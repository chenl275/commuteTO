from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .schemas import AlertsResponse, SlowZonesResponse, TransitCommuteRequest, TransitCommuteResponse
from .services.alerts_service import get_alerts
from .services.slow_zones_scraper import get_slow_zones
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


@app.post("/traffic", response_model=TransitCommuteResponse)
@app.post("/transit/commute", response_model=TransitCommuteResponse)
async def commute(request: TransitCommuteRequest) -> TransitCommuteResponse:
    try:
        return await get_transit_commute_estimate(request)
    except TransitCommuteError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
