import { defineConfig } from "vite";

/**
 * Dev-server-only config — production uses vite.config.prod.mts instead
 * (see build.sh), a genuinely different build: a minimal HTML shell with
 * no Engine Room panel, inlined into one self-contained file. Root/
 * publicDir stay at their defaults on purpose:
 *   - root (project root): index.html here is the dev entry — the Engine
 *     Room preview (device-frame simulator, UI editor overlay, freecam,
 *     live stats, ...), moved from the old public/index.html. See its own
 *     doc comments for the hot-reload handoff this relies on.
 *   - publicDir ("public"): scripts/sync-assets.js already stages
 *     assets/ -> public/assets/ and tools/ui-editor.html ->
 *     public/ui-editor.html here, so Vite serves them at /assets/... and
 *     /ui-editor.html with zero extra config.
 */
export default defineConfig({
  server: {
    port: 8000,
    strictPort: true,
    // Vite 5+ defaults to binding only the IPv6 loopback (::1) —
    // scripts/dev-build-api.js's CORS allowlist (and README, and various
    // dev tooling) expect the game to be reachable at either
    // http://localhost:8000 or http://127.0.0.1:8000; binding the IPv4
    // loopback explicitly keeps both working, matching the old esbuild
    // dev server's behavior.
    host: "127.0.0.1",
    watch: {
      /**
       * The two files the 3D editor saves are deliberately NOT watched.
       *
       * Both are real imports in main.ts's module graph, so writing one
       * trips HMR and tears down the very scene the editor is editing —
       * which is why saving used to be batched all the way to Exit Editor.
       * Now that both editors have their own Save button, that reload
       * would fire mid-session and throw away the selection and the whole
       * undo history every time you pressed it.
       *
       * Ignoring them is safe because the editor already holds the live
       * objects: the file is persistence, not the source of truth for a
       * running session. They're read on the next full load, which is
       * exactly when they should be.
       *
       * src/game/sceneBindings.json is pointedly *not* in this list — that
       * one genuinely needs the reload, because re-applying assignments
       * only happens through Game.ts's applySceneBindings at boot.
       */
      ignored: ["**/src/game/colliders.json", "**/src/game/particles.json"],
    },
  },
});
