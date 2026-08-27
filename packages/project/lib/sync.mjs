import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export const ENGINE_DIR = "IONEngine";
const PACKAGES = ["runtime", "editor", "build", "project"];

/**
 * Materialises the installed ION packages into the project's IONEngine/ folder.
 *
 * ## Why the engine is copied out of node_modules rather than left in it
 *
 * Two requirements pull in opposite directions. The engine has to be a real
 * dependency — versioned in package.json, updated with `npm update`, resolved
 * by npm's own algorithm — and npm puts dependencies in node_modules. But a
 * project also has to *read* as engine-here / game-there, at the top level,
 * in a file tree and in a pull request, which node_modules cannot express
 * because everything lives in it.
 *
 * So npm keeps ownership of *versions*, and this step keeps ownership of
 * *layout*: it copies what npm resolved into IONEngine/, one directory per
 * package, and records exactly what it copied. Running from `postinstall`
 * means every `npm install` and every `npm update` refreshes it with no
 * separate command to remember.
 *
 * IONEngine/ is git-ignored. It is a build artifact of `npm install`, and a
 * customer's repository contains their game, not a vendored copy of ours.
 */

function copyTree(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) copyTree(path.join(from, entry), path.join(to, entry));
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    if (to.endsWith(".sh")) fs.chmodSync(to, 0o755);
  }
}

const README = (versions) => `# IONEngine

The ION Engine, editor and build tooling for this project.

**This folder is generated. Do not edit it and do not commit it.**

It is written by \`npm install\` (see the \`postinstall\` script) from the
\`@ion-engine/*\` packages your \`package.json\` depends on, and it is listed in
\`.gitignore\`. Anything changed here is overwritten on the next install and
will never appear in a commit.

| | |
| --- | --- |
| \`IONEngine/\` | The engine. Ours. Regenerated on install. |
| \`src/game/\` | Your game. Yours. The only place you normally work. |

## Updating the engine

\`\`\`bash
npm update @ion-engine/runtime @ion-engine/editor @ion-engine/build @ion-engine/project
\`\`\`

npm resolves the new versions, \`postinstall\` refreshes this folder, and
\`src/game/\` is untouched. The version this project is pinned to is
\`ionVersion\` in \`ion.config.json\`; \`npm run doctor\` reports when the two
disagree.

## What is in here

${Object.entries(versions).map(([name, v]) => `- \`${name}/\` — ${v}`).join("\n")}
`;

/**
 * @param {string} projectRoot
 * @param {{ quiet?: boolean }} [opts]
 * @returns {{ synced: string[], versions: Record<string,string>, missing: string[] }}
 */
export function sync(projectRoot, opts = {}) {
  const require = createRequire(path.join(projectRoot, "package.json"));
  const target = path.join(projectRoot, ENGINE_DIR);
  const synced = [];
  const missing = [];
  const versions = {};

  for (const short of PACKAGES) {
    const name = `@ion-engine/${short}`;
    let dir;
    try {
      dir = path.dirname(require.resolve(`${name}/package.json`));
    } catch {
      missing.push(name);
      continue;
    }
    const dest = path.join(target, short);
    // Replaced wholesale rather than merged: a file removed in a new engine
    // version has to disappear here too, and a stale leftover shadowing a
    // renamed module is the kind of bug that costs a day.
    fs.rmSync(dest, { recursive: true, force: true });
    copyTree(dir, dest);
    // A nested node_modules would be both wrong and enormous — npm already
    // resolved these; this folder is a view, not an install root.
    fs.rmSync(path.join(dest, "node_modules"), { recursive: true, force: true });
    versions[short] = JSON.parse(fs.readFileSync(path.join(dest, "package.json"), "utf8")).version;
    synced.push(short);
  }

  if (synced.length) {
    fs.writeFileSync(path.join(target, "README.md"), README(versions));
    fs.writeFileSync(
      path.join(target, "ion-engine.json"),
      JSON.stringify({ generatedBy: "ion sync", packages: versions }, null, 2) + "\n"
    );
  }

  if (!opts.quiet) {
    if (synced.length) console.log(`  IONEngine/  ${synced.map((s) => `${s}@${versions[s]}`).join("  ")}`);
    for (const name of missing) console.warn(`  ⚠ ${name} is not installed — IONEngine/ is incomplete. Run \`npm install\`.`);
  }
  return { synced, versions, missing };
}

/**
 * Where a given ION package lives for this project.
 *
 * Two answers, because the packages are two different kinds of thing.
 *
 * `runtime` and `editor` are prebuilt browser bundles whose only external is
 * `three`. Nothing about them needs Node's resolver, so they are loaded from
 * IONEngine/ — the folder the project is told it runs is the folder it runs.
 *
 * `build` and `project` are Node programs with their own dependency trees
 * (glTF-Transform, sharp, meshoptimizer, Vite). Node resolves *their* imports
 * relative to where they sit on disk, and a copy under IONEngine/ resolves
 * against the customer's node_modules, which does not contain a transitive
 * dependency of a linked package. Running them from node_modules is what lets
 * npm's own resolution do its job. IONEngine/build is still written, so the
 * pipeline is readable — it is just not the copy that executes.
 *
 * @param {"served"|"executed"} kind
 */
export function enginePackageDir(projectRoot, name, kind = "served") {
  const short = name.replace("@ion-engine/", "");
  const fromNodeModules = () => {
    try {
      return path.dirname(createRequire(path.join(projectRoot, "package.json")).resolve(`${name}/package.json`));
    } catch {
      return null;
    }
  };
  if (kind === "executed") return fromNodeModules() ?? materialisedOr(projectRoot, short, null);
  return materialisedOr(projectRoot, short, fromNodeModules());
}

function materialisedOr(projectRoot, short, fallback) {
  const dir = path.join(projectRoot, ENGINE_DIR, short);
  return fs.existsSync(path.join(dir, "package.json")) ? dir : fallback;
}
