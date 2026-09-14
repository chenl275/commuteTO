"use client";

import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { CARTO_DARK_MATTER_STYLE, DEFAULT_MAP_ZOOM, TORONTO_CENTER } from "@/lib/constants";

interface TTCMapProps {
  className?: string;
}

// maplibre-gl's worker script imports a sibling chunk via a relative path;
// Turbopack's asset pipeline copies only the one file it's told about, so
// that import 404s and tiles silently never load. Both files are copied
// into public/ (see scripts/copy-maplibre-worker.mjs) and served verbatim,
// co-located, so the worker's relative import resolves correctly.
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

export default function TTCMap({ className = "" }: TTCMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: CARTO_DARK_MATTER_STYLE,
      center: TORONTO_CENTER,
      zoom: DEFAULT_MAP_ZOOM,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Interactive map centered on Toronto"
      className={className}
    />
  );
}
