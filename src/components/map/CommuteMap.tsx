"use client";

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import SkylineSilhouette from "@/components/home/SkylineSilhouette";
import {
  DEFAULT_MAP_ZOOM,
  MAPBOX_DARK_STYLE,
  MAPBOX_TOKEN,
  TORONTO_CENTER,
} from "@/lib/constants";

interface CommuteMapProps {
  className?: string;
}

const hasToken = MAPBOX_TOKEN !== "";

export default function CommuteMap({ className = "" }: CommuteMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);

  useEffect(() => {
    if (!hasToken || !containerRef.current) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: MAPBOX_DARK_STYLE,
      center: TORONTO_CENTER,
      zoom: DEFAULT_MAP_ZOOM,
    });

    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  if (!hasToken) {
    return (
      <div
        role="img"
        aria-label="Map of Toronto (unavailable — Mapbox access token not configured)"
        className={`relative flex items-center justify-center overflow-hidden bg-neutral-950 ${className}`}
      >
        <div className="absolute inset-0 bg-gradient-to-b from-black via-neutral-950 to-neutral-900" />
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-red-600/25 via-red-900/10 to-transparent blur-2xl" />
        <SkylineSilhouette className="absolute inset-x-0 bottom-0 h-32 w-full text-black/90 sm:h-48" />
        <p className="relative z-10 mx-6 max-w-xs rounded-full border border-white/15 bg-white/10 px-4 py-2 text-center text-xs text-white/70 backdrop-blur-md sm:text-sm">
          Live map coming soon — set{" "}
          <code className="text-white">NEXT_PUBLIC_MAPBOX_TOKEN</code> to enable
          Mapbox GL.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Interactive map centered on Toronto"
      className={className}
    />
  );
}
