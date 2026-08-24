import * as THREE from "three";
import type { ShapeModule } from "./ParticleTypes";
import type { ParticleRandom } from "./ParticleRandom";

/**
 * Emission-volume sampling: where a new particle starts, and which way it
 * initially points.
 *
 * One function per shape, all writing into caller-owned vectors — this runs
 * once per spawned particle, and a burst of 500 allocating two Vector3s
 * each is 1000 objects in one frame.
 *
 * **The emitter's axis is local +Y.** A cone opens upward, a box's default
 * direction is up, and "fire/smoke rises" is therefore the zero-rotation
 * case rather than something every preset has to rotate into. Emitters are
 * freely rotatable, so this only decides what "unrotated" means — but
 * picking the common case as the default is what keeps a preset's rotation
 * field at 0,0,0 and readable.
 */

/** Scratch for the local basis a cone direction is built in — module-level, never allocated per spawn. */
const tangentScratch = new THREE.Vector3();
const bitangentScratch = new THREE.Vector3();

const AXIS = new THREE.Vector3(0, 1, 0);

/**
 * Samples `shape`, writing the spawn point into `outPosition` and a unit
 * direction into `outDirection`, both in the emitter's local space.
 *
 * The shape's own position/rotation/scale offset is applied by the caller
 * (see ParticleSimulation.spawnOne) rather than here, so this stays pure
 * geometry and the offset matrix can be composed once per frame instead of
 * once per particle.
 */
export function sampleShape(shape: ShapeModule, rng: ParticleRandom, outPosition: THREE.Vector3, outDirection: THREE.Vector3): void {
  switch (shape.kind) {
    case "box":
      sampleBox(shape, rng, outPosition, outDirection);
      return;
    case "sphere":
      sampleSphere(shape, rng, outPosition, outDirection);
      return;
    default:
      sampleCone(shape, rng, outPosition, outDirection);
  }
}

/**
 * Uniform within the box's volume, directed along +Y.
 *
 * `radiusThickness` re-reads as *shell thickness* here: at 0 the particle
 * is pushed out onto the box's surface (the face it's already nearest),
 * which is what makes a box emitter usable as a room-edge or ground-plane
 * source rather than only ever a solid cloud.
 */
function sampleBox(shape: ShapeModule, rng: ParticleRandom, outPosition: THREE.Vector3, outDirection: THREE.Vector3): void {
  const hx = shape.boxSize[0] * 0.5;
  const hy = shape.boxSize[1] * 0.5;
  const hz = shape.boxSize[2] * 0.5;
  let x = rng.nextSigned() * hx;
  let y = rng.nextSigned() * hy;
  let z = rng.nextSigned() * hz;

  if (shape.radiusThickness < 1) {
    // Push toward the nearest face, by however much the thickness asks
    // for. Measured as a fraction of each half-extent so a flat box
    // (a ground plane) still resolves to its large faces rather than
    // collapsing onto an edge.
    const fx = hx > 0 ? Math.abs(x) / hx : 0;
    const fy = hy > 0 ? Math.abs(y) / hy : 0;
    const fz = hz > 0 ? Math.abs(z) / hz : 0;
    const shell = 1 - shape.radiusThickness;
    if (fx >= fy && fx >= fz) x = x < 0 ? x * (1 - shell) - hx * shell : x * (1 - shell) + hx * shell;
    else if (fy >= fz) y = y < 0 ? y * (1 - shell) - hy * shell : y * (1 - shell) + hy * shell;
    else z = z < 0 ? z * (1 - shell) - hz * shell : z * (1 - shell) + hz * shell;
  }

  outPosition.set(x, y, z);
  outDirection.copy(AXIS);
}

/**
 * Uniform on (or within) a sphere, directed radially outward.
 *
 * The radius draw is `u^(1/3)`, not `u`: a linear draw concentrates
 * particles near the center, because a sphere's volume grows with r³ and a
 * uniform-in-r sample doesn't account for it. That produces a visibly
 * dense core on every explosion, which reads as a bug even when nobody can
 * name it.
 *
 * `arc` restricts the azimuth, so a half-sphere or a quarter burst needs no
 * separate shape.
 */
function sampleSphere(shape: ShapeModule, rng: ParticleRandom, outPosition: THREE.Vector3, outDirection: THREE.Vector3): void {
  const arc = (shape.arc <= 0 ? 360 : shape.arc) * THREE.MathUtils.DEG2RAD;
  const theta = rng.next() * arc;
  // Uniform on the sphere needs the *cosine* of the polar angle to be
  // uniform, not the angle itself — sampling phi directly bunches
  // particles at the poles.
  const cosPhi = rng.nextSigned();
  const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));

  const dirX = sinPhi * Math.cos(theta);
  const dirY = cosPhi;
  const dirZ = sinPhi * Math.sin(theta);

  const shell = 1 - shape.radiusThickness;
  const r = shape.radius * (shell + shape.radiusThickness * Math.cbrt(rng.next()));

  outPosition.set(dirX * r, dirY * r, dirZ * r);
  outDirection.set(dirX, dirY, dirZ);
}

/**
 * A disc of `radius` at the base, opening to `coneAngle` degrees about +Y.
 *
 * `coneHeight` spreads the spawn point along the axis as well, which turns
 * the same shape into a *volume* emitter — the difference between a jet
 * leaving a nozzle (height 0) and a column of smoke that's already filled
 * its own shaft (height > 0). Positions spread along the height are also
 * widened proportionally, so the particles stay inside the cone's real
 * silhouette instead of forming a cylinder.
 */
function sampleCone(shape: ShapeModule, rng: ParticleRandom, outPosition: THREE.Vector3, outDirection: THREE.Vector3): void {
  const arc = (shape.arc <= 0 ? 360 : shape.arc) * THREE.MathUtils.DEG2RAD;
  const theta = rng.next() * arc;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);

  // sqrt for a uniform disc — same reasoning as the sphere's cbrt above,
  // one dimension down.
  const shell = 1 - shape.radiusThickness;
  const rNorm = shell + shape.radiusThickness * Math.sqrt(rng.next());
  const r = shape.radius * rNorm;

  const angle = shape.coneAngle * THREE.MathUtils.DEG2RAD;
  const spread = Math.tan(angle);

  // Direction: the cone's opening, built from the radial offset so a
  // particle spawned at the disc's edge travels outward and one at the
  // center travels straight up.
  tangentScratch.set(cosT, 0, sinT);
  outDirection.set(tangentScratch.x * spread * rNorm, 1, tangentScratch.z * spread * rNorm).normalize();

  const h = shape.coneHeight > 0 ? rng.next() * shape.coneHeight : 0;
  // Widen with height so the emission volume is the actual cone, not a
  // cylinder with a cone-shaped velocity field.
  const widen = h * spread;
  outPosition.set(cosT * (r + widen * rNorm), h, sinT * (r + widen * rNorm));
}

/**
 * Blends `direction` toward a uniformly random unit vector by `amount`
 * (0..1), in place.
 *
 * Kept separate from the samplers so every shape gets randomization
 * identically and none of them has to implement it — and so `amount === 0`
 * (the common case) costs one comparison and returns, rather than three
 * random draws and a normalize that produce the vector that was already
 * there.
 */
export function randomizeDirection(direction: THREE.Vector3, amount: number, rng: ParticleRandom): void {
  if (amount <= 0) return;
  const theta = rng.next() * Math.PI * 2;
  const cosPhi = rng.nextSigned();
  const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
  bitangentScratch.set(sinPhi * Math.cos(theta), cosPhi, sinPhi * Math.sin(theta));
  direction.lerp(bitangentScratch, Math.min(1, amount));
  const len = direction.length();
  // A perfect 0.5 blend of two opposite vectors is genuinely zero — fall
  // back to the random one rather than emitting a NaN direction.
  if (len < 1e-6) direction.copy(bitangentScratch);
  else direction.multiplyScalar(1 / len);
}
