/**
 * Structural validation of the ION particle shaders.
 *
 * A GLSL compile error only surfaces when a real GL context tries to link
 * the program — which in practice means "the one render mode nobody tested
 * in a browser is silently broken". That is exactly what happened: the
 * mesh variant declared `mvPosition` twice, because the mesh block ended
 * in a `return` and the billboard block after it was left unguarded. The
 * preprocessor only strips a *false* branch, so both declarations survived
 * into one scope and mesh mode never compiled.
 *
 * This runs the real `#ifdef`/`#else`/`#endif` structure for every define
 * combination the renderer can actually produce, and asserts each one
 * preprocesses to something a compiler would accept. It can't catch a type
 * error inside a line, but it catches the whole class of "this variant
 * doesn't even parse" bug without needing a GPU.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE = readFileSync(join(ROOT, "src", "engine", "particles", "ParticleMaterial.ts"), "utf8");

function extractShader(name) {
  const match = new RegExp("const " + name + " = /\\* glsl \\*/ `([\\s\\S]*?)`;").exec(SOURCE);
  assert.ok(match, `could not find ${name} in ParticleMaterial.ts`);
  return match[1];
}

/**
 * Minimal C-preprocessor for the subset these shaders use.
 *
 * Tracks `taken` (did this branch's condition hold) separately from
 * `active` (is this branch emitting, given every enclosing branch) — an
 * `#else` nested inside a false parent must stay inactive, which a single
 * boolean per level gets wrong.
 */
function preprocess(shader, defines) {
  const out = [];
  const stack = [];
  let line = 0;
  for (const raw of shader.split("\n")) {
    line++;
    const t = raw.trim();
    let m;
    if ((m = /^#ifdef\s+(\w+)/.exec(t))) {
      const parentActive = stack.every((s) => s.active);
      const on = defines.has(m[1]);
      stack.push({ taken: on, active: parentActive && on });
    } else if (/^#else\b/.test(t)) {
      const top = stack[stack.length - 1];
      assert.ok(top, `#else without a matching #ifdef at line ${line}`);
      const parentActive = stack.slice(0, -1).every((s) => s.active);
      top.active = parentActive && !top.taken;
    } else if (/^#endif\b/.test(t)) {
      assert.ok(stack.pop(), `#endif without a matching #ifdef at line ${line}`);
    } else if (stack.every((s) => s.active)) {
      out.push(raw);
    }
  }
  assert.equal(stack.length, 0, `${stack.length} unclosed #ifdef`);
  return out.join("\n");
}

/** Every define set ParticleMaterial.createParticleMaterial can actually emit. */
const VARIANTS = [
  ["billboard", []],
  ["velocity-aligned", ["USE_VELOCITY"]],
  ["stretched", ["USE_VELOCITY", "USE_STRETCH"]],
  ["mesh", ["USE_MESH"]],
  ["billboard + flipbook", ["USE_FLIPBOOK"]],
  ["billboard + soft", ["USE_SOFT"]],
  ["velocity + flipbook", ["USE_VELOCITY", "USE_FLIPBOOK"]],
  ["stretched + flipbook + soft", ["USE_VELOCITY", "USE_STRETCH", "USE_FLIPBOOK", "USE_SOFT"]],
  ["mesh + soft", ["USE_MESH", "USE_SOFT"]],
];

test("vertex shader: preprocessor directives are balanced", () => {
  const vertex = extractShader("VERTEX_SHADER");
  for (const [name, defs] of VARIANTS) {
    assert.doesNotThrow(() => preprocess(vertex, new Set(defs)), `${name} has unbalanced directives`);
  }
});

test("vertex shader: every variant declares mvPosition exactly once", () => {
  const vertex = extractShader("VERTEX_SHADER");
  for (const [name, defs] of VARIANTS) {
    const code = preprocess(vertex, new Set(defs));
    const declarations = (code.match(/\bvec4\s+mvPosition\s*=/g) || []).length;
    assert.equal(declarations, 1, `${name}: mvPosition declared ${declarations}x — 2 is a redefinition error, 0 leaves it undeclared`);
  }
});

test("vertex shader: every variant writes gl_Position exactly once", () => {
  const vertex = extractShader("VERTEX_SHADER");
  for (const [name, defs] of VARIANTS) {
    const code = preprocess(vertex, new Set(defs));
    const writes = (code.match(/\bgl_Position\s*=/g) || []).length;
    assert.equal(writes, 1, `${name}: gl_Position written ${writes}x`);
  }
});

test("vertex shader: no variant references an attribute or uniform it never declares", () => {
  const vertex = extractShader("VERTEX_SHADER");
  // Each guarded symbol, paired with the define that declares it.
  const guarded = [
    ["aVelocity", "USE_VELOCITY"],
    ["uStretch", "USE_STRETCH"],
    ["uTiles", "USE_FLIPBOOK"],
    ["vClipPos", "USE_SOFT"],
  ];
  for (const [name, defs] of VARIANTS) {
    const active = new Set(defs);
    const code = preprocess(vertex, active);
    for (const [symbol, requires] of guarded) {
      if (active.has(requires)) continue;
      assert.ok(!new RegExp(`\\b${symbol}\\b`).test(code), `${name} references ${symbol}, which only exists under ${requires}`);
    }
  }
});

test("fragment shader: preprocessor directives are balanced and soft-particle symbols are guarded", () => {
  const fragment = extractShader("FRAGMENT_SHADER");
  for (const defs of [[], ["USE_SOFT"]]) {
    const code = preprocess(fragment, new Set(defs));
    const writes = (code.match(/\bgl_FragColor\s*=/g) || []).length;
    assert.equal(writes, 1, "the fragment shader must write gl_FragColor exactly once");
    if (!defs.includes("USE_SOFT")) {
      for (const symbol of ["uDepth", "uNear", "uFar", "uSoftFade", "vClipPos", "linearizeDepth"]) {
        assert.ok(!new RegExp(`\\b${symbol}\\b`).test(code), `the non-soft fragment variant references ${symbol}`);
      }
    }
  }
});

test("trail shader: preprocesses cleanly and writes its outputs once", () => {
  const match = /const VERTEX_SHADER = \/\* glsl \*\/ `([\s\S]*?)`;/.exec(
    readFileSync(join(ROOT, "src", "engine", "particles", "ParticleTrails.ts"), "utf8")
  );
  assert.ok(match, "could not find the trail vertex shader");
  const code = preprocess(match[1], new Set());
  assert.equal((code.match(/\bgl_Position\s*=/g) || []).length, 1);
});
