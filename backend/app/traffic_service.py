import hashlib
import math
import os
import random
from datetime import datetime, timedelta
from typing import Optional, Tuple, Union

import httpx

from .schemas import TrafficRequest, TrafficResponse

GOOGLE_DISTANCE_MATRIX_URL = "https://maps.googleapis.com/maps/api/distancematrix/json"

# Assumed average speed for the simulated fallback, tuned for city driving
# with signals/congestion rather than highway speeds.
AVERAGE_URBAN_SPEED_KMH = 28.0
EARTH_RADIUS_KM = 6371.0


def _is_coordinates(value: Union[str, Tuple[float, float]]) -> bool:
    return isinstance(value, (list, tuple))


def _format_location(value: Union[str, Tuple[float, float]]) -> str:
    if _is_coordinates(value):
        lat, lng = value
        return f"{lat},{lng}"
    return value


def _parse_departure_time(departure_time: Optional[str]) -> datetime:
    if not departure_time:
        return datetime.now()
    try:
        return datetime.fromisoformat(departure_time)
    except ValueError:
        return datetime.now()


def _haversine_km(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    lat1, lon1 = a
    lat2, lon2 = b
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    h = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(h))


def _seeded_random(*parts: str) -> random.Random:
    # A stable hash (unlike Python's salted str hash) so the same
    # origin/destination/day always simulates the same-feeling result.
    digest = hashlib.md5("|".join(parts).encode()).hexdigest()
    return random.Random(int(digest[:8], 16))


def _format_duration(total_seconds: int) -> str:
    minutes = round(total_seconds / 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours} hour{'s' if hours != 1 else ''} {minutes} min"
    return f"{minutes} min"


def _simulate(request: TrafficRequest, departure: datetime) -> TrafficResponse:
    origin, destination = request.origin, request.destination
    rng = _seeded_random(str(origin), str(destination), departure.date().isoformat())

    if _is_coordinates(origin) and _is_coordinates(destination):
        # Real coordinates: base the estimate on actual distance, with a
        # road-vs-straight-line fudge factor since streets aren't straight.
        straight_line_km = _haversine_km(tuple(origin), tuple(destination))
        distance_km = max(straight_line_km * 1.35, 0.5)
    else:
        # No coordinates to work with (free-text addresses) — simulate a
        # plausible intra-city trip distance instead.
        distance_km = round(rng.uniform(4.0, 28.0), 1)

    baseline_minutes = max(distance_km / AVERAGE_URBAN_SPEED_KMH * 60, 4.0)
    traffic_multiplier = rng.uniform(1.05, 1.55)
    traffic_minutes = baseline_minutes * traffic_multiplier

    baseline_seconds = round(baseline_minutes * 60)
    traffic_seconds = round(traffic_minutes * 60)
    delay_minutes = max(round((traffic_seconds - baseline_seconds) / 60), 0)

    arrival = departure + timedelta(seconds=traffic_seconds)

    return TrafficResponse(
        origin=_format_location(origin),
        destination=_format_location(destination),
        distance_meters=round(distance_km * 1000),
        distance_text=f"{distance_km:.1f} km",
        duration_seconds=baseline_seconds,
        duration_text=_format_duration(baseline_seconds),
        duration_in_traffic_seconds=traffic_seconds,
        duration_in_traffic_text=_format_duration(traffic_seconds),
        traffic_delay_minutes=delay_minutes,
        departure_time=departure.isoformat(),
        arrival_time=arrival.isoformat(),
        source="simulated",
    )


async def _query_google(
    request: TrafficRequest, departure: datetime, api_key: str
) -> Optional[TrafficResponse]:
    now = datetime.now()
    # Google's Distance Matrix API only accepts "now" or a future Unix
    # timestamp for departure_time — never a past one.
    use_now = departure <= now
    params = {
        "origins": _format_location(request.origin),
        "destinations": _format_location(request.destination),
        "departure_time": "now" if use_now else str(int(departure.timestamp())),
        "units": "metric",
        "key": api_key,
    }

    async with httpx.AsyncClient(timeout=8.0) as client:
        response = await client.get(GOOGLE_DISTANCE_MATRIX_URL, params=params)
        response.raise_for_status()
        payload = response.json()

    if payload.get("status") != "OK":
        return None

    rows = payload.get("rows") or []
    if not rows or not rows[0].get("elements"):
        return None

    element = rows[0]["elements"][0]
    if element.get("status") != "OK":
        return None

    distance = element["distance"]
    duration = element["duration"]
    duration_in_traffic = element.get("duration_in_traffic", duration)

    departure_used = now if use_now else departure
    arrival = departure_used + timedelta(seconds=duration_in_traffic["value"])
    delay_minutes = max(round((duration_in_traffic["value"] - duration["value"]) / 60), 0)

    origin_address = (payload.get("origin_addresses") or [_format_location(request.origin)])[0]
    destination_address = (
        payload.get("destination_addresses") or [_format_location(request.destination)]
    )[0]

    return TrafficResponse(
        origin=origin_address,
        destination=destination_address,
        distance_meters=distance["value"],
        distance_text=distance["text"],
        duration_seconds=duration["value"],
        duration_text=duration["text"],
        duration_in_traffic_seconds=duration_in_traffic["value"],
        duration_in_traffic_text=duration_in_traffic.get(
            "text", _format_duration(duration_in_traffic["value"])
        ),
        traffic_delay_minutes=delay_minutes,
        departure_time=departure_used.isoformat(),
        arrival_time=arrival.isoformat(),
        source="google_maps",
    )


async def get_traffic_estimate(request: TrafficRequest) -> TrafficResponse:
    departure = _parse_departure_time(request.departure_time)
    api_key = os.getenv("GOOGLE_MAPS_API_KEY")

    if api_key:
        try:
            result = await _query_google(request, departure, api_key)
            if result is not None:
                return result
        except (httpx.HTTPError, KeyError, ValueError):
            # Fall through to the simulated estimate below.
            pass

    return _simulate(request, departure)
