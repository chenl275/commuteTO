export const SITE_NAME = "commuteTO";
export const SITE_TAGLINE = "TTC Smart Commute";
export const SITE_DESCRIPTION =
  "Plan your Toronto commute in seconds with real-time TTC transit data.";

export const CARTO_DARK_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
export const CARTO_LIGHT_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
/** [longitude, latitude] */
export const TORONTO_CENTER: [number, number] = [-79.3832, 43.6532];
export const DEFAULT_MAP_ZOOM = 11.5;

export const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";
