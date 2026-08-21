import * as THREE from "three";
import type { ColliderData, ColliderShape, ShapeWorld } from "./ColliderTypes";
import { shapeContainsPoint, shapesOverlap } from "./intersect";

/** Called with the collider on the *other* side of the overlap, plus this one, so a single shared handler can serve several colliders. */
export type ColliderEventHandler = (other: Collider, self: Collider) => void;

/** Returned by every `on*` subscription — call it to stop listening. Same shape as EventBus's own handle, for the same reason: a subscriber that outlives its target is a leak nobody notices. */
export type ColliderEventHandle = () => void;

interface Subscription {
  /** Only fire when the other collider carries this tag. Undefined means "any". */
  tag: string | undefined;
  handler: ColliderEventHandler;
}

export interface ColliderInit {
  id?: string;
  name?: string;
  isTrigger?: boolean;
  enabled?: boolean;
  tag?: string;
  mask?: string[];
  /** The scene object this collider follows. Omit for a world-space collider. */
  attachTo?: THREE.Object3D;
  position?: THREE.Vector3 | [number, number, number];
  /** Euler angles in **degrees** — the same unit the Inspector shows, so nothing has to convert at the call site. */
  rotation?: THREE.Vector3 | [number, number, number];
  scale?: THREE.Vector3 | [number, number, number];
}

/** Pair keys pack two collider ids into one number (see ColliderManager.pairKey). 2^22 colliders is far past anything a playable will ever hold, and keeps the packed key inside Number.MAX_SAFE_INTEGER. */
const MAX_COLLIDERS = 1 << 22;
let nextNumericId = 1;

const composeScratch = new THREE.Matrix4();
const offsetScratch = new THREE.Matrix4();
const quatScratch = new THREE.Quaternion();
const invScratch = new THREE.Matrix4();
const posScratch = new THREE.Vector3();
const scaleScratch = new THREE.Vector3();

/**
 * A lightweight, physics-free collision volume.
 *
 * What it is: a shape, a transform, a tag, and an on/off switch. What it
 * deliberately is **not**: a rigidbody. There is no mass, no velocity, no
 * gravity, no solver, no contact resolution — nothing here ever moves a
 * scene object. Colliders are asked, once per frame, whether they overlap;
 * gameplay decides what that means.
 *
 * That's the right trade for a playable ad. A physics engine (Rapier and
 * friends) is hundreds of kilobytes of WASM and a simulation step you then
 * have to fight to keep deterministic — for a system whose entire job is
 * "tell me when the player reaches the zone". This costs a few kilobytes
 * and a handful of dot products.
 *
 * **Attachment, not parenting.** A collider's node lives under the
 * engine-owned COLLIDERS group, never inside the visual scene graph — see
 * ColliderManager's doc comment for why. `attachTo` makes it *follow* a
 * scene object instead: every frame its world transform is recomputed as
 * that object's world matrix times this collider's local offset, so it
 * tracks movement, rotation, and scale of the thing it's attached to
 * without ever touching that object or its meshes.
 *
 * **The sync is two-way.** If something else moves the node — the 3D
 * editor's transform gizmo is the case that matters — the change is
 * detected and folded back into the offset rather than being overwritten on
 * the next frame. That's what makes dragging a collider in the editor
 * actually stick.
 */
export abstract class Collider {
  /** Stable string id, persisted in colliders.json. */
  readonly id: string;
  /** Compact integer id, used only for pair keys — never persisted, never meaningful across sessions. */
  readonly numericId: number;
  abstract readonly shape: ColliderShape;

  /**
   * The collider's own transform carrier, and what the editor selects,
   * gizmos, and lists in the Hierarchy. Empty at runtime — it renders
   * nothing; the editor parents its wireframe visuals under it, and strips
   * them again on teardown.
   */
  readonly node = new THREE.Object3D();

  tag: string;
  /** Tags this collider will pair with. Empty means every tag — see ColliderManager.canPair. */
  mask: string[];
  isTrigger: boolean;

  /** Offset from `attached` (or from world origin when unattached), in that object's local space. */
  readonly offsetPosition = new THREE.Vector3();
  readonly offsetRotation = new THREE.Euler();
  readonly offsetScale = new THREE.Vector3(1, 1, 1);

  /** The scene object this collider follows, if any. Never modified by the collider. */
  attached: THREE.Object3D | undefined;

  /** Set by ColliderManager.add — the collider needs it to emit exits when it's disabled or destroyed mid-overlap. */
  manager: { onColliderDeactivated(collider: Collider): void } | undefined;

  /**
   * True for colliders that came from (and belong in) src/game/colliders.json.
   *
   * The 3D editor saves the file wholesale, so it needs to know which
   * colliders are its to write. A collider a script created — the Player's
   * own cylinder, say — is still shown, selectable, and editable in the
   * editor, but writing it to the JSON would resurrect it as a *second*
   * collider on the next boot, next to the one the script creates again.
   */
  persisted = false;

  private enabledFlag: boolean;
  private destroyed = false;
  /** The node matrix this collider last *wrote*. Anything else in `node.matrix` next frame came from outside (the gizmo, the Inspector, a script) and gets folded back into the offset. */
  private readonly lastWritten = new THREE.Matrix4();
  private hasWritten = false;

  private readonly triggerEnter: Subscription[] = [];
  private readonly triggerStay: Subscription[] = [];
  private readonly triggerExit: Subscription[] = [];
  private readonly collisionEnter: Subscription[] = [];
  private readonly collisionStay: Subscription[] = [];
  private readonly collisionExit: Subscription[] = [];

  protected constructor(init: ColliderInit) {
    this.id = init.id ?? `col_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
    this.numericId = nextNumericId++ % MAX_COLLIDERS;
    this.tag = init.tag ?? "Untagged";
    this.mask = init.mask ? [...init.mask] : [];
    this.isTrigger = init.isTrigger ?? false;
    this.enabledFlag = init.enabled ?? true;
    this.attached = init.attachTo;
    if (init.position) copyInto(this.offsetPosition, init.position);
    if (init.rotation) {
      copyInto(posScratch, init.rotation);
      this.offsetRotation.set(THREE.MathUtils.degToRad(posScratch.x), THREE.MathUtils.degToRad(posScratch.y), THREE.MathUtils.degToRad(posScratch.z));
    }
    if (init.scale) copyInto(this.offsetScale, init.scale);
    this.node.name = init.name ?? "Collider";
    // Not renderable and not raycast fodder at runtime; the editor adds its
    // own visuals as children and takes them away again.
    this.node.userData.ionCollider = this.id;
  }

  /** The Hierarchy row's label and the name gameplay looks colliders up by. Renaming keeps the node in step so the editor tree matches. */
  get name(): string {
    return this.node.name;
  }
  set name(value: string) {
    this.node.name = value;
  }

  get enabled(): boolean {
    return this.enabledFlag && !this.destroyed;
  }

  /**
   * Turning a collider off mid-overlap fires exit on every pair it was in
   * — the alternative is a gameplay handler that entered a zone and never
   * hears it left, which is the bug that makes "just set a flag" systems
   * unreliable.
   */
  setEnabled(enabled: boolean): this {
    if (this.enabledFlag === enabled) return this;
    this.enabledFlag = enabled;
    if (!enabled) this.manager?.onColliderDeactivated(this);
    return this;
  }

  /** True when this collider carries `tag`. The spec'd spelling of `collider.tag === "Player"`, and the one that keeps working if tags ever become a list. */
  checkTag(tag: string): boolean {
    return this.tag === tag;
  }

  /**
   * Follow a different scene object — or nothing (world space).
   *
   * **The collider does not move.** The offset is recomputed against the
   * new parent so the volume stays exactly where it is in the world, which
   * is the only behavior that makes sense when you're pointing at a prop
   * and saying "follow that": you placed the volume already, attaching is
   * about what it tracks from now on, not about where it goes.
   *
   * Keeping the old offset verbatim (the obvious implementation) teleports
   * it instead — a collider sitting at world (−8, 0, 8) re-homed onto a
   * prop 12 units away lands at *that prop's transform times* (−8, 0, 8),
   * i.e. somewhere off in the distance. That looked from the outside like
   * attaching had done nothing at all.
   *
   * Pass `preserveWorld: false` for the rare case where the offset really
   * is meant to be read as local from the start.
   */
  attachToObject(object: THREE.Object3D | undefined, preserveWorld = true): this {
    // Only meaningful once the collider has actually been placed in the
    // world at least once. Before the first sync the node's matrix is still
    // identity while the offset holds the real values, so "preserving" it
    // would zero the collider out.
    if (preserveWorld && this.hasWritten) {
      this.node.updateMatrix();
      if (object) {
        object.updateWorldMatrix(true, false);
        invScratch.copy(object.matrixWorld).invert();
        offsetScratch.multiplyMatrices(invScratch, this.node.matrix);
      } else {
        offsetScratch.copy(this.node.matrix);
      }
      offsetScratch.decompose(this.offsetPosition, quatScratch, this.offsetScale);
      this.offsetRotation.setFromQuaternion(quatScratch);
    }
    this.attached = object;
    this.hasWritten = false; // the node's current matrix means something different now — don't read it as an external edit
    return this;
  }

  /** Convenience for the common "sit this many units above the thing I'm attached to" case. */
  setOffsetPosition(x: number, y: number, z: number): this {
    this.offsetPosition.set(x, y, z);
    return this;
  }

  // ---------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------

  /**
   * Fires once, on the frame the overlap begins.
   *
   *   zone.onTriggerEnter("Player", (other) => hud.showPrompt());
   *   zone.onTriggerEnter((other) => log(other.tag));
   *
   * The optional first argument is a tag filter, which is the whole point
   * of the tag system: a trigger tagged `PlayerZone` that only wants the
   * player says so once here instead of testing `other.tag` in every
   * handler. It filters *in addition to* `mask` — mask decides which pairs
   * are evaluated at all, this decides which handlers hear about them.
   */
  onTriggerEnter(tagOrHandler: string | ColliderEventHandler, handler?: ColliderEventHandler): ColliderEventHandle {
    return subscribe(this.triggerEnter, tagOrHandler, handler);
  }

  /** Fires every frame the overlap continues, *after* the entering frame — enter and stay never both fire for the same pair on the same frame. */
  onTriggerStay(tagOrHandler: string | ColliderEventHandler, handler?: ColliderEventHandler): ColliderEventHandle {
    return subscribe(this.triggerStay, tagOrHandler, handler);
  }

  /** Fires once when the overlap ends — including when the other collider is disabled, destroyed, or removed from the scene while still inside. */
  onTriggerExit(tagOrHandler: string | ColliderEventHandler, handler?: ColliderEventHandler): ColliderEventHandle {
    return subscribe(this.triggerExit, tagOrHandler, handler);
  }

  /** The non-trigger counterpart. Fires for pairs where *neither* collider is a trigger — a trigger overlap produces trigger events only, so a zone never doubles as a collision. */
  onCollisionEnter(tagOrHandler: string | ColliderEventHandler, handler?: ColliderEventHandler): ColliderEventHandle {
    return subscribe(this.collisionEnter, tagOrHandler, handler);
  }
  onCollisionStay(tagOrHandler: string | ColliderEventHandler, handler?: ColliderEventHandler): ColliderEventHandle {
    return subscribe(this.collisionStay, tagOrHandler, handler);
  }
  onCollisionExit(tagOrHandler: string | ColliderEventHandler, handler?: ColliderEventHandler): ColliderEventHandle {
    return subscribe(this.collisionExit, tagOrHandler, handler);
  }

  /** Called by ColliderManager only. */
  dispatch(phase: "enter" | "stay" | "exit", trigger: boolean, other: Collider): void {
    const list = trigger
      ? phase === "enter"
        ? this.triggerEnter
        : phase === "stay"
          ? this.triggerStay
          : this.triggerExit
      : phase === "enter"
        ? this.collisionEnter
        : phase === "stay"
          ? this.collisionStay
          : this.collisionExit;
    if (list.length === 0) return;
    // Snapshot: a handler unsubscribing itself (very common for one-shot
    // gameplay beats) must not corrupt the iteration it's inside.
    for (const sub of [...list]) {
      if (sub.tag !== undefined && other.tag !== sub.tag) continue;
      sub.handler(other, this);
    }
  }

  // ---------------------------------------------------------------------
  // Per-frame transform + shape sync
  // ---------------------------------------------------------------------

  /**
   * Recomputes the node's world transform from `attached` + offset, folding
   * any external edit back into the offset first, then refreshes the
   * world-space shape the intersection tests read.
   *
   * Called once per frame per collider by ColliderManager.update(), before
   * any overlap test runs — which is what makes detection continuous and
   * correct for objects that move, rotate, or scale every frame, rather
   * than one frame stale.
   */
  syncWorld(): void {
    this.node.updateMatrix();
    if (this.hasWritten && !this.node.matrix.equals(this.lastWritten)) this.adoptNodeTransform();

    offsetScratch.compose(this.offsetPosition, quatScratch.setFromEuler(this.offsetRotation), this.offsetScale);
    if (this.attached) {
      // Force-refresh the attachment's own world matrix: colliders sync
      // during update(), before three.js's render-time traversal, so
      // reading matrixWorld without this would be a frame behind on
      // anything that just moved.
      this.attached.updateWorldMatrix(true, false);
      composeScratch.multiplyMatrices(this.attached.matrixWorld, offsetScratch);
    } else {
      composeScratch.copy(offsetScratch);
    }
    // The COLLIDERS group is held at identity (see ColliderManager), so the
    // node's local transform *is* its world transform — no parent inverse
    // needed here.
    composeScratch.decompose(this.node.position, this.node.quaternion, this.node.scale);
    this.node.updateMatrix();
    this.lastWritten.copy(this.node.matrix);
    this.hasWritten = true;
    this.node.updateMatrixWorld(true);

    this.node.matrixWorld.decompose(posScratch, quatScratch, scaleScratch);
    this.updateWorldShape(posScratch, quatScratch, scaleScratch);
  }

  /** Someone moved the node directly (the editor gizmo, an Inspector field). Convert its transform back into an offset so the next sync reproduces it instead of undoing it. */
  private adoptNodeTransform(): void {
    if (this.attached) {
      this.attached.updateWorldMatrix(true, false);
      invScratch.copy(this.attached.matrixWorld).invert();
      offsetScratch.multiplyMatrices(invScratch, this.node.matrix);
    } else {
      offsetScratch.copy(this.node.matrix);
    }
    offsetScratch.decompose(this.offsetPosition, quatScratch, this.offsetScale);
    this.offsetRotation.setFromQuaternion(quatScratch);
  }

  /** World-space shape, refreshed by syncWorld(). Reading it without a sync gives last frame's answer. */
  abstract get world(): ShapeWorld;

  /** Radius of a world-space sphere fully containing this collider — the broad phase's cheap reject. */
  abstract get boundingRadius(): number;

  /** Rebuilds `world` in place from the node's decomposed world transform. */
  protected abstract updateWorldShape(position: THREE.Vector3, quaternion: THREE.Quaternion, scale: THREE.Vector3): void;

  /** Shape-specific half of the persisted record — the base fields are filled in by ColliderSerialization. */
  abstract shapeData(): Partial<ColliderData>;

  /** Human-readable dimensions for the Inspector header, e.g. "2 × 1 × 2". */
  abstract describeShape(): string;

  // ---------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------

  /** Does this collider currently overlap `other`? Uses the last synced world shapes — call ColliderManager.update() first, or accept a frame of staleness. */
  overlaps(other: Collider): boolean {
    return shapesOverlap(this.world, other.world);
  }

  /** Is this world-space point inside the volume? */
  containsPoint(point: THREE.Vector3): boolean {
    return shapeContainsPoint(this.world, point);
  }

  /** World-space center, as of the last sync. */
  get worldCenter(): THREE.Vector3 {
    return this.world.center;
  }

  /**
   * Retires the collider: fires exit on anything it was overlapping,
   * unregisters it, and detaches its node. Idempotent — calling it twice is
   * a no-op, which matters because both gameplay teardown and the editor's
   * delete button can reach the same collider.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.manager?.onColliderDeactivated(this);
    this.node.removeFromParent();
    this.attached = undefined;
    this.triggerEnter.length = 0;
    this.triggerStay.length = 0;
    this.triggerExit.length = 0;
    this.collisionEnter.length = 0;
    this.collisionStay.length = 0;
    this.collisionExit.length = 0;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }
}

function subscribe(list: Subscription[], tagOrHandler: string | ColliderEventHandler, handler?: ColliderEventHandler): ColliderEventHandle {
  const sub: Subscription =
    typeof tagOrHandler === "string" ? { tag: tagOrHandler, handler: handler as ColliderEventHandler } : { tag: undefined, handler: tagOrHandler };
  if (typeof sub.handler !== "function") throw new Error("Collider event: expected a handler function (usage: on...(handler) or on...(tag, handler)).");
  list.push(sub);
  return () => {
    const index = list.indexOf(sub);
    if (index >= 0) list.splice(index, 1);
  };
}

function copyInto(target: THREE.Vector3, source: THREE.Vector3 | [number, number, number]): void {
  if (Array.isArray(source)) target.set(source[0], source[1], source[2]);
  else target.copy(source);
}
