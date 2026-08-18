#!/usr/bin/env node
// Runs Vite's own dev server (config: vite.config.ts — index.html at
// project root, port 8000) alongside the Engine Room build-trigger API
// (scripts/dev-build-api.js) as two child processes, forwarding Ctrl+C to
// both so neither is left orphaned. Plain child_process instead of a
// concurrently-style dependency — this is the only place that needs it.
const { spawn } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");

function run(command, args) {
  return spawn(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
}

const viteProc = run("npx", ["vite"]);
const apiProc = run("node", ["scripts/dev-build-api.js"]);

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
  // button — so don't tear down Vite's server over it.
  if (!shuttingDown) console.error(`dev-build-api.js exited unexpectedly (code ${code}) — Build button will be unavailable until you restart npm run dev.`);
});
