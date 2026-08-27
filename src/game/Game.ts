import * as THREE from "three";
import { DynamicJoystick } from "../engine/core/DynamicJoystick";
import { InputManager } from "../engine/core/InputManager";
import { CameraHandler } from "../engine/core/CameraHandler";
import { ViewHelperWidget } from "../engine/core/ViewHelperWidget";
import type { GizmoMode, InspectorToolState } from "../engine/core/SceneInspector";
import { EditorRoot, type FieldPickCallbacks } from "../engine/editor/EditorRoot";
import { ColliderVisuals } from "../engine/editor/ColliderVisuals";
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
import { applySceneBindings } from "../engine/SceneBindings";
import sceneBindingsRaw from "./sceneBindings.json";
import { Ion } from "../engine/Ion";
import { loadColliders } from "../engine/collision";
import type { ColliderData, ColliderShape } from "../engine/collision";
import collidersRaw from "./colliders.json";
import { ParticleVisuals } from "../engine/editor/ParticleVisuals";
import { loadParticles } from "../engine/particles";
import type { ParticleSystemConfig } from "../engine/particles";
import particlesRaw from "./particles.json";
import { AreaDemo } from "./AreaDemo";
import { SoundHandler } from "./SoundHandler";
import { manifest, libGlb, libAudio } from "./assets";
import { Environment } from "./entities/Environment";
import { SceneEnvironment, loadSceneEnv, snapshotScene, applySceneOverrides } from "../engine/scene";
import type { SceneEnvData, SceneSnapshot } from "../engine/scene";
import environmentRaw from "./environment.json";
// What the 3D editor changed about the scene graph — object transforms,
// visibility, names, parenting. A real import, so it ships: what you move in
// the editor is where it is in the production build.
import sceneRaw from "./scene.json";

const mainLayoutData = mainLayoutRaw as UILayoutData;
const endcardLayoutData = endcardLayoutRaw as UILayoutData;

const COIN_COUNT = 6;
const AUTO_END_MS = 15000;
/**
 * Camera framing, lighting, and world settings, authored in the 3D
 * editor's Environment dock. A real import, so it ships: what you set in
 * the panel is what the production playable runs, exactly like
 * colliders.json and particles.json.
 */
const environmentData = loadSceneEnv(environmentRaw as unknown);
/** Real store listing / click-through URL — swap this for the actual app before a network build. Every CTA (HUD button, endcard) routes through Cta.open(), which picks the right network API automatically and falls back to a new tab in a plain browser (this dev preview included). Only consulted on the paths that actually take a URL — network-owned handlers redirect to the listing the network itself has configured; see src/engine/Cta.ts. */
const STORE_URL = "https://devangsharma28.github.io/portfolio/";
// Same URL the CTA buttons use, registered once at module load so
// IonEngine's crash-recovery overlay's own CTA still works if gameplay
// ever throws mid-frame — see CrashOverlay.ts's own doc comment for why
// this is self-registered rather than threaded through IonEngine.boot().
setCrashRecoveryUrl(STORE_URL);

export class Game {
  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  /**
   * The live scene environment. Ships (it's what applies environment.json
   * at boot); the *panel* that edits it is dev-only — see
   * engine/scene/SceneEnvironment.ts's own note on the split.
   */
  private readonly sceneEnv: SceneEnvironment;

  private readonly world: World;
  private readonly player: Player;
  private readonly coinField: CoinField;
  private readonly input: DynamicJoystick;
  /** Keyboard (WASD/arrows) fallback for the joystick's own movement axis — desktop dev-preview testing without a touchscreen. See update()'s combineAxes. */
  private readonly keyboardInput: InputManager;
  private readonly cameraHandler: CameraHandler;
  private readonly hud: HUD;
  /** The ION Collider & Area worked example — see src/game/AreaDemo.ts. */
  private readonly areaDemo: AreaDemo;
  private readonly soundHandler: SoundHandler;
  private readonly mainUI: UILayout;
  private readonly endcardUI: UILayout;
  private readonly assetLoader: AssetLoader;
  private readonly environment: Environment;
  /** Only exists when #er-viewhelper is in the page (the dev-only Engine Room panel) — undefined, and never rendered into, in production. */
  private readonly viewHelper: ViewHelperWidget | undefined;
  /**
   * Collider wireframe drawing, DEV only.
   *
   * Owned here rather than by the editor because it has to work **while
   * the game is playing** — that's the whole point of the Engine Room's
   * Colliders toggle: watch a trigger light up as you walk into it, with
   * gameplay running normally. The editor borrows the same instance for
   * its Configure Colliders mode (see EditorRoot), so there's one layer
   * and two independent things that can show it, rather than two layers
   * drawing the same volumes twice.
   *
   * Constructed behind `import.meta.env.DEV` like ViewHelperWidget, so the
   * whole module — geometry, materials, colours — drops out of a
   * production build. The collision system itself is unaffected: it's
   * runtime, and it ships.
   */
  private readonly colliderDebug: ColliderVisuals | undefined;
  /**
   * Particle emission-volume gizmos, DEV only.
   *
   * Owned here for the same reason `colliderDebug` is — the editor borrows
   * it for a session rather than owning it, so there's one gizmo layer
   * with a single lifetime instead of one built and torn down per editor
   * session. Constructed behind `import.meta.env.DEV`, so the module and
   * its geometry/materials drop out of a production build while the
   * particle *runtime* ships untouched.
   */
  private readonly particleGizmos: ParticleVisuals | undefined;
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
  /** The scene as built, before scene.json applied. Handed to each editor session — see SceneOverrides.ts. */
  private sceneBaseline: SceneSnapshot | undefined;
  private sceneDirtyCallback: (() => void) | undefined;

  /** Set via onGizmoModeChange(); re-attached to each new EditorRoot since one is (re)created per editor session — see setFreecam(). */
  private gizmoModeChangeCallback: ((mode: GizmoMode) => void) | undefined;
  /** Same reasoning as gizmoModeChangeCallback, for grid/helpers/snap/space instead of gizmo mode — see onInspectorStateChange(). */
  private inspectorStateChangeCallback: ((state: InspectorToolState) => void) | undefined;
  /** Same again, for "a collider edit happened" — lets the dev page's Exit button count colliders alongside pending scene-object assignments. */
  private colliderDirtyCallback: (() => void) | undefined;
  /** Same again, for particle edits. */
  private particleDirtyCallback: (() => void) | undefined;
  /** Same again, for environment edits — camera, lighting, or world. */
  private environmentDirtyCallback: (() => void) | undefined;
  /** Same again, for undo/redo — lets the toolbars repaint their buttons without polling. */
  private historyChangeCallback: (() => void) | undefined;
  /** Held so re-attaching on a new editor session drops the previous session's subscription rather than stacking another. */
  private historyChangeUnsubscribe: (() => void) | undefined;

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

    // The rig owns both cameras and every projection setting — see
    // CameraHandler. Built before the renderer because SoundHandler parents
    // its AudioListener to the perspective camera, and before
    // SceneEnvironment because that drives it.
    this.cameraHandler = new CameraHandler(environmentData.camera);
    this.soundHandler = new SoundHandler(this.cameraHandler.perspective, musicBuffer);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Lights, fog, background, tone mapping, shadow settings, and the
    // camera block above — all from environment.json, all applied here.
    // Nothing else in the game may add scene lighting: the Environment
    // panel edits this instance, and a second set of lights added
    // elsewhere would be lighting the scene while the panel edited
    // something invisible. (World.ts used to build three by hand; those are
    // now this file's defaults, with identical colours and intensities.)
    this.sceneEnv = new SceneEnvironment(
      {
        scene: this.scene,
        renderer: this.renderer,
        rig: this.cameraHandler,
        // Same contract the particle editor uses: the environment never
        // loads an asset itself, so a background/skybox texture is
        // preloaded with the manifest and inlined by the production build
        // like any other asset.
        resolveTexture: (path) => {
          try {
            return this.assetLoader.getTexture(path);
          } catch {
            console.warn(`Environment: texture "${path}" isn't preloaded — add it to src/game/assets.ts's manifest.`);
            return undefined;
          }
        },
      },
      environmentData
    );
    this.sceneEnv.apply();
    // The rig was constructed against a 1×1 viewport; give it the real one
    // before the first frame so the projection is right on frame one rather
    // than after the first resize event.
    this.cameraHandler.handleResize(window.innerWidth, window.innerHeight);

    this.world = new World(this.scene);

    // The ION Collider & Area registry's own COLLIDERS group joins the
    // scene here, before anything creates a collider — Player builds its
    // cylinder in its own constructor a few lines down, and a collider
    // whose node has nowhere to live would never get a world transform.
    // Ion is already bound at this point: IonEngine binds it before
    // Game.create() precisely so entity constructors can do this.
    Ion.colliders.attachToScene(this.scene);

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
    this.environment = new Environment(this.scene);

    // Editor-authored colliders (src/game/colliders.json — written by the
    // 3D editor's "Configure Colliders" mode). It's a real import, so these
    // ship: what you place in the editor is what runs in the production
    // build.
    //
    // Loaded *after* the entities, not just after the environment GLB. A
    // collider records its attachment as a scene path and can only resolve
    // it against a graph that already contains that object — and the most
    // useful thing to attach one to is a character, which doesn't exist
    // until `new Player(...)` above has added its model. Loading these
    // earlier silently dropped every collider attached to anything the
    // entities build, which read as "the editor forgot my attachment".
    // Before the colliders and particles below, both of which attach by scene
    // path and read world matrices — they have to see the final transforms.
    // And before them rather than after `sceneModel` is added, because the
    // baseline these diff against is taken at the same moment (see
    // IonGame.finishCreate for the packaged path).
    this.sceneBaseline = snapshotScene(this.scene);
    applySceneOverrides(this.scene, sceneRaw);

    loadColliders(Ion.colliders, collidersRaw, this.scene);

    // The ION Particle registry's own PARTICLES group joins the scene, then
    // the editor-authored effects load into it.
    //
    // Same ordering rule as loadColliders directly above, and for the same
    // reason: an emitter records its attachment as a scene path and can
    // only resolve it against a graph that already contains the object —
    // and the most useful thing to attach an effect to is a character,
    // which doesn't exist until `new Player(...)` has added its model.
    // src/game/particles.json is a real import, so these ship: what's
    // authored in the Particle Editor is what runs in the production build.
    Ion.particles.attachToScene(this.scene);
    loadParticles(Ion.particles, particlesRaw, this.scene);

    // Both halves of the collider example now exist — the zone from
    // colliders.json above, and the Player's own cylinder from its
    // constructor — so the handlers have something to subscribe to.
    this.areaDemo = new AreaDemo();
    this.inspectables = new Map<string, object>([
      ["Game", this],
      ["World", this.world],
      ["Player", this.player],
      ["Environment", this.environment],
      ["CoinField", this.coinField],
      ["AreaDemo", this.areaDemo],
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
      applySceneBindings(instance, className, sceneBindingsRaw, this.scene);
    }

    // After that pass, never inside AreaDemo's own constructor: its `zone`
    // field is editor-assignable, and editor-assigned fields don't exist
    // until the loop above has run. See AreaDemo.wire's doc comment.
    this.areaDemo.wire();

    this.mainLayer = document.getElementById("custom-ui-layer") as HTMLElement;
    const endcardLayer = document.getElementById("endcard-layer") as HTMLElement;
    this.mainUI = new UILayout(this.mainLayer, mainLayoutData);
    this.endcardUI = new UILayout(endcardLayer, endcardLayoutData);

    // Authoring aids inside Cinema_World.glb that exist to be *read*, not
    // seen: "walkablearea" is four flat polygons describing where the player
    // may walk, and "Colliders" (a GLB node — not the engine's own COLLIDERS
    // group) is the blocking geometry the artist modelled. "cinemafloor" is
    // hidden because the walkable polygons sit a hair above it and z-fight.
    //
    // Looked up rather than cast. `getObjectByName` returns
    // `Object3D | undefined`, and asserting it away with `as THREE.Object3D`
    // meant that renaming one node in Blender — or dropping in a different
    // environment GLB, which is the first thing anyone building on this does
    // — threw "Cannot set properties of undefined (reading 'visible')" from
    // inside Game.create(), i.e. a blank screen at boot with a stack trace
    // pointing at a line that looks like it just hides a mesh.
    for (const name of ["walkablearea", "cinemafloor", "Colliders"]) {
      const node = this.scene.getObjectByName(name);
      if (node) node.visible = false;
      else console.warn(`Game: "${name}" is not in the environment model — nothing to hide. Rename it in the GLB or drop it from this list.`);
    }
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

    // import.meta.env.DEV first, so the whole ViewHelperWidget module (and
    // the second WebGLRenderer it owns) is statically unreachable in a
    // production build and drops out of the bundle entirely, rather than
    // shipping as dead weight guarded only by a DOM lookup that never
    // finds anything.
    const viewHelperCanvas = import.meta.env.DEV ? (document.getElementById("er-viewhelper") as HTMLCanvasElement | null) : null;
    this.viewHelper = viewHelperCanvas ? new ViewHelperWidget(viewHelperCanvas) : undefined;
    // Same gating and the same reasoning as viewHelper above — see the
    // field's own doc comment. Starts hidden and draws nothing until
    // something turns it on.
    this.colliderDebug = import.meta.env.DEV ? new ColliderVisuals(Ion.colliders) : undefined;
    // Same gating and the same reasoning as colliderDebug above — see the
    // field's own doc comment.
    this.particleGizmos = import.meta.env.DEV ? new ParticleVisuals(Ion.particles) : undefined;

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
      const environmentEl = document.getElementById("si-environment");
      if (!hierarchyEl || !inspectorEl || !environmentEl) return;

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
        getGameplayCamera: () => this.cameraHandler.camera,
        renderer: this.renderer,
        viewportContainer: viewportContainer as HTMLElement,
        hierarchyEl,
        inspectorEl,
        initialTarget: this.player.position,
        // The pre-override scene, so the editor's Save writes the full set of
        // deviations from the model rather than only this session's edits.
        sceneBaseline: this.sceneBaseline,
        sceneOverridesOnLoad: (sceneRaw as { objects?: { objectPath: string }[] }).objects ?? [],
        onSceneDirty: () => this.sceneDirtyCallback?.(),
        // The live registry, not a copy — colliders arranged in the editor
        // are the same objects gameplay resumes running against on exit.
        colliderManager: Ion.colliders,
        // Guaranteed to exist: this whole branch is already behind
        // import.meta.env.DEV, the same gate colliderDebug is built under.
        colliderVisuals: this.colliderDebug as ColliderVisuals,
        onColliderDirty: () => this.colliderDirtyCallback?.(),
        // The live registry, not a copy — effects arranged in the editor
        // are the same ones gameplay resumes running on exit.
        particleManager: Ion.particles,
        // Guaranteed to exist: this whole branch is already behind
        // import.meta.env.DEV, the same gate particleGizmos is built under.
        particleVisuals: this.particleGizmos as ParticleVisuals,
        onParticleDirty: () => this.particleDirtyCallback?.(),
        // The live environment, not a copy — what the panel tunes is what
        // gameplay resumes rendering with on exit.
        environment: this.sceneEnv,
        onEnvironmentDirty: () => this.environmentDirtyCallback?.(),
        environmentEl,
        // Particle textures go through the game's own AssetLoader, so they
        // are preloaded with everything else and base64-inlined by the
        // production build like any other asset — the editor never loads
        // an asset itself.
        resolveTexture: (path) => {
          try {
            return this.assetLoader.getTexture(path);
          } catch {
            // Not in the manifest. A warning rather than a throw: a typo in
            // a texture path shouldn't take the editor down, and the
            // emitter falls back to the built-in soft dot.
            console.warn(`Particles: texture "${path}" isn't preloaded — add it to src/game/assets.ts's manifest. Using the default texture.`);
            return undefined;
          }
        },
      });
      // A fresh EditorRoot is created each session, so re-wire any
      // previously-registered listener rather than relying on it surviving
      // from a prior one.
      if (this.gizmoModeChangeCallback) this.editor.addModeChangeListener(this.gizmoModeChangeCallback);
      if (this.inspectorStateChangeCallback) this.editor.addStateChangeListener(this.inspectorStateChangeCallback);
      // Same per-session re-attach as the two above — the history belongs
      // to the EditorRoot, which is rebuilt on every entry.
      if (this.historyChangeCallback) {
        this.historyChangeUnsubscribe = this.editor.onHistoryChange(this.historyChangeCallback);
      }
    } else {
      this.historyChangeUnsubscribe?.();
      this.historyChangeUnsubscribe = undefined;
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

  /** Dev-only: what a field should receive for a clicked object, plus what to write down so it survives a reload — see EditorRoot.assignmentFor. */
  editorAssignmentFor(declaredType: string | undefined, object: THREE.Object3D): ReturnType<EditorRoot["assignmentFor"]> | undefined {
    return this.editor?.assignmentFor(declaredType, object);
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

  // -----------------------------------------------------------------------
  // Dev-only: the 3D editor's "Configure Colliders" mode. Thin passthroughs
  // for the same reason as the toolbar toggles above — the whole collider
  // *editor* lives inside EditorRoot, which only exists while the editor is
  // open and only in a dev build. The collision system itself
  // (engine/collision/) is entirely separate and always running.
  // -----------------------------------------------------------------------

  setColliderMode(active: boolean): boolean | undefined {
    return this.editor?.setColliderMode(active);
  }
  /**
   * The Engine Room's "Colliders" debug toggle — draws every registered
   * collider and trigger volume **over the running game**, independent of
   * the 3D editor. Returns the new state, or undefined in production where
   * there is no layer to toggle.
   */
  setColliderDebug(visible: boolean): boolean | undefined {
    this.colliderDebug?.setDebugVisible(visible);
    return this.colliderDebug?.isDebugVisible;
  }
  toggleColliderDebug(): boolean | undefined {
    return this.setColliderDebug(!this.colliderDebug?.isDebugVisible);
  }
  createCollider(shape: ColliderShape): void {
    this.editor?.createCollider(shape);
  }
  deleteSelectedCollider(): boolean {
    return this.editor?.deleteSelectedCollider() ?? false;
  }
  toggleColliderVisible(): boolean | undefined {
    return this.editor?.toggleColliderVisible();
  }
  /** The records the dev page POSTs to /save-colliders on Exit Editor. Undefined when the editor isn't open — there's nothing to save then. */
  serializeColliders(): ColliderData[] | undefined {
    return this.editor?.serializeColliders();
  }
  hasColliderChanges(): boolean {
    return this.editor?.hasColliderChanges ?? false;
  }
  markCollidersSaved(): void {
    this.editor?.markCollidersSaved();
  }
  /** Live counters for the collider toolbar's readout — available with or without the editor, since the registry itself is always there. */
  getColliderStats(): ReturnType<typeof Ion.colliders.getStats> {
    return Ion.colliders.getStats();
  }
  /** Same reasoning as onGizmoModeChange: a new EditorRoot is built per session, so the callback is stored here and re-attached. */
  onColliderDirty(cb: () => void): void {
    this.colliderDirtyCallback = cb;
  }

  // -----------------------------------------------------------------------
  // Dev-only: the 3D editor's "Particle System" mode. Thin passthroughs for
  // the same reason the collider ones above are — the particle *editor*
  // lives inside EditorRoot, which only exists while the editor is open and
  // only in a dev build. The particle system itself (engine/particles/) is
  // entirely separate and always running.
  // -----------------------------------------------------------------------

  setParticleMode(active: boolean): boolean | undefined {
    return this.editor?.setParticleMode(active);
  }
  createParticleSystem(presetKey?: string): void {
    this.editor?.createParticleSystem(presetKey);
  }
  addParticleEmitter(): void {
    this.editor?.addParticleEmitter();
  }
  deleteSelectedEmitter(): boolean {
    return this.editor?.deleteSelectedEmitter() ?? false;
  }
  duplicateSelectedEmitter(): boolean {
    return this.editor?.duplicateSelectedEmitter() ?? false;
  }
  particlePlay(): void {
    this.editor?.particlePlay();
  }
  particlePause(): void {
    this.editor?.particlePause();
  }
  particleStop(): void {
    this.editor?.particleStop();
  }
  particleRestart(): void {
    this.editor?.particleRestart();
  }
  particleClear(): void {
    this.editor?.particleClear();
  }
  isParticlePreviewPlaying(): boolean {
    return this.editor?.isParticlePreviewPlaying ?? false;
  }
  toggleParticleGizmo(kind: "shapes" | "direction" | "bounds"): boolean | undefined {
    return this.editor?.toggleParticleGizmos(kind);
  }
  /**
   * The preset list the toolbar's dropdown is built from.
   *
   * Routed through the editor rather than importing the preset table
   * directly: an ungated import here shipped all thirteen preset configs
   * into the production bundle for a dropdown that only exists in the
   * editor. Reaching it through `this.editor` keeps the table inside the
   * DEV-gated module tree where it tree-shakes away.
   */
  getParticlePresets(): { key: string; label: string; description: string }[] {
    return this.editor?.getParticlePresets() ?? [];
  }
  /** The records the dev page POSTs to /save-particles on Exit Editor. */
  serializeParticles(): ParticleSystemConfig[] | undefined {
    return this.editor?.serializeParticles();
  }
  hasParticleChanges(): boolean {
    return this.editor?.hasParticleChanges ?? false;
  }
  markParticlesSaved(): void {
    this.editor?.markParticlesSaved();
  }
  /** Live counters for the particle toolbar's readout — available with or without the editor, since the registry itself is always there. */
  getParticleStats(): ReturnType<typeof Ion.particles.getStats> {
    return Ion.particles.getStats();
  }
  /** Global quality tier. Ungated by the editor on purpose — a real playable would call this from a device-capability check at boot, not from an editor. */
  setParticleQuality(quality: "high" | "medium" | "low"): void {
    Ion.particles.setQuality(quality);
  }
  /** Same reasoning as onColliderDirty. */
  onParticleDirty(cb: () => void): void {
    this.particleDirtyCallback = cb;
  }

  // -----------------------------------------------------------------------
  // Dev-only: editor undo/redo. One stack shared by every editor mode —
  // see EditorRoot.history for why it lives there rather than per-mode.
  // -----------------------------------------------------------------------
  // Scene environment (camera / lighting / world) — thin passthroughs to the
  // editor's Environment dock, plus the one runtime accessor the dev page's
  // save path needs. Only meaningful while the editor is open; the
  // environment itself runs regardless.
  // -----------------------------------------------------------------------

  /** Every authored environment setting, as a JSON-ready record for src/game/environment.json. */
  serializeEnvironment(): SceneEnvData | undefined {
    return this.editor?.serializeEnvironment();
  }
  hasEnvironmentChanges(): boolean {
    return this.editor?.hasEnvironmentChanges() ?? false;
  }
  markEnvironmentSaved(): void {
    this.editor?.markEnvironmentSaved();
  }
  /** Same per-session re-attach contract as onColliderDirty — see its own note. */
  onEnvironmentDirty(cb: () => void): void {
    this.environmentDirtyCallback = cb;
  }

  /** What the gizmo and the Hierarchy changed, as records for src/game/scene.json. */
  serializeScene(): unknown[] | undefined {
    return this.editor?.serializeScene();
  }
  hasSceneChanges(): boolean {
    return this.editor?.hasSceneChanges() ?? false;
  }
  markSceneSaved(): void {
    this.editor?.markSceneSaved();
  }
  /** Same per-session re-attach contract as onColliderDirty — see its own note. */
  onSceneDirty(cb: () => void): void {
    this.sceneDirtyCallback = cb;
  }

  // -----------------------------------------------------------------------

  editorUndo(): boolean {
    return this.editor?.undo() ?? false;
  }
  editorRedo(): boolean {
    return this.editor?.redo() ?? false;
  }
  getEditorHistory(): ReturnType<EditorRoot["getHistoryState"]> | undefined {
    return this.editor?.getHistoryState();
  }
  /** Same re-attach-per-session reasoning as onGizmoModeChange — a fresh EditorRoot is built each time the editor opens. */
  onEditorHistoryChange(cb: () => void): void {
    this.historyChangeCallback = cb;
    this.historyChangeUnsubscribe?.();
    this.historyChangeUnsubscribe = this.editor?.onHistoryChange(cb);
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

  /** Advance all systems by one frame. Called once per requestAnimationFrame tick. */
  tick(dt: number, elapsed: number): void {
    if (!this.ended) {
      this.player.update(dt, elapsed, this.combinedAxis());

      this.playTimeMs += dt * 1000;
      if (this.playTimeMs >= AUTO_END_MS) {
        // this.showEndCard(false);
      }
    }

    this.coinField.update(dt, elapsed, this.player.position, () => {
      this.collected++;
      this.hud.setScore(this.collected, this.coinField.total);
      if (this.collected >= this.coinField.total) {
        // this.showEndCad(true);
      }
    });

    this.cameraHandler.update(this.player.position, dt);
    this.soundHandler.update(); // applies volume/muted — see SoundHandler.update's own doc comment for why this is a poll, not a setter
  }

  render(): void {
    const activeCamera = this.editor?.camera ?? this.cameraHandler.camera;
    this.editor?.update();
    // After the editor (which is what syncs colliders while gameplay is
    // paused) and before the draw, so the wireframes show this frame's
    // positions and overlap state. Reconciled here for both the in-game
    // debug overlay and the editor's Configure Colliders mode — one call
    // site, one layer. Cheap to a no-op while nothing is showing.
    this.colliderDebug?.update();
    // Particles upload here, once per frame, for gameplay and the editor
    // alike — one call site for the same reason the collider layer has
    // one. The camera is handed over every frame rather than once at
    // construction because billboarding and distance sorting both read its
    // *current* position, and because `activeCamera` genuinely changes when
    // the editor opens (see EditorRoot, which points the registry at its
    // own camera for the session).
    Ion.particles.setCamera(activeCamera);
    Ion.particles.render();
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
    // Drops the collider event subscriptions this instance registered. The
    // colliders themselves are IonEngine's to retire (it clears the whole
    // registry in __disposeGame) — this is just the handlers closing over
    // *this* Game.
    this.areaDemo.dispose();
    this.input.dispose();
    this.keyboardInput.dispose();
    this.soundHandler.dispose();
    // Drops the DOM listeners the designed UI wired up (button actions,
    // toggle/slider interaction, hover states). The nodes themselves are
    // replaced when the next Game builds into the same container, but the
    // handlers close over *this* Game — so on an in-place reload, leaving
    // them attached keeps a disposed Game reachable and lets a stray click
    // on stale UI drive it.
    this.mainUI.dispose();
    this.endcardUI.dispose();
    // Releases every light it created plus the PMREM render target behind
    // a generated environment map — both would otherwise accumulate one
    // full set per in-place hot reload.
    this.sceneEnv.dispose();
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
