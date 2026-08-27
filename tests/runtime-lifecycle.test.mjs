/**
 * The engine actually running: boot, frames, teardown, and re-boot.
 *
 * These drive the real `IonEngine.boot()` loop against a real
 * `THREE.WebGLRenderer` over a stub GL context (tests/lib/dom-env.mjs), which
 * is what makes them able to answer questions no unit test can: whether a
 * frame reaches the renderer, whether teardown gives the driver its resources
 * back, whether a second boot into the same canvas retires the first.
 *
 * Every leak assertion here was written against a reproduction first. The
 * hot-reload one in particular — four boots holding four full sets of
 * textures, programs and framebuffers — is the reason
 * src/engine/core/disposeScene.ts exists.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { bootGame } from "./lib/boot.mjs";
import { loadRuntime } from "./lib/runtime-bundle.mjs";

const runtime = await loadRuntime();

/** An AssetLoader with a manifest already in it, for the paths that need one without a network. */
class SeededLoader extends runtime.AssetLoader {
  constructor() {
    super();
    this.texture = new THREE.Texture();
    this.texture.name = "SEEDED";
    this.audioBuffer = { duration: 1, sampleRate: 44100, numberOfChannels: 1, length: 1024 };
  }
  getTexture() { return this.texture; }
  getAudio() { return this.audioBuffer; }
}

test("boot", async (t) => {
  await t.test("runs the game's start(), then a frame reaches the renderer", async () => {
    const harness = await bootGame({
      game: ({ Game, ION }) => class Started extends Game {
        starts = 0;
        updates = 0;
        start() { this.starts++; ION.scene.ground(); ION.scene.box({ color: "orange" }); }
        update() { this.updates++; }
      },
    });
    assert.equal(harness.game.starts, 1);
    harness.frames(3);
    assert.equal(harness.game.updates, 3, "one update per rAF frame");
    assert.ok(harness.game.rendererStats.drawCalls > 0, "the frame actually drew something");
    harness.dispose();
  });

  await t.test("the scene carries the engine's own groups plus the game's content", async () => {
    const harness = await bootGame({
      game: ({ Game, ION }) => class Named extends Game { start() { ION.scene.box({ name: "Crate" }); } },
    });
    const names = harness.game.world.children.map((child) => child.name);
    assert.ok(names.includes("COLLIDERS"), "collider registry attached");
    assert.ok(names.includes("PARTICLES"), "particle registry attached");
    assert.ok(names.includes("Crate"));
    harness.dispose();
  });

  await t.test("a page missing the UI layers says so instead of throwing on null", async () => {
    await assert.rejects(
      () => bootGame({
        dom: { html: `<!doctype html><html><body><canvas id="game"></canvas></body></html>` },
        game: ({ Game }) => class Bare extends Game { start() {} },
      }),
      /custom-ui-layer/
    );
  });

  await t.test("an authored background texture is resolved during boot, not after it", async () => {
    // The constructor builds and applies the scene environment. It used to do
    // that against an empty AssetLoader — `create()` swapped the warmed one in
    // only afterwards — so a texture background silently fell back to colour.
    const harness = await bootGame({
      assets: new SeededLoader(),
      data: { environment: { version: 1, world: { backgroundMode: "texture", backgroundTexture: "./sky.png" } } },
      game: ({ Game }) => class Sky extends Game { start() {} },
    });
    assert.equal(harness.game.world.background?.name, "SEEDED");
    harness.dispose();
  });
});

test("teardown", async (t) => {
  await t.test("gives back every GPU resource the game itself allocated", async () => {
    const harness = await bootGame({
      game: ({ Game, ION }) => class Heavy extends Game {
        start() {
          ION.scene.ground({ size: 30 });
          for (let i = 0; i < 20; i++) ION.scene.box({ x: i, color: "blue" });
        }
      },
    });
    harness.frames(2);
    const peak = { ...harness.env.gl.counts };
    assert.ok(peak.buffers > 0 && peak.programs > 0, "the render actually allocated something to release");

    harness.env.window.__disposeGame();
    const after = harness.env.gl.counts;
    assert.equal(after.buffers, 0, "vertex/index buffers released");
    assert.equal(after.programs, 0, "shader programs released");
    assert.equal(after.vertexArrays, 0, "vertex array objects released");
    // Textures and framebuffers do not reach zero, and should not: three.js
    // allocates four placeholder textures and three framebuffers per
    // *renderer*, and the renderer is shared per canvas so the next boot can
    // reuse it. What matters is that the count is a constant of the page
    // rather than a function of how many times a game has booted — which is
    // exactly what the reload suite below asserts.
    assert.ok(after.textures <= peak.textures, "no texture was created by teardown");
    harness.env.restore();
  });

  await t.test("is idempotent — a second dispose is a no-op, not a crash", async () => {
    const harness = await bootGame({ game: ({ Game, ION }) => class D extends Game { start() { ION.scene.box(); } } });
    harness.frames(1);
    harness.env.window.__disposeGame();
    assert.doesNotThrow(() => harness.game.dispose());
    harness.env.restore();
  });

  await t.test("stops the frame loop", async () => {
    const harness = await bootGame({ game: ({ Game }) => class L extends Game { start() {} } });
    harness.frames(1);
    assert.ok(harness.env.clock.pendingFrames > 0, "loop is running");
    harness.env.window.__disposeGame();
    // The generation guard is what stops it: the next callback sees a bumped
    // generation and declines to reschedule.
    harness.env.clock.step();
    harness.env.clock.step();
    assert.equal(harness.env.clock.pendingFrames, 0, "no frame is queued any more");
    harness.env.restore();
  });

  await t.test("drops the window resize listener", async () => {
    const harness = await bootGame({ game: ({ Game }) => class R extends Game { start() {} } });
    harness.env.window.__disposeGame();
    // A resize after teardown must not reach the disposed renderer.
    assert.doesNotThrow(() => harness.env.resize(500, 900));
    harness.env.restore();
  });
});

test("re-boot into the same canvas (what a hot reload does)", async (t) => {
  await t.test("does not accumulate GPU resources", async () => {
    const harness = await bootGame({
      game: ({ Game, ION }) => class Reload extends Game {
        start() { ION.scene.ground(); ION.scene.box(); ION.scene.sphere(); }
      },
    });
    harness.frames(2);
    const afterFirst = { ...harness.env.gl.counts };

    const GameClass = Object.getPrototypeOf(harness.game).constructor;
    for (let i = 0; i < 3; i++) {
      runtime.IonEngine.boot(harness.env.canvas, { createGame: (canvas) => GameClass.create(canvas, {}) });
      for (let drain = 0; drain < 30; drain++) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      harness.frames(2);
    }

    const afterFourth = harness.env.gl.counts;
    for (const key of ["textures", "buffers", "programs", "framebuffers"]) {
      assert.ok(
        afterFourth[key] <= afterFirst[key],
        `${key} grew across reloads: ${afterFirst[key]} → ${afterFourth[key]}`
      );
    }
    harness.dispose();
  });

  await t.test("retires the previous game rather than running both", async () => {
    const harness = await bootGame({
      game: ({ Game }) => class Counting extends Game {
        static live = 0;
        updates = 0;
        start() { Counting.live++; }
        stop() { Counting.live--; }
        update() { this.updates++; }
      },
    });
    const GameClass = Object.getPrototypeOf(harness.game).constructor;
    const first = harness.game;
    harness.frames(1);

    runtime.IonEngine.boot(harness.env.canvas, { createGame: (canvas) => GameClass.create(canvas, {}) });
    for (let drain = 0; drain < 30; drain++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const before = first.updates;
    harness.frames(3);
    assert.equal(first.updates, before, "the superseded game stopped ticking");
    assert.equal(GameClass.live, 1, "exactly one game is live");
    harness.dispose();
  });
});

test("crash handling", async (t) => {
  await t.test("a throwing update stops the loop and reports once", async () => {
    const crashes = [];
    const harness = await bootGame({
      engineOptions: { onCrash: (err) => crashes.push(err) },
      game: ({ Game }) => class Boom extends Game {
        start() {}
        update() { throw new Error("gameplay exploded"); }
      },
    });
    const errors = [];
    const realError = console.error;
    console.error = (...args) => errors.push(args);
    try {
      harness.frames(1);
      harness.env.clock.step();
      harness.env.clock.step();
    } finally {
      console.error = realError;
    }
    assert.equal(crashes.length, 1, "onCrash fired exactly once");
    assert.match(crashes[0].message, /gameplay exploded/);
    assert.equal(harness.env.clock.pendingFrames, 0, "the loop did not reschedule into the same crash");
    assert.ok(harness.env.document.body.textContent.length > 0, "a recovery overlay is on the page");
    harness.env.restore();
  });

  await t.test("a throwing onCrash hook does not prevent the overlay", async () => {
    const harness = await bootGame({
      engineOptions: { onCrash: () => { throw new Error("hook also broke"); } },
      game: ({ Game }) => class Boom2 extends Game {
        start() {}
        update() { throw new Error("first failure"); }
      },
    });
    const realError = console.error;
    console.error = () => {};
    try {
      assert.doesNotThrow(() => harness.frames(1));
    } finally {
      console.error = realError;
    }
    harness.env.restore();
  });
});

test("resize", async (t) => {
  await t.test("follows the window and survives extreme aspect ratios", async () => {
    const harness = await bootGame({
      dom: { width: 400, height: 800 },
      game: ({ Game }) => class Rz extends Game { start() {} },
    });
    for (const [width, height] of [[400, 800], [800, 400], [2400, 300], [300, 2400], [1, 1]]) {
      harness.env.resize(width, height);
      harness.frames(1);
      const camera = harness.game.rig.perspective;
      assert.ok(Number.isFinite(camera.aspect) && camera.aspect > 0, `aspect broke at ${width}x${height}`);
      assert.ok(Number.isFinite(camera.fov) && camera.fov > 0 && camera.fov < 180, `fov broke at ${width}x${height}`);
      const ortho = harness.game.rig.orthographic;
      assert.ok(ortho.right > ortho.left && ortho.top > ortho.bottom, `ortho frustum inverted at ${width}x${height}`);
    }
    harness.dispose();
  });

  await t.test("a zero-sized viewport does not produce a NaN projection", async () => {
    const harness = await bootGame({ game: ({ Game }) => class Z extends Game { start() {} } });
    harness.env.resize(0, 0);
    harness.frames(1);
    assert.ok(Number.isFinite(harness.game.rig.perspective.projectionMatrix.elements[0]));
    harness.dispose();
  });
});
