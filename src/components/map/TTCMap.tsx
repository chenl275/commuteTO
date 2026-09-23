"use client";

import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { CARTO_DARK_STYLE, CARTO_LIGHT_STYLE, DEFAULT_MAP_ZOOM, TORONTO_CENTER } from "@/lib/constants";
import {
  findStationByName,
  getRouteCoordinates,
  getStationIndexOnLine,
  linesGeoJSON,
  stationsGeoJSON,
} from "@/lib/geo/subwayGeoJSON";
import { useIsDarkMode } from "@/components/theme/useIsDarkMode";
import { getAlerts, getDayBuses, getNightBuses, getSlowZones, getStreetcars, getSurfaceStops } from "@/lib/traffic";
import { reverseGeocode } from "@/lib/geocoding";
import { formatStationLabel } from "@/lib/stationDisplay";
import { useDetourMap } from "@/lib/detourMapContext";
import type { LocationSelection } from "@/lib/types";
import type { DetourSummary, RouteSummary } from "@/types/traffic";

interface TTCMapProps {
  className?: string;
  /** Called when a rider picks "Set as Departure" on a station popup. */
  onSelectDeparture?: (selection: LocationSelection) => void;
  /** Called when a rider right-clicks/long-presses the map and picks "Set as
   * Origin" from the resulting pin-drop menu. */
  onSetOrigin?: (selection: LocationSelection) => void;
  /** Same as `onSetOrigin`, for "Set as Destination". */
  onSetDestination?: (selection: LocationSelection) => void;
  /** The most recently calculated commute, used to glow the route + fit the map to it. */
  commuteResult?: RouteSummary | null;
}

// maplibre-gl's worker script imports a sibling chunk via a relative path;
// Turbopack's asset pipeline copies only the one file it's told about, so
// that import 404s and tiles silently never load. Both files are copied
// into public/ (see scripts/copy-maplibre-worker.mjs) and served verbatim,
// co-located, so the worker's relative import resolves correctly.
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

const LINES_SOURCE_ID = "ttc-lines";
const LINES_CASING_LAYER_ID = "ttc-lines-casing";
const LINES_LAYER_ID = "ttc-lines-layer";
const SLOW_ZONES_SOURCE_ID = "ttc-slow-zones";
const SLOW_ZONES_LAYER_ID = "ttc-slow-zones-layer";
const DISRUPTIONS_SOURCE_ID = "ttc-disruptions";
const DISRUPTIONS_GLOW_LAYER_ID = "ttc-disruptions-glow";
const DISRUPTIONS_LAYER_ID = "ttc-disruptions-layer";
const ROUTE_SOURCE_ID = "ttc-route-highlight";
const ROUTE_GLOW_LAYER_ID = "ttc-route-highlight-glow";
const ROUTE_LINE_LAYER_ID = "ttc-route-highlight-line";
// Drawn instead of the ROUTE_* layers above whenever the backend's
// multi-modal router (router.py) returned a real walk+transit itinerary,
// e.g. a cross-line or off-subway-network trip the subway-only fast path
// can't model as a single straight line.
const ITINERARY_SOURCE_ID = "ttc-itinerary";
const ITINERARY_TRANSIT_CASING_LAYER_ID = "ttc-itinerary-transit-casing";
const ITINERARY_TRANSIT_LAYER_ID = "ttc-itinerary-transit";
const ITINERARY_WALK_LAYER_ID = "ttc-itinerary-walk";
const STATIONS_SOURCE_ID = "ttc-stations";
const STATIONS_LAYER_ID = "ttc-stations-layer";
const ENDPOINTS_SOURCE_ID = "ttc-route-endpoints";
const ENDPOINTS_GLOW_LAYER_ID = "ttc-route-endpoints-glow";
const ENDPOINTS_LAYER_ID = "ttc-route-endpoints-layer";
const STREETCARS_SOURCE_ID = "ttc-streetcars";
const STREETCARS_LAYER_ID = "streetcar-line";
const DAY_BUSES_SOURCE_ID = "ttc-day-buses";
const DAY_BUSES_LAYER_ID = "day-buses";
const NIGHT_BUSES_SOURCE_ID = "ttc-night-buses";
const NIGHT_BUSES_LAYER_ID = "night-bus-line";
const SURFACE_STOPS_SOURCE_ID = "ttc-surface-stops";
// Split per network (rather than one shared stops layer) so each network's
// checkbox can toggle its own stops independently of the other's.
const STREETCAR_STOPS_HALO_LAYER_ID = "streetcar-stops-halo";
const STREETCAR_STOPS_LAYER_ID = "streetcar-stops";
const NIGHT_BUS_STOPS_HALO_LAYER_ID = "night-bus-stops-halo";
const NIGHT_BUS_STOPS_LAYER_ID = "night-bus-stops";

// Layers grouped by the map-layer toggle that controls them.
const SUBWAY_LAYER_IDS = [
  LINES_CASING_LAYER_ID,
  LINES_LAYER_ID,
  STATIONS_LAYER_ID,
  SLOW_ZONES_LAYER_ID,
  DISRUPTIONS_GLOW_LAYER_ID,
  DISRUPTIONS_LAYER_ID,
];
const STREETCAR_LAYER_IDS = [STREETCARS_LAYER_ID, STREETCAR_STOPS_HALO_LAYER_ID, STREETCAR_STOPS_LAYER_ID];
// No dedicated stops layer for day buses — this is a line-only overlay
// (see addDayBusLayer), unlike streetcars/night buses.
const DAY_BUS_LAYER_IDS = [DAY_BUSES_LAYER_ID];
const NIGHT_BUS_LAYER_IDS = [NIGHT_BUSES_LAYER_ID, NIGHT_BUS_STOPS_HALO_LAYER_ID, NIGHT_BUS_STOPS_LAYER_ID];

const DAY_BUS_COLOR = "#2563EB";
const NIGHT_BUS_COLOR = "#2A4365";
const SURFACE_STOP_COLOR = "#BA0C2F";

// Official TTC subway line colors (see project CLAUDE.md), keyed by the
// route's GTFS short_name — the same string router.py surfaces as an
// itinerary leg's routeShortName. Buses and streetcars both render in TTC's
// surface-transit red, matching SURFACE_STOP_COLOR above.
const SUBWAY_LINE_COLORS: Record<string, string> = {
  "1": "#FFD200",
  "2": "#009A44",
  "4": "#A05EB5",
  "5": "#F58220",
  "6": "#8A8D8F",
};
const SURFACE_TRANSIT_COLOR = SURFACE_STOP_COLOR;
const WALK_LEG_COLOR = "#9CA3AF";

// Zoom-scaled width/opacity for the two surface networks — kept far below
// subway's stroke width (see LINES_LAYER_ID) so subway always reads as the
// visually dominant network, with a "case" arm reserved for the currently
// hovered feature (see highlightSurfaceRoute below).
// maplibre-gl's own .d.ts doesn't publicly export its style expression types
// (they live in an internal @maplibre/maplibre-gl-style-spec type not
// re-exported under the `maplibregl` namespace), so a precise annotation
// isn't reachable here; the runtime shape is a standard MapLibre style-spec
// expression, validated by MapLibre itself at addLayer()/setPaintProperty() time.
// Stations named here render 1.3x the standard radius so the busiest
// interchanges stand out immediately, even at a glance.
const MAJOR_INTERCHANGE_STATION_IDS = ["bloor-yonge", "st-george", "union"];
const MAJOR_INTERCHANGE_RADIUS_MULTIPLIER = 1.3;

/* eslint-disable @typescript-eslint/no-explicit-any */
const STREETCAR_WIDTH_EXPRESSION: any = ["interpolate", ["linear"], ["zoom"], 10, 0.75, 12, 1.2, 14, 2.0];
const STREETCAR_OPACITY_EXPRESSION: any = ["interpolate", ["linear"], ["zoom"], 10, 0.35, 12, 0.55, 14, 0.8];
// ~150 routes' worth of lines — a thin 1px hairline below zoom 12 (still
// rendered from DAY_BUSES_MIN_ZOOM up, see addDayBusLayer) so the network is
// visible right at the app's default zoom without reading as visual noise,
// then thickens as the rider zooms into individual routes.
const DAY_BUS_WIDTH_EXPRESSION: any = ["interpolate", ["linear"], ["zoom"], 10, 1.0, 12, 1.5, 16, 3.5];
const NIGHT_BUS_WIDTH_EXPRESSION: any = ["interpolate", ["linear"], ["zoom"], 10, 0.75, 12, 1.0, 14, 1.6];
const NIGHT_BUS_OPACITY_EXPRESSION: any = STREETCAR_OPACITY_EXPRESSION;
const IS_MAJOR_INTERCHANGE_EXPRESSION: any = [
  "in",
  ["get", "id"],
  ["literal", MAJOR_INTERCHANGE_STATION_IDS],
];
// MapLibre only allows one zoom-based step/interpolate subexpression per
// paint property, so the major-interchange multiplier has to live *inside*
// each of this step expression's per-tier output values (as a "case"), not
// wrapped around the whole thing — otherwise addLayer() rejects it outright.
function _stationRadiusForTier(base: number): unknown {
  return ["case", IS_MAJOR_INTERCHANGE_EXPRESSION, base * MAJOR_INTERCHANGE_RADIUS_MULTIPLIER, base];
}
// Zoom < 12: 4px / 1.5px border. Zoom 12-14: 6px / 2px. Zoom > 14: 8px / 2.5px.
const STATION_RADIUS_EXPRESSION: any = [
  "step",
  ["zoom"],
  _stationRadiusForTier(4),
  12,
  _stationRadiusForTier(6),
  14,
  _stationRadiusForTier(8),
];
const STATION_STROKE_WIDTH_EXPRESSION: any = ["step", ["zoom"], 1.5, 12, 2, 14, 2.5];
/* eslint-enable @typescript-eslint/no-explicit-any */

// How long a touch must be held before it counts as a long-press (opens the
// "Set as Origin"/"Set as Destination" pin-drop menu) rather than the start
// of a pan/drag gesture.
const LONG_PRESS_MS = 550;

const HOVERED_SURFACE_LINE_WIDTH = 3.0;
const HOVERED_SURFACE_LINE_OPACITY = 1.0;
const DIMMED_SURFACE_LINE_OPACITY = 0.2;

// Below this, the full ~150-route day-bus network would draw as visual
// noise over half the city at once; the layer simply doesn't render until
// the rider has zoomed in enough for individual routes to be legible. Kept
// at/below the app's default zoom (11.5, see DEFAULT_MAP_ZOOM) so the
// network is already visible on load once the toggle is checked, rather
// than only appearing after the rider manually zooms in further.
const DAY_BUSES_MIN_ZOOM = 10;

// Applied to every background transit layer (subway, streetcar, day/night
// bus, stations) while a detour is being viewed (see the viewedDetour
// effect below) — isolates the rerouted corridor by fading everything else
// out rather than hiding it outright, so the surrounding network stays
// visible for context.
const DETOUR_VIEW_DIMMED_OPACITY = 0.15;

const DETOUR_EFFECT_LABELS: Record<DetourSummary["effect"], string> = {
  DETOUR: "Detour — bypassed",
  MODIFIED_SERVICE: "Modified service",
  NO_SERVICE: "No service",
};

interface LayerVisibility {
  subways: boolean;
  streetcars: boolean;
  dayBuses: boolean;
  nightBuses: boolean;
}

// TTC's Blue Night network uses the 300-399 route-number range (matching
// backend/scripts/ingest_surface_gtfs.py's own NIGHT_BUS_RANGE) — an
// ordinary daytime bus leg (e.g. "29") shares CommuteStep's generic "bus"
// mode with a night one (e.g. "320"), so the mode alone can't tell them
// apart (see the commuteResult layer-auto-sync below).
function isNightBusRouteNumber(routeNumber: string): boolean {
  const numeric = Number(routeNumber);
  return !Number.isNaN(numeric) && numeric >= 300 && numeric < 400;
}

// Subways, streetcars, and day buses shown by default; night buses stay
// opt-in — they're only relevant during the overnight window most visitors
// aren't browsing in. Day buses used to default off too (the full ~150-route
// network is the heaviest layer to render, see DAY_BUSES_MIN_ZOOM), but the
// lazy-fetch effect below already keeps that cost paid only once per
// session regardless of whether it's on by default or toggled on later.
const DEFAULT_LAYER_VISIBILITY: LayerVisibility = {
  subways: true,
  streetcars: true,
  dayBuses: true,
  nightBuses: false,
};

const EMPTY_FEATURE_COLLECTION: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

const LAYER_TOGGLE_OPTIONS: Array<{
  key: keyof LayerVisibility;
  label: string;
  swatchClassName: string;
}> = [
  { key: "subways", label: "Subways", swatchClassName: "bg-neutral-700 dark:bg-neutral-300" },
  { key: "streetcars", label: "Streetcars", swatchClassName: "bg-red-800" },
  { key: "dayBuses", label: "Day Buses", swatchClassName: "bg-blue-600" },
  { key: "nightBuses", label: "Night Buses", swatchClassName: "bg-indigo-900" },
];

const lineMetaById: Map<number, (typeof linesGeoJSON.features)[number]["properties"]> = new Map(
  linesGeoJSON.features.map((f) => [f.properties.lineId, f.properties])
);

function buildPopupContent(
  station: { name: string; lines: number[]; lon: number; lat: number },
  onSelectDeparture: (selection: LocationSelection) => void
): HTMLElement {
  const container = document.createElement("div");
  container.className = "min-w-[170px] p-1";

  const title = document.createElement("p");
  title.className = "mb-2 font-bold text-neutral-900";
  title.textContent = formatStationLabel(station.name);
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
  button.addEventListener("click", () =>
    onSelectDeparture({ name: formatStationLabel(station.name), lat: station.lat, lon: station.lon })
  );
  container.appendChild(button);

  return container;
}

/** The "Set as Origin" / "Set as Destination" menu shown on a right-click or
 * long-press anywhere on the map (see the contextmenu/touchstart handlers
 * below) — lets a rider drop a pin at an arbitrary point, not just a
 * station, and use it as a commute endpoint. */
function buildPinContextMenuContent(onSetOrigin: () => void, onSetDestination: () => void): HTMLElement {
  const container = document.createElement("div");
  container.className = "flex min-w-[170px] flex-col gap-0.5 p-1";

  const originButton = document.createElement("button");
  originButton.type = "button";
  originButton.className =
    "w-full rounded-lg px-3 py-1.5 text-left text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-50";
  originButton.textContent = "📍 Set as Origin";
  originButton.addEventListener("click", onSetOrigin);
  container.appendChild(originButton);

  const destinationButton = document.createElement("button");
  destinationButton.type = "button";
  destinationButton.className =
    "w-full rounded-lg px-3 py-1.5 text-left text-xs font-semibold text-red-700 transition-colors hover:bg-red-50";
  destinationButton.textContent = "🏁 Set as Destination";
  destinationButton.addEventListener("click", onSetDestination);
  container.appendChild(destinationButton);

  return container;
}

function buildDisruptionTooltipContent(properties: { headline: string; description: string }): HTMLElement {
  const container = document.createElement("div");
  container.className = "max-w-[240px] p-1";

  const badge = document.createElement("span");
  badge.className =
    "mb-1 inline-block rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white";
  badge.textContent = "Service Disruption";
  container.appendChild(badge);

  const headline = document.createElement("p");
  headline.className = "mt-1 text-xs font-semibold text-neutral-900";
  headline.textContent = properties.headline;
  container.appendChild(headline);

  const description = document.createElement("p");
  description.className = "mt-1 text-[11px] leading-snug text-neutral-600";
  description.textContent = properties.description;
  container.appendChild(description);

  return container;
}

function addBaseLineLayer(map: maplibregl.Map) {
  if (!map.getSource(LINES_SOURCE_ID)) {
    map.addSource(LINES_SOURCE_ID, { type: "geojson", data: linesGeoJSON });
  }
  // A dark casing beneath the official line color keeps subway readable and
  // crisp against the basemap — and, now that the surface networks render
  // far thinner (see STREETCAR/NIGHT_BUS width expressions), keeps subway
  // unambiguously the visually dominant layer at every zoom.
  if (!map.getLayer(LINES_CASING_LAYER_ID)) {
    map.addLayer({
      id: LINES_CASING_LAYER_ID,
      type: "line",
      source: LINES_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#111827",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 5.0, 14, 6.5],
      },
    });
  }
  if (!map.getLayer(LINES_LAYER_ID)) {
    map.addLayer({
      id: LINES_LAYER_ID,
      type: "line",
      source: LINES_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "colorHex"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3.5, 14, 5],
      },
    });
  }
}

function addSlowZoneLayer(map: maplibregl.Map, data: GeoJSON.FeatureCollection) {
  if (!map.getSource(SLOW_ZONES_SOURCE_ID)) {
    map.addSource(SLOW_ZONES_SOURCE_ID, { type: "geojson", data });
  }
  if (!map.getLayer(SLOW_ZONES_LAYER_ID)) {
    map.addLayer({
      id: SLOW_ZONES_LAYER_ID,
      type: "line",
      source: SLOW_ZONES_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#f59e0b",
        "line-width": 5,
        // Explicit 0 (MapLibre's own default) so this stays a color
        // override centered directly on the track, not a detached parallel
        // line — the real fix is the source geometry above matching the
        // base line's curve exactly; this just documents the intent.
        "line-offset": 0,
        "line-dasharray": [3, 2],
        "line-opacity": 0.95,
      },
    });
  }
}

function addDisruptionLayers(map: maplibregl.Map, data: GeoJSON.FeatureCollection) {
  if (!map.getSource(DISRUPTIONS_SOURCE_ID)) {
    map.addSource(DISRUPTIONS_SOURCE_ID, { type: "geojson", data });
  }
  if (!map.getLayer(DISRUPTIONS_GLOW_LAYER_ID)) {
    map.addLayer({
      id: DISRUPTIONS_GLOW_LAYER_ID,
      type: "line",
      source: DISRUPTIONS_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#dc2626", "line-width": 14, "line-blur": 6, "line-opacity": 0.35 },
    });
  }
  if (!map.getLayer(DISRUPTIONS_LAYER_ID)) {
    map.addLayer({
      id: DISRUPTIONS_LAYER_ID,
      type: "line",
      source: DISRUPTIONS_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#dc2626",
        "line-width": 6,
        "line-dasharray": [0.2, 1.6],
        "line-opacity": 1,
      },
    });
  }
}

function setLayersVisible(map: maplibregl.Map, layerIds: string[], visible: boolean) {
  for (const id of layerIds) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  }
}

function applyLayerVisibility(map: maplibregl.Map, visibility: LayerVisibility) {
  setLayersVisible(map, SUBWAY_LAYER_IDS, visibility.subways);
  setLayersVisible(map, STREETCAR_LAYER_IDS, visibility.streetcars);
  setLayersVisible(map, DAY_BUS_LAYER_IDS, visibility.dayBuses);
  setLayersVisible(map, NIGHT_BUS_LAYER_IDS, visibility.nightBuses);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mixes bare numbers with the STREETCAR/NIGHT_BUS zoom-interpolated opacity expressions
type PaintValue = any;

/** Every background transit layer dimmed while a detour is being viewed (see
 * the viewedDetour effect) — each entry's `normal` is that layer's own
 * un-dimmed opacity value/expression, exactly as set where the layer is
 * first added, so restoring is just replaying it. */
const BACKGROUND_DIM_TARGETS: Array<{ layerId: string; property: "line-opacity" | "circle-opacity"; normal: PaintValue }> = [
  { layerId: LINES_CASING_LAYER_ID, property: "line-opacity", normal: 1 },
  { layerId: LINES_LAYER_ID, property: "line-opacity", normal: 1 },
  { layerId: STATIONS_LAYER_ID, property: "circle-opacity", normal: 1 },
  { layerId: SLOW_ZONES_LAYER_ID, property: "line-opacity", normal: 0.95 },
  { layerId: DISRUPTIONS_GLOW_LAYER_ID, property: "line-opacity", normal: 0.35 },
  { layerId: DISRUPTIONS_LAYER_ID, property: "line-opacity", normal: 1 },
  { layerId: STREETCARS_LAYER_ID, property: "line-opacity", normal: STREETCAR_OPACITY_EXPRESSION },
  { layerId: STREETCAR_STOPS_HALO_LAYER_ID, property: "circle-opacity", normal: 0.35 },
  { layerId: STREETCAR_STOPS_LAYER_ID, property: "circle-opacity", normal: 1 },
  { layerId: DAY_BUSES_LAYER_ID, property: "line-opacity", normal: 1 },
  { layerId: NIGHT_BUSES_LAYER_ID, property: "line-opacity", normal: NIGHT_BUS_OPACITY_EXPRESSION },
  { layerId: NIGHT_BUS_STOPS_HALO_LAYER_ID, property: "circle-opacity", normal: 0.35 },
  { layerId: NIGHT_BUS_STOPS_LAYER_ID, property: "circle-opacity", normal: 1 },
];

/** Fades every base network layer to DETOUR_VIEW_DIMMED_OPACITY (dimmed) or
 * back to its own normal opacity (restored) — used to isolate the corridor
 * a selected detour affects without hiding the rest of the network outright. */
function setBackgroundLayersDimmed(map: maplibregl.Map, dimmed: boolean) {
  for (const { layerId, property, normal } of BACKGROUND_DIM_TARGETS) {
    if (map.getLayer(layerId)) {
      map.setPaintProperty(layerId, property, dimmed ? DETOUR_VIEW_DIMMED_OPACITY : normal);
    }
  }
}

function addStreetcarLayer(map: maplibregl.Map, data: GeoJSON.FeatureCollection, visible: boolean) {
  if (!map.getSource(STREETCARS_SOURCE_ID)) {
    map.addSource(STREETCARS_SOURCE_ID, { type: "geojson", data });
  }
  if (!map.getLayer(STREETCARS_LAYER_ID)) {
    // No casing here (unlike subway) — a border around every streetcar
    // corridor would merge parallel/overlapping routes into a solid block
    // of color at low zoom, which is exactly what thinner lines are meant
    // to avoid.
    map.addLayer({
      id: STREETCARS_LAYER_ID,
      type: "line",
      source: STREETCARS_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round", visibility: visible ? "visible" : "none" },
      paint: {
        "line-color": ["get", "colorHex"],
        "line-width": STREETCAR_WIDTH_EXPRESSION,
        "line-opacity": STREETCAR_OPACITY_EXPRESSION,
      },
    });
  }
}

function addDayBusLayer(map: maplibregl.Map, data: GeoJSON.FeatureCollection, visible: boolean) {
  if (!map.getSource(DAY_BUSES_SOURCE_ID)) {
    map.addSource(DAY_BUSES_SOURCE_ID, { type: "geojson", data });
  }
  if (!map.getLayer(DAY_BUSES_LAYER_ID)) {
    map.addLayer({
      id: DAY_BUSES_LAYER_ID,
      type: "line",
      source: DAY_BUSES_SOURCE_ID,
      minzoom: DAY_BUSES_MIN_ZOOM,
      layout: { "line-cap": "round", "line-join": "round", visibility: visible ? "visible" : "none" },
      paint: {
        "line-color": DAY_BUS_COLOR,
        "line-width": DAY_BUS_WIDTH_EXPRESSION,
      },
    });
  }
}

function addNightBusLayer(map: maplibregl.Map, data: GeoJSON.FeatureCollection, visible: boolean) {
  if (!map.getSource(NIGHT_BUSES_SOURCE_ID)) {
    map.addSource(NIGHT_BUSES_SOURCE_ID, { type: "geojson", data });
  }
  if (!map.getLayer(NIGHT_BUSES_LAYER_ID)) {
    map.addLayer({
      id: NIGHT_BUSES_LAYER_ID,
      type: "line",
      source: NIGHT_BUSES_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round", visibility: visible ? "visible" : "none" },
      paint: {
        "line-color": NIGHT_BUS_COLOR,
        "line-width": NIGHT_BUS_WIDTH_EXPRESSION,
        "line-opacity": NIGHT_BUS_OPACITY_EXPRESSION,
        "line-dasharray": [3, 2],
      },
    });
  }
}

function addSurfaceStopsLayer(
  map: maplibregl.Map,
  data: GeoJSON.FeatureCollection,
  visibility: { streetcars: boolean; nightBuses: boolean }
) {
  if (!map.getSource(SURFACE_STOPS_SOURCE_ID)) {
    map.addSource(SURFACE_STOPS_SOURCE_ID, { type: "geojson", data });
  }

  const networks: Array<{
    network: "streetcar" | "night_bus";
    haloLayerId: string;
    layerId: string;
    visible: boolean;
  }> = [
    {
      network: "streetcar",
      haloLayerId: STREETCAR_STOPS_HALO_LAYER_ID,
      layerId: STREETCAR_STOPS_LAYER_ID,
      visible: visibility.streetcars,
    },
    {
      network: "night_bus",
      haloLayerId: NIGHT_BUS_STOPS_HALO_LAYER_ID,
      layerId: NIGHT_BUS_STOPS_LAYER_ID,
      visible: visibility.nightBuses,
    },
  ];

  for (const { network, haloLayerId, layerId, visible } of networks) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the STREETCAR/NIGHT_BUS expression constants above
    const servesNetwork: any = ["in", network, ["get", "networks"]];
    const visibilityValue = visible ? "visible" : "none";

    // A soft amber halo under interchange stops, so a transfer point stands
    // out from an ordinary stop without needing a whole separate icon.
    // minzoom 15 (not city-wide) — these stop coordinates are the nearest
    // surface stop to a subway station, not necessarily right outside its
    // entrance, so at low zoom they land off to one side of the station
    // marker and read as visual clutter rather than useful detail.
    if (!map.getLayer(haloLayerId)) {
      map.addLayer({
        id: haloLayerId,
        type: "circle",
        source: SURFACE_STOPS_SOURCE_ID,
        minzoom: 15.0,
        filter: ["all", servesNetwork, ["==", ["get", "isInterchange"], true]],
        layout: { visibility: visibilityValue },
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, 5, 17, 7],
          "circle-color": "#fbbf24",
          "circle-opacity": 0.35,
          "circle-blur": 0.6,
        },
      });
    }
    if (!map.getLayer(layerId)) {
      map.addLayer({
        id: layerId,
        type: "circle",
        source: SURFACE_STOPS_SOURCE_ID,
        minzoom: 15.0,
        filter: servesNetwork,
        layout: { visibility: visibilityValue },
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, 1.8, 17, 3.0],
          "circle-color": SURFACE_STOP_COLOR,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
        },
      });
    }
  }
}

/** Elevates the hovered surface route to full opacity/3px width and dims
 * every other streetcar/night-bus line to 0.2 opacity, across both layers.
 *
 * MapLibre requires a zoom expression to be the top-level expression (or
 * nested inside a top-level "step"/"interpolate" — matching the
 * STATION_RADIUS_EXPRESSION pattern above): wrapping "case" around the
 * whole zoom-based width expression, as this used to do, throws
 * `"zoom" expression may only be used as input to a top-level "step" or
 * "interpolate" expression` the moment a route is hovered. The fix keeps
 * "interpolate"/["zoom"] at the top and moves the hover "case" inside each
 * zoom stop's output value instead. */
function highlightSurfaceRoute(map: maplibregl.Map, routeId: string, direction: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the STREETCAR/NIGHT_BUS expression constants above
  const isHovered: any = [
    "all",
    ["==", ["get", "routeId"], routeId],
    ["==", ["get", "direction"], direction],
  ];

  map.setPaintProperty(STREETCARS_LAYER_ID, "line-width", [
    "interpolate",
    ["linear"],
    ["zoom"],
    10,
    ["case", isHovered, HOVERED_SURFACE_LINE_WIDTH, 0.75],
    12,
    ["case", isHovered, HOVERED_SURFACE_LINE_WIDTH, 1.2],
    14,
    ["case", isHovered, HOVERED_SURFACE_LINE_WIDTH, 2.0],
  ]);
  map.setPaintProperty(STREETCARS_LAYER_ID, "line-opacity", [
    "case",
    isHovered,
    HOVERED_SURFACE_LINE_OPACITY,
    DIMMED_SURFACE_LINE_OPACITY,
  ]);

  map.setPaintProperty(NIGHT_BUSES_LAYER_ID, "line-width", [
    "interpolate",
    ["linear"],
    ["zoom"],
    10,
    ["case", isHovered, HOVERED_SURFACE_LINE_WIDTH, 0.75],
    12,
    ["case", isHovered, HOVERED_SURFACE_LINE_WIDTH, 1.0],
    14,
    ["case", isHovered, HOVERED_SURFACE_LINE_WIDTH, 1.6],
  ]);
  map.setPaintProperty(NIGHT_BUSES_LAYER_ID, "line-opacity", [
    "case",
    isHovered,
    HOVERED_SURFACE_LINE_OPACITY,
    DIMMED_SURFACE_LINE_OPACITY,
  ]);
}

function clearSurfaceRouteHighlight(map: maplibregl.Map) {
  map.setPaintProperty(STREETCARS_LAYER_ID, "line-width", STREETCAR_WIDTH_EXPRESSION);
  map.setPaintProperty(STREETCARS_LAYER_ID, "line-opacity", STREETCAR_OPACITY_EXPRESSION);
  map.setPaintProperty(NIGHT_BUSES_LAYER_ID, "line-width", NIGHT_BUS_WIDTH_EXPRESSION);
  map.setPaintProperty(NIGHT_BUSES_LAYER_ID, "line-opacity", NIGHT_BUS_OPACITY_EXPRESSION);
}

interface SurfaceRouteTooltipEntry {
  routeShortName: string;
  routeLongName: string;
  /** A genuinely lettered branch (504A/504B, a 512B replacement-bus
   * reroute) — when set (with `headsign`), the entry names this specific
   * branch instead of just the bare route number every branch shares. */
  branchCode?: string | null;
  headsign?: string;
}

/** A shared corridor (e.g. Queens Quay East, where routes 114 and 97C both
 * run) stacks several different routes' LineStrings on the same pixels —
 * MapLibre's hit-test returns all of them in `event.features`, so a popup
 * built from just the first one silently drops whichever routes happened
 * to hit-test underneath it. Renders one line per distinct route instead,
 * all sharing `networkLabel` since every entry here always comes from a
 * single layer's own event (see the mousemove handlers below) — a
 * streetcar layer's features are never mixed with a day-bus layer's. */
function buildSurfaceRouteTooltipContent(entries: SurfaceRouteTooltipEntry[], networkLabel: string): HTMLElement {
  const container = document.createElement("div");
  container.className = "flex flex-col gap-1 p-1";
  for (const entry of entries) {
    const text = document.createElement("p");
    text.className = "text-xs font-semibold text-neutral-900";
    const label =
      entry.branchCode && entry.headsign ? entry.headsign : `${entry.routeShortName} ${entry.routeLongName}`;
    text.textContent = `${label} ${networkLabel}`;
    container.appendChild(text);
  }
  return container;
}

/** Keeps just the first feature seen per distinct `routeShortName` from a
 * hover/click hit-test — several different routes sharing a corridor (114
 * and 97C on Queens Quay East, say) all show up in `event.features` at
 * once, but a single route can also appear more than once in there (its
 * shape crossing itself, or adjacent segments both under the cursor), which
 * would otherwise list the same route twice. */
function dedupeSurfaceRouteFeatures<T extends { properties: { routeShortName: string } }>(features: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const feature of features) {
    const routeShortName = feature.properties.routeShortName;
    if (seen.has(routeShortName)) continue;
    seen.add(routeShortName);
    deduped.push(feature);
  }
  return deduped;
}

function buildSurfaceStopTooltipContent(properties: { name: string; routes: string[] | string }): HTMLElement {
  const routes = Array.isArray(properties.routes)
    ? properties.routes
    : (JSON.parse(properties.routes as string) as string[]);

  const container = document.createElement("div");
  container.className = "max-w-[220px] p-1";

  const name = document.createElement("p");
  name.className = "text-xs font-semibold text-neutral-900";
  name.textContent = properties.name;
  container.appendChild(name);

  const routesLine = document.createElement("p");
  routesLine.className = "mt-0.5 text-[11px] text-neutral-600";
  routesLine.textContent = `Routes: ${routes.join(", ")}`;
  container.appendChild(routesLine);

  return container;
}

/** A red ring with a diagonal slash through it — the warning marker dropped
 * on each stop a selected detour names as closed/bypassed (see the
 * viewedDetour effect). Built as a plain DOM node (maplibregl.Marker takes
 * one directly, like the origin/destination pins in placePin below) and
 * styled entirely with Tailwind utility classes per the project's no-inline-CSS rule. */
function createDetourStopMarkerElement(): HTMLDivElement {
  const el = document.createElement("div");
  el.className =
    "flex h-6 w-6 items-center justify-center rounded-full border-2 border-red-600 bg-red-600/25 shadow-[0_0_0_2px_rgba(255,255,255,0.9)]";
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", "Closed or bypassed stop");
  const slash = document.createElement("span");
  slash.className = "block h-[2px] w-4 rotate-45 rounded-full bg-red-600";
  el.appendChild(slash);
  return el;
}

function buildDetourStopTooltipContent(properties: { name: string; effectLabel: string }): HTMLElement {
  const container = document.createElement("div");
  container.className = "max-w-[220px] p-1";

  const name = document.createElement("p");
  name.className = "text-xs font-semibold text-neutral-900";
  name.textContent = properties.name;
  container.appendChild(name);

  const effect = document.createElement("p");
  effect.className = "mt-0.5 text-[11px] font-medium text-red-600";
  effect.textContent = properties.effectLabel;
  container.appendChild(effect);

  return container;
}

function addRouteHighlightLayers(map: maplibregl.Map, data: GeoJSON.FeatureCollection) {
  if (!map.getSource(ROUTE_SOURCE_ID)) {
    map.addSource(ROUTE_SOURCE_ID, { type: "geojson", data });
  }
  // A dark casing beneath the line's own official TTC color (e.g. Line 1's
  // #F8C300) keeps it legible against the basemap — matching the base
  // subway network's own casing+color treatment (see addBaseLineLayer)
  // rather than the blurred glow + white overlay this used to be, which hid
  // the actual line color entirely. Solid, never dashed or animated.
  if (!map.getLayer(ROUTE_GLOW_LAYER_ID)) {
    map.addLayer({
      id: ROUTE_GLOW_LAYER_ID,
      type: "line",
      source: ROUTE_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#111827", "line-width": 8 },
    });
  }
  if (!map.getLayer(ROUTE_LINE_LAYER_ID)) {
    map.addLayer({
      id: ROUTE_LINE_LAYER_ID,
      type: "line",
      source: ROUTE_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "colorHex"], "line-width": 5 },
    });
  }
}

function addItineraryLayers(map: maplibregl.Map, data: GeoJSON.FeatureCollection) {
  if (!map.getSource(ITINERARY_SOURCE_ID)) {
    map.addSource(ITINERARY_SOURCE_ID, { type: "geojson", data });
  }
  /* eslint-disable @typescript-eslint/no-explicit-any -- see the STREETCAR/NIGHT_BUS expression constants above */
  const isWalkLeg: any = ["==", ["get", "mode"], "walk"];
  const isTransitLeg: any = ["!=", ["get", "mode"], "walk"];
  /* eslint-enable @typescript-eslint/no-explicit-any */

  if (!map.getLayer(ITINERARY_TRANSIT_CASING_LAYER_ID)) {
    map.addLayer({
      id: ITINERARY_TRANSIT_CASING_LAYER_ID,
      type: "line",
      source: ITINERARY_SOURCE_ID,
      filter: isTransitLeg,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#111827", "line-width": 6 },
    });
  }
  if (!map.getLayer(ITINERARY_TRANSIT_LAYER_ID)) {
    map.addLayer({
      id: ITINERARY_TRANSIT_LAYER_ID,
      type: "line",
      source: ITINERARY_SOURCE_ID,
      filter: isTransitLeg,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "colorHex"], "line-width": 4 },
    });
  }
  // A crisp, thin dashed line for each walk leg (origin -> first stop, a
  // transfer, or the last stop -> destination) — deliberately thinner than
  // the solid transit legs' 4px (see ITINERARY_TRANSIT_LAYER_ID) so it never
  // reads as another track, drawn on top of them since walk legs are short
  // and would otherwise be hard to spot under a casing.
  if (!map.getLayer(ITINERARY_WALK_LAYER_ID)) {
    map.addLayer({
      id: ITINERARY_WALK_LAYER_ID,
      type: "line",
      source: ITINERARY_SOURCE_ID,
      filter: isWalkLeg,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": WALK_LEG_COLOR, "line-width": 2, "line-dasharray": [1.5, 1.5] },
    });
  }
}

function addStationsLayer(map: maplibregl.Map) {
  if (!map.getSource(STATIONS_SOURCE_ID)) {
    map.addSource(STATIONS_SOURCE_ID, { type: "geojson", data: stationsGeoJSON });
  }
  if (!map.getLayer(STATIONS_LAYER_ID)) {
    map.addLayer({
      id: STATIONS_LAYER_ID,
      type: "circle",
      source: STATIONS_SOURCE_ID,
      paint: {
        "circle-radius": STATION_RADIUS_EXPRESSION,
        "circle-color": "#FFFFFF",
        "circle-stroke-color": "#111111",
        "circle-stroke-width": STATION_STROKE_WIDTH_EXPRESSION,
      },
    });
  }
}

function addEndpointHighlightLayers(map: maplibregl.Map, data: GeoJSON.FeatureCollection) {
  if (!map.getSource(ENDPOINTS_SOURCE_ID)) {
    map.addSource(ENDPOINTS_SOURCE_ID, { type: "geojson", data });
  }
  if (!map.getLayer(ENDPOINTS_GLOW_LAYER_ID)) {
    map.addLayer({
      id: ENDPOINTS_GLOW_LAYER_ID,
      type: "circle",
      source: ENDPOINTS_SOURCE_ID,
      paint: {
        "circle-radius": 18,
        "circle-color": ["match", ["get", "role"], "origin", "#34d399", "#f87171"],
        "circle-blur": 0.9,
        "circle-opacity": 0.65,
      },
    });
  }
  if (!map.getLayer(ENDPOINTS_LAYER_ID)) {
    map.addLayer({
      id: ENDPOINTS_LAYER_ID,
      type: "circle",
      source: ENDPOINTS_SOURCE_ID,
      paint: {
        "circle-radius": 8,
        "circle-color": ["match", ["get", "role"], "origin", "#10b981", "#ef4444"],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    });
  }
}

function itineraryLegColor(leg: RouteSummary["itinerary"][number]): string {
  if (leg.mode === "subway") {
    return (leg.routeShortName && SUBWAY_LINE_COLORS[leg.routeShortName]) || "#ffffff";
  }
  return SURFACE_TRANSIT_COLOR;
}

/** The canonical station coordinate for `name` when it names one (the
 * backend reports a clean canonical name for a subway/streetcar/bus leg's
 * station end — see traffic_service.py's station-name cleanup), otherwise
 * `fallback` unchanged. A leg's path ends on the specific stop/platform it
 * actually boarded/alighted at, which can sit slightly off that station's
 * single map marker — or, on a curved line like Line 1's loop through
 * Union, slightly past it into the loop's tail — so the itinerary's very
 * first/last rendered point is snapped to the same dot the marker uses,
 * keeping the highlighted route's terminus and the endpoint pin pixel-identical. */
function snapToStationCoordinate(name: string, fallback: [number, number]): [number, number] {
  return findStationByName(name)?.coordinates ?? fallback;
}

/** Builds the dashed-walk + solid-transit line layers, plus origin/destination
 * dots, from a router.py itinerary's actual leg coordinates — snapped onto
 * the canonical station coordinate at either end when that leg's endpoint
 * names a known station (see snapToStationCoordinate above). */
function computeItineraryFeatures(result: RouteSummary | null): {
  itinerary: GeoJSON.FeatureCollection;
  endpoints: GeoJSON.FeatureCollection;
  bounds: maplibregl.LngLatBounds | null;
} {
  if (!result || result.itinerary.length === 0) {
    return { itinerary: EMPTY_FEATURE_COLLECTION, endpoints: EMPTY_FEATURE_COLLECTION, bounds: null };
  }

  const firstLeg = result.itinerary[0];
  const lastLeg = result.itinerary[result.itinerary.length - 1];
  const originPoint: [number, number] | undefined = firstLeg.path[0]
    ? snapToStationCoordinate(firstLeg.fromName, firstLeg.path[0])
    : undefined;
  const destinationPoint: [number, number] | undefined = lastLeg.path[lastLeg.path.length - 1]
    ? snapToStationCoordinate(lastLeg.toName, lastLeg.path[lastLeg.path.length - 1])
    : undefined;

  const features: GeoJSON.Feature[] = result.itinerary
    .filter((leg) => leg.path.length > 1)
    .map((leg) => {
      const coordinates = leg.path.map((point) => point as [number, number]);
      if (leg === firstLeg && originPoint) coordinates[0] = originPoint;
      if (leg === lastLeg && destinationPoint) coordinates[coordinates.length - 1] = destinationPoint;
      return {
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates },
        properties: { mode: leg.mode, colorHex: itineraryLegColor(leg) },
      };
    });

  const endpoints: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: [
      ...(originPoint
        ? [
            {
              type: "Feature" as const,
              geometry: { type: "Point" as const, coordinates: originPoint },
              properties: { role: "origin", name: result.origin },
            },
          ]
        : []),
      ...(destinationPoint
        ? [
            {
              type: "Feature" as const,
              geometry: { type: "Point" as const, coordinates: destinationPoint },
              properties: { role: "destination", name: result.destination },
            },
          ]
        : []),
    ],
  };

  let bounds: maplibregl.LngLatBounds | null = null;
  for (const feature of features) {
    for (const coordinate of (feature.geometry as GeoJSON.LineString).coordinates) {
      const point = coordinate as [number, number];
      bounds = bounds ? bounds.extend(point) : new maplibregl.LngLatBounds(point, point);
    }
  }

  return { itinerary: { type: "FeatureCollection", features }, endpoints, bounds };
}

function computeRouteFeatures(result: RouteSummary | null): {
  route: GeoJSON.FeatureCollection;
  endpoints: GeoJSON.FeatureCollection;
  bounds: maplibregl.LngLatBounds | null;
} {
  // The multi-modal itinerary (see computeItineraryFeatures) owns rendering
  // for this result instead — drawing both would double up the endpoint dots.
  if (!result || result.itinerary.length > 0) {
    return { route: EMPTY_FEATURE_COLLECTION, endpoints: EMPTY_FEATURE_COLLECTION, bounds: null };
  }

  const originStation = findStationByName(result.origin);
  const destinationStation = findStationByName(result.destination);
  if (!originStation || !destinationStation) {
    return { route: EMPTY_FEATURE_COLLECTION, endpoints: EMPTY_FEATURE_COLLECTION, bounds: null };
  }

  // getRouteCoordinates always returns stations in ascending line-index
  // order, regardless of which endpoint is actually the origin — reverse
  // when travel runs the other way, so the LineString's point order (and
  // therefore the direction the route-pulse animation appears to flow)
  // always matches origin -> destination.
  const rawCoordinates = getRouteCoordinates(result.line, originStation.id, destinationStation.id);
  const originIndex = getStationIndexOnLine(result.line, originStation.id);
  const destinationIndex = getStationIndexOnLine(result.line, destinationStation.id);
  const coordinates =
    originIndex !== null && destinationIndex !== null && originIndex > destinationIndex
      ? [...rawCoordinates].reverse()
      : rawCoordinates;
  const lineMeta = lineMetaById.get(result.line);

  const route: GeoJSON.FeatureCollection =
    coordinates.length > 1
      ? {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "LineString", coordinates },
              properties: { colorHex: lineMeta?.colorHex ?? "#ffffff" },
            },
          ],
        }
      : EMPTY_FEATURE_COLLECTION;

  // The pin sits wherever the line actually ends, not the station's separate
  // canonical dot (ttc-stations.json) — getRouteCoordinates deliberately
  // slices pure track vertices with no anchoring (see its own comment), so
  // its real endpoint can sit 50-200m from that dot. Following the line's
  // own endpoint keeps the marker glued to the visible track terminus
  // instead of floating off to the side of it; only falls back to the
  // canonical dot when there's no route line to anchor to at all.
  const originPoint = coordinates.length > 0 ? coordinates[0] : originStation.coordinates;
  const destinationPoint = coordinates.length > 0 ? coordinates[coordinates.length - 1] : destinationStation.coordinates;

  const endpoints: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: originPoint },
        properties: { role: "origin", name: originStation.name },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: destinationPoint },
        properties: { role: "destination", name: destinationStation.name },
      },
    ],
  };

  const bounds =
    coordinates.length > 0
      ? coordinates.reduce(
          (acc, coord) => acc.extend(coord),
          new maplibregl.LngLatBounds(coordinates[0], coordinates[0])
        )
      : null;

  return { route, endpoints, bounds };
}

export default function TTCMap({
  className = "",
  onSelectDeparture,
  onSetOrigin,
  onSetDestination,
  commuteResult = null,
}: TTCMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const isDark = useIsDarkMode();
  const hasSetInitialStyleRef = useRef(false);

  // The detour a rider picked "View on Map" for in the header's DetourPanel
  // (a sibling component, see lib/detourMapContext) — drives the warning
  // markers + background dimming effect further down.
  const { viewedDetour, clearViewedDetour } = useDetourMap();
  const detourMarkersRef = useRef<maplibregl.Marker[]>([]);

  const [layerVisibility, setLayerVisibility] = useState<LayerVisibility>(DEFAULT_LAYER_VISIBILITY);
  const layerVisibilityRef = useRef(layerVisibility);

  // A night-network result (e.g. 320 Yonge overnight) is only meaningful in
  // the context of the Blue Night background layer — auto-check that toggle
  // so the checkbox and what's on the map never disagree; a plain daytime
  // bus result gets the same treatment for the Day Buses toggle. This
  // adjusts state during render (React's recommended pattern for "derive
  // state from a prop change") rather than in an effect, since it only
  // needs to run once per actual commuteResult change, not resync an
  // external system every render.
  const [lastSyncedCommuteResult, setLastSyncedCommuteResult] = useState(commuteResult);
  if (commuteResult !== lastSyncedCommuteResult) {
    setLastSyncedCommuteResult(commuteResult);
    // CommuteStep's mode is just "bus" for both networks (see
    // types/traffic.ts) — TTC's own 300-399 Blue Night route-number range
    // (matching backend/scripts/ingest_surface_gtfs.py's NIGHT_BUS_RANGE)
    // is what actually tells a night leg (e.g. "320") apart from an
    // ordinary daytime one (e.g. "29"). Previously this checked mode alone,
    // which meant an everyday daytime-bus commute incorrectly force-enabled
    // the Blue Night overlay instead of (or as well as) Day Buses.
    const usesNightBus =
      commuteResult?.steps.some((step) => step.mode === "bus" && isNightBusRouteNumber(step.routeNumber)) ?? false;
    const usesDayBus =
      commuteResult?.steps.some((step) => step.mode === "bus" && !isNightBusRouteNumber(step.routeNumber)) ?? false;
    if ((usesNightBus && !layerVisibility.nightBuses) || (usesDayBus && !layerVisibility.dayBuses)) {
      setLayerVisibility((previous) => ({
        ...previous,
        nightBuses: previous.nightBuses || usesNightBus,
        dayBuses: previous.dayBuses || usesDayBus,
      }));
    }
  }

  const slowZonesDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FEATURE_COLLECTION);
  const disruptionsDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FEATURE_COLLECTION);
  const streetcarsDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FEATURE_COLLECTION);
  // The full day-bus network is the heaviest payload of any layer here —
  // fetched by its own gated effect (further down) keyed off
  // layerVisibility.dayBuses rather than bundled into the unconditional
  // fetch below, and cached here afterward so toggling it off and back on
  // never re-fetches it. That effect fires as soon as dayBuses is true,
  // which happens immediately on mount now that it's on by default (see
  // DEFAULT_LAYER_VISIBILITY) — this ref just decouples "when the data
  // arrives" from "when the map/source is ready for it" (see style.load
  // below), regardless of which happens first.
  const dayBusesDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FEATURE_COLLECTION);
  const hasFetchedDayBusesRef = useRef(false);
  const nightBusesDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FEATURE_COLLECTION);
  const surfaceStopsDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FEATURE_COLLECTION);
  const routeDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FEATURE_COLLECTION);
  const itineraryDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FEATURE_COLLECTION);
  const endpointsDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FEATURE_COLLECTION);

  // Fetch the (static) streetcar + night-bus networks, and their stops, once on mount.
  useEffect(() => {
    let cancelled = false;

    getStreetcars()
      .then((geojson) => {
        if (cancelled) return;
        streetcarsDataRef.current = geojson;
        (mapRef.current?.getSource(STREETCARS_SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(
          geojson
        );
      })
      .catch(() => {
        // Surface-network overlays are opt-in extras — a failed fetch just
        // leaves that toggle with nothing to show.
      });

    getNightBuses()
      .then((geojson) => {
        if (cancelled) return;
        nightBusesDataRef.current = geojson;
        (mapRef.current?.getSource(NIGHT_BUSES_SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(
          geojson
        );
      })
      .catch(() => {});

    getSurfaceStops()
      .then((geojson) => {
        if (cancelled) return;
        surfaceStopsDataRef.current = geojson;
        (mapRef.current?.getSource(SURFACE_STOPS_SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(
          geojson
        );
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch the day-bus network as soon as "Day Buses" is checked — on by
  // default (see DEFAULT_LAYER_VISIBILITY), so in practice this fires right
  // on mount. Kept as its own gated effect rather than bundled into the one
  // above (which always fetches unconditionally) so a rider who unchecks it
  // doesn't pay for a network the map isn't even showing, and so it still
  // only ever fetches once per session (hasFetchedDayBusesRef) if they
  // uncheck and recheck it later.
  useEffect(() => {
    if (!layerVisibility.dayBuses || hasFetchedDayBusesRef.current) return;
    let cancelled = false;

    getDayBuses()
      .then((geojson) => {
        if (cancelled) return;
        // Claimed only once the fetch actually lands, not before it starts
        // (see below) — this used to be set synchronously right here,
        // which meant React StrictMode's dev-only double-invoke (mount ->
        // cleanup -> mount, run back to back on every first mount) could
        // permanently starve the layer of data: the first invocation
        // claimed the guard and then got cancelled by its own cleanup
        // before the fetch resolved, and the second invocation saw the
        // guard already claimed and never started a fetch of its own —
        // net result, no invocation's data ever lands. Each invocation now
        // tracks its own `cancelled` independently, so whichever one
        // actually finishes claims the guard and applies its data,
        // regardless of StrictMode or fetch-ordering.
        hasFetchedDayBusesRef.current = true;
        dayBusesDataRef.current = geojson;
        (mapRef.current?.getSource(DAY_BUSES_SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(geojson);
      })
      .catch(() => {
        // Guard was never claimed on this path — a later toggle-off/on (or
        // the next render, if still checked) naturally retries.
      });

    return () => {
      cancelled = true;
    };
  }, [layerVisibility.dayBuses]);

  // Fetch live slow zones once on mount and draw them as a dashed amber
  // overlay on top of the affected track segments.
  useEffect(() => {
    let cancelled = false;

    getSlowZones()
      .then((data) => {
        if (cancelled) return;

        const features: GeoJSON.Feature[] = [];
        for (const zone of data.slowZones) {
          if (!zone.fromStationId || !zone.toStationId) continue;
          // Must be the exact same polyline the base subway line renders
          // (see getRouteCoordinates/LINE_SHAPES in subwayGeoJSON.ts) — a
          // straight chord between the two station points here would
          // visibly diverge from the base line's real curved track
          // wherever the track bends, reading as a second, parallel line
          // running alongside it rather than sitting on top of it.
          const coordinates = getRouteCoordinates(zone.line, zone.fromStationId, zone.toStationId);
          if (coordinates.length < 2) continue;

          features.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates },
            properties: { line: zone.line, direction: zone.direction },
          });
        }

        const geojson: GeoJSON.FeatureCollection = { type: "FeatureCollection", features };
        slowZonesDataRef.current = geojson;
        (mapRef.current?.getSource(SLOW_ZONES_SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(
          geojson
        );
      })
      .catch(() => {
        // The slow-zone overlay is a nice-to-have visual, not the critical
        // path — a failed fetch just leaves the map without it.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch live service alerts once on mount and draw active line closures as
  // a bold red dashed overlay on the affected track segments.
  useEffect(() => {
    let cancelled = false;

    getAlerts()
      .then((data) => {
        if (cancelled) return;

        const features: GeoJSON.Feature[] = [];
        for (const alert of data.alerts) {
          // Planned nightly closures outside their restricted window are
          // informational only — reserve the red overlay for closures that
          // are actually in effect right now.
          if (alert.category !== "closure" || alert.isUpcomingNotice) continue;
          const fromStation = findStationByName(alert.fromStation);
          const toStation = findStationByName(alert.toStation);
          if (!fromStation || !toStation) continue;

          const coordinates = getRouteCoordinates(alert.line, fromStation.id, toStation.id);
          if (coordinates.length < 2) continue;

          features.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates },
            properties: {
              alertId: alert.id,
              headline: alert.headline,
              description: alert.description,
            },
          });
        }

        const geojson: GeoJSON.FeatureCollection = { type: "FeatureCollection", features };
        disruptionsDataRef.current = geojson;
        (mapRef.current?.getSource(DISRUPTIONS_SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(
          geojson
        );
      })
      .catch(() => {
        // Same as slow zones — a failed fetch just leaves the map without
        // the disruption overlay rather than breaking the page.
      });

    return () => {
      cancelled = true;
    };
  }, []);

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

    const handleDeparture =
      onSelectDeparture ?? ((selection: LocationSelection) => console.log("Set as departure:", selection));
    const handleSetOrigin =
      onSetOrigin ?? ((selection: LocationSelection) => console.log("Set as origin:", selection));
    const handleSetDestination =
      onSetDestination ?? ((selection: LocationSelection) => console.log("Set as destination:", selection));

    let interactionsBound = false;
    let disruptionHoverPopup: maplibregl.Popup | null = null;
    let surfaceRouteHoverPopup: maplibregl.Popup | null = null;
    let pinContextMenuPopup: maplibregl.Popup | null = null;
    let originPinMarker: maplibregl.Marker | null = null;
    let destinationPinMarker: maplibregl.Marker | null = null;
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let stopHoverPopup: maplibregl.Popup | null = null;

    // "style.load" (unlike "load") fires again every time setStyle() swaps
    // the basemap, which is exactly when our custom layers need re-adding.
    map.on("style.load", () => {
      // Surface transit (streetcars/night buses) is added first so subway —
      // added next — always renders on top of it, keeping subway the
      // visually dominant network regardless of z-order coincidences.
      addStreetcarLayer(map, streetcarsDataRef.current, layerVisibilityRef.current.streetcars);
      addDayBusLayer(map, dayBusesDataRef.current, layerVisibilityRef.current.dayBuses);
      addNightBusLayer(map, nightBusesDataRef.current, layerVisibilityRef.current.nightBuses);
      addBaseLineLayer(map);
      addSlowZoneLayer(map, slowZonesDataRef.current);
      addDisruptionLayers(map, disruptionsDataRef.current);
      addRouteHighlightLayers(map, routeDataRef.current);
      addItineraryLayers(map, itineraryDataRef.current);
      addStationsLayer(map);
      addSurfaceStopsLayer(map, surfaceStopsDataRef.current, {
        streetcars: layerVisibilityRef.current.streetcars,
        nightBuses: layerVisibilityRef.current.nightBuses,
      });
      addEndpointHighlightLayers(map, endpointsDataRef.current);
      // setStyle() (theme toggle) wipes layer visibility along with
      // everything else — reapply the current toggle state on every reload.
      applyLayerVisibility(map, layerVisibilityRef.current);

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
        const [lon, lat] = feature.geometry.coordinates as [number, number];

        new maplibregl.Popup({ offset: 12 })
          .setLngLat(feature.geometry.coordinates as [number, number])
          .setDOMContent(buildPopupContent({ name: properties.name, lines, lon, lat }, handleDeparture))
          .addTo(map);
      });

      // Hovering an alert segment shows a tooltip that follows the cursor;
      // clicking pins a closable one (for touch devices without hover).
      map.on("mouseenter", DISRUPTIONS_LAYER_ID, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", DISRUPTIONS_LAYER_ID, () => {
        map.getCanvas().style.cursor = "";
        disruptionHoverPopup?.remove();
        disruptionHoverPopup = null;
      });
      map.on("mousemove", DISRUPTIONS_LAYER_ID, (event) => {
        const feature = event.features?.[0];
        if (!feature || feature.geometry.type !== "LineString") return;
        const properties = feature.properties as { headline: string; description: string };

        if (!disruptionHoverPopup) {
          disruptionHoverPopup = new maplibregl.Popup({
            closeButton: false,
            closeOnClick: false,
            offset: 8,
          });
        }
        disruptionHoverPopup
          .setLngLat(event.lngLat)
          .setDOMContent(buildDisruptionTooltipContent(properties))
          .addTo(map);
      });
      map.on("click", DISRUPTIONS_LAYER_ID, (event) => {
        const feature = event.features?.[0];
        if (!feature || feature.geometry.type !== "LineString") return;
        const properties = feature.properties as { headline: string; description: string };

        new maplibregl.Popup({ offset: 8 })
          .setLngLat(event.lngLat)
          .setDOMContent(buildDisruptionTooltipContent(properties))
          .addTo(map);
      });

      // Hovering a streetcar/night-bus line highlights it (opacity 1.0,
      // width 3px) and dims every other surface line to 0.2 opacity — see
      // highlightSurfaceRoute — with a tooltip naming the route.
      for (const [layerId, networkLabel] of [
        [STREETCARS_LAYER_ID, "Streetcar"],
        [NIGHT_BUSES_LAYER_ID, "Night Bus"],
      ] as const) {
        map.on("mouseenter", layerId, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mousemove", layerId, (event) => {
          const lineFeatures = (event.features ?? [])
            .filter((feature) => feature.geometry.type === "LineString" && !!feature.properties)
            .map((feature) => ({
              properties: feature.properties as {
                routeId: string;
                routeShortName: string;
                routeLongName: string;
                direction: number;
                branchCode: string | null;
                headsign: string;
              },
            }));
          if (lineFeatures.length === 0) return;
          const dedupedFeatures = dedupeSurfaceRouteFeatures(lineFeatures);

          // Same-layer overlaps (e.g. two streetcar routes sharing track)
          // still highlight/dim around whichever route is topmost under the
          // cursor — the tooltip below is what actually lists every route.
          const topmost = dedupedFeatures[0].properties;
          highlightSurfaceRoute(map, topmost.routeId, topmost.direction);

          if (!surfaceRouteHoverPopup) {
            surfaceRouteHoverPopup = new maplibregl.Popup({
              closeButton: false,
              closeOnClick: false,
              offset: 6,
            });
          }
          surfaceRouteHoverPopup
            .setLngLat(event.lngLat)
            .setDOMContent(
              buildSurfaceRouteTooltipContent(
                dedupedFeatures.map((feature) => feature.properties),
                networkLabel
              )
            )
            .addTo(map);
        });
        map.on("mouseleave", layerId, () => {
          map.getCanvas().style.cursor = "";
          clearSurfaceRouteHighlight(map);
          surfaceRouteHoverPopup?.remove();
          surfaceRouteHoverPopup = null;
        });
      }

      // Day buses get the same hover popup as streetcars/night buses (route
      // number + name + "Bus"), but no highlightSurfaceRoute dim/highlight —
      // that function only targets the streetcar/night-bus layers, and
      // dimming ~150 other bus routes on every hover would be far noisier
      // than useful here.
      map.on("mouseenter", DAY_BUSES_LAYER_ID, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mousemove", DAY_BUSES_LAYER_ID, (event) => {
        const lineFeatures = (event.features ?? [])
          .filter((feature) => feature.geometry.type === "LineString" && !!feature.properties)
          .map((feature) => ({
            properties: feature.properties as {
              routeShortName: string;
              routeLongName: string;
              branchCode: string | null;
              headsign: string;
            },
          }));
        if (lineFeatures.length === 0) return;
        // The day-bus network is dense enough that two different routes
        // sharing a block (114 Queens Quay East and 97C Yonge, say) is
        // routine, not an edge case — every distinct route under the
        // cursor gets its own line in the tooltip below.
        const dedupedFeatures = dedupeSurfaceRouteFeatures(lineFeatures);

        if (!surfaceRouteHoverPopup) {
          surfaceRouteHoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 6 });
        }
        surfaceRouteHoverPopup
          .setLngLat(event.lngLat)
          .setDOMContent(
            buildSurfaceRouteTooltipContent(
              dedupedFeatures.map((feature) => feature.properties),
              "Bus"
            )
          )
          .addTo(map);
      });
      map.on("mouseleave", DAY_BUSES_LAYER_ID, () => {
        map.getCanvas().style.cursor = "";
        surfaceRouteHoverPopup?.remove();
        surfaceRouteHoverPopup = null;
      });

      // Hovering a surface stop (either network) shows its name + the routes serving it.
      for (const stopLayerId of [STREETCAR_STOPS_LAYER_ID, NIGHT_BUS_STOPS_LAYER_ID]) {
        map.on("mouseenter", stopLayerId, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mousemove", stopLayerId, (event) => {
          const feature = event.features?.[0];
          if (!feature || feature.geometry.type !== "Point") return;
          const properties = feature.properties as { name: string; routes: string[] | string };

          if (!stopHoverPopup) {
            stopHoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 6 });
          }
          stopHoverPopup
            .setLngLat(feature.geometry.coordinates as [number, number])
            .setDOMContent(buildSurfaceStopTooltipContent(properties))
            .addTo(map);
        });
        map.on("mouseleave", stopLayerId, () => {
          map.getCanvas().style.cursor = "";
          stopHoverPopup?.remove();
          stopHoverPopup = null;
        });
      }

      // Drops a clean marker at `lngLat` for `role` (replacing any previous
      // pin of that same role) and reverse-geocodes it into a rider-facing
      // label — see lib/geocoding.ts — before handing it to the form.
      function placePin(role: "origin" | "destination", lngLat: maplibregl.LngLat) {
        const marker = new maplibregl.Marker({ color: role === "origin" ? "#10b981" : "#ef4444" })
          .setLngLat(lngLat)
          .addTo(map);
        if (role === "origin") {
          originPinMarker?.remove();
          originPinMarker = marker;
        } else {
          destinationPinMarker?.remove();
          destinationPinMarker = marker;
        }

        reverseGeocode(lngLat.lat, lngLat.lng).then((name) => {
          const selection: LocationSelection = { name, lat: lngLat.lat, lon: lngLat.lng };
          if (role === "origin") {
            handleSetOrigin(selection);
          } else {
            handleSetDestination(selection);
          }
        });
      }

      function showPinContextMenu(lngLat: maplibregl.LngLat) {
        pinContextMenuPopup?.remove();
        pinContextMenuPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, offset: 4 })
          .setLngLat(lngLat)
          .setDOMContent(
            buildPinContextMenuContent(
              () => {
                placePin("origin", lngLat);
                pinContextMenuPopup?.remove();
              },
              () => {
                placePin("destination", lngLat);
                pinContextMenuPopup?.remove();
              }
            )
          )
          .addTo(map);
      }

      // Desktop: right-click anywhere on the map (MapLibre already suppresses
      // the browser's own context menu on the canvas).
      map.on("contextmenu", (event) => {
        showPinContextMenu(event.lngLat);
      });

      // Mobile/touch: long-press anywhere on the map — cancelled by any
      // finger movement or a second touch point (a pan/pinch gesture, not a
      // press-and-hold), or by lifting the finger before the threshold.
      const cancelLongPress = () => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      };
      map.on("touchstart", (event) => {
        if (event.points.length > 1) return;
        cancelLongPress();
        const pressLngLat = event.lngLat;
        longPressTimer = setTimeout(() => showPinContextMenu(pressLngLat), LONG_PRESS_MS);
      });
      map.on("touchmove", cancelLongPress);
      map.on("touchend", cancelLongPress);
      map.on("touchcancel", cancelLongPress);
    });

    return () => {
      if (longPressTimer) clearTimeout(longPressTimer);
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isDark is read once for the initial style; later changes go through the effect below
  }, [onSelectDeparture, onSetOrigin, onSetDestination]);

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

  // Apply the layer-toggle checkboxes to the live map whenever they change,
  // and keep the ref in sync for the style.load handler (a stable callback
  // that can't close over the latest state directly).
  useEffect(() => {
    layerVisibilityRef.current = layerVisibility;
    const map = mapRef.current;
    if (!map) return;

    // Ordinarily style.load (see the map-creation effect above) is what
    // adds every custom layer, reading layerVisibilityRef for its initial
    // visibility — applyLayerVisibility below then just flips an existing
    // layer's visibility on toggle. Day buses is the one layer whose data
    // can already be sitting in dayBusesDataRef before that first
    // style.load ever runs (its own fetch effect isn't gated on the map
    // being ready — see that effect above), so if this fires while the
    // layer still doesn't exist yet, add it directly with whatever data is
    // already in hand instead of only ever relying on style.load to catch
    // up. Guarded on isStyleLoaded() since addLayer/addSource throw if
    // called before the style itself has finished loading.
    if (layerVisibility.dayBuses && map.isStyleLoaded() && !map.getLayer(DAY_BUSES_LAYER_ID)) {
      addDayBusLayer(map, dayBusesDataRef.current, true);
    }

    applyLayerVisibility(map, layerVisibility);
  }, [layerVisibility]);

  // Glow the route (or, for a multi-modal router.py result, draw its
  // dashed-walk + solid-transit legs instead) and highlight both endpoints
  // whenever a commute is calculated.
  useEffect(() => {
    const { route, endpoints: routeEndpoints, bounds: routeBounds } = computeRouteFeatures(commuteResult);
    const { itinerary, endpoints: itineraryEndpoints, bounds: itineraryBounds } =
      computeItineraryFeatures(commuteResult);
    const endpoints = commuteResult?.itinerary.length ? itineraryEndpoints : routeEndpoints;
    const bounds = itineraryBounds ?? routeBounds;

    routeDataRef.current = route;
    itineraryDataRef.current = itinerary;
    endpointsDataRef.current = endpoints;

    const map = mapRef.current;
    if (!map) return;

    (map.getSource(ROUTE_SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(route);
    (map.getSource(ITINERARY_SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(itinerary);
    (map.getSource(ENDPOINTS_SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(endpoints);

    if (bounds) {
      map.fitBounds(bounds, { padding: 96, duration: 800, maxZoom: 15 });
    }
  }, [commuteResult]);

  // Selecting a detour from the header's DetourPanel ("View on Map") isolates
  // its corridor: fit the map to its affected stops, drop a warning marker on
  // each, and dim every other background transit layer so the rerouted
  // segment reads clearly against the rest of the network.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const marker of detourMarkersRef.current) marker.remove();
    detourMarkersRef.current = [];

    if (!viewedDetour) {
      setBackgroundLayersDimmed(map, false);
      return;
    }

    setBackgroundLayersDimmed(map, true);

    const effectLabel = DETOUR_EFFECT_LABELS[viewedDetour.effect] ?? viewedDetour.effect;
    let bounds: maplibregl.LngLatBounds | null = null;

    for (const stop of viewedDetour.affectedStops) {
      const lngLat: [number, number] = [stop.lon, stop.lat];
      const marker = new maplibregl.Marker({ element: createDetourStopMarkerElement(), anchor: "center" })
        .setLngLat(lngLat)
        .setPopup(
          new maplibregl.Popup({ offset: 16, closeButton: false }).setDOMContent(
            buildDetourStopTooltipContent({ name: stop.name, effectLabel })
          )
        )
        .addTo(map);
      detourMarkersRef.current.push(marker);
      bounds = bounds ? bounds.extend(lngLat) : new maplibregl.LngLatBounds(lngLat, lngLat);
    }

    if (bounds) {
      map.fitBounds(bounds, { padding: 120, duration: 800, maxZoom: 16 });
    }
  }, [viewedDetour]);

  function handleLayerToggle(key: keyof LayerVisibility) {
    setLayerVisibility((previous) => ({ ...previous, [key]: !previous[key] }));
  }

  return (
    <div id="ttc-map" className={className}>
      <div
        ref={containerRef}
        role="region"
        aria-label="Interactive map centered on Toronto"
        className="absolute inset-0 h-full w-full"
      />

      <div className="pointer-events-none absolute inset-0">
        {viewedDetour && (
          <div className="pointer-events-auto absolute left-4 top-4 flex max-w-xs items-start gap-2 rounded-lg border border-red-300 bg-white/95 p-3 text-xs shadow-md backdrop-blur dark:border-red-400/30 dark:bg-neutral-900/95">
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-red-600 dark:text-red-300">
                Viewing detour: Route {viewedDetour.routeShortName ?? "?"}
              </p>
              <p className="mt-0.5 line-clamp-3 text-neutral-600 dark:text-white/70">{viewedDetour.summary}</p>
            </div>
            <button
              type="button"
              onClick={clearViewedDetour}
              className="shrink-0 rounded-full border border-neutral-300 px-2 py-1 text-[11px] font-semibold text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-white/20 dark:text-white/70 dark:hover:bg-white/10"
            >
              Exit
            </button>
          </div>
        )}

        {/* bottom-12 (48px) clears MapLibre's attribution/info-badge strip
            pinned at the map's own bottom edge, which sits below this panel
            in the DOM but is rendered by MapLibre itself at bottom-0. */}
        <div className="pointer-events-auto absolute right-4 bottom-12 rounded-lg border border-zinc-200 bg-white/90 p-3 text-xs shadow-md backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/90">
          <p className="mb-2 font-medium uppercase tracking-wide text-neutral-500 dark:text-white/50">
            Map Layers
          </p>
          <div className="flex flex-col gap-2">
            {LAYER_TOGGLE_OPTIONS.map((option) => (
              <label
                key={option.key}
                className="flex cursor-pointer items-center gap-2 text-xs font-medium text-neutral-700 dark:text-white/80"
              >
                <input
                  type="checkbox"
                  checked={layerVisibility[option.key]}
                  onChange={() => handleLayerToggle(option.key)}
                  className="h-4 w-4 accent-red-600"
                />
                <span className={`h-2 w-2 rounded-full ${option.swatchClassName}`} />
                {option.label}
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
