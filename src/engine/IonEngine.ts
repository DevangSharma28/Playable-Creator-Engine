import { Game } from "../game/Game";
import type { UILayout } from "./ui/UILayout";

/**
 * Dev-only hooks the Engine Room panel (public/index.html) and the in-place
 * hot-reload flow (public/index.html's "/esbuild" change listener) talk to.
 * All inert in the production build — nothing in src/index.template.html or
 * the shipped bundle ever calls any of these, so this whole surface is
 * simply never touched there.
 *
 * __setUIEditorPaused: the "Edit UI" overlay calls this to pause gameplay
 * (joystick input, coin collection, the 15s auto-endcard timer) while it's
 * open, without blanking the screen — render() still runs every frame, so
 * the last frame stays visible as a live backdrop.
 *
 * __resizeGameTo: the device-frame simulator calls this to size the
 * renderer/camera to a letterboxed box instead of the real window, for
 * previewing a fixed aspect ratio (e.g. 16:9 landscape) within your actual
 * browser window.
 *
 * __getEngineStats: the Engine Room panel polls this for its FPS/draw
 * calls/triangles readout.
 *
 * __setFreecamActive: the Engine Room "3D View" button calls this to pause
 * gameplay update() (same reason as __setUIEditorPaused — player/camera
 * would otherwise fight OrbitControls) while it hands the camera to
 * Game.setFreecam(); render() keeps running so the scene stays visible.
 *
 * __setGizmoMode: the Engine Room panel's Select/Move/Rotate/Scale toolbar
 * (only meaningful, and only shown, while freecam/3D View is active) calls
 * this to switch SceneInspector's transform gizmo.
 *
 * __onGizmoModeChanged: the reverse direction — SceneInspector also lets you
 * switch modes via keyboard (W/E/R/Q), so this is how the Engine Room
 * panel's toolbar buttons find out and update their own active-highlight to
 * match, instead of only ever reflecting clicks on themselves.
 *
 * __onGameReady: fires once Game.create()'s async asset loading actually
 * resolves and a real Game exists — Game.create() takes real time (GLB/
 * texture loads), so anything that sizes the renderer against the current
 * device-frame box (applyDeviceFrame, which calls __resizeGameTo above) has
 * to either run *after* this, or its call lands while there's no Game yet
 * and silently does nothing. Without it, a fresh instance — first boot or
 * an in-place reload alike — always initializes at the raw window size and
 * stays that way, ignoring whatever Portrait/Landscape letterbox was
 * active, until something else (e.g. clicking a device-preview tab)
 * happens to call applyDeviceFrame() again.
 *
 * __getInspectable: the Engine Room panel's Control Desk (a live public-
 * field viewer/editor, keyed by class name) calls this to reach an actual
 * running instance — Player, CoinField, World, Game itself, whatever
 * Game.ts chose to register (see Game.getInspectable) — and reads/writes
 * its fields directly. No serialization involved: the dev panel and the
 * running game share this same `window`, so the hook just hands back the
 * real object reference.
 *
 * __disposeGame / __gameInstanceGeneration: in-place hot-reload itself.
 * public/index.html swaps in a freshly-rebuilt bundle.js after every
 * source/layout save instead of doing a full page navigation, specifically
 * so the UI editor overlay's own in-memory session (undo history, unsaved
 * edits, Connect state) survives a Save — a full reload used to wipe all of
 * it out from under you every time. Each bundle execution is its own
 * isolated closure with no shared state, so the *new* one has to reach back
 * into the *old* one via `window` to tear it down — see start()/dispose().
 */
type EngineWindow = Window & {
  __setUIEditorPaused?: (paused: boolean) => void;
  __resizeGameTo?: (width: number, height: number) => void;
  __getEngineStats?: () => { fps: number; drawCalls: number; triangles: number };
  __setFreecamActive?: (active: boolean) => void;
  __setGizmoMode?: (mode: string) => void;
  __onGizmoModeChanged?: (mode: string) => void;
  __getInspectable?: (className: string) => object | undefined;
  __disposeGame?: () => void;
  __gameInstanceGeneration?: number;
  __onGameReady?: () => void;
};

/**
 * Ion Engine — the one thing a bundle's entry point (main.ts) needs to call
 * to boot a Game and keep it running frame to frame, including everything
 * the dev preview's Engine Room panel and in-place hot-reload depend on
 * (the window.__* hooks above, the per-frame RAF loop, tearing down a
 * previous instance cleanly before a new one takes over the same canvas).
 *
 * None of this is specific to *this* playable ad — Game.ts (Player,
 * CoinField, the coin-collect win condition, the 15s auto-endcard timer,
 * ...) is what actually differs between playable ads built on this engine;
 * this class is meant to stay the same across all of them, so a new ad's
 * main.ts only ever needs:
 *
 *   const canvas = document.getElementById("game") as HTMLCanvasElement;
 *   IonEngine.boot(canvas);
 */
export class IonEngine {
  private readonly win = window as EngineWindow;

  private game: Game | undefined;
  private freecamActive = false;
  private fps = 0;
  private uiEditorPaused: boolean;

  private constructor(private readonly canvas: HTMLCanvasElement) {
    // Derived from the real DOM, not defaulted to false — this instance is
    // recreated fresh on every in-place reload, but the editor overlay's
    // own visibility (owned by public/index.html, never touched by a
    // bundle swap) isn't. Without this, saving a layout while the editor
    // is open would silently un-pause gameplay underneath it — the
    // joystick, coin pickup, and the 15s auto-endcard timer would all
    // start running again behind the still-open editor.
    this.uiEditorPaused = document.getElementById("ui-editor-frame")?.style.display === "block";
  }

  /**
   * Boots (or, on a dev in-place reload, re-boots into the same canvas —
   * see the private start()) a Game and starts its render loop.
   * Fire-and-forget by design, same as the main() this replaces: nothing
   * meaningful to hand back to the caller — everything observable happens
   * through the DOM or the dev hooks above.
   */
  static boot(canvas: HTMLCanvasElement): void {
    new IonEngine(canvas).start();
  }

  /** Access designed sprites/text from mainLayout.json by the name given in tools/ui-editor.html. Undefined only before Game.create() resolves — not meaningfully useful to callers until then anyway. */
  get ui(): UILayout | undefined {
    return this.game?.ui;
  }

  /** Access designed sprites/text from endcardLayout.json. */
  get endcardUI(): UILayout | undefined {
    return this.game?.endcardUILayout;
  }

  private async start(): Promise<void> {
    // Tear down whatever a *previous* bundle execution left running on
    // this same canvas before creating a new one — a no-op on a real
    // first page load (nothing's registered this hook yet).
    this.win.__disposeGame?.();

    const activeGame = await Game.create(this.canvas);
    this.game = activeGame;
    this.installDevHooks(activeGame);

    // Every bundle execution bumps this and captures its own copy below —
    // loop() checks it's still the most recent one on every frame, so an
    // old, superseded execution's RAF chain quietly stops rescheduling
    // itself instead of rendering alongside the new one into the same
    // canvas/WebGL context.
    this.win.__gameInstanceGeneration = (this.win.__gameInstanceGeneration ?? 0) + 1;
    const myGeneration = this.win.__gameInstanceGeneration;

    let lastTime = performance.now();

    const loop = (now: number): void => {
      if (this.win.__gameInstanceGeneration !== myGeneration) return;

      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      // Exponential moving average — an instantaneous 1/dt reading jitters
      // too much frame to frame to be readable.
      if (dt > 0) this.fps = this.fps === 0 ? 1 / dt : this.fps * 0.9 + (1 / dt) * 0.1;

      if (!this.uiEditorPaused && !this.freecamActive) activeGame.update(dt, now / 1000);
      activeGame.render();

      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private installDevHooks(activeGame: Game): void {
    this.win.__disposeGame = () => activeGame.dispose();
    activeGame.onGizmoModeChange((mode) => this.win.__onGizmoModeChanged?.(mode));

    this.win.__setUIEditorPaused = (paused) => {
      this.uiEditorPaused = paused;
    };
    this.win.__resizeGameTo = (width, height) => {
      activeGame.resizeTo(width, height);
    };
    this.win.__setFreecamActive = (active) => {
      this.freecamActive = active;
      activeGame.setFreecam(active);
    };
    this.win.__getEngineStats = () => ({
      fps: Math.round(this.fps),
      drawCalls: activeGame.rendererStats.drawCalls,
      triangles: activeGame.rendererStats.triangles,
    });
    this.win.__setGizmoMode = (mode) => {
      activeGame.setGizmoMode(mode as Parameters<Game["setGizmoMode"]>[0]);
    };
    this.win.__getInspectable = (className) => activeGame.getInspectable(className);

    // Must be last: __onGameReady's whole job is to trigger a resize
    // against the now-ready activeGame (see its doc comment above), so
    // __resizeGameTo has to already point at *this* instance by the time
    // it fires — calling this any earlier in this method (it used to run
    // second, right after __disposeGame) meant the resulting
    // applyDeviceFrame() -> __resizeGameTo() call either hit `undefined`
    // (first-ever boot) or a stale closure still bound to whatever Game
    // instance existed *before* this one (a reload) — either way, the
    // real, current renderer never actually got resized to match the
    // active device-frame letterbox, and silently stayed at its
    // constructor's raw-window-size default instead.
    this.win.__onGameReady?.();
  }
}
