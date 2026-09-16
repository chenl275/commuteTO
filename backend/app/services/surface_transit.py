"""Static TTC streetcar network + Blue Night bus route/stop data.

Generated offline by scripts/ingest_surface_gtfs.py from the City of
Toronto's GTFS feed. Genuinely static (regenerated manually, not on a live
schedule) so it's loaded once at import time rather than fetched/cached
like the live scraper services.
"""

from __future__ import annotations

import json
from pathlib import Path

_DATA_DIR = Path(__file__).resolve().parents[1] / "data"

_EMPTY_FEATURE_COLLECTION = {"type": "FeatureCollection", "features": []}


def _load_geojson(filename: str) -> dict:
    try:
        return json.loads((_DATA_DIR / filename).read_text())
    except (OSError, json.JSONDecodeError):
        return dict(_EMPTY_FEATURE_COLLECTION)


def _load_stops_as_geojson(filename: str) -> dict:
    try:
        stops = json.loads((_DATA_DIR / filename).read_text())
    except (OSError, json.JSONDecodeError):
        return dict(_EMPTY_FEATURE_COLLECTION)
    if not isinstance(stops, list):
        return dict(_EMPTY_FEATURE_COLLECTION)

    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": stop["coordinates"]},
                "properties": {
                    "id": stop["id"],
                    "name": stop["name"],
                    "networks": stop["networks"],
                    "routes": stop.get("routes", []),
                    "isInterchange": stop["isInterchange"],
                    "interchangeStationId": stop.get("interchangeStationId"),
                },
            }
            for stop in stops
        ],
    }


_STREETCARS_GEOJSON = _load_geojson("streetcars.geojson")
_NIGHT_BUSES_GEOJSON = _load_geojson("night_buses.geojson")
_SURFACE_STOPS_GEOJSON = _load_stops_as_geojson("surface_stops.json")


def get_streetcars_geojson() -> dict:
    return _STREETCARS_GEOJSON


def get_night_buses_geojson() -> dict:
    return _NIGHT_BUSES_GEOJSON


def get_surface_stops_geojson() -> dict:
    return _SURFACE_STOPS_GEOJSON
