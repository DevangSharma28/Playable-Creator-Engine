import { cloneSceneEnv, defaultSceneEnv } from "./SceneEnvDefaults";
import type { DirectionalLightConfig, SceneEnvData } from "./SceneEnvTypes";

/**
 * Reads src/game/environment.json into a complete SceneEnvData.
 *
 * Field-by-field merge over the defaults rather than a cast, for the same
 * reason the collider and particle loaders validate: the file is hand-
 * editable and outlives the code that wrote it. A config saved before a
 * setting existed simply picks up that setting's default instead of
 * arriving as `undefined` and turning into a NaN somewhere inside a shader
 * uniform three frames later.
 */
export function loadSceneEnv(raw: unknown): SceneEnvData {
  const defaults = defaultSceneEnv();
  if (!raw || typeof raw !== "object") return defaults;
  const data = raw as Partial<SceneEnvData>;

  const directionals: DirectionalLightConfig[] = Array.isArray(data.directionals)
    ? data.directionals.map((entry, index) => ({
        ...cloneSceneEnv(defaults.directionals[0]),
        ...(entry as object),
        // An entry with no id can never be addressed by the editor or a
        // history command, so give it a stable one derived from position
        // rather than dropping the light.
        id: (entry as DirectionalLightConfig)?.id || `dir_${index}`,
      }))
    : defaults.directionals;

  return {
    version: 1,
    camera: { ...defaults.camera, ...(data.camera as object) },
    ambient: { ...defaults.ambient, ...(data.ambient as object) },
    directionals,
    world: { ...defaults.world, ...(data.world as object) },
  };
}

/** JSON-ready form, for POST /save-environment. A plain deep copy — every field in the config is authored, so there's nothing to filter out. */
export function serializeSceneEnv(data: SceneEnvData): SceneEnvData {
  return cloneSceneEnv(data);
}
