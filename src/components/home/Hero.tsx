"use client";

import { useState } from "react";
import TTCMap from "@/components/map/TTCMap";
import CommuteForm from "@/components/commute/CommuteForm";
import type { TransitCommuteResponse } from "@/types/traffic";

export default function Hero() {
  const [from, setFrom] = useState("");
  const [destination, setDestination] = useState("");
  const [commuteResult, setCommuteResult] = useState<TransitCommuteResponse | null>(null);

  return (
    <section className="relative h-[85vh] min-h-[560px] w-full">
      <TTCMap
        className="absolute inset-0 h-full w-full"
        onSelectDeparture={setFrom}
        commuteResult={commuteResult}
      />

      <div className="pointer-events-none absolute inset-0">
        <div className="pointer-events-auto absolute inset-x-4 top-4 bottom-4 overflow-y-auto sm:inset-x-auto sm:bottom-auto sm:left-6 sm:top-1/2 sm:max-h-[calc(100%-3rem)] sm:w-[26rem] sm:-translate-y-1/2">
          <CommuteForm
            from={from}
            destination={destination}
            onFromChange={setFrom}
            onDestinationChange={setDestination}
            onResult={setCommuteResult}
          />
        </div>
      </div>
    </section>
  );
}
