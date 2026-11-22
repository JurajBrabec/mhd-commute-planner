import { test } from "node:test";
import assert from "node:assert/strict";
import { directionToJson, buildJsonOutput } from "../format.js";
import type { DirectionConfig, Itinerary } from "../types.js";

const TZ = "Europe/Bratislava";

function makeItinerary(overrides: Partial<Itinerary> = {}): Itinerary {
  const departEpoch = 1_700_000_000;
  const arriveEpoch = departEpoch + 30 * 60;
  return {
    departEpoch,
    arriveEpoch,
    totalMinutes: 30,
    transfers: 1,
    steps: [
      {
        kind: "walk",
        minutes: 2,
        fromEpoch: departEpoch,
        toEpoch: departEpoch + 2 * 60,
        fromStop: "Home",
        toStop: "StopA",
        label: "Home -> StopA",
      },
      {
        kind: "line",
        line: "9",
        direction: "Somewhere",
        boardStop: "StopA",
        alightStop: "StopB",
        departEpoch: departEpoch + 3 * 60,
        arriveEpoch: departEpoch + 20 * 60,
      },
      {
        kind: "walk",
        minutes: 2,
        fromEpoch: departEpoch + 20 * 60,
        toEpoch: arriveEpoch,
        fromStop: "StopB",
        toStop: "Work",
        label: "StopB -> Work",
      },
    ],
    alternatives: [],
    ...overrides,
  };
}

const DIRECTION: DirectionConfig = {
  departureWindow: "07:00-08:00",
  origin: { name: "Home", connectsTo: [{ stop: "StopA", walkMinutes: 2 }] },
  destination: { name: "Work", connectsTo: [{ stop: "StopB", walkMinutes: 2 }] },
};

test("directionToJson: round-trips basic fields", () => {
  const it = makeItinerary();
  const json = directionToJson(DIRECTION, [it], TZ);
  assert.equal(json.departureWindow, "07:00-08:00");
  assert.equal(json.origin, "Home");
  assert.equal(json.destination, "Work");
  assert.equal(json.itineraries.length, 1);
  assert.equal(json.itineraries[0].durationMinutes, 30);
  assert.equal(json.itineraries[0].transfers, 1);
});

test("directionToJson: walk steps carry fromStop/toStop (not just the free-text label)", () => {
  const it = makeItinerary();
  const json = directionToJson(DIRECTION, [it], TZ);
  const walkSteps = json.itineraries[0].steps.filter((s) => s.kind === "walk");
  assert.equal(walkSteps.length, 2);
  assert.equal(walkSteps[0].fromStop, "Home");
  assert.equal(walkSteps[0].toStop, "StopA");
  assert.equal(walkSteps[1].fromStop, "StopB");
  assert.equal(walkSteps[1].toStop, "Work");
});

test("directionToJson: line steps carry line/direction/boardStop/alightStop", () => {
  const it = makeItinerary();
  const json = directionToJson(DIRECTION, [it], TZ);
  const lineStep = json.itineraries[0].steps.find((s) => s.kind === "line")!;
  assert.equal(lineStep.line, "9");
  assert.equal(lineStep.direction, "Somewhere");
  assert.equal(lineStep.boardStop, "StopA");
  assert.equal(lineStep.alightStop, "StopB");
});

test("directionToJson: alternatives are serialized recursively, one level deep", () => {
  const alt = makeItinerary({ totalMinutes: 40 });
  const main = makeItinerary({ alternatives: [alt] });
  const json = directionToJson(DIRECTION, [main], TZ);
  assert.equal(json.itineraries[0].alternatives.length, 1);
  assert.equal(json.itineraries[0].alternatives[0].durationMinutes, 40);
  assert.deepEqual(json.itineraries[0].alternatives[0].alternatives, []);
});

test("directionToJson: departTime/arriveTime are formatted HH:mm in the given timezone", () => {
  const it = makeItinerary();
  const json = directionToJson(DIRECTION, [it], TZ);
  assert.match(json.itineraries[0].departTime, /^\d{2}:\d{2}$/);
  assert.match(json.itineraries[0].arriveTime, /^\d{2}:\d{2}$/);
});

test("buildJsonOutput: assembles the full document with both directions", () => {
  const it = makeItinerary();
  const toWork = directionToJson(DIRECTION, [it], TZ);
  const toHome = directionToJson(DIRECTION, [], TZ);
  const output = buildJsonOutput(TZ, "workday", ["StopA", "StopB"], [], toWork, toHome);

  assert.equal(output.timezone, TZ);
  assert.equal(output.pattern, "workday");
  assert.deepEqual(output.stops, ["StopA", "StopB"]);
  assert.deepEqual(output.lineStopOrders, []);
  assert.equal(output.directions.toWork.itineraries.length, 1);
  assert.equal(output.directions.toHome.itineraries.length, 0);
  assert.ok(output.generatedAt.length > 0);
  // generatedAt should be a valid ISO timestamp
  assert.ok(!Number.isNaN(new Date(output.generatedAt).getTime()));
});

test("buildJsonOutput: output is JSON-serializable (no circular refs, no Maps/Sets left over)", () => {
  const it = makeItinerary();
  const toWork = directionToJson(DIRECTION, [it], TZ);
  const toHome = directionToJson(DIRECTION, [], TZ);
  const output = buildJsonOutput(TZ, "freeday", ["StopA"], [], toWork, toHome);
  const json = JSON.stringify(output);
  const parsed = JSON.parse(json);
  assert.equal(parsed.pattern, "freeday");
  assert.equal(parsed.directions.toWork.itineraries[0].steps.length, 3);
});
