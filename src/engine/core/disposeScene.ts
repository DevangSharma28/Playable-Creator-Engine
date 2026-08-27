import * as THREE from "three";

/**
 * Releasing GPU memory held by a scene graph.
 *
 * three.js allocates GPU resources lazily on first render and frees them only
 * when something calls `.dispose()` on the owning geometry, material or
 * texture. `WebGLRenderer.dispose()` releases the renderer's *own* state — its
 * programs, its render targets — and deliberately not the scene's, because a
 * renderer has no way of knowing whether the geometry it just drew is also
 * being drawn by something else.
 *
 * Nothing was calling these, which was measurable rather than theoretical: a
 * game booted four times into the same canvas (what a dev in-place hot reload
 * does on every save, and what the Engine Room does when a project is
 * reloaded) held four full sets of textures, buffers and programs, because
 * each teardown dropped its references without ever telling the driver. See
 * tests/runtime-lifecycle.test.mjs, which asserts the count goes back down.
 *
 * Everything here is idempotent — three.js's own `dispose()` is a no-op the
 * second time — so disposing an object twice, or disposing a material two
 * meshes share, is safe.
 */

/** Every texture-valued property a standard material can carry. */
const TEXTURE_SLOTS = [
  "map", "lightMap", "aoMap", "emissiveMap", "bumpMap", "normalMap",
  "displacementMap", "roughnessMap", "metalnessMap", "alphaMap",
  "envMap", "specularMap", "gradientMap", "matcap",
  "clearcoatMap", "clearcoatNormalMap", "clearcoatRoughnessMap",
  "iridescenceMap", "iridescenceThicknessMap", "sheenColorMap",
  "sheenRoughnessMap", "transmissionMap", "thicknessMap", "specularIntensityMap",
  "specularColorMap", "anisotropyMap",
] as const;

/**
 * Disposes a material and every texture it references.
 *
 * `disposeTextures` is off for the shared case: two materials produced by the
 * same glTF routinely point at one texture, so a caller retiring a single
 * mesh must not free an image the rest of the model is still drawing with.
 * The whole-scene path below turns it on, because there nothing survives.
 */
export function disposeMaterial(material: THREE.Material, disposeTextures = false): void {
  if (disposeTextures) {
    const record = material as unknown as Record<string, unknown>;
    for (const slot of TEXTURE_SLOTS) {
      const texture = record[slot];
      if (texture instanceof THREE.Texture) texture.dispose();
    }
    // Custom ShaderMaterial uniforms — the particle system's own materials
    // carry their textures here rather than in a named slot.
    const uniforms = (material as THREE.ShaderMaterial).uniforms;
    if (uniforms) {
      for (const uniform of Object.values(uniforms)) {
        if (uniform?.value instanceof THREE.Texture) uniform.value.dispose();
      }
    }
  }
  material.dispose();
}

/**
 * Disposes the geometry and materials of one object and everything under it.
 *
 * Does *not* detach it from its parent — callers differ on whether they want
 * that, and doing it here would silently mutate a hierarchy mid-traversal.
 */
export function disposeObject3D(root: THREE.Object3D, disposeTextures = false): void {
  root.traverse((node) => {
    const mesh = node as Partial<THREE.Mesh> & THREE.Object3D;
    mesh.geometry?.dispose?.();
    const material = mesh.material;
    if (Array.isArray(material)) for (const entry of material) disposeMaterial(entry, disposeTextures);
    else if (material) disposeMaterial(material, disposeTextures);
  });
}

/**
 * Full teardown of a scene: every geometry, material and texture under it,
 * plus the scene's own background/environment maps.
 *
 * Textures are freed here — unlike the single-object path — because the whole
 * graph is being retired at once, so there is nothing left that could still
 * be sharing one.
 */
export function disposeScene(scene: THREE.Scene): void {
  disposeObject3D(scene, true);
  if (scene.background instanceof THREE.Texture) scene.background.dispose();
  if (scene.environment instanceof THREE.Texture) scene.environment.dispose();
  scene.background = null;
  scene.environment = null;
  scene.clear();
}
