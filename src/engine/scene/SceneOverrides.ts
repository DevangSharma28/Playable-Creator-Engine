import * as THREE from "three";
import { sceneObjectPath, resolveSceneObject } from "../SceneBindings";

/**
 * Persistence for what the 3D editor does to the *scene graph* itself.
 *
 * ## Why this exists
 *
 * Everything else the editor authors already had a file. Camera, lighting and
 * world settings go to `environment.json`; trigger volumes to
 * `colliders.json`; effects to `particles.json`; ⊙ Pick assignments to
 * `sceneBindings.json`. Moving an object with the gizmo, hiding one, renaming
 * one or re-parenting one had **no file at all** — those edits were direct
 * mutations of live `THREE.Object3D` instances, and every one of those is
 * rebuilt from the GLB on the next boot.
 *
 * The result read like a caching bug: Save and Exit updated the running game
 * (the objects really had moved), and a browser reload threw it all away (the
 * objects were parsed fresh from the model). Nothing was cached and nothing
 * was stale — the data had simply never been written anywhere.
 *
 * ## Keyed by path, not uuid
 *
 * Same decision, for the same reason, as `SceneBindings` and
 * `ColliderData.attachPath`: three.js regenerates uuids on every GLB parse, so
 * a uuid written in one session resolves to nothing in the next. A
 * slash-separated name path is stable across parses of the same model.
 *
 * The path recorded is always the object's **baseline** path — where it was
 * when the game built the scene, before any override applied. That is what
 * makes renaming and re-parenting survivable: the key does not move when the
 * thing it names does.
 *
 * ## Diffed, never dumped
 *
 * `capture()` compares the live scene against a snapshot taken at load and
 * emits only what actually differs. Writing every node would produce a
 * thousand-entry file for a model with 281 of them, would grow the shipped
 * bundle for nothing, and would freeze the artist's model — a later export
 * with a moved prop would be silently overridden back by stale data nobody
 * remembers authoring.
 */

/** One object's authored deviation from the model. Every field bar the key is optional — only what changed is written. */
export interface SceneObjectOverride {
  /** Slash-separated path as of load, before any override applied. The stable key. */
  objectPath: string;
  /** Last segment of `objectPath`, for the same name-fallback lookup `SceneFieldBinding.objectName` provides. */
  objectName: string;
  position?: [number, number, number];
  /** Degrees, matching what the Inspector shows. */
  rotation?: [number, number, number];
  scale?: [number, number, number];
  visible?: boolean;
  /** Set when the object was renamed in the Hierarchy. */
  name?: string;
  /** Set when the object was re-parented. Baseline path of the new parent, or "" for the scene root. */
  parentPath?: string;
}

export interface SceneOverridesFileData {
  version: number;
  objects: SceneObjectOverride[];
}

/** What an object looked like when the scene was built. */
interface BaselineEntry {
  object: THREE.Object3D;
  path: string;
  name: string;
  visible: boolean;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  parentPath: string;
  /** The parent object itself, so a re-parent can be detected without re-deriving a path. */
  parent: THREE.Object3D | null;
}

/** Every object's load-time state, keyed by the object itself so a rename cannot lose it. */
export type SceneSnapshot = Map<THREE.Object3D, BaselineEntry>;

/**
 * Floating-point slack for "did this actually change".
 *
 * A gizmo drag writes doubles, and a round trip through JSON and back is not
 * bit-exact. Without a tolerance every object the user merely *selected* would
 * come back as a change on the next capture, and the file would grow without
 * anyone editing anything.
 */
const EPSILON = 1e-6;

const triple = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];
const eulerDegrees = (e: THREE.Euler): [number, number, number] => [
  THREE.MathUtils.radToDeg(e.x),
  THREE.MathUtils.radToDeg(e.y),
  THREE.MathUtils.radToDeg(e.z),
];
const same = (a: [number, number, number], b: [number, number, number]): boolean =>
  Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON && Math.abs(a[2] - b[2]) < EPSILON;

/**
 * Engine-owned groups whose contents are not scene content.
 *
 * Colliders and particles persist through their own files; the editor's grid,
 * gizmo and light helpers are chrome. Neither belongs in a snapshot, and
 * excluding them here is what stops a helper from being mistaken for an
 * authored object.
 */
const ENGINE_GROUPS = new Set(["COLLIDERS", "PARTICLES"]);

function isEngineOwned(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (ENGINE_GROUPS.has(node.name)) return true;
  }
  return false;
}

/**
 * Records the scene as the game built it.
 *
 * Must be taken **before** overrides are applied. A snapshot of the
 * already-overridden scene would make the next capture see no difference, and
 * saving would then write an empty file over the user's work.
 */
export function snapshotScene(scene: THREE.Scene): SceneSnapshot {
  const snapshot: SceneSnapshot = new Map();
  scene.traverse((object) => {
    if (object === scene || isEngineOwned(object)) return;
    snapshot.set(object, {
      object,
      path: sceneObjectPath(object, scene),
      name: object.name,
      visible: object.visible,
      position: triple(object.position),
      rotation: eulerDegrees(object.rotation),
      scale: triple(object.scale),
      parentPath: object.parent && object.parent !== scene ? sceneObjectPath(object.parent, scene) : "",
      parent: object.parent,
    });
  });
  return snapshot;
}

/**
 * Everything that differs from the snapshot, as records for `scene.json`.
 *
 * Only objects present in the snapshot are considered. Anything created since
 * — editor helpers, particles, colliders, an entity a game spawned after load
 * — is deliberately not persisted here: this file describes deviations from
 * the authored model, not the contents of a running scene.
 */
export function captureSceneOverrides(
  scene: THREE.Scene,
  snapshot: SceneSnapshot,
  options: CaptureOptions = {}
): SceneObjectOverride[] {
  const overrides: SceneObjectOverride[] = [];
  const { touchedSince, alsoKeep } = options;

  for (const baseline of snapshot.values()) {
    const object = baseline.object;

    // A game animates things. Coins spin, a character walks, a prop bobs — and
    // every one of those differs from the load-time baseline the moment the
    // editor opens, through nobody's authoring. Writing them turned a single
    // gizmo drag into a 55-entry file that then froze the animation's last
    // frame into the next boot.
    //
    // So when the caller supplies the state as of the editor opening, an
    // object is only written if it moved *during the session* — or if the file
    // already had a record for it, which must survive a session that did not
    // touch it.
    if (touchedSince && !differsFrom(object, touchedSince.get(object)) && !alsoKeep?.has(baseline.path)) continue;
    // Detached from the scene since load — recorded as hidden rather than
    // dropped, so removing a prop in the editor is a thing that persists.
    if (!object.parent) {
      overrides.push({ objectPath: baseline.path, objectName: lastSegment(baseline.path), visible: false });
      continue;
    }

    const override: SceneObjectOverride = { objectPath: baseline.path, objectName: lastSegment(baseline.path) };
    let changed = false;

    const position = triple(object.position);
    if (!same(position, baseline.position)) { override.position = position; changed = true; }

    const rotation = eulerDegrees(object.rotation);
    if (!same(rotation, baseline.rotation)) { override.rotation = rotation; changed = true; }

    const scale = triple(object.scale);
    if (!same(scale, baseline.scale)) { override.scale = scale; changed = true; }

    if (object.visible !== baseline.visible) { override.visible = object.visible; changed = true; }
    if (object.name !== baseline.name) { override.name = object.name; changed = true; }

    const parentPath = object.parent && object.parent !== scene ? pathOfBaseline(object.parent, snapshot, scene) : "";
    if (parentPath !== baseline.parentPath) { override.parentPath = parentPath; changed = true; }

    if (changed) overrides.push(override);
  }

  // Stable order, so two saves of the same scene produce the same bytes and a
  // diff of the file shows real edits rather than traversal order.
  overrides.sort((a, b) => (a.objectPath < b.objectPath ? -1 : a.objectPath > b.objectPath ? 1 : 0));
  return overrides;
}

/** How to decide which objects are worth writing. See captureSceneOverrides. */
export interface CaptureOptions {
  /** State as of the editor opening. With it, only objects that moved during the session are considered. */
  touchedSince?: SceneSnapshot;
  /** Baseline paths already present in the loaded file. Kept even if this session did not touch them. */
  alsoKeep?: Set<string>;
}

/** True when the object no longer matches the state recorded for it. A missing entry counts as changed. */
function differsFrom(object: THREE.Object3D, entry: BaselineEntry | undefined): boolean {
  if (!entry) return true;
  return (
    !same(triple(object.position), entry.position) ||
    !same(eulerDegrees(object.rotation), entry.rotation) ||
    !same(triple(object.scale), entry.scale) ||
    object.visible !== entry.visible ||
    object.name !== entry.name ||
    // Compared against the parent recorded at snapshot time, not the object's
    // current one — `entry.object` is the same instance, so reading its parent
    // would compare a value with itself and never see a re-parent.
    object.parent !== entry.parent
  );
}

/** A parent's *baseline* path, so re-parenting is recorded against a key that survives the next boot. */
function pathOfBaseline(parent: THREE.Object3D, snapshot: SceneSnapshot, scene: THREE.Scene): string {
  return snapshot.get(parent)?.path ?? sceneObjectPath(parent, scene);
}

function lastSegment(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

/**
 * Applies an authored `scene.json` to a freshly built scene.
 *
 * Two passes, and the split matters. Every target is resolved first, against
 * the paths as they are *now* — i.e. before any rename or re-parent in this
 * file has moved anything. Applying as it resolved would invalidate the paths
 * of every entry after the first one that renames or moves an object.
 *
 * `data` is `unknown` for the same reason the other loaders take `unknown`:
 * the caller's value is a raw `.json` import, TypeScript types its arrays as
 * `number[]` rather than tuples, and everything here is validated anyway.
 */
export function applySceneOverrides(scene: THREE.Scene, data: unknown): number {
  const file = data as SceneOverridesFileData | undefined;
  const records = Array.isArray(file?.objects) ? file.objects : [];
  if (records.length === 0) return 0;

  const resolved: { record: SceneObjectOverride; object: THREE.Object3D }[] = [];
  for (const record of records) {
    if (!record || typeof record !== "object" || typeof record.objectPath !== "string") {
      console.warn("Scene: skipping a malformed record in scene.json", record);
      continue;
    }
    const object = resolveSceneObject(scene, {
      className: "",
      fieldName: "",
      objectPath: record.objectPath,
      objectName: record.objectName ?? lastSegment(record.objectPath),
    });
    if (!object) {
      if (import.meta.env.DEV) {
        console.warn(`Scene: "${record.objectPath}" from scene.json is not in this scene — the model may have changed. Skipping its overrides.`);
      }
      continue;
    }
    resolved.push({ record, object });
  }

  // Parents resolve against the same pre-application paths, so a record can
  // name a parent that a later record renames.
  const parentFor = new Map<THREE.Object3D, THREE.Object3D | null>();
  for (const { record, object } of resolved) {
    if (record.parentPath === undefined) continue;
    if (record.parentPath === "") {
      parentFor.set(object, null);
      continue;
    }
    const parent = resolveSceneObject(scene, {
      className: "",
      fieldName: "",
      objectPath: record.parentPath,
      objectName: lastSegment(record.parentPath),
    });
    if (parent && parent !== object && !isDescendantOf(parent, object)) parentFor.set(object, parent);
    else if (import.meta.env.DEV) console.warn(`Scene: cannot re-parent "${record.objectPath}" to "${record.parentPath}".`);
  }

  for (const { record, object } of resolved) {
    if (Array.isArray(record.position) && record.position.length === 3) object.position.set(...(record.position as [number, number, number]));
    if (Array.isArray(record.rotation) && record.rotation.length === 3) {
      object.rotation.set(
        THREE.MathUtils.degToRad(record.rotation[0]),
        THREE.MathUtils.degToRad(record.rotation[1]),
        THREE.MathUtils.degToRad(record.rotation[2])
      );
    }
    if (Array.isArray(record.scale) && record.scale.length === 3) object.scale.set(...(record.scale as [number, number, number]));
    if (typeof record.visible === "boolean") object.visible = record.visible;
    if (typeof record.name === "string" && record.name) object.name = record.name;
  }

  // Re-parenting last: it changes the graph the passes above walked, and
  // `attach` is what preserves the world transform an authored position was
  // measured in.
  for (const [object, parent] of parentFor) {
    (parent ?? scene).add(object);
  }

  // Said out loud in dev. "My edits did not come back" is the report this file
  // exists to answer, and the first question is always whether the boot saw
  // the file at all — a count here separates "nothing was saved" from
  // "nothing resolved" from "something later overwrote it".
  if (import.meta.env.DEV) {
    console.info(`ION scene: applied ${resolved.length} of ${records.length} override(s) from scene.json`);
  }

  return resolved.length;
}

/** Guards against re-parenting an object under its own descendant, which detaches the whole branch from the scene. */
function isDescendantOf(candidate: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = candidate; node; node = node.parent) {
    if (node === ancestor) return true;
  }
  return false;
}

/** The empty file, for a project that has never saved scene overrides. */
export const EMPTY_SCENE_OVERRIDES: SceneOverridesFileData = { version: 1, objects: [] };
