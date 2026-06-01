// Regression test for the schedule-tag FILTER CHIPS in airzone-schedules-card.js.
//
// Bug (v1.0.88): the "TAGS:" filter row was only populated by _renderTagFilters()
// from connectedCallback (when _schedules is still empty) and from _setUnit /
// the "All" chip handler. It was NOT refreshed by _renderList(), which is what
// runs after _loadSchedules() fetches the schedules. Result: on a normal load the
// row rendered once with no schedules -> "No tags yet" -> and never updated to
// show the tags that actually exist (e.g. the migrated "away" tag), even though
// per-row tag badges and _allTags() were correct.
//
// This test drives the real card source with a minimal DOM stub. It asserts that
// after schedules are present and _renderList() runs, the filter row exposes a
// chip per distinct tag. It FAILS before the fix (no chips) and PASSES after.
//
// Run: node tests/card/test_tag_filters.mjs   (also wired into run_card_tests.mjs)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CARD = resolve(__dirname, "../../custom_components/airzone_cloud/airzone-schedules-card.js");

// --- Minimal DOM stubs -----------------------------------------------------
// Only what the card touches in the constructor + _renderList + _renderTagFilters.
class FakeClassList {
  constructor() { this._s = new Set(); }
  add(c) { this._s.add(c); }
  remove(c) { this._s.delete(c); }
  toggle(c, on) { if (on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); return on; }
  contains(c) { return this._s.has(c); }
}

// A tiny element that can hold innerHTML and answer querySelector/querySelectorAll
// against buttons it "rendered" from innerHTML (we parse button text crudely).
class FakeEl {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this._html = "";
    this.children = [];      // parsed pseudo-children from innerHTML (buttons)
    this.appended = [];      // real appendChild children
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this._attrs = {};
    this._listeners = {};
    this.textContent = "";
  }
  set innerHTML(v) {
    this._html = String(v);
    // Parse <button ... data-tag="X">LABEL</button> occurrences into child nodes
    this.children = [];
    const re = /<button[^>]*?(?:data-tag="([^"]*)")?[^>]*>([\s\S]*?)<\/button>/g;
    let m;
    while ((m = re.exec(this._html)) !== null) {
      const b = new FakeEl("button");
      b.dataset.tag = m[1] !== undefined ? m[1] : undefined;
      // strip nested tags from label to get text
      b.textContent = m[2].replace(/<[^>]*>/g, "").trim();
      this.children.push(b);
    }
  }
  get innerHTML() { return this._html; }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k]; }
  appendChild(c) { this.appended.push(c); return c; }
  querySelector(sel) {
    const hit = this.querySelectorAll(sel)[0];
    if (hit) return hit;
    // Per-row wiring in _renderList does el.querySelector('.az-edit').addEventListener(...)
    // for many controls. Return a tolerant no-op element so that wiring can't crash
    // the render — this test only cares about the tag-filter row, not row internals.
    return new FakeEl("div");
  }
  querySelectorAll(sel) {
    if (sel === "button" || sel === ".az-filter-btn") return this.children.filter((c) => c.tagName === "BUTTON");
    return [];
  }
  addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); }
  click() { (this._listeners.click || []).forEach((fn) => fn({})); }
}

function makeCard() {
  // Registry of elements the card looks up by id selector.
  const els = {
    "#az-tag-filters": new FakeEl("span"),
    "#az-tab-schedules": new FakeEl("div"),
  };
  // Base HTMLElement stub the card class extends.
  const HTMLElementStub = class {
    constructor() { this.classList = new FakeClassList(); }
    querySelector(sel) {
      if (els[sel]) return els[sel];
      return null;
    }
    querySelectorAll() { return []; }
    addEventListener() {}
    appendChild() {}
  };

  const sandbox = {
    HTMLElement: HTMLElementStub,
    customElements: { get: () => undefined, define: () => {} },
    window: {},
    document: { addEventListener() {}, createElement: () => new FakeEl() },
    localStorage: { getItem: () => null, setItem() {} },
    console,
    setTimeout,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  // Expose the class instance for testing: append a line that stashes the ctor.
  const src = readFileSync(CARD, "utf8") + "\n;globalThis.__AZ = AirzoneSchedulesCard;";
  vm.runInContext(src, sandbox, { filename: "airzone-schedules-card.js" });
  const Cls = sandbox.__AZ || sandbox.globalThis?.__AZ;
  assert.ok(Cls, "card class should be defined");
  const card = new Cls();
  card._hass = {};
  return { card, els };
}

// --- The test --------------------------------------------------------------
let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok -", name); }
  catch (e) { failures++; console.error("  FAIL -", name, "\n   ", e.message); }
}

console.log("test_tag_filters:");

check("_renderList populates tag filter chips from schedule tags", () => {
  const { card } = makeCard();
  // Simulate schedules having loaded (as _loadSchedules sets them), one tagged.
  card._schedules = [
    { id: "1", name: "Day", tags: [] },
    { id: "2", name: "Away", tags: ["away"] },
    { id: "3", name: "Night", tags: [] },
  ];
  // This is the call that runs after a real load.
  card._renderList();

  const wrap = card.querySelector("#az-tag-filters");
  const labels = wrap.querySelectorAll("button").map((b) => b.textContent.trim());
  // Expect an "All" chip plus a chip for the distinct "away" tag.
  assert.ok(labels.includes("away"), `expected an "away" filter chip, got: [${labels.join(", ")}]`);
  assert.ok(labels.includes("All"), `expected an "All" chip, got: [${labels.join(", ")}]`);
});

check("_renderList reflects multiple distinct tags, sorted & deduped", () => {
  const { card } = makeCard();
  card._schedules = [
    { id: "1", name: "A", tags: ["winter", "away"] },
    { id: "2", name: "B", tags: ["away"] },
    { id: "3", name: "C", tags: ["summer"] },
  ];
  card._renderList();
  const wrap = card.querySelector("#az-tag-filters");
  const labels = wrap.querySelectorAll("button").map((b) => b.textContent.trim()).filter((t) => t !== "All");
  assert.deepEqual(labels, ["away", "summer", "winter"], `got: [${labels.join(", ")}]`);
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("all checks passed");
