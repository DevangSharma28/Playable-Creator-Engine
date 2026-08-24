/**
 * Behavioral tests for the ION Particle & VFX simulation.
 *
 * These exercise the *simulation* layer only — the part that's pure math
 * over typed arrays and has no DOM, no WebGL, and no THREE.Texture in it.
 * That's deliberate: the renderer needs a GL context (which is a browser's
 * job, and is verified by actually running the editor), while the
 * simulation is where a wrong sign, an off-by-one in the buffer's
 * swap-remove, or a broken seed would hide silently and only ever show up
 * as "the effect looks a bit odd".
 *
 * The sources are bundled with esbuild rather than imported directly, for
 * the same reason tests/lib/geometry-source.mjs transforms UILayout.ts:
 * they're TypeScript with sibling imports, and Node can't load either
 * without a build step.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Bundles the DOM-free half of the particle runtime and hands back its
 * live exports.
 *
 * Deliberately *not* `particles/index.ts`: that re-exports
 * ParticleSerialization, which imports SceneBindings -> Ion -> Cta ->
 * MraidAdapter, and MraidAdapter reads `window` at module scope. Pulling
 * the whole barrel in would mean stubbing a browser to test arithmetic.
 * Naming the four modules that actually contain the simulation keeps the
 * bundle honest about what's under test — and if one of them ever grows a
 * DOM dependency, this fails loudly instead of quietly being propped up
 * by a stub.
 */
async function loadParticles() {
  const dir = join(ROOT, "src", "engine", "particles");
  const result = await esbuild.build({
    stdin: {
      contents: `
        export { ParticleBuffer } from ${JSON.stringify(join(dir, "ParticleBuffer.ts"))};
        export { ParticleRandom, evaluateCurve, evaluateGradient, valueNoise3 } from ${JSON.stringify(join(dir, "ParticleRandom.ts"))};
        export { ParticleSimulation } from ${JSON.stringify(join(dir, "ParticleSimulation.ts"))};
        export { normalizeEmitterConfig, defaultEmitterConfig, cloneEmitterConfig } from ${JSON.stringify(join(dir, "ParticleDefaults.ts"))};
        export { ParticleManager } from ${JSON.stringify(join(dir, "ParticleManager.ts"))};
        export { ParticleSystem } from ${JSON.stringify(join(dir, "ParticleSystem.ts"))};
        export { ParticleEmitter } from ${JSON.stringify(join(dir, "ParticleEmitter.ts"))};
        export { ParticleTrails } from ${JSON.stringify(join(dir, "ParticleTrails.ts"))};
        export { EditorHistory } from ${JSON.stringify(join(ROOT, "src", "engine", "editor", "EditorHistory.ts"))};
        export * as THREE from "three";
      `,
      resolveDir: dir,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2020",
    write: false,
    // import.meta.env.DEV guards a dev-only warning inside the runtime;
    // esbuild has no Vite to define it, so it's substituted here the same
    // way a production build would.
    define: { "import.meta.env.DEV": "false" },
  });
  const out = mkdtempSync(join(tmpdir(), "ion-particles-"));
  const outFile = join(out, "particles.mjs");
  writeFileSync(outFile, result.outputFiles[0].text, "utf8");
  return import(pathToFileURL(outFile).href);
}

/**
 * The smallest DOM the particle *renderer* needs to be constructible.
 *
 * ParticleEmitter builds a ParticleRenderer, which resolves the shared
 * default texture, which paints a radial gradient into a canvas. None of
 * that is under test here — the composition-order tests below only care
 * that constructing an emitter doesn't throw and that lifecycle ordering
 * is right — so this stubs the surface rather than pulling in a full
 * jsdom.
 *
 * `getContext` returns null on purpose: getDefaultParticleTexture already
 * guards for it (a canvas with no 2D context is a real browser condition),
 * so the texture comes out blank instead of painted, which is exactly the
 * amount of fidelity these tests need.
 */
function installMinimalDom() {
  if (globalThis.document) return;
  globalThis.document = {
    createElement(tag) {
      if (tag !== "canvas") return {};
      return { width: 0, height: 0, getContext: () => null };
    },
    createElementNS: () => ({ style: {} }),
  };
  globalThis.window = globalThis;
  globalThis.self = globalThis;
}

installMinimalDom();
const mod = await loadParticles();
const { ParticleBuffer, ParticleRandom, ParticleSimulation, normalizeEmitterConfig, evaluateCurve, evaluateGradient, ParticleManager, ParticleTrails, EditorHistory, THREE } = mod;

/** Builds a simulation over a normalized config, with no renderer involved. */
function makeSim(partial, seed = 1234) {
  const config = normalizeEmitterConfig(partial, "Test");
  const buffer = new ParticleBuffer(config.main.maxParticles);
  const rng = new ParticleRandom(seed);
  const sim = new ParticleSimulation(config, buffer, rng, {});
  return { config, buffer, sim };
}

/** Steps a simulation for `seconds` at a fixed 60Hz, the way the engine loop would. */
function run(sim, seconds, dt = 1 / 60) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) sim.step(dt);
}

test("emission: a continuous rate produces roughly rate x time particles", () => {
  const { buffer, sim } = makeSim({
    main: { duration: 100, loop: false, startLifetime: { min: 100, max: 100 }, maxParticles: 5000, autoRandomSeed: false, playOnStart: false },
    emission: { enabled: true, rateOverTime: { min: 60, max: 60 }, bursts: [] },
  });
  sim.play();
  run(sim, 1);
  // Nothing has died (lifetime is 100s), so every emitted particle is
  // still live. Allow a couple either way for the fractional-debt carry.
  assert.ok(Math.abs(buffer.count - 60) <= 2, `expected ~60 particles, got ${buffer.count}`);
});

test("emission: a burst fires exactly once per cycle, not every frame", () => {
  const { buffer, sim } = makeSim({
    main: { duration: 100, loop: false, startLifetime: { min: 100, max: 100 }, maxParticles: 5000, autoRandomSeed: false, playOnStart: false },
    emission: { enabled: true, rateOverTime: { min: 0, max: 0 }, bursts: [{ time: 0.1, count: { min: 25, max: 25 }, cycles: 1, interval: 0.01, probability: 1 }] },
  });
  sim.play();
  run(sim, 2);
  assert.equal(buffer.count, 25, "a one-cycle burst must fire once, not once per frame");
});

test("emission: a burst is never skipped by a frame that steps over it", () => {
  const { buffer, sim } = makeSim({
    main: { duration: 100, loop: false, startLifetime: { min: 100, max: 100 }, maxParticles: 5000, autoRandomSeed: false, playOnStart: false },
    emission: { enabled: true, rateOverTime: { min: 0, max: 0 }, bursts: [{ time: 0.02, count: { min: 10, max: 10 }, cycles: 1, interval: 0.01, probability: 1 }] },
  });
  sim.play();
  // One long frame that jumps clean past the burst's scheduled time — the
  // window-based check is what stops this being missed entirely.
  sim.step(0.5);
  assert.equal(buffer.count, 10, "a burst inside a long frame's window must still fire");
});

test("lifetime: particles die exactly when their lifetime elapses", () => {
  const { buffer, sim } = makeSim({
    main: { duration: 0.01, loop: false, startLifetime: { min: 0.5, max: 0.5 }, maxParticles: 100, autoRandomSeed: false, playOnStart: false },
    emission: { enabled: true, rateOverTime: { min: 0, max: 0 }, bursts: [{ time: 0, count: { min: 10, max: 10 }, cycles: 1, interval: 0.01, probability: 1 }] },
  });
  sim.play();
  sim.step(1 / 60);
  assert.equal(buffer.count, 10);
  run(sim, 0.4);
  assert.equal(buffer.count, 10, "still alive before the lifetime is up");
  run(sim, 0.2);
  assert.equal(buffer.count, 0, "every particle must be reclaimed once its lifetime elapses");
});

test("buffer: maxParticles is a hard cap that is never exceeded", () => {
  const { buffer, sim } = makeSim({
    main: { duration: 100, loop: false, startLifetime: { min: 100, max: 100 }, maxParticles: 32, autoRandomSeed: false, playOnStart: false },
    emission: { enabled: true, rateOverTime: { min: 5000, max: 5000 }, bursts: [] },
  });
  sim.play();
  run(sim, 2);
  assert.equal(buffer.count, 32, "the buffer must fill to exactly its capacity and stop");
  assert.equal(buffer.capacity, 32);
});

test("buffer: swap-remove keeps the live range dense and contiguous", () => {
  const buffer = new ParticleBuffer(8);
  for (let i = 0; i < 5; i++) {
    const slot = buffer.spawn();
    buffer.posX[slot] = i;
  }
  assert.equal(buffer.count, 5);
  // Kill the middle one — the last live particle must move into its slot.
  buffer.swapRemove(1);
  assert.equal(buffer.count, 4);
  const xs = [buffer.posX[0], buffer.posX[1], buffer.posX[2], buffer.posX[3]].sort((a, b) => a - b);
  assert.deepEqual(xs, [0, 2, 3, 4], "the surviving particles must all still be in [0, count)");
});

test("buffer: birth ids are never reused, even as slots are", () => {
  const buffer = new ParticleBuffer(4);
  const a = buffer.spawn();
  const firstId = buffer.birthId[a];
  buffer.swapRemove(a);
  const b = buffer.spawn();
  assert.equal(b, a, "the slot itself is reused");
  assert.notEqual(buffer.birthId[b], firstId, "but its birth id must not be — trails and sub-emitters depend on this");
});

test("gravity: a positive modifier pulls particles down", () => {
  const { buffer, sim } = makeSim({
    main: { duration: 100, loop: false, startLifetime: { min: 10, max: 10 }, startSpeed: { min: 0, max: 0 }, gravityModifier: 1, maxParticles: 10, simulationSpace: "world", autoRandomSeed: false, playOnStart: false },
    emission: { enabled: true, rateOverTime: { min: 0, max: 0 }, bursts: [{ time: 0, count: { min: 1, max: 1 }, cycles: 1, interval: 0.01, probability: 1 }] },
    shape: { enabled: true, kind: "sphere", radius: 0, radiusThickness: 0 },
  });
  sim.play();
  run(sim, 1);
  // s = 1/2 g t^2 with g = 9.81 over 1s is about -4.9. Integrated
  // discretely, so an exact match isn't expected — the sign and the
  // magnitude are what matter.
  assert.ok(buffer.posY[0] < -4 && buffer.posY[0] > -6, `expected ~-4.9 after 1s of gravity, got ${buffer.posY[0]}`);
});

test("determinism: the same seed reproduces the same simulation exactly", () => {
  const build = () =>
    makeSim(
      {
        main: { duration: 100, loop: false, startLifetime: { min: 5, max: 5 }, startSpeed: { min: 1, max: 4 }, maxParticles: 200, autoRandomSeed: false, playOnStart: false },
        emission: { enabled: true, rateOverTime: { min: 50, max: 50 }, bursts: [] },
        shape: { enabled: true, kind: "cone", radius: 0.5, coneAngle: 25 },
        noise: { enabled: true, strength: 0.8, frequency: 1, scrollSpeed: 0.5, octaves: 2, damping: 0.5 },
      },
      98765
    );

  const a = build();
  const b = build();
  a.sim.play();
  b.sim.play();
  run(a.sim, 1.5);
  run(b.sim, 1.5);

  assert.equal(a.buffer.count, b.buffer.count, "particle counts must match");
  assert.ok(a.buffer.count > 10, "the test is only meaningful with real particles in flight");
  for (let i = 0; i < a.buffer.count; i++) {
    assert.equal(a.buffer.posX[i], b.buffer.posX[i], `posX diverged at ${i}`);
    assert.equal(a.buffer.posY[i], b.buffer.posY[i], `posY diverged at ${i}`);
    assert.equal(a.buffer.posZ[i], b.buffer.posZ[i], `posZ diverged at ${i}`);
  }
});

test("determinism: a different seed produces a different simulation", () => {
  const cfg = {
    main: { duration: 100, loop: false, startLifetime: { min: 5, max: 5 }, startSpeed: { min: 1, max: 4 }, maxParticles: 200, autoRandomSeed: false, playOnStart: false },
    emission: { enabled: true, rateOverTime: { min: 50, max: 50 }, bursts: [] },
    shape: { enabled: true, kind: "sphere", radius: 0.5 },
  };
  const a = makeSim(cfg, 1);
  const b = makeSim(cfg, 2);
  a.sim.play();
  b.sim.play();
  run(a.sim, 1);
  run(b.sim, 1);
  assert.ok(a.buffer.count > 10, "the test is only meaningful with real particles in flight");
  let differences = 0;
  for (let i = 0; i < Math.min(a.buffer.count, b.buffer.count); i++) {
    if (a.buffer.posX[i] !== b.buffer.posX[i]) differences++;
  }
  assert.ok(differences > 0, "two different seeds must not produce identical output");
});

test("shape: a zero-thickness sphere emits onto its surface shell", () => {
  const { config, buffer, sim } = makeSim({
    main: { duration: 100, loop: false, startLifetime: { min: 10, max: 10 }, startSpeed: { min: 0, max: 0 }, maxParticles: 200, autoRandomSeed: false, playOnStart: false },
    emission: { enabled: true, rateOverTime: { min: 0, max: 0 }, bursts: [{ time: 0, count: { min: 100, max: 100 }, cycles: 1, interval: 0.01, probability: 1 }] },
    shape: { enabled: true, kind: "sphere", radius: 2, radiusThickness: 0 },
  });
  sim.play();
  sim.step(1 / 60);
  assert.equal(buffer.count, 100);
  for (let i = 0; i < buffer.count; i++) {
    const r = Math.hypot(buffer.posX[i], buffer.posY[i], buffer.posZ[i]);
    assert.ok(Math.abs(r - config.shape.radius) < 1e-4, `particle ${i} is at radius ${r}, expected ${config.shape.radius}`);
  }
});

test("shape: a box emitter keeps every particle inside its own extents", () => {
  const { buffer, sim } = makeSim({
    main: { duration: 100, loop: false, startLifetime: { min: 10, max: 10 }, startSpeed: { min: 0, max: 0 }, maxParticles: 300, autoRandomSeed: false, playOnStart: false },
    emission: { enabled: true, rateOverTime: { min: 0, max: 0 }, bursts: [{ time: 0, count: { min: 200, max: 200 }, cycles: 1, interval: 0.01, probability: 1 }] },
    shape: { enabled: true, kind: "box", boxSize: [4, 2, 6], radiusThickness: 1 },
  });
  sim.play();
  sim.step(1 / 60);
  for (let i = 0; i < buffer.count; i++) {
    assert.ok(Math.abs(buffer.posX[i]) <= 2.0001, `x out of range: ${buffer.posX[i]}`);
    assert.ok(Math.abs(buffer.posY[i]) <= 1.0001, `y out of range: ${buffer.posY[i]}`);
    assert.ok(Math.abs(buffer.posZ[i]) <= 3.0001, `z out of range: ${buffer.posZ[i]}`);
  }
});

test("collision: killOnContact removes particles at the plane", () => {
  const { buffer, sim } = makeSim({
    main: { duration: 100, loop: false, startLifetime: { min: 10, max: 10 }, startSpeed: { min: 0, max: 0 }, gravityModifier: 1, maxParticles: 50, simulationSpace: "world", autoRandomSeed: false, playOnStart: false },
    emission: { enabled: true, rateOverTime: { min: 0, max: 0 }, bursts: [{ time: 0, count: { min: 20, max: 20 }, cycles: 1, interval: 0.01, probability: 1 }] },
    shape: { enabled: true, kind: "sphere", radius: 0, radiusThickness: 0 },
    collision: { enabled: true, planeY: -1, killOnContact: true, bounce: 0, friction: 0, lifetimeLoss: 0 },
  });
  sim.play();
  sim.step(1 / 60);
  assert.equal(buffer.count, 20);
  run(sim, 1);
  assert.equal(buffer.count, 0, "gravity should have driven every particle through the kill plane");
});

test("modules: a disabled module genuinely has no effect", () => {
  const base = {
    main: { duration: 100, loop: false, startLifetime: { min: 5, max: 5 }, startSpeed: { min: 0, max: 0 }, maxParticles: 20, autoRandomSeed: false, playOnStart: false },
    emission: { enabled: true, rateOverTime: { min: 0, max: 0 }, bursts: [{ time: 0, count: { min: 5, max: 5 }, cycles: 1, interval: 0.01, probability: 1 }] },
    shape: { enabled: true, kind: "sphere", radius: 0, radiusThickness: 0 },
  };
  const off = makeSim({ ...base, force: { enabled: false, force: { x: { min: 50, max: 50 }, y: { min: 0, max: 0 }, z: { min: 0, max: 0 } }, drag: 0 } }, 7);
  const on = makeSim({ ...base, force: { enabled: true, force: { x: { min: 50, max: 50 }, y: { min: 0, max: 0 }, z: { min: 0, max: 0 } }, drag: 0 } }, 7);
  off.sim.play();
  on.sim.play();
  run(off.sim, 0.5);
  run(on.sim, 0.5);
  assert.equal(off.buffer.posX[0], 0, "a disabled Force module must not move anything");
  assert.ok(on.buffer.posX[0] > 1, "the same module enabled must actually apply force");
});

test("curves: evaluateCurve clamps outside its key range instead of extrapolating", () => {
  const keys = [
    { t: 0.25, v: 2 },
    { t: 0.75, v: 6 },
  ];
  assert.equal(evaluateCurve(keys, 0), 2, "before the first key holds its value");
  assert.equal(evaluateCurve(keys, 1), 6, "after the last key holds its value");
  assert.equal(evaluateCurve(keys, 0.5), 4, "linear between keys");
  assert.equal(evaluateCurve([], 0.5), 1, "an empty curve is neutral, not NaN");
});

test("gradients: evaluateGradient interpolates RGBA into a caller-owned array", () => {
  const out = new Float32Array(4);
  evaluateGradient(
    [
      { t: 0, color: [1, 0, 0], alpha: 1 },
      { t: 1, color: [0, 0, 1], alpha: 0 },
    ],
    0.5,
    out
  );
  assert.ok(Math.abs(out[0] - 0.5) < 1e-6, `r=${out[0]}`);
  assert.equal(out[1], 0);
  assert.ok(Math.abs(out[2] - 0.5) < 1e-6, `b=${out[2]}`);
  assert.ok(Math.abs(out[3] - 0.5) < 1e-6, `a=${out[3]}`);
});

test("lifecycle: stop() lets live particles finish, clear() kills them now", () => {
  const { buffer, sim } = makeSim({
    main: { duration: 100, loop: false, startLifetime: { min: 2, max: 2 }, maxParticles: 200, autoRandomSeed: false, playOnStart: false },
    emission: { enabled: true, rateOverTime: { min: 60, max: 60 }, bursts: [] },
  });
  sim.play();
  run(sim, 0.5);
  const beforeStop = buffer.count;
  assert.ok(beforeStop > 0);
  sim.stop();
  run(sim, 0.2);
  assert.equal(buffer.count, beforeStop, "stop() must not kill anything already alive");
  assert.equal(sim.isPlaying, false);
  sim.clear();
  assert.equal(buffer.count, 0, "clear() removes them immediately");
});

test("lifecycle: a non-looping system reports finished once it has drained", () => {
  const { sim } = makeSim({
    main: { duration: 0.2, loop: false, startLifetime: { min: 0.3, max: 0.3 }, maxParticles: 100, autoRandomSeed: false, playOnStart: false },
    emission: { enabled: true, rateOverTime: { min: 60, max: 60 }, bursts: [] },
  });
  sim.play();
  run(sim, 0.1);
  assert.equal(sim.isFinished, false, "still emitting");
  run(sim, 1);
  assert.equal(sim.isFinished, true, "past duration and past every lifetime");
});

// ---------------------------------------------------------------------------
// Composition — ParticleManager -> ParticleSystem -> ParticleEmitter.
//
// These exist because the simulation tests above all drove
// ParticleSimulation directly and therefore never exercised the wiring
// between the three classes. A prewarming emitter spawning particles from
// inside its own constructor crashed on exactly that gap: the sub-emitter
// closures captured a `const` that was still in its temporal dead zone.
// ---------------------------------------------------------------------------

/** A system config with `n` emitters, all prewarming (the case that broke). */
function prewarmSystem(space, extra = {}) {
  return {
    id: "sys_test",
    name: "Test System",
    emitters: [
      normalizeEmitterConfig(
        {
          id: "em_a",
          name: "A",
          position: [3, 1, -2],
          main: {
            duration: 2,
            loop: true,
            prewarm: true,
            playOnStart: true,
            simulationSpace: space,
            startLifetime: { min: 5, max: 5 },
            startSpeed: { min: 0, max: 0 },
            maxParticles: 200,
            autoRandomSeed: false,
          },
          emission: { enabled: true, rateOverTime: { min: 30, max: 30 }, bursts: [] },
          shape: { enabled: true, kind: "sphere", radius: 0, radiusThickness: 0 },
          ...extra,
        },
        "A"
      ),
      normalizeEmitterConfig(
        {
          id: "em_b",
          name: "B",
          main: { duration: 2, loop: true, playOnStart: true, maxParticles: 100, autoRandomSeed: false },
          emission: { enabled: true, rateOverTime: { min: 0, max: 0 }, bursts: [] },
        },
        "B"
      ),
    ],
  };
}

test("composition: a prewarming emitter can be created without throwing", () => {
  // The original crash: ParticleEmitter's constructor called play() ->
  // prewarm() -> spawnOne() -> onBirth, while ParticleSystem's own
  // `const emitter = new ParticleEmitter(...)` was still evaluating.
  const manager = new ParticleManager();
  let system;
  assert.doesNotThrow(() => {
    system = manager.create(prewarmSystem("local"));
  }, "creating a prewarming system must not throw");
  assert.equal(system.all.length, 2);
  manager.clear();
});

test("composition: a prewarming emitter with sub-emitters wired does not throw", () => {
  // The exact shape that crashed — emitter A fires B on particle birth, so
  // the sub-emitter path runs during the prewarm.
  const config = prewarmSystem("local", {
    subEmitters: { enabled: true, entries: [{ trigger: "birth", emitter: "B", count: 1, probability: 1, inheritVelocity: 0 }] },
  });
  const manager = new ParticleManager();
  let system;
  assert.doesNotThrow(() => {
    system = manager.create(config);
  });
  // The sub-emitter must actually have fired during the prewarm, not just
  // failed silently — otherwise this test would pass on a null-guard that
  // swallowed the whole feature.
  assert.ok(system.get("B").activeParticles > 0, "sub-emitter B should have been fired by A's prewarm");
  manager.clear();
});

test("composition: playOnStart is honoured, and prewarm fills the buffer", () => {
  const manager = new ParticleManager();
  const system = manager.create(prewarmSystem("local"));
  const a = system.get("A");
  assert.equal(a.isPlaying(), true, "playOnStart must start the emitter");
  // 30/sec over a 2s duration, so a full prewarm is ~60 particles.
  assert.ok(a.activeParticles > 40, `prewarm should have populated the buffer, got ${a.activeParticles}`);
  manager.clear();
});

test("composition: a world-space prewarm spawns at the emitter's transform, not the origin", () => {
  // The second bug the constructor-time play() caused: prewarm ran before
  // setWorldRoot()/syncTransform(), so simulation.worldMatrix was
  // undefined and every prewarmed particle baked in an identity transform
  // — landing the whole backlog at the origin instead of at (3, 1, -2).
  const manager = new ParticleManager();
  const system = manager.create(prewarmSystem("world"));
  const a = system.get("A");
  assert.ok(a.activeParticles > 0, "the test needs prewarmed particles to inspect");

  const buf = a.__buffer();
  let atOrigin = 0;
  for (let i = 0; i < a.activeParticles; i++) {
    if (Math.abs(buf.posX[i]) < 0.001 && Math.abs(buf.posY[i]) < 0.001 && Math.abs(buf.posZ[i]) < 0.001) atOrigin++;
  }
  assert.equal(atOrigin, 0, "no world-space prewarmed particle should sit at the origin");
  // Positively: they should be at the emitter's own transform, (3, 1, -2),
  // since startSpeed is 0 and the shape radius is 0.
  assert.ok(Math.abs(buf.posX[0] - 3) < 0.001, `expected x=3, got ${buf.posX[0]}`);
  assert.ok(Math.abs(buf.posZ[0] + 2) < 0.001, `expected z=-2, got ${buf.posZ[0]}`);
  manager.clear();
});

test("composition: manager.clear() releases every system", () => {
  const manager = new ParticleManager();
  manager.create(prewarmSystem("local"));
  assert.equal(manager.all.length, 1);
  manager.clear();
  assert.equal(manager.all.length, 0, "clear() must empty the registry");
});

// ---------------------------------------------------------------------------
// Regressions. Every test below reproduces a bug that was actually in the
// code, and each was checked to fail against the original.
// ---------------------------------------------------------------------------

test("regression: a burst at time 0 fires on every cycle of a looping emitter", () => {
  // The wrap left the new cycle starting at the leftover remainder rather
  // than at 0, so a burst scheduled at 0 fell *before* the next window and
  // was skipped — yet still consumed, so it fired on cycle 1 and never
  // again. Both the Explosion and Coin Burst demos are exactly this shape.
  const { buffer, sim } = makeSim({
    main: { duration: 0.5, loop: true, startLifetime: { min: 100, max: 100 }, maxParticles: 5000, autoRandomSeed: false, playOnStart: false },
    emission: { enabled: true, rateOverTime: { min: 0, max: 0 }, bursts: [{ time: 0, count: { min: 5, max: 5 }, cycles: 1, interval: 0.01, probability: 1 }] },
  });
  sim.play();
  run(sim, 2.05); // ~5 cycle starts at duration 0.5
  assert.ok(buffer.count >= 20, `a t=0 burst should repeat every cycle; got only ${buffer.count} particles (one cycle's worth is 5)`);
});

test("regression: a burst does not double-fire across a cycle boundary", () => {
  // The other half of the same fix — the window's lower bound stays
  // half-open except at a genuine cycle start, so slicing the frame at the
  // boundary must not fire the same burst twice.
  const { buffer, sim } = makeSim({
    main: { duration: 1, loop: true, startLifetime: { min: 100, max: 100 }, maxParticles: 5000, autoRandomSeed: false, playOnStart: false },
    emission: { enabled: true, rateOverTime: { min: 0, max: 0 }, bursts: [{ time: 0.5, count: { min: 10, max: 10 }, cycles: 1, interval: 0.01, probability: 1 }] },
  });
  sim.play();
  run(sim, 1.0); // exactly one cycle: the mid-cycle burst must fire once
  assert.equal(buffer.count, 10, `expected exactly one burst in one cycle, got ${buffer.count / 10}`);
});

test("regression: normalizeEmitterConfig deep-copies, so two effects never share arrays", () => {
  // The module spreads carried gradient/curve/bursts arrays through by
  // reference from the source object — which is either a shared entry in
  // PARTICLE_PRESETS or the cached particles.json module. Editing one
  // effect recoloured every sibling built from the same source.
  const partial = {
    colorOverLifetime: { enabled: true, gradient: [{ t: 0, color: [1, 0, 0], alpha: 1 }] },
    emission: { enabled: true, rateOverTime: { min: 1, max: 1 }, bursts: [{ time: 0, count: { min: 1, max: 1 }, cycles: 1, interval: 1, probability: 1 }] },
  };
  const a = normalizeEmitterConfig(partial, "A");
  const b = normalizeEmitterConfig(partial, "B");

  assert.notEqual(a.colorOverLifetime.gradient, b.colorOverLifetime.gradient, "gradient arrays must not be shared");
  assert.notEqual(a.emission.bursts, b.emission.bursts, "burst arrays must not be shared");

  a.colorOverLifetime.gradient[0].color[0] = 0.25;
  a.emission.bursts[0].time = 99;
  assert.equal(b.colorOverLifetime.gradient[0].color[0], 1, "editing A must not reach B");
  assert.equal(b.emission.bursts[0].time, 0, "editing A must not reach B");
  assert.equal(partial.colorOverLifetime.gradient[0].color[0], 1, "editing A must not mutate the source literal");
});

test("regression: an attached emitter's local offset does not drift", () => {
  // syncTransform writes the *world* transform onto the node for an
  // attached emitter. The editor calls adoptNodeTransform every frame, and
  // copying node.position straight back into config.position stored a
  // world position in a field read as a local offset — compounding by the
  // attachment's transform every single frame.
  const manager = new ParticleManager();
  const system = manager.create(prewarmSystem("local"));
  const emitter = system.get("A");

  const host = new THREE.Object3D();
  host.position.set(5, 2, -1);
  host.updateWorldMatrix(true, false);
  emitter.attached = host;

  const before = [...emitter.settings.position];
  // Exactly what EditorParticles.update() does each frame.
  for (let i = 0; i < 60; i++) {
    emitter.update(1 / 60, undefined);
    emitter.adoptNodeTransform();
  }
  const after = emitter.settings.position;
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(
      Math.abs(after[axis] - before[axis]) < 1e-3,
      `axis ${axis} drifted from ${before[axis]} to ${after[axis]} over 60 frames`
    );
  }
  manager.clear();
});

test("regression: trail points all age, not just the oldest", () => {
  const trails = new ParticleTrails(
    { enabled: true, ratio: 1, lifetime: 0.2, minVertexDistance: 0.01, maxPoints: 8, widthStart: 0.1, widthEnd: 0, inheritParticleColor: false, color: [1, 1, 1] },
    4
  );
  const buffer = new ParticleBuffer(4);
  const slot = buffer.spawn();
  buffer.rand3[slot] = 0; // below ratio, so it trails

  // Lay down several points by moving the particle each frame.
  for (let i = 0; i < 6; i++) {
    buffer.posX[slot] = i * 0.5;
    trails.update(buffer, 1 / 60);
  }

  // Now stop feeding it and let time pass well beyond the trail lifetime.
  // With the aging loop breaking at the first surviving point, only the
  // oldest point aged per frame, so the trail survived roughly
  // lifetime x maxPoints instead of lifetime.
  buffer.swapRemove(slot);
  for (let i = 0; i < 30; i++) trails.update(buffer, 1 / 60); // 0.5s >> 0.2s lifetime

  const anyLive = trails.__slots().some((s) => s.count > 0);
  assert.equal(anyLive, false, "every trail point should have expired well within 0.5s at a 0.2s lifetime");
  trails.dispose();
});

test("regression: a world-space sub-emitter spawns at the trigger point, not offset by its own position", () => {
  // spawnPosition had the emitter's world matrix applied (including its
  // translation) and then the trigger origin added on top, so a sub-emitter
  // appeared at (emitterPos + parentParticlePos).
  const manager = new ParticleManager();
  const system = manager.create({
    id: "sys_sub",
    name: "Sub",
    emitters: [
      normalizeEmitterConfig(
        {
          id: "em_parent",
          name: "Parent",
          position: [10, 0, 0],
          main: { duration: 100, loop: false, prewarm: false, playOnStart: false, simulationSpace: "world", startLifetime: { min: 100, max: 100 }, startSpeed: { min: 0, max: 0 }, maxParticles: 10, autoRandomSeed: false },
          emission: { enabled: true, rateOverTime: { min: 0, max: 0 }, bursts: [] },
          shape: { enabled: true, kind: "sphere", radius: 0, radiusThickness: 0 },
          subEmitters: { enabled: true, entries: [{ trigger: "birth", emitter: "Child", count: 1, probability: 1, inheritVelocity: 0 }] },
        },
        "Parent"
      ),
      normalizeEmitterConfig(
        {
          id: "em_child",
          name: "Child",
          position: [10, 0, 0],
          main: { duration: 100, loop: false, prewarm: false, playOnStart: false, simulationSpace: "world", startLifetime: { min: 100, max: 100 }, startSpeed: { min: 0, max: 0 }, maxParticles: 10, autoRandomSeed: false },
          emission: { enabled: true, rateOverTime: { min: 0, max: 0 }, bursts: [] },
          shape: { enabled: true, kind: "sphere", radius: 0, radiusThickness: 0 },
        },
        "Child"
      ),
    ],
  });

  const parent = system.get("Parent");
  const child = system.get("Child");
  // Give both a real world matrix, as the frame loop would.
  parent.update(1 / 60, undefined);
  child.update(1 / 60, undefined);

  parent.emit(1);
  assert.equal(child.activeParticles, 1, "the sub-emitter should have fired on birth");

  // The parent particle is at world x = 10 (its emitter position, zero
  // shape radius, zero speed). The child must land there too — not at 20.
  const cb = child.__buffer();
  assert.ok(Math.abs(cb.posX[0] - 10) < 1e-4, `child spawned at x=${cb.posX[0]}, expected 10 (20 means the emitter position was double-counted)`);
  manager.clear();
});

// ---------------------------------------------------------------------------
// Editor lifecycle: opening or closing the 3D editor must never disturb a
// running effect.
// ---------------------------------------------------------------------------

test("editor: detaching and re-adding a system preserves the same instances", () => {
  // The undo path for "delete a system" removes it with keepAlive and
  // re-adds the identical object, so every existing reference — a
  // sub-emitter target, a Control Desk assignment — keeps resolving.
  const manager = new ParticleManager();
  const system = manager.create(prewarmSystem("local"));
  const emitterA = system.get("A");
  const emitterB = system.get("B");

  manager.remove(system, true);
  assert.equal(manager.all.length, 0, "system should be unregistered");

  manager.readd(system);
  assert.equal(manager.all.length, 1);
  assert.equal(system.get("A"), emitterA, "the same emitter instance must come back, not a copy");
  assert.equal(system.get("B"), emitterB);
  // Re-parenting is the easy thing to get wrong: a world-space emitter's
  // render mesh lives under the manager's group, not the system's.
  assert.ok(emitterA.node.parent, "emitter node must be re-parented");
  manager.clear();
});

test("editor: a detached-then-readded emitter keeps working", () => {
  const manager = new ParticleManager();
  const system = manager.create(prewarmSystem("local"));
  const emitter = system.get("A");

  system.removeEmitter(emitter, true);
  assert.equal(system.all.length, 1, "only B should remain");
  system.readdEmitter(emitter);
  assert.equal(system.all.length, 2);
  assert.equal(system.get("A"), emitter, "the same instance");

  emitter.play();
  emitter.update(1 / 60, undefined);
  assert.equal(emitter.isPlaying(), true, "a restored emitter must still simulate");
  manager.clear();
});

// ---------------------------------------------------------------------------
// Undo / redo.
// ---------------------------------------------------------------------------

test("history: undo and redo walk the stack in order", () => {
  const history = new EditorHistory();
  const log = [];
  for (const n of [1, 2, 3]) {
    history.push({ label: `step ${n}`, undo: () => log.push(`-${n}`), redo: () => log.push(`+${n}`) });
  }
  assert.equal(history.canUndo, true);
  assert.equal(history.canRedo, false);
  assert.equal(history.undoLabel, "step 3");

  history.undo();
  history.undo();
  assert.deepEqual(log, ["-3", "-2"]);
  assert.equal(history.redoLabel, "step 2");

  history.redo();
  assert.deepEqual(log, ["-3", "-2", "+2"]);
  assert.equal(history.canRedo, true, "step 3 is still redoable");
});

test("history: a new action discards the redo branch and releases what it held", () => {
  const history = new EditorHistory();
  const discarded = [];
  history.push({ label: "a", undo: () => {}, redo: () => {}, discard: (s) => discarded.push(`a:${s}`) });
  history.undo();
  assert.equal(history.canRedo, true);

  history.push({ label: "b", undo: () => {}, redo: () => {} });
  assert.equal(history.canRedo, false, "the redo branch must be gone");
  // "a" was on the redo stack, so it was unapplied — its undo() is the live
  // state and its redo() will never run again. A create command in that
  // position is holding a detached object that has to be released.
  assert.deepEqual(discarded, ["a:unapplied"]);
});

test("history: consecutive same-key changes coalesce into one entry", () => {
  const history = new EditorHistory();
  // A slider drag: many pushes, same key, all within the merge window.
  for (let i = 1; i <= 25; i++) {
    history.push({ label: "Drag", mergeKey: "emitter1:size", undo: () => {}, redo: () => {} });
  }
  assert.equal(history.depth, 1, "a whole drag must be a single undo step");

  // A different field is its own step.
  history.push({ label: "Other", mergeKey: "emitter1:speed", undo: () => {}, redo: () => {} });
  assert.equal(history.depth, 2);
  // And so is an unkeyed discrete action.
  history.push({ label: "Delete", undo: () => {}, redo: () => {} });
  history.push({ label: "Delete", undo: () => {}, redo: () => {} });
  assert.equal(history.depth, 4, "unkeyed actions never merge");
});

test("history: a coalesced drag undoes to the state before the whole gesture", () => {
  const history = new EditorHistory();
  let value = 0;
  // Each tick of the drag records its own before/after, exactly as the
  // editors' record() does.
  for (const [before, after] of [[0, 1], [1, 2], [2, 3]]) {
    history.push({
      label: "Drag",
      mergeKey: "same",
      undo: () => (value = before),
      redo: () => (value = after),
    });
  }
  value = 3;
  history.undo();
  assert.equal(value, 0, "undo must reach the state before the gesture began, not the previous tick");
  history.redo();
  assert.equal(value, 3, "redo must reach the gesture's final state");
});

test("history: pushes during undo/redo are ignored", () => {
  const history = new EditorHistory();
  let reentered = 0;
  history.push({
    label: "outer",
    undo: () => {
      // An editor's own change handler firing during a replay would push
      // the inverse of the thing being replayed, corrupting the stack.
      history.push({ label: "inner", undo: () => reentered++, redo: () => reentered++ });
    },
    redo: () => {},
  });
  history.undo();
  assert.equal(history.depth, 0, "the re-entrant push must not have landed");
  assert.equal(history.canRedo, true, "the outer command is still redoable");
  assert.equal(reentered, 0);
});

test("history: dirty tracks distance from the last save, both directions", () => {
  const history = new EditorHistory();
  assert.equal(history.isDirty, false);
  history.push({ label: "a", undo: () => {}, redo: () => {} });
  assert.equal(history.isDirty, true);

  history.markSaved();
  assert.equal(history.isDirty, false, "saving makes the current state clean");

  history.push({ label: "b", undo: () => {}, redo: () => {} });
  assert.equal(history.isDirty, true);
  history.undo();
  assert.equal(history.isDirty, false, "undoing back to the saved point is clean again");
  history.undo();
  assert.equal(history.isDirty, true, "undoing past it is dirty again");
});

test("history: clear releases both stacks with the right applied state", () => {
  const history = new EditorHistory();
  const discarded = [];
  history.push({ label: "kept", undo: () => {}, redo: () => {}, discard: (s) => discarded.push(`kept:${s}`) });
  history.push({ label: "undone", undo: () => {}, redo: () => {}, discard: (s) => discarded.push(`undone:${s}`) });
  history.undo(); // "undone" moves to the redo stack

  history.clear();
  assert.deepEqual(discarded.sort(), ["kept:applied", "undone:unapplied"]);
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
});

test("regression: saving one editor's file must not clear the other's dirty flag", () => {
  // The bug this guards: a single shared "mark everything saved" call
  // cleared both the collider and particle dirty flags. Saving colliders
  // therefore disarmed the particle save — flushParticles saw no pending
  // changes and returned without writing, so those edits lived only in
  // memory and vanished on the next reload. Exit Editor hit it every
  // time, because it flushes colliders first.
  //
  // Asserted against the real source rather than a live EditorRoot (which
  // needs a renderer, a canvas, and a DOM): the invariant is structural —
  // no save path may clear a flag belonging to the other file.
  const editorRoot = readFileSync(join(ROOT, "src", "engine", "editor", "EditorRoot.ts"), "utf8");

  const collidersSaved = /markCollidersSaved\(\)\s*:\s*void\s*\{([\s\S]*?)\n  \}/.exec(editorRoot);
  const particlesSaved = /markParticlesSaved\(\)\s*:\s*void\s*\{([\s\S]*?)\n  \}/.exec(editorRoot);
  assert.ok(collidersSaved, "markCollidersSaved should exist");
  assert.ok(particlesSaved, "markParticlesSaved should exist");

  assert.ok(!/editorParticles\.markSaved/.test(collidersSaved[1]), "saving colliders must not mark the particle editor saved");
  assert.ok(!/editorColliders\.markSaved/.test(particlesSaved[1]), "saving particles must not mark the collider editor saved");

  // And the shared clear-everything entry point must not exist at all —
  // fixing the call sites while leaving the method around just waits for
  // someone to call it again.
  assert.ok(!/\bmarkHistorySaved\s*\(/.test(editorRoot), "EditorRoot must not expose a combined markHistorySaved()");

  const ionEngine = readFileSync(join(ROOT, "src", "engine", "IonEngine.ts"), "utf8");
  assert.ok(!/__markHistorySaved/.test(ionEngine), "the combined hook must not be exposed on window");

  const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
  assert.ok(!/__markHistorySaved/.test(indexHtml), "the dev page must not call a combined save-marker");
});

test("simulationSpeed of 0 freezes an emitter without stopping it", () => {
  const { buffer, sim } = makeSim({
    main: { duration: 100, loop: false, startLifetime: { min: 10, max: 10 }, maxParticles: 100, autoRandomSeed: false, playOnStart: false },
    emission: { enabled: true, rateOverTime: { min: 60, max: 60 }, bursts: [] },
  });
  sim.play();
  // The emitter applies simulationSpeed before calling step(), so a zero
  // speed reaches the simulation as dt = 0 — which must be a complete
  // no-op rather than, say, dividing by it.
  for (let i = 0; i < 60; i++) sim.step(0);
  assert.equal(buffer.count, 0, "no time passed, so nothing should have been emitted");
  assert.equal(sim.isPlaying, true, "but the emitter is still playing");
});
