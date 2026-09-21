"use client";

import { useCallback, useState } from "react";
import TTCMap from "@/components/map/TTCMap";
import CommuteForm from "@/components/commute/CommuteForm";
import type { LatLon, LocationSelection } from "@/lib/types";
import type { RouteSummary } from "@/types/traffic";

export default function Hero() {
  const [from, setFrom] = useState("");
  const [destination, setDestination] = useState("");
  const [fromCoords, setFromCoords] = useState<LatLon | null>(null);
  const [destinationCoords, setDestinationCoords] = useState<LatLon | null>(null);
  // The route currently highlighted on TTCMap — the primary/fastest result
  // by default, or whichever stacked alternative card the rider picked in
  // CommuteResultCard (see onSelectRoute below).
  const [highlightedRoute, setHighlightedRoute] = useState<RouteSummary | null>(null);
  // Owned here (not inside CommuteForm) because collapsing also has to
  // shrink the positioning wrapper below — otherwise its now-invisible
  // full-size box would keep intercepting clicks/drags on the map
  // underneath it even once the visible card is just a small corner tab.
  const [isFormCollapsed, setIsFormCollapsed] = useState(false);

  function handleFromChange(value: string) {
    setFrom(value);
    setFromCoords(null);
  }

  function handleDestinationChange(value: string) {
    setDestination(value);
    setDestinationCoords(null);
  }

  // Stable across renders (empty deps, only calling stable setState setters)
  // so passing these straight into TTCMap doesn't retrigger its map-creation
  // effect — which would tear down and rebuild the whole WebGL map — every
  // time the rider picks an origin/destination.
  const handleFromSelect = useCallback((selection: LocationSelection) => {
    setFrom(selection.name);
    setFromCoords({ lat: selection.lat, lon: selection.lon });
  }, []);

  const handleDestinationSelect = useCallback((selection: LocationSelection) => {
    setDestination(selection.name);
    setDestinationCoords({ lat: selection.lat, lon: selection.lon });
  }, []);

  function handleSwap() {
    setFrom(destination);
    setDestination(from);
    setFromCoords(destinationCoords);
    setDestinationCoords(fromCoords);
  }

  return (
    <section className="relative h-[85vh] min-h-[560px] w-full">
      <TTCMap
        className="absolute inset-0 h-full w-full"
        onSelectDeparture={handleFromSelect}
        onSetOrigin={handleFromSelect}
        onSetDestination={handleDestinationSelect}
        commuteResult={highlightedRoute}
      />

      <div className="pointer-events-none absolute inset-0">
        {/* The positioning box shrinks to fit in the collapsed state too —
            not just the visible card inside it — so its hit-testing area
            never blocks map clicks/drags once it's just a small corner tab. */}
        <div
          className={
            isFormCollapsed
              ? "pointer-events-auto absolute left-4 top-4 sm:left-6 sm:top-6"
              : "pointer-events-auto absolute inset-x-4 top-4 bottom-4 overflow-y-auto sm:inset-x-auto sm:bottom-auto sm:left-6 sm:top-1/2 sm:max-h-[calc(100%-3rem)] sm:w-[26rem] sm:-translate-y-1/2"
          }
        >
          <CommuteForm
            from={from}
            destination={destination}
            fromCoords={fromCoords}
            destinationCoords={destinationCoords}
            onFromChange={handleFromChange}
            onDestinationChange={handleDestinationChange}
            onFromSelect={handleFromSelect}
            onDestinationSelect={handleDestinationSelect}
            onSwap={handleSwap}
            onResult={setHighlightedRoute}
            onSelectRoute={setHighlightedRoute}
            isCollapsed={isFormCollapsed}
            onToggleCollapsed={() => setIsFormCollapsed((collapsed) => !collapsed)}
          />
        </div>
      </div>
    </section>
  );
}
