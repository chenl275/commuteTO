export type Coordinates = [number, number];

export interface TransitCommuteRequest {
  origin: string | Coordinates;
  destination: string | Coordinates;
  /** ISO 8601 timestamp; omit for "leave now". */
  departureTime?: string;
}

export type TransitSource = "live" | "fallback";

/**
 * A TTC-reported reduced speed zone affecting one direction of travel
 * between two adjacent stations.
 */
export interface ActiveSlowZone {
  /** Stable key for lists/map features — derived client-side, not sent by the API. */
  id: string;
  line: number;
  direction: string;
  fromStation: string;
  toStation: string;
  fromStationId: string | null;
  toStationId: string | null;
  defectLengthMeters: number;
  reducedSpeedKmh: number;
  normalSpeedKmh: number;
  reason: string;
  targetRemoval: string;
  delaySeconds: number;
}

export interface SlowZonesResponse {
  slowZones: Omit<ActiveSlowZone, "id">[];
  lastUpdated: string | null;
  source: TransitSource;
}

export type AlertCategory = "closure" | "delay" | "maintenance";

/** A live TTC service alert (closure, incident delay, or maintenance) affecting a subway line. */
export interface ServiceAlert {
  id: string;
  line: number;
  category: AlertCategory;
  headline: string;
  description: string;
  direction: string;
  fromStation: string;
  toStation: string;
  affectedStationIds: string[];
  shuttleService: boolean;
  postedAt: string | null;
  activeUntil: string | null;
  /** True when a recognized nightly-closure alert doesn't apply to the
   * current/requested travel time — an informational notice, not an active disruption. */
  isUpcomingNotice: boolean;
}

export interface AlertsResponse {
  alerts: ServiceAlert[];
  lastUpdated: string | null;
  source: TransitSource;
}

export interface TransitCommuteResponse {
  origin: string;
  destination: string;
  line: number;
  stationHops: number;
  scheduledDurationMinutes: number;
  slowZoneDelayMinutes: number;
  slowZoneDelaySeconds: number;
  alertDelayMinutes: number;
  totalDurationMinutes: number;
  activeSlowZones: ActiveSlowZone[];
  isDisrupted: boolean;
  activeAlertsOnRoute: ServiceAlert[];
  departureTime: string;
  arrivalTime: string;
  source: TransitSource;
}
