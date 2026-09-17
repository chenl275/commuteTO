"""Server-side fallback geocoding for a free-typed origin/destination that
isn't a recognized TTC station name and didn't already come with explicit
coordinates from the frontend (see traffic_service._resolve_endpoint) —
e.g. a rider types "80 bay street" and hits Enter before the frontend's own
debounced Photon lookup (StationAutocompleteField.tsx) has resolved, or
submits from a client that never attached coordinates at all. Without this,
that request has nothing to route with and previously hard-failed as an
"Unrecognized TTC station" error instead of degrading gracefully to a real
walk+transit route.

Uses the same free, keyless Photon API (OpenStreetMap-based) as the frontend."""

from __future__ import annotations

from typing import Optional, Tuple

import httpx

PHOTON_URL = "https://photon.komoot.io/api/"
# Toronto center, used to bias results the same way the frontend does.
TORONTO_BIAS_LAT = 43.6532
TORONTO_BIAS_LON = -79.3832

_REQUEST_HEADERS = {"User-Agent": "commuteTO/1.0 (+https://github.com/)"}
_TIMEOUT_SECONDS = 6.0


async def geocode_address(query: str) -> Optional[Tuple[float, float]]:
    """Best-effort (lat, lon) for a free-typed address/landmark string, or
    None if Photon finds nothing or is unreachable — callers treat that as
    "can't resolve this endpoint" rather than raising themselves, so a slow
    or down geocoder degrades to the existing "Unrecognized TTC station"
    error instead of a 500."""
    cleaned = query.strip()
    if not cleaned:
        return None

    params = {"q": cleaned, "lat": TORONTO_BIAS_LAT, "lon": TORONTO_BIAS_LON, "limit": 1}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS, headers=_REQUEST_HEADERS) as client:
            response = await client.get(PHOTON_URL, params=params)
            response.raise_for_status()
            data = response.json()
    except (httpx.HTTPError, ValueError):
        return None

    features = data.get("features") or []
    if not features:
        return None

    coordinates = features[0].get("geometry", {}).get("coordinates")
    if not coordinates or len(coordinates) != 2:
        return None

    lon, lat = coordinates
    return (float(lat), float(lon))
