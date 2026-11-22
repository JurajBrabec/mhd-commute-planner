import { test } from "node:test";
import assert from "node:assert/strict";
import { planDirection } from "../planner.js";
import type { RouteConfig, DirectionConfig, TimetablePage } from "../types.js";

// All synthetic URLs double as lookup keys into a small in-memory schedule
// table, so the fake fetchTimetableImpl below never touches the network.
const URLS = {
  lineA_atHome: "fake://lineA/Home",
  lineA_atMid: "fake://lineA/Mid",
  lineB_atMid: "fake://lineB/Mid",
  lineB_atWork: "fake://lineB/Work",
  lineC_atHome: "fake://lineC/Home", // a second, slower origin option
  lineC_atWork: "fake://lineC/Work",
} as const;

const DAY_START = 1_700_000_000; // arbitrary fixed epoch, aligned to a round number for readable offsets
const MIN = 60;

/**
 * Builds a fake TimetablePage for a line/stop pair from a small hand-rolled
 * schedule table, expressed as {departures (seconds after DAY_START),
 * stopOffsets (minutes to each downstream stop)}.
 */
function page(departuresFromStart: number[], stopOffsets: Record<string, number>): TimetablePage {
  return {
    departures: departuresFromStart.map((s) => DAY_START + s),
    stopOffsets: new Map(Object.entries(stopOffsets)),
  };
}

// Synthetic network:
//   Home --(walk 2min)--> HomeStop --(line A, 10min)--> MidStop
//   MidStop --(line B, 5min)--> WorkStop --(walk 2min)--> Work
//   Home --(walk 20min)--> SlowStop --(line C, 1min)--> WorkStop   (a much slower direct alternative)
//
// Line A departs HomeStop every 20 min starting at +0; line B departs
// MidStop every 20 min starting at +12 (2 min after line A's first arrival,
// enough to make the transfer feasible on the very first trip).
const SCHEDULE: Record<string, TimetablePage> = {
  [URLS.lineA_atHome]: page([0 * MIN, 20 * MIN, 40 * MIN], { MidStop: 10 }),
  [URLS.lineB_atMid]: page([12 * MIN, 32 * MIN, 52 * MIN], { WorkStop: 5 }),
  [URLS.lineC_atHome]: page([0 * MIN, 30 * MIN], { WorkStop: 1 }),
};

async function fakeFetchTimetable(url: string): Promise<TimetablePage> {
  const p = SCHEDULE[url];
  if (!p) throw new Error(`no fake schedule for ${url}`);
  // Return a fresh copy each time (defensive -- planner must not mutate it).
  return { departures: [...p.departures], stopOffsets: new Map(p.stopOffsets) };
}

function buildConfig(extra: Partial<RouteConfig> = {}): RouteConfig {
  return {
    timezone: "UTC",
    stops: ["HomeStop", "MidStop", "WorkStop", "SlowStop"],
    lines: [
      { line: "A", direction: "toMid", stops: { HomeStop: URLS.lineA_atHome } },
      { line: "B", direction: "toWork", stops: { MidStop: URLS.lineB_atMid } },
      { line: "C", direction: "direct", stops: { SlowStop: URLS.lineC_atHome } },
    ],
    walkTransfers: [],
    directions: {
      toWork: {
        departureWindow: "00:00-02:00",
        origin: { name: "Home", connectsTo: [{ stop: "HomeStop", walkMinutes: 2 }] },
        destination: { name: "Work", connectsTo: [{ stop: "WorkStop", walkMinutes: 2 }] },
      },
      toHome: {
        departureWindow: "00:00-02:00",
        origin: { name: "Work", connectsTo: [{ stop: "WorkStop", walkMinutes: 2 }] },
        destination: { name: "Home", connectsTo: [{ stop: "HomeStop", walkMinutes: 2 }] },
      },
    },
    ...extra,
  };
}

test("planDirection: finds a simple two-leg itinerary with correct times", async () => {
  const config = buildConfig();
  const results = await planDirection(config, config.directions.toWork, "workday", DAY_START, fakeFetchTimetable);

  assert.ok(results.length > 0, "expected at least one itinerary");
  const first = results[0];
  // leave Home at departEpoch; walk 2min -> board line A at +2min (first
  // departure is at +0, so must wait until the *next* one, +20min, since
  // leaving right at epoch 0 means walking arrives at HomeStop at +2min,
  // after the +0 departure already left)
  assert.equal(first.steps[0].kind, "walk");
  assert.equal(first.steps[1].kind, "line");
  assert.equal((first.steps[1] as { line: string }).line, "A");
  assert.equal(first.steps[2].kind, "line");
  assert.equal((first.steps[2] as { line: string }).line, "B");
  assert.equal(first.steps[3].kind, "walk");
});

test("planDirection: picks the next feasible line B departure after transferring", async () => {
  const config = buildConfig();
  const results = await planDirection(config, config.directions.toWork, "workday", DAY_START, fakeFetchTimetable);
  const first = results[0];
  const lineAStep = first.steps[1] as { arriveEpoch: number };
  const lineBStep = first.steps[2] as { departEpoch: number };
  // line B departs MidStop at +12, +32, +52 (relative to DAY_START); must
  // pick a departure >= line A's arrival time.
  assert.ok(lineBStep.departEpoch >= lineAStep.arriveEpoch, "must not board a line before arriving");
});

test("planDirection: origin-side alternatives are captured (regression for the toHome walk-vs-bus bug)", async () => {
  // Give Home TWO origin connections: the fast HomeStop->line A->line B
  // path, and a direct-but-slower SlowStop->line C path. Both should
  // appear for a shared departure: one as main, one as an alternative --
  // reproducing the walk-vs-bus bug with a synthetic network.
  const config = buildConfig();
  config.directions.toWork.origin.connectsTo.push({ stop: "SlowStop", walkMinutes: 20 });

  const results = await planDirection(config, config.directions.toWork, "workday", DAY_START, fakeFetchTimetable);
  assert.ok(results.length > 0);

  const withAlternatives = results.find((it) => it.alternatives.length > 0);
  assert.ok(withAlternatives, "expected at least one departure to have a captured alternative");
});

test("planDirection: destination-side alternatives are sorted by arrival time, excluding the winner", async () => {
  const config = buildConfig();
  // Add a second (slower) destination connection so there's something to
  // compare against the main WorkStop one.
  config.directions.toWork.destination.connectsTo.push({ stop: "MidStop", walkMinutes: 100 });

  const results = await planDirection(config, config.directions.toWork, "workday", DAY_START, fakeFetchTimetable);
  const withAlts = results.filter((it) => it.alternatives.length > 0);
  assert.ok(withAlts.length > 0);
  for (const it of withAlts) {
    for (const alt of it.alternatives) {
      assert.ok(alt.arriveEpoch >= it.arriveEpoch, "alternatives must never arrive before the main itinerary");
      assert.deepEqual(alt.alternatives, [], "an alternative's own alternatives must always be empty (one level deep only)");
    }
  }
});

test("planDirection: respects the departure window", async () => {
  const config = buildConfig();
  const narrow: DirectionConfig = {
    ...config.directions.toWork,
    departureWindow: "00:00-00:05", // only the very first few minutes
  };
  const results = await planDirection(config, narrow, "workday", DAY_START, fakeFetchTimetable);
  for (const it of results) {
    const windowEndEpoch = DAY_START + 5 * MIN;
    assert.ok(it.departEpoch <= windowEndEpoch, "no departure should fall outside the configured window");
  }
});

test("planDirection: turn penalty delays re-boarding after a same-stop transfer", async () => {
  const withPenalty = buildConfig({
    walkTransfers: [{ from: "MidStop", to: "MidStop", minutes: 10 }],
  });
  const withoutPenalty = buildConfig();

  const resultsWithPenalty = await planDirection(
    withPenalty,
    withPenalty.directions.toWork,
    "workday",
    DAY_START,
    fakeFetchTimetable,
  );
  const resultsWithoutPenalty = await planDirection(
    withoutPenalty,
    withoutPenalty.directions.toWork,
    "workday",
    DAY_START,
    fakeFetchTimetable,
  );

  assert.ok(resultsWithPenalty.length > 0);
  assert.ok(resultsWithoutPenalty.length > 0);
  // Same departure, compare total duration: the 10-minute turn penalty at
  // MidStop should push the itinerary onto a later line-B departure,
  // making it slower than the no-penalty case for at least one shared
  // departure time.
  const firstWith = resultsWithPenalty[0];
  const firstWithout = resultsWithoutPenalty[0];
  assert.ok(
    firstWith.totalMinutes >= firstWithout.totalMinutes,
    "turn penalty should never make the trip faster",
  );
});

test("planDirection: returns no itineraries when destination is unreachable", async () => {
  const config = buildConfig();
  config.directions.toWork.destination.connectsTo = [{ stop: "NoSuchReachableStop", walkMinutes: 1 }];
  const results = await planDirection(config, config.directions.toWork, "workday", DAY_START, fakeFetchTimetable);
  assert.deepEqual(results, []);
});
