import type * as THREE from "three";
import { Game } from "../game/Game";
import type { UILayout } from "./ui/UILayout";
import { Scheduler } from "./core/Scheduler";
import { EventBus } from "./core/EventBus";
import { bindIon, unbindIon, type IonContext } from "./Ion";
import { showCrashOverlay, removeCrashOverlay } from "./core/CrashOverlay";
import { isAssignableObjectField } from "./editor/objectAssignment";
import { OBJECT_DRAG_MIME } from "./editor/EditorDragSource";

/**
 * Dev-only hooks the Engine Room panel (index.html, the dev entry — see
 * vite.config.ts) and the in-place hot-reload flow (main.ts's own
 * `import.meta.hot.accept()`) talk to. All inert in the production build —
 * nothing in src/index.template.html or the shipped bundle ever calls any
 * of these, so this whole surface is simply never touched there.
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
 * __toggleGrid / __toggleHelpers / __toggleSnap / __toggleSpace /
 * __frameSelected: the Engine Room panel's Grid/Helpers/Snap/Space/Frame
 * toolbar buttons, same passthrough shape as __setGizmoMode. The four
 * toggles return their new state so the button's own click handler can
 * flip its active-highlight immediately, without waiting on
 * __onInspectorStateChanged below.
 *
 * __onInspectorStateChanged: the reverse direction for that same toolbar —
 * F/G/H/X/C keyboard shortcuts (handled inside SceneInspector, see its
 * onKeyDown) also flip these, so this is how the buttons find out and stay
 * in sync, same reasoning as __onGizmoModeChanged.
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
 * __editorRequestPick / __editorCancelPick: Control Desk's "Pick" flow —
 * arms the 3D Viewer/Editor to hand back the next scene object the user
 * clicks (in the Hierarchy or the viewport, interchangeably), type-checked
 * against the field's declared TypeScript type. Same no-serialization
 * reasoning as __getInspectable below: the resolved object is the real
 * live THREE.Object3D, so assigning it to a field assigns the actual scene
 * object, not a copy or an id. __editorRequestPick returns false when the
 * editor isn't open (nothing to click in).
 *
 * __getInspectable: the Engine Room panel's Control Desk (a live public-
 * field viewer/editor, keyed by class name) calls this to reach an actual
 * running instance — Player, CoinField, World, Game itself, whatever
 * Game.ts chose to register (see Game.getInspectable) — and reads/writes
 * its fields directly. No serialization involved: the dev panel and the
 * running game share this same `window`, so the hook just hands back the
 * real object reference.
 *
 * __getAudioAnalyser / __isMusicPlaying: the Engine Room "Audio Reactor"
 * panel's live spectrum readout — same no-serialization reasoning as
 * __getInspectable, just handing back a THREE.AudioAnalyser instance
 * (structurally typed here as {getFrequencyData} rather than importing
 * THREE into this file just for the annotation) instead of a whole object.
 * Dev-only in every sense: the analyser itself is never constructed unless
 * this hook is actually called (see SoundHandler.getAnalyser's own doc
 * comment), so a production build that never wires these up pays nothing.
 *
 * __disposeGame / __gameInstanceGeneration: in-place hot-reload itself.
 * main.ts self-accepts its own Vite HMR updates (`import.meta.hot.accept()`)
 * so a source/layout save re-executes just that module in place instead of
 * a full page navigation, specifically so the UI editor overlay's own
 * in-memory session (undo history, unsaved edits, Connect state) survives a
 * Save — a full reload used to wipe all of it out from under you every
 * time. Each module execution is its own isolated closure with no shared
 * state, so the *new* one has to reach back into the *old* one via `window`
 * to tear it down — see start()/dispose().
 */
type EngineWindow = Window & {
  __setUIEditorPaused?: (paused: boolean) => void;
  __resizeGameTo?: (width: number, height: number) => void;
  __getEngineStats?: () => { fps: number; drawCalls: number; triangles: number };
  __setFreecamActive?: (active: boolean) => void;
  __setGizmoMode?: (mode: string) => void;
  __onGizmoModeChanged?: (mode: string) => void;
  __toggleGrid?: () => boolean | undefined;
  __toggleHelpers?: () => boolean | undefined;
  __toggleSnap?: () => boolean | undefined;
  __toggleSpace?: () => string | undefined;
  __frameSelected?: () => void;
  __onInspectorStateChanged?: (state: { grid: boolean; helpers: boolean; snap: boolean; space: string }) => void;
  __getInspectable?: (className: string) => object | undefined;
  __wasFreecamActive?: () => boolean;
  __editorRequestPick?: (declaredType: string | undefined, callbacks: { onResolve: (object: unknown) => void; onReject?: (reason: string) => void; onCancel?: () => void }) => boolean;
  __editorCancelPick?: () => void;
  __editorIsPickableField?: (declaredType: string | undefined) => boolean;
  __editorObjectPath?: (object: unknown) => { objectPath: string; objectName: string } | undefined;
  __editorDragAssign?: (declaredType: string | undefined, commit: boolean, uuid?: string) => { ok: boolean; reason: string; name?: string; object?: unknown; objectPath?: string; objectName?: string } | undefined;
  __editorDragMime?: string;
  __getEditorViewportInfo?: () => { containerWidth: number; containerHeight: number; containerAspect: number; rendererWidth: number; rendererHeight: number; cameraAspect: number; pixelRatio: number } | undefined;
  __getAudioAnalyser?: () => { getFrequencyData: () => Uint8Array } | undefined;
  __isMusicPlaying?: () => boolean;
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
/**
 * Optional knobs for boot(). Everything here has a default that preserves
 * the engine's original behavior exactly — an existing playable that calls
 * `IonEngine.boot(canvas)` with no options behaves byte-for-byte as before.
 */
export interface IonEngineOptions {
  /**
   * Run gameplay on a fixed timestep (seconds — e.g. `1/60`) instead of
   * the default variable, frame-length dt.
   *
   * Off by default, because the variable path is what every existing
   * system here was written and tuned against. Turn it on when
   * determinism matters — anything integrating forces, resolving
   * collisions, or otherwise accumulating state across frames will
   * visibly jitter (or tunnel straight through a collider) on a frame
   * spike under variable dt, because a single 50ms step is not the same
   * as three 16ms ones.
   *
   * When set, update() may run several times in one animation frame to
   * consume the accumulated time, and exactly once per fixed step —
   * render() still runs once per frame, as usual.
   */
  fixedTimestep?: number;

  /**
   * update()/render() throwing mid-frame stops that RAF chain for good —
   * not stopping it means the *next* frame throws too, forever, which is
   * worse than doing nothing: a playable that's crashed can never earn
   * its install click again, so continuing to burn CPU on a broken loop
   * has no upside. IonEngine always shows a minimal, dependency-free
   * fallback (see core/CrashOverlay.ts) with a working CTA so the ad
   * spend isn't a total loss even though gameplay is dead.
   *
   * onCrash is an optional *addition* to that, not a replacement for it —
   * for logging/analytics. Wrapped in its own try/catch: if this itself
   * throws, it's swallowed, since the one thing that must never fail is
   * showing the recovery UI.
   */
  onCrash?: (error: unknown) => void;
}

/** Guards the "spiral of death": if a single frame accumulated more steps than this (a background tab, a long GC pause, a breakpoint), drop the backlog rather than running hundreds of update()s and falling further behind on every subsequent frame. */
const MAX_FIXED_STEPS_PER_FRAME = 5;

export class IonEngine {
  private readonly win = window as EngineWindow;

  private game: Game | undefined;
  private freecamActive = false;
  private fps = 0;
  private uiEditorPaused: boolean;
  /** Timers/tweens for this instance — owned here (not by Game) because the loop is what drives it, and because teardown has to be able to retire it on an in-place reload. */
  private readonly scheduler = new Scheduler();
  /** Same reasoning as scheduler — owned here so teardown can drop every listener before a hot-reloaded bundle's Game classes (whose closures those listeners captured) get disposed. */
  private readonly bus = new EventBus();
  private readonly ionContext: IonContext = { scheduler: this.scheduler, bus: this.bus };

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: IonEngineOptions = {}
  ) {
    // Derived from the real DOM, not defaulted to false — this instance is
    // recreated fresh on every in-place reload, but the editor overlay's
    // own visibility (owned by index.html, never touched by a
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
  static boot(canvas: HTMLCanvasElement, options?: IonEngineOptions): void {
    new IonEngine(canvas, options).start();
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
    // A crash overlay from a previous dev iteration (see the crash guard
    // below) has nothing to do with *this* fresh instance — clear it so
    // it doesn't linger visually over a working reload.
    removeCrashOverlay();

    const activeGame = await Game.create(this.canvas);
    this.game = activeGame;
    // Bind before installDevHooks (and therefore before __onGameReady
    // fires) so anything reacting to "the game exists now" can already
    // use Ion.after/tween without tripping its not-yet-booted guard.
    bindIon(this.ionContext);
    this.installDevHooks(activeGame);

    // Every bundle execution bumps this and captures its own copy below —
    // loop() checks it's still the most recent one on every frame, so an
    // old, superseded execution's RAF chain quietly stops rescheduling
    // itself instead of rendering alongside the new one into the same
    // canvas/WebGL context.
    this.win.__gameInstanceGeneration = (this.win.__gameInstanceGeneration ?? 0) + 1;
    const myGeneration = this.win.__gameInstanceGeneration;

    let lastTime = performance.now();
    const fixedStep = this.options.fixedTimestep ?? 0;
    /** Unconsumed real time carried between frames — fixed-timestep mode only. */
    let accumulator = 0;
    /** Game time in fixed mode: advances only by whole steps actually run, so it never drifts from the number of update()s. Unused in variable mode, which keeps passing wall-clock `now` exactly as before. */
    let fixedElapsed = 0;

    const loop = (now: number): void => {
      if (this.win.__gameInstanceGeneration !== myGeneration) return;

      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      // Exponential moving average — an instantaneous 1/dt reading jitters
      // too much frame to frame to be readable.
      if (dt > 0) this.fps = this.fps === 0 ? 1 / dt : this.fps * 0.9 + (1 / dt) * 0.1;

      try {
        if (!this.uiEditorPaused && !this.freecamActive) {
          if (fixedStep > 0) {
            accumulator += dt;
            let steps = 0;
            while (accumulator >= fixedStep && steps < MAX_FIXED_STEPS_PER_FRAME) {
              fixedElapsed += fixedStep;
              activeGame.update(fixedStep, fixedElapsed);
              this.scheduler.update(fixedStep);
              accumulator -= fixedStep;
              steps++;
            }
            // Hit the cap: real time is arriving faster than we can simulate
            // it. Drop the backlog instead of carrying it into the next
            // frame, where it would produce the same overrun again, forever.
            if (steps === MAX_FIXED_STEPS_PER_FRAME) accumulator = 0;
          } else {
            activeGame.update(dt, now / 1000);
            this.scheduler.update(dt);
          }
        }
        activeGame.render();
      } catch (err) {
        // Deliberately not re-entering this loop — see IonEngineOptions.onCrash's
        // doc comment for why a dead RAF chain is the right outcome here.
        console.error("IonEngine: gameplay crashed — showing the fallback CTA instead of a dead frame.", err);
        try {
          this.options.onCrash?.(err);
        } catch (hookErr) {
          console.error("IonEngine: onCrash itself threw (ignored, recovery UI still shows):", hookErr);
        }
        showCrashOverlay();
        return;
      }

      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private installDevHooks(activeGame: Game): void {
    this.win.__disposeGame = () => {
      // Order matters: drop this instance's pending timers/tweens *before*
      // the Game they close over is torn down. A surviving one-shot from
      // the old bundle would otherwise fire into a disposed Game (or, on
      // an in-place reload, alongside the new one) — the same class of
      // bug __gameInstanceGeneration already guards the RAF loop against.
      this.scheduler.clear();
      this.bus.clear();
      unbindIon(this.ionContext);
      activeGame.dispose();
    };
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
    this.win.__toggleGrid = () => activeGame.toggleGrid();
    this.win.__toggleHelpers = () => activeGame.toggleHelpers();
    this.win.__toggleSnap = () => activeGame.toggleSnap();
    this.win.__toggleSpace = () => activeGame.toggleSpace();
    this.win.__frameSelected = () => activeGame.frameSelected();
    activeGame.onInspectorStateChange((state) => this.win.__onInspectorStateChanged?.(state));
    this.win.__getInspectable = (className) => activeGame.getInspectable(className);
    this.win.__getAudioAnalyser = () => activeGame.getAudioAnalyser();
    this.win.__isMusicPlaying = () => activeGame.isMusicPlaying();
    // Editor-only hooks, gated so a production build drops not just these
    // assignments but the entire editor module tree they reach into —
    // objectAssignment's type table and EditorDragSource's MIME constant
    // are real code and real strings, and an ungated import pulls them in
    // even when nothing ever calls the hook. Everything above stays
    // ungated: those are plain closures over the Game that's already in
    // the bundle, so they cost nothing beyond their own bytes.
    if (!import.meta.env.DEV) return this.win.__onGameReady?.();

    this.win.__editorRequestPick = (declaredType, callbacks) =>
      activeGame.requestObjectPick(declaredType, {
        onResolve: (object) => callbacks.onResolve(object),
        onReject: callbacks.onReject,
        onCancel: callbacks.onCancel,
      });
    this.win.__editorCancelPick = () => activeGame.cancelObjectPick();
    // Available whenever the game is booted, not only while the editor is
    // open — Control Desk needs it to decide which fields get a "Pick"
    // button at render time, and it renders regardless of editor state.
    // Exposed rather than reimplemented in index.html so the declared-type
    // rules live in exactly one place (see editor/objectAssignment.ts).
    this.win.__editorIsPickableField = (declaredType) => isAssignableObjectField(declaredType);
    this.win.__getEditorViewportInfo = () => activeGame.getEditorViewportInfo();
    this.win.__editorObjectPath = (object) => activeGame.editorObjectPath(object as THREE.Object3D);
    this.win.__editorDragAssign = (declaredType, commit, uuid) => activeGame.editorDragAssign(declaredType, commit, uuid);
    // Exposed so the Control Desk's drop targets match on the same MIME the
    // Hierarchy rows set, without that string being written out twice.
    this.win.__editorDragMime = OBJECT_DRAG_MIME;

    // Restore the 3D Viewer/Editor after an in-place reload, here rather
    // than in main.ts's hot-accept callback. That callback runs the moment
    // the new module's top-level code has executed — which is while
    // start() is still awaiting Game.create(), so at that point
    // __setFreecamActive is still the *previous* instance's closure,
    // pointing at a Game that was just disposed. Its own
    // already-in-freecam guard turned the call into a no-op, and the new
    // Game never entered the editor at all: the dev page kept showing the
    // editor chrome while gameplay quietly resumed underneath it. Doing it
    // here means the hooks above are already this instance's, and the Game
    // they close over is the live one.
    if (this.win.__wasFreecamActive?.()) {
      this.win.__setFreecamActive?.(true);
    }

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
