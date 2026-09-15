import { formatStationLabel } from "@/lib/stationDisplay";
import type { AlertCategory, ServiceAlert, TransitCommuteResponse } from "@/types/traffic";

interface CommuteResultCardProps {
  result: TransitCommuteResponse;
  className?: string;
}

const SLOW_ZONE_BADGE_STYLES = {
  none: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  delay: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
} as const;

/** "No Slow Zone Delay" only when there's truly nothing to report — any
 * nonzero delay (even a few seconds) gets a precise "+X secs"/"+X mins" badge. */
function formatSlowZoneDelay(
  zoneCount: number,
  delaySeconds: number
): { label: string; hasDelay: boolean } {
  if (zoneCount === 0 || delaySeconds <= 0) {
    return { label: "No Slow Zone Delay", hasDelay: false };
  }
  if (delaySeconds < 60) {
    const secs = Math.round(delaySeconds);
    return { label: `+${secs} sec${secs === 1 ? "" : "s"} Slow Zone Delay`, hasDelay: true };
  }
  const mins = Math.round(delaySeconds / 60);
  return { label: `+${mins} min${mins === 1 ? "" : "s"} Slow Zone Delay`, hasDelay: true };
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

function formatMinutes(minutes: number): string {
  const rounded = Math.round(minutes);
  return `${rounded} min${rounded === 1 ? "" : "s"}`;
}

function formatClockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function CommuteResultCard({ result, className = "" }: CommuteResultCardProps) {
  const slowZoneDelay = formatSlowZoneDelay(result.activeSlowZones.length, result.slowZoneDelaySeconds);

  return (
    <div
      className={`rounded-2xl border border-neutral-200 bg-neutral-50 p-4 dark:border-white/10 dark:bg-white/5 ${className}`}
    >
      {result.activeAlertsOnRoute.length > 0 && (
        <div className="mb-3 flex flex-col gap-2">
          {sortAlertsBySeverity(result.activeAlertsOnRoute).map((alert) => (
            <div
              key={alert.id}
              className={`rounded-xl border px-3 py-2 text-xs font-medium ${getAlertBannerStyle(alert)}`}
            >
              <span className="font-bold">{getAlertLabel(alert)}:</span> {alert.headline}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-white/50">
            Scheduled Time
          </p>
          <p className="text-lg font-bold text-neutral-900 dark:text-white">
            {formatMinutes(result.scheduledDurationMinutes)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-white/50">
            Estimated Travel Time
          </p>
          <p className="text-lg font-bold text-neutral-900 dark:text-white">
            {formatMinutes(result.totalDurationMinutes)}
          </p>
        </div>
      </div>

      <p className="mt-2 text-xs text-neutral-500 dark:text-white/50">
        Line {result.line} · {result.stationHops} stop{result.stationHops === 1 ? "" : "s"}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
            SLOW_ZONE_BADGE_STYLES[slowZoneDelay.hasDelay ? "delay" : "none"]
          }`}
        >
          {slowZoneDelay.label}
        </span>
        {result.alertDelayMinutes > 0 && (
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
              result.isDisrupted
                ? "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300"
                : "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
            }`}
          >
            +{formatMinutes(result.alertDelayMinutes)} Service Alert Delay
          </span>
        )}
        <p className="ml-auto text-xs text-neutral-500 dark:text-white/50">
          Arriving around{" "}
          <span className="font-semibold text-neutral-800 dark:text-white">
            {formatClockTime(result.arrivalTime)}
          </span>
        </p>
      </div>

      {result.activeSlowZones.length > 0 && (
        <details className="group mt-3">
          <summary className="cursor-pointer list-none text-xs font-semibold text-red-600 marker:content-none dark:text-red-400">
            {result.activeSlowZones.length} active slow zone
            {result.activeSlowZones.length === 1 ? "" : "s"} on this route
            <span className="ml-1 inline-block transition-transform group-open:rotate-180">▾</span>
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {result.activeSlowZones.map((zone) => (
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

      {result.source === "fallback" && (
        <p className="mt-3 text-[11px] text-neutral-400 dark:text-white/30">
          Live TTC slow zone data is unavailable — showing a fallback estimate.
        </p>
      )}
    </div>
  );
}
