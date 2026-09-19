from typing import Optional, Tuple, Union

from pydantic import BaseModel, ConfigDict, Field

Coordinates = Tuple[float, float]


class TransitCommuteRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    origin: Union[str, Coordinates]
    destination: Union[str, Coordinates]
    # Explicit coordinates for a geocoded address or a map-dropped pin — kept
    # alongside the rider-facing display string (unlike the legacy
    # origin/destination-as-tuple form above) so the response can still echo
    # back "214 College St" instead of silently swapping in a station name.
    origin_lat: Optional[float] = Field(default=None, alias="originLat")
    origin_lon: Optional[float] = Field(default=None, alias="originLon")
    dest_lat: Optional[float] = Field(default=None, alias="destLat")
    dest_lon: Optional[float] = Field(default=None, alias="destLon")
    departure_time: Optional[str] = Field(default=None, alias="departureTime")


class ActiveSlowZone(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    line: int
    direction: str
    from_station: str = Field(alias="fromStation")
    to_station: str = Field(alias="toStation")
    from_station_id: Optional[str] = Field(default=None, alias="fromStationId")
    to_station_id: Optional[str] = Field(default=None, alias="toStationId")
    defect_length_meters: int = Field(alias="defectLengthMeters")
    distance_between_stations_meters: Optional[int] = Field(
        default=None, alias="distanceBetweenStationsMeters"
    )
    track_reduced_percent: Optional[int] = Field(default=None, alias="trackReducedPercent")
    reduced_speed_kmh: float = Field(alias="reducedSpeedKmh")
    normal_speed_kmh: float = Field(alias="normalSpeedKmh")
    reason: str
    target_removal: str = Field(alias="targetRemoval")
    delay_seconds: float = Field(alias="delaySeconds")


class SlowZonesResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    slow_zones: list[ActiveSlowZone] = Field(alias="slowZones")
    last_updated: Optional[str] = Field(default=None, alias="lastUpdated")
    source: str


class ServiceAlert(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    line: int
    category: str  # "closure" | "delay" | "maintenance"
    headline: str
    description: str
    direction: str
    from_station: str = Field(alias="fromStation")
    to_station: str = Field(alias="toStation")
    affected_station_ids: list[str] = Field(alias="affectedStationIds")
    shuttle_service: bool = Field(alias="shuttleService")
    posted_at: Optional[str] = Field(default=None, alias="postedAt")
    active_until: Optional[str] = Field(default=None, alias="activeUntil")
    is_upcoming_notice: bool = Field(default=False, alias="isUpcomingNotice")
    is_advisory: bool = Field(default=False, alias="isAdvisory")


class AlertsResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    alerts: list[ServiceAlert]
    last_updated: Optional[str] = Field(default=None, alias="lastUpdated")
    source: str


class DetourStop(BaseModel):
    """One stop an active detour names as closed/bypassed, resolved to real
    coordinates (see detour_service._resolve_stop_details) so the map can
    place a marker for it — a streetcar/bus stop has no equivalent in our
    subway station-id registry, so this carries its own lat/lon directly."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str
    lat: float
    lon: float


class DetourSummary(BaseModel):
    """One active bus/streetcar DETOUR/MODIFIED_SERVICE/NO_SERVICE alert —
    see detour_service.get_active_surface_detours for GET /api/detours."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    route_id: Optional[str] = Field(default=None, alias="routeId")
    route_short_name: Optional[str] = Field(default=None, alias="routeShortName")
    route_ids: list[str] = Field(default_factory=list, alias="routeIds")
    header: str
    description: str
    summary: str
    effect: str
    affected_stop_ids: list[str] = Field(default_factory=list, alias="affectedStopIds")
    # A subset of affected_stop_ids when the routing DB doesn't have a
    # matching row for one (a stale/renamed stop_id in a live alert).
    affected_stops: list[DetourStop] = Field(default_factory=list, alias="affectedStops")


class DetoursResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    detours: list[DetourSummary]


class CommuteStep(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    mode: str  # "subway" | "streetcar" | "bus"
    route_number: str = Field(alias="routeNumber")
    stop_count: int = Field(alias="stopCount")


class ItineraryLeg(BaseModel):
    """One leg of a router.py multi-modal itinerary — either a walk (origin
    to the first stop, a transfer, or the last stop to the destination) or a
    scheduled transit ride, in the order the rider actually travels them."""

    model_config = ConfigDict(populate_by_name=True)

    mode: str  # "walk" | "bus" | "streetcar" | "subway"
    route_short_name: Optional[str] = Field(default=None, alias="routeShortName")
    route_long_name: Optional[str] = Field(default=None, alias="routeLongName")
    # Rider-facing compass direction ("Southbound", ...), read off this leg's
    # boarding stop — see router.py's _extract_direction. None for a walk
    # leg, or a transit leg boarding where GTFS has no directional platform label.
    direction: Optional[str] = None
    from_name: str = Field(alias="fromName")
    to_name: str = Field(alias="toName")
    stop_count: int = Field(default=0, alias="stopCount")
    distance_meters: Optional[float] = Field(default=None, alias="distanceMeters")
    duration_minutes: float = Field(alias="durationMinutes")
    departure_time: str = Field(alias="departureTime")
    arrival_time: str = Field(alias="arrivalTime")
    # [lon, lat] pairs in travel order — a straight line for a walk leg, the
    # actual boarded-to-alighted stop sequence for a transit leg. Matches the
    # [lon, lat] convention used everywhere else in this codebase (GeoJSON).
    path: list[Coordinates] = Field(default_factory=list)


class RouteSummary(BaseModel):
    """Everything needed to render and highlight one route option — shared
    by the primary result and each entry in TransitCommuteResponse's
    alternative_routes, so a stacked "Fastest"/"Alternative" card in the UI
    can render either one identically."""

    model_config = ConfigDict(populate_by_name=True)

    # "Fastest" for the primary route, "Alternative" for anything in
    # alternative_routes — see traffic_service.py's multi-route search.
    label: str = "Fastest"
    origin: str
    destination: str
    line: int
    station_hops: int = Field(alias="stationHops")
    scheduled_duration_minutes: float = Field(alias="scheduledDurationMinutes")
    slow_zone_delay_minutes: float = Field(alias="slowZoneDelayMinutes")
    slow_zone_delay_seconds: float = Field(alias="slowZoneDelaySeconds")
    telemetry_source: str = Field(alias="telemetrySource")  # "gtfs_realtime" | "kinematic_model"
    # Live-observed (GTFS-RT TripUpdates) or, absent that, detour-estimated
    # delay on a streetcar/bus leg of this route — see router.py's
    # surface_realtime_service integration. A subset of slow_zone_delay_*
    # above (already reflected in total_duration_minutes), broken out so the
    # UI can badge it distinctly ("Streetcar Delay"/"Traffic Delay") instead
    # of folding it into the subway-oriented "Track Slowdown" badge. 0 for
    # the subway-only fast path, or when no surface leg is delayed.
    streetcar_delay_minutes: float = Field(default=0.0, alias="streetcarDelayMinutes")
    bus_delay_minutes: float = Field(default=0.0, alias="busDelayMinutes")
    alert_delay_minutes: float = Field(alias="alertDelayMinutes")
    detour_delay_minutes: float = Field(default=0.0, alias="detourDelayMinutes")
    detour_warnings: list[str] = Field(default_factory=list, alias="detourWarnings")
    upcoming_detour_notices: list[str] = Field(default_factory=list, alias="upcomingDetourNotices")
    alternate_route: Optional[str] = Field(default=None, alias="alternateRoute")
    total_duration_minutes: float = Field(alias="totalDurationMinutes")
    active_slow_zones: list[ActiveSlowZone] = Field(default_factory=list, alias="activeSlowZones")
    is_disrupted: bool = Field(default=False, alias="isDisrupted")
    active_alerts_on_route: list[ServiceAlert] = Field(default_factory=list, alias="activeAlertsOnRoute")
    steps: list[CommuteStep] = Field(default_factory=list)
    # Populated by router.py's multi-modal (walk+bus+streetcar+subway) fallback
    # path — empty for the subway-only fast path, which the existing `steps`
    # summary + map route-highlight already cover.
    itinerary: list[ItineraryLeg] = Field(default_factory=list)
    departure_time: str = Field(alias="departureTime")
    arrival_time: str = Field(alias="arrivalTime")
    source: str


class TransitCommuteResponse(RouteSummary):
    # Up to one genuinely different, real alternative route (see
    # router.py's find_itineraries) — empty when no competitive alternative
    # exists, or for the subway-only fast path, which doesn't search for one.
    alternative_routes: list[RouteSummary] = Field(default_factory=list, alias="alternativeRoutes")
