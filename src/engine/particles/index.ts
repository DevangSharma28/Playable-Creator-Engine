/**
 * The ION Particle & VFX system's public surface.
 *
 * Game code should import from here rather than reaching into individual
 * files — same convention as `engine/collision/index.ts`, and the same
 * benefit: the internal file layout can change (a different renderer, a
 * split simulation) without touching a single import in `src/game/`.
 *
 * The runtime ships. The *editor* for it (`engine/editor/EditorParticles`,
 * `engine/editor/ParticleVisuals`) lives under `editor/` and tree-shakes
 * out of a production build with the rest of that tree — exactly the split
 * the collision system uses.
 */

export { ParticleManager, PARTICLES_GROUP_NAME, type ParticleQuality } from "./ParticleManager";
export { ParticleSystem } from "./ParticleSystem";
export { ParticleEmitter } from "./ParticleEmitter";
export { ParticleBuffer } from "./ParticleBuffer";
export { ParticleRandom, constant, between, evaluateCurve, evaluateGradient, valueNoise3 } from "./ParticleRandom";
export { ParticleSimulation, type ParticleEvents } from "./ParticleSimulation";
export { ParticleRenderer } from "./ParticleRenderer";
export { ParticleTrails } from "./ParticleTrails";
export { sampleShape, randomizeDirection } from "./ParticleShapes";
export { getDefaultParticleTexture, disposeDefaultParticleTexture } from "./ParticleMaterial";

export {
  defaultEmitterConfig,
  normalizeEmitterConfig,
  cloneEmitterConfig,
  newParticleId,
  type PartialEmitterConfig,
} from "./ParticleDefaults";

export { PARTICLE_PRESETS, getPreset, createSystemFromPreset, createEmptySystem, type ParticlePreset } from "./ParticlePresets";
export { loadParticles, systemToData, serializeParticles } from "./ParticleSerialization";

export type {
  ParticleEmitterConfig,
  ParticleSystemConfig,
  ParticlesFileData,
  ParticleStats,
  EmitterShapeKind,
  SimulationSpace,
  ParticleRenderMode,
  ParticleBlendMode,
  ParticleSortMode,
  TextureSheetMode,
  SubEmitterTrigger,
  ScalarRange,
  CurveKey,
  GradientKey,
  Vector3Range,
  MainModule,
  EmissionModule,
  Burst,
  ShapeModule,
  VelocityModule,
  ForceModule,
  LimitVelocityModule,
  NoiseModule,
  ColorOverLifetimeModule,
  SizeOverLifetimeModule,
  RotationModule,
  TextureSheetModule,
  RendererModule,
  TrailModule,
  CollisionModule,
  SubEmitterModule,
  SubEmitterEntry,
  LodModule,
} from "./ParticleTypes";
