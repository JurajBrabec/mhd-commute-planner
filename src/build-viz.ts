// Generates a single static HTML file containing 4 candidate visualizations
// (table, timeline, scatter, Marey per-itinerary drill-down), fed by the
// same JSON contract produced by `cli.ts --json`. No build tooling, no
// framework — plain embedded JSON + vanilla JS rendering to SVG/HTML, so the
// output is a double-clickable file with no local server required.

import { loadConfig } from "./config.js";
import { planDirection, computeLineStopOrders } from "./planner.js";
import { buildJsonOutput, directionToJson, type JsonOutput } from "./format.js";
import type { SchedulePattern } from "./scraper.js";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { clearTimetableCache } from "./cache.js";
import { scheduleChanges } from "./schedule-changes.js";
import { pathToFileURL } from "node:url";
import { todayWindow } from "./time.js";

function parsePatternFlag(args: string[]): SchedulePattern {
  const flag = args.find((a) => a.startsWith("--pattern="));
  if (!flag) return "workday";
  const value = flag.slice("--pattern=".length);
  if (value === "workday" || value === "freeday") return value;
  throw new Error(`--pattern must be "workday" or "freeday", got "${value}"`);
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const pattern = parsePatternFlag(args);
  const configPath = positional[0] ?? "config/routes.yaml";
  const outPath = positional[1] ?? "viz/mockups.html";

  const config = await loadConfig(configPath);
  if (args.includes("--serve")) {
    const server = createVizServer(config.timezone, pattern, p => buildData(config, p), clearTimetableCache);
    const portValue = process.env.PORT ?? "3000";
    if (!/^\d+$/.test(portValue) || Number(portValue) > 65535) throw new Error("PORT must be an integer between 0 and 65535");
    const host = process.env.HOST ?? "127.0.0.1";
    if (!host.trim()) throw new Error("HOST must not be empty");
    server.listen(Number(portValue), host, () => {
      const address = server.address();
      if (address && typeof address !== "string") {
        const displayHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
        console.log(`Listening at http://${displayHost}:${address.port}`);
      }
    });
    return;
  }
  const data = await buildData(config, pattern);
  const html = renderPage(data);
  await writeFile(outPath, html, "utf8");
  console.log(`Wrote ${outPath}`);
}

export function createVizServer(
  timezone: string,
  pattern: SchedulePattern,
  generate: (pattern: SchedulePattern) => Promise<JsonOutput>,
  clearCache: () => Promise<void>,
) {
    const cache = new Map<string, Promise<JsonOutput>>();
    // Serialize cache operations so a refresh cannot race an in-flight build
    // that would otherwise repopulate the disk cache with stale pages.
    let queue: Promise<void> = Promise.resolve();
    function serialized<T>(operation: () => Promise<T>): Promise<T> {
      const result = queue.then(operation);
      queue = result.then(() => undefined, () => undefined);
      return result;
    }
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/api/refresh") {
          if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end(); return; }
          // A JSON content type forces cross-origin browsers to preflight; no
          // CORS permission is granted. Reject non-browser/simple requests too.
          if (req.headers["content-type"] !== "application/json") { res.writeHead(415); res.end(); return; }
          await serialized(async () => {
            cache.clear();
            await clearCache();
          });
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method !== "GET") { res.writeHead(405, { Allow: "GET" }); res.end(); return; }
        const selected = url.searchParams.get("pattern") ?? pattern;
        if (selected !== "workday" && selected !== "freeday") { res.writeHead(400); res.end("Invalid pattern"); return; }
        res.setHeader("Cache-Control", "no-store");
        if (url.pathname === "/") {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(renderPage(undefined, selected));
        } else if (url.pathname === "/api/data") {
          const data = await serialized(async () => {
            const date = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
            const key = `${date}:${selected}`;
            if (!cache.has(key)) {
              for (const cachedKey of cache.keys()) if (!cachedKey.startsWith(date + ":")) cache.delete(cachedKey);
              const pending = generate(selected);
              cache.set(key, pending);
              pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
            }
            return cache.get(key)!;
          });
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(data));
        } else { res.writeHead(404); res.end("Not found"); }
      } catch (err) {
        console.error(err);
        if (!res.headersSent) res.writeHead(500);
        res.end("Failed to generate timetable");
      }
    });
    return server;
}

async function buildData(config: Awaited<ReturnType<typeof loadConfig>>, pattern: SchedulePattern): Promise<JsonOutput> {
  const now = new Date();
  const workWindow = todayWindow(config.timezone, config.directions.toWork.departureWindow, now);
  const homeWindow = todayWindow(config.timezone, config.directions.toHome.departureWindow, now);

  const toWorkItineraries = await planDirection(config, config.directions.toWork, pattern, workWindow.dayStart, undefined, workWindow);
  const toHomeItineraries = await planDirection(config, config.directions.toHome, pattern, homeWindow.dayStart, undefined, homeWindow);

  const lineStopOrders = await computeLineStopOrders(config, pattern);
  const data = buildJsonOutput(
    config.timezone,
    pattern,
    config.stops,
    lineStopOrders,
    directionToJson(config.directions.toWork, toWorkItineraries, config.timezone),
    directionToJson(config.directions.toHome, toHomeItineraries, config.timezone),
  );

  data.scheduleChanges = await scheduleChanges(config, pattern);
  return data;
}

export function renderPage(data?: JsonOutput, pattern: SchedulePattern = "workday"): string {
  const selected = data?.pattern ?? pattern;
  const patternLabel = selected === "workday" ? "Workday (Pracovné dni)" : "Free day (Voľné dni)";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>MHD Commute Planner</title>
<style>${CSS}</style>
</head>
<body>
<h1>MHD Commute Planner</h1>
<p class="note">Planned for <strong>${patternLabel}</strong> schedule pattern.</p>
${data ? "" : '<nav><a href="/?pattern=workday">Workday</a> · <a href="/?pattern=freeday">Free day</a> · <button type="button" id="refresh-cache">Refresh schedule</button> <span id="refresh-status" role="status"></span></nav>'}
<p class="note" id="schedule-age" aria-label="Schedule generation time"></p>
<p class="note" id="schedule-changes" role="status"></p>
<div id="app"></div>
<script id="data" type="application/json">${data ? JSON.stringify(data).replace(/</g, "\\u003c") : "null"}</script>
<script>${JS}</script>
</body>
</html>`;
}

const CSS = `
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
  .direction-tabs { display: flex; gap: .5rem; margin-top: 1rem; border-bottom: 2px solid #ddd; }
  .direction-tab-btn {
    font-size: 1rem; font-weight: 600; padding: .6rem 1.2rem; border: none;
    background: #f0f0f0; color: #555; cursor: pointer; border-radius: 6px 6px 0 0;
    margin-bottom: -2px;
  }
  .direction-tab-btn.active { background: #fff; color: #1a1a1a; border: 2px solid #ddd; border-bottom: 2px solid #fff; }
  .direction-tab-btn:hover:not(.active) { background: #e4e4e4; }
  .direction-panel.hidden { display: none; }
  .controls-section {
    border: 1px solid #ddd; border-radius: 6px; margin: 1rem 0; background: #fafafa;
  }
  .controls-section summary {
    cursor: pointer; padding: .6rem .9rem; font-weight: 600; font-size: .9rem; color: #444;
    list-style: none;
  }
  .controls-section summary::-webkit-details-marker { display: none; }
  .controls-section summary::before { content: '\u25B6 '; display: inline-block; transition: transform .15s; }
  .controls-section[open] summary::before { transform: rotate(90deg); }
  .controls-body { padding: 0 .9rem .9rem .9rem; border-top: 1px solid #e5e5e5; }
  .view-tabs { display: flex; gap: .3rem; margin: 1rem 0 0 0; border-bottom: 1px solid #ddd; }
  .view-tab-btn {
    font-size: .85rem; font-weight: 600; padding: .4rem .9rem; border: none;
    background: #f5f5f5; color: #666; cursor: pointer; border-radius: 4px 4px 0 0;
    margin-bottom: -1px;
  }
  .view-tab-btn.active { background: #fff; color: #1a1a1a; border: 1px solid #ddd; border-bottom: 1px solid #fff; }
  .view-tab-btn:hover:not(.active) { background: #ececec; }
  .view-panel { padding-top: 1rem; }
  .view-panel.hidden { display: none; }
  .controls-table { width: 100%; border-collapse: collapse; margin-top: .5rem; }
  .controls-table td { border: none; padding: .5rem .6rem; vertical-align: middle; }
  .controls-table tr + tr td { border-top: 1px solid #eee; }
  .controls-table .label-cell { font-size: .85rem; color: #555; font-weight: 600; white-space: nowrap; width: 1%; }
  .controls-table .controls-cell { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; }
  .controls-table .reset-cell { width: 1%; white-space: nowrap; text-align: right; }
  .line-filter-chip {
    font-size: .85rem; font-weight: 700; padding: .2rem .6rem; border-radius: 12px;
    border: 2px solid #ccc; background: #fff; cursor: pointer;
  }
  .line-filter-chip.required::after { content: ' \\2713 '; }
  .line-filter-chip.excluded { text-decoration: line-through; opacity: .5; border-style: dashed; }
  .control-reset { font-size: .8rem; padding: .2rem .6rem; border-radius: 12px; border: 1px solid #ccc; background: #f5f5f5; cursor: pointer; }
  .line-filter-status { font-size: .85rem; color: #444; margin-top: .7rem; padding-top: .5rem; border-top: 1px solid #e5e5e5; }
  .time-slider { width: 180px; vertical-align: middle; }
  .time-window-label { font-size: .85rem; font-weight: 600; color: #333; min-width: 110px; }
  @media (max-width: 640px) {
    .controls-table, .controls-table tbody, .controls-table tr, .controls-table td { display: block; width: 100%; }
    .controls-table .label-cell { width: auto; padding-bottom: 0; }
    .controls-table .reset-cell { text-align: left; padding-top: 0; }
    .time-slider { width: 100%; max-width: 280px; }
  }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.15rem; margin-top: 2.5rem; border-bottom: 2px solid #ddd; padding-bottom: .3rem; }
  h3 { font-size: 1rem; color: #555; margin-top: 1.5rem; }
  .note { color: #666; font-size: .9rem; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { border: 1px solid #ddd; padding: .35rem .6rem; text-align: left; }
  th { background: #f5f5f5; }
  tr:nth-child(even) { background: #fafafa; }
  tr.alt-row { color: #888; font-style: italic; background: #fff9ec; }
  tr.alt-row td { border-top: none; }
  tr.selected-row td { background: #d6e8ff !important; font-weight: 700; }
  .chip { display: inline-block; padding: 0 .4rem; border-radius: 3px; color: white; font-weight: 600; font-size: .8rem; margin-right: 2px; }
  .walk-chip { background: #bbb; padding: 0 .3rem; }
  .duration-cell { white-space: nowrap; }
  .duration-badge { display: inline-block; padding: 1px .4rem; border-radius: 10px; color: white; font-weight: 700; font-size: .72rem; vertical-align: middle; }
  .route-cell { font-size: .8rem; }
  .arrow { color: #999; margin: 0 2px; }
  svg { background: #fff; border: 1px solid #eee; }
  .axis-label { font-size: 10px; fill: #666; }
  .legend { font-size: .8rem; margin: .5rem 0; }
  .legend .chip { margin-right: 6px; }
  select { font-size: .9rem; padding: .2rem; margin-bottom: .5rem; }
  .caption { font-size: .8rem; color: #666; margin-top: .3rem; }
  .playback-bar { display: flex; align-items: center; gap: .6rem; margin: .6rem 0 1rem 0; padding: .5rem .7rem; background: #f5f5f5; border-radius: 6px; }
  .playback-play { font-size: 1rem; width: 2rem; height: 2rem; border-radius: 50%; border: 1px solid #ccc; background: #fff; cursor: pointer; }
  .playback-play:hover { background: #eee; }
  .playback-scrubber { flex: 1; min-width: 120px; }
  .playback-time { font-size: .85rem; font-weight: 700; min-width: 50px; text-align: center; }
  .playback-speed { font-size: .8rem; padding: .15rem; }
  .playhead-line { stroke: #e6194b; stroke-width: 1.5; pointer-events: none; }
  .playhead-dot { fill: #e6194b; stroke: white; stroke-width: 1.5; pointer-events: none; }
  .rich-tooltip {
    position: fixed; z-index: 1000; background: #1a1a1a; color: #f0f0f0;
    border-radius: 6px; padding: .5rem .7rem; font-size: .8rem; line-height: 1.5;
    box-shadow: 0 4px 12px rgba(0,0,0,.3); pointer-events: none; max-width: 360px;
  }
  .rich-tooltip.hidden { display: none; }
  .tooltip-header { font-weight: 700; margin-bottom: .3rem; border-bottom: 1px solid #444; padding-bottom: .25rem; }
  .tooltip-note { color: #ffca7a; font-style: italic; margin-bottom: .25rem; }
  .tooltip-step { display: flex; align-items: center; gap: .3rem; white-space: nowrap; opacity: .65; }
  .tooltip-step.current { opacity: 1; font-weight: 700; }
  .tooltip-step-time { margin-left: auto; color: #bbb; font-weight: 400; font-size: .75rem; }
  .tooltip-step.current .tooltip-step-time { color: #fff; }
`;

const JS = `
(async function () {
const refreshButton = document.getElementById('refresh-cache');
if (refreshButton) refreshButton.addEventListener('click', async () => {
  const status = document.getElementById('refresh-status');
  refreshButton.disabled = true;
  status.textContent = 'Refreshing schedule…';
  try {
    const response = await fetch('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    location.reload();
  } catch (err) {
    status.textContent = 'Refresh failed. Please try again.';
    refreshButton.disabled = false;
    console.error(err);
  }
});
const embedded = JSON.parse(document.getElementById('data').textContent);
const response = embedded ? null : await fetch('/api/data' + location.search);
if (response && !response.ok) throw new Error('Failed to load timetable: HTTP ' + response.status);
const DATA = embedded || await response.json();
const changes = DATA.scheduleChanges;
const changesLabel = document.getElementById('schedule-changes');
if (changes && changes.compared) {
  const parts = [changes.lines.length ? 'Schedule changes detected on lines: ' + changes.lines.join(', ') + '.' : 'No schedule changes detected on previously checked pages.'];
  if (changes.newLines && changes.newLines.length) parts.push('No previous snapshot for some pages on lines: ' + changes.newLines.join(', ') + '.');
  if (changes.removedPages) parts.push(changes.removedPages + ' previously checked page(s) no longer configured.');
  changesLabel.textContent = parts.join(' ');
} else {
  changesLabel.textContent = 'Schedule changes: no previous snapshot to compare.';
}
const generated = new Date(DATA.generatedAt);
const ageLabel = document.getElementById('schedule-age');
if (Number.isFinite(generated.getTime())) {
  const timestamp = new Intl.DateTimeFormat('en-GB', {
    timeZone: DATA.timezone, dateStyle: 'medium', timeStyle: 'short'
  }).format(generated);
  function updateScheduleAge() {
    const minutes = Math.max(0, Math.floor((Date.now() - generated.getTime()) / 60000));
    const age = minutes < 1 ? 'less than a minute ago' : minutes < 60 ? minutes + ' min ago' :
      minutes < 1440 ? Math.floor(minutes / 60) + ' hr ago' : Math.floor(minutes / 1440) + ' days ago';
    ageLabel.textContent = 'Schedule generated: ' + timestamp + ' (' + DATA.timezone + '; ' + age + '). Timetable pages may be older.';
  }
  updateScheduleAge();
  setInterval(updateScheduleAge, 60000);
} else {
  ageLabel.textContent = 'Schedule generation time unavailable.';
}

const LINE_COLORS = {
  "4": "#e6194b", "9": "#3cb44b", "32": "#4363d8", "33": "#f58231",
  "39": "#911eb4", "50": "#42b0b0", "63": "#f032e6"
};
function colorFor(line) { return LINE_COLORS[line] || "#777"; }
function walkColor() { return "#bbb"; }
const WALK_EMOJI = String.fromCodePoint(0x1F6B6); // 🚶

function el(tag, attrs, children) {
  const e = document.createElementNS(tag === 'svg' || tag === 'g' || tag === 'rect' || tag === 'line' || tag === 'circle' || tag === 'text' || tag === 'title'
    ? 'http://www.w3.org/2000/svg' : null, tag);
  for (const k in (attrs || {})) e.setAttribute(k, attrs[k]);
  for (const c of (children || [])) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
}
function h(tag, attrs, children) {
  const e = document.createElement(tag);
  for (const k in (attrs || {})) {
    if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]);
  }
  for (const c of (children || [])) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
}

// ---------- shared rich tooltip (replaces plain SVG <title> tooltips) ----------

const tooltipEl = h('div', { class: 'rich-tooltip hidden' });
document.body.appendChild(tooltipEl);

function showTooltip(contentNodes, clientX, clientY) {
  tooltipEl.innerHTML = '';
  for (const n of contentNodes) tooltipEl.appendChild(n);
  tooltipEl.classList.remove('hidden');
  positionTooltip(clientX, clientY);
}
function positionTooltip(clientX, clientY) {
  const margin = 14;
  const rect = tooltipEl.getBoundingClientRect();
  let left = clientX + margin;
  let top = clientY + margin;
  if (left + rect.width > window.innerWidth) left = clientX - rect.width - margin;
  if (top + rect.height > window.innerHeight) top = clientY - rect.height - margin;
  tooltipEl.style.left = Math.max(4, left) + 'px';
  tooltipEl.style.top = Math.max(4, top) + 'px';
}
function hideTooltip() {
  tooltipEl.classList.add('hidden');
}

/** Builds the tooltip content for a single step (line or walk), with the current step bold/highlighted. */
function stepTooltipLine(s, isCurrent) {
  const row = h('div', { class: 'tooltip-step' + (isCurrent ? ' current' : '') });
  if (s.kind === 'line') {
    row.appendChild(h('span', { class: 'chip', style: 'background:' + colorFor(s.line) }, [s.line]));
    row.appendChild(document.createTextNode(' ' + s.boardStop + ' \u2192 ' + s.alightStop + ' '));
  } else {
    row.appendChild(h('span', { class: 'chip walk-chip' }, [WALK_EMOJI]));
    row.appendChild(document.createTextNode(' ' + s.label + ' '));
  }
  row.appendChild(h('span', { class: 'tooltip-step-time' }, [s.departTime + '\u2013' + s.arriveTime + ' (' + s.minutes + 'min)']));
  return row;
}

/**
 * Builds the full tooltip content for an itinerary: header line
 * (depart/arrive/duration/transfers) + every step, with "highlightStep"
 * (if given, by reference) shown bold so the hovered segment stands out
 * among the full journey.
 */
function itineraryTooltipContent(it, highlightStep, extraNote) {
  const nodes = [];
  const header = h('div', { class: 'tooltip-header' }, [
    it.departTime + ' \u2192 ' + it.arriveTime + '  (' + it.durationMinutes + 'min, ' +
    it.transfers + ' transfer' + (it.transfers === 1 ? '' : 's') + ')'
  ]);
  nodes.push(header);
  if (extraNote) nodes.push(h('div', { class: 'tooltip-note' }, [extraNote]));
  for (const s of it.steps) {
    nodes.push(stepTooltipLine(s, s === highlightStep));
  }
  return nodes;
}

function attachTooltip(element, contentFn) {
  element.addEventListener('mouseenter', (e) => {
    showTooltip(contentFn(), e.clientX, e.clientY);
  });
  element.addEventListener('mousemove', (e) => {
    positionTooltip(e.clientX, e.clientY);
  });
  element.addEventListener('mouseleave', hideTooltip);
}

// ---------- shared playback controller ----------
//
// Drives an animated "virtual clock" over [minEpoch, maxEpoch] for a chart:
// play/pause, speed multiplier, and a manual scrubber. onTick(epoch) is
// called on every animation frame while playing, and once immediately on
// any scrubber drag/speed change/play/pause toggle, so a chart only needs
// to implement "redraw for this one virtual time" and doesn't need to know
// about timers itself.

const PLAYBACK_SPEEDS = [1, 2, 5, 15, 60];

function createPlaybackController(minEpoch, maxEpoch, onTick) {
  const bar = h('div', { class: 'playback-bar' });
  const playBtn = h('button', { type: 'button', class: 'playback-play' }, ['\u25B6']);
  const scrubber = h('input', {
    type: 'range', min: String(minEpoch), max: String(maxEpoch), value: String(minEpoch), class: 'playback-scrubber',
  });
  const timeLabel = h('span', { class: 'playback-time' }, [fmtClock(minEpoch)]);
  const speedSelect = h('select', { class: 'playback-speed' });
  for (const sp of PLAYBACK_SPEEDS) {
    speedSelect.appendChild(h('option', { value: String(sp) }, [sp + '\u00d7']));
  }
  speedSelect.value = '15';

  bar.appendChild(playBtn);
  bar.appendChild(scrubber);
  bar.appendChild(timeLabel);
  bar.appendChild(speedSelect);

  let playing = false;
  let current = minEpoch;
  let rafId = null;
  let lastFrameMs = null;

  function setCurrent(epoch) {
    current = Math.max(minEpoch, Math.min(maxEpoch, epoch));
    scrubber.value = String(current);
    timeLabel.textContent = fmtClock(current);
    onTick(current);
  }

  function frame(nowMs) {
    if (!playing) return;
    if (lastFrameMs === null) lastFrameMs = nowMs;
    const dtSeconds = (nowMs - lastFrameMs) / 1000;
    lastFrameMs = nowMs;
    const speed = Number(speedSelect.value);
    const next = current + dtSeconds * speed * 60; // speed is in "minutes of virtual time per real second"
    if (next >= maxEpoch) {
      setCurrent(maxEpoch);
      pause();
      return;
    }
    setCurrent(next);
    rafId = requestAnimationFrame(frame);
  }

  function play() {
    if (playing) return;
    if (current >= maxEpoch) setCurrent(minEpoch);
    playing = true;
    playBtn.textContent = '\u23F8';
    lastFrameMs = null;
    rafId = requestAnimationFrame(frame);
  }
  function pause() {
    playing = false;
    playBtn.textContent = '\u25B6';
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  playBtn.addEventListener('click', () => { playing ? pause() : play(); });
  scrubber.addEventListener('input', () => { pause(); setCurrent(Number(scrubber.value)); });

  setCurrent(minEpoch);

  return { bar, pause, destroy: pause };
}

function routeSummary(it) {
  const parts = [];
  for (const s of it.steps) {
    if (s.kind === 'line') {
      const chip = h('span', { class: 'chip', style: 'background:' + colorFor(s.line) }, [s.line]);
      parts.push(chip);
      parts.push(document.createTextNode(' ' + s.alightStop + ' '));
    } else {
      parts.push(h('span', { class: 'chip walk-chip', title: s.label + ' (' + s.minutes + 'min)' }, [WALK_EMOJI]));
    }
  }
  return parts;
}

// ---------- 1. TABLE ----------
function durationColor(deltaMin, maxDelta) {
  if (maxDelta <= 0) return '#2e7d32'; // all equal -> green
  const frac = Math.min(1, deltaMin / maxDelta);
  // green (#2e7d32 ~ hue 123) -> amber -> red (#c62828 ~ hue 3), via HSL interpolation
  const hue = 123 - frac * 120;
  return 'hsl(' + hue.toFixed(0) + ', 65%, 38%)';
}

/**
 * Identify an itinerary by its direction, times and complete step sequence.
 * Different routes can depart and arrive at exactly the same time.
 */
function itineraryKey(directionKey, it) {
  return JSON.stringify([directionKey, it.departEpoch, it.arriveEpoch, it.steps.map(s => [s.kind, s.departEpoch, s.arriveEpoch, s.line, s.direction, s.boardStop, s.alightStop, s.fromStop, s.toStop])]);
}

function renderTable(direction, container, directionKey, selectedKey, onSelect) {
  const table = h('table');
  const thead = h('thead', {}, [h('tr', {}, ['Depart','Arrive','Duration','Transfers','Route'].map(t => h('th', {}, [t])))]);
  table.appendChild(thead);
  const tbody = h('tbody');

  const minDuration = Math.min(...direction.itineraries.map(it => it.durationMinutes));
  const maxDuration = Math.max(...direction.itineraries.map(it => it.durationMinutes));
  const maxDelta = maxDuration - minDuration;

  for (const it of direction.itineraries) {
    const delta = it.durationMinutes - minDuration;
    const color = durationColor(delta, maxDelta);
    const badge = h('span', {
      class: 'duration-badge',
      style: 'background:' + color,
      title: delta === 0 ? 'Fastest option in this window' : delta + ' min slower than the fastest option in this window',
    }, [delta === 0 ? 'fastest' : '+' + delta]);
    const isSelected = itineraryKey(directionKey, it) === selectedKey;
    const tr = h('tr', { class: isSelected ? 'selected-row' : '', style: 'cursor: pointer;' }, [
      h('td', {}, [it.departTime]),
      h('td', {}, [it.arriveTime]),
      h('td', { class: 'duration-cell' }, [it.durationMinutes + 'min ', badge]),
      h('td', {}, [String(it.transfers)]),
      h('td', { class: 'route-cell' }, routeSummary(it)),
    ]);
    tr.addEventListener('click', () => onSelect(it));
    tbody.appendChild(tr);
    for (const alt of it.alternatives) {
      const extra = alt.durationMinutes - it.durationMinutes;
      const altIsSelected = itineraryKey(directionKey, alt) === selectedKey;
      const altTr = h('tr', { class: 'alt-row' + (altIsSelected ? ' selected-row' : ''), style: 'cursor: pointer;' }, [
        h('td', {}, ['']),
        h('td', {}, [alt.arriveTime]),
        h('td', {}, [alt.durationMinutes + 'min (+' + extra + ')']),
        h('td', {}, [String(alt.transfers)]),
        h('td', { class: 'route-cell' }, routeSummary(alt)),
      ]);
      altTr.addEventListener('click', () => onSelect(alt));
      tbody.appendChild(altTr);
    }
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

// ---------- 2. TIMELINE / GANTT ----------
function renderTimeline(direction, container, directionKey, selectedKey, onSelect) {
  if (direction.itineraries.length === 0) { container.appendChild(h('p', {}, ['No itineraries.'])); return; }
  const width = 900, mainRowHeight = 22, altRowHeight = 12, rowGap = 4, padding = 60;

  // Flatten main itineraries + their alternatives into a single row list,
  // alternatives rendered thinner/fainter directly below their main row.
  const rows = [];
  for (const it of direction.itineraries) {
    rows.push({ it, isAlt: false });
    for (const alt of it.alternatives) rows.push({ it: alt, isAlt: true });
  }

  const allTimes = rows.flatMap(r => [r.it.departEpoch, r.it.arriveEpoch]);
  const minT = Math.min(...allTimes);
  const maxT = Math.max(...allTimes);
  const scaleX = t => padding + (t - minT) / (maxT - minT) * (width - padding - 20);

  let y = 4;
  const rowYs = rows.map(r => {
    const rowH = r.isAlt ? altRowHeight : mainRowHeight;
    const thisY = y;
    y += rowH + rowGap;
    return thisY;
  });
  const height = y + 26;

  const svg = el('svg', { width: width, height: height, viewBox: '0 0 ' + width + ' ' + height });

  // time axis ticks every 10 min
  const tickStep = 600; // seconds
  let t0 = Math.ceil(minT / tickStep) * tickStep;
  for (let t = t0; t <= maxT; t += tickStep) {
    const x = scaleX(t);
    svg.appendChild(el('line', { x1: x, x2: x, y1: 0, y2: height - 20, stroke: '#eee' }));
    const d = new Date(t * 1000);
    const label = d.toLocaleTimeString('en-GB', { timeZone: DATA.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    svg.appendChild(el('text', { x: x, y: height - 6, class: 'axis-label', 'text-anchor': 'middle' }, [label]));
  }

  rows.forEach(({ it, isAlt }, i) => {
    const rowH = isAlt ? altRowHeight : mainRowHeight;
    const y = rowYs[i];
    const opacity = isAlt ? 0.55 : 1;
    const isSelected = itineraryKey(directionKey, it) === selectedKey;
    for (const s of it.steps) {
      const x1 = scaleX(s.departEpoch), x2 = scaleX(s.arriveEpoch);
      const color = s.kind === 'line' ? colorFor(s.line) : walkColor();
      const rect = el('rect', {
        x: x1, y: y, width: Math.max(1, x2 - x1), height: rowH, fill: color, rx: 2, opacity: opacity, style: 'cursor: pointer;',
        stroke: isSelected ? '#000' : 'none', 'stroke-width': isSelected ? 2 : 0,
      });
      attachTooltip(rect, () => itineraryTooltipContent(it, s, isAlt ? 'Alternative (+' + (it.durationMinutes) + 'min total)' : null));
      rect.addEventListener('click', () => onSelect(it));
      svg.appendChild(rect);
      if (!isAlt) {
        const label = s.kind === 'line' ? s.line : WALK_EMOJI;
        svg.appendChild(el('text', { x: (x1+x2)/2, y: y + rowH/2 + 4, 'text-anchor': 'middle', fill: s.kind === 'line' ? 'white' : '#333', 'font-size': 10, 'font-weight': 600 }, [label]));
      }
    }
    if (!isAlt) {
      svg.appendChild(el('text', { x: 2, y: y + rowH/2 + 4, class: 'axis-label' }, [it.departTime]));
    }
  });

  // playhead: single vertical sweep line across all rows, driven by the
  // playback controller in the caller (passed back via the returned object
  // so container-level code can mount the playback bar above the chart).
  const playheadLine = el('line', { class: 'playhead-line', x1: 0, x2: 0, y1: 0, y2: height - 20 });
  svg.appendChild(playheadLine);

  container.appendChild(svg);
  return { minT, maxT, onTick: (t) => { const x = scaleX(t); playheadLine.setAttribute('x1', x); playheadLine.setAttribute('x2', x); } };
}

// ---------- 3. SCATTER ----------
function fmtClock(epoch) {
  return new Date(epoch * 1000).toLocaleTimeString('en-GB', { timeZone: DATA.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

function niceStep(range, targetTicks) {
  const rough = range / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}

function renderScatter(direction, container, directionKey, selectedKey, onSelect) {
  if (direction.itineraries.length === 0) { container.appendChild(h('p', {}, ['No itineraries.'])); return; }
  const width = 640, height = 420, padLeft = 70, padBottom = 50, padTop = 20, padRight = 20;
  const plotW = width - padLeft - padRight, plotH = height - padTop - padBottom;

  const departs = direction.itineraries.map(i => i.departEpoch);
  const durations = direction.itineraries.map(i => i.durationMinutes);
  const minX = Math.min(...departs), maxX = Math.max(...departs) === minX ? minX + 60 : Math.max(...departs);
  const minY = Math.max(0, Math.min(...durations) - 3), maxY = Math.max(...durations) + 3;
  const scaleX = t => padLeft + (t - minX) / (maxX - minX) * plotW;
  const scaleY = d => padTop + plotH - (d - minY) / (maxY - minY) * plotH;

  const svg = el('svg', { width: width, height: height, viewBox: '0 0 ' + width + ' ' + height });

  // axes lines
  svg.appendChild(el('line', { x1: padLeft, x2: padLeft, y1: padTop, y2: padTop + plotH, stroke: '#999' }));
  svg.appendChild(el('line', { x1: padLeft, x2: padLeft + plotW, y1: padTop + plotH, y2: padTop + plotH, stroke: '#999' }));

  // y ticks (duration, minutes)
  const yStep = niceStep(maxY - minY, 6);
  for (let v = Math.ceil(minY / yStep) * yStep; v <= maxY; v += yStep) {
    const y = scaleY(v);
    svg.appendChild(el('line', { x1: padLeft - 4, x2: padLeft + plotW, y1: y, y2: y, stroke: '#eee' }));
    svg.appendChild(el('text', { x: padLeft - 8, y: y + 3, 'text-anchor': 'end', class: 'axis-label' }, [String(Math.round(v)) + 'm']));
  }

  // x ticks (clock time, every ~10min, rounded to nice boundary)
  const xStepSeconds = niceStep((maxX - minX) / 60, 8) * 60;
  const t0 = Math.ceil(minX / xStepSeconds) * xStepSeconds;
  for (let t = t0; t <= maxX; t += xStepSeconds) {
    const x = scaleX(t);
    svg.appendChild(el('line', { x1: x, x2: x, y1: padTop, y2: padTop + plotH, stroke: '#f3f3f3' }));
    svg.appendChild(el('text', { x: x, y: padTop + plotH + 16, 'text-anchor': 'middle', class: 'axis-label' }, [fmtClock(t)]));
  }

  // axis titles
  svg.appendChild(el('text', { x: 14, y: 14, class: 'axis-label', 'font-weight': 700 }, ['duration (min)']));
  svg.appendChild(el('text', { x: padLeft + plotW / 2, y: height - 8, 'text-anchor': 'middle', class: 'axis-label', 'font-weight': 700 }, ['departure time']));

  const transferColors = { 0: '#3cb44b', 1: '#4363d8', 2: '#e6194b', 3: '#911eb4' };
  direction.itineraries.forEach(it => {
    const cx = scaleX(it.departEpoch), cy = scaleY(it.durationMinutes);
    const isSelected = itineraryKey(directionKey, it) === selectedKey;
    const c = el('circle', {
      cx: cx, cy: cy, r: isSelected ? 8 : 5, fill: transferColors[it.transfers] || '#777', 'fill-opacity': 0.85, style: 'cursor: pointer;',
      stroke: isSelected ? '#000' : 'none', 'stroke-width': isSelected ? 2 : 0,
    });
    attachTooltip(c, () => itineraryTooltipContent(it, null, null));
    c.addEventListener('click', () => onSelect(it));
    svg.appendChild(c);
  });

  container.appendChild(svg);
  const legend = h('div', { class: 'legend' }, [
    'Transfers: ',
    ...Object.entries(transferColors).map(([k,v]) => h('span', { class: 'chip', style: 'background:' + v }, [k]))
  ]);
  container.appendChild(legend);
}

// ---------- 4. MAREY (per-itinerary drill-down) ----------

/** Resolves a step's (fromName, toName), for line or walk steps alike. */
function stepEndpoints(s) {
  return s.kind === 'line' ? { from: s.boardStop, to: s.alightStop } : { from: s.fromStop, to: s.toStop };
}

function stopSequence(it) {
  const seq = [];
  for (const s of it.steps) {
    const { from, to } = stepEndpoints(s);
    if (seq.length === 0 || seq[seq.length - 1].name !== from) {
      seq.push({ name: from, time: s.departEpoch });
    }
    seq.push({ name: to, time: s.arriveEpoch });
  }
  return seq;
}

/** Linearly interpolates (x, y) position along an itinerary's drawn path at virtual clock time t. */
function positionAtTime(it, seq, scaleX, yFor, t) {
  if (t <= seq[0].time) return { x: scaleX(seq[0].time), y: yFor(0) };
  if (t >= seq[seq.length - 1].time) return { x: scaleX(seq[seq.length - 1].time), y: yFor(seq.length - 1) };
  let stopIdx = 0;
  for (const s of it.steps) {
    const { from: fromName } = stepEndpoints(s);
    while (stopIdx < seq.length - 1 && seq[stopIdx].name !== fromName) stopIdx++;
    if (t >= s.departEpoch && t <= s.arriveEpoch) {
      const frac = s.arriveEpoch === s.departEpoch ? 0 : (t - s.departEpoch) / (s.arriveEpoch - s.departEpoch);
      const x1 = scaleX(s.departEpoch), x2 = scaleX(s.arriveEpoch);
      const y1 = yFor(stopIdx), y2 = yFor(stopIdx + 1);
      return { x: x1 + (x2 - x1) * frac, y: y1 + (y2 - y1) * frac };
    }
    stopIdx++;
  }
  return { x: scaleX(t), y: yFor(0) };
}

function renderMarey(direction, container, directionKey, selectedKey, onSelect) {
  if (direction.itineraries.length === 0) { container.appendChild(h('p', {}, ['No itineraries.'])); return; }

  const select = h('select', { id: 'marey-select-' + directionKey });
  const choices = direction.itineraries.flatMap(it => [it, ...it.alternatives]);
  choices.forEach((it, i) => {
    select.appendChild(h('option', { value: i }, [it.departTime + ' -> ' + it.arriveTime + ' (' + it.durationMinutes + 'min, ' + it.transfers + ' transfers)']));
  });
  container.appendChild(select);
  // If the shared cross-view selection points at one of this direction's
  // itineraries, start the dropdown on it instead of always index 0, so
  // selecting a trip elsewhere (Table/Timeline/Scatter) is reflected here too.
  const preselectIdx = selectedKey ? choices.findIndex(it => itineraryKey(directionKey, it) === selectedKey) : -1;
  if (preselectIdx >= 0) select.value = String(preselectIdx);
  const playbackHolder = h('div');
  container.appendChild(playbackHolder);
  const chartHolder = h('div');
  container.appendChild(chartHolder);

  let currentPlayback = null;

  function draw(index) {
    if (currentPlayback) { currentPlayback.destroy(); currentPlayback = null; }
    chartHolder.innerHTML = '';
    playbackHolder.innerHTML = '';
    const it = choices[index];
    const seq = stopSequence(it);
    const width = 760, padding = 150, topAxis = 36, rowHeight = 50, rightPad = 30;
    const height = topAxis + (seq.length - 1) * rowHeight + 30;
    const minT = seq[0].time, maxT = seq[seq.length - 1].time;
    const scaleX = t => padding + (t - minT) / (maxT - minT) * (width - padding - rightPad);
    const yFor = idx => topAxis + idx * rowHeight;

    const svg = el('svg', { width: width, height: height, viewBox: '0 0 ' + width + ' ' + height });

    // top time axis: ticks every ~5 min, gridlines down through the whole chart
    const xStepSeconds = niceStep((maxT - minT) / 60, 8) * 60;
    const t0 = Math.ceil(minT / xStepSeconds) * xStepSeconds;
    for (let t = t0; t <= maxT; t += xStepSeconds) {
      const x = scaleX(t);
      svg.appendChild(el('line', { x1: x, x2: x, y1: topAxis - 10, y2: yFor(seq.length - 1), stroke: '#f0f0f0' }));
      svg.appendChild(el('text', { x: x, y: 16, 'text-anchor': 'middle', class: 'axis-label' }, [fmtClock(t)]));
    }

    // stop labels + horizontal guide lines
    seq.forEach((stop, idx) => {
      const y = yFor(idx);
      svg.appendChild(el('line', { x1: padding, x2: width - rightPad, y1: y, y2: y, stroke: '#eee' }));
      svg.appendChild(el('text', { x: padding - 8, y: y + 4, 'text-anchor': 'end', 'font-size': 11 }, [stop.name]));
      svg.appendChild(el('text', { x: scaleX(stop.time), y: y - 6, 'text-anchor': 'middle', class: 'axis-label' }, [fmtClock(stop.time)]));
    });

    // draw segments
    let stopIdx = 0;
    for (const s of it.steps) {
      const isLine = s.kind === 'line';
      const { from: fromName, to: toName } = stepEndpoints(s);
      // find consecutive seq indices (sequential by construction)
      while (stopIdx < seq.length - 1 && seq[stopIdx].name !== fromName) stopIdx++;
      const y1 = yFor(stopIdx);
      const y2 = yFor(stopIdx + 1);
      const x1 = scaleX(s.departEpoch), x2 = scaleX(s.arriveEpoch);
      const color = isLine ? colorFor(s.line) : walkColor();
      // thickness proxy: shorter duration => thicker (faster pace); crude, no stop-count data available
      const thickness = Math.max(2, Math.min(8, 10 - s.minutes / 4));
      const visibleLine = el('line', { x1: x1, y1: y1, x2: x2, y2: y2, stroke: color, 'stroke-width': thickness, 'stroke-dasharray': isLine ? '' : '4,3' });
      svg.appendChild(visibleLine);
      // wider invisible overlay for an easier hover target than the thin visible stroke
      const hitLine = el('line', { x1: x1, y1: y1, x2: x2, y2: y2, stroke: 'transparent', 'stroke-width': Math.max(thickness, 10), style: 'cursor: pointer;' });
      attachTooltip(hitLine, () => itineraryTooltipContent(it, s, null));
      svg.appendChild(hitLine);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const segLabel = isLine ? s.line : WALK_EMOJI;
      svg.appendChild(el('text', { x: mx, y: my - 6, 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 700, fill: isLine ? color : '#777' }, [segLabel]));
      stopIdx++;
    }

    // playhead: vertical line + moving dot, driven by the playback controller
    const playheadLine = el('line', { class: 'playhead-line', x1: 0, x2: 0, y1: topAxis - 10, y2: yFor(seq.length - 1) });
    const playheadDot = el('circle', { class: 'playhead-dot', r: 6, cx: 0, cy: 0 });
    svg.appendChild(playheadLine);
    svg.appendChild(playheadDot);

    chartHolder.appendChild(svg);
    chartHolder.appendChild(h('div', { class: 'caption' }, [
      'Overall: ' + it.departTime + ' -> ' + it.arriveTime + ' (' + it.durationMinutes + 'min total, ' + it.transfers + ' transfers). ' +
      'Line thickness is a pace proxy (shorter wall-clock duration = thicker); true speed would need stop-count/distance data not currently scraped.'
    ]));

    currentPlayback = createPlaybackController(minT, maxT, (t) => {
      const x = scaleX(t);
      playheadLine.setAttribute('x1', x);
      playheadLine.setAttribute('x2', x);
      const pos = positionAtTime(it, seq, scaleX, yFor, t);
      playheadDot.setAttribute('cx', pos.x);
      playheadDot.setAttribute('cy', pos.y);
    });
    playbackHolder.appendChild(currentPlayback.bar);
  }

  select.addEventListener('change', () => {
    const idx = Number(select.value);
    onSelect(choices[idx]);
  });
  draw(preselectIdx >= 0 ? preselectIdx : 0);
  return () => { if (currentPlayback) currentPlayback.destroy(); };
}

// ---------- 5. MAREY whole-network overlay ----------

/**
 * Computes a geographically-faithful stop order for the whole-network
 * overlay, derived from the actual itinerary data rather than config.stops
 * (whose authored order has no guarantee of matching real stop sequence,
 * and can't anyway since different lines/directions branch at shared stops
 * — e.g. this network forks at Riviera, with toWork and toHome continuing
 * in opposite directions from there, so no single shared order is
 * correct for both; each direction gets its own computed order).
 *
 * Algorithm: every line/walk step in every itinerary + its alternatives
 * gives one "A before B" edge (board/from stop before alight/to stop).
 * Pooling all such edges and running a topological sort (Kahn's algorithm)
 * yields an order consistent with every line's own real stop sequence.
 * Origin naturally sorts first (it only ever has outgoing edges) and
 * destination naturally sorts last (only incoming edges) with no special
 * casing needed. Falls back to appending any leftover nodes (cycles from
 * contradictory edges, or disconnected stops) in first-seen order — a
 * graceful degrade, not a crash, if the data ever contains a genuine
 * ordering conflict.
 */
function computeStopOrder(direction) {
  const nodes = new Set([direction.origin, direction.destination]);
  const firstSeen = [direction.origin, direction.destination];
  const edgesOut = new Map(); // node -> Set(node)
  const inDegree = new Map();

  function ensureNode(n) {
    if (!nodes.has(n)) { nodes.add(n); firstSeen.push(n); }
    if (!inDegree.has(n)) inDegree.set(n, 0);
    if (!edgesOut.has(n)) edgesOut.set(n, new Set());
  }
  function addEdge(from, to) {
    if (from === to) return;
    ensureNode(from);
    ensureNode(to);
    if (!edgesOut.get(from).has(to)) {
      edgesOut.get(from).add(to);
      inDegree.set(to, inDegree.get(to) + 1);
    }
  }
  ensureNode(direction.origin);
  ensureNode(direction.destination);

  // 1. Edges from itinerary steps actually used (this is what tells us
  // where origin/destination/line-boarding points sit relative to the
  // graph, since lineStopOrders alone doesn't know about origin/destination
  // walk connections). Also record which (line, direction) pairs were
  // actually boarded in this commute direction -- needed below, since the
  // SAME line number can run opposite physical directions for toWork vs
  // toHome (e.g. line 9 "Karlova Ves" vs line 9 "Ruzinov" run opposite ways
  // through the same stops), so matching lineStopOrders by stop-name alone
  // would silently mix in a contradictory reversed order.
  const usedStops = new Set();
  const usedLineDirections = new Set();
  for (const it of direction.itineraries) {
    for (const candidate of [it, ...it.alternatives]) {
      for (const s of candidate.steps) {
        const { from, to } = stepEndpoints(s);
        usedStops.add(from);
        usedStops.add(to);
        addEdge(from, to);
        if (s.kind === 'line') usedLineDirections.add(s.line + '|' + s.direction);
      }
    }
  }

  // 2. Edges from each ACTUALLY-USED line+direction's REAL full stop order
  // (every consecutive pair, not just the two endpoints any one itinerary
  // happened to use) -- this is what lets us place an intermediate stop
  // between two others on a line even when no
  // itinerary boards/alights there directly.
  for (const lineOrder of DATA.lineStopOrders) {
    if (!usedLineDirections.has(lineOrder.line + '|' + lineOrder.direction)) continue;
    const sorted = [...lineOrder.stops].sort((a, b) => a.offsetMinutes - b.offsetMinutes);
    for (let i = 0; i < sorted.length - 1; i++) {
      addEdge(sorted[i].name, sorted[i + 1].name);
    }
  }

  const order = [];
  const ready = firstSeen.filter(n => inDegree.get(n) === 0);
  const inReady = new Set(ready);
  while (ready.length > 0) {
    const n = ready.shift();
    inReady.delete(n);
    order.push(n);
    for (const next of edgesOut.get(n)) {
      inDegree.set(next, inDegree.get(next) - 1);
      if (inDegree.get(next) === 0 && !inReady.has(next) && !order.includes(next)) {
        ready.push(next);
        inReady.add(next);
      }
    }
  }
  // Any nodes left out (cycle or already-visited edge cases) get appended
  // in first-seen order so nothing is silently dropped from the chart.
  for (const n of firstSeen) {
    if (!order.includes(n)) order.push(n);
  }
  return order;
}

function renderMareyOverlay(direction, container, directionKey, selectedKey, onSelect) {
  if (direction.itineraries.length === 0) { container.appendChild(h('p', {}, ['No itineraries.'])); return; }

  const stopOrder = computeStopOrder(direction);
  const stopIndex = new Map(stopOrder.map((name, i) => [name, i]));

  // Pool every step from every main itinerary + its alternatives, skipping
  // any step whose endpoints aren't both in our fixed stop order (shouldn't
  // happen in practice, but guards against surprises).
  const allSteps = [];
  for (const it of direction.itineraries) {
    for (const candidate of [it, ...it.alternatives]) {
      for (const s of candidate.steps) {
        const { from, to } = stepEndpoints(s);
        if (stopIndex.has(from) && stopIndex.has(to)) allSteps.push({ step: s, owner: candidate, from, to });
      }
    }
  }
  if (allSteps.length === 0) { container.appendChild(h('p', {}, ['No plottable segments.'])); return; }

  const minT = Math.min(...allSteps.map(e => e.step.departEpoch));
  const maxT = Math.max(...allSteps.map(e => e.step.arriveEpoch));

  const width = 1000, padding = 150, topAxis = 36, rowHeight = 42, rightPad = 30;
  const height = topAxis + (stopOrder.length - 1) * rowHeight + 30;
  const scaleX = t => padding + (t - minT) / (maxT - minT) * (width - padding - rightPad);
  const yFor = idx => topAxis + idx * rowHeight;

  const svg = el('svg', { width: width, height: height, viewBox: '0 0 ' + width + ' ' + height });

  // top time axis
  const xStepSeconds = niceStep((maxT - minT) / 60, 10) * 60;
  const t0 = Math.ceil(minT / xStepSeconds) * xStepSeconds;
  for (let t = t0; t <= maxT; t += xStepSeconds) {
    const x = scaleX(t);
    svg.appendChild(el('line', { x1: x, x2: x, y1: topAxis - 10, y2: yFor(stopOrder.length - 1), stroke: '#f5f5f5' }));
    svg.appendChild(el('text', { x: x, y: 16, 'text-anchor': 'middle', class: 'axis-label' }, [fmtClock(t)]));
  }

  // stop labels + horizontal guide lines (fixed order, not per-itinerary)
  stopOrder.forEach((name, idx) => {
    const y = yFor(idx);
    svg.appendChild(el('line', { x1: padding, x2: width - rightPad, y1: y, y2: y, stroke: '#eee' }));
    svg.appendChild(el('text', { x: padding - 8, y: y + 4, 'text-anchor': 'end', 'font-size': 10 }, [name]));
  });

  // draw every pooled segment, faint, colored by line; alternatives drawn
  // even fainter so the "main" network shape still reads clearly. The
  // currently-selected itinerary (shared across views) is instead drawn
  // thick/bold/opaque so its full path stands out against the network.
  for (const { step: s, owner, from, to } of allSteps) {
    const isLine = s.kind === 'line';
    const isAltOwner = direction.itineraries.indexOf(owner) === -1; // owner is an alternative, not a main itinerary
    const isSelected = itineraryKey(directionKey, owner) === selectedKey;
    const y1 = yFor(stopIndex.get(from));
    const y2 = yFor(stopIndex.get(to));
    const x1 = scaleX(s.departEpoch), x2 = scaleX(s.arriveEpoch);
    const color = isLine ? colorFor(s.line) : walkColor();
    const opacity = isSelected ? 1 : (isAltOwner ? 0.18 : 0.45);
    const strokeWidth = isSelected ? (isLine ? 5 : 3) : (isLine ? 2 : 1.3);
    const visibleLine = el('line', { x1: x1, y1: y1, x2: x2, y2: y2, stroke: color, 'stroke-width': strokeWidth, 'stroke-dasharray': isLine ? '' : '3,2', opacity: opacity });
    svg.appendChild(visibleLine);
    const hitLine = el('line', { x1: x1, y1: y1, x2: x2, y2: y2, stroke: 'transparent', 'stroke-width': 8, style: 'cursor: pointer;' });
    attachTooltip(hitLine, () => itineraryTooltipContent(owner, s, isAltOwner ? 'Alternative (+' + owner.durationMinutes + 'min total)' : null));
    hitLine.addEventListener('click', () => onSelect(owner));
    svg.appendChild(hitLine);
  }

  container.appendChild(svg);
  container.appendChild(h('div', { class: 'caption' }, [
    'Every itinerary (' + direction.itineraries.length + ' departures, including alternatives) overlaid on a stop order computed from the actual routes used. ' +
    'Faint lines = alternatives. A segment may still run backward if two lines genuinely disagree on stop order (rare) \u2014 hover any segment for details.'
  ]));
}

// ---------- line filter (exclude / require-all) ----------

function allLinesIn(direction) {
  const set = new Set();
  for (const it of direction.itineraries) {
    for (const s of it.steps) if (s.kind === 'line') set.add(s.line);
    for (const alt of it.alternatives) for (const s of alt.steps) if (s.kind === 'line') set.add(s.line);
  }
  return [...set].sort((a, b) => {
    const na = parseInt(a), nb = parseInt(b);
    return (isNaN(na) || isNaN(nb)) ? a.localeCompare(b) : na - nb;
  });
}

function itineraryLines(it) {
  return new Set(it.steps.filter(s => s.kind === 'line').map(s => s.line));
}

function passesFilter(it, required, excluded) {
  const lines = itineraryLines(it);
  for (const ex of excluded) if (lines.has(ex)) return false;
  for (const req of required) if (!lines.has(req)) return false;
  return true;
}

/**
 * Re-derives a direction's itinerary list under a line filter. For each
 * original departure, pools the main itinerary + its stored alternatives,
 * keeps only the candidates that pass the filter, and re-sorts/regroups
 * them (best candidate becomes the new "main", the rest become its
 * "alternatives") so every view (table/timeline/scatter/Marey) just works
 * on the result unmodified. Departures with zero surviving candidates are
 * dropped entirely.
 *
 * Note: this filters among already-computed options only — it does not
 * re-run the route search with the excluded lines removed from the graph,
 * so a filter can reduce the result to nothing for a given departure even
 * if some other (never-computed) line combination would have worked.
 */
function applyLineFilter(direction, required, excluded) {
  if (required.size === 0 && excluded.size === 0) return direction;
  const filteredItineraries = [];
  for (const it of direction.itineraries) {
    const candidates = [it, ...it.alternatives].filter(c => passesFilter(c, required, excluded));
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => a.durationMinutes - b.durationMinutes);
    const [best, ...rest] = candidates;
    filteredItineraries.push({ ...best, alternatives: rest });
  }
  return { ...direction, itineraries: filteredItineraries };
}

/**
 * Narrows a direction's itinerary list to only those whose "field"
 * (departEpoch or arriveEpoch) falls within [minEpoch, maxEpoch]
 * (inclusive). This can only narrow the originally planned window, never
 * widen it beyond what was actually computed by the planner - there is no
 * data outside that range in the JSON payload.
 */
function applyEpochWindow(direction, field, minEpoch, maxEpoch) {
  const filteredItineraries = direction.itineraries.filter(
    it => it[field] >= minEpoch && it[field] <= maxEpoch
  );
  return { ...direction, itineraries: filteredItineraries };
}

/**
 * Same shape as applyEpochWindow but bounds durationMinutes instead of an
 * epoch field - kept as its own named function (rather than just calling
 * applyEpochWindow with field='durationMinutes') since "duration window"
 * reads clearer at call sites than a generic epoch name would.
 */
function applyDurationWindow(direction, minMinutes, maxMinutes) {
  const filteredItineraries = direction.itineraries.filter(
    it => it.durationMinutes >= minMinutes && it.durationMinutes <= maxMinutes
  );
  return { ...direction, itineraries: filteredItineraries };
}

const fmtMinutes = (m) => m + 'min';

const fmtClockLocal = (epoch) => new Date(epoch * 1000).toLocaleTimeString('en-GB', {
  timeZone: DATA.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/**
 * Generic numeric-range slider pair bounding any itinerary field (e.g.
 * "departEpoch"/"arriveEpoch" formatted as clock time, or
 * "durationMinutes" formatted as plain minutes). "field" selects which
 * field of each itinerary bounds the slider range; "labelText" is the
 * human-facing row label; "fmt" formats a raw value for the on-screen
 * label (defaults to clock-time formatting for the epoch fields).
 */
/**
 * Renders one <tr> of the controls table: label cell, control cell
 * (sliders), reset-button cell. Returns the row plus fullMin/fullMax so the
 * caller can seed its own filter state and detect "is this control at its
 * default" for the status line.
 */
function renderEpochWindowRow(direction, field, labelText, onChange, fmt) {
  if (!fmt) fmt = fmtClockLocal;
  const values = direction.itineraries.map(it => it[field]);
  const fullMin = values.length ? Math.min(...values) : 0;
  const fullMax = values.length ? Math.max(...values) : 0;

  const controlCell = h('td', { class: 'controls-cell' });
  const startSlider = h('input', { type: 'range', min: String(fullMin), max: String(fullMax), value: String(fullMin), class: 'time-slider' });
  const endSlider = h('input', { type: 'range', min: String(fullMin), max: String(fullMax), value: String(fullMax), class: 'time-slider' });
  const label = h('span', { class: 'time-window-label' }, [values.length ? fmt(fullMin) + ' \u2013 ' + fmt(fullMax) : 'No departures']);
  if (!values.length) { startSlider.disabled = true; endSlider.disabled = true; }

  function emit() {
    let lo = Number(startSlider.value), hi = Number(endSlider.value);
    if (lo > hi) { [lo, hi] = [hi, lo]; }
    label.textContent = fmt(lo) + ' \u2013 ' + fmt(hi);
    onChange(lo, hi);
  }
  startSlider.addEventListener('input', emit);
  endSlider.addEventListener('input', emit);
  controlCell.appendChild(startSlider);
  controlCell.appendChild(endSlider);
  controlCell.appendChild(label);

  const resetBtn = h('button', { type: 'button', class: 'control-reset' }, ['Reset']);
  if (!values.length) resetBtn.disabled = true;
  resetBtn.addEventListener('click', () => {
    startSlider.value = String(fullMin);
    endSlider.value = String(fullMax);
    emit();
  });
  const resetCell = h('td', { class: 'reset-cell' }, [resetBtn]);

  const row = h('tr', {}, [
    h('td', { class: 'label-cell' }, [labelText]),
    controlCell,
    resetCell,
  ]);

  return { row, fullMin, fullMax };
}

/**
 * Strips every itinerary's alternatives down to [] (used when the "show
 * alternates" checkbox is unticked). Main itineraries are otherwise
 * untouched, so table/timeline/whole-network-marey simply stop rendering
 * alt rows/segments without needing their own separate code path.
 */
function stripAlternatives(direction) {
  return { ...direction, itineraries: direction.itineraries.map(it => ({ ...it, alternatives: [] })) };
}

function renderShowAltsRow(onChange, directionKey) {
  const controlCell = h('td', { class: 'controls-cell' });
  const checkbox = h('input', { type: 'checkbox', checked: 'checked', id: 'show-alts-checkbox-' + directionKey });
  const label = h('label', { for: 'show-alts-checkbox-' + directionKey }, [' Show alternate routes']);
  checkbox.addEventListener('change', () => onChange(checkbox.checked));
  controlCell.appendChild(checkbox);
  controlCell.appendChild(label);

  const resetBtn = h('button', { type: 'button', class: 'control-reset' }, ['Reset']);
  resetBtn.addEventListener('click', () => {
    checkbox.checked = true;
    onChange(true);
  });
  const resetCell = h('td', { class: 'reset-cell' }, [resetBtn]);

  const row = h('tr', {}, [
    h('td', { class: 'label-cell' }, ['Alternates']),
    controlCell,
    resetCell,
  ]);

  return { row };
}

function renderLineFilterRow(direction, onChange) {
  const lines = allLinesIn(direction);
  const state = {}; // line -> 'required' | 'excluded' | undefined
  const controlCell = h('td', { class: 'controls-cell' });

  const chips = {};
  for (const line of lines) {
    const lineColor = colorFor(line);
    const chip = h('button', { type: 'button', class: 'line-filter-chip', style: 'border-color:' + lineColor + '; color:' + lineColor }, [line]);
    chips[line] = chip;
    chip.addEventListener('click', () => {
      const cur = state[line];
      const next = cur === undefined ? 'required' : cur === 'required' ? 'excluded' : undefined;
      if (next === undefined) delete state[line]; else state[line] = next;
      chip.classList.remove('required', 'excluded');
      if (next === 'required') {
        chip.style.background = lineColor;
        chip.style.color = 'white';
      } else if (next === 'excluded') {
        chip.style.background = '#fff';
        chip.style.color = lineColor;
        chip.classList.add('excluded');
      } else {
        chip.style.background = '#fff';
        chip.style.color = lineColor;
      }
      if (next) chip.classList.add(next);
      onChange(
        new Set(Object.keys(state).filter(l => state[l] === 'required')),
        new Set(Object.keys(state).filter(l => state[l] === 'excluded')),
      );
    });
    controlCell.appendChild(chip);
  }

  const resetBtn = h('button', { type: 'button', class: 'control-reset' }, ['Reset']);
  resetBtn.addEventListener('click', () => {
    for (const line of lines) {
      delete state[line];
      const chip = chips[line];
      chip.classList.remove('required', 'excluded');
      chip.style.background = '#fff';
      chip.style.color = colorFor(line);
    }
    onChange(new Set(), new Set());
  });
  const resetCell = h('td', { class: 'reset-cell' }, [resetBtn]);

  const row = h('tr', {}, [
    h('td', { class: 'label-cell' }, ['Lines']),
    controlCell,
    resetCell,
  ]);

  return { row };
}

// ---------- page assembly ----------
const app = document.getElementById('app');

const tabBar = h('div', { class: 'direction-tabs' });
const panels = {};
const DIRECTION_META = {
  toWork: { emoji: '\u{1F305}', label: 'Morning \u2014 to Work' },
  toHome: { emoji: '\u{1F306}', label: 'Evening \u2014 back Home' },
};

['toWork', 'toHome'].forEach((key, i) => {
  const direction = DATA.directions[key];
  const meta = DIRECTION_META[key];

  const btn = h('button', { class: 'direction-tab-btn' + (i === 0 ? ' active' : ''), type: 'button' }, [
    meta.emoji + ' ' + meta.label + ' (' + direction.departureWindow + ')'
  ]);
  tabBar.appendChild(btn);

  const panel = h('div', { class: 'direction-panel' + (i === 0 ? '' : ' hidden') });
  panels[key] = panel;

  const totalDepartures = direction.itineraries.length;

  // --- Controls section (collapsible, stays visible across view tabs) ---
  const controls = h('details', { class: 'controls-section', open: '' });
  const summary = h('summary', {}, ['\u2699\uFE0F Controls (line filter, time window)']);
  controls.appendChild(summary);
  const controlsBody = h('div', { class: 'controls-body' });
  controls.appendChild(controlsBody);
  panel.appendChild(controls);

  // --- View tabs: Table / Timeline / Scatter / Marey, one visible at a time ---
  const viewTabBar = h('div', { class: 'view-tabs' });
  const viewPanels = {};
  const VIEW_META = [
    { key: 'table', label: '1. Table' },
    { key: 'timeline', label: '2. Timeline / Gantt' },
    { key: 'scatter', label: '3. Scatter' },
    { key: 'marey', label: '4. Marey chart (drill-down)' },
    { key: 'mareyAll', label: '5. Marey chart (whole network)' },
  ];
  VIEW_META.forEach((v, vi) => {
    const vbtn = h('button', { class: 'view-tab-btn' + (vi === 0 ? ' active' : ''), type: 'button' }, [v.label]);
    viewTabBar.appendChild(vbtn);
    const vpanel = h('div', { class: 'view-panel' + (vi === 0 ? '' : ' hidden') });
    viewPanels[v.key] = { btn: vbtn, panel: vpanel };
    vbtn.addEventListener('click', () => {
      viewTabBar.querySelectorAll('.view-tab-btn').forEach(b => b.classList.remove('active'));
      vbtn.classList.add('active');
      Object.values(viewPanels).forEach(vp => vp.panel.classList.add('hidden'));
      vpanel.classList.remove('hidden');
    });
  });
  panel.appendChild(viewTabBar);
  Object.values(viewPanels).forEach(vp => panel.appendChild(vp.panel));

  let currentRequired = new Set();
  let currentExcluded = new Set();
  let currentDepartMin = -Infinity;
  let currentDepartMax = Infinity;
  let currentArriveMin = -Infinity;
  let currentArriveMax = Infinity;
  let currentDurationMin = -Infinity;
  let currentDurationMax = Infinity;
  let currentShowAlts = true;
  const storageKey = 'mhd.filters.v1:' + DATA.generatedAt + ':' + DATA.pattern + ':' + key;
  let restoring = true;
  let selectedKey = null;
  let timelinePlayback = null;
  let destroyMarey = null;

  // Shared cross-view selection: clicking a trip in any one view marks the
  // same trip (by its direction and full step sequence) in
  // every other view. Re-runs the full rerenderAll so every view's
  // selection highlighting stays in sync from one call site.
  function selectItinerary(it) {
    selectedKey = itineraryKey(key, it);
    rerenderAll();
  }

  function rerenderAll() {
    if (!restoring) {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify({
          required: [...currentRequired], excluded: [...currentExcluded],
          depart: [currentDepartMin, currentDepartMax], arrive: [currentArriveMin, currentArriveMax],
          duration: [currentDurationMin, currentDurationMax], showAlts: currentShowAlts,
        }));
      } catch (_) { /* Storage can be unavailable or full; controls still work. */ }
    }
    const lineFiltered = applyLineFilter(direction, currentRequired, currentExcluded);
    const departFiltered = applyEpochWindow(lineFiltered, 'departEpoch', currentDepartMin, currentDepartMax);
    const arriveFiltered = applyEpochWindow(departFiltered, 'arriveEpoch', currentArriveMin, currentArriveMax);
    const durationFiltered = applyDurationWindow(arriveFiltered, currentDurationMin, currentDurationMax);
    const filtered = currentShowAlts ? durationFiltered : stripAlternatives(durationFiltered);

    const anyLineFilter = currentRequired.size > 0 || currentExcluded.size > 0;
    const anyDepartFilter = currentDepartMin > departFullMin || currentDepartMax < departFullMax;
    const anyArriveFilter = currentArriveMin > arriveFullMin || currentArriveMax < arriveFullMax;
    const anyDurationFilter = currentDurationMin > durationFullMin || currentDurationMax < durationFullMax;
    if (anyLineFilter || anyDepartFilter || anyArriveFilter || anyDurationFilter) {
      status.textContent = filtered.itineraries.length + ' of ' + totalDepartures + ' departures match the current filter.';
    } else {
      status.textContent = totalDepartures + ' departures.';
    }

    viewPanels.table.panel.innerHTML = '';
    renderTable(filtered, viewPanels.table.panel, key, selectedKey, selectItinerary);

    if (timelinePlayback) { timelinePlayback.destroy(); timelinePlayback = null; }
    viewPanels.timeline.panel.innerHTML = '';
    const timelineResult = renderTimeline(filtered, viewPanels.timeline.panel, key, selectedKey, selectItinerary);
    if (timelineResult) {
      const controller = createPlaybackController(timelineResult.minT, timelineResult.maxT, timelineResult.onTick);
      viewPanels.timeline.panel.insertBefore(controller.bar, viewPanels.timeline.panel.firstChild);
      timelinePlayback = controller;
    }

    viewPanels.scatter.panel.innerHTML = '';
    renderScatter(filtered, viewPanels.scatter.panel, key, selectedKey, selectItinerary);

    if (destroyMarey) { destroyMarey(); destroyMarey = null; }
    viewPanels.marey.panel.innerHTML = '';
    destroyMarey = renderMarey(filtered, viewPanels.marey.panel, key, selectedKey, selectItinerary);

    viewPanels.mareyAll.panel.innerHTML = '';
    renderMareyOverlay(filtered, viewPanels.mareyAll.panel, key, selectedKey, selectItinerary);
  }

  const { row: lineRow } = renderLineFilterRow(direction, (req, exc) => {
    currentRequired = req;
    currentExcluded = exc;
    rerenderAll();
  });

  const { row: departRow, fullMin: departFullMin, fullMax: departFullMax } = renderEpochWindowRow(
    direction, 'departEpoch', 'Departure window', (lo, hi) => {
      currentDepartMin = lo;
      currentDepartMax = hi;
      rerenderAll();
    },
  );
  currentDepartMin = departFullMin;
  currentDepartMax = departFullMax;

  const { row: arriveRow, fullMin: arriveFullMin, fullMax: arriveFullMax } = renderEpochWindowRow(
    direction, 'arriveEpoch', 'Arrival window', (lo, hi) => {
      currentArriveMin = lo;
      currentArriveMax = hi;
      rerenderAll();
    },
  );
  currentArriveMin = arriveFullMin;
  currentArriveMax = arriveFullMax;

  const { row: durationRow, fullMin: durationFullMin, fullMax: durationFullMax } = renderEpochWindowRow(
    direction, 'durationMinutes', 'Duration window', (lo, hi) => {
      currentDurationMin = lo;
      currentDurationMax = hi;
      rerenderAll();
    },
    fmtMinutes,
  );
  currentDurationMin = durationFullMin;
  currentDurationMax = durationFullMax;

  const { row: showAltsRow } = renderShowAltsRow((checked) => {
    currentShowAlts = checked;
    rerenderAll();
  }, key);

  const controlsTable = h('table', { class: 'controls-table' }, [
    h('tbody', {}, [lineRow, departRow, arriveRow, durationRow, showAltsRow]),
  ]);
  controlsBody.appendChild(controlsTable);

  const status = h('div', { class: 'line-filter-status' });
  controlsBody.appendChild(status);

  // Restore through the controls themselves so their labels and chip styles
  // stay in sync with filter state. Ignore malformed or out-of-range values.
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (saved && typeof saved === 'object') {
      const required = Array.isArray(saved.required) ? saved.required : [];
      const excluded = Array.isArray(saved.excluded) ? saved.excluded : [];
      lineRow.querySelectorAll('.line-filter-chip').forEach(chip => {
        const clicks = required.includes(chip.textContent) ? 1 : excluded.includes(chip.textContent) ? 2 : 0;
        for (let i = 0; i < clicks; i++) chip.click();
      });
      [[departRow, saved.depart], [arriveRow, saved.arrive], [durationRow, saved.duration]].forEach(([row, range]) => {
        const sliders = row.querySelectorAll('input[type=range]');
        if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) ||
            range[0] > range[1] || range[0] < Number(sliders[0].min) || range[1] > Number(sliders[1].max)) return;
        sliders[0].value = String(range[0]);
        sliders[1].value = String(range[1]);
        sliders[0].dispatchEvent(new Event('input'));
      });
      const checkbox = showAltsRow.querySelector('input[type=checkbox]');
      if (saved.showAlts === false) {
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('change'));
      }
    }
  } catch (_) { /* Invalid stored data or disabled storage: use defaults. */ }
  restoring = false;
  rerenderAll();

  btn.addEventListener('click', () => {
    tabBar.querySelectorAll('.direction-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    Object.values(panels).forEach(p => p.classList.add('hidden'));
    panel.classList.remove('hidden');
  });

  app.appendChild(panel);
});

app.insertBefore(tabBar, app.firstChild);
})().catch(err => { document.getElementById('app').textContent = 'Failed to load timetable. Please retry.'; console.error(err); });
`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
