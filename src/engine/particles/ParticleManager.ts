import * as THREE from "three";
import { ParticleSystem } from "./ParticleSystem";
import type { ParticleEmitter } from "./ParticleEmitter";
import { disposeDefaultParticleTexture } from "./ParticleMaterial";
import type { ParticleStats, ParticleSystemConfig } from "./ParticleTypes";

/**
 * The engine-owned group every particle system lives under. Uppercase for
 * exactly the reason COLLIDERS is: it must be unmistakable against any
 * similarly-named node a GLB happens to ship, and it reads as engine
 * infrastructure rather than scene content in the Hierarchy.
 */
export const PARTICLES_GROUP_NAME = "PARTICLES";

/** Quality tiers. `setQuality` scales emission rates rather than particle *size* or count caps, because a thinner effect reads as the same effect while a smaller one reads as a different one. */
export type ParticleQuality = "high" | "medium" | "low";

/**
 * Registry and per-frame driver for every particle system in the scene.
 *
 * Structurally the twin of ColliderManager, and for the same reasons:
 *
 *  - **Systems live in one engine-owned group at the scene root**, never
 *    salted through the GLB hierarchy. An emitter *attaches* to a scene
 *    object (recomputing its transform from that object's world matrix
 *    each frame) rather than parenting under it, so attachment survives
 *    the target being re-parented, swapped, or re-exported.
 *  - **The whole cost scales with the number of emitters**, not the size
 *    of the scene: nothing here traverses the scene graph.
 *  - **Pointing the registry at a different scene retires everything in
 *    it**, because an emitter attached to objects that aren't in the new
 *    scene is an emitter whose transform is meaningless.
 *
 * The manager is owned by IonEngine and cleared on teardown, so a
 * hot-reloaded bundle can't leave the previous one's emitters simulating
 * into the new scene.
 */
export class ParticleManager {
  /** Added to the scene by attachToScene(). Held at identity — world-space emitters render their meshes directly into it and assume no transform. */
  readonly group = new THREE.Group();

  private scene: THREE.Scene | undefined;
  private readonly systems: ParticleSystem[] = [];
  private readonly byId = new Map<string, ParticleSystem>();

  private quality: ParticleQuality = "high";
  private depthTexture: THREE.Texture | undefined;
  private near = 0.1;
  private far = 1000;

  private readonly cameraPosition = new THREE.Vector3();
  private cameraMatrixWorld: THREE.Matrix4 | undefined;
  private hasCamera = false;

  private stats: ParticleStats = {
    systems: 0,
    emitters: 0,
    activeParticles: 0,
    maxParticles: 0,
    simulating: 0,
    drawCalls: 0,
    bufferBytes: 0,
    lastUpdateMs: 0,
  };
  /** Recomputed on a slow cadence — walking every emitter for byte counts every frame would cost more than the thing it measures. */
  private statsCountdown = 0;

  constructor() {
    this.group.name = PARTICLES_GROUP_NAME;
  }

  // ---------------------------------------------------------------------
  // Scene
  // ---------------------------------------------------------------------

  /** Safe to call repeatedly with the same scene. Pointing it at a *different* one retires everything first — see the class doc. */
  attachToScene(scene: THREE.Scene): void {
    if (this.scene === scene) return;
    if (this.scene) this.clear();
    this.scene = scene;
    scene.add(this.group);
  }

  detachFromScene(): void {
    this.group.removeFromParent();
    this.scene = undefined;
  }

  get currentScene(): THREE.Scene | undefined {
    return this.scene;
  }

  // ---------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------

  /** Builds a system from config and registers it. */
  create(config: ParticleSystemConfig): ParticleSystem {
    const system = new ParticleSystem(config);
    return this.add(system);
  }

  add(system: ParticleSystem): ParticleSystem {
    if (this.byId.has(system.id)) return system;
    this.systems.push(system);
    this.byId.set(system.id, system);
    this.group.add(system.group);
    system.setWorldRoot(this.group);
    system.setQualityScale(this.qualityScale());
    if (this.depthTexture) system.setDepthTexture(this.depthTexture, this.near, this.far);
    // Last, and deliberately not inside ParticleSystem's constructor: a
    // world-space emitter's prewarm bakes its world matrix into every
    // particle it spawns, so it has to happen after the group is parented
    // and the world root is set. Quality scale is applied first for the
    // same reason — a prewarm at the wrong tier emits the wrong count.
    system.autoStart();
    return system;
  }

  /**
   * Unregisters a system.
   *
   * `keepAlive` detaches without releasing GPU resources so the same
   * instance can be re-added — the editor's undo path, same contract as
   * `ColliderManager.remove` and `ParticleSystem.removeEmitter`. Anything
   * holding a detached system owns it and must re-add or dispose it.
   */
  remove(system: ParticleSystem, keepAlive = false): void {
    const index = this.systems.indexOf(system);
    if (index < 0) return;
    this.systems.splice(index, 1);
    this.byId.delete(system.id);
    if (keepAlive) system.detach();
    else system.dispose();
  }

  /** Re-registers a system removed with `keepAlive` — the undo of remove(). */
  readd(system: ParticleSystem): ParticleSystem {
    if (this.byId.has(system.id)) return system;
    this.systems.push(system);
    this.byId.set(system.id, system);
    this.group.add(system.group);
    // Emitter nodes first, then setWorldRoot — detach() unparented both
    // the nodes and their render meshes, and the mesh's correct parent
    // depends on simulation space.
    system.reattach();
    system.setWorldRoot(this.group);
    system.setQualityScale(this.qualityScale());
    if (this.depthTexture) system.setDepthTexture(this.depthTexture, this.near, this.far);
    return system;
  }

  get all(): readonly ParticleSystem[] {
    return this.systems;
  }

  get(id: string): ParticleSystem | undefined {
    return this.byId.get(id);
  }

  /** First system with this name — how gameplay finds an effect it didn't create (`Ion.particles.getByName("Explosion")`). */
  getByName(name: string): ParticleSystem | undefined {
    return this.systems.find((s) => s.name === name);
  }

  /** Every emitter across every system, for the editor's flat lists. */
  get allEmitters(): ParticleEmitter[] {
    const out: ParticleEmitter[] = [];
    for (const system of this.systems) out.push(...system.all);
    return out;
  }

  /**
   * The emitter a scene object belongs to, if it's an emitter node or a
   * child of one — how a viewport raycast on a gizmo resolves back to the
   * emitter it's drawing. Mirrors ColliderManager.fromNode exactly.
   */
  emitterFromNode(object: THREE.Object3D | undefined): ParticleEmitter | undefined {
    let node: THREE.Object3D | null | undefined = object;
    while (node) {
      const id = node.userData?.ionParticleEmitter as string | undefined;
      if (id) {
        for (const system of this.systems) {
          const found = system.getById(id);
          if (found) return found;
        }
        return undefined;
      }
      node = node.parent;
    }
    return undefined;
  }

  /** The system a scene object belongs to. */
  systemFromNode(object: THREE.Object3D | undefined): ParticleSystem | undefined {
    let node: THREE.Object3D | null | undefined = object;
    while (node) {
      const id = node.userData?.ionParticleSystem as string | undefined;
      if (id) return this.byId.get(id);
      node = node.parent;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------

  /**
   * The camera particles are billboarded and distance-sorted against.
   *
   * Set once per frame by the host before update(). Held rather than
   * passed so the editor — which renders through a *different* camera than
   * gameplay — can point the whole system at its own camera for the
   * duration of a session with one call.
   */
  setCamera(camera: THREE.Camera | undefined): void {
    if (!camera) {
      this.hasCamera = false;
      this.cameraMatrixWorld = undefined;
      return;
    }
    this.hasCamera = true;
    this.cameraMatrixWorld = camera.matrixWorld;
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    const perspective = camera as THREE.PerspectiveCamera;
    if (perspective.isPerspectiveCamera) {
      this.near = perspective.near;
      this.far = perspective.far;
    }
  }

  /**
   * One simulation pass for every system.
   *
   * Called by IonEngine immediately after gameplay update, inside the same
   * not-paused guard as collision detection — so particles freeze with
   * gameplay behind an open editor rather than running on regardless, and
   * so an effect triggered this frame is simulated from where things
   * actually moved to.
   */
  update(dt: number): void {
    const started = import.meta.env.DEV ? performance.now() : 0;
    const camera = this.hasCamera ? this.cameraPosition : undefined;
    let simulating = 0;
    for (const system of this.systems) simulating += system.update(dt, camera);
    this.stats.simulating = simulating;
    if (import.meta.env.DEV) this.stats.lastUpdateMs = performance.now() - started;
  }

  /**
   * Uploads every system's particles to the GPU.
   *
   * Deliberately a separate pass from update(): simulating everything
   * before drawing anything means a sub-emitter that fired during another
   * emitter's update is already populated by the time its own upload
   * happens, instead of showing up a frame late.
   */
  render(): void {
    for (const system of this.systems) system.render(this.cameraMatrixWorld);
    if (--this.statsCountdown <= 0) {
      this.statsCountdown = 15;
      this.refreshStats();
    }
  }

  // ---------------------------------------------------------------------
  // Quality
  // ---------------------------------------------------------------------

  /**
   * Scales every effect down at once.
   *
   * Emission rate and burst counts are what scale — not lifetime, size, or
   * the max-particle cap. A low-tier effect should be the same effect with
   * fewer particles in it, and that's the only knob where "fewer" doesn't
   * also mean "different".
   */
  setQuality(quality: ParticleQuality): void {
    if (this.quality === quality) return;
    this.quality = quality;
    const scale = this.qualityScale();
    for (const system of this.systems) system.setQualityScale(scale);
  }

  getQuality(): ParticleQuality {
    return this.quality;
  }

  private qualityScale(): number {
    if (this.quality === "low") return 0.35;
    if (this.quality === "medium") return 0.65;
    return 1;
  }

  /**
   * Wires the scene depth texture soft particles need.
   *
   * Optional and off unless the host actually maintains a depth target —
   * soft particles are the one renderer feature that can't be self-
   * contained, since it needs the depth of geometry this system didn't
   * draw. With nothing wired, the `softParticles` flag compiles out and
   * the effect renders hard-edged rather than silently breaking.
   */
  setDepthTexture(depth: THREE.Texture | undefined): void {
    this.depthTexture = depth;
    for (const system of this.systems) system.setDepthTexture(depth, this.near, this.far);
  }

  // ---------------------------------------------------------------------
  // Stats & teardown
  // ---------------------------------------------------------------------

  getStats(): ParticleStats {
    return { ...this.stats };
  }

  private refreshStats(): void {
    let emitters = 0;
    let active = 0;
    let max = 0;
    let draws = 0;
    let bytes = 0;
    for (const system of this.systems) {
      emitters += system.all.length;
      active += system.activeParticles;
      max += system.maxParticles;
      draws += system.drawCalls;
      bytes += system.byteLength();
    }
    this.stats.systems = this.systems.length;
    this.stats.emitters = emitters;
    this.stats.activeParticles = active;
    this.stats.maxParticles = max;
    this.stats.drawCalls = draws;
    this.stats.bufferBytes = bytes;
  }

  /** Stops every system without destroying anything — the "pause all VFX" call. */
  pauseAll(): void {
    for (const system of this.systems) system.pause();
  }

  playAll(): void {
    for (const system of this.systems) system.play();
  }

  clearAllParticles(): void {
    for (const system of this.systems) system.clear();
  }

  /**
   * Retires everything: every system disposed (releasing its GPU
   * resources), the registry emptied, the group detached.
   *
   * Called by IonEngine's teardown for the same reason it clears the
   * collider registry — a hot-reloaded bundle's emitters would otherwise
   * keep simulating and drawing into the new one's scene.
   */
  clear(): void {
    for (const system of [...this.systems]) system.dispose();
    this.systems.length = 0;
    this.byId.clear();
    this.detachFromScene();
  }

  /**
   * Releases process-wide shared resources (the default particle texture).
   *
   * Separate from clear() and called only at real teardown: the shared
   * texture is used by every emitter that hasn't overridden it, so an
   * individual system disposing must never touch it, and a hot reload
   * that immediately builds new emitters would just rebuild it.
   */
  disposeSharedResources(): void {
    disposeDefaultParticleTexture();
  }
}
