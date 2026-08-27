import * as THREE from "three";
import { CameraHandler } from "../../../src/engine/core/CameraHandler";
import { SceneEnvironment, loadSceneEnv, snapshotScene, applySceneOverrides } from "../../../src/engine/scene";
import type { SceneSnapshot } from "../../../src/engine/scene";
import type { SceneEnvData } from "../../../src/engine/scene";
import { AssetLoader } from "../../../src/engine/AssetLoader";
import type { AssetEntry } from "../../../src/engine/AssetLoader";
import { UILayout } from "../../../src/engine/ui/UILayout";
import type { UILayoutData } from "../../../src/engine/ui/UILayoutTypes";
import { Ion } from "../../../src/engine/Ion";
import { loadColliders } from "../../../src/engine/collision";
import { loadParticles } from "../../../src/engine/particles";
import { applySceneBindings } from "../../../src/engine/SceneBindings";
import { getEditorHost, type DebugLayer, type EditorSession } from "./editor-host";
import { InputManager } from "../../../src/engine/core/InputManager";
import { DynamicJoystick } from "../../../src/engine/core/DynamicJoystick";
import { disposeScene } from "../../../src/engine/core/disposeScene";

/**
 * The two overlay divs every ION page provides, fetched with an error that
 * says what to do.
 *
 * A project that edits its own index.html and drops one of these used to get
 * `Cannot read properties of null (reading 'appendChild')` from inside
 * UILayout's constructor, several frames from the cause.
 */
/**
 * One `WebGLRenderer` per canvas, reused for the life of the page.
 *
 * A dev in-place reload boots a new game into the *same* canvas, and
 * `canvas.getContext()` hands back the *same* WebGL context every time — so
 * constructing a renderer per boot did not get a fresh context, it got another
 * set of three.js's own per-renderer allocations (four placeholder textures
 * and three framebuffers) layered onto the one context. `renderer.dispose()`
 * does not release those, so a long editing session accumulated seven GL
 * objects per save, forever. Reusing the renderer is also simply what the
 * context wants: two renderers driving one context fight over its state.
 *
 * Keyed weakly so a canvas that goes out of scope takes its renderer with it.
 */
const renderersByCanvas = new WeakMap<HTMLCanvasElement, THREE.WebGLRenderer>();

function acquireRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const existing = renderersByCanvas.get(canvas);
  // A lost context cannot be rendered through and cannot be revived by us —
  // three.js reinitialises on `webglcontextrestored`, but if we are booting
  // into one that is still lost, a fresh renderer is the honest answer.
  if (existing && !existing.getContext().isContextLost()) return existing;
  const created = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderersByCanvas.set(canvas, created);
  return created;
}

function requireLayer(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(
      `ION: the page is missing <div id="${id}"></div>.\n` +
        "  Both #custom-ui-layer and #endcard-layer must exist before the game boots —\n" +
        "  they are where the UI editor's layouts are rendered. Restore them in your\n" +
        "  index.html (see src/index.template.html for the expected markup)."
    );
  }
  return element;
}

/** The authored data files a project ships. All optional — a missing one just means that system has nothing to load. */
export interface IonProjectData {
  environment?: unknown;
  /** What the 3D editor changed about the scene graph itself — transforms, visibility, names, parenting. */
  scene?: unknown;
  colliders?: unknown;
  particles?: unknown;
  sceneBindings?: unknown;
  mainLayout?: unknown;
  endcardLayout?: unknown;
}

export interface IonGameOptions {
  canvas: HTMLCanvasElement;
  /** Preloaded before your onCreate runs. Nothing loads lazily — a playable can't afford a mid-interaction stall. */
  manifest?: AssetEntry[];
  /** The JSON the ION editors write. Pass them straight through from your imports. */
  data?: IonProjectData;
  /** Class name this game registers under for ⊙ Pick scene bindings. Defaults to "Game". */
  bindingName?: string;
  /**
   * A loader that has already resolved `manifest`.
   *
   * `create()` passes the loader it preloaded with, so the constructor builds
   * the scene environment against real assets. It used to construct an empty
   * loader and have `create()` swap the warmed one in afterwards — by which
   * point `environment.apply()` had already run and quietly resolved every
   * background/skybox texture to `undefined`, so a project that authored a
   * texture background silently rendered the fallback colour instead.
   *
   * Passing one explicitly is also how two games can share a warmed cache.
   */
  assets?: AssetLoader;
}

/**
 * The base every ION game extends.
 *
 * ## Why this exists
 *
 * It owns everything that is *engine* rather than *game*: the renderer, the
 * camera rig, the scene environment, the collider and particle registries,
 * the UI layers, the whole dev-editor surface, resize handling, and teardown.
 * A project's own `Game` subclass implements gameplay and nothing else.
 *
 * That split is what makes the commercial boundary work. Before this class,
 * every playable's `Game.ts` had to construct `EditorRoot` itself and carry a
 * 59-member dev facade — which meant a client project could not be written
 * without importing editor internals. Now the editor is reached through
 * `editor-host`'s registration hook, which the *dev entry* fills in and a
 * production build never touches, so client code never names an editor module
 * at all.
 *
 * ## What a subclass provides
 *
 * ```ts
 * export class Game extends IonGame {
 *   private cube!: THREE.Mesh;
 *   protected onCreate(): void { this.cube = ...; this.scene.add(this.cube); }
 *   protected onUpdate(dt: number): void { this.cube.rotation.y += dt; }
 *   protected getCameraFocus(): THREE.Vector3 { return this.cube.position; }
 * }
 * ```
 *
 * `IonEngine.boot(canvas, { createGame: (c) => Game.create(c, { … }) })` does
 * the rest.
 */
export abstract class IonGame {
  /** The scene graph. Add your content to it. */
  protected readonly scene = new THREE.Scene();
  /** The camera rig — perspective + orthographic, driven by ion's environment config. */
  protected readonly camera: CameraHandler;
  /** Lights, fog, background, tone mapping and shadows, from environment.json. */
  protected readonly environment: SceneEnvironment;
  /** Preloaded textures, models and audio. */
  protected readonly assets: AssetLoader;
  /** The main UI layer, built from mainLayout.json. */
  readonly ui: UILayout;
  /** The endcard UI layer, built from endcardLayout.json. */
  readonly endcardUI: UILayout;
  /** Keyboard and pointer input. Reached through `ION.input` in game code. */
  readonly input: InputManager;
  /**
   * The touch-anywhere virtual joystick, when the layout defines one.
   *
   * Built only if mainLayout.json contains a `joystick` element, because a
   * joystick with no designed visuals would be invisible and a game that
   * doesn't want one shouldn't get a full-screen input catcher it never asked
   * for. `ION.input.axis` reads this when present and the keyboard otherwise,
   * so game code does not branch on it.
   */
  readonly joystick: DynamicJoystick | undefined;
  /** The audio listener every sound plays through. Parented to the perspective camera — see CameraHandler. */
  readonly audioListener = new THREE.AudioListener();

  private readonly renderer: THREE.WebGLRenderer;
  protected readonly mainLayer: HTMLElement;
  private editorSession: EditorSession | undefined;
  /** The "Show Colliders" overlay. Exists only when a dev entry registered an editor host — undefined, and never drawn, in production. */
  private readonly debugLayer: DebugLayer | undefined;
  private readonly canvas!: HTMLCanvasElement;
  private manualSize = false;
  private lastManualWidth = 0;
  private lastManualHeight = 0;
  /** Class-name → instance, for Control Desk. Subclasses add to it via `inspect()`. */
  private readonly inspectables = new Map<string, object>();
  /** The pre-override scene, handed to an editor session so its Save can diff against the model rather than against itself. */
  private sceneBaseline: SceneSnapshot | undefined;
  /** The records scene.json held at boot — kept so a session that touches nothing still re-writes them. */
  private sceneOverridesOnLoad: readonly { objectPath: string }[] = [];

  /**
   * Public because `IonGame.create()` constructs `new this(options)` and
   * TypeScript will not accept a protected constructor there. Call `create()`
   * rather than this directly — it preloads assets and runs the ordered
   * setup that collider, particle and binding data depend on.
   */
  constructor(options: IonGameOptions) {
    const data = options.data ?? {};
    const environmentData: SceneEnvData = loadSceneEnv(data.environment);

    this.assets = options.assets ?? new AssetLoader();
    this.camera = new CameraHandler(environmentData.camera);

    this.renderer = acquireRenderer(options.canvas);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.environment = new SceneEnvironment(
      {
        scene: this.scene,
        renderer: this.renderer,
        rig: this.camera,
        resolveTexture: (p) => {
          try {
            return this.assets.getTexture(p);
          } catch {
            return undefined;
          }
        },
      },
      environmentData
    );
    this.environment.apply();
    this.camera.handleResize(window.innerWidth, window.innerHeight);

    Ion.colliders.attachToScene(this.scene);
    Ion.particles.attachToScene(this.scene);

    const layerOrEmpty = (raw: unknown): UILayoutData =>
      (raw as UILayoutData) ?? { version: 1, canvasWidth: 400, canvasHeight: 711, elements: [] };
    this.mainLayer = requireLayer("custom-ui-layer");
    const endcardLayer = requireLayer("endcard-layer");
    this.ui = new UILayout(this.mainLayer, layerOrEmpty(data.mainLayout));
    this.endcardUI = new UILayout(endcardLayer, layerOrEmpty(data.endcardLayout));

    this.camera.perspective.add(this.audioListener);

    // Both input paths share one "first gesture" callback: a browser
    // AudioContext stays suspended, and every sound silently no-ops, until a
    // real user gesture — and a keyboard-only tester needs to satisfy that
    // too, or audio never starts for them.
    const onFirstInput = () => this.onFirstInput();
    this.input = new InputManager(window, onFirstInput);
    const joystickElements = this.ui.getJoystick("joystick");
    this.joystick = joystickElements
      ? new DynamicJoystick(this.mainLayer, joystickElements.base, joystickElements.knob, 45, onFirstInput)
      : undefined;

    this.debugLayer = getEditorHost()?.createDebugLayer();
    this.inspectables.set(options.bindingName ?? "Game", this);
    window.addEventListener("resize", this.onWindowResize);
    // three.js already prevents the default and re-initialises itself on
    // restore. What it does not do is tell anyone — so a phone that dropped
    // the context under memory pressure showed a frozen playable with nothing
    // in the console. These make it visible and let a game pause on it.
    options.canvas.addEventListener("webglcontextlost", this.onContextLost);
    options.canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.canvas = options.canvas;
  }

  /**
   * Finishes construction in the right order.
   *
   * Collider and particle data has to load *after* `onCreate`, because an
   * attachment is recorded as a scene path and can only resolve against a
   * graph that already contains the object. Scene bindings come after both
   * for the same reason. This ordering was the cause of several "the editor
   * forgot my collider" reports before it was pinned down here.
   */
  private finishCreate(data: IonProjectData): void {
    this.onCreate();
    // The scene exactly as the game built it, captured before anything
    // authored is applied. This is what a later save diffs against, and taking
    // it after the overrides would make every save write an empty file over
    // the user's work.
    this.sceneBaseline = snapshotScene(this.scene);
    this.sceneOverridesOnLoad = (data.scene as { objects?: { objectPath: string }[] } | undefined)?.objects ?? [];
    // Applied before colliders and particles: both attach by scene path and
    // read world matrices, so they have to see the final transforms.
    applySceneOverrides(this.scene, data.scene);
    // Passed straight through. Each loader takes `unknown` and validates what
    // it is given, so there is nothing to assert here and nothing to default:
    // a missing file is one of the shapes they already handle.
    loadColliders(Ion.colliders, data.colliders, this.scene);
    loadParticles(Ion.particles, data.particles, this.scene);
    for (const [className, instance] of this.inspectables) {
      applySceneBindings(instance, className, data.sceneBindings, this.scene);
    }
    this.onReady();
  }

  /**
   * Builds and returns a game of the calling subclass.
   *
   * `Game.create(canvas, { manifest, data })` from your own subclass — the
   * generic plumbing (asset preload, ordered construction) lives here so a
   * project's Game never reimplements it.
   */
  static async create<T extends IonGame>(
    this: new (options: IonGameOptions) => T,
    canvas: HTMLCanvasElement,
    options: Omit<IonGameOptions, "canvas"> = {}
  ): Promise<T> {
    const loader = options.assets ?? new AssetLoader();
    await loader.preload(options.manifest ?? []);
    // The warmed loader goes in through the constructor, not onto the instance
    // afterwards: everything the constructor builds — the scene environment
    // above all — resolves its textures through it while it runs.
    const full: IonGameOptions = { ...options, canvas, assets: loader };
    const game = new this(full);
    (game as unknown as { finishCreate(d: IonProjectData): void }).finishCreate(full.data ?? {});
    return game;
  }

  // ---------------------------------------------------------------- hooks --

  /** Build your scene here. Runs once, before collider/particle/binding data loads. */
  protected abstract onCreate(): void;

  /** One gameplay tick. `dt` is seconds; `elapsed` is game time, which pauses with the editor. */
  protected abstract onUpdate(dt: number, elapsed: number): void;

  /** Runs after all authored data has loaded and every binding is resolved. Read editor-assigned fields here, never in a constructor. */
  protected onReady(): void {}

  /**
   * Runs each frame *after* the camera rig has moved.
   *
   * Anything that adjusts the camera's own transform has to happen here rather
   * than in `onUpdate`, because the rig's follow lerp writes an absolute
   * position: an offset applied before it is simply overwritten and never
   * seen. Camera shake is the case that proved it — `ION.camera.shake()` did
   * nothing at all whenever the camera was following something, which is the
   * usual configuration.
   */
  protected onLateUpdate(_dt: number): void {}

  /** Release anything your game created. The engine's own resources are handled for you. */
  protected onDispose(): void {}

  /** The player's very first interaction. Unlocking audio hangs off this. */
  protected onFirstInput(): void {
    // three.js types AudioContext.getContext() loosely; the real object is a
    // WebAudio AudioContext, which is suspended until a user gesture.
    const context = THREE.AudioContext.getContext() as unknown as AudioContext;
    if (context.state === "suspended") void context.resume();
  }

  /** The point the camera rig follows while `follow` is on. Return undefined to leave the camera where the environment config put it. */
  protected getCameraFocus(): THREE.Vector3 | undefined {
    return undefined;
  }

  /** Register a gameplay object so Control Desk can edit its public fields and ⊙ Pick can assign scene objects onto it. */
  protected inspect(className: string, instance: object): void {
    this.inspectables.set(className, instance);
  }

  // -------------------------------------------------------------- engine --

  /** Called by IonEngine each frame. Do not override — implement `onUpdate`. */
  tick(dt: number, elapsed: number): void {
    this.onUpdate(dt, elapsed);
    const focus = this.getCameraFocus();
    if (focus) this.camera.update(focus, dt);
    this.onLateUpdate(dt);
  }

  /** Called by IonEngine each frame. Do not override. */
  render(): void {
    const activeCamera = this.editorSession?.camera ?? this.camera.camera;
    this.editorSession?.update();
    // After the editor (which is what syncs colliders while gameplay is
    // paused) and before the draw, so the wireframes show this frame's
    // positions. A no-op while nothing is showing.
    this.debugLayer?.update();
    Ion.particles.setCamera(activeCamera);
    Ion.particles.render();
    this.renderer.render(this.scene, activeCamera);
    this.editorSession?.afterRender(activeCamera);
  }

  /**
   * Retires the game and everything it allocated, including on the GPU.
   *
   * Called on every dev in-place reload as well as at real teardown, so a step
   * missing here is a leak that compounds once per save. The ordering is
   * deliberate: subclass teardown runs while the scene is still intact, the
   * scene is released next, and the renderer last — releasing the renderer
   * first would leave the scene's own disposals with no context to free
   * against.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("resize", this.onWindowResize);
    this.editorSession?.dispose();
    this.editorSession = undefined;
    this.debugLayer?.dispose();
    this.input.dispose();
    this.joystick?.dispose();
    this.onDispose();
    this.ui.dispose();
    this.endcardUI.dispose();
    this.environment.dispose();
    // Detached before the scene walk so the WebAudio graph doesn't stay
    // parented to a camera that is about to be dropped.
    this.audioListener.removeFromParent();
    // Every geometry, material and texture the game built, then the manifest
    // the loader uploaded. Neither is released by renderer.dispose(), which
    // only knows about its own programs and render targets.
    disposeScene(this.scene);
    this.assets.dispose();
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    // The renderer itself is deliberately *not* disposed: it is shared per
    // canvas and the next boot will reuse it (see acquireRenderer). What is
    // released here is everything that belonged to this game — the render
    // lists holding references to the scene just torn down, and any render
    // target still bound.
    this.renderer.setRenderTarget(null);
    this.renderer.renderLists.dispose();
  }

  /** Guards against a second teardown — the dev reload path and an explicit call can both land. */
  private disposed = false;

  private readonly onWindowResize = (): void => {
    if (!this.manualSize) this.handleResize();
  };

  private readonly onContextLost = (): void => {
    console.warn("ION: the WebGL context was lost. Rendering is paused until the browser restores it.");
    Ion.emit("ion:context-lost", undefined);
  };

  private readonly onContextRestored = (): void => {
    console.info("ION: the WebGL context was restored.");
    // Everything three.js uploads is re-uploaded lazily on the next draw; the
    // scene environment's own render targets are the exception, so they are
    // rebuilt explicitly.
    this.environment.apply();
    Ion.emit("ion:context-restored", undefined);
  };

  private handleResize(): void {
    this.camera.handleResize(window.innerWidth, window.innerHeight);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.ui.updateScale(window.innerWidth, window.innerHeight);
    this.endcardUI.updateScale(window.innerWidth, window.innerHeight);
  }

  /** The dev device-frame simulator's letterbox sizing. Inert in production. */
  resizeTo(width: number, height: number): void {
    this.manualSize = true;
    this.lastManualWidth = width;
    this.lastManualHeight = height;
    if (this.editorSession) return; // the editor owns viewport sizing for its session
    this.camera.handleResize(width, height);
    this.renderer.setSize(width, height);
    this.ui.updateScale(width, height);
    this.endcardUI.updateScale(width, height);
  }

  get rendererStats(): { drawCalls: number; triangles: number } {
    return { drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles };
  }

  getInspectable(className: string): object | undefined {
    return this.inspectables.get(className);
  }

  /**
   * Opens or closes the 3D editor.
   *
   * The editor is reached through `editor-host`'s registration hook rather
   * than an import, so this file — and therefore the whole runtime package —
   * never names an editor module. A production build has nothing registered,
   * so this is a no-op there regardless of who calls it.
   */
  setFreecam(active: boolean): void {
    if (active === !!this.editorSession) return;
    if (active) {
      const host = getEditorHost();
      if (!host) return;
      this.mainLayer.style.display = "none";
      this.input.setEnabled(false);
      this.editorSession = host.open({
        scene: this.scene,
        renderer: this.renderer,
        getGameplayCamera: () => this.camera.camera,
        environment: this.environment,
        sceneBaseline: this.sceneBaseline,
        sceneOverridesOnLoad: this.sceneOverridesOnLoad,
        initialTarget: this.getCameraFocus(),
        resolveTexture: (p) => {
          try {
            return this.assets.getTexture(p);
          } catch {
            return undefined;
          }
        },
      });
      if (!this.editorSession) this.mainLayer.style.display = "";
    } else {
      this.editorSession?.dispose();
      this.editorSession = undefined;
      this.mainLayer.style.display = "";
      this.input.setEnabled(true);
      if (this.manualSize) this.resizeTo(this.lastManualWidth, this.lastManualHeight);
      else this.handleResize();
    }
  }

  /** The open editor session, or undefined. Escape hatch for tooling; gameplay should not need it. */
  get editor(): EditorSession | undefined {
    return this.editorSession;
  }

  /** IonEngine's own `endcardUI` getter reads this name. */
  get endcardUILayout(): UILayout {
    return this.endcardUI;
  }

  // -----------------------------------------------------------------------
  // Dev-panel surface.
  //
  // Every one of these forwards to the open editor session and no-ops without
  // one, which is what lets the Engine Room drive a project whose own Game
  // class contains nothing but gameplay. They live in this package precisely
  // so they never appear in client code — before this class existed, a
  // project's Game.ts had to declare all of them by hand.
  // -----------------------------------------------------------------------

  setGizmoMode(mode: string): void { this.editorSession?.setGizmoMode(mode); }
  onGizmoModeChange(cb: (mode: string) => void): void { this.editorSession?.onGizmoModeChange(cb); }
  onInspectorStateChange(cb: (state: { grid: boolean; helpers: boolean; snap: boolean; space: string }) => void): void { this.editorSession?.onInspectorStateChange(cb); }
  toggleGrid(): boolean | undefined { return this.editorSession?.toggleGrid(); }
  toggleHelpers(): boolean | undefined { return this.editorSession?.toggleHelpers(); }
  toggleSnap(): boolean | undefined { return this.editorSession?.toggleSnap(); }
  toggleSpace(): string | undefined { return this.editorSession?.toggleSpace(); }
  frameSelected(): void { this.editorSession?.frameSelected(); }
  setColliderMode(active: boolean): boolean | undefined { return this.editorSession?.setColliderMode(active); }
  createCollider(shape: string): void { this.editorSession?.createCollider(shape); }
  deleteSelectedCollider(): boolean { return this.editorSession?.deleteSelectedCollider() ?? false; }
  toggleColliderVisible(): boolean | undefined { return this.editorSession?.toggleColliderVisible(); }
  serializeColliders(): unknown[] | undefined { return this.editorSession?.serializeColliders(); }
  hasColliderChanges(): boolean { return this.editorSession?.hasColliderChanges() ?? false; }
  markCollidersSaved(): void { this.editorSession?.markCollidersSaved(); }
  onColliderDirty(cb: () => void): void { this.editorSession?.onColliderDirty(cb); }
  setColliderDebug(visible: boolean): boolean | undefined { return this.debugLayer?.setVisible(visible); }
  toggleColliderDebug(): boolean | undefined { return this.debugLayer?.toggle(); }
  getColliderStats(): { total: number; enabled: number; narrowTests: number; activePairs: number } | undefined { return this.editorSession?.getColliderStats(); }
  setParticleMode(active: boolean): boolean | undefined { return this.editorSession?.setParticleMode(active); }
  createParticleSystem(presetKey?: string): void { this.editorSession?.createParticleSystem(presetKey); }
  addParticleEmitter(): void { this.editorSession?.addParticleEmitter(); }
  deleteSelectedEmitter(): boolean { return this.editorSession?.deleteSelectedEmitter() ?? false; }
  duplicateSelectedEmitter(): boolean { return this.editorSession?.duplicateSelectedEmitter() ?? false; }
  particlePlay(): void { this.editorSession?.particlePlay(); }
  particlePause(): void { this.editorSession?.particlePause(); }
  particleStop(): void { this.editorSession?.particleStop(); }
  particleRestart(): void { this.editorSession?.particleRestart(); }
  particleClear(): void { this.editorSession?.particleClear(); }
  isParticlePreviewPlaying(): boolean { return this.editorSession?.isParticlePreviewPlaying() ?? false; }
  toggleParticleGizmo(kind: string): boolean | undefined { return this.editorSession?.toggleParticleGizmo(kind); }
  getParticlePresets(): { key: string; label: string; description: string }[] { return this.editorSession?.getParticlePresets() ?? []; }
  setParticleQuality(quality: string): void { this.editorSession?.setParticleQuality(quality); }
  serializeParticles(): unknown[] | undefined { return this.editorSession?.serializeParticles(); }
  hasParticleChanges(): boolean { return this.editorSession?.hasParticleChanges() ?? false; }
  markParticlesSaved(): void { this.editorSession?.markParticlesSaved(); }
  onParticleDirty(cb: () => void): void { this.editorSession?.onParticleDirty(cb); }
  getParticleStats(): unknown | undefined { return this.editorSession?.getParticleStats(); }
  serializeEnvironment(): unknown | undefined { return this.editorSession?.serializeEnvironment(); }
  hasEnvironmentChanges(): boolean { return this.editorSession?.hasEnvironmentChanges() ?? false; }
  markEnvironmentSaved(): void { this.editorSession?.markEnvironmentSaved(); }
  onEnvironmentDirty(cb: () => void): void { this.editorSession?.onEnvironmentDirty(cb); }
  serializeScene(): unknown[] | undefined { return this.editorSession?.serializeScene(); }
  hasSceneChanges(): boolean { return this.editorSession?.hasSceneChanges() ?? false; }
  markSceneSaved(): void { this.editorSession?.markSceneSaved(); }
  onSceneDirty(cb: () => void): void { this.editorSession?.onSceneDirty(cb); }
  editorUndo(): boolean { return this.editorSession?.editorUndo() ?? false; }
  editorRedo(): boolean { return this.editorSession?.editorRedo() ?? false; }
  getEditorHistory(): unknown | undefined { return this.editorSession?.getEditorHistory(); }
  onEditorHistoryChange(cb: () => void): void { this.editorSession?.onEditorHistoryChange(cb); }
  getEditorViewportInfo(): unknown | undefined { return this.editorSession?.getEditorViewportInfo(); }
  requestObjectPick(declaredType: string | undefined, callbacks: unknown): boolean { return this.editorSession?.requestObjectPick(declaredType, callbacks) ?? false; }
  cancelObjectPick(): void { this.editorSession?.cancelObjectPick(); }
  editorDragAssign(declaredType: string | undefined, commit: boolean, uuid?: string): unknown | undefined { return this.editorSession?.editorDragAssign(declaredType, commit, uuid); }
  editorAssignmentFor(declaredType: string | undefined, object: unknown): unknown | undefined { return this.editorSession?.editorAssignmentFor(declaredType, object); }
}
