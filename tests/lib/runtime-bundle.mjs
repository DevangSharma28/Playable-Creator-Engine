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

/** One bundle per `dev` setting — they are genuinely different builds, not the same one configured twice. */
const cached = new Map();

/**
 * @param {{ dev?: boolean }} [options]
 *   `dev: true` builds the bundle with `import.meta.env.DEV` true, which is
 *   what a *dev preview* actually runs. Several things exist only there — the
 *   `window.__*` panel hooks beyond the always-on ones, and the Engine Room's
 *   orientation gizmo — so a test of any of them against the default
 *   production bundle is testing the wrong build and silently passes for the
 *   wrong reason (or, worse, fails and looks like a real bug).
 */
export async function loadRuntime({ dev = false } = {}) {
  const hit = cached.get(dev);
  if (hit) return hit;
  // Emitted *inside* node_modules rather than into a temp dir, because the
  // bundle keeps `three` as a bare import and Node resolves bare specifiers by
  // walking up from the importing file. From /tmp there is no node_modules to
  // find; from here there is exactly one, the same copy the test file itself
  // imports.
  const dir = join(ROOT, "node_modules", ".ion-test-build");
  mkdirSync(dir, { recursive: true });
  const outfile = join(dir, dev ? "runtime-dev.mjs" : "runtime.mjs");
  await esbuild.build({
    entryPoints: [join(ROOT, "packages", "runtime", "src", "index.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["three", "three/*"],
    // The runtime reads this to decide whether dev-only branches exist. It
    // defaults to the production build, so a test of production behavior
    // cannot accidentally be testing the dev one; a test that wants the other
    // branch asks for it with `{ dev: true }`.
    define: { "import.meta.env.DEV": String(dev), "import.meta.env.PROD": String(!dev) },
    logLevel: "silent",
  });
  const loaded = await import(pathToFileURL(outfile).href);
  cached.set(dev, loaded);
  return loaded;
}

export { ROOT };
