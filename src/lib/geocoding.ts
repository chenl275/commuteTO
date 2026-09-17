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
/** min_lon,min_lat,max_lon,max_lat — the Greater Toronto Area. Photon's own
 * distance bias alone still lets a same-named US location (e.g. Buffalo)
 * outrank a real GTA match for a short/common query, so results are also
 * hard-bounded to this box. */
const GTA_BBOX = "-79.64,43.58,-79.11,43.86";

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
  city?: string;
  state?: string;
  country?: string;
  /** ISO 3166-1 alpha-2, e.g. "CA" — used to reject a same-named
   * out-of-country result (Buffalo, NY) that slips inside a loose bbox. */
  countrycode?: string;
  osm_id?: number | string;
  osm_type?: string;
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
  const streetAddress = formatStreetAddress(properties);
  if (properties.name) {
    return { title: properties.name, subtitle: streetAddress };
  }
  // No POI/landmark name — the address itself is the title, with nothing
  // more specific left to put underneath it.
  return { title: streetAddress, subtitle: "" };
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

/** Toronto-biased address/landmark search, debounced by the caller (see
 * StationAutocompleteField.tsx) — Photon has no built-in debounce of its own.
 * Hard-bounded to the GTA and filtered to Canadian results client-side, so a
 * same-named US location (Buffalo, NY for a "Main St" query, say) never
 * shows up as a Toronto commute endpoint. */
export async function searchAddresses(
  query: string,
  signal?: AbortSignal
): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const url = `${PHOTON_BASE_URL}?q=${encodeURIComponent(trimmed)}&lat=${TORONTO_BIAS.lat}&lon=${TORONTO_BIAS.lon}&limit=5&bbox=${GTA_BBOX}`;
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Address search failed with status ${response.status}`);
  }

  const data = (await response.json()) as PhotonResponse;
  return (data.features ?? [])
    .filter((feature) => feature.properties.countrycode === "CA")
    .map(toGeocodeResult);
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
