// Config file shape (parsed from YAML) and internal planning types.
// This is a GRAPH model: named stops + lines serving a subset of them,
// plus optional fixed-minute walk transfers between physically distinct
// stops. The planner searches this graph for the earliest arrival per
// departure, rather than following a pre-picked sequence of legs.

export interface LineConfig {
  line: string;
  direction: string;
  /** Per-stop timetable URL, keyed by stop name (must be a subset of `stops`). */
  stops: Record<string, string>;
}

export interface WalkTransferConfig {
  from: string;
  to: string;
  minutes: number;
  /** If true, also usable from `to` to `from` with the same duration. */
  bidirectional?: boolean;
}

export interface EndpointConnection {
  stop: string;
  walkMinutes: number;
}

export interface EndpointConfig {
  name: string;
  connectsTo: EndpointConnection[];
}

export interface DirectionConfig {
  departureWindow: string; // "16:00-17:00"
  origin: EndpointConfig;
  destination: EndpointConfig;
}

export interface RouteConfig {
  timezone: string;
  stops: string[];
  lines: LineConfig[];
  walkTransfers: WalkTransferConfig[];
  directions: {
    toWork: DirectionConfig;
    toHome: DirectionConfig;
  };
}

// --- Scraped schedule data ---

export interface TimetablePage {
  /**
   * Departure epoch seconds at the board stop, for the matched service
   * pattern (workday/freeday). The calendar date component is whatever
   * "today" was when scraped — only the time-of-day is meaningful, since
   * a pattern's three data-depts epochs are always exactly 24h apart (see
   * scraper.ts).
   */
  departures: number[];
  /** stop name -> minutes-from-board (max), excludes the board stop itself */
  stopOffsets: Map<string, number>;
}

// --- Planner output ---

export interface LineStepResult {
  kind: "line";
  line: string;
  direction: string;
  boardStop: string;
  alightStop: string;
  departEpoch: number;
  arriveEpoch: number;
}

export interface WalkStepResult {
  kind: "walk";
  minutes: number;
  fromEpoch: number;
  toEpoch: number;
  /** Named endpoint this walk starts/ends at — origin/destination name or a stop name. */
  fromStop: string;
  toStop: string;
  /** Human-readable description, e.g. "Home -> Example stop". */
  label: string;
}

export type StepResult = LineStepResult | WalkStepResult;

export interface Itinerary {
  departEpoch: number; // leaving origin
  arriveEpoch: number; // arriving at destination
  steps: StepResult[];
  totalMinutes: number;
  transfers: number;
  /**
   * Every other way to reach the destination from this same departure,
   * via a different `destination.connectsTo` stop (e.g. a longer final walk
   * instead of one more bus) — sorted by arrival time, this itinerary
   * itself excluded. Lets the UI show "how much time you'd lose" for a
   * deliberately-slower choice (e.g. walking the last stretch instead of
   * waiting for a bus).
   */
  alternatives: Itinerary[];
}

/**
 * A line's real stop order (restricted to the subset of its stops that are
 * also in config.stops — the ones the graph/UI actually cares about),
 * sorted by actual minute-offset from the first such stop. Used to connect
 * stops that share a line but where no itinerary happens to board/alight
 * at one of the in-between stops directly — without this, a stop order
 * derived only from used itinerary steps can't place intermediate stops
 * relative to each other, even though the scraped timetable already knows
 * their real relative distance.
 */
export interface LineStopOrder {
  line: string;
  direction: string;
  /** Stop names in real line order, each with minutes-from-first-stop. */
  stops: { name: string; offsetMinutes: number }[];
}
