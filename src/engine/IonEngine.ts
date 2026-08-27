import type * as THREE from "three";
import type { UILayout } from "./ui/UILayout";
import { Scheduler } from "./core/Scheduler";
import { EventBus } from "./core/EventBus";
import { bindIon, unbindIon, type IonContext } from "./Ion";
import { ColliderManager } from "./collision/ColliderManager";
import { ParticleManager } from "./particles/ParticleManager";
import { showCrashOverlay, removeCrashOverlay } from "./core/CrashOverlay";
import { isAssignableObjectField } from "./editor/objectAssignment";
import { OBJECT_DRAG_MIME } from "./editor/EditorDragSource";
// Type-only, so every one of these erases at build time and adds nothing to
// the bundle. They exist to describe GameDevFacade below precisely rather
// than restating each shape structurally and letting the two drift.
import type { GizmoMode, InspectorToolState } from "./core/SceneInspector";
import type { ColliderData, ColliderShape, ColliderStats } from "./collision";
import type { ParticleStats, ParticleSystemConfig } from "./particles";
import type { SceneEnvData } from "./scene";
import type { EditorRoot, FieldPickCallbacks } from "./editor/EditorRoot";

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
 * __setColliderMode / __createCollider / __deleteSelectedCollider /
 * __toggleColliderVisible / __getColliderStats: the 3D editor's "Configure
 * Colliders" toolbar — same passthrough shape as __setGizmoMode. Only
 * meaningful while the editor is open, except __getColliderStats, which
 * reads the always-present runtime registry.
 *
 * __setColliderDebug / __toggleColliderDebug: the Engine Room's "Colliders"
 * overlay — draws every collider and trigger volume *over the running
 * game*, with no editor open and gameplay proceeding normally, so a trigger
 * can be watched lighting up as the player walks into it. Deliberately
 * installed alongside the ungated hooks above rather than the editor ones
 * below, since needing the editor open would defeat the point.
 *
 * __serializeColliders / __hasColliderChanges / __markCollidersSaved /
 * __onColliderDirty: persisting collider edits. Batched to a single write
 * on Exit Editor for exactly the reason scene bindings are (see
 * index.html's pendingSceneBindings): src/game/colliders.json is a real
 * source file in main.ts's module graph, so writing it mid-session
 * hot-reloads the scene out from under the editor that's editing it.
 * __onColliderDirty is the reverse direction, so the Exit button can show
 * there's something to save.
 *
 * __serializeScene / __hasSceneChanges / __markSceneSaved / __onSceneDirty:
 * the same four hooks again, for src/game/scene.json — what the gizmo and the
 * Hierarchy did to the scene graph (transforms, visibility, names, parenting).
 * This was the one editor-authored surface with no file behind it, which is
 * why moving an object survived Exit Editor and vanished on a browser reload:
 * the change was a live mutation of an Object3D that the next boot rebuilt
 * from the GLB. See src/engine/scene/SceneOverrides.ts.
 *
 * __serializeEnvironment / __hasEnvironmentChanges /
 * __markEnvironmentSaved / __onEnvironmentDirty: the same four-hook shape
 * for the 3D editor's Environment dock (camera framing, lighting, world),
 * writing src/game/environment.json. Batched for the identical reason —
 * that file is a real import in main.ts's module graph, so writing it
 * mid-session would hot-reload the scene out from under the panel tuning
 * it.
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
  __editorRequestPick?: (
    declaredType: string | undefined,
    callbacks: { onResolve: (assignment: { value: unknown; object: unknown; objectPath: string; objectName: string; colliderId?: string }) => void; onReject?: (reason: string) => void; onCancel?: () => void }
  ) => boolean;
  __editorCancelPick?: () => void;
  __editorIsPickableField?: (declaredType: string | undefined) => boolean;
  __editorDragAssign?: (declaredType: string | undefined, commit: boolean, uuid?: string) => { ok: boolean; reason: string; name?: string; value?: unknown; objectPath?: string; objectName?: string; colliderId?: string } | undefined;
  __editorDragMime?: string;
  __setColliderMode?: (active: boolean) => boolean | undefined;
  __createCollider?: (shape: string) => void;
  __deleteSelectedCollider?: () => boolean;
  __toggleColliderVisible?: () => boolean | undefined;
  __serializeColliders?: () => unknown[] | undefined;
  __hasColliderChanges?: () => boolean;
  __markCollidersSaved?: () => void;
  __getColliderStats?: () => { total: number; enabled: number; narrowTests: number; activePairs: number };
  __onColliderDirty?: () => void;
  __serializeEnvironment?: () => unknown;
  __hasEnvironmentChanges?: () => boolean;
  __markEnvironmentSaved?: () => void;
  __onEnvironmentDirty?: () => void;
  __serializeScene?: () => unknown[] | undefined;
  __hasSceneChanges?: () => boolean;
  __markSceneSaved?: () => void;
  __onSceneDirty?: () => void;
  __setColliderDebug?: (visible: boolean) => boolean | undefined;
  __toggleColliderDebug?: () => boolean | undefined;
  __setParticleMode?: (active: boolean) => boolean | undefined;
  __createParticleSystem?: (presetKey?: string) => void;
  __addParticleEmitter?: () => void;
  __deleteSelectedEmitter?: () => boolean;
  __duplicateSelectedEmitter?: () => boolean;
  __particlePlay?: () => void;
  __particlePause?: () => void;
  __particleStop?: () => void;
  __particleRestart?: () => void;
  __particleClear?: () => void;
  __isParticlePreviewPlaying?: () => boolean;
  __toggleParticleGizmo?: (kind: string) => boolean | undefined;
  __getParticlePresets?: () => { key: string; label: string; description: string }[];
  __serializeParticles?: () => unknown[] | undefined;
  __hasParticleChanges?: () => boolean;
  __markParticlesSaved?: () => void;
  __getParticleStats?: () => { systems: number; emitters: number; activeParticles: number; maxParticles: number; simulating: number; drawCalls: number; bufferBytes: number; lastUpdateMs: number };
  __onParticleDirty?: () => void;
  __setParticleQuality?: (quality: string) => void;
  __editorUndo?: () => boolean;
  __editorRedo?: () => boolean;
  __getEditorHistory?: () => { canUndo: boolean; canRedo: boolean; undoLabel: string; redoLabel: string; colliderDirty: boolean; particleDirty: boolean; environmentDirty: boolean; depth: number } | undefined;
  __onEditorHistoryChanged?: () => void;
  __editorAssignmentFor?: (declaredType: string | undefined, object: unknown) => { value: unknown; object: unknown; objectPath: string; objectName: string; colliderId?: string } | undefined;
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
/**
 * Everything the Engine Room dev panel can ask a game for — all optional.
 *
 * `installDevHooks` used to call these straight off `Game`, which made every
 * one of them a *hard* requirement: a new playable's Game class had to
 * implement all 59 or the project wouldn't typecheck, even though nothing in
 * a production build ever calls one. Measured on a minimal game, that was 64
 * of 108 lines of pure stub.
 *
 * Declaring them here as optional and reaching them through this type instead
 * means a game implements only the dev features it actually wants. The Engine
 * Room already degrades gracefully — every one of its call sites is written
 * `window.__x && window.__x()` — so a missing member simply means that button
 * does nothing, which is the correct behaviour for a game that never wired it.
 *
 * `update`, `render`, `dispose` and the static `create` stay on `Game` itself
 * and stay required: those are the actual contract for running a game.
 */
export interface GameDevFacade {
  addParticleEmitter?(): void;
  cancelObjectPick?(): void;
  createCollider?(shape: ColliderShape): void;
  createParticleSystem?(presetKey?: string): void;
  deleteSelectedCollider?(): boolean;
  deleteSelectedEmitter?(): boolean;
  duplicateSelectedEmitter?(): boolean;
  editorAssignmentFor?(declaredType: string | undefined, object: THREE.Object3D): ReturnType<EditorRoot["assignmentFor"]> | undefined;
  editorDragAssign?(declaredType: string | undefined, commit: boolean, uuid?: string): ReturnType<EditorRoot["dragAssign"]> | undefined;
  editorRedo?(): boolean;
  editorUndo?(): boolean;
  readonly endcardUILayout?: UILayout;
  frameSelected?(): void;
  getAudioAnalyser?(): THREE.AudioAnalyser;
  getColliderStats?(): ColliderStats;
  getEditorHistory?(): ReturnType<EditorRoot["getHistoryState"]> | undefined;
  getEditorViewportInfo?(): ReturnType<EditorRoot["getViewportInfo"]> | undefined;
  getInspectable?(className: string): object | undefined;
  getParticlePresets?(): { key: string; label: string; description: string }[];
  getParticleStats?(): ParticleStats;
  hasColliderChanges?(): boolean;
  hasEnvironmentChanges?(): boolean;
  hasParticleChanges?(): boolean;
  isMusicPlaying?(): boolean;
  isParticlePreviewPlaying?(): boolean;
  hasSceneChanges?(): boolean;
  markCollidersSaved?(): void;
  markEnvironmentSaved?(): void;
  markParticlesSaved?(): void;
  markSceneSaved?(): void;
  onColliderDirty?(cb: () => void): void;
  onEditorHistoryChange?(cb: () => void): void;
  onEnvironmentDirty?(cb: () => void): void;
  onGizmoModeChange?(cb: (mode: GizmoMode) => void): void;
  onInspectorStateChange?(cb: (state: InspectorToolState) => void): void;
  onParticleDirty?(cb: () => void): void;
  onSceneDirty?(cb: () => void): void;
  particleClear?(): void;
  particlePause?(): void;
  particlePlay?(): void;
  particleRestart?(): void;
  particleStop?(): void;
  readonly rendererStats?: { drawCalls: number; triangles: number };
  requestObjectPick?(declaredType: string | undefined, callbacks: FieldPickCallbacks): boolean;
  resizeTo?(width: number, height: number): void;
  serializeColliders?(): ColliderData[] | undefined;
  serializeEnvironment?(): SceneEnvData | undefined;
  serializeParticles?(): ParticleSystemConfig[] | undefined;
  /** What the gizmo and the Hierarchy changed about the scene graph — see src/game/scene.json. */
  serializeScene?(): unknown[] | undefined;
  setColliderDebug?(visible: boolean): boolean | undefined;
  setColliderMode?(active: boolean): boolean | undefined;
  setFreecam?(active: boolean): void;
  setGizmoMode?(mode: GizmoMode): void;
  setParticleMode?(active: boolean): boolean | undefined;
  setParticleQuality?(quality: "high" | "medium" | "low"): void;
  toggleColliderDebug?(): boolean | undefined;
  toggleColliderVisible?(): boolean | undefined;
  toggleGrid?(): boolean | undefined;
  toggleHelpers?(): boolean | undefined;
  toggleParticleGizmo?(kind: "shapes" | "direction" | "bounds"): boolean | undefined;
  toggleSnap?(): boolean | undefined;
  toggleSpace?(): ("local" | "world") | undefined;
  readonly ui?: UILayout;
}

/**
 * The four things IonEngine needs of a game. Everything else it might ask for
 * is optional — see GameDevFacade.
 */
export interface IonGameLike {
  /**
   * One frame of engine work.
   *
   * Deliberately not called `update`: that is the name a *game* wants for its
   * own per-frame code, and when both used it a subclass's `update` silently
   * overrode the engine's — so entity ticking and camera follow stopped
   * running while the game itself looked fine. Separate names make that
   * collision impossible rather than merely unlikely.
   */
  tick(dt: number, elapsed: number): void;
  render(): void;
  dispose(): void;
}

/** Builds the game for a canvas. Async because assets preload before the first frame. */
export type CreateGame = (canvas: HTMLCanvasElement) => Promise<IonGameLike>;

export interface IonEngineOptions {
  /**
   * How to construct the game.
   *
   * A factory rather than an import, and that inversion is load-bearing: this
   * file used to `import { Game } from "../game/Game"`, which pointed the
   * engine at one specific playable. Beyond breaking the engine/game rule on
   * paper, it meant anything bundling the engine also bundled that game — its
   * entities, its UI, and its asset manifest, so a different project would
   * try to fetch models it has never heard of.
   */
  createGame?: CreateGame;

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

  private game: IonGameLike | undefined;
  private freecamActive = false;
  private fps = 0;
  private uiEditorPaused: boolean;
  /** Timers/tweens for this instance — owned here (not by Game) because the loop is what drives it, and because teardown has to be able to retire it on an in-place reload. */
  private readonly scheduler = new Scheduler();
  /** Same reasoning as scheduler — owned here so teardown can drop every listener before a hot-reloaded bundle's Game classes (whose closures those listeners captured) get disposed. */
  private readonly bus = new EventBus();
  /**
   * The ION Collider & Area system's registry. Owned here for the same
   * reasons as scheduler and bus: the loop is what drives it (so overlap
   * detection pauses with gameplay instead of firing behind the editor),
   * and teardown has to be able to retire it wholesale on an in-place
   * reload — a surviving collider from the old bundle would otherwise sit
   * in the new scene overlapping the new player.
   */
  private readonly colliders = new ColliderManager();
  /**
   * The ION Particle & VFX registry. Owned here for exactly the reasons
   * the collider registry is: the loop is what drives it (so effects
   * freeze with gameplay rather than running behind an open editor), and
   * teardown has to retire it wholesale on an in-place reload — a
   * surviving emitter from the old bundle would otherwise keep simulating
   * and drawing into the new scene.
   */
  private readonly particles = new ParticleManager();
  private readonly ionContext: IonContext = { scheduler: this.scheduler, bus: this.bus, colliders: this.colliders, particles: this.particles };

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
    // `start()` handles its own failures and never rejects, so this is a
    // deliberate fire-and-forget rather than a dropped promise. It used to be
    // a genuinely dropped one: anything that threw while the game was being
    // built — a bad asset path, a page missing the UI layers, a typo in
    // start() — surfaced only as "Uncaught (in promise)" over a blank canvas,
    // with no indication that it came from ION at all.
    void new IonEngine(canvas, options).start();
  }

  /** Access designed sprites/text from mainLayout.json by the name given in tools/ui-editor.html. Undefined only before Game.create() resolves — not meaningfully useful to callers until then anyway. */
  get ui(): UILayout | undefined {
    return (this.game as (IonGameLike & Partial<GameDevFacade>) | undefined)?.ui;
  }

  /** Access designed sprites/text from endcardLayout.json. */
  get endcardUI(): UILayout | undefined {
    return (this.game as (IonGameLike & Partial<GameDevFacade>) | undefined)?.endcardUILayout;
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

    // Bound *before* Game.create(), not after. Everything in the context
    // (scheduler, bus, collider registry) is constructed by this class's
    // own field initializers and depends on nothing from Game, so there was
    // never a reason for the bind to wait — and waiting had a real cost:
    // every entity constructor runs inside Game.create(), so `Ion.*` threw
    // its not-yet-booted error for exactly the code most likely to reach
    // for it. Registering a collider at the point an entity builds its
    // model (see Player's cylinder collider) needs this ordering.
    //
    // Safe against the stale-dispose case above: __disposeGame() has
    // already run, and unbindIon is context-guarded, so a late teardown
    // from a superseded bundle can't unbind this one.
    bindIon(this.ionContext);
    const createGame = this.options.createGame;
    if (!createGame) {
      this.reportBootFailure(
        new Error(
          "IonEngine.boot() needs a game to run: pass { createGame }.\n" +
            "  e.g. IonEngine.boot(canvas, { createGame: (c) => Game.create(c) })"
        )
      );
      return;
    }
    let activeGame: IonGameLike;
    try {
      activeGame = await createGame(this.canvas);
    } catch (err) {
      this.reportBootFailure(err);
      return;
    }
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
              activeGame.tick(fixedStep, fixedElapsed);
              this.scheduler.update(fixedStep);
              // After update(), so overlaps are evaluated against where
              // things actually moved to this step rather than a step
              // behind — and inside the not-paused guard, so trigger
              // enter/exit doesn't fire behind an open editor.
              this.colliders.update();
              // After the colliders, so an effect a trigger fired this
              // step is simulated from this step rather than the next —
              // and inside the same guard, so VFX freeze with gameplay.
              this.particles.update(fixedStep);
              accumulator -= fixedStep;
              steps++;
            }
            // Hit the cap: real time is arriving faster than we can simulate
            // it. Drop the backlog instead of carrying it into the next
            // frame, where it would produce the same overrun again, forever.
            if (steps === MAX_FIXED_STEPS_PER_FRAME) accumulator = 0;
          } else {
            activeGame.tick(dt, now / 1000);
            this.scheduler.update(dt);
            this.colliders.update(); // see the fixed-step branch above for the ordering
            this.particles.update(dt);
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

  /**
   * Reports a failure that happened before the first frame.
   *
   * Handled exactly like a gameplay crash — same recovery overlay, same
   * `onCrash` hook — because from a player's point of view they are the same
   * event: the playable did not run. The only difference is that there is no
   * loop to stop, since one was never started.
   */
  private reportBootFailure(err: unknown): void {
    console.error("IonEngine: the game failed to start — showing the fallback CTA instead of a blank canvas.", err);
    // Nothing was created, so nothing can be torn down; but the Ion binding
    // was taken before createGame ran and would otherwise outlive this
    // attempt and make the next boot's staleness check meaningless.
    unbindIon(this.ionContext);
    try {
      this.options.onCrash?.(err);
    } catch (hookErr) {
      console.error("IonEngine: onCrash itself threw (ignored, recovery UI still shows):", hookErr);
    }
    showCrashOverlay();
  }

  private installDevHooks(activeGame: IonGameLike): void {
    // Every dev-panel member is optional (see GameDevFacade). Reaching them
    // through this alias rather than off `activeGame` directly is what keeps
    // them from being a hard requirement on every game built on this engine.
    const dev = activeGame as IonGameLike & Partial<GameDevFacade>;
    this.win.__disposeGame = () => {
      // Order matters: drop this instance's pending timers/tweens *before*
      // the Game they close over is torn down. A surviving one-shot from
      // the old bundle would otherwise fire into a disposed Game (or, on
      // an in-place reload, alongside the new one) — the same class of
      // bug __gameInstanceGeneration already guards the RAF loop against.
      this.scheduler.clear();
      this.bus.clear();
      // Same reasoning one line up: a collider from the retired bundle
      // left in the scene would keep overlapping (and firing enter/exit
      // into handlers closing over a disposed Game) alongside the new one.
      this.colliders.clear();
      // And the same again for particles — an emitter from the retired
      // bundle would keep simulating and drawing into the new scene, and
      // its GPU buffers would leak on every reload. The shared default
      // texture is deliberately NOT released here: the next bundle is
      // about to build emitters that want it (see disposeSharedResources).
      this.particles.clear();
      unbindIon(this.ionContext);
      activeGame.dispose();
    };
    dev.onGizmoModeChange?.((mode) => this.win.__onGizmoModeChanged?.(mode));

    this.win.__setUIEditorPaused = (paused) => {
      this.uiEditorPaused = paused;
    };
    this.win.__resizeGameTo = (width, height) => {
      dev.resizeTo?.(width, height);
    };
    this.win.__setFreecamActive = (active) => {
      this.freecamActive = active;
      dev.setFreecam?.(active);
    };
    this.win.__getEngineStats = () => ({
      fps: Math.round(this.fps),
      // Zeroed rather than absent when a game doesn't expose them: the
      // Engine Room's stats row renders a number or nothing, and "0" reads
      // as "this game reports no counters" far better than a blank cell.
      drawCalls: dev.rendererStats?.drawCalls ?? 0,
      triangles: dev.rendererStats?.triangles ?? 0,
    });
    this.win.__setGizmoMode = (mode) => {
      dev.setGizmoMode?.(mode as GizmoMode);
    };
    this.win.__toggleGrid = () => dev.toggleGrid?.();
    this.win.__toggleHelpers = () => dev.toggleHelpers?.();
    this.win.__toggleSnap = () => dev.toggleSnap?.();
    this.win.__toggleSpace = () => dev.toggleSpace?.();
    this.win.__frameSelected = () => dev.frameSelected?.();
    // Ungated, unlike the editor hooks further down: the Engine Room's
    // Colliders overlay is meant to work over the *running* game with no
    // editor open. It's still dev-only in effect — the layer it drives is
    // built behind import.meta.env.DEV, so in production these return
    // undefined and draw nothing.
    this.win.__setColliderDebug = (visible) => dev.setColliderDebug?.(visible);
    this.win.__toggleColliderDebug = () => dev.toggleColliderDebug?.();
    dev.onInspectorStateChange?.((state) => this.win.__onInspectorStateChanged?.(state));
    this.win.__getInspectable = (className) => dev.getInspectable?.(className);
    this.win.__getAudioAnalyser = () => dev.getAudioAnalyser?.();
    this.win.__isMusicPlaying = () => dev.isMusicPlaying?.() ?? false;
    // Editor-only hooks, gated so a production build drops not just these
    // assignments but the entire editor module tree they reach into —
    // objectAssignment's type table and EditorDragSource's MIME constant
    // are real code and real strings, and an ungated import pulls them in
    // even when nothing ever calls the hook. Everything above stays
    // ungated: those are plain closures over the Game that's already in
    // the bundle, so they cost nothing beyond their own bytes.
    if (!import.meta.env.DEV) return this.win.__onGameReady?.();

    // `?? false` for the same reason the boolean hooks above use it: the
    // dev page reads a falsy return as "the editor isn't open / can't do
    // this", which is precisely the situation a game with no facade is in.
    this.win.__editorRequestPick = (declaredType, callbacks) =>
      dev.requestObjectPick?.(declaredType, {
        onResolve: (assignment) => callbacks.onResolve(assignment),
        onReject: callbacks.onReject,
        onCancel: callbacks.onCancel,
      }) ?? false;
    this.win.__editorCancelPick = () => dev.cancelObjectPick?.();
    // Available whenever the game is booted, not only while the editor is
    // open — Control Desk needs it to decide which fields get a "Pick"
    // button at render time, and it renders regardless of editor state.
    // Exposed rather than reimplemented in index.html so the declared-type
    // rules live in exactly one place (see editor/objectAssignment.ts).
    this.win.__editorIsPickableField = (declaredType) => isAssignableObjectField(declaredType);
    this.win.__getEditorViewportInfo = () => dev.getEditorViewportInfo?.();
    this.win.__editorAssignmentFor = (declaredType, object) => dev.editorAssignmentFor?.(declaredType, object as THREE.Object3D);
    this.win.__editorDragAssign = (declaredType, commit, uuid) => dev.editorDragAssign?.(declaredType, commit, uuid);
    // Exposed so the Control Desk's drop targets match on the same MIME the
    // Hierarchy rows set, without that string being written out twice.
    this.win.__editorDragMime = OBJECT_DRAG_MIME;

    this.win.__setColliderMode = (active) => dev.setColliderMode?.(active);
    this.win.__createCollider = (shape) => dev.createCollider?.(shape as ColliderShape);
    this.win.__deleteSelectedCollider = () => dev.deleteSelectedCollider?.() ?? false;
    this.win.__toggleColliderVisible = () => dev.toggleColliderVisible?.();
    this.win.__serializeColliders = () => dev.serializeColliders?.();
    this.win.__hasColliderChanges = () => dev.hasColliderChanges?.() ?? false;
    this.win.__markCollidersSaved = () => dev.markCollidersSaved?.();
    this.win.__getColliderStats = () => dev.getColliderStats?.() ?? { total: 0, enabled: 0, narrowTests: 0, activePairs: 0 };
    dev.onColliderDirty?.(() => this.win.__onColliderDirty?.());

    // The 3D editor's Environment dock. Not a mode — the panel is simply
    // present for the whole session — so there's nothing to switch on and
    // off here, only the four persistence hooks.
    this.win.__serializeEnvironment = () => dev.serializeEnvironment?.();
    this.win.__hasEnvironmentChanges = () => dev.hasEnvironmentChanges?.() ?? false;
    this.win.__markEnvironmentSaved = () => dev.markEnvironmentSaved?.();
    dev.onEnvironmentDirty?.(() => this.win.__onEnvironmentDirty?.());
    this.win.__serializeScene = () => dev.serializeScene?.();
    this.win.__hasSceneChanges = () => dev.hasSceneChanges?.() ?? false;
    this.win.__markSceneSaved = () => dev.markSceneSaved?.();
    dev.onSceneDirty?.(() => this.win.__onSceneDirty?.());

    // The 3D editor's "Particle System" mode — same passthrough shape as
    // the collider toolbar above, and only meaningful while the editor is
    // open, except __getParticleStats which reads the always-present
    // runtime registry.
    this.win.__setParticleMode = (active) => dev.setParticleMode?.(active);
    this.win.__createParticleSystem = (presetKey) => dev.createParticleSystem?.(presetKey);
    this.win.__addParticleEmitter = () => dev.addParticleEmitter?.();
    this.win.__deleteSelectedEmitter = () => dev.deleteSelectedEmitter?.() ?? false;
    this.win.__duplicateSelectedEmitter = () => dev.duplicateSelectedEmitter?.() ?? false;
    this.win.__particlePlay = () => dev.particlePlay?.();
    this.win.__particlePause = () => dev.particlePause?.();
    this.win.__particleStop = () => dev.particleStop?.();
    this.win.__particleRestart = () => dev.particleRestart?.();
    this.win.__particleClear = () => dev.particleClear?.();
    this.win.__isParticlePreviewPlaying = () => dev.isParticlePreviewPlaying?.() ?? false;
    this.win.__toggleParticleGizmo = (kind) => dev.toggleParticleGizmo?.(kind as "shapes" | "direction" | "bounds");
    this.win.__getParticlePresets = () => dev.getParticlePresets?.() ?? [];
    this.win.__serializeParticles = () => dev.serializeParticles?.();
    this.win.__hasParticleChanges = () => dev.hasParticleChanges?.() ?? false;
    this.win.__markParticlesSaved = () => dev.markParticlesSaved?.();
    this.win.__getParticleStats = () => dev.getParticleStats?.() ?? { systems: 0, emitters: 0, activeParticles: 0, maxParticles: 0, simulating: 0, drawCalls: 0, bufferBytes: 0, lastUpdateMs: 0 };
    this.win.__setParticleQuality = (quality) => dev.setParticleQuality?.(quality as "high" | "medium" | "low");
    dev.onParticleDirty?.(() => this.win.__onParticleDirty?.());

    // Undo/redo. One stack across both editor modes (see EditorRoot), so
    // these are deliberately not namespaced per mode — a single Undo walks
    // back through whatever actually happened, in order.
    this.win.__editorUndo = () => dev.editorUndo?.() ?? false;
    this.win.__editorRedo = () => dev.editorRedo?.() ?? false;
    this.win.__getEditorHistory = () => dev.getEditorHistory?.();
    dev.onEditorHistoryChange?.(() => this.win.__onEditorHistoryChanged?.());

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
