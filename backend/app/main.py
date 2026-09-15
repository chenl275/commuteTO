from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .schemas import TrafficRequest, TrafficResponse
from .traffic_service import get_traffic_estimate

# Load backend/.env regardless of the working directory uvicorn was started from.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

app = FastAPI(title="commuteTO Traffic Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "commuteTO-traffic", "status": "ok"}


@app.post("/traffic", response_model=TrafficResponse)
async def traffic(request: TrafficRequest) -> TrafficResponse:
    return await get_traffic_estimate(request)
