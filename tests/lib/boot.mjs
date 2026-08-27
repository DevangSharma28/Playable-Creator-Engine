/**
 * Boots a real game through the real `IonEngine.boot()` and hands back the
 * pieces a test needs to drive it.
 *
 * Going through `boot()` rather than calling `Game.create()` directly is not
 * incidental: `Ion`'s registries are bound by the engine, and a game
 * constructed without it fails in its own constructor. Booting the way a
 * project does is also what puts the frame loop, the crash guard and the
 * generation guard under test rather than around it.
 */

import { installDom } from "./dom-env.mjs";
import { loadRuntime } from "./runtime-bundle.mjs";

/**
 * @param {object} options
 * @param {(runtime: object) => Function} options.game  Returns the Game subclass to boot, given the runtime module.
 */
export async function bootGame({ game, data, manifest, assets, engineOptions, dom } = {}) {
  const env = installDom(dom);
  const runtime = await loadRuntime();
  let instance;
  let createError;

  runtime.IonEngine.boot(env.canvas, {
    ...engineOptions,
    createGame: async (canvas) => {
      try {
        const GameClass = game(runtime);
        instance = await GameClass.create(canvas, { data, manifest, assets });
        return instance;
      } catch (err) {
        // The engine routes this to the crash overlay rather than rejecting
        // (see IonEngine.reportBootFailure), which is right for a player and
        // useless for a test — so it is captured here and re-thrown below.
        createError = err;
        throw err;
      }
    },
  });

  // boot() is fire-and-forget by design, so there is no promise to await.
  // Draining the microtask queue is what lets `create()`'s own awaits settle;
  // the loop only schedules its first frame afterwards, which the clock holds.
  for (let i = 0; i < 20 && !instance && !createError; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  if (createError) throw createError;
  if (!instance) throw new Error("bootGame: the game never finished creating");

  return {
    env,
    runtime,
    game: instance,
    /** Advance the engine by one real frame through its own rAF loop. */
    frame: (ms) => env.clock.step(ms),
    frames: (count, ms) => env.clock.steps(count, ms),
    dispose() {
      env.window.__disposeGame?.();
      env.restore();
    },
  };
}
