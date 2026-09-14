"use client";

import { useState, type FormEvent } from "react";
import FormField from "./FormField";
import DepartureToggle from "./DepartureToggle";
import Button from "@/components/ui/Button";
import {
  CalendarIcon,
  ClockIcon,
  FlagIcon,
  MapPinIcon,
  SwapIcon,
} from "@/components/icons";
import { calculateCommute } from "@/lib/commute";
import type { DepartureMode } from "@/lib/types";

function getTodayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

function getCurrentTime(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes()
  ).padStart(2, "0")}`;
}

export default function CommuteForm() {
  const [from, setFrom] = useState("");
  const [destination, setDestination] = useState("");
  const [departureMode, setDepartureMode] = useState<DepartureMode>("now");
  const [date, setDate] = useState(getTodayISODate);
  const [time, setTime] = useState(getCurrentTime);
  const [isCalculating, setIsCalculating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const isLeavingLater = departureMode === "later";
  const canSubmit =
    from.trim() !== "" &&
    destination.trim() !== "" &&
    (!isLeavingLater || (date !== "" && time !== ""));

  function handleSwap() {
    setFrom(destination);
    setDestination(from);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsCalculating(true);
    setNotice(null);

    try {
      await calculateCommute({
        from,
        destination,
        departure: isLeavingLater ? { mode: "later", date, time } : { mode: "now" },
      });
    } catch {
      setNotice(
        "Commute calculation is coming soon! We're still wiring up live TTC data."
      );
    } finally {
      setIsCalculating(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-3xl border border-white/15 bg-white/10 p-5 shadow-2xl shadow-black/40 backdrop-blur-xl sm:p-8"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <FormField
          id="from"
          label="From"
          icon={<MapPinIcon className="h-5 w-5" />}
          placeholder="Current location or address"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />

        <button
          type="button"
          onClick={handleSwap}
          aria-label="Swap from and destination"
          className="mx-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/20 text-white/70 transition-colors hover:bg-white/10 hover:text-white sm:mb-0.5"
        >
          <SwapIcon className="h-4 w-4 rotate-90 sm:rotate-0" />
        </button>

        <FormField
          id="destination"
          label="Destination"
          icon={<FlagIcon className="h-5 w-5" />}
          placeholder="Where are you headed?"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
        />
      </div>

      <DepartureToggle
        value={departureMode}
        onChange={setDepartureMode}
        className="mt-5"
      />

      {isLeavingLater && (
        <div className="mt-4 flex animate-fade-in-up flex-col gap-4 sm:flex-row">
          <FormField
            id="departure-date"
            label="Date"
            type="date"
            icon={<CalendarIcon className="h-5 w-5" />}
            value={date}
            min={getTodayISODate()}
            onChange={(e) => setDate(e.target.value)}
            required
          />
          <FormField
            id="departure-time"
            label="Time"
            type="time"
            icon={<ClockIcon className="h-5 w-5" />}
            value={time}
            onChange={(e) => setTime(e.target.value)}
            required
          />
        </div>
      )}

      <Button
        type="submit"
        disabled={isCalculating || !canSubmit}
        className="mt-5 w-full sm:w-auto"
      >
        {isCalculating ? "Calculating…" : "Calculate Commute"}
      </Button>

      {notice && (
        <p
          role="status"
          className="mt-4 rounded-lg border border-red-400/30 bg-red-500/15 px-4 py-3 text-sm text-red-100"
        >
          {notice}
        </p>
      )}
    </form>
  );
}
