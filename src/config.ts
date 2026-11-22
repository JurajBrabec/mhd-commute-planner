import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { RouteConfig } from "./types.js";

export async function loadConfig(path: string): Promise<RouteConfig> {
  const raw = await readFile(path, "utf8");
  const data = parse(raw) as RouteConfig;

  if (!data || typeof data !== "object") throw new Error("Config must be a mapping");
  if (typeof data.timezone !== "string" || !data.timezone) throw new Error("Config needs a timezone");
  try { new Intl.DateTimeFormat("en", { timeZone: data.timezone }); }
  catch { throw new Error(`Invalid timezone: ${data.timezone}`); }
  if (!Array.isArray(data.stops) || !data.stops.length || data.stops.some(s => typeof s !== "string" || !s.trim())) throw new Error("Config needs a non-empty `stops` list of names");
  if (!Array.isArray(data.lines)) throw new Error("Config needs a `lines` list");
  if (data.walkTransfers !== undefined && !Array.isArray(data.walkTransfers)) throw new Error("walkTransfers must be a list");
  const stopSet = new Set(data.stops);

  for (const line of data.lines) {
    if (!line || typeof line.line !== "string" || !line.line.trim() || typeof line.direction !== "string" || !line.direction.trim() || !line.stops || typeof line.stops !== "object" || Array.isArray(line.stops)) throw new Error("Each line needs a line, direction and stops mapping");
    for (const [stopName, url] of Object.entries(line.stops)) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || parsed.hostname !== "imhd.sk" || parsed.username || parsed.password) throw new Error();
      } catch { throw new Error(`Invalid timetable URL for ${stopName}: expected an https://imhd.sk URL`); }
      if (!stopSet.has(stopName)) {
        throw new Error(
          `Line ${line.line} (${line.direction}) references unknown stop "${stopName}" — add it to \`stops\``,
        );
      }
    }
  }

  for (const wt of data.walkTransfers ?? []) {
    if (!wt || !Number.isFinite(wt.minutes) || wt.minutes < 0 || (wt.bidirectional !== undefined && typeof wt.bidirectional !== "boolean")) throw new Error("walkTransfers needs non-negative minutes and an optional boolean bidirectional");
    if (!stopSet.has(wt.from)) throw new Error(`walkTransfers references unknown stop "${wt.from}"`);
    if (!stopSet.has(wt.to)) throw new Error(`walkTransfers references unknown stop "${wt.to}"`);
  }

  for (const key of ["toWork", "toHome"] as const) {
    const dir = data.directions?.[key];
    if (!dir) throw new Error(`Config missing directions.${key}`);
    try { parseWindow(dir.departureWindow); } catch { throw new Error(`Invalid directions.${key}.departureWindow`); }
    for (const endpoint of [dir.origin, dir.destination]) {
      if (!endpoint || typeof endpoint.name !== "string" || !endpoint.name.trim() || !Array.isArray(endpoint.connectsTo) || !endpoint.connectsTo.length) throw new Error(`directions.${key} endpoints need a name and non-empty connectsTo list`);
      if (endpoint.connectsTo.some(c => !c || !Number.isFinite(c.walkMinutes) || c.walkMinutes < 0)) throw new Error(`directions.${key} walkMinutes must be non-negative numbers`);
    }
    for (const c of dir.origin.connectsTo) {
      if (!stopSet.has(c.stop)) {
        throw new Error(`directions.${key}.origin references unknown stop "${c.stop}"`);
      }
    }
    for (const c of dir.destination.connectsTo) {
      if (!stopSet.has(c.stop)) {
        throw new Error(`directions.${key}.destination references unknown stop "${c.stop}"`);
      }
    }
  }

  data.walkTransfers ??= [];
  return data;
}

export function parseWindow(window: string): { startMin: number; endMin: number } {
  if (typeof window !== "string" || !/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(window)) throw new Error("Window must be HH:MM-HH:MM");
  const [start, end] = window.split("-");
  const startMin = toMinutes(start), endMin = toMinutes(end);
  if (startMin > endMin) throw new Error("Overnight windows are not supported");
  return { startMin, endMin };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.trim().split(":").map(Number);
  return h * 60 + m;
}
