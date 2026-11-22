import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createVizServer } from "../build-viz.js";
import type { JsonOutput } from "../format.js";
import type { SchedulePattern } from "../scraper.js";

function fixture(pattern: SchedulePattern, version: number): JsonOutput {
  return {
    generatedAt: new Date(version * 1000).toISOString(), timezone: "Europe/Bratislava", pattern,
    stops: [], lineStopOrders: [],
    directions: {
      toWork: { origin: "Home", destination: "Work", departureWindow: "07:00-08:00", itineraries: [] },
      toHome: { origin: "Work", destination: "Home", departureWindow: "16:00-17:00", itineraries: [] },
    },
  };
}

async function start(generate: (p: SchedulePattern) => Promise<JsonOutput>, clear = async () => {}) {
  const server = createVizServer("Europe/Bratislava", "workday", generate, clear);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, close: () => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())) };
}

test("server routes, validation and per-pattern caching", async () => {
  let calls = 0;
  const app = await start(async p => fixture(p, ++calls));
  try {
    const shell = await fetch(app.base + "/");
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get("content-type")!, /text\/html/);
    assert.match(await shell.text(), /refresh-cache/);
    assert.equal((await fetch(app.base + "/missing")).status, 404);
    assert.equal((await fetch(app.base + "/api/data?pattern=invalid")).status, 400);
    assert.equal((await fetch(app.base + "/api/data", { method: "POST" })).status, 405);
    assert.equal((await fetch(app.base + "/api/refresh")).status, 405);
    assert.equal((await fetch(app.base + "/api/refresh", { method: "POST" })).status, 415);
    const a = await (await fetch(app.base + "/api/data")).json();
    const b = await (await fetch(app.base + "/api/data")).json();
    const c = await (await fetch(app.base + "/api/data?pattern=freeday")).json() as JsonOutput;
    assert.deepEqual(a, b);
    assert.equal(c.pattern, "freeday");
    assert.equal(calls, 2);
  } finally { await app.close(); }
});

test("refresh invalidates both pattern results and clears timetable cache", async () => {
  let calls = 0, clears = 0;
  const app = await start(async p => fixture(p, ++calls), async () => { clears++; });
  try {
    const get = async (p: string) => (await fetch(app.base + "/api/data?pattern=" + p)).json() as Promise<JsonOutput>;
    const before = await get("workday");
    await get("freeday");
    const response = await fetch(app.base + "/api/refresh", { method: "POST", headers: { "Content-Type": "application/json" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.notEqual((await get("workday")).generatedAt, before.generatedAt);
    await get("freeday");
    assert.equal(calls, 4);
    assert.equal(clears, 1);
  } finally { await app.close(); }
});

test("concurrent requests share a build and refresh waits for it", async () => {
  let calls = 0, clears = 0;
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const entered = new Promise<void>(r => { started = r; });
  const app = await start(async p => { calls++; if (calls === 1) { started(); await gate; } return fixture(p, calls); }, async () => { clears++; });
  try {
    const first = fetch(app.base + "/api/data");
    await entered;
    const second = fetch(app.base + "/api/data");
    // Ensure the second request is queued before refresh.
    await new Promise(r => setTimeout(r, 30));
    const refresh = fetch(app.base + "/api/refresh", { method: "POST", headers: { "Content-Type": "application/json" } });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(clears, 0);
    release();
    assert.deepEqual(await (await first).json(), await (await second).json());
    assert.equal((await refresh).status, 200);
    assert.equal(clears, 1);
    await fetch(app.base + "/api/data");
    assert.equal(calls, 2);
  } finally { release(); await app.close(); }
});

test("failed generation is not cached and a subsequent request can retry", async () => {
  let calls = 0;
  const app = await start(async p => { if (++calls === 1) throw new Error("synthetic failure"); return fixture(p, calls); });
  try {
    assert.equal((await fetch(app.base + "/api/data")).status, 500);
    assert.equal((await fetch(app.base + "/api/data")).status, 200);
    assert.equal(calls, 2);
  } finally { await app.close(); }
});
