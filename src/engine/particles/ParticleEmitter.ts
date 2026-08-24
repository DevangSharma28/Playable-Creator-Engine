import * as THREE from "three";
import { ParticleBuffer } from "./ParticleBuffer";
import { ParticleRandom } from "./ParticleRandom";
import { ParticleRenderer } from "./ParticleRenderer";
import { ParticleSimulation, type ParticleEvents } from "./ParticleSimulation";
import { ParticleTrails } from "./ParticleTrails";
import type { ParticleEmitterConfig } from "./ParticleTypes";

/** Scratch for adoptNodeTransform's attachment inverse — module-level, since it runs once per emitter per editor frame. */
const adoptInverse = new THREE.Matrix4();
const adoptLocal = new THREE.Matrix4();
const adoptPos = new THREE.Vector3();
const adoptQuat = new THREE.Quaternion();
const adoptScale = new THREE.Vector3();
const adoptEuler = new THREE.Euler();

/**
 * One emitter: a config, the buffer its particles live in, the simulation
 * that advances them, and the renderer that draws them.
 *
 * This is the composition point, and deliberately thin — it owns lifecycle
 * (play/pause/stop/restart/clear), the scene node, and the local↔world
 * transform decision, and delegates literally everything else. The same
 * reasoning EditorRoot's doc comment gives for staying a wiring diagram:
 * the interesting behavior belongs in focused classes that can be tested
 * and replaced independently.
 *
 * ## The node, and why it isn't always the particles' parent
 *
 * `node` always carries the emitter's authored transform and always
 * appears in the Hierarchy — that's what the editor selects and gizmos.
 * Whether the *render mesh* is parented under it depends on simulation
 * space:
 *
 *  - `local` — mesh is a child of `node`, so particles inherit the
 *    emitter's transform every frame and move with it.
 *  - `world` — mesh is a child of the manager's PARTICLES group (held at
 *    identity), and each particle had the emitter transform baked in at
 *    birth. Moving the emitter afterwards leaves them behind, which is the
 *    entire point.
 *
 * Switching the mode at runtime re-parents the mesh and clears the live
 * particles, because the existing ones are expressed in the space that's
 * being left and would visibly teleport otherwise.
 */
export class ParticleEmitter {
  readonly node = new THREE.Object3D();
  readonly id: string;

  private config: ParticleEmitterConfig;
  private readonly buffer: ParticleBuffer;
  private readonly rng: ParticleRandom;
  private readonly simulation: ParticleSimulation;
  private readonly renderer: ParticleRenderer;
  private readonly trails: ParticleTrails | undefined;

  /** The scene object this emitter follows, if any. Never modified — same attachment-not-parenting contract colliders use. */
  attached: THREE.Object3D | undefined;

  /** Group the mesh goes into when simulating in world space. Set by ParticleManager on registration. */
  private worldRoot: THREE.Object3D | undefined;

  private readonly worldMatrix = new THREE.Matrix4();
  private readonly boundsSphere = new THREE.Sphere();
  /** Frames until the next bounds recompute — an O(count) pass with no rendering benefit, so it runs on a slow cadence rather than every frame. */
  private boundsCountdown = 0;
  private culled = false;

  /** True when the config came from particles.json (and belongs back in it) — same contract as Collider.persisted. */
  persisted = false;

  constructor(config: ParticleEmitterConfig, events: ParticleEvents = {}) {
    this.config = config;
    this.id = config.id;
    this.node.name = config.name;
    this.node.userData.ionParticleEmitter = config.id;

    const seed = config.main.autoRandomSeed ? (Math.random() * 0xffffffff) >>> 0 : config.main.seed;
    this.rng = new ParticleRandom(seed);
    this.buffer = new ParticleBuffer(config.main.maxParticles);
    this.simulation = new ParticleSimulation(config, this.buffer, this.rng, events);
    this.renderer = new ParticleRenderer(config.main.maxParticles, config.renderer);
    this.renderer.applyConfig(config.renderer, config.textureSheet);
    this.trails = config.trails.enabled ? new ParticleTrails(config.trails, config.main.maxParticles) : undefined;

    this.applyNodeTransform();
    this.node.add(this.renderer.mesh);
    if (this.trails) this.node.add(this.trails.mesh);

    // Deliberately does NOT start playing here — see autoStart() for why a
    // constructor that begins simulating is a real bug rather than a
    // convenience.
  }

  /**
   * Honours `playOnStart`, once the emitter is fully wired.
   *
   * **Must not be folded back into the constructor.** Doing so broke two
   * things at once, both of which are easy to reintroduce:
   *
   *  - `play()` runs `prewarm()`, which spawns particles immediately,
   *    which fires `onBirth` into ParticleSystem's sub-emitter routing —
   *    while that system's own `const emitter = new ParticleEmitter(...)`
   *    is still evaluating. The closure captured a binding in its temporal
   *    dead zone: "Cannot access 'emitter' before initialization".
   *  - Prewarm at construction time also runs *before* `setWorldRoot()`
   *    and before the first `syncTransform()`, so `simulation.worldMatrix`
   *    is undefined. A world-space emitter therefore prewarmed its entire
   *    backlog at the origin instead of at its own transform — silently
   *    wrong rather than crashing, which is worse.
   *
   * Callers invoke this after registration: ParticleManager.add() for a
   * whole system, and the editor after its own setWorldRoot() call.
   */
  autoStart(): this {
    if (this.config.main.playOnStart && this.config.enabled) this.play();
    return this;
  }

  // -----------------------------------------------------------------------
  // Public runtime API — what gameplay scripts call
  // -----------------------------------------------------------------------

  get name(): string {
    return this.node.name;
  }
  set name(value: string) {
    this.node.name = value;
    this.config.name = value;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Disabling stops simulation and hides the mesh, but keeps the emitter registered and editable — the Inspector still shows it. */
  setEnabled(enabled: boolean): this {
    this.config.enabled = enabled;
    if (!enabled) {
      this.simulation.pause();
      this.renderer.mesh.visible = false;
      this.trails?.setVisible(false);
    } else {
      // The renderer re-derives its own visibility from the live particle
      // count on the next sync(), but the trail layer has no such signal —
      // without this, disabling and re-enabling an emitter left its trails
      // permanently hidden.
      this.trails?.setVisible(true);
    }
    return this;
  }

  play(): this {
    this.simulation.play();
    // `loop` is required, matching ParticleSimulation.restart's own guard.
    // Prewarming a one-shot would run its entire duration at play() time
    // and leave it instantly finished — the effect would never be seen.
    if (this.config.main.prewarm && this.config.main.loop && this.buffer.count === 0) {
      // Refresh the transform first. Prewarm spawns a full duration's
      // worth of particles right now, and a world-space emitter bakes its
      // world matrix into every one of them at birth — so a stale (or
      // absent) matrix places the entire backlog at the origin. update()
      // would fix it for particles spawned later, but never for these.
      this.syncTransform();
      this.simulation.worldMatrix = this.worldMatrix;
      this.simulation.prewarm();
    }
    return this;
  }

  pause(): this {
    this.simulation.pause();
    return this;
  }

  /** Stops emitting; live particles finish their lifetimes. See ParticleSimulation.stop. */
  stop(): this {
    this.simulation.stop();
    return this;
  }

  restart(): this {
    // Same reason play() does it: restart() prewarms too (see
    // ParticleSimulation.restart), and prewarmed particles bake the world
    // matrix in at birth.
    this.syncTransform();
    this.simulation.worldMatrix = this.worldMatrix;
    this.simulation.restart();
    this.trails?.clear();
    return this;
  }

  /** Kills every live particle immediately. */
  clear(): this {
    this.simulation.clear();
    this.trails?.clear();
    return this;
  }

  /** Emits `count` particles right now, ignoring rate and duration. */
  emit(count: number): number {
    return this.simulation.emit(count);
  }

  /** Emits at an explicit point in this emitter's own simulation space — how sub-emitters spawn at their parent particle's position. */
  emitAt(count: number, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): number {
    return this.simulation.emit(count, x, y, z, vx, vy, vz);
  }

  isPlaying(): boolean {
    return this.simulation.isPlaying;
  }

  /** True once it has stopped emitting and every particle it made has died. */
  isFinished(): boolean {
    return this.simulation.isFinished;
  }

  /** Re-seeds and rewinds, so the next play() reproduces exactly. */
  setSeed(seed: number): this {
    this.config.main.seed = seed >>> 0;
    this.config.main.autoRandomSeed = false;
    this.rng.reseed(seed);
    return this;
  }

  get seed(): number {
    return this.rng.seed;
  }

  /**
   * One draw from this emitter's own seeded stream.
   *
   * Exposed so ParticleSystem can roll sub-emitter probabilities against
   * it instead of `Math.random()` — the global generator can't be seeded,
   * so a single probability check on it makes the entire effect
   * irreproducible no matter what `setSeed()` was given.
   */
  nextRandom(): number {
    return this.rng.next();
  }

  get activeParticles(): number {
    return this.buffer.count;
  }

  get maxParticles(): number {
    return this.buffer.capacity;
  }

  /** Live, mutable config — what the Inspector edits in place. Structural changes must go through applyConfig(). */
  get settings(): ParticleEmitterConfig {
    return this.config;
  }

  // -----------------------------------------------------------------------
  // Frame
  // -----------------------------------------------------------------------

  /**
   * One frame for this emitter.
   *
   * `dt` arrives unscaled; the emitter applies its own `simulationSpeed`
   * here so every downstream consumer (simulation, trails) sees one
   * consistent already-scaled value.
   *
   * Returns false when nothing was simulated (disabled, culled, or fully
   * idle), which is what lets the manager keep an honest "simulating"
   * count without re-deriving the condition.
   */
  update(dt: number, cameraPosition: THREE.Vector3 | undefined): boolean {
    if (!this.config.enabled) return false;

    this.syncTransform();

    if (this.applyCulling(cameraPosition)) {
      this.renderer.mesh.visible = false;
      this.trails?.setVisible(false);
      return false;
    }

    const scaled = dt * Math.max(0, this.config.main.simulationSpeed);
    this.simulation.worldMatrix = this.worldMatrix;
    this.simulation.step(scaled);
    this.trails?.update(this.buffer, scaled);

    if (--this.boundsCountdown <= 0) {
      this.boundsCountdown = 10;
      this.renderer.computeBounds(this.buffer, this.boundsSphere);
    }
    return this.simulation.isPlaying || this.buffer.count > 0;
  }

  /** Uploads to the GPU. Separate from update() so the manager can simulate every emitter before drawing any of them. */
  render(cameraMatrixWorld: THREE.Matrix4 | undefined): void {
    if (!this.config.enabled || this.culled) return;
    this.renderer.sync(this.buffer, cameraMatrixWorld);
    this.trails?.sync();
  }

  /**
   * Refreshes the emitter's own world transform from its authored
   * position/rotation/scale and whatever it's attached to.
   *
   * The attachment path mirrors Collider.syncWorld exactly, including the
   * forced `updateWorldMatrix` — emitters update during the gameplay pass,
   * before three's own render traversal, so reading `matrixWorld` without
   * refreshing it would be a frame stale for anything that just moved.
   */
  private syncTransform(): void {
    if (this.attached) {
      this.attached.updateWorldMatrix(true, false);
      this.node.matrix.copy(this.attached.matrixWorld).multiply(this.localMatrix());
      this.node.matrix.decompose(this.node.position, this.node.quaternion, this.node.scale);
    }
    // updateParents: true. The node's own parent chain (system group ->
    // PARTICLES group -> scene) can be stale — `playAt()` moves a system
    // group, and nothing else refreshes it before this runs.
    this.node.updateWorldMatrix(true, false);
    this.worldMatrix.copy(this.node.matrixWorld);
  }

  private readonly localScratch = new THREE.Matrix4();
  private readonly localEuler = new THREE.Euler();
  private readonly localQuat = new THREE.Quaternion();
  private readonly localPos = new THREE.Vector3();
  private readonly localScale = new THREE.Vector3();

  private localMatrix(): THREE.Matrix4 {
    const c = this.config;
    this.localPos.set(c.position[0], c.position[1], c.position[2]);
    this.localEuler.set(c.rotation[0] * THREE.MathUtils.DEG2RAD, c.rotation[1] * THREE.MathUtils.DEG2RAD, c.rotation[2] * THREE.MathUtils.DEG2RAD);
    this.localQuat.setFromEuler(this.localEuler);
    this.localScale.set(c.scale[0], c.scale[1], c.scale[2]);
    return this.localScratch.compose(this.localPos, this.localQuat, this.localScale);
  }

  /** Writes the authored transform onto the node. Used at construction and whenever the Inspector edits position/rotation/scale. */
  applyNodeTransform(): void {
    const c = this.config;
    this.node.position.set(c.position[0], c.position[1], c.position[2]);
    this.node.rotation.set(c.rotation[0] * THREE.MathUtils.DEG2RAD, c.rotation[1] * THREE.MathUtils.DEG2RAD, c.rotation[2] * THREE.MathUtils.DEG2RAD);
    this.node.scale.set(c.scale[0], c.scale[1], c.scale[2]);
  }

  /**
   * Reads the node's current transform back into the config — how a gizmo
   * drag becomes a saved value, the same two-way sync colliders use.
   *
   * **The attachment case must go through the inverse.** For an attached
   * emitter, `syncTransform` has already written the *world* transform
   * into the node (attached.matrixWorld × local), so copying
   * `node.position` straight into `config.position` stores a world
   * position in a field that's read back as a local offset. Next frame
   * that produces `attached.matrixWorld × worldPos`, and the frame after
   * that squares the error again — an attached emitter accelerated off
   * toward infinity within a second of the editor opening. Recovering the
   * local transform makes this idempotent: adopt(compose(L)) === L.
   */
  adoptNodeTransform(): void {
    const c = this.config;
    this.node.updateMatrix();

    if (this.attached) {
      this.attached.updateWorldMatrix(true, false);
      adoptInverse.copy(this.attached.matrixWorld).invert();
      adoptLocal.multiplyMatrices(adoptInverse, this.node.matrix);
      adoptLocal.decompose(adoptPos, adoptQuat, adoptScale);
      adoptEuler.setFromQuaternion(adoptQuat);
      c.position = [adoptPos.x, adoptPos.y, adoptPos.z];
      c.rotation = [THREE.MathUtils.radToDeg(adoptEuler.x), THREE.MathUtils.radToDeg(adoptEuler.y), THREE.MathUtils.radToDeg(adoptEuler.z)];
      c.scale = [adoptScale.x, adoptScale.y, adoptScale.z];
      return;
    }

    c.position = [this.node.position.x, this.node.position.y, this.node.position.z];
    c.rotation = [
      THREE.MathUtils.radToDeg(this.node.rotation.x),
      THREE.MathUtils.radToDeg(this.node.rotation.y),
      THREE.MathUtils.radToDeg(this.node.rotation.z),
    ];
    c.scale = [this.node.scale.x, this.node.scale.y, this.node.scale.z];
  }

  /**
   * Distance culling. Returns true when this emitter should be skipped
   * entirely this frame.
   *
   * Stops *simulation*, not just drawing — a far-off emitter that keeps
   * integrating a thousand particles nobody can see is the exact cost this
   * is meant to remove. That does mean a culled effect isn't where it
   * would have been when it comes back into range, which is the right
   * trade for ambient effects (the only kind anyone sets a cull distance
   * on) and the reason it's off by default.
   */
  private applyCulling(cameraPosition: THREE.Vector3 | undefined): boolean {
    const lod = this.config.lod;
    if (!lod.enabled || lod.cullDistance <= 0 || !cameraPosition) {
      this.culled = false;
      return false;
    }
    const dx = this.worldMatrix.elements[12] - cameraPosition.x;
    const dy = this.worldMatrix.elements[13] - cameraPosition.y;
    const dz = this.worldMatrix.elements[14] - cameraPosition.z;
    const reach = lod.cullDistance + this.boundsSphere.radius;
    this.culled = dx * dx + dy * dy + dz * dz > reach * reach;
    return this.culled;
  }

  // -----------------------------------------------------------------------
  // Config changes
  // -----------------------------------------------------------------------

  /**
   * Applies an edited config.
   *
   * Most edits are in-place on the object the Inspector already holds
   * (`settings`), so this is only for changes with *structural*
   * consequences — the ones a live mutation can't express on its own.
   */
  applyConfig(next: ParticleEmitterConfig): void {
    const previous = this.config;
    this.config = next;
    this.simulation.setConfig(next);
    this.node.name = next.name;

    if (previous.main.simulationSpace !== next.main.simulationSpace) {
      // The live particles are expressed in the space being left; keeping
      // them would teleport every one of them by the emitter transform.
      this.simulation.clear();
      this.trails?.clear();
      this.reparentMesh();
    }
    this.renderer.applyConfig(next.renderer, next.textureSheet);
    // ParticleTrails holds its own copy of the trail config (it reads it
    // in two hot loops and shouldn't chase a reference), so it has to be
    // told when that config changes — without this, every trail edit in
    // the Inspector silently did nothing.
    this.trails?.setConfig(next.trails);
    this.applyNodeTransform();
  }

  /** Called by the manager when registering, and again whenever simulation space changes. */
  setWorldRoot(root: THREE.Object3D | undefined): void {
    this.worldRoot = root;
    this.reparentMesh();
  }

  private reparentMesh(): void {
    const worldSpace = this.config.main.simulationSpace === "world";
    const parent = worldSpace && this.worldRoot ? this.worldRoot : this.node;
    if (this.renderer.mesh.parent !== parent) parent.add(this.renderer.mesh);
    if (this.trails && this.trails.mesh.parent !== parent) parent.add(this.trails.mesh);
  }

  /** Swaps the particle texture — the resolved THREE.Texture, not a path. Path resolution is the manager's job (it owns the AssetLoader). */
  setTexture(texture: THREE.Texture | undefined): void {
    this.renderer.setTexture(texture);
  }

  /** Supplies the base geometry for `mesh` render mode. */
  setMeshSource(geometry: THREE.BufferGeometry | undefined): void {
    this.renderer.setMeshSource(geometry);
  }

  setDepthTexture(depth: THREE.Texture | undefined, near: number, far: number): void {
    this.renderer.setDepthTexture(depth, near, far);
  }

  /** LOD/quality scale, applied to emission rate and burst counts. */
  setQualityScale(scale: number): void {
    this.simulation.quality = scale;
  }

  get bounds(): THREE.Sphere {
    return this.boundsSphere;
  }

  /**
   * Test-only seam (tests/particles.test.mjs) — the raw particle store.
   *
   * Same convention and the same reasoning as `UILayout.__geometry()`:
   * asserting on real particle positions otherwise needs a renderer and a
   * GL context, neither of which exists in a Node test, and neither of
   * which the assertions are actually about. Additive — nothing else in
   * this class or the engine calls it.
   */
  __buffer(): ParticleBuffer {
    return this.buffer;
  }

  get drawCalls(): number {
    return this.renderer.drawCalls + (this.trails?.drawCalls ?? 0);
  }

  byteLength(): number {
    return this.buffer.byteLength() + this.renderer.byteLength() + (this.trails?.byteLength() ?? 0);
  }

  /**
   * Takes the emitter out of the scene **without** releasing anything.
   *
   * The undo path's counterpart to dispose(): a deleted emitter has to
   * stay intact so that undoing the delete can put the very same instance
   * back, keeping every reference to it (a sub-emitter target, a Control
   * Desk assignment) valid. Live particles are cleared because they'd
   * otherwise reappear frozen mid-flight, which reads as a glitch rather
   * than an undo.
   *
   * Whatever holds a detached emitter owns it: it must eventually be
   * re-added or disposed, or its buffers leak. See EditorHistory's
   * `discard` contract.
   */
  detach(): void {
    this.simulation.pause();
    this.simulation.clear();
    this.trails?.clear();
    this.node.removeFromParent();
    this.renderer.mesh.removeFromParent();
    this.trails?.mesh.removeFromParent();
  }

  /**
   * Releases everything this emitter owns: GPU buffers, geometry,
   * material, any texture it owns exclusively, the trail pool, and its
   * scene node.
   *
   * The shared default texture and any host-loaded mesh geometry are
   * deliberately *not* released here — see ParticleRenderer.dispose.
   */
  dispose(): void {
    this.renderer.dispose();
    this.trails?.dispose();
    this.node.removeFromParent();
    this.attached = undefined;
  }
}
