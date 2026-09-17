"""Live GTFS-Realtime subway TripUpdates ingestion, for TTC Lines 1, 2, 4.

Per-station observed delay (seconds) is derived from subway TripUpdates —
used as empirical ground truth ahead of the kinematic slow-zone delay
estimate (kinematics.py) whenever it's available.

The URL commonly cited for this
(https://opendata.toronto.ca/transportation/gtfs-realtime/trip-updates.pb)
doesn't actually resolve to protobuf data — it 200s with the toronto.ca
website's HTML shell. The real feed, found via TTC's own GTFS-RT landing
page (https://gtfsrt.ttc.ca), is:
  - https://gtfsrt.ttc.ca/trips/subway?format=binary — subway-only
    TripUpdates, `route_id` "1"/"2"/"4" (confirmed against a live pull).

Caveat verified against the live subway feed: StopTimeUpdates only ever
populate `arrival.time` (an absolute predicted Unix timestamp), never
`arrival.delay`/`departure.delay` — and the feed's trip ids come from TTC's
internal CAD/AVL system, not the trip ids in their published static GTFS, so
there's no published crosswalk to derive "vs. scheduled" delay by joining
the two. `_parse_feed` still checks `.delay` first per GTFS-RT spec (so this
starts working automatically if TTC ever populates it), but today it will
consistently find nothing and every route falls back to the kinematic model
— the correct, intended behavior, not a bug: honest about only surfacing
delay actually observed, not a fabricated one.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Optional

import httpx
from google.transit import gtfs_realtime_pb2

GTFS_RT_SUBWAY_TRIP_UPDATES_URL = "https://gtfsrt.ttc.ca/trips/subway?format=binary"
CACHE_TTL_SECONDS = 30

_REQUEST_HEADERS = {"User-Agent": "commuteTO/1.0 (+https://github.com/)"}

SUBWAY_ROUTE_IDS = {"1", "2", "4"}

# GTFS stop_id -> our station id, e.g. {"13857": "st-george"}. Built once
# from the static GTFS feed's stops.txt (stop names like "St George Station
# - Southbound Platform") — see the mapping file for details. Static because
# TTC's GTFS stop ids are stable; regenerating from the ~35MB static feed on
# every server start would be slow and adds an avoidable failure mode.
_STOP_MAPPING_PATH = Path(__file__).resolve().parent.parent / "data" / "gtfs_stop_mapping.json"


def _load_stop_mapping() -> dict[str, str]:
    try:
        return json.loads(_STOP_MAPPING_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


_GTFS_STOP_TO_STATION_ID: dict[str, str] = _load_stop_mapping()


def get_station_id_for_stop(stop_id: str) -> Optional[str]:
    """Our station id for a GTFS-RT `stop_id` (e.g. "13857" -> "st-george"),
    or None if it's not a mapped subway stop — used to translate a GTFS-RT
    alert's `informed_entity.stop_id` list into station-range checks
    (see detour_service.py)."""
    return _GTFS_STOP_TO_STATION_ID.get(stop_id)


def _parse_feed(payload: bytes) -> dict[str, int]:
    """Return {station_id: max_observed_delay_seconds} across all current
    subway trip updates. Max (not average/first) so a single train running
    badly behind is never masked by other on-time trains at the same station."""
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(payload)

    delays: dict[str, int] = {}
    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue
        trip_update = entity.trip_update
        if trip_update.trip.route_id not in SUBWAY_ROUTE_IDS:
            continue

        for stop_time_update in trip_update.stop_time_update:
            station_id = _GTFS_STOP_TO_STATION_ID.get(stop_time_update.stop_id)
            if not station_id:
                continue

            delay: Optional[int] = None
            if stop_time_update.HasField("arrival") and stop_time_update.arrival.HasField("delay"):
                delay = stop_time_update.arrival.delay
            elif stop_time_update.HasField("departure") and stop_time_update.departure.HasField(
                "delay"
            ):
                delay = stop_time_update.departure.delay

            if delay is None:
                continue

            existing = delays.get(station_id)
            if existing is None or delay > existing:
                delays[station_id] = delay

    return delays


async def _fetch_feed() -> bytes:
    async with httpx.AsyncClient(timeout=10.0, headers=_REQUEST_HEADERS) as client:
        response = await client.get(GTFS_RT_SUBWAY_TRIP_UPDATES_URL)
        response.raise_for_status()
        return response.content


class _DelayCache:
    """Thread-safe in-memory cache of per-station observed delay (seconds)."""

    def __init__(self, ttl_seconds: int):
        self._ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._delays: dict[str, int] = {}
        self._fetched_at: Optional[float] = None
        self._source = "fallback"

    @property
    def is_fresh(self) -> bool:
        with self._lock:
            return (
                self._fetched_at is not None
                and (time.monotonic() - self._fetched_at) < self._ttl_seconds
            )

    def set(self, delays: dict[str, int], source: str) -> None:
        with self._lock:
            self._delays = delays
            self._fetched_at = time.monotonic()
            self._source = source

    def get(self, station_id: str) -> Optional[int]:
        with self._lock:
            return self._delays.get(station_id)


_cache = _DelayCache(CACHE_TTL_SECONDS)


async def _refresh_if_stale(force_refresh: bool = False) -> None:
    if not force_refresh and _cache.is_fresh:
        return
    try:
        payload = await _fetch_feed()
        delays = _parse_feed(payload)
        _cache.set(delays, source="live")
    except (httpx.HTTPError, ValueError, KeyError):
        # Leave whatever's cached in place (even if stale) — callers treat a
        # missing/None reading as "no live data for this station" and fall
        # back to the kinematic model regardless of why it's missing.
        pass


async def get_live_station_delay(station_id: str) -> Optional[int]:
    """Observed live delay (seconds) at `station_id` from the current GTFS-RT
    snapshot, or None if there's no live reading for that station."""
    await _refresh_if_stale()
    return _cache.get(station_id)
