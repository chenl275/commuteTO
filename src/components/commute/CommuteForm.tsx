"use client";

import { useState, type FormEvent } from "react";
import StationAutocompleteField from "./StationAutocompleteField";
import FormField from "./FormField";
import DepartureToggle from "./DepartureToggle";
import CommuteResultCard from "./CommuteResultCard";
import Button from "@/components/ui/Button";
import {
  CalendarIcon,
  ClockIcon,
  FlagIcon,
  MapPinIcon,
  SpinnerIcon,
  SwapIcon,
} from "@/components/icons";
import { getTrafficEstimate } from "@/lib/traffic";
import { getStationByNameOrId } from "@/lib/geo/subwayGeoJSON";
import type { DepartureMode } from "@/lib/types";
import type { TransitCommuteResponse } from "@/types/traffic";

/**
 * Resolves free-typed rider input to the station registry's bare canonical
 * name ("Union", "Bloor-Yonge") before it's sent to the backend. Falls back
 * to the raw trimmed text for anything the registry can't resolve, so the
 * backend's own matching still gets a chance to handle it.
 */
function resolveStationInput(value: string): string {
  const trimmed = value.trim();
  return getStationByNameOrId(trimmed)?.name ?? trimmed;
}

function getTodayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

function getCurrentTime(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes()
  ).padStart(2, "0")}`;
}

interface CommuteFormProps {
  from: string;
  destination: string;
  onFromChange: (value: string) => void;
  onDestinationChange: (value: string) => void;
  onResult?: (result: TransitCommuteResponse | null) => void;
}

export default function CommuteForm({
  from,
  destination,
  onFromChange,
  onDestinationChange,
  onResult,
}: CommuteFormProps) {
  const [departureMode, setDepartureMode] = useState<DepartureMode>("now");
  const [date, setDate] = useState(getTodayISODate);
  const [time, setTime] = useState(getCurrentTime);
  const [isCalculating, setIsCalculating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<TransitCommuteResponse | null>(null);

  const isLeavingLater = departureMode === "later";
  const canSubmit =
    from.trim() !== "" &&
    destination.trim() !== "" &&
    (!isLeavingLater || (date !== "" && time !== ""));

  function handleSwap() {
    onFromChange(destination);
    onDestinationChange(from);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsCalculating(true);
    setErrorMessage(null);
    setResult(null);
    onResult?.(null);

    try {
      const estimate = await getTrafficEstimate({
        origin: resolveStationInput(from),
        destination: resolveStationInput(destination),
        departureTime: isLeavingLater ? `${date}T${time}` : undefined,
      });
      setResult(estimate);
      onResult?.(estimate);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Couldn't reach the transit service. Is the backend running?"
      );
    } finally {
      setIsCalculating(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-3xl border border-neutral-200 bg-white/90 p-5 text-neutral-900 shadow-xl shadow-black/5 backdrop-blur-xl sm:p-8 dark:border-neutral-800 dark:bg-neutral-900/80 dark:text-white dark:shadow-2xl dark:shadow-black/40"
    >
      <div className="flex flex-col gap-4">
        <StationAutocompleteField
          id="from"
          label="From"
          icon={<MapPinIcon className="h-5 w-5" />}
          placeholder="Departure station"
          value={from}
          onChange={onFromChange}
        />

        <button
          type="button"
          onClick={handleSwap}
          aria-label="Swap from and destination"
          className="mx-auto -my-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-neutral-300 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:border-white/20 dark:text-white/70 dark:hover:bg-white/10 dark:hover:text-white"
        >
          <SwapIcon className="h-4 w-4 rotate-90" />
        </button>

        <StationAutocompleteField
          id="destination"
          label="Destination"
          icon={<FlagIcon className="h-5 w-5" />}
          placeholder="Destination station"
          value={destination}
          onChange={onDestinationChange}
        />
      </div>

      <DepartureToggle
        value={departureMode}
        onChange={setDepartureMode}
        className="mt-5"
      />

      {isLeavingLater && (
        <div className="mt-4 flex animate-fade-in-up flex-col gap-4">
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
        {isCalculating ? (
          <>
            <SpinnerIcon className="h-4 w-4 animate-spin" />
            Calculating…
          </>
        ) : (
          "Calculate Commute"
        )}
      </Button>

      {errorMessage && (
        <p
          role="status"
          className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-400/30 dark:bg-red-500/15 dark:text-red-100"
        >
          {errorMessage}
        </p>
      )}

      {result && <CommuteResultCard result={result} className="mt-4 animate-fade-in-up" />}
    </form>
  );
}
