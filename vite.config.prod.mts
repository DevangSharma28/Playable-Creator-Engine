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
/**
 * `ion` is the specifier generated projects import from. The dev server aliases
 * it (see @ion-engine/project's dev.mjs); the production build needs the same
 * mapping, passed in as an absolute path because this config runs from inside
 * the installed package and cannot resolve the project's own node_modules.
 */
const runtimeEntry = process.env.ION_RUNTIME_ENTRY;

export default defineConfig({
  // Both specifiers, one file. A project imports the runtime as "ion" and the
  // generated entry used to import it as "@ion-engine/runtime"; those resolve
  // to different paths (IONEngine/ versus node_modules/), so the bundle got two
  // copies of the engine. Two copies means two `Ion` facades — one bound by
  // boot(), the other read by the game — and the game threw "Ion used before
  // IonEngine.boot() finished" on a boot that had already finished.
  resolve: runtimeEntry ? { alias: { ion: runtimeEntry, "@ion-engine/runtime": runtimeEntry }, dedupe: ["three"] } : undefined,
  // ION's own repo when unset; the customer's project when `ion build` sets
  // it. Without this the config would resolve "src" relative to its own
  // installed location inside node_modules and build the package, not the game.
  root: path.resolve(process.env.ION_PROJECT_ROOT ?? import.meta.dirname, "src"),
  publicDir: false, // no dist/assets copy — every real asset is base64-inlined by build.sh's own post-build step instead, not shipped as separate files (the whole point of the single-file build)
  build: {
    outDir: path.resolve(process.env.ION_PROJECT_ROOT ?? import.meta.dirname, "dist"),
    emptyOutDir: true,
    // Vite's own default target ("baseline-widely-available") assumes a
    // real modern browser and leaves plenty of recent syntax untouched —
    // class static {} blocks (ES2022), optional catch binding `catch {}`
    // (ES2019), optional chaining `?.`/nullish coalescing `??` (ES2020)
    // all showed up as-is in a build against that default (verified: grep
    // for `static{`/`catch{` in a built dist/index.html found real
    // matches, including inside three.js's own source, not just this
    // project's). Mindworks' review WebView can't parse any of that —
    // "SyntaxError: Unexpected token '{'" is exactly what an engine
    // without static-block support throws on `static{...}`. es2015 tells
    // esbuild (Vite's minifier/transformer) to down-level all of the
    // above into older equivalent syntax across every module it touches,
    // including node_modules dependencies like three.js — not just this
    // project's own TypeScript.
    target: "es2015",
    rollupOptions: {
      input: path.resolve(process.env.ION_PROJECT_ROOT ?? import.meta.dirname, "src/index.template.html"),
      output: {
        // Vite's default output is a real ES module (<script type="module">,
        // plus any import/export keywords Rollup can't fully inline away) —
        // ad-network review tools (Mintegral's Mindworks among them; see
        // its own explicit rule: "Do not use crossorigin, type='module',
        // import or export in local files") reject that outright, since
        // some WebViews used for validation don't support ES modules at
        // all, and file:// itself blocks module script loading via CORS
        // regardless. IIFE is a single self-executing classic <script> —
        // zero import/export syntax, no type="module" needed — safe here
        // because this app has no dynamic import() calls to code-split
        // (verified: nothing in src/ uses one), so there's nothing an IIFE
        // bundle can't inline into one file anyway.
        format: "iife",
      },
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
