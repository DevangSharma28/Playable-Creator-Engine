// Shared source-extraction/normalization helpers for
// tests/geometry-parity.test.mjs — the mechanical enforcement of
// ENGINE.md's "ui/UILayout.ts" contract: src/engine/ui/UILayout.ts's own
// geometry formulas must stay identical to tools/ui-editor.html's. See
// that file's GEOMETRY fence for the human-readable version of this same
// point.
//
// Plain text/brace-depth scanning throughout, deliberately — the same
// "no real parser" philosophy scripts/dev-build-api.js's /script-info
// endpoint already uses for the same reason (no new parser dependency,
// and this repo's own convention for lightweight structural extraction).

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

/**
 * Node's ESM resolver takes specifiers literally — no extension guessing —
 * so TypeScript's extensionless `from "./UILayoutTypes"` has to become
 * `from "./UILayoutTypes.mjs"` to resolve against what we actually wrote
 * to disk.
 */
function rewriteRelativeSpecifiers(code) {
  return code.replace(/((?:from|import)\s*["'])(\.\/[^"']+?)(["'])/g, (_all, head, spec, tail) =>
    /\.(mjs|js|json)$/.test(spec) ? `${head}${spec}${tail}` : `${head}${spec}.mjs${tail}`
  );
}

/**
 * Transforms every relative sibling module `code` imports into `outDir`,
 * recursively, so the transformed entry file can actually be imported.
 * Deliberately narrow: relative specifiers only (a bare "three" would be
 * a real dependency and has no business anywhere near a geometry
 * formula), one file per specifier, and `seen` guards against an import
 * cycle.
 */
function writeSiblingModules(code, sourceDir, outDir, seen) {
  for (const match of code.matchAll(/(?:from|import)\s*["']\.\/([^"']+?)(?:\.mjs)?["']/g)) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    const tsFile = join(sourceDir, `${name}.ts`);
    if (!existsSync(tsFile)) continue;
    const { code: siblingCode } = esbuild.transformSync(readFileSync(tsFile, "utf8"), { loader: "ts", format: "esm", target: "es2020" });
    writeFileSync(join(outDir, `${name}.mjs`), rewriteRelativeSpecifiers(siblingCode), "utf8");
    writeSiblingModules(siblingCode, sourceDir, outDir, seen);
  }
}

const BEGIN_MARKER = "// ─── GEOMETRY:BEGIN ───";
const END_MARKER = "// ─── GEOMETRY:END ───";

/**
 * Raw source text strictly between a file's GEOMETRY:BEGIN/END marker
 * comments (exclusive of the marker lines themselves), trimmed. Throws if
 * either marker is missing, or if a second BEGIN appears before the
 * matching END (out of order / duplicated fence).
 */
export function extractGeometryBlock(filePath) {
  const src = readFileSync(filePath, "utf8");
  const beginIdx = src.indexOf(BEGIN_MARKER);
  if (beginIdx === -1) {
    throw new Error(`${filePath}: missing "${BEGIN_MARKER}" marker — the GEOMETRY fence is required for parity checking (see ENGINE.md's "ui/UILayout.ts" section)`);
  }
  const afterBegin = beginIdx + BEGIN_MARKER.length;
  const endIdx = src.indexOf(END_MARKER, afterBegin);
  if (endIdx === -1) {
    throw new Error(`${filePath}: missing "${END_MARKER}" marker after GEOMETRY:BEGIN (or the markers are out of order)`);
  }
  const secondBegin = src.indexOf(BEGIN_MARKER, afterBegin);
  if (secondBegin !== -1 && secondBegin < endIdx) {
    throw new Error(`${filePath}: a second GEOMETRY:BEGIN appears before the matching GEOMETRY:END — markers are out of order`);
  }
  return src.slice(afterBegin, endIdx).trim();
}

/**
 * Brace-depth scan for one top-level `function NAME(...) { ... }` or
 * `const NAME = { ... };` declaration anywhere in `src` — used to pull in
 * tools/ui-editor.html's needsLockedAspect()/visualAspectRatio()/
 * ANCHOR_FRAC, which the fenced formulas call but which deliberately stay
 * OUTSIDE the fence itself (see the fence's own doc comment there): they
 * aren't UILayout.ts-vs-editor parity formulas, they're shared constants
 * already duplicated by hand between the two files elsewhere.
 */
function extractDeclaration(src, name) {
  const fnMatch = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  const constMatch = fnMatch ? null : new RegExp(`const\\s+${name}\\s*=`).exec(src);
  const match = fnMatch ?? constMatch;
  if (!match) throw new Error(`could not find a "function ${name}(" or "const ${name} =" declaration in source`);
  const braceOpen = src.indexOf("{", match.index);
  if (braceOpen === -1) throw new Error(`"${name}": no opening brace found after its declaration`);
  let depth = 0;
  let i = braceOpen;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error(`"${name}": unbalanced braces while scanning its declaration`);
  let end = i + 1;
  if (constMatch) {
    // const object literal — swallow the trailing semicolon if present so
    // it doesn't dangle right before whatever gets appended after it.
    let j = end;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] === ";") end = j + 1;
  }
  return src.slice(match.index, end);
}

/**
 * Extracts tools/ui-editor.html's GEOMETRY fence and compiles it into
 * real callables via `new Function(...)` — never touches `document`/
 * `window`/DOM (constraint: this file's script registers page listeners
 * at load, so anything that evaluated the whole file would throw). The
 * fence closes over `scaleX`/`scaleY` as bare identifiers (the real
 * editor's own module-level globals) — re-derived here from
 * `containerW`/`containerH` and `layout.canvasWidth`/`canvasHeight`
 * exactly the way the real editor's applyCanvasSize() does, so
 * `make(layout, containerWidth, containerHeight)` gives every fenced
 * function the same view of the world the live editor would.
 */
export function loadEditorGeometry(htmlPath) {
  const src = readFileSync(htmlPath, "utf8");
  const block = extractGeometryBlock(htmlPath);
  const anchorFrac = extractDeclaration(src, "ANCHOR_FRAC");
  const needsLockedAspect = extractDeclaration(src, "needsLockedAspect");
  const visualAspectRatio = extractDeclaration(src, "visualAspectRatio");

  const names = [...new Set([...block.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))];
  if (names.length === 0) throw new Error(`${htmlPath}: no "function name(...)" declarations found inside the GEOMETRY fence`);

  const body = [
    anchorFrac,
    needsLockedAspect,
    visualAspectRatio,
    "const canvasWidth = containerW, canvasHeight = containerH;",
    "const designWidth = layout.canvasWidth, designHeight = layout.canvasHeight;",
    "const scaleX = designWidth > 0 ? canvasWidth / designWidth : 1;",
    "const scaleY = designHeight > 0 ? canvasHeight / designHeight : 1;",
    block,
    `return { ${names.join(", ")} };`,
  ].join("\n");

  let factory;
  try {
    // eslint-disable-next-line no-new-func -- deliberate: see this file's own doc comment
    factory = new Function("layout", "containerW", "containerH", body);
  } catch (err) {
    throw new Error(`${htmlPath}: extracted GEOMETRY block failed to compile as a standalone function body: ${err.message}`);
  }

  return {
    names,
    block,
    make(layoutData, containerWidth, containerHeight) {
      return factory(layoutData, containerWidth, containerHeight);
    },
  };
}

/**
 * Transforms UILayout.ts's real source with esbuild (TS -> ESM JS, no
 * bundling), writes it to a temp dir alongside any *sibling* modules it
 * imports, and dynamic-imports it for real. `make(...)` then builds each
 * instance via `Object.create(UILayout.prototype)` rather than `new
 * UILayout(...)` — the real constructor touches `document`
 * (ensureKeyframes' createElement) and expects a live HTMLElement
 * container, neither of which exists in this Node process and neither of
 * which any GEOMETRY formula actually reads. Only the handful of instance
 * fields the fenced formulas depend on (scaleX/scaleY/liveHeight/
 * canvasWidth/canvasHeight) are set by hand, to exactly what the real
 * constructor's own initial updateScale() call would have set them to.
 *
 * Siblings are followed (one directory, no node_modules, no deep
 * transitive graph) because UILayout.ts imports real *values* from
 * UILayoutTypes.ts, not only types. `import type` is erased outright by
 * esbuild, so for a long time nothing survived transformation and a lone
 * file imported cleanly — the moment one runtime constant was shared, the
 * whole suite failed with a bare ERR_MODULE_NOT_FOUND that said nothing
 * about geometry. Resolving siblings here keeps that failure mode from
 * coming back the next time the renderer legitimately needs a shared
 * constant.
 */
export async function loadRuntimeGeometry(tsPath) {
  const block = extractGeometryBlock(tsPath); // also validates the fence exists before we even try to compile anything
  const src = readFileSync(tsPath, "utf8");
  const { code } = esbuild.transformSync(src, { loader: "ts", format: "esm", target: "es2020" });

  const dir = mkdtempSync(join(tmpdir(), "geometry-parity-"));
  const outFile = join(dir, "UILayout.mjs");
  writeFileSync(outFile, rewriteRelativeSpecifiers(code), "utf8");
  writeSiblingModules(code, dirname(tsPath), dir, new Set(["UILayout"]));
  const mod = await import(pathToFileURL(outFile).href);
  const UILayoutClass = mod.UILayout;
  if (!UILayoutClass) throw new Error(`${tsPath}: transformed module has no "UILayout" export`);
  if (typeof UILayoutClass.prototype.__geometry !== "function") {
    throw new Error(`${tsPath}: UILayout is missing its __geometry() test seam (a public __geometry() method) — see UILayout.ts's GEOMETRY fence and ENGINE.md's "ui/UILayout.ts" section`);
  }

  function make(layoutData, containerWidth, containerHeight) {
    const instance = Object.create(UILayoutClass.prototype);
    instance.canvasWidth = layoutData.canvasWidth;
    instance.canvasHeight = layoutData.canvasHeight;
    instance.scaleX = containerWidth / layoutData.canvasWidth;
    instance.scaleY = containerHeight / layoutData.canvasHeight;
    instance.liveHeight = containerHeight;
    return instance.__geometry();
  }

  const names = Object.keys(make({ canvasWidth: 100, canvasHeight: 100 }, 100, 100));
  return { names, block, make };
}

const CONTAINER_ALIASES = [
  ["containerWidth", "$CW"],
  ["containerHeight", "$CH"],
  ["containerW", "$CW"],
  ["containerH", "$CH"],
];

/**
 * Normalizes away the differences the two files are *allowed* to have
 * (private/public modifiers, `this.`/`layout.` prefixes, TS type
 * annotations, the containerW(idth)/containerH(eight) naming difference,
 * ...) and SHA-256s the result. Two type-annotation-stripping passes are
 * targeted at TS's actual two syntax positions — right after a `(`/`,` in
 * a parameter list, and right before the `{` that opens a function body —
 * specifically so a ternary's `? ... : ...` (which this geometry uses
 * constantly) is never mistaken for a type annotation.
 */
export function geometryFingerprint(src) {
  let s = src;
  s = s.replace(/\/\/.*$/gm, ""); // line comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, ""); // block comments
  s = s.replace(/\b(private|public)\b\s*/g, ""); // TS modifiers
  s = s.replace(/this\.data\./g, ""); // this.data.
  s = s.replace(/this\./g, ""); // this.
  s = s.replace(/layout\./g, ""); // layout.
  s = s.replace(/\bfunction\b\s*/g, ""); // function keyword
  s = s.replace(/([,(]\s*[A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$]*(\[\])?/g, "$1"); // param type annotations
  s = s.replace(/\)\s*:\s*[A-Za-z_$][\w$]*(\[\])?\s*\{/g, "){"); // return type annotations
  s = s.replace(/\b(const|let)\b\s*/g, ""); // const/let
  s = s.replace(/\s+/g, ""); // all whitespace
  s = s.replace(/;/g, ""); // semicolons
  for (const [long, short] of CONTAINER_ALIASES) {
    // Longest-pattern-first order is load-bearing: containerWidth must be
    // aliased before containerW, or the short pattern partially rewrites
    // it first and containerWidth never matches again.
    s = s.split(long).join(short);
  }
  const hash = createHash("sha256").update(s).digest("hex");
  return { hash, normalized: s };
}
