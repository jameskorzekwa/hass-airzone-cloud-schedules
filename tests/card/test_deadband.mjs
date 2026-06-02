// Regression test for the heat/cool deadband validation in the schedule editor.
//
// Bug (v1.0.92): saving a dual schedule with heat 65°F / cool 67°F — exactly the
// 2°F default deadband apart — was rejected with "Heat and cool must be at least
// 2° apart". Cause: the check converted both setpoints to Celsius first, where
// 67°F−65°F came out as 1.1111107 vs a 1.1111112 threshold (a ~4e-16 float
// rounding error), so an exactly-on-the-deadband gap read as "too small".
//
// Fix: _deadbandViolated() compares in the user's DISPLAY unit (what they typed)
// with a small epsilon. This drives the real card method and asserts 65/67°F
// with a 2°F deadband is allowed, while a genuinely-too-small gap is rejected.
//
// Run: node tests/card/test_deadband.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CARD = resolve(__dirname, "../../custom_components/airzone_cloud/airzone-schedules-card.js");

function makeCard() {
  const HTMLElementStub = class {
    constructor() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
    addEventListener() {}
    appendChild() {}
  };
  const sandbox = {
    HTMLElement: HTMLElementStub,
    customElements: { get: () => undefined, define: () => {} },
    window: {},
    document: { addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {} } }) },
    localStorage: { getItem: () => null, setItem() {} },
    console, setTimeout, clearTimeout,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const src = readFileSync(CARD, "utf8") + "\n;globalThis.__AZ = AirzoneSchedulesCard;";
  vm.runInContext(src, sandbox, { filename: "airzone-schedules-card.js" });
  const card = new sandbox.__AZ();
  return card;
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok -", name); }
  catch (e) { failures++; console.error("  FAIL -", name, "\n   ", e.message); }
}

console.log("test_deadband:");

check("65°F / 67°F with a 2°F deadband is allowed (the reported bug)", () => {
  const card = makeCard();
  card._useFah = true;
  card._settings = { setpoint_differential: 2, setpoint_differential_unit: "F" };
  // heat 65, cool 67 — exactly 2°F apart
  assert.equal(card._deadbandViolated(65, 67), false, "exactly-on-deadband gap must NOT be rejected");
});

check("a genuinely too-small gap is still rejected", () => {
  const card = makeCard();
  card._useFah = true;
  card._settings = { setpoint_differential: 2, setpoint_differential_unit: "F" };
  assert.equal(card._deadbandViolated(65, 66), true, "1°F gap with a 2°F deadband must be rejected");
});

check("a larger gap is allowed", () => {
  const card = makeCard();
  card._useFah = true;
  card._settings = { setpoint_differential: 2, setpoint_differential_unit: "F" };
  assert.equal(card._deadbandViolated(65, 70), false);
});

check("deadband of 0 never blocks", () => {
  const card = makeCard();
  card._useFah = true;
  card._settings = { setpoint_differential: 0, setpoint_differential_unit: "F" };
  assert.equal(card._deadbandViolated(65, 65.5), false);
});

check("works in Celsius display too (2°C deadband, exactly 2°C apart)", () => {
  const card = makeCard();
  card._useFah = false;
  card._settings = { setpoint_differential: 2, setpoint_differential_unit: "C" };
  assert.equal(card._deadbandViolated(20, 22), false);
  assert.equal(card._deadbandViolated(20, 21), true);
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("all checks passed");
