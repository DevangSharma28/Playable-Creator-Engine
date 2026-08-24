import type { CurveKey, GradientKey, ScalarRange } from "./ParticleTypes";

/**
 * Deterministic pseudo-random source, plus the sampling helpers every
 * module uses to turn a `ScalarRange`/`CurveKey[]`/`GradientKey[]` into a
 * number.
 *
 * **Why not Math.random().** A particle effect that has to reproduce
 * exactly — a replay, a screenshot test, a "why does this look different
 * on the third play" bug — can't be built on a generator with no seed and
 * no state a caller can own. `Math.random()` is also a single global
 * stream: two emitters drawing from it interleave differently depending on
 * frame timing, so even seeding it (which JS doesn't allow) wouldn't make
 * two emitters independently reproducible. Each emitter owning one of
 * these instead makes determinism a per-emitter property, which is what
 * `setSeed()` on the public API actually promises.
 *
 * The generator is mulberry32: 32-bit state, four arithmetic ops per draw,
 * and a period long past anything a playable will consume. Chosen over a
 * bigger PRNG for exactly the reason the collision system chose a sweep
 * over a BVH — this runs once per particle per spawn and the quality
 * difference is invisible at that sample count.
 */
export class ParticleRandom {
  private state: number;
  /** The seed `reset()` rewinds to. Not readonly — `reseed()` genuinely replaces it, which is what makes setSeed() on the public API mean "and this is the sequence from now on" rather than only affecting the current run. */
  private initialSeed: number;

  constructor(seed: number) {
    this.initialSeed = seed >>> 0;
    this.state = this.initialSeed;
  }

  get seed(): number {
    return this.initialSeed;
  }

  /** Rewinds to the seed this was constructed with — what restart() calls so a replay genuinely replays. */
  reset(): void {
    this.state = this.initialSeed;
  }

  /** Re-seeds and rewinds in one step. */
  reseed(seed: number): void {
    this.initialSeed = seed >>> 0;
    this.state = this.initialSeed;
  }

  /** Uniform 0..1. */
  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform -1..1 — the shape samplers' most common draw. */
  nextSigned(): number {
    return this.next() * 2 - 1;
  }

  /** Uniform within a range. */
  range(min: number, max: number): number {
    return min === max ? min : min + (max - min) * this.next();
  }

  /** Uniform within a ScalarRange. Constant ranges (min === max) skip the draw entirely, so a constant genuinely costs nothing. */
  sample(range: ScalarRange): number {
    return range.min === range.max ? range.min : range.min + (range.max - range.min) * this.next();
  }
}

/** A ScalarRange from one number — the shape every "constant" config value takes. */
export function constant(v: number): ScalarRange {
  return { min: v, max: v };
}

/** A ScalarRange from two. */
export function between(min: number, max: number): ScalarRange {
  return { min, max };
}

/**
 * Linear interpolation across a sorted curve.
 *
 * Returns the first key's value before the curve starts and the last key's
 * after it ends, rather than extrapolating — a size curve that ran past 1
 * and kept growing would be a bug in every case where it happened, and
 * clamping is what every DCC tool's default curve does too.
 *
 * Linear rather than a real spline on purpose: this is evaluated once per
 * particle per frame per enabled curve module, and the visual difference
 * between a 6-key linear curve and a 6-key bezier at particle scale is not
 * detectable. Add keys, not interpolation orders.
 */
export function evaluateCurve(keys: CurveKey[], t: number): number {
  const n = keys.length;
  if (n === 0) return 1;
  if (n === 1) return keys[0].v;
  if (t <= keys[0].t) return keys[0].v;
  if (t >= keys[n - 1].t) return keys[n - 1].v;
  for (let i = 1; i < n; i++) {
    const b = keys[i];
    if (t > b.t) continue;
    const a = keys[i - 1];
    const span = b.t - a.t;
    if (span <= 0) return b.v;
    return a.v + (b.v - a.v) * ((t - a.t) / span);
  }
  return keys[n - 1].v;
}

/**
 * Linear RGBA interpolation across a sorted gradient, written into `out`.
 *
 * Writes into a caller-owned array rather than returning a new one — this
 * runs once per particle per frame when Color over Lifetime is on, and a
 * 4-element allocation at that rate is exactly the garbage the rest of this
 * engine goes out of its way to avoid (see ColliderTypes' own note on
 * per-frame allocation).
 */
export function evaluateGradient(keys: GradientKey[], t: number, out: Float32Array | number[]): void {
  const n = keys.length;
  if (n === 0) {
    out[0] = out[1] = out[2] = out[3] = 1;
    return;
  }
  if (n === 1 || t <= keys[0].t) {
    writeKey(keys[0], out);
    return;
  }
  if (t >= keys[n - 1].t) {
    writeKey(keys[n - 1], out);
    return;
  }
  for (let i = 1; i < n; i++) {
    const b = keys[i];
    if (t > b.t) continue;
    const a = keys[i - 1];
    const span = b.t - a.t;
    const f = span <= 0 ? 1 : (t - a.t) / span;
    out[0] = a.color[0] + (b.color[0] - a.color[0]) * f;
    out[1] = a.color[1] + (b.color[1] - a.color[1]) * f;
    out[2] = a.color[2] + (b.color[2] - a.color[2]) * f;
    out[3] = a.alpha + (b.alpha - a.alpha) * f;
    return;
  }
  writeKey(keys[n - 1], out);
}

function writeKey(key: GradientKey, out: Float32Array | number[]): void {
  out[0] = key.color[0];
  out[1] = key.color[1];
  out[2] = key.color[2];
  out[3] = key.alpha;
}

/**
 * Value noise in 3D with a seeded integer hash — the field the Noise
 * module samples.
 *
 * Deliberately not simplex/Perlin: those need a permutation table (256+
 * bytes of setup and a gradient lookup per corner) for a smoothness
 * difference that a turbulence force applied to a particle cannot show.
 * This is eight hashed corner values and a smoothstep blend, entirely
 * branch-free and allocation-free, which is what a per-particle per-frame
 * call needs to be.
 */
export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  // Smoothstep the fractions so the field is C1-continuous across cell
  // boundaries — without it the noise visibly grids.
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);

  const c000 = hash3(xi, yi, zi, seed);
  const c100 = hash3(xi + 1, yi, zi, seed);
  const c010 = hash3(xi, yi + 1, zi, seed);
  const c110 = hash3(xi + 1, yi + 1, zi, seed);
  const c001 = hash3(xi, yi, zi + 1, seed);
  const c101 = hash3(xi + 1, yi, zi + 1, seed);
  const c011 = hash3(xi, yi + 1, zi + 1, seed);
  const c111 = hash3(xi + 1, yi + 1, zi + 1, seed);

  const x00 = c000 + (c100 - c000) * u;
  const x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u;
  const x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  // -1..1, so the caller can scale it by a strength directly.
  return (y0 + (y1 - y0) * w) * 2 - 1;
}

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(z, 0xcb1ab31f) ^ Math.imul(seed, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
}
