export type Coordinates = [number, number];

export interface TransitCommuteRequest {
  origin: string | Coordinates;
  destination: string | Coordinates;
  /** ISO 8601 timestamp; omit for "leave now". */
  departureTime?: string;
}

export type TransitSource = "live" | "fallback";

/** Properties on each LineString feature in the streetcar/night-bus GeoJSON
 * layers served by GET /transit/surface/streetcars and /night-buses. */
export interface SurfaceRouteProperties {
  routeId: string;
  routeShortName: string;
  routeLongName: string;
  direction: number;
  colorHex: string;
}

export type SurfaceRoutesGeoJSON = GeoJSON.FeatureCollection<
  GeoJSON.LineString,
  SurfaceRouteProperties
>;

/** Properties on each Point feature in the surface-stops GeoJSON layer
 * served by GET /transit/surface/stops. */
export interface SurfaceStopProperties {
  id: string;
  name: string;
  networks: Array<"streetcar" | "night_bus">;
  /** Route short names serving this stop, e.g. ["501", "504"]. */
  routes: string[];
  isInterchange: boolean;
  interchangeStationId: string | null;
}

export type SurfaceStopsGeoJSON = GeoJSON.FeatureCollection<
  GeoJSON.Point,
  SurfaceStopProperties
>;

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
  /** True for a broad terminus-to-terminus status update (e.g. "delays
   * between Vaughan and Finch") rather than a pinpointed incident — the
   * backend exempts/caps the delay penalty for these, see traffic_service.py. */
  isAdvisory: boolean;
}

export interface AlertsResponse {
  alerts: ServiceAlert[];
  lastUpdated: string | null;
  source: TransitSource;
}

export type TelemetrySource = "gtfs_realtime" | "kinematic_model";

/** One leg of a (possibly multi-modal) trip, e.g. a subway ride plus a
 * streetcar connection at either end, or a Blue Night bus overnight. */
export interface CommuteStep {
  mode: "subway" | "streetcar" | "bus";
  routeNumber: string;
  stopCount: number;
}

export interface TransitCommuteResponse {
  origin: string;
  destination: string;
  line: number;
  stationHops: number;
  scheduledDurationMinutes: number;
  slowZoneDelayMinutes: number;
  slowZoneDelaySeconds: number;
  /** Whether slowZoneDelay* came from live train transponder data or the kinematic fallback model. */
  telemetrySource: TelemetrySource;
  alertDelayMinutes: number;
  totalDurationMinutes: number;
  activeSlowZones: ActiveSlowZone[];
  isDisrupted: boolean;
  activeAlertsOnRoute: ServiceAlert[];
  steps: CommuteStep[];
  departureTime: string;
  arrivalTime: string;
  source: TransitSource;
}
