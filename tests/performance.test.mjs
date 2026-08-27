/**
 * Performance baselines.
 *
 * The point of these is not to measure absolute speed — a stub GL context
 * draws no pixels, and the machine varies — but to catch the shape of a
 * regression: a per-frame allocation appearing in a hot path, an O(n²) sweep
 * replacing an O(n) one, a teardown that stops being proportional to what it
 * built. So the thresholds are deliberately loose in absolute terms and tight
 * in *relative* terms, and the scaling assertions are the ones that matter.
 *
 * A failure here means "something got structurally slower", not "this machine
 * is busy". Anything that could plausibly fail on a loaded CI runner is
 * expressed as a ratio between two measurements taken in the same run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { bootGame } from "./lib/boot.mjs";
import { loadRuntime } from "./lib/runtime-bundle.mjs";

const runtime = await loadRuntime();
const { ION } = runtime;

/** Median of `runs` timings, in ms. The median rather than the mean, because one GC pause should not decide the verdict. */
function timeMedian(runs, body) {
  const samples = [];
  for (let run = 0; run < runs; run++) {
    const started = process.hrtime.bigint();
    body(run);
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

const report = [];
function record(name, value, unit, budget) {
  report.push({ name, value: Number(value.toFixed(3)), unit, budget });
  return value;
}

test.after(() => {
  console.log("\n  ION performance baselines");
  for (const row of report) {
    const verdict = row.budget === undefined ? "" : row.value <= row.budget ? "  ✓" : "  ✗";
    console.log(`    ${row.name.padEnd(48)} ${String(row.value).padStart(9)} ${row.unit.padEnd(6)} ${row.budget === undefined ? "" : `budget ${row.budget}${verdict}`}`);
  }
  console.log("");
});

test("startup", async (t) => {
  await t.test("an empty game boots well inside a frame budget's worth of work", async () => {
    const started = process.hrtime.bigint();
    const harness = await bootGame({ game: ({ Game }) => class B extends Game { start() {} } });
    const bootMs = Number(process.hrtime.bigint() - started) / 1e6;
    record("boot: empty game", bootMs, "ms", 400);
    assert.ok(bootMs < 400, `booting an empty game took ${bootMs.toFixed(1)}ms`);
    harness.dispose();
  });

  await t.test("a hundred-object scene boots without super-linear cost", async () => {
    const build = async (count) => {
      const started = process.hrtime.bigint();
      const harness = await bootGame({
        game: ({ Game }) => class S extends Game {
          start() { for (let i = 0; i < count; i++) ION.scene.box({ x: i % 10, z: Math.floor(i / 10) }); }
        },
      });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      harness.dispose();
      return ms;
    };
    const small = await build(50);
    const large = await build(500);
    record("boot: 500 objects", large, "ms", 1500);
    // Ten times the content should not cost far more than ten times the work.
    const ratio = large / Math.max(small, 0.5);
    record("boot: 500/50 object cost ratio", ratio, "×", 25);
    assert.ok(ratio < 25, `scene construction scaled ${ratio.toFixed(1)}× for 10× the objects`);
  });
});

test("frame time", async (t) => {
  await t.test("an idle frame is cheap", async () => {
    const harness = await bootGame({ game: ({ Game }) => class F extends Game { start() { ION.scene.ground(); } } });
    harness.frames(10);
    const ms = timeMedian(120, () => harness.frame());
    record("frame: idle", ms, "ms", 8);
    assert.ok(ms < 8, `an idle frame took ${ms.toFixed(2)}ms`);
    harness.dispose();
  });

  await t.test("500 updating entities stay within a frame budget", async () => {
    const harness = await bootGame({
      game: ({ Game, Entity }) => {
        class Spinner extends Entity {
          update(dt) { this.rotation.y += 90 * dt; this.position.y = Math.sin(this.position.x + dt); }
        }
        return class F extends Game {
          start() { for (let i = 0; i < 500; i++) new Spinner(`S${i}`); }
        };
      },
    });
    harness.frames(5);
    const ms = timeMedian(60, () => harness.frame());
    record("frame: 500 updating entities", ms, "ms", 16);
    assert.ok(ms < 16, `500 entities cost ${ms.toFixed(2)}ms per frame`);
    harness.dispose();
  });

  await t.test("entity update cost is linear in entity count", async () => {
    const measure = async (count) => {
      const harness = await bootGame({
        game: ({ Game, Entity }) => {
          class Tick extends Entity { update(dt) { this.position.x += dt; } }
          return class F extends Game { start() { for (let i = 0; i < count; i++) new Tick(`T${i}`); } };
        },
      });
      harness.frames(5);
      const ms = timeMedian(60, () => harness.frame());
      harness.dispose();
      return ms;
    };
    const small = await measure(100);
    const large = await measure(1000);
    const ratio = large / Math.max(small, 0.05);
    record("frame: 1000/100 entity cost ratio", ratio, "×", 20);
    assert.ok(ratio < 20, `entity updates scaled ${ratio.toFixed(1)}× for 10× the entities — that is not linear`);
  });

  await t.test(
    "the rotation view does not allocate per frame",
    // Needs a real GC to mean anything: without --expose-gc the heap figure is
    // whatever V8 happened to have collected, which is noise either way.
    { skip: typeof globalThis.gc === "function" ? false : "run with --expose-gc" },
    async () => {
    // It used to build a fresh object and seven closures on every read, which
    // for `this.rotation.y += …` in an update() is one allocation per entity
    // per frame — a GC pause a playable cannot pay for.
    const harness = await bootGame({
      game: ({ Game, Entity }) => {
        class Spin extends Entity { update(dt) { this.rotation.y += 60 * dt; } }
        return class F extends Game { start() { for (let i = 0; i < 200; i++) new Spin(`S${i}`); } };
      },
    });
    harness.frames(20);
    if (typeof globalThis.gc === "function") globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    harness.frames(300);
    if (typeof globalThis.gc === "function") globalThis.gc();
    const growthKb = (process.memoryUsage().heapUsed - before) / 1024;
    record("frame: heap growth over 300 frames × 200 entities", growthKb, "KB", 2048);
    assert.ok(growthKb < 2048, `the heap grew ${growthKb.toFixed(0)}KB over 300 frames`);
    harness.dispose();
  }
  );
});

test("colliders", async (t) => {
  await t.test("overlap testing scales sub-quadratically", async () => {
    // The broad phase is the whole reason this system exists; a regression to
    // an all-pairs sweep would still be correct and would still pass every
    // behavioural test.
    const measure = async (count) => {
      const harness = await bootGame({
        game: ({ Game, Entity }) => class C extends Game {
          start() {
            for (let i = 0; i < count; i++) {
              const entity = new Entity(`Body${i}`);
              entity.moveTo((i % 20) * 1.5, 0, Math.floor(i / 20) * 1.5);
              ION.colliders.attach(entity, { size: 1 });
            }
          }
        },
      });
      harness.frames(5);
      const ms = timeMedian(40, () => harness.frame());
      harness.dispose();
      return ms;
    };
    const small = await measure(50);
    const large = await measure(400);
    record("frame: 400 colliders", large, "ms", 16);
    const ratio = large / Math.max(small, 0.05);
    // 8× the colliders. Quadratic would be ~64×; anything under 30 is not
    // all-pairs.
    record("frame: 400/50 collider cost ratio", ratio, "×", 30);
    assert.ok(ratio < 30, `collider cost scaled ${ratio.toFixed(1)}× for 8× the colliders`);
  });
});

test("UI", async (t) => {
  const layout = (count) => ({
    version: 1,
    canvasWidth: 400,
    canvasHeight: 711,
    elements: Array.from({ length: count }, (_, i) => ({
      id: `e${i}`, name: `Element${i}`, type: i % 3 === 0 ? "text" : "sprite",
      x: (i % 8) * 48, y: Math.floor(i / 8) * 32, width: 44, height: 28,
      text: `${i}`, visible: true, opacity: 1, renderOrder: i,
    })),
  });

  await t.test("building a large layout is fast", async () => {
    const started = process.hrtime.bigint();
    const harness = await bootGame({ data: { mainLayout: layout(200) }, game: ({ Game }) => class U extends Game { start() {} } });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    record("ui: build 200 elements", ms, "ms", 800);
    assert.equal(harness.env.document.getElementById("custom-ui-layer").children.length, 200);
    harness.dispose();
  });

  await t.test("rescaling a large layout is fast enough for a resize", async () => {
    const harness = await bootGame({ data: { mainLayout: layout(200) }, game: ({ Game }) => class U extends Game { start() {} } });
    let width = 400;
    const ms = timeMedian(30, () => {
      width = width === 400 ? 401 : 400;
      harness.game.ui.updateScale(width, 711);
    });
    record("ui: rescale 200 elements", ms, "ms", 20);
    assert.ok(ms < 20, `rescaling 200 UI elements took ${ms.toFixed(2)}ms`);
    harness.dispose();
  });
});

test("teardown", async (t) => {
  await t.test("disposing a large scene is proportional to what it built", async () => {
    const measure = async (count) => {
      const harness = await bootGame({
        game: ({ Game }) => class D extends Game {
          start() { for (let i = 0; i < count; i++) ION.scene.box({ x: i % 20 }); }
        },
      });
      harness.frames(2);
      const started = process.hrtime.bigint();
      harness.env.window.__disposeGame();
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      harness.env.restore();
      return ms;
    };
    const small = await measure(100);
    const large = await measure(1000);
    record("teardown: 1000 objects", large, "ms", 500);
    const ratio = large / Math.max(small, 0.2);
    record("teardown: 1000/100 cost ratio", ratio, "×", 30);
    assert.ok(large < 500, `disposing 1000 objects took ${large.toFixed(1)}ms`);
    assert.ok(ratio < 30, `teardown scaled ${ratio.toFixed(1)}× for 10× the objects`);
  });

  await t.test("repeated boot and teardown does not grow the heap without bound", async () => {
    const cycle = async () => {
      const harness = await bootGame({
        game: ({ Game }) => class R extends Game { start() { ION.scene.ground(); for (let i = 0; i < 30; i++) ION.scene.box({ x: i }); } },
      });
      harness.frames(3);
      harness.dispose();
    };
    for (let warm = 0; warm < 3; warm++) await cycle();
    if (typeof globalThis.gc === "function") globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 12; i++) await cycle();
    if (typeof globalThis.gc === "function") globalThis.gc();
    const growthMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
    record("teardown: heap growth over 12 boot/dispose cycles", growthMb, "MB", 48);
    assert.ok(growthMb < 48, `12 boot/dispose cycles grew the heap by ${growthMb.toFixed(1)}MB`);
  });
});
