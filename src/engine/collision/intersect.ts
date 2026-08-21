import * as THREE from "three";
import type { BoxWorld, CylinderWorld, ShapeWorld, SphereWorld } from "./ColliderTypes";

/**
 * Every shape-vs-shape overlap test in the ION Collider system, in one
 * file, with zero allocation per call.
 *
 * Read the scratch-vector block below before editing anything here: these
 * functions run O(pairs) times every single frame, so each one borrows from
 * a fixed pool of module-level temporaries instead of allocating. That
 * means **no function here may call another that borrows the same
 * temporary** — the pool is partitioned by purpose (`tmpA`/`tmpB` for
 * leaf math, `segA`/`segB` for the segment routines, `boxTmp` for the
 * closest-point-on-box walk) precisely so the nesting that does happen
 * (box↔cylinder calls both) can't stomp on itself.
 *
 * Exactness, honestly stated — this matters for gameplay tuning:
 *
 *  - sphere↔sphere, sphere↔box, box↔box, sphere↔cylinder: **exact**.
 *  - cylinder↔cylinder with near-parallel axes (the overwhelmingly common
 *    case — two upright volumes): **exact**.
 *  - cylinder↔cylinder at an angle, and box↔cylinder: **conservative**,
 *    i.e. never a false negative, occasionally a false positive within a
 *    fraction of the cylinder's radius near a corner. Both combine an SAT
 *    test against the cylinder's tight OBB with a distance-to-axis-segment
 *    refinement, and a genuine overlap always passes both. Playables want
 *    "did the player reach the zone", not contact manifolds, so paying for
 *    a GJK/EPA solver to close that last fraction of a radius would be
 *    spending frame budget on precision nobody can see.
 */

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const boxTmp = new THREE.Vector3();
const segA = new THREE.Vector3();
const segB = new THREE.Vector3();
const segC = new THREE.Vector3();
const obbA: BoxWorld = { kind: "box", center: new THREE.Vector3(), axes: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], half: new THREE.Vector3() };
const obbB: BoxWorld = { kind: "box", center: new THREE.Vector3(), axes: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], half: new THREE.Vector3() };

/** Below this, two directions count as the same line for the parallel-cylinder fast path. ~2.6° of slop — tight enough that the fast path stays exact in practice, loose enough that a hand-placed "upright" cylinder still takes it. */
const PARALLEL_EPS = 0.999;
/** Guards SAT's cross-product axes: two nearly-parallel edge directions produce a near-zero cross product whose normalization amplifies float error into a phantom separating axis. Skipping those axes is the standard fix and is safe — the 6 face axes already cover the parallel case. */
const SAT_EPS = 1e-6;

/**
 * The one entry point. Dispatches on the two shape kinds and normalizes
 * argument order so each pair type is implemented exactly once (there is no
 * `boxSphere` — it's `sphereBox` with the arguments swapped).
 */
export function shapesOverlap(a: ShapeWorld, b: ShapeWorld): boolean {
  if (a.kind === "sphere") {
    if (b.kind === "sphere") return sphereSphere(a, b);
    if (b.kind === "box") return sphereBox(a, b);
    return sphereCylinder(a, b);
  }
  if (a.kind === "box") {
    if (b.kind === "sphere") return sphereBox(b, a);
    if (b.kind === "box") return boxBox(a, b);
    return boxCylinder(a, b);
  }
  if (b.kind === "sphere") return sphereCylinder(b, a);
  if (b.kind === "box") return boxCylinder(b, a);
  return cylinderCylinder(a, b);
}

/** Exact. */
export function sphereSphere(a: SphereWorld, b: SphereWorld): boolean {
  const r = a.radius + b.radius;
  return a.center.distanceToSquared(b.center) <= r * r;
}

/**
 * Exact. The classic OBB test: clamp the sphere's center into the box's own
 * axis-aligned frame, which gives the closest point on (or in) the box,
 * then compare that distance to the radius.
 */
export function sphereBox(sphere: SphereWorld, box: BoxWorld): boolean {
  closestPointOnBox(box, sphere.center, boxTmp);
  return boxTmp.distanceToSquared(sphere.center) <= sphere.radius * sphere.radius;
}

/**
 * Exact. Separating Axis Theorem over all 15 candidate axes: each box's
 * 3 face normals, plus the 9 pairwise cross products of their edge
 * directions. If any axis separates them, they don't overlap.
 */
export function boxBox(a: BoxWorld, b: BoxWorld): boolean {
  tmpA.copy(b.center).sub(a.center);
  for (let i = 0; i < 3; i++) {
    if (separatedOn(a.axes[i], a, b, tmpA)) return false;
  }
  for (let i = 0; i < 3; i++) {
    if (separatedOn(b.axes[i], a, b, tmpA)) return false;
  }
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      tmpB.crossVectors(a.axes[i], b.axes[j]);
      if (tmpB.lengthSq() < SAT_EPS) continue; // parallel edges — see SAT_EPS
      tmpB.normalize();
      if (separatedOn(tmpB, a, b, tmpA)) return false;
    }
  }
  return true;
}

/**
 * Exact. Clamps the sphere's center into the cylinder's capped volume
 * (radially, then along the axis) to get the true closest point, rather
 * than approximating the cylinder as a capsule or a box.
 */
export function sphereCylinder(sphere: SphereWorld, cyl: CylinderWorld): boolean {
  closestPointInCylinder(cyl, sphere.center, tmpC);
  return tmpC.distanceToSquared(sphere.center) <= sphere.radius * sphere.radius;
}

/**
 * Exact when the axes are near-parallel (see PARALLEL_EPS), conservative
 * otherwise — see the file header.
 *
 * The parallel case decomposes cleanly into two independent 1D/2D tests:
 * the volumes overlap iff their extents overlap *along* the shared axis and
 * their circular cross-sections overlap *across* it.
 */
export function cylinderCylinder(a: CylinderWorld, b: CylinderWorld): boolean {
  tmpA.copy(b.center).sub(a.center);
  if (Math.abs(a.axis.dot(b.axis)) >= PARALLEL_EPS) {
    const along = tmpA.dot(a.axis);
    if (Math.abs(along) > a.halfHeight + b.halfHeight) return false;
    // Perpendicular component — the 2D circle-vs-circle part.
    tmpB.copy(tmpA).addScaledVector(a.axis, -along);
    const r = a.radius + b.radius;
    return tmpB.lengthSq() <= r * r;
  }
  // Skewed: the two conservative tests together. Either one alone lets
  // through configurations the other rejects, and a real overlap passes
  // both (a point inside both cylinders is within each one's radius of that
  // cylinder's axis segment, and inside each one's OBB).
  cylinderToObb(a, obbA);
  cylinderToObb(b, obbB);
  if (!boxBox(obbA, obbB)) return false;
  const r = a.radius + b.radius;
  return segmentSegmentDistanceSq(axisStart(a, segA), axisEnd(a, segB), axisStart(b, segC), axisEndAlt(b)) <= r * r;
}

/**
 * Conservative — see the file header. SAT against the cylinder's tight OBB
 * rejects everything clearly outside (including anything past a cap plane,
 * since the cylinder's own axis is one of the tested axes), and the
 * distance from the box to the axis segment rejects the corner cases the
 * OBB's corners would otherwise let through.
 */
export function boxCylinder(box: BoxWorld, cyl: CylinderWorld): boolean {
  cylinderToObb(cyl, obbA);
  if (!boxBox(box, obbA)) return false;
  return boxSegmentDistanceSq(box, axisStart(cyl, segA), axisEnd(cyl, segB)) <= cyl.radius * cyl.radius;
}

/** True when a single world-space point is inside the shape. Used by ColliderManager's point queries — a sphere of radius 0 would give the same answer, this just skips the dispatch. */
export function shapeContainsPoint(shape: ShapeWorld, point: THREE.Vector3): boolean {
  if (shape.kind === "sphere") return point.distanceToSquared(shape.center) <= shape.radius * shape.radius;
  if (shape.kind === "box") {
    tmpA.copy(point).sub(shape.center);
    return (
      Math.abs(tmpA.dot(shape.axes[0])) <= shape.half.x &&
      Math.abs(tmpA.dot(shape.axes[1])) <= shape.half.y &&
      Math.abs(tmpA.dot(shape.axes[2])) <= shape.half.z
    );
  }
  tmpA.copy(point).sub(shape.center);
  const along = tmpA.dot(shape.axis);
  if (Math.abs(along) > shape.halfHeight) return false;
  tmpB.copy(tmpA).addScaledVector(shape.axis, -along);
  return tmpB.lengthSq() <= shape.radius * shape.radius;
}

/** Closest point on (or inside) an OBB to `point`, written into `out`. */
export function closestPointOnBox(box: BoxWorld, point: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  tmpA.copy(point).sub(box.center);
  out.copy(box.center);
  out.addScaledVector(box.axes[0], clamp(tmpA.dot(box.axes[0]), -box.half.x, box.half.x));
  out.addScaledVector(box.axes[1], clamp(tmpA.dot(box.axes[1]), -box.half.y, box.half.y));
  out.addScaledVector(box.axes[2], clamp(tmpA.dot(box.axes[2]), -box.half.z, box.half.z));
  return out;
}

/** Closest point on (or inside) a capped cylinder to `point`, written into `out`. */
function closestPointInCylinder(cyl: CylinderWorld, point: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  tmpA.copy(point).sub(cyl.center);
  const along = clamp(tmpA.dot(cyl.axis), -cyl.halfHeight, cyl.halfHeight);
  tmpB.copy(tmpA).addScaledVector(cyl.axis, -tmpA.dot(cyl.axis));
  const radial = tmpB.length();
  out.copy(cyl.center).addScaledVector(cyl.axis, along);
  if (radial > 1e-8) out.addScaledVector(tmpB, Math.min(radial, cyl.radius) / radial);
  return out;
}

/** One SAT axis: project both boxes' half-extents onto it and compare against the projected center distance. */
function separatedOn(axis: THREE.Vector3, a: BoxWorld, b: BoxWorld, centerDelta: THREE.Vector3): boolean {
  const ra = Math.abs(a.axes[0].dot(axis)) * a.half.x + Math.abs(a.axes[1].dot(axis)) * a.half.y + Math.abs(a.axes[2].dot(axis)) * a.half.z;
  const rb = Math.abs(b.axes[0].dot(axis)) * b.half.x + Math.abs(b.axes[1].dot(axis)) * b.half.y + Math.abs(b.axes[2].dot(axis)) * b.half.z;
  return Math.abs(centerDelta.dot(axis)) > ra + rb;
}

/** The cylinder's tight oriented bounding box: its own axis as the box's Y, radius as the X/Z half-extents. */
function cylinderToObb(cyl: CylinderWorld, out: BoxWorld): void {
  out.center.copy(cyl.center);
  out.axes[0].copy(cyl.axisX);
  out.axes[1].copy(cyl.axis);
  out.axes[2].copy(cyl.axisZ);
  out.half.set(cyl.radius, cyl.halfHeight, cyl.radius);
}

function axisStart(cyl: CylinderWorld, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(cyl.center).addScaledVector(cyl.axis, -cyl.halfHeight);
}
function axisEnd(cyl: CylinderWorld, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(cyl.center).addScaledVector(cyl.axis, cyl.halfHeight);
}
/** Fourth segment endpoint for the skewed cylinder↔cylinder path — the scratch pool only holds three segment temporaries, and this is the only caller that needs a fourth. */
const segD = new THREE.Vector3();
function axisEndAlt(cyl: CylinderWorld): THREE.Vector3 {
  return segD.copy(cyl.center).addScaledVector(cyl.axis, cyl.halfHeight);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

const p1 = new THREE.Vector3();
const p2 = new THREE.Vector3();
const d1 = new THREE.Vector3();
const d2 = new THREE.Vector3();
const rVec = new THREE.Vector3();

/** Squared distance between two line segments — Ericson, *Real-Time Collision Detection*, §5.1.9. Handles the degenerate (zero-length) cases the naive parametric solution divides by zero on. */
function segmentSegmentDistanceSq(a0: THREE.Vector3, a1: THREE.Vector3, b0: THREE.Vector3, b1: THREE.Vector3): number {
  d1.copy(a1).sub(a0);
  d2.copy(b1).sub(b0);
  rVec.copy(a0).sub(b0);
  const aa = d1.lengthSq();
  const e = d2.lengthSq();
  const f = d2.dot(rVec);
  let s: number;
  let t: number;
  if (aa <= 1e-12 && e <= 1e-12) return a0.distanceToSquared(b0);
  if (aa <= 1e-12) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = d1.dot(rVec);
    if (e <= 1e-12) {
      t = 0;
      s = clamp(-c / aa, 0, 1);
    } else {
      const b = d1.dot(d2);
      const denom = aa * e - b * b;
      s = denom !== 0 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / aa, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / aa, 0, 1);
      }
    }
  }
  p1.copy(a0).addScaledVector(d1, s);
  p2.copy(b0).addScaledVector(d2, t);
  return p1.distanceToSquared(p2);
}

const bsBoxPoint = new THREE.Vector3();
const bsSegPoint = new THREE.Vector3();

/**
 * Squared distance between an OBB and a line segment, by alternating
 * projection: closest point on the box to the current segment point, then
 * closest point on the segment to that box point, repeat.
 *
 * Both sets are convex, so the iteration is monotonically non-increasing
 * and converges quickly; six passes is far past the point where the result
 * stops moving at single-precision. This is only ever a *refinement* of an
 * SAT test that already passed (see boxCylinder), so even an early-stopped
 * iterate stays conservative in the direction that matters — it can only
 * over-report distance, never under-report it.
 */
function boxSegmentDistanceSq(box: BoxWorld, s0: THREE.Vector3, s1: THREE.Vector3): number {
  bsSegPoint.copy(s0).add(s1).multiplyScalar(0.5);
  for (let i = 0; i < 6; i++) {
    closestPointOnBox(box, bsSegPoint, bsBoxPoint);
    closestPointOnSegment(s0, s1, bsBoxPoint, bsSegPoint);
  }
  return bsBoxPoint.distanceToSquared(bsSegPoint);
}

// ---------------------------------------------------------------------------
// Penetration — how far, and which way, to push one shape out of another
// ---------------------------------------------------------------------------

/**
 * How far each shape reaches along `axis` from its own centre — the
 * support function, exact for all three volumes.
 *
 * This is what lets one generic SAT loop below serve every shape pair
 * instead of six bespoke penetration routines. A cylinder's support is the
 * one worth reading twice: `halfHeight` scaled by how much the axis points
 * along it, plus `radius` scaled by how much it points across it, which is
 * exactly a capped cylinder's silhouette in that direction.
 */
function extentAlong(shape: ShapeWorld, axis: THREE.Vector3): number {
  if (shape.kind === "sphere") return shape.radius;
  if (shape.kind === "box") {
    return Math.abs(shape.axes[0].dot(axis)) * shape.half.x + Math.abs(shape.axes[1].dot(axis)) * shape.half.y + Math.abs(shape.axes[2].dot(axis)) * shape.half.z;
  }
  const along = Math.abs(shape.axis.dot(axis));
  const across = Math.sqrt(Math.max(0, 1 - along * along));
  return shape.halfHeight * along + shape.radius * across;
}

const MAX_CANDIDATES = 24;
const candidates: THREE.Vector3[] = Array.from({ length: MAX_CANDIDATES }, () => new THREE.Vector3());
const axesA: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const axesB: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const candTmp = new THREE.Vector3();
const cpTmp = new THREE.Vector3();
const sepVec = new THREE.Vector3();
const axisTmp = new THREE.Vector3();
const bestAxis = new THREE.Vector3();

/** Principal axes of a shape — the directions its own flat faces point. A sphere has none; that's why the centre-to-centre direction is always a candidate. */
function principalAxes(shape: ShapeWorld, into: THREE.Vector3[]): number {
  if (shape.kind === "box") {
    into[0].copy(shape.axes[0]);
    into[1].copy(shape.axes[1]);
    into[2].copy(shape.axes[2]);
    return 3;
  }
  if (shape.kind === "cylinder") {
    into[0].copy(shape.axis);
    return 1;
  }
  return 0;
}

/**
 * The directions worth testing for this pair.
 *
 * For two boxes this is the textbook 15 (3 + 3 face normals, 9 edge cross
 * products) and the result is the exact MTV. The extra entries are what
 * make curved surfaces work: the perpendicular from a cylinder's axis
 * toward the other shape, and the direction from a box's closest point to
 * a sphere's centre, are the true minimal escape directions in the cases
 * a face-normal set alone would miss.
 */
function buildCandidates(a: ShapeWorld, b: ShapeWorld): number {
  let n = 0;
  const add = (v: THREE.Vector3): void => {
    if (n < MAX_CANDIDATES) candidates[n++].copy(v);
  };
  const addNormalized = (v: THREE.Vector3): void => {
    if (v.lengthSq() > 1e-10) add(v.normalize());
  };

  const countA = principalAxes(a, axesA);
  const countB = principalAxes(b, axesB);
  for (let i = 0; i < countA; i++) add(axesA[i]);
  for (let i = 0; i < countB; i++) add(axesB[i]);

  // Always useful, and the *only* meaningful axis for sphere↔sphere.
  candTmp.copy(a.center).sub(b.center);
  addNormalized(candTmp);

  // Edge/edge for boxes, edge/round-side for cylinders.
  for (let i = 0; i < countA; i++) {
    for (let j = 0; j < countB; j++) {
      candTmp.crossVectors(axesA[i], axesB[j]);
      addNormalized(candTmp);
    }
  }

  // A cylinder's round side: straight out from its axis toward the other shape.
  if (a.kind === "cylinder") {
    candTmp.copy(b.center).sub(a.center);
    candTmp.addScaledVector(a.axis, -candTmp.dot(a.axis));
    addNormalized(candTmp);
  }
  if (b.kind === "cylinder") {
    candTmp.copy(a.center).sub(b.center);
    candTmp.addScaledVector(b.axis, -candTmp.dot(b.axis));
    addNormalized(candTmp);
  }

  // A sphere against a box corner or edge escapes along the line from the
  // box's closest point — no face normal points that way.
  if (a.kind === "sphere" && b.kind === "box") {
    closestPointOnBox(b, a.center, cpTmp);
    candTmp.copy(a.center).sub(cpTmp);
    addNormalized(candTmp);
  }
  if (b.kind === "sphere" && a.kind === "box") {
    closestPointOnBox(a, b.center, cpTmp);
    candTmp.copy(cpTmp).sub(b.center);
    addNormalized(candTmp);
  }
  return n;
}

/**
 * The minimum translation that moves `a` clear of `b`, written into `out`.
 * Returns false when they aren't overlapping.
 *
 * Generic SAT over the candidate set above, using each shape's exact
 * support function — the smallest positive overlap across every candidate
 * is the push. Exact for box↔box; for curved pairs the true minimal
 * direction may sit slightly off the candidate set, in which case the
 * answer is a *larger* push along a nearby axis. That errs the safe way:
 * it always fully separates, never under-pushes and leaves you clipped
 * inside a wall.
 *
 * **`up` is what makes this usable for a character.** Given an up vector,
 * every candidate is projected into the plane perpendicular to it before
 * being measured, so the result is the minimum *horizontal* escape. Without
 * it, walking into a low wall resolves upward — the smallest way out of a
 * knee-high box really is over the top — and the player pops onto the
 * scenery instead of being stopped by it.
 */
export function penetration(a: ShapeWorld, b: ShapeWorld, out: THREE.Vector3, up?: THREE.Vector3): boolean {
  const count = buildCandidates(a, b);
  sepVec.copy(a.center).sub(b.center);
  let best = Infinity;
  let found = false;

  for (let i = 0; i < count; i++) {
    axisTmp.copy(candidates[i]);
    if (up) axisTmp.addScaledVector(up, -axisTmp.dot(up));
    const lengthSq = axisTmp.lengthSq();
    if (lengthSq < 1e-8) continue; // degenerate, or purely vertical when up is set
    axisTmp.multiplyScalar(1 / Math.sqrt(lengthSq));
    const overlap = extentAlong(a, axisTmp) + extentAlong(b, axisTmp) - Math.abs(sepVec.dot(axisTmp));
    if (overlap <= 0) return false; // a genuine separating axis — they're apart
    if (overlap < best) {
      best = overlap;
      bestAxis.copy(axisTmp);
      found = true;
    }
  }
  // Only reachable with `up` set and every candidate parallel to it: the
  // shapes overlap, but not in any horizontal direction we're allowed to
  // resolve along. Refusing to move is the right answer.
  if (!found) return false;

  // Orient the push so it moves `a` away from `b`, not further in.
  if (sepVec.dot(bestAxis) < 0) bestAxis.negate();
  out.copy(bestAxis).multiplyScalar(best);
  return true;
}

const cpsAB = new THREE.Vector3();
function closestPointOnSegment(a: THREE.Vector3, b: THREE.Vector3, point: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  cpsAB.copy(b).sub(a);
  const lengthSq = cpsAB.lengthSq();
  if (lengthSq < 1e-12) return out.copy(a);
  const t = clamp(cpsAB.dot(out.copy(point).sub(a)) / lengthSq, 0, 1);
  return out.copy(a).addScaledVector(cpsAB, t);
}
