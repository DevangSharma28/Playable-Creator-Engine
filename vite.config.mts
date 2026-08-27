import path from "node:path";
import { defineConfig, type Plugin } from "vite";

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
/**
 * The four files the ION editors write.
 *
 * Every one is a real `import` in main.ts's module graph, which is what makes
 * editor-authored data ship in the production build — and also what made
 * saving one mid-session tear down the very scene being edited.
 */
const EDITOR_AUTHORED = [
  "src/game/colliders.json",
  "src/game/particles.json",
  "src/game/environment.json",
  "src/game/scene.json",
];

/**
 * Invalidate these on change, but never hot-update them.
 *
 * This replaces `server.watch.ignored`, which looked like it did the same job
 * and quietly did something much worse. Ignoring a file removes it from the
 * watcher entirely, so Vite never learns it changed — and Vite's module graph
 * is invalidated *by* watcher events. The transformed JSON module therefore
 * stayed in the dev server's cache, and a **full browser reload re-served the
 * stale copy**. Restarting `npm run dev` rebuilt the cache and the edits
 * reappeared, which is exactly the "it saves but a reload loses it, and a dev
 * restart brings it back" report this fixes.
 *
 * Watching the file gives us the invalidation; returning an empty module array
 * from `handleHotUpdate` gives up the HMR. Vite calls
 * `moduleGraph.onFileChange()` before this hook runs, so by the time we
 * decline the update the cache is already correct for the next request.
 *
 * The HMR still has to be declined: these files are imported by Game.ts, so an
 * update would reload the scene out from under the editor session editing it,
 * taking the selection and the whole undo history with it.
 */
function ionEditorDataPlugin(): Plugin {
  return {
    name: "ion:editor-authored-data",
    handleHotUpdate(ctx) {
      const relative = path.relative(process.cwd(), ctx.file).split(path.sep).join("/");
      if (!EDITOR_AUTHORED.includes(relative)) return;
      ctx.server.config.logger.info(`  ion  ${relative} saved — will load on next full reload (no hot update)`);
      // Empty, not undefined: undefined means "use the default", which is the
      // reload we are here to prevent.
      return [];
    },
  };
}

export default defineConfig({
  plugins: [ionEditorDataPlugin()],
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
  },
});
