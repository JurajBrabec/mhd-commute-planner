import { loadConfig } from "./config.js";
import { planDirection, computeLineStopOrders } from "./planner.js";
import { buildJsonOutput, directionToJson } from "./format.js";
import type { SchedulePattern } from "./scraper.js";
import type { Itinerary } from "./types.js";
import { todayWindow } from "./time.js";

function fmtTime(epoch: number, timezone: string): string {
  return new Date(epoch * 1000).toLocaleTimeString("sk-SK", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  });
}

function describeSteps(it: Itinerary, timezone: string): string {
  return it.steps
    .map((s) =>
      s.kind === "walk"
        ? `walk ${s.minutes}m (${s.label})`
        : `${s.line}→${s.alightStop} (${fmtTime(s.departEpoch, timezone)}-${fmtTime(s.arriveEpoch, timezone)})`,
    )
    .join("  ");
}

function parsePatternFlag(args: string[]): SchedulePattern {
  const flag = args.find((a) => a.startsWith("--pattern="));
  if (!flag) return "workday";
  const value = flag.slice("--pattern=".length);
  if (value === "workday" || value === "freeday") return value;
  throw new Error(`--pattern must be "workday" or "freeday", got "${value}"`);
}

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const pattern = parsePatternFlag(args);
  const configPath = args.find((a) => !a.startsWith("--")) ?? "config/routes.yaml";

  const config = await loadConfig(configPath);
  const now = new Date();
  const workWindow = todayWindow(config.timezone, config.directions.toWork.departureWindow, now);
  const homeWindow = todayWindow(config.timezone, config.directions.toHome.departureWindow, now);

  const toWorkItineraries = await planDirection(config, config.directions.toWork, pattern, workWindow.dayStart, undefined, workWindow);
  const toHomeItineraries = await planDirection(config, config.directions.toHome, pattern, homeWindow.dayStart, undefined, homeWindow);

  if (jsonMode) {
    const lineStopOrders = await computeLineStopOrders(config, pattern);
    const output = buildJsonOutput(
      config.timezone,
      pattern,
      config.stops,
      lineStopOrders,
      directionToJson(config.directions.toWork, toWorkItineraries, config.timezone),
      directionToJson(config.directions.toHome, toHomeItineraries, config.timezone),
    );
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  for (const [label, direction, itineraries] of [
    ["to_work", config.directions.toWork, toWorkItineraries],
    ["to_home", config.directions.toHome, toHomeItineraries],
  ] as const) {
    console.log(`\n=== ${label} (${direction.departureWindow}, ${pattern}) ===`);
    if (itineraries.length === 0) {
      console.log("  (no departures in window)");
      continue;
    }
    for (const it of itineraries) {
      console.log(
        `  ${fmtTime(it.departEpoch, config.timezone)} -> ${fmtTime(it.arriveEpoch, config.timezone)}` +
          `  (${it.totalMinutes}min, ${it.transfers} transfer${it.transfers === 1 ? "" : "s"})` +
          `   ${describeSteps(it, config.timezone)}`,
      );
      for (const alt of it.alternatives) {
        const extra = alt.totalMinutes - it.totalMinutes;
        console.log(
          `      alt: ${fmtTime(alt.arriveEpoch, config.timezone)} (+${extra}min)` +
            `   ${describeSteps(alt, config.timezone)}`,
        );
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
