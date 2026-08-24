import * as THREE from "three";
import type { Collider } from "../collision/Collider";
import type { ColliderShape } from "../collision/ColliderTypes";
import type { ColliderManager } from "../collision/ColliderManager";
import { BoxCollider } from "../collision/BoxCollider";
import { SphereCollider } from "../collision/SphereCollider";
import { CylinderCollider } from "../collision/CylinderCollider";
import { applyColliderData, colliderToData } from "../collision/ColliderSerialization";
import type { ColliderData } from "../collision/ColliderTypes";
import type { ColliderVisuals } from "./ColliderVisuals";
import type { EditorSelection } from "./EditorSelection";
import type { EditorObjectPicker } from "./EditorObjectPicker";
import type { EditorHistory } from "./EditorHistory";
import type { InspectorField, InspectorSection, InspectorSectionProvider } from "./InspectorSections";

export interface EditorCollidersOptions {
  manager: ColliderManager;
  /** Shared with Game's in-game DEV debug overlay — one wireframe layer, two things that can show it. */
  visuals: ColliderVisuals;
  scene: THREE.Scene;
  selection: EditorSelection;
  /** Used by the "Attached To" row's ⊙ button — the same arm/resolve flow Control Desk's field picking uses. */
  picker: EditorObjectPicker;
  /** Where a new unattached collider is dropped: the orbit target, i.e. the middle of what you're looking at. */
  getFocusPoint: () => THREE.Vector3;
  /** Shared with the particle editor, so undo survives a mode switch. */
  history: EditorHistory;
  /** Notified whenever something changed that a save would need to write. */
  onDirty?: () => void;
}

const boundsScratch = new THREE.Box3();
const sizeScratch = new THREE.Vector3();
const centerScratch = new THREE.Vector3();
const sphereScratch = new THREE.Sphere();
const matrixScratch = new THREE.Matrix4();
const childMatrixScratch = new THREE.Matrix4();
const childBounds = new THREE.Box3();

/**
 * "Configure Colliders" — the 3D editor's collider authoring mode, and the
 * Inspector panel that goes with it.
 *
 * Everything about editing colliders lives here: creating them, fitting
 * them to a mesh's real bounds, attaching them to scene objects, and
 * describing them to the Inspector. It owns no DOM of its own — the
 * Inspector renders whatever `describe()` hands back (see
 * InspectorSections.ts), which is what keeps this file about colliders
 * instead of about `<input>` elements.
 *
 * Two invariants it holds throughout:
 *
 *  - **It never modifies a render mesh.** Fitting a collider to an object
 *    reads that object's geometry bounds and writes only the collider. No
 *    material, geometry, transform, or visibility of anything in the game
 *    scene is touched — "configuring colliders" can't damage the model.
 *  - **It never exists in production.** Reachable only from EditorRoot,
 *    which Game constructs behind `import.meta.env.DEV`, so this module,
 *    ColliderVisuals, and their geometry/materials are all statically
 *    unreachable in a shipped build and drop out of it. The runtime
 *    collision system in engine/collision/ is entirely independent of it.
 */
export class EditorColliders implements InspectorSectionProvider {
  private readonly opts: EditorCollidersOptions;
  private readonly visuals: ColliderVisuals;
  private readonly unsubscribe: () => void;

  private active = false;
  private dirty = false;
  /** Bumped whenever the Inspector's collider section would need different *rows* — a shape swap, a different collider, a create/delete. See InspectorSectionProvider.version. */
  private structureVersion = 0;
  private newColliderCount = 0;

  /** Transform captured on the leading edge of a gizmo drag, so the trailing edge can push one undo entry for the whole gesture. */
  private dragSnapshot: { collider: Collider; data: ColliderData } | undefined;

  constructor(opts: EditorCollidersOptions) {
    this.opts = opts;
    this.visuals = opts.visuals;
    // Tint only. Deliberately does *not* bump structureVersion: the
    // Inspector already rebuilds on a selection change by itself, and
    // bumping here would additionally force a second rebuild a frame later,
    // yanking focus out of a field the user just clicked into.
    this.unsubscribe = opts.selection.subscribe((state) => {
      this.visuals.setSelected(this.colliderFor(state.object)?.id);
    });
  }

  // ---------------------------------------------------------------------
  // Mode
  // ---------------------------------------------------------------------

  /** Toolbar "Configure Colliders". Turning it on reveals every collider's volume; turning it off hides them again and leaves the registry untouched. */
  setActive(active: boolean): boolean {
    this.active = active;
    this.visuals.setEditorVisible(active);
    this.structureVersion++;
    return this.active;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Independent of the mode: lets you keep authoring with the volumes hidden when they're covering the thing you're aiming at. */
  toggleVisible(): boolean {
    this.visuals.setEditorVisible(!this.visuals.isEditorVisible);
    return this.visuals.isVisible;
  }

  /**
   * Once per editor frame, from EditorRoot.update().
   *
   * previewOverlaps() rather than update(): gameplay is paused for the
   * whole editor session, so this is the only thing keeping collider
   * transforms in step with gizmo drags — and it deliberately runs
   * detection without dispatching events, so arranging a trigger in the
   * editor never runs the game's own handlers. See its doc comment.
   */
  update(): void {
    this.opts.manager.previewOverlaps();
    // The drawing itself is refreshed once per frame by Game.render(), for
    // both this and the in-game debug overlay — doing it here as well would
    // reconcile the same layer twice a frame.
  }

  /** The wireframe layer is Game's, not this class's — leave it alive, just stop claiming it for the editor. */
  dispose(): void {
    this.unsubscribe();
    this.visuals.setEditorVisible(false);
    this.visuals.setSelected(undefined);
  }

  // ---------------------------------------------------------------------
  // Authoring
  // ---------------------------------------------------------------------

  /**
   * Creates a collider of `shape`.
   *
   * With a normal scene object selected, the new collider is **attached to
   * it and fitted to its real geometry bounds** — the spec's "copy the
   * exact bounds/shape of a selected Mesh/Object3D", and the case that's
   * actually useful, since a collider almost always describes something.
   * With nothing (or another collider) selected, it's a 1-unit volume at
   * the view's focus point, ready to be dragged into place.
   */
  create(shape: ColliderShape): Collider {
    const target = this.selectedSceneObject();
    const collider = this.instantiate(shape);
    collider.name = this.uniqueName(defaultNameFor(shape));
    collider.persisted = true;
    this.opts.manager.add(collider);

    if (target) {
      collider.attachToObject(target);
      this.fitToObject(collider, target);
    } else {
      collider.offsetPosition.copy(this.opts.getFocusPoint());
    }

    this.recordCreate(collider, `Create ${collider.name}`);
    this.opts.selection.selectObject(collider.node, "api");
    return collider;
  }

  /** Re-fits an existing collider to whatever it's attached to. The button you press after moving a prop and wanting its volume to catch up. */
  refit(collider: Collider): boolean {
    if (!collider.attached) return false;
    this.record(collider, `Fit ${collider.name}`, () => this.fitToObject(collider, collider.attached as THREE.Object3D));
    return true;
  }

  /** Same collider, same settings, new id and name — the fast way to lay out a row of identical zones. */
  duplicate(collider: Collider): Collider {
    const copy = this.instantiate(collider.shape);
    copy.name = this.uniqueName(collider.name);
    copy.tag = collider.tag;
    copy.mask = [...collider.mask];
    copy.isTrigger = collider.isTrigger;
    copy.persisted = true;
    copy.offsetPosition.copy(collider.offsetPosition);
    copy.offsetRotation.copy(collider.offsetRotation);
    copy.offsetScale.copy(collider.offsetScale);
    copyShape(collider, copy);
    copy.attachToObject(collider.attached);
    this.opts.manager.add(copy);
    this.recordCreate(copy, `Duplicate ${collider.name}`);
    this.opts.selection.selectObject(copy.node, "api");
    return copy;
  }

  /**
   * Removes a collider. Refuses code-created ones — deleting a collider a
   * script builds every boot would look like it worked and then come
   * straight back.
   *
   * Detached with `keepAlive` rather than destroyed, so undo restores the
   * very same instance and anything holding a reference to it (a Control
   * Desk assignment, a gameplay handler) keeps working. The command owns
   * it from here: `discard("applied")` destroys it once the delete can no
   * longer be undone.
   */
  remove(collider: Collider): boolean {
    if (!collider.persisted) return false;
    const wasSelected = this.opts.selection.object === collider.node;
    if (wasSelected) this.opts.selection.selectObject(undefined, "api");
    this.opts.manager.remove(collider, true);
    this.markDirty();
    this.structureVersion++;

    this.opts.history.push({
      label: `Delete ${collider.name}`,
      undo: () => {
        this.opts.manager.add(collider);
        this.structureVersion++;
        this.markDirty();
        if (wasSelected) this.opts.selection.selectObject(collider.node, "api");
      },
      redo: () => {
        if (this.opts.selection.object === collider.node) this.opts.selection.selectObject(undefined, "api");
        this.opts.manager.remove(collider, true);
        this.structureVersion++;
        this.markDirty();
      },
      discard: (state) => {
        if (state === "applied") collider.destroy();
      },
    });
    return true;
  }

  /** The currently-selected collider, if the selection is one. */
  get selected(): Collider | undefined {
    return this.colliderFor(this.opts.selection.object);
  }

  /** Deletes whatever collider is selected — the toolbar's 🗑 button. */
  removeSelected(): boolean {
    const collider = this.selected;
    return collider ? this.remove(collider) : false;
  }

  /**
   * Maps a viewport raycast hit to the collider node it belongs to.
   *
   * Clicks land on the translucent volume mesh, which is a child of the
   * collider's node — without this, selecting a collider in the viewport
   * would select an editor visual and attach the transform gizmo to it,
   * moving the drawing away from the volume it's meant to be drawing.
   */
  resolveHit(object: THREE.Object3D): THREE.Object3D {
    const collider = this.opts.manager.fromNode(object);
    return collider ? collider.node : object;
  }

  // ---------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------

  /** True when something has changed that Exit Editor should write out. */
  get hasChanges(): boolean {
    return this.dirty;
  }

  /** How many colliders would be written — what the Exit button counts. */
  get persistedCount(): number {
    return this.opts.manager.all.filter((c) => c.persisted).length;
  }

  /**
   * The whole file's worth of colliders, as JSON-ready records.
   *
   * A wholesale replace rather than a per-collider diff: colliders.json is
   * entirely the editor's to own, and a diff would have to reconcile
   * deletions, reorders, and id collisions for no benefit. Code-created
   * colliders are excluded — see Collider.persisted.
   */
  serialize(): ColliderData[] {
    return this.opts.manager.all.filter((c) => c.persisted).map((c) => colliderToData(c, this.opts.scene));
  }

  /** Called by the dev page once the save actually landed. */
  markSaved(): void {
    this.dirty = false;
  }

  // ---------------------------------------------------------------------
  // Inspector section
  // ---------------------------------------------------------------------

  get version(): number {
    return this.structureVersion;
  }

  describe(object: THREE.Object3D): InspectorSection | undefined {
    const collider = this.colliderFor(object);
    if (!collider) return undefined;
    const fields: InspectorField[] = [
      {
        kind: "text",
        label: "Name",
        value: collider.name,
        placeholder: "Collider",
        hint: "Free-form. This is also how gameplay finds it: Ion.colliders.getByName(\"…\").",
        read: () => collider.name,
        onChange: (v) => {
          // Merged by field, so typing a name is one undo step rather than
          // one per keystroke.
          this.record(collider, `Rename to "${v || "Collider"}"`, () => (collider.name = v || "Collider"), `col:${collider.id}:name`);
        },
      },
      {
        kind: "info",
        label: "Shape",
        value: `${collider.shape} · ${collider.describeShape()}`,
        read: () => `${collider.shape} · ${collider.describeShape()}`,
      },
      ...this.shapeFields(collider),
      {
        kind: "toggle",
        label: "Is Trigger",
        value: collider.isTrigger,
        onText: "Trigger / Area",
        offText: "Solid collider",
        hint: "A trigger reports overlaps (onTriggerEnter/Stay/Exit) instead of acting as a solid volume. If either side of a pair is a trigger, only trigger events fire.",
        read: () => collider.isTrigger,
        onChange: (v) => {
          this.record(collider, v ? `Make ${collider.name} a trigger` : `Make ${collider.name} solid`, () => {
            collider.isTrigger = v;
            this.structureVersion++;
          });
        },
      },
      {
        kind: "toggle",
        label: "Enabled",
        value: collider.enabled,
        onText: "Detecting",
        offText: "Off",
        hint: "Turning a collider off mid-overlap fires exit on every pair it was in, so nothing gets stuck thinking the player is still inside.",
        read: () => collider.enabled,
        onChange: (v) => {
          this.record(collider, v ? `Enable ${collider.name}` : `Disable ${collider.name}`, () => collider.setEnabled(v));
        },
      },
      {
        kind: "text",
        label: "Tag",
        value: collider.tag,
        placeholder: "Untagged",
        hint: 'What this collider *is* — "Player", "PlayerZone", "Pickup". Handlers filter on it: zone.onTriggerEnter("Player", …).',
        read: () => collider.tag,
        onChange: (v) => {
          this.record(collider, `Tag ${collider.name}`, () => (collider.tag = v || "Untagged"), `col:${collider.id}:tag`);
        },
      },
      {
        kind: "text",
        label: "Mask",
        value: collider.mask.join(", "),
        placeholder: "any tag",
        hint: "Comma-separated tags this collider will pair with at all. Empty means every tag. Filtered in the broad phase, before any intersection test runs.",
        read: () => collider.mask.join(", "),
        onChange: (v) => {
          this.record(
            collider,
            `Mask ${collider.name}`,
            () => {
              collider.mask = v
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean);
            },
            `col:${collider.id}:mask`
          );
        },
      },
      {
        kind: "objectRef",
        label: "Attached To",
        value: collider.attached ? collider.attached.name || collider.attached.type : "— world space —",
        hint: "The scene object this collider follows. It tracks that object's movement, rotation, and scale every frame without ever modifying it.",
        read: () => (collider.attached ? collider.attached.name || collider.attached.type : "— world space —"),
        onPick: () => this.armAttachPick(collider),
        onClear: () => {
          this.record(collider, `Detach ${collider.name}`, () => collider.attachToObject(undefined));
        },
        onDropObject: (dropped) => {
          if (this.opts.manager.fromNode(dropped)) return; // attaching a collider to another collider's node is a loop nobody wants
          this.record(collider, `Attach ${collider.name} to ${dropped.name || dropped.type}`, () => collider.attachToObject(dropped));
        },
      },
      {
        kind: "vec3",
        label: "Offset Position",
        value: [collider.offsetPosition.x, collider.offsetPosition.y, collider.offsetPosition.z],
        step: 0.05,
        read: () => [collider.offsetPosition.x, collider.offsetPosition.y, collider.offsetPosition.z],
        onChange: (axis, v) => {
          // Keyed per axis: nudging X then Y are two intentional edits, and
          // merging them would make one undo revert both.
          this.record(collider, `Move ${collider.name}`, () => collider.offsetPosition.setComponent(axis, v), `col:${collider.id}:pos:${axis}`);
        },
      },
      {
        kind: "vec3",
        label: "Offset Rotation °",
        value: eulerDegrees(collider),
        step: 1,
        read: () => eulerDegrees(collider),
        onChange: (axis, v) => {
          this.record(
            collider,
            `Rotate ${collider.name}`,
            () => {
              const e = collider.offsetRotation;
              const radians = THREE.MathUtils.degToRad(v);
              if (axis === 0) e.x = radians;
              else if (axis === 1) e.y = radians;
              else e.z = radians;
            },
            `col:${collider.id}:rot:${axis}`
          );
        },
      },
      {
        kind: "vec3",
        label: "Offset Scale",
        value: [collider.offsetScale.x, collider.offsetScale.y, collider.offsetScale.z],
        step: 0.05,
        read: () => [collider.offsetScale.x, collider.offsetScale.y, collider.offsetScale.z],
        onChange: (axis, v) => {
          this.record(collider, `Scale ${collider.name}`, () => collider.offsetScale.setComponent(axis, v), `col:${collider.id}:scale:${axis}`);
        },
      },
      {
        kind: "info",
        label: "Right now",
        value: "—",
        hint: "Live overlap state, evaluated every editor frame without firing any gameplay handler.",
        read: () => (this.opts.manager.isOverlapping(collider) ? "Overlapping" : "Clear"),
        readAccent: () => (this.opts.manager.isOverlapping(collider) ? "warn" : "good"),
      },
      {
        kind: "info",
        label: "Defined in",
        value: collider.persisted ? "colliders.json" : "game code",
        hint: collider.persisted ? "Saved to src/game/colliders.json when you exit the editor." : "Created by a script at runtime — editable here for this session, but not written to colliders.json (it would come back as a duplicate on the next boot).",
      },
      {
        kind: "buttons",
        buttons: [
          { text: "⧉ Fit to attached", title: "Resize and recenter this collider onto its attached object's real geometry bounds", onClick: () => this.refit(collider) },
          { text: "⧉ Duplicate", title: "New collider with the same shape, tag, and placement", onClick: () => this.duplicate(collider) },
          { text: "🗑 Delete", title: collider.persisted ? "Remove this collider" : "Colliders created in code can't be deleted here", danger: true, onClick: () => this.remove(collider) },
        ],
      },
    ];

    return {
      id: `collider:${collider.id}`,
      title: "Collider",
      badge: collider.isTrigger ? "TRIGGER" : collider.enabled ? "SOLID" : "OFF",
      badgeTone: collider.isTrigger ? "trigger" : collider.enabled ? "solid" : "off",
      fields,
    };
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private shapeFields(collider: Collider): InspectorField[] {
    if (collider instanceof BoxCollider) {
      return [
        {
          kind: "vec3",
          label: "Size",
          axisLabels: ["W", "H", "D"],
          value: [collider.size.x, collider.size.y, collider.size.z],
          step: 0.1,
          read: () => [collider.size.x, collider.size.y, collider.size.z],
          onChange: (axis, v) => {
            this.record(collider, `Resize ${collider.name}`, () => collider.size.setComponent(axis, Math.max(0.001, v)), `col:${collider.id}:size:${axis}`);
          },
        },
      ];
    }
    if (collider instanceof SphereCollider) {
      return [
        {
          kind: "number",
          label: "Radius",
          value: collider.radius,
          step: 0.05,
          min: 0.001,
          read: () => collider.radius,
          onChange: (v) => {
            this.record(collider, `Resize ${collider.name}`, () => (collider.radius = Math.max(0.001, v)), `col:${collider.id}:radius`);
          },
        },
      ];
    }
    const cyl = collider as CylinderCollider;
    return [
      {
        kind: "number",
        label: "Radius",
        value: cyl.radius,
        step: 0.05,
        min: 0.001,
        read: () => cyl.radius,
        onChange: (v) => {
          this.record(collider, `Resize ${collider.name}`, () => (cyl.radius = Math.max(0.001, v)), `col:${collider.id}:radius`);
        },
      },
      {
        kind: "number",
        label: "Height",
        value: cyl.height,
        step: 0.05,
        min: 0.001,
        read: () => cyl.height,
        onChange: (v) => {
          this.record(collider, `Resize ${collider.name}`, () => (cyl.height = Math.max(0.001, v)), `col:${collider.id}:height`);
        },
      },
    ];
  }

  private armAttachPick(collider: Collider): void {
    this.opts.picker.beginPickRequest({
      validate: (object) => (this.opts.manager.fromNode(object) ? { ok: false, reason: "That's a collider — pick a scene object for it to follow." } : { ok: true, reason: "" }),
      onResolve: (object) => {
        this.record(collider, `Attach ${collider.name} to ${object.name || object.type}`, () => collider.attachToObject(object));
        // Back to the collider, not the object that was just picked: the
        // panel you were configuring is the one you want to still be
        // looking at.
        this.opts.selection.selectObject(collider.node, "api");
      },
    });
  }

  private instantiate(shape: ColliderShape): Collider {
    if (shape === "sphere") return new SphereCollider({ radius: 0.5 });
    if (shape === "cylinder") return new CylinderCollider({ radius: 0.5, height: 2 });
    return new BoxCollider({ size: [1, 1, 1] });
  }

  /** The selection, unless it's a collider node — creating a collider "on" another collider isn't a thing. */
  private selectedSceneObject(): THREE.Object3D | undefined {
    const selected = this.opts.selection.object;
    if (!selected || this.opts.manager.fromNode(selected)) return undefined;
    return selected;
  }

  private colliderFor(object: THREE.Object3D | undefined): Collider | undefined {
    return object ? this.opts.manager.fromNode(object) : undefined;
  }

  /**
   * Sizes and centers `collider` onto `object`'s real geometry, in the
   * object's own local space.
   *
   * Local, not world, is the whole trick: `Box3.setFromObject` gives a
   * world-space *axis-aligned* box, so fitting from that would produce a
   * collider that's too big for any rotated object and wrong again the
   * moment the object turns. Measuring in local space gives a box that
   * genuinely wraps the geometry and then inherits the object's own
   * rotation through the attachment, which is what an oriented collider is
   * for.
   *
   * Reads geometry only — nothing about `object` is modified.
   */
  private fitToObject(collider: Collider, object: THREE.Object3D): void {
    if (!this.localBounds(object, boundsScratch)) return;
    boundsScratch.getSize(sizeScratch);
    boundsScratch.getCenter(centerScratch);
    collider.offsetPosition.copy(centerScratch);
    collider.offsetRotation.set(0, 0, 0);
    collider.offsetScale.set(1, 1, 1);

    if (collider instanceof BoxCollider) {
      collider.setSize(Math.max(sizeScratch.x, 0.001), Math.max(sizeScratch.y, 0.001), Math.max(sizeScratch.z, 0.001));
    } else if (collider instanceof SphereCollider) {
      // The AABB's own bounding sphere — the smallest sphere that actually
      // contains the measured box, rather than half the largest side (which
      // would cut the corners off).
      boundsScratch.getBoundingSphere(sphereScratch);
      collider.setRadius(Math.max(sphereScratch.radius, 0.001));
      collider.offsetPosition.copy(sphereScratch.center);
    } else if (collider instanceof CylinderCollider) {
      collider.setRadius(Math.max(Math.max(sizeScratch.x, sizeScratch.z) * 0.5, 0.001));
      collider.setHeight(Math.max(sizeScratch.y, 0.001));
    }
    this.structureVersion++;
  }

  /** Union of every descendant mesh's geometry bounds, expressed in `root`'s local space. Returns false when there's no geometry under it at all. */
  private localBounds(root: THREE.Object3D, out: THREE.Box3): boolean {
    out.makeEmpty();
    root.updateWorldMatrix(true, true);
    matrixScratch.copy(root.matrixWorld).invert();
    let found = false;
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox;
      if (!box) return;
      childMatrixScratch.multiplyMatrices(matrixScratch, mesh.matrixWorld);
      childBounds.copy(box).applyMatrix4(childMatrixScratch);
      out.union(childBounds);
      found = true;
    });
    return found;
  }

  private uniqueName(base: string): string {
    const taken = new Set(this.opts.manager.all.map((c) => c.name));
    if (!taken.has(base)) return base;
    this.newColliderCount++;
    let candidate = `${base} ${this.newColliderCount}`;
    let n = this.newColliderCount;
    while (taken.has(candidate)) candidate = `${base} ${++n}`;
    return candidate;
  }

  private markDirty(): void {
    this.dirty = true;
    this.opts.onDirty?.();
  }

  // ---------------------------------------------------------------------
  // Undo / redo
  // ---------------------------------------------------------------------

  /**
   * Runs `mutate` and records it as one undoable property change.
   *
   * Captures the collider's serialized form before and after, and restores
   * by writing the fields back onto the *same live collider*
   * (`applyColliderData`) rather than rebuilding it — identity survives, so
   * a Control Desk assignment pointing at this collider still resolves
   * after an undo.
   *
   * `mergeKey` collapses a continuous gesture (a slider drag, typing into a
   * number field) into a single entry — see EditorHistory.push.
   */
  private record(collider: Collider, label: string, mutate: () => void, mergeKey?: string): void {
    if (this.opts.history.isApplying) {
      // Already inside an undo/redo — this mutation *is* the replay, and
      // recording it would push the inverse of the thing being replayed.
      mutate();
      return;
    }
    const before = colliderToData(collider, this.opts.scene);
    mutate();
    const after = colliderToData(collider, this.opts.scene);
    this.opts.history.push({
      label,
      mergeKey,
      undo: () => this.restoreCollider(collider, before),
      redo: () => this.restoreCollider(collider, after),
    });
    this.markDirty();
  }

  private restoreCollider(collider: Collider, data: ColliderData): void {
    if (collider.isDestroyed) return;
    applyColliderData(collider, data, this.opts.scene);
    // Dimensions and attachment change which rows the Inspector shows.
    this.structureVersion++;
    this.markDirty();
  }

  /**
   * Records a create/duplicate so undo removes it and redo brings the same
   * object back.
   *
   * `keepAlive` on removal is what makes that possible: the collider is
   * detached rather than destroyed, so redo re-registers the identical
   * instance. `discard` releases it if the command is dropped while
   * unapplied — at that point nothing can ever bring it back, and the
   * object would otherwise sit detached forever.
   */
  private recordCreate(collider: Collider, label: string): void {
    this.opts.history.push({
      label,
      undo: () => {
        if (this.opts.selection.object === collider.node) this.opts.selection.selectObject(undefined, "api");
        this.opts.manager.remove(collider, true);
        this.structureVersion++;
        this.markDirty();
      },
      redo: () => {
        this.opts.manager.add(collider);
        this.structureVersion++;
        this.markDirty();
      },
      discard: (state) => {
        if (state === "unapplied") collider.destroy();
      },
    });
    this.markDirty();
  }

  /** Begin/end of a gizmo drag — see EditorRoot, which routes SceneInspector's drag events here. */
  onGizmoDrag(dragging: boolean): void {
    const collider = this.selected;
    if (dragging) {
      this.dragSnapshot = collider ? { collider, data: colliderToData(collider, this.opts.scene) } : undefined;
      return;
    }
    const snapshot = this.dragSnapshot;
    this.dragSnapshot = undefined;
    if (!snapshot || snapshot.collider !== collider || !collider) return;
    const after = colliderToData(collider, this.opts.scene);
    // A click that selected without moving anything must not create an
    // empty undo step.
    if (JSON.stringify(snapshot.data.offset) === JSON.stringify(after.offset)) return;
    this.opts.history.push({
      label: `Transform ${collider.name}`,
      undo: () => this.restoreCollider(collider, snapshot.data),
      redo: () => this.restoreCollider(collider, after),
    });
    this.markDirty();
  }
}

function defaultNameFor(shape: ColliderShape): string {
  return shape === "sphere" ? "Sphere Collider" : shape === "cylinder" ? "Cylinder Collider" : "Box Collider";
}

function copyShape(from: Collider, to: Collider): void {
  if (from instanceof BoxCollider && to instanceof BoxCollider) to.size.copy(from.size);
  else if (from instanceof SphereCollider && to instanceof SphereCollider) to.radius = from.radius;
  else if (from instanceof CylinderCollider && to instanceof CylinderCollider) {
    to.radius = from.radius;
    to.height = from.height;
  }
}

function eulerDegrees(collider: Collider): [number, number, number] {
  return [THREE.MathUtils.radToDeg(collider.offsetRotation.x), THREE.MathUtils.radToDeg(collider.offsetRotation.y), THREE.MathUtils.radToDeg(collider.offsetRotation.z)];
}
