import { formatStationLabel } from "@/lib/stationDisplay";
import type { TransitCommuteResponse } from "@/types/traffic";

interface CommuteResultCardProps {
  result: TransitCommuteResponse;
  className?: string;
}

type DelaySeverity = "none" | "low" | "moderate" | "severe";

function getDelaySeverity(minutes: number): DelaySeverity {
  if (minutes < 0.5) return "none";
  if (minutes < 3) return "low";
  if (minutes < 8) return "moderate";
  return "severe";
}

const DELAY_BADGE_STYLES: Record<DelaySeverity, string> = {
  none: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  low: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  moderate: "bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300",
  severe: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

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
  const severity = getDelaySeverity(result.slowZoneDelayMinutes);
  const hasDelay = severity !== "none";

  return (
    <div
      className={`rounded-2xl border border-neutral-200 bg-neutral-50 p-4 dark:border-white/10 dark:bg-white/5 ${className}`}
    >
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

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${DELAY_BADGE_STYLES[severity]}`}
        >
          {hasDelay
            ? `+${formatMinutes(result.slowZoneDelayMinutes)} Slow Zone Delay`
            : "No Slow Zone Delay"}
        </span>
        <p className="text-xs text-neutral-500 dark:text-white/50">
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
                  Line {zone.line} {zone.direction}: {zone.normalSpeedKmh} → {zone.reducedSpeedKmh}{" "}
                  km/h between {formatStationLabel(zone.fromStation)} and{" "}
                  {formatStationLabel(zone.toStation)}
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
