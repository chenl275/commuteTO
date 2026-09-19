"""Live GTFS-Realtime TripUpdates ingestion for surface transit (streetcars
and buses) — the general https://gtfsrt.ttc.ca/trips/update feed, which
(unlike gtfs_service.py's subway-only endpoint) covers every TTC route,
confirmed live against streetcar (504, 506, ...) and bus (85, ...) trips.

A task requesting this feature named a different host —
https://bustime.ttc.ca/gtfsrt/tripupdates — as the source. That exact path
404s to an HTML directory listing (the real one, discovered the same way as
this module's own gtfsrt.ttc.ca URL originally was: https://bustime.ttc.ca/gtfsrt/trips),
but fetching it confirms it and gtfsrt.ttc.ca/trips/update are mirrors of
the *identical* underlying feed: matched live side by side, both return the
same trip_ids (e.g. "-1470290236") for the same routes at the same
timestamps down to the second. So this module keeps polling the one URL
already proven reliable here rather than adding a second poller that would
just double the request volume against the same backend for no new data.

Same fundamental caveat noted when this module was first written: this
feed's StopTimeUpdates only ever populate arrival/departure `.time` (an
absolute predicted Unix timestamp) — never `.delay`, confirmed again across
the full live feed (0 of ~20,500 StopTimeUpdates) — and its trip_ids come
from TTC's internal vehicle-tracking system, not the published static GTFS
(every entity's schedule_relationship is NEW/DELETED, never the static
feed's own ids). `.delay` is still read when present (a `SurfacePrediction`
carries it) so a real value is used the moment TTC ever populates one,
instead of always recomputing our own.

Two lookups are exposed, both backed by the same cache:
  - get_prediction_for_trip_stop(trip_id, stop_id): the literal (trip_id,
    stop_id) join the raw feed itself is keyed by. Only useful for a
    trip_id sourced from this same live feed — router.py's own static GTFS
    trip_ids never match one (see above), so this exists for completeness/
    future use, not as router.py's actual integration point.
  - get_live_departure(route_short_name, stop_id, scheduled_epoch): the
    real integration point — since no trip_id crosswalk exists, this finds
    whichever currently-tracked vehicle on that route+stop is nearest in
    time to a *specific* scheduled departure (router.py's own itinerary
    leg), the same "nearest-in-time, no crosswalk" fallback this module
    has always used, just matching a caller-supplied target instead of
    matching each other for the aggregate get_route_delay_seconds() below.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional
import sqlite3

import httpx
from google.protobuf.message import DecodeError
from google.transit import gtfs_realtime_pb2

GTFS_RT_TRIP_UPDATES_URL = "https://gtfsrt.ttc.ca/trips/update?format=binary"
# How often a fresh fetch is even attempted — matches the 30-second poll
# interval requested for this feature.
CACHE_TTL_SECONDS = 30
# Beyond this since the last *successful* fetch, cached predictions are old
# enough that a fetch has clearly been failing for a while (the feed is
# unreachable, or every response has failed to parse) — the system-wide
# analogue of a single vehicle's tracking dropping out: rather than keep
# quietly serving an ever-more-outdated reading, callers treat the whole
# feed as untrustworthy and fall back to the static schedule, flagged
# distinctly (see router.py's `tracking_unavailable`) from a route that
# simply has no live vehicle tracked at this exact moment.
STALE_AFTER_SECONDS = 90

_REQUEST_HEADERS = {"User-Agent": "commuteTO/1.0 (+https://github.com/)"}
_DB_PATH = Path(__file__).resolve().parents[1] / "data" / "gtfs_routing.db"

# Beyond this, the nearest scheduled/live match found is too far from the
# target time to trust as the same real-world trip.
NEAREST_MATCH_MAX_SECONDS = 45 * 60


def _get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{_DB_PATH}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only = TRUE")
    return conn


@dataclass
class SurfacePrediction:
    """One live vehicle's predicted arrival/departure at one stop, as the
    feed itself reports it — trip_id is the feed's own internal id (see
    module docstring: never our static GTFS trip_id)."""

    trip_id: str
    predicted_epoch: int
    # Always None against the real feed today (see module docstring) —
    # respected directly whenever present rather than only ever computing
    # our own predicted-vs-scheduled delay.
    reported_delay_seconds: Optional[int] = None


@dataclass
class LiveDeparture:
    """A live reading matched to one specific scheduled departure (see
    get_live_departure) — router.py's actual per-leg live-ETA source."""

    predicted_epoch: int
    delay_seconds: int
    trip_id: str


class _SurfacePredictionCache:
    """Thread-safe in-memory cache of the live feed's latest predictions,
    indexed two ways: by the feed's own (trip_id, stop_id) — the literal key
    item 1 of this feature asks for — and by (route_short_name, stop_id),
    since GTFS-RT's route_id field already matches our route_short_name
    convention for this feed (e.g. "504", "85"), confirmed live, so no
    separate crosswalk is needed there. A route+stop can have more than one
    currently-tracked vehicle (short headways), so that index keeps a list."""

    def __init__(self, ttl_seconds: int, stale_after_seconds: int):
        self._ttl_seconds = ttl_seconds
        self._stale_after_seconds = stale_after_seconds
        self._lock = threading.Lock()
        self._by_trip_stop: dict[tuple[str, str], SurfacePrediction] = {}
        self._by_route_stop: dict[tuple[str, str], list[SurfacePrediction]] = {}
        self._fetched_at: Optional[float] = None

    @property
    def is_fresh(self) -> bool:
        """True when a fetch was attempted recently enough that another one
        isn't worth making yet — independent of whether that fetch actually
        succeeded (see is_stale for that)."""
        with self._lock:
            return self._fetched_at is not None and (time.monotonic() - self._fetched_at) < self._ttl_seconds

    @property
    def is_stale(self) -> bool:
        with self._lock:
            return self._fetched_at is None or (time.monotonic() - self._fetched_at) > self._stale_after_seconds

    def set(self, rows: list[tuple[str, str, SurfacePrediction]]) -> None:
        by_trip_stop: dict[tuple[str, str], SurfacePrediction] = {}
        by_route_stop: dict[tuple[str, str], list[SurfacePrediction]] = defaultdict(list)
        for route_id, stop_id, prediction in rows:
            by_trip_stop[(prediction.trip_id, stop_id)] = prediction
            by_route_stop[(route_id, stop_id)].append(prediction)
        with self._lock:
            self._by_trip_stop = by_trip_stop
            self._by_route_stop = dict(by_route_stop)
            self._fetched_at = time.monotonic()

    def get_by_trip_stop(self, trip_id: str, stop_id: str) -> Optional[SurfacePrediction]:
        with self._lock:
            return self._by_trip_stop.get((trip_id, stop_id))

    def predictions_for_route_stop(self, route_short_name: str, stop_id: str) -> list[SurfacePrediction]:
        with self._lock:
            return list(self._by_route_stop.get((route_short_name, stop_id), []))


_cache = _SurfacePredictionCache(CACHE_TTL_SECONDS, STALE_AFTER_SECONDS)


def _parse_feed(payload: bytes) -> list[tuple[str, str, SurfacePrediction]]:
    """[(route_id, stop_id, SurfacePrediction), ...] across every entity in
    the feed — every reading kept (not last-write-wins) so a route+stop with
    more than one currently-tracked vehicle keeps all of them for the
    nearest-match lookups below."""
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(payload)

    rows: list[tuple[str, str, SurfacePrediction]] = []
    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue
        trip_update = entity.trip_update
        route_id = trip_update.trip.route_id
        trip_id = trip_update.trip.trip_id
        if not route_id or not trip_id:
            continue
        for stop_time_update in trip_update.stop_time_update:
            predicted: Optional[int] = None
            reported_delay: Optional[int] = None
            if stop_time_update.HasField("arrival"):
                if stop_time_update.arrival.HasField("time"):
                    predicted = stop_time_update.arrival.time
                if stop_time_update.arrival.HasField("delay"):
                    reported_delay = stop_time_update.arrival.delay
            if predicted is None and stop_time_update.HasField("departure"):
                if stop_time_update.departure.HasField("time"):
                    predicted = stop_time_update.departure.time
                if reported_delay is None and stop_time_update.departure.HasField("delay"):
                    reported_delay = stop_time_update.departure.delay
            if predicted is None:
                continue
            rows.append(
                (
                    route_id,
                    stop_time_update.stop_id,
                    SurfacePrediction(trip_id=trip_id, predicted_epoch=predicted, reported_delay_seconds=reported_delay),
                )
            )
    return rows


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
    except (httpx.HTTPError, ValueError, KeyError, DecodeError):
        # Leave whatever's cached in place (even if stale) — is_stale (above)
        # is what tells callers when that cached data is too old to trust;
        # this alone just avoids raising out of a request path over a feed
        # hiccup, the same "no data beats a 500" precedent as detour_service.py.
        pass


def is_feed_stale() -> bool:
    """True when the live feed hasn't been successfully refreshed in over
    STALE_AFTER_SECONDS — the feed is unreachable, or every recent response
    failed to parse. router.py checks this only *after* a get_live_departure
    miss, to tell "this route genuinely has no live vehicle right now" (a
    normal, common case — not every stop has one at every moment) apart from
    "the whole tracking system is down" (see its `tracking_unavailable`)."""
    return _cache.is_stale


def get_prediction_for_trip_stop(trip_id: str, stop_id: str) -> Optional[SurfacePrediction]:
    """Direct (trip_id, stop_id) lookup, exactly as the raw feed is keyed —
    see module docstring for why this is only useful for a trip_id sourced
    from this same live feed, not from router.py's own static GTFS
    itineraries. Does not trigger a refresh; callers wanting fresh data
    should go through get_live_departure or call _refresh_if_stale first."""
    return _cache.get_by_trip_stop(trip_id, stop_id)


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


async def get_live_departure(route_short_name: str, stop_id: str, scheduled_epoch: float) -> Optional[LiveDeparture]:
    """The live prediction nearest in time to `scheduled_epoch` (a router.py
    itinerary leg's own scheduled boarding time, as a Unix timestamp) among
    every vehicle currently tracked on `route_short_name` at `stop_id` — or
    None when there's nothing usable within NEAREST_MATCH_MAX_SECONDS (no
    vehicle tracked there right now, or the feed itself is stale/unreachable
    — see is_feed_stale to tell those two apart)."""
    await _refresh_if_stale()

    candidates = _cache.predictions_for_route_stop(route_short_name, stop_id)
    if not candidates:
        return None

    nearest = min(candidates, key=lambda p: abs(p.predicted_epoch - scheduled_epoch))
    if abs(nearest.predicted_epoch - scheduled_epoch) > NEAREST_MATCH_MAX_SECONDS:
        return None

    delay = (
        nearest.reported_delay_seconds
        if nearest.reported_delay_seconds is not None
        else int(nearest.predicted_epoch - scheduled_epoch)
    )
    return LiveDeparture(predicted_epoch=nearest.predicted_epoch, delay_seconds=delay, trip_id=nearest.trip_id)


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
            candidates = _cache.predictions_for_route_stop(route_short_name, stop_id)
            if not candidates:
                continue
            # The soonest still-upcoming prediction is the most relevant
            # "is this stop currently running late" reading when more than
            # one vehicle is tracked there; falls back to the latest past
            # one if every tracked vehicle has already gone by.
            now = time.time()
            upcoming = [p for p in candidates if p.predicted_epoch >= now]
            prediction = min(upcoming, key=lambda p: p.predicted_epoch) if upcoming else max(
                candidates, key=lambda p: p.predicted_epoch
            )

            local = datetime.fromtimestamp(prediction.predicted_epoch)
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
