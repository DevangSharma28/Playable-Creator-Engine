import * as THREE from "three";
import { GLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

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

    return new Promise((resolve, reject) => {
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
    });
  }

  loadGlb(path: string): Promise<GLTF> {
    const cached = this.glbs.get(path);
    if (cached) return Promise.resolve(cached);

    return new Promise((resolve, reject) => {
      this.gltfLoader.load(
        path,
        (gltf) => {
          this.glbs.set(path, gltf);
          resolve(gltf);
        },
        undefined,
        (err) => reject(new Error(`Failed to load model "${path}": ${err}`))
      );
    });
  }

  loadAudio(path: string): Promise<AudioBuffer> {
    const cached = this.audioBuffers.get(path);
    if (cached) return Promise.resolve(cached);

    return new Promise((resolve, reject) => {
      this.audioLoader.load(
        path,
        (buffer) => {
          this.audioBuffers.set(path, buffer);
          resolve(buffer);
        },
        undefined,
        (err) => reject(new Error(`Failed to load audio "${path}": ${err}`))
      );
    });
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
}
