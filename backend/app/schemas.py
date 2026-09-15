from typing import Optional, Tuple, Union

from pydantic import BaseModel, ConfigDict, Field

Coordinates = Tuple[float, float]


class TrafficRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    origin: Union[str, Coordinates]
    destination: Union[str, Coordinates]
    departure_time: Optional[str] = Field(default=None, alias="departureTime")


class TrafficResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    origin: str
    destination: str
    distance_meters: int = Field(alias="distanceMeters")
    distance_text: str = Field(alias="distanceText")
    duration_seconds: int = Field(alias="durationSeconds")
    duration_text: str = Field(alias="durationText")
    duration_in_traffic_seconds: int = Field(alias="durationInTrafficSeconds")
    duration_in_traffic_text: str = Field(alias="durationInTrafficText")
    traffic_delay_minutes: int = Field(alias="trafficDelayMinutes")
    departure_time: str = Field(alias="departureTime")
    arrival_time: str = Field(alias="arrivalTime")
    source: str
