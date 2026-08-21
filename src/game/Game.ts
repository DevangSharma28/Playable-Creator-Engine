import * as THREE from "three";
import { DynamicJoystick } from "../engine/core/DynamicJoystick";
import { InputManager } from "../engine/core/InputManager";
import { CameraHandler } from "../engine/core/CameraHandler";
import { ViewHelperWidget } from "../engine/core/ViewHelperWidget";
import type { GizmoMode, InspectorToolState } from "../engine/core/SceneInspector";
import { EditorRoot, type FieldPickCallbacks } from "../engine/editor/EditorRoot";
import { World } from "./world/World";
import { Player } from "./entities/Player";
import { CoinField } from "./entities/CoinField";
import { HUD } from "./ui/HUD";
import { UILayout } from "../engine/ui/UILayout";
import type { UILayoutData } from "../engine/ui/UILayoutTypes";
import mainLayoutRaw from "./ui/mainLayout.json";
import endcardLayoutRaw from "./ui/endcardLayout.json";
import { AssetLoader } from "../engine/AssetLoader";
import { MraidAdapter } from "../engine/MraidAdapter";
import { MindworksAdapter } from "../engine/MindworksAdapter";
import { Cta } from "../engine/Cta";
import { setCrashRecoveryUrl } from "../engine/core/CrashOverlay";
import { applySceneBindings, type SceneBindingsData } from "../engine/SceneBindings";
import sceneBindingsRaw from "./sceneBindings.json";
import { SoundHandler } from "./SoundHandler";
import { manifest, libGlb, libAudio } from "./assets";

const mainLayoutData = mainLayoutRaw as UILayoutData;
const endcardLayoutData = endcardLayoutRaw as UILayoutData;

const COIN_COUNT = 6;
const AUTO_END_MS = 15000;
const CAMERA_OFFSET = new THREE.Vector3(0, 12, 12);
/** Real store listing / click-through URL — swap this for the actual app before a network build. Every CTA (HUD button, endcard) routes through Cta.open(), which picks the right network API automatically and falls back to a new tab in a plain browser (this dev preview included). Only consulted on the paths that actually take a URL — network-owned handlers redirect to the listing the network itself has configured; see src/engine/Cta.ts. */
const STORE_URL = "https://devangsharma28.github.io/portfolio/";
// Same URL the CTA buttons use, registered once at module load so
// IonEngine's crash-recovery overlay's own CTA still works if gameplay
// ever throws mid-frame — see CrashOverlay.ts's own doc comment for why
// this is self-registered rather than threaded through IonEngine.boot().
setCrashRecoveryUrl(STORE_URL);

export class Game {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;

  private readonly world: World;
  private readonly player: Player;
  private readonly coinField: CoinField;
  private readonly input: DynamicJoystick;
  /** Keyboard (WASD/arrows) fallback for the joystick's own movement axis — desktop dev-preview testing without a touchscreen. See update()'s combineAxes. */
  private readonly keyboardInput: InputManager;
  private readonly cameraHandler: CameraHandler;
  private readonly hud: HUD;
  private readonly soundHandler: SoundHandler;
  private readonly mainUI: UILayout;
  private readonly endcardUI: UILayout;
  private readonly assetLoader: AssetLoader;
  /** Only exists when #er-viewhelper is in the page (the dev-only Engine Room panel) — undefined, and never rendered into, in production. */
  private readonly viewHelper: ViewHelperWidget | undefined;
  private readonly mainLayer: HTMLElement;
  /**
   * The whole dev 3D Viewer/Editor (camera, orbit controls, selection,
   * hierarchy, inspector, gizmo, picker, viewport sizing), or undefined
   * when it isn't open — which is always, in production: nothing in the
   * shipped build ever calls setFreecam(), and the construction below is
   * additionally gated on import.meta.env.DEV so the whole editor tree is
   * dead code the production bundle can drop.
   */
  private editor: EditorRoot | undefined;
  /** Set via onGizmoModeChange(); re-attached to each new EditorRoot since one is (re)created per editor session — see setFreecam(). */
  private gizmoModeChangeCallback: ((mode: GizmoMode) => void) | undefined;
  /** Same reasoning as gizmoModeChangeCallback, for grid/helpers/snap/space instead of gizmo mode — see onInspectorStateChange(). */
  private inspectorStateChangeCallback: ((state: InspectorToolState) => void) | undefined;

  private collected = 0;
  private ended = false;
  /** Wall-clock-free playtime accumulator driving the 15s auto-endcard — only advances inside update(), so it (like everything else in update()) naturally stops while the UI editor or freecam is open instead of firing behind them on real elapsed time. */
  private playTimeMs = 0;
  /** The most recent explicit size passed to resizeTo() — replayed by applyCurrentSize() when the editor closes and hands sizing back to the game. */
  private lastManualWidth = 0;
  private lastManualHeight = 0;
  /** True once something has called resizeTo() explicitly (the dev-only device-frame simulator) — while true, the window's own resize event no longer drives sizing, so the simulator stays in control until it hands back (by calling resizeTo() with the real window size again). Production never sets this; the window listener below is the only thing that ever runs there. */
  private manualSize = false;

  /** Dev-only: class-name -> live instance lookup for the Engine Room's Control Desk panel (see IonEngine.installDevHooks' __getInspectable hook). Explicit, hand-picked entries — same reasoning as Bindings.ts's explicit field wiring, not a reflective registry that auto-discovers every object the game happens to construct. */
  private readonly inspectables: Map<string, object>;

  private constructor(canvas: HTMLCanvasElement, model: THREE.Group, clips: THREE.AnimationClip[], sceneModel: THREE.Group, musicBuffer: AudioBuffer) {
    this.assetLoader = new AssetLoader();

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 1000);
    this.camera.lookAt(0, 0, 0);
    this.soundHandler = new SoundHandler(this.camera, musicBuffer);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.world = new World(this.scene);

    // Cinema_World.glb — a designed environment dropped in alongside World's
    // procedural ground/walls (not replacing them; World.bound below still
    // drives gameplay's play-area clamp regardless of what this model looks
    // like). Shadow flags aren't baked into the GLB export, so set them the
    // same way Player does for its own mesh.
    sceneModel.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    this.scene.add(sceneModel);

    this.player = new Player(this.scene, this.world.bound, model, clips);
    this.coinField = new CoinField(this.scene, COIN_COUNT, this.world.bound);
    this.inspectables = new Map<string, object>([
      ["Game", this],
      ["World", this.world],
      ["Player", this.player],
      ["CoinField", this.coinField],
      ["SoundHandler", this.soundHandler],
    ]);

    // Persisted "⊙ Pick" assignments from the 3D Viewer/Editor's Control
    // Desk — a field like Player's `popcornMachine!: THREE.Object3D` gets
    // the real scene object written onto it here. Applied over the whole
    // inspectables map rather than class by class, so registering a class
    // above is the only step needed for its scene fields to persist; and
    // applied *after* this.scene.add(sceneModel) above, since a binding can
    // only resolve against objects already in the graph. This is the
    // counterpart of applyBindings() for UI elements, and it ships: the
    // JSON is a real import, so the assignment holds in the production
    // build exactly as it does in the editor.
    for (const [className, instance] of this.inspectables) {
      applySceneBindings(instance, className, sceneBindingsRaw as SceneBindingsData, this.scene);
    }

    this.mainLayer = document.getElementById("custom-ui-layer") as HTMLElement;
    const endcardLayer = document.getElementById("endcard-layer") as HTMLElement;
    this.mainUI = new UILayout(this.mainLayer, mainLayoutData);
    this.endcardUI = new UILayout(endcardLayer, endcardLayoutData);

    let wa = this.scene.getObjectByName("walkablearea") as THREE.Object3D
    (this.scene.getObjectByName("cinemafloor") as THREE.Mesh).visible = false;
    (this.scene.getObjectByName("Colliders") as THREE.Object3D).visible = false;
    wa.visible = false
    // HUD wires up its own editor-assigned fields (e.g. moneyIcon) in its
    // own constructor — see src/game/ui/HUD.ts and src/engine/Bindings.ts.
    this.hud = new HUD(this.mainUI, this.endcardUI);
    this.hud.setScore(0, this.coinField.total);
    // Every CTA routes through this one call — never window.open()/alert()
    // directly. Which network API actually handles the click (Mindworks'
    // install(), Meta's FbPlayableAd, Google's ExitApi, ironSource's DAPI,
    // MRAID, or a plain new tab in this dev preview) is entirely Cta's
    // problem; see src/engine/Cta.ts for the ordering and why exactly one
    // handler may ever run.
    this.hud.onCtaClick(() => Cta.open(STORE_URL));
    this.hud.onInGameCtaClick(() => Cta.open(STORE_URL));

    // The joystick is a real, editable layout element (type: "joystick",
    // named "joystick") — not hardcoded HTML — so DynamicJoystick reuses
    // whatever base/knob tools/ui-editor.html placed (color, size) for its
    // visuals, it just controls *where*/*when* they appear itself instead
    // of leaving them pinned at their designed spot. It has to exist:
    // there's no fallback control scheme, so fail loudly rather than ship
    // a game nothing can move.
    const joystick = this.mainUI.getJoystick("joystick");
    if (!joystick) {
      throw new Error('Game: mainLayout.json is missing a "joystick" element — add one in the UI editor (Properties panel names it "joystick" by default) and Set Active.');
    }
    // First real user gesture in the whole playable — also what unlocks
    // audio (see SoundHandler's own doc comment: a browser AudioContext
    // stays suspended, and .play() silently no-ops, until one of these).
    this.input = new DynamicJoystick(this.mainLayer, joystick.base, joystick.knob, 45, () => {
      this.hud.hideDragHint();
      this.soundHandler.playMusic();
    });
    // Same first-input unlock as the joystick above (see its own comment) —
    // a keyboard-only desktop tester needs it too, or music never starts for them.
    this.keyboardInput = new InputManager(window, () => {
      this.hud.hideDragHint();
      this.soundHandler.playMusic();
    });

    this.cameraHandler = new CameraHandler(this.camera, CAMERA_OFFSET);

    // import.meta.env.DEV first, so the whole ViewHelperWidget module (and
    // the second WebGLRenderer it owns) is statically unreachable in a
    // production build and drops out of the bundle entirely, rather than
    // shipping as dead weight guarded only by a DOM lookup that never
    // finds anything.
    const viewHelperCanvas = import.meta.env.DEV ? (document.getElementById("er-viewhelper") as HTMLCanvasElement | null) : null;
    this.viewHelper = viewHelperCanvas ? new ViewHelperWidget(viewHelperCanvas) : undefined;

    window.addEventListener("resize", this.onWindowResize);

    // Some ad-network WebViews (Mintegral's Mindworks among them) can
    // still be mid-layout — sometimes literally reporting 0×0 — the
    // instant this constructor runs, and aren't guaranteed to ever fire a
    // native `resize` event once they settle; they signal through MRAID's
    // own ready/sizeChange events instead. Without this, a renderer sized
    // once here from window.innerWidth/innerHeight and never revisited
    // can stay wrong (in the 0×0 case, invisible) for the whole session —
    // see MraidAdapter.onReady's own doc comment.
    MraidAdapter.onReady(() => {
      if (!this.manualSize) this.handleResize();
    });
    MraidAdapter.onSizeChange(() => {
      if (!this.manualSize) this.handleResize();
    });

    // Mindworks calls these *into* the playable itself (see
    // MindworksAdapter.exposeLifecycleHooks' own doc comment) — real
    // no-op functions for now since this game has no countdown/music
    // system yet to hook them up to; wire real behavior in here once it
    // does, rather than leaving window.gameStart/gameClose undefined
    // (the review tool checks they exist as callable functions).
    MindworksAdapter.exposeLifecycleHooks(
      () => { },
      () => { }
    );
  }

  /** Stored so dispose() can remove exactly this listener — an inline arrow passed straight to addEventListener can never be removed later. */
  private readonly onWindowResize = (): void => {
    if (!this.manualSize) this.handleResize();
  };

  static async create(canvas: HTMLCanvasElement): Promise<Game> {
    const loader = new AssetLoader();
    await loader.preload(manifest);
    const path = libGlb.player;
    const model = loader.getGlb(path).scene;
    const clips = loader.getAnimations(path);
    const sceneModel = loader.getGlb(libGlb.sceneGLB).scene;
    const musicBuffer = loader.getAudio(libAudio.MainMusic);

    const game = new Game(canvas, model, clips, sceneModel, musicBuffer);
    // Every asset is loaded and the game is fully constructed — Mindworks'
    // own loading overlay waits for this before it'll consider the
    // playable loaded at all (see MindworksAdapter.gameReady's own doc
    // comment); a no-op everywhere else.
    MindworksAdapter.gameReady();

    return game;
  }

  /** Access designed sprites/text from mainLayout.json by the name given in tools/ui-editor.html. */
  get ui(): UILayout {
    return this.mainUI;
  }

  /** Access designed sprites/text from endcardLayout.json by the name given in tools/ui-editor.html. */
  get endcardUILayout(): UILayout {
    return this.endcardUI;
  }

  /**
   * Dev-only: sizes the renderer/camera to an explicit box instead of the
   * real window — how the device-frame simulator (see index.html)
   * previews a fixed aspect ratio letterboxed within your actual browser
   * window. Takes over from the window's own resize event until called
   * again; passing the real window size hands control back to "real" mode.
   */
  resizeTo(width: number, height: number): void {
    this.manualSize = true;
    this.lastManualWidth = width;
    this.lastManualHeight = height;
    // While the editor is open it owns the renderer size and its own
    // camera's projection, measured from the real viewport container (see
    // EditorViewport). Letting the device-frame path also write the
    // renderer size and the *gameplay* camera's aspect here would put the
    // game's logical/design resolution and the editor's viewport
    // resolution back into the same variable — exactly the coupling that
    // made the scene render stretched when the editor opened over a
    // Portrait or Landscape preview. The values are still recorded above,
    // so exiting the editor restores this size correctly.
    if (this.editor) return;
    this.cameraHandler.handleResize(width, height);
    this.renderer.setSize(width, height);
    // The explicit target size, not a DOM re-measure — see
    // UILayout.updateScale's own doc comment for why that matters here
    // specifically: #device-frame (this method's caller, the dev
    // device-frame simulator) animates its own resize over a CSS
    // transition, so reading its box synchronously right after setting a
    // new size would catch it mid-transition.
    this.mainUI.updateScale(width, height);
    this.endcardUI.updateScale(width, height);
    // The joystick lives outside mainUI's own DOM subtree by the time
    // anyone could resize (see DynamicJoystick's constructor/syncSize()
    // doc comments) — updateScale() above doesn't reach it.
    this.input.syncSize();
  }

  /**
   * Dev-only: Engine Room "3D Viewer/Editor" button — opens the editor
   * over the *live* gameplay scene (no separate renderer, scene, or
   * canvas), so what you inspect is exactly what's currently running.
   * IonEngine pauses gameplay update() while this is active (same
   * mechanism as the UI editor pause), so the player and the gameplay
   * camera don't fight the orbit controls underneath you.
   *
   * This method owns only the session boundary — everything inside is
   * EditorRoot's (see src/engine/editor/). The whole construction is
   * behind import.meta.env.DEV so a production build, where this method is
   * never called anyway, can additionally drop the entire editor module
   * tree as dead code rather than shipping it unused.
   */
  setFreecam(active: boolean): void {
    if (active === !!this.editor) return;

    if (active) {
      if (!import.meta.env.DEV) return;
      const hierarchyEl = document.getElementById("si-hierarchy");
      const inspectorEl = document.getElementById("si-inspector");
      if (!hierarchyEl || !inspectorEl) return;

      // The canvas's own container is what the editor measures for
      // viewport size — never the window, which doesn't account for the
      // editor's side panels. Falls back to the canvas itself if the dev
      // page's #device-frame wrapper isn't there for some reason.
      const viewportContainer = document.getElementById("device-frame") ?? this.renderer.domElement.parentElement ?? this.renderer.domElement;

      this.mainLayer.style.display = "none"; // HUD/joystick would otherwise sit on top of the canvas and steal drag gestures from the orbit controls
      // The editor owns the keyboard for its session: its W/E/R/Q gizmo
      // shortcuts collide with this fallback's WASD, and both listen on
      // `window` where event propagation can't separate them (see
      // InputManager.setEnabled).
      this.keyboardInput.setEnabled(false);

      this.editor = new EditorRoot({
        scene: this.scene,
        gameplayCamera: this.camera,
        renderer: this.renderer,
        viewportContainer: viewportContainer as HTMLElement,
        hierarchyEl,
        inspectorEl,
        initialTarget: this.player.position,
      });
      // A fresh EditorRoot is created each session, so re-wire any
      // previously-registered listener rather than relying on it surviving
      // from a prior one.
      if (this.gizmoModeChangeCallback) this.editor.addModeChangeListener(this.gizmoModeChangeCallback);
      if (this.inspectorStateChangeCallback) this.editor.addStateChangeListener(this.inspectorStateChangeCallback);
    } else {
      this.editor?.dispose();
      this.editor = undefined;
      this.mainLayer.style.display = "";
      this.keyboardInput.setEnabled(true);
      // Hand the renderer and the gameplay camera back to the game's own
      // sizing. The editor sized both to its panel-bounded viewport; the
      // dev page re-applies the real device-frame box right after this
      // returns (see index.html's setFreecamUI -> applyDeviceFrameInstant),
      // but doing it here too means the state is already coherent for any
      // frame rendered in between.
      this.applyCurrentSize();
    }
  }

  /** Re-applies whichever sizing mode is currently in force — the explicit device-frame box, or the real window. */
  private applyCurrentSize(): void {
    if (this.manualSize) this.resizeTo(this.lastManualWidth, this.lastManualHeight);
    else this.handleResize();
  }

  /**
   * Dev-only: arms Control Desk's "Pick" for a script field of the given
   * declared TypeScript type. The next object clicked — in the Hierarchy
   * or directly in the 3D viewport, interchangeably — is type-checked
   * against that declaration and handed back. No-op unless the editor is
   * open, since there's nothing to click in otherwise.
   */
  requestObjectPick(declaredType: string | undefined, callbacks: FieldPickCallbacks): boolean {
    if (!this.editor) return false;
    this.editor.requestObjectPick(declaredType, callbacks);
    return true;
  }

  cancelObjectPick(): void {
    this.editor?.cancelObjectPick();
  }

  /** Dev-only: validates (commit=false) or completes (commit=true) a Hierarchy row dropped onto a Control Desk object field — see EditorRoot.dragAssign. */
  editorDragAssign(declaredType: string | undefined, commit: boolean, uuid?: string): ReturnType<EditorRoot["dragAssign"]> | undefined {
    return this.editor?.dragAssign(declaredType, commit, uuid);
  }

  /** Dev-only: stable path for a picked scene object, so Control Desk can persist the assignment (see SceneBindings.ts). */
  editorObjectPath(object: THREE.Object3D): { objectPath: string; objectName: string } | undefined {
    return this.editor?.objectPath(object);
  }

  /** Dev-only: see EditorRoot.getViewportInfo — the readable form of the "never stretched" invariant. */
  getEditorViewportInfo(): ReturnType<EditorRoot["getViewportInfo"]> | undefined {
    return this.editor?.getViewportInfo();
  }

  /** Dev-only: Engine Room's Move/Rotate/Scale/Select toolbar — a thin passthrough; the gizmo lives inside the editor, which only exists while it's open. */
  setGizmoMode(mode: GizmoMode): void {
    this.editor?.setGizmoMode(mode);
  }

  /** Dev-only: lets the editor toolbar's gizmo-mode buttons stay in sync when the mode changes via keyboard shortcut (W/E/R/Q) instead of a button click. Call once, any time — stored and (re)attached to whichever EditorRoot is live, since a new one is created per session. */
  onGizmoModeChange(cb: (mode: GizmoMode) => void): void {
    this.gizmoModeChangeCallback = cb;
    this.editor?.addModeChangeListener(cb);
  }

  /** Dev-only: Engine Room's Grid/Helpers/Snap/Space toolbar — thin passthroughs, only meaningful while the editor is open. Each returns the new state so the caller (the toolbar button's click handler) can update its own active-highlight without a round trip through onInspectorStateChange. */
  toggleGrid(): boolean | undefined {
    return this.editor?.toggleGrid();
  }
  toggleHelpers(): boolean | undefined {
    return this.editor?.toggleHelpers();
  }
  toggleSnap(): boolean | undefined {
    return this.editor?.toggleSnap();
  }
  toggleSpace(): ("local" | "world") | undefined {
    return this.editor?.toggleSpace();
  }
  frameSelected(): void {
    this.editor?.frameSelected();
  }

  /** Same reasoning as onGizmoModeChange, for the toolbar toggles above — keeps the toolbar's active-highlight in sync when a toggle happens via keyboard shortcut (F/G/H/X/C) instead of a button click. */
  onInspectorStateChange(cb: (state: InspectorToolState) => void): void {
    this.inspectorStateChangeCallback = cb;
    this.editor?.addStateChangeListener(cb);
  }

  /** Dev-only: Engine Room Control Desk's class-name -> live instance lookup — see this.inspectables above and IonEngine's __getInspectable hook. */
  getInspectable(className: string): object | undefined {
    return this.inspectables.get(className);
  }

  /** Dev-only: Engine Room "Audio Reactor" panel — a thin passthrough since the analyser itself is lazily built inside SoundHandler and only ever touched from here. */
  getAudioAnalyser(): THREE.AudioAnalyser {
    return this.soundHandler.getAnalyser();
  }

  /** Dev-only: lets the Audio Reactor panel show Playing/Stopped without also needing __getAudioAnalyser to just answer that. */
  isMusicPlaying(): boolean {
    return this.soundHandler.isPlaying;
  }

  /** Joystick wins whenever it's actively held; keyboard only fills in while the joystick is neutral — so a touch drag can never fight a stale held key, and vice versa. Same {x,y} shape either way (see InputManager.ts's own doc comment on why keyboardAxis matches DynamicJoystick.axis's sign convention exactly), so Player.update needs no changes to accept either. */
  private combinedAxis(): { x: number; y: number } {
    const joy = this.input.axis;
    return joy.x !== 0 || joy.y !== 0 ? joy : this.keyboardInput.keyboardAxis;
  }

  /** Advance all systems by one frame. Call once per requestAnimationFrame tick. */
  update(dt: number, elapsed: number): void {
    if (!this.ended) {
      this.player.update(dt, elapsed, this.combinedAxis());

      this.playTimeMs += dt * 1000;
      if (this.playTimeMs >= AUTO_END_MS) {
        this.showEndCard(false);
      }
    }

    this.coinField.update(dt, elapsed, this.player.position, () => {
      this.collected++;
      this.hud.setScore(this.collected, this.coinField.total);
      if (this.collected >= this.coinField.total) {
        this.showEndCard(true);
      }
    });

    this.cameraHandler.update(this.player.position, dt);
    this.soundHandler.update(); // applies volume/muted — see SoundHandler.update's own doc comment for why this is a poll, not a setter
  }

  render(): void {
    const activeCamera = this.editor?.camera ?? this.camera;
    this.editor?.update();
    this.renderer.render(this.scene, activeCamera);
    this.viewHelper?.update(activeCamera);
  }

  /** Dev-only: live renderer counters for the Engine Room stats readout. Reading renderer.info.render is cheap (Three.js already tallies it every frame) — no separate tracking needed. */
  get rendererStats(): { drawCalls: number; triangles: number } {
    return { drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles };
  }

  /**
   * Dev-only: tears this instance down when a fresh bundle is about to
   * take over the same #game canvas in place (see main.ts's __disposeGame
   * hook) — the dev preview swaps in a newly-rebuilt bundle after every
   * source/layout save instead of doing a full page navigation, so the UI
   * editor overlay's own in-memory session (undo history, unsaved edits,
   * Connect state) survives a Save. Without this, every save would leak a
   * WebGL context (browsers cap how many a page can hold open at once) plus
   * a full set of window-level input listeners, since nothing else ever
   * releases the old instance once a new one starts rendering into the same
   * canvas. Never called in production — nothing there ever replaces the
   * bundle without a real navigation.
   */
  dispose(): void {
    window.removeEventListener("resize", this.onWindowResize);
    // Close the editor first, if it's open. Without this, disposing a Game
    // mid-editor-session (which is exactly what an in-place hot reload does
    // while the 3D Viewer/Editor is up) left the whole editor alive:
    // its window/canvas listeners stayed registered, its helpers stayed in
    // the discarded scene, and its DOM stayed in the hierarchy/inspector
    // panels — so clicks in those panels drove a scene nothing was
    // rendering any more, and every reload stacked another one.
    this.setFreecam(false);
    // Owns a second WebGLRenderer (its own tiny canvas/context). Browsers
    // cap live WebGL contexts, so leaking one per hot reload eventually
    // starts force-losing them.
    this.viewHelper?.dispose();
    this.input.dispose();
    this.keyboardInput.dispose();
    this.soundHandler.dispose();
    this.renderer.dispose();
  }

  private showEndCard(won: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.hud.showEndCard(won);
    MindworksAdapter.gameEnd();
  }

  private handleResize(): void {
    this.cameraHandler.handleResize(window.innerWidth, window.innerHeight);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.mainUI.updateScale(window.innerWidth, window.innerHeight);
    this.endcardUI.updateScale(window.innerWidth, window.innerHeight);
    // See resizeTo()'s matching call for why this is needed here too.
    this.input.syncSize();
  }
}
