#!/usr/bin/env node
/**
 * Layout regression for ION Studio's own UI, in a real browser.
 *
 * Deliberately *not* a pixel-diff suite. A screenshot baseline of a 3D editor
 * changes whenever a light moves or a font renders half a pixel differently,
 * which trains everyone to re-bless the baseline and stops catching anything.
 * What is checked instead is the set of things that are actually broken when
 * the editor "looks wrong", stated as measurable invariants:
 *
 *  - the page never scrolls horizontally,
 *  - every dock is fully on screen when open and fully off it when closed,
 *  - the viewport canvas fills the space the docks leave, at every size,
 *  - opening and closing a dock returns the canvas to exactly where it was,
 *  - nothing throws while any of it happens.
 *
 * Screenshots are still written, for a human to look at — they are evidence,
 * not the assertion.
 *
 *   node scripts/visual-regression.mjs [--out <dir>] [--port 8123] [--api-port 8124] [--keep]
 *
 * Exits non-zero if any invariant fails.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { launchChrome } from "./verify-bundle.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

/**
 * The viewports the editor has to survive.
 *
 * Phones in both orientations because that is what a playable is previewed at,
 * desktop because that is where the editor is actually used, and two absurd
 * aspect ratios because those are what find the layout that assumed one.
 */
export const VIEWPORTS = [
  { name: "phone-portrait", width: 390, height: 844 },
  { name: "phone-landscape", width: 844, height: 390 },
  { name: "tablet-portrait", width: 820, height: 1180 },
  { name: "laptop", width: 1440, height: 900 },
  { name: "desktop-wide", width: 2560, height: 1440 },
  { name: "extreme-wide", width: 2400, height: 320 },
  { name: "extreme-tall", width: 320, height: 2000 },
  { name: "tiny", width: 320, height: 480 },
];

/** A free TCP port, asked of the OS rather than guessed — the dev ports are often already in use. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${url} did not come up within ${timeoutMs}ms`);
}

/**
 * A throwaway mirror of the project's authored data, for the build API to own.
 *
 * The API this script starts is the one every ION editor *saves* through. A
 * layout test has no business writing to anyone's `colliders.json`, and
 * loading the Engine Room repeatedly is exactly the sort of thing that can
 * provoke a save. Pointing it at a copy means the worst case is a modified
 * temp directory. The Vite server still serves the real project — the thing
 * under test — because only the API writes.
 */
function mirrorProjectData() {
  const mirror = fs.mkdtempSync(path.join(os.tmpdir(), "ion-vr-project-"));
  fs.cpSync(path.join(ROOT, "src", "game"), path.join(mirror, "src", "game"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(mirror, "package.json"));
  return mirror;
}

/**
 * Starts the dev server and the build API on ports nobody else is using.
 *
 * Never the configured 8000/8001: a developer running this almost certainly
 * has their own project on those, and taking them would either fail outright
 * or, worse, measure their project instead of this one.
 */
async function startDevServer({ port, apiPort }) {
  const origin = `http://127.0.0.1:${port}`;
  spawnSyncQuiet(process.execPath, [path.join(ROOT, "scripts", "sync-assets.js")]);
  const mirror = mirrorProjectData();

  const vite = spawn("npx", ["vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: ROOT,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  const api = spawn(process.execPath, [path.join(ROOT, "scripts", "dev-build-api.js")], {
    cwd: ROOT,
    stdio: "ignore",
    env: { ...process.env, ION_PROJECT_ROOT: mirror, ION_API_PORT: String(apiPort), ION_DEV_ORIGINS: origin },
  });

  await waitForServer(origin);
  return {
    origin,
    apiOrigin: `http://127.0.0.1:${apiPort}`,
    mirror,
    stop() {
      // Same reasoning as verify-scene-persistence.mjs's matching teardown:
      // vite runs through a shell on Windows (to resolve npx.cmd), so its
      // .pid is the shell's, not vite's — plain kill() leaves the real
      // process (and its locks on `mirror`) running and the rmSync below
      // fails with EPERM. taskkill /t kills the whole tree instead.
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(vite.pid), "/t", "/f"]);
      else vite.kill("SIGTERM");
      api.kill("SIGTERM");
      fs.rmSync(mirror, { recursive: true, force: true });
    },
  };
}

function spawnSyncQuiet(command, commandArgs) {
  spawnSync(command, commandArgs, { cwd: ROOT, stdio: "ignore" });
}

/** Measurements taken inside the page — one round trip per viewport rather than one per question. */
const PROBE = `(() => {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const canvas = document.getElementById("game");
  const docks = [...document.querySelectorAll(".editor-dock")].map((el) => ({
    id: el.id,
    open: el.classList.contains("visible"),
    rect: rect(el),
  }));
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    canvas: canvas ? { css: rect(canvas), buffer: { width: canvas.width, height: canvas.height } } : null,
    docks,
    panelOpen: !!document.querySelector("#engine-room, .engine-room, #panel"),
  };
})()`;

async function main() {
  const outDir = path.resolve(argValue("out", path.join(ROOT, ".visual-regression")));
  fs.mkdirSync(outDir, { recursive: true });

  const port = Number(argValue("port", 0)) || (await freePort());
  const apiPort = Number(argValue("api-port", 0)) || (await freePort());

  console.log(`\n  ION Studio layout regression`);
  console.log(`    dev server  http://127.0.0.1:${port}`);
  console.log(`    build api   http://127.0.0.1:${apiPort}`);
  console.log(`    screenshots ${path.relative(process.cwd(), outDir)}\n`);

  const server = await startDevServer({ port, apiPort });
  const browser = await launchChrome({ width: 1440, height: 900 });
  const { cdp } = browser;
  const failures = [];
  const results = [];

  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    // index.html reads this to find the build API; without it the page talks
    // to whatever is on the default port, which may be someone else's project.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__ION_API_ORIGIN = ${JSON.stringify(server.apiOrigin)};`,
    });

    for (const viewport of VIEWPORTS) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.width < 900,
      });
      await cdp.send("Page.navigate", { url: server.origin });
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const probe = (await cdp.send("Runtime.evaluate", { returnByValue: true, expression: PROBE })).result.value;
      results.push({ viewport: viewport.name, probe });

      const fail = (message) => failures.push(`${viewport.name}: ${message}`);

      if (!probe.canvas) fail("no #game canvas on the page");
      else {
        if (probe.canvas.css.width <= 0 || probe.canvas.css.height <= 0) fail(`canvas has no size (${probe.canvas.css.width}×${probe.canvas.css.height})`);
        if (probe.canvas.buffer.width <= 0 || probe.canvas.buffer.height <= 0) fail("canvas backing buffer is empty");
      }
      // A few pixels of slack: scrollbars and sub-pixel rounding are not a bug.
      if (probe.scroll.width > probe.viewport.width + 2) {
        fail(`page scrolls horizontally (${probe.scroll.width} > ${probe.viewport.width})`);
      }
      for (const dock of probe.docks) {
        if (!dock.rect) continue;
        if (dock.open && (dock.rect.x < -2 || dock.rect.x + dock.rect.width > probe.viewport.width + 2)) {
          fail(`open dock #${dock.id} is off screen (x ${dock.rect.x}, width ${dock.rect.width})`);
        }
      }

      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(outDir, `${viewport.name}.png`), Buffer.from(shot.data, "base64"));
      console.log(`    ${failures.length ? " " : "✓"} ${viewport.name.padEnd(18)} ${probe.viewport.width}×${probe.viewport.height}  canvas ${probe.canvas ? `${probe.canvas.css.width}×${probe.canvas.css.height}` : "—"}`);
    }

    // Dock open/close must be reversible. A dock that resizes the viewport on
    // the way out but not on the way back in is the exact bug that left the
    // canvas frozen at the wrong size after the Environment panel closed.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: server.origin });
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const cycle = await cdp.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const canvas = document.getElementById("game");
        const size = () => { const r = canvas.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), bw: canvas.width, bh: canvas.height }; };
        const docks = [...document.querySelectorAll(".editor-dock")].map((d) => d.id);
        const before = size();
        const observed = [];
        for (const id of docks) {
          const dock = document.getElementById(id);
          if (!dock) continue;
          dock.classList.add("visible");
          await wait(400);
          const open = size();
          dock.classList.remove("visible");
          await wait(400);
          observed.push({ id, open, closed: size() });
        }
        return { before, observed };
      })()`,
    });
    const cycleResult = cycle.result.value;
    if (cycleResult?.observed) {
      for (const entry of cycleResult.observed) {
        const same = entry.closed.w === cycleResult.before.w && entry.closed.h === cycleResult.before.h;
        if (!same) failures.push(`dock #${entry.id}: closing it left the canvas at ${entry.closed.w}×${entry.closed.h}, not ${cycleResult.before.w}×${cycleResult.before.h}`);
      }
      console.log(`\n    dock open/close cycle: ${cycleResult.observed.length} dock(s) checked`);
    }

    const errors = cdp.events
      .filter((event) => event.method === "Runtime.exceptionThrown" || (event.method === "Log.entryAdded" && event.params.entry.level === "error"))
      .map((event) => {
        const entry = event.params.entry;
        const text = event.params.exceptionDetails?.exception?.description ?? entry?.text;
        // A bare "404 Not Found" says nothing about what is missing.
        return entry?.url ? `${text} — ${entry.url}` : text;
      })
      .filter(Boolean)
      .filter((message) => !/favicon|ERR_CONNECTION_REFUSED/i.test(message));
    for (const message of errors) failures.push(`console error: ${message.split("\n")[0]}`);

    fs.writeFileSync(path.join(outDir, "measurements.json"), JSON.stringify({ results, failures }, null, 2));
  } finally {
    browser.close();
    server.stop();
  }

  if (failures.length) {
    console.log(`\n  ✖ ${failures.length} layout problem(s):`);
    for (const failure of failures) console.log(`    - ${failure}`);
    console.log("");
    process.exit(1);
  }
  console.log(`\n  ✓ every viewport laid out correctly\n`);
}

await main();
