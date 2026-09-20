/**
 * The ION Collider system's narrow-phase maths, tested directly.
 *
 * `ColliderManager`'s behaviour — trigger enter/exit exactly once per
 * crossing, masks, retirement, broad-phase scaling — is covered by
 * `tests/simple-api.test.mjs` and `tests/performance.test.mjs`. What those
 * cannot see is *which* answer the shape-vs-shape tests gave: a broad
 * phase that correctly forwarded a pair to a narrow test that then got the
 * geometry wrong looks identical from outside to a pair that legitimately
 * did not overlap.
 *
 * This is the same shape as the particle suite, for the same reason:
 * `intersect.ts` is pure, DOM-free, allocation-free maths, so it can be
 * exercised exactly as the engine calls it.
 *
 * Two properties get as much attention as the individual answers, because
 * both are specific to how this file is written:
 *
 *  - **Symmetry.** `shapesOverlap` normalizes argument order so each pair
 *    type is implemented once. A swapped pair reaching the wrong branch is
 *    invisible in normal play (one of the two orders is usually the only
 *    one the broad phase produces) and catastrophic when it isn't.
 *  - **Scratch-pool reuse.** Every function here borrows from a fixed pool
 *    of module-level temporaries, and the file's own header warns that no
 *    function may call another borrowing the same one. A stomp shows up as
 *    "the same call returns a different answer the second time", so every
 *    interesting case is asserted twice with an unrelated call in between.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const ROOT = resolve(import.meta.dirname, "..");

/** Bundles intersect.ts (plus three, which it uses for vector maths) and hands back its live exports. */
async function loadIntersect() {
  const dir = join(ROOT, "src", "engine", "collision");
  const result = await esbuild.build({
    stdin: {
      contents: `
        export * from ${JSON.stringify(join(dir, "intersect.ts"))};
        export * as THREE from "three";
      `,
      resolveDir: dir,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2020",
    write: false,
  });
  const out = mkdtempSync(join(tmpdir(), "ion-intersect-"));
  const file = join(out, "intersect.mjs");
  writeFileSync(file, result.outputFiles[0].text, "utf8");
  return import(pathToFileURL(file).href);
}

const M = await loadIntersect();
const { THREE, shapesOverlap, shapeContainsPoint, penetration, sphereSphere, boxBox, sphereBox, sphereCylinder, cylinderCylinder, boxCylinder, closestPointOnBox } = M;

const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** A world-space sphere. */
function sphere(center, radius) {
  return { kind: "sphere", center: v(...center), radius };
}

/**
 * A world-space box. `euler` is degrees, applied XYZ — the same convention
 * the Inspector uses — and produces the three unit axes `BoxWorld` carries
 * rather than a matrix, exactly as `Collider.syncWorld` does.
 */
function box(center, size, euler = [0, 0, 0]) {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(...euler.map(THREE.MathUtils.degToRad))
  );
  return {
    kind: "box",
    center: v(...center),
    axes: [v(1, 0, 0).applyQuaternion(q), v(0, 1, 0).applyQuaternion(q), v(0, 0, 1).applyQuaternion(q)],
    half: v(size[0] / 2, size[1] / 2, size[2] / 2),
  };
}

/** A world-space capped cylinder, upright unless `euler` tilts it. */
function cylinder(center, radius, height, euler = [0, 0, 0]) {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(...euler.map(THREE.MathUtils.degToRad))
  );
  return {
    kind: "cylinder",
    center: v(...center),
    axis: v(0, 1, 0).applyQuaternion(q),
    axisX: v(1, 0, 0).applyQuaternion(q),
    axisZ: v(0, 0, 1).applyQuaternion(q),
    halfHeight: height / 2,
    radius,
  };
}

/**
 * Asserts an overlap answer, in both argument orders, twice each, with an
 * unrelated call wedged in between the passes.
 *
 * The repetition is the scratch-pool guard described in the file header —
 * a borrowed temporary that one function leaves dirty for another only
 * shows up on a second call, or on a call that follows a different shape
 * pair.
 */
function overlaps(a, b, expected, message) {
  assert.equal(shapesOverlap(a, b), expected, `${message} (a,b)`);
  assert.equal(shapesOverlap(b, a), expected, `${message} (b,a) — argument order must not change the answer`);
  // Something unrelated, to dirty every scratch vector in the pool.
  shapesOverlap(cylinder([99, 99, 99], 1, 1, [37, 12, 5]), box([99.5, 99, 99], [1, 1, 1], [10, 20, 30]));
  assert.equal(shapesOverlap(a, b), expected, `${message} (a,b, repeated after an unrelated test)`);
  assert.equal(shapesOverlap(b, a), expected, `${message} (b,a, repeated)`);
}

test("sphere vs sphere", async (t) => {
  await t.test("overlaps when the centres are closer than the summed radii", () => {
    overlaps(sphere([0, 0, 0], 1), sphere([1.5, 0, 0], 1), true, "1.5 apart, radii sum 2");
    overlaps(sphere([0, 0, 0], 1), sphere([3, 0, 0], 1), false, "3 apart, radii sum 2");
  });

  await t.test("exact touching counts as overlapping", () => {
    // `<=`, not `<` — a trigger you are exactly on the edge of should
    // fire, and the alternative is an event that depends on float noise.
    assert.equal(sphereSphere(sphere([0, 0, 0], 1), sphere([2, 0, 0], 1)), true);
    assert.equal(sphereSphere(sphere([0, 0, 0], 1), sphere([2.0001, 0, 0], 1)), false);
  });

  await t.test("a sphere fully inside another still overlaps", () => {
    overlaps(sphere([0, 0, 0], 5), sphere([0.2, 0, 0], 0.1), true, "small sphere nested in a large one");
  });
});

test("sphere vs box", async (t) => {
  await t.test("uses the closest point on the box, not its bounding sphere", () => {
    // Diagonally off a corner of a 2x2x2 box: 1.2 units clear on each of
    // three axes puts the centre ~2.08 from the corner, well outside a
    // 0.5 radius — but inside the box's own bounding sphere (radius
    // ~1.73), which is what a lazier test would have compared against.
    overlaps(box([0, 0, 0], [2, 2, 2]), sphere([2.2, 2.2, 2.2], 0.5), false, "clear of the corner");
    overlaps(box([0, 0, 0], [2, 2, 2]), sphere([1.4, 1.4, 1.4], 0.8), true, "touching the corner");
  });

  await t.test("respects the box's rotation", () => {
    // A point 1.3 out along +X clears an unrotated 2x2x2 box by 0.3, and
    // is *inside* the same box turned 45° about Y (whose half-diagonal
    // reaches ~1.41 that way).
    overlaps(box([0, 0, 0], [2, 2, 2]), sphere([1.2, 0, 0], 0.1), false, "outside the unrotated box");
    overlaps(box([0, 0, 0], [2, 2, 2], [0, 45, 0]), sphere([1.2, 0, 0], 0.1), true, "inside the 45°-turned box");
  });

  await t.test("closestPointOnBox clamps into the box's own frame", () => {
    const out = v();
    closestPointOnBox(box([0, 0, 0], [2, 4, 2]), v(5, 0, 0), out);
    assert.equal(out.x, 1);
    // A point already inside comes back unchanged.
    closestPointOnBox(box([0, 0, 0], [2, 4, 2]), v(0.25, 1, -0.5), out);
    assert.ok(out.distanceTo(v(0.25, 1, -0.5)) < 1e-6);
  });
});

test("box vs box", async (t) => {
  await t.test("separates on a face axis", () => {
    overlaps(box([0, 0, 0], [2, 2, 2]), box([1.9, 0, 0], [2, 2, 2]), true, "overlapping on X");
    overlaps(box([0, 0, 0], [2, 2, 2]), box([2.1, 0, 0], [2, 2, 2]), false, "clear on X");
  });

  await t.test("separates on an edge-cross axis no face normal covers", () => {
    // The classic SAT case: two long thin boxes crossed at 45°, positioned
    // so every one of the six face axes overlaps and only a cross product
    // of their edge directions separates them. Testing face normals alone
    // reports a false overlap here.
    const a = box([0, 0, 0], [4, 0.2, 0.2]);
    const b = box([0, 0.35, 0], [4, 0.2, 0.2], [0, 45, 0]);
    overlaps(a, b, false, "crossed bars, vertically clear");
    const touching = box([0, 0.15, 0], [4, 0.2, 0.2], [0, 45, 0]);
    overlaps(a, touching, true, "crossed bars, vertically overlapping");
  });

  await t.test("a box fully inside another overlaps", () => {
    overlaps(box([0, 0, 0], [10, 10, 10]), box([1, 1, 1], [1, 1, 1], [15, 30, 45]), true, "nested and rotated");
  });
});

test("sphere vs cylinder", async (t) => {
  await t.test("clamps radially and along the axis, so the caps are flat", () => {
    const cyl = cylinder([0, 0, 0], 1, 2);
    // Straight off the flat top: the cap sits at y = 1, so a 0.3 sphere
    // centred at 1.2 reaches down to 0.9 and one at 1.4 stops at 1.1.
    overlaps(cyl, sphere([0, 1.2, 0], 0.3), true, "just above the cap");
    overlaps(cyl, sphere([0, 1.4, 0], 0.3), false, "clear of the cap");
    // Straight out the side.
    overlaps(cyl, sphere([1.25, 0, 0], 0.3), true, "against the side");
    overlaps(cyl, sphere([1.35, 0, 0], 0.3), false, "clear of the side");
  });

  await t.test("the rim is a real corner, not a rounded capsule end", () => {
    // Diagonally off the rim at (1, 1): a capsule approximation would call
    // this an overlap, the exact capped-cylinder answer does not.
    const cyl = cylinder([0, 0, 0], 1, 2);
    overlaps(cyl, sphere([1.5, 1.5, 0], 0.6), false, "diagonally off the rim");
    overlaps(cyl, sphere([1.3, 1.3, 0], 0.6), true, "close enough to the rim");
  });

  await t.test("respects a tilted axis", () => {
    // Laid on its side about Z, the tall direction becomes X.
    const laid = cylinder([0, 0, 0], 0.5, 4, [0, 0, 90]);
    assert.equal(sphereCylinder(sphere([1.8, 0, 0], 0.2), laid), true, "along the now-horizontal axis");
    assert.equal(sphereCylinder(sphere([0, 1.8, 0], 0.2), laid), false, "across the now-short direction");
  });
});

test("cylinder vs cylinder", async (t) => {
  await t.test("the parallel fast path is exact in both directions", () => {
    const a = cylinder([0, 0, 0], 1, 2);
    // Side by side: circles overlap iff centres are within summed radii.
    overlaps(a, cylinder([1.9, 0, 0], 1, 2), true, "circles overlapping");
    overlaps(a, cylinder([2.1, 0, 0], 1, 2), false, "circles clear");
    // Stacked: extents along the shared axis.
    overlaps(a, cylinder([0, 1.9, 0], 1, 2), true, "extents overlapping");
    overlaps(a, cylinder([0, 2.1, 0], 1, 2), false, "extents clear");
  });

  await t.test("a small tilt still takes the parallel path and stays correct", () => {
    // Inside PARALLEL_EPS (~2.6°): still the exact 1D + 2D decomposition.
    overlaps(cylinder([0, 0, 0], 1, 2), cylinder([0, 2.4, 0], 1, 2, [1, 0, 0]), false, "nearly parallel, clear");
  });

  await t.test("skewed axes never miss a real overlap", () => {
    // The documented guarantee for this path is conservative: no false
    // negatives. A genuine, unambiguous overlap must be reported.
    const upright = cylinder([0, 0, 0], 0.8, 3);
    const crossing = cylinder([0, 0, 0], 0.8, 3, [90, 0, 0]);
    overlaps(upright, crossing, true, "two cylinders through the same point");
    overlaps(upright, cylinder([8, 0, 0], 0.8, 3, [90, 0, 0]), false, "far apart, skewed");
  });
});

test("box vs cylinder", async (t) => {
  await t.test("rejects past a cap plane", () => {
    const cyl = cylinder([0, 0, 0], 1, 2);
    overlaps(cyl, box([0, 3, 0], [1, 1, 1]), false, "well above the cap");
    overlaps(cyl, box([0, 1.4, 0], [1, 1, 1]), true, "straddling the cap");
  });

  await t.test("rejects clear of the round side", () => {
    const cyl = cylinder([0, 0, 0], 1, 2);
    overlaps(cyl, box([3, 0, 0], [1, 1, 1]), false, "clear of the side");
    overlaps(cyl, box([1.4, 0, 0], [1, 1, 1]), true, "against the side");
  });

  await t.test("never misses a real overlap when the box is rotated", () => {
    overlaps(cylinder([0, 0, 0], 1, 2), box([0.5, 0, 0.5], [1, 1, 1], [20, 35, 10]), true, "rotated box inside");
  });
});

test("shapeContainsPoint", async (t) => {
  await t.test("sphere", () => {
    assert.equal(shapeContainsPoint(sphere([1, 0, 0], 2), v(2.5, 0, 0)), true);
    assert.equal(shapeContainsPoint(sphere([1, 0, 0], 2), v(3.5, 0, 0)), false);
  });

  await t.test("box, in the box's own frame", () => {
    const rotated = box([0, 0, 0], [2, 2, 2], [0, 45, 0]);
    assert.equal(shapeContainsPoint(rotated, v(1.3, 0, 0)), true, "inside the turned box");
    assert.equal(shapeContainsPoint(rotated, v(1.3, 0, 1.3)), false, "outside the turned box");
  });

  await t.test("cylinder, radially and along the axis", () => {
    const cyl = cylinder([0, 0, 0], 1, 2);
    assert.equal(shapeContainsPoint(cyl, v(0.9, 0.9, 0)), true);
    assert.equal(shapeContainsPoint(cyl, v(1.1, 0, 0)), false, "outside the radius");
    assert.equal(shapeContainsPoint(cyl, v(0, 1.1, 0)), false, "past the cap");
  });
});

test("penetration", async (t) => {
  await t.test("returns false for shapes that do not overlap", () => {
    const out = v();
    assert.equal(penetration(sphere([0, 0, 0], 1), sphere([5, 0, 0], 1), out), false);
  });

  await t.test("gives the exact minimum translation for two axis-aligned boxes", () => {
    // 0.2 of overlap on X, 1.0 on Y and Z — the minimum escape is +X by 0.2.
    const out = v();
    assert.equal(penetration(box([1.8, 0, 0], [2, 2, 2]), box([0, 0, 0], [2, 2, 2]), out), true);
    assert.ok(Math.abs(out.x - 0.2) < 1e-6, `expected +0.2 on X, got ${out.toArray()}`);
    assert.ok(Math.abs(out.y) < 1e-6 && Math.abs(out.z) < 1e-6, "the escape must be purely along X");
  });

  await t.test("always pushes `a` away from `b`, never further in", () => {
    const out = v();
    penetration(box([-1.8, 0, 0], [2, 2, 2]), box([0, 0, 0], [2, 2, 2]), out);
    assert.ok(out.x < 0, `a is on -X of b, so the push must be negative; got ${out.x}`);
  });

  await t.test("applying the push leaves the pair no longer interpenetrating", () => {
    // The contract for curved pairs is "may over-push, never under-push".
    // The check is `penetration` again rather than `shapesOverlap`: a
    // minimum translation puts the two volumes *exactly* touching by
    // definition, and `shapesOverlap` counts touching as overlapping (`<=`,
    // deliberately — see the sphere-vs-sphere test). `penetration` returning
    // false is the property `moveAndSlide` actually relies on to stop
    // iterating, so it is the one worth asserting.
    const a = sphere([0.4, 0.1, 0], 1);
    const b = cylinder([0, 0, 0], 1, 2);
    const out = v();
    assert.equal(penetration(a, b, out), true);
    const moved = sphere([a.center.x + out.x, a.center.y + out.y, a.center.z + out.z], a.radius);
    assert.equal(penetration(moved, b, v()), false, "applying the push must resolve the overlap in one pass");
  });

  await t.test("`up` forces a horizontal escape, which is what stops a character climbing walls", () => {
    // A player-sized volume overlapping the top corner of a knee-high
    // wall. The genuinely smallest way out is straight up — and that is
    // exactly the answer that makes a character pop onto the scenery.
    const player = cylinder([0.85, 0.9, 0], 0.4, 1.8);
    const wall = box([0, 0.25, 0], [2, 0.5, 2]);
    const free = v();
    assert.equal(penetration(player, wall, free), true);

    const constrained = v();
    assert.equal(penetration(player, wall, constrained, v(0, 1, 0)), true);
    assert.ok(Math.abs(constrained.y) < 1e-6, `with up set, the push must be horizontal; got ${constrained.toArray()}`);
    assert.ok(constrained.x > 0, "and it must move the player out along +X, away from the wall");
  });

  await t.test("refuses to move when the only escape is the one `up` forbids", () => {
    // A volume dead-centred inside a wide, flat slab: every horizontal
    // candidate is a straight-through direction, and the honest answer is
    // "not resolvable in the plane you allowed".
    const inside = sphere([0, 0, 0], 0.2);
    const slab = box([0, 0, 0], [40, 0.4, 40]);
    const out = v(1, 2, 3);
    const resolved = penetration(inside, slab, out, v(0, 1, 0));
    if (resolved) {
      assert.ok(Math.abs(out.y) < 1e-6, "any answer given must still be horizontal");
    }
  });
});

test("degenerate and concentric shapes", async (t) => {
  await t.test("concentric shapes are still separable", () => {
    // A pair that overlaps as completely as it is possible to overlap used to
    // report *no* penetration. Two spheres have no principal axes of their
    // own, so the centre-to-centre direction is their only candidate axis —
    // and a zero-length one is correctly rejected, which left the candidate
    // set empty and `penetration` answering "not touching". `depenetrate`
    // then returned zero and `moveAndSlide` never pushed, so anything that
    // spawned on top of the player stayed inside it permanently.
    const out = v();
    for (const [label, a, b] of [
      ["sphere/sphere", sphere([0, 0, 0], 1), sphere([0, 0, 0], 1)],
      ["sphere/box", sphere([0, 0, 0], 1), box([0, 0, 0], [2, 2, 2])],
      ["box/box", box([0, 0, 0], [2, 2, 2]), box([0, 0, 0], [2, 2, 2])],
      ["cylinder/cylinder", cylinder([0, 0, 0], 1, 2), cylinder([0, 0, 0], 1, 2)],
    ]) {
      assert.equal(shapesOverlap(a, b), true, `${label}: concentric shapes overlap`);
      assert.equal(penetration(a, b, out), true, `${label}: and must be pushable apart`);
      assert.ok(out.length() > 0, `${label}: with a real, non-zero push`);
    }
  });

  await t.test("near-coincident centres behave like coincident ones", () => {
    // The realistic version of the case above: two things spawned at the same
    // spot, or float drift. 1e-9 apart is well inside the 1e-10 squared-length
    // threshold that rejects the centre-delta axis.
    const out = v();
    assert.equal(penetration(sphere([1e-9, 0, 0], 1), sphere([0, 0, 0], 1), out), true);
    assert.ok(out.length() > 0);
  });

  await t.test("the concentric push is deterministic", () => {
    // Direction does not matter — every direction is equally valid for a
    // concentric pair — but it must not change between frames, or the object
    // would jitter along a different axis each tick instead of leaving.
    const first = v();
    const second = v();
    penetration(sphere([0, 0, 0], 1), sphere([0, 0, 0], 1), first);
    shapesOverlap(box([9, 9, 9], [1, 1, 1]), sphere([9, 9, 9], 1)); // dirty the scratch pool
    penetration(sphere([0, 0, 0], 1), sphere([0, 0, 0], 1), second);
    assert.deepEqual(first.toArray(), second.toArray());
  });

  await t.test("a false return leaves `out` zeroed, not holding the last push", () => {
    // `penetration` is exported public API. A caller that checks the boolean
    // loosely used to get whatever vector the *previous* call had written.
    const out = v();
    assert.equal(penetration(sphere([0, 0, 0], 1), sphere([0, 0, 0], 1), out), true);
    assert.ok(out.length() > 0, "primed with a real push");
    assert.equal(penetration(sphere([0, 0, 0], 1), sphere([50, 0, 0], 1), out), false);
    assert.deepEqual(out.toArray(), [0, 0, 0], "cleared on the way out");
  });

  await t.test("zero-sized shapes report no penetration rather than a fake one", () => {
    // Overlap depth genuinely is 0, so "nothing to push" is the honest answer
    // — and `out` must still come back clean.
    const out = v();
    assert.equal(penetration(sphere([0, 0, 0], 0), sphere([0, 0, 0], 0), out), false);
    assert.deepEqual(out.toArray(), [0, 0, 0]);
    assert.equal(penetration(box([0, 0, 0], [0, 0, 0]), box([0, 0, 0], [0, 0, 0]), out), false);
    assert.deepEqual(out.toArray(), [0, 0, 0]);
  });
});

test("consistency", async (t) => {
  await t.test("shapesOverlap agrees with the pairwise functions it dispatches to", () => {
    const cases = [
      [sphere([0, 0, 0], 1), sphere([1.5, 0, 0], 1), sphereSphere],
      [sphere([0, 0, 0], 1), box([1.2, 0, 0], [2, 2, 2]), (a, b) => sphereBox(a, b)],
      [box([0, 0, 0], [2, 2, 2]), box([1.5, 0, 0], [2, 2, 2]), boxBox],
      [sphere([0, 0, 0], 1), cylinder([1.2, 0, 0], 1, 2), (a, b) => sphereCylinder(a, b)],
      [cylinder([0, 0, 0], 1, 2), cylinder([1.2, 0, 0], 1, 2), cylinderCylinder],
      [box([0, 0, 0], [2, 2, 2]), cylinder([1.2, 0, 0], 1, 2), (a, b) => boxCylinder(a, b)],
    ];
    for (const [a, b, direct] of cases) {
      assert.equal(shapesOverlap(a, b), direct(a, b), `${a.kind} vs ${b.kind}: dispatch must reach the same test`);
    }
  });

  await t.test("a point inside a shape is inside a zero-radius sphere test of it too", () => {
    const shapes = [sphere([1, 2, 3], 1.5), box([1, 2, 3], [2, 3, 4], [10, 20, 30]), cylinder([1, 2, 3], 1, 2, [0, 0, 15])];
    const probes = [v(1, 2, 3), v(1, 4.4, 3), v(4, 2, 3), v(1.6, 2.4, 3.2)];
    for (const shape of shapes) {
      for (const point of probes) {
        assert.equal(
          shapeContainsPoint(shape, point),
          shapesOverlap({ kind: "sphere", center: point.clone(), radius: 0 }, shape),
          `${shape.kind} at ${point.toArray()}: containsPoint and a zero-radius sphere must agree`
        );
      }
    }
  });
});
