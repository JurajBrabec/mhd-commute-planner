import { test } from "node:test";
import assert from "node:assert/strict";
import { todayWindow, localTimeEpoch } from "../time.js";

test("Bratislava commute windows use local time across DST transitions", () => {
  for (const [date, midnight, seven] of [
    ["2026-01-15", "2026-01-14T23:00:00Z", "2026-01-15T06:00:00Z"],
    ["2026-07-15", "2026-07-14T22:00:00Z", "2026-07-15T05:00:00Z"],
    ["2026-03-29", "2026-03-28T23:00:00Z", "2026-03-29T05:00:00Z"],
    ["2026-10-25", "2026-10-24T22:00:00Z", "2026-10-25T06:00:00Z"],
  ]) {
    const result = todayWindow("Europe/Bratislava", "07:00-08:00", new Date(date + "T12:00:00Z"));
    assert.equal(result.dayStart, Date.parse(midnight) / 1000);
    assert.equal(result.windowStart, Date.parse(seven) / 1000);
    assert.equal(result.windowEnd - result.windowStart, 3600);
  }
});

test("DST gaps are rejected and repeated times cover both occurrences", () => {
  assert.throws(() => localTimeEpoch("2026-03-29", 150, "Europe/Bratislava"), /does not exist/);
  const first = localTimeEpoch("2026-10-25", 150, "Europe/Bratislava");
  const last = localTimeEpoch("2026-10-25", 150, "Europe/Bratislava", "end");
  assert.equal(last - first, 3600);
});
