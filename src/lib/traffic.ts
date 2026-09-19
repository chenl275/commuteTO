import { BACKEND_URL } from "./constants";
import type {
  ActiveSlowZone,
  AlertsResponse,
  DetoursResponse,
  RouteSummary,
  SlowZonesResponse,
  SurfaceRoutesGeoJSON,
  SurfaceStopsGeoJSON,
  TransitCommuteRequest,
  TransitCommuteResponse,
} from "@/types/traffic";

type RawRouteSummary = Omit<RouteSummary, "activeSlowZones"> & {
  activeSlowZones: Omit<ActiveSlowZone, "id">[];
};

type RawTransitCommuteResponse = RawRouteSummary & {
  alternativeRoutes: RawRouteSummary[];
};

function withZoneIds(zones: Omit<ActiveSlowZone, "id">[]): ActiveSlowZone[] {
  return zones.map((zone, index) => ({
    ...zone,
    id: `${zone.line}-${zone.fromStationId ?? zone.fromStation}-${zone.toStationId ?? zone.toStation}-${index}`,
  }));
}

function withRouteZoneIds(route: RawRouteSummary): RouteSummary {
  return { ...route, activeSlowZones: withZoneIds(route.activeSlowZones) };
}

async function readErrorDetail(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as { detail?: string } | null;
  return typeof body?.detail === "string" ? body.detail : null;
}

export async function getTrafficEstimate(
  request: TransitCommuteRequest
): Promise<TransitCommuteResponse> {
  const response = await fetch(`${BACKEND_URL}/traffic`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(detail ?? `Transit commute request failed with status ${response.status}`);
  }

  const data = (await response.json()) as RawTransitCommuteResponse;
  return {
    ...withRouteZoneIds(data),
    alternativeRoutes: data.alternativeRoutes.map(withRouteZoneIds),
  };
}

export async function getSlowZones(): Promise<SlowZonesResponse> {
  const response = await fetch(`${BACKEND_URL}/transit/slow-zones`);

  if (!response.ok) {
    throw new Error(`Slow zones request failed with status ${response.status}`);
  }

  return response.json() as Promise<SlowZonesResponse>;
}

export async function getAlerts(): Promise<AlertsResponse> {
  const response = await fetch(`${BACKEND_URL}/transit/alerts`);

  if (!response.ok) {
    throw new Error(`Alerts request failed with status ${response.status}`);
  }

  return response.json() as Promise<AlertsResponse>;
}

/** Active bus/streetcar DETOUR/MODIFIED_SERVICE/NO_SERVICE alerts, for the
 * live detours panel (see components/alerts/DetourPanel.tsx). */
export async function getDetours(): Promise<DetoursResponse> {
  const response = await fetch(`${BACKEND_URL}/api/detours`);

  if (!response.ok) {
    throw new Error(`Detours request failed with status ${response.status}`);
  }

  return response.json() as Promise<DetoursResponse>;
}

export async function getStreetcars(): Promise<SurfaceRoutesGeoJSON> {
  const response = await fetch(`${BACKEND_URL}/transit/surface/streetcars`);

  if (!response.ok) {
    throw new Error(`Streetcars request failed with status ${response.status}`);
  }

  return response.json() as Promise<SurfaceRoutesGeoJSON>;
}

/** The full daytime bus network (~150 routes) — a much larger payload than
 * streetcars/night buses, so callers should only fetch this once the rider
 * actually enables the "Day Buses" map layer, not on initial page load. */
export async function getDayBuses(): Promise<SurfaceRoutesGeoJSON> {
  const response = await fetch(`${BACKEND_URL}/transit/surface/day-buses`);

  if (!response.ok) {
    throw new Error(`Day buses request failed with status ${response.status}`);
  }

  return response.json() as Promise<SurfaceRoutesGeoJSON>;
}

export async function getNightBuses(): Promise<SurfaceRoutesGeoJSON> {
  const response = await fetch(`${BACKEND_URL}/transit/surface/night-buses`);

  if (!response.ok) {
    throw new Error(`Night buses request failed with status ${response.status}`);
  }

  return response.json() as Promise<SurfaceRoutesGeoJSON>;
}

export async function getSurfaceStops(): Promise<SurfaceStopsGeoJSON> {
  const response = await fetch(`${BACKEND_URL}/transit/surface/stops`);

  if (!response.ok) {
    throw new Error(`Surface stops request failed with status ${response.status}`);
  }

  return response.json() as Promise<SurfaceStopsGeoJSON>;
}
