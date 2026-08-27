import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MANIFEST_NAME = "ion-integrity.json";

/**
 * Verifies that the installed ION packages are the ones ION published.
 *
 * ## What this is and isn't
 *
 * It answers "has engine code been edited in place?" — nothing more. It is a
 * *correctness* check, not a security control: anyone who can edit
 * `node_modules` can equally edit the manifest, and this makes no attempt to
 * stop them. What it does stop is the failure that actually happens, which is
 * silent and expensive: someone debugs a problem by editing engine source
 * inside `node_modules`, it works, and then the fix evaporates on the next
 * `npm ci` with nothing in `git status` to explain why the bug came back.
 *
 * The real boundary is elsewhere and is deliberate: engine code lives only in
 * `node_modules`, which is git-ignored, so an edit to it cannot be committed
 * and cannot be pushed. This check exists so that edit is *noticed* rather
 * than quietly lost.
 */

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === MANIFEST_NAME || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out[path.relative(base, full).split(path.sep).join("/")] = sha256(full);
  }
  return out;
}

/** Writes `ion-integrity.json` next to a package's own package.json. Called by the package build. */
export function writeManifest(pkgDir, shippedDirs) {
  const files = {};
  for (const rel of shippedDirs) {
    const dir = path.join(pkgDir, rel);
    if (fs.existsSync(dir)) walk(dir, pkgDir, files);
  }
  const manifest = { algorithm: "sha256", generatedAt: null, files };
  fs.writeFileSync(path.join(pkgDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");
  return Object.keys(files).length;
}

/**
 * @returns {{ checked: number, modified: string[], missing: string[], unverifiable: boolean }}
 */
export function verifyPackage(pkgDir) {
  const manifestPath = path.join(pkgDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return { checked: 0, modified: [], missing: [], unverifiable: true };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return { checked: 0, modified: [], missing: [], unverifiable: true };
  }
  const modified = [];
  const missing = [];
  for (const [rel, expected] of Object.entries(manifest.files ?? {})) {
    const full = path.join(pkgDir, rel);
    if (!fs.existsSync(full)) missing.push(rel);
    else if (sha256(full) !== expected) modified.push(rel);
  }
  return { checked: Object.keys(manifest.files ?? {}).length, modified, missing, unverifiable: false };
}

/**
 * Verifies every copy of the engine this project has.
 *
 * There are two, and checking only one was a real hole. `npm install` puts the
 * packages in `node_modules`, and `ion sync` copies them to `IONEngine/` — and
 * `IONEngine/` is the copy that is actually *served*: the dev server and the
 * production build both resolve `ion` and `@ion-engine/runtime` there (see
 * enginePackageDir). It is also the copy a client can see in their file tree,
 * which makes it the one they are likely to edit. Verifying only node_modules
 * meant an edited `IONEngine/runtime/dist/index.js` was loaded by every build
 * while `ion doctor` reported no problems at all.
 *
 * @returns {{ name: string, location: "node_modules"|"IONEngine", checked: number, modified: string[], missing: string[], unverifiable: boolean }[]}
 */
export function verifyInstall(projectRoot) {
  const results = [];

  const scope = path.join(projectRoot, "node_modules", "@ion-engine");
  if (fs.existsSync(scope)) {
    for (const name of fs.readdirSync(scope)) {
      const dir = path.join(scope, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      results.push({ name: `@ion-engine/${name}`, location: "node_modules", ...verifyPackage(dir) });
    }
  }

  const engineDir = path.join(projectRoot, "IONEngine");
  if (fs.existsSync(engineDir)) {
    for (const name of fs.readdirSync(engineDir)) {
      const dir = path.join(engineDir, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      // README.md and ion-engine.json are written by `ion sync` itself and are
      // deliberately outside every package's manifest.
      results.push({ name: `IONEngine/${name}`, location: "IONEngine", ...verifyPackage(dir) });
    }
  }

  return results;
}
