import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scheduleChanges } from "../schedule-changes.js";
import type { RouteConfig } from "../types.js";

const config = { timezone: "Europe/Bratislava", lines: [{ line: "9", direction: "A", stops: { A: "https://imhd.sk/a" } }] } as unknown as RouteConfig;

test("schedule fingerprints compare clock times and survive cache refresh", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mhd-history-"));
  let departure = 1700086400, offset = 4;
  const fetchPage = async () => ({ departures: [departure], stopOffsets: new Map([["B", offset]]) });
  try {
    assert.deepEqual(await scheduleChanges(config, "workday", fetchPage, dir), { compared: false, lines: [], newLines: ["9"], removedPages: 0 });
    departure += 86400;
    assert.deepEqual(await scheduleChanges(config, "workday", fetchPage, dir), { compared: true, lines: [], newLines: [], removedPages: 0 });
    offset++;
    assert.deepEqual(await scheduleChanges(config, "workday", fetchPage, dir), { compared: true, lines: ["9"], newLines: [], removedPages: 0 });
    assert.deepEqual(await scheduleChanges(config, "freeday", fetchPage, dir), { compared: false, lines: [], newLines: ["9"], removedPages: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("added, removed and changed URLs are reported as uncomparable pages", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mhd-history-"));
  const fetchPage = async () => ({ departures: [1700086400], stopOffsets: new Map([["B", 4]]) });
  const changedConfig = { ...config, lines: [
    config.lines[0],
    { line: "50", direction: "B", stops: { B: "https://imhd.sk/new" } },
  ] };
  try {
    await scheduleChanges(config, "workday", fetchPage, dir);
    assert.deepEqual(await scheduleChanges(changedConfig, "workday", fetchPage, dir), { compared: true, lines: [], newLines: ["50"], removedPages: 0 });
    const replaced = { ...changedConfig, lines: [config.lines[0], { ...changedConfig.lines[1], stops: { B: "https://imhd.sk/replaced" } }] };
    assert.deepEqual(await scheduleChanges(replaced, "workday", fetchPage, dir), { compared: true, lines: [], newLines: ["50"], removedPages: 1 });
    assert.deepEqual(await scheduleChanges(config, "workday", fetchPage, dir), { compared: true, lines: [], newLines: [], removedPages: 1 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("failed comparison leaves the previous baseline intact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mhd-history-"));
  const page = (offset: number) => async () => ({ departures: [1700086400], stopOffsets: new Map([["B", offset]]) });
  try {
    await scheduleChanges(config, "workday", page(4), dir);
    await assert.rejects(() => scheduleChanges(config, "workday", async () => { throw new Error("network failure"); }, dir), /network failure/);
    assert.deepEqual(await scheduleChanges(config, "workday", page(5), dir), { compared: true, lines: ["9"], newLines: [], removedPages: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("invalid history is reported rather than silently losing the baseline", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mhd-history-"));
  try {
    await writeFile(path.join(dir, "workday.json"), "null");
    await assert.rejects(() => scheduleChanges(config, "workday", async () => ({ departures: [1], stopOffsets: new Map() }), dir), /Invalid schedule history/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
