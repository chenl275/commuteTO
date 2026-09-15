"use client";

import type { ChangeEvent } from "react";
import type { DepartureMode } from "@/lib/types";

interface DepartureToggleProps {
  value: DepartureMode;
  onChange: (mode: DepartureMode) => void;
  className?: string;
}

const options: Array<{ value: DepartureMode; label: string }> = [
  { value: "now", label: "Leave now" },
  { value: "later", label: "Leave later" },
];

export default function DepartureToggle({
  value,
  onChange,
  className = "",
}: DepartureToggleProps) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    onChange(event.target.value as DepartureMode);
  }

  return (
    <fieldset className={className}>
      <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-white/60">
        Departure
      </legend>
      <div className="inline-flex rounded-full border border-neutral-300 bg-neutral-100 p-1 dark:border-white/15 dark:bg-white/5">
        {options.map((option) => {
          const inputId = `departure-${option.value}`;
          const isChecked = value === option.value;

          return (
            <div key={option.value} className="relative">
              <input
                type="radio"
                id={inputId}
                name="departure"
                value={option.value}
                checked={isChecked}
                onChange={handleChange}
                className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
              <label
                htmlFor={inputId}
                className={`block cursor-pointer rounded-full px-4 py-2 text-sm font-medium transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-red-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-white dark:peer-focus-visible:ring-red-400 dark:peer-focus-visible:ring-offset-neutral-950 ${
                  isChecked
                    ? "bg-red-600 text-white"
                    : "text-neutral-600 hover:text-neutral-900 dark:text-white/70 dark:hover:text-white"
                }`}
              >
                {option.label}
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
