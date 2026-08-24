import { newParticleId, normalizeEmitterConfig, type PartialEmitterConfig } from "./ParticleDefaults";
import type { ParticleSystemConfig, ScalarRange } from "./ParticleTypes";

/**
 * Reusable starter effects, as **data**.
 *
 * Every preset here is a partial config merged over
 * `defaultEmitterConfig()` — not a class, not a factory with behavior, and
 * deliberately not tied to any gameplay concept. "Coin Burst" describes a
 * look (small bright specks thrown upward with gravity), not a coin: the
 * engine has no idea this game has coins, and a different playable using
 * the same preset for a gem or a star is the normal case.
 *
 * That's the same boundary `src/engine/` holds everywhere else — a preset
 * is a *configuration* a game may instantiate, so it belongs to the engine;
 * deciding that collecting a coin plays it belongs to the game.
 *
 * Presets that need more than one emitter (an explosion is a flash *and*
 * debris *and* smoke) declare several, and sub-emitter wiring between them
 * is expressed by name exactly as it would be in a saved file.
 */

const r = (min: number, max = min): ScalarRange => ({ min, max });

export interface ParticlePreset {
  /** Stable key — what `createFromPreset` takes and what the editor's preset list shows. */
  key: string;
  label: string;
  /** One line, shown in the editor's preset picker. */
  description: string;
  emitters: { name: string; config: PartialEmitterConfig }[];
}

export const PARTICLE_PRESETS: ParticlePreset[] = [
  {
    key: "smoke",
    label: "Smoke",
    description: "Slow rising puffs that expand and fade. Alpha-blended, sorted.",
    emitters: [
      {
        name: "Smoke",
        config: {
          main: {
            duration: 5,
            loop: true,
            startLifetime: r(2.5, 4),
            startSpeed: r(0.4, 0.8),
            startSize: r(0.8, 1.4),
            startRotation: r(-180, 180),
            startColor: [0.55, 0.55, 0.58],
            startAlpha: r(0.35, 0.55),
            maxParticles: 120,
          },
          emission: { enabled: true, rateOverTime: r(8), bursts: [] },
          shape: { kind: "cone", radius: 0.25, coneAngle: 12, coneHeight: 0.2, radiusThickness: 1 },
          force: { enabled: true, force: { x: r(-0.1, 0.1), y: r(0.2, 0.4), z: r(-0.1, 0.1) }, drag: 0.35 },
          noise: { enabled: true, strength: 0.35, frequency: 0.4, scrollSpeed: 0.3, octaves: 1, damping: 0.5 },
          sizeOverLifetime: { enabled: true, curve: [{ t: 0, v: 0.5 }, { t: 1, v: 2.2 }] },
          colorOverLifetime: {
            enabled: true,
            gradient: [
              { t: 0, color: [1, 1, 1], alpha: 0 },
              { t: 0.2, color: [1, 1, 1], alpha: 1 },
              { t: 1, color: [0.8, 0.8, 0.85], alpha: 0 },
            ],
          },
          rotation_: { enabled: true, angularVelocity: r(-25, 25) },
          // Alpha-blended overlapping puffs genuinely need sorting; this is
          // the one preset where it earns its cost.
          renderer: { blending: "normal", sortMode: "byDistance", opacity: 0.9 },
        },
      },
    ],
  },
  {
    key: "fire",
    label: "Fire",
    description: "Additive flame tongues rising from a cone, hot core fading to smoke tones.",
    emitters: [
      {
        name: "Fire",
        config: {
          main: {
            duration: 3,
            loop: true,
            prewarm: true,
            startLifetime: r(0.6, 1.1),
            startSpeed: r(1.2, 2.2),
            startSize: r(0.45, 0.8),
            startRotation: r(-30, 30),
            startColor: [1, 0.65, 0.2],
            startAlpha: r(0.9),
            maxParticles: 150,
          },
          emission: { enabled: true, rateOverTime: r(45), bursts: [] },
          shape: { kind: "cone", radius: 0.22, coneAngle: 14, coneHeight: 0.1 },
          force: { enabled: true, force: { x: r(0), y: r(1.2, 2), z: r(0) }, drag: 0.6 },
          noise: { enabled: true, strength: 0.9, frequency: 1.4, scrollSpeed: 1.2, octaves: 2, damping: 0.5 },
          sizeOverLifetime: { enabled: true, curve: [{ t: 0, v: 0.35 }, { t: 0.35, v: 1 }, { t: 1, v: 0.15 }] },
          colorOverLifetime: {
            enabled: true,
            gradient: [
              { t: 0, color: [1, 1, 0.75], alpha: 0.9 },
              { t: 0.35, color: [1, 0.55, 0.12], alpha: 1 },
              { t: 0.75, color: [0.7, 0.2, 0.05], alpha: 0.5 },
              { t: 1, color: [0.25, 0.12, 0.1], alpha: 0 },
            ],
          },
          renderer: { blending: "additive", opacity: 1 },
        },
      },
    ],
  },
  {
    key: "sparks",
    label: "Sparks",
    description: "Fast stretched streaks thrown outward, falling under gravity and bouncing.",
    emitters: [
      {
        name: "Sparks",
        config: {
          main: {
            duration: 1,
            loop: false,
            startLifetime: r(0.5, 1.2),
            startSpeed: r(4, 9),
            startSize: r(0.05, 0.11),
            startColor: [1, 0.85, 0.4],
            startAlpha: r(1),
            gravityModifier: 1,
            maxParticles: 200,
            playOnStart: false,
          },
          emission: { enabled: true, rateOverTime: r(0), bursts: [{ time: 0, count: r(40, 70), cycles: 1, interval: 0.01, probability: 1 }] },
          shape: { kind: "sphere", radius: 0.1, radiusThickness: 0 },
          force: { enabled: true, force: { x: r(0), y: r(0), z: r(0) }, drag: 0.6 },
          collision: { enabled: true, planeY: 0, bounce: 0.35, friction: 0.6, lifetimeLoss: 0.25 },
          colorOverLifetime: {
            enabled: true,
            gradient: [
              { t: 0, color: [1, 1, 0.85], alpha: 1 },
              { t: 0.6, color: [1, 0.6, 0.15], alpha: 1 },
              { t: 1, color: [0.6, 0.15, 0], alpha: 0 },
            ],
          },
          // Stretched billboards are what make a spark read as a moving
          // streak rather than a dot — the mode exists for exactly this.
          renderer: { mode: "stretched", blending: "additive", stretchFactor: 0.06 },
        },
      },
    ],
  },
  {
    key: "dust",
    label: "Dust",
    description: "Ambient motes drifting inside a box volume. Cheap, loops forever.",
    emitters: [
      {
        name: "Dust",
        config: {
          main: {
            duration: 8,
            loop: true,
            prewarm: true,
            startLifetime: r(4, 8),
            startSpeed: r(0.05, 0.2),
            startSize: r(0.04, 0.11),
            startColor: [1, 0.97, 0.88],
            startAlpha: r(0.25, 0.5),
            maxParticles: 150,
            simulationSpace: "world",
          },
          emission: { enabled: true, rateOverTime: r(18), bursts: [] },
          shape: { kind: "box", boxSize: [8, 3, 8], radiusThickness: 1, randomizeDirection: 1 },
          noise: { enabled: true, strength: 0.12, frequency: 0.25, scrollSpeed: 0.15, octaves: 1, damping: 0.5 },
          colorOverLifetime: {
            enabled: true,
            gradient: [
              { t: 0, color: [1, 1, 1], alpha: 0 },
              { t: 0.25, color: [1, 1, 1], alpha: 1 },
              { t: 0.75, color: [1, 1, 1], alpha: 1 },
              { t: 1, color: [1, 1, 1], alpha: 0 },
            ],
          },
          renderer: { blending: "additive", opacity: 0.6 },
        },
      },
    ],
  },
  {
    key: "explosion",
    label: "Explosion",
    description: "Three-part burst: additive flash, stretched debris, lingering smoke column.",
    emitters: [
      {
        name: "Flash",
        config: {
          main: {
            duration: 0.4,
            loop: false,
            startLifetime: r(0.18, 0.3),
            startSpeed: r(0.5, 1.5),
            startSize: r(1.6, 2.6),
            startColor: [1, 0.9, 0.6],
            startAlpha: r(1),
            maxParticles: 30,
            playOnStart: false,
          },
          emission: { enabled: true, rateOverTime: r(0), bursts: [{ time: 0, count: r(8, 12), cycles: 1, interval: 0.01, probability: 1 }] },
          shape: { kind: "sphere", radius: 0.2, radiusThickness: 1 },
          sizeOverLifetime: { enabled: true, curve: [{ t: 0, v: 0.4 }, { t: 0.3, v: 1.3 }, { t: 1, v: 1.6 }] },
          colorOverLifetime: {
            enabled: true,
            gradient: [
              { t: 0, color: [1, 1, 0.9], alpha: 1 },
              { t: 0.5, color: [1, 0.6, 0.2], alpha: 0.8 },
              { t: 1, color: [0.4, 0.15, 0.05], alpha: 0 },
            ],
          },
          renderer: { blending: "additive" },
        },
      },
      {
        name: "Debris",
        config: {
          main: {
            duration: 0.6,
            loop: false,
            startLifetime: r(0.7, 1.6),
            startSpeed: r(6, 14),
            startSize: r(0.06, 0.14),
            startColor: [1, 0.75, 0.35],
            startAlpha: r(1),
            gravityModifier: 1.2,
            maxParticles: 250,
            playOnStart: false,
          },
          emission: { enabled: true, rateOverTime: r(0), bursts: [{ time: 0, count: r(60, 90), cycles: 1, interval: 0.01, probability: 1 }] },
          shape: { kind: "sphere", radius: 0.15, radiusThickness: 0 },
          force: { enabled: true, force: { x: r(0), y: r(0), z: r(0) }, drag: 0.9 },
          collision: { enabled: true, planeY: 0, bounce: 0.3, friction: 0.5, lifetimeLoss: 0.3 },
          colorOverLifetime: {
            enabled: true,
            gradient: [
              { t: 0, color: [1, 1, 0.8], alpha: 1 },
              { t: 1, color: [0.8, 0.25, 0.05], alpha: 0 },
            ],
          },
          renderer: { mode: "stretched", blending: "additive", stretchFactor: 0.05 },
          // Debris dying spawns the smoke below — the chain that makes
          // this one effect rather than three a script has to sequence.
          subEmitters: { enabled: true, entries: [{ trigger: "death", emitter: "Smoke", count: 1, probability: 0.25, inheritVelocity: 0.1 }] },
        },
      },
      {
        name: "Smoke",
        config: {
          main: {
            duration: 2.5,
            loop: false,
            startLifetime: r(1.4, 2.6),
            startSpeed: r(0.2, 0.6),
            startSize: r(0.7, 1.3),
            startRotation: r(-180, 180),
            startColor: [0.3, 0.29, 0.29],
            startAlpha: r(0.5),
            maxParticles: 100,
            playOnStart: false,
          },
          // Rate 0 with no bursts: this emitter exists purely as the
          // Debris sub-emitter's target, so it must never emit on its own.
          emission: { enabled: true, rateOverTime: r(0), bursts: [] },
          shape: { kind: "sphere", radius: 0.3, radiusThickness: 1 },
          force: { enabled: true, force: { x: r(-0.2, 0.2), y: r(0.5, 1), z: r(-0.2, 0.2) }, drag: 0.8 },
          sizeOverLifetime: { enabled: true, curve: [{ t: 0, v: 0.4 }, { t: 1, v: 1.8 }] },
          rotation_: { enabled: true, angularVelocity: r(-40, 40) },
          renderer: { blending: "normal", sortMode: "byDistance", opacity: 0.75 },
        },
      },
    ],
  },
  {
    key: "magic",
    label: "Magic",
    description: "Orbiting motes rising in a column, additive with a bright color ramp.",
    emitters: [
      {
        name: "Magic",
        config: {
          main: {
            duration: 4,
            loop: true,
            prewarm: true,
            startLifetime: r(1.2, 2.2),
            startSpeed: r(0.2, 0.5),
            startSize: r(0.1, 0.22),
            startColor: [0.6, 0.4, 1],
            startAlpha: r(1),
            maxParticles: 160,
          },
          emission: { enabled: true, rateOverTime: r(35), bursts: [] },
          shape: { kind: "cone", radius: 0.5, coneAngle: 4, coneHeight: 0.3, radiusThickness: 0.4 },
          velocity: { enabled: true, linear: { x: r(0), y: r(0.6, 1.3), z: r(0) }, orbital: r(1.2, 2.4), radial: r(-0.15, 0.05), space: "local" },
          sizeOverLifetime: { enabled: true, curve: [{ t: 0, v: 0 }, { t: 0.25, v: 1 }, { t: 1, v: 0 }] },
          colorOverLifetime: {
            enabled: true,
            gradient: [
              { t: 0, color: [0.8, 0.7, 1], alpha: 0 },
              { t: 0.3, color: [0.65, 0.45, 1], alpha: 1 },
              { t: 1, color: [0.3, 0.7, 1], alpha: 0 },
            ],
          },
          renderer: { blending: "additive" },
        },
      },
    ],
  },
  {
    key: "hit-impact",
    label: "Hit Impact",
    description: "Short radial punch of flat specks. One-shot, no gravity, instantly readable.",
    emitters: [
      {
        name: "Impact",
        config: {
          main: {
            duration: 0.35,
            loop: false,
            startLifetime: r(0.16, 0.32),
            startSpeed: r(5, 9),
            startSize: r(0.12, 0.22),
            startColor: [1, 1, 1],
            startAlpha: r(1),
            maxParticles: 60,
            playOnStart: false,
          },
          emission: { enabled: true, rateOverTime: r(0), bursts: [{ time: 0, count: r(14, 20), cycles: 1, interval: 0.01, probability: 1 }] },
          shape: { kind: "sphere", radius: 0.05, radiusThickness: 0 },
          force: { enabled: true, force: { x: r(0), y: r(0), z: r(0) }, drag: 6 },
          sizeOverLifetime: { enabled: true, curve: [{ t: 0, v: 1 }, { t: 1, v: 0 }] },
          renderer: { mode: "stretched", blending: "additive", stretchFactor: 0.04 },
        },
      },
    ],
  },
  {
    key: "coin-burst",
    label: "Coin Burst",
    description: "Bright specks thrown up and out, falling back under gravity. Reward feedback.",
    emitters: [
      {
        name: "Coins",
        config: {
          main: {
            duration: 0.5,
            loop: false,
            startLifetime: r(0.7, 1.1),
            startSpeed: r(2.5, 4.5),
            startSize: r(0.14, 0.24),
            startRotation: r(-180, 180),
            startColor: [1, 0.85, 0.25],
            startAlpha: r(1),
            gravityModifier: 1.4,
            maxParticles: 80,
            playOnStart: false,
          },
          emission: { enabled: true, rateOverTime: r(0), bursts: [{ time: 0, count: r(12, 18), cycles: 1, interval: 0.01, probability: 1 }] },
          shape: { kind: "cone", radius: 0.15, coneAngle: 35, coneHeight: 0 },
          rotation_: { enabled: true, angularVelocity: r(-320, 320) },
          colorOverLifetime: {
            enabled: true,
            gradient: [
              { t: 0, color: [1, 1, 0.8], alpha: 1 },
              { t: 0.7, color: [1, 0.85, 0.25], alpha: 1 },
              { t: 1, color: [1, 0.7, 0.1], alpha: 0 },
            ],
          },
          renderer: { blending: "additive" },
        },
      },
    ],
  },
  {
    key: "confetti",
    label: "Confetti",
    description: "Spinning colored flakes fluttering down. Win-moment celebration.",
    emitters: [
      {
        name: "Confetti",
        config: {
          main: {
            duration: 1.5,
            loop: false,
            startLifetime: r(2, 3.5),
            startSpeed: r(3, 6),
            startSize: r(0.1, 0.18),
            startRotation: r(-180, 180),
            startColor: [1, 1, 1],
            startAlpha: r(1),
            gravityModifier: 0.55,
            maxParticles: 220,
            playOnStart: false,
          },
          emission: { enabled: true, rateOverTime: r(0), bursts: [{ time: 0, count: r(60, 90), cycles: 3, interval: 0.18, probability: 1 }] },
          shape: { kind: "cone", radius: 0.4, coneAngle: 45, coneHeight: 0, randomizeDirection: 0.3 },
          force: { enabled: true, force: { x: r(-0.4, 0.4), y: r(0), z: r(-0.4, 0.4) }, drag: 1.4 },
          // Turbulence is what makes a flake *flutter* rather than fall in
          // a straight line — the single detail that sells confetti.
          noise: { enabled: true, strength: 1.6, frequency: 0.9, scrollSpeed: 0.8, octaves: 1, damping: 0.5 },
          rotation_: { enabled: true, angularVelocity: r(-400, 400) },
          sizeOverLifetime: { enabled: true, curve: [{ t: 0, v: 1 }, { t: 0.85, v: 1 }, { t: 1, v: 0 }] },
          renderer: { blending: "normal" },
        },
      },
    ],
  },
  {
    key: "trail",
    label: "Trail",
    description: "Sparse motes with ribbon trails — attach to a moving object.",
    emitters: [
      {
        name: "Trail",
        config: {
          main: {
            duration: 5,
            loop: true,
            startLifetime: r(0.5, 0.9),
            startSpeed: r(0.1, 0.4),
            startSize: r(0.1, 0.18),
            startColor: [0.4, 0.85, 1],
            startAlpha: r(1),
            maxParticles: 60,
            simulationSpace: "world",
          },
          emission: { enabled: true, rateOverTime: r(30), bursts: [] },
          shape: { kind: "sphere", radius: 0.08, radiusThickness: 1, randomizeDirection: 1 },
          sizeOverLifetime: { enabled: true, curve: [{ t: 0, v: 1 }, { t: 1, v: 0 }] },
          trails: { enabled: true, ratio: 1, lifetime: 0.35, minVertexDistance: 0.06, maxPoints: 12, widthStart: 0.09, widthEnd: 0, color: [0.4, 0.85, 1] },
          renderer: { blending: "additive" },
        },
      },
    ],
  },
  {
    key: "rain",
    label: "Rain",
    description: "Stretched droplets falling through a wide box, killed at ground level.",
    emitters: [
      {
        name: "Rain",
        config: {
          main: {
            duration: 5,
            loop: true,
            prewarm: true,
            startLifetime: r(1.2, 1.8),
            startSpeed: r(0),
            startSize: r(0.03, 0.06),
            startColor: [0.7, 0.82, 1],
            startAlpha: r(0.5),
            gravityModifier: 2.2,
            maxParticles: 500,
            simulationSpace: "world",
          },
          emission: { enabled: true, rateOverTime: r(220), bursts: [] },
          shape: { kind: "box", boxSize: [14, 0.2, 14], position: [0, 7, 0], radiusThickness: 1 },
          collision: { enabled: true, planeY: 0, killOnContact: true, bounce: 0, friction: 0, lifetimeLoss: 0 },
          colorOverLifetime: { enabled: false, gradient: [] },
          renderer: { mode: "stretched", blending: "normal", stretchFactor: 0.06, opacity: 0.65 },
        },
      },
    ],
  },
  {
    key: "snow",
    label: "Snow",
    description: "Slow drifting flakes with turbulence. Wide box, world space.",
    emitters: [
      {
        name: "Snow",
        config: {
          main: {
            duration: 8,
            loop: true,
            prewarm: true,
            startLifetime: r(6, 10),
            startSpeed: r(0),
            startSize: r(0.06, 0.14),
            startRotation: r(-180, 180),
            startColor: [1, 1, 1],
            startAlpha: r(0.8),
            gravityModifier: 0.06,
            maxParticles: 400,
            simulationSpace: "world",
          },
          emission: { enabled: true, rateOverTime: r(55), bursts: [] },
          shape: { kind: "box", boxSize: [16, 0.5, 16], position: [0, 8, 0], radiusThickness: 1 },
          noise: { enabled: true, strength: 0.35, frequency: 0.35, scrollSpeed: 0.25, octaves: 1, damping: 0.5 },
          limitVelocity: { enabled: true, speedLimit: 1.2, dampen: 0.4 },
          rotation_: { enabled: true, angularVelocity: r(-45, 45) },
          renderer: { blending: "normal", opacity: 0.9 },
        },
      },
    ],
  },
  {
    key: "energy-burst",
    label: "Energy Burst",
    description: "Expanding shell of additive motes with a hard outward push. Power-up moment.",
    emitters: [
      {
        name: "Burst",
        config: {
          main: {
            duration: 0.8,
            loop: false,
            startLifetime: r(0.5, 0.9),
            startSpeed: r(7, 10),
            startSize: r(0.18, 0.32),
            startColor: [0.35, 0.85, 1],
            startAlpha: r(1),
            maxParticles: 180,
            playOnStart: false,
          },
          emission: { enabled: true, rateOverTime: r(0), bursts: [{ time: 0, count: r(70, 100), cycles: 1, interval: 0.01, probability: 1 }] },
          // A zero-thickness sphere emits from the *shell*, which is what
          // makes the burst read as one expanding ring rather than a
          // filled cloud.
          shape: { kind: "sphere", radius: 0.25, radiusThickness: 0 },
          force: { enabled: true, force: { x: r(0), y: r(0), z: r(0) }, drag: 4.5 },
          sizeOverLifetime: { enabled: true, curve: [{ t: 0, v: 1 }, { t: 1, v: 0 }] },
          colorOverLifetime: {
            enabled: true,
            gradient: [
              { t: 0, color: [1, 1, 1], alpha: 1 },
              { t: 0.4, color: [0.4, 0.9, 1], alpha: 1 },
              { t: 1, color: [0.1, 0.35, 0.9], alpha: 0 },
            ],
          },
          renderer: { blending: "additive" },
        },
      },
    ],
  },
];

export function getPreset(key: string): ParticlePreset | undefined {
  return PARTICLE_PRESETS.find((p) => p.key === key);
}

/**
 * Instantiates a preset into a complete, normalized system config.
 *
 * Fresh ids every time, so two explosions built from the same preset are
 * genuinely two systems rather than one registered twice — and each gets
 * its own normalized copy, so editing one in the Inspector can't reach
 * into the preset table and mutate the shared literal.
 */
export function createSystemFromPreset(key: string, name?: string): ParticleSystemConfig | undefined {
  const preset = getPreset(key);
  if (!preset) return undefined;
  return {
    id: newParticleId("sys"),
    name: name ?? preset.label,
    emitters: preset.emitters.map((entry) => {
      const config = normalizeEmitterConfig(entry.config, entry.name);
      config.id = newParticleId("em");
      config.name = entry.name;
      return config;
    }),
  };
}

/** An empty system with one default emitter — what "+ Particle System" creates when no preset is chosen. */
export function createEmptySystem(name = "Particle System"): ParticleSystemConfig {
  const emitter = normalizeEmitterConfig(undefined, "Emitter");
  return { id: newParticleId("sys"), name, emitters: [emitter] };
}
