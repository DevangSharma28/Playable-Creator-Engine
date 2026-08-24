/**
 * Shared vocabulary for the ION Particle & VFX system — the module config
 * shapes, the serialized form that ships in src/game/particles.json, and
 * the small value types (ranges, curves, gradients) every module is built
 * from.
 *
 * Same split, and the same reasoning, as collision/ColliderTypes.ts: this
 * file is pure data with no behavior and no THREE import beyond types, so
 * both the runtime and the editor can agree on the shape of an effect
 * without either one importing the other.
 *
 * **Everything is plain JSON-serializable data.** No Vector3, no Color, no
 * Texture — an effect's *configuration* is what gets persisted and what the
 * editor edits; the live particles it produces are never serialized (see
 * ParticleSerialization.ts). That's what lets a preset be a literal object
 * and a saved effect be a diffable file.
 */

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

/**
 * A number that may be a constant or a random range.
 *
 * Stored as two numbers rather than a tagged union so sampling is
 * branch-free in the hot path: `min === max` *is* the constant case, and
 * `lerp(min, max, rand())` collapses to `min` for free. A tagged union
 * would put an `if` inside a loop that runs once per particle per spawn.
 */
export interface ScalarRange {
  min: number;
  max: number;
}

/** One key on a curve. `t` is normalized 0..1 (lifetime position, usually). */
export interface CurveKey {
  t: number;
  v: number;
}

/** One stop on a color gradient. RGB is 0..1 linear, matching THREE.Color's own range. */
export interface GradientKey {
  t: number;
  color: [number, number, number];
  alpha: number;
}

/** A per-axis random range — start velocity, constant force, and anything else with independent X/Y/Z. */
export interface Vector3Range {
  x: ScalarRange;
  y: ScalarRange;
  z: ScalarRange;
}

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** The three emission volumes. Deliberately small, same principle as ColliderShape — each one has a cheap, well-defined surface/volume sampling function (see ParticleShapes.ts). */
export type EmitterShapeKind = "box" | "sphere" | "cone";

/**
 * Where a particle's position is integrated.
 *
 * `local` — particles live in the emitter's own space and move with it, so
 * rotating the emitter drags its existing particles along. Right for a
 * torch flame attached to a moving hand.
 *
 * `world` — particles are released into world space and the emitter's
 * later movement doesn't touch them. Right for exhaust, smoke trails, and
 * anything that should be left behind.
 */
export type SimulationSpace = "local" | "world";

/**
 * How a particle is turned into geometry.
 *
 * `billboard` — always faces the camera. The cheap default.
 * `velocity` — billboard rotated so its local +Y follows the velocity.
 * `stretched` — velocity-aligned *and* scaled along it by speed, for
 *   sparks and rain.
 * `mesh` — instances a real geometry instead of a quad.
 */
export type ParticleRenderMode = "billboard" | "velocity" | "stretched" | "mesh";

/** Maps 1:1 onto THREE's blending constants — resolved in ParticleMaterial so this file stays THREE-free. */
export type ParticleBlendMode = "normal" | "additive" | "multiply";

/** What drives the flipbook's frame index. */
export type TextureSheetMode = "lifetime" | "speed" | "fps";

/** When a sub-emitter fires. */
export type SubEmitterTrigger = "birth" | "death" | "collision";

/** Which end of the effect a sort applies to, when the renderer sorts at all. */
export type ParticleSortMode = "none" | "byDistance" | "oldestFirst" | "youngestFirst";

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

/**
 * The always-on module. Everything here applies to every particle at spawn
 * and has no `enabled` flag, because an emitter without a lifetime or a
 * max-particle cap isn't a cheaper emitter, it's a broken one.
 */
export interface MainModule {
  /** Seconds of emission before the system stops (or loops). */
  duration: number;
  loop: boolean;
  /** Start mid-cycle, as though the system had already been running for `duration`. Costs one extra simulated warm-up at play() time — see ParticleEmitter.prewarmNow. */
  prewarm: boolean;
  /** Seconds to wait after play() before the first particle. */
  startDelay: ScalarRange;
  startLifetime: ScalarRange;
  /** Initial speed along whatever direction the shape module produced. */
  startSpeed: ScalarRange;
  startSize: ScalarRange;
  /** Degrees. */
  startRotation: ScalarRange;
  startColor: [number, number, number];
  startAlpha: ScalarRange;
  /** Convenience shortcut for a downward constant force — additive with the Force module's own vector. */
  gravityModifier: number;
  simulationSpace: SimulationSpace;
  /** Multiplies dt for this system only. 0 freezes it; 2 runs it double-time. */
  simulationSpeed: number;
  /** Hard ceiling on live particles. The buffer is allocated to exactly this, once — see ParticleBuffer. */
  maxParticles: number;
  /** Deterministic seed. Same seed + same dt sequence = same effect, every time. */
  seed: number;
  /** Re-seed from Math.random() on every play(), so repeated one-shots don't look identical. */
  autoRandomSeed: boolean;
  /** Start emitting as soon as the effect is loaded, without a script calling play(). */
  playOnStart: boolean;
}

export interface Burst {
  /** Seconds into the cycle. */
  time: number;
  count: ScalarRange;
  /** How many times this burst repeats within one cycle. */
  cycles: number;
  /** Seconds between repeats. */
  interval: number;
  /** 0..1 — rolled per cycle, so a burst can be made occasional without a script. */
  probability: number;
}

export interface EmissionModule {
  enabled: boolean;
  /** Particles per second, continuous. */
  rateOverTime: ScalarRange;
  bursts: Burst[];
}

export interface ShapeModule {
  enabled: boolean;
  kind: EmitterShapeKind;
  /** Box only — full extents, not half. */
  boxSize: [number, number, number];
  /** Sphere and cone. */
  radius: number;
  /** 0 = emit from the surface shell only, 1 = the whole solid volume. */
  radiusThickness: number;
  /** Cone only — degrees from the axis. */
  coneAngle: number;
  /** Cone only — emission is spread along this much of the cone's axis. */
  coneHeight: number;
  /** Degrees of the shape's circumference actually used. 360 is the whole thing. */
  arc: number;
  /** The shape's own offset within the emitter. */
  position: [number, number, number];
  /** Degrees. */
  rotation: [number, number, number];
  scale: [number, number, number];
  /** 0..1 blend from the shape's natural outward direction toward a fully random one. */
  randomizeDirection: number;
  /** Spawn the particle already rotated to face its own velocity. */
  alignToDirection: boolean;
}

export interface VelocityModule {
  enabled: boolean;
  /** Added to the shape's own directional velocity. */
  linear: Vector3Range;
  /** Radians/sec around the emitter's Y axis. */
  orbital: ScalarRange;
  /** Outward from the emitter's center, units/sec. */
  radial: ScalarRange;
  /** Whether `linear` is read in emitter space or world space. */
  space: SimulationSpace;
}

export interface ForceModule {
  enabled: boolean;
  force: Vector3Range;
  /** Velocity is multiplied by (1 - drag*dt) each step. 0 = no drag. */
  drag: number;
}

export interface LimitVelocityModule {
  enabled: boolean;
  /** Speed ceiling, units/sec. */
  speedLimit: number;
  /** 0..1 — how hard speed above the limit is pulled back per second. 1 clamps immediately. */
  dampen: number;
}

export interface NoiseModule {
  enabled: boolean;
  /** Peak displacement contribution, units/sec. */
  strength: number;
  /** Spatial frequency — higher is more turbulent detail. */
  frequency: number;
  /** How fast the noise field itself drifts, units/sec. */
  scrollSpeed: number;
  /** 1 is a single smooth field; 2-3 adds finer detail at real cost. */
  octaves: number;
  /** Amplitude multiplier per extra octave. */
  damping: number;
}

export interface ColorOverLifetimeModule {
  enabled: boolean;
  gradient: GradientKey[];
}

export interface SizeOverLifetimeModule {
  enabled: boolean;
  curve: CurveKey[];
}

export interface RotationModule {
  enabled: boolean;
  /** Degrees/sec. */
  angularVelocity: ScalarRange;
}

export interface TextureSheetModule {
  enabled: boolean;
  tilesX: number;
  tilesY: number;
  mode: TextureSheetMode;
  /** `fps` mode only. */
  fps: number;
  /** How many times the sheet plays across one particle's life, in `lifetime` mode. */
  cycles: number;
  /** 0..1 into the sheet — randomized per particle when startFrameRandom is set. */
  startFrame: number;
  startFrameRandom: boolean;
}

export interface RendererModule {
  mode: ParticleRenderMode;
  /** Asset path, resolved through the game's AssetLoader — see ParticleMaterial.resolveTexture. Empty means the built-in soft dot. */
  texturePath: string;
  blending: ParticleBlendMode;
  /** Multiplies every particle's alpha. */
  opacity: number;
  /** THREE renderOrder on the emitter's mesh. */
  renderOrder: number;
  depthWrite: boolean;
  depthTest: boolean;
  /** Fades particles as they approach opaque geometry. Costs a depth-texture read per fragment — off by default. */
  softParticles: boolean;
  softFadeDistance: number;
  /** `stretched` only — extra length per unit of speed. */
  stretchFactor: number;
  /** Shifts the quad off its center, in units of its own size. */
  pivot: [number, number];
  sortMode: ParticleSortMode;
  /** `mesh` mode only — asset path of a GLB whose first mesh is instanced. */
  meshPath: string;
}

export interface TrailModule {
  enabled: boolean;
  /** 0..1 — fraction of particles that get a trail. */
  ratio: number;
  /** Seconds a trail point survives after the particle passes it. */
  lifetime: number;
  /** Minimum world distance before a new point is recorded — the main cost control. */
  minVertexDistance: number;
  /** Per-trail point cap. Total trail memory is ratio * maxParticles * this. */
  maxPoints: number;
  widthStart: number;
  widthEnd: number;
  /** Inherit the particle's own color-over-lifetime instead of using the flat color below. */
  inheritParticleColor: boolean;
  color: [number, number, number];
}

export interface CollisionModule {
  enabled: boolean;
  /** World Y of the single collision plane. A real depth/collider query is deliberately not attempted — see ParticleSimulation's own note. */
  planeY: number;
  /** 0..1 — fraction of the normal velocity retained on bounce. */
  bounce: number;
  /** 0..1 — fraction of remaining lifetime lost per bounce. */
  lifetimeLoss: number;
  /** 0..1 — tangential velocity retained (1 = frictionless). */
  friction: number;
  /** Kill the particle on first contact instead of bouncing. */
  killOnContact: boolean;
}

export interface SubEmitterEntry {
  trigger: SubEmitterTrigger;
  /** Name of another emitter in the same ParticleSystem. */
  emitter: string;
  /** How many particles to emit per trigger. */
  count: number;
  /** 0..1, rolled per trigger. */
  probability: number;
  /** 0..1 — how much of the parent particle's velocity the child inherits. */
  inheritVelocity: number;
}

export interface SubEmitterModule {
  enabled: boolean;
  entries: SubEmitterEntry[];
}

/**
 * Automatic quality scaling. The same effect authored once should be able
 * to run on a low-end phone without a second copy of it existing — see
 * ParticleManager.setQuality.
 */
export interface LodModule {
  enabled: boolean;
  /** Beyond this world distance from the camera the emitter stops simulating entirely. 0 disables the check. */
  cullDistance: number;
  /** Multiplies rate and burst counts on the low quality tier. */
  lowQualityScale: number;
  /** Multiplies rate and burst counts on the medium tier. */
  mediumQualityScale: number;
}

// ---------------------------------------------------------------------------
// The effect
// ---------------------------------------------------------------------------

/**
 * One emitter's complete configuration — everything the editor edits and
 * everything that ships in particles.json.
 *
 * Every optional module carries its own `enabled`, and the simulation
 * genuinely skips a disabled module's whole pass rather than evaluating it
 * with neutral values (see ParticleSimulation.step). That's what keeps "a
 * simple emitter stays extremely cheap" true rather than aspirational.
 */
export interface ParticleEmitterConfig {
  id: string;
  name: string;
  enabled: boolean;
  /** Local transform within the PARTICLES group, or relative to `attachPath` when attached. */
  position: [number, number, number];
  /** Degrees. */
  rotation: [number, number, number];
  scale: [number, number, number];
  /** Scene path of an object this emitter follows, "" for a free-standing emitter. Same format and same resolution rules as ColliderData.attachPath. */
  attachPath: string;
  attachName: string;

  main: MainModule;
  emission: EmissionModule;
  shape: ShapeModule;
  velocity: VelocityModule;
  force: ForceModule;
  limitVelocity: LimitVelocityModule;
  noise: NoiseModule;
  colorOverLifetime: ColorOverLifetimeModule;
  sizeOverLifetime: SizeOverLifetimeModule;
  rotation_: RotationModule;
  textureSheet: TextureSheetModule;
  renderer: RendererModule;
  trails: TrailModule;
  collision: CollisionModule;
  subEmitters: SubEmitterModule;
  lod: LodModule;
}

/** A named group of emitters played together — what gameplay actually calls play() on. */
export interface ParticleSystemConfig {
  id: string;
  name: string;
  emitters: ParticleEmitterConfig[];
}

/** The whole file. `version` carries the same purpose it does in colliders.json/mainLayout.json. */
export interface ParticlesFileData {
  version: number;
  systems: ParticleSystemConfig[];
}

/** Live counters for the Inspector's diagnostics panel. */
export interface ParticleStats {
  systems: number;
  emitters: number;
  activeParticles: number;
  maxParticles: number;
  /** Emitters currently simulating — i.e. playing, enabled, and not LOD-culled. */
  simulating: number;
  drawCalls: number;
  /** Bytes held by every particle buffer and instanced attribute currently allocated. */
  bufferBytes: number;
  /** Milliseconds spent inside the last update() — measured, not estimated. */
  lastUpdateMs: number;
}
