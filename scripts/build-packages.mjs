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
import { writeManifest } from "../packages/project/lib/integrity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKGS = path.join(ROOT, "packages");
const withTypes = !process.argv.includes("--no-types");

/**
 * One version for the whole engine, taken from the repo's own package.json.
 *
 * Stamped into every package at build time rather than maintained by hand in
 * four manifests. Hand-maintained copies had already drifted — the packages
 * said 0.1.0 while the engine was 4.0.1 — which made the Studio's version pill
 * in a generated project report a number that corresponded to nothing.
 */
const ION_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

function stampVersions() {
  for (const pkg of ["runtime", "editor", "build", "project"]) {
    const file = path.join(PKGS, pkg, "package.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.version = ION_VERSION;
    for (const field of ["peerDependencies", "dependencies"]) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        if (dep.startsWith("@ion-engine/")) manifest[field][dep] = ION_VERSION;
      }
    }
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  }
}

const BUNDLED = [
  {
    name: "runtime",
    entry: "packages/runtime/src/index.ts",
    // `three` stays external: the project depends on it directly, and two
    // copies of three.js in one bundle is a class of bug that shows up as
    // `instanceof` silently failing across the boundary.
    externalExact: ["three"],
  },
  {
    name: "editor",
    entry: "packages/editor/src/index.ts",
    externalExact: ["three", "@ion-engine/runtime"],
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

/**
 * Externalises only the *bare* specifier, never its subpaths.
 *
 * esbuild's own `external: ["three"]` also covers `three/examples/jsm/...`,
 * which leaves those as bare imports in the artifact — and they then only
 * resolve for a consumer who happens to have three as a direct sibling. The
 * jsm modules (OrbitControls, TransformControls, RoomEnvironment, the meshopt
 * decoder, tween) are part of what these packages *are*, so they get bundled
 * in; only three's own core stays shared, which is what keeps a single THREE
 * identity across the game and the editor.
 */
function externalBarePlugin(names) {
  return {
    name: "ion:external-bare",
    setup(build) {
      for (const name of names) {
        const filter = new RegExp(`^${name.replace(/[/\\]/g, "\\$&")}$`);
        build.onResolve({ filter }, (args) => ({ path: args.path, external: true }));
      }
    },
  };
}

async function bundle({ name, entry, externalExact }) {
  const outfile = path.join(PKGS, name, "dist", "index.js");
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2019",
    plugins: [externalBarePlugin(externalExact)],
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
    // tsc reports diagnostics on *stdout*, not stderr. Discarding it meant a
    // type-emit failure printed "FAILED" followed by a blank line, with the
    // actual error nowhere to be seen.
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
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

stampVersions();
log(`\nBuilding ION packages — v${ION_VERSION}\n`);

for (const spec of BUNDLED) {
  rmDist(spec.name);
  await bundle(spec);
}

const typeFailures = [];
if (withTypes) {
  log("");
  for (const pkg of ["runtime", "editor"]) {
    process.stdout.write(`  types: @ion-engine/${pkg} … `);
    try {
      emitTypes(pkg);
      log("ok");
    } catch (err) {
      log("FAILED");
      const detail = [err.stdout, err.stderr].map((part) => String(part ?? "")).join("").trim();
      log(detail ? detail.slice(0, 2000) : String(err.message));
      typeFailures.push(pkg);
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
// The dev API ships with the build package rather than the editor: it is the
// thing that reads and writes the *project's* files, which is a build/tooling
// concern, and `ion dev` launches it with ION_PROJECT_ROOT pointed at the
// customer's directory.
// Copied as .cjs deliberately: this file is CommonJS, and @ion-engine/build
// declares "type": "module", under which a bare .js is parsed as ESM and dies
// on its first `require`. Renaming at copy time beats converting a 1,400-line
// server that works.
copyTree(path.join(ROOT, "scripts", "dev-build-api.js"), path.join(buildLib, "dev-build-api.cjs"));
copyTree(path.join(ROOT, "scripts", "check-build-report.mjs"), path.join(buildLib, "check-build-report.mjs"));
// build.sh shells this by name out of ION_BUILD_LIB, so it has to travel with
// the pipeline rather than staying behind in the ION repository.
copyTree(path.join(ROOT, "scripts", "compat-scan.mjs"), path.join(buildLib, "compat-scan.mjs"));
copyTree(path.join(ROOT, "vite.config.prod.mts"), path.join(buildLib, "vite.config.prod.mts"));
copyTree(path.join(ROOT, "src", "index.template.html"), path.join(buildLib, "index.template.html"));
// Written here rather than kept as a source file: this directory is wiped and
// re-copied on every build, so anything hand-placed in it silently disappears
// — which is exactly what happened to an earlier copy of this entry, leaving
// the package's own `exports` pointing at a file that wasn't there.
fs.writeFileSync(
  path.join(buildLib, "index.mjs"),
  `import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute paths to this package's payload — the pipeline, the compressor, the gate, and the production Vite config. */
export const BUILD_LIB = path.dirname(fileURLToPath(import.meta.url));
export const BUILD_SCRIPT = path.join(BUILD_LIB, "build.sh");
export const PROD_VITE_CONFIG = path.join(BUILD_LIB, "vite.config.prod.mts");
export const CHECK_REPORT = path.join(BUILD_LIB, "check-build-report.mjs");
export const COMPRESS_ASSETS = path.join(BUILD_LIB, "compress-assets.mjs");
export const DEV_API = path.join(BUILD_LIB, "dev-build-api.cjs");
export const INDEX_TEMPLATE = path.join(BUILD_LIB, "index.template.html");
`
);
log(`  build payload:  ${fs.readdirSync(buildLib).length} files`);

// ── Integrity manifests ────────────────────────────────────────────────────
// Lets `ion doctor` tell a customer that engine code has been edited inside
// node_modules — where such an edit is invisible to git and evaporates on the
// next clean install. See packages/project/lib/integrity.mjs for why this is
// a correctness check and explicitly not a security control.
log("");
for (const [pkg, dirs] of [
  ["runtime", ["dist"]],
  ["editor", ["dist", "studio"]],
  ["build", ["lib"]],
  ["project", ["bin", "lib"]],
]) {
  const n = writeManifest(path.join(PKGS, pkg), dirs);
  log(`  integrity: @ion-engine/${pkg.padEnd(8)} ${String(n).padStart(4)} files hashed`);
}

// A partial build reporting success is worse than no build: the packages are
// on disk, so everything downstream carries on against a runtime that ships no
// type declarations at all.
if (typeFailures.length) {
  log(`\n✖ Type declarations failed for: ${typeFailures.join(", ")}`);
  log("  The bundles were written, but these packages would publish without types.");
  log("  Fix the errors above and re-run.\n");
} else {
  log("\n✓ Packages built into packages/*/dist\n");
}
