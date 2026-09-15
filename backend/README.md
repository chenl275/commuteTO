# commuteTO transit service

A small FastAPI service that scrapes TTC's live Reduced Speed Zones (RSZ) and
estimates subway commute time — schedule plus any active slow-zone delay —
for the "Calculate Commute" button on the frontend.

## Setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
source .venv/bin/activate
uvicorn app.main:app --reload --port 8000
```

The frontend (`NEXT_PUBLIC_BACKEND_URL`, default `http://localhost:8000`)
expects this to be running on port 8000 while developing locally.

## API

### `GET /transit/slow-zones`

Returns the currently active TTC slow zones on Lines 1 and 2, scraped from
[ttc.ca](https://www.ttc.ca/riding-the-ttc/Updates/Reduced-Speed-Zones) and
cached in memory for an hour.

```json
{
  "slowZones": [
    {
      "line": 1,
      "direction": "Northbound",
      "fromStation": "TMU",
      "toStation": "College",
      "fromStationId": "tmu",
      "toStationId": "college",
      "defectLengthMeters": 251,
      "distanceBetweenStationsMeters": 501,
      "trackReducedPercent": 50,
      "reducedSpeedKmh": 15,
      "normalSpeedKmh": 49,
      "reason": "Track issue",
      "targetRemoval": "TBD",
      "delaySeconds": 61.8
    }
  ],
  "lastUpdated": "Sep 14, 10:26 AM",
  "source": "live"
}
```

`source` is `"live"` when the scrape succeeded, or `"fallback"` when ttc.ca
couldn't be reached and no prior cached scrape was available.

### `POST /traffic` (alias: `POST /transit/commute`)

```json
{
  "origin": "Union",
  "destination": "TMU",
  "departureTime": "2026-09-15T08:30"
}
```

`origin`/`destination` accept either a TTC station name (or id, e.g.
`"bloor-yonge"`) or a `[lat, lng]` pair, which resolves to the nearest
station. Both stations must share Line 1 or Line 2 — multi-line transfer
routing isn't modeled yet. `departureTime` is optional (ISO 8601) and
defaults to now.

```json
{
  "origin": "Union",
  "destination": "TMU",
  "line": 1,
  "stationHops": 3,
  "scheduledDurationMinutes": 4.5,
  "slowZoneDelayMinutes": 1.0,
  "totalDurationMinutes": 5.5,
  "activeSlowZones": ["..."],
  "departureTime": "2026-09-15T08:30:00",
  "arrivalTime": "2026-09-15T08:35:30",
  "source": "live"
}
```
