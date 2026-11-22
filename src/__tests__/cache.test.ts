import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// cache.ts resolves CACHE_DIR from process.cwd() at import time, so we must
// chdir into a scratch directory *before* importing it.
const scratchDir = await mkdtemp(path.join(tmpdir(), "mhd-cache-test-"));
const originalCwd = process.cwd();
process.chdir(scratchDir);
const { fetchCached, clearTimetableCache } = await import("../cache.js");

test("clearTimetableCache: next request fetches fresh content", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => ({ ok: true, text: async () => `version ${++calls}` }) as Response) as typeof fetch;
  try {
    const url = "https://example.test/refresh";
    assert.equal(await fetchCached(url, "Europe/Bratislava"), "version 1");
    assert.equal(await fetchCached(url, "Europe/Bratislava"), "version 1");
    await clearTimetableCache();
    assert.equal(await fetchCached(url, "Europe/Bratislava"), "version 2");
  } finally {
    await clearTimetableCache();
    globalThis.fetch = originalFetch;
  }
});

async function withFakeFetch(responseText: string, fn: () => Promise<void>) {
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    callCount++;
    return { ok: true, text: async () => responseText } as Response;
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return callCount;
}

test.after(async () => {
  process.chdir(originalCwd);
  await rm(scratchDir, { recursive: true, force: true });
});

test("fetchCached: fetches over the network on a cold cache and writes a cache file", async () => {
  const url = "https://example.invalid/page-a";
  let calls = 0;
  calls = await withFakeFetch("<html>hello</html>", async () => {
    const html = await fetchCached(url, "Europe/Bratislava");
    assert.equal(html, "<html>hello</html>");
  });
  assert.equal(calls, 1, "expected exactly one network fetch on a cold cache");

  const files = await readdir(path.join(scratchDir, ".cache"));
  assert.equal(files.length, 1, "expected exactly one cache file to be written");
});

test("fetchCached: serves from cache on a second call for the same URL+day, no network hit", async () => {
  const url = "https://example.invalid/page-b";
  const firstCalls = await withFakeFetch("<html>first</html>", async () => {
    await fetchCached(url, "Europe/Bratislava");
  });
  assert.equal(firstCalls, 1);

  const secondCalls = await withFakeFetch("<html>should not be used</html>", async () => {
    const html = await fetchCached(url, "Europe/Bratislava");
    assert.equal(html, "<html>first</html>", "must return the cached content, not a fresh fetch");
  });
  assert.equal(secondCalls, 0, "a warm cache hit must not touch the network at all");
});

test("fetchCached: regression -- a cache entry from a different calendar day is never served as today's", async () => {
  // Simulates the real bug found during development: fetching late on day
  // N, then again on day N+1, must NOT silently reuse day N's cached page.
  // Rather than pre-computing a hash externally (which would only test
  // that our OWN keying logic matches itself, not the real module under
  // test), we mock the system clock and call the module's actual exported
  // function twice: once pretending it's "day A", once pretending it's
  // "day B", and confirm the second call hits the network instead of
  // reusing day A's cached file.
  const url = "https://example.invalid/page-c";
  const RealDate = globalThis.Date;
  function mockDate(iso: string) {
    // cache.ts only ever calls `new Date()` with no arguments (see
    // todayDateStr()), so only that constructor form needs overriding.
    function MockDate(this: unknown) {
      return new RealDate(iso);
    }
    MockDate.now = () => new RealDate(iso).getTime();
    globalThis.Date = MockDate as unknown as DateConstructor;
  }

  try {
    mockDate("2026-11-14T10:00:00Z");
    const callsDayA = await withFakeFetch("<html>DAY A CONTENT</html>", async () => {
      const html = await fetchCached(url, "Europe/Bratislava");
      assert.equal(html, "<html>DAY A CONTENT</html>");
    });
    assert.equal(callsDayA, 1, "first fetch (day A) must hit the network");

    mockDate("2026-11-15T10:00:00Z"); // next calendar day, same timezone
    const callsDayB = await withFakeFetch("<html>DAY B CONTENT</html>", async () => {
      const html = await fetchCached(url, "Europe/Bratislava");
      assert.equal(html, "<html>DAY B CONTENT</html>", "must fetch fresh content for the new day, not reuse day A's cache");
    });
    assert.equal(callsDayB, 1, "crossing a calendar day must trigger a fresh network fetch, not a cache hit");
  } finally {
    globalThis.Date = RealDate;
  }
});

test("fetchCached: throws a clear error when the upstream fetch fails", async () => {
  const url = "https://example.invalid/page-d";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({ ok: false, status: 503, text: async () => "" }) as unknown as Response) as typeof fetch;
  try {
    await assert.rejects(() => fetchCached(url, "Europe/Bratislava"), /Fetch failed 503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
