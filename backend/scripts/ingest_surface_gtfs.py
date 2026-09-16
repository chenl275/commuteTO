#!/usr/bin/env python3
"""One-time ingestion script: TTC streetcar network + Blue Night bus routes,
from the City of Toronto's static GTFS feed, into the static data files the
backend serves at request time.

Run manually whenever TTC's published GTFS changes meaningfully — this is
NOT part of the request path (the static feed is ~35MB with a 200MB+
stop_times.txt, far too slow/heavy to parse per-request):

    python backend/scripts/ingest_surface_gtfs.py
    python backend/scripts/ingest_surface_gtfs.py --gtfs-zip /path/to/local.zip

Writes:
    backend/app/data/streetcars.geojson    (501, 503, 504, 505, 506, 509, 510, 511, 512)
    backend/app/data/night_buses.geojson   (Blue Night bus routes, 300-399 series)
    backend/app/data/surface_stops.json    (stops served by either network)

Route selection notes (see routes.txt route_type/route_short_name):
  - Streetcars are GTFS route_type 0 ("Tram/Streetcar"), but that type also
    covers Line 5/Line 6 LRT (already modeled elsewhere as rapid transit —
    excluded here to avoid a duplicate, conflicting rendering) and the
    "3xx" overnight streetcar variants (301 Queen, 304 King, etc.) that run
    the same physical track as their daytime route — since this script's
    streetcar output is meant to be the network riders know by name, we key
    off TTC's own published route numbers instead of route_type alone.
  - Night buses are route_type 3 ("Bus") with a short_name in 300-399 —
    this deliberately excludes the 3xx *streetcar* variants above, which
    are a different vehicle type despite sharing the numbering scheme.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import sys
import zipfile
from collections import defaultdict
from pathlib import Path
from typing import Optional

import httpx

GTFS_STATIC_URL = (
    "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/"
    "7795b45e-e65a-4465-81fc-c36b9dfff169/resource/"
    "cfb6b2b8-6191-41e3-bda1-b175c51148cb/download/opendata_ttc_schedules.zip"
)

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(__file__).resolve().parents[1] / "app" / "data"
STATIONS_JSON_PATH = REPO_ROOT / "src" / "data" / "ttc-stations.json"

STREETCAR_ROUTE_SHORT_NAMES = {"501", "503", "504", "505", "506", "509", "510", "511", "512"}
NIGHT_BUS_ROUTE_TYPE = "3"
NIGHT_BUS_RANGE = range(300, 400)

# A surface stop within this distance of a subway station is treated as an
# interchange (e.g. a streetcar stop right outside Broadview Station).
INTERCHANGE_RADIUS_METERS = 150.0
EARTH_RADIUS_M = 6_371_000.0

DEFAULT_STREETCAR_COLOR = "ED1C24"  # TTC official streetcar red
DEFAULT_NIGHT_BUS_COLOR = "0054A6"  # TTC official Blue Night blue


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    h = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def _open_member(zf: zipfile.ZipFile, name: str) -> io.TextIOWrapper:
    return io.TextIOWrapper(zf.open(name, "r"), encoding="utf-8-sig", newline="")


def _load_gtfs_zip(source: str) -> zipfile.ZipFile:
    if source.startswith("http://") or source.startswith("https://"):
        print(f"Downloading GTFS feed from {source} ...", file=sys.stderr)
        response = httpx.get(source, timeout=120.0, follow_redirects=True)
        response.raise_for_status()
        return zipfile.ZipFile(io.BytesIO(response.content))
    return zipfile.ZipFile(source)


def _classify_routes(zf: zipfile.ZipFile) -> tuple[dict[str, dict], dict[str, dict]]:
    """Return (streetcar_routes_by_id, night_bus_routes_by_id)."""
    streetcars: dict[str, dict] = {}
    night_buses: dict[str, dict] = {}
    with _open_member(zf, "routes.txt") as f:
        for row in csv.DictReader(f):
            short_name = row["route_short_name"].strip()
            if short_name in STREETCAR_ROUTE_SHORT_NAMES:
                streetcars[row["route_id"]] = row
            elif (
                row["route_type"] == NIGHT_BUS_ROUTE_TYPE
                and short_name.isdigit()
                and int(short_name) in NIGHT_BUS_RANGE
            ):
                night_buses[row["route_id"]] = row
    print(f"  routes: {len(streetcars)} streetcar, {len(night_buses)} night bus", file=sys.stderr)
    return streetcars, night_buses


def _load_trips_for_routes(zf: zipfile.ZipFile, route_ids: set[str]) -> dict[str, dict]:
    """trip_id -> trip row, for trips belonging to `route_ids`."""
    trips: dict[str, dict] = {}
    with _open_member(zf, "trips.txt") as f:
        for row in csv.DictReader(f):
            if row["route_id"] in route_ids:
                trips[row["trip_id"]] = row
    return trips


def _pick_canonical_shapes(trips: dict[str, dict]) -> dict[tuple[str, str], str]:
    """(route_id, direction_id) -> the shape_id used by the most trips.

    A route typically has many shape variants (short-turns, garage
    pull-ins/outs); the one backing the most trips is the dominant,
    canonical end-to-end path.
    """
    counts: dict[tuple[str, str, str], int] = defaultdict(int)
    for trip in trips.values():
        counts[(trip["route_id"], trip["direction_id"], trip["shape_id"])] += 1

    best: dict[tuple[str, str], tuple[str, int]] = {}
    for (route_id, direction_id, shape_id), count in counts.items():
        key = (route_id, direction_id)
        if key not in best or count > best[key][1]:
            best[key] = (shape_id, count)

    return {key: shape_id for key, (shape_id, _count) in best.items()}


def _load_shape_geometries(
    zf: zipfile.ZipFile, shape_ids: set[str]
) -> dict[str, list[list[float]]]:
    """shape_id -> [[lon, lat], ...] ordered by shape_pt_sequence."""
    points: dict[str, list[tuple[int, float, float]]] = defaultdict(list)
    with _open_member(zf, "shapes.txt") as f:
        for row in csv.DictReader(f):
            shape_id = row["shape_id"]
            if shape_id not in shape_ids:
                continue
            points[shape_id].append(
                (int(row["shape_pt_sequence"]), float(row["shape_pt_lon"]), float(row["shape_pt_lat"]))
            )

    geometries: dict[str, list[list[float]]] = {}
    for shape_id, pts in points.items():
        pts.sort(key=lambda p: p[0])
        geometries[shape_id] = [[lon, lat] for _seq, lon, lat in pts]
    return geometries


def _build_route_feature_collection(
    zf: zipfile.ZipFile, routes: dict[str, dict], trips: dict[str, dict], default_color: str
) -> dict:
    canonical_shapes = _pick_canonical_shapes(trips)
    geometries = _load_shape_geometries(zf, set(canonical_shapes.values()))

    features = []
    for (route_id, direction_id), shape_id in sorted(canonical_shapes.items()):
        coordinates = geometries.get(shape_id)
        if not coordinates or len(coordinates) < 2:
            continue
        route = routes[route_id]
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": coordinates},
                "properties": {
                    "routeId": route_id,
                    "routeShortName": route["route_short_name"],
                    "routeLongName": route["route_long_name"],
                    "direction": int(direction_id),
                    "colorHex": f"#{route['route_color'] or default_color}",
                },
            }
        )

    return {"type": "FeatureCollection", "features": features}


def _trip_route_short_names(routes: dict[str, dict], trips: dict[str, dict]) -> dict[str, str]:
    """trip_id -> that trip's route_short_name (e.g. "504")."""
    return {
        trip_id: routes[trip["route_id"]]["route_short_name"] for trip_id, trip in trips.items()
    }


def _collect_stop_route_info(
    zf: zipfile.ZipFile,
    streetcar_trip_routes: dict[str, str],
    night_bus_trip_routes: dict[str, str],
) -> dict[str, dict]:
    """stop_id -> {"networks": {...}, "routes": {route_short_name, ...}}.

    Streams stop_times.txt (200MB+) row by row rather than loading it, since
    all we need out of it is this small per-stop summary.
    """
    info: dict[str, dict] = defaultdict(lambda: {"networks": set(), "routes": set()})
    with _open_member(zf, "stop_times.txt") as f:
        for row in csv.DictReader(f):
            trip_id = row["trip_id"]
            stop_id = row["stop_id"]

            streetcar_route = streetcar_trip_routes.get(trip_id)
            if streetcar_route:
                info[stop_id]["networks"].add("streetcar")
                info[stop_id]["routes"].add(streetcar_route)

            night_bus_route = night_bus_trip_routes.get(trip_id)
            if night_bus_route:
                info[stop_id]["networks"].add("night_bus")
                info[stop_id]["routes"].add(night_bus_route)
    return info


def _load_subway_stations() -> list[dict]:
    try:
        return json.loads(STATIONS_JSON_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return []


def _find_interchange(
    lat: float, lon: float, subway_stations: list[dict]
) -> Optional[dict]:
    nearest: Optional[dict] = None
    nearest_distance = INTERCHANGE_RADIUS_METERS
    for station in subway_stations:
        station_lon, station_lat = station["coordinates"]
        distance = _haversine_m(lat, lon, station_lat, station_lon)
        if distance <= nearest_distance:
            nearest = station
            nearest_distance = distance
    return nearest


def _route_sort_key(route_short_name: str) -> tuple[int, int | str]:
    return (0, int(route_short_name)) if route_short_name.isdigit() else (1, route_short_name)


def _build_surface_stops(zf: zipfile.ZipFile, stop_route_info: dict[str, dict]) -> list[dict]:
    subway_stations = _load_subway_stations()
    stops: list[dict] = []

    with _open_member(zf, "stops.txt") as f:
        for row in csv.DictReader(f):
            info = stop_route_info.get(row["stop_id"])
            if not info or not info["networks"]:
                continue

            lat, lon = float(row["stop_lat"]), float(row["stop_lon"])
            interchange = _find_interchange(lat, lon, subway_stations)

            stops.append(
                {
                    "id": row["stop_id"],
                    "name": row["stop_name"],
                    "coordinates": [lon, lat],
                    "networks": sorted(info["networks"]),
                    "routes": sorted(info["routes"], key=_route_sort_key),
                    "isInterchange": interchange is not None,
                    "interchangeStationId": interchange["id"] if interchange else None,
                }
            )

    stops.sort(key=lambda s: s["id"])
    return stops


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--gtfs-zip",
        default=GTFS_STATIC_URL,
        help="Path or URL to the GTFS static zip (default: City of Toronto Open Data feed).",
    )
    args = parser.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    print("Loading GTFS feed ...", file=sys.stderr)
    zf = _load_gtfs_zip(args.gtfs_zip)

    print("Classifying routes ...", file=sys.stderr)
    streetcar_routes, night_bus_routes = _classify_routes(zf)

    print("Loading trips ...", file=sys.stderr)
    streetcar_trips = _load_trips_for_routes(zf, set(streetcar_routes))
    night_bus_trips = _load_trips_for_routes(zf, set(night_bus_routes))
    print(
        f"  trips: {len(streetcar_trips)} streetcar, {len(night_bus_trips)} night bus",
        file=sys.stderr,
    )

    print("Building streetcar shapes ...", file=sys.stderr)
    streetcars_geojson = _build_route_feature_collection(
        zf, streetcar_routes, streetcar_trips, DEFAULT_STREETCAR_COLOR
    )
    print("Building night bus shapes ...", file=sys.stderr)
    night_buses_geojson = _build_route_feature_collection(
        zf, night_bus_routes, night_bus_trips, DEFAULT_NIGHT_BUS_COLOR
    )

    print("Scanning stop_times.txt for served stops (this is the slow part) ...", file=sys.stderr)
    streetcar_trip_routes = _trip_route_short_names(streetcar_routes, streetcar_trips)
    night_bus_trip_routes = _trip_route_short_names(night_bus_routes, night_bus_trips)
    stop_route_info = _collect_stop_route_info(zf, streetcar_trip_routes, night_bus_trip_routes)
    print("Building surface stops ...", file=sys.stderr)
    surface_stops = _build_surface_stops(zf, stop_route_info)

    (DATA_DIR / "streetcars.geojson").write_text(json.dumps(streetcars_geojson, indent=2))
    (DATA_DIR / "night_buses.geojson").write_text(json.dumps(night_buses_geojson, indent=2))
    (DATA_DIR / "surface_stops.json").write_text(json.dumps(surface_stops, indent=2))

    print(
        f"Wrote {len(streetcars_geojson['features'])} streetcar shapes, "
        f"{len(night_buses_geojson['features'])} night bus shapes, "
        f"{len(surface_stops)} surface stops to {DATA_DIR}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
