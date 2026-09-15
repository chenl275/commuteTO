import type { TrafficResponse } from "@/types/traffic";

interface CommuteResultCardProps {
  result: TrafficResponse;
  className?: string;
}

type DelaySeverity = "low" | "moderate" | "severe";

function getDelaySeverity(minutes: number): DelaySeverity {
  if (minutes >= 15) return "severe";
  if (minutes >= 5) return "moderate";
  return "low";
}

const DELAY_BADGE_STYLES: Record<DelaySeverity, string> = {
  low: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  moderate: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  severe: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

function formatClockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function CommuteResultCard({ result, className = "" }: CommuteResultCardProps) {
  const severity = getDelaySeverity(result.trafficDelayMinutes);

  return (
    <div
      className={`rounded-2xl border border-neutral-200 bg-neutral-50 p-4 dark:border-white/10 dark:bg-white/5 ${className}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-white/50">
            Without traffic
          </p>
          <p className="text-lg font-bold text-neutral-900 dark:text-white">{result.durationText}</p>
        </div>
        <div className="text-right">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-white/50">
            With traffic
          </p>
          <p className="text-lg font-bold text-neutral-900 dark:text-white">
            {result.durationInTrafficText}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${DELAY_BADGE_STYLES[severity]}`}
        >
          {result.trafficDelayMinutes > 0
            ? `+${result.trafficDelayMinutes} mins traffic delay`
            : "No significant delay"}
        </span>
        <p className="text-xs text-neutral-500 dark:text-white/50">
          Arriving around{" "}
          <span className="font-semibold text-neutral-800 dark:text-white">
            {formatClockTime(result.arrivalTime)}
          </span>
        </p>
      </div>

      {result.source === "simulated" && (
        <p className="mt-3 text-[11px] text-neutral-400 dark:text-white/30">
          Simulated estimate — live traffic data isn&apos;t connected yet.
        </p>
      )}
    </div>
  );
}
