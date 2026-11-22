import { fetchTimetable, type SchedulePattern } from "./scraper.js";
import { parseWindow } from "./config.js";
import type { DirectionConfig, Itinerary, LineStopOrder, RouteConfig, StepResult, TimetablePage } from "./types.js";

/**
 * Earliest-arrival graph search over the configured stops/lines.
 *
 * Model: nodes are named stops; edges are either
 *   - a line ride from one named stop to another named stop on the same
 *     line (duration = scraped minute-offset, using the next feasible
 *     departure after the stop is "ready"), or
 *   - an explicit walkTransfers entry between two *different* stops.
 *
 * Transfer penalty: a walkTransfers entry with from === to is treated as a
 * flat "turn penalty" applied whenever re-boarding *any* line after having
 * just arrived via a line at that stop (e.g. 2 minutes to change platforms).
 * It does NOT apply to the
 * very first boarding (fresh walk-in from origin) nor after an explicit
 * two-stop walk transfer (already a deliberate walk, not a same-spot
 * scramble). This is a simplification — documented in AGENTS.md.
 *
 * Because travel-time offsets are static (not per-trip), taking the next
 * feasible departure on a line is always at least as good as any later one,
 * so each relaxation only needs the *next* departure per line — this keeps
 * the search a straightforward Dijkstra despite being time-dependent.
 */

interface LineEdgeSource {
  line: string;
  direction: string;
  boardUrl: string;
}

function buildLineIndex(config: RouteConfig): Map<string, LineEdgeSource[]> {
  const index = new Map<string, LineEdgeSource[]>();
  for (const line of config.lines) {
    for (const [stop, boardUrl] of Object.entries(line.stops)) {
      const list = index.get(stop) ?? [];
      list.push({ line: line.line, direction: line.direction, boardUrl });
      index.set(stop, list);
    }
  }
  return index;
}

function buildWalkIndex(config: RouteConfig): Map<string, { to: string; minutes: number }[]> {
  const index = new Map<string, { to: string; minutes: number }[]>();
  for (const wt of config.walkTransfers) {
    if (wt.from === wt.to) continue; // self-loops are turn penalties, not edges
    const add = (from: string, to: string) => {
      const list = index.get(from) ?? [];
      list.push({ to, minutes: wt.minutes });
      index.set(from, list);
    };
    add(wt.from, wt.to);
    if (wt.bidirectional) add(wt.to, wt.from);
  }
  return index;
}

function buildTurnPenalty(config: RouteConfig): Map<string, number> {
  const index = new Map<string, number>();
  for (const wt of config.walkTransfers) {
    if (wt.from === wt.to) index.set(wt.from, wt.minutes);
  }
  return index;
}

export type FetchTimetableFn = (url: string, pattern: SchedulePattern, timezone: string) => Promise<TimetablePage>;

/** Each `line.stops[stop]` URL fetched at most once per run, shared across all Dijkstra passes. */
function makeTimetableMemo(pattern: SchedulePattern, timezone: string, fetchTimetableImpl: FetchTimetableFn) {
  const cache = new Map<string, Promise<TimetablePage>>();
  return (url: string): Promise<TimetablePage> => {
    let p = cache.get(url);
    if (!p) {
      p = fetchTimetableImpl(url, pattern, timezone);
      cache.set(url, p);
    }
    return p;
  };
}

type GetTimetable = ReturnType<typeof makeTimetableMemo>;

const ORIGIN = Symbol("origin");

async function dijkstra(
  config: RouteConfig,
  direction: DirectionConfig,
  leaveOrigin: number,
  originConns: { stop: string; walkMinutes: number }[],
  lineIndex: Map<string, LineEdgeSource[]>,
  walkIndex: Map<string, { to: string; minutes: number }[]>,
  turnPenalty: Map<string, number>,
  getTimetable: GetTimetable,
): Promise<Itinerary | null> {
  const bestArrival = new Map<string, number>();
  const viaLine = new Map<string, boolean>();
  const predStop = new Map<string, string | typeof ORIGIN>();
  const predStep = new Map<string, StepResult>();
  const visited = new Set<string>();

  for (const conn of originConns) {
    const t = leaveOrigin + conn.walkMinutes * 60;
    if (!bestArrival.has(conn.stop) || t < bestArrival.get(conn.stop)!) {
      bestArrival.set(conn.stop, t);
      viaLine.set(conn.stop, false);
      predStop.set(conn.stop, ORIGIN);
      predStep.set(conn.stop, {
        kind: "walk",
        minutes: conn.walkMinutes,
        fromEpoch: leaveOrigin,
        toEpoch: t,
        fromStop: direction.origin.name,
        toStop: conn.stop,
        label: `${direction.origin.name} -> ${conn.stop}`,
      });
    }
  }

  for (;;) {
    let current: string | null = null;
    let currentTime = Infinity;
    for (const [stop, t] of bestArrival) {
      if (!visited.has(stop) && t < currentTime) {
        current = stop;
        currentTime = t;
      }
    }
    if (current === null) break;
    visited.add(current);

    const readyTime = currentTime + (viaLine.get(current) ? (turnPenalty.get(current) ?? 0) * 60 : 0);

    for (const edge of lineIndex.get(current) ?? []) {
      const tt = await getTimetable(edge.boardUrl);
      const nextDep = tt.departures.find((d) => d >= readyTime);
      if (nextDep === undefined) continue;
      for (const [otherStop, offsetMin] of tt.stopOffsets) {
        if (otherStop === current || !config.stops.includes(otherStop)) continue;
        const rawArrival = nextDep + offsetMin * 60;
        if (!bestArrival.has(otherStop) || rawArrival < bestArrival.get(otherStop)!) {
          bestArrival.set(otherStop, rawArrival);
          viaLine.set(otherStop, true);
          predStop.set(otherStop, current);
          predStep.set(otherStop, {
            kind: "line",
            line: edge.line,
            direction: edge.direction,
            boardStop: current,
            alightStop: otherStop,
            departEpoch: nextDep,
            arriveEpoch: rawArrival,
          });
        }
      }
    }

    for (const edge of walkIndex.get(current) ?? []) {
      const rawArrival = currentTime + edge.minutes * 60;
      if (!bestArrival.has(edge.to) || rawArrival < bestArrival.get(edge.to)!) {
        bestArrival.set(edge.to, rawArrival);
        viaLine.set(edge.to, false);
        predStop.set(edge.to, current);
        predStep.set(edge.to, {
          kind: "walk",
          minutes: edge.minutes,
          fromEpoch: currentTime,
          toEpoch: rawArrival,
          fromStop: current,
          toStop: edge.to,
          label: `transfer walk ${current} -> ${edge.to}`,
        });
      }
    }
  }

  // Collect every feasible final destination connection (not just the
  // winner) so the UI can show deliberately-slower alternatives (e.g. a
  // scenic/preferred walk instead of one more bus leg).
  const candidates: { destStop: string; walkMinutes: number; finalArrival: number }[] = [];
  for (const conn of direction.destination.connectsTo) {
    const arr = bestArrival.get(conn.stop);
    if (arr === undefined) continue;
    candidates.push({ destStop: conn.stop, walkMinutes: conn.walkMinutes, finalArrival: arr + conn.walkMinutes * 60 });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.finalArrival - b.finalArrival);

  function buildItinerary(destStop: string, walkMinutes: number, finalArrival: number): Itinerary {
    const steps: StepResult[] = [];
    let cursor: string | typeof ORIGIN = destStop;
    while (cursor !== ORIGIN) {
      const stop = cursor as string;
      steps.unshift(predStep.get(stop)!);
      cursor = predStop.get(stop)!;
    }
    steps.push({
      kind: "walk",
      minutes: walkMinutes,
      fromEpoch: bestArrival.get(destStop)!,
      toEpoch: finalArrival,
      fromStop: destStop,
      toStop: direction.destination.name,
      label: `${destStop} -> ${direction.destination.name}`,
    });

    const transfers = Math.max(0, steps.filter((s) => s.kind === "line").length - 1);
    const totalMinutes = Math.round((finalArrival - leaveOrigin) / 60);

    return { departEpoch: leaveOrigin, arriveEpoch: finalArrival, steps, totalMinutes, transfers, alternatives: [] };
  }

  const [best, ...rest] = candidates;
  const result = buildItinerary(best.destStop, best.walkMinutes, best.finalArrival);
  result.alternatives = rest.map((c) => buildItinerary(c.destStop, c.walkMinutes, c.finalArrival));
  return result;
}

export async function planDirection(
  config: RouteConfig,
  direction: DirectionConfig,
  pattern: SchedulePattern,
  dayStartEpoch: number,
  fetchTimetableImpl: FetchTimetableFn = fetchTimetable,
  bounds?: { windowStart: number; windowEnd: number },
): Promise<Itinerary[]> {
  const { startMin, endMin } = parseWindow(direction.departureWindow);
  const windowStart = bounds?.windowStart ?? dayStartEpoch + startMin * 60;
  const windowEnd = bounds?.windowEnd ?? dayStartEpoch + endMin * 60;

  const lineIndex = buildLineIndex(config);
  const walkIndex = buildWalkIndex(config);
  const turnPenalty = buildTurnPenalty(config);
  const getTimetable = makeTimetableMemo(pattern, config.timezone, fetchTimetableImpl);

  // Sample candidate "leave origin" times: every real departure at every
  // line/stop reachable from the origin, shifted back by that stop's walk
  // time. Any itinerary's true leave-time can be pushed forward to exactly
  // one such sample without changing the outcome, so this is a complete
  // (not just heuristic) set of candidates — see module doc comment.
  const leaveTimes = new Set<number>();
  for (const conn of direction.origin.connectsTo) {
    for (const edge of lineIndex.get(conn.stop) ?? []) {
      const tt = await getTimetable(edge.boardUrl);
      for (const d of tt.departures) {
        const leave = d - conn.walkMinutes * 60;
        if (leave >= windowStart && leave <= windowEnd) leaveTimes.add(leave);
      }
    }
  }

  // For each candidate leave time, run the search once PER origin
  // connection (not once with all of them seeded together) so that walking
  // directly to a stop and taking a bus there remain separate options rather
  // than one silently discarding the other. All results for a
  // given leave time (each already including its own destination-side
  // alternatives) are flattened into one pool; the fastest becomes the
  // main itinerary and everything else becomes an alternative — same
  // one-level-deep pattern as the destination-side alternatives above.
  const itineraries: Itinerary[] = [];
  for (const leave of [...leaveTimes].sort((a, b) => a - b)) {
    const candidates: Itinerary[] = [];
    for (const originConn of direction.origin.connectsTo) {
      const it = await dijkstra(config, direction, leave, [originConn], lineIndex, walkIndex, turnPenalty, getTimetable);
      if (it) candidates.push(it, ...it.alternatives);
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => a.arriveEpoch - b.arriveEpoch);
    const [best, ...rest] = candidates;
    best.alternatives = rest;
    itineraries.push(best);
  }
  return itineraries;
}

/**
 * Computes each line's real stop order (restricted to its configured
 * stops), by fetching the timetable from every configured stop on that
 * line and merging the resulting "X minutes downstream of here" offsets.
 *
 * Why fetch from every stop rather than just the first: `stopOffsets` only
 * ever lists stops *downstream* of the fetched board stop (the scraped
 * "Zastávky" table only shows stops after the selected one) — so a single
 * fetch can't reveal the position of stops upstream of it. Fetching from
 * every configured stop and merging covers the full pairwise order
 * regardless of which one happens to be most "upstream" — verified
 * empirically: for an N-stop line this gives offsets from stop i to every
 * stop downstream of it, for every i, which is enough to totally order all
 * N stops by picking any one fetch's reference point and translating the
 * rest onto a shared scale.
 */
export async function computeLineStopOrders(
  config: RouteConfig,
  pattern: SchedulePattern,
  fetchTimetableImpl: FetchTimetableFn = fetchTimetable,
): Promise<LineStopOrder[]> {
  const getTimetable = makeTimetableMemo(pattern, config.timezone, fetchTimetableImpl);
  const results: LineStopOrder[] = [];

  for (const line of config.lines) {
    const configuredStops = Object.keys(line.stops);
    if (configuredStops.length < 2) continue;

    // Pick whichever configured stop reaches the most others as our
    // reference (likely the most "upstream" one, though not required to
    // be — any stop reaching all others directly works equally well).
    let bestRef: string | null = null;
    let bestOffsets: Map<string, number> | null = null;
    let bestCount = -1;
    for (const stop of configuredStops) {
      const tt = await getTimetable(line.stops[stop]);
      const reachableCount = configuredStops.filter((s) => s !== stop && tt.stopOffsets.has(s)).length;
      if (reachableCount > bestCount) {
        bestCount = reachableCount;
        bestRef = stop;
        bestOffsets = tt.stopOffsets;
      }
    }
    if (bestRef === null || bestOffsets === null) continue;

    const stopsInOrder = [{ name: bestRef, offsetMinutes: 0 }];
    for (const stop of configuredStops) {
      if (stop === bestRef) continue;
      const offset = bestOffsets.get(stop);
      if (offset !== undefined) stopsInOrder.push({ name: stop, offsetMinutes: offset });
    }

    // Any configured stops not directly reachable from bestRef (shouldn't
    // happen if bestRef was chosen well, but guard anyway): try resolving
    // them via a second stop's offsets, translated onto bestRef's scale.
    const unresolved = configuredStops.filter((s) => s !== bestRef && !bestOffsets!.has(s));
    for (const stop of unresolved) {
      for (const other of stopsInOrder) {
        if (other.name === bestRef) continue;
        const tt = await getTimetable(line.stops[other.name]);
        const offsetFromOther = tt.stopOffsets.get(stop);
        if (offsetFromOther !== undefined) {
          stopsInOrder.push({ name: stop, offsetMinutes: other.offsetMinutes + offsetFromOther });
          break;
        }
      }
    }

    stopsInOrder.sort((a, b) => a.offsetMinutes - b.offsetMinutes);
    results.push({ line: line.line, direction: line.direction, stops: stopsInOrder });
  }

  return results;
}
