import * as THREE from "three";
import { ParticleEmitter } from "./ParticleEmitter";
import type { ParticleEmitterConfig, ParticleSystemConfig, SubEmitterTrigger } from "./ParticleTypes";

const worldPoint = new THREE.Vector3();
const localPoint = new THREE.Vector3();
const inverseScratch = new THREE.Matrix4();

/**
 * A named group of emitters that play together — the unit gameplay
 * actually holds a reference to and calls `play()` on.
 *
 * An explosion is not one emitter: it's a flash, a debris burst, a shock
 * ring, and a lingering smoke column, each with a different lifetime,
 * material, and shape. Making the *system* the gameplay-facing object
 * means `explosion.play()` starts all four, and adding a fifth later is a
 * data change rather than a code change at every call site.
 *
 * ## Sub-emitters live here, not in the simulation
 *
 * `ParticleSimulation` emits birth/death/collision events and knows
 * nothing about other emitters — that's deliberate, and it's what keeps
 * the simulation a pure per-particle loop. Routing those events into
 * another emitter needs to know about siblings, which is exactly what this
 * class is, so the wiring lives here.
 *
 * The space conversion matters and is easy to get wrong: a parent
 * simulating in local space reports a *local* position, while the child
 * that needs to spawn there may be simulating in world space (or vice
 * versa). `convertPoint` puts the trigger point into the child's own frame
 * before emitting, so an explosion's sparks appear where the debris
 * actually was rather than offset by the emitter's transform.
 */
export class ParticleSystem {
  readonly id: string;
  readonly group = new THREE.Object3D();
  private readonly emitters: ParticleEmitter[] = [];
  private readonly byName = new Map<string, ParticleEmitter>();
  /** Where world-space emitters park their render meshes. Held so a re-added emitter can have its mesh parenting restored. */
  private worldRoot: THREE.Object3D | undefined;
  /** Guards against a sub-emitter chain feeding back into itself — see fireSubEmitters. */
  private subEmitterDepth = 0;

  constructor(config: ParticleSystemConfig) {
    this.id = config.id;
    this.group.name = config.name;
    this.group.userData.ionParticleSystem = config.id;
    for (const emitterConfig of config.emitters) this.addEmitter(emitterConfig);
    this.wireSubEmitters();
  }

  get name(): string {
    return this.group.name;
  }
  set name(value: string) {
    this.group.name = value;
  }

  get all(): readonly ParticleEmitter[] {
    return this.emitters;
  }

  get(name: string): ParticleEmitter | undefined {
    return this.byName.get(name);
  }

  getById(id: string): ParticleEmitter | undefined {
    return this.emitters.find((e) => e.id === id);
  }

  /**
   * Builds and registers one emitter.
   *
   * The events object is created here rather than in ParticleEmitter
   * because only this class can resolve a sub-emitter's target — and it's
   * created even when the sub-emitter module is off, because it's three
   * closures with an early return, and rebuilding the emitter just to turn
   * sub-emitters on in the Inspector would drop its live particles.
   *
   * **The emitter is not started here.** Auto-play is deferred to
   * `autoStart()`, called once the whole system is registered and its
   * world root is set — see ParticleEmitter.autoStart for the two things
   * that broke when a constructor was allowed to begin simulating.
   *
   * `self` is a plain `let`, written immediately after construction, and
   * the closures null-check it. A `const` captured by those closures is in
   * its temporal dead zone for the whole constructor call, so any spawn
   * during construction threw "Cannot access 'emitter' before
   * initialization" rather than doing something sensible. Deferring
   * auto-play fixes the case that actually happened; this makes the
   * remaining ones (a future constructor-time spawn from anywhere else)
   * degrade to "no sub-emitter fired" instead of a crash.
   */
  addEmitter(config: ParticleEmitterConfig): ParticleEmitter {
    let self: ParticleEmitter | undefined;
    const fire = (trigger: SubEmitterTrigger, x: number, y: number, z: number, vx: number, vy: number, vz: number): void => {
      if (!self) return;
      this.fireSubEmitters(self, trigger, x, y, z, vx, vy, vz);
    };
    const emitter = new ParticleEmitter(config, {
      onBirth: (x, y, z, vx, vy, vz) => fire("birth", x, y, z, vx, vy, vz),
      onDeath: (x, y, z, vx, vy, vz) => fire("death", x, y, z, vx, vy, vz),
      onCollision: (x, y, z, vx, vy, vz) => fire("collision", x, y, z, vx, vy, vz),
    });
    self = emitter;
    this.emitters.push(emitter);
    this.byName.set(emitter.name, emitter);
    this.group.add(emitter.node);
    return emitter;
  }

  /**
   * Honours every emitter's `playOnStart`.
   *
   * Called by ParticleManager.add() *after* `setWorldRoot()`, so a
   * world-space emitter's prewarm has a real world matrix to bake into its
   * particles. Safe to call more than once — `play()` on an
   * already-playing emitter is a no-op, and prewarm is guarded on the
   * buffer being empty.
   */
  autoStart(): this {
    for (const emitter of this.emitters) emitter.autoStart();
    return this;
  }

  /**
   * Unregisters an emitter.
   *
   * `keepAlive` detaches it without releasing its GPU resources, so the
   * *same instance* can be re-added later — the editor's undo path is the
   * only caller that wants that, exactly as with
   * `ColliderManager.remove`. Every other caller must let it dispose, or
   * the buffers leak.
   */
  removeEmitter(emitter: ParticleEmitter, keepAlive = false): boolean {
    const index = this.emitters.indexOf(emitter);
    if (index < 0) return false;
    this.emitters.splice(index, 1);
    this.byName.delete(emitter.name);
    if (keepAlive) emitter.detach();
    else emitter.dispose();
    return true;
  }

  /** Re-registers an emitter removed with `keepAlive` — the undo of removeEmitter. */
  readdEmitter(emitter: ParticleEmitter): ParticleEmitter {
    if (this.emitters.includes(emitter)) return emitter;
    this.emitters.push(emitter);
    this.byName.set(emitter.name, emitter);
    this.group.add(emitter.node);
    // Restores the render mesh's parent, which detach() cleared and which
    // differs by simulation space (this group vs. the manager's).
    emitter.setWorldRoot(this.worldRoot);
    return emitter;
  }

  /** Rebuilds the name index — called after a rename, since sub-emitters resolve their target by name. */
  wireSubEmitters(): void {
    this.byName.clear();
    for (const emitter of this.emitters) this.byName.set(emitter.name, emitter);
  }

  // -----------------------------------------------------------------------
  // Public runtime API
  // -----------------------------------------------------------------------

  play(): this {
    for (const emitter of this.emitters) if (emitter.enabled) emitter.play();
    return this;
  }

  pause(): this {
    for (const emitter of this.emitters) emitter.pause();
    return this;
  }

  stop(): this {
    for (const emitter of this.emitters) emitter.stop();
    return this;
  }

  restart(): this {
    for (const emitter of this.emitters) if (emitter.enabled) emitter.restart();
    return this;
  }

  clear(): this {
    for (const emitter of this.emitters) emitter.clear();
    return this;
  }

  /** Emits `count` from every enabled emitter — the "fire this one-shot now" call. */
  emit(count: number): this {
    for (const emitter of this.emitters) if (emitter.enabled) emitter.emit(count);
    return this;
  }

  isPlaying(): boolean {
    return this.emitters.some((e) => e.isPlaying());
  }

  isFinished(): boolean {
    return this.emitters.every((e) => e.isFinished());
  }

  /**
   * Seeds every emitter deterministically.
   *
   * Each emitter gets `seed + index`, not the same number: identical seeds
   * across emitters would make a flash and a debris burst draw the same
   * random sequence, so their particles would be suspiciously correlated —
   * every spark leaving at the same angle as every smoke puff.
   */
  setSeed(seed: number): this {
    this.emitters.forEach((emitter, index) => emitter.setSeed((seed + index) >>> 0));
    return this;
  }

  /** Moves the whole effect. Convenience for the common "play this at the hit point" call. */
  setPosition(x: number, y: number, z: number): this {
    this.group.position.set(x, y, z);
    return this;
  }

  /** Plays the effect at a world position in one call — what a collision handler actually wants. */
  playAt(position: THREE.Vector3): this {
    this.group.position.copy(position);
    this.group.updateWorldMatrix(false, true);
    return this.restart();
  }

  get activeParticles(): number {
    let total = 0;
    for (const emitter of this.emitters) total += emitter.activeParticles;
    return total;
  }

  get maxParticles(): number {
    let total = 0;
    for (const emitter of this.emitters) total += emitter.maxParticles;
    return total;
  }

  get drawCalls(): number {
    let total = 0;
    for (const emitter of this.emitters) total += emitter.drawCalls;
    return total;
  }

  byteLength(): number {
    let total = 0;
    for (const emitter of this.emitters) total += emitter.byteLength();
    return total;
  }

  // -----------------------------------------------------------------------
  // Frame
  // -----------------------------------------------------------------------

  /** Returns how many emitters actually simulated, for the manager's stats. */
  update(dt: number, cameraPosition: THREE.Vector3 | undefined): number {
    let simulating = 0;
    for (const emitter of this.emitters) {
      if (emitter.update(dt, cameraPosition)) simulating++;
    }
    return simulating;
  }

  render(cameraMatrixWorld: THREE.Matrix4 | undefined): void {
    for (const emitter of this.emitters) emitter.render(cameraMatrixWorld);
  }

  setQualityScale(scale: number): void {
    for (const emitter of this.emitters) emitter.setQualityScale(scale);
  }

  setDepthTexture(depth: THREE.Texture | undefined, near: number, far: number): void {
    for (const emitter of this.emitters) emitter.setDepthTexture(depth, near, far);
  }

  setWorldRoot(root: THREE.Object3D | undefined): void {
    // Remembered so readdEmitter can restore a re-added emitter's mesh
    // parenting without the caller having to pass it back in.
    this.worldRoot = root;
    for (const emitter of this.emitters) emitter.setWorldRoot(root);
  }

  /**
   * Takes the whole system out of the scene without releasing anything —
   * see ParticleEmitter.detach for the ownership contract.
   *
   * Each emitter is detached individually rather than relying on the group
   * leaving the scene: a **world-space** emitter's render mesh is parented
   * under the manager's PARTICLES group, not under this system's own
   * group, so removing the group alone would leave its particles visibly
   * hanging in the scene.
   */
  detach(): void {
    for (const emitter of this.emitters) emitter.detach();
    this.group.removeFromParent();
  }

  /** Puts every emitter node back under this system's group — the counterpart of detach(). Mesh parenting is then restored by the caller's setWorldRoot. */
  reattach(): void {
    for (const emitter of this.emitters) this.group.add(emitter.node);
  }

  dispose(): void {
    for (const emitter of this.emitters) emitter.dispose();
    this.emitters.length = 0;
    this.byName.clear();
    this.group.removeFromParent();
  }

  // -----------------------------------------------------------------------
  // Sub-emitters
  // -----------------------------------------------------------------------

  private fireSubEmitters(parent: ParticleEmitter, trigger: SubEmitterTrigger, x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    const module = parent.settings.subEmitters;
    if (!module.enabled || module.entries.length === 0) return;
    // A chain like explosion -> sparks -> smoke is the point; a cycle
    // (A's death spawns B, B's death spawns A) would recurse until the
    // stack gives out. Depth-limiting is cheaper and more predictable than
    // trying to detect the cycle in the graph, and three levels is deeper
    // than any real effect needs.
    if (this.subEmitterDepth >= 3) return;

    this.subEmitterDepth++;
    for (const entry of module.entries) {
      if (entry.trigger !== trigger) continue;
      const child = this.byName.get(entry.emitter);
      if (!child || child === parent || !child.enabled) continue;
      // The parent's own seeded stream, never Math.random() — a
      // sub-emitter probability rolled off the global generator would make
      // any effect that uses one non-reproducible, quietly undoing the
      // whole point of setSeed().
      if (entry.probability < 1 && parent.nextRandom() >= entry.probability) continue;

      this.convertPoint(parent, child, x, y, z);
      const inherit = entry.inheritVelocity;
      child.emitAt(entry.count, localPoint.x, localPoint.y, localPoint.z, vx * inherit, vy * inherit, vz * inherit);
    }
    this.subEmitterDepth--;
  }

  /**
   * Moves a trigger point from the parent's simulation space into the
   * child's, leaving the result in `localPoint`.
   *
   * Both-local and both-world are the common cases and both collapse to a
   * copy. The mixed cases genuinely need the transform: without it, an
   * explosion emitter simulating in world space that spawns a local-space
   * smoke child would place every puff at the world coordinate treated as
   * a local offset — visibly flung away from the explosion by exactly the
   * emitter's own position.
   */
  private convertPoint(parent: ParticleEmitter, child: ParticleEmitter, x: number, y: number, z: number): void {
    const parentWorld = parent.settings.main.simulationSpace === "world";
    const childWorld = child.settings.main.simulationSpace === "world";
    localPoint.set(x, y, z);
    if (parentWorld === childWorld) return;

    if (parentWorld) {
      // World -> child local.
      child.node.updateWorldMatrix(true, false);
      inverseScratch.copy(child.node.matrixWorld).invert();
      localPoint.applyMatrix4(inverseScratch);
    } else {
      // Parent local -> world.
      parent.node.updateWorldMatrix(true, false);
      worldPoint.set(x, y, z).applyMatrix4(parent.node.matrixWorld);
      localPoint.copy(worldPoint);
    }
  }
}
