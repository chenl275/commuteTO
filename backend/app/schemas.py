from typing import Optional, Tuple, Union

from pydantic import BaseModel, ConfigDict, Field

Coordinates = Tuple[float, float]


class TransitCommuteRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    origin: Union[str, Coordinates]
    destination: Union[str, Coordinates]
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


class CommuteStep(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    mode: str  # "subway" | "streetcar" | "bus"
    route_number: str = Field(alias="routeNumber")
    stop_count: int = Field(alias="stopCount")


class TransitCommuteResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    origin: str
    destination: str
    line: int
    station_hops: int = Field(alias="stationHops")
    scheduled_duration_minutes: float = Field(alias="scheduledDurationMinutes")
    slow_zone_delay_minutes: float = Field(alias="slowZoneDelayMinutes")
    slow_zone_delay_seconds: float = Field(alias="slowZoneDelaySeconds")
    telemetry_source: str = Field(alias="telemetrySource")  # "gtfs_realtime" | "kinematic_model"
    alert_delay_minutes: float = Field(alias="alertDelayMinutes")
    total_duration_minutes: float = Field(alias="totalDurationMinutes")
    active_slow_zones: list[ActiveSlowZone] = Field(alias="activeSlowZones")
    is_disrupted: bool = Field(alias="isDisrupted")
    active_alerts_on_route: list[ServiceAlert] = Field(alias="activeAlertsOnRoute")
    steps: list[CommuteStep] = Field(default_factory=list)
    departure_time: str = Field(alias="departureTime")
    arrival_time: str = Field(alias="arrivalTime")
    source: str
