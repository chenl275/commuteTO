import stations from "@/data/ttc-stations.json";
import subwayLineShapes from "@/data/subway-line-shapes.json";
import type { LineId, Station } from "@/types/transit";
import { stationMatchKey, stripStationSuffix } from "@/lib/stationDisplay";

const typedStations = stations as Station[];

const stationsById = new Map(typedStations.map((station) => [station.id, station]));

/** Real curved track geometry for a subway line, extracted offline from
 * GTFS shapes.txt (see backend/scripts/build_subway_line_shapes.py) —
 * `shapePoints` are [lon, lat, shapeDistTraveledKm] triples in travel order,
 * `stationDistances` locates each of our canonical stations along that same
 * distance axis. Only lines with real GTFS static schedule data get this
 * (1, 2, 4 in the current feed); Line 5/6 fall back to the coarser
 * straight-chord-between-stations approximation below. */
interface SubwayLineShape {
  shapePoints: [number, number, number][];
  stationDistances: Record<string, number>;
}

const LINE_SHAPES = subwayLineShapes as unknown as Record<string, SubwayLineShape>;

interface LineDefinition {
  id: LineId;
  name: string;
  colorHex: string;
  /** Station ids in travel order, from one terminus to the other. */
  stationIds: string[];
}

const LINE_DEFINITIONS: LineDefinition[] = [
  {
    id: 1,
    name: "Line 1 Yonge-University",
    colorHex: "#F8C300",
    stationIds: [
      "vaughan-metropolitan-centre",
      "highway-407",
      "pioneer-village",
      "york-university",
      "finch-west",
      "downsview-park",
      "sheppard-west",
      "wilson",
      "yorkdale",
      "lawrence-west",
      "glencairn",
      "cedarvale",
      "st-clair-west",
      "dupont",
      "spadina",
      "st-george",
      "museum",
      "queens-park",
      "st-patrick",
      "osgoode",
      "st-andrew",
      "union",
      "king",
      "queen",
      "tmu",
      "college",
      "wellesley",
      "bloor-yonge",
      "rosedale",
      "summerhill",
      "st-clair",
      "davisville",
      "eglinton",
      "lawrence",
      "york-mills",
      "sheppard-yonge",
      "north-york-centre",
      "finch",
    ],
  },
  {
    id: 2,
    name: "Line 2 Bloor-Danforth",
    colorHex: "#00923F",
    stationIds: [
      "kipling",
      "islington",
      "royal-york",
      "old-mill",
      "jane",
      "runnymede",
      "high-park",
      "keele",
      "dundas-west",
      "lansdowne",
      "dufferin",
      "ossington",
      "christie",
      "bathurst",
      "spadina",
      "st-george",
      "bay",
      "bloor-yonge",
      "sherbourne",
      "castle-frank",
      "broadview",
      "chester",
      "pape",
      "donlands",
      "greenwood",
      "coxwell",
      "woodbine",
      "main-street",
      "victoria-park",
      "warden",
      "kennedy",
    ],
  },
  {
    id: 4,
    name: "Line 4 Sheppard",
    colorHex: "#A21A68",
    stationIds: ["sheppard-yonge", "bayview", "bessarion", "leslie", "don-mills"],
  },
  {
    id: 5,
    name: "Line 5 Eglinton Crosstown",
    colorHex: "#EE7C0E",
    stationIds: [
      "mount-dennis",
      "keelesdale",
      "caledonia",
      "fairbank",
      "oakwood",
      "cedarvale",
      "forest-hill",
      "chaplin",
      "avenue",
      "eglinton",
      "mount-pleasant",
      "leaside",
      "laird",
      "sunnybrook-park",
      "don-valley",
      "aga-khan-park-and-museum",
      "wynford",
      "sloane",
      "oconnor",
      "pharmacy",
      "hakimi-lebovic",
      "golden-mile",
      "birchmount",
      "ionview",
      "kennedy",
    ],
  },
  {
    id: 6,
    name: "Line 6 Finch West",
    colorHex: "#768692",
    stationIds: [
      "humber-college",
      "westmore",
      "martin-grove",
      "albion",
      "stevenson",
      "mount-olive",
      "rowntree-mills",
      "pearldale",
      "duncanwoods",
      "milvan-rumike",
      "emery",
      "signet-arrow",
      "norfinch-oakdale",
      "jane-and-finch",
      "driftwood",
      "tobermory",
      "sentinel",
      "finch-west",
    ],
  },
];

function getStation(id: string): Station {
  const station = stationsById.get(id);
  if (!station) {
    throw new Error(`Unknown station id in line definition: ${id}`);
  }
  return station;
}

export interface StationProperties {
  id: string;
  name: string;
  lines: LineId[];
  isTransfer: boolean;
}

export interface LineProperties {
  lineId: LineId;
  lineName: string;
  colorHex: string;
}

export const stationsGeoJSON: GeoJSON.FeatureCollection<GeoJSON.Point, StationProperties> = {
  type: "FeatureCollection",
  features: typedStations.map((station) => ({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: station.coordinates,
    },
    properties: {
      id: station.id,
      name: station.name,
      lines: station.lines,
      isTransfer: station.isTransfer,
    },
  })),
};

/** This line's full geometry, in travel order — the real curved track (see
 * LINE_SHAPES above) when GTFS shape data exists for it, otherwise the
 * straight-chord-between-stations approximation. */
function fullLineCoordinates(line: LineDefinition): [number, number][] {
  const shape = LINE_SHAPES[String(line.id)];
  if (shape && shape.shapePoints.length > 1) {
    return shape.shapePoints.map(([lon, lat]) => [lon, lat]);
  }
  return line.stationIds.map((id) => getStation(id).coordinates);
}

export const linesGeoJSON: GeoJSON.FeatureCollection<GeoJSON.LineString, LineProperties> = {
  type: "FeatureCollection",
  features: LINE_DEFINITIONS.map((line) => ({
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: fullLineCoordinates(line),
    },
    properties: {
      lineId: line.id,
      lineName: line.name,
      colorHex: line.colorHex,
    },
  })),
};

/** All stations, alphabetically sorted by name (e.g. for search/autocomplete). */
export function getAllStations(): Station[] {
  return [...typedStations].sort((a, b) => a.name.localeCompare(b.name));
}

/** Official TTC line color by line number, e.g. for badges/pills next to a station name. */
export const lineColorById: Record<number, string> = Object.fromEntries(
  LINE_DEFINITIONS.map((line) => [line.id, line.colorHex])
);

/** Case-insensitive exact-name lookup, e.g. for resolving a backend response's station name. */
export function findStationByName(name: string): Station | undefined {
  const normalized = name.trim().toLowerCase();
  return typedStations.find((station) => station.name.toLowerCase() === normalized);
}

/**
 * Resolves free-typed rider input — a station id ("bloor-yonge"), a bare
 * canonical name ("Union"), a display label with a "Station"/"Subway
 * Station" suffix ("Union Station"), or an unambiguous partial name
 * ("bloor") — to its canonical Station record. Used to normalize origin/
 * destination text before it's sent to the backend.
 */
export function getStationByNameOrId(query: string): Station | undefined {
  const cleaned = stripStationSuffix(query);
  if (!cleaned) return undefined;

  const byId = stationsById.get(cleaned.toLowerCase());
  if (byId) return byId;

  const cleanedLower = cleaned.toLowerCase();
  const exactNameMatch = typedStations.find((station) => station.name.toLowerCase() === cleanedLower);
  if (exactNameMatch) return exactNameMatch;

  const key = stationMatchKey(cleaned);
  if (!key) return undefined;
  const partialMatches = typedStations.filter((station) => stationMatchKey(station.name).includes(key));
  return partialMatches.length === 1 ? partialMatches[0] : undefined;
}

/**
 * Coordinates between `fromStationId` and `toStationId` along `lineId`, in
 * ascending-distance order — for drawing a highlighted trip path (or a slow
 * zone/disruption overlay) on the map.
 *
 * Slices the real curved track (see LINE_SHAPES) between the two stations'
 * recorded positions along it, then clamps both ends exactly onto the
 * stations' own marker coordinates (ttc-stations.json, snapped precisely
 * onto the line by backend/scripts/snap_stations_to_track.py). The
 * distance-based slice boundary and that snapped marker don't always land
 * on the exact same point — GTFS's own recorded shape_dist_traveled for a
 * station's stop and the true geometric nearest point can disagree by
 * anywhere from ~15m to, right at a sharp turn like Union's loop, ~180m —
 * so without clamping, the slice can stop noticeably short of the station,
 * or (worse, at that same sharp turn) run past it into the next segment of
 * track. Earlier this function anchored nowhere *but* the raw shape
 * vertices, specifically to avoid a spur — that was needed when station
 * coordinates were still their unadjusted GTFS-stop position (50-200m off
 * the track); now that every station is snapped onto its line first, this
 * clamp lands within a track-width of the slice's own geometry instead of
 * opening a new gap. Falls back to the coarser station-to-station chord
 * (still correctly ordered, just without the curved in-between geometry,
 * but matching fullLineCoordinates()'s own chord-based fallback exactly)
 * when this line has no shape data, or either station isn't located on it.
 */
export function getRouteCoordinates(
  lineId: number,
  fromStationId: string,
  toStationId: string
): [number, number][] {
  const line = LINE_DEFINITIONS.find((definition) => definition.id === lineId);
  if (!line) return [];

  const fromIndex = line.stationIds.indexOf(fromStationId);
  const toIndex = line.stationIds.indexOf(toStationId);
  if (fromIndex === -1 || toIndex === -1) return [];

  const shape = LINE_SHAPES[String(lineId)];
  const fromDist = shape?.stationDistances[fromStationId];
  const toDist = shape?.stationDistances[toStationId];
  if (shape && fromDist !== undefined && toDist !== undefined) {
    const [lowDistId, highDistId] = fromDist <= toDist ? [fromStationId, toStationId] : [toStationId, fromStationId];
    const [lowDist, highDist] = fromDist <= toDist ? [fromDist, toDist] : [toDist, fromDist];
    const path: [number, number][] = shape.shapePoints
      .filter(([, , dist]) => dist >= lowDist && dist <= highDist)
      .map(([lon, lat]) => [lon, lat]);
    if (path.length < 2) return [];

    // Clamp — never extend past, never stop short of — the slice's two ends
    // to the stations' own snapped marker coordinates (see this function's
    // docstring). Overwriting (not appending) is what actually stops the
    // slice bleeding past the terminal station along a sharp curve like
    // Union's loop: an appended extra point can't undo a boundary that
    // already overshot into the next segment of track.
    path[0] = getStation(lowDistId).coordinates;
    path[path.length - 1] = getStation(highDistId).coordinates;

    // The GTFS trip this shape was extracted from may run in either physical
    // direction relative to this line's stationIds array — normalize so
    // this function's output direction always matches the ascending
    // station-index contract callers rely on (e.g. computeRouteFeatures in
    // TTCMap.tsx, which reverses based on getStationIndexOnLine).
    return line.stationIds.indexOf(lowDistId) <= line.stationIds.indexOf(highDistId) ? path : [...path].reverse();
  }

  const [start, end] = fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
  return line.stationIds.slice(start, end + 1).map((id) => getStation(id).coordinates);
}

/** A station's position (0-based) in `lineId`'s travel-ordered station list,
 * or null if the station isn't on that line — used to order a route's
 * coordinates origin -> destination regardless of which endpoint has the
 * lower index (see computeRouteFeatures in TTCMap.tsx). */
export function getStationIndexOnLine(lineId: number, stationId: string): number | null {
  const line = LINE_DEFINITIONS.find((definition) => definition.id === lineId);
  if (!line) return null;
  const index = line.stationIds.indexOf(stationId);
  return index === -1 ? null : index;
}
