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

export type DetourEffect = "DETOUR" | "MODIFIED_SERVICE" | "NO_SERVICE";

/** One stop an active detour names as closed/bypassed, resolved to real
 * coordinates server-side — a streetcar/bus stop has no equivalent in our
 * subway station-id registry, so this carries its own lat/lon directly. */
export interface DetourStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

/** One active bus/streetcar detour/disruption from GET /api/detours — see
 * backend/app/services/detour_service.py's get_active_surface_detours. */
export interface DetourSummary {
  id: string;
  routeId: string | null;
  routeShortName: string | null;
  routeIds: string[];
  header: string;
  description: string;
  summary: string;
  effect: DetourEffect;
  /** Raw GTFS stop_ids the alert names as closed/bypassed — not run through
   * our subway station-id registry, since these are surface (streetcar/bus)
   * stops with no equivalent mapping. */
  affectedStopIds: string[];
  /** Same stops, resolved to name/lat/lon for placing a map marker — a
   * subset of affectedStopIds when the backend's routing DB doesn't have a
   * matching row for one. */
  affectedStops: DetourStop[];
}

export interface DetoursResponse {
  detours: DetourSummary[];
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
  /** The original static-schedule times, before any live/kinematic delay
   * shift — departureTime/arrivalTime above reflect the best available
   * estimate (live-adjusted when isLive is true), so these are what a "was
   * X, now Y" strikethrough display diffs against for a delayed leg. */
  scheduledDepartureTime: string;
  scheduledArrivalTime: string;
  /** True when departureTime/arrivalTime reflect an actual live GTFS-RT
   * TripUpdates reading for this specific leg, rather than the static
   * schedule or a flat detour-penalty estimate. Only ever true for a
   * bus/streetcar leg departing within router.py's 45-minute live-ETA
   * horizon (see LIVE_ETA_HORIZON_MINUTES). */
  isLive: boolean;
  /** True when this leg's departure was soon enough that a live reading was
   * attempted, but the live feed itself had gone stale/unreachable (a
   * system-wide "ghost bus") — the schedule is kept as the best available
   * time, but flagged distinctly from a route that simply has no live
   * vehicle tracked right now, so the UI can show "Scheduled (Tracking
   * Unavailable)" instead of a plain "Scheduled" badge. */
  trackingUnavailable: boolean;
  /** This leg's own delay in seconds (live or kinematic) — 0 for an
   * on-time or non-surface leg. */
  delaySeconds: number;
  /** [lon, lat] pairs in travel order — a straight line for a walk leg, the
   * actual boarded-to-alighted stop sequence for a transit leg. */
  path: Coordinates[];
}

/** Everything needed to render and highlight one route option — shared by
 * TransitCommuteResponse's own top-level fields (the primary/fastest route)
 * and each entry in its alternativeRoutes, so a stacked route card can
 * render either one identically. */
export interface RouteSummary {
  /** "Fastest" for the primary route, "Alternative" for anything in
   * alternativeRoutes — see traffic_service.py's multi-route search. */
  label: string;
  origin: string;
  destination: string;
  line: number;
  stationHops: number;
  scheduledDurationMinutes: number;
  slowZoneDelayMinutes: number;
  slowZoneDelaySeconds: number;
  /** Whether slowZoneDelay* came from live train transponder data or the kinematic fallback model. */
  telemetrySource: TelemetrySource;
  /** Live-observed (GTFS-RT TripUpdates) or, absent that, detour-estimated
   * delay on a streetcar/bus leg of this route. A subset of
   * slowZoneDelay* above (already reflected in totalDurationMinutes),
   * broken out so the UI can badge it distinctly ("Streetcar Delay"/
   * "Traffic Delay") instead of folding it into the subway-oriented "Track
   * Slowdown" badge. 0 for the subway-only fast path, or when no surface
   * leg is delayed. */
  streetcarDelayMinutes: number;
  busDelayMinutes: number;
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

export interface TransitCommuteResponse extends RouteSummary {
  /** Up to one genuinely different, real alternative route (see router.py's
   * find_itineraries) — empty when no competitive alternative exists, or
   * for the subway-only fast path, which doesn't search for one. */
  alternativeRoutes: RouteSummary[];
}
