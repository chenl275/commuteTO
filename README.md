# commuteTO

A real-time transit tracker for Toronto's TTC network that predicts delays before they hit your commute. Unlike standard transit apps that just read timetable schedules, commuteTO pairs live vehicle GPS and subway signals with realistic train physics to show what your commute time actually looks like right now.
---

## Features

- **Kinematic Delay Engine:** Calculates train delay through active track slow zones using vehicle dynamics (140m Toronto Rocket trainsets, civil service braking of 0.85 m/s², and tractive acceleration of 0.75 m/s²) rather than point-mass assumptions.
- **Live GTFS-RT Telemetry:** Ingests live Metrolinx/TTC binary Protocol Buffer feeds (`TripUpdates` and `VehiclePositions`) to capture real-world headway and transponder offsets.
- **Complete Transit Grid:** Full vector coverage of subway lines (Lines 1, 2, 4), the entire downtown streetcar network (501–512), and the 300-series Blue Night bus grid.
- **Time-Aware Disruption Filtering:** Distinguishes active service disruptions from scheduled overnight maintenance windows, reserving travel time penalties strictly for currently affected routes.
- **Subway Train Interpolation:** Maps underground subway movements by projecting real-time signal block progress onto high-resolution track geometry.

---

## Architecture

- **Frontend:** Next.js (App Router), TypeScript, Tailwind CSS
- **Map Engine:** MapLibre GL with custom vector tile styling and zoom-interpolated layers
- **Backend:** FastAPI (Python 3.11+), Pydantic, HTTPX
- **Data Protocols:** GTFS static tables, GTFS-Realtime (Protobuf)

---

## Getting Started

### 1. Prerequisites
- Node.js 18+
- Python 3.11+

### 2. Backend Setup
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000