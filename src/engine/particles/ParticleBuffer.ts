/**
 * The particle store: one preallocated set of typed arrays, densely
 * packed, with no per-particle object anywhere.
 *
 * ## Structure of arrays, not array of structures
 *
 * Every attribute is its own `Float32Array` indexed by particle slot. The
 * alternative — an array of `{position, velocity, age, ...}` objects — costs
 * one allocation and one GC-tracked reference per particle, and scatters
 * each particle's fields across the heap so a simulation pass that touches
 * only `age` still pulls whole objects into cache. At 2000 particles × 60fps
 * that difference is the whole frame budget of a playable ad.
 *
 * ## Dense packing, not a free list
 *
 * Live particles always occupy `[0, count)`. Killing particle `i`
 * copies the last live particle into slot `i` and decrements `count`
 * (`swapRemove`). That keeps the array contiguous, which matters twice
 * over: the simulation loop is a straight `for (i = 0; i < count; i++)`
 * with no liveness check per slot, and the renderer can upload
 * `[0, count)` directly as `instanceCount` with no compaction pass.
 *
 * A free list would avoid the copy but reintroduce holes, and then every
 * consumer needs an `if (alive[i])` — a branch inside the hottest loop in
 * the system, plus a GPU upload that has to compact anyway.
 *
 * The one thing swap-remove costs is **stable ordering**: particle order is
 * not birth order after the first death. Nothing here depends on it (the
 * renderer sorts explicitly when asked — see ParticleRenderer.sortMode), and
 * `ParticleSimulation` accounts for it by stepping `i` backwards on removal.
 *
 * ## Allocation happens once
 *
 * `maxParticles` is a hard cap, allocated in the constructor and never
 * grown. Emitting past it is dropped rather than reallocating: a
 * mid-effect reallocation is a frame spike exactly when the effect is
 * busiest, which is the worst possible moment for it.
 */
export class ParticleBuffer {
  readonly capacity: number;

  /** Position, in whatever space the emitter simulates in. */
  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly posZ: Float32Array;

  readonly velX: Float32Array;
  readonly velY: Float32Array;
  readonly velZ: Float32Array;

  /** Seconds lived so far. */
  readonly age: Float32Array;
  /** Total seconds this particle gets. `age / lifetime` is the normalized t every curve/gradient is sampled at. */
  readonly lifetime: Float32Array;

  /** Size at birth, before Size over Lifetime scales it. */
  readonly startSize: Float32Array;
  /** Current size, after every size module — what the renderer uploads. */
  readonly size: Float32Array;

  /** Radians. */
  readonly rotation: Float32Array;
  /** Radians/sec. */
  readonly angularVelocity: Float32Array;

  /** Birth color, so Color over Lifetime can multiply rather than replace. */
  readonly startR: Float32Array;
  readonly startG: Float32Array;
  readonly startB: Float32Array;
  readonly startA: Float32Array;

  /** Current color — what the renderer uploads. */
  readonly colR: Float32Array;
  readonly colG: Float32Array;
  readonly colB: Float32Array;
  readonly colA: Float32Array;

  /** Flipbook frame index, as a float so a `lifetime`-driven sheet can advance smoothly and the shader can floor it. */
  readonly frame: Float32Array;

  /**
   * Per-particle random draws, fixed at birth.
   *
   * Four of them, because several modules need a *stable* random that
   * doesn't change frame to frame — a particle whose noise offset was
   * re-rolled every frame would jitter instead of drifting. Drawing them
   * once at spawn and reading them thereafter is what makes per-particle
   * variation deterministic and free.
   */
  readonly rand0: Float32Array;
  readonly rand1: Float32Array;
  readonly rand2: Float32Array;
  readonly rand3: Float32Array;

  /**
   * Monotonic birth id, never reused.
   *
   * Trails need to know that slot 7 holds a *different* particle than it
   * did last frame (swap-remove reuses slots constantly), and a sub-emitter
   * firing on death needs to fire once per particle rather than once per
   * slot. The slot index alone can't answer either question.
   */
  readonly birthId: Float64Array;

  private liveCount = 0;
  private nextBirthId = 1;

  constructor(capacity: number) {
    const n = Math.max(1, Math.floor(capacity));
    this.capacity = n;
    this.posX = new Float32Array(n);
    this.posY = new Float32Array(n);
    this.posZ = new Float32Array(n);
    this.velX = new Float32Array(n);
    this.velY = new Float32Array(n);
    this.velZ = new Float32Array(n);
    this.age = new Float32Array(n);
    this.lifetime = new Float32Array(n);
    this.startSize = new Float32Array(n);
    this.size = new Float32Array(n);
    this.rotation = new Float32Array(n);
    this.angularVelocity = new Float32Array(n);
    this.startR = new Float32Array(n);
    this.startG = new Float32Array(n);
    this.startB = new Float32Array(n);
    this.startA = new Float32Array(n);
    this.colR = new Float32Array(n);
    this.colG = new Float32Array(n);
    this.colB = new Float32Array(n);
    this.colA = new Float32Array(n);
    this.frame = new Float32Array(n);
    this.rand0 = new Float32Array(n);
    this.rand1 = new Float32Array(n);
    this.rand2 = new Float32Array(n);
    this.rand3 = new Float32Array(n);
    this.birthId = new Float64Array(n);
  }

  /** Live particles. Slots `[0, count)` are all alive; nothing beyond it is. */
  get count(): number {
    return this.liveCount;
  }

  get isFull(): boolean {
    return this.liveCount >= this.capacity;
  }

  get free(): number {
    return this.capacity - this.liveCount;
  }

  /**
   * Claims the next free slot and returns its index, or -1 when full.
   *
   * Returning -1 rather than throwing or growing is deliberate: an emitter
   * hitting its cap is a *configured* outcome (maxParticles is a real knob
   * the Inspector shows), not an error, and the caller's correct response
   * is to stop emitting this frame — which is exactly what
   * ParticleSimulation does.
   */
  spawn(): number {
    if (this.liveCount >= this.capacity) return -1;
    const index = this.liveCount++;
    this.birthId[index] = this.nextBirthId++;
    return index;
  }

  /**
   * Kills the particle at `index` by moving the last live one into its
   * slot.
   *
   * The caller must not advance its loop counter after calling this — the
   * slot now holds a particle that hasn't been visited yet. See
   * ParticleSimulation.step, which steps `i` back by one.
   */
  swapRemove(index: number): void {
    const last = --this.liveCount;
    if (index === last) return;
    this.posX[index] = this.posX[last];
    this.posY[index] = this.posY[last];
    this.posZ[index] = this.posZ[last];
    this.velX[index] = this.velX[last];
    this.velY[index] = this.velY[last];
    this.velZ[index] = this.velZ[last];
    this.age[index] = this.age[last];
    this.lifetime[index] = this.lifetime[last];
    this.startSize[index] = this.startSize[last];
    this.size[index] = this.size[last];
    this.rotation[index] = this.rotation[last];
    this.angularVelocity[index] = this.angularVelocity[last];
    this.startR[index] = this.startR[last];
    this.startG[index] = this.startG[last];
    this.startB[index] = this.startB[last];
    this.startA[index] = this.startA[last];
    this.colR[index] = this.colR[last];
    this.colG[index] = this.colG[last];
    this.colB[index] = this.colB[last];
    this.colA[index] = this.colA[last];
    this.frame[index] = this.frame[last];
    this.rand0[index] = this.rand0[last];
    this.rand1[index] = this.rand1[last];
    this.rand2[index] = this.rand2[last];
    this.rand3[index] = this.rand3[last];
    this.birthId[index] = this.birthId[last];
  }

  /** Drops every live particle at once. No array is cleared — nothing reads past `count`, so zeroing 26 arrays would be pure waste. */
  clear(): void {
    this.liveCount = 0;
  }

  /** Total bytes held, for the Inspector's memory readout. */
  byteLength(): number {
    // 25 Float32Arrays + 1 Float64Array.
    return this.capacity * (25 * 4 + 8);
  }
}
