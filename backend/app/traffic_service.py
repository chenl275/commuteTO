"""Subway commute-time modeling: station-hop schedule + live slow zone delay."""

from datetime import datetime, time as dt_time, timedelta
from typing import Optional, Tuple, Union

from .schemas import ActiveSlowZone, CommuteStep, ServiceAlert, TransitCommuteRequest, TransitCommuteResponse
from .services import gtfs_service, stations
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
# A broad line-wide advisory ("delays between Vaughan and Finch") isn't a
# pinpointed hold — riders on a short hop through it shouldn't eat the same
# penalty as someone caught in an actual localized incident.
ADVISORY_NOMINAL_PENALTY_MINUTES = 2.0
ADVISORY_EXEMPT_MAX_HOPS = 2

# TTC subway runs roughly 6am-1:30am; overnight requests in this window ride
# the Blue Night network instead (see stations.NIGHT_NETWORK_ROUTE_BY_LINE).
NIGHT_NETWORK_START = dt_time(1, 30)
NIGHT_NETWORK_END = dt_time(5, 30)
# Night buses run at street level with stops/signals, unlike grade-separated
# subway — slower per hop, and only a rough stand-in absent a real overnight
# surface-network schedule.
NIGHT_BUS_MINUTES_PER_HOP = 3.0


def _is_within_night_network_window(moment: datetime) -> bool:
    check = moment.time()
    return NIGHT_NETWORK_START <= check < NIGHT_NETWORK_END


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


def _get_night_network_estimate(
    origin_station: dict, destination_station: dict, line: int, hops: int, departure: datetime
) -> TransitCommuteResponse:
    """The subway doesn't run 1:30-5:30am — route via the Blue Night bus that
    shadows this line's corridor instead. No slow zones, GTFS telemetry, or
    subway service alerts apply to a bus leg, so those all read as empty/none."""
    night_route = stations.NIGHT_NETWORK_ROUTE_BY_LINE.get(line)
    if night_route is None:
        raise TransitCommuteError(
            f"The subway is closed overnight (1:30am-5:30am) and Line {line} has no mapped "
            "Blue Night route yet — try a Line 1 or Line 2 trip for overnight travel."
        )
    night_route_number, _night_route_name = night_route

    scheduled_minutes = hops * NIGHT_BUS_MINUTES_PER_HOP
    arrival = departure + timedelta(minutes=scheduled_minutes)

    return TransitCommuteResponse(
        origin=origin_station["name"],
        destination=destination_station["name"],
        line=line,
        station_hops=hops,
        scheduled_duration_minutes=round(scheduled_minutes, 1),
        slow_zone_delay_minutes=0.0,
        slow_zone_delay_seconds=0.0,
        telemetry_source="kinematic_model",
        alert_delay_minutes=0.0,
        total_duration_minutes=round(scheduled_minutes, 1),
        active_slow_zones=[],
        is_disrupted=False,
        active_alerts_on_route=[],
        steps=[CommuteStep(mode="bus", route_number=night_route_number, stop_count=hops)],
        departure_time=departure.isoformat(),
        arrival_time=arrival.isoformat(),
        source="live",
    )


async def get_transit_commute_estimate(request: TransitCommuteRequest) -> TransitCommuteResponse:
    departure = _parse_departure_time(request.departure_time)

    origin_station = _resolve_station(request.origin)
    destination_station = _resolve_station(request.destination)
    line = _shared_line(origin_station, destination_station)

    hops = stations.hops_between(line, origin_station["id"], destination_station["id"])
    if hops is None:
        raise TransitCommuteError("Couldn't find a route between these stations.")

    if _is_within_night_network_window(departure):
        return _get_night_network_estimate(origin_station, destination_station, line, hops, departure)

    scheduled_minutes = hops * MINUTES_PER_STATION_HOP

    slow_zones = await get_slow_zones()
    zones_on_route = stations.zones_along_route(
        line, origin_station["id"], destination_station["id"], slow_zones["slowZones"]
    )
    # Kinematic-model estimate (see kinematics.py) — the fallback whenever
    # live transponder data isn't available for this trip.
    kinematic_delay_seconds = sum(zone["delaySeconds"] for zone in zones_on_route)

    # Live GTFS-RT observed delay takes priority as empirical ground truth
    # over the kinematic estimate whenever it's available. Checked across
    # every station actually traveled (not just the endpoints), taking the
    # worst observed reading as representative of the trip.
    route_station_ids = stations.stations_on_route(
        line, origin_station["id"], destination_station["id"]
    )
    live_delay_seconds: Optional[int] = None
    for station_id in route_station_ids:
        observed = await gtfs_service.get_live_station_delay(station_id)
        if observed is not None and observed > 0:
            if live_delay_seconds is None or observed > live_delay_seconds:
                live_delay_seconds = observed

    if live_delay_seconds is not None:
        slow_zone_delay_seconds: float = float(live_delay_seconds)
        telemetry_source = "gtfs_realtime"
    else:
        slow_zone_delay_seconds = kinematic_delay_seconds
        telemetry_source = "kinematic_model"

    slow_zone_delay_minutes = slow_zone_delay_seconds / 60

    alerts = await get_alerts()
    alerts_on_route = stations.alerts_along_route(
        line, origin_station["id"], destination_station["id"], alerts["alerts"]
    )

    effective_alerts: list[dict] = []
    is_disrupted = False
    delay_penalty_minutes = 0.0
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
            if alert.get("isAdvisory"):
                # A generic line-wide advisory ("regular service has
                # resumed between Vaughan and Finch") isn't a pinpointed
                # hold on this specific segment — short hops through it are
                # exempt entirely, longer trips get a small nominal add-on
                # rather than the full incident penalty.
                if hops > ADVISORY_EXEMPT_MAX_HOPS:
                    delay_penalty_minutes += ADVISORY_NOMINAL_PENALTY_MINUTES
            else:
                delay_penalty_minutes += INCIDENT_HOLD_PENALTY_MINUTES
        effective_alerts.append(alert)

    # "maintenance" alerts are informational only here — the extra travel
    # time they cause is already captured by the slow-zone delay above, so
    # adding a separate penalty for them would double-count the same cause.
    alert_delay_minutes = delay_penalty_minutes
    if is_disrupted:
        alert_delay_minutes += CLOSURE_SHUTTLE_PENALTY_MINUTES

    total_minutes = scheduled_minutes + slow_zone_delay_minutes + alert_delay_minutes
    arrival = departure + timedelta(minutes=total_minutes)

    steps: list[CommuteStep] = [CommuteStep(mode="subway", route_number=str(line), stop_count=hops)]
    # Surface a real streetcar connection at either endpoint — useful context
    # on its own, and especially so when the subway leg above is disrupted.
    for endpoint_station in (origin_station, destination_station):
        for stop in stations.get_surface_interchange_stops(endpoint_station["id"]):
            if "streetcar" not in stop.get("networks", []) or not stop.get("routes"):
                continue
            steps.append(CommuteStep(mode="streetcar", route_number=stop["routes"][0], stop_count=1))
            break

    return TransitCommuteResponse(
        origin=origin_station["name"],
        destination=destination_station["name"],
        line=line,
        station_hops=hops,
        scheduled_duration_minutes=round(scheduled_minutes, 1),
        slow_zone_delay_minutes=round(slow_zone_delay_minutes, 1),
        slow_zone_delay_seconds=round(slow_zone_delay_seconds, 1),
        telemetry_source=telemetry_source,
        alert_delay_minutes=round(alert_delay_minutes, 1),
        total_duration_minutes=round(total_minutes, 1),
        active_slow_zones=[ActiveSlowZone(**zone) for zone in zones_on_route],
        is_disrupted=is_disrupted,
        active_alerts_on_route=[ServiceAlert(**alert) for alert in effective_alerts],
        steps=steps,
        departure_time=departure.isoformat(),
        arrival_time=arrival.isoformat(),
        source=slow_zones["source"],
    )
