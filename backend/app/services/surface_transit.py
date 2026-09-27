"""Static TTC streetcar, daytime bus, and Blue Night bus route/stop data.

Generated offline by scripts/ingest_surface_gtfs.py from the City of
Toronto's GTFS feed. Genuinely static (regenerated manually, not on a live
schedule).

The raw streetcars/day-buses/night-buses GeoJSON files are served straight
from disk via FileResponse (see main.py) instead of being parsed into
Python dicts, since day_buses.geojson alone is ~8MB and holding all three
decoded in the heap is a meaningful chunk of a 512MB Render instance.
Only surface_stops.json needs a shape transform before it can go out as
GeoJSON, so that one is parsed on request rather than cached at import.
"""

from __future__ import annotations

import json
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[1] / "data"

STREETCARS_GEOJSON_PATH = DATA_DIR / "streetcars.geojson"
DAY_BUSES_GEOJSON_PATH = DATA_DIR / "day_buses.geojson"
NIGHT_BUSES_GEOJSON_PATH = DATA_DIR / "night_buses.geojson"

_EMPTY_FEATURE_COLLECTION = {"type": "FeatureCollection", "features": []}


def _load_stops_as_geojson(filename: str) -> dict:
    try:
        stops = json.loads((DATA_DIR / filename).read_text())
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


def get_surface_stops_geojson() -> dict:
    return _load_stops_as_geojson("surface_stops.json")
