// maplibre-gl's tile-processing worker imports a sibling chunk
// (maplibre-gl-shared.mjs) via a relative path. Bundlers that treat
// `new URL('maplibre-gl/dist/...', import.meta.url)` as an opaque asset copy
// (Turbopack included) don't discover and emit that sibling, so the worker
// 404s on its own import and tiles silently never load. Serving both files
// verbatim from public/ (co-located, unprocessed) sidesteps that entirely.
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(rootDir, "node_modules/maplibre-gl/dist");
const destination = path.join(rootDir, "public");

for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  copyFileSync(path.join(source, file), path.join(destination, file));
}

console.log("Copied maplibre-gl worker files into public/");
