"""Live TTC service alerts (closures, delays, maintenance) for Lines 1, 2, 4.

Pulls the same JSON feed that powers TTC's own live map widget
(https://livemap.ttc.ca) — reverse-engineered from that app's bundled JS,
which calls `https://www.ttc.ca/ttcapi/routedetail/getallroutesandstopsalerts`
with no auth. Caches the result in memory for CACHE_TTL_SECONDS.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from datetime import datetime, time as dt_time
from typing import Optional

import httpx

from . import stations

TTC_ALERTS_URL = "https://www.ttc.ca/ttcapi/routedetail/getallroutesandstopsalerts"
CACHE_TTL_SECONDS = 2 * 60  # 2 minutes

_REQUEST_HEADERS = {"User-Agent": "commuteTO/1.0 (+https://github.com/)"}

# Only these route numbers are subway lines we model; the feed also carries
# bus/streetcar alerts under the same "routeAlerts" list.
SUBWAY_LINES = {1, 2, 4}

# TTC's sentinel for "no defined end time" (still active / ongoing).
_NO_END_SENTINEL = "0001-01-01T00:00:00Z"

_CLOSURE_KEYWORDS = ("no subway service", "closure", "closed", "suspended", "no service")
_DELAY_CAUSES = {
    "MEDICAL_EMERGENCY",
    "PERSON_ON_TRACK",
    "SECURITY_INCIDENT",
    "POLICE_ACTIVITY",
    "PASSENGER_ASSISTANCE",
    "SIGNAL_PROBLEM",
    "TRAIN_TRAFFIC",
    "MECHANICAL",
    "FIRE_ALARM",
}
_MAINTENANCE_CAUSES = {"MAINTENANCE", "CONSTRUCTION"}

_SERVICE_RESUMED_PATTERN = re.compile(r"regular service has resumed", re.IGNORECASE)
# An alert whose affected stations cover this much of the line end-to-end
# reads as a general line-wide status update ("delays between Vaughan and
# Finch"), not a pinpointed incident — even when TTC files it as "Delays".
_LINE_WIDE_COVERAGE_THRESHOLD = 0.7


def _is_line_wide_advisory(description: str, line: int, affected_station_ids: list[str]) -> bool:
    """True for broad terminus-to-terminus status updates rather than a
    specific, localized incident or hold — these shouldn't be penalized
    like a pinpointed delay (see traffic_service.py)."""
    if _SERVICE_RESUMED_PATTERN.search(description):
        return True
    total_stations = len(stations.LINE_STATION_IDS.get(line, []))
    if total_stations == 0:
        return False
    return len(affected_station_ids) / total_stations >= _LINE_WIDE_COVERAGE_THRESHOLD

_NIGHTLY_KEYWORD_PATTERN = re.compile(r"\bnightly\b", re.IGNORECASE)
_CLOCK_TIME_PATTERN = re.compile(r"\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?", re.IGNORECASE)
_CLOCK_TIME_TOKEN_PATTERN = re.compile(r"(\d{1,2})(?::(\d{2}))?\s*([ap])", re.IGNORECASE)
# TTC's usual first-train time — used as the end of the window when an alert
# only states when the closure begins ("starting 11:59 p.m.") and not when
# service resumes.
_DEFAULT_NIGHTLY_END = dt_time(6, 0)


def _parse_clock_time(text: str) -> Optional[dt_time]:
    match = _CLOCK_TIME_TOKEN_PATTERN.match(text.strip())
    if not match:
        return None
    hour = int(match.group(1)) % 12
    minute = int(match.group(2)) if match.group(2) else 0
    if match.group(3).lower() == "p":
        hour += 12
    return dt_time(hour=hour, minute=minute)


def find_nightly_window(description: str) -> Optional[tuple[dt_time, dt_time, str]]:
    """If `description` reads like a recurring overnight closure (contains
    "nightly" plus at least one clock time), return
    (window_start, window_end, raw_start_time_text) — else None.

    Falls back to `_DEFAULT_NIGHTLY_END` when only a start time is given,
    which is the common case ("starting 11:59 p.m., nightly ...").
    """
    if not _NIGHTLY_KEYWORD_PATTERN.search(description):
        return None

    times = _CLOCK_TIME_PATTERN.findall(description)
    if not times:
        return None

    start = _parse_clock_time(times[0])
    if start is None:
        return None
    end = _parse_clock_time(times[1]) if len(times) > 1 else None

    return start, end or _DEFAULT_NIGHTLY_END, times[0]


def _time_in_window(check: dt_time, start: dt_time, end: dt_time) -> bool:
    if start <= end:
        return start <= check < end
    return check >= start or check < end  # window wraps past midnight


def is_within_nightly_window(description: str, moment: datetime) -> Optional[bool]:
    """None if `description` isn't a recognized nightly-closure pattern;
    else whether `moment`'s time-of-day falls inside that window."""
    window = find_nightly_window(description)
    if window is None:
        return None
    start, end, _ = window
    return _time_in_window(moment.time(), start, end)


def describe_nightly_window(description: str) -> Optional[str]:
    """A short "informational notice" headline for a recognized nightly
    closure, e.g. "Planned Nightly Closure: Starts at 11:59 p.m." """
    window = find_nightly_window(description)
    if window is None:
        return None
    _, _, raw_start_text = window
    return f"Planned Nightly Closure: Starts at {raw_start_text.strip()}"


_WEEKEND_KEYWORD_PATTERN = re.compile(r"\bthis weekend\b|\bsaturday\b|\bsunday\b", re.IGNORECASE)
# Python's date.weekday(): Monday=0 ... Saturday=5, Sunday=6.
_SATURDAY, _SUNDAY = 5, 6


def is_within_weekend_window(description: str, moment: datetime) -> Optional[bool]:
    """None if `description` doesn't explicitly mention "this weekend",
    "Saturday", or "Sunday"; else whether `moment` falls on Saturday or
    Sunday. A real TTC alert can describe a Saturday/Sunday-only closure
    with an active_period spanning the whole surrounding week (see
    detour_service.py), so — same as is_within_nightly_window — the raw
    active-period range alone can't tell a weekday request that the
    disruption doesn't actually apply to it."""
    if not _WEEKEND_KEYWORD_PATTERN.search(description):
        return None
    return moment.weekday() in (_SATURDAY, _SUNDAY)


def describe_weekend_window(description: str) -> Optional[str]:
    """A short "informational notice" headline for a recognized
    weekend-scoped closure."""
    if not _WEEKEND_KEYWORD_PATTERN.search(description):
        return None
    return "Planned Weekend Closure"


def is_within_recognized_window(description: str, moment: datetime) -> Optional[bool]:
    """Combines the nightly and weekend day/time-window checks into the one
    call sites actually need: None only if `description` matches neither
    recognized pattern (i.e. it's genuinely active whenever its
    active_period says so, not further day/time-scoped); else whether
    `moment` falls inside whichever pattern it does match."""
    nightly = is_within_nightly_window(description, moment)
    if nightly is not None:
        return nightly
    return is_within_weekend_window(description, moment)


def describe_recognized_window(description: str) -> Optional[str]:
    return describe_nightly_window(description) or describe_weekend_window(description)


def _classify(effect_desc: str, header_text: str, cause: str) -> str:
    """Categorize an alert as "closure", "delay", or "maintenance".

    Closure is checked first because TTC tags planned closures with
    cause=MAINTENANCE too (e.g. "Subway Closure - Early Closure" for
    overnight track work) — the effect text is the more reliable signal.
    """
    text = f"{effect_desc} {header_text}".lower()
    if any(keyword in text for keyword in _CLOSURE_KEYWORDS):
        return "closure"
    if "delay" in text or "hold" in text or cause in _DELAY_CAUSES:
        return "delay"
    if "maintenance" in text or "track work" in text or cause in _MAINTENANCE_CAUSES:
        return "maintenance"
    return "delay"


def build_headline(category: str, from_station: str, to_station: str, shuttle_service: bool) -> str:
    same_station = from_station == to_station
    if category == "closure":
        span = from_station if same_station else f"{from_station} and {to_station}"
        return f"Shuttle buses running between {span}" if shuttle_service else f"No subway service between {span}"
    if category == "delay":
        return f"Delays near {from_station}" if same_station else f"Delays between {from_station} and {to_station}"
    return f"Scheduled maintenance near {from_station}" if same_station else (
        f"Scheduled maintenance between {from_station} and {to_station}"
    )


@dataclass
class ServiceAlert:
    id: str
    line: int
    category: str
    headline: str
    description: str
    direction: str
    from_station: str
    to_station: str
    affected_station_ids: list[str]
    shuttle_service: bool
    posted_at: Optional[str]
    active_until: Optional[str]
    is_upcoming_notice: bool = False
    is_advisory: bool = False

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "line": self.line,
            "category": self.category,
            "headline": self.headline,
            "description": self.description,
            "direction": self.direction,
            "fromStation": self.from_station,
            "toStation": self.to_station,
            "affectedStationIds": self.affected_station_ids,
            "shuttleService": self.shuttle_service,
            "postedAt": self.posted_at,
            "activeUntil": self.active_until,
            "isUpcomingNotice": self.is_upcoming_notice,
            "isAdvisory": self.is_advisory,
        }


def _parse_alert(raw: dict) -> Optional[ServiceAlert]:
    if raw.get("routeType") != "Subway":
        return None
    try:
        line = int(raw["route"])
    except (KeyError, TypeError, ValueError):
        return None
    if line not in SUBWAY_LINES:
        return None

    effect_desc = raw.get("effectDesc") or ""
    header_text = raw.get("headerText") or ""
    cause = raw.get("cause") or ""
    category = _classify(effect_desc, header_text, cause)

    from_station = stations.normalize_station_name(raw.get("stopStart") or "")
    to_station = stations.normalize_station_name(raw.get("stopEnd") or "")
    shuttle_service = bool(raw.get("shuttleType"))

    affected_station_ids: list[str] = []
    for raw_name in raw.get("stopIDList") or []:
        station_id = stations.find_station_id(raw_name)
        if station_id and station_id not in affected_station_ids:
            affected_station_ids.append(station_id)

    active_period = raw.get("activePeriod") or {}
    active_until = active_period.get("end")
    if active_until == _NO_END_SENTINEL:
        active_until = None

    description = header_text or effect_desc
    headline = build_headline(category, from_station, to_station, shuttle_service)
    is_advisory = _is_line_wide_advisory(description, line, affected_station_ids)

    # For the generic feed (no specific trip in mind), judge a closure's
    # nightly/weekend window against the current moment — traffic_service.py
    # re-judges this per-request against the rider's actual departure time.
    is_upcoming_notice = False
    if category == "closure" and is_within_recognized_window(description, datetime.now()) is False:
        is_upcoming_notice = True
        notice_headline = describe_recognized_window(description)
        if notice_headline:
            headline = notice_headline

    return ServiceAlert(
        id=str(raw.get("id")),
        line=line,
        category=category,
        headline=headline,
        description=description,
        direction=raw.get("compassDirection") or raw.get("direction") or "Both ways",
        from_station=from_station,
        to_station=to_station,
        affected_station_ids=affected_station_ids,
        shuttle_service=shuttle_service,
        posted_at=active_period.get("start"),
        active_until=active_until,
        is_upcoming_notice=is_upcoming_notice,
        is_advisory=is_advisory,
    )


def _parse_alerts(payload: dict) -> tuple[list[dict], Optional[str]]:
    raw_alerts = payload.get("routeAlerts") or []
    alerts = [_parse_alert(raw) for raw in raw_alerts]
    return [alert.to_dict() for alert in alerts if alert is not None], payload.get("lastUpdated")


async def _fetch_alerts() -> dict:
    async with httpx.AsyncClient(timeout=10.0, headers=_REQUEST_HEADERS) as client:
        response = await client.get(TTC_ALERTS_URL)
        response.raise_for_status()
        return response.json()


class _AlertsCache:
    def __init__(self, ttl_seconds: int):
        self._ttl_seconds = ttl_seconds
        self._alerts: list[dict] = []
        self._last_updated: Optional[str] = None
        self._fetched_at: Optional[float] = None
        self._source = "fallback"

    @property
    def has_data(self) -> bool:
        return self._fetched_at is not None

    @property
    def is_fresh(self) -> bool:
        return (
            self._fetched_at is not None
            and (time.monotonic() - self._fetched_at) < self._ttl_seconds
        )

    def set(self, alerts: list[dict], last_updated: Optional[str], source: str) -> None:
        self._alerts = alerts
        self._last_updated = last_updated
        self._fetched_at = time.monotonic()
        self._source = source

    def snapshot(self) -> dict:
        return {
            "alerts": self._alerts,
            "lastUpdated": self._last_updated,
            "source": self._source,
        }


_cache = _AlertsCache(CACHE_TTL_SECONDS)


async def get_alerts(force_refresh: bool = False) -> dict:
    """Return the cached (or freshly fetched) list of active subway alerts.

    Falls back to the last good cache on a failed fetch. If there's no prior
    data at all, falls back to an empty alert list — unlike slow zones,
    fabricating a plausible "baseline" incident would be actively
    misleading, so "no alerts" is the honest default.
    """
    if not force_refresh and _cache.is_fresh:
        return _cache.snapshot()

    try:
        payload = await _fetch_alerts()
        alerts, last_updated = _parse_alerts(payload)
        _cache.set(alerts, last_updated, source="live")
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        if not _cache.has_data:
            _cache.set([], None, source="fallback")

    return _cache.snapshot()
