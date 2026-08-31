/**
 * Authored data files must still typecheck once they contain something.
 *
 * TypeScript infers a JSON array literal as `number[]`, never as a tuple. The
 * collider and particle schemas use `[number, number, number]` for every
 * transform, so `import data from "./particles.json"` followed by
 * `as ParticlesFileData` compiles fine while the file is empty and fails with
 * TS2352 the moment it holds one real emitter.
 *
 * That is a nasty failure mode: `tsc --noEmit` — and therefore `npm test` and
 * CI — broke not when anyone changed code, but when someone authored their
 * first particle effect in the editor and pressed Save. The engine's own
 * `npm test` cannot catch it either, unless the repository's `particles.json`
 * happens to be non-empty.
 *
 * So this compiles a fixture that always is. It is the one test here that
 * shells out to `tsc`, because the defect exists only at type-check time.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");

/** One emitter, with every tuple field populated — the shape the editor writes. */
const PARTICLES = {
  version: 1,
  systems: [
    {
      id: "sys_fire",
      name: "Fire",
      emitters: [
        {
          id: "em_fire",
          name: "Core",
          enabled: true,
          position: [0, 1, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          attachPath: "",
          attachName: "",
          main: { maxParticles: 200, startLifetime: { min: 0.4, max: 1.2 }, startSpeed: { min: 1, max: 3 } },
          emission: { enabled: true, rateOverTime: { min: 30, max: 30 }, bursts: [] },
          shape: { kind: "cone", radius: 0.5 },
          renderer: { blending: "additive", opacity: 1 },
        },
      ],
    },
  ],
};

const COLLIDERS = {
  version: 1,
  colliders: [
    {
      id: "col_goal",
      name: "Goal",
      shape: "box",
      size: [4, 2, 4],
      isTrigger: true,
      enabled: true,
      tag: "goal",
      mask: [],
      attachPath: "",
      attachName: "",
      offset: { position: [0, 1, 0], rotation: [0, 45, 0], scale: [1, 1, 1] },
    },
  ],
};

const BINDINGS = {
  version: 1,
  bindings: [{ className: "Game", fieldName: "spawn", objectPath: "Level/Spawn", objectName: "Spawn" }],
};

test("a populated data file typechecks when passed to its loader", async (t) => {
  // Inside the repository, not /tmp: the probe imports `three` as a bare
  // specifier and TypeScript resolves that by walking up for node_modules,
  // exactly the way a real project does.
  const dir = fs.mkdtempSync(path.join(ROOT, "node_modules", ".ion-jsontypes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, "particles.json"), JSON.stringify(PARTICLES, null, 2));
  fs.writeFileSync(path.join(dir, "colliders.json"), JSON.stringify(COLLIDERS, null, 2));
  fs.writeFileSync(path.join(dir, "sceneBindings.json"), JSON.stringify(BINDINGS, null, 2));

  const engine = path.join(ROOT, "src", "engine").split(path.sep).join("/");
  fs.writeFileSync(path.join(dir, "probe.ts"), `
import * as THREE from "three";
import { loadColliders, ColliderManager } from "${engine}/collision";
import { loadParticles, ParticleManager } from "${engine}/particles";
import { applySceneBindings } from "${engine}/SceneBindings";

import collidersRaw from "./colliders.json";
import particlesRaw from "./particles.json";
import sceneBindingsRaw from "./sceneBindings.json";

const scene = new THREE.Scene();
loadColliders(new ColliderManager(), collidersRaw, scene);
loadParticles(new ParticleManager(), particlesRaw, scene);
applySceneBindings({}, "Game", sceneBindingsRaw, scene);
`);

  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      esModuleInterop: true,
      // The engine branches on import.meta.env.DEV, so it needs Vite's client
      // types exactly as the project's own tsconfig does.
      types: ["vite/client"],
    },
    include: ["probe.ts"],
  }, null, 2));

  await t.test("loading them compiles", () => {
    const result = spawnSync("npx", ["tsc", "-p", path.join(dir, "tsconfig.json")], { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.equal(result.status, 0, `a populated data file no longer typechecks:\n${output}`);
    assert.ok(!output.includes("TS2352"), `TS2352 is back — a loader is asking for a tuple a .json import cannot provide:\n${output}`);
  });

  await t.test("the loaders take unknown, which is what makes that possible", async () => {
    // Stated as an assertion rather than left implicit: narrowing any of these
    // three back to its schema type reintroduces the failure above, and the
    // signature is the whole fix.
    const sources = {
      loadColliders: path.join(ROOT, "src/engine/collision/ColliderSerialization.ts"),
      loadParticles: path.join(ROOT, "src/engine/particles/ParticleSerialization.ts"),
      applySceneBindings: path.join(ROOT, "src/engine/SceneBindings.ts"),
    };
    for (const [name, file] of Object.entries(sources)) {
      const source = fs.readFileSync(file, "utf8");
      const signature = new RegExp("export function " + name + "\\(([^)]*)\\)", "s").exec(source);
      assert.ok(signature, `could not find ${name}'s signature`);
      assert.match(signature[1], /data: unknown/, `${name} no longer takes its data as unknown`);
    }
  });
});

test("the repository's own authored data still loads", async (t) => {
  // The engine's own particles.json used to be empty, which is the only reason
  // its `as ParticlesFileData` cast compiled. Now that it holds real systems,
  // the repository is itself a standing regression test — as long as nobody
  // empties it to "fix" a build.
  await t.test("src/game/particles.json has content", () => {
    const file = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "game", "particles.json"), "utf8"));
    assert.ok(Array.isArray(file.systems));
    assert.ok(file.systems.length > 0, "particles.json is empty again — the tuple-inference regression cannot be caught while it is");
    assert.ok(file.systems.every((system) => Array.isArray(system.emitters)));
  });
});
