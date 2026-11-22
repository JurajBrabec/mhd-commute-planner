import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, parseWindow } from "../config.js";

const VALID_YAML = `
timezone: Europe/Bratislava
stops:
  - StopA
  - StopB
lines:
  - line: "1"
    direction: "Somewhere"
    stops:
      StopA: "https://imhd.sk/a"
      StopB: "https://imhd.sk/b"
walkTransfers:
  - from: StopA
    to: StopA
    minutes: 2
directions:
  toWork:
    departureWindow: "07:00-08:00"
    origin:
      name: Home
      connectsTo:
        - { stop: StopA, walkMinutes: 2 }
    destination:
      name: Work
      connectsTo:
        - { stop: StopB, walkMinutes: 2 }
  toHome:
    departureWindow: "16:00-17:00"
    origin:
      name: Work
      connectsTo:
        - { stop: StopB, walkMinutes: 2 }
    destination:
      name: Home
      connectsTo:
        - { stop: StopA, walkMinutes: 2 }
`;

async function withTempConfig(yamlText: string, fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "mhd-config-test-"));
  const file = path.join(dir, "routes.yaml");
  await writeFile(file, yamlText, "utf8");
  try {
    await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadConfig: accepts a minimal valid config", async () => {
  await withTempConfig(VALID_YAML, async (file) => {
    const config = await loadConfig(file);
    assert.equal(config.timezone, "Europe/Bratislava");
    assert.deepEqual(config.stops, ["StopA", "StopB"]);
    assert.equal(config.lines.length, 1);
    assert.equal(config.directions.toWork.departureWindow, "07:00-08:00");
  });
});

test("loadConfig: defaults walkTransfers to [] when omitted", async () => {
  const yamlText = VALID_YAML.replace(/walkTransfers:\n {2}- from: StopA\n {4}to: StopA\n {4}minutes: 2\n/, "");
  await withTempConfig(yamlText, async (file) => {
    const config = await loadConfig(file);
    assert.deepEqual(config.walkTransfers, []);
  });
});

test("loadConfig: rejects a line referencing an unknown stop", async () => {
  const yamlText = VALID_YAML.replace("StopB: ", "StopC: ");
  await withTempConfig(yamlText, async (file) => {
    await assert.rejects(() => loadConfig(file), /unknown stop "StopC"/);
  });
});

test("loadConfig: rejects walkTransfers referencing an unknown stop", async () => {
  const yamlText = VALID_YAML.replace("from: StopA\n    to: StopA", "from: StopA\n    to: StopZZZ");
  await withTempConfig(yamlText, async (file) => {
    await assert.rejects(() => loadConfig(file), /unknown stop "StopZZZ"/);
  });
});

test("loadConfig: rejects a direction.origin.connectsTo referencing an unknown stop", async () => {
  const yamlText = VALID_YAML.replace(
    "- { stop: StopA, walkMinutes: 2 }\n    destination:",
    "- { stop: NoSuchStop, walkMinutes: 2 }\n    destination:",
  );
  await withTempConfig(yamlText, async (file) => {
    await assert.rejects(() => loadConfig(file), /toWork\.origin references unknown stop "NoSuchStop"/);
  });
});

test("loadConfig: rejects a config missing the toHome direction", async () => {
  const yamlText = VALID_YAML.slice(0, VALID_YAML.indexOf("  toHome:"));
  await withTempConfig(yamlText, async (file) => {
    await assert.rejects(() => loadConfig(file), /missing directions\.toHome/);
  });
});

test("loadConfig: rejects a config with an empty stops list", async () => {
  const yamlText = VALID_YAML.replace("stops:\n  - StopA\n  - StopB\n", "stops: []\n");
  await withTempConfig(yamlText, async (file) => {
    await assert.rejects(() => loadConfig(file), /non-empty `stops` list/);
  });
});

test("loadConfig: rejects invalid values before planning", async () => {
  for (const [yaml, error] of [
    [VALID_YAML.replace("Europe/Bratislava", "Not/AZone"), /Invalid timezone/],
    [VALID_YAML.replace("https://imhd.sk/a", "http://example.com/a"), /Invalid timetable URL/],
    [VALID_YAML.replace('"07:00-08:00"', '"25:00-08:00"'), /departureWindow/],
    [VALID_YAML.replace('walkMinutes: 2', 'walkMinutes: -1'), /walkMinutes/],
    [VALID_YAML.replace('    minutes: 2', '    minutes: -3'), /walkTransfers/],
  ] as const) {
    await withTempConfig(yaml, async file => assert.rejects(() => loadConfig(file), error));
  }
});

test("parseWindow: rejects malformed and overnight windows", () => {
  for (const value of ["7:00-08:00", "07:60-08:00", "23:00-01:00", "07:00-08:00-extra"]) {
    assert.throws(() => parseWindow(value));
  }
});

test("parseWindow: parses HH:MM-HH:MM into start/end minutes", () => {
  assert.deepEqual(parseWindow("07:00-08:30"), { startMin: 420, endMin: 510 });
  assert.deepEqual(parseWindow("16:05-17:00"), { startMin: 965, endMin: 1020 });
});
