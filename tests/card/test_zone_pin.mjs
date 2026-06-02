// Regression test for zone on/off section pinning (grace period on turn-off,
// immediate move + auto-expand on turn-on).
//
// Mirrors the schedule grace period: turning a zone OFF keeps it in the On
// section for the grace period (3s) before it drops to Off; turning a zone ON
// moves it to On immediately and expands the On group. Zones read membership
// from live HA state (which we can't mutate), so the pin carries a displayOn
// override too, used by _zoneSection (membership) and _zoneDisplayOff (body).
//
// Drives the real card with a controllable fake timer + stub callService.
//
// Run: node tests/card/test_zone_pin.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CARD = resolve(__dirname, "../../custom_components/airzone_cloud/airzone-schedules-card.js");

function makeCard() {
  const timers = [];
  let seq = 1;
  const fakeSetTimeout = (fn) => { const id = seq++; timers.push({ id, fn }); return id; };
  const fakeClearTimeout = (id) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); };
  const flushTimers = () => { const due = timers.splice(0); due.forEach(t => t.fn()); };

  const HTMLElementStub = class {
    constructor() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
    addEventListener() {}
    appendChild() {}
  };
  const calls = [];
  const sandbox = {
    HTMLElement: HTMLElementStub,
    customElements: { get: () => undefined, define: () => {} },
    window: {},
    document: { addEventListener() {}, createElement: () => ({ classList: { add() {}, remove() {}, toggle() {} }, style: {}, setAttribute() {}, appendChild() {} }) },
    localStorage: { getItem: () => null, setItem() {} },
    console, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const src = readFileSync(CARD, "utf8") + "\n;globalThis.__AZ = AirzoneSchedulesCard;";
  vm.runInContext(src, sandbox, { filename: "airzone-schedules-card.js" });
  const card = new sandbox.__AZ();
  card._activeTab = "zones";
  card._renderZones = () => {};
  card._hass = { callService: (d, s, data) => { calls.push({ d, s, eid: data.entity_id }); } };
  return { card, flushTimers, calls };
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok -", name); }
  catch (e) { failures++; console.error("  FAIL -", name, "\n   ", e.message); }
}

const zone = (eid, state) => ({ entity_id: eid, state });

console.log("test_zone_pin:");

check("turning a zone OFF keeps it in the On section during the grace period", () => {
  const { card, calls } = makeCard();
  card._toggleZonePower("climate.z1", false);
  // service called to turn off
  assert.deepEqual(calls.at(-1), { d: "climate", s: "turn_off", eid: "climate.z1" });
  // even though live state is now off, it still displays in 'on'
  assert.equal(card._zoneSection(zone("climate.z1", "off")), "on", "should stay in On during grace");
  // and its body should render as OFF immediately
  assert.equal(card._zoneDisplayOff("climate.z1", true), true, "body shows off immediately");
});

check("after the grace timer the zone drops to the Off section", () => {
  const { card, flushTimers } = makeCard();
  card._toggleZonePower("climate.z1", false);
  assert.equal(card._zoneSection(zone("climate.z1", "off")), "on");
  flushTimers();
  assert.equal(card._zoneSection(zone("climate.z1", "off")), "off", "drops to Off after grace");
});

check("turning a zone ON shows it in On immediately and expands the On group", () => {
  const { card, calls } = makeCard();
  card._groupOpen = { zonesOn: false, zonesOff: true };
  card._toggleZonePower("climate.z2", true);
  assert.deepEqual(calls.at(-1), { d: "climate", s: "turn_on", eid: "climate.z2" });
  // live state still off (cloud lag) but it shows in On
  assert.equal(card._zoneSection(zone("climate.z2", "off")), "on", "shows in On immediately");
  assert.equal(card._zoneDisplayOff("climate.z2", true), false, "body shows on immediately");
  assert.equal(card._groupOpen.zonesOn, true, "On group auto-expanded");
});

check("optimistic ON pin clears once live state catches up", () => {
  const { card } = makeCard();
  card._groupOpen = {};
  card._toggleZonePower("climate.z3", true);
  // live state now on -> reconcile should drop the pin
  card._reconcileZonePins([zone("climate.z3", "heat")]);
  assert.equal(card._zonePins.has("climate.z3"), false, "optimistic pin cleared after live confirms");
});

check("an unpinned zone just follows live state", () => {
  const { card } = makeCard();
  assert.equal(card._zoneSection(zone("climate.z4", "off")), "off");
  assert.equal(card._zoneSection(zone("climate.z4", "cool")), "on");
  assert.equal(card._zoneDisplayOff("climate.z4", true), true);
  assert.equal(card._zoneDisplayOff("climate.z4", false), false);
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("all checks passed");
