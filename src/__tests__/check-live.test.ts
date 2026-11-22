import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checkLivePage } from "../check-live.js";

const html = await readFile(new URL("./fixtures/three-patterns.html", import.meta.url), "utf8");

test("live check reports both patterns without touching the network", async () => {
  const fakeFetch: typeof fetch = async () => new Response(html, { status: 200 });
  const result = await checkLivePage("https://imhd.sk/example", ["Example B"], fakeFetch);
  assert.equal(result.length, 2);
  assert.match(result[0], /workday:.*1 configured downstream stops matched/);
  assert.match(result[1], /freeday:/);
});

test("live check rejects upstream errors and unexpected page structure", async () => {
  await assert.rejects(() => checkLivePage("https://imhd.sk/example", [], async () => new Response("", { status: 503 })), /HTTP 503/);
  await assert.rejects(() => checkLivePage("https://imhd.sk/example", [], async () => new Response("not a timetable")), /service-pattern tabs/);
  await assert.rejects(() => checkLivePage("https://imhd.sk/example", [], async () => new Response(html.replaceAll('data-depts=', 'data-missing='))), /no departures parsed/);
});
