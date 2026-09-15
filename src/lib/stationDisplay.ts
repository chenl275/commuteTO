const STATION_WORD_PATTERN = /\bstations?\b/gi;
const TRAILING_STATION_SUFFIX_PATTERN = /\s+(subway\s+)?stations?$/i;

/** The canonical display label for a station, e.g. "Union" -> "Union Station". */
export function formatStationLabel(name: string): string {
  const trimmed = name.trim();
  return TRAILING_STATION_SUFFIX_PATTERN.test(trimmed) ? trimmed : `${trimmed} Station`;
}

/**
 * Strips a trailing "Station"/"Subway Station" suffix, e.g. "Union Station"
 * -> "Union", "Bloor-Yonge Subway Station" -> "Bloor-Yonge" — for resolving
 * a displayed label back to the station registry's bare canonical name.
 */
export function stripStationSuffix(value: string): string {
  return value.trim().replace(TRAILING_STATION_SUFFIX_PATTERN, "").trim();
}

/**
 * A forgiving key for matching station names/labels against user input —
 * ignores the word "Station" entirely so "Union" and "Union Station" both
 * normalize to the same key.
 */
export function stationMatchKey(value: string): string {
  return value
    .toLowerCase()
    .replace(STATION_WORD_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
}
