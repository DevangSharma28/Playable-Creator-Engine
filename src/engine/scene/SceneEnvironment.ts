import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { cloneSceneEnv, defaultSceneEnv } from "./SceneEnvDefaults";
import type {
  AmbientLightConfig,
  CameraEnvConfig,
  CameraRig,
  DirectionalLightConfig,
  SceneEnvData,
  ShadowTypeName,
  ToneMappingName,
  WorldEnvConfig,
} from "./SceneEnvTypes";

const TONE_MAPPING: Record<ToneMappingName, THREE.ToneMapping> = {
  none: THREE.NoToneMapping,
  linear: THREE.LinearToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  cineon: THREE.CineonToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
};

const SHADOW_TYPE: Record<ShadowTypeName, THREE.ShadowMapType> = {
  basic: THREE.BasicShadowMap,
  pcf: THREE.PCFShadowMap,
  pcfsoft: THREE.PCFSoftShadowMap,
  vsm: THREE.VSMShadowMap,
};

export interface SceneEnvironmentOptions {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  /** The camera rig the `camera` block drives. See CameraRig's own note on why this is an interface. */
  rig: CameraRig;
  /**
   * Resolves a background/skybox texture path through the game's own
   * AssetLoader. Same contract the particle editor uses: the environment
   * never loads an asset itself, so everything it references is preloaded
   * with the rest of the manifest and base64-inlined by the production
   * build like any other asset.
   */
  resolveTexture?: (path: string) => THREE.Texture | undefined;
}

/**
 * The live scene environment: camera framing, lighting, and world settings,
 * driven from one plain-data config (see SceneEnvTypes).
 *
 * ## Why this ships rather than being editor-only
 *
 * Same reason colliders.json and particles.json ship: what you author in
 * the editor has to be what the playable runs. The *panel* that edits this
 * is dev-only (EditorEnvironment, reached only from EditorRoot, which is
 * itself behind `import.meta.env.DEV`); this class is the small runtime
 * half that reads the JSON and applies it. In a production build it runs
 * `apply()` once at boot and is never touched again.
 *
 * ## It owns its lights
 *
 * Every light described by the config is created, updated, and removed by
 * this class — nothing else may add scene lighting, or the panel would be
 * editing one set of lights while another set did the actual lighting.
 * That's why World.ts no longer builds any: its three hardcoded lights are
 * now the two entries in DEFAULT_DIRECTIONALS plus DEFAULT_AMBIENT, with
 * identical colours and intensities.
 *
 * ## Apply is idempotent and cheap
 *
 * `apply()` reconciles live objects against the config rather than
 * rebuilding them, so the editor can call it on every slider event. The one
 * genuinely expensive path — a shadow-map type change, which needs every
 * material recompiled — is detected and done only when the value actually
 * changed.
 */
export class SceneEnvironment {
  private data: SceneEnvData;

  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly rig: CameraRig;
  private readonly resolveTexture: ((path: string) => THREE.Texture | undefined) | undefined;

  /** The container every environment light lives under — one node to find in the Hierarchy, and one node to remove on teardown. */
  private readonly root = new THREE.Group();
  private ambientLight: THREE.AmbientLight | undefined;
  private hemisphereLight: THREE.HemisphereLight | undefined;
  private readonly directionals = new Map<string, THREE.DirectionalLight>();

  private pmrem: THREE.PMREMGenerator | undefined;
  /** The runtime-generated room IBL. Held so it can be disposed and so it isn't regenerated on every apply(). */
  private generatedEnvironment: THREE.Texture | undefined;

  /** Last applied values for the two settings whose change forces a shader recompile — see applyWorld. */
  private lastShadowType: ShadowTypeName | undefined;
  private lastShadowsEnabled: boolean | undefined;

  /** Bumped on every mutation. The editor panel polls it to know when its rows need rebuilding, same contract as InspectorSectionProvider.version. */
  private revision = 0;

  constructor(options: SceneEnvironmentOptions, data?: SceneEnvData) {
    this.scene = options.scene;
    this.renderer = options.renderer;
    this.rig = options.rig;
    this.resolveTexture = options.resolveTexture;
    this.data = data ? cloneSceneEnv(data) : defaultSceneEnv();

    this.root.name = "Environment Lights";
    this.scene.add(this.root);
  }

  get version(): number {
    return this.revision;
  }

  /** The live config. Treat as read-only — mutate through the update* methods so `revision` and the scene both keep up. */
  get config(): SceneEnvData {
    return this.data;
  }

  /** A detached copy — what a history command holds as its before/after state, and what the save path writes. */
  snapshot(): SceneEnvData {
    return cloneSceneEnv(this.data);
  }

  /** The scene node the lights hang off, so the editor can exclude it from picking if it ever wants to. */
  get lightRoot(): THREE.Object3D {
    return this.root;
  }

  /** The rig's live camera — what the environment panel reads for its "where is the gameplay camera actually" readout while the editor orbits somewhere else. */
  get rigCamera(): THREE.Camera {
    return this.rig.camera;
  }

  // ---------------------------------------------------------------------
  // Mutation. Every path funnels through here so nothing can change the
  // config without the scene and `revision` following.
  // ---------------------------------------------------------------------

  updateCamera(patch: Partial<CameraEnvConfig>): void {
    Object.assign(this.data.camera, patch);
    this.revision++;
    this.applyCamera();
  }

  updateAmbient(patch: Partial<AmbientLightConfig>): void {
    Object.assign(this.data.ambient, patch);
    this.revision++;
    this.applyAmbient();
  }

  updateDirectional(id: string, patch: Partial<DirectionalLightConfig>): void {
    const config = this.data.directionals.find((d) => d.id === id);
    if (!config) return;
    Object.assign(config, patch);
    this.revision++;
    this.applyDirectionals();
  }

  updateWorld(patch: Partial<WorldEnvConfig>): void {
    Object.assign(this.data.world, patch);
    this.revision++;
    this.applyWorld();
  }

  addDirectional(config?: Partial<DirectionalLightConfig>): DirectionalLightConfig {
    const template = cloneSceneEnv(defaultSceneEnv().directionals[0]);
    const index = this.data.directionals.length + 1;
    const created: DirectionalLightConfig = {
      ...template,
      ...config,
      id: config?.id ?? `dir_${Math.random().toString(36).slice(2, 10)}`,
      name: config?.name ?? `Directional Light ${index}`,
    };
    this.data.directionals.push(created);
    this.revision++;
    this.applyDirectionals();
    return created;
  }

  removeDirectional(id: string): boolean {
    const index = this.data.directionals.findIndex((d) => d.id === id);
    if (index < 0) return false;
    this.data.directionals.splice(index, 1);
    this.revision++;
    this.applyDirectionals();
    return true;
  }

  /**
   * Replaces the whole config and re-applies it.
   *
   * This is the undo/redo path. A whole-config restore rather than a
   * per-field one because adding and removing a directional light are
   * ordinary edits here — a field-level command couldn't express them, and
   * the config is small enough that cloning it per history entry costs
   * nothing measurable.
   */
  restore(data: SceneEnvData): void {
    this.data = cloneSceneEnv(data);
    this.revision++;
    this.apply();
  }

  // ---------------------------------------------------------------------
  // Application
  // ---------------------------------------------------------------------

  /** Full reconcile. Called once at boot, and again whenever a whole-config restore lands. */
  apply(): void {
    this.applyCamera();
    this.applyAmbient();
    this.applyDirectionals();
    this.applyWorld();
  }

  private applyCamera(): void {
    this.rig.applyCameraConfig(this.data.camera);
  }

  private applyAmbient(): void {
    const config = this.data.ambient;
    const wantAmbient = config.enabled && config.mode === "ambient";
    const wantHemisphere = config.enabled && config.mode === "hemisphere";

    if (wantAmbient) {
      if (!this.ambientLight) {
        this.ambientLight = new THREE.AmbientLight(0xffffff, 1);
        this.ambientLight.name = "Ambient Light";
        this.root.add(this.ambientLight);
      }
      this.ambientLight.color.setRGB(...config.color);
      this.ambientLight.intensity = config.intensity;
    } else if (this.ambientLight) {
      this.root.remove(this.ambientLight);
      this.ambientLight.dispose();
      this.ambientLight = undefined;
    }

    if (wantHemisphere) {
      if (!this.hemisphereLight) {
        this.hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
        this.hemisphereLight.name = "Hemisphere Light";
        this.root.add(this.hemisphereLight);
      }
      this.hemisphereLight.color.setRGB(...config.color);
      this.hemisphereLight.groundColor.setRGB(...config.groundColor);
      this.hemisphereLight.intensity = config.intensity;
    } else if (this.hemisphereLight) {
      this.root.remove(this.hemisphereLight);
      this.hemisphereLight.dispose();
      this.hemisphereLight = undefined;
    }
  }

  private applyDirectionals(): void {
    const seen = new Set<string>();

    for (const config of this.data.directionals) {
      seen.add(config.id);
      let light = this.directionals.get(config.id);
      if (!light) {
        light = new THREE.DirectionalLight(0xffffff, 1);
        // The target is a real Object3D and must be in the graph for its
        // world matrix to be current — a target left unparented leaves the
        // light aiming at the origin no matter what its position says.
        light.target.name = `${config.name} Target`;
        this.root.add(light, light.target);
        this.directionals.set(config.id, light);
      }
      light.name = config.name;
      light.target.name = `${config.name} Target`;
      light.visible = config.enabled;
      light.color.setRGB(...config.color);
      light.intensity = config.intensity;
      light.position.set(...config.position);
      light.target.position.set(...config.target);
      light.target.updateMatrixWorld();

      light.castShadow = config.castShadow;
      if (config.castShadow) {
        const size = Math.max(64, Math.round(config.shadowMapSize));
        if (light.shadow.mapSize.width !== size || light.shadow.mapSize.height !== size) {
          light.shadow.mapSize.set(size, size);
          // The render target was allocated at the old size; dropping it
          // makes three.js reallocate at the new one on the next shadow
          // pass. Without this the resolution setting silently does nothing.
          light.shadow.map?.dispose();
          light.shadow.map = null;
        }
        light.shadow.bias = config.shadowBias;
        light.shadow.normalBias = config.shadowNormalBias;
        light.shadow.radius = config.shadowRadius;
        const camera = light.shadow.camera;
        camera.left = -config.shadowCameraExtent;
        camera.right = config.shadowCameraExtent;
        camera.top = config.shadowCameraExtent;
        camera.bottom = -config.shadowCameraExtent;
        camera.near = config.shadowCameraNear;
        camera.far = config.shadowCameraFar;
        camera.updateProjectionMatrix();
      }
    }

    for (const [id, light] of [...this.directionals]) {
      if (seen.has(id)) continue;
      this.root.remove(light, light.target);
      light.shadow.map?.dispose();
      light.dispose();
      this.directionals.delete(id);
    }
  }

  private applyWorld(): void {
    const config = this.data.world;

    this.applyBackground(config);
    this.applyEnvironmentMap(config);

    this.scene.backgroundBlurriness = config.backgroundBlurriness;
    this.scene.backgroundIntensity = config.backgroundIntensity;
    this.scene.environmentIntensity = config.environmentIntensity;

    if (config.fogMode === "linear") {
      const fog = this.scene.fog instanceof THREE.Fog ? this.scene.fog : new THREE.Fog(0xffffff, 1, 100);
      fog.color.setRGB(...config.fogColor);
      fog.near = config.fogNear;
      fog.far = config.fogFar;
      this.scene.fog = fog;
    } else if (config.fogMode === "exp2") {
      const fog = this.scene.fog instanceof THREE.FogExp2 ? this.scene.fog : new THREE.FogExp2(0xffffff, 0.01);
      fog.color.setRGB(...config.fogColor);
      fog.density = config.fogDensity;
      this.scene.fog = fog;
    } else {
      this.scene.fog = null;
    }

    this.renderer.toneMapping = TONE_MAPPING[config.toneMapping] ?? THREE.NoToneMapping;
    this.renderer.toneMappingExposure = config.toneMappingExposure;

    // Both of these change the shader every material compiles, so three.js
    // won't pick them up on already-compiled materials on its own. Doing it
    // unconditionally would recompile the whole scene on every slider
    // event, hence the change check.
    const shadowsChanged = this.lastShadowsEnabled !== config.shadowsEnabled || this.lastShadowType !== config.shadowType;
    this.renderer.shadowMap.enabled = config.shadowsEnabled;
    this.renderer.shadowMap.type = SHADOW_TYPE[config.shadowType] ?? THREE.PCFSoftShadowMap;
    if (shadowsChanged) {
      this.lastShadowsEnabled = config.shadowsEnabled;
      this.lastShadowType = config.shadowType;
      this.renderer.shadowMap.needsUpdate = true;
      this.scene.traverse((object) => {
        const material = (object as THREE.Mesh).material;
        if (!material) return;
        if (Array.isArray(material)) for (const m of material) m.needsUpdate = true;
        else material.needsUpdate = true;
      });
    }
  }

  private applyBackground(config: WorldEnvConfig): void {
    if (config.backgroundMode === "color") {
      const color = this.scene.background instanceof THREE.Color ? this.scene.background : new THREE.Color();
      color.setRGB(...config.backgroundColor);
      this.scene.background = color;
      return;
    }
    if (config.backgroundMode === "texture") {
      const texture = this.lookupTexture(config.backgroundTexture);
      if (texture) {
        // Equirectangular is the only single-file panorama layout worth
        // supporting here — a cube map is six assets, which a playable's
        // size budget rarely justifies.
        texture.mapping = THREE.EquirectangularReflectionMapping;
        this.scene.background = texture;
        return;
      }
      // Fall through to the colour rather than leaving the scene
      // transparent: a mistyped path should look wrong, not invisible.
      const fallback = this.scene.background instanceof THREE.Color ? this.scene.background : new THREE.Color();
      fallback.setRGB(...config.backgroundColor);
      this.scene.background = fallback;
      return;
    }
    this.scene.background = null;
  }

  private applyEnvironmentMap(config: WorldEnvConfig): void {
    if (config.environmentSource === "none") {
      this.scene.environment = null;
      this.releaseGeneratedEnvironment();
      return;
    }

    if (config.environmentSource === "background") {
      const texture = this.lookupTexture(config.backgroundTexture);
      if (texture) {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        this.scene.environment = texture;
        this.releaseGeneratedEnvironment();
        return;
      }
      // No background texture to borrow — fall back to the generated room
      // rather than silently leaving metals black.
    }

    if (!this.generatedEnvironment) {
      this.pmrem ??= new THREE.PMREMGenerator(this.renderer);
      const room = new RoomEnvironment();
      this.generatedEnvironment = this.pmrem.fromScene(room, 0.04).texture;
      // fromScene() has already rendered everything it needs; the source
      // scene's geometry and materials are dead weight from here on.
      room.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) for (const m of material) m.dispose();
        else material.dispose();
      });
    }
    this.scene.environment = this.generatedEnvironment;
  }

  private releaseGeneratedEnvironment(): void {
    this.generatedEnvironment?.dispose();
    this.generatedEnvironment = undefined;
  }

  private lookupTexture(path: string): THREE.Texture | undefined {
    if (!path || !this.resolveTexture) return undefined;
    return this.resolveTexture(path);
  }

  /**
   * Releases every light, render target, and generated texture this created.
   *
   * Called from Game.dispose(), which an in-place hot reload runs on every
   * source save — without it each reload would leave a full set of lights
   * in the discarded scene and leak the PMREM render target.
   */
  dispose(): void {
    for (const [, light] of this.directionals) {
      this.root.remove(light, light.target);
      light.shadow.map?.dispose();
      light.dispose();
    }
    this.directionals.clear();
    this.ambientLight?.dispose();
    this.hemisphereLight?.dispose();
    this.ambientLight = this.hemisphereLight = undefined;
    this.releaseGeneratedEnvironment();
    this.pmrem?.dispose();
    this.pmrem = undefined;
    this.scene.environment = null;
    this.scene.remove(this.root);
  }
}
