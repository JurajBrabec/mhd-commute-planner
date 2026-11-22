import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";

const CACHE_DIR = path.resolve(process.cwd(), ".cache");

/**
 * Cache key includes the calendar date (in the given timezone), not just
 * the URL. This is required because the scraped page's "today" is relative
 * to *when it was fetched* (see scraper.ts day-offset note) — a plain
 * time-based TTL can silently serve yesterday's "today" across a midnight
 * rollover, with no error, just empty/wrong results. Keying by date forces
 * a fresh fetch every calendar day regardless of TTL.
 */
function keyFor(url: string, dateStr: string): string {
  return createHash("sha256").update(`${dateStr}|${url}`).digest("hex");
}

function todayDateStr(timezone: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: timezone }); // YYYY-MM-DD
}

// Remove all cached timetable pages; the next fetch recreates the directory.
export async function clearTimetableCache(): Promise<void> {
  await rm(CACHE_DIR, { recursive: true, force: true });
}

export async function fetchCached(url: string, timezone: string): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${keyFor(url, todayDateStr(timezone))}.html`);

  try {
    return await readFile(file, "utf8");
  } catch {
    // no cache yet for today
  }

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (mhd-commute-planner)" },
  });
  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }
  const html = await res.text();
  await writeFile(file, html, "utf8");
  return html;
}
