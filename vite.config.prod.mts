import path from "node:path";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * Production build config — see build.sh, the only thing that runs this.
 * A deliberately different entry/shape than the dev config
 * (vite.config.mts): `root` is `src/`, whose own index.template.html is a
 * minimal page shell with none of the dev-only Engine Room panel
 * (device-frame simulator, UI editor overlay, freecam, live stats, ...) —
 * that dev chrome must never ship in the real playable (see the
 * ion-engine-architect skill's "Editor vs Runtime Separation" guardrail).
 *
 * vite-plugin-singlefile inlines the built JS/CSS directly into the
 * output HTML — but it only ever sees what's actually in Vite's own
 * module graph. This project's real game assets (GLB models, textures)
 * are referenced as plain runtime string paths in assets.ts, not `import`
 * statements, so Vite never sees them as build inputs at all; build.sh's
 * own post-build step base64-inlines those directly into the emitted
 * HTML, the same job the old esbuild-based build.sh always did, just
 * retargeted at Vite's output instead of esbuild's.
 */
export default defineConfig({
  root: path.resolve(import.meta.dirname, "src"),
  publicDir: false, // no dist/assets copy — every real asset is base64-inlined by build.sh's own post-build step instead, not shipped as separate files (the whole point of the single-file build)
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(import.meta.dirname, "src/index.template.html"),
    },
    // vite-plugin-singlefile needs every genuinely-imported asset inlined
    // regardless of size, or it can't fold them into the single output
    // file — irrelevant to this project's GLB/texture assets (see above)
    // but matters for anything actually pulled in through JS/CSS.
    assetsInlineLimit: 100_000_000,
    minify: true,
  },
  plugins: [viteSingleFile()],
});
