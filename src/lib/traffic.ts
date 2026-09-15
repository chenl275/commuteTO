import { BACKEND_URL } from "./constants";
import type {
  ActiveSlowZone,
  SlowZonesResponse,
  TransitCommuteRequest,
  TransitCommuteResponse,
} from "@/types/traffic";

type RawTransitCommuteResponse = Omit<TransitCommuteResponse, "activeSlowZones"> & {
  activeSlowZones: Omit<ActiveSlowZone, "id">[];
};

function withZoneIds(zones: Omit<ActiveSlowZone, "id">[]): ActiveSlowZone[] {
  return zones.map((zone, index) => ({
    ...zone,
    id: `${zone.line}-${zone.fromStationId ?? zone.fromStation}-${zone.toStationId ?? zone.toStation}-${index}`,
  }));
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
  return { ...data, activeSlowZones: withZoneIds(data.activeSlowZones) };
}

export async function getSlowZones(): Promise<SlowZonesResponse> {
  const response = await fetch(`${BACKEND_URL}/transit/slow-zones`);

  if (!response.ok) {
    throw new Error(`Slow zones request failed with status ${response.status}`);
  }

  return response.json() as Promise<SlowZonesResponse>;
}
