/**
 * `IonGame`'s dev-panel surface — the half of the packaged runtime the Engine
 * Room drives.
 *
 * This exists because a whole family of these members was wrong in the same
 * way and nothing noticed. Every one of them forwarded to
 * `this.editorSession`, including the ones that must work with **no editor
 * open at all**:
 *
 *  - `IonEngine.installDevHooks` registers the panel's callbacks **once**,
 *    right after `Game.create()` resolves — long before anyone opens the 3D
 *    editor. `onColliderDirty`/`onSceneDirty`/… forwarded to a session that
 *    was `undefined` at that instant, so every callback was dropped and never
 *    re-offered. The panel therefore never learned a session had unsaved work:
 *    edits (a gizmo move, a Hierarchy re-parent) were silently discarded on
 *    exit.
 *  - `getColliderStats()` read the session too, so the collider readout showed
 *    `0 total / 0 enabled` while colliders were registered and firing
 *    enter/exit correctly — which reads as "collision is broken" when the
 *    collision system is the one part that was fine.
 *
 * None of it is visible to a test that only checks gameplay, and all of it is
 * visible here, because these tests drive the same hooks the panel does.
 *
 * The reference `src/game/Game.ts` never had these bugs — it has always
 * stored the callbacks and read the live registries. So the rule this file
 * enforces is really "the packaged path behaves like the reference one".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { bootGame } from "./lib/boot.mjs";

/** The dev page's own markup: the Engine Room panel supplies the view-helper canvas. */
const DEV_PAGE = `<!doctype html><html><body>
  <canvas id="game"></canvas>
  <div id="custom-ui-layer"></div>
  <div id="endcard-layer"></div>
  <canvas id="er-viewhelper" width="60" height="60"></canvas>
</body></html>`;

/**
 * The smallest thing that satisfies `EditorHost`.
 *
 * Records what the game hands it at open time, and exposes the levers a real
 * session would pull, so a test can assert the wiring in both directions
 * without any of the editor package's DOM.
 */
function fakeHost() {
  const record = { opened: 0, options: null, listeners: { gizmo: [], inspector: [], history: [] } };
  const session = {
    camera: { isPerspectiveCamera: true, quaternion: { copy: () => ({ invert: () => {} }) } },
    update() {},
    dispose() {},
    setGizmoMode() {},
    onGizmoModeChange(cb) { record.listeners.gizmo.push(cb); },
    onInspectorStateChange(cb) { record.listeners.inspector.push(cb); },
    toggleGrid: () => true, toggleHelpers: () => true, toggleSnap: () => true, toggleSpace: () => "world",
    frameSelected() {},
    setColliderMode: () => true, createCollider() {}, deleteSelectedCollider: () => true,
    toggleColliderVisible: () => true, serializeColliders: () => [], hasColliderChanges: () => false,
    markCollidersSaved() {}, onColliderDirty() {}, setColliderDebug: () => undefined,
    toggleColliderDebug: () => undefined, getColliderStats: () => ({ total: -1, enabled: -1, narrowTests: -1, activePairs: -1 }),
    setParticleMode: () => true, createParticleSystem() {}, addParticleEmitter() {},
    deleteSelectedEmitter: () => true, duplicateSelectedEmitter: () => true,
    particlePlay() {}, particlePause() {}, particleStop() {}, particleRestart() {}, particleClear() {},
    isParticlePreviewPlaying: () => false, toggleParticleGizmo: () => true, getParticlePresets: () => [],
    setParticleQuality() {}, serializeParticles: () => [], hasParticleChanges: () => false,
    markParticlesSaved() {}, onParticleDirty() {}, getParticleStats: () => ({ systems: -1 }),
    serializeEnvironment: () => ({}), hasEnvironmentChanges: () => false, markEnvironmentSaved() {},
    onEnvironmentDirty() {}, serializeScene: () => [], hasSceneChanges: () => false,
    markSceneSaved() {}, onSceneDirty() {},
    editorUndo: () => false, editorRedo: () => false, getEditorHistory: () => ({}),
    onEditorHistoryChange(cb) { record.listeners.history.push(cb); },
    getEditorViewportInfo: () => ({}),
    requestObjectPick: () => false, cancelObjectPick() {}, editorDragAssign: () => undefined,
    editorAssignmentFor: () => undefined,
  };
  const host = {
    createDebugLayer: () => ({ setVisible: (v) => v, toggle: () => true, update() {}, dispose() {} }),
    open(options) { record.opened++; record.options = options; return session; },
  };
  return { host, record, session };
}

test("dev facade: the always-available half", async (t) => {
  await t.test("collider stats come from the live registry, not from an editor session", async () => {
    // The registry is owned by IonEngine and always present. Reading it
    // through the session meant the Engine Room's readout was all zeros
    // whenever the editor was closed, which is most of the time.
    // The dev build: `window.__getColliderStats` is one of the panel hooks
    // IonEngine only installs there, so the production bundle would report
    // "not a function" and prove nothing either way.
    const harness = await bootGame({
      dev: true,
      game: ({ Game, ION }) => class Zoned extends Game {
        start() {
          this.thing = ION.scene.box({ name: "Thing" });
          ION.colliders.zone({ name: "A", size: 2 });
          ION.colliders.zone({ name: "B", size: 2 });
        }
      },
    });
    harness.frames(2);

    const stats = harness.env.window.__getColliderStats();
    assert.equal(stats.total, 2, "two registered colliders must be reported with no editor open");
    assert.equal(stats.enabled, 2);
    harness.dispose();
  });

  await t.test("particle stats and quality do not need an editor either", async () => {
    const harness = await bootGame({ dev: true, game: ({ Game }) => class Bare extends Game { start() {} } });
    harness.frames(1);
    const stats = harness.env.window.__getParticleStats();
    assert.ok(stats && typeof stats.systems === "number", "a real stats object, not undefined");
    // A runtime quality tier — the panel's Low/Medium/High must work with the
    // editor closed. It threw nothing before; it simply did nothing.
    assert.doesNotThrow(() => harness.env.window.__setParticleQuality("low"));
    harness.dispose();
  });

  await t.test("the orientation gizmo is built and drawn by the game, not by an editor session", async () => {
    // It used to be constructed inside the editor session, so on the packaged
    // path it drew only while the 3D editor was open and sat frozen the rest
    // of the time.
    const harness = await bootGame({
      dev: true,
      dom: { html: DEV_PAGE },
      game: ({ Game }) => class Bare extends Game { start() {} },
    });
    assert.ok(harness.game.viewHelper, "constructed at boot, with no editor host registered at all");
    // Drawing it means rendering into its own canvas every frame; the stub GL
    // context counts draw calls, so a frame that reaches it is observable.
    assert.doesNotThrow(() => harness.frames(3));
    harness.dispose();
  });

  await t.test("a page with no view-helper canvas simply has no gizmo", async () => {
    const harness = await bootGame({ dev: true, game: ({ Game }) => class Bare extends Game { start() {} } });
    assert.equal(harness.game.viewHelper, undefined, "no #er-viewhelper in the page — nothing to draw into");
    harness.dispose();
  });

  await t.test("a production build never constructs it, even when the canvas is there", async () => {
    // The construction site is behind `import.meta.env.DEV` so Rollup can drop
    // the class entirely — scripts/verify-bundle.mjs asserts `ViewHelper` is
    // absent from dist/index.html, and that only holds while this is true.
    const harness = await bootGame({ dom: { html: DEV_PAGE }, game: ({ Game }) => class Bare extends Game { start() {} } });
    assert.equal(harness.game.viewHelper, undefined, "the gizmo is dev-only and must not reach a shipped playable");
    harness.dispose();
  });
});

test("dev facade: callbacks registered before any editor exists", async (t) => {
  await t.test("dirty callbacks survive to the session that is opened later", async () => {
    // This is the save/parenting bug in one assertion. IonEngine registers
    // these immediately after create(); the session opens minutes later.
    const harness = await bootGame({ game: ({ Game }) => class Bare extends Game { start() {} } });
    const { host, record } = fakeHost();
    harness.runtime.registerEditorHost(host);
    try {
      const fired = { collider: 0, particle: 0, environment: 0, scene: 0 };
      // Exactly what IonEngine.installDevHooks does, at the time it does it.
      harness.game.onColliderDirty(() => fired.collider++);
      harness.game.onParticleDirty(() => fired.particle++);
      harness.game.onEnvironmentDirty(() => fired.environment++);
      harness.game.onSceneDirty(() => fired.scene++);

      harness.game.setFreecam(true);
      assert.equal(record.opened, 1, "the fake host was asked for a session");

      // The game must have handed its held callbacks to the session at open
      // time — EditorRoot takes them as constructor options, so this is the
      // only moment they can be delivered.
      for (const key of ["onColliderDirty", "onParticleDirty", "onEnvironmentDirty", "onSceneDirty"]) {
        assert.equal(typeof record.options[key], "function", `${key} must be passed through EditorOpenOptions`);
      }
      record.options.onColliderDirty();
      record.options.onSceneDirty();
      assert.equal(fired.collider, 1, "a collider edit must reach the callback registered at boot");
      assert.equal(fired.scene, 1, "and so must a scene-graph change — this is what made re-parenting vanish on exit");

      harness.game.setFreecam(false);
    } finally {
      harness.runtime.registerEditorHost(undefined);
      harness.dispose();
    }
  });

  await t.test("listener-style callbacks are replayed onto every session, not just the first", async () => {
    // A session is destroyed on Exit and rebuilt on re-entry, while the panel
    // registered its listeners exactly once. Applying them only at
    // registration time leaves the toolbar out of sync from the second entry
    // onward.
    const harness = await bootGame({ game: ({ Game }) => class Bare extends Game { start() {} } });
    const { host, record } = fakeHost();
    harness.runtime.registerEditorHost(host);
    try {
      harness.game.onGizmoModeChange(() => {});
      harness.game.onInspectorStateChange(() => {});
      harness.game.onEditorHistoryChange(() => {});

      harness.game.setFreecam(true);
      harness.game.setFreecam(false);
      harness.game.setFreecam(true);

      assert.equal(record.opened, 2, "two sessions were opened");
      assert.equal(record.listeners.gizmo.length, 2, "gizmo-mode listener applied to both");
      assert.equal(record.listeners.inspector.length, 2, "inspector-state listener applied to both");
      assert.equal(record.listeners.history.length, 2, "history listener applied to both");

      harness.game.setFreecam(false);
    } finally {
      harness.runtime.registerEditorHost(undefined);
      harness.dispose();
    }
  });
});
