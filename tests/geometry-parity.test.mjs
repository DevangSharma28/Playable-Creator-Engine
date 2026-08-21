// Enforces ENGINE.md's "ui/UILayout.ts" contract mechanically: these two
// files' GEOMETRY fences (src/engine/ui/UILayout.ts, tools/ui-editor.html)
// must compute IDENTICAL numbers, not just look similar. See
// tests/lib/geometry-source.mjs for the extraction/normalization
// machinery this file drives.
//
// Three layers:
//   1. Structural drift  — do the two fenced formulas read the same, once
//      normalized for the differences they're allowed to have?
//   2. Numeric parity    — do they compute the exact same bits across a
//      dense viewport/design/element/parent-box matrix? (Object.is, not
//      an epsilon — see the header note below for why.)
//   3. Runtime-only property tests — invariants the formulas are supposed
//      to guarantee regardless of what the editor's copy does, so they
//      keep proving something even if both sides drifted together.
//
// Why exact equality, not an epsilon: rewriting `(el.width / 100) *
// parentW` to the mathematically identical `parentW * el.width / 100`
// produces real divergence in IEEE-754 double arithmetic (verified while
// building this suite — e.g. 1003.1999999999999 vs 1003.2). An epsilon
// comparison would pass that silently. ENGINE.md's requirement is
// "reproduce it exactly, not be an equivalent system" — so exact equality
// is the correct assertion strength, and float-associativity drift is a
// genuine finding here, not test noise.

import assert from "node:assert/strict";
import { test } from "node:test";
import { extractGeometryBlock, geometryFingerprint, loadEditorGeometry, loadRuntimeGeometry } from "./lib/geometry-source.mjs";

const EDITOR_PATH = "tools/ui-editor.html";
const RUNTIME_PATH = "src/engine/ui/UILayout.ts";

/* ------------------------------------------------------------------ */
/*  Layer 1 — structural drift                                         */
/* ------------------------------------------------------------------ */

test("Layer 1: GEOMETRY fences are structurally identical after normalization", () => {
  const editorBlock = extractGeometryBlock(EDITOR_PATH);
  const runtimeBlock = extractGeometryBlock(RUNTIME_PATH);
  const editorFp = geometryFingerprint(editorBlock);
  const runtimeFp = geometryFingerprint(runtimeBlock);

  if (editorFp.hash === runtimeFp.hash) return;

  const a = editorFp.normalized;
  const b = runtimeFp.normalized;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const context = 70;
  const aCtx = a.slice(Math.max(0, i - context), i + context);
  const bCtx = b.slice(Math.max(0, i - context), i + context);

  assert.fail(
    [
      `${EDITOR_PATH}'s and ${RUNTIME_PATH}'s GEOMETRY fences no longer normalize to the same text.`,
      `First difference at normalized character ${i}:`,
      `  editor : ...${aCtx}...`,
      `  runtime: ...${bCtx}...`,
      `ENGINE.md's "ui/UILayout.ts" section requires changing the same formula in both files together — either this is a real, deliberate divergence that needs a decision, or one side changed without the other.`,
    ].join("\n")
  );
});

/* ------------------------------------------------------------------ */
/*  Layer 2 — numeric parity                                           */
/* ------------------------------------------------------------------ */

// Real sizes, not round numbers — see the task brief this suite was built
// against for why each group is here.
const VIEWPORTS = [
  // Poki's mandated 16:9 targets
  [640, 360], [836, 470], [1031, 580],
  // CrazyGames windowed
  [907, 510], [1216, 684], [1077, 606], [821, 462],
  // CrazyGames fullscreen
  [1280, 720], [1366, 768], [1536, 864], [1920, 1080],
  // CrazyGames mobile / tablet
  [800, 450], [1080, 607],
  // Extremes — regression anchors for the old fixed-resolution "stage" bug
  [360, 800], [320, 900], [500, 500], [3440, 1440], [2560, 600], [300, 1200],
];

const DESIGN_RESOLUTIONS = [
  [1080, 1920], // portrait
  [1920, 1080], // landscape
  [1031, 580], // non-round
];

// "Parent box" scale relative to the top-level container — 1 = the
// container itself, the other two simulate nested-group live boxes
// (elemScreenWidth/Height/X/Y take rectW/rectH generically and don't care
// whether that rect came from the canvas or a group's own resolved box).
const PARENT_SCALES = [
  { label: "container", scale: 1 },
  { label: "nested-group(0.5)", scale: 0.5 },
  { label: "nested-group(0.337)", scale: 0.337 },
];

const ELEMENTS = [
  { name: "full-bleed-bg", type: "rect", anchor: "top-left", xUnit: "pct", yUnit: "pct", widthUnit: "pct", heightUnit: "pct", xPct: 0, yPct: 0, widthPct: 100, heightPct: 100, fontSizePct: 4 },
  { name: "joystick-px-square", type: "joystick", anchor: "bottom-left", xUnit: "px", yUnit: "px", widthUnit: "px", heightUnit: "px", xPx: 32, yPx: 32, widthPx: 120, heightPx: 120, aspectRatio: 1, fontSizePct: 4 },
  { name: "mixed-units", type: "image", anchor: "middle-center", xUnit: "px", yUnit: "pct", widthUnit: "pct", heightUnit: "px", xPx: 12, yPct: 30, widthPct: 40, heightPx: 55, fontSizePct: 4 },
  { name: "fractional", type: "rect", anchor: "top-center", xUnit: "pct", yUnit: "pct", widthUnit: "pct", heightUnit: "pct", xPct: 33.333, yPct: 41.7, widthPct: 87.9, heightPct: 41.7, fontSizePct: 4 },
  { name: "out-of-range", type: "rect", anchor: "middle-left", xUnit: "pct", yUnit: "pct", widthUnit: "pct", heightUnit: "pct", xPct: -10, yPct: 50, widthPct: 110, heightPct: 120, fontSizePct: 4 },
  { name: "all-zero", type: "rect", anchor: "top-left", xUnit: "px", yUnit: "px", widthUnit: "px", heightUnit: "px", xPx: 0, yPx: 0, widthPx: 0, heightPx: 0, fontSizePct: 0 },
  { name: "sub-pixel", type: "text", anchor: "top-left", xUnit: "pct", yUnit: "pct", widthUnit: "px", heightUnit: "pct", xPct: 0, yPct: 0, widthPx: 1, heightPct: 1, fontSizePct: 0.1 },
  { name: "fontSizePct-omitted", type: "text", anchor: "middle-center", xUnit: "pct", yUnit: "pct", widthUnit: "pct", heightUnit: "pct", xPct: 50, yPct: 50, widthPct: 20, heightPct: 10 },
  { name: "locked-aspect-non-joystick", type: "image", anchor: "middle-center", xUnit: "pct", yUnit: "pct", widthUnit: "pct", heightUnit: "pct", xPct: 50, yPct: 50, widthPct: 30, heightPct: 30, lockAspect: true, aspectRatio: 1.5, fontSizePct: 4 },
  { name: "height-px-non-locked", type: "rect", anchor: "bottom-right", xUnit: "pct", yUnit: "pct", widthUnit: "pct", heightUnit: "px", xPct: 100, yPct: 100, widthPct: 25, heightPx: 80, fontSizePct: 4 },
  // One px-positioned/px-sized element per anchor — exercises every
  // ANCHOR_FRAC entry and both pxSignX/pxSignY branches (=== 1 vs not).
  ...["top-left", "top-center", "top-right", "middle-left", "middle-center", "middle-right", "bottom-left", "bottom-center", "bottom-right"].map((anchor) => ({
    name: `anchor-${anchor}`,
    type: "rect",
    anchor,
    xUnit: "px", yUnit: "px", widthUnit: "px", heightUnit: "px",
    xPx: 15, yPx: 25, widthPx: 60, heightPx: 40,
    fontSizePct: 4,
  })),
];

const FUNCTIONS = [
  { name: "elemScreenWidth", call: (geo, d, rectW, rectH) => geo.elemScreenWidth(d, rectW) },
  { name: "elemScreenHeight", call: (geo, d, rectW, rectH) => geo.elemScreenHeight(d, rectW, rectH) },
  { name: "elemScreenX", call: (geo, d, rectW, rectH) => geo.elemScreenX(d, rectW) },
  { name: "elemScreenY", call: (geo, d, rectW, rectH) => geo.elemScreenY(d, rectH) },
  { name: "pxSignX", call: (geo, d) => geo.pxSignX(d) },
  { name: "pxSignY", call: (geo, d) => geo.pxSignY(d) },
  { name: "elemFontSizePx", call: (geo, d, rectW, rectH, liveH) => geo.elemFontSizePx(d, liveH) },
];

test("Layer 2: numeric parity across the viewport/design/element/parent matrix", async () => {
  const editor = loadEditorGeometry(EDITOR_PATH);
  const runtime = await loadRuntimeGeometry(RUNTIME_PATH);

  const failures = [];
  let checks = 0;

  for (const [designW, designH] of DESIGN_RESOLUTIONS) {
    const layout = { canvasWidth: designW, canvasHeight: designH };
    for (const [viewW, viewH] of VIEWPORTS) {
      const editorGeo = editor.make(layout, viewW, viewH);
      const runtimeGeo = runtime.make(layout, viewW, viewH);

      checks++;
      if (!Object.is(editorGeo.pxScale(), runtimeGeo.pxScale())) {
        failures.push(`pxScale @ design=${designW}x${designH} / viewport=${viewW}x${viewH}: runtime=${runtimeGeo.pxScale()} editor=${editorGeo.pxScale()}`);
      }

      for (const parent of PARENT_SCALES) {
        const rectW = viewW * parent.scale;
        const rectH = viewH * parent.scale;

        for (const el of ELEMENTS) {
          for (const fn of FUNCTIONS) {
            checks++;
            const editorVal = fn.call(editorGeo, el, rectW, rectH, viewH);
            const runtimeVal = fn.call(runtimeGeo, el, rectW, rectH, viewH);
            if (!Object.is(editorVal, runtimeVal)) {
              failures.push(
                `${fn.name} @ design=${designW}x${designH} / viewport=${viewW}x${viewH} / element=${el.name} / parent=${parent.label}: runtime=${runtimeVal} editor=${editorVal} (delta=${runtimeVal - editorVal})`
              );
            }
          }
        }
      }
    }
  }

  console.log(`Layer 2: ran ${checks} numeric checks across ${DESIGN_RESOLUTIONS.length} design resolutions × ${VIEWPORTS.length} viewports × ${PARENT_SCALES.length} parent boxes × ${ELEMENTS.length} elements × ${FUNCTIONS.length} functions.`);
  assert.ok(checks > 3000, `expected > 3000 checks to guard against a silently-degenerated matrix, got ${checks}`);

  if (failures.length > 0) {
    const shown = failures.slice(0, 25);
    const tail = failures.length > 25 ? `\n...and ${failures.length - 25} more` : "";
    assert.fail(`${failures.length} of ${checks} numeric checks diverged between editor and runtime:\n${shown.join("\n")}${tail}`);
  }
});

/* ------------------------------------------------------------------ */
/*  Layer 3 — runtime-only property tests                              */
/* ------------------------------------------------------------------ */

test("Layer 3a: a px square stays square at every viewport (pxScale is Math.min, not per-axis)", async () => {
  const runtime = await loadRuntimeGeometry(RUNTIME_PATH);
  const square = { name: "square", type: "rect", anchor: "top-left", xUnit: "px", yUnit: "px", widthUnit: "px", heightUnit: "px", xPx: 0, yPx: 0, widthPx: 88, heightPx: 88, fontSizePct: 4 };

  for (const [designW, designH] of DESIGN_RESOLUTIONS) {
    const layout = { canvasWidth: designW, canvasHeight: designH };
    for (const [viewW, viewH] of VIEWPORTS) {
      const geo = runtime.make(layout, viewW, viewH);
      const w = geo.elemScreenWidth(square, viewW);
      const h = geo.elemScreenHeight(square, viewW, viewH);
      assert.strictEqual(w, h, `square element ballooned into an oval at design=${designW}x${designH} viewport=${viewW}x${viewH}: width=${w} height=${h}`);
    }
  }
});

test("Layer 3b: a 100%x100% element resolves to exactly the parent's width and height at every aspect ratio", async () => {
  const runtime = await loadRuntimeGeometry(RUNTIME_PATH);
  const fullBleed = { name: "full-bleed", type: "rect", anchor: "top-left", xUnit: "pct", yUnit: "pct", widthUnit: "pct", heightUnit: "pct", xPct: 0, yPct: 0, widthPct: 100, heightPct: 100, fontSizePct: 4 };

  for (const [designW, designH] of DESIGN_RESOLUTIONS) {
    const layout = { canvasWidth: designW, canvasHeight: designH };
    for (const [viewW, viewH] of VIEWPORTS) {
      for (const parent of PARENT_SCALES) {
        const rectW = viewW * parent.scale;
        const rectH = viewH * parent.scale;
        const geo = runtime.make(layout, viewW, viewH);
        const w = geo.elemScreenWidth(fullBleed, rectW);
        const h = geo.elemScreenHeight(fullBleed, rectW, rectH);
        assert.strictEqual(w, rectW, `100% width didn't reach the real parent edge at viewport=${viewW}x${viewH} parent=${parent.label}`);
        assert.strictEqual(h, rectH, `100% height didn't reach the real parent edge at viewport=${viewW}x${viewH} parent=${parent.label}`);
      }
    }
  }
});

test("Layer 3c: font size at a fixed height is width-independent and equals fontSizePct/100 * height", async () => {
  const runtime = await loadRuntimeGeometry(RUNTIME_PATH);
  const layout = { canvasWidth: 1080, canvasHeight: 1920 };
  const text = { name: "label", type: "text", anchor: "middle-center", xUnit: "pct", yUnit: "pct", widthUnit: "pct", heightUnit: "pct", xPct: 50, yPct: 50, widthPct: 50, heightPct: 10, fontSizePct: 6.5 };
  const fixedHeight = 800;

  const geoNarrow = runtime.make(layout, 400, fixedHeight);
  const geoWide = runtime.make(layout, 3000, fixedHeight);

  const sizeNarrow = geoNarrow.elemFontSizePx(text, fixedHeight);
  const sizeWide = geoWide.elemFontSizePx(text, fixedHeight);
  const expected = (text.fontSizePct / 100) * fixedHeight;

  assert.strictEqual(sizeNarrow, sizeWide, `font size at fixed height ${fixedHeight} differed between width=400 (${sizeNarrow}) and width=3000 (${sizeWide}) — it must depend only on height, never pxScale()`);
  assert.strictEqual(sizeNarrow, expected, `font size at height ${fixedHeight} was ${sizeNarrow}, expected fontSizePct/100 * height = ${expected}`);
});
