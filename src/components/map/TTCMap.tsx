"use client";

import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { CARTO_DARK_STYLE, CARTO_LIGHT_STYLE, DEFAULT_MAP_ZOOM, TORONTO_CENTER } from "@/lib/constants";
import { linesGeoJSON, stationsGeoJSON } from "@/lib/geo/subwayGeoJSON";
import { useIsDarkMode } from "@/components/theme/useIsDarkMode";

interface TTCMapProps {
  className?: string;
  /** Called when a rider picks "Set as Departure" on a station popup. */
  onSelectDeparture?: (stationName: string) => void;
}

// maplibre-gl's worker script imports a sibling chunk via a relative path;
// Turbopack's asset pipeline copies only the one file it's told about, so
// that import 404s and tiles silently never load. Both files are copied
// into public/ (see scripts/copy-maplibre-worker.mjs) and served verbatim,
// co-located, so the worker's relative import resolves correctly.
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

const LINES_SOURCE_ID = "ttc-lines";
const LINES_LAYER_ID = "ttc-lines-layer";
const STATIONS_SOURCE_ID = "ttc-stations";
const STATIONS_LAYER_ID = "ttc-stations-layer";

const lineMetaById: Map<number, (typeof linesGeoJSON.features)[number]["properties"]> = new Map(
  linesGeoJSON.features.map((f) => [f.properties.lineId, f.properties])
);

function buildPopupContent(
  station: { name: string; lines: number[] },
  onSelectDeparture: (stationName: string) => void
): HTMLElement {
  const container = document.createElement("div");
  container.className = "min-w-[170px] p-1";

  const title = document.createElement("p");
  title.className = "mb-2 font-bold text-neutral-900";
  title.textContent = station.name;
  container.appendChild(title);

  const badgeRow = document.createElement("div");
  badgeRow.className = "mb-3 flex flex-wrap gap-1.5";
  for (const lineId of station.lines) {
    const meta = lineMetaById.get(lineId);
    if (!meta) continue;
    const badge = document.createElement("span");
    badge.className = "rounded-full px-2 py-0.5 text-[11px] font-semibold text-white";
    // Badge color is per-row data (5 possible hex values), which Tailwind's
    // build-time class scanner can't pick up from a runtime string — this is
    // the one legitimate case for a direct style property.
    badge.style.backgroundColor = meta.colorHex;
    badge.textContent = `Line ${lineId}`;
    badgeRow.appendChild(badge);
  }
  container.appendChild(badgeRow);

  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "w-full rounded-full bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-700";
  button.textContent = "Set as Departure";
  button.addEventListener("click", () => onSelectDeparture(station.name));
  container.appendChild(button);

  return container;
}

/**
 * Adds (or re-adds) the subway line/station layers. Safe to call repeatedly —
 * each source/layer is only added if missing, which matters both for hot
 * reloads and for re-applying after a basemap style swap (`setStyle` wipes
 * any layers not present in the new style.json).
 */
function addTTCLayers(map: maplibregl.Map) {
  if (!map.getSource(LINES_SOURCE_ID)) {
    map.addSource(LINES_SOURCE_ID, { type: "geojson", data: linesGeoJSON });
  }
  if (!map.getLayer(LINES_LAYER_ID)) {
    map.addLayer({
      id: LINES_LAYER_ID,
      type: "line",
      source: LINES_SOURCE_ID,
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": ["get", "colorHex"],
        "line-width": 4,
      },
    });
  }

  if (!map.getSource(STATIONS_SOURCE_ID)) {
    map.addSource(STATIONS_SOURCE_ID, { type: "geojson", data: stationsGeoJSON });
  }
  if (!map.getLayer(STATIONS_LAYER_ID)) {
    map.addLayer({
      id: STATIONS_LAYER_ID,
      type: "circle",
      source: STATIONS_SOURCE_ID,
      paint: {
        "circle-radius": ["case", ["get", "isTransfer"], 6.5, 4],
        "circle-color": "#FFFFFF",
        "circle-stroke-color": "#111111",
        "circle-stroke-width": 2,
      },
    });
  }
}

export default function TTCMap({ className = "", onSelectDeparture }: TTCMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const isDark = useIsDarkMode();
  const hasSetInitialStyleRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      // Read once at mount — later theme toggles are handled by the setStyle
      // effect below, not by recreating the map.
      style: isDark ? CARTO_DARK_STYLE : CARTO_LIGHT_STYLE,
      center: TORONTO_CENTER,
      zoom: DEFAULT_MAP_ZOOM,
      dragRotate: true,
      pitchWithRotate: true,
      touchPitch: true,
    });

    map.addControl(
      new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }),
      "top-right"
    );
    mapRef.current = map;

    const handleDeparture = onSelectDeparture ?? ((name: string) => console.log("Set as departure:", name));

    let interactionsBound = false;

    // "style.load" (unlike "load") fires again every time setStyle() swaps
    // the basemap, which is exactly when our custom layers need re-adding.
    map.on("style.load", () => {
      addTTCLayers(map);

      if (interactionsBound) return;
      interactionsBound = true;

      map.on("mouseenter", STATIONS_LAYER_ID, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", STATIONS_LAYER_ID, () => {
        map.getCanvas().style.cursor = "";
      });

      map.on("click", STATIONS_LAYER_ID, (event) => {
        const feature = event.features?.[0];
        if (!feature || feature.geometry.type !== "Point") return;

        const properties = feature.properties as { name: string; lines: number[] | string };
        const lines = Array.isArray(properties.lines)
          ? properties.lines
          : (JSON.parse(properties.lines as unknown as string) as number[]);

        new maplibregl.Popup({ offset: 12 })
          .setLngLat(feature.geometry.coordinates as [number, number])
          .setDOMContent(buildPopupContent({ name: properties.name, lines }, handleDeparture))
          .addTo(map);
      });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isDark is read once for the initial style; later changes go through the effect below
  }, [onSelectDeparture]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Skip the run that fires right after mount — the map was just created
    // with this exact style already.
    if (!hasSetInitialStyleRef.current) {
      hasSetInitialStyleRef.current = true;
      return;
    }

    map.setStyle(isDark ? CARTO_DARK_STYLE : CARTO_LIGHT_STYLE);
  }, [isDark]);

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Interactive map centered on Toronto"
      className={className}
    />
  );
}
