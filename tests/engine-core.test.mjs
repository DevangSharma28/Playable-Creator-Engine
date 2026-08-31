/**
 * The small engine services that sit under everything else: the scheduler's
 * clock, the asset loader's cache, the analytics seam, and the viewport
 * watcher.
 *
 * None of these are visible in a screenshot, and all four are the kind of
 * thing that fails quietly — a repeat that fires twelve times in twelve
 * frames after a pause, an asset downloaded twice, an event dropped because
 * the host's SDK attached late, a rotation that never reaches the renderer.
 * They are also all pure enough to drive directly, so there is no excuse for
 * them not to be.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { installDom } from "./lib/dom-env.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Bundles the DOM-free core services.
 *
 * Named modules rather than a barrel, for the same reason the particle suite
 * does it: the barrels reach `Ion` -> `Cta` -> `MraidAdapter`, and pulling
 * those in would mean stubbing a browser to test a timer.
 */
async function loadCore() {
  const engine = join(ROOT, "src", "engine");
  const result = await esbuild.build({
    stdin: {
      contents: `
        export { Scheduler } from ${JSON.stringify(join(engine, "core", "Scheduler.ts"))};
        export { EventBus } from ${JSON.stringify(join(engine, "core", "EventBus.ts"))};
        export { AssetLoader } from ${JSON.stringify(join(engine, "AssetLoader.ts"))};
        export { Telemetry } from ${JSON.stringify(join(engine, "Telemetry.ts"))};
      `,
      resolveDir: engine,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2020",
    write: false,
    define: { "import.meta.env.DEV": "false" },
  });
  const out = mkdtempSync(join(tmpdir(), "ion-core-"));
  const file = join(out, "core.mjs");
  writeFileSync(file, result.outputFiles[0].text, "utf8");
  return import(pathToFileURL(file).href);
}

const core = await loadCore();

test("Scheduler", async (t) => {
  await t.test("after() fires once, at the right game time", () => {
    const s = new core.Scheduler();
    let fired = 0;
    s.after(1, () => fired++);
    s.update(0.9);
    assert.equal(fired, 0);
    s.update(0.2);
    assert.equal(fired, 1);
    s.update(5);
    assert.equal(fired, 1, "a one-shot must not carry forward");
  });

  await t.test("every() does not pay off a backlog one fire per frame", () => {
    // The failure this guards: a repeat that sat behind a long pause (an
    // editor session, a backgrounded tab, a breakpoint) used to advance its
    // next-fire time by exactly one interval per update — so after falling
    // twelve intervals behind it fired on twelve consecutive frames,
    // catching up in a burst instead of resuming its cadence.
    const s = new core.Scheduler();
    let fired = 0;
    s.every(1, () => fired++);

    s.update(12); // one enormous step: twelve intervals' worth at once
    assert.equal(fired, 1, "an oversized step is still one fire, not twelve");

    // And the next frames resume the normal cadence rather than draining
    // the eleven intervals it is nominally still owed.
    s.update(0.016);
    s.update(0.016);
    s.update(0.016);
    assert.equal(fired, 1, "no catch-up burst on the frames that follow");

    s.update(1);
    assert.equal(fired, 2, "the repeat is still running, just re-based");
  });

  await t.test("every() keeps firing on its own interval under normal frames", () => {
    const s = new core.Scheduler();
    let fired = 0;
    s.every(0.1, () => fired++);
    for (let i = 0; i < 100; i++) s.update(0.01); // 1 second of 100fps frames
    assert.ok(fired >= 9 && fired <= 10, `~10 fires expected in a second at 0.1s; got ${fired}`);
  });

  await t.test("cancel is safe twice, and after the timer already ran", () => {
    const s = new core.Scheduler();
    let fired = 0;
    const handle = s.after(0.1, () => fired++);
    s.update(0.2);
    assert.equal(fired, 1);
    assert.equal(handle.done, true);
    handle.cancel();
    handle.cancel();
    s.update(1);
    assert.equal(fired, 1);
  });

  await t.test("clear() drops everything pending — the hot-reload guarantee", () => {
    const s = new core.Scheduler();
    let fired = 0;
    s.after(0.1, () => fired++);
    s.every(0.1, () => fired++);
    s.clear();
    s.update(5);
    assert.equal(fired, 0);
  });

  await t.test("a callback that schedules more work runs it next tick, not this one", () => {
    const s = new core.Scheduler();
    const order = [];
    s.after(0, () => {
      order.push("first");
      s.after(0, () => order.push("second"));
    });
    s.update(0.016);
    assert.deepEqual(order, ["first"], "the nested timer must not run in the same update");
    s.update(0.016);
    assert.deepEqual(order, ["first", "second"]);
  });
});

test("AssetLoader", async (t) => {
  /** An AssetLoader whose three.js loaders are replaced by counters that resolve asynchronously. */
  function countingLoader() {
    const loader = new core.AssetLoader();
    const calls = { texture: 0, glb: 0, audio: 0 };
    const settle = [];
    const stub = (kind, value) => ({
      load(path, onLoad) {
        calls[kind]++;
        // Deferred, so two callers can genuinely overlap — which is the whole
        // case under test. A synchronous stub could never reproduce it.
        settle.push(() => onLoad(value(path)));
      },
    });
    loader.textureLoader = stub("texture", (path) => ({ name: path, colorSpace: "" }));
    loader.gltfLoader = stub("glb", (path) => ({ scene: { name: path }, animations: [] }));
    loader.audioLoader = stub("audio", (path) => ({ name: path }));
    return { loader, calls, flush: () => { const queued = settle.splice(0, settle.length); for (const fn of queued) fn(); } };
  }

  await t.test("two overlapping requests for one path produce one load", async () => {
    // The resolved cache only de-duplicates *sequential* calls. Two that
    // overlap both missed it and both fetched — so a manifest listing an
    // asset twice downloaded and GPU-uploaded it twice, leaving one copy
    // unreachable for the life of the loader.
    const { loader, calls, flush } = countingLoader();
    const a = loader.loadTexture("./coin.png");
    const b = loader.loadTexture("./coin.png");
    assert.equal(calls.texture, 1, "the second caller must join the first request");
    flush();
    assert.equal(await a, await b, "and both must get the same object back");
  });

  await t.test("a manifest listing the same asset twice loads it once", async () => {
    const { loader, calls, flush } = countingLoader();
    const done = loader.preload([
      { kind: "glb", path: "./coin.glb" },
      { kind: "texture", path: "./sky.png" },
      { kind: "glb", path: "./coin.glb" },
    ]);
    flush();
    await done;
    assert.equal(calls.glb, 1);
    assert.equal(calls.texture, 1);
  });

  await t.test("progress still counts every manifest entry", async () => {
    const { loader, flush } = countingLoader();
    const seen = [];
    const done = loader.preload(
      [{ kind: "glb", path: "./a.glb" }, { kind: "glb", path: "./a.glb" }],
      (loaded, total) => seen.push([loaded, total])
    );
    flush();
    await done;
    assert.deepEqual(seen.map((entry) => entry[1]), [2, 2], "total is the manifest's length, duplicates included");
  });

  await t.test("a resolved path is a cache hit, with no second request", async () => {
    const { loader, calls, flush } = countingLoader();
    const first = loader.loadAudio("./music.mp3");
    flush();
    await first;
    await loader.loadAudio("./music.mp3");
    assert.equal(calls.audio, 1);
  });

  await t.test("a failed load is retryable rather than permanently cached", async () => {
    const loader = new core.AssetLoader();
    let attempts = 0;
    loader.textureLoader = {
      load(path, onLoad, _onProgress, onError) {
        attempts++;
        if (attempts === 1) onError(new Error("network"));
        else onLoad({ name: path, colorSpace: "" });
      },
    };
    await assert.rejects(() => loader.loadTexture("./flaky.png"), /Failed to load texture/);
    const recovered = await loader.loadTexture("./flaky.png");
    assert.equal(recovered.name, "./flaky.png");
    assert.equal(attempts, 2, "the rejected promise must not be handed to the retry");
  });
});

test("Telemetry", async (t) => {
  t.afterEach(() => core.Telemetry.reset());

  await t.test("events fired before a sink exists are replayed, in order", () => {
    // An ad network's SDK routinely attaches after the playable's own script
    // has run, so an unbuffered seam drops exactly the boot and
    // first-interaction events — the ones worth the most.
    core.Telemetry.reset();
    core.Telemetry.track("boot");
    core.Telemetry.track("first-input", { source: "touch" });
    assert.equal(core.Telemetry.bufferedCount, 2);

    const got = [];
    core.Telemetry.setSink((event, props) => got.push([event, props]));
    assert.deepEqual(got, [["boot", undefined], ["first-input", { source: "touch" }]]);
    assert.equal(core.Telemetry.bufferedCount, 0, "the buffer is handed over, not copied");
  });

  await t.test("events after a sink is installed go straight through", () => {
    core.Telemetry.reset();
    const got = [];
    core.Telemetry.setSink((event) => got.push(event));
    core.Telemetry.track("cta");
    assert.deepEqual(got, ["cta"]);
  });

  await t.test("a sink that throws cannot take the frame down with it", () => {
    // This is the whole reason the seam is wrapped: a throw here would reach
    // IonEngine's crash guard and replace a working playable with the
    // recovery overlay — an analytics bug costing the whole impression.
    core.Telemetry.reset();
    core.Telemetry.setSink(() => { throw new Error("sink exploded"); });
    assert.doesNotThrow(() => core.Telemetry.track("anything"));
  });

  await t.test("the buffer is bounded, keeping the oldest", () => {
    core.Telemetry.reset();
    for (let i = 0; i < 200; i++) core.Telemetry.track(`e${i}`);
    const got = [];
    core.Telemetry.setSink((event) => got.push(event));
    assert.ok(got.length <= 64, `the buffer must be bounded; got ${got.length}`);
    assert.equal(got[got.length - 1], "e199", "the most recent event is always kept");
  });

  await t.test("uninstalling a sink buffers again rather than dropping", () => {
    core.Telemetry.reset();
    core.Telemetry.setSink(() => {});
    core.Telemetry.setSink(undefined);
    core.Telemetry.track("orphan");
    assert.equal(core.Telemetry.bufferedCount, 1);
  });
});

test("ViewportWatcher", async (t) => {
  /** Loaded separately: it touches `window` at construction, so it needs the DOM installed first. */
  async function loadWatcher() {
    const engine = join(ROOT, "src", "engine");
    const result = await esbuild.build({
      stdin: {
        contents: `export { ViewportWatcher } from ${JSON.stringify(join(engine, "core", "ViewportWatcher.ts"))};`,
        resolveDir: engine,
        loader: "ts",
      },
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2020",
      write: false,
      define: { "import.meta.env.DEV": "false" },
    });
    const out = mkdtempSync(join(tmpdir(), "ion-viewport-"));
    const file = join(out, "viewport.mjs");
    writeFileSync(file, result.outputFiles[0].text, "utf8");
    return import(pathToFileURL(file).href);
  }

  await t.test("reports a real resize, and only once for one change", async () => {
    const env = installDom();
    try {
      const { ViewportWatcher } = await loadWatcher();
      let fired = 0;
      const watcher = new ViewportWatcher(() => fired++, { settleDelaysMs: [] });
      env.resize(390, 844);
      assert.equal(fired, 1);
      // The same size again is not a change — this de-duplication is what
      // makes it safe to point four noisy event sources at one handler that
      // resizes a renderer and re-lays-out two UI layouts.
      env.window.dispatchEvent(new env.window.Event("resize"));
      assert.equal(fired, 1);
      watcher.dispose();
    } finally {
      env.restore();
    }
  });

  await t.test("re-measures after the event, which is what makes rotation work", async () => {
    // iOS Safari dispatches `resize` before layout settles, so the size read
    // in the handler is frequently the pre-rotation one. The settle passes
    // are what catch the real value.
    const env = installDom();
    try {
      const { ViewportWatcher } = await loadWatcher();
      const sizes = [];
      const watcher = new ViewportWatcher(
        () => sizes.push([env.window.innerWidth, env.window.innerHeight]),
        { settleDelaysMs: [5] }
      );
      // The event arrives while the window still reports the old size.
      env.window.dispatchEvent(new env.window.Event("orientationchange"));
      // ...and the real dimensions land a moment later, with no further event.
      env.window.innerWidth = 844;
      env.window.innerHeight = 390;
      await new Promise((done) => setTimeout(done, 20));
      assert.deepEqual(sizes[sizes.length - 1], [844, 390], "the settle pass must pick up the late size");
      watcher.dispose();
    } finally {
      env.restore();
    }
  });

  await t.test("dispose stops everything, including a settle pass already in flight", async () => {
    const env = installDom();
    try {
      const { ViewportWatcher } = await loadWatcher();
      let fired = 0;
      const watcher = new ViewportWatcher(() => fired++, { settleDelaysMs: [5] });
      env.window.dispatchEvent(new env.window.Event("resize"));
      watcher.dispose();
      env.window.innerWidth = 1000;
      await new Promise((done) => setTimeout(done, 20));
      env.window.dispatchEvent(new env.window.Event("resize"));
      assert.equal(fired, 0, "a disposed watcher must be completely inert");
    } finally {
      env.restore();
    }
  });
});
