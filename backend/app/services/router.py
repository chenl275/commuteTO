"""Multi-modal (Walk + Bus + Streetcar + Subway) time-dependent shortest-path
router, over the full TTC GTFS static schedule.

Implements a time-dependent Dijkstra (see
scripts/build_gtfs_routing_index.py for how the ~4.3M-row stop_times.txt is
preprocessed into the indexed SQLite database this module queries): from the
set of stops walkable from the origin, expand outward through scheduled
transit rides — boarding, for every route serving a settled stop, the
earliest trip catchable at the current time (the standard "earliest trip per
route" simplification also used by RAPTOR, valid under the FIFO assumption
that a later-departing trip on a route never overtakes an earlier one on the
same route) — plus short walking transfers between nearby stops, until a stop
walkable to the destination is reached. Subway kinematic delay and live
streetcar/bus detour delay are layered on afterwards, onto whichever legs of
the winning itinerary they actually apply to (see _augment_with_live_delays).
"""

from __future__ import annotations

import asyncio
import heapq
import math
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Optional, Tuple

from . import gtfs_service, stations
from .detour_service import get_detours_for_routes
from .slow_zones_scraper import get_slow_zones
from . import surface_realtime_service

_DB_PATH = Path(__file__).resolve().parents[1] / "data" / "gtfs_routing.db"

WALK_SPEED_METERS_PER_MINUTE = 80.0
# Real pedestrian paths follow the street grid, not a straight line — this
# inflates straight-line (haversine) distance to a rough walking-distance estimate.
WALK_GRID_FACTOR = 1.25
MAX_INITIAL_WALK_METERS = 800.0
MAX_TRANSFER_WALK_METERS = 250.0
MAX_NEARBY_STOP_CANDIDATES = 25
MAX_TRANSFER_CANDIDATES = 6

# Bounds the search so a query near closing time, or toward an unreachable
# destination, can't scan indefinitely.
SEARCH_HORIZON_MINUTES = 90
MAX_SETTLED_STOPS = 8000
MAX_TRIP_FANOUT_STOPS = 120
# Minimum realistic alight-and-reboard time at the same physical stop, so a
# same-platform 0-second transfer isn't preferred over a genuinely faster
# nearby alternative purely because it's modeled as instantaneous.
TRANSFER_BUFFER_SECONDS = 60
# Fixed in-station transfer time between sibling platforms at the same
# subway interchange complex (e.g. Line 1 <-> Line 2 at Bloor-Yonge, St
# George, or Spadina) — a short, real, indoor walk between platforms, not a
# haversine-distance walk estimate through the street grid like an ordinary
# nearby-stop transfer (see _sibling_platforms/WALK_GRID_FACTOR).
SAME_STATION_TRANSFER_SECONDS = 60.0

_ORIGIN_NODE = "__origin__"
_DESTINATION_NODE = "__destination__"

# GTFS route_type -> this app's leg mode (see routes.txt: this feed only uses
# 0=streetcar/tram, 1=subway/metro, 3=bus).
_ROUTE_TYPE_TO_MODE = {0: "streetcar", 1: "subway", 3: "bus"}
_SUBWAY_ROUTE_SHORT_NAMES = {"1", "2", "4"}

_WEEKDAY_COLUMNS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

EARTH_RADIUS_M = 6_371_000.0

# TTC's raw GTFS stop names encode a subway platform's own local heading —
# e.g. "College Station - Southbound Platform" — which is accurate for the
# rider's boarding experience at that specific stop, but not a single
# consistent "trip direction": on a loop-shaped line like Line 1, the same
# physical train's platform label changes as it curves through Union (a
# College->Union rider boards a "Southbound Platform" and alights at a stop
# GTFS labels "Northbound Platform ..." on the other side of that same
# curve). So a leg's rider-facing direction is always read off its
# *boarding* stop's raw name (see _build_itinerary), never the alighting one.
_DIRECTION_PATTERN = re.compile(r"-\s*(Northbound|Southbound|Eastbound|Westbound)\s+Platform", re.IGNORECASE)
# Strips that same internal platform descriptor (direction + optional
# "Towards X" clause, or the directionless "Subway Platform" some termini
# use) so a raw stop name reads as a plain, rider-facing station name.
_PLATFORM_SUFFIX_PATTERN = re.compile(
    r"\s*-\s*(Northbound|Southbound|Eastbound|Westbound|Subway)\s+Platform(\s+Towards\s+.+)?$",
    re.IGNORECASE,
)


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    h = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def _walk_minutes(distance_meters: float) -> float:
    return (distance_meters * WALK_GRID_FACTOR) / WALK_SPEED_METERS_PER_MINUTE


def _get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{_DB_PATH}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only = TRUE")
    return conn


@dataclass
class ItineraryLeg:
    mode: str  # "walk" | "bus" | "streetcar" | "subway"
    route_short_name: Optional[str]
    route_long_name: Optional[str]
    from_name: str
    to_name: str
    from_coordinates: Tuple[float, float]  # (lon, lat)
    to_coordinates: Tuple[float, float]
    stop_count: int
    distance_meters: Optional[float]
    departure_sec: float
    arrival_sec: float
    # GTFS stop ids (not our subway "station" ids) — None for the virtual
    # origin/destination ends of the trip. Used to cross-reference live
    # subway delay data in _augment_with_live_delays.
    from_stop_id: Optional[str] = None
    to_stop_id: Optional[str] = None
    path: list = field(default_factory=list)  # [[lon, lat], ...] in travel order
    # Rider-facing compass direction ("Southbound", ...), read off this leg's
    # *boarding* stop — see _extract_direction. None for a walk leg, or a
    # transit leg boarding at a stop with no directional platform label.
    direction: Optional[str] = None

    @property
    def duration_minutes(self) -> float:
        return (self.arrival_sec - self.departure_sec) / 60.0


@dataclass
class Itinerary:
    legs: list  # list[ItineraryLeg], in travel order
    departure_sec: float
    arrival_sec: float
    # Total seconds of live/kinematic delay layered onto the legs above,
    # already reflected in their arrival_sec/duration — kept separately so
    # callers can still report a scheduled-vs-actual breakdown.
    delay_seconds: float = 0.0
    # The worst single live-observed delay (see surface_realtime_service)
    # found on a streetcar leg, and separately a bus leg, of this
    # itinerary — a subset of delay_seconds above, broken out so the UI can
    # label a surface delay distinctly ("Streetcar Delay"/"Traffic Delay")
    # instead of folding it into the subway-oriented "Track Slowdown" badge.
    # 0.0 when no leg of that mode has a live delay reading.
    streetcar_delay_seconds: float = 0.0
    bus_delay_seconds: float = 0.0


def _bbox(lat: float, lon: float, radius_m: float) -> Tuple[float, float, float, float]:
    dlat = radius_m / 111_320.0
    dlon = radius_m / (111_320.0 * max(math.cos(math.radians(lat)), 0.1))
    return lat - dlat, lat + dlat, lon - dlon, lon + dlon


def _nearby_stops(
    conn: sqlite3.Connection,
    lat: float,
    lon: float,
    radius_m: float,
    exclude_stop_id: Optional[str] = None,
) -> list[tuple[str, str, float, float, float]]:
    """(stop_id, name, lat, lon, distance_m) within `radius_m`, nearest first."""
    lat_min, lat_max, lon_min, lon_max = _bbox(lat, lon, radius_m)
    rows = conn.execute(
        "SELECT stop_id, name, lat, lon FROM stops WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
        (lat_min, lat_max, lon_min, lon_max),
    ).fetchall()
    results = []
    for stop_id, name, stop_lat, stop_lon in rows:
        if stop_id == exclude_stop_id:
            continue
        distance = _haversine_m(lat, lon, stop_lat, stop_lon)
        if distance <= radius_m:
            results.append((stop_id, name, stop_lat, stop_lon, distance))
    results.sort(key=lambda r: r[4])
    return results


def _active_service_ids(conn: sqlite3.Connection, on_date: date) -> set[str]:
    """Service ids running on `on_date`, from calendar.txt's weekly pattern
    plus calendar_dates.txt's day-specific add/remove exceptions.

    A post-midnight trip (GTFS arrival/departure past 24:00:00) is still
    filed under the *previous* day's service id — not modeled here, so a
    departure in the first couple hours after midnight may miss those very
    late-running trips. An accepted gap given this app's scope."""
    weekday_col = _WEEKDAY_COLUMNS[on_date.weekday()]
    date_str = on_date.strftime("%Y%m%d")
    rows = conn.execute(
        f"SELECT service_id, start_date, end_date FROM calendar WHERE {weekday_col} = 1"
    ).fetchall()
    active = {service_id for service_id, start, end in rows if start <= date_str <= end}
    for service_id, _date, exception_type in conn.execute(
        "SELECT service_id, date, exception_type FROM calendar_dates WHERE date = ?", (date_str,)
    ):
        if exception_type == 1:
            active.add(service_id)
        elif exception_type == 2:
            active.discard(service_id)
    return active


def _route_ids_at_stop(conn: sqlite3.Connection, stop_id: str) -> list[str]:
    return [row[0] for row in conn.execute("SELECT route_id FROM stop_routes WHERE stop_id = ?", (stop_id,))]


def _sibling_platforms(conn: sqlite3.Connection, stop_id: str) -> list[tuple[str, str, float, float]]:
    """(stop_id, name, lat, lon) for every other platform sharing `stop_id`'s
    parent_station — e.g. the Line 1 and Line 2 platforms at Bloor-Yonge,
    St George, or Spadina. TTC's static feed ships every platform as a
    standalone stop with no parent_station of its own, so this is a synthetic
    grouping built at index time (see build_gtfs_routing_index.py) from our
    canonical GTFS-stop -> station-id mapping — real for every subway
    interchange, empty (no rows) for an ordinary surface stop."""
    return conn.execute(
        "SELECT s2.stop_id, s2.name, s2.lat, s2.lon FROM stops s1 "
        "JOIN stops s2 ON s2.parent_station = s1.parent_station AND s2.stop_id != s1.stop_id "
        "WHERE s1.stop_id = ? AND s1.parent_station IS NOT NULL",
        (stop_id,),
    ).fetchall()


def _earliest_trips_per_route(
    conn: sqlite3.Connection,
    stop_id: str,
    after_sec: float,
    route_ids: list[str],
    active_service_ids: set[str],
) -> dict[str, tuple[str, int, int]]:
    """route_id -> (trip_id, departure_sec, stop_sequence) for the earliest
    trip on each of `route_ids` catchable at `stop_id` at/after `after_sec`."""
    if not route_ids:
        return {}
    remaining = set(route_ids)
    found: dict[str, tuple[str, int, int]] = {}
    rows = conn.execute(
        "SELECT st.trip_id, st.departure_sec, st.stop_sequence, t.route_id, t.service_id "
        "FROM stop_times st JOIN trips t ON st.trip_id = t.trip_id "
        "WHERE st.stop_id = ? AND st.departure_sec >= ? "
        "ORDER BY st.departure_sec ASC LIMIT 500",
        (stop_id, int(after_sec)),
    )
    for trip_id, departure_sec, stop_sequence, route_id, service_id in rows:
        if route_id not in remaining or service_id not in active_service_ids:
            continue
        found[route_id] = (trip_id, departure_sec, stop_sequence)
        remaining.discard(route_id)
        if not remaining:
            break
    return found


def _trip_fanout(conn: sqlite3.Connection, trip_id: str, from_sequence: int) -> list[tuple[str, int, int]]:
    """(stop_id, arrival_sec, stop_sequence) for every stop after
    `from_sequence` on `trip_id` — capped at MAX_TRIP_FANOUT_STOPS so an
    unusually long route can't blow up a single relaxation step."""
    return conn.execute(
        "SELECT stop_id, arrival_sec, stop_sequence FROM stop_times "
        "WHERE trip_id = ? AND stop_sequence > ? ORDER BY stop_sequence ASC LIMIT ?",
        (trip_id, from_sequence, MAX_TRIP_FANOUT_STOPS),
    ).fetchall()


def _route_meta(conn: sqlite3.Connection, route_id: str) -> Optional[tuple[str, str, int]]:
    row = conn.execute(
        "SELECT short_name, long_name, route_type FROM routes WHERE route_id = ?", (route_id,)
    ).fetchone()
    return tuple(row) if row else None


def _stop_info(conn: sqlite3.Connection, stop_id: str) -> tuple[str, float, float]:
    return conn.execute("SELECT name, lat, lon FROM stops WHERE stop_id = ?", (stop_id,)).fetchone()


def _extract_direction(raw_name: str) -> Optional[str]:
    """"Southbound"/"Northbound"/"Eastbound"/"Westbound" read off a raw stop
    name's own platform descriptor, or None for a stop that doesn't carry
    one (a surface stop, or a single-platform terminus like Kipling/Finch/
    VMC's "... Subway Platform")."""
    match = _DIRECTION_PATTERN.search(raw_name)
    return match.group(1).capitalize() if match else None


def _clean_stop_name(stop_id: str, raw_name: str) -> str:
    """Rider-facing station name for a GTFS stop: the canonical station
    registry's name (e.g. "Union", "Bloor-Yonge") for a subway platform —
    which also collapses TTC's separate per-street raw names for the same
    interchange (e.g. "Bloor Station"/"Yonge Station") into the one name
    riders actually know it by — falling back to stripping the internal
    platform descriptor (see _PLATFORM_SUFFIX_PATTERN) for anything not in
    that registry, e.g. a surface stop, or a subway platform this build's
    gtfs_stop_mapping.json doesn't happen to cover."""
    canonical_station_id = gtfs_service.get_station_id_for_stop(stop_id)
    if canonical_station_id:
        canonical_name = stations.station_name(canonical_station_id)
        if canonical_name:
            return canonical_name
    return _PLATFORM_SUFFIX_PATTERN.sub("", raw_name).strip()


def _shape_dist_at_sequence(conn: sqlite3.Connection, trip_id: str, stop_sequence: int) -> Optional[float]:
    """`shape_dist_traveled` for one stop on `trip_id`, or None if that stop
    row doesn't exist. TTC's feed leaves this column blank specifically (and
    only, verified against the full feed) on a trip's very first stop —
    exactly where the implied distance is 0 — so that case is filled in
    rather than treated as missing, which would otherwise silently drop the
    curved-shape rendering for every leg that boards at a route terminus."""
    row = conn.execute(
        "SELECT shape_dist_traveled FROM stop_times WHERE trip_id = ? AND stop_sequence = ?",
        (trip_id, stop_sequence),
    ).fetchone()
    if row is None:
        return None
    dist = row[0]
    if dist is not None:
        return dist
    return 0.0 if stop_sequence == 1 else None


def _transit_leg_path(
    conn: sqlite3.Connection,
    trip_id: str,
    from_stop_sequence: int,
    to_stop_sequence: int,
    from_lon: float,
    from_lat: float,
    to_lon: float,
    to_lat: float,
) -> list[list[float]]:
    """[lon, lat] points for one transit leg (one continuous ride on
    `trip_id`, boarding at `from_stop_sequence` and alighting at
    `to_stop_sequence`), following the vehicle's real physical path from
    shapes.txt rather than straight chords between consecutive stop
    coordinates. Straight stop-to-stop chords are a reasonable approximation
    almost everywhere, but visibly cut across the track near a sharp turn —
    most noticeably Line 1's loop through Union, where a chord from, say, St
    Andrew to Union to King draws a straight line that crosses the parallel
    Yonge-side track instead of following the real curve, reading as a
    "bowtie" on the map.

    Anchored onto the exact boarding/alighting stop coordinates at both
    ends — shape points trace the vehicle's path, not necessarily through
    the exact platform coordinate used elsewhere (station markers, the walk
    legs immediately before/after this one) — so the rendered line stays
    visually continuous with them. Falls back to the stop-to-stop chord
    (still correctly ordered by stop_sequence, just without the curved
    in-between geometry) whenever this trip has no usable shape data."""
    row = conn.execute("SELECT shape_id FROM trips WHERE trip_id = ?", (trip_id,)).fetchone()
    shape_id = row[0] if row else None

    shape_points: list[list[float]] = []
    if shape_id:
        from_dist = _shape_dist_at_sequence(conn, trip_id, from_stop_sequence)
        to_dist = _shape_dist_at_sequence(conn, trip_id, to_stop_sequence)
        if from_dist is not None and to_dist is not None:
            lo, hi = min(from_dist, to_dist), max(from_dist, to_dist)
            shape_points = [
                [lon, lat]
                for lat, lon in conn.execute(
                    "SELECT lat, lon FROM shapes WHERE shape_id = ? AND dist BETWEEN ? AND ? ORDER BY seq ASC",
                    (shape_id, lo, hi),
                ).fetchall()
            ]

    if len(shape_points) >= 2:
        return [[from_lon, from_lat], *shape_points, [to_lon, to_lat]]

    # No shape data for this trip (or the distance window matched nothing) —
    # fall back to the stop-to-stop chord.
    path: list[list[float]] = []
    for (stop_id,) in conn.execute(
        "SELECT stop_id FROM stop_times WHERE trip_id = ? AND stop_sequence BETWEEN ? AND ? "
        "ORDER BY stop_sequence ASC",
        (trip_id, from_stop_sequence, to_stop_sequence),
    ):
        _name, lat, lon = _stop_info(conn, stop_id)
        path.append([lon, lat])
    return path


@dataclass
class _Edge:
    kind: str  # "walk" | "transit"
    from_node: str
    to_node: str
    depart_sec: float
    arrive_sec: float
    # transit-only:
    route_id: Optional[str] = None
    trip_id: Optional[str] = None
    from_stop_sequence: Optional[int] = None
    to_stop_sequence: Optional[int] = None
    # walk-only:
    distance_meters: Optional[float] = None


def _reconstruct(prev: dict[str, _Edge], end_node: str) -> list[_Edge]:
    edges: list[_Edge] = []
    node = end_node
    while node in prev:
        edge = prev[node]
        edges.append(edge)
        node = edge.from_node
    edges.reverse()
    return edges


def _run_dijkstra(
    conn: sqlite3.Connection,
    origin_lat: float,
    origin_lon: float,
    destination_lat: float,
    destination_lon: float,
    departure_sec: float,
    on_date: date,
    penalized_route_ids: Optional[set[str]] = None,
    penalty_multiplier: float = 1.0,
) -> Optional[list[_Edge]]:
    """`penalized_route_ids`/`penalty_multiplier` bias the search away from
    reusing those routes, without distorting the *real* schedule times
    stored on the returned edges: a separate `priority` value (search-order
    only) is inflated for a penalized route's edges, while `dist` — and
    every _Edge's depart_sec/arrive_sec — always stays the genuine
    GTFS-scheduled time. Used by find_itineraries to search for a second,
    genuinely different itinerary after the unpenalized primary search
    already found the fastest one, whose displayed duration must still be
    real, not inflated by the very penalty used to find it."""
    active_service_ids = _active_service_ids(conn, on_date)

    origin_stops = _nearby_stops(conn, origin_lat, origin_lon, MAX_INITIAL_WALK_METERS)[:MAX_NEARBY_STOP_CANDIDATES]
    destination_stops = _nearby_stops(conn, destination_lat, destination_lon, MAX_INITIAL_WALK_METERS)[
        :MAX_NEARBY_STOP_CANDIDATES
    ]
    destination_walk: dict[str, tuple[float, float]] = {
        stop_id: (_walk_minutes(distance) * 60, distance) for stop_id, _n, _la, _lo, distance in destination_stops
    }

    dist: dict[str, float] = {_ORIGIN_NODE: departure_sec}
    priority: dict[str, float] = {_ORIGIN_NODE: departure_sec}
    prev: dict[str, _Edge] = {}
    arrived_via: dict[str, str] = {_ORIGIN_NODE: "origin"}
    settled: set[str] = set()
    heap: list[tuple[float, str]] = [(departure_sec, _ORIGIN_NODE)]

    def relax(from_node: str, to_node: str, real_arrival: float, edge: _Edge, via: str) -> None:
        cost = real_arrival - dist[from_node]
        if penalized_route_ids and edge.route_id in penalized_route_ids:
            cost *= penalty_multiplier
        candidate_priority = priority[from_node] + cost
        if candidate_priority < priority.get(to_node, math.inf):
            dist[to_node] = real_arrival
            priority[to_node] = candidate_priority
            arrived_via[to_node] = via
            prev[to_node] = edge
            heapq.heappush(heap, (candidate_priority, to_node))

    # Direct walk, bypassing transit entirely, for a short origin-destination hop.
    direct_distance = _haversine_m(origin_lat, origin_lon, destination_lat, destination_lon)
    if direct_distance <= MAX_INITIAL_WALK_METERS * 2:
        arrive = departure_sec + _walk_minutes(direct_distance) * 60
        edge = _Edge("walk", _ORIGIN_NODE, _DESTINATION_NODE, departure_sec, arrive, distance_meters=direct_distance)
        relax(_ORIGIN_NODE, _DESTINATION_NODE, arrive, edge, "origin")

    for stop_id, _name, _lat, _lon, distance in origin_stops:
        arrive = departure_sec + _walk_minutes(distance) * 60
        edge = _Edge("walk", _ORIGIN_NODE, stop_id, departure_sec, arrive, distance_meters=distance)
        relax(_ORIGIN_NODE, stop_id, arrive, edge, "walk")

    horizon_sec = departure_sec + SEARCH_HORIZON_MINUTES * 60
    settled_count = 0

    while heap:
        _priority_value, node = heapq.heappop(heap)
        if node in settled:
            continue
        settled.add(node)
        arrival_sec = dist[node]

        if node == _DESTINATION_NODE:
            return _reconstruct(prev, _DESTINATION_NODE)

        if arrival_sec > horizon_sec or settled_count > MAX_SETTLED_STOPS:
            continue
        settled_count += 1

        walk_to_destination = destination_walk.get(node)
        if walk_to_destination is not None:
            walk_seconds, distance = walk_to_destination
            arrive = arrival_sec + walk_seconds
            edge = _Edge("walk", node, _DESTINATION_NODE, arrival_sec, arrive, distance_meters=distance)
            relax(node, _DESTINATION_NODE, arrive, edge, "walk")

        route_ids = _route_ids_at_stop(conn, node)
        board_after = arrival_sec + (TRANSFER_BUFFER_SECONDS if arrived_via.get(node) == "transit" else 0)
        boardings = _earliest_trips_per_route(conn, node, board_after, route_ids, active_service_ids)
        for route_id, (trip_id, departure, from_sequence) in boardings.items():
            for to_stop_id, arrival, to_sequence in _trip_fanout(conn, trip_id, from_sequence):
                candidate_arrival = float(arrival)
                edge = _Edge(
                    "transit",
                    node,
                    to_stop_id,
                    float(departure),
                    candidate_arrival,
                    route_id=route_id,
                    trip_id=trip_id,
                    from_stop_sequence=from_sequence,
                    to_stop_sequence=to_sequence,
                )
                relax(node, to_stop_id, candidate_arrival, edge, "transit")

        # Short walking transfers to other nearby stops — only from a stop
        # reached by transit; walk-to-walk chaining never helps, since
        # walking there directly from the previous node is at least as fast.
        if arrived_via.get(node) == "transit":
            # Sibling platforms at the same subway interchange complex (e.g.
            # Line 1 <-> Line 2 at Bloor-Yonge/St George/Spadina) get a fixed
            # short in-station transfer instead of a distance-estimated walk
            # — real interchange platforms can sit close enough that
            # haversine distance would otherwise price the transfer as
            # near-instant, or occasionally just outside MAX_TRANSFER_WALK_METERS
            # and get missed entirely.
            for to_stop_id, _n, _la, _lo in _sibling_platforms(conn, node):
                arrive = arrival_sec + SAME_STATION_TRANSFER_SECONDS
                edge = _Edge("walk", node, to_stop_id, arrival_sec, arrive, distance_meters=0.0)
                relax(node, to_stop_id, arrive, edge, "walk")

            row = conn.execute("SELECT lat, lon FROM stops WHERE stop_id = ?", (node,)).fetchone()
            if row:
                node_lat, node_lon = row
                for to_stop_id, _n, _la, _lo, distance in _nearby_stops(
                    conn, node_lat, node_lon, MAX_TRANSFER_WALK_METERS, exclude_stop_id=node
                )[:MAX_TRANSFER_CANDIDATES]:
                    arrive = arrival_sec + _walk_minutes(distance) * 60
                    edge = _Edge("walk", node, to_stop_id, arrival_sec, arrive, distance_meters=distance)
                    relax(node, to_stop_id, arrive, edge, "walk")

    return None


def _build_itinerary(
    conn: sqlite3.Connection,
    edges: list[_Edge],
    origin_coords: Tuple[float, float],
    destination_coords: Tuple[float, float],
    origin_name: str,
    destination_name: str,
) -> Itinerary:
    legs: list[ItineraryLeg] = []
    route_meta_cache: dict[str, Optional[tuple[str, str, int]]] = {}

    for edge in edges:
        if edge.from_node == _ORIGIN_NODE:
            from_name, from_lon, from_lat, from_stop_id, from_direction = (
                origin_name,
                origin_coords[0],
                origin_coords[1],
                None,
                None,
            )
        else:
            raw_name, lat, lon = _stop_info(conn, edge.from_node)
            from_name, from_lon, from_lat, from_stop_id, from_direction = (
                _clean_stop_name(edge.from_node, raw_name),
                lon,
                lat,
                edge.from_node,
                _extract_direction(raw_name),
            )

        if edge.to_node == _DESTINATION_NODE:
            to_name, to_lon, to_lat, to_stop_id = destination_name, destination_coords[0], destination_coords[1], None
        else:
            raw_name, lat, lon = _stop_info(conn, edge.to_node)
            to_name, to_lon, to_lat, to_stop_id = _clean_stop_name(edge.to_node, raw_name), lon, lat, edge.to_node

        if edge.kind == "walk":
            legs.append(
                ItineraryLeg(
                    mode="walk",
                    route_short_name=None,
                    route_long_name=None,
                    from_name=from_name,
                    to_name=to_name,
                    from_coordinates=(from_lon, from_lat),
                    to_coordinates=(to_lon, to_lat),
                    stop_count=0,
                    distance_meters=edge.distance_meters,
                    departure_sec=edge.depart_sec,
                    arrival_sec=edge.arrive_sec,
                    from_stop_id=from_stop_id,
                    to_stop_id=to_stop_id,
                    path=[[from_lon, from_lat], [to_lon, to_lat]],
                )
            )
            continue

        if edge.route_id not in route_meta_cache:
            route_meta_cache[edge.route_id] = _route_meta(conn, edge.route_id)
        meta = route_meta_cache[edge.route_id]
        short_name, long_name, route_type = meta if meta else (edge.route_id, None, 3)
        mode = _ROUTE_TYPE_TO_MODE.get(route_type, "bus")

        path = _transit_leg_path(
            conn, edge.trip_id, edge.from_stop_sequence, edge.to_stop_sequence, from_lon, from_lat, to_lon, to_lat
        )

        legs.append(
            ItineraryLeg(
                mode=mode,
                route_short_name=short_name,
                route_long_name=long_name,
                from_name=from_name,
                to_name=to_name,
                from_coordinates=(from_lon, from_lat),
                to_coordinates=(to_lon, to_lat),
                stop_count=edge.to_stop_sequence - edge.from_stop_sequence,
                distance_meters=None,
                departure_sec=edge.depart_sec,
                arrival_sec=edge.arrive_sec,
                from_stop_id=from_stop_id,
                to_stop_id=to_stop_id,
                path=path,
                direction=from_direction,
            )
        )

    return Itinerary(
        legs=legs,
        departure_sec=edges[0].depart_sec if edges else 0.0,
        arrival_sec=edges[-1].arrive_sec if edges else 0.0,
    )


async def _augment_with_live_delays(itinerary: Itinerary) -> Tuple[float, float, float]:
    """Mutates `itinerary`'s legs in place: adds subway kinematic/live delay
    and surface (streetcar/bus) live/detour delay onto whichever legs they
    apply to, shifting every later leg's times by the same cumulative
    amount — the same modeling traffic_service.py applies to a subway-only
    trip, reused here per-leg for a general multi-modal itinerary. Returns
    (total delay seconds added, worst single streetcar-leg delay, worst
    single bus-leg delay) — the latter two are a subset of the total, kept
    separate so callers can label a surface delay distinctly ("Streetcar
    Delay"/"Traffic Delay") instead of folding it into the subway-oriented
    "Track Slowdown" badge."""
    if not itinerary.legs:
        return 0.0, 0.0, 0.0

    cumulative_shift = 0.0
    total_added = 0.0
    streetcar_worst = 0.0
    bus_worst = 0.0
    slow_zones_cache: Optional[dict] = None

    for leg in itinerary.legs:
        leg.departure_sec += cumulative_shift
        leg.arrival_sec += cumulative_shift

        added_seconds = 0.0
        if leg.mode == "subway" and leg.route_short_name in _SUBWAY_ROUTE_SHORT_NAMES and leg.from_stop_id and leg.to_stop_id:
            line = int(leg.route_short_name)
            from_station_id = gtfs_service.get_station_id_for_stop(leg.from_stop_id)
            to_station_id = gtfs_service.get_station_id_for_stop(leg.to_stop_id)
            if from_station_id and to_station_id:
                if slow_zones_cache is None:
                    slow_zones_cache = await get_slow_zones()
                zones_on_leg = stations.zones_along_route(
                    line, from_station_id, to_station_id, slow_zones_cache["slowZones"]
                )
                kinematic_seconds = sum(zone["delaySeconds"] for zone in zones_on_leg)

                live_seconds = 0
                for station_id in stations.stations_on_route(line, from_station_id, to_station_id):
                    observed = await gtfs_service.get_live_station_delay(station_id)
                    if observed is not None and observed > live_seconds:
                        live_seconds = observed
                added_seconds = float(live_seconds) if live_seconds > 0 else kinematic_seconds
        elif leg.mode in ("streetcar", "bus") and leg.route_short_name:
            # Live TripUpdates (real vehicles genuinely running behind, e.g.
            # traffic) takes priority over the detour feed's flat estimate,
            # same "live observed beats modeled" precedent as subway above —
            # only falls back to the detour penalty when this leg's route
            # has no usable live reading right now.
            leg_stop_ids = [stop_id for stop_id in (leg.from_stop_id, leg.to_stop_id) if stop_id]
            live_seconds = (
                await surface_realtime_service.get_route_delay_seconds(leg.route_short_name, leg_stop_ids)
                if leg_stop_ids
                else None
            )
            if live_seconds is not None and live_seconds > 0:
                added_seconds = float(live_seconds)
            else:
                detours = await get_detours_for_routes({leg.route_short_name})
                active_penalties = [d["penaltyMinutes"] for d in detours if not d["isFuture"]]
                if active_penalties:
                    added_seconds = max(active_penalties) * 60

            if leg.mode == "streetcar":
                streetcar_worst = max(streetcar_worst, added_seconds)
            else:
                bus_worst = max(bus_worst, added_seconds)

        if added_seconds > 0:
            leg.arrival_sec += added_seconds
            cumulative_shift += added_seconds
            total_added += added_seconds

    return total_added, streetcar_worst, bus_worst


# How much more expensive a penalized route's edges look to the alternative
# search (see find_itineraries) than they really are — big enough to make a
# competitive different route win out, small enough that the search doesn't
# reach for something absurd when the primary's routes are genuinely the
# only reasonable way to make the trip.
ALTERNATIVE_ROUTE_PENALTY_MULTIPLIER = 1.5


def _transit_route_signature(edges: list[_Edge]) -> tuple:
    """The sequence of actual trips ridden (ignoring walk edges) — two
    itineraries with this in common are the same real route, even if the
    walk legs bracketing them differ slightly."""
    return tuple((edge.trip_id, edge.from_stop_sequence, edge.to_stop_sequence) for edge in edges if edge.kind == "transit")


async def find_itineraries(
    origin: Tuple[float, float],
    destination: Tuple[float, float],
    departure: datetime,
    origin_name: str = "Origin",
    destination_name: str = "Destination",
    max_alternatives: int = 0,
) -> list[Itinerary]:
    """Like find_itinerary, but can also search for up to `max_alternatives`
    genuinely different itineraries — a route using different lines/trips
    than the primary, found via penalized Dijkstra on the primary's own
    routes (see _run_dijkstra's penalized_route_ids) rather than a full
    Yen's-algorithm k-shortest-paths search, which would need re-running the
    whole search once per *excluded edge* rather than just once more. The
    penalty only biases which path the alternative search settles on; its
    returned itinerary's actual times are always the real GTFS schedule (see
    _run_dijkstra's own docstring), so its displayed duration is honest, not
    inflated by 1.5x. Returns just [primary] when no genuinely different
    alternative exists (the penalized search finds the exact same trips
    again, or no path at all). Empty list if not even the primary connects.
    """
    origin_lat, origin_lon = origin
    destination_lat, destination_lon = destination
    departure_sec = departure.hour * 3600 + departure.minute * 60 + departure.second

    def _search() -> list[Itinerary]:
        conn = _get_connection()
        try:
            primary_edges = _run_dijkstra(
                conn, origin_lat, origin_lon, destination_lat, destination_lon, departure_sec, departure.date()
            )
            if primary_edges is None:
                return []

            edge_lists = [primary_edges]
            primary_route_ids = {edge.route_id for edge in primary_edges if edge.kind == "transit" and edge.route_id}
            if primary_route_ids and max_alternatives > 0:
                alternative_edges = _run_dijkstra(
                    conn,
                    origin_lat,
                    origin_lon,
                    destination_lat,
                    destination_lon,
                    departure_sec,
                    departure.date(),
                    penalized_route_ids=primary_route_ids,
                    penalty_multiplier=ALTERNATIVE_ROUTE_PENALTY_MULTIPLIER,
                )
                if alternative_edges is not None and _transit_route_signature(
                    alternative_edges
                ) != _transit_route_signature(primary_edges):
                    edge_lists.append(alternative_edges)

            return [
                _build_itinerary(
                    conn,
                    edges,
                    (origin_lon, origin_lat),
                    (destination_lon, destination_lat),
                    origin_name,
                    destination_name,
                )
                for edges in edge_lists
            ]
        finally:
            conn.close()

    itineraries = await asyncio.to_thread(_search)

    for itinerary in itineraries:
        (
            itinerary.delay_seconds,
            itinerary.streetcar_delay_seconds,
            itinerary.bus_delay_seconds,
        ) = await _augment_with_live_delays(itinerary)
        itinerary.arrival_sec = itinerary.legs[-1].arrival_sec if itinerary.legs else itinerary.arrival_sec

    # Fastest first by real total duration — the penalized search sometimes
    # still finds a "different but slower" alternative when nothing
    # competitive really exists, and a rider expects option order to track
    # actual speed, not which search found it.
    itineraries.sort(key=lambda itinerary: itinerary.arrival_sec - itinerary.departure_sec)
    return itineraries


async def find_itinerary(
    origin: Tuple[float, float],
    destination: Tuple[float, float],
    departure: datetime,
    origin_name: str = "Origin",
    destination_name: str = "Destination",
) -> Optional[Itinerary]:
    """origin/destination are (lat, lon). Returns None if no walk+transit
    path connects them within the search horizon (SEARCH_HORIZON_MINUTES)."""
    itineraries = await find_itineraries(origin, destination, departure, origin_name, destination_name)
    return itineraries[0] if itineraries else None
