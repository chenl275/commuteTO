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
import { searchAddresses } from "@/lib/geocoding";
import type { DepartureMode, LatLon, LocationSelection } from "@/lib/types";
import type { TransitCommuteResponse } from "@/types/traffic";

interface ResolvedEndpoint {
  text: string;
  coords: LatLon | null;
}

/**
 * Auto-resolves a free-typed origin/destination that doesn't yet have
 * coordinates attached — e.g. the rider typed "80 bay street" and hit Enter
 * or clicked "Calculate Commute" without ever clicking a dropdown
 * suggestion, so StationAutocompleteField's onSelect never fired. Mirrors
 * that component's own hybrid lookup: a known station name needs no
 * coordinates at all, otherwise geocode it the same way the address
 * dropdown would (see lib/geocoding.ts) and take the top result. Falls back
 * to the raw text with no coordinates if nothing resolves — the backend
 * geocodes as a last resort too (see traffic_service.py), so submission is
 * never blocked here.
 */
async function resolveEndpoint(value: string, coords: LatLon | null): Promise<ResolvedEndpoint> {
  if (coords) return { text: value.trim(), coords };

  const trimmed = value.trim();
  if (!trimmed) return { text: trimmed, coords: null };

  const station = getStationByNameOrId(trimmed);
  if (station) return { text: station.name, coords: null };

  try {
    const [first] = await searchAddresses(trimmed);
    if (first) return { text: first.title, coords: { lat: first.lat, lon: first.lon } };
  } catch {
    // A failed/offline geocode just falls through to the raw text below —
    // the backend's own geocoding fallback still gets a chance to resolve it.
  }

  return { text: trimmed, coords: null };
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
  /** Exact coordinates behind `from`/`destination`, when the rider picked a
   * geocoded address/station suggestion or dropped a map pin — null once
   * they've typed something that no longer necessarily matches those
   * coordinates. Passed straight to the backend so its multi-modal router
   * can compute the real walk leg from that exact point. */
  fromCoords: LatLon | null;
  destinationCoords: LatLon | null;
  onFromChange: (value: string) => void;
  onDestinationChange: (value: string) => void;
  onFromSelect: (selection: LocationSelection) => void;
  onDestinationSelect: (selection: LocationSelection) => void;
  /** Swaps from/destination (text and coordinates together) — owned by the
   * parent since it holds both pairs of state. */
  onSwap: () => void;
  onResult?: (result: TransitCommuteResponse | null) => void;
}

export default function CommuteForm({
  from,
  destination,
  fromCoords,
  destinationCoords,
  onFromChange,
  onDestinationChange,
  onFromSelect,
  onDestinationSelect,
  onSwap,
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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsCalculating(true);
    setErrorMessage(null);
    setResult(null);
    onResult?.(null);

    try {
      // Pressing Enter or clicking "Calculate Commute" without ever picking
      // a dropdown suggestion (e.g. typing "80 bay street" and submitting
      // straight away) leaves fromCoords/destinationCoords null — resolve
      // both endpoints the same way the dropdown would before requesting an
      // estimate, so originLat/originLon/destLat/destLon are always attached.
      const [resolvedFrom, resolvedDestination] = await Promise.all([
        resolveEndpoint(from, fromCoords),
        resolveEndpoint(destination, destinationCoords),
      ]);
      if (!fromCoords && resolvedFrom.coords) {
        onFromSelect({ name: resolvedFrom.text, ...resolvedFrom.coords });
      }
      if (!destinationCoords && resolvedDestination.coords) {
        onDestinationSelect({ name: resolvedDestination.text, ...resolvedDestination.coords });
      }

      const estimate = await getTrafficEstimate({
        origin: resolvedFrom.text,
        destination: resolvedDestination.text,
        originLat: resolvedFrom.coords?.lat,
        originLon: resolvedFrom.coords?.lon,
        destLat: resolvedDestination.coords?.lat,
        destLon: resolvedDestination.coords?.lon,
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
          placeholder="Departure station, address, or landmark"
          value={from}
          onChange={onFromChange}
          onSelect={onFromSelect}
        />

        <button
          type="button"
          onClick={onSwap}
          aria-label="Swap from and destination"
          className="mx-auto -my-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-neutral-300 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:border-white/20 dark:text-white/70 dark:hover:bg-white/10 dark:hover:text-white"
        >
          <SwapIcon className="h-4 w-4 rotate-90" />
        </button>

        <StationAutocompleteField
          id="destination"
          label="Destination"
          icon={<FlagIcon className="h-5 w-5" />}
          placeholder="Destination station, address, or landmark"
          value={destination}
          onChange={onDestinationChange}
          onSelect={onDestinationSelect}
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
