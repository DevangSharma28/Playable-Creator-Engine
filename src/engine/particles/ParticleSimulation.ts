import * as THREE from "three";
import type { ParticleBuffer } from "./ParticleBuffer";
import type { ParticleEmitterConfig } from "./ParticleTypes";
import { ParticleRandom, evaluateCurve, evaluateGradient, valueNoise3 } from "./ParticleRandom";
import { randomizeDirection, sampleShape } from "./ParticleShapes";

/** Fired when a particle is born, dies, or hits the collision plane — how sub-emitters are triggered without the simulation knowing what a sub-emitter is. */
export interface ParticleEvents {
  onBirth?(x: number, y: number, z: number, vx: number, vy: number, vz: number): void;
  onDeath?(x: number, y: number, z: number, vx: number, vy: number, vz: number): void;
  onCollision?(x: number, y: number, z: number, vx: number, vy: number, vz: number): void;
}

const spawnPosition = new THREE.Vector3();
const spawnDirection = new THREE.Vector3();
const shapeMatrix = new THREE.Matrix4();
const shapeQuaternion = new THREE.Quaternion();
const shapeEuler = new THREE.Euler();
const shapeScale = new THREE.Vector3();
const shapePosition = new THREE.Vector3();
const gravityScratch = new THREE.Vector3();
const inverseScratch = new THREE.Matrix4();
const gradientScratch = new Float32Array(4);

const WORLD_DOWN = new THREE.Vector3(0, -1, 0);
/** Earth gravity, so `gravityModifier: 1` means what a designer expects rather than an arbitrary engine unit. */
const GRAVITY = 9.81;

/**
 * The single per-frame update pipeline for one emitter.
 *
 * ## One pass, not a hundred callbacks
 *
 * Every module is a branch inside one loop over `[0, count)` rather than
 * its own iteration or its own per-particle callback. That matters more
 * than it looks: a per-module pass would read and write the same particle's
 * position and velocity once per module, blowing cache on every pass, and a
 * per-particle callback would add an indirect call per particle per module.
 * Here a particle's fields are loaded into locals once, every enabled
 * module operates on those locals, and they're written back once.
 *
 * ## Disabled modules are genuinely free
 *
 * Each module's `enabled` flag is hoisted into a `const` before the loop,
 * so a disabled module costs one already-predicted branch per particle and
 * touches nothing. This is what backs the claim that a simple emitter stays
 * cheap no matter how many features exist — the feature set is opt-in at
 * runtime, not just at author time.
 *
 * ## Simulation space
 *
 * In `local` space particles are integrated in the emitter's own frame and
 * the render mesh carries the emitter's transform, so moving the emitter
 * drags its particles with it. In `world` space spawn position and
 * direction are transformed into world space once, at birth, and the mesh
 * sits at identity — so particles stay where they were released. Gravity
 * is resolved into whichever frame is active (see `resolveGravity`), which
 * is why smoke rises correctly from a tilted emitter in both modes.
 */
export class ParticleSimulation {
  /** Seconds since play() — drives duration, looping, and burst scheduling. */
  private time = 0;
  /** Fractional particles owed by the rate accumulator, carried between frames so a 0.5/sec rate genuinely emits one particle every two seconds instead of never. */
  private rateDebt = 0;
  private delayRemaining = 0;
  private playing = false;
  private stopping = false;
  /** Bursts already fired this cycle, indexed to match config.emission.bursts, holding how many of their `cycles` have gone. */
  private burstProgress: number[] = [];
  private burstNextTime: number[] = [];

  /** Multiplies emission rate and burst counts — how the LOD/quality tier scales an effect down without a second copy of it. */
  quality = 1;

  constructor(
    private config: ParticleEmitterConfig,
    private readonly buffer: ParticleBuffer,
    private readonly rng: ParticleRandom,
    private readonly events: ParticleEvents = {}
  ) {
    this.resetBursts();
  }

  /** Swaps in an edited config. Live particles are kept — an Inspector tweak shouldn't blank the preview you're tweaking against. */
  setConfig(config: ParticleEmitterConfig): void {
    this.config = config;
    if (this.burstProgress.length !== config.emission.bursts.length) this.resetBursts();
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** True once the system has stopped emitting AND every particle it produced has died — what a one-shot effect's owner polls to know it can be released. */
  get isFinished(): boolean {
    return !this.playing && this.buffer.count === 0;
  }

  get elapsed(): number {
    return this.time;
  }

  play(): void {
    if (this.playing && !this.stopping) return;
    this.playing = true;
    this.stopping = false;
    if (this.time === 0) this.delayRemaining = this.rng.sample(this.config.main.startDelay);
  }

  pause(): void {
    this.playing = false;
  }

  /**
   * Stops emitting. Existing particles are deliberately left to finish
   * their lifetimes — a smoke plume that vanished the instant you stopped
   * the emitter would be wrong in every case anyone actually stops one.
   * Use `clear()` for the immediate version.
   */
  stop(): void {
    this.playing = false;
    this.stopping = true;
  }

  restart(): void {
    this.clear();
    this.time = 0;
    this.rateDebt = 0;
    this.resetBursts();
    if (this.config.main.autoRandomSeed) this.rng.reseed((Math.random() * 0xffffffff) >>> 0);
    else this.rng.reset();
    this.playing = true;
    this.stopping = false;
    this.delayRemaining = this.rng.sample(this.config.main.startDelay);
    if (this.config.main.prewarm && this.config.main.loop) this.prewarm();
  }

  /** Kills every live particle immediately, without stopping emission. */
  clear(): void {
    this.buffer.clear();
  }

  /**
   * Runs a full duration's worth of simulation in fixed steps so a looping
   * effect starts already populated.
   *
   * Without this a campfire that's meant to have been burning forever
   * visibly fills in over its first few seconds every time the scene
   * loads. 30Hz rather than the real frame rate because this is a one-off
   * cost at play() time and the visual difference between 30 and 60 warm-up
   * steps is nothing.
   */
  prewarm(): void {
    const step = 1 / 30;
    const steps = Math.min(300, Math.ceil(this.config.main.duration / step));
    const wasDelay = this.delayRemaining;
    this.delayRemaining = 0;
    for (let i = 0; i < steps; i++) this.step(step);
    this.delayRemaining = wasDelay;
  }

  /** Emits `count` particles right now, regardless of rate or duration — the manual `emit(n)` on the public API, and how sub-emitters fire. */
  emit(count: number, originX?: number, originY?: number, originZ?: number, inheritVx = 0, inheritVy = 0, inheritVz = 0): number {
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      if (!this.spawnOne(originX, originY, originZ, inheritVx, inheritVy, inheritVz)) break;
      spawned++;
    }
    return spawned;
  }

  /**
   * One frame.
   *
   * `dt` is already scaled by the emitter's own `simulationSpeed` by the
   * caller, so this doesn't re-apply it — the emitter owns that knob
   * because it also needs the scaled value for its own bookkeeping.
   */
  step(dt: number): void {
    if (dt > 0 && this.playing) this.advanceEmission(dt);
    if (dt > 0) this.integrate(dt);
  }

  // -----------------------------------------------------------------------
  // Emission
  // -----------------------------------------------------------------------

  private advanceEmission(dt: number): void {
    const main = this.config.main;

    if (this.delayRemaining > 0) {
      this.delayRemaining -= dt;
      if (this.delayRemaining > 0) return;
      // Carry the overshoot into this frame's emission rather than
      // discarding it, so a 0.05s delay on a 0.016s frame doesn't quantize
      // the effect's start to the next whole frame boundary.
      dt = -this.delayRemaining;
      this.delayRemaining = 0;
    }

    // The frame is consumed in slices that never straddle a cycle
    // boundary. That matters for one specific, very common case: a burst
    // scheduled at time 0 on a looping emitter.
    //
    // Advancing straight through the boundary and then subtracting the
    // duration leaves the new cycle starting at the *remainder*, not at 0
    // — so the next frame's window is something like (0.0067, 0.0234] and
    // a burst at 0 falls before it. It was skipped, yet still consumed
    // (burstProgress incremented), so a t=0 burst fired on the first cycle
    // and never again. Slicing means every cycle genuinely begins at 0 and
    // gets a window that includes it.
    let remaining = dt;
    let guard = 0;
    while (remaining > 0) {
      const untilEnd = Math.max(0, main.duration - this.time);
      // A cycle shorter than one frame is legitimate (a 0.1s looping
      // sparkle at 30fps); the guard below is what stops a pathological
      // duration from spinning here forever.
      const slice = Math.min(remaining, untilEnd > 0 ? untilEnd : main.duration);
      const from = this.time;
      const atCycleStart = from === 0;
      this.time += slice;
      remaining -= slice;

      if (this.config.emission.enabled) {
        this.fireBursts(from, this.time, atCycleStart);
        this.emitAtRate(slice);
      }

      if (this.time >= main.duration - 1e-9) {
        if (!main.loop) {
          this.playing = false;
          this.stopping = true;
          return;
        }
        this.time = 0;
        this.resetBursts();
      }

      // Real time arriving faster than whole cycles can be consumed. Drop
      // the backlog rather than carrying it — the same call the fixed-step
      // loop in IonEngine makes, for the same reason.
      if (++guard >= 8) return;
    }
  }

  /** The continuous-rate half of emission, for a slice of `seconds`. */
  private emitAtRate(seconds: number): void {
    const rate = this.rng.sample(this.config.emission.rateOverTime) * this.quality;
    if (rate <= 0) return;
    this.rateDebt += rate * seconds;
    // Cap the per-frame spawn burst: a long frame (a stall, a backgrounded
    // tab resuming) would otherwise try to spawn the entire backlog at
    // once, which is both a spike and visually wrong — the particles all
    // appear at the same position on the same frame instead of being
    // spread through the time that elapsed.
    const budget = Math.min(Math.floor(this.rateDebt), this.buffer.free, 256);
    for (let i = 0; i < budget; i++) {
      if (!this.spawnOne()) break;
      this.rateDebt -= 1;
    }
    if (this.rateDebt > 1) this.rateDebt = 1;
  }

  /**
   * Fires any burst whose scheduled time fell inside `(from, to]`, or
   * `[from, to]` when `atCycleStart` says this slice begins a cycle.
   *
   * Window-based rather than "is time past the burst time", so a burst
   * can't be missed by a long frame that stepped clean over it — and can't
   * re-fire every frame afterwards either, which is what a naive
   * `time >= burst.time` check does. The half-open lower bound is what
   * stops a burst firing twice across two adjacent slices; `atCycleStart`
   * is the one case that must include it, since a burst at exactly 0
   * would otherwise never be inside any window.
   */
  private fireBursts(from: number, to: number, atCycleStart: boolean): void {
    const bursts = this.config.emission.bursts;
    for (let b = 0; b < bursts.length; b++) {
      const burst = bursts[b];
      const cycles = Math.max(1, burst.cycles);
      while (this.burstProgress[b] < cycles) {
        const at = this.burstNextTime[b];
        if (at > to) break;
        if (at > from || (atCycleStart && at <= from)) {
          if (burst.probability >= 1 || this.rng.next() < burst.probability) {
            this.emit(Math.round(this.rng.sample(burst.count) * this.quality));
          }
        }
        this.burstProgress[b]++;
        this.burstNextTime[b] = at + Math.max(burst.interval, 1e-4);
      }
    }
  }

  private resetBursts(): void {
    const bursts = this.config.emission.bursts;
    this.burstProgress = new Array(bursts.length).fill(0);
    this.burstNextTime = bursts.map((burst) => burst.time);
  }

  /**
   * Creates one particle.
   *
   * Returns false when the buffer is full — a *configured* outcome, not an
   * error (see ParticleBuffer.spawn), so the caller stops emitting rather
   * than growing anything.
   */
  private spawnOne(originX?: number, originY?: number, originZ?: number, inheritVx = 0, inheritVy = 0, inheritVz = 0): boolean {
    const index = this.buffer.spawn();
    if (index < 0) return false;

    const cfg = this.config;
    const main = cfg.main;
    const buffer = this.buffer;
    const rng = this.rng;

    if (cfg.shape.enabled) {
      sampleShape(cfg.shape, rng, spawnPosition, spawnDirection);
      randomizeDirection(spawnDirection, cfg.shape.randomizeDirection, rng);
      // The shape's own offset transform, composed once per spawn. Cheap
      // enough here and it keeps the samplers pure geometry.
      shapeEuler.set(
        cfg.shape.rotation[0] * THREE.MathUtils.DEG2RAD,
        cfg.shape.rotation[1] * THREE.MathUtils.DEG2RAD,
        cfg.shape.rotation[2] * THREE.MathUtils.DEG2RAD
      );
      shapeQuaternion.setFromEuler(shapeEuler);
      shapePosition.set(cfg.shape.position[0], cfg.shape.position[1], cfg.shape.position[2]);
      shapeScale.set(cfg.shape.scale[0], cfg.shape.scale[1], cfg.shape.scale[2]);
      shapeMatrix.compose(shapePosition, shapeQuaternion, shapeScale);
      spawnPosition.applyMatrix4(shapeMatrix);
      spawnDirection.applyQuaternion(shapeQuaternion).normalize();
    } else {
      spawnPosition.set(0, 0, 0);
      spawnDirection.set(0, 1, 0);
    }

    const hasOrigin = originX !== undefined;

    // World-space simulation releases particles into the world and never
    // moves them again, so the emitter's transform is baked in *once*,
    // here, at birth. (Local-space emitters skip this entirely and let the
    // render mesh carry the same transform every frame instead — see
    // ParticleEmitter.syncTransform.)
    if (main.simulationSpace === "world" && this.worldMatrix) {
      spawnPosition.applyMatrix4(this.worldMatrix);
      spawnDirection.transformDirection(this.worldMatrix);
      if (hasOrigin) {
        // A sub-emitter spawn is *placed* by its origin, which is already a
        // world point — so the emitter's own world translation must come
        // back off, leaving only the rotated/scaled shape offset to scatter
        // around that point. Without this the child's position is added on
        // top of the trigger point, and an explosion's smoke appeared at
        // (emitter + debris) instead of at the debris.
        spawnPosition.x -= this.worldMatrix.elements[12];
        spawnPosition.y -= this.worldMatrix.elements[13];
        spawnPosition.z -= this.worldMatrix.elements[14];
      }
    }

    // A sub-emitter spawns at its parent particle's position, not its own
    // shape's origin — the shape sample above still applies, as a local
    // scatter around that point. The origin arrives already in the child's
    // own simulation space (ParticleSystem converts it), so this is a
    // plain add.
    if (hasOrigin) {
      spawnPosition.x += originX;
      spawnPosition.y += originY ?? 0;
      spawnPosition.z += originZ ?? 0;
    }

    const speed = rng.sample(main.startSpeed);
    buffer.posX[index] = spawnPosition.x;
    buffer.posY[index] = spawnPosition.y;
    buffer.posZ[index] = spawnPosition.z;
    buffer.velX[index] = spawnDirection.x * speed + inheritVx;
    buffer.velY[index] = spawnDirection.y * speed + inheritVy;
    buffer.velZ[index] = spawnDirection.z * speed + inheritVz;

    if (cfg.velocity.enabled) {
      buffer.velX[index] += rng.sample(cfg.velocity.linear.x);
      buffer.velY[index] += rng.sample(cfg.velocity.linear.y);
      buffer.velZ[index] += rng.sample(cfg.velocity.linear.z);
    }

    const lifetime = Math.max(1e-3, rng.sample(main.startLifetime));
    buffer.age[index] = 0;
    buffer.lifetime[index] = lifetime;

    const size = rng.sample(main.startSize);
    buffer.startSize[index] = size;
    buffer.size[index] = size;

    buffer.rotation[index] = rng.sample(main.startRotation) * THREE.MathUtils.DEG2RAD;
    buffer.angularVelocity[index] = cfg.rotation_.enabled ? rng.sample(cfg.rotation_.angularVelocity) * THREE.MathUtils.DEG2RAD : 0;

    if (cfg.shape.alignToDirection) {
      // Screen-space roll that approximately matches the launch direction.
      // Exact alignment is what renderMode "velocity" is for; this is the
      // cheap version for billboards that only need to *start* oriented.
      buffer.rotation[index] = Math.atan2(spawnDirection.x, spawnDirection.y);
    }

    const alpha = rng.sample(main.startAlpha);
    buffer.startR[index] = main.startColor[0];
    buffer.startG[index] = main.startColor[1];
    buffer.startB[index] = main.startColor[2];
    buffer.startA[index] = alpha;
    buffer.colR[index] = main.startColor[0];
    buffer.colG[index] = main.startColor[1];
    buffer.colB[index] = main.startColor[2];
    buffer.colA[index] = alpha;

    buffer.rand0[index] = rng.next();
    buffer.rand1[index] = rng.next();
    buffer.rand2[index] = rng.next();
    buffer.rand3[index] = rng.next();

    const sheet = cfg.textureSheet;
    buffer.frame[index] = sheet.enabled && sheet.startFrameRandom ? Math.floor(buffer.rand0[index] * Math.max(1, sheet.tilesX * sheet.tilesY)) : sheet.startFrame;

    this.events.onBirth?.(spawnPosition.x, spawnPosition.y, spawnPosition.z, buffer.velX[index], buffer.velY[index], buffer.velZ[index]);
    return true;
  }

  // -----------------------------------------------------------------------
  // Integration
  // -----------------------------------------------------------------------

  private integrate(dt: number): void {
    const cfg = this.config;
    const buffer = this.buffer;

    // Hoisted once per frame, not read per particle: every one of these is
    // a property lookup through two objects, and the JIT can't hoist them
    // itself because the config is reachable from outside the loop.
    const useForce = cfg.force.enabled;
    const useNoise = cfg.noise.enabled;
    const useLimit = cfg.limitVelocity.enabled;
    const useColor = cfg.colorOverLifetime.enabled && cfg.colorOverLifetime.gradient.length > 0;
    const useSize = cfg.sizeOverLifetime.enabled && cfg.sizeOverLifetime.curve.length > 0;
    const useRotation = cfg.rotation_.enabled;
    const useSheet = cfg.textureSheet.enabled;
    const useCollision = cfg.collision.enabled;
    const useVelocityModule = cfg.velocity.enabled;
    const hasOrbital = useVelocityModule && (cfg.velocity.orbital.min !== 0 || cfg.velocity.orbital.max !== 0);
    const hasRadial = useVelocityModule && (cfg.velocity.radial.min !== 0 || cfg.velocity.radial.max !== 0);

    this.resolveGravity(gravityScratch);
    const gx = gravityScratch.x;
    const gy = gravityScratch.y;
    const gz = gravityScratch.z;

    let fx = 0;
    let fy = 0;
    let fz = 0;
    if (useForce) {
      // Sampled once per frame rather than per particle: a *constant*
      // force is the overwhelmingly common case, and a per-particle draw
      // there would burn three random numbers per particle per frame to
      // produce the same number three times.
      fx = this.rng.sample(cfg.force.force.x);
      fy = this.rng.sample(cfg.force.force.y);
      fz = this.rng.sample(cfg.force.force.z);
    }
    const drag = useForce ? Math.max(0, cfg.force.drag) : 0;
    const dragFactor = drag > 0 ? Math.max(0, 1 - drag * dt) : 1;

    const noise = cfg.noise;
    const noiseTime = this.time * noise.scrollSpeed;
    const octaves = useNoise ? Math.max(1, Math.min(4, Math.floor(noise.octaves))) : 1;

    const sheet = cfg.textureSheet;
    const totalFrames = Math.max(1, sheet.tilesX * sheet.tilesY);

    for (let i = 0; i < buffer.count; i++) {
      let age = buffer.age[i] + dt;
      const lifetime = buffer.lifetime[i];

      if (age >= lifetime) {
        this.events.onDeath?.(buffer.posX[i], buffer.posY[i], buffer.posZ[i], buffer.velX[i], buffer.velY[i], buffer.velZ[i]);
        buffer.swapRemove(i);
        i--; // the slot now holds a particle that hasn't been visited — see ParticleBuffer.swapRemove
        continue;
      }
      buffer.age[i] = age;
      const t = age / lifetime;

      let px = buffer.posX[i];
      let py = buffer.posY[i];
      let pz = buffer.posZ[i];
      let vx = buffer.velX[i];
      let vy = buffer.velY[i];
      let vz = buffer.velZ[i];

      vx += gx * dt;
      vy += gy * dt;
      vz += gz * dt;

      if (useForce) {
        vx += fx * dt;
        vy += fy * dt;
        vz += fz * dt;
      }

      if (hasRadial) {
        // Outward from the emitter origin. Length guarded because a
        // particle sitting exactly at the origin has no outward direction
        // and normalizing it would produce NaN that propagates forever.
        const len = Math.sqrt(px * px + py * py + pz * pz);
        if (len > 1e-5) {
          const radial = (cfg.velocity.radial.min + (cfg.velocity.radial.max - cfg.velocity.radial.min) * buffer.rand1[i]) * dt;
          vx += (px / len) * radial;
          vy += (py / len) * radial;
          vz += (pz / len) * radial;
        }
      }

      if (hasOrbital) {
        // Rotation about the emitter's Y axis: a tangential push in XZ.
        const orbital = (cfg.velocity.orbital.min + (cfg.velocity.orbital.max - cfg.velocity.orbital.min) * buffer.rand2[i]) * dt;
        vx += -pz * orbital;
        vz += px * orbital;
      }

      if (useNoise) {
        // Each axis samples the same field at a different offset — cheaper
        // than three independent fields and visually indistinguishable,
        // since what matters is that the three components decorrelate.
        const nx = px * noise.frequency;
        const ny = py * noise.frequency;
        const nz = pz * noise.frequency + noiseTime;
        let amplitude = noise.strength;
        let frequency = 1;
        for (let o = 0; o < octaves; o++) {
          vx += valueNoise3(nx * frequency, ny * frequency, nz * frequency, 1) * amplitude * dt;
          vy += valueNoise3(nx * frequency + 31.4, ny * frequency + 17.7, nz * frequency, 2) * amplitude * dt;
          vz += valueNoise3(nx * frequency, ny * frequency + 91.2, nz * frequency + 55.3, 3) * amplitude * dt;
          amplitude *= noise.damping;
          frequency *= 2;
        }
      }

      if (dragFactor !== 1) {
        vx *= dragFactor;
        vy *= dragFactor;
        vz *= dragFactor;
      }

      if (useLimit) {
        const speedSq = vx * vx + vy * vy + vz * vz;
        const limit = cfg.limitVelocity.speedLimit;
        if (limit > 0 && speedSq > limit * limit) {
          const speed = Math.sqrt(speedSq);
          // Ease toward the limit rather than hard-clamping, so `dampen`
          // below 1 reads as air resistance instead of a visible snap.
          const target = speed + (limit - speed) * Math.min(1, cfg.limitVelocity.dampen);
          const scale = target / speed;
          vx *= scale;
          vy *= scale;
          vz *= scale;
        }
      }

      px += vx * dt;
      py += vy * dt;
      pz += vz * dt;

      if (useCollision && py < cfg.collision.planeY) {
        py = cfg.collision.planeY;
        this.events.onCollision?.(px, py, pz, vx, vy, vz);
        if (cfg.collision.killOnContact) {
          this.events.onDeath?.(px, py, pz, vx, vy, vz);
          buffer.swapRemove(i);
          i--;
          continue;
        }
        vy = Math.abs(vy) * cfg.collision.bounce;
        vx *= cfg.collision.friction;
        vz *= cfg.collision.friction;
        if (cfg.collision.lifetimeLoss > 0) {
          age += (lifetime - age) * cfg.collision.lifetimeLoss;
          buffer.age[i] = age;
        }
      }

      buffer.posX[i] = px;
      buffer.posY[i] = py;
      buffer.posZ[i] = pz;
      buffer.velX[i] = vx;
      buffer.velY[i] = vy;
      buffer.velZ[i] = vz;

      buffer.size[i] = useSize ? buffer.startSize[i] * evaluateCurve(cfg.sizeOverLifetime.curve, t) : buffer.startSize[i];

      if (useColor) {
        evaluateGradient(cfg.colorOverLifetime.gradient, t, gradientScratch);
        // Multiplied against the birth color, not replacing it, so a
        // gradient authored as a white-to-transparent fade works as an
        // alpha envelope over whatever start color the main module set.
        buffer.colR[i] = buffer.startR[i] * gradientScratch[0];
        buffer.colG[i] = buffer.startG[i] * gradientScratch[1];
        buffer.colB[i] = buffer.startB[i] * gradientScratch[2];
        buffer.colA[i] = buffer.startA[i] * gradientScratch[3];
      }

      if (useRotation) buffer.rotation[i] += buffer.angularVelocity[i] * dt;

      if (useSheet) {
        if (sheet.mode === "lifetime") {
          buffer.frame[i] = (t * sheet.cycles * totalFrames) % totalFrames;
        } else if (sheet.mode === "fps") {
          buffer.frame[i] = (age * sheet.fps) % totalFrames;
        } else {
          const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
          buffer.frame[i] = (speed * sheet.fps) % totalFrames;
        }
      }
    }
  }

  /**
   * Gravity expressed in whatever frame the simulation actually runs in.
   *
   * World space is trivially world-down. Local space has to rotate
   * world-down *into* the emitter's own frame — otherwise a tilted
   * emitter's smoke rises along the emitter's up instead of the world's,
   * which looks fine at zero rotation and obviously broken the moment
   * anyone tilts it.
   *
   * `transformDirection` normalizes, so the magnitude is applied after it
   * rather than before — scaling first and then normalizing would throw
   * the magnitude away.
   */
  private resolveGravity(out: THREE.Vector3): void {
    const modifier = this.config.main.gravityModifier;
    if (modifier === 0) {
      out.set(0, 0, 0);
      return;
    }
    out.copy(WORLD_DOWN);
    if (this.config.main.simulationSpace === "local" && this.worldMatrix) {
      inverseScratch.copy(this.worldMatrix).invert();
      out.transformDirection(inverseScratch);
    }
    out.multiplyScalar(GRAVITY * modifier);
  }

  /**
   * The emitter's current world matrix, refreshed by ParticleEmitter each
   * frame before `step()`.
   *
   * Read for exactly two things: rotating gravity into local space above,
   * and lifting a spawn into world space below. Left `undefined` for an
   * emitter that has never been placed in a scene, in which case both
   * paths degrade to the identity case rather than throwing.
   */
  worldMatrix: THREE.Matrix4 | undefined;
}
