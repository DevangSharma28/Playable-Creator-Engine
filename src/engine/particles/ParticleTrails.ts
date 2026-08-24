import * as THREE from "three";
import type { ParticleBuffer } from "./ParticleBuffer";
import type { TrailModule } from "./ParticleTypes";

/**
 * Pooled ribbon trails.
 *
 * ## Why this is opt-in and pooled
 *
 * A trail costs far more than the particle that owns it — a 32-point trail
 * is 64 vertices against the particle's own 4. Making every particle
 * trail-capable would multiply the whole system's memory by an order of
 * magnitude for a feature most effects never turn on. So the pool is sized
 * from `ratio * maxParticles`, allocated only when the module is enabled,
 * and the module object isn't even constructed otherwise (see
 * ParticleEmitter's constructor) — "trails can be disabled completely so
 * simple effects have zero trail overhead" is therefore literally true:
 * with `enabled: false` there is no geometry, no material, no pool, and no
 * per-frame call.
 *
 * ## Ribbon, not GL lines
 *
 * `THREE.Line` looks like the cheap answer and can't do the job:
 * `linewidth` is hardcoded to 1 on every major WebGL implementation, so
 * `widthStart`/`widthEnd` would silently do nothing. This builds a real
 * camera-facing ribbon instead — two vertices per trail point, expanded in
 * view space by the vertex shader along the segment normal, which gives
 * genuine width control and correct facing for the same one draw call.
 *
 * ## One draw call regardless of trail count
 *
 * The whole pool is one geometry with a fully preallocated index buffer.
 * Unused trail slots and unused points within a slot are collapsed to
 * zero-width degenerate triangles rather than being excluded from the
 * index — a degenerate triangle is discarded at setup cost on the GPU,
 * whereas rebuilding the index per frame would be a full re-upload and
 * per-trail draw ranges would be one draw call each.
 */

const VERTEX_SHADER = /* glsl */ `
precision highp float;

attribute float aSide;
attribute vec3 aDir;
attribute float aWidth;
attribute vec4 aColor;

varying vec4 vColor;

void main() {
  vColor = aColor;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vec3 dirView = (modelViewMatrix * vec4(aDir, 0.0)).xyz;
  vec2 d = dirView.xy;
  float len = length(d);
  // A segment pointing straight at the camera projects to nothing;
  // normalizing it would be NaN and would drop the whole ribbon rather
  // than just that segment.
  vec2 n = len > 1e-5 ? vec2(d.y, -d.x) / len : vec2(1.0, 0.0);
  mvPosition.xy += n * aSide * aWidth * 0.5;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
varying vec4 vColor;
void main() {
  if (vColor.a < 0.003) discard;
  gl_FragColor = vColor;
}
`;

interface TrailSlot {
  /** Which particle owns this trail, by its never-reused birth id — a slot index can't identify a particle, because swap-remove reuses slots constantly. */
  birthId: number;
  /** Points held, oldest first. */
  count: number;
  /** Frame stamp for the mark-and-sweep that detects an owner that died. */
  lastSeen: number;
  /** True once the owner is gone: the trail stops growing and fades out rather than vanishing on the frame the particle died. */
  orphaned: boolean;
}

export class ParticleTrails {
  readonly mesh: THREE.Mesh;

  private config: TrailModule;
  private readonly maxTrails: number;
  private readonly maxPoints: number;

  /** Per-slot point positions: slot * maxPoints * 3. */
  private readonly pointPos: Float32Array;
  /** Per-slot point ages, in seconds since the point was recorded. */
  private readonly pointAge: Float32Array;
  /**
   * Per-*trail* RGB, refreshed from the owning particle each frame when
   * `inheritParticleColor` is on.
   *
   * Per trail rather than per point: storing a colour on every point would
   * cost three more floats per point for a gradient along the ribbon that
   * is, in practice, invisible at trail lengths anyone uses. The whole
   * trail tracking the particle's current colour is what the option
   * actually means to a designer.
   */
  private readonly slotColor: Float32Array;
  private readonly slots: TrailSlot[];
  /** birthId -> slot index. A Map because birth ids are unbounded and sparse; it only ever holds `maxTrails` entries. */
  private readonly slotByBirth = new Map<number, number>();
  private readonly freeSlots: number[] = [];

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly aPosition: THREE.BufferAttribute;
  private readonly aSide: THREE.BufferAttribute;
  private readonly aDir: THREE.BufferAttribute;
  private readonly aWidth: THREE.BufferAttribute;
  private readonly aColor: THREE.BufferAttribute;

  private frameStamp = 0;
  private visible = true;

  constructor(config: TrailModule, maxParticles: number) {
    this.config = { ...config };
    this.maxPoints = Math.max(2, Math.floor(config.maxPoints));
    this.maxTrails = Math.max(1, Math.min(maxParticles, Math.ceil(maxParticles * Math.max(0.01, config.ratio))));

    this.pointPos = new Float32Array(this.maxTrails * this.maxPoints * 3);
    this.pointAge = new Float32Array(this.maxTrails * this.maxPoints);
    this.slotColor = new Float32Array(this.maxTrails * 3);
    this.slots = [];
    for (let i = 0; i < this.maxTrails; i++) {
      this.slots.push({ birthId: -1, count: 0, lastSeen: -1, orphaned: false });
      this.freeSlots.push(i);
    }

    const vertexCount = this.maxTrails * this.maxPoints * 2;
    this.geometry = new THREE.BufferGeometry();
    this.aPosition = dynamic(vertexCount, 3);
    this.aSide = dynamic(vertexCount, 1);
    this.aDir = dynamic(vertexCount, 3);
    this.aWidth = dynamic(vertexCount, 1);
    this.aColor = dynamic(vertexCount, 4);
    this.geometry.setAttribute("position", this.aPosition);
    this.geometry.setAttribute("aSide", this.aSide);
    this.geometry.setAttribute("aDir", this.aDir);
    this.geometry.setAttribute("aWidth", this.aWidth);
    this.geometry.setAttribute("aColor", this.aColor);

    // Static index for every possible quad. Built once — see the class doc
    // for why unused ones are degenerated rather than excluded.
    const segments = this.maxPoints - 1;
    const indices = new Uint32Array(this.maxTrails * segments * 6);
    let w = 0;
    for (let t = 0; t < this.maxTrails; t++) {
      const base = t * this.maxPoints * 2;
      for (let s = 0; s < segments; s++) {
        const a = base + s * 2;
        indices[w++] = a;
        indices[w++] = a + 1;
        indices[w++] = a + 2;
        indices[w++] = a + 1;
        indices[w++] = a + 3;
        indices[w++] = a + 2;
      }
    }
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    // Side arrays are constant per vertex — written once here, never again.
    const sides = this.aSide.array as Float32Array;
    for (let v = 0; v < vertexCount; v++) sides[v] = v % 2 === 0 ? -1 : 1;
    this.aSide.needsUpdate = true;

    this.material = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.material.name = "ion-particle-trail";

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = "particle trails";
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  }

  setConfig(config: TrailModule): void {
    this.config = { ...config };
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.mesh.visible = visible;
  }

  get drawCalls(): number {
    return this.mesh.visible ? 1 : 0;
  }

  /**
   * Records new points and ages old ones.
   *
   * Runs the mark half of a mark-and-sweep: every live particle that owns
   * a trail stamps its slot with the current frame, and any slot that
   * wasn't stamped is orphaned in the sweep below. That's what detects "the
   * particle that owned this trail died" without a per-particle death
   * callback or an allocation-heavy set intersection every frame.
   */
  update(buffer: ParticleBuffer, dt: number): void {
    if (!this.visible) return;
    this.frameStamp++;
    const ratio = this.config.ratio;
    const minDistSq = this.config.minVertexDistance * this.config.minVertexDistance;

    for (let i = 0; i < buffer.count; i++) {
      // rand3 is fixed at birth, so whether a given particle trails is
      // stable for its whole life rather than flickering frame to frame.
      if (buffer.rand3[i] >= ratio) continue;
      const birthId = buffer.birthId[i];
      let slot = this.slotByBirth.get(birthId);
      if (slot === undefined) {
        slot = this.acquire(birthId);
        if (slot === undefined) continue; // pool exhausted — this particle simply doesn't trail
      }
      const record = this.slots[slot];
      record.lastSeen = this.frameStamp;

      if (this.config.inheritParticleColor) {
        // Tracked live rather than captured at birth, so a trail follows
        // its particle through a Color-over-Lifetime ramp instead of
        // staying whatever colour the particle started as.
        const c3 = slot * 3;
        this.slotColor[c3] = buffer.colR[i];
        this.slotColor[c3 + 1] = buffer.colG[i];
        this.slotColor[c3 + 2] = buffer.colB[i];
      }

      const base = slot * this.maxPoints * 3;
      const x = buffer.posX[i];
      const y = buffer.posY[i];
      const z = buffer.posZ[i];

      if (record.count === 0) {
        this.pushPoint(slot, record, x, y, z);
      } else {
        const last = base + (record.count - 1) * 3;
        const dx = x - this.pointPos[last];
        const dy = y - this.pointPos[last + 1];
        const dz = z - this.pointPos[last + 2];
        if (dx * dx + dy * dy + dz * dz >= minDistSq) {
          this.pushPoint(slot, record, x, y, z);
        } else {
          // Below the distance threshold: keep the newest point glued to
          // the particle rather than leaving a visible gap between the
          // particle and the head of its own trail.
          this.pointPos[last] = x;
          this.pointPos[last + 1] = y;
          this.pointPos[last + 2] = z;
        }
      }
    }

    this.sweep(dt);
  }

  /** Writes the ribbon vertices. Split from update() for the same reason the particle renderer's sync is: simulate everything, then upload everything. */
  sync(): void {
    if (!this.visible) return;
    const positions = this.aPosition.array as Float32Array;
    const dirs = this.aDir.array as Float32Array;
    const widths = this.aWidth.array as Float32Array;
    const colors = this.aColor.array as Float32Array;
    const lifetime = Math.max(1e-3, this.config.lifetime);
    const inherit = this.config.inheritParticleColor;
    const [flatR, flatG, flatB] = this.config.color;

    for (let t = 0; t < this.maxTrails; t++) {
      const record = this.slots[t];
      const pBase = t * this.maxPoints * 3;
      const vBase = t * this.maxPoints * 2;
      const c3 = t * 3;
      const cr = inherit ? this.slotColor[c3] : flatR;
      const cg = inherit ? this.slotColor[c3 + 1] : flatG;
      const cb = inherit ? this.slotColor[c3 + 2] : flatB;

      for (let p = 0; p < this.maxPoints; p++) {
        const v0 = (vBase + p * 2) * 3;
        const v1 = v0 + 3;
        const w0 = vBase + p * 2;
        const c0 = w0 * 4;

        if (p >= record.count) {
          // Degenerate: zero width collapses the quad to a line with no
          // area, which the rasterizer drops.
          widths[w0] = 0;
          widths[w0 + 1] = 0;
          colors[c0 + 3] = 0;
          colors[c0 + 7] = 0;
          continue;
        }

        const src = pBase + p * 3;
        const px = this.pointPos[src];
        const py = this.pointPos[src + 1];
        const pz = this.pointPos[src + 2];
        positions[v0] = px;
        positions[v0 + 1] = py;
        positions[v0 + 2] = pz;
        positions[v1] = px;
        positions[v1 + 1] = py;
        positions[v1 + 2] = pz;

        // Direction toward the next point (or from the previous one for
        // the very last), which is what the shader expands perpendicular
        // to.
        const nextIndex = p < record.count - 1 ? src + 3 : src - 3;
        const sign = p < record.count - 1 ? 1 : -1;
        let dx = 0;
        let dy = 1;
        let dz = 0;
        if (record.count > 1) {
          dx = (this.pointPos[nextIndex] - px) * sign;
          dy = (this.pointPos[nextIndex + 1] - py) * sign;
          dz = (this.pointPos[nextIndex + 2] - pz) * sign;
        }
        dirs[v0] = dx;
        dirs[v0 + 1] = dy;
        dirs[v0 + 2] = dz;
        dirs[v1] = dx;
        dirs[v1 + 1] = dy;
        dirs[v1 + 2] = dz;

        // Head of the trail is `widthStart`, tail is `widthEnd`. Points
        // are stored oldest-first, so the newest (index count-1) is the
        // head.
        const along = record.count > 1 ? 1 - p / (record.count - 1) : 0;
        const width = this.config.widthEnd + (this.config.widthStart - this.config.widthEnd) * (1 - along);
        widths[w0] = width;
        widths[w0 + 1] = width;

        const alpha = Math.max(0, 1 - this.pointAge[t * this.maxPoints + p] / lifetime);
        colors[c0] = cr;
        colors[c0 + 1] = cg;
        colors[c0 + 2] = cb;
        colors[c0 + 3] = alpha;
        colors[c0 + 4] = cr;
        colors[c0 + 5] = cg;
        colors[c0 + 6] = cb;
        colors[c0 + 7] = alpha;
      }
    }

    this.aPosition.needsUpdate = true;
    this.aDir.needsUpdate = true;
    this.aWidth.needsUpdate = true;
    this.aColor.needsUpdate = true;
  }

  clear(): void {
    for (let i = 0; i < this.slots.length; i++) {
      this.slots[i].birthId = -1;
      this.slots[i].count = 0;
      this.slots[i].orphaned = false;
      this.slots[i].lastSeen = -1;
    }
    this.slotByBirth.clear();
    this.freeSlots.length = 0;
    for (let i = 0; i < this.maxTrails; i++) this.freeSlots.push(i);
  }

  /**
   * Test-only seam (tests/particles.test.mjs) — the slot records.
   *
   * Same convention as ParticleEmitter.__buffer(): asserting that trail
   * points actually expire otherwise needs a GL context to read back, and
   * the assertion isn't about rendering. Additive; nothing else calls it.
   */
  __slots(): readonly { birthId: number; count: number; orphaned: boolean }[] {
    return this.slots;
  }

  byteLength(): number {
    return (
      this.pointPos.byteLength +
      this.pointAge.byteLength +
      this.maxTrails * this.maxPoints * 2 * (3 + 1 + 3 + 1 + 4) * 4 +
      this.maxTrails * (this.maxPoints - 1) * 6 * 4
    );
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.slotByBirth.clear();
  }

  // -----------------------------------------------------------------------

  private acquire(birthId: number): number | undefined {
    const slot = this.freeSlots.pop();
    if (slot === undefined) return undefined;
    const record = this.slots[slot];
    record.birthId = birthId;
    record.count = 0;
    record.orphaned = false;
    record.lastSeen = this.frameStamp;
    this.slotByBirth.set(birthId, slot);
    return slot;
  }

  private release(slot: number): void {
    const record = this.slots[slot];
    if (record.birthId >= 0) this.slotByBirth.delete(record.birthId);
    record.birthId = -1;
    record.count = 0;
    record.orphaned = false;
    this.freeSlots.push(slot);
  }

  private pushPoint(slot: number, record: TrailSlot, x: number, y: number, z: number): void {
    const base = slot * this.maxPoints * 3;
    const ageBase = slot * this.maxPoints;
    if (record.count >= this.maxPoints) {
      // Full: drop the oldest by shifting everything down one point.
      // copyWithin is a memmove, so this is cheap even at the 64-point
      // ceiling — and it keeps points stored oldest-first, which is what
      // makes sync()'s width/alpha ramp a straight index walk.
      this.pointPos.copyWithin(base, base + 3, base + this.maxPoints * 3);
      this.pointAge.copyWithin(ageBase, ageBase + 1, ageBase + this.maxPoints);
      record.count = this.maxPoints - 1;
    }
    const at = base + record.count * 3;
    this.pointPos[at] = x;
    this.pointPos[at + 1] = y;
    this.pointPos[at + 2] = z;
    this.pointAge[ageBase + record.count] = 0;
    record.count++;
  }

  /** Ages every point, drops expired ones from the tail, and frees slots whose owner died and whose points have all faded. */
  private sweep(dt: number): void {
    const lifetime = Math.max(1e-3, this.config.lifetime);
    for (let t = 0; t < this.maxTrails; t++) {
      const record = this.slots[t];
      if (record.birthId < 0) continue;
      if (record.lastSeen !== this.frameStamp) record.orphaned = true;

      const ageBase = t * this.maxPoints;
      // Two passes, deliberately. Ageing and expiry-counting look like one
      // loop, and folding them into one is wrong: the count can stop at the
      // first surviving point (they're stored oldest-first) but the *ageing*
      // must not. A single loop that breaks on the first survivor left every
      // later point frozen at whatever age it had, so a point only aged once
      // it became the oldest — trails lasted roughly `lifetime x maxPoints`
      // and the alpha ramp below, which reads these ages, was flat for all
      // but one point.
      for (let p = 0; p < record.count; p++) this.pointAge[ageBase + p] += dt;

      let expired = 0;
      while (expired < record.count && this.pointAge[ageBase + expired] >= lifetime) expired++;
      if (expired > 0) {
        const base = t * this.maxPoints * 3;
        this.pointPos.copyWithin(base, base + expired * 3, base + record.count * 3);
        this.pointAge.copyWithin(ageBase, ageBase + expired, ageBase + record.count);
        record.count -= expired;
      }
      if (record.orphaned && record.count === 0) this.release(t);
    }
  }
}

function dynamic(count: number, itemSize: number): THREE.BufferAttribute {
  const attribute = new THREE.BufferAttribute(new Float32Array(count * itemSize), itemSize);
  attribute.setUsage(THREE.DynamicDrawUsage);
  return attribute;
}
