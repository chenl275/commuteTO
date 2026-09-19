/**
 * Toronto-biased address/landmark search against Photon (photon.komoot.io),
 * a free OpenStreetMap-based geocoder that needs no API key — used to fill
 * in the "hybrid" station-or-address autocomplete (see
 * StationAutocompleteField.tsx) and to reverse-geocode a map-dropped pin
 * into a rider-facing label.
 */

const PHOTON_BASE_URL = "https://photon.komoot.io/api/";
const PHOTON_REVERSE_URL = "https://photon.komoot.io/reverse";
/** [longitude, latitude] center used to bias Photon's results toward Toronto. */
const TORONTO_BIAS = { lat: 43.6532, lon: -79.3832 };
/** min_lon,min_lat,max_lon,max_lat — Toronto's own city limits (not the
 * wider Greater Toronto Area, which would let a 905-region suggestion like
 * Mississauga or Markham through — those aren't TTC destinations at all). */
const TORONTO_BOUNDS = { minLon: -79.6393, minLat: 43.581, maxLon: -79.1158, maxLat: 43.8555 };
const TORONTO_BBOX_PARAM = `${TORONTO_BOUNDS.minLon},${TORONTO_BOUNDS.minLat},${TORONTO_BOUNDS.maxLon},${TORONTO_BOUNDS.maxLat}`;

/** True if `lat`/`lon` falls inside Toronto's city limits. Checked
 * client-side in addition to Photon's own `bbox` query param — that param
 * is a bias/filter hint to Photon's search, not a guarantee every result
 * satisfies it (confirmed live: a "Square One" search still returns
 * Mississauga hits even with this exact bbox applied), so a boundary-
 * adjacent or mis-tagged result could otherwise slip through. */
function isWithinToronto(lat: number, lon: number): boolean {
  return (
    lat >= TORONTO_BOUNDS.minLat &&
    lat <= TORONTO_BOUNDS.maxLat &&
    lon >= TORONTO_BOUNDS.minLon &&
    lon <= TORONTO_BOUNDS.maxLon
  );
}

/** Neighbouring 905-region municipalities right up against Toronto's own
 * jagged border — a rectangular bbox can't exclude these on coordinates
 * alone, since a point just across the line from Toronto can still fall
 * inside the rectangle (e.g. a Mississauga address ~2km southwest of
 * Toronto's western edge). None of these are served by the TTC. Toronto's
 * own former boroughs (Scarborough, North York, Etobicoke, East York,
 * York), amalgamated into the city in 1998, are deliberately not here. */
const EXCLUDED_MUNICIPALITIES = new Set([
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
]);

function isExcludedMunicipality(city: string | undefined): boolean {
  return !!city && EXCLUDED_MUNICIPALITIES.has(city.trim().toLowerCase());
}

export interface GeocodeResult {
  id: string;
  /** Bold headline for the suggestion list, and the text filled into the
   * origin/destination field once picked — a landmark/POI name when Photon
   * has one (e.g. "New York Fries"), otherwise the street address itself. */
  title: string;
  /** Muted subtitle for the suggestion list: the full street address, e.g.
   * "220 Yonge St, Toronto". Empty when `title` already is the address —
   * nothing more specific to show underneath it. */
  subtitle: string;
  lat: number;
  lon: number;
}

interface PhotonProperties {
  name?: string;
  housenumber?: string;
  street?: string;
  /** Neighbourhood-level area, e.g. "Kensington Market" — finer-grained than
   * `city`, used both as an extra disambiguation field for the token-split
   * fallback (see featureMatchesToken) and to tell apart two same-named
   * chain locations in the suggestion list (see formatPhotonAddress). */
  locality?: string;
  city?: string;
  state?: string;
  country?: string;
  /** ISO 3166-1 alpha-2, e.g. "CA" — used to reject a same-named
   * out-of-country result (Buffalo, NY) that slips inside a loose bbox. */
  countrycode?: string;
  osm_id?: number | string;
  osm_type?: string;
  /** OSM's `highway=*` classification when this feature IS a street (only
   * present on a `layer=street` reverse-geocode result, see
   * fetchNearbyStreets) — e.g. "secondary" for Bathurst Street vs.
   * "service" for the service laneway behind it. Used to tell a real,
   * recognizable road apart from a minor service/pedestrian way. */
  osm_value?: string;
}

interface PhotonFeature {
  properties: PhotonProperties;
  geometry: { type: "Point"; coordinates: [number, number] };
}

interface PhotonResponse {
  features: PhotonFeature[];
}

/** Full street address line, e.g. "220 Yonge St, Toronto" — falls back to
 * just the city when there's no street/housenumber at all. */
function formatStreetAddress(properties: PhotonProperties): string {
  const streetPart = `${properties.housenumber ?? ""} ${properties.street ?? ""}`.trim();
  const city = properties.city || "Toronto";
  return streetPart ? `${streetPart}, ${city}` : city;
}

function formatPhotonAddress(properties: PhotonProperties): { title: string; subtitle: string } {
  if (properties.name) {
    // A neighbourhood/locality, when Photon has one, disambiguates two
    // same-named chain locations ("which FreshCo?") right in the
    // suggestion list — inserted between the street and city the way a
    // Toronto address is normally read, e.g. "410 Bathurst St, Kensington
    // Market, Toronto". May be replaced entirely by enrichPoiSubtitle below
    // when the street itself turns out to be an unrecognizable laneway.
    const streetPart = `${properties.housenumber ?? ""} ${properties.street ?? ""}`.trim();
    const city = properties.city || "Toronto";
    const parts = [streetPart, properties.locality, city].filter((part): part is string => !!part);
    return { title: properties.name, subtitle: parts.join(", ") };
  }
  // No POI/landmark name — the address itself is the title, with nothing
  // more specific left to put underneath it.
  return { title: formatStreetAddress(properties), subtitle: "" };
}

function toGeocodeResult(feature: PhotonFeature, index: number): GeocodeResult {
  const [lon, lat] = feature.geometry.coordinates;
  const { title, subtitle } = formatPhotonAddress(feature.properties);
  return {
    id: `${feature.properties.osm_type ?? "photon"}-${feature.properties.osm_id ?? index}`,
    title,
    subtitle,
    lat,
    lon,
  };
}

/** One raw Photon query, Toronto-biased and filtered down to real, in-city
 * Canadian results (see searchAddresses's own docstring) — deliberately
 * carries no `osm_tag` restriction, so a shop/amenity POI (a supermarket, a
 * gym) comes back on equal footing with a plain street address; Photon
 * returns every category by default and nothing here narrows that. */
async function fetchPhotonFeatures(
  query: string,
  limit: number,
  signal?: AbortSignal
): Promise<PhotonFeature[]> {
  const url = `${PHOTON_BASE_URL}?q=${encodeURIComponent(query)}&lat=${TORONTO_BIAS.lat}&lon=${TORONTO_BIAS.lon}&limit=${limit}&bbox=${TORONTO_BBOX_PARAM}`;
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Address search failed with status ${response.status}`);
  }

  const data = (await response.json()) as PhotonResponse;
  return (data.features ?? []).filter(
    (feature) =>
      feature.properties.countrycode === "CA" &&
      isWithinToronto(feature.geometry.coordinates[1], feature.geometry.coordinates[0]) &&
      !isExcludedMunicipality(feature.properties.city)
  );
}

/** Common spelling mismatches between what a rider types and how Photon's
 * underlying OSM data is actually tagged — Canadian/British spelling
 * ("Centre", "Theatre") for a generic word, or a plausible one-letter typo
 * of an exact brand/street name ("FreshCo", "Bathurst"). Whole-word,
 * case-insensitive. Only ever changes the query text sent to Photon as a
 * fallback retry — never what's shown back to the rider, which always comes
 * from the matched result's own real properties.
 *
 * Photon's hosted API has no fuzzy-matching mode to opt into for anything
 * this list doesn't cover: it rejects an unrecognized `fuzzy` query param
 * outright (`{"message": "Unknown query parameter 'fuzzy'."}`, confirmed
 * live against photon.komoot.io), so this plain substitution list — not a
 * fuzzy-search flag — is what actually stands in for Step B. */
const SPELLING_CORRECTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bcenter\b/gi, "centre"],
  [/\btheater\b/gi, "theatre"],
  [/\bfresco\b/gi, "freshco"],
  [/\bbathrust\b/gi, "bathurst"],
];

function applySpellingCorrections(query: string): string {
  return SPELLING_CORRECTIONS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), query);
}

/** True if `token` shows up in one of a Photon result's own rider-facing
 * fields (its POI name, street, or locality/city) — used by the token-split
 * fallback below to confirm a same-anchor-word result is actually near the
 * disambiguating word the rider typed ("bathurst" in "fresco bathurst"),
 * not just any result that happens to share the anchor word. */
function featureMatchesToken(feature: PhotonFeature, token: string): boolean {
  const needle = token.toLowerCase();
  const haystacks = [
    feature.properties.name,
    feature.properties.street,
    feature.properties.locality,
    feature.properties.city,
  ];
  return haystacks.some((value) => value?.toLowerCase().includes(needle));
}

/** OSM `highway=*` values that represent a minor service/pedestrian way
 * rather than a real, recognizable arterial/collector/local road — a POI
 * tagged with one of these as its own `street` (a supermarket whose nearest
 * OSM way is its own loading-dock laneway, say) isn't a useful location
 * label on its own. Checked against a `layer=street` reverse-geocode
 * result's `osm_value` (see fetchNearbyStreets/fetchNearbyRealStreets). */
const MINOR_ROAD_HIGHWAY_VALUES = new Set([
  "service",
  "track",
  "path",
  "footway",
  "pedestrian",
  "cycleway",
  "steps",
]);

/** Name patterns that read as a minor laneway/alley purely from the text —
 * checked first since it's free (no extra request) — before a POI's own
 * `street` is treated as suspect enough to warrant the real reverse-geocode
 * classification check in enrichPoiSubtitle. Deliberately doesn't include
 * generic suffixes like "Place"/"Court"/"Crescent" that are also
 * legitimate real street names in Toronto (e.g. "Grosvenor Place") — those
 * only get re-checked when the POI has no housenumber either, which is the
 * actual "College Place"-style case this whole feature is fixing. */
const MINOR_ROAD_NAME_PATTERN = /\b(lane|laneway|mews|alley|walk|trail)\b/i;

/** True when a POI's own listed `street` looks unreliable enough to be
 * worth a real (reverse-geocode) classification check — missing entirely,
 * a name that already reads as a laneway, or a generic-suffix street name
 * with no housenumber (the exact "410 Bathurst St" POI tagged only to
 * "College Place" case: a real numbered address never has this shape). */
function looksLikeMinorRoad(properties: PhotonProperties): boolean {
  if (!properties.street) return true;
  if (MINOR_ROAD_NAME_PATTERN.test(properties.street)) return true;
  return !properties.housenumber && /\b(place|court|crescent|circle|square)\b/i.test(properties.street);
}

/** Nearby streets (any classification), nearest first, via Photon's own
 * reverse-geocode endpoint restricted to the "street" layer — used both to
 * find a POI's real neighbouring arterial (fetchNearbyRealStreets) and to
 * spatially confirm a rider-typed disambiguator names a street genuinely
 * near a POI even when it isn't that POI's own listed `street` (see
 * searchAddresses's Step C). Best-effort: an unreachable/erroring reverse
 * lookup just yields no nearby streets rather than failing the whole search. */
async function fetchNearbyStreets(lat: number, lon: number, signal?: AbortSignal): Promise<PhotonFeature[]> {
  try {
    const url = `${PHOTON_REVERSE_URL}?lat=${lat}&lon=${lon}&layer=street&limit=6`;
    const response = await fetch(url, { signal });
    if (!response.ok) return [];
    const data = (await response.json()) as PhotonResponse;
    return data.features ?? [];
  } catch {
    return [];
  }
}

/** Up to 2 nearby *real* (non-minor) street names for `feature`, nearest
 * first, excluding its own listed street — the recognizable "Street A &
 * Street B" cross-street pairing used to replace a POI's subtitle when its
 * own `street` is an unrecognizable service laneway (see enrichPoiSubtitle). */
async function fetchNearbyRealStreets(feature: PhotonFeature, signal?: AbortSignal): Promise<string[]> {
  const [lon, lat] = feature.geometry.coordinates;
  const nearby = await fetchNearbyStreets(lat, lon, signal);
  const ownStreet = feature.properties.street?.toLowerCase();
  const names: string[] = [];
  for (const candidate of nearby) {
    const name = candidate.properties.name;
    if (!name || name.toLowerCase() === ownStreet) continue;
    if (candidate.properties.osm_value && MINOR_ROAD_HIGHWAY_VALUES.has(candidate.properties.osm_value)) continue;
    if (!names.includes(name)) names.push(name);
    if (names.length === 2) break;
  }
  return names;
}

/** Replaces `result.subtitle` with a recognizable cross-street label (plus
 * neighbourhood, when available) when `feature`'s own listed street looks
 * like an unreliable service laneway — e.g. a FreshCo tagged only to
 * "College Place" becomes "Bathurst Street & Nassau Street, Kensington
 * Market" once its real nearby arterials are found. Leaves `result`
 * untouched (still whatever formatPhotonAddress already produced) when
 * the street looks fine, or when no better nearby street turns up. */
async function enrichPoiSubtitle(result: GeocodeResult, feature: PhotonFeature, signal?: AbortSignal): Promise<void> {
  if (!feature.properties.name || !looksLikeMinorRoad(feature.properties)) return;

  const realStreets = await fetchNearbyRealStreets(feature, signal);
  if (realStreets.length === 0) return;

  const parts = [realStreets.join(" & "), feature.properties.locality, feature.properties.city || "Toronto"].filter(
    (part): part is string => !!part
  );
  result.subtitle = parts.join(", ");
}

/** True if a rider-typed disambiguator word names a street genuinely near
 * `feature`, even when it isn't that POI's own listed `street` — the
 * spatial counterpart to featureMatchesToken's plain text check, for a POI
 * tagged to a minor laneway (e.g. "College Place") that's still right next
 * to the named street the rider actually typed ("Bathurst"). */
async function featureNearbyStreetsMatchToken(feature: PhotonFeature, token: string, signal?: AbortSignal): Promise<boolean> {
  const [lon, lat] = feature.geometry.coordinates;
  const nearby = await fetchNearbyStreets(lat, lon, signal);
  const needle = token.toLowerCase();
  return nearby.some((street) => street.properties.name?.toLowerCase().includes(needle));
}

// Bounds how many anchor candidates Step C's spatial fallback below fires a
// reverse-geocode request for — Photon's own anchor-search ranking is
// already nearest-first, so the true match is almost always within this
// many candidates, and this keeps a worst-case empty search from firing a
// couple dozen extra requests.
const SPATIAL_RANKING_CANDIDATE_LIMIT = 6;

/** Toronto-biased address/landmark search, debounced by the caller (see
 * StationAutocompleteField.tsx) — Photon has no built-in debounce of its own.
 * Strictly bounded to Toronto's own city limits (never the wider GTA —
 * Mississauga, Markham, etc. aren't TTC destinations) and filtered to
 * Canadian results client-side, so a same-named US location (Buffalo, NY
 * for a "Main St" query, say) never shows up as a commute endpoint.
 *
 * A three-stage fallback pipeline, each stage only tried when the previous
 * one came back empty — most queries resolve on Step A and never pay for
 * the later stages:
 *   A. The query exactly as typed.
 *   B. A plain spelling-correction retry (see applySpellingCorrections) —
 *      e.g. "Athletic Center" finds nothing, "Athletic Centre" does.
 *   C. A token-split retry for a multi-word query that's still empty — often
 *      a POI name plus a disambiguating street/area ("fresco bathurst")
 *      that Photon can't match as one phrase even though each word alone
 *      would. Searches just the first word, then ranks whatever comes back
 *      by whether the rest of the query shows up in that result's own
 *      street/locality/name — and, when no candidate's own listed fields
 *      match at all, falls back to a spatial check (see
 *      featureNearbyStreetsMatchToken) for a POI tagged to a minor laneway
 *      that's still genuinely near the named street ("bathurst") even
 *      though its own `street` property says something else entirely.
 *      Falls back to the unranked anchor list if nothing matches either
 *      way, rather than discarding real candidates outright.
 *
 * Every returned POI result then gets one more best-effort pass
 * (enrichPoiSubtitle) that replaces its subtitle with a recognizable
 * cross-street label when its own listed street reads as an unreliable
 * service laneway — same root cause Step C's spatial fallback works around,
 * fixed up for display even on a query that matched fine at Step A. */
export async function searchAddresses(
  query: string,
  signal?: AbortSignal
): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  let features = await fetchPhotonFeatures(trimmed, 5, signal);

  // Step C below splits whichever of these two query strings is "best" —
  // the corrected one once B has actually been tried, so a typo'd anchor
  // word ("Fresco") doesn't slip through to the token-split search
  // unmatched-to-its-real-spelling and match some unrelated same-word
  // result (e.g. "Fresco's Fish & Chips") instead of the intended one.
  let bestQuery = trimmed;

  if (features.length === 0) {
    const corrected = applySpellingCorrections(trimmed);
    if (corrected !== trimmed) {
      features = await fetchPhotonFeatures(corrected, 5, signal);
      bestQuery = corrected;
    }
  }

  if (features.length === 0) {
    const words = bestQuery.split(/\s+/).filter(Boolean);
    if (words.length > 1) {
      const [anchor, ...disambiguators] = words;
      const anchorFeatures = await fetchPhotonFeatures(anchor, 10, signal);
      let matching = anchorFeatures.filter((feature) =>
        disambiguators.some((word) => featureMatchesToken(feature, word))
      );

      if (matching.length === 0 && anchorFeatures.length > 0) {
        const candidates = anchorFeatures.slice(0, SPATIAL_RANKING_CANDIDATE_LIMIT);
        const spatialMatches = await Promise.all(
          candidates.map(async (feature) => {
            const matchesAny = await Promise.all(
              disambiguators.map((word) => featureNearbyStreetsMatchToken(feature, word, signal))
            );
            return matchesAny.some(Boolean) ? feature : null;
          })
        );
        matching = spatialMatches.filter((feature): feature is PhotonFeature => feature !== null);
      }

      features = (matching.length > 0 ? matching : anchorFeatures).slice(0, 5);
    }
  }

  const results = features.map(toGeocodeResult);
  await Promise.all(results.map((result, index) => enrichPoiSubtitle(result, features[index], signal)));
  return results;
}

/** Best-effort human label for a map-dropped pin's raw coordinates — falls
 * back to a plain "lat, lon" string when reverse geocoding is unavailable or
 * finds nothing (a lake, a highway median, a Photon outage), so pin
 * placement always works even if this fails. */
export async function reverseGeocode(lat: number, lon: number): Promise<string> {
  const fallback = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  try {
    const url = `${PHOTON_REVERSE_URL}?lat=${lat}&lon=${lon}`;
    const response = await fetch(url);
    if (!response.ok) return fallback;

    const data = (await response.json()) as PhotonResponse;
    const [feature] = data.features ?? [];
    if (!feature) return fallback;

    const { title, subtitle } = formatPhotonAddress(feature.properties);
    return subtitle ? `${title}, ${subtitle}` : title;
  } catch {
    return fallback;
  }
}
