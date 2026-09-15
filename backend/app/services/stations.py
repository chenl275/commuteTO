"""Shared TTC subway station data: lookups, line ordering, and route math.

Station names/ids/coordinates are read from the frontend's single source of
truth (`src/data/ttc-stations.json`) so the backend never drifts out of sync
with what's rendered on the map.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Optional, Tuple

_REPO_ROOT = Path(__file__).resolve().parents[3]
_STATIONS_JSON_PATH = _REPO_ROOT / "src" / "data" / "ttc-stations.json"

EARTH_RADIUS_KM = 6371.0

# Station ids in travel order, mirroring src/lib/geo/subwayGeoJSON.ts.
# Only Lines 1 and 2 are modeled — that's the current scope of both the TTC
# Reduced Speed Zones page and this app's delay modeling.
LINE_1_STATION_IDS = [
    "vaughan-metropolitan-centre",
    "highway-407",
    "pioneer-village",
    "york-university",
    "finch-west",
    "downsview-park",
    "sheppard-west",
    "wilson",
    "yorkdale",
    "lawrence-west",
    "glencairn",
    "cedarvale",
    "st-clair-west",
    "dupont",
    "spadina",
    "st-george",
    "museum",
    "queens-park",
    "st-patrick",
    "osgoode",
    "st-andrew",
    "union",
    "king",
    "queen",
    "tmu",
    "college",
    "wellesley",
    "bloor-yonge",
    "rosedale",
    "summerhill",
    "st-clair",
    "davisville",
    "eglinton",
    "lawrence",
    "york-mills",
    "sheppard-yonge",
    "north-york-centre",
    "finch",
]

LINE_2_STATION_IDS = [
    "kipling",
    "islington",
    "royal-york",
    "old-mill",
    "jane",
    "runnymede",
    "high-park",
    "keele",
    "dundas-west",
    "lansdowne",
    "dufferin",
    "ossington",
    "christie",
    "bathurst",
    "spadina",
    "st-george",
    "bay",
    "bloor-yonge",
    "sherbourne",
    "castle-frank",
    "broadview",
    "chester",
    "pape",
    "donlands",
    "greenwood",
    "coxwell",
    "woodbine",
    "main-street",
    "victoria-park",
    "warden",
    "kennedy",
]

LINE_STATION_IDS: dict[int, list[str]] = {1: LINE_1_STATION_IDS, 2: LINE_2_STATION_IDS}


_TRAILING_STATION_PATTERN = re.compile(r"\s+stations?$", re.IGNORECASE)


def _normalize_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def _strip_station_suffix(name: str) -> str:
    """Drop a trailing "Station"/"Stations" word so "Union Station" resolves
    the same as "Union" — the frontend always displays the suffixed form."""
    return _TRAILING_STATION_PATTERN.sub("", name.strip())


def _load_stations() -> list[dict]:
    try:
        raw = json.loads(_STATIONS_JSON_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return []
    return raw if isinstance(raw, list) else []


_STATIONS: list[dict] = _load_stations()
_STATIONS_BY_ID: dict[str, dict] = {station["id"]: station for station in _STATIONS}
_NAME_KEY_TO_ID: dict[str, str] = {
    _normalize_key(station["name"]): station["id"] for station in _STATIONS
}


def normalize_station_name(raw_name: str) -> str:
    """Best-effort match of a scraped station name to our canonical name."""
    cleaned = raw_name.strip()
    station_id = _NAME_KEY_TO_ID.get(_normalize_key(cleaned))
    return _STATIONS_BY_ID[station_id]["name"] if station_id else cleaned


def find_station(raw_name: str) -> Optional[dict]:
    """Resolve a station name (or id) to its canonical station record."""
    cleaned = _strip_station_suffix(raw_name)
    station_id = _NAME_KEY_TO_ID.get(_normalize_key(cleaned))
    if station_id is None and cleaned.lower() in _STATIONS_BY_ID:
        station_id = cleaned.lower()
    return _STATIONS_BY_ID.get(station_id) if station_id else None


def find_station_id(raw_name: str) -> Optional[str]:
    station = find_station(raw_name)
    return station["id"] if station else None


def _haversine_km(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    lat1, lon1 = a
    lat2, lon2 = b
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    h = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(h))


def nearest_station(coordinates: Tuple[float, float]) -> Optional[dict]:
    """Find the closest station to a [lat, lng] pair."""
    if not _STATIONS:
        return None
    lat, lng = coordinates

    def distance_km(station: dict) -> float:
        station_lng, station_lat = station["coordinates"]
        return _haversine_km((lat, lng), (station_lat, station_lng))

    return min(_STATIONS, key=distance_km)


def line_index(line: int, station_id: str) -> Optional[int]:
    ids = LINE_STATION_IDS.get(line)
    if ids is None or station_id not in ids:
        return None
    return ids.index(station_id)


def hops_between(line: int, from_id: str, to_id: str) -> Optional[int]:
    """Number of station-to-station hops travelling along `line`."""
    from_index, to_index = line_index(line, from_id), line_index(line, to_id)
    if from_index is None or to_index is None:
        return None
    return abs(from_index - to_index)


def stations_on_route(line: int, origin_id: str, destination_id: str) -> list[str]:
    """Station ids actually traveled (inclusive of both ends), in whichever
    order they appear on the line — direction-agnostic, unlike zones_along_route."""
    ids = LINE_STATION_IDS.get(line)
    if not ids or origin_id not in ids or destination_id not in ids:
        return []
    start, end = sorted((ids.index(origin_id), ids.index(destination_id)))
    return ids[start : end + 1]


def alerts_along_route(
    line: int, origin_id: str, destination_id: str, alerts: list[dict]
) -> list[dict]:
    """Active service alerts whose affected stations overlap the traveled path."""
    traveled = set(stations_on_route(line, origin_id, destination_id))
    if not traveled:
        return []

    return [
        alert
        for alert in alerts
        if alert.get("line") == line and traveled & set(alert.get("affectedStationIds") or [])
    ]


def zones_along_route(
    line: int, origin_id: str, destination_id: str, zones: list[dict]
) -> list[dict]:
    """Active slow zones whose (fromStationId, toStationId) segment lies on
    the traveled path, in the direction actually travelled."""
    ids = LINE_STATION_IDS.get(line)
    if not ids or origin_id not in ids or destination_id not in ids:
        return []

    origin_index, destination_index = ids.index(origin_id), ids.index(destination_id)
    step = 1 if destination_index >= origin_index else -1
    traveled_pairs = {
        (ids[i], ids[i + step]) for i in range(origin_index, destination_index, step)
    }

    return [
        zone
        for zone in zones
        if zone.get("line") == line
        and (zone.get("fromStationId"), zone.get("toStationId")) in traveled_pairs
    ]
