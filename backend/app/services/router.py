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
import time
from dataclasses import dataclass, field
from functools import lru_cache
from datetime import date, datetime, timedelta
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
SEARCH_HORIZON_MINUTES = 120
# Was 8000 — barely below the network's own ~9400 stops, so a legitimate
# multi-transfer trip to an outer-boundary stop (e.g. downtown to McCowan Rd
# at Steeles Ave, Subway -> Bus -> Bus) could get cut off mid-search: Dijkstra
# settles nodes in strictly increasing arrival-time order, and the dense
# downtown core alone can account for thousands of stops reachable within the
# horizon, exhausting the old cap before the search ever reached the node
# that would have relaxed the destination's own walk edge — a real reachable
# path silently reported as "no route found". Comfortably above the total
# stop count so the horizon (above), not this, is what actually bounds a
# hopeless search.
MAX_SETTLED_STOPS = 20000
MAX_TRIP_FANOUT_STOPS = 120
# Bounds worst-case search breadth on a dense, hub-heavy network: a real TTC
# trip essentially never benefits from a 5th route change (the itineraries
# this router already favors — e.g. bus+subway+bus — top out at 2-3), so
# refusing to relax a transit edge past this many genuine transfers (the
# rider's first boarding doesn't count, only each subsequent route/trip
# change — see `relax`) prunes a large class of runaway zig-zag exploration
# for free, well before it'd ever compete with a sane answer anyway.
MAX_TRANSFER_COUNT = 4
# Universal floor on the boarding buffer for any transfer — i.e. any board
# attempt after the rider's very first one of the trip, whether it's a
# same-stop reboard or a walked connection to a nearby stop (see the
# boarding loop in _run_dijkstra: T_dep must be >= T_arrival, which already
# includes any walk time, + this floor). Models the realistic minimum
# readiness margin a transfer needs beyond raw travel time — finding the
# right platform/bay, doors, fare readers — that a same-stop transfer
# wouldn't otherwise get (0-second, arrival-instant boarding) and a walked
# transfer wouldn't otherwise get either (walk time alone isn't the same
# thing as "ready to board"). The rider's first boarding of the trip is
# exempt — waiting for a scheduled departure at the stop you're already
# standing at isn't a "transfer".
MIN_TRANSFER_BUFFER_SECONDS = 120.0
# Fixed in-station transfer time between sibling platforms at the same
# subway interchange complex (e.g. Line 1 <-> Line 2 at Bloor-Yonge, St
# George, or Spadina) — a short, real, indoor walk between platforms, not a
# haversine-distance walk estimate through the street grid like an ordinary
# nearby-stop transfer (see _sibling_platforms/WALK_GRID_FACTOR). The
# MIN_TRANSFER_BUFFER_SECONDS floor above still applies on top once the
# rider is at the sibling platform and boarding from there.
SAME_STATION_TRANSFER_SECONDS = 60.0
# Mode-pair-specific alight-and-reboard buffers for a transfer (see the
# boarding loop in _run_dijkstra) — more realistic than the flat
# MIN_TRANSFER_BUFFER_SECONDS floor alone for combinations with a genuinely
# longer real-world walk: crossing between subway platforms at a
# non-sibling interchange, or walking from a subway platform out to a
# connected bus bay. Values at or below the floor (any pair not listed
# here) simply fall back to MIN_TRANSFER_BUFFER_SECONDS. These feed the
# real earliest-catchable-trip floor (board_after), so unlike the
# search-only weights below, they *do* shift the reported scheduled/
# estimated times.
_TRANSFER_BUFFER_SECONDS_BY_MODE_PAIR: dict[tuple[str, str], float] = {
    ("subway", "subway"): 120.0,
    ("subway", "bus"): 180.0,
}

# Real-world walking distance inside a large multi-modal terminal —
# escalators, fare gates, indoor corridors between a bus bay and a subway
# platform — isn't well approximated by straight-line haversine distance
# the way an ordinary street-level nearby-stop transfer is (see
# _hub_terminal_platforms). A bus/streetcar/LRT bay within this radius of a
# subway platform is instead treated as sharing that platform's station
# complex (the runtime analogue of a GTFS transfers.txt transfer_type=2
# entry) and gets this fixed transfer time.
HUB_TERMINAL_RADIUS_METERS = 150.0
HUB_TERMINAL_TRANSFER_SECONDS = 180.0

# A bus/streetcar leg only ever gets a live GTFS-RT ETA lookup when its
# (delay-shifted-so-far) departure is within this many minutes of the real
# current wall-clock time — a query for a departure further out (either a
# later leg of a long trip, or a rider explicitly planning a future
# departure) keeps the static schedule instead, so a live reading many
# minutes stale by the time it'd actually matter can't silently warp a
# forecast further out than it's actually trustworthy for.
LIVE_ETA_HORIZON_MINUTES = 45

_ORIGIN_NODE = "__origin__"
_DESTINATION_NODE = "__destination__"

# GTFS route_type -> this app's leg mode (see routes.txt: this feed only uses
# 0=streetcar/tram, 1=subway/metro, 3=bus).
_ROUTE_TYPE_TO_MODE = {0: "streetcar", 1: "subway", 3: "bus"}
_SUBWAY_ROUTE_SHORT_NAMES = {"1", "2", "4"}

# A streetcar route (e.g. 506 Carlton, always numbered in TTC's 500-599
# streetcar block) sometimes runs a construction-detour trip on buses
# instead of streetcars — TTC's feed never gives that trip its own route_id
# or route_type (the "506" route stays route_type=0/tram for the whole
# route), only a distinct trip_headsign, e.g. "West - 506B Carlton
# Replacement Bus towards Spadina Station" vs. the ordinary "West - 506
# Carlton towards High Park". Detected/overridden per-trip in
# _build_itinerary (see _trip_headsign) so that specific leg renders with
# the bus mode/icon instead of a streetcar one it isn't actually running as.
_REPLACEMENT_BUS_HEADSIGN_PATTERN = re.compile(r"replacement bus|bus detour", re.IGNORECASE)
# Pulls the branch code (e.g. "506B") out of a matched headsign, for display
# in place of the route's bare "506" short name — falls back to leaving the
# short name as-is if a headsign matches _REPLACEMENT_BUS_HEADSIGN_PATTERN
# but doesn't happen to carry a lettered branch code.
_BRANCH_CODE_PATTERN = re.compile(r"\b(\d{3}[A-Z])\b")

# Synthetic Dijkstra path-cost penalty — search weight only, see _run_dijkstra's
# `relax` — charged whenever a transit edge is not a genuine continuation of
# the current ride (see CONTINUOUS_RIDE_COST_MULTIPLIER below): boarding a
# different route_id, or a different trip_id on the same route_id, than the
# one last ridden to reach its boarding stop. Applied purely on ride identity,
# never on physical transfer distance — a same-stop, 0-meter reboard onto a
# different vehicle costs exactly as much as a nearby-stop walk transfer.
# Discourages the search from settling on a 4- or 5-leg zig-zag, or getting
# off a bus early to catch a different one a few stops on, purely because its
# *unweighted* schedule total happens to look marginally faster than staying
# put. Never added to any edge's real depart_sec/arrive_sec, so it never
# leaks into a reported scheduled_time or estimated_time (same dist-vs-priority
# split already used for penalized_route_ids).
TRANSFER_INCONVENIENCE_PENALTY_SECONDS = 600.0

# Extra search-cost-only penalty stacked on top of
# TRANSFER_INCONVENIENCE_PENALTY_SECONDS (see `relax`) specifically for
# hopping off Line 1/2 heavy rail to board a *local* surface bus (route
# 1-199) — e.g. exiting at Cedarvale for the 63 Ossington instead of riding
# the subway on to a real transfer hub. A subway-to-subway, subway-to-
# express-bus, or subway-to-streetcar transfer is a legitimate interchange
# and only pays the base transfer penalty above; this only fires for the
# specific "gave up a rapid-transit trunk for a slow local bus" case.
SUBWAY_EXIT_TO_LOCAL_BUS_PENALTY_SECONDS = 480.0

# Discount stacked onto route_cost_multiplier (see `relax`) for an edge that
# is a genuine continuation of the current ride — same route_id *and* same
# trip_id as whatever got the rider to this edge's boarding stop. In this
# graph a single trip's ride is already usually modeled as one atomic edge
# (see _trip_fanout), so this mostly rewards the case where Dijkstra
# considers re-boarding the exact same vehicle after settling an intermediate
# stop some other way — staying put should never look worse than leaving and
# coming back.
CONTINUOUS_RIDE_COST_MULTIPLIER = 0.95

# Search-cost-only multiplier (see _run_dijkstra's `relax`) applied to every
# walking edge's weight — nudges Dijkstra toward riding transit a little
# further in exchange for a shorter final walk, rather than alighting as
# soon as it's physically reachable. Never applied to `dist` or an edge's
# real depart_sec/arrive_sec/distance_meters, so the walk time actually
# shown to the rider always stays the raw distance/WALK_SPEED_METERS_PER_MINUTE
# figure — this only shifts which path the search prefers.
WALK_EDGE_COST_MULTIPLIER = 1.3

# Extra flat search-cost penalty (see _run_dijkstra's `relax`) on a
# "stop -> destination" final-mile walk edge from any stop OTHER than the
# one with the genuinely shortest physical walk to the destination among
# all destination-adjacent stops (see `destination_walk`/
# closest_destination_stop_id) — so alighting a transit line one stop early
# to shave the walk, or vice versa, only wins the search when it's a real
# improvement: it must beat the closest-walk stop by more than this many
# seconds of *actual* elapsed time, not just a technicality.
# WALK_EDGE_COST_MULTIPLIER alone can't guarantee this — a small walk-time
# delta only earns a proportionally small weighted penalty from a pure
# multiplier, which lets a marginal, one-stop-early alighting win even with
# that multiplier already active.
MIN_WALK_TIME_SAVINGS_SECONDS = 180.0

# Search-cost-only multipliers (see _run_dijkstra's `relax`/`route_cost_multiplier`)
# that bias Dijkstra toward rapid-transit trunk routes and express bus
# corridors over an equivalent-or-faster-looking chain of local buses — e.g.
# preferring 129 + Line 2 + 929 over a 42-stop ride on the 11 Bayview. Only
# ever applied to the search-order `priority`, never to `dist` or an edge's
# real times.
#
# Line 1/2 are the city's actual rapid-transit spine (full-length,
# high-frequency, grade-separated) and get the strongest pull; Line 4
# (Sheppard, a short isolated stub) isn't part of that spine and is left at
# the neutral 1.0 default rather than folded in here — unlike
# _SUBWAY_ROUTE_SHORT_NAMES above, which covers all three for unrelated
# delay-modeling purposes and must stay as-is.
RAPID_TRANSIT_TRUNK_COST_MULTIPLIER = 0.80
_RAPID_TRANSIT_TRUNK_SHORT_NAMES = {"1", "2"}
# A local bus's frequent stop cycles and traffic exposure make it a genuinely
# less pleasant/reliable way to cover ground than a comparable express bus or
# subway leg, even when its raw scheduled time is competitive — nudge the
# search away from riding one further than it has to (e.g. staying on a local
# bus all the way downtown instead of transferring to a nearby subway
# terminal).
LOCAL_BUS_COST_MULTIPLIER = 1.12
_LOCAL_BUS_SHORT_NAME_MIN = 1
_LOCAL_BUS_SHORT_NAME_MAX = 199
EXPRESS_BUS_COST_MULTIPLIER = 0.95
_EXPRESS_BUS_SHORT_NAME_PATTERN = re.compile(r"^9\d{2}$")

# Flat per-intermediate-stop search-cost addition for a bus edge (search
# weight only, added to `cost` alongside TRANSFER_INCONVENIENCE_PENALTY_SECONDS
# before route_cost_multiplier is applied — see `relax`) — small on its own,
# but compounds over a long local run, so Dijkstra increasingly disfavors
# staying on a many-stop bus (e.g. the 42-stop 11 Bayview) once a
# shorter-hop path to a rapid-transit trunk is competitive (e.g. the
# 24-stop 129 to Kennedy/Line 2). Never applied to `dist` or an edge's real
# times.
BUS_STOP_INCONVENIENCE_SECONDS = 6.0


def _is_local_bus_short_name(short_name: Optional[str]) -> bool:
    """True for a plain local-bus route number (1-199) — excludes the
    900-series express corridors (handled separately, see
    EXPRESS_BUS_COST_MULTIPLIER) and non-numeric short names."""
    if not short_name or not short_name.isdigit():
        return False
    return _LOCAL_BUS_SHORT_NAME_MIN <= int(short_name) <= _LOCAL_BUS_SHORT_NAME_MAX

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
    # Read-performance tuning — safe on a read-only connection since none of
    # these affect on-disk durability: a larger page cache and memory-mapped
    # I/O cut down on repeated disk reads for the hot stop_times/shapes
    # tables across a single Dijkstra search's many small queries, and
    # routing temp b-trees/sorts through memory avoids a temp-file round
    # trip for the ORDER BY queries this module runs. synchronous/journal_mode
    # only actually govern write-durability trade-offs — harmless to set here
    # (this connection is query_only and never writes) but also with no real
    # upside, since there's no write path for them to speed up; included for
    # completeness/explicitness rather than because they do anything on their
    # own for this read-only workload.
    conn.execute("PRAGMA synchronous = OFF")
    conn.execute("PRAGMA journal_mode = OFF")
    conn.execute("PRAGMA cache_size = -64000")  # 64MB page cache
    conn.execute("PRAGMA temp_store = MEMORY")
    conn.execute("PRAGMA mmap_size = 300000000")  # ~286MB memory-mapped I/O
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
    # The original static-schedule times, set once at construction (see
    # _build_itinerary) and never mutated afterward — departure_sec/
    # arrival_sec above *are* mutated by _augment_with_live_delays as a
    # live/kinematic delay shifts them, so these are what a "was X, now Y"
    # strikethrough display (see item 3's UI spec) diffs against.
    scheduled_departure_sec: float = 0.0
    scheduled_arrival_sec: float = 0.0
    # Set by _augment_with_live_delays for a bus/streetcar leg departing
    # within LIVE_ETA_HORIZON_MINUTES of the real current time: True when a
    # genuine GTFS-RT TripUpdates reading was found and used (as opposed to
    # the static schedule, or a flat detour-penalty estimate).
    is_live: bool = False
    # Set instead of is_live when this leg's departure was soon enough to
    # look for one, but the live feed itself was stale/unreachable (a
    # system-wide "ghost bus" — see surface_realtime_service.is_feed_stale)
    # — the schedule is kept as the best available time, but flagged
    # distinctly from a route that simply has no live vehicle right now.
    tracking_unavailable: bool = False
    # This leg's own share of whatever delay ended up applied to it (live or
    # kinematic) — a subset of the itinerary-level delay_seconds/
    # streetcar_delay_seconds/bus_delay_seconds, broken out per leg so the
    # UI can render "5m late" against this specific leg. 0 for an on-time or
    # non-surface leg.
    delay_seconds: float = 0.0

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


def _hub_terminal_platforms(conn: sqlite3.Connection, stop_id: str) -> list[tuple[str, str, float, float]]:
    """(stop_id, name, lat, lon) for every stop of the *opposite* kind —
    subway platform vs. bus/streetcar/LRT bay — within
    HUB_TERMINAL_RADIUS_METERS of `stop_id`: the surface-to-subway
    counterpart to _sibling_platforms above, and symmetric (works from
    either side of the terminal). TTC's feed never sets parent_station on a
    surface stop (see _sibling_platforms's own docstring), so a bus bay at a
    major interchange terminal — e.g. Kennedy Station's bus platforms around
    the Line 2 platform — has no structural link to the subway platform
    it's physically co-located with, in either direction; without this,
    transferring between them falls through to the ordinary
    distance-estimated nearby-stop walk (_nearby_stops), which understates a
    large terminal's real indoor walk (escalators, fare gates, corridors)
    and is capped at MAX_TRANSFER_CANDIDATES, so a legitimate in-terminal
    transfer isn't guaranteed to even be considered."""
    row = conn.execute("SELECT lat, lon, parent_station FROM stops WHERE stop_id = ?", (stop_id,)).fetchone()
    if row is None:
        return []
    lat, lon, parent_station = row
    opposite_kind_filter = "parent_station IS NULL" if parent_station is not None else "parent_station IS NOT NULL"
    lat_min, lat_max, lon_min, lon_max = _bbox(lat, lon, HUB_TERMINAL_RADIUS_METERS)
    candidates = conn.execute(
        f"SELECT stop_id, name, lat, lon FROM stops WHERE {opposite_kind_filter} AND stop_id != ? "
        "AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
        (stop_id, lat_min, lat_max, lon_min, lon_max),
    ).fetchall()
    return [
        (s_id, name, s_lat, s_lon)
        for s_id, name, s_lat, s_lon in candidates
        if _haversine_m(lat, lon, s_lat, s_lon) <= HUB_TERMINAL_RADIUS_METERS
    ]


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


def _trip_headsign(conn: sqlite3.Connection, trip_id: str) -> Optional[str]:
    row = conn.execute("SELECT trip_headsign FROM trips WHERE trip_id = ?", (trip_id,)).fetchone()
    return row[0] if row and row[0] else None


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
    real, not inflated by the very penalty used to find it.

    The same dist-vs-priority split also carries several other always-on
    search biases, independent of `penalized_route_ids` (see `relax`):
    TRANSFER_INCONVENIENCE_PENALTY_SECONDS, charged against `priority` alone
    whenever a transit edge isn't a genuine continuation of the current ride
    — a different route_id, or even just a different trip_id on the same
    route_id, than what was last ridden — regardless of whether the transfer
    is a same-stop 0m reboard or a nearby-stop walk, so a 4-5 leg zig-zag (or
    hopping off a bus a few stops early to catch a different one) doesn't
    out-rank staying put purely on an unweighted schedule-time technicality;
    SUBWAY_EXIT_TO_LOCAL_BUS_PENALTY_SECONDS, stacked on top of that when the
    ride being abandoned was Line 1/2 heavy rail and the new one is a local
    surface bus specifically (a subway-to-subway/express-bus/streetcar
    transfer is still a legitimate interchange, only the "gave up the trunk
    for a slow local bus" case pays extra); BUS_STOP_INCONVENIENCE_SECONDS, a
    flat per-intermediate-stop add-on for a bus edge so a many-stop local run
    looks worse the longer it drags on; RAPID_TRANSIT_TRUNK_COST_MULTIPLIER/
    LOCAL_BUS_COST_MULTIPLIER/EXPRESS_BUS_COST_MULTIPLIER, which discount or
    inflate `priority` by mode/route so the search prefers a Line 1/2 +
    express-bus itinerary over an equivalent-looking long ride on a local
    bus; CONTINUOUS_RIDE_COST_MULTIPLIER, a small discount for an edge that
    *is* a genuine continuation, so staying aboard never looks worse than
    leaving and coming back; WALK_EDGE_COST_MULTIPLIER, which inflates the
    weight of every walking edge so the search leans toward riding transit a
    little further over walking a little further; and
    MIN_WALK_TIME_SAVINGS_SECONDS, an extra flat penalty on a final-mile
    "stop -> destination" walk edge from anywhere other than the single
    closest-walk stop to the destination (`closest_destination_stop_id`),
    so alighting one stop early (or late) only wins the search when it's a
    genuine `MIN_WALK_TIME_SAVINGS_SECONDS`-or-better real-time improvement,
    not a marginal technicality. None of these ever touch `dist` or an
    edge's real depart_sec/arrive_sec."""
    active_service_ids = _active_service_ids(conn, on_date)

    # Every stop's coordinates, prefetched once instead of the one-row-at-a-
    # time `SELECT lat, lon FROM stops WHERE stop_id = ?` the transfer-walk
    # step below used to run per settled node — ~9.4k rows is small enough
    # that one bulk fetch up front is far cheaper overall than paying a
    # round trip per node on a search that can settle thousands of them.
    stop_coordinates: dict[str, tuple[float, float]] = {
        stop_id: (lat, lon) for stop_id, lat, lon in conn.execute("SELECT stop_id, lat, lon FROM stops")
    }

    origin_stops = _nearby_stops(conn, origin_lat, origin_lon, MAX_INITIAL_WALK_METERS)[:MAX_NEARBY_STOP_CANDIDATES]
    destination_stops = _nearby_stops(conn, destination_lat, destination_lon, MAX_INITIAL_WALK_METERS)[
        :MAX_NEARBY_STOP_CANDIDATES
    ]
    destination_walk: dict[str, tuple[float, float]] = {
        stop_id: (_walk_minutes(distance) * 60, distance) for stop_id, _n, _la, _lo, distance in destination_stops
    }
    # _nearby_stops returns its results nearest-first, so this is simply the
    # single stop with the shortest physical walk to the destination among
    # every stop within range of it — the reference MIN_WALK_TIME_SAVINGS_SECONDS
    # below measures every other final-mile walk candidate against.
    closest_destination_stop_id: Optional[str] = destination_stops[0][0] if destination_stops else None

    dist: dict[str, float] = {_ORIGIN_NODE: departure_sec}
    priority: dict[str, float] = {_ORIGIN_NODE: departure_sec}
    prev: dict[str, _Edge] = {}
    arrived_via: dict[str, str] = {_ORIGIN_NODE: "origin"}
    # route_id (and trip_id) of the last transit edge ridden to reach each
    # node (None until a first boarding), plus its mode — used by `relax` to
    # tell a genuine ride continuation from a transfer (whether to a
    # different route or just a different trip on the same route), and by
    # the boarding loop below to size the alight-and-reboard buffer by mode
    # pair. Carried forward unchanged across a walk edge (walking doesn't
    # itself count as "leaving" the ride you were last on), overwritten on a
    # transit edge.
    last_route: dict[str, Optional[str]] = {_ORIGIN_NODE: None}
    last_trip: dict[str, Optional[str]] = {_ORIGIN_NODE: None}
    last_mode: dict[str, Optional[str]] = {_ORIGIN_NODE: None}
    # Genuine route/trip transfers used to reach each node so far (the first
    # boarding doesn't count — see MAX_TRANSFER_COUNT); `relax` refuses to
    # extend a path past the cap rather than let a many-transfer zig-zag
    # keep expanding.
    transfer_count: dict[str, int] = {_ORIGIN_NODE: 0}
    settled: set[str] = set()
    heap: list[tuple[float, str]] = [(departure_sec, _ORIGIN_NODE)]

    route_meta_cache: dict[str, Optional[tuple[str, str, int]]] = {}

    def route_meta(route_id: str) -> Optional[tuple[str, str, int]]:
        if route_id not in route_meta_cache:
            route_meta_cache[route_id] = _route_meta(conn, route_id)
        return route_meta_cache[route_id]

    def route_mode(route_id: str) -> str:
        meta = route_meta(route_id)
        route_type = meta[2] if meta else 3
        return _ROUTE_TYPE_TO_MODE.get(route_type, "bus")

    def route_short_name(route_id: str) -> Optional[str]:
        meta = route_meta(route_id)
        return meta[0] if meta else None

    def is_rapid_transit_trunk(route_id: str) -> bool:
        meta = route_meta(route_id)
        if not meta:
            return False
        short_name, _long_name, route_type = meta
        return route_type == 1 and short_name in _RAPID_TRANSIT_TRUNK_SHORT_NAMES

    def route_cost_multiplier(route_id: str) -> float:
        meta = route_meta(route_id)
        if not meta:
            return 1.0
        short_name, _long_name, route_type = meta
        if route_type == 1 and short_name in _RAPID_TRANSIT_TRUNK_SHORT_NAMES:
            return RAPID_TRANSIT_TRUNK_COST_MULTIPLIER
        if route_type == 3 and short_name and _EXPRESS_BUS_SHORT_NAME_PATTERN.match(short_name):
            return EXPRESS_BUS_COST_MULTIPLIER
        if route_type == 3 and _is_local_bus_short_name(short_name):
            return LOCAL_BUS_COST_MULTIPLIER
        return 1.0

    def relax(from_node: str, to_node: str, real_arrival: float, edge: _Edge, via: str) -> None:
        cost = real_arrival - dist[from_node]
        is_transfer = False
        if edge.kind == "walk":
            cost *= WALK_EDGE_COST_MULTIPLIER
            if (
                to_node == _DESTINATION_NODE
                and from_node != _ORIGIN_NODE
                and closest_destination_stop_id is not None
                and from_node != closest_destination_stop_id
            ):
                cost += MIN_WALK_TIME_SAVINGS_SECONDS
        if edge.kind == "transit" and edge.route_id:
            prior_route = last_route.get(from_node)
            continuing_ride = (
                prior_route is not None
                and prior_route == edge.route_id
                and last_trip.get(from_node) == edge.trip_id
            )
            is_transfer = prior_route is not None and not continuing_ride
            if is_transfer and transfer_count.get(from_node, 0) + 1 > MAX_TRANSFER_COUNT:
                return
            if is_transfer:
                cost += TRANSFER_INCONVENIENCE_PENALTY_SECONDS
                if (
                    is_rapid_transit_trunk(prior_route)
                    and route_mode(edge.route_id) == "bus"
                    and _is_local_bus_short_name(route_short_name(edge.route_id))
                ):
                    cost += SUBWAY_EXIT_TO_LOCAL_BUS_PENALTY_SECONDS
            if (
                route_mode(edge.route_id) == "bus"
                and edge.from_stop_sequence is not None
                and edge.to_stop_sequence is not None
            ):
                intermediate_stops = max(0, (edge.to_stop_sequence - edge.from_stop_sequence) - 1)
                cost += intermediate_stops * BUS_STOP_INCONVENIENCE_SECONDS
            cost *= route_cost_multiplier(edge.route_id)
            if continuing_ride:
                cost *= CONTINUOUS_RIDE_COST_MULTIPLIER
        if penalized_route_ids and edge.route_id in penalized_route_ids:
            cost *= penalty_multiplier
        candidate_priority = priority[from_node] + cost
        if candidate_priority < priority.get(to_node, math.inf):
            dist[to_node] = real_arrival
            priority[to_node] = candidate_priority
            arrived_via[to_node] = via
            prev[to_node] = edge
            if edge.kind == "transit" and edge.route_id:
                last_route[to_node] = edge.route_id
                last_trip[to_node] = edge.trip_id
                last_mode[to_node] = route_mode(edge.route_id)
                transfer_count[to_node] = transfer_count.get(from_node, 0) + 1 if is_transfer else transfer_count.get(from_node, 0)
            else:
                last_route[to_node] = last_route.get(from_node)
                last_trip[to_node] = last_trip.get(from_node)
                last_mode[to_node] = last_mode.get(from_node)
                transfer_count[to_node] = transfer_count.get(from_node, 0)
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
        # A transfer's boarding buffer applies to any board attempt beyond
        # the rider's very first one of the trip — a same-stop reboard and a
        # walked-to connection alike, since a walk's own duration is *travel
        # time*, not the readiness margin (finding the platform/bay, doors)
        # a genuine transfer also needs on top (see MIN_TRANSFER_BUFFER_SECONDS).
        # `last_mode` is None only when no transit has been ridden yet
        # (still departing from/near the origin), so it doubles as "is this
        # actually a transfer" here. Sized per mode pair beyond the floor
        # (see _TRANSFER_BUFFER_SECONDS_BY_MODE_PAIR) since e.g. crossing out
        # to a connected bus bay genuinely takes longer than reboarding at
        # the same bus stop.
        prior_mode = last_mode.get(node)
        boardings: dict[str, tuple[str, int, int]] = {}
        if route_ids:
            buffer_groups: dict[float, list[str]] = {}
            for route_id in route_ids:
                buffer_seconds = (
                    max(
                        MIN_TRANSFER_BUFFER_SECONDS,
                        _TRANSFER_BUFFER_SECONDS_BY_MODE_PAIR.get((prior_mode, route_mode(route_id)), MIN_TRANSFER_BUFFER_SECONDS),
                    )
                    if prior_mode is not None
                    else 0.0
                )
                buffer_groups.setdefault(buffer_seconds, []).append(route_id)
            for buffer_seconds, grouped_route_ids in buffer_groups.items():
                board_after = arrival_sec + buffer_seconds
                boardings.update(
                    _earliest_trips_per_route(conn, node, board_after, grouped_route_ids, active_service_ids)
                )
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

            # Same idea, the other direction: a bus/streetcar/LRT bay at a
            # major interchange terminal (e.g. Kennedy Station's bus
            # platforms around the Line 2 platform) gets a fixed in-terminal
            # transfer to the subway platform it's physically co-located
            # with, instead of relying on the ordinary distance-estimated
            # nearby-stop walk below to both reach far enough and rank
            # highly enough among MAX_TRANSFER_CANDIDATES to be considered.
            for to_stop_id, _n, _la, _lo in _hub_terminal_platforms(conn, node):
                arrive = arrival_sec + HUB_TERMINAL_TRANSFER_SECONDS
                edge = _Edge("walk", node, to_stop_id, arrival_sec, arrive, distance_meters=0.0)
                relax(node, to_stop_id, arrive, edge, "walk")

            node_coordinates = stop_coordinates.get(node)
            if node_coordinates:
                node_lat, node_lon = node_coordinates
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
                    scheduled_departure_sec=edge.depart_sec,
                    scheduled_arrival_sec=edge.arrive_sec,
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

        if mode == "streetcar":
            headsign = _trip_headsign(conn, edge.trip_id)
            if headsign and _REPLACEMENT_BUS_HEADSIGN_PATTERN.search(headsign):
                mode = "bus"
                branch_match = _BRANCH_CODE_PATTERN.search(headsign)
                if branch_match:
                    short_name = branch_match.group(1)

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
                scheduled_departure_sec=edge.depart_sec,
                scheduled_arrival_sec=edge.arrive_sec,
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


async def _augment_with_live_delays(itinerary: Itinerary, on_date: date) -> Tuple[float, float, float]:
    """Mutates `itinerary`'s legs in place: adds subway kinematic/live delay
    and surface (streetcar/bus) live/detour delay onto whichever legs they
    apply to, shifting every later leg's times by the same cumulative
    amount — the same modeling traffic_service.py applies to a subway-only
    trip, reused here per-leg for a general multi-modal itinerary. Returns
    (total delay seconds added, worst single streetcar-leg delay, worst
    single bus-leg delay) — the latter two are a subset of the total, kept
    separate so callers can label a surface delay distinctly ("Streetcar
    Delay"/"Traffic Delay") instead of folding it into the subway-oriented
    "Track Slowdown" badge. `on_date` (the itinerary's own date — legs only
    carry seconds-of-day) lets a bus/streetcar leg's departure_sec be
    compared against the real current time, for LIVE_ETA_HORIZON_MINUTES
    clamping (see the surface branch below)."""
    if not itinerary.legs:
        return 0.0, 0.0, 0.0

    midnight = datetime(on_date.year, on_date.month, on_date.day)
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
            live_departure = None
            if leg.from_stop_id:
                minutes_until_departure = (midnight + timedelta(seconds=leg.departure_sec) - datetime.now()).total_seconds() / 60.0
                # Only within the live-ETA horizon (a later leg of a long
                # trip, or a rider-planned future departure, keeps the
                # static schedule instead — see LIVE_ETA_HORIZON_MINUTES).
                if 0 <= minutes_until_departure <= LIVE_ETA_HORIZON_MINUTES:
                    scheduled_epoch = (midnight + timedelta(seconds=leg.departure_sec)).timestamp()
                    live_departure = await surface_realtime_service.get_live_departure(
                        leg.route_short_name, leg.from_stop_id, scheduled_epoch
                    )
                    if live_departure is None and surface_realtime_service.is_feed_stale():
                        # The feed itself has gone stale/unreachable (not
                        # just "no vehicle tracked at this stop right now")
                        # — the system-wide "ghost bus" case: keep the
                        # schedule, but flag it distinctly from a plain
                        # "Scheduled" leg (see ItineraryLeg.tracking_unavailable).
                        leg.tracking_unavailable = True

            if live_departure is not None:
                leg.is_live = True
                added_seconds = max(0.0, float(live_departure.delay_seconds))
                # A live reading is anchored to this vehicle's own predicted
                # arrival at the boarding stop — unlike the slow-zone
                # (subway) and detour-penalty (below) estimates, which model
                # extra time *during* the ride, the vehicle itself is
                # running late, so the rider's actual boarding time shifts
                # too, not just when they'd get off.
                leg.departure_sec += added_seconds
            else:
                # Live TripUpdates (real vehicles genuinely running behind,
                # e.g. traffic) takes priority over the detour feed's flat
                # estimate, same "live observed beats modeled" precedent as
                # subway above — only falls back to the detour penalty when
                # this leg's route has no usable live reading right now.
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

        leg.delay_seconds = added_seconds
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


# In-memory cache of _run_dijkstra's raw edge-list output, keyed on
# everything that actually affects the *pathfinding* (see
# _itinerary_search_cache_key) — origin_name/destination_name are
# deliberately excluded since they only affect display labels in
# _build_itinerary, never which edges get searched. Only the comparatively
# expensive, purely-schedule-based graph search is ever cached; live-delay
# data is never stored here and is always fetched fresh in find_itineraries
# below regardless of a cache hit, so a cached result can never serve stale
# delay/detour info. A short TTL bounds how long a cached "no route found"
# for a since-fixed query, or a stale schedule window, can linger; the size
# cap is a simple reset-on-overflow rather than real LRU eviction, which is
# plenty for this module's actual traffic pattern (a modest, bursty set of
# popular origin/destination pairs, not a long tail worth a proper LRU).
_ITINERARY_SEARCH_CACHE: dict[tuple, tuple[float, list[list[_Edge]]]] = {}
ITINERARY_SEARCH_CACHE_TTL_SECONDS = 30.0
_ITINERARY_SEARCH_CACHE_MAX_ENTRIES = 512


def _itinerary_search_cache_key(
    origin_lat: float,
    origin_lon: float,
    destination_lat: float,
    destination_lon: float,
    departure: datetime,
    max_alternatives: int,
) -> tuple:
    # Coordinates rounded to ~11m and departure rounded to the minute — the
    # underlying GTFS timetable a Dijkstra search depends on doesn't
    # meaningfully change at finer granularity than that, so two requests a
    # few seconds (or a few meters, e.g. a slightly-jittered map pin) apart
    # for the same trip share one cached search instead of each paying for
    # the full graph search.
    return (
        round(origin_lat, 4),
        round(origin_lon, 4),
        round(destination_lat, 4),
        round(destination_lon, 4),
        departure.date().isoformat(),
        departure.hour * 60 + departure.minute,
        max_alternatives,
    )


def _run_itinerary_search(
    origin_lat: float,
    origin_lon: float,
    destination_lat: float,
    destination_lon: float,
    departure_sec: float,
    on_date: date,
    max_alternatives: int,
) -> list[list[_Edge]]:
    """The actual (expensive) Dijkstra work behind find_itineraries, with
    _build_itinerary's display-formatting split out so its result — pure
    `_Edge` lists, nothing live-delay- or display-label-dependent — is safe
    to cache verbatim (see _ITINERARY_SEARCH_CACHE)."""
    conn = _get_connection()
    try:
        primary_edges = _run_dijkstra(conn, origin_lat, origin_lon, destination_lat, destination_lon, departure_sec, on_date)
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
                on_date,
                penalized_route_ids=primary_route_ids,
                penalty_multiplier=ALTERNATIVE_ROUTE_PENALTY_MULTIPLIER,
            )
            if alternative_edges is not None and _transit_route_signature(alternative_edges) != _transit_route_signature(
                primary_edges
            ):
                edge_lists.append(alternative_edges)
        return edge_lists
    finally:
        conn.close()


def _build_itineraries_from_edge_lists(
    edge_lists: list[list[_Edge]],
    origin_coords: Tuple[float, float],
    destination_coords: Tuple[float, float],
    origin_name: str,
    destination_name: str,
) -> list[Itinerary]:
    conn = _get_connection()
    try:
        return [
            _build_itinerary(conn, edges, origin_coords, destination_coords, origin_name, destination_name)
            for edges in edge_lists
        ]
    finally:
        conn.close()


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

    cache_key = _itinerary_search_cache_key(
        origin_lat, origin_lon, destination_lat, destination_lon, departure, max_alternatives
    )
    now = time.monotonic()
    cached = _ITINERARY_SEARCH_CACHE.get(cache_key)
    if cached is not None and now - cached[0] > ITINERARY_SEARCH_CACHE_TTL_SECONDS:
        del _ITINERARY_SEARCH_CACHE[cache_key]
        cached = None

    if cached is not None:
        edge_lists = cached[1]
    else:
        edge_lists = await asyncio.to_thread(
            _run_itinerary_search,
            origin_lat,
            origin_lon,
            destination_lat,
            destination_lon,
            departure_sec,
            departure.date(),
            max_alternatives,
        )
        if len(_ITINERARY_SEARCH_CACHE) >= _ITINERARY_SEARCH_CACHE_MAX_ENTRIES:
            _ITINERARY_SEARCH_CACHE.clear()
        _ITINERARY_SEARCH_CACHE[cache_key] = (now, edge_lists)

    itineraries = await asyncio.to_thread(
        _build_itineraries_from_edge_lists,
        edge_lists,
        (origin_lon, origin_lat),
        (destination_lon, destination_lat),
        origin_name,
        destination_name,
    )

    for itinerary in itineraries:
        (
            itinerary.delay_seconds,
            itinerary.streetcar_delay_seconds,
            itinerary.bus_delay_seconds,
        ) = await _augment_with_live_delays(itinerary, departure.date())
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


def _stop_ids_for_station_on_route(conn: sqlite3.Connection, route_id: str, station_id: str) -> list[str]:
    """Every GTFS stop_id on `route_id` that maps to our `station_id` (see
    gtfs_service.get_station_id_for_stop) — typically two: the
    northbound/southbound (or up/down) platform stop_ids TTC's static feed
    ships as separate stops sharing no parent_station of their own."""
    all_stop_ids = [row[0] for row in conn.execute("SELECT DISTINCT stop_id FROM stop_routes WHERE route_id = ?", (route_id,))]
    return [stop_id for stop_id in all_stop_ids if gtfs_service.get_station_id_for_stop(stop_id) == station_id]


# Safe to cache verbatim (exact-args, no TTL needed): this is a pure
# function of the static GTFS schedule baked into gtfs_routing.db at build
# time — no live delay/detour data ever factors in — so its result for a
# given (line, stations, departure_sec, date) tuple can only actually change
# when that file itself is rebuilt, i.e. never during a running process.
@lru_cache(maxsize=4096)
def get_subway_scheduled_duration_seconds(
    line: int, origin_station_id: str, destination_station_id: str, departure_sec: float, on_date: date
) -> Optional[float]:
    """Real GTFS-scheduled travel time (seconds) between two subway stations
    on `line`, read off the earliest actually-scheduled trip catchable at
    `departure_sec` — replaces traffic_service.py's old flat "hops *
    MINUTES_PER_STATION_HOP" estimate, which assumed every inter-station hop
    takes the same time. It doesn't: on Line 1 alone, real hop times range
    from ~1.1 minutes (Osgoode -> St Andrew, downtown core) to ~4.2 minutes
    (Cedarvale -> St Clair West), so a flat per-hop average systematically
    over/under-estimates any specific trip depending on which stretch of the
    line it actually covers (verified against the static feed: Line 1's own
    real average is ~2.0 min/hop against the old flat 1.5, Line 4's ~2.1 —
    only Line 2 happens to sit close to 1.5).

    Reuses the same "earliest trip per route, then fan out along its stop
    sequence" building blocks find_itineraries' Dijkstra is built from,
    just scoped to one already-known route/line instead of searching a
    whole graph. Returns None if no matching trip is found in either
    direction (e.g. outside service hours) — callers should fall back to
    the flat estimate rather than fail outright."""
    conn = _get_connection()
    try:
        route_id_row = conn.execute("SELECT route_id FROM routes WHERE short_name = ?", (str(line),)).fetchone()
        if route_id_row is None:
            return None
        route_id = route_id_row[0]

        active_service_ids = _active_service_ids(conn, on_date)
        origin_stop_ids = _stop_ids_for_station_on_route(conn, route_id, origin_station_id)
        if not origin_stop_ids:
            return None

        best_duration: Optional[float] = None
        best_departure: Optional[float] = None
        for origin_stop_id in origin_stop_ids:
            boardings = _earliest_trips_per_route(conn, origin_stop_id, departure_sec, [route_id], active_service_ids)
            boarding = boardings.get(route_id)
            if boarding is None:
                continue
            trip_id, trip_departure_sec, from_sequence = boarding
            for stop_id, arrival_sec, _seq in _trip_fanout(conn, trip_id, from_sequence):
                if gtfs_service.get_station_id_for_stop(stop_id) != destination_station_id:
                    continue
                # Two platform stop_ids can each independently catch an
                # earlier-departing trip (e.g. a same-direction express-vs-
                # local quirk isn't a real thing on this feed, but a trip
                # starting mid-line could still board sooner on one platform
                # than the other) — keep whichever trip actually departs
                # soonest, matching the "earliest trip per route" semantics
                # find_itineraries' own Dijkstra relies on.
                if best_departure is None or trip_departure_sec < best_departure:
                    best_departure = trip_departure_sec
                    best_duration = float(arrival_sec - trip_departure_sec)
                break

        return best_duration
    finally:
        conn.close()
