#!/usr/bin/env node
/**
 * ION Studio, driven in a real browser inside a real generated project.
 *
 * This exists because the editor a *customer* runs is not the one this
 * repository runs. ION's own dev entry constructs `EditorRoot` directly from
 * `src/game/Game.ts`; a generated project reaches it through
 * `@ion-engine/editor`'s adapter. The two wire the same classes differently,
 * so a defect in the adapter is invisible to every test that runs in-repo.
 *
 * One did exactly that. The adapter built a second `ColliderVisuals` for the
 * editor while the debug layer kept the first — and since `ColliderVisuals` is
 * reconciled once per frame from `IonGame.render()` via the *debug* layer,
 * the editor's copy was never ticked. Colliders existed and detection ran, but
 * not one wireframe was ever drawn: Configure Colliders looked completely
 * dead, and every API-level check reported success.
 *
 * So the assertions here are about what is actually on screen and in the scene
 * graph, not about what the hooks return.
 *
 *   node scripts/verify-editor.mjs [--project <dir>] [--keep]
 *
 * With no --project it generates and installs one, which takes a minute.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchChrome } from "./verify-bundle.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ion-editor-"));
  const gen = spawnSync(process.execPath, [path.join(ROOT, "create-ion-project.mjs"), "editor-probe", "--yes"], { cwd: dir, encoding: "utf8" });
  if (gen.status !== 0) throw new Error(`generator failed:\n${gen.stdout}${gen.stderr}`);
  const project = path.join(dir, "editor-probe");
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: project, encoding: "utf8" });
  if (install.status !== 0) throw new Error(`npm install failed:\n${install.stdout}${install.stderr}`);
  return { project, workspace: dir };
}

async function startDev(project) {
  const dev = spawn("npm", ["run", "dev"], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
  let port = null;
  dev.stdout.on("data", (d) => {
    const m = /ION Studio\s+http:\/\/localhost:(\d+)/.exec(d.toString());
    if (m) port = Number(m[1]);
  });
  for (let i = 0; i < 240 && !port; i++) await wait(500);
  if (!port) { dev.kill("SIGTERM"); throw new Error("the dev server never reported a port"); }
  await wait(2500);
  return { dev, port };
}

const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); return ok; };

async function main() {
  const given = argValue("project");
  const made = given ? null : makeProject();
  const project = given ? path.resolve(given) : made.project;
  console.log(`\n  ION Studio in a generated project\n    project  ${project}`);

  const { dev, port } = await startDev(project);
  console.log(`    server   http://127.0.0.1:${port}\n`);
  const browser = await launchChrome({ width: 1600, height: 1000 });
  const { cdp } = browser;
  const ev = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? "evaluate threw");
    return r.result?.value;
  };
  const layout = () => ev(`[...document.querySelectorAll(".editor-dock")].map(d=>({id:d.id,panes:[...d.querySelectorAll(".editor-pane,.editor-viewhelper-slot")].map(p=>p.id)}))`);

  try {
    await cdp.send("Runtime.enable"); await cdp.send("Log.enable"); await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    await wait(7000);

    check(await ev(`!!(window.__getInspectable && window.__getInspectable("Game"))`), "the game never booted");

    await ev(`document.getElementById("er-btn-viewer").click()`);
    await wait(3500);
    const docks = await ev(`[...document.querySelectorAll(".editor-dock")].filter(d=>d.classList.contains("visible")).length`);
    check(docks === 3, `expected 3 editor docks after opening the editor, saw ${docks}`);
    console.log(`    editor opened — ${docks} docks`);

    const opened = await layout();
    // ── Configure Colliders: the wireframes must actually be drawn. ──
    await ev(`document.getElementById("si-tool-colliders").click()`);
    await wait(1500);
    await ev(`document.getElementById("si-col-add-box").click()`);
    await wait(2500);

    const colliders = await ev(`(() => {
      const game = window.__getInspectable("Game");
      let group = null;
      game.scene.traverse((n) => { if (n.name === "COLLIDERS") group = n; });
      let drawn = 0;
      if (group) group.traverse((n) => { if ((n.isMesh || n.isLineSegments) && n.visible) drawn++; });
      return { registered: window.__serializeColliders().length, drawn, stats: window.__getColliderStats() };
    })()`);
    console.log(`    colliders: ${colliders.registered} registered, ${colliders.drawn} wireframe object(s) drawn`);
    check(colliders.registered > 0, "creating a collider did not register one");
    check(colliders.drawn > 0, "Configure Colliders drew no wireframes — the editor's ColliderVisuals is not being reconciled");
    check(colliders.stats.total > 0, "the collider stats report nothing registered");

    // ── Particle System: its toolbar appears and the collider one goes. ──
    await ev(`document.getElementById("si-tool-particles").click()`);
    await wait(2000);
    // Both toolbars hide with `visibility: hidden` rather than `display: none`
    // (they animate in and out), so presence in the layout says nothing —
    // computed visibility is what a person actually sees.
    const modes = await ev(`(() => {
      const shown = (el) => !!el && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).opacity !== "0";
      return {
        particleToolbar: shown(document.getElementById("si-particle-toolbar")) || shown(document.getElementById("si-part-save")?.closest("[id$='toolbar']")),
        colliderToolbar: shown(document.getElementById("si-collider-toolbar")),
        particleBtn: document.getElementById("si-tool-particles").classList.contains("active"),
        colliderBtn: document.getElementById("si-tool-colliders").classList.contains("active"),
      };
    })()`);
    console.log(`    particle mode: particle toolbar=${modes.particleToolbar} collider toolbar=${modes.colliderToolbar}`);
    check(modes.particleToolbar, "the particle toolbar did not appear");
    check(!modes.colliderToolbar, "the collider toolbar is still showing in particle mode — the two modes are not exclusive");
    check(!modes.colliderBtn, "the Configure Colliders button is still lit in particle mode");

    // ── Back to colliders: the layout and the view helper must return. ──
    await ev(`document.getElementById("si-tool-colliders").click()`);
    await wait(2000);
    const restored = await layout();
    check(
      JSON.stringify(restored) === JSON.stringify(opened),
      `the dock layout did not return to how the editor opened.\n      opened:   ${JSON.stringify(opened)}\n      restored: ${JSON.stringify(restored)}`
    );
    const helper = await ev(`(() => {
      const slot = document.getElementById("editor-pane-viewhelper");
      const canvas = document.getElementById("er-viewhelper");
      return { slotVisible: slot ? getComputedStyle(slot).display !== "none" : false, canvas: !!canvas };
    })()`);
    check(helper.canvas, "the view helper canvas is missing from the page");
    check(helper.slotVisible, "the view helper is hidden after switching modes — body.particle-mode was never cleared");
    console.log(`    back to colliders: layout restored, view helper visible=${helper.slotVisible}`);

    const errors = cdp.events
      .filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Log.entryAdded" && e.params.entry.level === "error"))
      .map((e) => { const en = e.params.entry; const t = e.params.exceptionDetails?.exception?.description ?? en?.text; return en?.url ? `${t} — ${en.url}` : t; })
      .filter(Boolean)
      .filter((m) => !/favicon|GL Driver/i.test(m));
    for (const m of errors) problems.push(`console error: ${m.split("\n")[0]}`);
  } finally {
    await browser.close();
    dev.kill("SIGTERM");
    await wait(1500);
    if (made && !args.includes("--keep")) fs.rmSync(made.workspace, { recursive: true, force: true });
  }

  if (problems.length) {
    console.log(`\n  ✖ ${problems.length} problem(s):`);
    for (const p of problems) console.log(`    - ${p}`);
    console.log("");
    process.exit(1);
  }
  console.log("\n  ✓ ION Studio works end to end in a generated project\n");
}

await main();
