export const SITE_NAME = "commuteTO";
export const SITE_TAGLINE = "TTC Smart Commute";
export const SITE_DESCRIPTION =
  "Plan your Toronto commute in seconds with real-time TTC transit data.";

export const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";
export const MAPBOX_DARK_STYLE = "mapbox://styles/mapbox/dark-v11";
/** [longitude, latitude] */
export const TORONTO_CENTER: [number, number] = [-79.3832, 43.6532];
export const DEFAULT_MAP_ZOOM = 11;
