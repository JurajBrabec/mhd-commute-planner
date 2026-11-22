import * as cheerio from "cheerio";
import { fetchCached } from "./cache.js";
import type { TimetablePage } from "./types.js";

export type SchedulePattern = "workday" | "freeday";

/**
 * Classifies an imhd.sk service-pattern tab label into our two buckets.
 *
 * Observed labels across lines (tab IDs are NOT consistent across lines —
 * e.g. line 4 uses SM-14/11/9, another uses SM-41/49/9, another only has
 * SM-21/9 — so matching must be by label text, not numeric ID):
 *   "Pracovné dni, školský rok"        -> workday (school-year variant)
 *   "Pracovné dni, školské prázdniny"  -> workday (school-holiday variant)
 *   "Pracovné dni"                     -> workday (lines with no split)
 *   "Vysokoškolský rok"                -> workday (university-year variant)
 *   "Vysokoškolské prázdniny"          -> workday (university-holiday variant)
 *   "Voľné dni"                        -> freeday (weekends/public holidays)
 *
 * When a line has multiple "workday" sub-variants, we prefer the
 * *non*-holiday one (school-year / university-year), since most of the
 * year is in session — see AGENTS.md for the decision.
 */
function classifyLabel(label: string): SchedulePattern | "workday-holiday" {
  if (label.includes("Voľné")) return "freeday";
  if (label.includes("prázdniny")) return "workday-holiday";
  return "workday";
}

/**
 * Parse an imhd.sk per-stop timetable page into departures (epoch seconds,
 * local "today" time-of-day for the matched service pattern) and
 * minute-offsets to every downstream stop (using the conservative `timemax`
 * value).
 *
 * Pattern matching replaces the earlier today/tomorrow day-offset approach:
 * the three epochs in each `data-depts="e0;e1;e2"` cell are always exactly
 * 86400s apart (verified empirically) — i.e. a tab encodes a *time-of-day*
 * schedule, not specific calendar dates. We always read the middle epoch
 * (index 1); only its time-of-day is used by the planner, so the specific
 * date is irrelevant for within-day window math.
 */
export function parseTimetablePage(html: string, pattern: SchedulePattern): TimetablePage {
  const $ = cheerio.load(html);

  // 1. Find every service-pattern tab's id + label, classify, and pick the
  //    best match for the requested pattern.
  //
  //    Note: the `<a id="SM-{id}-tab">` tab headers live inside a
  //    <script type="text/x-custom-template"> block (client-side JS
  //    template, not real DOM) and are therefore invisible to a static HTML
  //    parser like cheerio. The `<h2 id="headerSM-{id}">` heading right
  //    above each pattern's table carries the same label and IS real DOM —
  //    use that instead.
  const candidates: { id: string; label: string; classified: SchedulePattern | "workday-holiday" }[] = [];
  $("h2[id^='headerSM-']").each((_, el) => {
    const id = $(el).attr("id")!.replace(/^headerSM-/, "");
    const label = $(el).text().trim();
    candidates.push({ id, label, classified: classifyLabel(label) });
  });
  if (candidates.length === 0) {
    throw new Error("Could not find any service-pattern tabs on page");
  }

  let match: { id: string; label: string } | undefined;
  if (pattern === "freeday") {
    match = candidates.find((c) => c.classified === "freeday");
  } else {
    // Prefer the non-holiday workday variant; fall back to the holiday one
    // if that's all the line offers.
    match =
      candidates.find((c) => c.classified === "workday") ??
      candidates.find((c) => c.classified === "workday-holiday");
  }
  if (!match) {
    throw new Error(
      `No "${pattern}" service pattern found among tabs: ${candidates.map((c) => c.label).join(", ")}`,
    );
  }

  // 2. Collect departures from that pattern's table (middle epoch of each
  //    triple — see function doc comment).
  const departures: number[] = [];
  $(`#tableSM-${match.id} td[data-depts]`).each((_, el) => {
    const raw = $(el).attr("data-depts");
    if (!raw) return;
    const parts = raw.split(";").map(Number);
    const epoch = parts[1];
    if (Number.isFinite(epoch)) departures.push(epoch);
  });
  departures.sort((a, b) => a - b);

  // 3. Collect downstream stop offsets (minutes, max/conservative) from the
  //    "Zastávky" stopsList table. Rows before/at the boarding stop have no
  //    timemax value and are skipped. This table is pattern-independent
  //    (same for all service patterns), so it's fine to read once here.
  const stopOffsets = new Map<string, number>();
  $("table.stopsList tbody tr").each((_, el) => {
    const row = $(el);
    const timemax = row.find("td.stopTime span.timemax").first().text().trim();
    if (!timemax) return; // upstream of / equal to the boarding stop
    const minutes = Number(timemax);
    if (!Number.isFinite(minutes)) return;

    const nameEl = row.find("td.stopName").first().clone();
    nameEl.find("span").remove(); // strip the zone/terminus badge
    const name = nameEl.text().trim();
    if (!name) return;

    stopOffsets.set(name, minutes);
  });

  return { departures, stopOffsets };
}

export async function fetchTimetable(
  url: string,
  pattern: SchedulePattern,
  timezone: string,
): Promise<TimetablePage> {
  const html = await fetchCached(url, timezone);
  return parseTimetablePage(html, pattern);
}
