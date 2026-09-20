import * as THREE from "three";
import { LoopOnce, LoopRepeat } from "three";
import { disposeMaterial } from "../../../../src/engine/core/disposeScene";
import { LoopAnimator } from "../../../../src/engine/core/Animator";
import { getActiveGame } from "./context";
import type { Collider } from "../../../../src/engine/collision";
// Type-only, so it erases — `prop.ts` imports *this* module for `SceneNode`,
// and a value import back would be a genuine cycle. The runtime half comes in
// through `installPropFactory` below, the same shape prop.ts already uses to
// receive the colour parser from ion.ts.
import type { Prop } from "./prop";

/** Reused by distanceTo so a per-frame distance check allocates nothing. */
const scratch = new THREE.Vector3();

/** Builds (or returns the existing) handle for a raw object — supplied by prop.ts at module load. See the type-only import above for why it is injected. */
let propFactory: ((object: THREE.Object3D) => Prop) | undefined;

/** @internal — called once by prop.ts. */
export function installPropFactory(fn: (object: THREE.Object3D) => Prop): void {
  propFactory = fn;
}

/**
 * Marks a mesh whose geometry and material ION built and may therefore free.
 *
 * `ION.scene.box()` and friends build a fresh geometry and material per call,
 * so whatever ends up owning one can release it. A model instantiated from the
 * asset manifest shares both with every other clone of that GLB and with the
 * loader's cache, so freeing it on one handle's destroy() would blank every
 * other copy in the scene. The flag is what tells the two apart.
 */
export const ION_OWNED = "__ionOwned";

/** A live x/y/z view. Reading and writing go straight through — no copies, no sync step. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): void;
}

/**
 * A 3D vector, with the maths on it.
 *
 * `position` and `scale` hand one of these back, and it is **live** — writing
 * to it moves the thing, with no apply step:
 *
 * ```ts
 * player.position.y += 2;
 * player.position.add(ION.vec3(0, 0, 1));
 * const away = ION.vec3().subVectors(enemy.position, player.position).normalize();
 * ```
 *
 * Deliberately a type alias for three's own `Vector3` rather than a wrapper
 * class. A wrapper would mean reimplementing (and keeping correct) forty
 * methods of well-tested vector maths, and every one of them would allocate a
 * conversion on the way in and out of the engine — in `update()`, sixty times
 * a second. Aliasing costs nothing at runtime and gives the full surface:
 * `add`, `sub`, `addScaledVector`, `normalize`, `length`, `lerp`,
 * `distanceTo`, `cross`, `dot`, `clone`, `copy`, `applyQuaternion`, …
 *
 * A game still never writes `THREE`: it writes `Vec3` and `ION.vec3()`. That
 * is the boundary that matters — the name in your source, not the identity of
 * the prototype behind it.
 */
export type Vec3 = THREE.Vector3;

/**
 * Rotation as a quaternion, for the cases Euler angles handle badly (smoothly
 * turning toward a direction, blending two orientations). Same reasoning as
 * `Vec3` — the type is three's, the vocabulary is ION's.
 */
export type Quat = THREE.Quaternion;

/**
 * Everything in the world you can move, turn, scale, hide or throw away.
 *
 * The shared half of `Entity` and `Prop`. It exists so there is **one**
 * vocabulary to learn rather than two: whether you are holding something you
 * wrote a class for or something `ION.scene.box()` handed back, `moveBy`,
 * `rotation.y`, `lookAt` and `destroy()` mean the same thing and take the same
 * units.
 *
 * ## Why this is not "just use the three.js object"
 *
 * Because the units and the lifecycle are both wrong for game code:
 *
 * - `Object3D.rotation` is in **radians**. Every playable that ever span a
 *   coin wrote `rotation.y += dt * 2` and then had to reason about what
 *   `2` meant. Here it is degrees, and `2` is two degrees.
 * - `removeFromParent()` takes something out of the scene and **leaks its
 *   geometry and material**, because three.js frees GPU memory only when
 *   something calls `.dispose()`. A playable that spawns and destroys pickups
 *   — which is most of them — climbed in GPU memory for as long as the ad ran.
 *   `destroy()` here does both, and knows which resources are safe to free.
 * - `.material.color.set(0xff0000)` requires knowing that a mesh has a
 *   material, that the material has a color, and that the color is not a
 *   number. `handle.color = "red"` requires knowing none of it.
 *
 * The three.js object is still right there on `.object3D` for the cases this
 * does not cover. It is an escape hatch, not the main road.
 */
export abstract class SceneNode {
  /**
   * The three.js object behind this handle.
   *
   * Not needed for ordinary work. It is here so an advanced case is possible
   * rather than blocked.
   */
  abstract readonly object3D: THREE.Object3D;

  /** Colliders attached through `ION.colliders.attach`, retired when this is destroyed. */
  protected readonly bodies: Collider[] = [];
  /** Built once, then kept — see `rotation`. */
  private rotationView: Vec3Like | undefined;
  private spinner: LoopAnimator | undefined;
  /** The model's own clips, from the GLB. Empty for anything built by ION.scene.box() and friends. */
  private clips: THREE.AnimationClip[] = [];
  private mixer: THREE.AnimationMixer | undefined;
  private currentAction: THREE.AnimationAction | undefined;
  private currentName: string | undefined;

  /** The name this was given — what `ION.scene.find()` looks up. */
  get name(): string {
    return this.object3D.name;
  }
  set name(value: string) {
    this.object3D.name = value;
  }

  /**
   * Where it is — a **live** vector, so writing to it moves the thing.
   *
   * `Vec3` rather than a plain `{x, y, z}`: the maths comes with it, which is
   * the difference between `a.position.distanceTo(b.position)` and writing out
   * a square root by hand in an `update()`.
   */
  get position(): Vec3 {
    return this.object3D.position;
  }

  /** Which way it is facing, as a quaternion. `rotation` (degrees) is the easy one; this is for turning smoothly toward something. */
  get quaternion(): Quat {
    return this.object3D.quaternion;
  }

  /**
   * Rotation in **degrees**, because that is what people think in.
   *
   * The view is built once and kept. Rebuilding it — a fresh object and seven
   * closures — on every read meant an allocation per object per frame for the
   * ordinary `thing.rotation.y += 90 * dt`, and a GC pause is exactly the kind
   * of jank a playable cannot afford.
   */
  get rotation(): Vec3Like {
    if (this.rotationView) return this.rotationView;
    const e = this.object3D.rotation;
    const d = THREE.MathUtils.radToDeg;
    const r = THREE.MathUtils.degToRad;
    this.rotationView = {
      get x() { return d(e.x); },
      set x(v: number) { e.x = r(v); },
      get y() { return d(e.y); },
      set y(v: number) { e.y = r(v); },
      get z() { return d(e.z); },
      set z(v: number) { e.z = r(v); },
      set(x: number, y: number, z: number) { e.set(r(x), r(y), r(z)); },
    } as Vec3Like;
    return this.rotationView;
  }

  /** How big it is, per axis — live, like `position`. `size` sets all three at once. */
  get scale(): Vec3 {
    return this.object3D.scale;
  }

  /** Scale every axis at once. `thing.size = 2` is twice as big. */
  set size(value: number) {
    this.object3D.scale.setScalar(value);
  }

  /** Show or hide it. An Entity keeps updating either way. */
  get visible(): boolean {
    return this.object3D.visible;
  }
  set visible(v: boolean) {
    this.object3D.visible = v;
  }

  /** Put it at an exact spot. */
  moveTo(x: number, y: number, z: number): this {
    this.object3D.position.set(x, y, z);
    return this;
  }

  /** Shift it by an amount — the usual way to move something each frame. */
  moveBy(x: number, y: number, z: number): this {
    this.object3D.position.x += x;
    this.object3D.position.y += y;
    this.object3D.position.z += z;
    return this;
  }

  /** Turn it by an amount, in degrees. */
  rotateBy(x: number, y: number, z: number): this {
    const r = THREE.MathUtils.degToRad;
    this.object3D.rotation.x += r(x);
    this.object3D.rotation.y += r(y);
    this.object3D.rotation.z += r(z);
    return this;
  }

  /**
   * Turn forever, at `degreesPerSecond`. Negative goes the other way; `0`
   * stops. Returns this, so `ION.scene.box().spin(120)` reads as one thing.
   *
   * This is the single most common thing a playable does to a prop — a
   * spinning coin, a rotating reward, a turning arrow — and writing it by hand
   * means keeping the object, finding it every frame, and remembering that
   * `rotation` is radians. It runs on **game time**, so it freezes with
   * gameplay while an editor is open instead of spinning behind it, and it is
   * cancelled by `destroy()`.
   */
  spin(degreesPerSecond: number, axis: "x" | "y" | "z" = "y"): this {
    this.spinner?.cancel();
    this.spinner = undefined;
    if (!degreesPerSecond) return this;

    const euler = this.object3D.rotation;
    const direction = Math.sign(degreesPerSecond);
    const turn = THREE.MathUtils.degToRad(360) * direction;
    let previous = 0;
    // Applied as a *delta* rather than an absolute angle, so a spin composes
    // with whatever else turns the object instead of fighting it — and so the
    // wrap at the end of each cycle is seamless rather than a snap back to
    // where the spin happened to start.
    this.spinner = new LoopAnimator({ time: 360 / Math.abs(degreesPerSecond) }, (t) => {
      const delta = t >= previous ? t - previous : t + 1 - previous;
      previous = t;
      euler[axis] += delta * turn;
    });
    return this;
  }

  /** Stop a `spin()`. Leaves it wherever it got to. */
  stopSpin(): this {
    this.spinner?.cancel();
    this.spinner = undefined;
    return this;
  }

  /** Face a point or another thing. */
  lookAt(target: SceneNode | { x: number; y: number; z: number }): this {
    const p = target instanceof SceneNode ? target.object3D.position : target;
    this.object3D.lookAt(p.x, p.y, p.z);
    return this;
  }

  /** Straight-line distance to another thing or a point. */
  distanceTo(target: SceneNode | { x: number; y: number; z: number }): number {
    if (target instanceof SceneNode) return this.object3D.position.distanceTo(target.object3D.position);
    // A shared scratch vector rather than a new one: distance checks are the
    // most common thing in an update(), and this is called from inside loops.
    return this.object3D.position.distanceTo(scratch.set(target.x, target.y, target.z));
  }

  /**
   * A named part *inside* this model, as its own handle.
   *
   * A GLB is a tree, and the useful things in it have names: a weapon socket,
   * a headlight, a variant mesh the artist left in for you to switch between.
   * Reaching one meant `object3D.getObjectByName(...)` and then raw three.js
   * on whatever came back.
   *
   * ```ts
   * hero.part("Sword")?.hide();
   * hero.part("Cape")?.color = "red";
   * ```
   */
  part(name: string): Prop | undefined {
    const found = this.object3D.getObjectByName(name);
    if (!found) return undefined;
    // Deliberately no `import {` in this string: the ad-network compatibility
    // scanner matches on plain text (see scripts/compat-scan.mjs, which says
    // so), and an ES-module token inside a *string literal* in the shipped
    // bundle trips its "real import syntax in a classic script" rule. That is
    // a false positive, but it is one the build gate fails on — which it did,
    // for exactly this line.
    if (!propFactory) throw new Error("ION: the Prop factory was not registered. Reach the API through the package entry point rather than a deep path, or report this.");
    return propFactory(found);
  }

  /** Hide it. Shorthand for `visible = false`, so a chain reads as one thought. */
  hide(): this {
    this.object3D.visible = false;
    return this;
  }

  show(): this {
    this.object3D.visible = true;
    return this;
  }

  /**
   * Whether this casts a shadow, applied to every mesh underneath.
   *
   * Per-mesh in three.js, which for a loaded model means traversing it — and
   * `castShadow` on the group itself does nothing at all, silently, which is
   * a genuinely confusing thing to get wrong.
   */
  set castShadow(value: boolean) {
    this.object3D.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) node.castShadow = value;
    });
  }

  set receiveShadow(value: boolean) {
    this.object3D.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) node.receiveShadow = value;
    });
  }

  /** Attach something so it moves with this. */
  add(child: SceneNode | THREE.Object3D): this {
    this.object3D.add(child instanceof SceneNode ? child.object3D : child);
    return this;
  }

  // ── Animation ───────────────────────────────────────────────────────────
  //
  // A rigged model is the normal case for a character, and until this existed
  // the plain API could load one and then do nothing with it: the clips came
  // back on the GLB, `ION.scene.model()` dropped them, and driving a
  // `THREE.AnimationMixer` by hand meant importing three, keeping a Map of
  // actions, remembering to tick it every frame, and writing the crossfade.

  /** Every clip name this model shipped with. Empty for anything that isn't an animated GLB. */
  get animations(): string[] {
    return this.clips.map((clip) => clip.name);
  }

  /** True while a clip is playing. */
  get isPlaying(): boolean {
    return this.currentAction !== undefined && this.currentAction.isRunning();
  }

  /** The clip currently playing, or undefined. */
  get currentAnimation(): string | undefined {
    return this.currentName;
  }

  /**
   * Play one of the model's clips, crossfading from whatever is playing.
   *
   * ```ts
   * hero.play("Run");                       // 0.2s blend, loops
   * hero.play("Jump", { loop: false });     // plays once, holds the last pose
   * hero.play("Walk", { fade: 0, speed: 2 });
   * ```
   *
   * Re-playing the clip that is already playing is a no-op rather than a
   * restart — calling `play("Run")` from an `update()` while a key is held is
   * the obvious way to write movement, and restarting every frame would pin
   * the animation to frame zero forever.
   */
  play(name: string, options: { fade?: number; loop?: boolean; speed?: number } = {}): this {
    const clip = this.clips.find((c) => c.name === name);
    if (!clip) {
      console.warn(
        `${this.object3D.name}.play("${name}"): no such animation.` +
          (this.clips.length ? ` This model has: ${this.animations.join(", ")}.` : " This model has no animations.")
      );
      return this;
    }
    if (this.currentName === name && this.currentAction?.isRunning()) {
      // Already running — only the knobs are allowed to change.
      if (options.speed !== undefined) this.currentAction.timeScale = options.speed;
      return this;
    }

    const mixer = this.ensureMixer();
    const next = mixer.clipAction(clip);
    next.enabled = true;
    next.timeScale = options.speed ?? 1;
    next.setLoop(options.loop === false ? LoopOnce : LoopRepeat, Infinity);
    // A one-shot that snaps back to the bind pose reads as a glitch; holding
    // the last frame is what every "land", "die" or "open" clip wants.
    next.clampWhenFinished = options.loop === false;
    next.reset();

    const fade = options.fade ?? 0.2;
    if (this.currentAction && this.currentAction !== next && fade > 0) {
      this.currentAction.crossFadeTo(next.play(), fade, false);
    } else {
      this.currentAction?.stop();
      next.play();
    }

    this.currentAction = next;
    this.currentName = name;
    return this;
  }

  /** Stop whatever is playing and return to the model's bind pose. */
  stopAnimation(): this {
    this.currentAction?.stop();
    this.currentAction = undefined;
    this.currentName = undefined;
    return this;
  }

  /**
   * Advances this model's animation. Called by the game's own frame loop —
   * game code never needs to.
   *
   * @internal
   */
  tickAnimation(dt: number): void {
    this.mixer?.update(dt);
  }

  /**
   * Hands this node its clips. Called by `ION.scene.model()` right after the
   * GLB is instantiated.
   *
   * @internal
   */
  setClips(clips: THREE.AnimationClip[]): void {
    this.clips = clips;
  }

  /**
   * Built on first `play()`, not at construction.
   *
   * A mixer registers with the running game so it gets ticked, and most nodes
   * are never animated — a coin, a wall, a ground plane. Building one for each
   * would put a per-frame `mixer.update()` on every prop in the scene to
   * advance nothing.
   */
  private ensureMixer(): THREE.AnimationMixer {
    if (!this.mixer) {
      this.mixer = new THREE.AnimationMixer(this.object3D);
      getActiveGame()?.registerAnimated(this);
    }
    return this.mixer;
  }

  /** @internal — `ION.colliders.attach` records the collider here so destroy() takes it back out of the world. */
  trackCollider(collider: Collider): void {
    this.bodies.push(collider);
  }

  /**
   * Everything `destroy()` has to do regardless of which kind of handle this
   * is: stop the spin, unparent, free the GPU resources ION built for it, and
   * retire any collider attached to it.
   *
   * A collider outliving the thing it was attached to keeps overlapping at
   * whatever transform it last saw, so a destroyed pickup would go on firing
   * the zone it was standing in.
   */
  protected releaseSceneResources(): void {
    this.stopSpin();
    // A mixer left registered keeps being ticked every frame for a node that
    // is no longer in the scene, and keeps the clips (and the object) alive.
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.object3D);
      getActiveGame()?.unregisterAnimated(this);
      this.mixer = undefined;
      this.currentAction = undefined;
      this.currentName = undefined;
    }
    this.object3D.removeFromParent();
    // Each marked node's **own** geometry and material, and nothing below it.
    // This used to hand the marked node to `disposeObject3D`, which walks the
    // whole subtree — so anything parented under an ION-built shape was freed
    // along with it, marker or no marker. Attach a model from the asset
    // manifest to a box and destroying the box blanked every other clone of
    // that GLB in the scene, because they all share one geometry. The marker
    // means "these resources are ION's to free", and that claim is about one
    // node, not its descendants.
    this.object3D.traverse((node) => {
      if (!node.userData[ION_OWNED]) return;
      const mesh = node as Partial<THREE.Mesh> & THREE.Object3D;
      mesh.geometry?.dispose?.();
      const material = mesh.material;
      if (Array.isArray(material)) for (const entry of material) disposeMaterial(entry);
      else if (material) disposeMaterial(material);
    });
    for (const body of this.bodies) body.destroy();
    this.bodies.length = 0;
  }
}
