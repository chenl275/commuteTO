"use client";

import { useEffect, useState } from "react";
import type { ItineraryLeg } from "@/types/traffic";

// Matches router.py's LIVE_ETA_HORIZON_MINUTES — a leg the backend never
// even attempted to live-track (it was more than this many minutes out at
// request time) always renders as plain "Scheduled" here too.
const LIVE_ETA_HORIZON_MINUTES = 45;
const COUNTDOWN_THRESHOLD_MINUTES = 15;
// Keeps the relative "Arriving in N mins" countdown (and the live/static
// bucket a leg falls into) current without needing the whole result card to
// re-render for any other reason.
const TICK_MS = 15_000;

const SURFACE_DELAY_LABELS: Record<"bus" | "streetcar", string> = {
  bus: "Traffic Delay",
  streetcar: "Streetcar Delay",
};

function formatClockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

interface LegArrivalTimeProps {
  leg: ItineraryLeg;
}

/** Relative arrival formatting for one surface transit (bus/streetcar)
 * itinerary leg: a live-tracked departure within 15 minutes gets a
 * pulsating countdown, one 15-45 minutes out gets a clock time + delay
 * pill, a vehicle running late gets a strikethrough-and-revised time, and
 * anything not live — including a leg more than 45 minutes out, which the
 * backend never even attempts to live-track (see router.py's
 * LIVE_ETA_HORIZON_MINUTES) — falls back to the plain static schedule with
 * a subtle "Scheduled" badge. Call only for leg.mode === "bus" | "streetcar";
 * subway/walk legs have no live tracking to render here. */
export default function LegArrivalTime({ leg }: LegArrivalTimeProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(interval);
  }, []);

  const minutesUntil = (new Date(leg.departureTime).getTime() - now) / 60_000;

  if (leg.trackingUnavailable || !leg.isLive || minutesUntil > LIVE_ETA_HORIZON_MINUTES) {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span className="whitespace-nowrap">{formatClockTime(leg.departureTime)}</span>
        <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-neutral-500 dark:bg-white/10 dark:text-white/40">
          {leg.trackingUnavailable ? "Scheduled (Tracking Unavailable)" : "Scheduled"}
        </span>
      </div>
    );
  }

  const isDelayed = leg.delaySeconds > 0;
  const lateMinutes = Math.max(1, Math.round(leg.delaySeconds / 60));
  const delayLabel = SURFACE_DELAY_LABELS[leg.mode as "bus" | "streetcar"] ?? "Delay";

  if (minutesUntil <= COUNTDOWN_THRESHOLD_MINUTES) {
    // A departure that's already passed (minutesUntil <= 0) or is within 60
    // seconds (minutesUntil <= 1) reads as a literal "0 mins" countdown,
    // which looks like a stalled/broken timer rather than an imminent
    // vehicle — "Due"/"Arriving now" match how real transit countdown
    // displays (TTC NextBus included) handle the last stretch.
    if (minutesUntil <= 1) {
      return (
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />
          <span className="whitespace-nowrap font-semibold text-emerald-700 dark:text-emerald-300">
            {minutesUntil <= 0 ? "Due" : "Arriving now"}
          </span>
        </div>
      );
    }
    const displayMinutes = Math.round(minutesUntil);
    return (
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />
        <span className="whitespace-nowrap font-semibold text-emerald-700 dark:text-emerald-300">
          Arriving in {displayMinutes} min{displayMinutes === 1 ? "" : "s"}
        </span>
      </div>
    );
  }

  if (isDelayed) {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span className="whitespace-nowrap">
          <span className="text-neutral-400 line-through dark:text-white/30">
            {formatClockTime(leg.scheduledDepartureTime)}
          </span>{" "}
          <span className="font-semibold text-neutral-800 dark:text-white">{formatClockTime(leg.departureTime)}</span>
        </span>
        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
          +{lateMinutes} min{lateMinutes === 1 ? "" : "s"} {delayLabel}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="whitespace-nowrap text-neutral-700 dark:text-white/80">
        Arriving at {formatClockTime(leg.departureTime)} (~{Math.max(0, Math.round(minutesUntil))} mins)
      </span>
      <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
        On Time
      </span>
    </div>
  );
}
