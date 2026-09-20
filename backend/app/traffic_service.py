"""Subway commute-time modeling: station-hop schedule + live slow zone delay."""

import re
from datetime import datetime, time as dt_time, timedelta
from typing import Callable, Optional, Tuple, TypeVar, Union
from zoneinfo import ZoneInfo

from .schemas import (
    ActiveSlowZone,
    CommuteStep,
    ItineraryLeg,
    RouteSummary,
    ServiceAlert,
    TransitCommuteRequest,
    TransitCommuteResponse,
)
from .services import gtfs_service, router, stations
from .services.geocoding_service import geocode_address
from .services.alerts_service import (
    build_headline,
    describe_recognized_window,
    get_alerts,
    is_within_recognized_window,
)
from .services.detour_service import get_detours_for_routes
from .services.slow_zones_scraper import get_slow_zones

# Real Toronto wall-clock time, independent of whatever timezone the host
# OS itself runs (Render's containers default to UTC) — see
# _parse_departure_time, the only place "now" matters here. A bare
# datetime.now()/utcnow() on a UTC host reads as ~4-5 hours ahead of actual
# Toronto time, which for a "Leave now" request made late Saturday evening
# can land after 1am Sunday UTC — a time TTC subway service genuinely isn't
# running — so router.find_itineraries correctly finds nothing and the
# request 422s, even though it's really still Saturday evening in Toronto.
TORONTO_TZ = ZoneInfo("America/Toronto")

MINUTES_PER_STATION_HOP = 1.5

# A walk leg this short (meters) right at the start or end of a trip is
# internal station navigation — entering/exiting the concourse, or shuffling
# between sibling platforms at an interchange — not a real turn-by-turn
# street direction a rider needs called out as its own step. Matches the
# rough scale of "the origin is already at/near a station's concourse."
MICRO_WALK_SUPPRESSION_METERS = 150.0

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
# Several simultaneous "delay"-category alerts on the same short route
# (rare, but the widget feed doesn't dedupe) shouldn't compound into an
# unrealistic pile-up — this caps the incident/advisory total before the
# closure penalty (which is already its own separate, larger figure) is
# added on top.
MAX_ALERT_DELAY_PENALTY_MINUTES = 20.0
# A real GTFS-RT alert is commonly broadcast as one FeedEntity per stop id
# along the affected corridor (and the widget feed can likewise carry more
# than one dated instance of the same recurring notice) — all with
# identical rider-facing text, so without deduplication the same message
# would repeat once per stop/instance.

_DEDUP_PUNCTUATION_PATTERN = re.compile(r"[^\w\s]")
_DEDUP_WHITESPACE_PATTERN = re.compile(r"\s+")

_T = TypeVar("_T")


def _normalize_for_dedup(text: str) -> str:
    """Case-fold and strip whitespace/punctuation so the same underlying
    alert broadcast with only superficial formatting differences (extra
    spaces, a trailing period) still collapses to one entry."""
    lowered = _DEDUP_PUNCTUATION_PATTERN.sub("", text.lower())
    return _DEDUP_WHITESPACE_PATTERN.sub(" ", lowered).strip()


def _dedupe_by_text(items: list[_T], text_of: Callable[[_T], str]) -> list[_T]:
    """Keeps only the first occurrence of each normalized-text item,
    preserving order."""
    seen: set[str] = set()
    deduped: list[_T] = []
    for item in items:
        key = _normalize_for_dedup(text_of(item))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped

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
    """Naive datetime in Toronto wall-clock terms — matching
    datetime.fromisoformat's own naive result for the normal "leave later"
    case (the frontend sends a plain, offset-free local string, e.g.
    "2026-09-21T14:30"), so a "leave now" default and a rider-picked time
    are always comparable/interchangeable downstream instead of one
    silently carrying tzinfo the other doesn't. Every caller (this module,
    router.py) already treats the result as Toronto wall-clock only — never
    against the live system clock again — so stripping tzinfo here, once,
    is safe and keeps that contract intact."""
    if not departure_time:
        return datetime.now(TORONTO_TZ).replace(tzinfo=None)
    try:
        return datetime.fromisoformat(departure_time)
    except ValueError:
        return datetime.now(TORONTO_TZ).replace(tzinfo=None)


async def _resolve_endpoint(
    value: Union[str, Tuple[float, float]],
    lat: Optional[float],
    lon: Optional[float],
) -> Tuple[dict, Optional[Tuple[float, float]], str]:
    """Resolves one origin/destination endpoint to (the nearest/matched
    subway station used for line-hop + slow-zone modeling, the exact (lat,
    lon) point when the request supplied real coordinates — a geocoded
    address or a map-dropped pin, not just a named station — and the
    rider-facing display name. The display name preserves whatever the rider
    actually typed/picked (e.g. "214 College St") instead of silently
    swapping in the snapped nearest station's name.

    No upfront "is this a known station" gate: a plain string that isn't a
    recognized station name is geocoded server-side (Photon) as a fallback
    before giving up — the frontend's own debounced geocoder (see
    StationAutocompleteField.tsx) may not have resolved yet if the rider hit
    Enter or clicked "Calculate Commute" immediately after typing."""
    if lat is not None and lon is not None:
        station = stations.nearest_station((lat, lon))
        if station is None:
            raise TransitCommuteError("No TTC subway station data is available.")
        display_name = value.strip() if isinstance(value, str) and value.strip() else station["name"]
        return station, (lat, lon), display_name

    if _is_coordinates(value):
        coordinates = tuple(value)
        station = stations.nearest_station(coordinates)
        if station is None:
            raise TransitCommuteError("No TTC subway station data is available.")
        return station, coordinates, station["name"]

    matched_station = stations.find_station(value)
    if matched_station is not None:
        return matched_station, None, matched_station["name"]

    geocoded = await geocode_address(value)
    if geocoded is not None:
        station = stations.nearest_station(geocoded)
        if station is None:
            raise TransitCommuteError("No TTC subway station data is available.")
        return station, geocoded, value.strip()

    raise TransitCommuteError(f'Couldn\'t find a TTC station or address matching "{value}".')


def _shared_line(origin: dict, destination: dict) -> int:
    shared = sorted(set(origin["lines"]) & set(destination["lines"]) & {1, 2})
    if not shared:
        raise TransitCommuteError(
            f"\"{origin['name']}\" and \"{destination['name']}\" aren't both on Line 1 "
            "or Line 2 — multi-line transfer routing isn't supported yet."
        )
    return shared[0]


def _get_night_network_estimate(
    origin_station: dict,
    destination_station: dict,
    line: int,
    hops: int,
    departure: datetime,
    origin_display: str,
    destination_display: str,
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
        origin=origin_display,
        destination=destination_display,
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


def _to_clock_time(base_date, seconds_of_day: float) -> datetime:
    return datetime.combine(base_date, dt_time()) + timedelta(seconds=seconds_of_day)


def _trim_micro_walks(legs: list) -> list:
    """Drops a leading and/or trailing run of very short walk legs (each
    under MICRO_WALK_SUPPRESSION_METERS) from the *displayed* step list —
    the "walk to the platform" bracketing a trip whose origin/destination
    already sits at/near a station concourse, and any same-station
    platform-to-platform transfer walk right at the end of the trip. A short
    walk strictly *between* two transit legs (a real street-level transfer)
    is left alone — that's still a step the rider needs. Only affects which
    legs are shown; the caller still uses the untrimmed list for total
    duration/departure/arrival math, since the rider still spends that time
    walking even when it's not worth its own instruction. Never trims the
    whole list to empty (a walk-only trip has nothing else to show)."""
    start = 0
    while (
        start < len(legs) - 1
        and legs[start].mode == "walk"
        and (legs[start].distance_meters or 0) <= MICRO_WALK_SUPPRESSION_METERS
    ):
        start += 1

    end = len(legs)
    while (
        end > start + 1
        and legs[end - 1].mode == "walk"
        and (legs[end - 1].distance_meters or 0) <= MICRO_WALK_SUPPRESSION_METERS
    ):
        end -= 1

    return legs[start:end]


def _build_route_summary_fields(itinerary, base_date, label: str) -> dict:
    """Every RouteSummary field derivable from one router.py Itinerary,
    keyed by python (snake_case) field name — shared by the primary route
    and each alternative in _get_multimodal_estimate, so both render
    identically. Caller still fills in origin/destination/active_slow_zones/
    is_disrupted/active_alerts_on_route, which aren't itinerary-derived."""
    steps: list[CommuteStep] = []
    itinerary_legs: list[ItineraryLeg] = []
    total_stop_count = 0
    primary_line = 0

    # station_hops/primary_line reflect the real trip, so they're computed
    # from every leg — trimming only ever drops walk legs (see
    # _trim_micro_walks), which don't contribute to either anyway. Only the
    # rider-facing steps/itinerary lists below drop the internal micro-walks.
    for leg in itinerary.legs:
        if leg.mode != "walk":
            total_stop_count += leg.stop_count
            if leg.mode == "subway" and leg.route_short_name and leg.route_short_name.isdigit():
                primary_line = int(leg.route_short_name)

    for leg in _trim_micro_walks(itinerary.legs):
        if leg.mode != "walk":
            steps.append(CommuteStep(mode=leg.mode, route_number=leg.route_short_name or "", stop_count=leg.stop_count))
        itinerary_legs.append(
            ItineraryLeg(
                mode=leg.mode,
                route_short_name=leg.route_short_name,
                route_long_name=leg.route_long_name,
                direction=leg.direction,
                from_name=leg.from_name,
                to_name=leg.to_name,
                stop_count=leg.stop_count,
                distance_meters=leg.distance_meters,
                duration_minutes=round(leg.duration_minutes, 1),
                departure_time=_to_clock_time(base_date, leg.departure_sec).isoformat(),
                arrival_time=_to_clock_time(base_date, leg.arrival_sec).isoformat(),
                scheduled_departure_time=_to_clock_time(base_date, leg.scheduled_departure_sec).isoformat(),
                scheduled_arrival_time=_to_clock_time(base_date, leg.scheduled_arrival_sec).isoformat(),
                is_live=leg.is_live,
                tracking_unavailable=leg.tracking_unavailable,
                delay_seconds=round(leg.delay_seconds, 1),
                path=leg.path,
            )
        )

    first_leg, last_leg = itinerary.legs[0], itinerary.legs[-1]
    total_minutes = (last_leg.arrival_sec - first_leg.departure_sec) / 60.0
    delay_minutes = itinerary.delay_seconds / 60.0
    scheduled_minutes = total_minutes - delay_minutes

    return {
        "label": label,
        "line": primary_line,
        "station_hops": total_stop_count,
        "scheduled_duration_minutes": round(scheduled_minutes, 1),
        "slow_zone_delay_minutes": round(delay_minutes, 1),
        "slow_zone_delay_seconds": round(itinerary.delay_seconds, 1),
        "telemetry_source": "kinematic_model",
        "streetcar_delay_minutes": round(itinerary.streetcar_delay_seconds / 60.0, 1),
        "bus_delay_minutes": round(itinerary.bus_delay_seconds / 60.0, 1),
        "alert_delay_minutes": 0.0,
        "total_duration_minutes": round(total_minutes, 1),
        "steps": steps,
        "itinerary": itinerary_legs,
        "departure_time": _to_clock_time(base_date, first_leg.departure_sec).isoformat(),
        "arrival_time": _to_clock_time(base_date, last_leg.arrival_sec).isoformat(),
        "source": "live",
    }


async def _get_multimodal_estimate(
    origin_station: dict,
    destination_station: dict,
    departure: datetime,
    origin_point: Optional[Tuple[float, float]],
    destination_point: Optional[Tuple[float, float]],
    origin_display: str,
    destination_display: str,
) -> Optional[TransitCommuteResponse]:
    """Walk -> transit -> ... -> walk itinerary via router.py's time-dependent
    Dijkstra over the full GTFS network — the fallback whenever the origin
    and destination don't share a modeled subway line (see router.py), and
    always the path taken when the request supplied real coordinates for
    either endpoint (a geocoded address or a map-dropped pin), since only
    this path actually models the walk leg from that exact point rather than
    assuming the rider starts right at a station platform. Uses the request's
    actual (lat, lon) when it supplied coordinates directly, rather than the
    resolved station's coordinates, so the initial/final walk legs reflect
    where the rider actually is.

    Also searches for one genuinely different, real alternative route (see
    router.py's find_itineraries) — populated as alternative_routes[0] when
    one exists, alongside this function's own (fastest/primary) result."""
    origin_lat, origin_lon = origin_point if origin_point is not None else tuple(reversed(origin_station["coordinates"]))
    destination_lat, destination_lon = (
        destination_point if destination_point is not None else tuple(reversed(destination_station["coordinates"]))
    )

    itineraries = await router.find_itineraries(
        origin=(origin_lat, origin_lon),
        destination=(destination_lat, destination_lon),
        departure=departure,
        origin_name=origin_display,
        destination_name=destination_display,
        max_alternatives=1,
    )
    if not itineraries or not itineraries[0].legs:
        return None

    base_date = departure.date()
    primary_fields = _build_route_summary_fields(itineraries[0], base_date, "Fastest")

    alternative_routes: list[RouteSummary] = []
    if len(itineraries) > 1 and itineraries[1].legs:
        alternative_fields = _build_route_summary_fields(itineraries[1], base_date, "Alternative")
        alternative_routes.append(
            RouteSummary(origin=origin_display, destination=destination_display, **alternative_fields)
        )

    return TransitCommuteResponse(
        origin=origin_display,
        destination=destination_display,
        active_slow_zones=[],
        is_disrupted=False,
        active_alerts_on_route=[],
        alternative_routes=alternative_routes,
        **primary_fields,
    )


async def get_transit_commute_estimate(request: TransitCommuteRequest) -> TransitCommuteResponse:
    departure = _parse_departure_time(request.departure_time)

    origin_station, origin_point, origin_display = await _resolve_endpoint(
        request.origin, request.origin_lat, request.origin_lon
    )
    destination_station, destination_point, destination_display = await _resolve_endpoint(
        request.destination, request.dest_lat, request.dest_lon
    )

    # A geocoded address or map-dropped pin (real coordinates, not just a
    # named station) always routes through the multi-modal walk+transit
    # router, so the walk from that exact point to the nearest usable
    # stop/station is actually modeled — the subway-only fast path below
    # assumes the rider starts right at a station platform.
    if origin_point is not None or destination_point is not None:
        multimodal = await _get_multimodal_estimate(
            origin_station,
            destination_station,
            departure,
            origin_point,
            destination_point,
            origin_display,
            destination_display,
        )
        if multimodal is not None:
            return multimodal
        raise TransitCommuteError(
            f'No walking + transit route found between "{origin_display}" and "{destination_display}".'
        )

    try:
        line = _shared_line(origin_station, destination_station)
    except TransitCommuteError:
        # Cross-line (or off-subway-network) trip — the detailed line-hop
        # model below doesn't apply, but a real multi-modal path might still
        # exist (e.g. Walk -> Bus -> Subway -> Walk); fall through to the
        # original error only if the router can't find one either.
        multimodal = await _get_multimodal_estimate(
            origin_station,
            destination_station,
            departure,
            origin_point,
            destination_point,
            origin_display,
            destination_display,
        )
        if multimodal is not None:
            return multimodal
        raise

    hops = stations.hops_between(line, origin_station["id"], destination_station["id"])
    if hops is None:
        raise TransitCommuteError("Couldn't find a route between these stations.")

    if _is_within_night_network_window(departure):
        return _get_night_network_estimate(
            origin_station, destination_station, line, hops, departure, origin_display, destination_display
        )

    # Real GTFS-scheduled travel time for this specific station pair —
    # replaces the old flat "hops * MINUTES_PER_STATION_HOP" estimate, which
    # assumed every inter-station hop takes the same time (it doesn't: real
    # Line 1 hops alone range from ~1.1 to ~4.2 minutes depending on which
    # stretch of the line, so a flat average could be off by 20-40%+ on a
    # given trip — see router.py's get_subway_scheduled_duration_seconds).
    # Only None when no matching trip exists at all (e.g. a request right at
    # closing time), in which case the flat estimate is still a reasonable
    # fallback rather than failing the request outright.
    departure_sec = departure.hour * 3600 + departure.minute * 60 + departure.second
    real_duration_seconds = router.get_subway_scheduled_duration_seconds(
        line, origin_station["id"], destination_station["id"], departure_sec, departure.date()
    )
    scheduled_minutes = real_duration_seconds / 60.0 if real_duration_seconds is not None else hops * MINUTES_PER_STATION_HOP

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
    alerts_on_route = _dedupe_by_text(
        alerts_on_route, text_of=lambda a: f"{a.get('headline', '')} {a.get('description', '')}"
    )

    effective_alerts: list[dict] = []
    is_disrupted = False
    delay_penalty_minutes = 0.0
    for alert in alerts_on_route:
        alert = dict(alert)
        if alert["category"] == "closure":
            # A closure that matches a recognized "nightly" or "weekend"
            # pattern only counts as an active disruption when this
            # request's departure time actually falls inside that window —
            # otherwise it's surfaced as an upcoming notice, not a live
            # blocker (e.g. a Wednesday-afternoon request for a "this
            # weekend" closure must not eat the full closure penalty).
            within_window = is_within_recognized_window(alert["description"], departure)
            if within_window is False:
                alert["isUpcomingNotice"] = True
                notice_headline = describe_recognized_window(alert["description"])
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
    alert_delay_minutes = min(delay_penalty_minutes, MAX_ALERT_DELAY_PENALTY_MINUTES)
    if is_disrupted:
        alert_delay_minutes += CLOSURE_SHUTTLE_PENALTY_MINUTES

    steps: list[CommuteStep] = [CommuteStep(mode="subway", route_number=str(line), stop_count=hops)]
    # Surface a real streetcar connection at either endpoint — useful context
    # on its own, and especially so when the subway leg above is disrupted.
    for endpoint_station in (origin_station, destination_station):
        for stop in stations.get_surface_interchange_stops(endpoint_station["id"]):
            if "streetcar" not in stop.get("networks", []) or not stop.get("routes"):
                continue
            steps.append(CommuteStep(mode="streetcar", route_number=stop["routes"][0], stop_count=1))
            break

    # GTFS-RT ServiceAlerts detour/construction/shuttle detection — scoped
    # strictly to the subway line actually being ridden. The streetcar
    # step(s) above are a nearby-stop suggestion ("useful context"), not a
    # leg this itinerary instructs the rider to transfer onto, so a detour
    # on a connector route must never surface here (e.g. a Union -> King
    # subway rider must not see a 503/504 alert just because one of those
    # routes happens to stop near an endpoint station).
    primary_route_ids = {str(line)}
    detours = await get_detours_for_routes(primary_route_ids)
    # A real GTFS-RT alert is commonly broadcast as one FeedEntity per stop
    # id along the corridor (and/or one per recurring date instance), all
    # with identical text — collapse those down to one before anything else
    # sees them, rather than deduplicating the already-formatted strings
    # below (which would still double-count the same real-world closure).
    detours = _dedupe_by_text(detours, text_of=lambda d: d["summary"])
    traveled_station_ids = set(stations.stations_on_route(line, origin_station["id"], destination_station["id"]))

    # TTC often files several overlapping alert entries for the same ongoing
    # construction/detour (e.g. successive phase updates on one corridor) —
    # summing all of their penalties would compound a single real disruption
    # into an unrealistic pile-up, so the worst one stands in for the whole
    # leg's delay while every distinct notice still gets its own badge.
    detour_warnings: list[str] = []
    upcoming_detour_notices: list[str] = []
    detour_delay_minutes = 0.0
    for detour in detours:
        # A detour naming specific stations (e.g. "between St Clair and
        # College") only matters if the rider's own segment actually passes
        # through one of them — a Union -> King rider must never be warned
        # about, or penalized for, a closure confined to a stretch their
        # trip never touches. An alert with no station-level detail at all
        # (affectedStationIds empty) is treated as route-wide instead of
        # silently ignored.
        affected = set(detour["affectedStationIds"])
        if affected and not (affected & traveled_station_ids):
            continue

        route_label = "/".join(detour["routeIds"])
        if detour["isFuture"]:
            upcoming_detour_notices.append(f"ℹ️ Upcoming: {route_label} — {detour['summary']}")
            continue

        detour_warnings.append(f"⚠️ Detour active on {route_label}: {detour['summary']}")
        detour_delay_minutes = max(detour_delay_minutes, detour["penaltyMinutes"])

    # The (subway-only) widget alerts feed and this GTFS-RT detour feed can
    # both describe the exact same real-world closure/reroute on this line —
    # stacking both penalties would double-count one event. The
    # already-applied Service Alert Delay (richer context: headline,
    # direction, shuttle info) takes priority; the detour signal yields
    # rather than adding a second penalty and badge for the same thing.
    if alert_delay_minutes > 0 and detour_delay_minutes > 0:
        detour_delay_minutes = 0.0
        detour_warnings = []

    # A parallel Blue Night corridor already exists for this exact line (see
    # NIGHT_NETWORK_ROUTE_BY_LINE) — a real, already-modeled surface
    # alternative, not a fabricated second subway path. Only worth
    # suggesting when the primary route actually has a detour, that
    # alternative isn't itself detour-affected, AND it's actually running:
    # the Blue Night network only operates during the subway's own overnight
    # closure (1:30am-5:30am) — during standard daytime service hours a
    # 300-series night bus isn't a real alternative at all, so it must never
    # be suggested then regardless of any detour.
    alternate_route: Optional[str] = None
    if detour_delay_minutes > 0 and _is_within_night_network_window(departure):
        night_route = stations.NIGHT_NETWORK_ROUTE_BY_LINE.get(line)
        if night_route:
            alt_route_number, alt_route_name = night_route
            alt_detours = await get_detours_for_routes({alt_route_number})
            if not alt_detours:
                alternate_route = f"Alternate Route (Detour Avoidance): {alt_route_number} {alt_route_name}"

    total_minutes = scheduled_minutes + slow_zone_delay_minutes + alert_delay_minutes + detour_delay_minutes
    arrival = departure + timedelta(minutes=total_minutes)

    return TransitCommuteResponse(
        origin=origin_display,
        destination=destination_display,
        line=line,
        station_hops=hops,
        scheduled_duration_minutes=round(scheduled_minutes, 1),
        slow_zone_delay_minutes=round(slow_zone_delay_minutes, 1),
        slow_zone_delay_seconds=round(slow_zone_delay_seconds, 1),
        telemetry_source=telemetry_source,
        alert_delay_minutes=round(alert_delay_minutes, 1),
        detour_delay_minutes=round(detour_delay_minutes, 1),
        detour_warnings=detour_warnings,
        upcoming_detour_notices=upcoming_detour_notices,
        alternate_route=alternate_route,
        total_duration_minutes=round(total_minutes, 1),
        active_slow_zones=[ActiveSlowZone(**zone) for zone in zones_on_route],
        is_disrupted=is_disrupted,
        active_alerts_on_route=[ServiceAlert(**alert) for alert in effective_alerts],
        steps=steps,
        departure_time=departure.isoformat(),
        arrival_time=arrival.isoformat(),
        source=slow_zones["source"],
    )
