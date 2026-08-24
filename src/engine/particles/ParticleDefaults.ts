import type {
  ColorOverLifetimeModule,
  CollisionModule,
  EmissionModule,
  ForceModule,
  LimitVelocityModule,
  LodModule,
  MainModule,
  NoiseModule,
  ParticleEmitterConfig,
  RendererModule,
  RotationModule,
  ScalarRange,
  ShapeModule,
  SizeOverLifetimeModule,
  SubEmitterModule,
  TextureSheetModule,
  TrailModule,
  Vector3Range,
  VelocityModule,
} from "./ParticleTypes";

/**
 * Complete default values for every module, and the normalizer that turns
 * a *partial* config (a preset, a hand-edited particles.json, a file
 * written by an older version of the editor) into a complete one.
 *
 * ## Why normalization rather than optional fields everywhere
 *
 * The alternative is making every field on every module optional and
 * writing `?? default` at each read site. That pushes a default into the
 * hot loop (a `??` per particle per frame), scatters the same constant
 * across many files, and makes it impossible to answer "what is this
 * effect actually configured as" without mentally applying dozens of
 * fallbacks.
 *
 * Normalizing once at load means the simulation, the renderer, and the
 * Inspector all read plain required fields. It's also what makes a preset
 * a genuinely small object — `{ main: { startSpeed: {min: 2, max: 5} } }`
 * is a valid preset, and every other value comes from here.
 *
 * A missing field added in a later version therefore appears with its
 * default on the next load rather than as `undefined`, which is the
 * forward-compatibility story `ParticlesFileData.version` exists to
 * support.
 */

let idCounter = 0;

/** Short, collision-resistant id. Same shape and reasoning as Collider's own — readable in a JSON diff, unique enough for a file that holds tens of records. */
export function newParticleId(prefix = "ps"): string {
  idCounter++;
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${(Date.now() % 46656).toString(36)}${idCounter.toString(36)}`;
}

const range = (min: number, max = min): ScalarRange => ({ min, max });
const vec3Range = (x: number, y: number, z: number): Vector3Range => ({ x: range(x), y: range(y), z: range(z) });

export function defaultMain(): MainModule {
  return {
    duration: 5,
    loop: true,
    prewarm: false,
    startDelay: range(0),
    startLifetime: range(1, 2),
    startSpeed: range(1, 2),
    startSize: range(0.3, 0.5),
    startRotation: range(0),
    startColor: [1, 1, 1],
    startAlpha: range(1),
    gravityModifier: 0,
    simulationSpace: "local",
    simulationSpeed: 1,
    // 200 rather than a round 1000: a default that's too generous hides
    // the fact that maxParticles is a real budget, and every effect that
    // needs more is one field away from having it.
    maxParticles: 200,
    seed: 12345,
    autoRandomSeed: true,
    playOnStart: true,
  };
}

export function defaultEmission(): EmissionModule {
  return { enabled: true, rateOverTime: range(20), bursts: [] };
}

export function defaultShape(): ShapeModule {
  return {
    enabled: true,
    kind: "cone",
    boxSize: [1, 1, 1],
    radius: 0.3,
    radiusThickness: 1,
    coneAngle: 20,
    coneHeight: 0,
    arc: 360,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    randomizeDirection: 0,
    alignToDirection: false,
  };
}

export function defaultVelocity(): VelocityModule {
  return { enabled: false, linear: vec3Range(0, 0, 0), orbital: range(0), radial: range(0), space: "local" };
}

export function defaultForce(): ForceModule {
  return { enabled: false, force: vec3Range(0, 0, 0), drag: 0 };
}

export function defaultLimitVelocity(): LimitVelocityModule {
  return { enabled: false, speedLimit: 5, dampen: 0.5 };
}

export function defaultNoise(): NoiseModule {
  return { enabled: false, strength: 1, frequency: 0.5, scrollSpeed: 0.5, octaves: 1, damping: 0.5 };
}

export function defaultColorOverLifetime(): ColorOverLifetimeModule {
  return {
    enabled: true,
    // White, fading out. The single most common gradient by a wide margin,
    // and it makes a freshly-created emitter look finished rather than
    // like a block of hard-edged squares that pop out of existence.
    gradient: [
      { t: 0, color: [1, 1, 1], alpha: 0 },
      { t: 0.15, color: [1, 1, 1], alpha: 1 },
      { t: 1, color: [1, 1, 1], alpha: 0 },
    ],
  };
}

export function defaultSizeOverLifetime(): SizeOverLifetimeModule {
  return { enabled: false, curve: [{ t: 0, v: 1 }, { t: 1, v: 0 }] };
}

export function defaultRotation(): RotationModule {
  return { enabled: false, angularVelocity: range(0) };
}

export function defaultTextureSheet(): TextureSheetModule {
  return { enabled: false, tilesX: 1, tilesY: 1, mode: "lifetime", fps: 30, cycles: 1, startFrame: 0, startFrameRandom: false };
}

export function defaultRenderer(): RendererModule {
  return {
    mode: "billboard",
    texturePath: "",
    blending: "normal",
    opacity: 1,
    renderOrder: 0,
    // Particles are transparent; writing depth makes them occlude each
    // other in draw order, which is almost never what's wanted and is the
    // classic "why are my particles cutting holes in each other" bug.
    depthWrite: false,
    depthTest: true,
    softParticles: false,
    softFadeDistance: 0.5,
    stretchFactor: 0.1,
    pivot: [0, 0],
    sortMode: "none",
    meshPath: "",
  };
}

export function defaultTrails(): TrailModule {
  return {
    enabled: false,
    ratio: 1,
    lifetime: 0.4,
    minVertexDistance: 0.1,
    maxPoints: 16,
    widthStart: 0.1,
    widthEnd: 0,
    inheritParticleColor: true,
    color: [1, 1, 1],
  };
}

export function defaultCollision(): CollisionModule {
  return { enabled: false, planeY: 0, bounce: 0.4, lifetimeLoss: 0, friction: 0.8, killOnContact: false };
}

export function defaultSubEmitters(): SubEmitterModule {
  return { enabled: false, entries: [] };
}

export function defaultLod(): LodModule {
  return { enabled: false, cullDistance: 0, lowQualityScale: 0.35, mediumQualityScale: 0.65 };
}

/** A complete, immediately-playable emitter config. What "+ Emitter" in the editor creates. */
export function defaultEmitterConfig(name = "Emitter"): ParticleEmitterConfig {
  return {
    id: newParticleId("em"),
    name,
    enabled: true,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    attachPath: "",
    attachName: "",
    main: defaultMain(),
    emission: defaultEmission(),
    shape: defaultShape(),
    velocity: defaultVelocity(),
    force: defaultForce(),
    limitVelocity: defaultLimitVelocity(),
    noise: defaultNoise(),
    colorOverLifetime: defaultColorOverLifetime(),
    sizeOverLifetime: defaultSizeOverLifetime(),
    rotation_: defaultRotation(),
    textureSheet: defaultTextureSheet(),
    renderer: defaultRenderer(),
    trails: defaultTrails(),
    collision: defaultCollision(),
    subEmitters: defaultSubEmitters(),
    lod: defaultLod(),
  };
}

/** A recursively-partial view of a config — the shape a preset or a hand-written JSON entry is allowed to take. */
export type PartialEmitterConfig = {
  [K in keyof ParticleEmitterConfig]?: ParticleEmitterConfig[K] extends object ? Partial<ParticleEmitterConfig[K]> : ParticleEmitterConfig[K];
};

/**
 * Fills a partial config out to a complete one.
 *
 * Merges one level into each module, which is exactly the depth the config
 * has: a module is a flat bag of primitives, arrays, and small tuples.
 * Arrays (`gradient`, `curve`, `bursts`, `entries`) and tuples
 * (`startColor`, `boxSize`) are **replaced wholesale rather than merged
 * element-wise** — a preset supplying a 2-stop gradient means that
 * gradient, not its first two stops overlaid on the default's three, which
 * is what an element-wise merge would silently produce.
 */
export function normalizeEmitterConfig(partial: PartialEmitterConfig | undefined, fallbackName = "Emitter"): ParticleEmitterConfig {
  const base = defaultEmitterConfig(fallbackName);
  if (!partial) return base;

  const merged: ParticleEmitterConfig = {
    ...base,
    id: partial.id ?? base.id,
    name: partial.name ?? fallbackName,
    enabled: partial.enabled ?? base.enabled,
    position: (partial.position as [number, number, number]) ?? base.position,
    rotation: (partial.rotation as [number, number, number]) ?? base.rotation,
    scale: (partial.scale as [number, number, number]) ?? base.scale,
    attachPath: partial.attachPath ?? base.attachPath,
    attachName: partial.attachName ?? base.attachName,
    main: { ...base.main, ...partial.main },
    emission: { ...base.emission, ...partial.emission },
    shape: { ...base.shape, ...partial.shape },
    velocity: { ...base.velocity, ...partial.velocity },
    force: { ...base.force, ...partial.force },
    limitVelocity: { ...base.limitVelocity, ...partial.limitVelocity },
    noise: { ...base.noise, ...partial.noise },
    colorOverLifetime: { ...base.colorOverLifetime, ...partial.colorOverLifetime },
    sizeOverLifetime: { ...base.sizeOverLifetime, ...partial.sizeOverLifetime },
    rotation_: { ...base.rotation_, ...partial.rotation_ },
    textureSheet: { ...base.textureSheet, ...partial.textureSheet },
    renderer: { ...base.renderer, ...partial.renderer },
    trails: { ...base.trails, ...partial.trails },
    collision: { ...base.collision, ...partial.collision },
    subEmitters: { ...base.subEmitters, ...partial.subEmitters },
    lod: { ...base.lod, ...partial.lod },
  };

  // Clamp the values whose out-of-range forms are genuinely broken rather
  // than merely odd: a zero-capacity buffer can never emit, and a
  // non-positive duration divides by zero in the loop check.
  merged.main.maxParticles = Math.max(1, Math.min(100000, Math.floor(merged.main.maxParticles)));
  merged.main.duration = Math.max(0.01, merged.main.duration);
  merged.main.simulationSpeed = Math.max(0, merged.main.simulationSpeed);
  merged.textureSheet.tilesX = Math.max(1, Math.floor(merged.textureSheet.tilesX));
  merged.textureSheet.tilesY = Math.max(1, Math.floor(merged.textureSheet.tilesY));
  merged.trails.maxPoints = Math.max(2, Math.min(128, Math.floor(merged.trails.maxPoints)));

  // Deep-copied on the way out, and this is load-bearing rather than
  // defensive tidiness. The spreads above copy each *module* but carry the
  // arrays inside them (gradient, curve, bursts, entries) and the tuples
  // (startColor, boxSize, pivot) through by reference — straight from
  // `partial`, which is either a literal in the shared PARTICLE_PRESETS
  // table or the cached particles.json module object. Without this copy,
  // two effects built from one preset shared a gradient array, so editing
  // one recoloured the other *and* permanently mutated the preset for the
  // rest of the session; loading from JSON mutated the imported module.
  // Normalization runs at load/create time only, never per frame, so the
  // copy costs nothing that matters.
  return cloneEmitterConfig(merged);
}

/** Deep structural copy. Used by duplicate() and by preset instantiation, so two emitters built from one preset never share a gradient array. */
export function cloneEmitterConfig(config: ParticleEmitterConfig): ParticleEmitterConfig {
  return {
    ...config,
    position: [...config.position] as [number, number, number],
    rotation: [...config.rotation] as [number, number, number],
    scale: [...config.scale] as [number, number, number],
    main: { ...config.main, startColor: [...config.main.startColor] as [number, number, number] },
    emission: { ...config.emission, bursts: config.emission.bursts.map((b) => ({ ...b, count: { ...b.count } })) },
    shape: {
      ...config.shape,
      boxSize: [...config.shape.boxSize] as [number, number, number],
      position: [...config.shape.position] as [number, number, number],
      rotation: [...config.shape.rotation] as [number, number, number],
      scale: [...config.shape.scale] as [number, number, number],
    },
    velocity: { ...config.velocity, linear: { x: { ...config.velocity.linear.x }, y: { ...config.velocity.linear.y }, z: { ...config.velocity.linear.z } } },
    force: { ...config.force, force: { x: { ...config.force.force.x }, y: { ...config.force.force.y }, z: { ...config.force.force.z } } },
    limitVelocity: { ...config.limitVelocity },
    noise: { ...config.noise },
    colorOverLifetime: { ...config.colorOverLifetime, gradient: config.colorOverLifetime.gradient.map((g) => ({ ...g, color: [...g.color] as [number, number, number] })) },
    sizeOverLifetime: { ...config.sizeOverLifetime, curve: config.sizeOverLifetime.curve.map((k) => ({ ...k })) },
    rotation_: { ...config.rotation_ },
    textureSheet: { ...config.textureSheet },
    renderer: { ...config.renderer, pivot: [...config.renderer.pivot] as [number, number] },
    trails: { ...config.trails, color: [...config.trails.color] as [number, number, number] },
    collision: { ...config.collision },
    subEmitters: { ...config.subEmitters, entries: config.subEmitters.entries.map((e) => ({ ...e })) },
    lod: { ...config.lod },
  };
}
