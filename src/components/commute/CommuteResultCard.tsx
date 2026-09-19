import { useState } from "react";
import { formatStationLabel } from "@/lib/stationDisplay";
import { findStationByName } from "@/lib/geo/subwayGeoJSON";
import LegArrivalTime from "@/components/itinerary/LegArrivalTime";
import type { AlertCategory, ItineraryLeg, RouteSummary, ServiceAlert, TransitCommuteResponse } from "@/types/traffic";

interface CommuteResultCardProps {
  result: TransitCommuteResponse;
  className?: string;
  /** Fired when the rider picks a different stacked route card — lets the
   * parent re-highlight the newly selected route on TTCMap. */
  onSelectRoute?: (route: RouteSummary) => void;
}

// Upcoming (not-yet-active) notices sort last regardless of category; among
// active alerts, closures sort first (most severe/impassable), then active
// incidents, then informational maintenance notices.
const ALERT_SEVERITY_ORDER: Record<AlertCategory, number> = { closure: 0, delay: 1, maintenance: 2 };

const ALERT_BANNER_STYLES: Record<AlertCategory, string> = {
  closure:
    "border-red-300 bg-red-50 text-red-900 dark:border-red-400/30 dark:bg-red-500/15 dark:text-red-100",
  delay:
    "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/15 dark:text-amber-100",
  maintenance:
    "border-amber-200 bg-amber-50/70 text-amber-800 dark:border-amber-400/15 dark:bg-amber-500/10 dark:text-amber-200/90",
};

const UPCOMING_NOTICE_BANNER_STYLE =
  "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-400/20 dark:bg-sky-500/10 dark:text-sky-100";

const ALERT_LABELS: Record<AlertCategory, string> = {
  closure: "⚠️ Service Disruption",
  delay: "⚠️ Delay Alert",
  maintenance: "ℹ️ Maintenance",
};

function getAlertBannerStyle(alert: ServiceAlert): string {
  return alert.isUpcomingNotice ? UPCOMING_NOTICE_BANNER_STYLE : ALERT_BANNER_STYLES[alert.category];
}

function getAlertLabel(alert: ServiceAlert): string {
  return alert.isUpcomingNotice ? "ℹ️ Upcoming" : ALERT_LABELS[alert.category];
}

function sortAlertsBySeverity(alerts: ServiceAlert[]): ServiceAlert[] {
  return [...alerts].sort((a, b) => {
    if (a.isUpcomingNotice !== b.isUpcomingNotice) return a.isUpcomingNotice ? 1 : -1;
    return ALERT_SEVERITY_ORDER[a.category] - ALERT_SEVERITY_ORDER[b.category];
  });
}

// The backend already dedupes upcomingDetourNotices, but
// activeAlertsOnRoute's upcoming entries are a separate source, and the two
// can independently describe the same real closure — so this collapses
// both into one deduplicated list for a single combined display.

function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeText(items: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const item of items) {
    const key = normalizeForDedup(item);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function formatMinutes(minutes: number): string {
  const rounded = Math.round(minutes);
  return `${rounded} min${rounded === 1 ? "" : "s"}`;
}

/** "1 hr 46 min" / "46 min" — the large primary ETA figure in the
 * consolidated route header, spelled out since it's the single most
 * prominent number on the card. */
function formatDurationLong(minutes: number): string {
  const total = Math.round(minutes);
  const hrs = Math.floor(total / 60);
  const mins = total % 60;
  if (hrs <= 0) return `${mins} min${mins === 1 ? "" : "s"}`;
  return mins > 0 ? `${hrs} hr ${mins} min` : `${hrs} hr`;
}

/** "1h 45m" / "45m" — compact form for the header's muted metadata subline
 * (e.g. "Scheduled 1h 45m", "+1m delay") and the delay-summary bar's
 * breakdown clause, where the long spelled-out form would be too noisy. */
function formatDurationCompact(minutes: number): string {
  const total = Math.round(minutes);
  const hrs = Math.floor(total / 60);
  const mins = total % 60;
  if (hrs <= 0) return `${mins}m`;
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
}

function formatClockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

interface DelaySummary {
  totalMinutes: number;
  parts: string[];
}

/** Consolidates every delay source on a route into one honest total plus a
 * breakdown clause — e.g. "+21 mins delay · 11m track slowdown, 10m
 * streetcar congestion" — instead of the separate stacked minute-badges this
 * replaces. `totalMinutes` is always `totalDurationMinutes -
 * scheduledDurationMinutes` (the same delta the header's own ETA is built
 * from, so the two numbers never disagree), not a re-sum of the parts below.
 *
 * `slowZoneDelayMinutes` doubles as "total delay across every leg" for a
 * multi-modal itinerary (subway + surface combined — see router.py's
 * _augment_with_live_delays) and as a genuinely subway-only "track slowdown"
 * figure on the subway-only fast path, where streetcar/bus delay is always
 * 0. Subtracting out the known streetcar/bus subsets isolates the real
 * track/kinematic portion in both cases without double-counting (and is a
 * no-op on the subway-only path, where there's nothing to subtract). */
function buildDelaySummary(route: RouteSummary): DelaySummary {
  const totalMinutes = Math.max(0, route.totalDurationMinutes - route.scheduledDurationMinutes);
  const trackSlowdownMinutes = Math.max(
    0,
    route.slowZoneDelayMinutes - route.streetcarDelayMinutes - route.busDelayMinutes
  );
  const parts: string[] = [];
  if (Math.round(trackSlowdownMinutes) > 0) {
    parts.push(`${formatDurationCompact(trackSlowdownMinutes)} track slowdown`);
  }
  if (Math.round(route.streetcarDelayMinutes) > 0) {
    parts.push(`${formatDurationCompact(route.streetcarDelayMinutes)} streetcar congestion`);
  }
  if (Math.round(route.busDelayMinutes) > 0) {
    parts.push(`${formatDurationCompact(route.busDelayMinutes)} traffic delay`);
  }
  if (Math.round(route.alertDelayMinutes) > 0) {
    parts.push(`${formatDurationCompact(route.alertDelayMinutes)} service alert`);
  }
  if (Math.round(route.detourDelayMinutes) > 0) {
    parts.push(`${formatDurationCompact(route.detourDelayMinutes)} detour delay`);
  }
  return { totalMinutes: Math.round(totalMinutes), parts };
}

// Populated by the backend's multi-modal (walk + bus + streetcar + subway)
// router fallback — see router.py — for a trip the subway-only fast path
// can't handle (e.g. a cross-line or off-subway-network origin/destination).
const ITINERARY_MODE_ICONS: Record<ItineraryLeg["mode"], string> = {
  walk: "🚶",
  bus: "🚌",
  streetcar: "🚋",
  subway: "🚇",
};

/** Appends "Station" only when `name` actually names one (a subway leg's
 * stations are already canonical — see traffic_service.py's name cleanup —
 * and a walk leg can legitimately end at one too, e.g. "Walk to Don Mills"
 * right before boarding) — a streetcar/bus leg's endpoint, or the rider's
 * own address/landmark, is just as often a plain street stop ("Spadina Ave
 * at Willcocks St") or a business name ("McDonald's"), which "Station"
 * would wrongly imply is a subway/rail stop. */
function formatDestinationLabel(name: string): string {
  return findStationByName(name) ? formatStationLabel(name) : name;
}

/** e.g. "Line 1 Southbound to Union Station" (subway), "Northbound to
 * Dundas West" (streetcar/bus — its route number renders as its own badge,
 * see RouteNumberBadge, rather than inlined here), or "Walk 117m to College
 * Station". */
function formatItineraryLegHeadline(leg: ItineraryLeg): string {
  const destination = formatDestinationLabel(leg.toName);
  if (leg.mode === "walk") {
    const meters = leg.distanceMeters != null ? Math.round(leg.distanceMeters) : null;
    return `Walk${meters ? ` ${meters}m` : ""} to ${destination}`;
  }
  if (leg.mode === "subway") {
    const directionSuffix = leg.direction ? ` ${leg.direction}` : "";
    return `Line ${leg.routeShortName ?? ""}${directionSuffix} to ${destination}`;
  }
  const directionPrefix = leg.direction ? `${leg.direction} ` : "";
  return `${directionPrefix}to ${destination}`;
}

// TTC's own numbering for a peak/all-day "Express" service (e.g. 929
// Dufferin Express, 939 Finch Express) — see backend/scripts/
// ingest_surface_gtfs.py's identical DAY_BUS_RANGE/NIGHT_BUS_RANGE split,
// which this 900+ convention sits above.
function isExpressRoute(routeShortName: string | null): boolean {
  const numeric = Number(routeShortName);
  return routeShortName !== null && !Number.isNaN(numeric) && numeric >= 900;
}

/** A bus/streetcar leg's route number as its own small badge — separated
 * out from the headline text (see formatItineraryLegHeadline) so a 900+
 * express route can render in TTC's own express green rather than being
 * just another word in the sentence. */
function RouteNumberBadge({ leg }: { leg: ItineraryLeg }) {
  if ((leg.mode !== "bus" && leg.mode !== "streetcar") || !leg.routeShortName) return null;
  return (
    <span
      className={`mr-1.5 inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold text-white ${
        isExpressRoute(leg.routeShortName) ? "bg-[#00853F]" : "bg-neutral-600 dark:bg-white/20"
      }`}
    >
      {leg.routeShortName}
    </span>
  );
}

/** e.g. "4 stops" — the muted trailing detail joined onto the headline with
 * a middle dot; null for a walk leg, which has nothing more to add. */
function formatItineraryLegDetail(leg: ItineraryLeg): string | null {
  if (leg.mode === "walk") return null;
  return `${leg.stopCount} stop${leg.stopCount === 1 ? "" : "s"}`;
}

// A walk leg strictly between two transit legs is almost always just
// crossing the street or platform to the next stop — real transfer noise,
// not a turn-by-turn direction worth its own line (e.g. "Walk 40m to
// Sheppard Ave West"). The backend already drops the truly trivial walks
// bracketing the origin/destination itself (see traffic_service.py's
// MICRO_WALK_SUPPRESSION_METERS) — this catches the ones in between that it
// deliberately leaves alone, since a real street-level transfer can still
// matter. The very first and last legs always show regardless of size,
// since those describe how the rider actually reaches/leaves the transit
// network, not a same-stop shuffle.
const MID_TRIP_WALK_MIN_MINUTES = 3;
const MID_TRIP_WALK_MIN_METERS = 250;

function isDisplayedLeg(leg: ItineraryLeg, index: number, legs: ItineraryLeg[]): boolean {
  if (leg.mode !== "walk") return true;
  if (index === 0 || index === legs.length - 1) return true;
  return leg.durationMinutes > MID_TRIP_WALK_MIN_MINUTES || (leg.distanceMeters ?? 0) > MID_TRIP_WALK_MIN_METERS;
}

interface RouteCardProps {
  route: RouteSummary;
  isSelected: boolean;
  onSelect: () => void;
}

/** One stacked route option — the primary/fastest result, or one of
 * result.alternativeRoutes. Selecting a non-active card re-highlights that
 * route's path on TTCMap (see CommuteResultCard's onSelectRoute). */
function RouteCard({ route, isSelected, onSelect }: RouteCardProps) {
  const isLiveTelemetry = route.telemetrySource === "gtfs_realtime";
  const delaySummary = buildDelaySummary(route);
  const isDelayed = delaySummary.totalMinutes > 0;

  // Split activeAlertsOnRoute so its "upcoming" entries join the one
  // combined, collapsible Upcoming Notices section below instead of a
  // second always-expanded block duplicating the same sky-blue treatment.
  const activeAlerts = route.activeAlertsOnRoute.filter((alert) => !alert.isUpcomingNotice);
  const upcomingAlertNotices = route.activeAlertsOnRoute
    .filter((alert) => alert.isUpcomingNotice)
    .map((alert) => `ℹ️ Upcoming: ${alert.headline}`);
  const upcomingNotices = dedupeText([...upcomingAlertNotices, ...route.upcomingDetourNotices]);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isSelected}
      className={`block w-full rounded-2xl border p-4 text-left transition-colors ${
        isSelected
          ? "border-red-500 bg-white ring-2 ring-red-500/50 dark:border-red-400 dark:bg-neutral-900 dark:ring-red-400/40"
          : "border-neutral-200 bg-neutral-50 hover:border-neutral-300 dark:border-white/10 dark:bg-white/5 dark:hover:border-white/20"
      }`}
    >
      <div className="mb-1 flex items-start justify-between gap-3">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${
            route.label === "Fastest"
              ? "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300"
              : "bg-neutral-200 text-neutral-600 dark:bg-white/10 dark:text-white/60"
          }`}
        >
          {route.label === "Fastest" ? "Fastest" : "Alternative"}
        </span>
        <span className="text-2xl font-bold leading-none text-neutral-900 dark:text-white">
          {formatDurationLong(route.totalDurationMinutes)}
        </span>
      </div>
      <p className="mb-2.5 text-xs text-neutral-500 dark:text-white/50">
        Arrives{" "}
        <span className="font-medium text-neutral-700 dark:text-white/70" suppressHydrationWarning>
          {formatClockTime(route.arrivalTime)}
        </span>
        {" · Scheduled "}
        {formatDurationCompact(route.scheduledDurationMinutes)}
        {" · "}
        {isDelayed ? (
          <span className="font-semibold text-amber-700 dark:text-amber-400">
            +{formatDurationCompact(delaySummary.totalMinutes)} delay
          </span>
        ) : (
          <span className="font-semibold text-emerald-700 dark:text-emerald-400">On schedule</span>
        )}
      </p>

      {activeAlerts.length > 0 && (
        <div className="mb-3 flex flex-col gap-2">
          {sortAlertsBySeverity(activeAlerts).map((alert) => (
            <div
              key={alert.id}
              className={`rounded-xl border px-3 py-2 text-xs font-medium ${getAlertBannerStyle(alert)}`}
            >
              <span className="font-bold">{getAlertLabel(alert)}:</span> {alert.headline}
            </div>
          ))}
        </div>
      )}

      {route.detourWarnings.length > 0 && (
        <div className="mb-3 flex flex-col gap-2">
          {route.detourWarnings.map((warning) => (
            <div
              key={warning}
              className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-xs font-medium text-red-900 dark:border-red-400/30 dark:bg-red-500/15 dark:text-red-100"
            >
              {warning}
            </div>
          ))}
          {route.alternateRoute && (
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900 dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-100">
              🔁 {route.alternateRoute}
            </div>
          )}
        </div>
      )}

      {upcomingNotices.length > 0 && (
        <details className="group mb-3">
          <summary className="cursor-pointer list-none text-xs font-semibold text-sky-700 marker:content-none dark:text-sky-300">
            ℹ️ Upcoming Notices ({upcomingNotices.length})
            <span className="ml-1 inline-block transition-transform group-open:rotate-180">▾</span>
          </summary>
          <div className="mt-2 flex max-h-60 flex-col gap-2 overflow-y-auto">
            {upcomingNotices.map((notice) => (
              <div
                key={notice}
                className={`rounded-xl border px-3 py-2 text-xs font-medium ${UPCOMING_NOTICE_BANNER_STYLE}`}
              >
                {notice}
              </div>
            ))}
          </div>
        </details>
      )}

      {route.itinerary.length > 0 ? (
        <ol className="mt-2 flex flex-col divide-y divide-neutral-200/70 dark:divide-white/10">
          {route.itinerary
            .filter((leg, index, legs) => isDisplayedLeg(leg, index, legs))
            .map((leg, index) => {
              const detail = formatItineraryLegDetail(leg);
              return (
                <li key={index} className="flex items-start gap-2 py-2 text-xs first:pt-0 last:pb-0">
                  <span
                    aria-hidden="true"
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-[11px] dark:bg-white/10"
                  >
                    {ITINERARY_MODE_ICONS[leg.mode]}
                  </span>
                  {/* min-w-0 lets this cell wrap onto a second line instead of
                      forcing an ellipsis when the line is long (e.g. "Line 1
                      Southbound to Vaughan Metropolitan Centre Station"). */}
                  <span className="min-w-0 flex-1 font-semibold leading-snug break-words text-neutral-800 dark:text-white/90">
                    <RouteNumberBadge leg={leg} />
                    {formatItineraryLegHeadline(leg)}
                    {detail && (
                      <span className="font-normal text-neutral-500 dark:text-white/50"> · {detail}</span>
                    )}
                  </span>
                  <div className="shrink-0 text-right text-neutral-400 dark:text-white/40">
                    {leg.mode === "bus" || leg.mode === "streetcar" ? (
                      <LegArrivalTime leg={leg} />
                    ) : (
                      <span className="whitespace-nowrap">{formatMinutes(leg.durationMinutes)}</span>
                    )}
                  </div>
                </li>
              );
            })}
        </ol>
      ) : (
        <p className="mt-2 text-xs text-neutral-500 dark:text-white/50">
          Line {route.line} · {route.stationHops} stop{route.stationHops === 1 ? "" : "s"}
        </p>
      )}

      {(isDelayed || isLiveTelemetry) && (
        <div className="mt-3 flex flex-col gap-2">
          {isDelayed && (
            <div className="flex items-center gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 dark:border-amber-400/25 dark:bg-amber-500/10 dark:text-amber-100">
              <span aria-hidden="true">⚠️</span>
              <span>
                <span className="font-semibold">+{formatMinutes(delaySummary.totalMinutes)} delay</span>
                {delaySummary.parts.length > 0 && (
                  <span className="text-amber-800/80 dark:text-amber-200/70"> · {delaySummary.parts.join(", ")}</span>
                )}
              </span>
            </div>
          )}
          {isLiveTelemetry && (
            <span
              className="inline-flex w-fit items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
              title="This delay is from live train transponder data, not a modeled estimate."
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live Telemetry
            </span>
          )}
        </div>
      )}

      {route.activeSlowZones.length > 0 && (
        <details className="group mt-3">
          <summary className="cursor-pointer list-none text-xs font-semibold text-red-600 marker:content-none dark:text-red-400">
            {route.activeSlowZones.length} active slow zone
            {route.activeSlowZones.length === 1 ? "" : "s"} on this route
            <span className="ml-1 inline-block transition-transform group-open:rotate-180">▾</span>
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {route.activeSlowZones.map((zone) => (
              <li
                key={zone.id}
                className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-200"
              >
                <p className="font-semibold">
                  Line {zone.line} {zone.direction}: Reduced to {zone.reducedSpeedKmh} km/h between{" "}
                  {formatStationLabel(zone.fromStation)} and {formatStationLabel(zone.toStation)}
                </p>
                <p className="mt-0.5 text-amber-800/80 dark:text-amber-200/70">{zone.reason}</p>
              </li>
            ))}
          </ul>
        </details>
      )}

      {route.source === "fallback" && (
        <p className="mt-3 text-[11px] text-neutral-400 dark:text-white/30">
          Live TTC slow zone data is unavailable — showing a fallback estimate.
        </p>
      )}
    </button>
  );
}

export default function CommuteResultCard({ result, className = "", onSelectRoute }: CommuteResultCardProps) {
  const routes: RouteSummary[] = [result, ...result.alternativeRoutes];
  const [selectedIndex, setSelectedIndex] = useState(0);

  // A brand-new commute result (a fresh search) should always start back on
  // the fastest option, not whichever card happened to be selected for the
  // previous query — adjusted during render (React's recommended pattern for
  // "derive state from a prop change") rather than in an effect, since it
  // only needs to run once per actual result change.
  const [lastSyncedResult, setLastSyncedResult] = useState(result);
  if (result !== lastSyncedResult) {
    setLastSyncedResult(result);
    setSelectedIndex(0);
  }

  function handleSelect(index: number) {
    if (index === selectedIndex) return;
    setSelectedIndex(index);
    onSelectRoute?.(routes[index]);
  }

  return (
    <div className={`max-h-[60vh] overflow-y-auto space-y-4 pr-1 ${className}`}>
      {routes.map((route, index) => (
        <RouteCard key={index} route={route} isSelected={index === selectedIndex} onSelect={() => handleSelect(index)} />
      ))}
    </div>
  );
}
