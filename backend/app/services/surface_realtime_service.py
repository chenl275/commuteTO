"""Live GTFS-Realtime TripUpdates ingestion for surface transit (streetcars
and buses) — the general https://gtfsrt.ttc.ca/trips/update feed, which
(unlike gtfs_service.py's subway-only endpoint) covers every TTC route,
confirmed live against streetcar (504, 506, ...) and bus (85, ...) trips.

Same fundamental caveat as the subway feed (see gtfs_service.py's own
docstring): this feed's StopTimeUpdates only ever populate arrival/
departure `.time` (an absolute predicted Unix timestamp), never `.delay`,
and its trip_ids come from TTC's internal vehicle-tracking system, not the
published static GTFS — confirmed live, essentially none of the feed's
trip_ids exist in our static `trips` table, so there's no crosswalk to a
specific static trip to diff a predicted time against "that same trip's"
scheduled time.

Instead, for a given route + stop, this compares the predicted time against
the *nearest-in-time* scheduled arrival at that same stop on that same
route from the static schedule — a standard fallback when no trip_id
crosswalk exists, and only trusted within NEAREST_MATCH_MAX_SECONDS of the
predicted time, so a stray/unrelated stop_time row hours away can't be
mistaken for this vehicle's own schedule.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import httpx
from google.transit import gtfs_realtime_pb2

GTFS_RT_TRIP_UPDATES_URL = "https://gtfsrt.ttc.ca/trips/update?format=binary"
CACHE_TTL_SECONDS = 30

_REQUEST_HEADERS = {"User-Agent": "commuteTO/1.0 (+https://github.com/)"}
_DB_PATH = Path(__file__).resolve().parents[1] / "data" / "gtfs_routing.db"

# Beyond this, the "nearest" static scheduled time-of-day is too far from
# the live prediction to trust as the same real-world trip's schedule.
NEAREST_MATCH_MAX_SECONDS = 45 * 60


def _get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{_DB_PATH}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only = TRUE")
    return conn


class _SurfacePredictionCache:
    """Thread-safe in-memory cache of the live feed's latest prediction per
    (route_short_name, stop_id) — GTFS-RT's own route_id field already
    matches our route_short_name convention for this feed (e.g. "504",
    "85"), confirmed live, so no separate crosswalk is needed there."""

    def __init__(self, ttl_seconds: int):
        self._ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._predictions: dict[tuple[str, str], int] = {}
        self._fetched_at: Optional[float] = None

    @property
    def is_fresh(self) -> bool:
        with self._lock:
            return self._fetched_at is not None and (time.monotonic() - self._fetched_at) < self._ttl_seconds

    def set(self, predictions: dict[tuple[str, str], int]) -> None:
        with self._lock:
            self._predictions = predictions
            self._fetched_at = time.monotonic()

    def get(self, route_short_name: str, stop_id: str) -> Optional[int]:
        with self._lock:
            return self._predictions.get((route_short_name, stop_id))


_cache = _SurfacePredictionCache(CACHE_TTL_SECONDS)


def _parse_feed(payload: bytes) -> dict[tuple[str, str], int]:
    """(route_short_name, stop_id) -> predicted arrival/departure Unix
    timestamp, across every entity in the feed. Last write wins for a
    given key when more than one entity predicts the same route+stop."""
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(payload)

    predictions: dict[tuple[str, str], int] = {}
    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue
        route_id = entity.trip_update.trip.route_id
        if not route_id:
            continue
        for stop_time_update in entity.trip_update.stop_time_update:
            predicted: Optional[int] = None
            if stop_time_update.HasField("arrival") and stop_time_update.arrival.HasField("time"):
                predicted = stop_time_update.arrival.time
            elif stop_time_update.HasField("departure") and stop_time_update.departure.HasField("time"):
                predicted = stop_time_update.departure.time
            if predicted is None:
                continue
            predictions[(route_id, stop_time_update.stop_id)] = predicted
    return predictions


async def _fetch_feed() -> bytes:
    async with httpx.AsyncClient(timeout=10.0, headers=_REQUEST_HEADERS) as client:
        response = await client.get(GTFS_RT_TRIP_UPDATES_URL)
        response.raise_for_status()
        return response.content


async def _refresh_if_stale() -> None:
    if _cache.is_fresh:
        return
    try:
        payload = await _fetch_feed()
        _cache.set(_parse_feed(payload))
    except (httpx.HTTPError, ValueError, KeyError):
        # Leave whatever's cached in place (even if stale) — callers treat a
        # missing reading as "no live data" and fall back to whatever
        # modeled/detour-based estimate they already have.
        pass


def _nearest_scheduled_arrival_sec(
    conn: sqlite3.Connection, route_short_name: str, stop_id: str, target_sec_of_day: float
) -> Optional[float]:
    rows = conn.execute(
        "SELECT st.arrival_sec FROM stop_times st "
        "JOIN trips t ON st.trip_id = t.trip_id "
        "JOIN routes r ON t.route_id = r.route_id "
        "WHERE r.short_name = ? AND st.stop_id = ?",
        (route_short_name, stop_id),
    ).fetchall()
    if not rows:
        return None
    nearest = min(rows, key=lambda row: abs(row[0] - target_sec_of_day))[0]
    return float(nearest) if abs(nearest - target_sec_of_day) <= NEAREST_MATCH_MAX_SECONDS else None


async def get_route_delay_seconds(route_short_name: str, stop_ids: list[str]) -> Optional[int]:
    """Best-effort observed live delay (seconds) for `route_short_name`
    across `stop_ids` (typically an itinerary leg's boarding + alighting
    stops) — the largest predicted-vs-nearest-scheduled gap found, so one
    badly-delayed vehicle isn't averaged away by on-time ones elsewhere on
    the route (same "worst observed, not average" philosophy as
    gtfs_service.get_live_station_delay). None if the live feed has no
    usable prediction for any of these stops right now, or predicts them
    on time/early."""
    await _refresh_if_stale()

    worst_delay: Optional[int] = None
    conn = _get_connection()
    try:
        for stop_id in stop_ids:
            predicted_ts = _cache.get(route_short_name, stop_id)
            if predicted_ts is None:
                continue

            local = datetime.fromtimestamp(predicted_ts)
            predicted_sec_of_day = local.hour * 3600 + local.minute * 60 + local.second
            scheduled_sec = _nearest_scheduled_arrival_sec(conn, route_short_name, stop_id, predicted_sec_of_day)
            if scheduled_sec is None:
                continue

            delay = predicted_sec_of_day - scheduled_sec
            if delay > 0 and (worst_delay is None or delay > worst_delay):
                worst_delay = int(delay)
    finally:
        conn.close()

    return worst_delay
