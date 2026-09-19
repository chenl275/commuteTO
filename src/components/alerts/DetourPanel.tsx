"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getDetours } from "@/lib/traffic";
import type { DetourSummary } from "@/types/traffic";

// Matches detour_service.py's own GTFS-RT alerts cache TTL — polling faster
// would just refetch the exact same cached backend response.
const REFRESH_INTERVAL_MS = 2 * 60 * 1000;

const EFFECT_LABELS: Record<DetourSummary["effect"], string> = {
  DETOUR: "Detour",
  MODIFIED_SERVICE: "Modified Service",
  NO_SERVICE: "No Service",
};

const EFFECT_BADGE_STYLES: Record<DetourSummary["effect"], string> = {
  DETOUR: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  MODIFIED_SERVICE: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300",
  NO_SERVICE: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

// Higher wins when picking one effect to color a grouped route card's own
// badge — a route with both a NO_SERVICE alert and a MODIFIED_SERVICE one
// reads first and foremost as "no service" (see groupByRoute).
const EFFECT_SEVERITY: Record<DetourSummary["effect"], number> = {
  NO_SERVICE: 3,
  DETOUR: 2,
  MODIFIED_SERVICE: 1,
};

// The route-number pill's own background — bolder/more alarming than the
// per-bullet EFFECT_BADGE_STYLES so a route with an active NO_SERVICE or
// DETOUR reads at a glance without opening every bullet underneath it.
const ROUTE_BADGE_STYLES: Record<DetourSummary["effect"], string> = {
  NO_SERVICE: "bg-red-600",
  DETOUR: "bg-amber-600",
  MODIFIED_SERVICE: "bg-neutral-800 dark:bg-white/20",
};

type Category = "all" | "subway" | "streetcar" | "bus";

const CATEGORY_TABS: Array<{ key: Category; label: string }> = [
  { key: "all", label: "All" },
  { key: "subway", label: "Subway" },
  { key: "streetcar", label: "Streetcar" },
  { key: "bus", label: "Bus" },
];

/** TTC's own route-numbering convention (see backend/scripts/ingest_surface_gtfs.py's
 * identical STREETCAR_ROUTE_SHORT_NAMES/DAY_BUS_RANGE/NIGHT_BUS_RANGE split):
 * subway lines are 1/2/4, streetcars are the 500-series, and every other
 * route number (7-199 regular buses, 300-series night buses, or anything
 * else the live feed names) is a bus. */
function routeCategory(routeShortName: string | null): Exclude<Category, "all"> {
  const numeric = Number(routeShortName);
  if (routeShortName !== null && !Number.isNaN(numeric)) {
    if (numeric === 1 || numeric === 2 || numeric === 4) return "subway";
    if (numeric >= 500 && numeric <= 599) return "streetcar";
  }
  return "bus";
}

interface RouteGroup {
  routeShortName: string;
  category: Exclude<Category, "all">;
  alerts: DetourSummary[];
  worstEffect: DetourSummary["effect"];
  stopCount: number;
}

/** Multiple live GTFS-RT alerts can independently target the same route
 * (e.g. route 16 having both an "Easier Access" construction reroute and a
 * separate storm-drain-repair reroute) — this collapses them into one card
 * per route, each alert becoming its own bullet, rather than rendering
 * disjoint duplicate cards for the same route badge. */
function groupByRoute(detours: DetourSummary[]): RouteGroup[] {
  const groups = new Map<string, RouteGroup>();
  for (const detour of detours) {
    const key = detour.routeShortName ?? "?";
    let group = groups.get(key);
    if (!group) {
      group = { routeShortName: key, category: routeCategory(detour.routeShortName), alerts: [], worstEffect: detour.effect, stopCount: 0 };
      groups.set(key, group);
    }
    group.alerts.push(detour);
    if (EFFECT_SEVERITY[detour.effect] > EFFECT_SEVERITY[group.worstEffect]) {
      group.worstEffect = detour.effect;
    }
  }
  for (const group of groups.values()) {
    group.stopCount = new Set(group.alerts.flatMap((alert) => alert.affectedStopIds)).size;
  }
  return [...groups.values()];
}

/** Numeric route numbers first in ascending order (7, 13, 29, ...), any
 * non-numeric short name after, alphabetically — reads as "organized by
 * route badge" rather than arrival order off the live feed. */
function sortByRoute(groups: RouteGroup[]): RouteGroup[] {
  return [...groups].sort((a, b) => {
    const routeA = Number(a.routeShortName);
    const routeB = Number(b.routeShortName);
    const aIsNumeric = !Number.isNaN(routeA);
    const bIsNumeric = !Number.isNaN(routeB);
    if (aIsNumeric && bIsNumeric) return routeA - routeB;
    if (aIsNumeric !== bIsNumeric) return aIsNumeric ? -1 : 1;
    return a.routeShortName.localeCompare(b.routeShortName);
  });
}

/** The full, untruncated alert text — `summary` is a short badge-sized cut
 * (see detour_service.py's _summarize) that can genuinely omit real content
 * (a second sentence, the specific stops not served, ...), not just the
 * tail end of the first one. */
function fullDetourText(detour: DetourSummary): string {
  return `${detour.header} ${detour.description}`.replace(/\s+/g, " ").trim();
}

function AlertBullet({ detour }: { detour: DetourSummary }) {
  const [expanded, setExpanded] = useState(false);
  const full = fullDetourText(detour);
  // A real ellipsis only ever appears here when _summarize had to cut the
  // text short (see its own docstring) — a clean first-sentence summary
  // never gets one, even when the full text still has more after it, so
  // this alone isn't quite enough; also offer "Read more" whenever the full
  // text is genuinely longer than what's already shown.
  const isTruncated = full.length > detour.summary.length + 1;

  return (
    <li className="marker:text-neutral-400 dark:marker:text-white/30">
      <span
        className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${EFFECT_BADGE_STYLES[detour.effect]}`}
      >
        {EFFECT_LABELS[detour.effect]}
      </span>
      <p className="mt-0.5 break-words text-xs leading-snug text-neutral-700 dark:text-white/80">
        {expanded ? full : detour.summary}
      </p>
      {isTruncated && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-0.5 text-[11px] font-semibold text-red-600 hover:underline dark:text-red-300"
        >
          {expanded ? "Read less" : "Read more"}
        </button>
      )}
    </li>
  );
}

/** Compact header badge + expandable, tab-filtered, per-route-grouped list
 * of active subway/streetcar/bus detours — purely informational (route
 * badge, effect, affected-stop count, one bullet per active disruption). */
export default function DetourPanel() {
  const [detours, setDetours] = useState<DetourSummary[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<Category>("all");
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    function load() {
      getDetours()
        .then((data) => {
          if (!cancelled) setDetours(data.detours);
        })
        .catch(() => {
          // A failed fetch just leaves the last-known list (or empty on the
          // very first load) — this panel is a nice-to-have, not critical path.
        });
    }

    load();
    const interval = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Grouping + sorting is cheap (at most a few dozen live alerts) but still
  // no reason to redo it on every render that doesn't change the inputs —
  // and, since this state is entirely local to this component, switching
  // tabs never touches TTCMap or any other sibling (it isn't wired to
  // DetourMapContext), so it can't trigger a MapLibre re-render either.
  const allGroups = useMemo(() => sortByRoute(groupByRoute(detours)), [detours]);
  const visibleGroups = useMemo(
    () => (activeTab === "all" ? allGroups : allGroups.filter((group) => group.category === activeTab)),
    [allGroups, activeTab]
  );
  const hasDetours = allGroups.length > 0;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-haspopup="true"
        className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
          hasDetours
            ? "border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-400/30 dark:bg-red-500/15 dark:text-red-300 dark:hover:bg-red-500/25"
            : "border-neutral-200 bg-neutral-50 text-neutral-500 hover:bg-neutral-100 dark:border-white/10 dark:bg-white/5 dark:text-white/50 dark:hover:bg-white/10"
        }`}
      >
        <span aria-hidden="true">⚠️</span>
        Live Detours ({allGroups.length})
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full z-50 mt-2 flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-xl dark:border-white/10 dark:bg-neutral-900">
          <div className="p-3 pb-0">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-white/50">
              Active Detours &amp; Disruptions
            </p>
            <div className="flex gap-1 rounded-full bg-neutral-100 p-1 dark:bg-white/5">
              {CATEGORY_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  aria-pressed={activeTab === tab.key}
                  className={`flex-1 rounded-full px-2 py-1 text-[11px] font-semibold transition-colors ${
                    activeTab === tab.key
                      ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white"
                      : "text-neutral-500 hover:text-neutral-700 dark:text-white/50 dark:hover:text-white/80"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-y-auto p-3">
            {visibleGroups.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {visibleGroups.map((group) => (
                  <li
                    key={group.routeShortName}
                    className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 dark:border-white/10 dark:bg-white/5"
                  >
                    <div className="mb-1.5 flex items-center gap-2">
                      <span
                        className={`flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-bold text-white ${ROUTE_BADGE_STYLES[group.worstEffect]}`}
                      >
                        {group.routeShortName}
                      </span>
                      {group.alerts.length > 1 && (
                        <span className="text-[11px] text-neutral-500 dark:text-white/50">
                          {group.alerts.length} active alerts
                        </span>
                      )}
                      {group.stopCount > 0 && (
                        <span className="ml-auto shrink-0 text-[11px] text-neutral-500 dark:text-white/50">
                          {group.stopCount} stop{group.stopCount === 1 ? "" : "s"}
                        </span>
                      )}
                    </div>
                    <ul className="flex list-disc flex-col gap-2 pl-4">
                      {group.alerts.map((alert) => (
                        <AlertBullet key={alert.id} detour={alert} />
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-neutral-500 dark:text-white/50">
                {hasDetours ? "No active detours in this category." : "No active bus/streetcar detours right now."}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
