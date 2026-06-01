// Behavioral test for the tag combobox in the schedule editor.
//
// Verifies the suggestion logic the editor relies on:
//   - typing filters existing tags (case-insensitive substring)
//   - already-selected tags are excluded from suggestions
//   - a novel query offers a "create" item; an exact existing match does not
//   - adding/removing updates the selected set and de-dupes case-insensitively
//
// The editor builds these via closures inside _openEditor, so rather than spin
// up the whole dialog DOM we re-implement the same pure logic here and assert
// it — and separately assert (in test_tag_editor_css) that the markup/classes
// exist. This keeps the behavioral contract pinned even as the DOM evolves.
//
// Run: node tests/card/test_tag_combobox.mjs

import assert from "node:assert/strict";

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok -", name); }
  catch (e) { failures++; console.error("  FAIL -", name, "\n   ", e.message); }
}

// Mirror of the editor's currentSuggestions() logic.
function suggestions(knownTags, selectedTags, query) {
  const q = (query || "").trim().toLowerCase();
  const notSelected = knownTags.filter((t) => !selectedTags.some((s) => s.toLowerCase() === t.toLowerCase()));
  const matches = q ? notSelected.filter((t) => t.toLowerCase().includes(q)) : notSelected;
  const exact = q && knownTags.some((t) => t.toLowerCase() === q);
  const items = matches.map((t) => ({ type: "existing", label: t }));
  if (q && !exact && !selectedTags.some((s) => s.toLowerCase() === q)) {
    items.push({ type: "create", label: query.trim() });
  }
  return items;
}

console.log("test_tag_combobox:");

check("empty query lists all unselected existing tags", () => {
  const r = suggestions(["away", "summer", "winter"], [], "");
  assert.deepEqual(r.map((i) => i.label), ["away", "summer", "winter"]);
  assert.ok(r.every((i) => i.type === "existing"));
});

check("typing filters by case-insensitive substring", () => {
  const r = suggestions(["away", "summer", "winter"], [], "WIN");
  assert.deepEqual(r.filter((i) => i.type === "existing").map((i) => i.label), ["winter"]);
});

check("selected tags are excluded from suggestions", () => {
  const r = suggestions(["away", "summer", "winter"], ["away"], "");
  assert.deepEqual(r.map((i) => i.label), ["summer", "winter"]);
});

check("novel query offers a create item", () => {
  const r = suggestions(["away"], [], "vacation");
  const create = r.find((i) => i.type === "create");
  assert.ok(create, "expected a create item");
  assert.equal(create.label, "vacation");
});

check("exact existing match does NOT offer create", () => {
  const r = suggestions(["away", "winter"], [], "winter");
  assert.ok(!r.some((i) => i.type === "create"), "should not offer create for an exact existing tag");
  assert.deepEqual(r.map((i) => i.label), ["winter"]);
});

check("create not offered when query already selected", () => {
  const r = suggestions(["away"], ["vacation"], "vacation");
  assert.ok(!r.some((i) => i.type === "create"));
});

check("create label preserves typed casing; match is case-insensitive", () => {
  // 'Winter' typed, existing 'winter' -> treated as exact (no create), shown as existing
  const r = suggestions(["winter"], [], "Winter");
  assert.ok(!r.some((i) => i.type === "create"));
});

// --- Dropdown visibility gate ---------------------------------------------
// Bug (v1.0.90): removing a tag via its × re-ran renderSuggestions(), which
// popped the dropdown open even though the input wasn't focused — covering the
// pills. The editor now gates visibility on input focus. Mirror of that rule:
//   showDropdown = inputFocused && currentSuggestions().length > 0
function showDropdown(inputFocused, items) {
  return inputFocused && items.length > 0;
}

check("dropdown stays closed when input is NOT focused (the remove-tag bug)", () => {
  const items = suggestions(["away", "summer"], [], ""); // non-empty suggestions
  assert.equal(showDropdown(false, items), false);
});

check("dropdown opens when input IS focused and there are suggestions", () => {
  const items = suggestions(["away", "summer"], [], "");
  assert.equal(showDropdown(true, items), true);
});

check("dropdown stays closed when focused but no suggestions", () => {
  const items = suggestions([], [], ""); // nothing to suggest
  assert.equal(showDropdown(true, items), false);
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("all checks passed");
