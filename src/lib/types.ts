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
