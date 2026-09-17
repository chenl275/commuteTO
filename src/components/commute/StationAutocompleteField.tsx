"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { getAllStations, lineColorById } from "@/lib/geo/subwayGeoJSON";
import { formatStationLabel, stationMatchKey } from "@/lib/stationDisplay";
import { searchAddresses, type GeocodeResult } from "@/lib/geocoding";
import type { LocationSelection } from "@/lib/types";

const STATIONS = getAllStations().map((station) => ({
  ...station,
  label: formatStationLabel(station.name),
}));
const MAX_STATION_SUGGESTIONS = 5;
const ADDRESS_SEARCH_DEBOUNCE_MS = 300;
const MIN_ADDRESS_QUERY_LENGTH = 3;

type Suggestion =
  | { kind: "station"; id: string; label: string; lat: number; lon: number; lines: number[] }
  | { kind: "address"; id: string; label: string; subtitle: string; lat: number; lon: number };

interface StationAutocompleteFieldProps {
  id: string;
  label: string;
  icon: ReactNode;
  placeholder?: string;
  value: string;
  /** Free-typed text — clears any previously selected coordinates, since the
   * text no longer necessarily matches them. */
  onChange: (value: string) => void;
  /** A station or geocoded address picked from the suggestion list, or a pin
   * dropped on the map — carries exact coordinates for the multi-modal router. */
  onSelect: (selection: LocationSelection) => void;
}

export default function StationAutocompleteField({
  id,
  label,
  icon,
  placeholder,
  value,
  onChange,
  onSelect,
}: StationAutocompleteFieldProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [addressResults, setAddressResults] = useState<GeocodeResult[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  const query = stationMatchKey(value);
  const stationSuggestions = query
    ? STATIONS.filter((station) => stationMatchKey(station.label).includes(query)).slice(
        0,
        MAX_STATION_SUGGESTIONS
      )
    : [];

  // Toronto-biased address/landmark search via Photon (see lib/geocoding.ts)
  // — debounced so a rider typing a full address doesn't fire a request per
  // keystroke, and cancelled on cleanup so a slow, now-stale response can't
  // clobber a faster one for a later keystroke.
  useEffect(() => {
    const trimmed = value.trim();
    if (trimmed.length < MIN_ADDRESS_QUERY_LENGTH) {
      // Deferred (not called synchronously in the effect body) per the
      // react-hooks set-state-in-effect rule — this still clears stale
      // address results before the next keystroke's debounce fires.
      const timeoutId = setTimeout(() => setAddressResults([]), 0);
      return () => clearTimeout(timeoutId);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      searchAddresses(trimmed, controller.signal)
        .then((results) => setAddressResults(results))
        .catch(() => {
          // A failed/aborted geocode just leaves the address section of the
          // list empty — station suggestions (if any) still work.
        });
    }, ADDRESS_SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [value]);

  const suggestions: Suggestion[] = [
    ...stationSuggestions.map((station) => ({
      kind: "station" as const,
      id: station.id,
      label: station.label,
      lat: station.coordinates[1],
      lon: station.coordinates[0],
      lines: station.lines,
    })),
    ...addressResults.map((result) => ({
      kind: "address" as const,
      id: result.id,
      label: result.title,
      subtitle: result.subtitle,
      lat: result.lat,
      lon: result.lon,
    })),
  ];
  const showSuggestions =
    isOpen &&
    suggestions.length > 0 &&
    !(suggestions.length === 1 && suggestions[0].label === value);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function handleSelect(suggestion: Suggestion) {
    onSelect({ name: suggestion.label, lat: suggestion.lat, lon: suggestion.lon });
    setIsOpen(false);
  }

  return (
    <div ref={containerRef} className="relative flex-1">
      <label
        htmlFor={id}
        className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-white/60"
      >
        {label}
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-white/40">
          {icon}
        </span>
        <input
          id={id}
          type="text"
          autoComplete="off"
          role="combobox"
          aria-expanded={showSuggestions}
          aria-controls={listId}
          aria-autocomplete="list"
          value={value}
          placeholder={placeholder}
          onChange={(event) => {
            onChange(event.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && showSuggestions) {
              // Selecting a suggestion is the input's job on Enter — let the
              // form submit normally once a canonical location is already typed.
              event.preventDefault();
              handleSelect(suggestions[0]);
            }
          }}
          className="w-full rounded-xl border border-neutral-300 bg-white py-3 pl-10 pr-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/30 sm:text-base dark:border-white/15 dark:bg-white/10 dark:text-white dark:placeholder:text-white/40 dark:[color-scheme:dark] dark:focus:border-red-400 dark:focus:ring-red-400/40"
        />
      </div>

      {showSuggestions && (
        <ul
          id={listId}
          role="listbox"
          className="absolute top-full left-0 z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border border-neutral-300 bg-white py-1 shadow-xl dark:border-white/20 dark:bg-neutral-900"
        >
          {suggestions.map((suggestion) => (
            <li key={`${suggestion.kind}-${suggestion.id}`} role="option" aria-selected={suggestion.label === value}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => handleSelect(suggestion)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-800 hover:bg-neutral-100 dark:text-white/90 dark:hover:bg-white/10"
              >
                <span className="shrink-0" aria-hidden="true">
                  {suggestion.kind === "station" ? "🚇" : "📍"}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-semibold">{suggestion.label}</span>
                  {suggestion.kind === "address" && suggestion.subtitle && (
                    <span className="truncate text-xs font-normal text-neutral-500 dark:text-white/50">
                      {suggestion.subtitle}
                    </span>
                  )}
                </span>
                {suggestion.kind === "station" && (
                  <span className="ml-auto flex shrink-0 gap-1">
                    {suggestion.lines.map((lineId) => (
                      <span
                        key={lineId}
                        className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white"
                        // Line colors are per-row runtime data (5 possible hex
                        // values), which Tailwind's build-time class scanner
                        // can't pick up from a dynamic string.
                        style={{ backgroundColor: lineColorById[lineId] ?? "#6b7280" }}
                      >
                        {lineId}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
