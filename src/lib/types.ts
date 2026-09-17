export interface LatLon {
  lat: number;
  lon: number;
}

/** A station, geocoded address, or map-dropped pin picked as a commute
 * endpoint — carries exact coordinates for the backend's multi-modal router. */
export interface LocationSelection extends LatLon {
  name: string;
}

export type DepartureMode = "now" | "later";

export type Departure =
  | { mode: "now" }
  | { mode: "later"; date: string; time: string };

export interface CommuteRequest {
  from: string;
  destination: string;
  departure: Departure;
}

export interface CommuteStep {
  mode: "walk" | "streetcar" | "subway" | "bus";
  line?: string;
  description: string;
  durationMinutes: number;
}

export interface CommuteResult {
  totalDurationMinutes: number;
  distanceKm: number;
  steps: CommuteStep[];
}
