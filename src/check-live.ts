// Opt-in compatibility check: fetch one configured page directly, never via the disk cache.
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { parseTimetablePage, type SchedulePattern } from "./scraper.js";

export async function checkLivePage(url: string, expectedStops: string[], fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "Mozilla/5.0 (mhd-commute-planner)" },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Timetable request failed: HTTP ${response.status}`);
  const html = await response.text();
  const results: string[] = [];
  for (const pattern of ["workday", "freeday"] as SchedulePattern[]) {
    const page = parseTimetablePage(html, pattern);
    if (!page.departures.length) throw new Error(`${pattern}: no departures parsed`);
    if (page.departures.some(epoch => !Number.isFinite(epoch) || epoch <= 0)) throw new Error(`${pattern}: invalid departure epoch`);
    if (!page.stopOffsets.size) throw new Error(`${pattern}: no downstream stop offsets parsed`);
    const matched = expectedStops.filter(stop => page.stopOffsets.has(stop));
    results.push(`${pattern}: ${page.departures.length} departures, ${page.stopOffsets.size} downstream stops; ${matched.length} configured downstream stops matched`);
  }
  return results;
}

async function main() {
  const configPath = process.argv[2] ?? "config/routes.yaml";
  const config = await loadConfig(configPath);
  // Prefer a page with another configured stop on its line. Trying pages in
  // order avoids assuming that YAML stop order matches the line direction.
  const candidates = config.lines.filter(line => Object.keys(line.stops).length > 1);
  if (!candidates.length) throw new Error("No line has at least two configured stops to check");
  const line = candidates[0];
  const [boarding, url] = Object.entries(line.stops)[0];
  const expected = Object.keys(line.stops).filter(stop => stop !== boarding);
  console.log(`Checking line ${line.line}, direction ${line.direction}, boarding at ${boarding}`);
  for (const result of await checkLivePage(url, expected)) console.log(result);
  console.log("Check completed; no cache files were modified. Review matched stops if the boarding stop is not upstream.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(`Live check failed: ${err instanceof Error ? err.message : String(err)}`); process.exitCode = 1; });
}
