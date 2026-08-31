import * as THREE from "three";

/** Default half-extent, used only when no measurable source is given (or the one given turns out to be empty). */
const FALLBACK_HALF_EXTENT = 10;

export interface WorldOptions {
  /**
   * The object to measure the play area from. Cinema_World.glb carries a
   * `walkablearea` node — four flat polygons the artist authored to
   * describe exactly where the player may walk — so passing the loaded
   * model makes the play area follow the art instead of a number kept in
   * sync by hand.
   */
  from?: THREE.Object3D;
  /** Node name to look for inside `from` before falling back to measuring `from` itself. Default `"walkablearea"`. */
  walkableNodeName?: string;
  /** Half-extent to use when nothing measurable was given. */
  fallbackSize?: number;
}

const tmpBox = new THREE.Box3();
const tmpSize = new THREE.Vector3();

/**
 * The static play environment's *gameplay* extents.
 *
 * ## Why this is a box and not a number
 *
 * This used to be one scalar half-extent measured from the world origin,
 * which quietly assumed the play area was a square centred on (0, 0, 0).
 * Cinema_World.glb's floor is neither: it spans roughly x ∈ [-5.2, 12.1],
 * z ∈ [-12.8, 3.8]. With the old default of 10, `CoinField` scattered
 * coins across a ±10 box, most of which has no floor under it — so coins
 * routinely spawned in mid-air outside the cinema, and `Player`'s clamp
 * against the same number was commented out precisely because clamping to
 * the wrong box was worse than not clamping at all.
 *
 * A real axis-aligned box measured from the environment fixes both, and it
 * fixes them for *any* environment: drop in a different GLB and the play
 * area follows it, with nothing to update by hand.
 *
 * ## What it still isn't
 *
 * An AABB over the walkable polygons, not the polygons themselves. A floor
 * plan shaped like an L still gets a rectangle drawn around it, so a point
 * this class calls inside can sit in the missing corner. That's a
 * deliberate stopping point: a real point-in-polygon test against
 * `walkablearea` is a different (and per-game) design decision, and the
 * rectangle is already correct enough to place coins on the floor and keep
 * the player in the room — the two things anything here actually reads.
 *
 * Lighting, fog, background, tone mapping, and shadow settings used to be
 * built here by hand. They now live in src/game/environment.json and are
 * applied by the engine's SceneEnvironment, so the 3D editor's Environment
 * dock can author them live.
 */
export class World {
  /** The measured play area, in world space. Y is included but nothing reads it — gameplay here is planar. */
  readonly bounds = new THREE.Box3();
  /** Centre of `bounds` — not the world origin, and that's the whole point. */
  readonly center = new THREE.Vector3();
  /** Half the size of `bounds` on each axis. */
  readonly halfExtent = new THREE.Vector3();

  /**
   * The largest horizontal half-extent.
   *
   * Kept because it's the field the Engine Room's Control Desk shows for
   * this class and the one older code read. Prefer `clamp()` /
   * `randomPoint()`: a single number can't express an off-centre or
   * non-square area, which is the bug this class was rewritten to fix.
   */
  readonly bound: number;

  constructor(_scene: THREE.Scene, options: WorldOptions = {}) {
    const fallback = options.fallbackSize ?? FALLBACK_HALF_EXTENT;
    const source = this.resolveSource(options);

    // `makeEmpty` first: setFromObject on a node with no geometry under it
    // leaves the box inverted (min = +Infinity), and an inverted box's
    // getSize() is negative, which would silently make every extent
    // negative rather than obviously wrong.
    tmpBox.makeEmpty();
    if (source) tmpBox.setFromObject(source);
    tmpBox.getSize(tmpSize);

    if (tmpBox.isEmpty() || tmpSize.x <= 0 || tmpSize.z <= 0) {
      this.bounds.set(new THREE.Vector3(-fallback, 0, -fallback), new THREE.Vector3(fallback, 0, fallback));
    } else {
      this.bounds.copy(tmpBox);
    }

    this.bounds.getCenter(this.center);
    this.bounds.getSize(this.halfExtent).multiplyScalar(0.5);
    this.bound = Math.max(this.halfExtent.x, this.halfExtent.z);
  }

  /**
   * Clamps `position`'s x/z into the play area, mutating it in place and
   * returning it. `margin` keeps that many units clear of the edge.
   *
   * Y is untouched: nothing here knows how tall anything is, and clamping
   * a character's height against a box measured from a floor plan would
   * pin it to the floor's own Y.
   */
  clamp(position: THREE.Vector3, margin = 0): THREE.Vector3 {
    position.x = this.clampAxis(position.x, this.center.x, this.halfExtent.x, margin);
    position.z = this.clampAxis(position.z, this.center.z, this.halfExtent.z, margin);
    return position;
  }

  /** True when x/z fall inside the play area, `margin` units in from the edge. */
  contains(position: THREE.Vector3, margin = 0): boolean {
    return (
      Math.abs(position.x - this.center.x) <= Math.max(this.halfExtent.x - margin, 0) &&
      Math.abs(position.z - this.center.z) <= Math.max(this.halfExtent.z - margin, 0)
    );
  }

  /**
   * A uniformly random x/z inside the play area, `margin` units in from
   * the edge. `y` is left at whatever `out` already held, so a caller that
   * wants coins floating at 0.55 sets it once and doesn't have it
   * overwritten.
   */
  randomPoint(margin = 0, out = new THREE.Vector3()): THREE.Vector3 {
    out.x = this.center.x + (Math.random() * 2 - 1) * Math.max(this.halfExtent.x - margin, 0);
    out.z = this.center.z + (Math.random() * 2 - 1) * Math.max(this.halfExtent.z - margin, 0);
    return out;
  }

  private clampAxis(value: number, center: number, half: number, margin: number): number {
    const reach = Math.max(half - margin, 0);
    return THREE.MathUtils.clamp(value, center - reach, center + reach);
  }

  private resolveSource(options: WorldOptions): THREE.Object3D | undefined {
    const root = options.from;
    if (!root) return undefined;
    const name = options.walkableNodeName ?? "walkablearea";
    const walkable = root.getObjectByName(name);
    if (walkable) return walkable;
    // Measuring the whole model instead is deliberately *not* silent: it
    // includes walls and ceiling, so the play area comes out larger than
    // the floor, and the fix is to name the node in the GLB.
    console.warn(`World: no "${name}" node in the environment model — measuring the whole model instead, which includes walls and anything else it contains.`);
    return root;
  }
}
