#!/usr/bin/env node
// Runs Vite's own dev server (config: vite.config.mts — index.html at
// project root) alongside the Engine Room build-trigger API
// (scripts/dev-build-api.js) as two child processes, forwarding Ctrl+C to
// both so neither is left orphaned. Plain child_process instead of a
// concurrently-style dependency — this is the only place that needs it.
//
// ## Why the ports are allocated rather than assumed
//
// Both halves used to take their port as a hardcoded default — Vite 8000
// (with `strictPort`), the API 8001 — and neither checked. That produced a
// failure that is genuinely hard to diagnose from the symptom, and did:
//
//   1. Something else is already on 8001 — another ION project, or an
//      orphaned dev API from one that has since been deleted (a dev server
//      outlives the folder it was started in; moving that folder to the
//      Trash does not kill it).
//   2. `dev-build-api.js` exits with its "port in use" message. Vite is
//      deliberately kept alive, because the game still serves fine without
//      the Build button — so the message scrolls past and the preview works.
//   3. The Engine Room falls back to `http://127.0.0.1:8001`, which is now
//      *someone else's API*. The version pill, the git commit, the build
//      report, and every Save go to a different project.
//
// The observed symptom was a version pill reporting a version this checkout
// has never had, and a commit hash that is not an object in this repository.
// Nothing errored, because from the page's point of view nothing had.
//
// So: ports are found free before anything binds (the same `ports.mjs` the
// packaged `ion dev` uses — one implementation, not two), and the API's real
// origin is *told* to the page rather than guessed at. See
// vite.config.mts's ionDevApiOriginPlugin.
const { spawn } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");

function run(command, args, env) {
  return spawn(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, ...env } });
}

/** `--port 9000` / `--api-port 9001`, for when you want a specific pair. Both stay preferences: a taken one still moves. */
function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = Number(process.argv[index + 1]);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : undefined;
}

async function main() {
  // Dynamic import: this file is CommonJS (it is `require`d by npm scripts on
  // every platform) and ports.mjs is ESM. Reusing it is still the right call —
  // a second copy of "find a free port" is exactly the kind of duplicate that
  // drifts.
  const { allocateDevPorts } = await import("../packages/project/lib/ports.mjs");

  const preferredPort = flag("port") ?? 8000;
  const { port, apiPort, movedFrom } = await allocateDevPorts({
    port: preferredPort,
    apiPort: flag("api-port") ?? preferredPort + 1,
  });
  if (movedFrom !== null) {
    console.log(`  ion  port ${movedFrom} was taken — using ${port} (API on ${apiPort})`);
  }

  const viteProc = run("npx", ["vite", "--port", String(port)], {
    // vite.config.mts reads both: the first to bind the port this process
    // actually reserved, the second to inject window.__ION_API_ORIGIN into
    // index.html so the Engine Room never has to assume 8001.
    ION_PORT: String(port),
    ION_API_PORT: String(apiPort),
  });
  const apiProc = run("node", ["scripts/dev-build-api.js"], {
    ION_API_PORT: String(apiPort),
    ION_DEV_ORIGINS: `http://localhost:${port},http://127.0.0.1:${port}`,
  });

  let shuttingDown = false;
  function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    viteProc.kill();
    apiProc.kill();
    process.exit(code ?? 0);
  }

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  viteProc.on("exit", (code) => shutdown(code ?? 0));
  apiProc.on("exit", (code) => {
    // The build API dying isn't fatal to serving the game — just the Build
    // button — so don't tear down Vite's server over it. It is loud, though:
    // the page's API origin now points at nothing, and a silent failure here
    // is what the port allocation above exists to prevent in the first place.
    if (!shuttingDown) console.error(`dev-build-api.js exited unexpectedly (code ${code}) — Build, Save and the version readout will be unavailable until you restart npm run dev.`);
  });
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
