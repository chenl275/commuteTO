"""Subway commute-time modeling: station-hop schedule + live slow zone delay."""

from datetime import datetime, timedelta
from typing import Tuple, Union

from .schemas import ActiveSlowZone, TransitCommuteRequest, TransitCommuteResponse
from .services import stations
from .services.slow_zones_scraper import get_slow_zones

MINUTES_PER_STATION_HOP = 1.5


class TransitCommuteError(ValueError):
    """Raised when a request can't be resolved to a supported subway trip."""


def _is_coordinates(value: Union[str, Tuple[float, float]]) -> bool:
    return isinstance(value, (list, tuple))


def _parse_departure_time(departure_time: str | None) -> datetime:
    if not departure_time:
        return datetime.now()
    try:
        return datetime.fromisoformat(departure_time)
    except ValueError:
        return datetime.now()


def _resolve_station(value: Union[str, Tuple[float, float]]) -> dict:
    if _is_coordinates(value):
        station = stations.nearest_station(tuple(value))
        if station is None:
            raise TransitCommuteError("No TTC subway station data is available.")
        return station

    station = stations.find_station(value)
    if station is None:
        raise TransitCommuteError(f'Unrecognized TTC station: "{value}"')
    return station


def _shared_line(origin: dict, destination: dict) -> int:
    shared = sorted(set(origin["lines"]) & set(destination["lines"]) & {1, 2})
    if not shared:
        raise TransitCommuteError(
            f"\"{origin['name']}\" and \"{destination['name']}\" aren't both on Line 1 "
            "or Line 2 — multi-line transfer routing isn't supported yet."
        )
    return shared[0]


async def get_transit_commute_estimate(request: TransitCommuteRequest) -> TransitCommuteResponse:
    departure = _parse_departure_time(request.departure_time)

    origin_station = _resolve_station(request.origin)
    destination_station = _resolve_station(request.destination)
    line = _shared_line(origin_station, destination_station)

    hops = stations.hops_between(line, origin_station["id"], destination_station["id"])
    if hops is None:
        raise TransitCommuteError("Couldn't find a route between these stations.")

    scheduled_minutes = hops * MINUTES_PER_STATION_HOP

    slow_zones = await get_slow_zones()
    zones_on_route = stations.zones_along_route(
        line, origin_station["id"], destination_station["id"], slow_zones["slowZones"]
    )
    delay_minutes = sum(zone["delaySeconds"] for zone in zones_on_route) / 60

    total_minutes = scheduled_minutes + delay_minutes
    arrival = departure + timedelta(minutes=total_minutes)

    return TransitCommuteResponse(
        origin=origin_station["name"],
        destination=destination_station["name"],
        line=line,
        station_hops=hops,
        scheduled_duration_minutes=round(scheduled_minutes, 1),
        slow_zone_delay_minutes=round(delay_minutes, 1),
        total_duration_minutes=round(total_minutes, 1),
        active_slow_zones=[ActiveSlowZone(**zone) for zone in zones_on_route],
        departure_time=departure.isoformat(),
        arrival_time=arrival.isoformat(),
        source=slow_zones["source"],
    )
