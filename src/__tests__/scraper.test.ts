import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseTimetablePage } from "../scraper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");

const line4Html = readFileSync(path.join(fixturesDir, "three-patterns.html"), "utf8");
const line39Html = readFileSync(path.join(fixturesDir, "two-patterns.html"), "utf8");

test("parseTimetablePage: workday pattern returns departures and stop offsets (3-tab line)", () => {
  const tt = parseTimetablePage(line4Html, "workday");
  assert.ok(tt.departures.length > 0, "expected at least one departure");
  assert.ok(tt.stopOffsets.size > 0, "expected at least one stop offset");
  // departures must be sorted ascending
  for (let i = 1; i < tt.departures.length; i++) {
    assert.ok(tt.departures[i] >= tt.departures[i - 1], "departures must be sorted ascending");
  }
});

test("parseTimetablePage: freeday pattern returns a different departure set than workday", () => {
  const workday = parseTimetablePage(line4Html, "workday");
  const freeday = parseTimetablePage(line4Html, "freeday");
  assert.notDeepEqual(
    workday.departures,
    freeday.departures,
    "workday and freeday schedules should differ for this line",
  );
});

test("parseTimetablePage: stop offsets are non-negative and exclude the board stop itself", () => {
  const tt = parseTimetablePage(line4Html, "workday");
  for (const [name, minutes] of tt.stopOffsets) {
    assert.ok(minutes > 0, `offset for ${name} should be positive (board stop itself is excluded)`);
  }
});

test("parseTimetablePage: handles a line with only 2 tabs (no school-holiday variant)", () => {
  const workday = parseTimetablePage(line39Html, "workday");
  const freeday = parseTimetablePage(line39Html, "freeday");
  assert.ok(workday.departures.length > 0);
  assert.ok(freeday.departures.length > 0);
  assert.notDeepEqual(workday.departures, freeday.departures);
});

test("parseTimetablePage: departures triple is [yesterday,today,tomorrow] and we must read the middle slot", () => {
  // Regression test for a real bug found during development: the scraper
  // originally assumed data-depts was [today,+1,+2] and read index 0,
  // which actually holds YESTERDAY's epoch. Every triple is exactly 86400s
  // apart, so reading the wrong slot doesn't crash -- it silently serves
  // the wrong day. This test pins down that we read index 1 specifically,
  // by checking returned departures against the middle slot only (not
  // first or last), using the *raw fixture data* as ground truth rather
  // than the function's own output (which would make the test circular).
  const matches = [...line4Html.matchAll(/data-depts="(\d+);(\d+);(\d+)"/g)];
  assert.ok(matches.length > 0, "fixture should contain data-depts cells");
  const [, e0, e1, e2] = matches[0];
  assert.equal(Number(e1) - Number(e0), 86400, "day 0->1 gap must be exactly 24h");
  assert.equal(Number(e2) - Number(e1), 86400, "day 1->2 gap must be exactly 24h");

  const firstSlotEpochs = new Set(matches.map((m) => Number(m[1])));
  const middleSlotEpochs = new Set(matches.map((m) => Number(m[2])));
  const lastSlotEpochs = new Set(matches.map((m) => Number(m[3])));

  const tt = parseTimetablePage(line4Html, "workday");
  assert.ok(tt.departures.length > 0);
  const allFromMiddle = tt.departures.every((d) => middleSlotEpochs.has(d));
  const noneFromFirst = tt.departures.every((d) => !firstSlotEpochs.has(d));
  const noneFromLast = tt.departures.every((d) => !lastSlotEpochs.has(d));
  assert.ok(allFromMiddle, "every departure must come from the middle (today) slot");
  assert.ok(noneFromFirst, "no departure should come from the first (yesterday) slot");
  assert.ok(noneFromLast, "no departure should come from the last (tomorrow) slot");
});

test("parseTimetablePage: throws a clear error when no matching pattern exists", () => {
  const brokenHtml = "<html><body>no service pattern tabs here</body></html>";
  assert.throws(() => parseTimetablePage(brokenHtml, "workday"), /service-pattern tabs/);
});
