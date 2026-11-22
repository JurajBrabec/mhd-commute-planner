// Converts planner output into a JSON-serializable document. Kept separate
// from types.ts/planner.ts so the internal Itinerary shape (epoch-based) can
// evolve independently of the on-disk/API JSON contract.

import type { DirectionConfig, Itinerary, LineStopOrder, StepResult } from "./types.js";

export interface JsonStep {
  kind: "line" | "walk";
  departTime: string;
  arriveTime: string;
  departEpoch: number;
  arriveEpoch: number;
  minutes: number;
  // line-only
  line?: string;
  direction?: string;
  boardStop?: string;
  alightStop?: string;
  // walk-only
  fromStop?: string;
  toStop?: string;
  label?: string;
}

export interface JsonItinerary {
  departTime: string;
  arriveTime: string;
  departEpoch: number;
  arriveEpoch: number;
  durationMinutes: number;
  transfers: number;
  steps: JsonStep[];
  /**
   * Other ways to reach the destination from the same departure, via a
   * different final-stop choice (e.g. a longer walk instead of one more
   * bus leg). Sorted by arrival time; empty if there was only one option.
   * Each alternative's own `alternatives` is always [] (one level deep).
   */
  alternatives: JsonItinerary[];
}

export interface JsonDirection {
  departureWindow: string;
  origin: string;
  destination: string;
  itineraries: JsonItinerary[];
}

export interface JsonOutput {
  generatedAt: string;
  scheduleChanges?: { compared: boolean; lines: string[]; newLines: string[]; removedPages: number };
  timezone: string;
  /** Which imhd.sk service pattern these itineraries were planned against. */
  pattern: "workday" | "freeday";
  /**
   * The configured stop order from config.stops (graph node list). Used
   * by the whole-network Marey overlay to fix a single y-axis ordering
   * shared across all itineraries/lines, independent of any one trip's own
   * stop sequence.
   */
  stops: string[];
  /**
   * Each line's real stop order (subset restricted to `stops`), with real
   * minute-offsets. Lets consumers (the whole-network Marey overlay) place
   * intermediate stops relative to each other even when no itinerary
   * happens to board/alight at one of them directly.
   */
  lineStopOrders: LineStopOrder[];
  directions: {
    toWork: JsonDirection;
    toHome: JsonDirection;
  };
}

function fmtTime(epoch: number, timezone: string): string {
  return new Date(epoch * 1000).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
    hourCycle: "h23",
  });
}

function stepToJson(step: StepResult, timezone: string): JsonStep {
  if (step.kind === "line") {
    const minutes = Math.round((step.arriveEpoch - step.departEpoch) / 60);
    return {
      kind: "line",
      departTime: fmtTime(step.departEpoch, timezone),
      arriveTime: fmtTime(step.arriveEpoch, timezone),
      departEpoch: step.departEpoch,
      arriveEpoch: step.arriveEpoch,
      minutes,
      line: step.line,
      direction: step.direction,
      boardStop: step.boardStop,
      alightStop: step.alightStop,
    };
  }
  return {
    kind: "walk",
    departTime: fmtTime(step.fromEpoch, timezone),
    arriveTime: fmtTime(step.toEpoch, timezone),
    departEpoch: step.fromEpoch,
    arriveEpoch: step.toEpoch,
    minutes: step.minutes,
    fromStop: step.fromStop,
    toStop: step.toStop,
    label: step.label,
  };
}

function itineraryToJson(it: Itinerary, timezone: string): JsonItinerary {
  return {
    departTime: fmtTime(it.departEpoch, timezone),
    arriveTime: fmtTime(it.arriveEpoch, timezone),
    departEpoch: it.departEpoch,
    arriveEpoch: it.arriveEpoch,
    durationMinutes: it.totalMinutes,
    transfers: it.transfers,
    steps: it.steps.map((s) => stepToJson(s, timezone)),
    alternatives: it.alternatives.map((alt) => itineraryToJson(alt, timezone)),
  };
}

export function directionToJson(
  direction: DirectionConfig,
  itineraries: Itinerary[],
  timezone: string,
): JsonDirection {
  return {
    departureWindow: direction.departureWindow,
    origin: direction.origin.name,
    destination: direction.destination.name,
    itineraries: itineraries.map((it) => itineraryToJson(it, timezone)),
  };
}

export function buildJsonOutput(
  timezone: string,
  pattern: "workday" | "freeday",
  stops: string[],
  lineStopOrders: LineStopOrder[],
  toWork: JsonDirection,
  toHome: JsonDirection,
): JsonOutput {
  return {
    generatedAt: new Date().toISOString(),
    timezone,
    pattern,
    stops,
    lineStopOrders,
    directions: { toWork, toHome },
  };
}
