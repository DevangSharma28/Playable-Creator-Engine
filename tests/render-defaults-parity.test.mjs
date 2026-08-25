// Mechanically enforces that the editor's preview and the runtime renderer
// agree on every *default*, not just on the geometry formulas.
//
// tests/geometry-parity.test.mjs guards the fenced geometry. This file
// guards the other half of the same contract — the `?? fallback` on every
// schema field — because that is where the original fontSizePct bug
// actually lived. `(d.fontSizePct || 4)` in the editor against
// `(d.fontSizePct ?? 4)` in the runtime meant an authored 0 previewed as
// 4% and shipped as 0px: text that looked fine to the designer and was
// invisible in the ad. Nothing was checking for it, and the same trap sat
// under every `|| "#color"` in the file.
//
// Two guarantees:
//   1. Neither render path uses `||` to default a schema field. `||`
//      swallows every falsy authored value (0, ""), `??` swallows only
//      null/undefined, and only the second is what "no value was set"
//      means.
//   2. Where both files default the same field, they default it to the
//      same literal.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const EDITOR_PATH = "tools/ui-editor.html";
const RUNTIME_PATH = "src/engine/ui/UILayout.ts";

/** The region of each file that actually builds element DOM — the only place these defaults matter. */
function renderRegion(path, startMarker, endMarker) {
  const src = readFileSync(path, "utf8");
  const start = src.indexOf(startMarker);
  assert.notEqual(start, -1, `${path}: could not find "${startMarker}" — this test's anchors need updating`);
  const end = endMarker ? src.indexOf(endMarker, start) : src.length;
  assert.notEqual(end, -1, `${path}: could not find "${endMarker}" after "${startMarker}"`);
  return src.slice(start, end);
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Every `<obj>.<field> ?? <literal>` default in a chunk of source, as a
 * map of field -> set of literals.
 *
 * Restricted to the `data.`/`d.` receivers both files use for element
 * data, so unrelated nullish coalescing on locals or nested objects can't
 * masquerade as a schema default.
 */
function extractDefaults(src) {
  const found = new Map();
  const pattern = /\b(?:data|d)\.([A-Za-z_$][\w$]*)\s*\?\?\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?[\d.]+|true|false)/g;
  for (const match of stripComments(src).matchAll(pattern)) {
    const [, field, literal] = match;
    const normalized = literal.replace(/^'(.*)'$/, '"$1"');
    if (!found.has(field)) found.set(field, new Set());
    found.get(field).add(normalized);
  }
  return found;
}

/** Any `<obj>.<field> || <literal>` — the operator that caused the original bug. */
function extractOrDefaults(src) {
  const found = [];
  const pattern = /\b(?:data|d)\.([A-Za-z_$][\w$]*)\s*\|\|\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?[\d.]+)/g;
  for (const match of stripComments(src).matchAll(pattern)) found.push(`${match[1]} || ${match[2]}`);
  return found;
}

const editorRender = renderRegion(EDITOR_PATH, "function applyBoxStyle(", "function renderCanvas(");
const runtimeRender = renderRegion(RUNTIME_PATH, "private applyBoxStyle(", "private wireStates(");

describe("render-path defaults", () => {
  test("neither render path defaults a schema field with ||", () => {
    const editorOffenders = extractOrDefaults(editorRender);
    const runtimeOffenders = extractOrDefaults(runtimeRender);
    const message = [
      "`||` treats every falsy authored value as absent, so an explicit 0",
      'or "" silently becomes the fallback. That is exactly the',
      "fontSizePct bug: it previewed at 4% here and shipped at 0px.",
      "Use `??`, which only defaults null/undefined.",
      "",
      `${EDITOR_PATH}: ${editorOffenders.join(", ") || "(none)"}`,
      `${RUNTIME_PATH}: ${runtimeOffenders.join(", ") || "(none)"}`,
    ].join("\n");
    assert.deepEqual([...editorOffenders, ...runtimeOffenders], [], message);
  });

  test("shared fields default to the same literal on both sides", () => {
    const editor = extractDefaults(editorRender);
    const runtime = extractDefaults(runtimeRender);

    const shared = [...editor.keys()].filter((field) => runtime.has(field));
    assert.ok(shared.length > 12, `expected the two render paths to share many defaulted fields, found only ${shared.length} — the extraction anchors are probably wrong`);

    const mismatches = [];
    for (const field of shared) {
      const a = [...editor.get(field)].sort().join(" | ");
      const b = [...runtime.get(field)].sort().join(" | ");
      if (a !== b) mismatches.push(`${field}: editor uses ${a}, runtime uses ${b}`);
    }
    assert.deepEqual(mismatches, [], "the editor preview and the shipped render disagree on these defaults:\n" + mismatches.join("\n"));
  });

  /**
   * Fields the runtime defaults that the editor's *render* path
   * legitimately never reads, with the reason. Keep this list short and
   * justified — every entry is a place the preview is knowingly not the
   * shipped result, which is the thing this whole suite exists to prevent.
   */
  const EDITOR_RENDER_EXEMPT = {
    loop: "the editor previews a video's poster frame, never plays it — a looping clip behind the element you're positioning is a distraction, and a data-URI video would re-decode on every pointermove of a drag",
    muted: "same as loop: playback flags only matter once the video actually plays, which the editor deliberately never does",
    autoplay: "same as loop",
  };

  test("every field defaulted by the runtime is also defaulted by the editor", () => {
    const editor = extractDefaults(editorRender);
    const runtime = extractDefaults(runtimeRender);
    // A field the runtime defaults but the editor doesn't means the editor
    // is previewing `undefined` where the ad will show a real value.
    const missing = [...runtime.keys()].filter((field) => !editor.has(field) && !(field in EDITOR_RENDER_EXEMPT));
    assert.deepEqual(missing, [], `the runtime defaults these fields but the editor's preview doesn't: ${missing.join(", ")}`);
  });

  test("every exemption is still real — an exempt field must still be defaulted by the runtime", () => {
    // Stops the exemption list rotting into a place where stale entries
    // hide genuine new divergence.
    const runtime = extractDefaults(runtimeRender);
    const stale = Object.keys(EDITOR_RENDER_EXEMPT).filter((field) => !runtime.has(field));
    assert.deepEqual(stale, [], `these fields are exempted but the runtime no longer defaults them — drop them from the list: ${stale.join(", ")}`);
  });
});

describe("stacking order", () => {
  test("both files rank z-index through buildStackRanks rather than emitting a raw float", () => {
    // CSS z-index is `auto | <integer>`; a fractional value is invalid and
    // dropped. renderOrder is authored as 0, 0.1, 0.2 …, so emitting it
    // directly silently removed the z-index from every element after the
    // first, in both the preview and the shipped playable.
    for (const path of [EDITOR_PATH, RUNTIME_PATH]) {
      const src = stripComments(readFileSync(path, "utf8"));
      assert.ok(/function buildStackRanks|buildStackRanks\(/.test(src), `${path} must derive integer stacking ranks (buildStackRanks)`);
      assert.ok(
        !/zIndex\s*=\s*[`"']?\$?\{?\s*(?:data|d)\.renderOrder\s*\?\?/.test(src),
        `${path} assigns a raw renderOrder to z-index — a fractional value is invalid CSS and will be dropped`
      );
    }
  });
});
