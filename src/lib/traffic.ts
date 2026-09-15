import { BACKEND_URL } from "./constants";
import type { TrafficRequest, TrafficResponse } from "@/types/traffic";

export async function getTrafficEstimate(request: TrafficRequest): Promise<TrafficResponse> {
  const response = await fetch(`${BACKEND_URL}/traffic`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Traffic request failed with status ${response.status}`);
  }

  return response.json() as Promise<TrafficResponse>;
}
