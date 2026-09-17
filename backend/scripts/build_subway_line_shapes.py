#!/usr/bin/env python3
"""One-time extraction: real curved subway track geometry (from GTFS
shapes.txt, via the already-built routing index) for each subway line, plus
each of our canonical stations' position along that curve — written as a
frontend data asset so the map's route highlight can slice the *real* track
between two stations instead of a straight chord between their coordinates
(see src/lib/geo/subwayGeoJSON.ts's getRouteCoordinates and
TTCMap.tsx's computeRouteFeatures, which render the "fast path" direct-line
subway estimate — the multi-modal itinerary path already gets real shape
geometry server-side, see router.py's _transit_leg_path).

Only lines with actual GTFS static schedule data get real curves (1, 2, 4 in
the current feed) — Line 5/6 aren't in this feed at all yet, so
subwayGeoJSON.ts keeps its existing straight-chord approximation for those.

Run manually whenever backend/app/data/gtfs_routing.db is rebuilt:

    python backend/scripts/build_subway_line_shapes.py

Reads backend/app/data/gtfs_routing.db and backend/app/data/gtfs_stop_mapping.json.
Writes src/data/subway-line-shapes.json.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

DB_PATH = Path(__file__).resolve().parents[1] / "app" / "data" / "gtfs_routing.db"
STOP_MAPPING_PATH = Path(__file__).resolve().parents[1] / "app" / "data" / "gtfs_stop_mapping.json"
OUTPUT_PATH = Path(__file__).resolve().parents[2] / "src" / "data" / "subway-line-shapes.json"

# GTFS route_id for each subway line in this feed — matches route_short_name
# 1:1 here (verified against routes.txt), same ids router.py's
# _SUBWAY_ROUTE_SHORT_NAMES already assumes.
SUBWAY_ROUTE_IDS = ["1", "2", "4"]


def _pick_representative_trip(conn: sqlite3.Connection, route_id: str, stop_to_station: dict[str, str]) -> str:
    """The trip on `route_id` whose stops cover the most distinct canonical
    stations — a full-length run in one direction, not a short-turn."""
    trip_ids = [row[0] for row in conn.execute("SELECT trip_id FROM trips WHERE route_id = ?", (route_id,))]

    best_trip_id = None
    best_count = -1
    for trip_id in trip_ids:
        stop_ids = [row[0] for row in conn.execute("SELECT stop_id FROM stop_times WHERE trip_id = ?", (trip_id,))]
        station_count = len({stop_to_station[s] for s in stop_ids if s in stop_to_station})
        if station_count > best_count:
            best_count = station_count
            best_trip_id = trip_id

    if best_trip_id is None:
        raise SystemExit(f"No trips found for route {route_id}")
    print(f"  route {route_id}: trip {best_trip_id} covers {best_count} canonical stations", file=sys.stderr)
    return best_trip_id


def _shape_dist_at(conn: sqlite3.Connection, trip_id: str, stop_sequence: int) -> float | None:
    row = conn.execute(
        "SELECT shape_dist_traveled FROM stop_times WHERE trip_id = ? AND stop_sequence = ?",
        (trip_id, stop_sequence),
    ).fetchone()
    if row is None:
        return None
    dist = row[0]
    if dist is not None:
        return dist
    # Same feed quirk _shape_dist_at_sequence in router.py works around: only
    # ever blank on a trip's first stop, where the implied distance is 0.
    return 0.0 if stop_sequence == 1 else None


def build() -> None:
    stop_to_station: dict[str, str] = json.loads(STOP_MAPPING_PATH.read_text())
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)

    output: dict[str, dict] = {}
    for route_id in SUBWAY_ROUTE_IDS:
        trip_id = _pick_representative_trip(conn, route_id, stop_to_station)
        shape_row = conn.execute("SELECT shape_id FROM trips WHERE trip_id = ?", (trip_id,)).fetchone()
        shape_id = shape_row[0] if shape_row else None
        if not shape_id:
            print(f"  route {route_id}: no shape_id, skipping", file=sys.stderr)
            continue

        # [lon, lat, dist] triples — dist (shape_dist_traveled, km) is what
        # lets the frontend slice this curve between two stations the same
        # way router.py's _transit_leg_path does server-side, rather than
        # needing to guess a point index from raw coordinates.
        shape_points = [
            [lon, lat, dist]
            for lat, lon, dist in conn.execute(
                "SELECT lat, lon, dist FROM shapes WHERE shape_id = ? ORDER BY seq ASC", (shape_id,)
            ).fetchall()
        ]

        station_distances: dict[str, float] = {}
        for stop_id, stop_sequence in conn.execute(
            "SELECT stop_id, stop_sequence FROM stop_times WHERE trip_id = ? ORDER BY stop_sequence ASC",
            (trip_id,),
        ):
            station_id = stop_to_station.get(stop_id)
            if not station_id or station_id in station_distances:
                continue
            dist = _shape_dist_at(conn, trip_id, stop_sequence)
            if dist is not None:
                station_distances[station_id] = dist

        output[route_id] = {"shapePoints": shape_points, "stationDistances": station_distances}
        print(
            f"  route {route_id}: {len(shape_points)} shape points, {len(station_distances)} stations located",
            file=sys.stderr,
        )

    conn.close()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(output, indent=2))
    print(f"Wrote {OUTPUT_PATH}", file=sys.stderr)


if __name__ == "__main__":
    build()
