// Regression test: the tag-editor CSS rules must exist in the card source.
//
// Bug (v1.0.89): the tag-editor markup/render referenced .az-tag-chip,
// .az-tags-selected, .az-tags-available and .az-tag-add-row, but the CSS rule
// block that styles them was never added (a silently-failed edit). The chips
// therefore rendered as unstyled bare text ("away ×") — looked broken.
//
// This test asserts that every tag-editor class *referenced* in the card has a
// corresponding CSS *rule definition* (`.class {`) in the same file. It fails if
// any styling block goes missing again. Dependency-free; reads the source only.
//
// Run: node tests/card/test_tag_editor_css.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CARD = resolve(__dirname, "../../custom_components/airzone_cloud/airzone-schedules-card.js");
const src = readFileSync(CARD, "utf8");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok -", name); }
  catch (e) { failures++; console.error("  FAIL -", name, "\n   ", e.message); }
}

console.log("test_tag_editor_css:");

// Classes that style the tag editor. Each MUST have a `.<class> {` rule.
const REQUIRED_RULES = [
  "az-tag-chip",
  "az-tags-selected",
  "az-tags-available",
  "az-tag-add-row",
];

for (const cls of REQUIRED_RULES) {
  check(`CSS rule for .${cls} exists`, () => {
    // Match a rule definition: `.az-tag-chip {`  (allow `.az-tag-chip.add {` etc.
    // by anchoring on the class token followed eventually by `{` on a CSS line).
    const re = new RegExp(`\\.${cls}\\b[^\\n{]*\\{`);
    assert.ok(re.test(src), `no CSS rule "\\.${cls} { ... }" found in card source`);
  });
}

// The selected-chip remove affordance must be styled too (added in the redesign).
check("CSS rule for .az-tag-x (remove button) exists", () => {
  assert.ok(/\.az-tag-x\b[^\n{]*\{/.test(src), "no CSS rule for .az-tag-x found");
});

// Guard against the inverse drift: every class referenced in a class="az-tag…"
// or class="az-tags…" attribute in the source should have a rule. This is the
// general check that would have caught the original bug regardless of name.
check("every az-tag*/az-tags* class used in markup has a CSS rule", () => {
  const used = new Set();
  // class="...": collect az-tag* / az-tags* tokens from class attributes & template strings
  const classAttrRe = /class=(?:"|`|\\")([^"`]*?)(?:"|`|\\")/g;
  let m;
  while ((m = classAttrRe.exec(src)) !== null) {
    for (const tok of m[1].split(/\s+/)) {
      if (/^az-tags?(-|$)/.test(tok)) used.add(tok);
    }
  }
  const missing = [];
  for (const cls of used) {
    const re = new RegExp(`\\.${cls}\\b[^\\n{]*\\{`);
    if (!re.test(src)) missing.push(cls);
  }
  assert.deepEqual(missing, [], `classes used in markup but never styled: [${missing.join(", ")}]`);
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("all checks passed");
