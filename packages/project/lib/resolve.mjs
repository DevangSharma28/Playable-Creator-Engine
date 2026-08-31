import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Where this project's ION packages live.
 *
 * ## Why there is no longer a copy of the engine in the project
 *
 * There used to be. `ion sync` copied all four `@ion-engine/*` packages out of
 * `node_modules` into a root-level `IONEngine/` folder on every install, and
 * that folder — not `node_modules` — was what the dev server and the build
 * actually served. The intent was legibility: a project that *reads* as
 * engine-here / game-there at the top level.
 *
 * It cost more than it bought. There were two copies of the engine and
 * therefore two ways for them to disagree: an `npm update` whose `postinstall`
 * did not run left the served copy a version behind the installed one, and
 * every symptom of that pointed at the wrong place. It needed a `postinstall`
 * hook, a `sync` command, a version stamp file, drift detection in `doctor`,
 * and integrity verification of both locations — a whole subsystem whose only
 * job was keeping a duplicate honest. And it duplicated ~2 MB of engine into
 * every project, which is exactly what a package manager exists to avoid.
 *
 * npm is now the single authority. One copy, in `node_modules`, resolved by
 * Node's own algorithm — which is also what makes `npm update` work with no
 * ION-specific step, and what makes pnpm, Yarn, workspaces and `file:` links
 * work without this file knowing about any of them.
 */

/**
 * Absolute path to an installed ION package's root, or null.
 *
 * Resolved through `require.resolve` of the package's own `package.json`
 * rather than joining `node_modules/<name>`: that path is a guess that happens
 * to be right under npm's default layout and wrong under pnpm's symlinked
 * store, Yarn's, a workspace hoist, or a `file:` link — all of which a
 * customer may plausibly be using.
 *
 * `package.json` specifically, because it is the one path every package
 * exposes regardless of what its `exports` map publishes. Resolving the
 * package's main entry instead would work today and break the moment a
 * package tightens its exports.
 */
export function enginePackageDir(projectRoot, name) {
  try {
    const require = createRequire(path.join(projectRoot, "package.json"));
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

/**
 * The file a bare import of `name` resolves to from this project.
 *
 * Reads the package's own `exports` map rather than assuming `dist/index.js`,
 * so a package that moves its entry does not silently break every consumer's
 * alias. Used to pin absolute paths into the dev server and the production
 * build, which is what stops a linked package from resolving a *second* copy
 * of the runtime or of three.js relative to itself — two copies in one page
 * make `instanceof` fail across the boundary and produced the "Ion used before
 * IonEngine.boot() finished" class of failure.
 */
export function enginePackageEntry(projectRoot, name) {
  const dir = enginePackageDir(projectRoot, name);
  if (dir) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      const main = manifest.exports?.["."]?.default ?? manifest.exports?.["."] ?? manifest.main;
      if (typeof main === "string") return path.join(dir, main);
    } catch {
      // Fall through to plain resolution below.
    }
  }
  try {
    return createRequire(path.join(projectRoot, "package.json")).resolve(name);
  } catch {
    return null;
  }
}

/** Installed version of an ION package, or null when it is not installed. */
export function enginePackageVersion(projectRoot, name) {
  const dir = enginePackageDir(projectRoot, name);
  if (!dir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/** The four packages a complete ION project has. */
export const ION_PACKAGES = ["@ion-engine/runtime", "@ion-engine/editor", "@ion-engine/build", "@ion-engine/project"];
