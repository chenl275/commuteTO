"""GTFS-RT ServiceAlerts detour detection for any route a commute might use —
subway line numbers ("1", "2", "4") and streetcar/night-bus route numbers
("504", "320") alike. A broader net than alerts_service.py's TTC-widget
feed, which only covers subway.

Real feed URL discovered the same way as gtfs_service.py's trip-updates and
vehicle-positions feeds: the URL commonly cited under opendata.toronto.ca
doesn't resolve to real protobuf (a generic HTML shell, HTTP 200); the real
endpoint is under gtfsrt.ttc.ca. Confirmed live: 91 entities across subway
and ~80 surface routes, spanning `effect` values NO_SERVICE, DETOUR,
MODIFIED_SERVICE, REDUCED_SERVICE, ACCESSIBILITY_ISSUE, NO_EFFECT.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

import httpx
from google.protobuf.message import DecodeError
from google.transit import gtfs_realtime_pb2

from . import gtfs_service
from .alerts_service import is_within_recognized_window

GTFS_RT_ALERTS_URL = "https://gtfsrt.ttc.ca/alerts/all?format=binary"
_ROUTING_DB_PATH = Path(__file__).resolve().parents[1] / "data" / "gtfs_routing.db"
# Matches alerts_service.py's TTC-widget cache TTL — detour/construction
# notices don't change on the scale of seconds like vehicle positions do.
CACHE_TTL_SECONDS = 2 * 60

_REQUEST_HEADERS = {"User-Agent": "commuteTO/1.0 (+https://github.com/)"}

# Matched case-insensitively against an alert's header+description text. The
# `effect` enum (DETOUR/MODIFIED_SERVICE/...) alone isn't a reliable signal —
# real TTC-authored reroutes are inconsistently tagged (a genuine "divert
# via..." reroute is filed as MODIFIED_SERVICE about as often as DETOUR), so
# this keys off the same rider-facing language TTC actually writes.
_DETOUR_KEYWORDS = ("detour", "diverting", "divert", "construction", "shuttle buses")

# Checked first, and short-circuits a match even when the text also contains
# a word from _DETOUR_KEYWORDS — TTC's own resolution notices routinely
# reuse the same vocabulary as the original disruption (e.g. real feed text:
# "The 503 Kingston Rd replacement bus will no longer divert as the TTC
# track work ends... regular service will resume"), so a keyword-only check
# would flag an already-cleared detour as still active.
_RESOLVED_KEYWORDS = (
    "no longer divert",
    "resumed normal service",
    "regular service has resumed",
    "regular service will resume",
    "service resumed",
    "service restored",
    "cleared",
)

# A realistic added-ETA penalty for an active detour, sized by how severe the
# feed says the effect is — same spirit as traffic_service.py's existing
# CLOSURE_SHUTTLE_PENALTY_MINUTES/INCIDENT_HOLD_PENALTY_MINUTES tiers, kept
# within the +8 to +15 minute range a real reroute or shuttle substitution
# plausibly costs.
_DETOUR_EFFECT_PENALTY_MINUTES = {
    "NO_SERVICE": 15.0,
    "DETOUR": 15.0,
    "MODIFIED_SERVICE": 10.0,
    "REDUCED_SERVICE": 8.0,
    "ACCESSIBILITY_ISSUE": 8.0,
}
_DEFAULT_DETOUR_PENALTY_MINUTES = 10.0

# GET /api/detours filters on the raw GTFS-RT `effect` enum directly (unlike
# DetourAlert's keyword-based _is_detour_text, chosen there specifically
# because real TTC alerts tag effect inconsistently) — this is the exact
# set item 2 of the task asks for.
_SURFACE_DETOUR_EFFECTS = {"DETOUR", "MODIFIED_SERVICE", "NO_SERVICE"}


def _resolve_stop_details(stop_ids: list[str]) -> list[dict]:
    """[{id, name, lat, lon}, ...] for `stop_ids`, from the same routing
    database router.py queries — a frontend map has no other way to place a
    marker for an arbitrary GTFS stop_id (unlike a subway station, a
    streetcar/bus stop isn't in the static ttc-stations.json/subwayGeoJSON
    registry). Silently drops any stop_id not found rather than raising —
    a stale/renamed stop_id in a live alert shouldn't break the whole panel."""
    if not stop_ids or not _ROUTING_DB_PATH.exists():
        return []
    conn = sqlite3.connect(f"file:{_ROUTING_DB_PATH}?mode=ro", uri=True)
    try:
        placeholders = ",".join("?" * len(stop_ids))
        rows = conn.execute(
            f"SELECT stop_id, name, lat, lon FROM stops WHERE stop_id IN ({placeholders})",
            tuple(stop_ids),
        ).fetchall()
        by_id = {row[0]: {"id": row[0], "name": row[1], "lat": row[2], "lon": row[3]} for row in rows}
        # Preserve the alert's own stop order rather than SQL's arbitrary one.
        return [by_id[stop_id] for stop_id in stop_ids if stop_id in by_id]
    finally:
        conn.close()


@dataclass
class SurfaceDetour:
    """One active subway/streetcar/bus detour/disruption, shaped for the
    public GET /api/detours endpoint — a broader net than DetourAlert below
    in one sense (effect-filtered rather than keyword-filtered, see
    get_active_surface_detours) and a narrower one in another (only the
    three effect values item 2's spec calls out, vs. DetourAlert's wider
    keyword match). Keeps the raw GTFS stop_ids an alert names instead of
    collapsing them to our own station-id registry, since a streetcar/bus
    stop has no equivalent mapping there (a subway stop_id still resolves
    fine via the routing DB's own `stops` table)."""

    id: str
    route_ids: list[str]
    header: str
    description: str
    summary: str
    effect: str
    affected_stop_ids: list[str]
    # Resolved separately (see _resolve_stop_details) — a subset of
    # affected_stop_ids when the routing DB doesn't have a matching row.
    affected_stops: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "routeId": self.route_ids[0] if self.route_ids else None,
            # TTC's feed uses the same string for route_id and
            # route_short_name on every bus/streetcar route (confirmed
            # against the static feed), but both are surfaced distinctly
            # per the API contract in case that ever isn't true.
            "routeShortName": self.route_ids[0] if self.route_ids else None,
            "routeIds": self.route_ids,
            "id": self.id,
            "header": self.header,
            "description": self.description,
            "summary": self.summary,
            "effect": self.effect,
            "affectedStopIds": self.affected_stop_ids,
            "affectedStops": self.affected_stops,
        }


@dataclass
class DetourAlert:
    id: str
    route_ids: list[str]
    summary: str
    penalty_minutes: float
    # True for a real alert that isn't in effect *right now* — a future or
    # day/time-scoped notice (see _parse_entity) — surfaced as an
    # informational "Upcoming Notice" only, never a penalty or an active
    # red badge.
    is_future: bool = False
    # Station ids (ours, not GTFS's) the alert's informed_entity.stop_id
    # list maps to — empty when the alert names no specific stops at all,
    # which is treated as "affects the whole route" (see
    # traffic_service.py's station-range check).
    affected_station_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "routeIds": self.route_ids,
            "summary": self.summary,
            "penaltyMinutes": self.penalty_minutes,
            "isFuture": self.is_future,
            "affectedStationIds": self.affected_station_ids,
        }


def _alert_text(alert) -> str:
    header = alert.header_text.translation[0].text if alert.header_text.translation else ""
    description = alert.description_text.translation[0].text if alert.description_text.translation else ""
    return f"{header} {description}".strip()


def _is_detour_text(text: str) -> bool:
    lowered = text.lower()
    if any(keyword in lowered for keyword in _RESOLVED_KEYWORDS):
        return False
    return any(keyword in lowered for keyword in _DETOUR_KEYWORDS)


def _summarize(text: str, limit: int = 140) -> str:
    """A compact one-line summary for a badge — real alert text can run to
    several paragraphs (e.g. the 512/507/510 replacement-service alerts), so
    this takes the first sentence, or a length-capped prefix if even that's
    too long. Cut at the nearest preceding word boundary (not mid-word) —
    real TTC alert text is prose, so a hard character cut used to produce
    abrupt fragments like "...all time pe…" or "...removed fro…" on the
    frontend's badge; the full text is still available separately via
    `header`/`description` for a "Read more" expansion."""
    collapsed = " ".join(text.split())
    period_index = collapsed.find(". ")
    if 0 <= period_index < limit:
        return collapsed[: period_index + 1]
    if len(collapsed) <= limit:
        return collapsed
    truncated = collapsed[:limit]
    last_space = truncated.rfind(" ")
    if last_space > 0:
        truncated = truncated[:last_space]
    return truncated.rstrip() + "…"


def _active_period_status(alert, now: float) -> str:
    """"active" | "future" | "expired", from the alert's active_period
    ranges alone — or "active" (vacuously) when it declares none at all,
    which per the GTFS-RT spec means "always active".

    Real TTC alerts commonly pre-publish a whole run of future nightly
    closures as separate periods (e.g. one per night for the next several
    nights) well ahead of time — `now` sitting inside any one period counts
    as "active"; otherwise "future" if at least one period is still ahead,
    else every period is already over ("expired")."""
    periods = alert.active_period
    if not periods:
        return "active"
    saw_future = False
    for period in periods:
        start = period.start if period.HasField("start") else None
        end = period.end if period.HasField("end") else None
        if start is not None and now < start:
            saw_future = True
            continue
        if end is not None and now > end:
            continue
        return "active"
    return "future" if saw_future else "expired"


def _parse_entity(entity, now: float) -> Optional[DetourAlert]:
    if not entity.HasField("alert"):
        return None
    alert = entity.alert

    # Expired is the one case with nothing worth surfacing at all — future
    # and day/time-scoped-but-not-now alerts are kept (see is_future below)
    # so they can still show as an informational "Upcoming Notice".
    period_status = _active_period_status(alert, now)
    if period_status == "expired":
        return None

    route_ids = sorted({ie.route_id for ie in alert.informed_entity if ie.route_id})
    if not route_ids:
        return None

    text = _alert_text(alert)
    if not text or not _is_detour_text(text):
        return None

    is_future = period_status == "future"

    # The raw active_period range commonly spans an entire multi-day/night
    # run (e.g. a recurring "nightly Monday to Friday" closure's period
    # covers all five days end-to-end, or a "this weekend" one covers the
    # whole surrounding week), not just the actual narrow window the
    # disruption is in effect — this (shared with alerts_service.py's
    # widget-feed handling of the identical patterns) narrows that down to
    # whether *right now* genuinely falls inside the described nightly or
    # weekend window, so a daytime/weekday request doesn't get warned about,
    # or penalized for, a closure that's actually hours or days away.
    if not is_future and is_within_recognized_window(text, datetime.now()) is False:
        is_future = True

    effect_name = gtfs_realtime_pb2.Alert.Effect.Name(alert.effect)
    penalty_minutes = (
        0.0 if is_future else _DETOUR_EFFECT_PENALTY_MINUTES.get(effect_name, _DEFAULT_DETOUR_PENALTY_MINUTES)
    )

    affected_station_ids = sorted(
        {
            station_id
            for ie in alert.informed_entity
            if ie.stop_id and (station_id := gtfs_service.get_station_id_for_stop(ie.stop_id))
        }
    )

    return DetourAlert(
        id=entity.id,
        route_ids=route_ids,
        summary=_summarize(text),
        penalty_minutes=penalty_minutes,
        is_future=is_future,
        affected_station_ids=affected_station_ids,
    )


def _parse_feed(payload: bytes) -> list[DetourAlert]:
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(payload)
    now = time.time()
    return [d for e in feed.entity if (d := _parse_entity(e, now)) is not None]


def _translated_text(field) -> str:
    return field.translation[0].text if field.translation else ""


def _parse_surface_detour_entity(entity, now: float) -> Optional[SurfaceDetour]:
    if not entity.HasField("alert"):
        return None
    alert = entity.alert

    if _active_period_status(alert, now) != "active":
        return None

    effect_name = gtfs_realtime_pb2.Alert.Effect.Name(alert.effect)
    if effect_name not in _SURFACE_DETOUR_EFFECTS:
        return None

    route_ids = sorted({ie.route_id for ie in alert.informed_entity if ie.route_id})
    if not route_ids:
        return None

    header = _translated_text(alert.header_text)
    description = _translated_text(alert.description_text)
    if not header and not description:
        return None

    affected_stop_ids = sorted({ie.stop_id for ie in alert.informed_entity if ie.stop_id})

    return SurfaceDetour(
        id=entity.id,
        route_ids=route_ids,
        header=header,
        description=description,
        summary=_summarize(f"{header} {description}".strip()),
        effect=effect_name,
        affected_stop_ids=affected_stop_ids,
    )


def _parse_surface_detours_feed(payload: bytes) -> list[SurfaceDetour]:
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(payload)
    now = time.time()
    detours = [d for e in feed.entity if (d := _parse_surface_detour_entity(e, now)) is not None]

    # One batched query for every alert's stops combined, rather than one
    # connection/query per alert.
    all_stop_ids = sorted({stop_id for detour in detours for stop_id in detour.affected_stop_ids})
    stop_details_by_id = {stop["id"]: stop for stop in _resolve_stop_details(all_stop_ids)}
    for detour in detours:
        detour.affected_stops = [
            stop_details_by_id[stop_id] for stop_id in detour.affected_stop_ids if stop_id in stop_details_by_id
        ]

    return detours


async def get_active_surface_detours() -> list[dict]:
    """Every currently-active subway/streetcar/bus DETOUR/MODIFIED_SERVICE/
    NO_SERVICE alert right now — the full list for GET /api/detours,
    unscoped to any particular commute (contrast get_detours_for_routes)."""
    payload = await _get_raw_feed_payload()
    if not payload:
        return []
    try:
        detours = _parse_surface_detours_feed(payload)
    except DecodeError:
        # The cached payload was truncated/corrupted (a bad response body
        # that still made it past _fetch_feed's own status-code check) —
        # same "no data beats a 500" fallback as an outright fetch failure.
        return []
    return [d.to_dict() for d in detours]


async def _fetch_feed() -> bytes:
    async with httpx.AsyncClient(timeout=10.0, headers=_REQUEST_HEADERS) as client:
        response = await client.get(GTFS_RT_ALERTS_URL)
        response.raise_for_status()
        return response.content


class _RawFeedCache:
    """Thread-safe cache of the raw fetched GTFS-RT alerts payload —
    re-parsed on each read rather than caching a single derived shape,
    since parsing this feed's entity count is cheap and different callers
    need different derived structures (DetourAlert for the commute-delay
    penalty use in get_detours_for_routes, SurfaceDetour for the public
    GET /api/detours endpoint) without paying for a second HTTP fetch."""

    def __init__(self, ttl_seconds: int):
        self._ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._payload: Optional[bytes] = None
        self._fetched_at: Optional[float] = None

    @property
    def is_fresh(self) -> bool:
        with self._lock:
            return self._fetched_at is not None and (time.monotonic() - self._fetched_at) < self._ttl_seconds

    def set(self, payload: bytes) -> None:
        with self._lock:
            self._payload = payload
            self._fetched_at = time.monotonic()

    def get(self) -> Optional[bytes]:
        with self._lock:
            return self._payload


_cache = _RawFeedCache(CACHE_TTL_SECONDS)


async def _get_raw_feed_payload() -> Optional[bytes]:
    if not _cache.is_fresh:
        try:
            payload = await _fetch_feed()
            _cache.set(payload)
        except httpx.HTTPError:
            pass  # keep serving the last good cache (None, on a first-ever failure)
    return _cache.get()


async def _get_all_detours() -> list[DetourAlert]:
    payload = await _get_raw_feed_payload()
    if not payload:
        return []
    try:
        return _parse_feed(payload)
    except DecodeError:
        return []


async def get_detours_for_routes(route_ids: set[str]) -> list[dict]:
    """Active detour/construction/shuttle alerts affecting any of `route_ids`
    (subway line numbers as strings, e.g. "1", or streetcar/night-bus route
    numbers, e.g. "504") — for flagging on a specific commute's legs."""
    if not route_ids:
        return []
    all_detours = await _get_all_detours()
    return [d.to_dict() for d in all_detours if route_ids & set(d.route_ids)]
