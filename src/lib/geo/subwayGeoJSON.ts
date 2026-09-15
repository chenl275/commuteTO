import stations from "@/data/ttc-stations.json";
import type { LineId, Station } from "@/types/transit";

const typedStations = stations as Station[];

const stationsById = new Map(typedStations.map((station) => [station.id, station]));

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

export const linesGeoJSON: GeoJSON.FeatureCollection<GeoJSON.LineString, LineProperties> = {
  type: "FeatureCollection",
  features: LINE_DEFINITIONS.map((line) => ({
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: line.stationIds.map((id) => getStation(id).coordinates),
    },
    properties: {
      lineId: line.id,
      lineName: line.name,
      colorHex: line.colorHex,
    },
  })),
};

/** All station names, alphabetically sorted (e.g. for search/autocomplete). */
export function getAllStationNames(): string[] {
  return typedStations.map((station) => station.name).sort((a, b) => a.localeCompare(b));
}
