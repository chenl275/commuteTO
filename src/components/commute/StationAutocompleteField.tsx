"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { getAllStations, lineColorById } from "@/lib/geo/subwayGeoJSON";
import { formatStationLabel, stationMatchKey } from "@/lib/stationDisplay";

const STATIONS = getAllStations().map((station) => ({
  ...station,
  label: formatStationLabel(station.name),
}));
const MAX_SUGGESTIONS = 8;

interface StationAutocompleteFieldProps {
  id: string;
  label: string;
  icon: ReactNode;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}

export default function StationAutocompleteField({
  id,
  label,
  icon,
  placeholder,
  value,
  onChange,
}: StationAutocompleteFieldProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  const query = stationMatchKey(value);
  const suggestions = query
    ? STATIONS.filter((station) => stationMatchKey(station.label).includes(query)).slice(
        0,
        MAX_SUGGESTIONS
      )
    : [];
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

  function handleSelect(stationLabel: string) {
    onChange(stationLabel);
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
              // form submit normally once a canonical station is already typed.
              event.preventDefault();
              handleSelect(suggestions[0].label);
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
          {suggestions.map((station) => (
            <li key={station.id} role="option" aria-selected={station.label === value}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => handleSelect(station.label)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-neutral-800 hover:bg-neutral-100 dark:text-white/90 dark:hover:bg-white/10"
              >
                <span>{station.label}</span>
                <span className="flex shrink-0 gap-1">
                  {station.lines.map((lineId) => (
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
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
