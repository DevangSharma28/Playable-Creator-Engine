/**
 * The whole client workflow, from an empty directory to a running playable.
 *
 *   node create-ion-project.mjs → npm install → npm run build → open it in Chrome
 *
 * Every step in that chain has broken at least once in a way nothing else
 * caught: the generator emitted dependencies that could not resolve, the build
 * script was looked for at a path that only exists in ION's own repository,
 * asset compression silently skipped every file, and a bundle that built
 * cleanly threw on its first frame because the engine was in it twice. None of
 * those are visible from a unit test or an exit code, so this suite does the
 * real thing and then looks at the result in a real browser.
 *
 * It is slow — an npm install and two production builds — so it is opt-in:
 *
 *   ION_E2E=1 node --test tests/build-regression.test.mjs
 *
 * CI runs it on the production-build job. `npm test` does not.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findChrome, verifyBundle } from "../scripts/verify-bundle.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGES = path.join(ROOT, "packages");
const ENABLED = ["1", "true", "yes"].includes((process.env.ION_E2E ?? "").toLowerCase());

/** Runs a command in `cwd`, returning its status and combined output. */
function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

test(
  "end to end: generate, install, build, run",
  { skip: ENABLED ? false : "set ION_E2E=1 to run (needs npm install and a browser)" },
  async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ion-e2e-"));
    const project = path.join(workspace, "e2e-game");
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

    await t.test("the generator writes a project", () => {
      const { status, output } = run(process.execPath, [
        path.join(ROOT, "create-ion-project.mjs"), "e2e-game", "--yes", "--ion-packages", PACKAGES,
      ], workspace);
      assert.equal(status, 0, output);
      assert.ok(fs.existsSync(path.join(project, "package.json")));
    });

    await t.test("one npm install is the whole setup", () => {
      const { status, output } = run("npm", ["install", "--no-audit", "--no-fund"], project);
      assert.equal(status, 0, output);
      // Straight into node_modules, with no postinstall step and no second
      // copy of the engine anywhere in the project.
      for (const short of ["runtime", "editor", "build", "project"]) {
        assert.ok(
          fs.existsSync(path.join(project, "node_modules", "@ion-engine", short, "package.json")),
          `@ion-engine/${short} is not installed`
        );
      }
      assert.ok(!fs.existsSync(path.join(project, "IONEngine")), "the engine was copied into the project instead of being resolved from node_modules");
    });

    await t.test("the project typechecks against the installed engine", () => {
      const { status, output } = run("npx", ["tsc", "--noEmit"], project);
      assert.equal(status, 0, output);
    });

    await t.test("ion doctor reports a healthy project", () => {
      const { status, output } = run("npx", ["ion", "doctor"], project);
      assert.equal(status, 0, output);
      assert.match(output, /No problems found/);
    });

    await t.test("deep imports into the engine are refused, not merely discouraged", () => {
      // The client-access boundary is the package `exports` map, and this is
      // the assertion that it is real: a deep import must fail to resolve, not
      // produce a lint warning.
      const probe = path.join(project, "src", "game", "probe.ts");
      fs.writeFileSync(probe, `import { EditorRoot } from "@ion-engine/runtime/src/engine/editor/EditorRoot";\nexport const x = EditorRoot;\n`);
      const { status, output } = run("npx", ["tsc", "--noEmit"], project);
      fs.rmSync(probe);
      assert.notEqual(status, 0, "a deep import into engine internals typechecked");
      assert.match(output, /Cannot find module|not exported|TS2307/);
    });

    await t.test("npm run build produces a submittable single file", () => {
      const { status, output } = run("npm", ["run", "build"], project);
      assert.equal(status, 0, output);
      assert.match(output, /Build is submittable/);
      const dist = path.join(project, "dist");
      assert.ok(fs.existsSync(path.join(dist, "index.html")));
      // Single-file means single file: no sidecar assets directory to upload.
      assert.ok(!fs.existsSync(path.join(dist, "assets")), "the build left an assets/ folder beside index.html");
      const report = JSON.parse(fs.readFileSync(path.join(dist, "build-report.json"), "utf8"));
      assert.ok(report.distBytes > 0, "the report records no output size");
      assert.ok(report.gzipBytes > 0 && report.gzipBytes < report.distBytes, "the report's gzip figure is not plausible");
      assert.equal(report.overBudget, false);
      assert.ok(report.distBytes < 5 * 1024 * 1024, "the starter build should be well inside the 5 MB budget");
      assert.equal(report.distBytes, fs.statSync(path.join(dist, "index.html")).size, "the report disagrees with the file on disk");
    });

    await t.test("the output contains no ES-module or ES2019+ syntax", () => {
      // Ad-network WebViews are old. This is the same gate `ion build` runs;
      // asserting it here catches a regression in the gate itself.
      const { status, output } = run("npx", ["ion", "build"], project);
      assert.equal(status, 0, output);
      assert.match(output, /No known ad-network compatibility issues/);
    });

    await t.test("assets in the manifest are compressed and inlined", () => {
      // Compression resolved its paths against the ION package rather than the
      // project, so this whole step silently no-opped in every generated
      // project — a warning in the log and a build shipping raw assets.
      fs.mkdirSync(path.join(project, "assets", "models"), { recursive: true });
      fs.copyFileSync(path.join(ROOT, "assets", "models", "MainCharacter.glb"), path.join(project, "assets", "models", "MainCharacter.glb"));
      fs.writeFileSync(path.join(project, "src", "game", "assets.ts"), [
        `import type { AssetEntry } from "@ion-engine/runtime";`,
        `export const libGlb = { hero: "./assets/models/MainCharacter.glb" } as const;`,
        `const manifest: AssetEntry[] = [{ kind: "glb", path: libGlb.hero }];`,
        `export default manifest;`,
        ``,
      ].join("\n"));

      const { status, output } = run("npm", ["run", "build"], project);
      assert.equal(status, 0, output);
      assert.ok(!/compression step failed/i.test(output), `compression failed:\n${output}`);
      assert.match(output, /MainCharacter\.glb: .* -> /, "the model was not compressed");
      assert.match(output, /Inlined assets\/models\/MainCharacter\.glb/, "the model was not inlined");

      const compressed = /MainCharacter\.glb: [\d.]+ \w+ -> ([\d.]+) (\w+)/.exec(output);
      assert.ok(compressed, "no compression figure in the log");
      const originalBytes = fs.statSync(path.join(project, "assets", "models", "MainCharacter.glb")).size;
      const inlined = /Inlined assets\/models\/MainCharacter\.glb \(([\d,]+) bytes\)/.exec(output);
      assert.ok(Number(inlined[1].replace(/,/g, "")) < originalBytes, "the inlined copy is not smaller than the source");
    });

    await t.test(
      "the built playable boots and draws in a real browser",
      { skip: findChrome() ? false : "no Chrome/Chromium found" },
      async () => {
        const report = await verifyBundle(path.join(project, "dist"), { width: 400, height: 800 });
        assert.deepEqual(report.errors, [], "the page logged errors");
        assert.ok(report.webgl, "no WebGL context");
        assert.ok(report.canvas.width > 0 && report.canvas.height > 0, "the canvas has no size");
      }
    );

    await t.test(
      "the production build carries no editor code",
      { skip: findChrome() ? false : "no Chrome/Chromium found" },
      async () => {
        const report = await verifyBundle(path.join(project, "dist"), { width: 400, height: 800 });
        assert.deepEqual(report.editorSymbols, [], "editor modules survived into the shipped file");
        assert.equal(report.editorPresent, false, "editor DOM was built in production");
      }
    );

    await t.test("a build that exceeds the budget fails rather than warning", () => {
      const configFile = path.join(project, "ion.config.json");
      const original = fs.readFileSync(configFile, "utf8");
      const config = JSON.parse(original);
      config.build.budgetBytes = 1024;
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      try {
        const { status, output } = run("npm", ["run", "build"], project);
        assert.notEqual(status, 0, "an over-budget build reported success");
        assert.match(output, /budget/i);
        // The artifact still has to be on disk — that is how you work out why.
        assert.ok(fs.existsSync(path.join(project, "dist", "index.html")));
      } finally {
        fs.writeFileSync(configFile, original);
      }
    });

    await t.test("an engine file edited in place is reported and cannot be committed", () => {
      // node_modules is now the only copy, and the one that is served.
      const edited = path.join(project, "node_modules", "@ion-engine", "runtime", "dist", "index.js");
      const original = fs.readFileSync(edited, "utf8");
      fs.writeFileSync(edited, `${original}\n// edited in place\n`);
      try {
        const { status, output } = run("npx", ["ion", "doctor"], project);
        assert.notEqual(status, 0, "doctor did not notice an edited engine file");
        assert.match(output, /modified/i);
        assert.match(output, /dist\/index\.js/, "doctor did not say which file changed");
      } finally {
        fs.writeFileSync(edited, original);
      }
    });

    await t.test("a rebuild from the same source produces the same bytes", () => {
      // Reproducibility is what makes a build report meaningful: two runs that
      // disagree mean the number in the report describes a moment, not a state.
      const first = run("npm", ["run", "build"], project);
      assert.equal(first.status, 0, first.output);
      const firstBytes = fs.readFileSync(path.join(project, "dist", "index.html"));
      const second = run("npm", ["run", "build"], project);
      assert.equal(second.status, 0, second.output);
      const secondBytes = fs.readFileSync(path.join(project, "dist", "index.html"));
      assert.equal(firstBytes.length, secondBytes.length, "two builds of the same source differ in size");
      assert.ok(firstBytes.equals(secondBytes), "two builds of the same source differ byte for byte");
    });
  }
);
