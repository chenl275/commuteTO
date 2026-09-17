#!/usr/bin/env python3
"""One-time ingestion: the full TTC static GTFS schedule (routes, trips,
stop_times, stops, calendar, calendar_dates) into an indexed SQLite database
that router.py's time-dependent Dijkstra queries at request time.

The live request path never parses the raw feed directly — stop_times.txt
alone is ~4.3M rows (200MB+), far too slow to scan per request (same
reasoning as ingest_surface_gtfs.py's streetcar/night-bus extraction). This
script does that parsing once, offline, and writes a compact indexed DB that
opens in milliseconds.

Run manually whenever backend/data/gtfs/ is refreshed with a newer feed:

    python backend/scripts/build_gtfs_routing_index.py

Reads backend/data/gtfs/{routes,trips,stop_times,stops,shapes,calendar,calendar_dates}.txt
and writes backend/app/data/gtfs_routing.db.
"""

from __future__ import annotations

import csv
import json
import sqlite3
import sys
import time
from pathlib import Path
from typing import Optional

GTFS_DIR = Path(__file__).resolve().parents[1] / "data" / "gtfs"
DB_PATH = Path(__file__).resolve().parents[1] / "app" / "data" / "gtfs_routing.db"
# GTFS stop_id -> our canonical station id (e.g. "13755" -> "bloor-yonge"),
# see gtfs_service.py. TTC's own static feed ships every stop/platform as a
# standalone row with an empty parent_station column — no interchange
# grouping at all — so this mapping is used as a synthetic parent_station
# instead: every subway platform that shares a canonical station id (e.g. all
# four Line 1 + Line 2 platforms at Bloor-Yonge) is grouped under it, which
# is what lets router.py recognize a same-station transfer as a fixed short
# connection rather than a distance-estimated walk between "nearby" stops.
STOP_MAPPING_PATH = Path(__file__).resolve().parents[1] / "app" / "data" / "gtfs_stop_mapping.json"

STOP_TIMES_BATCH_SIZE = 50_000


def _time_to_seconds(value: str) -> int:
    """GTFS times can exceed 24:00:00 for a post-midnight trip on the
    previous service day — kept as seconds-since-midnight without wrapping,
    exactly as GTFS defines it, so ordering by departure_sec stays correct."""
    h, m, s = value.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def _open(name: str):
    path = GTFS_DIR / name
    if not path.exists():
        raise SystemExit(
            f"Missing {path} — download and extract the GTFS feed into {GTFS_DIR} first."
        )
    return open(path, newline="", encoding="utf-8-sig")


def build() -> None:
    started = time.monotonic()
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    if DB_PATH.exists():
        DB_PATH.unlink()

    conn = sqlite3.connect(DB_PATH)
    # Build-time only pragmas — this connection is discarded once the file is
    # written, so durability doesn't matter, only raw insert throughput.
    conn.execute("PRAGMA synchronous = OFF")
    conn.execute("PRAGMA journal_mode = MEMORY")
    cur = conn.cursor()

    cur.execute(
        "CREATE TABLE routes ("
        "route_id TEXT PRIMARY KEY, short_name TEXT, long_name TEXT, "
        "route_type INTEGER, color TEXT)"
    )
    cur.execute("CREATE TABLE trips (trip_id TEXT PRIMARY KEY, route_id TEXT, service_id TEXT, shape_id TEXT)")
    cur.execute(
        "CREATE TABLE stops (stop_id TEXT PRIMARY KEY, name TEXT, lat REAL, lon REAL, parent_station TEXT)"
    )
    cur.execute(
        "CREATE TABLE stop_times ("
        "trip_id TEXT, stop_id TEXT, stop_sequence INTEGER, "
        "arrival_sec INTEGER, departure_sec INTEGER, shape_dist_traveled REAL)"
    )
    cur.execute("CREATE TABLE stop_routes (stop_id TEXT, route_id TEXT)")
    # The vehicle's actual physical path (many points per route, tracing the
    # real curved track/road geometry) — used by router.py to render a
    # transit leg along real track shape instead of straight chords between
    # consecutive stop coordinates, which visibly cut across the Line 1 "U"
    # near Union (see build()'s shapes.txt loading below for why
    # shape_dist_traveled, not just point order, is what lets a leg be
    # sliced precisely between its boarding and alighting stop).
    cur.execute("CREATE TABLE shapes (shape_id TEXT, seq INTEGER, lat REAL, lon REAL, dist REAL)")
    cur.execute(
        "CREATE TABLE calendar ("
        "service_id TEXT PRIMARY KEY, monday INTEGER, tuesday INTEGER, wednesday INTEGER, "
        "thursday INTEGER, friday INTEGER, saturday INTEGER, sunday INTEGER, "
        "start_date TEXT, end_date TEXT)"
    )
    cur.execute("CREATE TABLE calendar_dates (service_id TEXT, date TEXT, exception_type INTEGER)")

    print("Loading routes.txt ...", file=sys.stderr)
    with _open("routes.txt") as f:
        route_rows = [
            (r["route_id"], r["route_short_name"], r["route_long_name"], int(r["route_type"]), r["route_color"])
            for r in csv.DictReader(f)
        ]
    cur.executemany("INSERT INTO routes VALUES (?,?,?,?,?)", route_rows)
    print(f"  {len(route_rows)} routes", file=sys.stderr)

    print("Loading trips.txt ...", file=sys.stderr)
    with _open("trips.txt") as f:
        trip_rows = [
            (r["trip_id"], r["route_id"], r["service_id"], r.get("shape_id") or None)
            for r in csv.DictReader(f)
        ]
    cur.executemany("INSERT INTO trips VALUES (?,?,?,?)", trip_rows)
    trip_to_route = {trip_id: route_id for trip_id, route_id, _service_id, _shape_id in trip_rows}
    print(f"  {len(trip_rows)} trips", file=sys.stderr)

    print("Loading shapes.txt ...", file=sys.stderr)
    with _open("shapes.txt") as f:
        shape_rows = [
            (
                r["shape_id"],
                int(r["shape_pt_sequence"]),
                float(r["shape_pt_lat"]),
                float(r["shape_pt_lon"]),
                float(r["shape_dist_traveled"]) if r.get("shape_dist_traveled") else None,
            )
            for r in csv.DictReader(f)
        ]
    cur.executemany("INSERT INTO shapes VALUES (?,?,?,?,?)", shape_rows)
    print(f"  {len(shape_rows)} shape points", file=sys.stderr)

    print("Loading gtfs_stop_mapping.json ...", file=sys.stderr)
    try:
        stop_to_station: dict[str, str] = json.loads(STOP_MAPPING_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        stop_to_station = {}
    print(f"  {len(stop_to_station)} subway stop -> station mappings", file=sys.stderr)

    print("Loading stops.txt ...", file=sys.stderr)
    with _open("stops.txt") as f:
        stop_rows = [
            (
                r["stop_id"],
                r["stop_name"],
                float(r["stop_lat"]),
                float(r["stop_lon"]),
                stop_to_station.get(r["stop_id"]),
            )
            for r in csv.DictReader(f)
            if r["stop_lat"] and r["stop_lon"]
        ]
    cur.executemany("INSERT INTO stops VALUES (?,?,?,?,?)", stop_rows)
    print(f"  {len(stop_rows)} stops", file=sys.stderr)

    print("Loading calendar.txt ...", file=sys.stderr)
    with _open("calendar.txt") as f:
        calendar_rows = [
            (
                r["service_id"],
                int(r["monday"]),
                int(r["tuesday"]),
                int(r["wednesday"]),
                int(r["thursday"]),
                int(r["friday"]),
                int(r["saturday"]),
                int(r["sunday"]),
                r["start_date"],
                r["end_date"],
            )
            for r in csv.DictReader(f)
        ]
    cur.executemany("INSERT INTO calendar VALUES (?,?,?,?,?,?,?,?,?,?)", calendar_rows)
    print(f"  {len(calendar_rows)} calendar rows", file=sys.stderr)

    print("Loading calendar_dates.txt ...", file=sys.stderr)
    with _open("calendar_dates.txt") as f:
        exception_rows = [(r["service_id"], r["date"], int(r["exception_type"])) for r in csv.DictReader(f)]
    cur.executemany("INSERT INTO calendar_dates VALUES (?,?,?)", exception_rows)
    print(f"  {len(exception_rows)} calendar exceptions", file=sys.stderr)

    print("Streaming stop_times.txt (this is the slow part) ...", file=sys.stderr)
    seen_stop_routes: set[tuple[str, str]] = set()
    batch: list[tuple[str, str, int, int, int, Optional[float]]] = []
    count = 0
    with _open("stop_times.txt") as f:
        for row in csv.DictReader(f):
            trip_id = row["trip_id"]
            stop_id = row["stop_id"]
            dist = row.get("shape_dist_traveled")
            batch.append(
                (
                    trip_id,
                    stop_id,
                    int(row["stop_sequence"]),
                    _time_to_seconds(row["arrival_time"]),
                    _time_to_seconds(row["departure_time"]),
                    float(dist) if dist else None,
                )
            )
            route_id = trip_to_route.get(trip_id)
            if route_id:
                seen_stop_routes.add((stop_id, route_id))
            count += 1
            if len(batch) >= STOP_TIMES_BATCH_SIZE:
                cur.executemany("INSERT INTO stop_times VALUES (?,?,?,?,?,?)", batch)
                batch.clear()
                print(f"  ... {count} stop_times rows", file=sys.stderr)
    if batch:
        cur.executemany("INSERT INTO stop_times VALUES (?,?,?,?,?,?)", batch)
    print(f"  {count} stop_times rows total", file=sys.stderr)

    cur.executemany("INSERT INTO stop_routes VALUES (?,?)", seen_stop_routes)
    print(f"  {len(seen_stop_routes)} stop_routes pairs", file=sys.stderr)

    print("Building indexes ...", file=sys.stderr)
    cur.execute("CREATE INDEX idx_stop_times_stop_dep ON stop_times (stop_id, departure_sec)")
    cur.execute("CREATE INDEX idx_stop_times_trip_seq ON stop_times (trip_id, stop_sequence)")
    cur.execute("CREATE INDEX idx_stop_routes_stop ON stop_routes (stop_id)")
    cur.execute("CREATE INDEX idx_stops_lat ON stops (lat)")
    cur.execute("CREATE INDEX idx_stops_lon ON stops (lon)")
    cur.execute("CREATE INDEX idx_stops_parent_station ON stops (parent_station)")
    cur.execute("CREATE INDEX idx_trips_route ON trips (route_id)")
    cur.execute("CREATE INDEX idx_shapes_shape_dist ON shapes (shape_id, dist)")

    conn.commit()
    conn.close()

    elapsed = time.monotonic() - started
    print(
        f"Wrote {DB_PATH} ({DB_PATH.stat().st_size / 1e6:.1f} MB) in {elapsed:.1f}s",
        file=sys.stderr,
    )


if __name__ == "__main__":
    build()
