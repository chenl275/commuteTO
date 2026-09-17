#!/usr/bin/env python3
"""One-time correction: snaps every subway station's canonical marker
coordinate onto the real track it sits on.

Station coordinates in ttc-stations.json trace back to GTFS stops.txt, which
places a station at its surface street entrance (e.g. inside the Eaton
Centre for Queen, or on the sidewalk for Museum) — not on the physical track
centerline the subway actually runs along (see subway-line-shapes.json,
itself extracted from GTFS shapes.txt). That gap is typically 30-90m, enough
for a station's circle marker to visibly float off the yellow/green line
instead of sitting on it.

For a station on exactly one line with real shape data (1, 2, or 4 in the
current feed — see build_subway_line_shapes.py), this snaps straight to the
nearest point on that line's polyline. For an interchange between two such
lines, it instead finds where their two polylines actually cross — a single
clean vertex at Bloor-Yonge, Sheppard-Yonge, and (a tight cluster of several
near-together real crossings, averaged into one point) St George — falling
back to the midpoint between each line's own nearest point when the two
tracks don't literally cross at all, as at Spadina (that interchange is a
connecting corridor, not a track junction). A station on a line with no
shape data (5, 6) is left untouched — there's no real track geometry to
snap it onto.

Run manually whenever subway-line-shapes.json is rebuilt:

    python backend/scripts/snap_stations_to_track.py

Reads and writes src/data/ttc-stations.json in place (reading
src/data/subway-line-shapes.json for track geometry).
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
STATIONS_PATH = REPO_ROOT / "src" / "data" / "ttc-stations.json"
SHAPES_PATH = REPO_ROOT / "src" / "data" / "subway-line-shapes.json"

EARTH_RADIUS_M = 6_371_000.0
# Only a segment pair whose midpoints both fall within this of the
# station's own (pre-snap) coordinate counts as "this station's crossing" —
# tight enough to exclude a nearby-but-different interchange's crossing
# (e.g. St George's, ~220m from Spadina) while still catching every real
# crossing found for the three interchanges checked (91m at Bloor-Yonge,
# 40-185m across St George's cluster).
INTERSECTION_SEARCH_RADIUS_M = 200.0
# Real crossings this close together are the same physical junction, just
# split across a couple of shape segments — collapsed into one point by averaging.
INTERSECTION_CLUSTER_RADIUS_M = 60.0


def _local_xy(lon: float, lat: float, ref_lat: float) -> tuple[float, float]:
    """Equirectangular projection to local planar meters around `ref_lat` —
    accurate enough at city scale for nearest-point/intersection math, and
    much simpler than full geodesic segment projection."""
    ref_rad = math.radians(ref_lat)
    x = math.radians(lon) * math.cos(ref_rad) * EARTH_RADIUS_M
    y = math.radians(lat) * EARTH_RADIUS_M
    return x, y


def _local_lonlat(x: float, y: float, ref_lat: float) -> tuple[float, float]:
    ref_rad = math.radians(ref_lat)
    lon = math.degrees(x / (EARTH_RADIUS_M * math.cos(ref_rad)))
    lat = math.degrees(y / EARTH_RADIUS_M)
    return lon, lat


def _haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = a
    lon2, lat2 = b
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    h = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def _nearest_point_on_polyline(
    point: tuple[float, float], polyline: list[tuple[float, float]]
) -> tuple[tuple[float, float], float]:
    """(snapped [lon, lat], distance_m) — the closest point anywhere along
    `polyline` (a sequence of [lon, lat] vertices, consecutive pairs treated
    as segments) to `point`."""
    ref_lat = point[1]
    px, py = _local_xy(point[0], point[1], ref_lat)

    best: Optional[tuple[float, float]] = None
    best_dist_sq = math.inf
    for i in range(len(polyline) - 1):
        ax, ay = _local_xy(polyline[i][0], polyline[i][1], ref_lat)
        bx, by = _local_xy(polyline[i + 1][0], polyline[i + 1][1], ref_lat)
        dx, dy = bx - ax, by - ay
        length_sq = dx * dx + dy * dy
        t = 0.0 if length_sq == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
        sx, sy = ax + t * dx, ay + t * dy
        dist_sq = (px - sx) ** 2 + (py - sy) ** 2
        if dist_sq < best_dist_sq:
            best_dist_sq = dist_sq
            best = (sx, sy)

    assert best is not None
    snapped_lon, snapped_lat = _local_lonlat(best[0], best[1], ref_lat)
    return (snapped_lon, snapped_lat), math.sqrt(best_dist_sq)


def _segment_intersection(
    a1: tuple[float, float], a2: tuple[float, float], b1: tuple[float, float], b2: tuple[float, float]
) -> Optional[tuple[float, float]]:
    """Standard 2D segment-segment intersection point, or None if they don't
    cross within both segments' bounds. Done directly in [lon, lat] — fine
    for a pure yes/no + location crossing test at this scale (segments only
    a few hundred meters long), unlike distance math which needs the
    equirectangular projection above."""
    x1, y1 = a1
    x2, y2 = a2
    x3, y3 = b1
    x4, y4 = b2
    denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(denom) < 1e-15:
        return None
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
    u = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / denom
    if not (0 <= t <= 1 and 0 <= u <= 1):
        return None
    return (x1 + t * (x2 - x1), y1 + t * (y2 - y1))


def _find_intersections_near(
    line_a: list[tuple[float, float]],
    line_b: list[tuple[float, float]],
    near: tuple[float, float],
    radius_m: float,
) -> list[tuple[float, float]]:
    def midpoint(p: tuple[float, float], q: tuple[float, float]) -> tuple[float, float]:
        return ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)

    hits: list[tuple[float, float]] = []
    for i in range(len(line_a) - 1):
        a1, a2 = line_a[i], line_a[i + 1]
        if _haversine_m(midpoint(a1, a2), near) > radius_m:
            continue
        for j in range(len(line_b) - 1):
            b1, b2 = line_b[j], line_b[j + 1]
            if _haversine_m(midpoint(b1, b2), near) > radius_m:
                continue
            point = _segment_intersection(a1, a2, b1, b2)
            if point is not None:
                hits.append(point)
    return hits


def _cluster_centroid(points: list[tuple[float, float]], cluster_radius_m: float) -> tuple[float, float]:
    """Averages a set of near-duplicate crossing points (the same physical
    junction split across a couple of shape segments) into one. Assumes the
    whole set is one cluster — true for every case this script encounters
    (checked via the printed spread below); doesn't attempt general
    multi-cluster grouping."""
    spread = max(_haversine_m(points[0], p) for p in points) if len(points) > 1 else 0.0
    if spread > cluster_radius_m:
        print(
            f"  WARNING: intersection points span {spread:.0f}m (> {cluster_radius_m:.0f}m) — "
            "averaging anyway, but this may not be one real junction",
            file=sys.stderr,
        )
    avg_lon = sum(p[0] for p in points) / len(points)
    avg_lat = sum(p[1] for p in points) / len(points)
    return (avg_lon, avg_lat)


def snap() -> None:
    stations = json.loads(STATIONS_PATH.read_text())
    shapes = json.loads(SHAPES_PATH.read_text())

    lines_with_shapes: dict[str, list[tuple[float, float]]] = {
        line_id: [(p[0], p[1]) for p in data["shapePoints"]] for line_id, data in shapes.items()
    }

    changed = 0
    for station in stations:
        current = (station["coordinates"][0], station["coordinates"][1])
        station_lines = [str(line_id) for line_id in station["lines"] if str(line_id) in lines_with_shapes]

        if not station_lines:
            continue

        if len(station_lines) == 1:
            snapped, distance = _nearest_point_on_polyline(current, lines_with_shapes[station_lines[0]])
            reason = f"nearest point on line {station_lines[0]} ({distance:.1f}m away)"
        else:
            line_a, line_b = lines_with_shapes[station_lines[0]], lines_with_shapes[station_lines[1]]
            crossings = _find_intersections_near(line_a, line_b, current, INTERSECTION_SEARCH_RADIUS_M)
            if crossings:
                snapped = _cluster_centroid(crossings, INTERSECTION_CLUSTER_RADIUS_M)
                reason = f"intersection of lines {station_lines[0]}/{station_lines[1]} ({len(crossings)} crossing(s) found)"
            else:
                # No literal track crossing within range (e.g. Spadina — the
                # interchange is a connecting corridor, not a junction) —
                # split the difference between each line's own nearest point.
                point_a, _ = _nearest_point_on_polyline(current, line_a)
                point_b, _ = _nearest_point_on_polyline(current, line_b)
                snapped = ((point_a[0] + point_b[0]) / 2, (point_a[1] + point_b[1]) / 2)
                reason = f"no crossing found for lines {station_lines[0]}/{station_lines[1]}, using midpoint of each line's nearest point"

        moved_m = _haversine_m(current, snapped)
        print(f"{station['id']}: moved {moved_m:.1f}m — {reason}", file=sys.stderr)
        station["coordinates"] = [round(snapped[0], 6), round(snapped[1], 6)]
        changed += 1

    STATIONS_PATH.write_text(json.dumps(stations, indent=2) + "\n")
    print(f"\nSnapped {changed}/{len(stations)} stations. Wrote {STATIONS_PATH}", file=sys.stderr)


if __name__ == "__main__":
    snap()
