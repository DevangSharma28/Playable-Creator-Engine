import type {
  AmbientLightConfig,
  CameraEnvConfig,
  DirectionalLightConfig,
  SceneEnvData,
  WorldEnvConfig,
} from "./SceneEnvTypes";

/**
 * The engine's own starting environment.
 *
 * Every value here reproduces what the engine did before the environment
 * system existed (World.ts's three hardcoded lights, its sky-blue
 * background and linear fog, and Game.ts's renderer/camera setup), so a
 * project with no environment.json renders exactly as it always did and
 * this system is purely additive until someone opens the panel.
 *
 * Two deliberate "off by default" choices worth knowing about, both of
 * which are real improvements the panel can switch on but neither of which
 * should change how an existing playable looks without being asked:
 *
 *  - `environmentSource: "none"` — no IBL. Metallic materials have nothing
 *    to reflect and render dark. Switching this to "room" is usually the
 *    single biggest visual gain available on a GLB-heavy scene.
 *  - `toneMapping: "none"` — highlights clip rather than roll off. "aces"
 *    at exposure ~1 is the usual choice once total light intensity climbs
 *    past 1.
 */

export const DEFAULT_CAMERA: CameraEnvConfig = {
  projection: "perspective",
  fov: 50,
  near: 0.01,
  far: 1000,
  zoom: 1,
  orthoSize: 10,
  // 0 = no orientation correction, matching the pre-existing fixed-FOV
  // behavior. Set it to the aspect the shot was framed at (e.g. 0.5625 for
  // a 9:16 portrait design) to keep horizontal framing across orientations.
  referenceAspect: 0,
  follow: true,
  offset: [0, 12, 12],
  lookAtHeight: 0.3,
  // ln(1/0.001) — the exponential-decay equivalent of the literal
  // `1 - Math.pow(0.001, dt)` this replaced, so follow feel is unchanged.
  damping: 6.91,
  position: [0, 12, 12],
  rotation: [-45, 0, 0],
};

export const DEFAULT_AMBIENT: AmbientLightConfig = {
  enabled: true,
  mode: "ambient",
  color: [1, 1, 1],
  groundColor: [0.35, 0.32, 0.28],
  intensity: 0.7,
};

/** 0xfff4d6 and 0xbfe3ff — the warm key and cool fill World.ts used to build by hand. */
export const DEFAULT_DIRECTIONALS: DirectionalLightConfig[] = [
  {
    id: "sun",
    name: "Sun",
    enabled: true,
    color: [1, 0.957, 0.839],
    intensity: 1.2,
    position: [6, 12, 6],
    target: [0, 0, 0],
    castShadow: false,
    shadowMapSize: 1024,
    shadowBias: -0.0005,
    shadowNormalBias: 0.02,
    shadowRadius: 1,
    shadowCameraExtent: 20,
    shadowCameraNear: 0.5,
    shadowCameraFar: 80,
  },
  {
    id: "fill",
    name: "Fill Light",
    enabled: true,
    color: [0.749, 0.89, 1],
    intensity: 0.35,
    position: [-6, 4, -4],
    target: [0, 0, 0],
    castShadow: false,
    shadowMapSize: 1024,
    shadowBias: -0.0005,
    shadowNormalBias: 0.02,
    shadowRadius: 1,
    shadowCameraExtent: 20,
    shadowCameraNear: 0.5,
    shadowCameraFar: 80,
  },
];

/** 0x8ed1ef sky, and the 30/180 linear fog tuned for the environment GLB's real footprint. */
export const DEFAULT_WORLD: WorldEnvConfig = {
  backgroundMode: "color",
  backgroundColor: [0.557, 0.82, 0.937],
  backgroundTexture: "",
  backgroundBlurriness: 0,
  backgroundIntensity: 1,
  environmentSource: "none",
  environmentIntensity: 1,
  fogMode: "linear",
  fogColor: [0.557, 0.82, 0.937],
  fogNear: 30,
  fogFar: 180,
  fogDensity: 0.01,
  toneMapping: "none",
  toneMappingExposure: 1,
  shadowsEnabled: true,
  shadowType: "pcfsoft",
};

export function defaultSceneEnv(): SceneEnvData {
  return cloneSceneEnv({
    version: 1,
    camera: DEFAULT_CAMERA,
    ambient: DEFAULT_AMBIENT,
    directionals: DEFAULT_DIRECTIONALS,
    world: DEFAULT_WORLD,
  });
}

/**
 * Deep copy.
 *
 * Load, snapshot-for-undo, and serialize-for-save all need one, and all
 * three are wrong with a shallow copy: the nested arrays (`offset`, every
 * colour triple, the directional list) would stay shared with the live
 * config and an "undo" would restore the state it was supposed to reverse.
 * Small enough that structural cloning by hand isn't worth it over JSON.
 */
export function cloneSceneEnv<T>(data: T): T {
  return JSON.parse(JSON.stringify(data)) as T;
}
