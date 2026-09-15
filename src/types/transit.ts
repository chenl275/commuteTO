/** TTC rapid transit line numbers covered by this dataset. */
export type LineId = 1 | 2 | 4 | 5 | 6;

export interface Station {
  id: string;
  name: string;
  lines: LineId[];
  isTransfer: boolean;
  /** [longitude, latitude] WGS84 */
  coordinates: [number, number];
}

export interface Line {
  id: LineId;
  name: string;
  colorHex: string;
  /** Station ids in travel order, from one terminus to the other. */
  stationIds: string[];
}
