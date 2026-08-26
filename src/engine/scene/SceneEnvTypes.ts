/**
 * The authored description of a scene's environment: how the camera is
 * framed, what lights it, and what the world around it looks like.
 *
 * Plain data on purpose — the same shape lives in src/game/environment.json,
 * travels through the dev API to disk, and is what a history command
 * snapshots for undo. Nothing here holds a THREE object; SceneEnvironment
 * is what turns these numbers into live scene state.
 *
 * Colors are `[r, g, b]` in 0..1 linear — THREE.Color's own range, and the
 * same convention the particle system's ColorField already uses, so the
 * value in the file is the value in the swatch is the value in the shader.
 */

export type CameraProjection = "perspective" | "orthographic";
export type BackgroundMode = "none" | "color" | "texture";
export type EnvironmentSource = "none" | "room" | "background";
export type FogMode = "none" | "linear" | "exp2";
export type ToneMappingName = "none" | "linear" | "reinhard" | "cineon" | "aces" | "agx" | "neutral";
export type ShadowTypeName = "basic" | "pcf" | "pcfsoft" | "vsm";
export type AmbientMode = "ambient" | "hemisphere";

export interface CameraEnvConfig {
  projection: CameraProjection;
  /** Vertical FOV in degrees. Perspective only. */
  fov: number;
  near: number;
  far: number;
  /** THREE.Camera.zoom — a post-projection scale that works in both modes. */
  zoom: number;
  /** Orthographic vertical half-extent in world units. Width follows the live aspect, so an ortho shot reframes on resize the way a perspective one does. */
  orthoSize: number;
  /**
   * Aspect the shot was framed at. On a narrower (more portrait) viewport
   * the FOV widens to preserve horizontal framing, which is what keeps a
   * playable readable in both orientations. 0 disables the correction and
   * leaves `fov` as authored.
   */
  referenceAspect: number;
  /**
   * True: the rig follows a focus point every frame (the gameplay case) and
   * `offset`/`lookAtHeight`/`damping` describe the shot.
   * False: the camera sits exactly at `position`/`rotation` and nothing
   * moves it — how you hand-place a fixed shot from the editor.
   */
  follow: boolean;
  /** Rig offset from the focus point. This is the framing control while `follow` is on. */
  offset: [number, number, number];
  /** Height above the focus point the camera aims at. */
  lookAtHeight: number;
  /** Follow stiffness. Higher converges faster; frame-rate independent either way. */
  damping: number;
  /** Used only while `follow` is off. */
  position: [number, number, number];
  /** Degrees. Used only while `follow` is off. */
  rotation: [number, number, number];
}

export interface AmbientLightConfig {
  enabled: boolean;
  /** "ambient" is a flat term added everywhere; "hemisphere" fades sky colour to `groundColor` from above to below. */
  mode: AmbientMode;
  color: [number, number, number];
  /** Hemisphere mode only — the bounce colour coming up off the floor. */
  groundColor: [number, number, number];
  intensity: number;
}

export interface DirectionalLightConfig {
  /** Stable across saves; what a history command and the editor's selection both key on. */
  id: string;
  name: string;
  enabled: boolean;
  color: [number, number, number];
  intensity: number;
  position: [number, number, number];
  /** World point the light aims at. Direction is `target - position`. */
  target: [number, number, number];
  castShadow: boolean;
  /** Square shadow map edge in texels. Powers of two only — anything else wastes memory for no sharpness. */
  shadowMapSize: number;
  shadowBias: number;
  shadowNormalBias: number;
  /** Softening radius. Ignored by PCFSoftShadowMap, which derives its own; meaningful under PCF and VSM. */
  shadowRadius: number;
  /** Half-width of the orthographic shadow frustum. Must cover everything that should cast — too small silently clips shadows away at the edges, too large wastes resolution. */
  shadowCameraExtent: number;
  shadowCameraNear: number;
  shadowCameraFar: number;
}

export interface WorldEnvConfig {
  backgroundMode: BackgroundMode;
  backgroundColor: [number, number, number];
  /** Manifest path of an equirectangular texture. Resolved through the game's own AssetLoader — the environment system never loads an asset itself. */
  backgroundTexture: string;
  backgroundBlurriness: number;
  backgroundIntensity: number;
  /**
   * What PBR materials reflect.
   * "room" generates a neutral studio IBL at runtime (no asset to ship);
   * "background" reuses the background texture when there is one.
   * Without either, every metallic material in the scene renders black —
   * a metal with no environment has nothing to reflect.
   */
  environmentSource: EnvironmentSource;
  environmentIntensity: number;
  fogMode: FogMode;
  fogColor: [number, number, number];
  /** Linear fog only. */
  fogNear: number;
  /** Linear fog only. */
  fogFar: number;
  /** Exponential-squared fog only. */
  fogDensity: number;
  toneMapping: ToneMappingName;
  toneMappingExposure: number;
  /** Master switch for the renderer's shadow pass. Off costs nothing; on costs a depth pass per shadow-casting light even if no light actually casts. */
  shadowsEnabled: boolean;
  shadowType: ShadowTypeName;
}

export interface SceneEnvData {
  version: 1;
  camera: CameraEnvConfig;
  ambient: AmbientLightConfig;
  directionals: DirectionalLightConfig[];
  world: WorldEnvConfig;
}

/**
 * The camera the environment system drives.
 *
 * An interface rather than a direct CameraHandler import so the two stay
 * independently replaceable: a playable that wants a different camera style
 * implements this and the environment panel keeps working unchanged.
 */
export interface CameraRig {
  /** The camera currently being rendered through — changes identity when the projection mode does. */
  readonly camera: import("three").Camera;
  applyCameraConfig(config: CameraEnvConfig): void;
}
