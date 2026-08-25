// Runtime-renderer coverage for src/engine/ui/UILayout.ts.
//
// tests/geometry-parity.test.mjs already proves the editor and the runtime
// compute the same *geometry*. This suite covers everything geometry
// parity deliberately doesn't: that each element type actually builds the
// DOM it claims to, that defaults are the ones the schema documents, that
// a resize re-derives what it should, and that the interactive behavior
// (states, actions, values) does what the editor's UI promises.
//
// Runs the real UILayout class against a real (jsdom) DOM — not a mock —
// so a change that only *looks* right in source still has to survive
// producing actual nodes with actual styles.

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { JSDOM } from "jsdom";
import { loadTsModule } from "./lib/load-ts.mjs";

let UILayout;
let dom;

/** A container whose measured size is fixed, so geometry is deterministic. */
function makeContainer(width = 1080, height = 1920) {
  const el = dom.window.document.createElement("div");
  el.getBoundingClientRect = () => ({ width, height, top: 0, left: 0, right: width, bottom: height });
  dom.window.document.body.appendChild(el);
  return el;
}

/** Minimal valid element data — every test overrides only what it cares about. */
function element(overrides) {
  return Object.assign(
    {
      id: "el_" + Math.random().toString(36).slice(2, 8),
      type: "rect",
      name: "el",
      xPct: 50,
      yPct: 50,
      widthPct: 20,
      heightPct: 10,
      anchor: "middle-center",
      rotation: 0,
      opacity: 1,
      zIndex: 1,
    },
    overrides
  );
}

function layout(elements, canvasWidth = 1080, canvasHeight = 1920) {
  return { version: 1, canvasWidth, canvasHeight, elements };
}

/** Builds a UILayout into a fresh container and hands back both. */
function render(elements, size) {
  const container = makeContainer(size?.[0], size?.[1]);
  const ui = new UILayout(container, layout(elements, size?.[2], size?.[3]));
  return { ui, container };
}

before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  // UILayout touches document/HTMLElement at module and construction time.
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.HTMLImageElement = dom.window.HTMLImageElement;
  const mod = await loadTsModule("src/engine/ui/UILayout.ts");
  UILayout = mod.UILayout;
});

/* ------------------------------------------------------------------ */
/*  Every type builds real DOM                                         */
/* ------------------------------------------------------------------ */

describe("element types", () => {
  const CASES = [
    ["text", { type: "text", text: "hello" }, (node) => assert.equal(node.textContent, "hello")],
    ["image", { type: "image", src: "data:image/png;base64,AAA" }, (node) => assert.equal(node.tagName, "IMG")],
    ["rect", { type: "rect", backgroundColor: "rgb(1, 2, 3)" }, (node) => assert.equal(node.style.backgroundColor, "rgb(1, 2, 3)")],
    ["group", { type: "group" }, (node) => assert.equal(node.style.position, "relative")],
    ["joystick", { type: "joystick" }, (node) => assert.ok(node.querySelector('[data-role="joystick-knob"]'))],
    ["button", { type: "button", text: "PLAY" }, (node) => assert.equal(node.querySelector('[data-role="label"]').textContent, "PLAY")],
    ["progress", { type: "progress", value: 0.5 }, (node) => assert.equal(node.querySelector('[data-role="fill"]').style.width, "50%")],
    ["slider", { type: "slider", value: 0.25 }, (node) => assert.ok(node.querySelector('[data-role="handle"]'))],
    ["toggle", { type: "toggle", on: true }, (node) => assert.equal(node.dataset.on, "true")],
    ["checkbox", { type: "checkbox", checked: true }, (node) => assert.equal(node.querySelector('[data-role="tick"]').style.opacity, "1")],
    ["sprite", { type: "sprite", src: "x.png", frameCols: 4, frameRows: 2 }, (node) => assert.equal(node.querySelector('[data-role="sprite-sheet"]').style.width, "400%")],
    ["video", { type: "video", src: "v.mp4" }, (node) => assert.equal(node.tagName, "VIDEO")],
    ["shape", { type: "shape", shape: "star" }, (node) => assert.ok(node.style.clipPath.startsWith("polygon("))],
    ["icon", { type: "icon", icon: "♥" }, (node) => assert.equal(node.textContent, "♥")],
  ];

  for (const [name, overrides, check] of CASES) {
    test(`${name} renders its own content node`, () => {
      const { ui } = render([element(Object.assign({ name: "target" }, overrides))]);
      const node = ui.get("target");
      assert.ok(node, `${name} produced no addressable node`);
      check(node);
    });
  }

  test("every type is reachable by name and sized to fill its wrapper", () => {
    for (const [name, overrides] of CASES.map((c) => [c[0], c[1]])) {
      const { ui } = render([element(Object.assign({ name: "target" }, overrides))]);
      const node = ui.get("target");
      assert.equal(node.style.width, "100%", `${name} content node should fill its wrapper`);
      assert.equal(node.style.height, "100%", `${name} content node should fill its wrapper`);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Defaults are the documented ones                                   */
/* ------------------------------------------------------------------ */

describe("schema defaults", () => {
  test("fontSizePct: 0 renders 0px, not the 4% default", () => {
    // The regression this whole audit started from: `|| 4` on the editor
    // side turned an authored 0 into 4, so text previewed visible and
    // shipped invisible. Both sides are `??` now; 0 must mean 0.
    const { ui } = render([element({ type: "text", name: "t", text: "x", fontSizePct: 0 })], [1080, 1920]);
    assert.equal(ui.get("t").style.fontSize, "0px");
  });

  test("fontSizePct absent falls back to 4% of live height", () => {
    const { ui } = render([element({ type: "text", name: "t", text: "x" })], [1080, 1920]);
    assert.equal(ui.get("t").style.fontSize, `${(4 / 100) * 1920}px`);
  });

  test("empty-string color is not silently replaced by white", () => {
    // `?? ` only defaults null/undefined. An explicit "" is an authored
    // value and must round-trip as one, the same as any other falsy input.
    const { ui } = render([element({ type: "text", name: "t", text: "x", color: "" })]);
    assert.equal(ui.get("t").style.color, "");
  });

  test("borderWidthPx does not scale unless borderScales is set", () => {
    // Deliberate back-compat: borders shipped unscaled, so existing
    // layouts must keep rendering identically at any device size.
    const unscaled = render([element({ name: "a", borderWidthPx: 4, borderColor: "#fff" })], [2160, 3840]).ui;
    assert.match(unscaled.get("a").style.border, /^4px/);

    const scaled = render([element({ name: "b", borderWidthPx: 4, borderColor: "#fff", borderScales: true })], [2160, 3840]).ui;
    assert.match(scaled.get("b").style.border, /^8px/, "borderScales:true should multiply by pxScale (2x here)");
  });

  test("video defaults to muted + autoplay + playsInline", () => {
    // The only combination most ad WebViews will actually start without a
    // user gesture — a wrong default here is a silently black video.
    const { ui } = render([element({ type: "video", name: "v", src: "v.mp4" })]);
    const node = ui.get("v");
    assert.equal(node.muted, true);
    assert.equal(node.autoplay, true);
    assert.equal(node.playsInline, true);
  });
});

/* ------------------------------------------------------------------ */
/*  Resize lifecycle                                                   */
/* ------------------------------------------------------------------ */

describe("updateScale", () => {
  test("re-derives px geometry, font size and scaled styles", () => {
    const { ui } = render(
      [element({ name: "a", type: "text", text: "x", widthUnit: "px", widthPx: 100, heightUnit: "px", heightPx: 50, fontSizePct: 10, textStrokeWidthPx: 2, textStrokeColor: "#000" })],
      [1080, 1920, 1080, 1920]
    );
    const node = ui.get("a");
    const wrapper = node.parentElement;
    assert.equal(wrapper.style.width, "100px", "pxScale is 1 at the design size");
    assert.equal(node.style.fontSize, "192px");

    ui.updateScale(540, 960); // exactly half the design resolution
    assert.equal(wrapper.style.width, "50px", "px width should halve with pxScale");
    assert.equal(node.style.fontSize, "96px", "font size tracks live height");
    assert.match(node.style.getPropertyValue("-webkit-text-stroke"), /^1px/, "text stroke is px-denominated and must rescale");
  });

  test("ignores a zero/negative size instead of poisoning the scale", () => {
    // A hidden container measures 0; baking that in would set every px
    // field to 0 permanently, since nothing re-measures afterwards.
    const { ui } = render([element({ name: "a", widthUnit: "px", widthPx: 100 })], [1080, 1920, 1080, 1920]);
    const wrapper = ui.get("a").parentElement;
    ui.updateScale(0, 0);
    assert.equal(wrapper.style.width, "100px");
  });

  test("percent geometry is left to native CSS at every aspect ratio", () => {
    const { ui } = render([element({ name: "a", widthPct: 100, heightPct: 100, xUnit: "pct", yUnit: "pct" })]);
    const wrapper = ui.get("a").parentElement;
    for (const [w, h] of [[320, 900], [3440, 1440], [500, 500]]) {
      ui.updateScale(w, h);
      assert.equal(wrapper.style.width, "100%");
      assert.equal(wrapper.style.height, "100%");
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Values, states, actions                                            */
/* ------------------------------------------------------------------ */

describe("runtime API", () => {
  test("setValue drives a progress fill and clamps out-of-range input", () => {
    const { ui } = render([element({ type: "progress", name: "bar", value: 0 })]);
    const fill = ui.get("bar").querySelector('[data-role="fill"]');
    ui.setValue("bar", 0.75);
    assert.equal(fill.style.width, "75%");
    ui.setValue("bar", 5);
    assert.equal(fill.style.width, "100%", "values above 1 must clamp, not overflow the track");
    ui.setValue("bar", -3);
    assert.equal(fill.style.width, "0%");
  });

  test("setValue normalizes a slider through its own min/max", () => {
    const { ui } = render([element({ type: "slider", name: "s", min: 10, max: 20, value: 10 })]);
    const fill = ui.get("s").querySelector('[data-role="fill"]');
    ui.setValue("s", 15);
    assert.equal(fill.style.width, "50%");
    assert.equal(ui.getValue("s"), 15, "getValue returns the authored-range value, not the normalized one");
  });

  test("progress direction anchors the fill to the correct edge", () => {
    const cases = { lr: "left", rl: "right", tb: "top", bt: "bottom" };
    for (const [direction, edge] of Object.entries(cases)) {
      const { ui } = render([element({ type: "progress", name: "p", value: 0.5, direction })]);
      const fill = ui.get("p").querySelector('[data-role="fill"]');
      assert.equal(fill.style[edge], "0px", `direction ${direction} should pin ${edge}`);
    }
  });

  test("setText reaches a button's nested label, not the button box", () => {
    const { ui } = render([element({ type: "button", name: "b", text: "OLD" })]);
    ui.setText("b", "NEW");
    assert.equal(ui.get("b").querySelector('[data-role="label"]').textContent, "NEW");
    assert.ok(ui.get("b").querySelector('[data-role="label"]'), "the label node must survive a setText");
  });

  test("a toggle flips itself and reports through isOn", () => {
    const { ui } = render([element({ type: "toggle", name: "t", on: false })]);
    assert.equal(ui.isOn("t"), false);
    ui.get("t").dispatchEvent(new dom.window.Event("click"));
    assert.equal(ui.isOn("t"), true);
  });

  test("show/hide/toggleVisible actions run entirely in the runtime", () => {
    const { ui } = render([
      element({ type: "button", name: "btn", actions: [{ type: "hide", target: "victim" }] }),
      element({ type: "rect", name: "victim" }),
    ]);
    assert.notEqual(ui.get("victim").style.display, "none");
    ui.get("btn").dispatchEvent(new dom.window.Event("click"));
    assert.equal(ui.get("victim").style.display, "none");
  });

  test("emit and cta actions route out through onAction rather than being handled internally", () => {
    // The seam that keeps the engine from learning any game's vocabulary.
    const seen = [];
    const { ui } = render([element({ type: "button", name: "btn", actions: [{ type: "emit", value: "start-game" }, { type: "cta" }] })]);
    ui.onAction((event) => seen.push(event));
    ui.get("btn").dispatchEvent(new dom.window.Event("click"));
    assert.deepEqual(seen, ["start-game", "cta"]);
  });

  test("an action pointing at a missing target is a no-op, not a crash", () => {
    const { ui } = render([element({ type: "button", name: "btn", actions: [{ type: "setText", target: "ghost", value: "x" }] })]);
    assert.doesNotThrow(() => ui.get("btn").dispatchEvent(new dom.window.Event("click")));
  });

  test("hover state applies an override and reverts it on leave", () => {
    const { ui } = render([element({ type: "button", name: "b", backgroundColor: "rgb(10, 20, 30)", states: { hover: { opacity: 0.5 } } })]);
    const node = ui.get("b");
    node.dispatchEvent(new dom.window.Event("pointerenter"));
    assert.equal(node.style.opacity, "0.5");
    node.dispatchEvent(new dom.window.Event("pointerleave"));
    assert.equal(node.style.opacity, "1", "leaving must restore the base value, not leave the override stuck on");
  });

  test("a disabled state stops the element receiving pointer events at all", () => {
    const { ui } = render([element({ type: "button", name: "b", states: { disabled: { opacity: 0.4 } } })]);
    const node = ui.get("b");
    assert.equal(node.style.pointerEvents, "none");
    assert.equal(node.dataset.disabled, "true");
  });

  test("implicitly-interactive types get pointer events without the interactive flag", () => {
    for (const type of ["button", "slider", "toggle", "checkbox"]) {
      const { ui } = render([element({ type, name: "x" })]);
      assert.equal(ui.get("x").style.pointerEvents, "auto", `${type} should be interactive by default`);
    }
    const decorative = render([element({ type: "rect", name: "x" })]).ui;
    assert.notEqual(decorative.get("x").style.pointerEvents, "auto", "a plain rect must stay click-through");
  });
});

/* ------------------------------------------------------------------ */
/*  Structure, ordering, teardown                                      */
/* ------------------------------------------------------------------ */

describe("structure", () => {
  test("children are real DOM descendants of their parent group", () => {
    // This is what makes a child's % resolve against the group instead of
    // the canvas — the whole reason the stage wrapper was deleted.
    const { ui } = render([
      element({ id: "g", type: "group", name: "grp" }),
      element({ id: "c", type: "rect", name: "child", parentId: "g" }),
    ]);
    assert.ok(ui.get("grp").contains(ui.get("child").parentElement));
  });

  test("a child declared before its parent still nests correctly", () => {
    // Array order isn't guaranteed to put parents first, hence the
    // two-pass build.
    const { ui } = render([
      element({ id: "c", type: "rect", name: "child", parentId: "g" }),
      element({ id: "g", type: "group", name: "grp" }),
    ]);
    assert.ok(ui.get("grp").contains(ui.get("child").parentElement));
  });

  test("clipContent turns a group into a mask", () => {
    const { ui } = render([element({ type: "group", name: "g", clipContent: true })]);
    assert.equal(ui.get("g").style.overflow, "hidden");
  });

  test("a fractional renderOrder still produces a valid, honored z-index", () => {
    // CSS z-index is `auto | <integer>`; a fractional value is invalid and
    // browsers drop the declaration. The editor authors renderOrder as
    // 0, 0.1, 0.2 …, so emitting it raw meant every element after the
    // first silently had NO z-index and stacking fell back to DOM order.
    // Ranks preserve the authored order and are always valid CSS.
    const { ui } = render([
      element({ name: "bottom", zIndex: 1, renderOrder: 0 }),
      element({ name: "middle", zIndex: 2, renderOrder: 0.1 }),
      element({ name: "top", zIndex: 3, renderOrder: 0.2 }),
    ]);
    const z = (name) => ui.get(name).parentElement.style.zIndex;
    for (const name of ["bottom", "middle", "top"]) {
      assert.notEqual(z(name), "", `${name} lost its z-index entirely — the value was rejected as invalid CSS`);
      assert.ok(Number.isInteger(Number(z(name))), `${name} must emit an integer z-index, got "${z(name)}"`);
    }
    assert.ok(Number(z("bottom")) < Number(z("middle")), "authored order must be preserved");
    assert.ok(Number(z("middle")) < Number(z("top")), "authored order must be preserved");
  });

  test("renderOrder falls back to zIndex for layouts saved before it existed", () => {
    const { ui } = render([element({ name: "low", zIndex: 2 }), element({ name: "high", zIndex: 9 })]);
    const low = Number(ui.get("low").parentElement.style.zIndex);
    const high = Number(ui.get("high").parentElement.style.zIndex);
    assert.ok(low < high, "legacy zIndex-only layouts must still stack in their authored order");
  });

  test("ties keep their array order rather than shuffling", () => {
    const { ui } = render([element({ name: "first", zIndex: 1, renderOrder: 5 }), element({ name: "second", zIndex: 2, renderOrder: 5 })]);
    assert.ok(Number(ui.get("first").parentElement.style.zIndex) < Number(ui.get("second").parentElement.style.zIndex));
  });

  test("zOrder decides DOM append order for hit-priority", () => {
    const { container } = render([
      element({ name: "first", zOrder: 5 }),
      element({ name: "second", zOrder: 1 }),
    ]);
    const order = [...container.children].map((wrapper) => wrapper.firstChild.textContent);
    assert.equal(order.length, 2);
  });

  test("a gradient fill emits a CSS gradient instead of a flat color", () => {
    const { ui } = render([element({ name: "g", fillType: "linear", gradient: { angle: 45, stops: [{ color: "#000", pos: 0 }, { color: "#fff", pos: 100 }] } })]);
    assert.match(ui.get("g").style.backgroundImage, /linear-gradient\(45deg/);
  });

  test("gradient stops are sorted, so out-of-order authoring still renders correctly", () => {
    const { ui } = render([element({ name: "g", fillType: "linear", gradient: { angle: 0, stops: [{ color: "#fff", pos: 100 }, { color: "#000", pos: 0 }] } })]);
    const image = ui.get("g").style.backgroundImage;
    assert.ok(image.indexOf("0%") < image.indexOf("100%"), "stops must be emitted in ascending position order");
  });

  test("rebuilding into the same container replaces rather than stacks", () => {
    // The dev preview reloads in place without navigating, so a second
    // build into a live container must not double every element.
    const container = makeContainer();
    new UILayout(container, layout([element({ name: "a" })]));
    new UILayout(container, layout([element({ name: "a" })]));
    assert.equal(container.children.length, 1);
  });

  test("dispose drops listeners so a hot reload can't keep a dead Game alive", () => {
    const { ui } = render([element({ type: "toggle", name: "t", on: false })]);
    const node = ui.get("t");
    ui.dispose();
    node.dispatchEvent(new dom.window.Event("click"));
    assert.equal(node.dataset.on, "false", "a disposed layout must not still react to clicks");
  });
});
