from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .schemas import (
    AlertsResponse,
    DetoursResponse,
    SlowZonesResponse,
    TransitCommuteRequest,
    TransitCommuteResponse,
)
from .services.alerts_service import get_alerts
from .services.detour_service import get_active_surface_detours
from .services.slow_zones_scraper import get_slow_zones
from .services.surface_transit import (
    get_day_buses_geojson,
    get_night_buses_geojson,
    get_streetcars_geojson,
    get_surface_stops_geojson,
)
from .traffic_service import TransitCommuteError, get_transit_commute_estimate

# Load backend/.env regardless of the working directory uvicorn was started from.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

app = FastAPI(title="commuteTO Transit Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "commuteTO-transit", "status": "ok"}


@app.get("/transit/slow-zones", response_model=SlowZonesResponse)
async def slow_zones() -> SlowZonesResponse:
    return SlowZonesResponse(**await get_slow_zones())


@app.get("/transit/alerts", response_model=AlertsResponse)
async def alerts() -> AlertsResponse:
    return AlertsResponse(**await get_alerts())


@app.get("/transit/surface/streetcars")
def surface_streetcars() -> dict:
    return get_streetcars_geojson()


@app.get("/transit/surface/day-buses")
def surface_day_buses() -> dict:
    return get_day_buses_geojson()


@app.get("/transit/surface/night-buses")
def surface_night_buses() -> dict:
    return get_night_buses_geojson()


@app.get("/transit/surface/stops")
def surface_stops() -> dict:
    return get_surface_stops_geojson()


@app.get("/api/detours", response_model=DetoursResponse)
async def detours() -> DetoursResponse:
    return DetoursResponse(detours=await get_active_surface_detours())


@app.post("/traffic", response_model=TransitCommuteResponse)
@app.post("/transit/commute", response_model=TransitCommuteResponse)
async def commute(request: TransitCommuteRequest) -> TransitCommuteResponse:
    try:
        return await get_transit_commute_estimate(request)
    except TransitCommuteError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
