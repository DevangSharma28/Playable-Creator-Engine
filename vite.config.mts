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
  },
});
