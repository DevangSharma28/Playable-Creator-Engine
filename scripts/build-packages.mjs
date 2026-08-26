#!/usr/bin/env node
/**
 * Builds the distributable ION packages out of this repository.
 *
 * The packages are *built from* `src/engine`, never a copy of it. That is the
 * safety property that matters while ION is still developed as one repo: this
 * script can be deleted, re-run, or changed without any risk to the engine or
 * to the reference playable, because nothing it does is a move.
 *
 * Output per package: a single bundled ESM file plus its type declarations.
 * Bundling is a *distribution* decision, not a protection one — see the
 * "Protected vs distributed" section of ENGINE.md. It makes the artifact one
 * file with no import graph to wander through; it does not make the source
 * secret, and nothing here pretends otherwise.
 *
 *   node scripts/build-packages.mjs            # build all four
 *   node scripts/build-packages.mjs --no-types # skip tsc, much faster
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKGS = path.join(ROOT, "packages");
const withTypes = !process.argv.includes("--no-types");

const BUNDLED = [
  {
    name: "runtime",
    entry: "packages/runtime/src/index.ts",
    // `three` stays external: the project depends on it directly, and two
    // copies of three.js in one bundle is a class of bug that shows up as
    // `instanceof` silently failing across the boundary.
    external: ["three", "three/*"],
  },
  {
    name: "editor",
    entry: "packages/editor/src/index.ts",
    external: ["three", "three/*", "@ion-engine/runtime"],
  },
];

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function rmDist(pkg) {
  fs.rmSync(path.join(PKGS, pkg, "dist"), { recursive: true, force: true });
}

/**
 * What `import.meta.env.DEV` becomes inside a prebuilt package.
 *
 * It cannot be left alone: Vite injects `import.meta.env` for modules it
 * processes, and a pre-bundled dependency in dev is not one of them, so the
 * expression would throw on a missing `env`. It also cannot simply be baked:
 * `false` would strip the editor hook installation that the Studio needs in
 * dev, and `true` would ship dev-only hooks into every production playable.
 *
 * So the runtime reads a global instead. A dev entry sets
 * `globalThis.__ION_DEV__ = true` before importing the runtime; a production
 * entry never does, leaving it `undefined` and therefore falsy. The editor
 * package only ever runs in dev, so it gets the constant.
 */
function spec_define(name) {
  return name === "editor"
    ? { "import.meta.env.DEV": "true" }
    : { "import.meta.env.DEV": "globalThis.__ION_DEV__" };
}

async function bundle({ name, entry, external }) {
  const outfile = path.join(PKGS, name, "dist", "index.js");
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2019",
    external,
    // Not minified. A published package is read by bundlers and by people
    // debugging their own game against it; unreadable frames in a stack trace
    // cost real support time, and minifying buys no protection (the registry
    // is what restricts access). The *game's* production build minifies
    // everything anyway — see @ion-engine/build.
    minify: false,
    sourcemap: false,
    legalComments: "none",
    define: spec_define(name),
    metafile: true,
  });
  const bytes = fs.statSync(outfile).size;
  const inputs = Object.keys(result.metafile.outputs[path.relative(ROOT, outfile)]?.inputs ?? {}).length;
  log(`  @ion-engine/${name.padEnd(8)} ${(bytes / 1024).toFixed(0).padStart(5)} KB   ${inputs} modules`);
}

function emitTypes(pkg) {
  const out = path.join(PKGS, pkg, "dist");
  execFileSync(
    "npx",
    [
      "tsc",
      "-p", path.join(PKGS, pkg, "tsconfig.json"),
      "--noEmit", "false",
      "--declaration", "--emitDeclarationOnly",
      "--declarationDir", path.join(out, ".types"),
    ],
    { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] }
  );
  // tsc mirrors the rootDir tree, so the real entry lands nested. Re-point a
  // flat index.d.ts at it rather than trying to flatten the tree — the nested
  // files are what its own relative imports resolve against.
  const nested = path.join(out, ".types", "packages", pkg, "src", "index.d.ts");
  if (!fs.existsSync(nested)) throw new Error(`type emit produced nothing at ${nested}`);
  fs.writeFileSync(path.join(out, "index.d.ts"), `export * from "./.types/packages/${pkg}/src/index";\n`);
}

/** Copies a package's non-bundled payload — scripts, configs, and the Studio's own HTML. */
function copyTree(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from)) copyTree(path.join(from, e), path.join(to, e));
  } else {
    fs.copyFileSync(from, to);
    if (to.endsWith(".sh")) fs.chmodSync(to, 0o755);
  }
}

log("\nBuilding ION packages\n");

for (const spec of BUNDLED) {
  rmDist(spec.name);
  await bundle(spec);
}

if (withTypes) {
  log("");
  for (const pkg of ["runtime", "editor"]) {
    process.stdout.write(`  types: @ion-engine/${pkg} … `);
    try {
      emitTypes(pkg);
      log("ok");
    } catch (err) {
      log("FAILED");
      log(String(err.stderr ?? err.message).slice(0, 800));
      process.exitCode = 1;
    }
  }
}

// ── Studio payload: the dev page and the visual UI editor ───────────────────
const studio = path.join(PKGS, "editor", "studio");
fs.rmSync(studio, { recursive: true, force: true });
copyTree(path.join(ROOT, "index.html"), path.join(studio, "engine-room.html"));
copyTree(path.join(ROOT, "tools", "ui-editor.html"), path.join(studio, "ui-editor.html"));
for (const g of fs.readdirSync(path.join(ROOT, "public")).filter((f) => f.startsWith("guide"))) {
  copyTree(path.join(ROOT, "public", g), path.join(studio, g));
}
log(`\n  studio payload: ${fs.readdirSync(studio).length} files`);

// ── Build pipeline payload ──────────────────────────────────────────────────
const buildLib = path.join(PKGS, "build", "lib");
fs.rmSync(buildLib, { recursive: true, force: true });
copyTree(path.join(ROOT, "build.sh"), path.join(buildLib, "build.sh"));
copyTree(path.join(ROOT, "scripts", "compress-assets.mjs"), path.join(buildLib, "compress-assets.mjs"));
copyTree(path.join(ROOT, "scripts", "check-build-report.mjs"), path.join(buildLib, "check-build-report.mjs"));
copyTree(path.join(ROOT, "vite.config.prod.mts"), path.join(buildLib, "vite.config.prod.mts"));
log(`  build payload:  ${fs.readdirSync(buildLib).length} files`);

log("\n✓ Packages built into packages/*/dist\n");
