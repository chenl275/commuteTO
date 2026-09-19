#!/usr/bin/env python3
"""Audit: does every standard TTC daytime bus route (route_type=3, numeric
route_short_name under 300 — the same selection ingest_surface_gtfs.py and
build_gtfs_routing_index.py use) actually have real geometry and appear in
both the routing graph and the day-bus map layer?

Cross-checks three independently-built artifacts against the same static
GTFS feed's routes.txt:
  1. backend/app/data/gtfs_routing.db  — the live routing graph (router.py
     queries this at request time; a route missing here can never be
     planned through, even if it's drawn on the map).
  2. backend/app/data/day_buses.geojson — the static map layer TTCMap.tsx
     renders (see ingest_surface_gtfs.py).
  3. backend/data/gtfs/shapes.txt — every route's trips must resolve to at
     least one non-empty shape_id with real geometry, or neither of the
     above can ever draw/route it correctly.

Run manually whenever the GTFS feed or either ingestion script changes:

    python backend/scripts/audit_bus_coverage.py
    python backend/scripts/audit_bus_coverage.py --gtfs-dir /path/to/gtfs

Exits non-zero (and prints every gap found) if anything is missing.
"""

from __future__ import annotations

import argparse
import csv
import json
import sqlite3
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
DEFAULT_GTFS_DIR = BACKEND_DIR / "data" / "gtfs"
ROUTING_DB_PATH = BACKEND_DIR / "app" / "data" / "gtfs_routing.db"
DAY_BUSES_GEOJSON_PATH = BACKEND_DIR / "app" / "data" / "day_buses.geojson"

DAY_BUS_ROUTE_TYPE = "3"
DAY_BUS_MAX_ROUTE_NUMBER = 300

# Explicitly checked by name, per the task — a quick human-readable sanity
# spot-check on top of the exhaustive scan below.
NAMED_SPOT_CHECK_ROUTES = {
    "13": "Avenue Rd",
    "7": "Bathurst",
    "29": "Dufferin",
    "32": "Eglinton West",
    "35": "Jane",
    "39": "Finch East",
    "102": "Markham Rd",
}


def _load_day_bus_routes(gtfs_dir: Path) -> dict[str, dict]:
    """route_id -> route row, for every standard daytime bus route in
    routes.txt (route_type=3, numeric short_name < 300 — excludes the
    300-399 Blue Night series, same convention as ingest_surface_gtfs.py)."""
    routes: dict[str, dict] = {}
    with (gtfs_dir / "routes.txt").open(newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            short_name = row["route_short_name"].strip()
            if (
                row["route_type"] == DAY_BUS_ROUTE_TYPE
                and short_name.isdigit()
                and int(short_name) < DAY_BUS_MAX_ROUTE_NUMBER
            ):
                routes[row["route_id"]] = row
    return routes


def _routes_with_valid_shapes(gtfs_dir: Path, route_ids: set[str]) -> tuple[set[str], set[str]]:
    """(route_ids with >=1 trip whose shape_id has real geometry, route_ids
    with trips but none of them resolve to a shape with any points)."""
    trip_route: dict[str, str] = {}
    trip_shape: dict[str, str] = {}
    with (gtfs_dir / "trips.txt").open(newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            if row["route_id"] in route_ids:
                trip_route[row["trip_id"]] = row["route_id"]
                trip_shape[row["trip_id"]] = row["shape_id"]

    candidate_shape_ids = {sid for sid in trip_shape.values() if sid}
    shapes_with_points: set[str] = set()
    with (gtfs_dir / "shapes.txt").open(newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            if row["shape_id"] in candidate_shape_ids:
                shapes_with_points.add(row["shape_id"])

    routes_with_valid_shape: set[str] = set()
    routes_missing_shape: set[str] = set()
    for trip_id, route_id in trip_route.items():
        shape_id = trip_shape.get(trip_id)
        if shape_id and shape_id in shapes_with_points:
            routes_with_valid_shape.add(route_id)
        else:
            routes_missing_shape.add(route_id)
    # A route with *some* valid-shape trips isn't "missing" even if a few of
    # its trips (e.g. a garage pull-in) have no shape.
    routes_missing_shape -= routes_with_valid_shape

    return routes_with_valid_shape, routes_missing_shape


def _routes_in_routing_db(route_ids: set[str]) -> set[str]:
    if not ROUTING_DB_PATH.exists():
        return set()
    conn = sqlite3.connect(f"file:{ROUTING_DB_PATH}?mode=ro", uri=True)
    try:
        placeholders = ",".join("?" * len(route_ids))
        rows = conn.execute(
            f"SELECT DISTINCT route_id FROM routes WHERE route_id IN ({placeholders})",
            tuple(route_ids),
        ).fetchall()
        return {row[0] for row in rows}
    finally:
        conn.close()


def _routes_in_day_buses_geojson() -> set[str]:
    if not DAY_BUSES_GEOJSON_PATH.exists():
        return set()
    data = json.loads(DAY_BUSES_GEOJSON_PATH.read_text())
    return {feature["properties"]["routeId"] for feature in data.get("features", [])}


def audit(gtfs_dir: Path) -> bool:
    """Returns True if everything checks out."""
    print(f"Auditing daytime bus coverage against {gtfs_dir} ...", file=sys.stderr)

    day_bus_routes = _load_day_bus_routes(gtfs_dir)
    route_ids = set(day_bus_routes)
    print(f"  {len(route_ids)} standard daytime bus routes found in routes.txt", file=sys.stderr)

    routes_with_shape, routes_missing_shape = _routes_with_valid_shapes(gtfs_dir, route_ids)
    routing_db_route_ids = _routes_in_routing_db(route_ids)
    geojson_route_ids = _routes_in_day_buses_geojson()

    missing_from_routing_db = route_ids - routing_db_route_ids
    missing_from_geojson = route_ids - geojson_route_ids

    ok = True

    if routes_missing_shape:
        ok = False
        print(f"\nMISSING SHAPE DATA ({len(routes_missing_shape)} routes) — every trip lacks usable geometry:", file=sys.stderr)
        for route_id in sorted(routes_missing_shape, key=lambda r: day_bus_routes[r]["route_short_name"]):
            row = day_bus_routes[route_id]
            print(f"  {row['route_short_name']:>4} {row['route_long_name']} (route_id={route_id})", file=sys.stderr)

    if missing_from_routing_db:
        ok = False
        print(f"\nMISSING FROM ROUTING GRAPH ({len(missing_from_routing_db)} routes) — router.py can never plan through these:", file=sys.stderr)
        for route_id in sorted(missing_from_routing_db, key=lambda r: day_bus_routes[r]["route_short_name"]):
            row = day_bus_routes[route_id]
            print(f"  {row['route_short_name']:>4} {row['route_long_name']} (route_id={route_id})", file=sys.stderr)

    if missing_from_geojson:
        ok = False
        print(f"\nMISSING FROM day_buses.geojson ({len(missing_from_geojson)} routes) — won't render on the map:", file=sys.stderr)
        for route_id in sorted(missing_from_geojson, key=lambda r: day_bus_routes[r]["route_short_name"]):
            row = day_bus_routes[route_id]
            print(f"  {row['route_short_name']:>4} {row['route_long_name']} (route_id={route_id})", file=sys.stderr)

    print("\nNamed spot-check routes:", file=sys.stderr)
    short_name_to_route_id = {row["route_short_name"]: route_id for route_id, row in day_bus_routes.items()}
    for short_name, expected_name in NAMED_SPOT_CHECK_ROUTES.items():
        route_id = short_name_to_route_id.get(short_name)
        if route_id is None:
            ok = False
            print(f"  {short_name:>4} {expected_name}: NOT FOUND in routes.txt at all", file=sys.stderr)
            continue
        checks = {
            "shape": route_id in routes_with_shape,
            "routing graph": route_id in routing_db_route_ids,
            "day_buses.geojson": route_id in geojson_route_ids,
        }
        status = "OK" if all(checks.values()) else "GAP: " + ", ".join(k for k, v in checks.items() if not v)
        print(f"  {short_name:>4} {expected_name}: {status}", file=sys.stderr)

    if ok:
        print(
            f"\n100% coverage: all {len(route_ids)} standard daytime bus routes have valid shape data, "
            "are in the routing graph, and render on the map.",
            file=sys.stderr,
        )
    return ok


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--gtfs-dir", type=Path, default=DEFAULT_GTFS_DIR, help="Directory of extracted GTFS .txt files.")
    args = parser.parse_args()

    if not (args.gtfs_dir / "routes.txt").exists():
        raise SystemExit(f"No routes.txt found in {args.gtfs_dir} — extract the GTFS feed there first.")

    ok = audit(args.gtfs_dir)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
