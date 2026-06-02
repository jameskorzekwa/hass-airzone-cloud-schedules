// Regression test for the "stay in section after toggling" grace period.
//
// Feature: when you flip a schedule's enable switch, the row should NOT jump to
// the other section immediately. It stays in its current section for a grace
// period (_sectionPinMs, 10s) and then re-sections. Implemented via
// _sectionPins + _displaySection + _pinScheduleSection in the card.
//
// This drives the real card class with a minimal stub: a controllable fake
// setTimeout (so we can advance "time"), a stub callWS, and a captured
// _renderList. It asserts:
//   - immediately after disabling, the row still displays in 'enabled'
//   - the live enabled flag is updated to false (server state is correct)
//   - after the grace timer fires, the pin clears -> row displays in 'disabled'
//     and a re-render was triggered
//
// Run: node tests/card/test_section_pin.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CARD = resolve(__dirname, "../../custom_components/airzone_cloud/airzone-schedules-card.js");

class FakeClassList {
  constructor() { this._s = new Set(); }
  add(c) { this._s.add(c); } remove(c) { this._s.delete(c); }
  toggle(c, on) { if (on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); return on; }
  contains(c) { return this._s.has(c); }
}

function makeCard() {
  // Controllable timer queue so the test can advance time deterministically.
  const timers = [];
  let seq = 1;
  const fakeSetTimeout = (fn, ms) => { const id = seq++; timers.push({ id, fn, ms }); return id; };
  const fakeClearTimeout = (id) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); };
  const flushTimers = () => { const due = timers.splice(0); due.forEach(t => t.fn()); };

  const HTMLElementStub = class {
    constructor() { this.classList = new FakeClassList(); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    addEventListener() {}
    appendChild() {}
  };

  const sandbox = {
    HTMLElement: HTMLElementStub,
    customElements: { get: () => undefined, define: () => {} },
    window: {},
    document: { addEventListener() {}, createElement: () => ({ classList: new FakeClassList(), style: {}, setAttribute() {}, appendChild() {} }) },
    localStorage: { getItem: () => null, setItem() {} },
    console,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const src = readFileSync(CARD, "utf8") + "\n;globalThis.__AZ = AirzoneSchedulesCard;";
  vm.runInContext(src, sandbox, { filename: "airzone-schedules-card.js" });
  const Cls = sandbox.__AZ;
  assert.ok(Cls, "card class should be defined");
  const card = new Cls();
  card._activeTab = "schedules";
  // capture re-render calls
  let renderCount = 0;
  card._renderList = () => { renderCount += 1; };
  // stub the websocket call the toggle makes
  card._hass = { callWS: async () => ({}) };
  return { card, flushTimers, renderCount: () => renderCount };
}

let failures = 0;
function check(name, fn) {
  try { return Promise.resolve(fn()).then(() => console.log("  ok -", name), (e) => { failures++; console.error("  FAIL -", name, "\n   ", e.message); }); }
  catch (e) { failures++; console.error("  FAIL -", name, "\n   ", e.message); }
}

console.log("test_section_pin:");

await check("disabling keeps the row in 'enabled' during the grace period", async () => {
  const { card } = makeCard();
  const sched = { id: "s1", name: "X", enabled: true };
  card._schedules = [sched];
  assert.equal(card._displaySection(sched), "enabled");

  await card._toggleSchedule(sched, false); // user flips it off

  // live state updated...
  assert.equal(sched.enabled, false, "enabled flag should be updated to false");
  // ...but it still DISPLAYS in the enabled section (pinned)
  assert.equal(card._displaySection(sched), "enabled", "row should stay pinned in 'enabled'");
});

await check("after the grace timer the row re-sections to 'disabled' and re-renders", async () => {
  const { card, flushTimers, renderCount } = makeCard();
  const sched = { id: "s1", name: "X", enabled: true };
  card._schedules = [sched];
  await card._toggleSchedule(sched, false);
  assert.equal(card._displaySection(sched), "enabled");

  flushTimers(); // advance past the grace period

  assert.equal(card._displaySection(sched), "disabled", "row should now show in 'disabled'");
  assert.ok(renderCount() >= 1, "a re-render should fire when the pin expires");
});

await check("enabling a disabled schedule moves it to 'enabled' IMMEDIATELY (no grace)", async () => {
  const { card } = makeCard();
  const sched = { id: "s2", name: "Y", enabled: false };
  card._schedules = [sched];
  card._groupOpen = { enabled: false, disabled: true }; // Enabled collapsed
  await card._toggleSchedule(sched, true);
  assert.equal(sched.enabled, true);
  assert.equal(card._displaySection(sched), "enabled", "should move to 'enabled' immediately, not pin in 'disabled'");
});

await check("enabling auto-expands the Enabled section", async () => {
  const { card } = makeCard();
  const sched = { id: "s2b", name: "Y2", enabled: false };
  card._schedules = [sched];
  card._groupOpen = { enabled: false, disabled: true };
  await card._toggleSchedule(sched, true);
  assert.equal(card._groupOpen.enabled, true, "Enabled group should be expanded after enabling");
});

await check("disabling then re-enabling within grace immediately shows enabled", async () => {
  const { card } = makeCard();
  const sched = { id: "s3", name: "Z", enabled: true };
  card._schedules = [sched];
  await card._toggleSchedule(sched, false); // pinned in 'enabled', live=false
  assert.equal(card._displaySection(sched), "enabled");
  await card._toggleSchedule(sched, true);  // enabling clears the pin, moves now
  assert.equal(sched.enabled, true);
  assert.equal(card._displaySection(sched), "enabled");
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("all checks passed");
