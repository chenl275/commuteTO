"""Subway commute-time modeling: station-hop schedule + live slow zone delay."""

from datetime import datetime, timedelta
from typing import Tuple, Union

from .schemas import ActiveSlowZone, ServiceAlert, TransitCommuteRequest, TransitCommuteResponse
from .services import stations
from .services.alerts_service import (
    build_headline,
    describe_nightly_window,
    get_alerts,
    is_within_nightly_window,
)
from .services.slow_zones_scraper import get_slow_zones

MINUTES_PER_STATION_HOP = 1.5

# A full closure means a shuttle replaces the subway for that stretch — a
# flat mid-range estimate of the extra transfer/wait time it costs a rider.
CLOSURE_SHUTTLE_PENALTY_MINUTES = 18.0
# An active incident (medical emergency, signal problem, etc.) typically
# holds trains for several minutes; applied per distinct incident on route.
INCIDENT_HOLD_PENALTY_MINUTES = 10.0


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
    slow_zone_delay_seconds = sum(zone["delaySeconds"] for zone in zones_on_route)
    slow_zone_delay_minutes = slow_zone_delay_seconds / 60

    alerts = await get_alerts()
    alerts_on_route = stations.alerts_along_route(
        line, origin_station["id"], destination_station["id"], alerts["alerts"]
    )

    effective_alerts: list[dict] = []
    is_disrupted = False
    incident_count = 0
    for alert in alerts_on_route:
        alert = dict(alert)
        if alert["category"] == "closure":
            # A closure that matches a recognized "nightly" pattern only
            # counts as an active disruption when this request's departure
            # time actually falls inside that overnight window — otherwise
            # it's surfaced as an upcoming notice, not a live blocker.
            within_window = is_within_nightly_window(alert["description"], departure)
            if within_window is False:
                alert["isUpcomingNotice"] = True
                notice_headline = describe_nightly_window(alert["description"])
                if notice_headline:
                    alert["headline"] = notice_headline
            else:
                # Restore the real disruption headline — the cached alert's
                # headline may have been swapped to "upcoming notice" text
                # for the generic feed (judged against "now" at scrape
                # time), which doesn't apply to this request's departure time.
                alert["isUpcomingNotice"] = False
                alert["headline"] = build_headline(
                    alert["category"], alert["fromStation"], alert["toStation"], alert["shuttleService"]
                )
                is_disrupted = True
        elif alert["category"] == "delay":
            incident_count += 1
        effective_alerts.append(alert)

    # "maintenance" alerts are informational only here — the extra travel
    # time they cause is already captured by the slow-zone delay above, so
    # adding a separate penalty for them would double-count the same cause.
    alert_delay_minutes = incident_count * INCIDENT_HOLD_PENALTY_MINUTES
    if is_disrupted:
        alert_delay_minutes += CLOSURE_SHUTTLE_PENALTY_MINUTES

    total_minutes = scheduled_minutes + slow_zone_delay_minutes + alert_delay_minutes
    arrival = departure + timedelta(minutes=total_minutes)

    return TransitCommuteResponse(
        origin=origin_station["name"],
        destination=destination_station["name"],
        line=line,
        station_hops=hops,
        scheduled_duration_minutes=round(scheduled_minutes, 1),
        slow_zone_delay_minutes=round(slow_zone_delay_minutes, 1),
        slow_zone_delay_seconds=round(slow_zone_delay_seconds, 1),
        alert_delay_minutes=round(alert_delay_minutes, 1),
        total_duration_minutes=round(total_minutes, 1),
        active_slow_zones=[ActiveSlowZone(**zone) for zone in zones_on_route],
        is_disrupted=is_disrupted,
        active_alerts_on_route=[ServiceAlert(**alert) for alert in effective_alerts],
        departure_time=departure.isoformat(),
        arrival_time=arrival.isoformat(),
        source=slow_zones["source"],
    )
