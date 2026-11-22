import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchTimetable, type SchedulePattern } from "./scraper.js";
import type { RouteConfig } from "./types.js";

/** Compare parsed schedule content, not volatile HTML or calendar dates. */
export async function scheduleChanges(config: RouteConfig, pattern: SchedulePattern, fetchPage = fetchTimetable, directory = path.resolve(".schedule-history")): Promise<{ compared: boolean; lines: string[]; newLines: string[]; removedPages: number }> {
  const file = path.join(directory, `${pattern}.json`);
  let previous: Record<string, string> = {};
  try {
    const stored: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!stored || typeof stored !== "object" || Array.isArray(stored) || Object.values(stored).some(value => typeof value !== "string")) {
      throw new Error(`Invalid schedule history: ${file}`);
    }
    previous = stored as Record<string, string>;
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  const current: Record<string, string> = {};
  const changed = new Set<string>();
  const newLines = new Set<string>();
  let compared = false;
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  for (const line of config.lines) {
    for (const url of Object.values(line.stops)) {
      const key = createHash("sha256").update(JSON.stringify([line.line, line.direction, url])).digest("hex");
      const page = await fetchPage(url, pattern, config.timezone);
      if (!page.departures.length) throw new Error(`Cannot compare line ${line.line}: no ${pattern} departures parsed`);
      const normalized = JSON.stringify({ departures: page.departures.map(t => clock.format(new Date(t * 1000))).sort(), offsets: [...page.stopOffsets].sort(([a], [b]) => a.localeCompare(b)) });
      const hash = createHash("sha256").update(normalized).digest("hex");
      current[key] = hash;
      if (typeof previous[key] === "string") {
        compared = true;
        if (previous[key] !== hash) changed.add(line.line);
      } else {
        newLines.add(line.line);
      }
    }
  }
  await mkdir(directory, { recursive: true });
  const temp = path.join(directory, `${pattern}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(current), "utf8");
  await rename(temp, file);
  const sort = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  return { compared, lines: [...changed].sort(sort), newLines: [...newLines].sort(sort), removedPages: Object.keys(previous).filter(key => !(key in current)).length };
}
