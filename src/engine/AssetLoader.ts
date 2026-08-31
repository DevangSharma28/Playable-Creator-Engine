import * as THREE from "three";
import { GLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { disposeObject3D } from "./core/disposeScene";

/** Which loader (see AssetLoader.preload below) a manifest entry needs. Generic — lives here, not in a specific game's assets.ts, since it describes the loader's own shape, not any particular game's content. */
export type AssetKind = "texture" | "glb" | "audio";

export interface AssetEntry {
  kind: AssetKind;
  path: string;
}

/**
 * Small caching asset loader.
 *
 * Usage:
 *   const loader = new AssetLoader();
 *   await loader.preload(manifest, (loaded, total) => updateBar(loaded / total));
 *   const tex = loader.getTexture(libTex.coin);       // already resolved, sync
 *   const gltf = loader.getGlb(libGlb.cube);
 *
 * Loading everything up front (rather than lazily, mid-gameplay) matters
 * for playable ads specifically: a stutter the first time a coin is
 * picked up reads as jank and can tank engagement metrics.
 */
export class AssetLoader {
  private textureLoader = new THREE.TextureLoader();
  private gltfLoader = new GLTFLoader();
  private audioLoader = new THREE.AudioLoader();

  constructor() {
    // Lets GLTFLoader decode EXT_meshopt_compression (the Builder's "Half
    // Float" option, see build.sh's compress-assets step) without any
    // extra network request — the decoder's WASM is inlined as a base64
    // byte array inside this module (see its own source), so it bundles
    // into the app the same as any other import instead of needing a
    // separately-hosted .wasm file. Harmless to set unconditionally: a GLB
    // that was never meshopt-compressed just never triggers this path.
    this.gltfLoader.setMeshoptDecoder(MeshoptDecoder);
  }

  private textures = new Map<string, THREE.Texture>();
  private glbs = new Map<string, GLTF>();
  private audioBuffers = new Map<string, AudioBuffer>();

  /**
   * Loads that have been started but haven't resolved yet, keyed
   * `kind:path`.
   *
   * The resolved caches above only de-duplicate *sequential* requests: the
   * second call is a cache hit because the first one already finished. Two
   * calls that overlap both miss, and both start a real fetch — so a
   * manifest that lists one texture twice (an easy thing to do once a
   * project has several entity modules contributing entries), or a
   * `loadGlb()` from an entity constructor for a model `preload()` is
   * fetching at that same moment, downloaded and GPU-uploaded the asset
   * twice and left one copy unreachable, i.e. leaked for the life of the
   * loader. Handing back the in-flight promise makes "one path, one load"
   * true regardless of call timing.
   */
  private readonly pending = new Map<string, Promise<unknown>>();

  /**
   * Runs `start` unless a load for this key is already in flight, in which
   * case the existing promise is returned instead.
   *
   * The entry is dropped on settle, not on success — a failed load must be
   * retryable, and leaving a rejected promise cached would make every
   * later attempt fail with the original error rather than trying again.
   */
  private once<T>(key: string, start: () => Promise<T>): Promise<T> {
    const inFlight = this.pending.get(key) as Promise<T> | undefined;
    if (inFlight) return inFlight;
    const promise = start().finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  /** Loads every entry in the manifest, reporting (loadedCount, totalCount) as it goes. */
  async preload(
    manifest: AssetEntry[],
    onProgress?: (loaded: number, total: number) => void
  ): Promise<void> {
    let loaded = 0;
    const total = manifest.length;
    const tick = () => onProgress?.(++loaded, total);

    await Promise.all(
      manifest.map(async (entry) => {
        switch (entry.kind) {
          case "texture":
            await this.loadTexture(entry.path);
            break;
          case "glb":
            await this.loadGlb(entry.path);
            break;
          case "audio":
            await this.loadAudio(entry.path);
            break;
        }
        tick();
      })
    );
  }

  loadTexture(path: string): Promise<THREE.Texture> {
    const cached = this.textures.get(path);
    if (cached) return Promise.resolve(cached);

    return this.once(`texture:${path}`, () => new Promise<THREE.Texture>((resolve, reject) => {
      this.textureLoader.load(
        path,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          this.textures.set(path, tex);
          resolve(tex);
        },
        undefined,
        (err) => reject(new Error(`Failed to load texture "${path}": ${err}`))
      );
    }));
  }

  loadGlb(path: string): Promise<GLTF> {
    const cached = this.glbs.get(path);
    if (cached) return Promise.resolve(cached);

    return this.once(`glb:${path}`, () => new Promise<GLTF>((resolve, reject) => {
      this.gltfLoader.load(
        path,
        (gltf) => {
          this.glbs.set(path, gltf);
          resolve(gltf);
        },
        undefined,
        (err) => reject(new Error(`Failed to load model "${path}": ${err}`))
      );
    }));
  }

  loadAudio(path: string): Promise<AudioBuffer> {
    const cached = this.audioBuffers.get(path);
    if (cached) return Promise.resolve(cached);

    return this.once(`audio:${path}`, () => new Promise<AudioBuffer>((resolve, reject) => {
      this.audioLoader.load(
        path,
        (buffer) => {
          this.audioBuffers.set(path, buffer);
          resolve(buffer);
        },
        undefined,
        (err) => reject(new Error(`Failed to load audio "${path}": ${err}`))
      );
    }));
  }

  /** Sync getters — only safe to call after preload() has resolved for that path. */
  getTexture(path: string): THREE.Texture {
    const tex = this.textures.get(path);
    if (!tex) throw new Error(`Texture not preloaded: ${path}`);
    return tex;
  }

  getGlb(path: string): GLTF {
    const gltf = this.glbs.get(path);
    if (!gltf) throw new Error(`Model not preloaded: ${path}`);
    return gltf;
  }

  getAudio(path: string): AudioBuffer {
    const buf = this.audioBuffers.get(path);
    if (!buf) throw new Error(`Audio not preloaded: ${path}`);
    return buf;
  }

  /** Deep-clones a cached glTF scene so you can place multiple instances (e.g. several coins). */
  instantiateGlb(path: string): THREE.Group {
    return this.getGlb(path).scene.clone(true);
  }

  /** Returns the animation clips for a preloaded GLB. */
  getAnimations(path: string): THREE.AnimationClip[] {
    return this.getGlb(path).animations;
  }

  /** Paths this loader has resolved, by kind. Used by the doctor/report tooling and by tests asserting a preload actually happened. */
  get cached(): { textures: string[]; models: string[]; audio: string[] } {
    return {
      textures: [...this.textures.keys()],
      models: [...this.glbs.keys()],
      audio: [...this.audioBuffers.keys()],
    };
  }

  /**
   * Releases every GPU resource this loader is holding and empties the caches.
   *
   * A cached texture is an uploaded GPU texture, and a cached GLB holds the
   * geometry and materials every `instantiateGlb()` clone shares. Dropping the
   * reference to the loader does not free any of that — only `dispose()` does.
   * Without this, each dev hot reload built a fresh loader and re-uploaded the
   * whole manifest while the previous copy stayed resident, so GPU memory grew
   * once per save until the tab lost its context.
   *
   * Not called during normal gameplay: this retires the loader. IonGame's own
   * dispose() is the caller.
   */
  dispose(): void {
    // Anything still downloading resolves into a cache this call is about
    // to empty; forgetting it here just means a late arrival can't be
    // handed to a caller that asks after teardown.
    this.pending.clear();
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
    // The clones handed out by instantiateGlb() share this geometry, so this
    // is the one release that covers all of them.
    for (const gltf of this.glbs.values()) disposeObject3D(gltf.scene, true);
    this.glbs.clear();
    // AudioBuffers are plain CPU memory owned by the WebAudio context; there
    // is nothing to release beyond dropping the references.
    this.audioBuffers.clear();
  }
}
