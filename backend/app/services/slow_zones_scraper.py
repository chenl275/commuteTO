"""Scraper for the TTC's live Reduced Speed Zones (RSZ) page.

Fetches https://www.ttc.ca/riding-the-ttc/Updates/Reduced-Speed-Zones, parses
the Line 1 / Line 2 tables, and caches the result in memory for
CACHE_TTL_SECONDS so the commute endpoint doesn't hammer ttc.ca on every
request.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Optional

import httpx
from bs4 import BeautifulSoup

from . import stations

TTC_RSZ_URL = "https://www.ttc.ca/riding-the-ttc/Updates/Reduced-Speed-Zones"
CACHE_TTL_SECONDS = 60 * 60  # 1 hour

_REQUEST_HEADERS = {"User-Agent": "commuteTO/1.0 (+https://github.com/)"}

_LINE_NUMBER_PATTERN = re.compile(r"Line\s+(\d+)", re.IGNORECASE)
_LOCATION_PATTERN = re.compile(
    r"^(?P<direction>Northbound|Southbound|Eastbound|Westbound)\s+(?P<from>.+?)\s+to\s+(?P<to>.+)$",
    re.IGNORECASE,
)


@dataclass
class SlowZone:
    line: int
    direction: str
    from_station: str
    to_station: str
    defect_length_meters: int
    distance_between_stations_meters: Optional[int]
    track_reduced_percent: Optional[int]
    reduced_speed_kmh: float
    normal_speed_kmh: float
    reason: str
    target_removal: str

    def delay_seconds(self) -> float:
        """Extra time (seconds) added by crawling the defect at reduced speed
        instead of the normal operating speed."""
        if self.reduced_speed_kmh <= 0 or self.normal_speed_kmh <= 0:
            return 0.0
        return self.defect_length_meters * (
            (3.6 / self.reduced_speed_kmh) - (3.6 / self.normal_speed_kmh)
        )

    def to_dict(self) -> dict:
        from_station_id = stations.find_station_id(self.from_station)
        to_station_id = stations.find_station_id(self.to_station)
        return {
            "line": self.line,
            "direction": self.direction,
            "fromStation": stations.normalize_station_name(self.from_station),
            "toStation": stations.normalize_station_name(self.to_station),
            "fromStationId": from_station_id,
            "toStationId": to_station_id,
            "defectLengthMeters": self.defect_length_meters,
            "distanceBetweenStationsMeters": self.distance_between_stations_meters,
            "trackReducedPercent": self.track_reduced_percent,
            "reducedSpeedKmh": self.reduced_speed_kmh,
            "normalSpeedKmh": self.normal_speed_kmh,
            "reason": self.reason,
            "targetRemoval": self.target_removal,
            "delaySeconds": round(self.delay_seconds(), 1),
        }


def _fallback_zone(**overrides) -> dict:
    zone = SlowZone(
        line=1,
        direction="Northbound",
        from_station="TMU",
        to_station="College",
        defect_length_meters=250,
        distance_between_stations_meters=500,
        track_reduced_percent=50,
        reduced_speed_kmh=15.0,
        normal_speed_kmh=49.0,
        reason="Track issue",
        target_removal="TBD",
    )
    for key, value in overrides.items():
        setattr(zone, key, value)
    return zone.to_dict()


# Minimal baseline used only when the live page can't be reached and there's
# no prior cached data to fall back on.
FALLBACK_SLOW_ZONES: list[dict] = [
    _fallback_zone(),
    _fallback_zone(
        line=2,
        direction="Eastbound",
        from_station="Bay",
        to_station="Bloor-Yonge",
        defect_length_meters=170,
        distance_between_stations_meters=480,
        track_reduced_percent=35,
        reduced_speed_kmh=25.0,
        normal_speed_kmh=46.0,
    ),
]


def _parse_int(text: str) -> Optional[int]:
    text = text.replace(",", "").strip()
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def _parse_float(text: str) -> Optional[float]:
    text = text.replace(",", "").strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _parse_table(table, line: int) -> list[SlowZone]:
    zones: list[SlowZone] = []
    for row in table.select("tbody tr"):
        cells = [cell.get_text(strip=True) for cell in row.select("td")]
        if len(cells) < 8:
            continue

        location, defect_len, distance, track_pct, reduced, normal, reason, target = cells[:8]
        match = _LOCATION_PATTERN.match(location)
        if not match:
            continue

        defect_meters = _parse_int(defect_len)
        reduced_speed = _parse_float(reduced)
        normal_speed = _parse_float(normal)
        if defect_meters is None or reduced_speed is None or normal_speed is None:
            continue

        zones.append(
            SlowZone(
                line=line,
                direction=match.group("direction").title(),
                from_station=match.group("from").strip(),
                to_station=match.group("to").strip(),
                defect_length_meters=defect_meters,
                distance_between_stations_meters=_parse_int(distance),
                track_reduced_percent=_parse_int(track_pct),
                reduced_speed_kmh=reduced_speed,
                normal_speed_kmh=normal_speed,
                reason=reason or "Unspecified",
                target_removal=target or "TBD",
            )
        )
    return zones


def _parse_last_updated(soup: BeautifulSoup) -> Optional[str]:
    node = soup.select_one(".updated-date")
    if not node:
        return None
    text = node.get_text(strip=True)
    return text.split(":", 1)[1].strip() if ":" in text else text


def _parse_html(html: str) -> tuple[list[SlowZone], Optional[str]]:
    soup = BeautifulSoup(html, "html.parser")
    zones: list[SlowZone] = []

    for section in soup.select("div.component.reduced-speed-zone-table"):
        heading = section.select_one("h2")
        table = section.select_one("table")
        if heading is None or table is None:
            continue

        line_match = _LINE_NUMBER_PATTERN.search(heading.get_text())
        if not line_match:
            continue

        line = int(line_match.group(1))
        if line not in (1, 2):
            continue

        zones.extend(_parse_table(table, line))

    return zones, _parse_last_updated(soup)


async def _fetch_html() -> str:
    async with httpx.AsyncClient(timeout=10.0, headers=_REQUEST_HEADERS) as client:
        response = await client.get(TTC_RSZ_URL)
        response.raise_for_status()
        return response.text


class _SlowZoneCache:
    def __init__(self, ttl_seconds: int):
        self._ttl_seconds = ttl_seconds
        self._zones: list[dict] = []
        self._last_updated: Optional[str] = None
        self._fetched_at: Optional[float] = None
        self._source = "fallback"

    @property
    def has_data(self) -> bool:
        return bool(self._zones)

    @property
    def is_fresh(self) -> bool:
        return (
            self._fetched_at is not None
            and (time.monotonic() - self._fetched_at) < self._ttl_seconds
        )

    def set(self, zones: list[dict], last_updated: Optional[str], source: str) -> None:
        self._zones = zones
        self._last_updated = last_updated
        self._fetched_at = time.monotonic()
        self._source = source

    def snapshot(self) -> dict:
        return {
            "slowZones": self._zones,
            "lastUpdated": self._last_updated,
            "source": self._source,
        }


_cache = _SlowZoneCache(CACHE_TTL_SECONDS)


async def get_slow_zones(force_refresh: bool = False) -> dict:
    """Return the cached (or freshly scraped) list of active TTC slow zones.

    Falls back to the last good cached scrape if a fresh fetch fails, and
    only drops to the minimal baseline JSON when there's no prior data at all.
    """
    if not force_refresh and _cache.is_fresh:
        return _cache.snapshot()

    try:
        html = await _fetch_html()
        zones, last_updated = _parse_html(html)
        if not zones:
            raise ValueError("No slow zones found in the TTC RSZ page markup.")
        _cache.set([zone.to_dict() for zone in zones], last_updated, source="live")
    except (httpx.HTTPError, ValueError):
        if not _cache.has_data:
            _cache.set(FALLBACK_SLOW_ZONES, None, source="fallback")

    return _cache.snapshot()
