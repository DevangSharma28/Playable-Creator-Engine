import type * as THREE from "three";

/**
 * Type compatibility for Control Desk's "Pick" flow — deciding whether the
 * scene object you just clicked is actually a legal value for the script
 * field you're assigning it to.
 *
 * The declared type arrives as the raw source text `/script-info` scraped
 * out of the `.ts` file (see scripts/dev-build-api.js — a brace-depth text
 * scan, not a real TS parse), so it's a string like `THREE.Mesh`,
 * `THREE.Object3D | undefined`, or `HTMLElement`. This module is the one
 * place that turns those strings into a yes/no against a live object.
 *
 * Checks go through three.js's own `isMesh`/`isLight`/... boolean flags
 * rather than `instanceof`. That's not a style preference: `instanceof`
 * compares against the class identity of *this* module's `three` import,
 * and the dev preview's in-place hot reload can leave a scene built by a
 * previous bundle execution holding objects from a previous module
 * instance. Those objects are still perfectly valid meshes; `instanceof
 * THREE.Mesh` would call them frauds. The flags are plain properties on
 * the instance and survive that intact.
 */

/** A three.js object as seen through its own duck-typing flags. */
type FlaggedObject = THREE.Object3D & Record<string, unknown>;

/** Declared-type name (already normalized) -> "does this live object satisfy it". Order-independent; the widest types are just as valid as the narrow ones. */
const TYPE_PREDICATES: Record<string, (obj: FlaggedObject) => boolean> = {
  Object3D: () => true, // every scene object is an Object3D — the widest legal target
  Mesh: (o) => o.isMesh === true,
  SkinnedMesh: (o) => o.isSkinnedMesh === true,
  InstancedMesh: (o) => o.isInstancedMesh === true,
  Group: (o) => o.isGroup === true,
  Scene: (o) => o.isScene === true,
  Bone: (o) => o.isBone === true,
  Sprite: (o) => o.isSprite === true,
  Points: (o) => o.isPoints === true,
  Line: (o) => o.isLine === true,
  LineSegments: (o) => o.isLineSegments === true,
  Light: (o) => o.isLight === true,
  DirectionalLight: (o) => o.isDirectionalLight === true,
  PointLight: (o) => o.isPointLight === true,
  SpotLight: (o) => o.isSpotLight === true,
  HemisphereLight: (o) => o.isHemisphereLight === true,
  AmbientLight: (o) => o.isAmbientLight === true,
  Camera: (o) => o.isCamera === true,
  PerspectiveCamera: (o) => o.isPerspectiveCamera === true,
  OrthographicCamera: (o) => o.isOrthographicCamera === true,
};

/**
 * Reduces a declared type to the single three.js type name it targets, or
 * undefined if the field isn't a scene-object field at all.
 *
 * Handles what the source scan realistically produces: an optional field
 * (`THREE.Mesh | undefined`), a nullable one, the `THREE.` namespace
 * prefix or a bare imported name, and stray whitespace. A union of two
 * *different* object types (`Mesh | Group`) resolves to its first
 * recognized member rather than being rejected — being able to assign at
 * all is more useful than refusing anything the scan can't fully model,
 * and the field would accept either at runtime regardless.
 */
export function resolveObjectFieldType(declaredType: string | undefined): string | undefined {
  if (!declaredType) return undefined;
  for (const rawPart of declaredType.split("|")) {
    const name = rawPart.trim().replace(/^THREE\./, "");
    if (name === "undefined" || name === "null") continue;
    if (name in TYPE_PREDICATES) return name;
  }
  return undefined;
}

/** True when this field can hold a scene object at all — Control Desk shows a Pick button only for these. */
export function isAssignableObjectField(declaredType: string | undefined): boolean {
  return resolveObjectFieldType(declaredType) !== undefined;
}

export interface AssignabilityResult {
  ok: boolean;
  /** Human-readable rejection, ready to show in the panel — empty when ok. */
  reason: string;
}

/** Whether `object` is a legal value for a field declared as `declaredType`. */
export function checkAssignable(declaredType: string | undefined, object: THREE.Object3D): AssignabilityResult {
  const target = resolveObjectFieldType(declaredType);
  if (!target) {
    return { ok: false, reason: `Field type "${declaredType ?? "unknown"}" doesn't accept a scene object.` };
  }
  const predicate = TYPE_PREDICATES[target];
  if (!predicate(object as FlaggedObject)) {
    return { ok: false, reason: `"${object.name || object.type}" is a ${object.type}, which isn't a ${target}.` };
  }
  return { ok: true, reason: "" };
}
