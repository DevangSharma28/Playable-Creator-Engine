/**
 * `create-ion-project.mjs` — what a client's very first command produces.
 *
 * Run against real generated directories rather than against the generator's
 * internals, because the thing under test is the tree it leaves behind: which
 * files exist, what the config says, and above all where the boundary between
 * ION's code and the client's code falls. A generator that writes engine
 * sources into `src/`, or forgets to git-ignore `IONEngine/`, has broken the
 * commercial arrangement no matter how well the engine itself works.
 *
 * The full `npm install` → `npm run build` flow is a separate suite
 * (tests/build-regression.test.mjs), because it takes minutes and needs a
 * network; everything here runs in under a second and offline.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const GENERATOR = path.join(ROOT, "create-ion-project.mjs");
const PACKAGES = path.join(ROOT, "packages");

/** Enough JSONC support to read a tsconfig: line comments, block comments, trailing commas. */
function stripJsonComments(text) {
  return text
    .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match, string) => string ?? "")
    .replace(/,(\s*[}\]])/g, "$1");
}

const workspaces = [];
test.after(() => {
  for (const dir of workspaces) fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs the generator in a throwaway directory and returns the result plus helpers. */
function generate(args = ["demo", "--yes"], { cwd } = {}) {
  const workspace = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "ion-gen-"));
  if (!cwd) workspaces.push(workspace);
  const result = spawnSync(process.execPath, [GENERATOR, ...args, "--ion-packages", PACKAGES], {
    cwd: workspace,
    encoding: "utf8",
  });
  const projectName = args.find((arg) => !arg.startsWith("--")) ?? "demo";
  const projectDir = path.join(workspace, projectName);
  return {
    result,
    workspace,
    projectDir,
    read: (relative) => fs.readFileSync(path.join(projectDir, relative), "utf8"),
    // tsconfig.json is JSONC — tsc allows comments and the generated one uses
    // them, so a plain JSON.parse is not enough to read the project's own files.
    json: (relative) => JSON.parse(stripJsonComments(fs.readFileSync(path.join(projectDir, relative), "utf8"))),
    exists: (relative) => fs.existsSync(path.join(projectDir, relative)),
  };
}

test("a generated project", async (t) => {
  const project = generate();

  await t.test("succeeds and reports where it wrote", () => {
    assert.equal(project.result.status, 0, project.result.stderr);
    assert.match(project.result.stdout, /npm install/);
  });

  await t.test("contains every file the first `npm run dev` needs", () => {
    for (const file of [
      "package.json", "ion.config.json", "tsconfig.json", ".gitignore", "README.md",
      "src/main.ts", "src/index.template.html",
      "src/game/Game.ts", "src/game/Player.ts", "src/game/assets.ts",
      "src/game/colliders.json", "src/game/particles.json", "src/game/environment.json",
      "src/game/sceneBindings.json",
      "src/game/ui/mainLayout.json", "src/game/ui/endcardLayout.json", "src/game/ui/bindings.json",
    ]) {
      assert.ok(project.exists(file), `missing ${file}`);
    }
  });

  await t.test("gives assets a home rather than leaving the location to guesswork", () => {
    assert.ok(project.exists("assets/models"));
    assert.ok(project.exists("assets/sounds"));
  });

  await t.test("contains no engine source at all", () => {
    // The whole client-access boundary rests on this: the engine arrives as a
    // dependency, so a generated tree that already contains it is a tree the
    // client can edit and commit.
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
      return [path.relative(project.projectDir, full)];
    });
    const files = walk(project.projectDir);
    assert.ok(!files.some((file) => file.startsWith("src/engine/")), "engine sources were written into src/");
    assert.ok(!files.some((file) => file.startsWith("IONEngine/")), "IONEngine/ is written by npm install, not the generator");
    assert.ok(files.every((file) => !file.endsWith("build.sh")), "the build pipeline is not the client's file");
  });

  await t.test("git-ignores everything that is ION's rather than the client's", () => {
    const ignored = project.read(".gitignore");
    for (const entry of ["node_modules/", "IONEngine/", "dist/", ".build-cache/"]) {
      assert.ok(ignored.includes(entry), `.gitignore is missing ${entry}`);
    }
  });

  await t.test("writes a config that ion's own loader accepts", async () => {
    const { loadConfig } = await import("../packages/project/lib/config.mjs");
    const config = loadConfig(project.projectDir);
    assert.equal(config.name, "demo");
    assert.equal(config.target, "playable-ad");
    assert.equal(config.build.budgetBytes, 5 * 1024 * 1024);
    assert.match(config.ionVersion, /^\d+\.\d+\.\d+/);
  });

  await t.test("pins ionVersion to the packages it was generated from", () => {
    const enginePackage = JSON.parse(fs.readFileSync(path.join(PACKAGES, "runtime", "package.json"), "utf8"));
    assert.equal(project.json("ion.config.json").ionVersion, enginePackage.version);
  });

  await t.test("declares the four ION packages and nothing of ION's build tooling as a direct dep", () => {
    const manifest = project.json("package.json");
    assert.ok(manifest.dependencies["@ion-engine/runtime"]);
    assert.ok(manifest.dependencies.three, "three is a peer of the runtime and must be installed");
    for (const dev of ["@ion-engine/editor", "@ion-engine/build", "@ion-engine/project"]) {
      assert.ok(manifest.devDependencies[dev], `${dev} should be a devDependency`);
    }
    assert.equal(manifest.dependencies["@ion-engine/editor"], undefined, "the editor must not be a production dependency");
    assert.equal(manifest.scripts.postinstall, "ion sync");
  });

  await t.test("the starter game imports only the public API", () => {
    const game = project.read("src/game/Game.ts");
    const player = project.read("src/game/Player.ts");
    for (const [name, source] of [["Game.ts", game], ["Player.ts", player]]) {
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
      for (const specifier of imports) {
        assert.ok(
          specifier === "ion" || specifier.startsWith("./") || specifier.startsWith("@ion-engine/"),
          `${name} imports ${specifier}, which reaches outside the public API`
        );
      }
      assert.ok(!source.includes("three"), `${name} should not need three.js`);
    }
  });

  await t.test("the entry boots through one runtime specifier", () => {
    // Two specifiers for the same package resolved to two files and produced
    // two `Ion` facades in the production bundle — "Ion used before
    // IonEngine.boot() finished" on a boot that had already finished.
    const main = project.read("src/main.ts");
    const specifiers = new Set(
      [...main.matchAll(/from\s+"([^"]+)"/g), ...main.matchAll(/import\("([^"]+)"\)/g)]
        .map((match) => match[1])
        .filter((specifier) => specifier === "ion" || specifier.startsWith("@ion-engine/"))
    );
    assert.ok(!(specifiers.has("ion") && specifiers.has("@ion-engine/runtime")), `main.ts mixes runtime specifiers: ${[...specifiers]}`);
  });

  await t.test("the editor is imported only behind a dev guard", () => {
    const main = project.read("src/main.ts");
    const editorLine = main.split("\n").findIndex((line) => line.includes("@ion-engine/editor"));
    assert.ok(editorLine >= 0, "the dev entry should install the editor");
    assert.match(main, /import\.meta\.env\.DEV/, "the editor import must be behind import.meta.env.DEV");
    assert.ok(!/^import .*@ion-engine\/editor/m.test(main), "the editor must be a dynamic import, not a static one");
  });

  await t.test("tsconfig maps the public specifiers at IONEngine/", () => {
    const tsconfig = project.json("tsconfig.json");
    const paths = tsconfig.compilerOptions.paths;
    for (const specifier of ["ion", "@ion-engine/runtime", "@ion-engine/editor"]) {
      assert.ok(paths[specifier], `tsconfig has no path mapping for "${specifier}"`);
      assert.ok(paths[specifier].every((target) => target.includes("IONEngine")), `"${specifier}" should map into IONEngine/`);
    }
  });
});

test("generator input handling", async (t) => {
  await t.test("refuses a project name that is not a usable package name", () => {
    const { result } = generate(["ok-dir", "--yes", "--name", "Not A Name"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /usable package name/i);
  });

  await t.test("derives a usable name from an awkward directory name", () => {
    // The positional argument is a *directory*; the project name is derived
    // from it, so "My Game" is a valid destination with the name "my-game".
    const project = generate(["My Game", "--yes"]);
    assert.equal(project.result.status, 0, project.result.stderr);
    assert.equal(project.json("ion.config.json").name, "my-game");
    // The printed instruction has to be runnable as printed.
    assert.match(project.result.stdout, /cd "My Game"/);
  });

  await t.test("refuses to write into a directory that already has files", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ion-gen-"));
    workspaces.push(workspace);
    fs.mkdirSync(path.join(workspace, "occupied"));
    fs.writeFileSync(path.join(workspace, "occupied", "keep.txt"), "mine");
    const { result } = generate(["occupied", "--yes"], { cwd: workspace });
    assert.notEqual(result.status, 0, "overwrote an occupied directory");
    assert.equal(fs.readFileSync(path.join(workspace, "occupied", "keep.txt"), "utf8"), "mine");
  });

  await t.test("each template writes its own orientation and resolution", () => {
    const expected = {
      "playable-ad": { orientation: "portrait", width: 1080 },
      "3d-game": { orientation: "landscape", width: 1920 },
      "web-game": { orientation: "both", width: 1280 },
    };
    for (const [template, want] of Object.entries(expected)) {
      const project = generate([template.replace(/-/g, ""), "--yes", "--template", template]);
      assert.equal(project.result.status, 0, project.result.stderr);
      const config = project.json("ion.config.json");
      assert.equal(config.target, template, `${template}: target`);
      assert.equal(config.orientation, want.orientation, `${template}: orientation`);
      assert.equal(config.resolution.width, want.width, `${template}: width`);
    }
  });

  await t.test("an unknown template is rejected rather than silently defaulted", () => {
    const { result } = generate(["tmpl", "--yes", "--template", "nonexistent"]);
    assert.notEqual(result.status, 0);
  });
});

test("ion.config.json validation", async (t) => {
  const { loadConfig } = await import("../packages/project/lib/config.mjs");

  function withConfig(config) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ion-cfg-"));
    workspaces.push(dir);
    fs.writeFileSync(path.join(dir, "ion.config.json"), typeof config === "string" ? config : JSON.stringify(config));
    return dir;
  }

  await t.test("missing file names the fix", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ion-cfg-"));
    workspaces.push(dir);
    assert.throws(() => loadConfig(dir), /create-ion-project/);
  });

  await t.test("malformed JSON is reported as malformed JSON", () => {
    assert.throws(() => loadConfig(withConfig("{ not json")), /not valid JSON/);
  });

  await t.test("every invalid field is listed, not just the first", () => {
    const dir = withConfig({ name: "no spaces allowed!", target: "nope", orientation: "sideways" });
    try {
      loadConfig(dir);
      assert.fail("expected a validation failure");
    } catch (err) {
      assert.match(err.message, /name/);
      assert.match(err.message, /target/);
      assert.match(err.message, /orientation/);
    }
  });

  await t.test("omitted fields fall back to defaults rather than undefined", () => {
    const config = loadConfig(withConfig({ name: "minimal" }));
    assert.equal(config.target, "playable-ad");
    assert.equal(config.build.singleFile, true);
    assert.equal(config.server.port, 8000);
  });

  await t.test("a partial nested object keeps its siblings' defaults", () => {
    const config = loadConfig(withConfig({ name: "partial", build: { budgetBytes: 1000 } }));
    assert.equal(config.build.budgetBytes, 1000);
    assert.equal(config.build.halfFloat, true, "an unrelated build field was dropped");
  });
});
