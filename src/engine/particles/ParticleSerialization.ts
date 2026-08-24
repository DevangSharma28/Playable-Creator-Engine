import type * as THREE from "three";
import type { ParticleManager } from "./ParticleManager";
import type { ParticleSystem } from "./ParticleSystem";
import { cloneEmitterConfig, normalizeEmitterConfig, type PartialEmitterConfig } from "./ParticleDefaults";
import type { ParticleEmitterConfig, ParticlesFileData, ParticleSystemConfig } from "./ParticleTypes";
import { resolveSceneObject, sceneObjectPath } from "../SceneBindings";

/**
 * The bridge between src/game/particles.json and a live ParticleManager.
 *
 * Same shape and the same reasoning as ColliderSerialization.ts: the JSON
 * is a real import in the module graph, so what's authored in the 3D
 * editor is what ships — no export step — and attachments are recorded by
 * *scene path* rather than uuid, because three regenerates uuids on every
 * GLB parse.
 *
 * **The configuration is serialized; the particles never are.** A saved
 * effect is its emitter configs and nothing else — no positions, no ages,
 * no live buffer state. That's what makes particles.json a small, diffable
 * file that describes an effect rather than a snapshot of one mid-play,
 * and it's why `loadParticles` produces an effect that starts from its own
 * beginning rather than resuming from wherever it was when someone hit
 * save.
 *
 * `loadParticles` runs in production; only `systemToData` (the save
 * direction) is exclusively the editor's.
 */

/**
 * Builds every system in `data` into `manager`, resolving each emitter's
 * attachment against `scene`.
 *
 * Call it once the scene graph is assembled, for exactly the reason
 * `loadColliders` must be: an attachment is a scene path and can only
 * resolve against a graph that already contains the object. In practice
 * that means *after* the entities are constructed, not merely after the
 * environment GLB — attaching an effect to a character is the most useful
 * thing anyone does with this, and a character doesn't exist until its
 * entity built it.
 *
 * An emitter whose attachment no longer resolves is still created, as a
 * free-standing emitter at its recorded transform, and warns in dev —
 * silently dropping it would make a renamed GLB node look like the VFX
 * system had stopped working.
 */
export function loadParticles(manager: ParticleManager, data: ParticlesFileData, scene: THREE.Scene): ParticleSystem[] {
  const built: ParticleSystem[] = [];
  for (const record of data.systems ?? []) {
    const config: ParticleSystemConfig = {
      id: record.id,
      name: record.name,
      emitters: (record.emitters ?? []).map((emitter, index) => normalizeEmitterConfig(emitter as PartialEmitterConfig, emitter?.name ?? `Emitter ${index + 1}`)),
    };
    const system = manager.create(config);

    for (const emitter of system.all) {
      emitter.persisted = true;
      const settings = emitter.settings;
      if (!settings.attachPath && !settings.attachName) continue;
      const target = resolveSceneObject(scene, {
        className: "",
        fieldName: "",
        objectPath: settings.attachPath,
        objectName: settings.attachName,
      });
      if (target) {
        emitter.attached = target;
      } else if (import.meta.env.DEV) {
        console.warn(`Particles: "${settings.name}" is attached to "${settings.attachPath || settings.attachName}", which no longer resolves — loading it free-standing instead.`);
      }
    }
    built.push(system);
  }
  return built;
}

/**
 * The save direction — a live system back into its persisted record.
 *
 * Reads each emitter's *config* rather than its runtime state, and
 * re-derives the attachment path from the live object so a target that was
 * re-parented in the editor is written out at its new location rather than
 * its old one.
 */
export function systemToData(system: ParticleSystem, scene: THREE.Scene): ParticleSystemConfig {
  return {
    id: system.id,
    name: system.name,
    emitters: system.all
      .filter((emitter) => emitter.persisted)
      .map((emitter) => {
        // A gizmo drag writes the node, not the config — fold it back
        // before reading, the same two-way sync colliders do.
        emitter.adoptNodeTransform();
        const config = cloneEmitterConfig(emitter.settings);
        config.attachPath = emitter.attached ? sceneObjectPath(emitter.attached, scene) : "";
        config.attachName = emitter.attached?.name ?? "";
        return roundConfig(config);
      }),
  };
}

/** Every system the editor owns, as one file's worth of records. */
export function serializeParticles(manager: ParticleManager, scene: THREE.Scene): ParticleSystemConfig[] {
  return manager.all.map((system) => systemToData(system, scene)).filter((record) => record.emitters.length > 0);
}

/**
 * Rounds the float fields a gizmo or a slider produces.
 *
 * Same reasoning as ColliderSerialization's own `r()`: raw transform
 * output is full float noise ("2.0000000000000004"), and a diff on
 * particles.json should show what a person changed, not float dust. Only
 * the fields that actually come from continuous input are rounded —
 * rounding a gradient's alpha to 4 places is free, rounding an integer
 * count would be pointless.
 */
function roundConfig(config: ParticleEmitterConfig): ParticleEmitterConfig {
  config.position = config.position.map(r4) as [number, number, number];
  config.rotation = config.rotation.map(r4) as [number, number, number];
  config.scale = config.scale.map(r4) as [number, number, number];
  config.shape.position = config.shape.position.map(r4) as [number, number, number];
  config.shape.rotation = config.shape.rotation.map(r4) as [number, number, number];
  config.shape.scale = config.shape.scale.map(r4) as [number, number, number];
  config.shape.boxSize = config.shape.boxSize.map(r4) as [number, number, number];
  config.shape.radius = r4(config.shape.radius);
  config.main.startColor = config.main.startColor.map(r4) as [number, number, number];
  for (const key of config.colorOverLifetime.gradient) {
    key.t = r4(key.t);
    key.alpha = r4(key.alpha);
    key.color = key.color.map(r4) as [number, number, number];
  }
  for (const key of config.sizeOverLifetime.curve) {
    key.t = r4(key.t);
    key.v = r4(key.v);
  }
  return config;
}

function r4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
