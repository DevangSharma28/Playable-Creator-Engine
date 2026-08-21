import * as THREE from "three";
import { Collider } from "./Collider";
import { BoxCollider, type BoxColliderInit } from "./BoxCollider";
import { SphereCollider, type SphereColliderInit } from "./SphereCollider";
import { CylinderCollider, type CylinderColliderInit } from "./CylinderCollider";
import { shapeContainsPoint, shapesOverlap } from "./intersect";

/** The engine-owned group every collider node lives under. Uppercase on purpose — Cinema_World.glb already contains a mesh group named "Colliders", and these two must never be confused for each other. */
export const COLLIDERS_GROUP_NAME = "COLLIDERS";

/** Packs two collider ids into one integer key. Must match Collider's MAX_COLLIDERS. */
const ID_SPAN = 1 << 22;

interface ActivePair {
  a: Collider;
  b: Collider;
  /** Frames this overlap has survived. 0 on the frame it began — which is how enter and stay are kept from both firing at once. */
  frames: number;
}

/** One entry in the sweep-and-prune array. Reused across frames; never reallocated. */
interface SweepEntry {
  min: number;
  max: number;
  collider: Collider;
}

/** Live counters for the editor's collider panel — cheap to keep, and the only honest way to answer "is my broad phase actually doing anything". */
export interface ColliderStats {
  total: number;
  enabled: number;
  /** Pairs that survived the sweep and got a real intersection test this frame. */
  narrowTests: number;
  /** Pairs overlapping right now. */
  activePairs: number;
}

/**
 * The registry and the per-frame overlap engine for the ION Collider &
 * Area system.
 *
 * ## What it is not
 *
 * Not a physics engine, and not a wrapper around one. Nothing here
 * integrates forces, applies gravity, resolves penetration, or moves a
 * single scene object. It answers exactly one question, continuously:
 * *which registered volumes overlap right now* — and turns the frame-over-
 * frame difference in that answer into enter/stay/exit events.
 *
 * That's the shape a playable ad actually needs. Trigger zones, pickup
 * radii, "did the player reach the machine" — none of it wants a solver,
 * and all of it wants to survive being dropped into a 3MB size budget.
 *
 * ## Why colliders live in their own group
 *
 * Every collider's node is parented under one engine-owned COLLIDERS group
 * rather than under the object it belongs to. Two reasons, both practical:
 *
 *  - **The visual hierarchy stays clean.** A GLB-heavy scene is already
 *    hundreds of nodes; salting collision data through it makes both
 *    harder to read, and re-exporting the model would blow the colliders
 *    away with it.
 *  - **Attachment outlives re-parenting.** A collider *follows* its target
 *    by recomputing its world transform from that target's world matrix
 *    every frame (see Collider.syncWorld), so moving the target elsewhere
 *    in the graph, or swapping it out entirely, changes nothing about how
 *    the collider is stored.
 *
 * The group is held at identity and never transformed — Collider.syncWorld
 * writes world-space transforms straight into node.position/quaternion/
 * scale on that assumption.
 *
 * ## The frame
 *
 * 1. Sync every collider's transform and world shape (so detection is
 *    current, not one frame stale, even for objects that moved this frame).
 * 2. Sweep and prune along X over world bounding spheres.
 * 3. Filter surviving candidates by enabled state and tag masks — *before*
 *    the intersection test, so a mask is a genuine optimization and not
 *    just an `if` inside the handler.
 * 4. Exact/near-exact narrow test (see intersect.ts).
 * 5. Diff against last frame's overlap set; dispatch enter/stay/exit.
 *
 * Nothing traverses the scene graph. The whole cost scales with the number
 * of *colliders*, not the number of objects in the scene, which is the
 * entire point of keeping a dedicated registry.
 */
export class ColliderManager {
  /** Added to the scene by attachToScene(). Held at identity — see the class doc. */
  readonly group = new THREE.Group();

  private scene: THREE.Scene | undefined;
  private readonly colliders: Collider[] = [];
  private readonly byId = new Map<string, Collider>();
  private readonly active = new Map<number, ActivePair>();
  private readonly seenThisFrame = new Set<number>();
  /** numericIds currently inside at least one overlap — what the editor tints. Rebuilt each frame. */
  private readonly overlapping = new Set<number>();
  private readonly sweep: SweepEntry[] = [];
  private sweepCount = 0;
  private stats: ColliderStats = { total: 0, enabled: 0, narrowTests: 0, activePairs: 0 };
  private readonly scratchPoint = new THREE.Vector3();

  constructor() {
    this.group.name = COLLIDERS_GROUP_NAME;
    // Left at identity, permanently. Collider.syncWorld writes world-space
    // transforms straight into each node's local position/quaternion/scale
    // on exactly that assumption — transforming this group would silently
    // offset every collider in the game from its own volume.
  }

  // ---------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------

  /**
   * Adds the COLLIDERS group to a scene. Safe to call repeatedly with the
   * same scene.
   *
   * **Pointing the registry at a different scene retires everything in
   * it.** A collider's whole meaning is a volume positioned relative to
   * objects in one scene; carried into a different one it's attached to
   * things that aren't there any more, which `syncAll` correctly spots and
   * disables — leaving the new scene's colliders silently switched off.
   *
   * That isn't hypothetical. Saving in the 3D editor can write two watched
   * files at once (colliders.json *and* sceneBindings.json), which fires
   * two hot reloads back to back. Both new bundles bind their own context,
   * but they share whichever registry was bound last — so the first
   * reload's Game registered its colliders here and the second reload's
   * Game then attached this registry to its own, different scene. Every
   * collider from the first came back disabled and detached, which looked
   * exactly like "the editor forgot everything on reload".
   */
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

  /** Registers a collider and parents its node under the COLLIDERS group. Returns the same collider so `manager.add(new BoxCollider(...))` reads as one expression. */
  add<T extends Collider>(collider: T): T {
    if (this.byId.has(collider.id)) return collider;
    collider.manager = this;
    this.colliders.push(collider);
    this.byId.set(collider.id, collider);
    this.group.add(collider.node);
    return collider;
  }

  /** Convenience factories — `manager.box({ ... })` instead of `manager.add(new BoxCollider({ ... }))`. */
  box(init: BoxColliderInit = {}): BoxCollider {
    return this.add(new BoxCollider(init));
  }
  sphere(init: SphereColliderInit = {}): SphereCollider {
    return this.add(new SphereCollider(init));
  }
  cylinder(init: CylinderColliderInit = {}): CylinderCollider {
    return this.add(new CylinderCollider(init));
  }

  /**
   * Unregisters a collider, firing exit on everything it was overlapping
   * first. The collider itself is destroyed unless `keepAlive` is set —
   * the editor's undo path is the only caller that wants the object to
   * survive removal.
   */
  remove(collider: Collider, keepAlive = false): void {
    const index = this.colliders.indexOf(collider);
    if (index < 0) return;
    this.onColliderDeactivated(collider);
    this.colliders.splice(index, 1);
    this.byId.delete(collider.id);
    collider.node.removeFromParent();
    collider.manager = undefined;
    if (!keepAlive) collider.destroy();
  }

  /** Every registered collider, in registration order. Read-only — use add/remove to change the set. */
  get all(): readonly Collider[] {
    return this.colliders;
  }

  get(id: string): Collider | undefined {
    return this.byId.get(id);
  }

  /** First collider with this name. Names are how gameplay finds a zone it didn't create ("PlayerZone"), so keep them unique in the editor. */
  getByName(name: string): Collider | undefined {
    return this.colliders.find((c) => c.name === name);
  }

  getByTag(tag: string): Collider[] {
    return this.colliders.filter((c) => c.tag === tag);
  }

  /** The node a scene object belongs to, if it's a collider node or a child of one — how the editor turns a viewport raycast hit on a wireframe into the collider it belongs to. */
  fromNode(object: THREE.Object3D | undefined): Collider | undefined {
    let node: THREE.Object3D | null | undefined = object;
    while (node) {
      const id = node.userData?.ionCollider as string | undefined;
      if (id) return this.byId.get(id);
      node = node.parent;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------
  // The frame
  // ---------------------------------------------------------------------

  /**
   * One full detection pass. Called by IonEngine once per gameplay update,
   * inside the same not-paused guard as everything else — so overlaps
   * freeze while the UI editor or the 3D editor is open rather than firing
   * behind them.
   */
  update(): void {
    this.syncAll();
    this.broadPhase(true);
    this.resolveExits();
    this.stats.total = this.colliders.length;
    this.stats.activePairs = this.active.size;
  }

  /**
   * Transform sync and overlap *detection* with no event dispatch and no
   * change to the enter/stay/exit state machine — what the 3D editor calls
   * every frame while it's open.
   *
   * It has to exist because gameplay is paused for the whole editor
   * session, so update() isn't running: without this, dragging a collider's
   * gizmo would never fold the drag back into its offset (so the edit
   * wouldn't save), and the wireframes would never light up on contact.
   * Dispatching real events from here instead would be worse — a trigger
   * that fires while you're arranging it in the editor is a trigger that
   * ran the game's logic behind a paused game.
   */
  previewOverlaps(): void {
    this.syncAll();
    this.broadPhase(false);
    this.stats.total = this.colliders.length;
    this.stats.activePairs = this.active.size;
  }

  /** Refreshes transforms and world shapes, and retires colliders whose attachment left the scene. */
  private syncAll(): void {
    this.sweepCount = 0;
    let enabled = 0;
    for (const collider of this.colliders) {
      if (collider.attached && !this.stillInScene(collider.attached)) {
        // The object this collider follows was removed from the scene. Its
        // world transform is now meaningless, so retire the collider rather
        // than leaving a volume frozen wherever the object happened to die
        // — which would keep firing enter/exit against a ghost.
        if (import.meta.env.DEV) {
          console.warn(`ColliderManager: "${collider.name}" was attached to an object that's no longer in the scene — disabling it.`);
        }
        collider.attachToObject(undefined);
        collider.setEnabled(false);
      }
      if (!collider.enabled) continue;
      enabled++;
      collider.syncWorld();
      const entry = this.sweepEntry(this.sweepCount++);
      const radius = collider.boundingRadius;
      entry.min = collider.worldCenter.x - radius;
      entry.max = collider.worldCenter.x + radius;
      entry.collider = collider;
    }
    this.stats.enabled = enabled;
  }

  /**
   * Sweep and prune along X, then a bounding-sphere reject, then the tag
   * masks, then the real test.
   *
   * The axis choice is arbitrary but stable; a playable's play area is
   * usually widest horizontally, and for the collider counts this system
   * targets (tens, not thousands) the sort dominates anyway — which is why
   * this is a single-axis sweep and not a BVH or a spatial hash. Adding
   * either would cost more to maintain per frame than it saves.
   */
  private broadPhase(dispatch: boolean): void {
    if (dispatch) this.seenThisFrame.clear();
    this.overlapping.clear();
    this.stats.narrowTests = 0;
    const entries = this.sweep;
    const count = this.sweepCount;
    // Insertion sort: the array is almost always already sorted (colliders
    // move a little between frames, they don't teleport), which is the case
    // insertion sort is O(n) on and comparison sorts aren't.
    for (let i = 1; i < count; i++) {
      const current = entries[i];
      let j = i - 1;
      while (j >= 0 && entries[j].min > current.min) {
        entries[j + 1] = entries[j];
        j--;
      }
      entries[j + 1] = current;
    }

    for (let i = 0; i < count; i++) {
      const a = entries[i].collider;
      const aMax = entries[i].max;
      for (let j = i + 1; j < count; j++) {
        if (entries[j].min > aMax) break; // sorted by min — nothing further along can overlap either
        const b = entries[j].collider;
        if (!canPair(a, b)) continue;
        const reach = a.boundingRadius + b.boundingRadius;
        if (a.worldCenter.distanceToSquared(b.worldCenter) > reach * reach) continue;
        this.stats.narrowTests++;
        if (!shapesOverlap(a.world, b.world)) continue;
        if (dispatch) {
          this.registerOverlap(a, b);
        } else {
          this.overlapping.add(a.numericId);
          this.overlapping.add(b.numericId);
        }
      }
    }
  }

  private registerOverlap(a: Collider, b: Collider): void {
    const key = pairKey(a, b);
    this.seenThisFrame.add(key);
    this.overlapping.add(a.numericId);
    this.overlapping.add(b.numericId);
    const existing = this.active.get(key);
    if (!existing) {
      this.active.set(key, { a, b, frames: 0 });
      dispatchPair(a, b, "enter");
      return;
    }
    existing.frames++;
    dispatchPair(existing.a, existing.b, "stay");
  }

  private resolveExits(): void {
    if (this.active.size === 0) return;
    for (const [key, pair] of [...this.active]) {
      if (this.seenThisFrame.has(key)) continue;
      this.active.delete(key);
      dispatchPair(pair.a, pair.b, "exit");
    }
  }

  /**
   * Called by Collider.setEnabled(false) and Collider.destroy(), and by
   * remove() — every overlap the collider was part of ends *now*, with a
   * real exit event.
   *
   * Without this a handler that ran on enter would simply never hear the
   * matching exit, which is the single most common way an
   * "is-the-player-inside" flag gets stuck on forever.
   */
  onColliderDeactivated(collider: Collider): void {
    if (this.active.size === 0) return;
    for (const [key, pair] of [...this.active]) {
      if (pair.a !== collider && pair.b !== collider) continue;
      this.active.delete(key);
      dispatchPair(pair.a, pair.b, "exit");
    }
  }

  // ---------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------

  /** Is this collider inside any overlap as of the last update()? The editor tints overlapping volumes with it. */
  isOverlapping(collider: Collider): boolean {
    return this.overlapping.has(collider.numericId);
  }

  /** Colliders whose volume the point falls inside. Optionally restricted to one tag. */
  queryPoint(point: THREE.Vector3, tag?: string): Collider[] {
    const hits: Collider[] = [];
    for (const collider of this.colliders) {
      if (!collider.enabled) continue;
      if (tag !== undefined && collider.tag !== tag) continue;
      if (shapeContainsPoint(collider.world, point)) hits.push(collider);
    }
    return hits;
  }

  /**
   * Colliders overlapping a world-space sphere — the ad-hoc counterpart to
   * a registered trigger, for the "what's near me right now" question a
   * gameplay script asks once rather than every frame.
   */
  overlapSphere(center: THREE.Vector3, radius: number, tag?: string): Collider[] {
    const probe = { kind: "sphere" as const, center: this.scratchPoint.copy(center), radius };
    const hits: Collider[] = [];
    for (const collider of this.colliders) {
      if (!collider.enabled) continue;
      if (tag !== undefined && collider.tag !== tag) continue;
      if (shapesOverlap(probe, collider.world)) hits.push(collider);
    }
    return hits;
  }

  getStats(): ColliderStats {
    return { ...this.stats };
  }

  /**
   * Retires everything — every collider destroyed (firing its exits), the
   * registry emptied, the group detached.
   *
   * Called by IonEngine's teardown so an in-place hot reload can't leave
   * the previous bundle's colliders overlapping the new bundle's player.
   */
  clear(): void {
    for (const collider of [...this.colliders]) this.remove(collider);
    this.colliders.length = 0;
    this.byId.clear();
    this.active.clear();
    this.overlapping.clear();
    this.seenThisFrame.clear();
    this.sweepCount = 0;
    this.detachFromScene();
  }

  /** Grows the reusable sweep array on demand and never shrinks it — steady state is zero allocation per frame. */
  private sweepEntry(index: number): SweepEntry {
    let entry = this.sweep[index];
    if (!entry) {
      entry = { min: 0, max: 0, collider: undefined as unknown as Collider };
      this.sweep[index] = entry;
    }
    return entry;
  }

  private stillInScene(object: THREE.Object3D): boolean {
    if (!this.scene) return true; // no scene to check against — assume the caller knows what it's doing
    let node: THREE.Object3D | null = object;
    while (node) {
      if (node === this.scene) return true;
      node = node.parent;
    }
    return false;
  }
}

/**
 * Whether two colliders may interact at all — checked before any
 * intersection test.
 *
 * Masks are ANDed, not ORed: each side has to accept the other. An empty
 * mask means "accept anything", so the common setup is exactly the example
 * in the spec — a trigger tagged `PlayerZone` with `mask: ["Player"]`, and
 * a player collider with no mask at all. The zone accepts only the player;
 * the player accepts everyone; the pair goes through. Give the zone a mask
 * of `["Enemy"]` instead and the pair is rejected in the broad phase and
 * never reaches an intersection test.
 */
function canPair(a: Collider, b: Collider): boolean {
  if (a === b) return false;
  if (a.mask.length > 0 && !a.mask.includes(b.tag)) return false;
  if (b.mask.length > 0 && !b.mask.includes(a.tag)) return false;
  return true;
}

function pairKey(a: Collider, b: Collider): number {
  return a.numericId < b.numericId ? a.numericId * ID_SPAN + b.numericId : b.numericId * ID_SPAN + a.numericId;
}

/**
 * Routes one pair's event to whichever side should hear about it.
 *
 * If either collider is a trigger, the overlap is a *trigger* overlap and
 * only triggers get called — a zone never also reports as a collision, and
 * the solid collider that walked into it isn't told anything, because from
 * its point of view nothing happened. Two non-triggers report to each other
 * as a collision.
 */
function dispatchPair(a: Collider, b: Collider, phase: "enter" | "stay" | "exit"): void {
  if (a.isTrigger || b.isTrigger) {
    if (a.isTrigger) a.dispatch(phase, true, b);
    if (b.isTrigger) b.dispatch(phase, true, a);
    return;
  }
  a.dispatch(phase, false, b);
  b.dispatch(phase, false, a);
}
