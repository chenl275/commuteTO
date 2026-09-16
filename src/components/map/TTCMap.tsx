"use client";

import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { CARTO_DARK_STYLE, CARTO_LIGHT_STYLE, DEFAULT_MAP_ZOOM, TORONTO_CENTER } from "@/lib/constants";
import {
  findStationByName,
  getRouteCoordinates,
  linesGeoJSON,
  stationsGeoJSON,
} from "@/lib/geo/subwayGeoJSON";
import { useIsDarkMode } from "@/components/theme/useIsDarkMode";
import { getAlerts, getNightBuses, getSlowZones, getStreetcars, getSurfaceStops } from "@/lib/traffic";
import { formatStationLabel } from "@/lib/stationDisplay";
import type { TransitCommuteResponse } from "@/types/traffic";

interface TTCMapProps {
  className?: string;
  /** Called when a rider picks "Set as Departure" on a station popup. */
  onSelectDeparture?: (stationName: string) => void;
  /** The most recently calculated commute, used to glow the route + fit the map to it. */
  commuteResult?: TransitCommuteResponse | null;
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
const STATIONS_SOURCE_ID = "ttc-stations";
const STATIONS_LAYER_ID = "ttc-stations-layer";
const ENDPOINTS_SOURCE_ID = "ttc-route-endpoints";
const ENDPOINTS_GLOW_LAYER_ID = "ttc-route-endpoints-glow";
const ENDPOINTS_LAYER_ID = "ttc-route-endpoints-layer";
const STREETCARS_SOURCE_ID = "ttc-streetcars";
const STREETCARS_LAYER_ID = "streetcar-line";
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
const NIGHT_BUS_LAYER_IDS = [NIGHT_BUSES_LAYER_ID, NIGHT_BUS_STOPS_HALO_LAYER_ID, NIGHT_BUS_STOPS_LAYER_ID];

const NIGHT_BUS_COLOR = "#2A4365";
const SURFACE_STOP_COLOR = "#BA0C2F";

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
const HOVERED_SURFACE_LINE_WIDTH = 3.0;
const HOVERED_SURFACE_LINE_OPACITY = 1.0;
const DIMMED_SURFACE_LINE_OPACITY = 0.2;

interface LayerVisibility {
  subways: boolean;
  streetcars: boolean;
  nightBuses: boolean;
}

// Subways and streetcars shown by default; night buses stay opt-in since
// they're only relevant during the overnight window most visitors aren't
// browsing in.
const DEFAULT_LAYER_VISIBILITY: LayerVisibility = {
  subways: true,
  streetcars: true,
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
  { key: "nightBuses", label: "Night Buses", swatchClassName: "bg-indigo-900" },
];

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
  button.addEventListener("click", () => onSelectDeparture(formatStationLabel(station.name)));
  container.appendChild(button);

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
        "line-width": 6,
        "line-dasharray": [1.4, 1.4],
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
  setLayersVisible(map, NIGHT_BUS_LAYER_IDS, visibility.nightBuses);
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
    if (!map.getLayer(haloLayerId)) {
      map.addLayer({
        id: haloLayerId,
        type: "circle",
        source: SURFACE_STOPS_SOURCE_ID,
        minzoom: 14.0,
        filter: ["all", servesNetwork, ["==", ["get", "isInterchange"], true]],
        layout: { visibility: visibilityValue },
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 5, 16, 7],
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
        minzoom: 14.0,
        filter: servesNetwork,
        layout: { visibility: visibilityValue },
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 1.8, 16, 3.0],
          "circle-color": SURFACE_STOP_COLOR,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
        },
      });
    }
  }
}

/** Elevates the hovered surface route to full opacity/3px width and dims
 * every other streetcar/night-bus line to 0.2 opacity, across both layers. */
function highlightSurfaceRoute(map: maplibregl.Map, routeId: string, direction: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the STREETCAR/NIGHT_BUS expression constants above
  const isHovered: any = [
    "all",
    ["==", ["get", "routeId"], routeId],
    ["==", ["get", "direction"], direction],
  ];

  map.setPaintProperty(STREETCARS_LAYER_ID, "line-width", [
    "case",
    isHovered,
    HOVERED_SURFACE_LINE_WIDTH,
    STREETCAR_WIDTH_EXPRESSION,
  ]);
  map.setPaintProperty(STREETCARS_LAYER_ID, "line-opacity", [
    "case",
    isHovered,
    HOVERED_SURFACE_LINE_OPACITY,
    DIMMED_SURFACE_LINE_OPACITY,
  ]);

  map.setPaintProperty(NIGHT_BUSES_LAYER_ID, "line-width", [
    "case",
    isHovered,
    HOVERED_SURFACE_LINE_WIDTH,
    NIGHT_BUS_WIDTH_EXPRESSION,
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

function buildSurfaceRouteTooltipContent(properties: {
  routeShortName: string;
  routeLongName: string;
  networkLabel: string;
}): HTMLElement {
  const container = document.createElement("div");
  container.className = "p-1";
  const text = document.createElement("p");
  text.className = "text-xs font-semibold text-neutral-900";
  text.textContent = `${properties.routeShortName} ${properties.routeLongName} ${properties.networkLabel}`;
  container.appendChild(text);
  return container;
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

function addRouteHighlightLayers(map: maplibregl.Map, data: GeoJSON.FeatureCollection) {
  if (!map.getSource(ROUTE_SOURCE_ID)) {
    map.addSource(ROUTE_SOURCE_ID, { type: "geojson", data });
  }
  if (!map.getLayer(ROUTE_GLOW_LAYER_ID)) {
    map.addLayer({
      id: ROUTE_GLOW_LAYER_ID,
      type: "line",
      source: ROUTE_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "colorHex"],
        "line-width": 18,
        "line-blur": 8,
        "line-opacity": 0.6,
      },
    });
  }
  if (!map.getLayer(ROUTE_LINE_LAYER_ID)) {
    map.addLayer({
      id: ROUTE_LINE_LAYER_ID,
      type: "line",
      source: ROUTE_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": 3, "line-opacity": 0.9 },
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

function computeRouteFeatures(result: TransitCommuteResponse | null): {
  route: GeoJSON.FeatureCollection;
  endpoints: GeoJSON.FeatureCollection;
  bounds: maplibregl.LngLatBounds | null;
} {
  if (!result) {
    return { route: EMPTY_FEATURE_COLLECTION, endpoints: EMPTY_FEATURE_COLLECTION, bounds: null };
  }

  const originStation = findStationByName(result.origin);
  const destinationStation = findStationByName(result.destination);
  if (!originStation || !destinationStation) {
    return { route: EMPTY_FEATURE_COLLECTION, endpoints: EMPTY_FEATURE_COLLECTION, bounds: null };
  }

  const coordinates = getRouteCoordinates(result.line, originStation.id, destinationStation.id);
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

  const endpoints: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: originStation.coordinates },
        properties: { role: "origin", name: originStation.name },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: destinationStation.coordinates },
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
  commuteResult = null,
}: TTCMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const isDark = useIsDarkMode();
  const hasSetInitialStyleRef = useRef(false);

  const [layerVisibility, setLayerVisibility] = useState<LayerVisibility>(DEFAULT_LAYER_VISIBILITY);
  const layerVisibilityRef = useRef(layerVisibility);

  // A night-network result (e.g. 320 Yonge overnight) is only meaningful in
  // the context of the Blue Night background layer — auto-check that toggle
  // so the checkbox and what's on the map never disagree. This adjusts state
  // during render (React's recommended pattern for "derive state from a prop
  // change") rather than in an effect, since it only needs to run once per
  // actual commuteResult change, not resync an external system every render.
  const [lastSyncedCommuteResult, setLastSyncedCommuteResult] = useState(commuteResult);
  if (commuteResult !== lastSyncedCommuteResult) {
    setLastSyncedCommuteResult(commuteResult);
    if (commuteResult?.steps.some((step) => step.mode === "bus") && !layerVisibility.nightBuses) {
      setLayerVisibility((previous) => ({ ...previous, nightBuses: true }));
    }
  }

  const slowZonesDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FEATURE_COLLECTION);
  const disruptionsDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FEATURE_COLLECTION);
  const streetcarsDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FEATURE_COLLECTION);
  const nightBusesDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FEATURE_COLLECTION);
  const surfaceStopsDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FEATURE_COLLECTION);
  const routeDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FEATURE_COLLECTION);
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
          const from = stationsGeoJSON.features.find((f) => f.properties.id === zone.fromStationId);
          const to = stationsGeoJSON.features.find((f) => f.properties.id === zone.toStationId);
          if (!from || !to) continue;

          features.push({
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: [from.geometry.coordinates, to.geometry.coordinates],
            },
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

    const handleDeparture = onSelectDeparture ?? ((name: string) => console.log("Set as departure:", name));

    let interactionsBound = false;
    let disruptionHoverPopup: maplibregl.Popup | null = null;
    let surfaceRouteHoverPopup: maplibregl.Popup | null = null;
    let stopHoverPopup: maplibregl.Popup | null = null;

    // "style.load" (unlike "load") fires again every time setStyle() swaps
    // the basemap, which is exactly when our custom layers need re-adding.
    map.on("style.load", () => {
      // Surface transit (streetcars/night buses) is added first so subway —
      // added next — always renders on top of it, keeping subway the
      // visually dominant network regardless of z-order coincidences.
      addStreetcarLayer(map, streetcarsDataRef.current, layerVisibilityRef.current.streetcars);
      addNightBusLayer(map, nightBusesDataRef.current, layerVisibilityRef.current.nightBuses);
      addBaseLineLayer(map);
      addSlowZoneLayer(map, slowZonesDataRef.current);
      addDisruptionLayers(map, disruptionsDataRef.current);
      addRouteHighlightLayers(map, routeDataRef.current);
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

        new maplibregl.Popup({ offset: 12 })
          .setLngLat(feature.geometry.coordinates as [number, number])
          .setDOMContent(buildPopupContent({ name: properties.name, lines }, handleDeparture))
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
          const feature = event.features?.[0];
          if (!feature || feature.geometry.type !== "LineString") return;
          const properties = feature.properties as {
            routeId: string;
            routeShortName: string;
            routeLongName: string;
            direction: number;
          };

          highlightSurfaceRoute(map, properties.routeId, properties.direction);

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
              buildSurfaceRouteTooltipContent({
                routeShortName: properties.routeShortName,
                routeLongName: properties.routeLongName,
                networkLabel,
              })
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

  // Apply the layer-toggle checkboxes to the live map whenever they change,
  // and keep the ref in sync for the style.load handler (a stable callback
  // that can't close over the latest state directly).
  useEffect(() => {
    layerVisibilityRef.current = layerVisibility;
    const map = mapRef.current;
    if (!map) return;
    applyLayerVisibility(map, layerVisibility);
  }, [layerVisibility]);

  // Glow the route + highlight both endpoints whenever a commute is calculated.
  useEffect(() => {
    const { route, endpoints, bounds } = computeRouteFeatures(commuteResult);
    routeDataRef.current = route;
    endpointsDataRef.current = endpoints;

    const map = mapRef.current;
    if (!map) return;

    (map.getSource(ROUTE_SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(route);
    (map.getSource(ENDPOINTS_SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(endpoints);

    if (bounds) {
      map.fitBounds(bounds, { padding: 96, duration: 800, maxZoom: 15 });
    }
  }, [commuteResult]);

  function handleLayerToggle(key: keyof LayerVisibility) {
    setLayerVisibility((previous) => ({ ...previous, [key]: !previous[key] }));
  }

  return (
    <div className={className}>
      <div
        ref={containerRef}
        role="region"
        aria-label="Interactive map centered on Toronto"
        className="absolute inset-0 h-full w-full"
      />

      <div className="pointer-events-none absolute inset-0">
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
