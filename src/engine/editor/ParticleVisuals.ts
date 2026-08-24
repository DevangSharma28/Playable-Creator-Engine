import * as THREE from "three";
import type { ParticleEmitter } from "../particles/ParticleEmitter";
import type { ParticleManager } from "../particles/ParticleManager";
import type { ShapeModule } from "../particles/ParticleTypes";

/** Emission volume — amber, deliberately a different hue family from the collider layer's green/cyan so the two are never confused when both are on. */
const COLOR_SHAPE = 0xffb020;
/** The selected emitter's volume. */
const COLOR_SELECTED = 0xffe066;
/** Disabled emitters — still drawn, because one you can't see is one you can't find to re-enable. */
const COLOR_DISABLED = 0x7c869b;
/** Direction indicator. */
const COLOR_DIRECTION = 0x38f0a0;
/** Live particle bounds. */
const COLOR_BOUNDS = 0x8a7cff;

interface Visual {
  group: THREE.Group;
  shapeLines: THREE.LineSegments;
  shapeMaterial: THREE.LineBasicMaterial;
  direction: THREE.Line;
  directionMaterial: THREE.LineBasicMaterial;
  bounds: THREE.LineSegments;
  boundsMaterial: THREE.LineBasicMaterial;
  /** Shape kind + dimensions as a string. Geometry is rebuilt only when this moves. */
  signature: string;
}

const boundsScratch = new THREE.Vector3();
const boundsInverse = new THREE.Matrix4();

/**
 * Editor-only wireframe drawing for particle emitters: the emission
 * volume, the direction the shape points, and the live particle bounds.
 *
 * Structurally identical to ColliderVisuals, and for the same reasons —
 * it's strictly a *view* (it reads emitters and draws them, never writes
 * one, never touches a game mesh), it reconciles by **signature** rather
 * than by change events (so it stays correct through creation, deletion,
 * shape swaps, and hot reload without the runtime needing to emit events
 * it otherwise has no reason to have), and the entire module is reachable
 * only from EditorRoot, which Game constructs behind `import.meta.env.DEV`
 * — so none of it, including these materials, exists in a production
 * build.
 *
 * Toggling the helpers changes nothing about the effect itself: the
 * visuals are separate geometry parented under each emitter's own node,
 * and teardown removes all of it leaving the scene byte-identical.
 */
export class ParticleVisuals {
  private readonly visuals = new Map<string, Visual>();
  private editorVisible = false;
  private showShapes = true;
  private showDirection = true;
  private showBounds = false;
  private selectedId: string | undefined;
  /** Where to register drawn objects so the Hierarchy hides them and the gizmo refuses to attach — same swappable-sink contract ColliderVisuals uses. */
  private excluded: Set<THREE.Object3D> | undefined;

  constructor(private readonly manager: ParticleManager) {}

  setEditorVisible(visible: boolean): void {
    this.editorVisible = visible;
    for (const visual of this.visuals.values()) visual.group.visible = visible;
  }

  get isVisible(): boolean {
    return this.editorVisible;
  }

  setShowShapes(show: boolean): void {
    this.showShapes = show;
  }
  setShowDirection(show: boolean): void {
    this.showDirection = show;
  }
  setShowBounds(show: boolean): void {
    this.showBounds = show;
  }

  get showingShapes(): boolean {
    return this.showShapes;
  }
  get showingDirection(): boolean {
    return this.showDirection;
  }
  get showingBounds(): boolean {
    return this.showBounds;
  }

  setSelected(emitterId: string | undefined): void {
    this.selectedId = emitterId;
  }

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

  /** Once per editor frame. Cheap when nothing changed — only geometry whose signature moved is rebuilt. */
  update(): void {
    if (!this.editorVisible && this.visuals.size === 0) return;
    const live = new Set<string>();
    for (const emitter of this.manager.allEmitters) {
      live.add(emitter.id);
      const signature = signatureFor(emitter);
      let visual = this.visuals.get(emitter.id);
      if (visual && visual.signature !== signature) {
        this.destroyVisual(emitter.id, visual);
        visual = undefined;
      }
      if (!visual) visual = this.createVisual(emitter, signature);
      this.paint(emitter, visual);
    }
    for (const [id, visual] of [...this.visuals]) {
      if (!live.has(id)) this.destroyVisual(id, visual);
    }
  }

  dispose(): void {
    for (const [id, visual] of [...this.visuals]) this.destroyVisual(id, visual);
    this.visuals.clear();
  }

  // -----------------------------------------------------------------------

  private createVisual(emitter: ParticleEmitter, signature: string): Visual {
    const shape = emitter.settings.shape;

    const shapeMaterial = new THREE.LineBasicMaterial({ color: COLOR_SHAPE, transparent: true, opacity: 0.9 });
    const shapeLines = new THREE.LineSegments(shapeGeometryFor(shape), shapeMaterial);
    shapeLines.name = `${emitter.name} (emission volume)`;
    // Over whatever it wraps: an emitter placed inside a prop is the
    // normal case, and a volume buried in geometry is a volume nobody can
    // aim at.
    shapeLines.renderOrder = 999;

    const directionMaterial = new THREE.LineBasicMaterial({ color: COLOR_DIRECTION, transparent: true, opacity: 0.95 });
    const direction = new THREE.Line(directionGeometry(), directionMaterial);
    direction.name = `${emitter.name} (direction)`;
    direction.renderOrder = 1000;

    const boundsMaterial = new THREE.LineBasicMaterial({ color: COLOR_BOUNDS, transparent: true, opacity: 0.4 });
    const bounds = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), boundsMaterial);
    bounds.name = `${emitter.name} (particle bounds)`;
    bounds.visible = false;

    // The shape's own offset transform is applied to the drawing, so the
    // wireframe sits exactly where particles actually spawn rather than at
    // the emitter's origin.
    const shapeHolder = new THREE.Group();
    shapeHolder.position.set(shape.position[0], shape.position[1], shape.position[2]);
    shapeHolder.rotation.set(
      shape.rotation[0] * THREE.MathUtils.DEG2RAD,
      shape.rotation[1] * THREE.MathUtils.DEG2RAD,
      shape.rotation[2] * THREE.MathUtils.DEG2RAD
    );
    shapeHolder.scale.set(shape.scale[0], shape.scale[1], shape.scale[2]);
    shapeHolder.add(shapeLines, direction);

    const group = new THREE.Group();
    group.name = `${emitter.name} (particle gizmo)`;
    group.visible = this.editorVisible;
    group.add(shapeHolder, bounds);
    emitter.node.add(group);

    const visual: Visual = { group, shapeLines, shapeMaterial, direction, directionMaterial, bounds, boundsMaterial, signature };
    if (this.excluded) this.register(visual, this.excluded);
    this.visuals.set(emitter.id, visual);
    return visual;
  }

  private paint(emitter: ParticleEmitter, visual: Visual): void {
    const selected = this.selectedId === emitter.id;
    const color = !emitter.enabled ? COLOR_DISABLED : selected ? COLOR_SELECTED : COLOR_SHAPE;
    visual.shapeMaterial.color.setHex(color);
    visual.shapeMaterial.opacity = emitter.enabled ? (selected ? 1 : 0.65) : 0.3;
    visual.shapeLines.visible = this.showShapes;
    visual.direction.visible = this.showDirection && emitter.enabled;
    visual.directionMaterial.opacity = selected ? 1 : 0.6;
    visual.group.visible = this.editorVisible;

    visual.bounds.visible = this.showBounds && emitter.activeParticles > 0;
    if (visual.bounds.visible) {
      const sphere = emitter.bounds;
      // The bounds box is drawn in the emitter's own space, so a
      // world-space emitter (whose particles are already in world coords)
      // needs the emitter transform undone or the box lands twice-
      // transformed.
      if (emitter.settings.main.simulationSpace === "world") {
        emitter.node.updateWorldMatrix(true, false);
        // Module-level scratch, not a fresh Matrix4 — this runs once per
        // emitter per editor frame.
        boundsInverse.copy(emitter.node.matrixWorld).invert();
        boundsScratch.copy(sphere.center).applyMatrix4(boundsInverse);
        visual.bounds.position.copy(boundsScratch);
      } else {
        visual.bounds.position.copy(sphere.center);
      }
      const size = Math.max(0.01, sphere.radius * 2);
      visual.bounds.scale.setScalar(size);
    }
  }

  private register(visual: Visual, sink: Set<THREE.Object3D>): void {
    sink.add(visual.group);
    sink.add(visual.shapeLines);
    sink.add(visual.direction);
    sink.add(visual.bounds);
    if (visual.shapeLines.parent) sink.add(visual.shapeLines.parent);
  }

  private unregister(visual: Visual, sink: Set<THREE.Object3D>): void {
    sink.delete(visual.group);
    sink.delete(visual.shapeLines);
    sink.delete(visual.direction);
    sink.delete(visual.bounds);
    if (visual.shapeLines.parent) sink.delete(visual.shapeLines.parent);
  }

  private destroyVisual(id: string, visual: Visual): void {
    visual.group.removeFromParent();
    if (this.excluded) this.unregister(visual, this.excluded);
    visual.shapeLines.geometry.dispose();
    visual.direction.geometry.dispose();
    visual.bounds.geometry.dispose();
    visual.shapeMaterial.dispose();
    visual.directionMaterial.dispose();
    visual.boundsMaterial.dispose();
    this.visuals.delete(id);
  }
}

/**
 * Wireframe at the shape's own dimensions.
 *
 * Built at true size with no transform applied — the holder group carries
 * the shape's offset and the emitter's node carries the rest, which is
 * what keeps the drawing and the sampling math reading the same numbers.
 */
function shapeGeometryFor(shape: ShapeModule): THREE.BufferGeometry {
  if (shape.kind === "box") {
    const box = new THREE.BoxGeometry(shape.boxSize[0], shape.boxSize[1], shape.boxSize[2]);
    const edges = new THREE.EdgesGeometry(box, 20);
    box.dispose();
    return edges;
  }
  if (shape.kind === "sphere") {
    // Deliberately coarse: EdgesGeometry emits nothing useful for a
    // sphere (every adjacent face is near-coplanar), and a fine wireframe
    // reads as a solid blob at distance. Same reasoning ColliderVisuals
    // gives for its own coarse copies.
    const sphere = new THREE.SphereGeometry(shape.radius, 16, 10);
    const wire = new THREE.WireframeGeometry(sphere);
    sphere.dispose();
    return wire;
  }
  // Cone: drawn as the real emission silhouette — the base disc at
  // `radius`, opening to `radius + tan(angle) * height` at the top, so
  // what's drawn is what sampleCone actually fills.
  const height = Math.max(shape.coneHeight, 0.5);
  const topRadius = shape.radius + Math.tan(shape.coneAngle * THREE.MathUtils.DEG2RAD) * height;
  const cone = new THREE.CylinderGeometry(topRadius, shape.radius, height, 20, 1, true);
  cone.translate(0, height * 0.5, 0); // three centers a cylinder on its own middle; the emitter's origin is the cone's base
  const wire = new THREE.WireframeGeometry(cone);
  cone.dispose();
  return wire;
}

/** A short arrow along +Y — the axis every shape emits about (see ParticleShapes' own note on why +Y). */
function directionGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0, 0, 1, 0, -0.12, 0.78, 0, 0, 1, 0, 0.12, 0.78, 0], 3)
  );
  return geometry;
}

function signatureFor(emitter: ParticleEmitter): string {
  const s = emitter.settings.shape;
  if (s.kind === "box") return `b:${s.boxSize[0]}:${s.boxSize[1]}:${s.boxSize[2]}:${s.position.join(",")}:${s.rotation.join(",")}:${s.scale.join(",")}`;
  if (s.kind === "sphere") return `s:${s.radius}:${s.position.join(",")}:${s.rotation.join(",")}:${s.scale.join(",")}`;
  return `c:${s.radius}:${s.coneAngle}:${s.coneHeight}:${s.position.join(",")}:${s.rotation.join(",")}:${s.scale.join(",")}`;
}
