"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { DetourSummary } from "@/types/traffic";

/** Bridges DetourPanel (rendered in the page header) and TTCMap (rendered
 * inside Hero, a sibling of the header, not a descendant) — the header has
 * no direct way to reach into the map, so "View on Map" instead sets this
 * shared piece of state, which TTCMap's own effect watches and reacts to
 * (fit bounds, highlight affected stops, dim other layers — see
 * TTCMap.tsx). */
interface DetourMapContextValue {
  /** The detour the rider most recently picked "View on Map" for. Stays set
   * (not auto-cleared) so TTCMap can still show it after a re-render;
   * cleared explicitly via clearViewedDetour (e.g. an "Exit detour view"
   * control on the map). */
  viewedDetour: DetourSummary | null;
  viewDetourOnMap: (detour: DetourSummary) => void;
  clearViewedDetour: () => void;
}

const DetourMapContext = createContext<DetourMapContextValue | null>(null);

export function DetourMapProvider({ children }: { children: ReactNode }) {
  const [viewedDetour, setViewedDetour] = useState<DetourSummary | null>(null);

  const value = useMemo<DetourMapContextValue>(
    () => ({
      viewedDetour,
      viewDetourOnMap: setViewedDetour,
      clearViewedDetour: () => setViewedDetour(null),
    }),
    [viewedDetour]
  );

  return <DetourMapContext.Provider value={value}>{children}</DetourMapContext.Provider>;
}

export function useDetourMap(): DetourMapContextValue {
  const context = useContext(DetourMapContext);
  if (!context) {
    throw new Error("useDetourMap must be used within a DetourMapProvider");
  }
  return context;
}
