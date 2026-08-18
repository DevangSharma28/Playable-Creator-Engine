import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DynamicJoystick } from "../engine/core/DynamicJoystick";
import { CameraHandler } from "../engine/core/CameraHandler";
import { ViewHelperWidget } from "../engine/core/ViewHelperWidget";
import { SceneInspector, type GizmoMode, type InspectorToolState } from "../engine/core/SceneInspector";
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
import { manifest, libGlb } from "./assets";

const mainLayoutData = mainLayoutRaw as UILayoutData;
const endcardLayoutData = endcardLayoutRaw as UILayoutData;

const COIN_COUNT = 6;
const AUTO_END_MS = 15000;
const CAMERA_OFFSET = new THREE.Vector3(0, 7.5, 7.5);
/** Real store listing / click-through URL — swap this for the actual app before a network build. Every CTA (HUD button, endcard) routes through MraidAdapter.openStoreUrl, which uses mraid.open() inside a real ad network host and falls back to a new tab everywhere else (this dev preview included). */
const STORE_URL = "https://devangsharma28.github.io/portfolio/";

export class Game {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;

  private readonly world: World;
  private readonly player: Player;
  private readonly coinField: CoinField;
  private readonly input: DynamicJoystick;
  private readonly cameraHandler: CameraHandler;
  private readonly hud: HUD;
  private readonly mainUI: UILayout;
  private readonly endcardUI: UILayout;
  private readonly assetLoader: AssetLoader;
  /** Only exists when #er-viewhelper is in the page (the dev-only Engine Room panel) — undefined, and never rendered into, in production. */
  private readonly viewHelper: ViewHelperWidget | undefined;
  private readonly mainLayer: HTMLElement;
  /** Only set while the dev-only Engine Room "3D View" freecam is active; undefined otherwise (including always in production, nothing there ever calls setFreecam()). */
  private orbitControls: OrbitControls | undefined;
  /** The camera freecam actually renders/orbits through — kept separate from this.camera so the CameraHelper gizmo (drawn by SceneInspector) shows a meaningful frustum for the real gameplay camera instead of coinciding with the view you're looking through. */
  private freecamCamera: THREE.PerspectiveCamera | undefined;
  private sceneInspector: SceneInspector | undefined;
  /** Set via onGizmoModeChange(); re-attached to each new SceneInspector instance since one is (re)created per freecam session — see setFreecam(). */
  private gizmoModeChangeCallback: ((mode: GizmoMode) => void) | undefined;
  /** Same reasoning as gizmoModeChangeCallback, for grid/helpers/snap/space instead of gizmo mode — see onInspectorStateChange(). */
  private inspectorStateChangeCallback: ((state: InspectorToolState) => void) | undefined;

  private collected = 0;
  private ended = false;
  /** Wall-clock-free playtime accumulator driving the 15s auto-endcard — only advances inside update(), so it (like everything else in update()) naturally stops while the UI editor or freecam is open instead of firing behind them on real elapsed time. */
  private playTimeMs = 0;
  /** True once something has called resizeTo() explicitly (the dev-only device-frame simulator) — while true, the window's own resize event no longer drives sizing, so the simulator stays in control until it hands back (by calling resizeTo() with the real window size again). Production never sets this; the window listener below is the only thing that ever runs there. */
  private manualSize = false;

  /** Dev-only: class-name -> live instance lookup for the Engine Room's Control Desk panel (see IonEngine.installDevHooks' __getInspectable hook). Explicit, hand-picked entries — same reasoning as Bindings.ts's explicit field wiring, not a reflective registry that auto-discovers every object the game happens to construct. */
  private readonly inspectables: Map<string, object>;

  private constructor(canvas: HTMLCanvasElement, model: THREE.Group, clips: THREE.AnimationClip[]) {
    this.assetLoader = new AssetLoader();

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.world = new World(this.scene);
    this.player = new Player(this.scene, this.world.bound, model, clips);
    this.coinField = new CoinField(this.scene, COIN_COUNT, this.world.bound);
    this.inspectables = new Map<string, object>([
      ["Game", this],
      ["World", this.world],
      ["Player", this.player],
      ["CoinField", this.coinField],
    ]);

    this.mainLayer = document.getElementById("custom-ui-layer") as HTMLElement;
    const endcardLayer = document.getElementById("endcard-layer") as HTMLElement;
    this.mainUI = new UILayout(this.mainLayer, mainLayoutData);
    this.endcardUI = new UILayout(endcardLayer, endcardLayoutData);

    // HUD wires up its own editor-assigned fields (e.g. moneyIcon) in its
    // own constructor — see src/game/ui/HUD.ts and src/engine/Bindings.ts.
    this.hud = new HUD(this.mainUI, this.endcardUI);
    this.hud.setScore(0, this.coinField.total);
    // Not window.open()/alert() — most ad-network WebViews (Mintegral's
    // Mindworks included) block or silently swallow plain navigation, and
    // alert() specifically can no-op or hang the JS thread depending on
    // the host's WebView build. Mindworks' own review doc is explicit
    // that a playable must never redirect on its own when its interface
    // is present — window.install() must be the *only* thing a CTA click
    // does then — so that branch is checked first and taken exclusively;
    // MraidAdapter (real MRAID host, or a plain new-tab open in this dev
    // preview) is only the fallback for hosts that don't define it.
    this.hud.onCtaClick(() => {
      if (MindworksAdapter.isPresent) {
        MindworksAdapter.install();
      } else {
        MraidAdapter.openStoreUrl(STORE_URL);
      }
    });

    this.hud.onInGameCtaClick(() => {
      if (MindworksAdapter.isPresent) {
        MindworksAdapter.install();
      } else {
        MraidAdapter.openStoreUrl(STORE_URL);
      }
    })

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
    this.input = new DynamicJoystick(this.mainLayer, joystick.base, joystick.knob, 45, () => this.hud.hideDragHint());

    this.cameraHandler = new CameraHandler(this.camera, CAMERA_OFFSET);

    const viewHelperCanvas = document.getElementById("er-viewhelper") as HTMLCanvasElement | null;
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

    const game = new Game(canvas, model, clips);
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
   * Dev-only: Engine Room "3D View" button — orbits the *live* gameplay
   * scene/camera (no separate renderer or canvas) rather than opening a
   * standalone asset viewer, so what you see is exactly what's currently
   * on screen. main.ts pauses gameplay update() while this is active (same
   * mechanism as the UI editor pause), so the player/camera don't fight
   * OrbitControls underneath you; this method only owns the controls
   * lifecycle and swapping the HUD out of the way.
   */
  setFreecam(active: boolean): void {
    if (active === !!this.orbitControls) return;

    if (active) {
      // A clone, not this.camera itself — main.ts pauses update() (so
      // this.camera stops moving) precisely so it stays put as a stable
      // reference frustum for the CameraHelper gizmo below, instead of
      // being hijacked as the same camera you're orbiting with.
      this.freecamCamera = this.camera.clone();
      this.orbitControls = new OrbitControls(this.freecamCamera, this.renderer.domElement);
      this.orbitControls.target.copy(this.player.position);
      this.orbitControls.enableDamping = true;
      this.mainLayer.style.display = "none"; // HUD/joystick would otherwise sit on top of the canvas and steal drag gestures from OrbitControls

      const hierarchyEl = document.getElementById("si-hierarchy");
      const inspectorEl = document.getElementById("si-inspector");
      if (hierarchyEl && inspectorEl) {
        this.sceneInspector = new SceneInspector({
          scene: this.scene,
          gameplayCamera: this.camera,
          viewCamera: this.freecamCamera,
          renderer: this.renderer,
          orbitControls: this.orbitControls,
          hierarchyEl,
          inspectorEl,
        });
        // A fresh SceneInspector instance is created each time freecam
        // activates, so re-wire any previously-registered listener rather
        // than relying on it surviving from a prior session.
        if (this.gizmoModeChangeCallback) this.sceneInspector.addModeChangeListener(this.gizmoModeChangeCallback);
        if (this.inspectorStateChangeCallback) this.sceneInspector.addStateChangeListener(this.inspectorStateChangeCallback);
      }
    } else {
      this.orbitControls?.dispose();
      this.orbitControls = undefined;
      this.freecamCamera = undefined;
      this.sceneInspector?.dispose();
      this.sceneInspector = undefined;
      this.mainLayer.style.display = "";
      this.cameraHandler.update(this.player.position, 0); // hands the camera back to gameplay control immediately, rather than leaving it wherever freecam last pointed it until the next real update() tick
    }
  }

  /** Dev-only: Engine Room's Move/Rotate/Scale/Select toolbar — a thin passthrough since the gizmo itself lives inside SceneInspector, only constructed while freecam is active. */
  setGizmoMode(mode: GizmoMode): void {
    this.sceneInspector?.setMode(mode);
  }

  /** Dev-only: lets the Engine Room panel's gizmo-mode buttons stay in sync when the mode changes via keyboard shortcut (W/E/R/Q) instead of a button click. Call once, any time — stored and (re)attached to whichever SceneInspector instance is live, since a new one is created per freecam session. */
  onGizmoModeChange(cb: (mode: GizmoMode) => void): void {
    this.gizmoModeChangeCallback = cb;
    this.sceneInspector?.addModeChangeListener(cb);
  }

  /** Dev-only: Engine Room's Grid/Helpers/Snap/Space toolbar — thin passthroughs, only meaningful while freecam is active. Each returns the new state so the caller (the toolbar button's click handler) can update its own active-highlight without a round trip through onInspectorStateChange. */
  toggleGrid(): boolean | undefined {
    return this.sceneInspector?.toggleGrid();
  }
  toggleHelpers(): boolean | undefined {
    return this.sceneInspector?.toggleHelpers();
  }
  toggleSnap(): boolean | undefined {
    return this.sceneInspector?.toggleSnap();
  }
  toggleSpace(): ("local" | "world") | undefined {
    return this.sceneInspector?.toggleSpace();
  }
  frameSelected(): void {
    this.sceneInspector?.frameSelected();
  }

  /** Same reasoning as onGizmoModeChange, for the toolbar toggles above — keeps the toolbar's active-highlight in sync when a toggle happens via keyboard shortcut (F/G/H/X/C) instead of a button click. */
  onInspectorStateChange(cb: (state: InspectorToolState) => void): void {
    this.inspectorStateChangeCallback = cb;
    this.sceneInspector?.addStateChangeListener(cb);
  }

  /** Dev-only: Engine Room Control Desk's class-name -> live instance lookup — see this.inspectables above and IonEngine's __getInspectable hook. */
  getInspectable(className: string): object | undefined {
    return this.inspectables.get(className);
  }

  /** Advance all systems by one frame. Call once per requestAnimationFrame tick. */
  update(dt: number, elapsed: number): void {
    if (!this.ended) {
      this.player.update(dt, elapsed, this.input.axis);

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
  }

  render(): void {
    const activeCamera = this.freecamCamera ?? this.camera;
    this.orbitControls?.update();
    this.sceneInspector?.update();
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
    this.input.dispose();
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
