/**
 * Loads the real `@ion-engine/runtime` public entry into the test process.
 *
 * Deliberately the *same* file the package publishes
 * (packages/runtime/src/index.ts) rather than reaching into src/engine
 * directly: what a client can actually import is part of what is under test,
 * so a symbol that stops being exported should break these tests.
 *
 * `three` stays external so the bundle and the test file share one module
 * instance. Without that there would be two `THREE.AudioContext` singletons
 * and two sets of `instanceof` identities — the same duplicate-module class
 * of bug that once produced "Ion used before IonEngine.boot() finished" in a
 * production bundle, and not something a test should reintroduce for itself.
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const ROOT = resolve(import.meta.dirname, "..", "..");

let cached;

export async function loadRuntime() {
  if (cached) return cached;
  // Emitted *inside* node_modules rather than into a temp dir, because the
  // bundle keeps `three` as a bare import and Node resolves bare specifiers by
  // walking up from the importing file. From /tmp there is no node_modules to
  // find; from here there is exactly one, the same copy the test file itself
  // imports.
  const dir = join(ROOT, "node_modules", ".ion-test-build");
  mkdirSync(dir, { recursive: true });
  const outfile = join(dir, "runtime.mjs");
  await esbuild.build({
    entryPoints: [join(ROOT, "packages", "runtime", "src", "index.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["three", "three/*"],
    // The runtime reads this to decide whether dev-only branches exist. A
    // test of production behavior must not accidentally be testing the dev
    // build, so it is pinned false here and set explicitly where a test
    // wants the other branch.
    define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true" },
    logLevel: "silent",
  });
  cached = await import(pathToFileURL(outfile).href);
  return cached;
}

export { ROOT };
