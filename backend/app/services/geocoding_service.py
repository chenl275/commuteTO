"""Server-side fallback geocoding for a free-typed origin/destination that
isn't a recognized TTC station name and didn't already come with explicit
coordinates from the frontend (see traffic_service._resolve_endpoint) —
e.g. a rider types "80 bay street" and hits Enter before the frontend's own
debounced Photon lookup (StationAutocompleteField.tsx) has resolved, or
submits from a client that never attached coordinates at all. Without this,
that request has nothing to route with and previously hard-failed as an
"Unrecognized TTC station" error instead of degrading gracefully to a real
walk+transit route.

Uses the same free, keyless Photon API (OpenStreetMap-based) as the frontend,
and the same three-stage fallback pipeline as lib/geocoding.ts's
searchAddresses — see that function's docstring for the full rationale;
kept in sync here since this module can't share code with the frontend."""

from __future__ import annotations

import re
from typing import Optional, Tuple

import httpx

PHOTON_URL = "https://photon.komoot.io/api/"
PHOTON_REVERSE_URL = "https://photon.komoot.io/reverse"
# Toronto center, used to bias results the same way the frontend does.
TORONTO_BIAS_LAT = 43.6532
TORONTO_BIAS_LON = -79.3832
# Toronto's own city limits (not the wider Greater Toronto Area) — kept in
# sync with lib/geocoding.ts's TORONTO_BOUNDS/TORONTO_BBOX_PARAM. Sent to
# Photon as a `bbox` bias hint *and* re-checked client-side below, since that
# param is only a hint, not a guarantee (a "Square One" search still returns
# a Mississauga hit even with this exact bbox applied, confirmed live) — so
# without the client-side check, a same-named out-of-city or out-of-country
# result (Cleveland's own "Athletic Center", say) can otherwise "succeed" at
# Step A and short-circuit the spelling/token-split fallback stages below
# before they ever get a chance to find the real Toronto match.
_TORONTO_MIN_LON, _TORONTO_MIN_LAT, _TORONTO_MAX_LON, _TORONTO_MAX_LAT = (-79.6393, 43.581, -79.1158, 43.8555)
_TORONTO_BBOX_PARAM = f"{_TORONTO_MIN_LON},{_TORONTO_MIN_LAT},{_TORONTO_MAX_LON},{_TORONTO_MAX_LAT}"
# Neighbouring 905-region municipalities right up against Toronto's own
# jagged border — a rectangular bbox can't exclude these on coordinates
# alone. None of these are served by the TTC. Kept in sync with
# lib/geocoding.ts's EXCLUDED_MUNICIPALITIES.
_EXCLUDED_MUNICIPALITIES = {
    "mississauga",
    "markham",
    "vaughan",
    "brampton",
    "richmond hill",
    "pickering",
    "ajax",
    "whitby",
    "oshawa",
    "oakville",
    "burlington",
    "milton",
    "caledon",
    "newmarket",
    "aurora",
    "stouffville",
    "whitchurch-stouffville",
    "halton hills",
    "uxbridge",
    "king",
}

_REQUEST_HEADERS = {"User-Agent": "commuteTO/1.0 (+https://github.com/)"}
_TIMEOUT_SECONDS = 6.0

# Common spelling mismatches between what a rider types and how Photon's
# underlying OSM data is actually tagged — Canadian/British spelling
# ("Centre", "Theatre") for a generic word, or a plausible one-letter typo of
# an exact brand/street name ("FreshCo", "Bathurst"). Whole-word,
# case-insensitive; only ever changes the query text sent to Photon as a
# fallback retry, never what's returned to the caller (always the matched
# result's own real coordinates).
#
# Photon's hosted API has no fuzzy-matching mode to opt into for anything
# this list doesn't cover: it rejects an unrecognized `fuzzy` query param
# outright (`{"message": "Unknown query parameter 'fuzzy'."}`, confirmed live
# against photon.komoot.io), so this plain substitution list — not a
# fuzzy-search flag — is what actually stands in for the "fuzzy fallback" step.
_SPELLING_CORRECTIONS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bcenter\b", re.IGNORECASE), "centre"),
    (re.compile(r"\btheater\b", re.IGNORECASE), "theatre"),
    (re.compile(r"\bfresco\b", re.IGNORECASE), "freshco"),
    (re.compile(r"\bbathrust\b", re.IGNORECASE), "bathurst"),
]


def _apply_spelling_corrections(query: str) -> str:
    corrected = query
    for pattern, replacement in _SPELLING_CORRECTIONS:
        corrected = pattern.sub(replacement, corrected)
    return corrected


def _is_within_toronto(lat: float, lon: float) -> bool:
    return _TORONTO_MIN_LAT <= lat <= _TORONTO_MAX_LAT and _TORONTO_MIN_LON <= lon <= _TORONTO_MAX_LON


def _is_excluded_municipality(city: Optional[str]) -> bool:
    return bool(city) and city.strip().lower() in _EXCLUDED_MUNICIPALITIES


async def _fetch_photon_features(client: httpx.AsyncClient, query: str, limit: int) -> list[dict]:
    # Deliberately no `osm_tag` filter — Photon returns every category
    # (shop=*, amenity=*, leisure=*, plain addresses, ...) by default, and
    # nothing here narrows that, so a supermarket or gym ranks alongside a
    # street address instead of being filtered out.
    params = {
        "q": query,
        "lat": TORONTO_BIAS_LAT,
        "lon": TORONTO_BIAS_LON,
        "limit": limit,
        "bbox": _TORONTO_BBOX_PARAM,
    }
    response = await client.get(PHOTON_URL, params=params)
    response.raise_for_status()
    data = response.json()
    features = data.get("features") or []

    filtered = []
    for feature in features:
        properties = feature.get("properties") or {}
        coordinates = feature.get("geometry", {}).get("coordinates")
        if not coordinates or len(coordinates) != 2:
            continue
        lon, lat = coordinates
        if (
            properties.get("countrycode") == "CA"
            and _is_within_toronto(lat, lon)
            and not _is_excluded_municipality(properties.get("city"))
        ):
            filtered.append(feature)
    return filtered


def _feature_matches_token(feature: dict, token: str) -> bool:
    """True if `token` shows up in one of `feature`'s own rider-facing
    fields (its POI name, street, or locality/city) — used by the
    token-split fallback to confirm a same-anchor-word result is actually
    near the disambiguating word the caller typed ("bathurst" in "fresco
    bathurst"), not just any result that happens to share the anchor word."""
    properties = feature.get("properties") or {}
    needle = token.lower()
    haystacks = [properties.get("name"), properties.get("street"), properties.get("locality"), properties.get("city")]
    return any(value and needle in value.lower() for value in haystacks)


def _feature_coordinates(feature: dict) -> Optional[Tuple[float, float]]:
    coordinates = feature.get("geometry", {}).get("coordinates")
    if not coordinates or len(coordinates) != 2:
        return None
    lon, lat = coordinates
    return (float(lat), float(lon))


# Bounds how many anchor candidates the Step C spatial fallback below fires
# a reverse-geocode request for — Photon's own anchor-search ranking is
# already nearest-first, so the true match is almost always within this
# many candidates, and this keeps a worst-case empty search from firing a
# couple dozen extra requests.
_SPATIAL_RANKING_CANDIDATE_LIMIT = 6


async def _fetch_nearby_streets(client: httpx.AsyncClient, lat: float, lon: float) -> list[dict]:
    """Nearby streets (any classification), nearest first, via Photon's own
    reverse-geocode endpoint restricted to the "street" layer — lets Step C
    confirm a disambiguator word names a street genuinely near a candidate
    even when that candidate's own listed `street` property says something
    else entirely (e.g. a FreshCo tagged to its own service laneway,
    "College Place", that's still right next to "Bathurst"). Best-effort:
    an unreachable/erroring reverse lookup just yields no nearby streets
    rather than failing the whole search."""
    try:
        response = await client.get(
            PHOTON_REVERSE_URL, params={"lat": lat, "lon": lon, "layer": "street", "limit": 6}
        )
        response.raise_for_status()
        data = response.json()
        return data.get("features") or []
    except (httpx.HTTPError, ValueError):
        return []


async def _feature_nearby_streets_match_token(client: httpx.AsyncClient, feature: dict, token: str) -> bool:
    coordinates = feature.get("geometry", {}).get("coordinates")
    if not coordinates or len(coordinates) != 2:
        return False
    lon, lat = coordinates
    nearby = await _fetch_nearby_streets(client, lat, lon)
    needle = token.lower()
    return any(needle in ((street.get("properties") or {}).get("name") or "").lower() for street in nearby)


async def geocode_address(query: str) -> Optional[Tuple[float, float]]:
    """Best-effort (lat, lon) for a free-typed address/landmark string, or
    None if Photon finds nothing (even after the fallback stages below) or
    is unreachable — callers treat that as "can't resolve this endpoint"
    rather than raising themselves, so a slow or down geocoder degrades to
    the existing "Unrecognized TTC station" error instead of a 500.

    A three-stage fallback pipeline, each stage only tried when the
    previous one came back empty — most queries resolve on Step A and never
    pay for the later stages:
      A. The query exactly as typed.
      B. A plain spelling-correction retry (see _apply_spelling_corrections)
         — e.g. "Athletic Center" finds nothing, "Athletic Centre" does.
      C. A token-split retry for a multi-word query that's still empty —
         often a POI name plus a disambiguating street/area ("fresco
         bathurst") that Photon can't match as one phrase even though each
         word alone would. Searches just the first word, then prefers
         whichever of those results has the rest of the query somewhere in
         its own street/locality/name; when none of them do, falls back to
         a spatial check (see _feature_nearby_streets_match_token) for a
         candidate tagged to a minor laneway that's still genuinely near the
         named street even though its own `street` property says something
         else (the FreshCo-tagged-to-"College Place"-instead-of-"Bathurst"
         case this stage exists for) — and only after both checks find
         nothing does this fall back to the plain first (nearest-biased)
         result, rather than returning nothing outright."""
    cleaned = query.strip()
    if not cleaned:
        return None

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS, headers=_REQUEST_HEADERS) as client:
            features = await _fetch_photon_features(client, cleaned, 1)

            # Step C below splits whichever of these two query strings is
            # "best" — the corrected one once B has actually been tried, so
            # a typo'd anchor word ("Fresco") doesn't slip through to the
            # token-split search unmatched-to-its-real-spelling and match
            # some unrelated same-word result (e.g. "Fresco's Fish & Chips")
            # instead of the intended one.
            best_query = cleaned

            if not features:
                corrected = _apply_spelling_corrections(cleaned)
                if corrected != cleaned:
                    features = await _fetch_photon_features(client, corrected, 1)
                    best_query = corrected

            if not features:
                words = best_query.split()
                if len(words) > 1:
                    anchor, *disambiguators = words
                    anchor_features = await _fetch_photon_features(client, anchor, 10)
                    matching = [
                        feature
                        for feature in anchor_features
                        if any(_feature_matches_token(feature, word) for word in disambiguators)
                    ]

                    if not matching and anchor_features:
                        for feature in anchor_features[:_SPATIAL_RANKING_CANDIDATE_LIMIT]:
                            spatial_hit = False
                            for word in disambiguators:
                                if await _feature_nearby_streets_match_token(client, feature, word):
                                    spatial_hit = True
                                    break
                            if spatial_hit:
                                matching.append(feature)

                    features = matching or anchor_features
    except (httpx.HTTPError, ValueError):
        return None

    if not features:
        return None
    return _feature_coordinates(features[0])
