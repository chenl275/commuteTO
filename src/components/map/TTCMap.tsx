"use client";

import { useEffect, useRef } from "react";
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
import { getSlowZones } from "@/lib/traffic";
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
const LINES_LAYER_ID = "ttc-lines-layer";
const SLOW_ZONES_SOURCE_ID = "ttc-slow-zones";
const SLOW_ZONES_LAYER_ID = "ttc-slow-zones-layer";
const ROUTE_SOURCE_ID = "ttc-route-highlight";
const ROUTE_GLOW_LAYER_ID = "ttc-route-highlight-glow";
const ROUTE_LINE_LAYER_ID = "ttc-route-highlight-line";
const STATIONS_SOURCE_ID = "ttc-stations";
const STATIONS_LAYER_ID = "ttc-stations-layer";
const ENDPOINTS_SOURCE_ID = "ttc-route-endpoints";
const ENDPOINTS_GLOW_LAYER_ID = "ttc-route-endpoints-glow";
const ENDPOINTS_LAYER_ID = "ttc-route-endpoints-layer";

const EMPTY_FEATURE_COLLECTION: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

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

function addBaseLineLayer(map: maplibregl.Map) {
  if (!map.getSource(LINES_SOURCE_ID)) {
    map.addSource(LINES_SOURCE_ID, { type: "geojson", data: linesGeoJSON });
  }
  if (!map.getLayer(LINES_LAYER_ID)) {
    map.addLayer({
      id: LINES_LAYER_ID,
      type: "line",
      source: LINES_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "colorHex"], "line-width": 4 },
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
        "circle-radius": ["case", ["get", "isTransfer"], 6.5, 4],
        "circle-color": "#FFFFFF",
        "circle-stroke-color": "#111111",
        "circle-stroke-width": 2,
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

  const slowZonesDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FEATURE_COLLECTION);
  const routeDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FEATURE_COLLECTION);
  const endpointsDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FEATURE_COLLECTION);

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
      addBaseLineLayer(map);
      addSlowZoneLayer(map, slowZonesDataRef.current);
      addRouteHighlightLayers(map, routeDataRef.current);
      addStationsLayer(map);
      addEndpointHighlightLayers(map, endpointsDataRef.current);

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

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Interactive map centered on Toronto"
      className={className}
    />
  );
}
