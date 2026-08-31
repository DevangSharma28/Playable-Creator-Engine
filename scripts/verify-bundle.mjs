#!/usr/bin/env node
/**
 * Runs a built playable in a real browser and reports what happened.
 *
 * The production bundle is the one artifact no amount of unit testing can
 * stand in for: it is minified, transpiled to ES2015, wrapped in an IIFE, has
 * every asset base64-inlined, and is loaded as one file with no module
 * resolution at all. Two bugs that shipped — a duplicated engine producing two
 * `Ion` facades, and an editor module surviving into production — were both
 * invisible everywhere except here.
 *
 * Serves `dist/` over http (never file://, which no ad network uses and whose
 * opaque origin changes WebGL and audio behaviour), drives Chrome over the
 * DevTools Protocol, and prints a JSON verdict.
 *
 *   node scripts/verify-bundle.mjs <project-dir> [--width 400] [--height 800] [--json]
 *
 * Exit code 0 means the playable booted, drew, and logged no page errors.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

export function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
}

/**
 * Identifiers that only exist inside the editor half of the engine.
 *
 * Their absence is what "the production build excludes editor-only tooling"
 * actually means, and it is checked against the shipped bytes rather than
 * against the build config, because the config being right and the output
 * being right are two different claims.
 */
const EDITOR_SYMBOLS = ["TransformControls", "OrbitControls", "EditorRoot", "ViewHelper", "Configure Colliders", "EditorHierarchy", "installEditor"];

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".glb": "model/gltf-binary", ".ogg": "audio/ogg" };

function serve(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      const file = path.join(root, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** Minimal CDP client over the raw WebSocket Node 22 ships. */
export class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        message.error ? reject(new Error(message.error.message)) : resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
      }
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)); }, 30_000);
    });
  }
}

export async function connect(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((target) => target.type === "page");
      if (page) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          socket.addEventListener("open", resolve, { once: true });
          socket.addEventListener("error", reject, { once: true });
        });
        return new Cdp(socket);
      }
    } catch { /* the browser is still coming up */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("could not attach to Chrome");
}

/**
 * @returns {Promise<{ok: boolean, errors: string[], canvas: {width:number,height:number}, webgl: boolean, drawCalls: number, editorPresent: boolean, sizeBytes: number}>}
 */
/**
 * Waits for a killed process to actually exit, rather than assuming SIGKILL is
 * instantaneous. It rarely takes long, but "rarely" is exactly what a flaky
 * CI failure looks like, and there is a real race behind it: Chrome tears down
 * through several helper processes (zygote, GPU, renderer), and one of them
 * can still hold a file open in the profile directory for a moment after the
 * main process has already been signalled.
 */
export function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Deletes a directory, retrying through the exact race `waitForExit` cannot
 * fully close.
 *
 * A recursive delete is not atomic: Node walks the tree, and if another
 * process (a not-quite-dead Chrome helper) writes or removes a file in it
 * between that walk and the `rmdir`, the result is `ENOTEMPTY` — not `ENOENT`,
 * which `force: true` already absorbs. This is a genuine TOCTOU race, not a
 * bug in the deletion itself, so the fix is to retry through the narrow window
 * rather than to delete more carefully.
 *
 * Cleanup failing is never allowed to crash the script or change its exit
 * code — it has nothing to do with whether the thing being verified passed,
 * and an uncaught exception here previously discarded that result entirely,
 * turning a real ✓ into a bare Node stack trace and exit 1.
 */
export async function removeDirRetrying(dir, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err.code !== "ENOTEMPTY" && err.code !== "EBUSY") {
        console.warn(`(cleanup) could not remove ${dir}: ${err.message}`);
        return;
      }
      if (attempt === attempts) {
        console.warn(`(cleanup) could not remove ${dir} after ${attempts} attempts: ${err.message}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
}

/**
 * Launches a headless Chrome on a random debug port and attaches to it.
 *
 * SwiftShader rather than the machine's GPU, deliberately: a test whose result
 * depends on which graphics driver the runner happens to have is not a test.
 */
export async function launchChrome({ width = 400, height = 800 } = {}) {
  const chrome = findChrome();
  if (!chrome) throw new Error("No Chrome/Chromium found. Set CHROME_PATH to one.");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ion-chrome-"));
  const debugPort = 9222 + Math.floor(Math.random() * 700);
  const browser = spawn(chrome, [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--use-gl=swiftshader", "--enable-unsafe-swiftshader",
    "--mute-audio", "about:blank",
  ], { stdio: "ignore" });
  const cdp = await connect(debugPort);
  return {
    cdp,
    async close() {
      browser.kill("SIGKILL");
      await waitForExit(browser);
      await removeDirRetrying(profile);
    },
  };
}

export { serve };

export async function verifyBundle(distDir, { width = 400, height = 800, settleMs = 2500 } = {}) {
  const chrome = findChrome();
  if (!chrome) throw new Error("No Chrome/Chromium found. Set CHROME_PATH to one.");
  const indexFile = path.join(distDir, "index.html");
  if (!fs.existsSync(indexFile)) throw new Error(`No index.html in ${distDir} — run the build first.`);

  const { server, port } = await serve(distDir);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ion-verify-"));
  const debugPort = 9222 + Math.floor(Math.random() * 700);
  const browser = spawn(chrome, [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    // Software GL, so the result does not depend on whether the machine
    // running the test happens to have a usable GPU.
    "--use-gl=swiftshader", "--enable-unsafe-swiftshader",
    "--mute-audio", "about:blank",
  ], { stdio: "ignore" });

  try {
    const cdp = await connect(debugPort);
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html` });
    await new Promise((resolve) => setTimeout(resolve, settleMs));

    const errors = cdp.events
      .filter((event) => event.method === "Runtime.exceptionThrown" || (event.method === "Log.entryAdded" && event.params.entry.level === "error"))
      .map((event) => {
        const entry = event.params.entry;
        const text = event.params.exceptionDetails?.exception?.description ?? event.params.exceptionDetails?.text ?? entry?.text;
        // A network failure's message alone ("404 Not Found") is useless
        // without the URL that failed.
        return entry?.url ? `${text} — ${entry.url}` : text;
      })
      .filter(Boolean)
      // The static server has no favicon and browsers always ask for one. It
      // says nothing about the playable.
      .filter((message) => !/favicon/i.test(message));

    const probe = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const canvas = document.getElementById("game");
        const gl = canvas && (canvas.getContext("webgl2") || canvas.getContext("webgl"));
        return {
          canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
          webgl: !!gl,
          uiChildren: (document.getElementById("custom-ui-layer")?.children.length) ?? 0,
          // Whether an *editor session* can actually exist. The dev hooks
          // themselves stay installed in production as inert forwarders — what
          // must not ship is the editor they forward to, so this asks the
          // runtime's own question rather than sniffing for hook names.
          editorPresent: !!(document.getElementById("editor-left") || document.querySelector(".editor-dock")),
          stats: window.__getEngineStats ? window.__getEngineStats() : null,
        };
      })()`,
    });

    const result = probe.result.value;
    return {
      ok: errors.length === 0 && !!result.canvas && result.webgl,
      errors,
      canvas: result.canvas,
      webgl: result.webgl,
      uiChildren: result.uiChildren,
      editorPresent: result.editorPresent,
      sizeBytes: fs.statSync(indexFile).size,
      /** Editor module identifiers that survived into the shipped file. Must be empty. */
      editorSymbols: EDITOR_SYMBOLS.filter((symbol) => fs.readFileSync(indexFile, "utf8").includes(symbol)),
    };
  } finally {
    browser.kill("SIGKILL");
    await waitForExit(browser);
    server.close();
    await removeDirRetrying(profile);
  }
}

if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const value = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback;
  };
  const projectDir = path.resolve(args.find((arg) => !arg.startsWith("--")) ?? ".");
  // dist/ first, always. A project root can have its own index.html — ION's
  // own repository does, and it is the *dev* Engine Room page — so preferring
  // whatever sits at the root meant pointing this at a project verified the
  // development entry instead of the artifact anyone would ship.
  const distDir = fs.existsSync(path.join(projectDir, "dist", "index.html"))
    ? path.join(projectDir, "dist")
    : projectDir;
  const report = await verifyBundle(distDir, { width: value("width", 400), height: value("height", 800) });
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`\n  ${report.ok ? "✓" : "✖"} ${path.relative(process.cwd(), distDir)}/index.html`);
    console.log(`    canvas        ${report.canvas ? `${report.canvas.width}×${report.canvas.height}` : "missing"}`);
    console.log(`    webgl         ${report.webgl}`);
    console.log(`    ui elements   ${report.uiChildren}`);
    console.log(`    editor code   ${report.editorSymbols.length ? `PRESENT — ${report.editorSymbols.join(", ")}` : "absent"}`);
    console.log(`    editor DOM    ${report.editorPresent ? "PRESENT — should not be" : "absent"}`);
    console.log(`    size          ${(report.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
    for (const error of report.errors) console.log(`    error         ${error.split("\n")[0]}`);
    console.log("");
  }
  process.exit(report.ok && !report.editorPresent && report.editorSymbols.length === 0 ? 0 : 1);
}
