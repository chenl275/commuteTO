export type Coordinates = [number, number];

export interface TransitCommuteRequest {
  /** Rider-facing display text — a station name, a geocoded address, or a
   * map-dropped pin's reverse-geocoded label. Always echoed back verbatim
   * on the response when coordinates are also supplied. */
  origin: string;
  destination: string;
  /** Exact coordinates for a geocoded address or a map-dropped pin — set
   * together with the matching lon field so the backend can route from that
   * precise point (via its multi-modal walk+transit router) instead of
   * snapping straight to a named station. Omit both for a plain station-name lookup. */
  originLat?: number;
  originLon?: number;
  destLat?: number;
  destLon?: number;
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

/** One leg of a router.py multi-modal itinerary — either a walk (origin to
 * the first stop, a transfer, or the last stop to the destination) or a
 * scheduled transit ride, in the order the rider actually travels them. */
export interface ItineraryLeg {
  mode: "walk" | "bus" | "streetcar" | "subway";
  routeShortName: string | null;
  routeLongName: string | null;
  /** Rider-facing compass direction ("Southbound", ...), read off this
   * leg's boarding stop — null for a walk leg, or a transit leg boarding
   * where GTFS has no directional platform label. */
  direction: string | null;
  fromName: string;
  toName: string;
  stopCount: number;
  distanceMeters: number | null;
  durationMinutes: number;
  departureTime: string;
  arrivalTime: string;
  /** [lon, lat] pairs in travel order — a straight line for a walk leg, the
   * actual boarded-to-alighted stop sequence for a transit leg. */
  path: Coordinates[];
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
  /** Added ETA penalty from active GTFS-RT detour/construction/shuttle alerts on this trip's routes. */
  detourDelayMinutes: number;
  /** Rider-facing "⚠️ Detour active on [Route]: [Summary]" lines, one per active detour notice. */
  detourWarnings: string[];
  /** Future or day/time-scoped detour notices that don't apply right now (e.g. a "this weekend" or nightly closure outside its window) — informational only, never penalized or shown as an active badge. */
  upcomingDetourNotices: string[];
  /** A parallel corridor without an active detour, e.g. "Alternate Route (Detour Avoidance): 320 Yonge" — null when there's no detour to avoid, or no mapped alternative. */
  alternateRoute: string | null;
  totalDurationMinutes: number;
  activeSlowZones: ActiveSlowZone[];
  isDisrupted: boolean;
  activeAlertsOnRoute: ServiceAlert[];
  steps: CommuteStep[];
  /** Populated by the backend's multi-modal router fallback — empty for the
   * subway-only fast path, which `steps` + the map's route highlight already cover. */
  itinerary: ItineraryLeg[];
  departureTime: string;
  arrivalTime: string;
  source: TransitSource;
}
