import * as THREE from "three";
import { CameraHandler } from "../../../src/engine/core/CameraHandler";
import { SceneEnvironment, loadSceneEnv } from "../../../src/engine/scene";
import type { SceneEnvData } from "../../../src/engine/scene";
import { AssetLoader } from "../../../src/engine/AssetLoader";
import type { AssetEntry } from "../../../src/engine/AssetLoader";
import { UILayout } from "../../../src/engine/ui/UILayout";
import type { UILayoutData } from "../../../src/engine/ui/UILayoutTypes";
import { Ion } from "../../../src/engine/Ion";
import { loadColliders } from "../../../src/engine/collision";
import type { CollidersFileData } from "../../../src/engine/collision";
import { loadParticles } from "../../../src/engine/particles";
import type { ParticlesFileData } from "../../../src/engine/particles";
import { applySceneBindings, type SceneBindingsData } from "../../../src/engine/SceneBindings";
import { getEditorHost, type DebugLayer, type EditorSession } from "./editor-host";
import { InputManager } from "../../../src/engine/core/InputManager";
import { DynamicJoystick } from "../../../src/engine/core/DynamicJoystick";

/** The authored data files a project ships. All optional — a missing one just means that system has nothing to load. */
export interface IonProjectData {
  environment?: unknown;
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
  private manualSize = false;
  private lastManualWidth = 0;
  private lastManualHeight = 0;
  /** Class-name → instance, for Control Desk. Subclasses add to it via `inspect()`. */
  private readonly inspectables = new Map<string, object>();

  /**
   * Public because `IonGame.create()` constructs `new this(options)` and
   * TypeScript will not accept a protected constructor there. Call `create()`
   * rather than this directly — it preloads assets and runs the ordered
   * setup that collider, particle and binding data depend on.
   */
  constructor(options: IonGameOptions) {
    const data = options.data ?? {};
    const environmentData: SceneEnvData = loadSceneEnv(data.environment);

    this.assets = new AssetLoader();
    this.camera = new CameraHandler(environmentData.camera);

    this.renderer = new THREE.WebGLRenderer({ canvas: options.canvas, antialias: true });
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
    this.mainLayer = document.getElementById("custom-ui-layer") as HTMLElement;
    const endcardLayer = document.getElementById("endcard-layer") as HTMLElement;
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
    loadColliders(Ion.colliders, (data.colliders as CollidersFileData) ?? { version: 1, colliders: [] }, this.scene);
    loadParticles(Ion.particles, (data.particles as ParticlesFileData) ?? { version: 1, systems: [] }, this.scene);
    for (const [className, instance] of this.inspectables) {
      applySceneBindings(instance, className, (data.sceneBindings as SceneBindingsData) ?? { version: 1, bindings: [] }, this.scene);
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
    const full: IonGameOptions = { ...options, canvas };
    const loader = new AssetLoader();
    await loader.preload(full.manifest ?? []);
    const game = new this(full);
    // The instance built its own loader; hand it the warmed cache rather than
    // loading everything a second time.
    (game as unknown as { assets: AssetLoader }).assets = loader;
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

  dispose(): void {
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
    this.renderer.dispose();
  }

  private readonly onWindowResize = (): void => {
    if (!this.manualSize) this.handleResize();
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
