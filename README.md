# commuteTO

A real-time transit tracker and multi-modal routing engine for Toronto's TTC network that predicts delays before they hit your commute. Unlike standard transit apps that merely read static timetables, commuteTO combines live vehicle telemetry and subway slow zones with realistic train physics to reveal your true travel time.

---

## Overview
<img width="2940" height="1602" alt="Screenshot 2026-09-21 at 10 05 11 AM" src="https://github.com/user-attachments/assets/003582e4-9f4a-4b0a-91f6-d9fa982e7a59" />
<img width="2940" height="1596" alt="Screenshot 2026-09-21 at 10 07 51 AM" src="https://github.com/user-attachments/assets/58c3858b-b887-4e8c-be1e-ccf4824ec7a8" />
<img width="5120" height="2344" alt="Screenshot 2026-09-23 at 6 48 18 PM" src="https://github.com/user-attachments/assets/046647b5-b94e-4dcb-9e83-efb1f6829fb7" />

---

## Live Demo & Performance Notice

* **Live Web App:** [commute-to.vercel.app](https://commute-to.vercel.app)
* **Backend:** FastAPI on Render (Free Tier)

> **⚡ Cloud vs. Local Performance:**  
> The routing engine solves time-dependent, multi-modal Dijkstra graphs across the entire Toronto transit graph (subways, streetcars, surface buses, and pedestrian walk transfers) directly in Python.  
> 
> Because Render's free tier provisions a throttled **0.1 vCPU** with shared virtual disk I/O, computing complex multi-transfer routes across the full network can take **30–60 seconds** on the cloud deployment. **Running the project locally is recommended for faster route calculations** using native processor cores.

---

## Features

- **Kinematic Delay Engine:** Calculates train delay through active track slow zones using vehicle dynamics (140m Toronto Rocket trainsets, civil service braking of 0.85 m/s², and tractive acceleration of 0.75 m/s²) rather than point-mass assumptions.
- **Multi-Modal Routing Engine:** Time-dependent graph solver implementing walking transfers, subway trunk lines (Line 1, Line 2, Line 4), surface streetcars, and day/night bus grids.
- **Live GTFS-RT Telemetry:** Ingests live Metrolinx/TTC binary Protocol Buffer feeds (`TripUpdates` and `VehiclePositions`) to capture real-world headway and transponder offsets.
- **Dynamic Disruption Modeling:** Surfaces live detour advisories, scraper-backed track slow zones, and per-leg delay penalties on active transit legs.
- **Subway Train Interpolation:** Maps underground subway movements by projecting real-time signal block progress onto high-resolution track geometry.
<img width="2940" height="1600" alt="Screenshot 2026-09-21 at 10 48 39 AM" src="https://github.com/user-attachments/assets/311c04f5-019f-420e-bc20-847ae310819c" />

---

## Architecture

- **Frontend:** Next.js (App Router), TypeScript, Tailwind CSS
- **Map Engine:** MapLibre GL with custom vector tile styling and zoom-interpolated layers
- **Backend:** FastAPI (Python 3.11+), Pydantic, HTTPX, SQLite
- **Data Protocols:** GTFS static relational tables, GTFS-Realtime (Protobuf)

---

## Getting Started (Local Setup)

Running locally delivers faster graph search and route generation.

### 1. Prerequisites
- Node.js 18+ 
- Python 3.11+ 

### 2. Backend Setup
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Assemble database if packaged as split files:
cat app/data/gtfs_routing.db.gz.part_* > app/data/gtfs_routing.db.gz 2>/dev/null || true
gunzip -f app/data/gtfs_routing.db.gz 2>/dev/null || true

uvicorn app.main:app --reload --port 8000
```

### 3. Frontend Setup

In a separate terminal window:

```bash
cd frontend
npm install
npm run dev
```
