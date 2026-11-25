import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";
import { renderPage } from "../build-viz.js";
import type { JsonItinerary, JsonOutput, JsonStep } from "../format.js";

for (const fails of [false, true]) {
  test('initial loading indicator and refresh recovery: ' + (fails ? 'failure' : 'success'), async () => {
    const direction = { departureWindow: '07:00-08:00', origin: 'Home', destination: 'Work', itineraries: [] };
    const data: JsonOutput = { generatedAt: new Date().toISOString(), timezone: 'Europe/Bratislava', pattern: 'workday', stops: [], lineStopOrders: [], directions: { toWork: direction, toHome: direction } };
    let complete!: () => void;
    const pending = new Promise<void>(resolve => { complete = resolve; });
    const dom = new JSDOM(renderPage(), {
      runScripts: 'dangerously', url: 'http://localhost/', virtualConsole: new VirtualConsole(),
      beforeParse(window) {
        window.fetch = (async () => {
          await pending;
          if (fails) throw new Error('Offline');
          return new Response(JSON.stringify(data));
        }) as typeof fetch;
      },
    });
    try {
      const doc = dom.window.document;
      const button = doc.getElementById('refresh-cache') as HTMLButtonElement;
      const progress = doc.getElementById('schedule-progress')!;
      assert.equal(button.disabled, true);
      assert.equal(progress.hidden, false);
      assert.equal(doc.getElementById('app')!.getAttribute('aria-busy'), 'true');
      await new Promise(resolve => setTimeout(resolve, 2100));
      assert.match(doc.getElementById('refresh-status')!.textContent!, /[1-9]\d*s elapsed/);
      complete();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(button.disabled, false);
      assert.equal(progress.hidden, true);
      assert.equal(doc.getElementById('app')!.getAttribute('aria-busy'), 'false');
      assert.match(doc.getElementById('refresh-status')!.textContent!, fails ? /Loading failed/ : /Schedule ready/);
      if (fails) {
        button.click();
        assert.equal(button.disabled, true);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(button.disabled, false);
        assert.equal(progress.hidden, true);
        assert.match(doc.getElementById('refresh-status')!.textContent!, /Refresh failed/);
      }
    } finally { dom.window.close(); }
  });
}

const step = (from: string, to: string): JsonStep => ({ kind: "walk", fromStop: from, toStop: to, label: from + " -> " + to, departTime: "07:00", arriveTime: "07:10", departEpoch: 1000, arriveEpoch: 1600, minutes: 10 });
const trip = (steps: JsonStep[]): JsonItinerary => ({ departTime: "07:00", arriveTime: "07:10", departEpoch: 1000, arriveEpoch: 1600, durationMinutes: 10, transfers: 0, steps, alternatives: [] });

test("tied alternative selection stays distinct across views and Marey dropdown", () => {
  const main = trip([step("Home", "A")]);
  const alt = trip([step("Home", "B")]);
  main.alternatives = [alt];
  const direction = { departureWindow: "07:00-08:00", origin: "Home", destination: "Work", itineraries: [main] };
  const data: JsonOutput = { generatedAt: new Date().toISOString(), timezone: "Europe/Bratislava", pattern: "workday", stops: ["A", "B"], lineStopOrders: [], directions: { toWork: direction, toHome: direction } };
  const dom = new JSDOM(renderPage(data), { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/" });
  try {
    const panel = dom.window.document.querySelector('.direction-panel')!;
    const checkboxes = dom.window.document.querySelectorAll('input[id^="show-alts-checkbox-"]');
    assert.equal(new Set([...checkboxes].map(el => el.id)).size, 2);
    const scatterDot = panel.querySelector('circle[fill-opacity]')!;
    assert.ok(Number.isFinite(Number(scatterDot.getAttribute('cx'))));
    (panel.querySelector('tr.alt-row') as HTMLElement).click();
    assert.equal(panel.querySelectorAll('tr.selected-row').length, 1);
    assert.ok(panel.querySelector('tr.alt-row.selected-row'));
    const select = panel.querySelector('select[id^="marey-select-"]') as HTMLSelectElement;
    assert.equal(select.options.length, 2);
    assert.equal(select.value, '1');
    select.value = '0';
    select.dispatchEvent(new dom.window.Event('change'));
    assert.ok(panel.querySelector('tr.selected-row:not(.alt-row)'));
    assert.equal(panel.querySelectorAll('tr.selected-row').length, 1);
  } finally { dom.window.close(); }
});

test("rerender cancels active Marey playback", () => {
  const main = trip([step("Home", "A")]);
  const direction = { departureWindow: "07:00-08:00", origin: "Home", destination: "Work", itineraries: [main] };
  const data: JsonOutput = { generatedAt: new Date().toISOString(), timezone: "Europe/Bratislava", pattern: "workday", stops: ["A"], lineStopOrders: [], directions: { toWork: direction, toHome: direction } };
  const pending = new Set<number>();
  let nextId = 1;
  const dom = new JSDOM(renderPage(data), {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(window) {
      window.requestAnimationFrame = () => { const id = nextId++; pending.add(id); return id; };
      window.cancelAnimationFrame = id => { pending.delete(id); };
    },
  });
  try {
    const panel = dom.window.document.querySelector('.direction-panel')!;
    const buttons = panel.querySelectorAll('.playback-play');
    assert.equal(buttons.length, 2);
    (buttons[1] as HTMLElement).click();
    assert.equal(pending.size, 1);
    (panel.querySelector('.view-panel table tbody tr') as HTMLElement).click();
    assert.equal(pending.size, 0, 'rerender must cancel the old animation frame');
  } finally { dom.window.close(); }
});

test("empty directions render usable panels without errors", () => {
  const direction = { departureWindow: "07:00-08:00", origin: "Home", destination: "Work", itineraries: [] };
  const data: JsonOutput = { generatedAt: new Date().toISOString(), timezone: "Europe/Bratislava", pattern: "workday", stops: [], lineStopOrders: [], directions: { toWork: direction, toHome: direction } };
  const errors: Error[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", error => errors.push(error));
  const dom = new JSDOM(renderPage(data), { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/", virtualConsole });
  try {
    assert.equal(errors.length, 0);
    assert.equal(dom.window.document.querySelectorAll('.direction-panel').length, 2);
    const controls = dom.window.document.querySelectorAll('.time-slider');
    assert.equal(controls.length, 12);
    assert.ok([...controls].every(el => (el as HTMLInputElement).disabled));
    assert.match(dom.window.document.querySelector('.line-filter-status')!.textContent!, /0 departures/);
  } finally { dom.window.close(); }
});
