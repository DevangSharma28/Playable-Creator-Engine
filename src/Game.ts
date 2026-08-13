import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { InputHandler } from "./core/InputHandler";
import { CameraHandler } from "./core/CameraHandler";
import { ViewHelperWidget } from "./core/ViewHelperWidget";
import { SceneInspector } from "./core/SceneInspector";
import { World } from "./world/World";
import { Player } from "./entities/Player";
import { CoinField } from "./entities/CoinField";
import { HUD } from "./ui/HUD";
import { UILayout } from "./ui/UILayout";
import type { UILayoutData } from "./ui/UILayoutTypes";
import mainLayoutRaw from "./ui/mainLayout.json";
import endcardLayoutRaw from "./ui/endcardLayout.json";
import { AssetLoader } from "./AssetLoader";
import { manifest, libGlb } from "./assets";

const mainLayoutData = mainLayoutRaw as UILayoutData;
const endcardLayoutData = endcardLayoutRaw as UILayoutData;

const COIN_COUNT = 6;
const AUTO_END_MS = 15000;
const CAMERA_OFFSET = new THREE.Vector3(0, 7.5, 7.5);

export class Game {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;

  private readonly world: World;
  private readonly player: Player;
  private readonly coinField: CoinField;
  private readonly input: InputHandler;
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

  private collected = 0;
  private ended = false;
  /** True once something has called resizeTo() explicitly (the dev-only device-frame simulator) — while true, the window's own resize event no longer drives sizing, so the simulator stays in control until it hands back (by calling resizeTo() with the real window size again). Production never sets this; the window listener below is the only thing that ever runs there. */
  private manualSize = false;

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

    this.mainLayer = document.getElementById("custom-ui-layer") as HTMLElement;
    const endcardLayer = document.getElementById("endcard-layer") as HTMLElement;
    this.mainUI = new UILayout(this.mainLayer, mainLayoutData);
    this.endcardUI = new UILayout(endcardLayer, endcardLayoutData);

    this.hud = new HUD(this.mainUI, this.endcardUI);
    this.hud.setScore(0, this.coinField.total);
    this.hud.onCtaClick(() => {
      // In a real network build this would open the store listing, e.g.:
      // window.open("https://play.google.com/store/apps/details?id=YOUR_APP", "_blank");
      alert("Install Now! (hook up your store URL here)");
    });

    // The joystick is a real, editable layout element (type: "joystick",
    // named "joystick") — not hardcoded HTML — so InputHandler wires
    // directly to whatever tools/ui-editor.html placed. It has to exist:
    // there's no fallback control scheme, so fail loudly rather than ship
    // a game nothing can move.
    const joystick = this.mainUI.getJoystick("joystick");
    if (!joystick) {
      throw new Error('Game: mainLayout.json is missing a "joystick" element — add one in the UI editor (Properties panel names it "joystick" by default) and Set Active.');
    }
    this.mainUI.setInteractive("joystick");
    this.input = new InputHandler(joystick.base, joystick.knob, 45, () => this.hud.hideDragHint());

    this.cameraHandler = new CameraHandler(this.camera, CAMERA_OFFSET);

    const viewHelperCanvas = document.getElementById("er-viewhelper") as HTMLCanvasElement | null;
    this.viewHelper = viewHelperCanvas ? new ViewHelperWidget(viewHelperCanvas) : undefined;

    window.addEventListener("resize", () => {
      if (!this.manualSize) this.handleResize();
    });
    window.setTimeout(() => this.showEndCard(false), AUTO_END_MS);
  }

  static async create(canvas: HTMLCanvasElement): Promise<Game> {
    const loader = new AssetLoader();
    await loader.preload(manifest);
    const path = libGlb.player;
    const model = loader.getGlb(path).scene;
    const clips = loader.getAnimations(path);

    return new Game(canvas, model, clips);
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
   * real window — how the device-frame simulator (see public/index.html)
   * previews a fixed aspect ratio letterboxed within your actual browser
   * window. Takes over from the window's own resize event until called
   * again; passing the real window size hands control back to "real" mode.
   */
  resizeTo(width: number, height: number): void {
    this.manualSize = true;
    this.cameraHandler.handleResize(width, height);
    this.renderer.setSize(width, height);
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
        this.sceneInspector = new SceneInspector(this.scene, this.camera, hierarchyEl, inspectorEl);
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

  /** Advance all systems by one frame. Call once per requestAnimationFrame tick. */
  update(dt: number, elapsed: number): void {
    if (!this.ended) {
      this.player.update(dt, elapsed, this.input.axis);
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

  private showEndCard(won: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.hud.showEndCard(won);
  }

  private handleResize(): void {
    this.cameraHandler.handleResize(window.innerWidth, window.innerHeight);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
