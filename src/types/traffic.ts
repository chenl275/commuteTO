export type Coordinates = [number, number];

export interface TrafficRequest {
  origin: string | Coordinates;
  destination: string | Coordinates;
  /** ISO 8601 timestamp; omit for "leave now". */
  departureTime?: string;
}

export type TrafficSource = "google_maps" | "simulated";

export interface TrafficResponse {
  origin: string;
  destination: string;
  distanceMeters: number;
  distanceText: string;
  durationSeconds: number;
  durationText: string;
  durationInTrafficSeconds: number;
  durationInTrafficText: string;
  trafficDelayMinutes: number;
  departureTime: string;
  arrivalTime: string;
  source: TrafficSource;
}
