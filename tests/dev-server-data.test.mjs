/**
 * The dev server must serve editor-authored data fresh after a save.
 *
 * This is the root cause of "the editor saves, the running game updates, and a
 * browser reload throws it away". `server.watch.ignored` was set on the four
 * files the ION editors write, to stop a save from hot-reloading the scene out
 * from under the editor. It did stop that — and it also removed the files from
 * the watcher entirely, which is how Vite's module graph learns to invalidate.
 * The transformed JSON module stayed in the dev server's cache, so a full page
 * reload re-served the *old* data. Restarting `npm run dev` rebuilt the cache,
 * which is exactly why the changes "came back" after a restart.
 *
 * The fix is a plugin that lets the watcher see the files (so they invalidate)
 * and declines the hot update (so the session survives). Both halves matter, so
 * both are asserted here: the module must come back fresh, and the change must
 * not have triggered an HMR update.
 *
 * Runs a real Vite dev server against a throwaway copy of the project.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

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

/** A copy of the project, so nothing here can touch the real one. node_modules is shared by symlink. */
function cloneProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ion-vite-"));
  const tar = spawnSync("bash", ["-c", `tar --exclude=node_modules --exclude=.git --exclude=dist --exclude=.build-cache -cf - . | (cd ${JSON.stringify(dir)} && tar xf -)`], { cwd: ROOT, stdio: "ignore" });
  if (tar.status !== 0) throw new Error("could not copy the project");
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
  return dir;
}

let project;
let vite;
let origin;

test.before(async () => {
  project = cloneProject();
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  vite = spawn("npx", ["vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: project, stdio: "ignore" });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { if ((await fetch(origin)).ok) return; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error("vite never came up");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
});

test.after(() => {
  vite?.kill("SIGTERM");
  if (project) fs.rmSync(project, { recursive: true, force: true });
});

/**
 * The file as the *module graph* serves it.
 *
 * `?import` is what makes Vite hand back the transformed ES module rather than
 * the raw file off disk. The distinction is the whole point: the raw file was
 * always fresh, which is why the bug survived a first look.
 */
const fetchModule = async (file) => await (await fetch(`${origin}/${file}?import`)).text();

/** Writes the way the dev API does: temp file, then rename. */
function saveJson(file, data) {
  const target = path.join(project, file);
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(`${target}.tmp`, target);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 1200));

test("editor-authored data after a save", async (t) => {
  await t.test("scene.json comes back fresh from the module graph", async () => {
    // The file behind the gizmo, and the one the reported bug was about.
    const before = await fetchModule("src/game/scene.json");
    assert.ok(!before.includes("Level/Crate"), "the fixture value was already there");

    saveJson("src/game/scene.json", {
      version: 1,
      objects: [{ objectPath: "Level/Crate", objectName: "Crate", position: [5, 2, -3] }],
    });
    await settle();

    const after = await fetchModule("src/game/scene.json");
    assert.match(after, /Level\/Crate/, "a browser reload would still see the old scene.json");
    assert.match(after, /"?position"?/, "the served module does not contain the saved data");
  });

  await t.test("environment.json comes back fresh", async () => {
    // Camera, lighting and world settings had the same bug for the same
    // reason, which is why they were reported as lost too.
    const file = path.join(project, "src", "game", "environment.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.camera = { ...(data.camera ?? {}), fov: 61.5 };
    saveJson("src/game/environment.json", data);
    await settle();
    assert.match(await fetchModule("src/game/environment.json"), /61\.5/, "a reload would still see the old camera settings");
  });

  await t.test("colliders.json and particles.json come back fresh", async () => {
    saveJson("src/game/colliders.json", {
      version: 1,
      colliders: [{ id: "regression_zone", name: "RegressionZone", shape: "box", isTrigger: true, enabled: true, tag: "z", mask: [], size: [1, 1, 1], attachPath: "", attachName: "", offset: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
    });
    saveJson("src/game/particles.json", { version: 1, systems: [{ id: "regression_fx", name: "RegressionFx", emitters: [] }] });
    await settle();
    assert.match(await fetchModule("src/game/colliders.json"), /RegressionZone/);
    assert.match(await fetchModule("src/game/particles.json"), /RegressionFx/);
  });

  await t.test("a save does not trigger a hot update", async () => {
    // The other half. These files are imported by Game.ts, so an HMR update
    // would tear down the scene the editor is editing — taking the selection
    // and the undo history with it. The plugin declines the update; it must
    // not have started declining nothing.
    const socket = new WebSocket(origin.replace("http", "ws"), "vite-hmr");
    const messages = [];
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.addEventListener("message", (event) => {
      try { messages.push(JSON.parse(event.data)); } catch { /* not json */ }
    });

    saveJson("src/game/scene.json", { version: 1, objects: [{ objectPath: "Level/Lamp", objectName: "Lamp", visible: false }] });
    await settle();
    await settle();
    socket.close();

    const disruptive = messages.filter((message) => message.type === "full-reload" || message.type === "update");
    assert.deepEqual(disruptive, [], `saving scene.json triggered ${disruptive.map((m) => m.type).join(", ")} — the editor session would be torn down`);

    // …and the invalidation still happened.
    assert.match(await fetchModule("src/game/scene.json"), /Level\/Lamp/, "declining the hot update also lost the invalidation");
  });

  await t.test("an ordinary source file still hot-updates", async () => {
    // The plugin must be surgical. If it swallowed every update, editing
    // gameplay code would stop reloading and nobody would notice for a while.
    const socket = new WebSocket(origin.replace("http", "ws"), "vite-hmr");
    const messages = [];
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.addEventListener("message", (event) => {
      try { messages.push(JSON.parse(event.data)); } catch { /* not json */ }
    });
    // Prime the module graph so the file has importers to update.
    await fetchModule("src/game/world/World.ts");

    const file = path.join(project, "src", "game", "world", "World.ts");
    fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}\n// touched by tests/dev-server-data.test.mjs\n`);
    await settle();
    await settle();
    socket.close();

    assert.ok(
      messages.some((message) => message.type === "update" || message.type === "full-reload"),
      "editing a normal source file no longer triggers HMR — the plugin is too broad"
    );
  });
});
