// Loads a real TypeScript source file from src/ into this Node process for
// testing, by transforming it (and any sibling modules it imports) with
// esbuild and importing the result.
//
// Same "no bundler, no test build step" philosophy as
// tests/lib/geometry-source.mjs, which does the narrower version of this
// for the GEOMETRY fence specifically. Kept separate from that file
// because its job is different: geometry-source extracts and compares
// *fenced formulas*, this one just gets a module running so its real
// behavior can be exercised against a DOM.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

/** Node's ESM resolver takes specifiers literally, so extensionless TS imports need a real filename. */
function rewriteRelativeSpecifiers(code) {
  return code.replace(/((?:from|import)\s*["'])(\.\/[^"']+?)(["'])/g, (_all, head, spec, tail) =>
    /\.(mjs|js|json)$/.test(spec) ? `${head}${spec}${tail}` : `${head}${spec}.mjs${tail}`
  );
}

function emit(tsPath, outDir, seen) {
  const name = tsPath.split("/").pop().replace(/\.ts$/, "");
  if (seen.has(name)) return;
  seen.add(name);
  const { code } = esbuild.transformSync(readFileSync(tsPath, "utf8"), { loader: "ts", format: "esm", target: "es2020" });
  writeFileSync(join(outDir, `${name}.mjs`), rewriteRelativeSpecifiers(code), "utf8");
  for (const match of code.matchAll(/(?:from|import)\s*["']\.\/([^"']+?)(?:\.mjs)?["']/g)) {
    const sibling = join(dirname(tsPath), `${match[1]}.ts`);
    if (existsSync(sibling)) emit(sibling, outDir, seen);
  }
}

/**
 * Transforms `tsPath` plus its relative sibling graph into a temp dir and
 * imports it. Returns the live module namespace.
 */
export async function loadTsModule(tsPath) {
  const dir = mkdtempSync(join(tmpdir(), "ion-ts-"));
  emit(tsPath, dir, new Set());
  const entry = join(dir, `${tsPath.split("/").pop().replace(/\.ts$/, "")}.mjs`);
  return import(pathToFileURL(entry).href);
}
