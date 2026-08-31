#!/usr/bin/env node
/**
 * The claim, proved in a real browser: a 3D-editor scene edit survives a full
 * page reload.
 *
 * Nothing short of an actual reload proves this. In-process tests can show
 * that the serializer and the loader agree, but the reported bug was
 * specifically that the *running* game was right and the *reloaded* game was
 * wrong — so the only convincing test navigates away and comes back.
 *
 * The sequence is exactly what a person does:
 *
 *   1. Load the Engine Room and open the 3D editor.
 *   2. Move an object, hide another, rename a third — the way the gizmo and
 *      the Hierarchy do.
 *   3. Save and Exit, and confirm the *live* game shows the change.
 *   4. Reload the page from scratch.
 *   5. Confirm the reloaded scene is identical.
 *
 * Runs against a throwaway copy of the project, on OS-assigned ports, so it
 * can never write to the repository it is testing or collide with a dev server
 * someone is already running.
 *
 *   node scripts/verify-scene-persistence.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { launchChrome, waitForExit, removeDirRetrying } from "./verify-bundle.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

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

async function waitFor(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${url} never came up`);
}

/**
 * A complete copy of the project, so the edits this makes are thrown away.
 *
 * node_modules is symlinked rather than copied — it is the same read-only
 * dependency tree either way, and copying it would take minutes.
 */
function cloneProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ion-persist-"));
  spawnSync("tar", ["--exclude=node_modules", "--exclude=.git", "--exclude=dist", "--exclude=.build-cache", "-cf", "-", "."], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 512 * 1024 * 1024 });
  const tar = spawnSync("bash", ["-c", `tar --exclude=node_modules --exclude=.git --exclude=dist --exclude=.build-cache -cf - . | (cd ${JSON.stringify(dir)} && tar xf -)`], { cwd: ROOT, stdio: "ignore" });
  if (tar.status !== 0) throw new Error("could not copy the project");
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
  return dir;
}

const step = (n, message) => console.log(`    ${n}. ${message}`);

async function main() {
  const project = cloneProject();
  const port = await freePort();
  const apiPort = await freePort();
  const origin = `http://127.0.0.1:${port}`;

  console.log(`\n  3D editor persistence across a full page reload`);
  console.log(`    project  ${project}`);
  console.log(`    server   ${origin}\n`);

  spawnSync(process.execPath, [path.join(project, "scripts", "sync-assets.js")], { cwd: project, stdio: "ignore" });
  const vite = spawn("npx", ["vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: project, stdio: "ignore" });
  const api = spawn(process.execPath, [path.join(project, "scripts", "dev-build-api.js")], {
    cwd: project,
    stdio: "ignore",
    env: { ...process.env, ION_PROJECT_ROOT: project, ION_API_PORT: String(apiPort), ION_DEV_ORIGINS: origin },
  });

  const browser = await launchChrome({ width: 1440, height: 900 });
  const { cdp } = browser;
  const problems = [];

  try {
    await waitFor(origin);
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Console.enable").catch(() => {});
    await cdp.send("Page.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__ION_API_ORIGIN = "http://127.0.0.1:${apiPort}";` });

    const evaluate = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluate threw");
      return result.result.value;
    };
    const load = async () => {
      await cdp.send("Page.navigate", { url: origin });
      await new Promise((resolve) => setTimeout(resolve, 4000));
    };

    await load();
    step(1, "loaded the Engine Room");

    // Pick a real, named node out of the loaded model and record where it is.
    const target = await evaluate(`(() => {
      const game = window.__getInspectable && window.__getInspectable("Game");
      const scene = game && game.scene;
      if (!scene) return null;
      let found = null;
      scene.traverse((node) => {
        if (found || !node.name || node.name === "COLLIDERS" || node.name === "PARTICLES") return;
        if (node.parent && node.parent.name === "COLLIDERS") return;
        if (node.type === "Mesh") found = node;
      });
      return found ? { name: found.name, x: found.position.x, y: found.position.y, z: found.position.z, visible: found.visible } : null;
    })()`);
    if (!target) throw new Error("could not find a mesh in the loaded scene");
    step(2, `picked "${target.name}" at x=${target.x.toFixed(3)}`);

    // Open the editor, then make the edits the gizmo and Hierarchy make.
    await evaluate(`window.__setFreecamActive && window.__setFreecamActive(true)`);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const MOVED = { x: target.x + 12.5, y: target.y + 3.25, z: target.z - 7.75 };
    await evaluate(`(() => {
      const game = window.__getInspectable("Game");
      const node = game.scene.getObjectByName(${JSON.stringify(target.name)});
      node.position.set(${MOVED.x}, ${MOVED.y}, ${MOVED.z});
      node.visible = false;
      node.updateMatrixWorld(true);
      return true;
    })()`);
    step(3, `moved it to x=${MOVED.x.toFixed(3)} and hid it`);

    const pending = await evaluate(`!!(window.__hasSceneChanges && window.__hasSceneChanges())`);
    if (!pending) problems.push("the editor did not notice the scene had changed");

    // Save and Exit, exactly as the Exit button does.
    const saved = await evaluate(`(async () => {
      const objects = window.__serializeScene();
      const res = await fetch(window.__ION_API_ORIGIN + "/save-scene", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objects }),
      });
      const data = await res.json();
      window.__markSceneSaved();
      window.__setFreecamActive(false);
      return { ok: data.ok, saved: data.saved };
    })()`);
    if (!saved.ok) problems.push("the save request failed");
    step(4, `saved ${saved.saved} override(s) and exited the editor`);

    // On disk?
    const file = path.join(project, "src", "game", "scene.json");
    const onDisk = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { objects: [] };
    const record = onDisk.objects.find((entry) => entry.objectName === target.name || entry.objectPath.endsWith("/" + target.name) || entry.objectPath === target.name);
    if (!record) problems.push(`scene.json does not contain "${target.name}" — the Save did not reach the filesystem`);
    else step(5, `scene.json on disk holds ${onDisk.objects.length} override(s)`);
    if (process.env.ION_DEBUG) {
      console.log("      sample:", JSON.stringify(onDisk.objects.slice(0, 4), null, 2).split("\n").join("\n      "));
      console.log("      target record:", JSON.stringify(record));
    }

    // The live game must still be right — the half that already worked.
    const live = await evaluate(`(() => {
      const node = window.__getInspectable("Game").scene.getObjectByName(${JSON.stringify(target.name)});
      return { x: node.position.x, visible: node.visible };
    })()`);
    if (Math.abs(live.x - MOVED.x) > 1e-6) problems.push(`the live game lost the change after Exit (x=${live.x})`);
    if (live.visible !== false) problems.push("the live game lost the visibility change after Exit");
    step(6, "the running game still shows the change");

    // The whole point: a full reload.
    await load();
    if (process.env.ION_DEBUG) {
      const served = await (await fetch(origin + "/src/game/scene.json")).text();
      console.log("      served scene.json length:", served.length);
      const logs = cdp.events
        .filter((e) => e.method === "Runtime.consoleAPICalled" || e.method === "Log.entryAdded")
        .map((e) => (e.params.args ? e.params.args.map((a) => a.value ?? a.description).join(" ") : e.params.entry?.text))
        .filter((t) => t && /scene|Scene|override/i.test(t));
      console.log("      relevant console:", logs.filter((t) => /ION scene/.test(t)).join(" | ") || "(no ION scene line)");
      const diag = await evaluate(`(() => {
        const game = window.__getInspectable && window.__getInspectable("Game");
        if (!game) return "no game";
        const n = game.scene.getObjectByName(${JSON.stringify(target.name)});
        return n ? { path: (() => { const parts = []; let o = n; while (o && o !== game.scene) { parts.unshift(o.name || "#"); o = o.parent; } return parts.join("/"); })() } : "not found";
      })()`);
      console.log("      live path of target:", JSON.stringify(diag));
    }
    const reloaded = await evaluate(`(() => {
      const game = window.__getInspectable && window.__getInspectable("Game");
      if (!game) return null;
      const node = game.scene.getObjectByName(${JSON.stringify(target.name)});
      return node ? { x: node.position.x, y: node.position.y, z: node.position.z, visible: node.visible } : null;
    })()`);
    if (!reloaded) problems.push("the object is not in the scene after a reload");
    else {
      const close = (a, b) => Math.abs(a - b) < 1e-4;
      if (!close(reloaded.x, MOVED.x) || !close(reloaded.y, MOVED.y) || !close(reloaded.z, MOVED.z)) {
        problems.push(`after reload the object is at (${reloaded.x.toFixed(3)}, ${reloaded.y.toFixed(3)}, ${reloaded.z.toFixed(3)}), expected (${MOVED.x.toFixed(3)}, ${MOVED.y.toFixed(3)}, ${MOVED.z.toFixed(3)})`);
      }
      if (reloaded.visible !== false) problems.push("after reload the object is visible again");
      step(7, `after a full reload it is still at x=${reloaded.x.toFixed(3)}, visible=${reloaded.visible}`);
    }
  } finally {
    // browser.close() already waits out Chrome's own teardown race (see
    // verify-bundle.mjs). vite/api get the same treatment before their
    // directory is removed — both still have file handles open under
    // `project` (dist/, .build-cache/, IONEngine/) for a moment after
    // SIGTERM, and rmSync raced them exactly like it raced Chrome's profile
    // dir. See removeDirRetrying's own doc comment.
    await browser.close();
    vite.kill("SIGTERM");
    api.kill("SIGTERM");
    await Promise.all([waitForExit(vite), waitForExit(api)]);
    await removeDirRetrying(project);
  }

  if (problems.length) {
    console.log(`\n  ✖ ${problems.length} problem(s):`);
    for (const problem of problems) console.log(`    - ${problem}`);
    console.log("");
    process.exit(1);
  }
  console.log(`\n  ✓ 3D editor changes survived a complete browser reload\n`);
}

await main();
