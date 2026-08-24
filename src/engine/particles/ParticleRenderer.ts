import * as THREE from "three";
import type { ParticleBuffer } from "./ParticleBuffer";
import type { RendererModule, TextureSheetModule, ParticleSortMode } from "./ParticleTypes";
import { createParticleMaterial, getDefaultParticleTexture, modeNeedsVelocity, needsMaterialRebuild, setFlipbook } from "./ParticleMaterial";

/**
 * Turns a ParticleBuffer into one draw call.
 *
 * Owns the `InstancedBufferGeometry`, the per-instance attributes, the
 * material, and the `THREE.Mesh` that carries them — and nothing else. It
 * never simulates: `sync()` reads the buffer and writes GPU attributes, and
 * that's the entire contract. Keeping the simulation and rendering layers
 * this separate is what allows either to be replaced (a transform-feedback
 * or compute-based simulation later; a trail or ribbon renderer alongside
 * this one) without touching the other.
 *
 * ## Upload strategy
 *
 * Attributes are allocated once at `maxParticles` and marked
 * `setUsage(DynamicDrawUsage)`. Each frame the live range `[0, count)` is
 * written and `updateRanges` is narrowed to exactly that many floats, so a
 * 2000-capacity emitter showing 30 particles uploads 30 particles' worth of
 * data, not 2000. `instanceCount` is set to the live count, so the GPU
 * never processes dead slots either.
 *
 * The buffer's dense packing (see ParticleBuffer) is what makes both of
 * those a straight prefix of the array rather than a scatter — which is the
 * whole reason it packs densely.
 */
export class ParticleRenderer {
  readonly mesh: THREE.Mesh;

  private geometry: THREE.InstancedBufferGeometry;
  private material: THREE.ShaderMaterial;
  private texture: THREE.Texture;
  /** True when `texture` is the shared module-level default, which must never be disposed by an emitter. */
  private usingSharedTexture: boolean;

  private aOffset: THREE.InstancedBufferAttribute;
  private aColor: THREE.InstancedBufferAttribute;
  private aParams: THREE.InstancedBufferAttribute;
  /** Only allocated for velocity-aligned/stretched modes — a plain billboard never pays for it. */
  private aVelocity: THREE.InstancedBufferAttribute | undefined;

  private readonly capacity: number;
  private config: RendererModule;
  private depthTexture: THREE.Texture | undefined;
  /** Base geometry for `mesh` mode — supplied by the host, never owned or disposed here. */
  private meshSource: THREE.BufferGeometry | undefined;

  /** Sort scratch: index + key pairs, reused so sorting allocates nothing per frame. */
  private sortIndices: Uint32Array;
  private sortKeys: Float32Array;
  private readonly cameraLocal = new THREE.Vector3();

  constructor(capacity: number, config: RendererModule, texture?: THREE.Texture, meshSource?: THREE.BufferGeometry) {
    this.capacity = Math.max(1, capacity);
    this.config = { ...config };
    this.meshSource = meshSource;
    this.usingSharedTexture = !texture;
    this.texture = texture ?? getDefaultParticleTexture();

    this.geometry = this.buildGeometry();
    this.aOffset = this.geometry.getAttribute("aOffset") as THREE.InstancedBufferAttribute;
    this.aColor = this.geometry.getAttribute("aColor") as THREE.InstancedBufferAttribute;
    this.aParams = this.geometry.getAttribute("aParams") as THREE.InstancedBufferAttribute;
    this.aVelocity = this.geometry.getAttribute("aVelocity") as THREE.InstancedBufferAttribute | undefined;

    this.material = createParticleMaterial({ renderer: this.config, texture: this.texture });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false; // the geometry's own bounds are a unit quad; real extents live in the instanced offsets, which three can't see. setBounds() below maintains a real sphere instead.
    this.mesh.renderOrder = this.config.renderOrder;
    this.mesh.name = "particles";
    this.mesh.visible = false;

    this.sortIndices = new Uint32Array(this.capacity);
    this.sortKeys = new Float32Array(this.capacity);
  }

  /**
   * Writes the live particles into the GPU attributes.
   *
   * `cameraMatrixWorld` is only consulted for distance sorting; passing it
   * always keeps the call site uniform, and the sort is skipped entirely
   * for `sortMode: "none"` (the default) so nothing is paid for it.
   */
  sync(buffer: ParticleBuffer, cameraMatrixWorld: THREE.Matrix4 | undefined): void {
    const count = Math.min(buffer.count, this.capacity);
    this.geometry.instanceCount = count;
    this.mesh.visible = count > 0;
    if (count === 0) return;

    const order = this.resolveOrder(buffer, count, cameraMatrixWorld);
    const offsets = this.aOffset.array as Float32Array;
    const colors = this.aColor.array as Float32Array;
    const params = this.aParams.array as Float32Array;
    const velocities = this.aVelocity?.array as Float32Array | undefined;

    for (let slot = 0; slot < count; slot++) {
      const i = order ? order[slot] : slot;
      const o3 = slot * 3;
      const c4 = slot * 4;

      offsets[o3] = buffer.posX[i];
      offsets[o3 + 1] = buffer.posY[i];
      offsets[o3 + 2] = buffer.posZ[i];

      colors[c4] = buffer.colR[i];
      colors[c4 + 1] = buffer.colG[i];
      colors[c4 + 2] = buffer.colB[i];
      colors[c4 + 3] = buffer.colA[i];

      const size = buffer.size[i];
      params[c4] = size;
      params[c4 + 1] = size;
      params[c4 + 2] = buffer.rotation[i];
      params[c4 + 3] = buffer.frame[i];

      if (velocities) {
        velocities[o3] = buffer.velX[i];
        velocities[o3 + 1] = buffer.velY[i];
        velocities[o3 + 2] = buffer.velZ[i];
      }
    }

    // Narrow the upload to exactly the live prefix. Without this every
    // frame re-uploads the full maxParticles allocation regardless of how
    // few particles are actually alive, which is the single biggest waste
    // an instanced particle renderer can have.
    markRange(this.aOffset, count * 3);
    markRange(this.aColor, count * 4);
    markRange(this.aParams, count * 4);
    if (this.aVelocity) markRange(this.aVelocity, count * 3);
  }

  /**
   * Recomputes a bounding sphere covering the live particles.
   *
   * The mesh itself stays `frustumCulled = false` — three would otherwise
   * cull against the unit quad the geometry actually declares and make
   * every emitter vanish the moment its origin left the frustum. This
   * sphere exists for the *manager's* own distance/LOD checks and for the
   * Inspector's bounds gizmo, both of which want honest extents.
   *
   * Deliberately not called every frame: it's an O(count) pass with no
   * rendering benefit, so the manager runs it on a slow cadence.
   */
  computeBounds(buffer: ParticleBuffer, out: THREE.Sphere): void {
    const count = buffer.count;
    if (count === 0) {
      out.center.set(0, 0, 0);
      out.radius = 0;
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = buffer.posX[i];
      const y = buffer.posY[i];
      const z = buffer.posZ[i];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    out.center.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;
    out.radius = Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.5;
  }

  /**
   * Applies a changed renderer config.
   *
   * Splits into three tiers on purpose. A uniform write (opacity, pivot,
   * stretch) is free. A material rebuild (blending, depth, render mode) is
   * cheap but drops the compiled program. A *geometry* rebuild is only
   * needed when the instanced attribute set itself changes — which is why
   * the velocity attribute's presence is checked separately rather than
   * folded into the material check.
   */
  applyConfig(next: RendererModule, sheet: TextureSheetModule): void {
    const previous = this.config;
    const hadVelocity = !!this.aVelocity;
    const wantVelocity = modeNeedsVelocity(next.mode);
    const meshModeChanged = (previous.mode === "mesh") !== (next.mode === "mesh");
    this.config = { ...next };

    if (hadVelocity !== wantVelocity || meshModeChanged) {
      this.rebuildGeometry();
    }

    if (needsMaterialRebuild(previous, next, !!this.depthTexture, !!this.depthTexture)) {
      const old = this.material;
      this.material = createParticleMaterial({ renderer: this.config, texture: this.texture, depthTexture: this.depthTexture });
      this.mesh.material = this.material;
      old.dispose();
    }

    this.material.uniforms.uOpacity.value = next.opacity;
    (this.material.uniforms.uPivot.value as THREE.Vector2).set(next.pivot[0], next.pivot[1]);
    this.material.uniforms.uStretch.value = next.stretchFactor;
    this.material.uniforms.uSoftFade.value = next.softFadeDistance;
    this.mesh.renderOrder = next.renderOrder;
    setFlipbook(this.material, sheet.enabled, sheet.tilesX, sheet.tilesY);
  }

  /** Swaps the texture. `undefined` returns to the shared default — and the previous texture is only disposed if this renderer owned it. */
  setTexture(texture: THREE.Texture | undefined): void {
    const next = texture ?? getDefaultParticleTexture();
    if (next === this.texture) return;
    if (!this.usingSharedTexture) this.texture.dispose();
    this.texture = next;
    this.usingSharedTexture = !texture;
    this.material.uniforms.uMap.value = next;
  }

  /** Supplies the base geometry for `mesh` mode. Never disposed here — it belongs to whatever loaded the GLB. */
  setMeshSource(geometry: THREE.BufferGeometry | undefined): void {
    if (this.meshSource === geometry) return;
    this.meshSource = geometry;
    if (this.config.mode === "mesh") this.rebuildGeometry();
  }

  /** Wires (or clears) the scene depth texture soft particles need. Rebuilds the material, since it's a compiled-in define. */
  setDepthTexture(depth: THREE.Texture | undefined, near: number, far: number): void {
    const changed = (!!this.depthTexture) !== (!!depth);
    this.depthTexture = depth;
    if (changed && this.config.softParticles) {
      const old = this.material;
      this.material = createParticleMaterial({ renderer: this.config, texture: this.texture, depthTexture: depth, near, far });
      this.mesh.material = this.material;
      old.dispose();
    } else {
      this.material.uniforms.uDepth.value = depth ?? null;
      this.material.uniforms.uNear.value = near;
      this.material.uniforms.uFar.value = far;
    }
  }

  get drawCalls(): number {
    return this.mesh.visible ? 1 : 0;
  }

  /** Bytes held by the instanced attributes, for the Inspector's memory readout. */
  byteLength(): number {
    return this.capacity * (3 + 4 + 4 + (this.aVelocity ? 3 : 0)) * 4;
  }

  /** Releases every GPU resource this renderer owns. The shared default texture and any host-owned mesh geometry are deliberately left alone. */
  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    if (!this.usingSharedTexture) this.texture.dispose();
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private buildGeometry(): THREE.InstancedBufferGeometry {
    const geometry = new THREE.InstancedBufferGeometry();
    const source = this.config.mode === "mesh" && this.meshSource ? this.meshSource : undefined;

    if (source) {
      // Copy the source's own vertex streams rather than referencing it —
      // an InstancedBufferGeometry that shared attribute objects with a
      // scene mesh would have its own dispose() free geometry the scene is
      // still drawing.
      const position = source.getAttribute("position");
      const uv = source.getAttribute("uv");
      if (position) geometry.setAttribute("position", position.clone());
      if (uv) geometry.setAttribute("uv", uv.clone());
      if (source.index) geometry.setIndex(source.index.clone());
    } else {
      // A unit quad centered on the origin. The shader treats position.xy
      // as the corner in the particle's own space, so this never changes.
      geometry.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      geometry.setIndex([0, 1, 2, 0, 2, 3]);
    }

    const n = this.capacity;
    geometry.setAttribute("aOffset", dynamicInstanced(n, 3));
    geometry.setAttribute("aColor", dynamicInstanced(n, 4));
    geometry.setAttribute("aParams", dynamicInstanced(n, 4));
    if (modeNeedsVelocity(this.config.mode)) geometry.setAttribute("aVelocity", dynamicInstanced(n, 3));
    geometry.instanceCount = 0;
    // Nonzero so three never tries to compute one from the instanced
    // attributes (which it can't interpret) — real culling is the
    // manager's job, off computeBounds().
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    return geometry;
  }

  private rebuildGeometry(): void {
    const old = this.geometry;
    this.geometry = this.buildGeometry();
    this.aOffset = this.geometry.getAttribute("aOffset") as THREE.InstancedBufferAttribute;
    this.aColor = this.geometry.getAttribute("aColor") as THREE.InstancedBufferAttribute;
    this.aParams = this.geometry.getAttribute("aParams") as THREE.InstancedBufferAttribute;
    this.aVelocity = this.geometry.getAttribute("aVelocity") as THREE.InstancedBufferAttribute | undefined;
    this.mesh.geometry = this.geometry;
    old.dispose();
  }

  /**
   * The order to upload particles in, or `undefined` for "as stored".
   *
   * Sorting is genuinely optional and off by default: for additive
   * blending — which is most of what a playable's effects use — draw order
   * is mathematically irrelevant, so the sort would be pure cost. It earns
   * its keep only for alpha-blended, depth-written smoke, which is exactly
   * when `byDistance` should be turned on.
   */
  private resolveOrder(buffer: ParticleBuffer, count: number, cameraMatrixWorld: THREE.Matrix4 | undefined): Uint32Array | undefined {
    const mode: ParticleSortMode = this.config.sortMode;
    if (mode === "none") return undefined;

    const indices = this.sortIndices;
    const keys = this.sortKeys;
    for (let i = 0; i < count; i++) indices[i] = i;

    if (mode === "byDistance" && cameraMatrixWorld) {
      this.cameraLocal.setFromMatrixPosition(cameraMatrixWorld);
      // Squared distance — the ordering is identical and the sqrt isn't.
      for (let i = 0; i < count; i++) {
        const dx = buffer.posX[i] - this.cameraLocal.x;
        const dy = buffer.posY[i] - this.cameraLocal.y;
        const dz = buffer.posZ[i] - this.cameraLocal.z;
        keys[i] = -(dx * dx + dy * dy + dz * dz); // far first, so nearer particles draw over them
      }
    } else if (mode === "oldestFirst") {
      for (let i = 0; i < count; i++) keys[i] = -buffer.age[i];
    } else if (mode === "youngestFirst") {
      for (let i = 0; i < count; i++) keys[i] = buffer.age[i];
    } else {
      return undefined;
    }

    // Insertion sort over the index array. Same reasoning as
    // ColliderManager's broad phase: particle order is near-sorted frame to
    // frame (they move a little, they don't teleport), which is the case
    // insertion sort is linear on and a comparison sort isn't — and it
    // allocates nothing, unlike Array.prototype.sort on a boxed array.
    //
    // Bounded by `count` directly rather than through a subarray() view:
    // subarray allocates a new TypedArray object on every call, which is a
    // per-frame allocation in the one path that exists to avoid them.
    for (let i = 1; i < count; i++) {
      const current = indices[i];
      const key = keys[current];
      let j = i - 1;
      while (j >= 0 && keys[indices[j]] > key) {
        indices[j + 1] = indices[j];
        j--;
      }
      indices[j + 1] = current;
    }
    return indices;
  }
}

function dynamicInstanced(count: number, itemSize: number): THREE.InstancedBufferAttribute {
  const attribute = new THREE.InstancedBufferAttribute(new Float32Array(count * itemSize), itemSize);
  attribute.setUsage(THREE.DynamicDrawUsage);
  return attribute;
}

/**
 * Marks only the live prefix of an attribute for upload.
 *
 * three.js renamed `updateRange` to the `updateRanges` array in r159; both
 * spellings are handled so this keeps working across the version range
 * this engine might be pinned to, rather than silently uploading nothing
 * (new API absent) or everything (old API absent) after a three bump.
 */
function markRange(attribute: THREE.BufferAttribute, length: number): void {
  const anyAttr = attribute as unknown as {
    updateRanges?: { start: number; count: number }[];
    updateRange?: { offset: number; count: number };
    clearUpdateRanges?: () => void;
  };
  if (anyAttr.updateRanges) {
    anyAttr.clearUpdateRanges?.();
    anyAttr.updateRanges.push({ start: 0, count: length });
  } else if (anyAttr.updateRange) {
    anyAttr.updateRange.offset = 0;
    anyAttr.updateRange.count = length;
  }
  attribute.needsUpdate = true;
}
