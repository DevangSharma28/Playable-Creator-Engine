import * as THREE from "three";
import type { ParticleBlendMode, ParticleRenderMode, RendererModule } from "./ParticleTypes";

/**
 * The particle shader, its material, and the shared default texture.
 *
 * ## Why a custom shader rather than THREE.Points or Sprite
 *
 * `THREE.Points` looks like the obvious fit and isn't: `gl_PointSize` is
 * capped by the driver (commonly 64-255px, and *silently* — a large soft
 * smoke puff just stops growing), points can't rotate, can't stretch along
 * velocity, and clip against the near plane as whole points rather than
 * fragment by fragment. `THREE.Sprite` fixes the rotation problem but is
 * one `Object3D` and one draw call *per particle*, which is exactly the
 * "don't create an Object3D per particle" failure the whole system exists
 * to avoid.
 *
 * An `InstancedBufferGeometry` of one quad plus per-particle instanced
 * attributes gives one draw call for the whole emitter, arbitrary size,
 * free GPU-side rotation/billboarding/stretching, and a flipbook for the
 * cost of a UV offset. The CPU writes six floats per particle per frame
 * and the GPU does the rest.
 *
 * ## Optional features are real `#define`s
 *
 * Velocity alignment, flipbooks, and soft particles each compile out
 * entirely when off, and their instanced attributes aren't even allocated
 * (see ParticleRenderer). A plain billboard emitter therefore uploads
 * position/color/params and nothing else — the "keep expensive features
 * optional so a simple emitter stays extremely cheap" requirement, enforced
 * by the compiler rather than by a runtime branch.
 */

const VERTEX_SHADER = /* glsl */ `
precision highp float;

// Per-instance. Declared here, supplied by ParticleRenderer's
// InstancedBufferAttributes. The position/uv attributes and the matrix
// uniforms all come from three's own ShaderMaterial injection.
attribute vec3 aOffset;
attribute vec4 aColor;
// x = width, y = height, z = rotation (radians), w = flipbook frame
attribute vec4 aParams;
#ifdef USE_VELOCITY
attribute vec3 aVelocity;
#endif

uniform vec2 uPivot;
#ifdef USE_FLIPBOOK
uniform vec2 uTiles;
#endif
#ifdef USE_STRETCH
uniform float uStretch;
#endif

varying vec4 vColor;
varying vec2 vUv;
#ifdef USE_SOFT
varying vec4 vClipPos;
#endif

void main() {
  vColor = aColor;

// Every branch below declares mvPosition exactly once. An earlier version
// put the mesh path in its own #ifdef block ending in a return, and left
// the billboard path unguarded after it — but the preprocessor only
// removes code inside a *false* branch, so with USE_MESH defined both
// declarations survived into one scope and the shader failed to compile
// with "redefinition of mvPosition". Mesh mode was dead on arrival
// because of it. #else is what actually makes these exclusive.
#ifdef USE_MESH
  // Mesh particles are real geometry, so none of the billboarding applies:
  // scale the source vertex, spin it about its own +Y, translate to the
  // particle's position, and let the normal model-view chain do the rest.
  // Rotation is a single axis on purpose — a full per-particle quaternion
  // would need three more instanced floats for a degree of freedom debris
  // and coins don't visibly use.
  float mc = cos(aParams.z);
  float ms = sin(aParams.z);
  vec3 scaledVertex = position * aParams.x;
  vec3 spun = vec3(
    scaledVertex.x * mc - scaledVertex.z * ms,
    scaledVertex.y,
    scaledVertex.x * ms + scaledVertex.z * mc
  );
  vec4 mvPosition = modelViewMatrix * vec4(aOffset + spun, 1.0);
#else

  // Pivot shifts the quad off center in units of its own size, so a flame
  // can be anchored at its base rather than its middle.
  vec2 corner = position.xy - uPivot;
  vec2 scaled = corner * aParams.xy;

  // The particle's center in view space. Billboarding is "offset in view
  // space, then project" — the view basis is the identity there, so the
  // quad is camera-facing by construction with no per-particle matrix.
  vec4 mvPosition = modelViewMatrix * vec4(aOffset, 1.0);

#ifdef USE_VELOCITY
  // Velocity-aligned: build a 2D basis from the velocity projected into
  // view space, so the quad's local +Y follows the direction of travel on
  // screen. Falls back to the unrotated basis when the velocity projects
  // to nothing (a particle heading straight at the camera), which would
  // otherwise normalize to NaN and drop the whole quad.
  vec3 vView = (modelViewMatrix * vec4(aVelocity, 0.0)).xyz;
  vec2 up = vView.xy;
  float upLen = length(up);
  vec2 dirUp = upLen > 1e-5 ? up / upLen : vec2(0.0, 1.0);
  vec2 dirRight = vec2(dirUp.y, -dirUp.x);
  #ifdef USE_STRETCH
    // Length grows with speed. Uses the full 3D speed, not the projected
    // length, so a spark doesn't visibly shorten just because it turned
    // toward the camera.
    scaled.y *= 1.0 + length(vView) * uStretch;
  #endif
  mvPosition.xy += dirRight * scaled.x + dirUp * scaled.y;
#else
  // Plain billboard with per-particle roll.
  float c = cos(aParams.z);
  float s = sin(aParams.z);
  mvPosition.xy += vec2(scaled.x * c - scaled.y * s, scaled.x * s + scaled.y * c);
#endif

#endif

  gl_Position = projectionMatrix * mvPosition;

#ifdef USE_SOFT
  vClipPos = gl_Position;
#endif

#ifdef USE_FLIPBOOK
  // Sheet frames run left-to-right, top-to-bottom — the order every sprite
  // packer emits — so the row is counted down from the top of the texture
  // while UV space counts up from the bottom.
  float frameIndex = floor(aParams.w + 0.5);
  float total = uTiles.x * uTiles.y;
  frameIndex = mod(frameIndex, max(total, 1.0));
  float col = mod(frameIndex, uTiles.x);
  float row = floor(frameIndex / uTiles.x);
  vUv = (uv + vec2(col, uTiles.y - 1.0 - row)) / uTiles;
#else
  vUv = uv;
#endif
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform sampler2D uMap;
uniform float uOpacity;
#ifdef USE_SOFT
uniform sampler2D uDepth;
uniform vec2 uDepthSize;
uniform float uNear;
uniform float uFar;
uniform float uSoftFade;
#endif

varying vec4 vColor;
varying vec2 vUv;
#ifdef USE_SOFT
varying vec4 vClipPos;
#endif

#ifdef USE_SOFT
// Depth buffers are non-linear; comparing raw values would make the fade
// distance mean something completely different at 2 units than at 40.
float linearizeDepth(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}
#endif

void main() {
  vec4 texel = texture2D(uMap, vUv);
  vec4 color = texel * vColor;
  color.a *= uOpacity;

#ifdef USE_SOFT
  vec2 screenUv = (vClipPos.xy / vClipPos.w) * 0.5 + 0.5;
  float sceneDepth = linearizeDepth(texture2D(uDepth, screenUv).x);
  float fragDepth = linearizeDepth(gl_FragCoord.z);
  // Fade out as the particle approaches whatever solid geometry is behind
  // it — the hard intersection line is the single most obvious "this is a
  // flat card" tell in a smoke effect.
  color.a *= clamp((sceneDepth - fragDepth) / max(uSoftFade, 0.0001), 0.0, 1.0);
#endif

  // Fully transparent fragments still write depth and still cost a blend;
  // discarding them early is measurably cheaper on the tiled mobile GPUs
  // this targets, where overdraw is the dominant particle cost.
  if (color.a < 0.003) discard;

  gl_FragColor = color;
}
`;

/** Maps the config's blend name onto THREE's own constant — kept here so ParticleTypes stays free of any THREE import. */
function threeBlending(mode: ParticleBlendMode): THREE.Blending {
  if (mode === "additive") return THREE.AdditiveBlending;
  if (mode === "multiply") return THREE.MultiplyBlending;
  return THREE.NormalBlending;
}

let defaultTexture: THREE.Texture | undefined;

/**
 * The built-in soft radial dot every emitter falls back to.
 *
 * Generated into a canvas rather than shipped as a PNG for two reasons
 * this project cares about: it costs zero bytes in the single-file build
 * (a 64×64 RGBA PNG base64-inlined is ~4KB that every playable would pay
 * whether or not it uses particles), and an effect works the instant it's
 * created in the editor rather than looking broken until someone assigns a
 * texture.
 *
 * Module-level and shared by every emitter that doesn't override it —
 * deliberately never disposed by an emitter's own teardown, since the next
 * one will want it. ParticleManager.disposeSharedResources releases it when
 * the whole system goes away.
 */
export function getDefaultParticleTexture(): THREE.Texture {
  if (defaultTexture) return defaultTexture;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const half = size / 2;
    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
    // A linear alpha ramp reads as a hard-edged disc; this curve keeps a
    // bright core and a long tail, which is what makes the same texture
    // work for smoke, sparks, and glow alike.
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.25, "rgba(255,255,255,0.85)");
    gradient.addColorStop(0.55, "rgba(255,255,255,0.35)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  defaultTexture = new THREE.CanvasTexture(canvas);
  defaultTexture.colorSpace = THREE.SRGBColorSpace;
  defaultTexture.name = "ion-particle-default";
  return defaultTexture;
}

/** Releases the shared default texture. Reached only through `ParticleManager.disposeSharedResources` (see its doc comment — nothing in this repository calls it, and why). An individual emitter must never call this, since every other emitter shares the texture. */
export function disposeDefaultParticleTexture(): void {
  defaultTexture?.dispose();
  defaultTexture = undefined;
}

export interface ParticleMaterialOptions {
  renderer: RendererModule;
  texture: THREE.Texture;
  /** Only supplied when the host has actually wired a depth target — soft particles compile out entirely otherwise. See ParticleManager.setDepthTexture. */
  depthTexture?: THREE.Texture;
  near?: number;
  far?: number;
}

/**
 * Builds the material for one emitter.
 *
 * The `#define` set is derived from the config once, here — the renderer
 * rebuilds the material (rather than mutating it) whenever a change would
 * alter that set, because a `ShaderMaterial`'s defines only take effect on
 * recompile and silently doing nothing is worse than a visible rebuild.
 */
export function createParticleMaterial(opts: ParticleMaterialOptions): THREE.ShaderMaterial {
  const { renderer, texture } = opts;
  const useMesh = renderer.mode === "mesh";
  // A mesh particle is not a billboard, so it never wants the view-space
  // velocity basis even in "stretched"-adjacent configurations.
  const useVelocity = !useMesh && (renderer.mode === "velocity" || renderer.mode === "stretched");
  const useStretch = !useMesh && renderer.mode === "stretched";
  const useSoft = renderer.softParticles && !!opts.depthTexture;

  const defines: Record<string, string> = {};
  if (useMesh) defines.USE_MESH = "1";
  if (useVelocity) defines.USE_VELOCITY = "1";
  if (useStretch) defines.USE_STRETCH = "1";
  if (useSoft) defines.USE_SOFT = "1";

  const material = new THREE.ShaderMaterial({
    defines,
    uniforms: {
      uMap: { value: texture },
      uOpacity: { value: renderer.opacity },
      uPivot: { value: new THREE.Vector2(renderer.pivot[0], renderer.pivot[1]) },
      uTiles: { value: new THREE.Vector2(1, 1) },
      uStretch: { value: renderer.stretchFactor },
      uDepth: { value: opts.depthTexture ?? null },
      uDepthSize: { value: new THREE.Vector2(1, 1) },
      uNear: { value: opts.near ?? 0.1 },
      uFar: { value: opts.far ?? 1000 },
      uSoftFade: { value: renderer.softFadeDistance },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    blending: threeBlending(renderer.blending),
    depthWrite: renderer.depthWrite,
    depthTest: renderer.depthTest,
    // Billboard quads are viewed from either side once rotated — culling
    // them costs a visible half of every stretched/velocity-aligned effect.
    // Real mesh particles keep normal front-face culling, where backface
    // rejection is a genuine saving rather than a bug.
    side: useMesh ? THREE.FrontSide : THREE.DoubleSide,
  });
  material.name = "ion-particle";
  return material;
}

/**
 * Turns the flipbook path on/off and sets its tile count.
 *
 * Separate from creation because the texture-sheet module can be toggled
 * live in the Inspector, and this is the one define that has a cheap
 * correct answer for "changed while running": flip `needsUpdate` and let
 * three recompile. Doing the same for the render *mode* would also need
 * the instanced attribute set rebuilt, which is why that path recreates
 * the material instead.
 */
export function setFlipbook(material: THREE.ShaderMaterial, enabled: boolean, tilesX: number, tilesY: number): void {
  const want = enabled && (tilesX > 1 || tilesY > 1);
  const has = material.defines?.USE_FLIPBOOK === "1";
  (material.uniforms.uTiles.value as THREE.Vector2).set(Math.max(1, tilesX), Math.max(1, tilesY));
  if (want === has) return;
  if (!material.defines) material.defines = {};
  if (want) material.defines.USE_FLIPBOOK = "1";
  else delete material.defines.USE_FLIPBOOK;
  material.needsUpdate = true;
}

/** Whether a config change needs a full material rebuild rather than a uniform write — see ParticleRenderer.applyConfig. */
export function needsMaterialRebuild(previous: RendererModule, next: RendererModule, hadDepth: boolean, hasDepth: boolean): boolean {
  return (
    modeNeedsVelocity(previous.mode) !== modeNeedsVelocity(next.mode) ||
    (previous.mode === "stretched") !== (next.mode === "stretched") ||
    (previous.mode === "mesh") !== (next.mode === "mesh") ||
    previous.blending !== next.blending ||
    previous.depthWrite !== next.depthWrite ||
    previous.depthTest !== next.depthTest ||
    (previous.softParticles && hadDepth) !== (next.softParticles && hasDepth)
  );
}

/** The render modes that need the per-instance velocity attribute uploaded at all. */
export function modeNeedsVelocity(mode: ParticleRenderMode): boolean {
  return mode === "velocity" || mode === "stretched";
}
