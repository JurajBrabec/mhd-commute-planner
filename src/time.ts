import { parseWindow } from "./config.js";

/** Resolve local wall-clock time to an instant, rejecting skipped DST times. */
export function localTimeEpoch(date: string, minutes: number, timezone: string, boundary: "start" | "end" = "start"): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Invalid local date: ${date}`);
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Math.floor(minutes / 60), minutes % 60);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const offsets = new Set<number>();
  // Sample both sides of transitions; offsets are not necessarily whole hours.
  for (let delta = -48; delta <= 48; delta += 6) {
    const instant = target + delta * 3600000;
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(p => [p.type, p.value]));
    offsets.add(Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) - instant);
  }
  const candidates = [...offsets].map(offset => target - offset).filter(instant => {
    const p = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
    return `${p.year}-${p.month}-${p.day}` === date && +p.hour * 60 + +p.minute === minutes;
  }).sort((a, b) => a - b);
  if (!candidates.length) throw new Error(`Local time ${date} ${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")} does not exist in ${timezone}`);
  return (boundary === "start" ? candidates[0] : candidates[candidates.length - 1]) / 1000;
}

export function todayWindow(timezone: string, window: string, now = new Date()): { dayStart: number; windowStart: number; windowEnd: number } {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const { startMin, endMin } = parseWindow(window);
  return { dayStart: localTimeEpoch(date, 0, timezone), windowStart: localTimeEpoch(date, startMin, timezone), windowEnd: localTimeEpoch(date, endMin, timezone, "end") };
}
