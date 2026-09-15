# commuteTO traffic service

A small FastAPI service that estimates driving time and traffic delay between
two points, for the "Calculate Commute" button on the frontend.

## Setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Optionally add a real Google Maps API key (copy `.env.example` to `.env` and
fill it in). Without one, `/traffic` returns a deterministic simulated
estimate instead of calling Google.

## Run

```bash
source .venv/bin/activate
uvicorn app.main:app --reload --port 8000
```

The frontend (`NEXT_PUBLIC_BACKEND_URL`, default `http://localhost:8000`)
expects this to be running on port 8000 while developing locally.

## API

`POST /traffic`

```json
{
  "origin": "Union Station",
  "destination": "Yonge-Eglinton",
  "departureTime": "2026-09-15T08:30"
}
```

`origin`/`destination` accept either a free-text address string or a
`[lat, lng]` pair. `departureTime` is optional (ISO 8601) and defaults to now.
