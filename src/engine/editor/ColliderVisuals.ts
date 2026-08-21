import * as THREE from "three";
import type { Collider } from "../collision/Collider";
import type { BoxCollider } from "../collision/BoxCollider";
import type { SphereCollider } from "../collision/SphereCollider";
import type { CylinderCollider } from "../collision/CylinderCollider";
import type { ColliderManager } from "../collision/ColliderManager";

/** Solid (non-trigger) volumes — green, the "this is a real obstacle" reading. */
const COLOR_SOLID = 0x4ade80;
/** Triggers/areas — cyan, deliberately a different hue family from solid so the two are distinguishable at a glance and not just by brightness. */
const COLOR_TRIGGER = 0x38bdf8;
/** Disabled — desaturated grey. Still drawn: a collider you can't see is one you can't find to re-enable. */
const COLOR_DISABLED = 0x7c869b;
/** Overlapping *right now*. The single most useful thing this layer does — you can watch a trigger fire instead of reading a console. */
const COLOR_HIT = 0xff5470;

interface Visual {
  group: THREE.Group;
  line: THREE.LineSegments;
  fill: THREE.Mesh;
  lineMaterial: THREE.LineBasicMaterial;
  fillMaterial: THREE.MeshBasicMaterial;
  /** Shape + dimensions, as a string. When it changes the geometry is rebuilt; when it doesn't, nothing is. */
  signature: string;
}

/**
 * Editor-only wireframe + translucent-fill rendering for every registered
 * collider.
 *
 * Strictly a *view*. It reads the collider registry and draws it; it never
 * writes a collider, and it never touches a game mesh — the visuals are
 * separate geometry parented under each collider's own node, so
 * "configuring colliders" can't accidentally modify the thing the collider
 * describes. Teardown removes all of it and the scene is byte-identical to
 * how it was found.
 *
 * The whole module is reachable only from EditorRoot, which Game only
 * constructs behind `import.meta.env.DEV` — so none of this, including the
 * materials and geometry below, exists in a production build.
 *
 * Reconciliation is signature-based rather than event-based: each frame it
 * compares what it has drawn against what the registry holds, and rebuilds
 * only the geometry whose shape or dimensions actually changed. That keeps
 * it correct through collider creation, deletion, shape swaps, and hot
 * reload without needing the registry to emit change events it otherwise
 * has no reason to have.
 */
export class ColliderVisuals {
  private readonly visuals = new Map<string, Visual>();
  /** The Engine Room's "Colliders" debug toggle — draws volumes over the *running* game. */
  private debugVisible = false;
  /** The 3D editor's Configure Colliders mode. */
  private editorVisible = false;
  private selectedId: string | undefined;
  /**
   * Where to register the drawn objects so the editor's Hierarchy hides
   * them and its gizmo refuses to attach to them.
   *
   * Optional and swappable because this layer outlives any one editor
   * session: it also draws during normal gameplay for the in-game debug
   * toggle, where there is no tree to hide from. EditorRoot points it at
   * `SceneInspector.ownedHelpers` on entry and clears it on exit, and the
   * objects are added/removed from whichever sink is current. The collider
   * *nodes* deliberately never go in — those are meant to be listed and
   * selectable.
   */
  private excluded: Set<THREE.Object3D> | undefined;

  constructor(private readonly manager: ColliderManager) {}

  /** The in-game DEV overlay. Independent of the editor's own mode — either one showing draws the volumes. */
  setDebugVisible(visible: boolean): void {
    this.debugVisible = visible;
    this.applyVisibility();
  }

  /** Configure Colliders mode, and its 👁 button. */
  setEditorVisible(visible: boolean): void {
    this.editorVisible = visible;
    this.applyVisibility();
  }

  get isDebugVisible(): boolean {
    return this.debugVisible;
  }

  get isEditorVisible(): boolean {
    return this.editorVisible;
  }

  /** Hides the drawing only — colliders keep detecting either way. */
  get isVisible(): boolean {
    return this.debugVisible || this.editorVisible;
  }

  /** Swaps the exclusion set (see the field's own comment), moving everything already drawn between them. */
  setExclusionSink(sink: Set<THREE.Object3D> | undefined): void {
    if (this.excluded === sink) return;
    if (this.excluded) {
      for (const visual of this.visuals.values()) this.unregister(visual, this.excluded);
    }
    this.excluded = sink;
    if (sink) {
      for (const visual of this.visuals.values()) this.register(visual, sink);
    }
  }

  private applyVisibility(): void {
    const visible = this.isVisible;
    for (const visual of this.visuals.values()) visual.group.visible = visible;
  }

  private register(visual: Visual, sink: Set<THREE.Object3D>): void {
    sink.add(visual.group);
    sink.add(visual.fill);
    sink.add(visual.line);
  }

  private unregister(visual: Visual, sink: Set<THREE.Object3D>): void {
    sink.delete(visual.group);
    sink.delete(visual.fill);
    sink.delete(visual.line);
  }

  setSelected(colliderId: string | undefined): void {
    this.selectedId = colliderId;
  }

  /** Once per frame, after ColliderManager has synced. Cheap when nothing changed — the loop below only rebuilds geometry whose signature moved. */
  update(): void {
    // Nothing is on screen, so nothing needs reconciling. This is the
    // normal state during gameplay, and it's what makes owning this layer
    // outside the editor free until someone turns the overlay on.
    if (!this.isVisible && this.visuals.size === 0) return;
    const live = new Set<string>();
    for (const collider of this.manager.all) {
      live.add(collider.id);
      const signature = signatureFor(collider);
      let visual = this.visuals.get(collider.id);
      if (visual && visual.signature !== signature) {
        this.destroyVisual(collider.id, visual);
        visual = undefined;
      }
      if (!visual) visual = this.createVisual(collider, signature);
      this.paint(collider, visual);
    }
    for (const [id, visual] of [...this.visuals]) {
      if (!live.has(id)) this.destroyVisual(id, visual);
    }
  }

  dispose(): void {
    for (const [id, visual] of [...this.visuals]) this.destroyVisual(id, visual);
    this.visuals.clear();
  }

  private createVisual(collider: Collider, signature: string): Visual {
    const geometry = geometryFor(collider);
    const lineMaterial = new THREE.LineBasicMaterial({ color: COLOR_SOLID, transparent: true, opacity: 0.95, depthTest: true });
    const fillMaterial = new THREE.MeshBasicMaterial({
      color: COLOR_SOLID,
      transparent: true,
      opacity: 0.1,
      // Never writes depth: a collider wrapping a mesh would otherwise cut
      // a hole in it, and the whole point is to see the mesh *through* the
      // volume. DoubleSide so standing inside a room-sized trigger still
      // shows its walls.
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const fill = new THREE.Mesh(geometry, fillMaterial);
    // The click target: raycasting a LineSegments needs a threshold and
    // still only hits within a few pixels of an edge, which makes small
    // colliders effectively unselectable in the viewport.
    fill.name = `${collider.name} (collider volume)`;
    const line = new THREE.LineSegments(outlineGeometryFor(collider, geometry), lineMaterial);
    line.name = `${collider.name} (collider outline)`;
    // Wireframe over everything it overlaps — a volume buried inside the
    // mesh it describes is the normal case, not the exception.
    line.renderOrder = 999;

    const group = new THREE.Group();
    group.name = `${collider.name} (collider gizmo)`;
    group.visible = this.isVisible;
    group.add(fill, line);
    collider.node.add(group);

    const visual: Visual = { group, line, fill, lineMaterial, fillMaterial, signature };
    // Hidden from the Hierarchy tree and never gizmo-attachable — but still
    // raycastable, which is what lets a viewport click on a volume select
    // the collider itself (see EditorColliders' resolveHit).
    if (this.excluded) this.register(visual, this.excluded);
    this.visuals.set(collider.id, visual);
    return visual;
  }

  private paint(collider: Collider, visual: Visual): void {
    const overlapping = this.manager.isOverlapping(collider);
    const color = !collider.enabled ? COLOR_DISABLED : overlapping ? COLOR_HIT : collider.isTrigger ? COLOR_TRIGGER : COLOR_SOLID;
    const selected = this.selectedId === collider.id;
    visual.lineMaterial.color.setHex(color);
    visual.fillMaterial.color.setHex(color);
    visual.lineMaterial.opacity = collider.enabled ? (selected ? 1 : 0.8) : 0.4;
    visual.fillMaterial.opacity = overlapping ? 0.26 : selected ? 0.2 : collider.enabled ? 0.09 : 0.04;
    visual.group.visible = this.isVisible;
  }

  private destroyVisual(id: string, visual: Visual): void {
    visual.group.removeFromParent();
    if (this.excluded) this.unregister(visual, this.excluded);
    visual.fill.geometry.dispose();
    visual.line.geometry.dispose();
    visual.lineMaterial.dispose();
    visual.fillMaterial.dispose();
    this.visuals.delete(id);
  }
}

/**
 * Geometry at the collider's *own* dimensions. The node already carries the
 * offset scale and the attachment's world transform, so this must not apply
 * either — building at true size and letting the node's matrix do the rest
 * is what keeps the drawing and the intersection math reading the same
 * numbers.
 */
function geometryFor(collider: Collider): THREE.BufferGeometry {
  if (collider.shape === "sphere") {
    const sphere = collider as SphereCollider;
    return new THREE.SphereGeometry(sphere.radius, 16, 12);
  }
  if (collider.shape === "cylinder") {
    const cyl = collider as CylinderCollider;
    return new THREE.CylinderGeometry(cyl.radius, cyl.radius, cyl.height, 20, 1);
  }
  const box = collider as BoxCollider;
  return new THREE.BoxGeometry(box.size.x, box.size.y, box.size.z);
}

/**
 * The line drawing, which is not simply "edges of the fill mesh".
 *
 * EdgesGeometry only emits an edge where two faces meet above an angle
 * threshold — perfect for a box (exactly its 12 edges, nothing else) and
 * useless for a sphere or a cylinder's curved side, where every adjacent
 * face is nearly coplanar and the result is close to empty. Those get a
 * full wireframe over a deliberately coarse copy of the shape instead:
 * enough lines to read the volume, few enough not to look like a solid
 * blob at distance.
 */
function outlineGeometryFor(collider: Collider, fill: THREE.BufferGeometry): THREE.BufferGeometry {
  if (collider.shape === "box") return new THREE.EdgesGeometry(fill, 20);
  if (collider.shape === "sphere") {
    const sphere = collider as SphereCollider;
    const coarse = new THREE.SphereGeometry(sphere.radius, 12, 6);
    const wire = new THREE.WireframeGeometry(coarse);
    coarse.dispose();
    return wire;
  }
  const cyl = collider as CylinderCollider;
  const coarse = new THREE.CylinderGeometry(cyl.radius, cyl.radius, cyl.height, 14, 1);
  const wire = new THREE.WireframeGeometry(coarse);
  coarse.dispose();
  return wire;
}

function signatureFor(collider: Collider): string {
  if (collider.shape === "sphere") return `s:${(collider as SphereCollider).radius}`;
  if (collider.shape === "cylinder") {
    const cyl = collider as CylinderCollider;
    return `c:${cyl.radius}:${cyl.height}`;
  }
  const box = collider as BoxCollider;
  return `b:${box.size.x}:${box.size.y}:${box.size.z}`;
}
