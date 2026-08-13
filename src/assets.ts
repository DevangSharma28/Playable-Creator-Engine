/**
 * Central registry of every asset path used in the game.
 *
 * Group by type (texture / model / audio / font) rather than by feature —
 * it keeps autocomplete useful ("libTex." shows only textures) and makes
 * it obvious at a glance what kind of loader a given path needs.
 *
 * Paths are relative to where index.html is served from. Keep every
 * binary asset under /assets so the whole folder can be copied verbatim
 * into dist/ during a production build.
 */

export namespace libTex {
}

export namespace libGlb {
  export const player: string = "./assets/models/MainCharacter.glb";
}

export namespace libAudio {
}

export namespace libFont {
  // Three.js "typeface" JSON fonts, for THREE.TextGeometry etc.
}

/**
 * Every asset in one flat list, tagged with the loader it needs.
 * Feed this straight into AssetLoader.preload() to load everything
 * up front behind a loading screen.
 */
export type AssetKind = "texture" | "glb" | "audio";

export interface AssetEntry {
  kind: AssetKind;
  path: string;
}

export const manifest: AssetEntry[] = [
  { kind: "glb", path: libGlb.player },
];
