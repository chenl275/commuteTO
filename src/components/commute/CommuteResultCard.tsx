import { useState } from "react";
import { formatStationLabel } from "@/lib/stationDisplay";
import { findStationByName } from "@/lib/geo/subwayGeoJSON";
import type { AlertCategory, ItineraryLeg, RouteSummary, ServiceAlert, TransitCommuteResponse } from "@/types/traffic";

interface CommuteResultCardProps {
  result: TransitCommuteResponse;
  className?: string;
  /** Fired when the rider picks a different stacked route card — lets the
   * parent re-highlight the newly selected route on TTCMap. */
  onSelectRoute?: (route: RouteSummary) => void;
}

const DELAY_BADGE_STYLES = {
  none: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  delay: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
} as const;

/** "No Track Slowdown" only when there's truly nothing to report — any
 * nonzero delay (even a few seconds), whether observed live or
 * kinematically modeled, gets a precise "+X secs"/"+X mins" badge instead
 * of being rounded away. Labeled "Track Slowdown" (not just "Delay") so
 * it reads as distinct from the separate "Service Alert Delay" badge below. */
function formatDelayBadge(delaySeconds: number): { label: string; hasDelay: boolean } {
  if (delaySeconds <= 0) {
    return { label: "No Track Slowdown", hasDelay: false };
  }
  if (delaySeconds < 60) {
    const secs = Math.round(delaySeconds);
    return { label: `+${secs} sec${secs === 1 ? "" : "s"} Track Slowdown`, hasDelay: true };
  }
  const mins = Math.round(delaySeconds / 60);
  return { label: `+${mins} min${mins === 1 ? "" : "s"} Track Slowdown`, hasDelay: true };
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

function formatClockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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

/** e.g. "Line 1 Southbound to Union Station" (subway), "506 to Dundas West"
 * (streetcar/bus), or "Walk 117m to College Station". */
function formatItineraryLegHeadline(leg: ItineraryLeg): string {
  const destination = formatDestinationLabel(leg.toName);
  if (leg.mode === "walk") {
    const meters = leg.distanceMeters != null ? Math.round(leg.distanceMeters) : null;
    return `Walk${meters ? ` ${meters}m` : ""} to ${destination}`;
  }
  const routePrefix = leg.mode === "subway" ? `Line ${leg.routeShortName ?? ""}` : leg.routeShortName ?? "";
  const directionSuffix = leg.direction ? ` ${leg.direction}` : "";
  return `${routePrefix}${directionSuffix} to ${destination}`;
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
  const delayBadge = formatDelayBadge(route.slowZoneDelaySeconds);
  const isLiveTelemetry = route.telemetrySource === "gtfs_realtime";

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
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${
            isSelected
              ? "bg-red-600 text-white"
              : "bg-neutral-200 text-neutral-600 dark:bg-white/10 dark:text-white/60"
          }`}
        >
          {route.label === "Fastest" ? "⚡ Fastest" : "🔀 Alternative Route"}
        </span>
        <span className="text-xs font-bold text-neutral-700 dark:text-white/80">
          {route.label === "Fastest" ? formatMinutes(route.totalDurationMinutes) : `Alternative Route · ${formatMinutes(route.totalDurationMinutes)}`}
        </span>
      </div>

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

      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-white/50">
            Scheduled Time
          </p>
          <p className="text-lg font-bold text-neutral-900 dark:text-white">
            {formatMinutes(route.scheduledDurationMinutes)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-white/50">
            Estimated Travel Time
          </p>
          <p className="text-lg font-bold text-neutral-900 dark:text-white">
            {formatMinutes(route.totalDurationMinutes)}
          </p>
        </div>
      </div>

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
                    {formatItineraryLegHeadline(leg)}
                    {detail && (
                      <span className="font-normal text-neutral-500 dark:text-white/50"> · {detail}</span>
                    )}
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-right text-neutral-400 dark:text-white/40">
                    {formatMinutes(leg.durationMinutes)}
                  </span>
                </li>
              );
            })}
        </ol>
      ) : (
        <p className="mt-2 text-xs text-neutral-500 dark:text-white/50">
          Line {route.line} · {route.stationHops} stop{route.stationHops === 1 ? "" : "s"}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
            DELAY_BADGE_STYLES[delayBadge.hasDelay ? "delay" : "none"]
          }`}
        >
          {delayBadge.label}
        </span>
        {isLiveTelemetry && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
            title="This delay is from live train transponder data, not a modeled estimate."
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Live Telemetry
          </span>
        )}
        {route.alertDelayMinutes > 0 && (
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
              route.isDisrupted
                ? "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300"
                : "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
            }`}
          >
            +{formatMinutes(route.alertDelayMinutes)} Service Alert Delay
          </span>
        )}
        {route.detourDelayMinutes > 0 && (
          <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-700 dark:bg-red-500/15 dark:text-red-300">
            +{formatMinutes(route.detourDelayMinutes)} Detour Delay
          </span>
        )}
        {route.streetcarDelayMinutes > 0 && (
          <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
            +{formatMinutes(route.streetcarDelayMinutes)} Streetcar Delay
          </span>
        )}
        {route.busDelayMinutes > 0 && (
          <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
            +{formatMinutes(route.busDelayMinutes)} Traffic Delay
          </span>
        )}
        <p className="ml-auto text-xs text-neutral-500 dark:text-white/50">
          Arriving around{" "}
          {/* toLocaleTimeString formats in the viewer's local timezone, which
              can differ from wherever this was rendered — this card only ever
              mounts after a client-side fetch response (never during the
              initial SSR/hydration pass), but suppress defensively in case
              that ever changes (e.g. a future server-prefetched result). */}
          <span
            className="font-semibold text-neutral-800 dark:text-white"
            suppressHydrationWarning
          >
            {formatClockTime(route.arrivalTime)}
          </span>
        </p>
      </div>

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
