import * as THREE from "three";
import { SceneNode } from "./node";

/**
 * Something in the world that has no behaviour of its own — a crate, a coin,
 * a wall, a tree, anything the ION editor placed.
 *
 * This is what every `ION.scene.*` call hands back. `Entity` is its sibling:
 * use an `Entity` when the thing needs its own `update()`, a `Prop` when it
 * just needs to be somewhere and look like something. Both speak the same
 * vocabulary (see `SceneNode`), so moving from one to the other is a change of
 * declaration, not a rewrite.
 *
 * ```ts
 * const coin = ION.scene.box({ color: "yellow", size: 0.6, y: 0.3 });
 * coin.spin(120);                     // degrees per second
 * ION.after(3, () => coin.destroy()); // frees its geometry and material
 * ```
 *
 * ## Why this exists rather than returning the three.js mesh
 *
 * `ION.scene.box()` used to hand back a raw `THREE.Mesh`, which meant the API
 * was Three-free right up until you used the thing it gave you. The starter
 * template made the problem plain in the first file anyone opens:
 *
 * ```ts
 * const coin = ION.scene.find(`Coin${i}`);
 * if (coin) coin.rotation.y += dt * 2;   // radians, and a per-frame lookup
 * ```
 *
 * — three.js units, three.js lifecycle, and no way to free the thing without
 * knowing that `removeFromParent()` alone leaks GPU memory. See `SceneNode`'s
 * own doc comment for the three specific traps.
 */
export class Prop extends SceneNode {
  private destroyed = false;

  /**
   * Wraps an object already in the scene. `ION.scene.*` and `ION.scene.find()`
   * are the ways to get one — construct this directly only if you built the
   * `Object3D` yourself.
   */
  constructor(readonly object3D: THREE.Object3D) {
    super();
  }

  /**
   * The prop's colour. Accepts what every other ION colour accepts: a name
   * (`"orange"`), `"#e8961e"`, or `0xe8961e`.
   *
   * Applied to every mesh underneath, so it works on a whole loaded model and
   * not only on a single shape. Reading it gives back the first material's
   * colour as a `#rrggbb` string, or `undefined` for something with no
   * material at all (an empty group, a light).
   */
  get color(): string | undefined {
    const material = this.firstMaterial();
    return material ? `#${material.color.getHexString()}` : undefined;
  }
  set color(value: string | number | undefined) {
    if (value === undefined) return;
    // Imported lazily through the shared helper on `ion.ts` would be circular,
    // so the conversion lives there and is handed in — see `setPropColor`.
    setColorOn(this.object3D, value);
  }

  /**
   * 0 is invisible, 1 is solid.
   *
   * Sets `transparent` alongside it, because a three.js material with
   * `opacity: 0.5` and `transparent: false` renders fully opaque — a
   * long-standing first-hour surprise that has nothing to teach anyone.
   */
  get opacity(): number {
    return this.firstMaterial()?.opacity ?? 1;
  }
  set opacity(value: number) {
    this.eachMaterial((material) => {
      material.opacity = value;
      material.transparent = value < 1;
    });
  }

  /**
   * Take it out of the world and give back its GPU memory. Safe to call twice.
   *
   * Geometry and material are freed only for shapes ION built (see
   * `ION_OWNED`). A model instantiated from the asset manifest shares both
   * with every other clone of that GLB, so freeing one would blank the rest.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.releaseSceneResources();
    this.object3D.clear();
    unregisterProp(this.object3D);
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  private firstMaterial(): THREE.MeshStandardMaterial | undefined {
    let found: THREE.MeshStandardMaterial | undefined;
    this.eachMaterial((material) => {
      found ??= material;
    });
    return found;
  }

  private eachMaterial(fn: (material: THREE.MeshStandardMaterial) => void): void {
    this.object3D.traverse((node) => {
      const material = (node as THREE.Mesh).material;
      if (!material) return;
      for (const entry of Array.isArray(material) ? material : [material]) {
        fn(entry as THREE.MeshStandardMaterial);
      }
    });
  }
}

/**
 * One `Prop` per `Object3D`, for the life of that object.
 *
 * `ION.scene.find("Coin")` called twice must give back the same handle, or
 * `a === b` is false for one object and a `spin()` started through one handle
 * is invisible to the other. A `WeakMap` because the scene owns the objects:
 * when one is dropped, its handle goes with it and nothing has to remember to
 * clean up this table.
 */
const props = new WeakMap<THREE.Object3D, Prop>();

/** The handle for this object, creating it on first ask. */
export function propFor(object: THREE.Object3D): Prop {
  const existing = props.get(object);
  if (existing) return existing;
  const prop = new Prop(object);
  props.set(object, prop);
  return prop;
}

function unregisterProp(object: THREE.Object3D): void {
  props.delete(object);
}

/**
 * Colour conversion, injected rather than imported.
 *
 * `ion.ts` owns the name/hex/number parsing (it is the same table
 * `ION.scene.box({ color })` uses, and there must be exactly one), and it
 * imports this module to build props — so importing it back would be a cycle.
 */
let setColorOn: (object: THREE.Object3D, value: string | number) => void = () => {};

/** @internal — called once by ion.ts at module load. */
export function installPropColorSetter(fn: (object: THREE.Object3D, value: string | number) => void): void {
  setColorOn = fn;
}
