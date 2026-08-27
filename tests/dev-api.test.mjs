/**
 * The dev API the ION editors save through.
 *
 * Every editor in ION Studio persists by POSTing to this server, so it is the
 * one process standing between a client's afternoon of work and their file
 * system. What is tested here is that contract: that a save lands, that a bad
 * save is refused rather than half-applied, that the endpoints the editors
 * actually call exist and answer in the shape the editors read, and that
 * nothing here will write outside the project.
 *
 * Runs against a real server process on a port the OS picked, in a throwaway
 * copy of a project — never the configured 8001, which on any working machine
 * belongs to whatever the developer is actually running.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

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

/** A minimal project tree the API can read and write, so no test touches the real one. */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ion-api-"));
  fs.mkdirSync(path.join(dir, "src", "game", "ui"), { recursive: true });
  const game = path.join(dir, "src", "game");
  fs.writeFileSync(path.join(game, "colliders.json"), JSON.stringify({ version: 1, colliders: [] }, null, 2));
  fs.writeFileSync(path.join(game, "particles.json"), JSON.stringify({ version: 1, systems: [] }, null, 2));
  fs.writeFileSync(path.join(game, "environment.json"), JSON.stringify({ version: 1 }, null, 2));
  fs.writeFileSync(path.join(game, "sceneBindings.json"), JSON.stringify({ version: 1, bindings: [] }, null, 2));
  fs.writeFileSync(path.join(game, "ui", "bindings.json"), JSON.stringify({ version: 1, bindings: [] }, null, 2));
  fs.writeFileSync(path.join(game, "ui", "mainLayout.json"), JSON.stringify({ version: 1, canvasWidth: 400, canvasHeight: 711, elements: [] }, null, 2));
  fs.writeFileSync(path.join(game, "ui", "endcardLayout.json"), JSON.stringify({ version: 1, canvasWidth: 400, canvasHeight: 711, elements: [] }, null, 2));
  fs.writeFileSync(path.join(game, "Game.ts"), `export default class Game {\n  public speed: number = 5;\n}\n`);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "api-fixture", version: "9.9.9" }, null, 2));
  return dir;
}

let server;
let origin;
let projectDir;

test.before(async () => {
  projectDir = makeProject();
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(ROOT, "scripts", "dev-build-api.js")], {
    cwd: ROOT,
    stdio: "ignore",
    env: { ...process.env, ION_PROJECT_ROOT: projectDir, ION_API_PORT: String(port), ION_DEV_ORIGINS: origin },
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await fetch(`${origin}/version`);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error("the dev API never came up");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

test.after(() => {
  server?.kill("SIGTERM");
  if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
});

const get = (route) => fetch(`${origin}${route}`);
const post = (route, body) =>
  fetch(`${origin}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const readProjectJson = (relative) => JSON.parse(fs.readFileSync(path.join(projectDir, relative), "utf8"));

test("basics", async (t) => {
  await t.test("/version reports the engine and the project separately", async () => {
    const response = await get("/version");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.version, "no ION version");
    assert.equal(body.projectVersion, "9.9.9", "the project's own version was not read from its package.json");
  });

  await t.test("an unknown route 404s rather than hanging", async () => {
    const response = await get("/definitely-not-a-route");
    assert.equal(response.status, 404);
  });

  await t.test("every endpoint the editors call answers", async () => {
    for (const route of [
      "/list-layouts", "/list-scripts", "/list-logic-scripts", "/list-bindings",
      "/list-scene-bindings", "/list-colliders", "/list-particles", "/list-environment",
    ]) {
      const response = await get(route);
      assert.equal(response.status, 200, `${route} answered ${response.status}`);
      await response.json();
    }
  });

  await t.test("/list-scripts always reports both categories, even when one is empty", async () => {
    // The UI editor reads `.engine.length` and `.game.length` directly; a
    // missing key threw a TypeError that emptied the whole Scripts panel.
    const body = await (await get("/list-scripts")).json();
    assert.ok(Array.isArray(body.engine), "no engine category");
    assert.ok(Array.isArray(body.game), "no game category");
  });
});

test("saving", async (t) => {
  await t.test("a UI layout round-trips through save and load", async () => {
    const layout = {
      version: 1,
      canvasWidth: 400,
      canvasHeight: 711,
      elements: [{ id: "a", name: "Score", type: "text", anchor: "top-left", xUnit: "px", yUnit: "px", xPx: 10, yPx: 10, width: 100, height: 30, text: "0", visible: true, opacity: 1, rotation: 0, zIndex: 1, zOrder: 1, renderOrder: 1 }],
    };
    const saved = await (await post("/save-layout", { kind: "main", data: layout })).json();
    assert.equal(saved.ok, true);
    assert.deepEqual(readProjectJson("src/game/ui/mainLayout.json"), layout);

    const loaded = await (await get("/load-layout?kind=main")).json();
    assert.deepEqual(loaded, layout);
  });

  await t.test("colliders round-trip and reject a record with no shape", async () => {
    const colliders = [{ id: "c1", name: "Zone", shape: "box", isTrigger: true, enabled: true, tag: "zone", mask: [], size: [2, 2, 2], attachPath: "", attachName: "", offset: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }];
    const saved = await (await post("/save-colliders", { colliders })).json();
    assert.equal(saved.ok, true);
    assert.equal(saved.saved, 1);
    assert.deepEqual(readProjectJson("src/game/colliders.json").colliders, colliders);

    const rejected = await post("/save-colliders", { colliders: [{ name: "no id or shape" }] });
    assert.equal(rejected.status, 400);
    // The valid file must still be intact — a rejected save must not have
    // touched it on the way to failing.
    assert.deepEqual(readProjectJson("src/game/colliders.json").colliders, colliders);
  });

  await t.test("particles and environment round-trip", async () => {
    const systems = [{ id: "s1", name: "Sparks", emitters: [{ id: "e1", name: "Core", main: { maxParticles: 100 } }] }];
    assert.equal((await (await post("/save-particles", { systems })).json()).ok, true);
    assert.deepEqual(readProjectJson("src/game/particles.json").systems, systems);

    // Each save endpoint validates the shape it is given; an emitter with no
    // `main` module is a half-written system and is refused.
    const badParticles = await post("/save-particles", { systems: [{ id: "s2", name: "Broken", emitters: [{ name: "no id" }] }] });
    assert.equal(badParticles.status, 400);
    assert.deepEqual(readProjectJson("src/game/particles.json").systems, systems, "a rejected save modified the file");

    const environment = { camera: { fov: 55 }, ambient: { mode: "flat" }, world: { fogMode: "none" }, directionals: [{ id: "key", intensity: 2 }] };
    assert.equal((await (await post("/save-environment", environment)).json()).ok, true);
    assert.equal(readProjectJson("src/game/environment.json").camera.fov, 55);

    const badEnvironment = await post("/save-environment", { camera: { fov: 1 } });
    assert.equal(badEnvironment.status, 400, "an environment with no world block was accepted");
    assert.equal(readProjectJson("src/game/environment.json").camera.fov, 55, "a rejected save modified the file");
  });

  await t.test("scene bindings round-trip", async () => {
    // Batched: the editor flushes a whole session's picks in one request.
    const edits = [{ className: "Game", fieldName: "spawn", objectPath: "Level/Spawn", objectName: "Spawn" }];
    assert.equal((await (await post("/save-scene-bindings", { edits })).json()).ok, true);
    const saved = readProjectJson("src/game/sceneBindings.json").bindings;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fieldName, "spawn");
    assert.equal(saved[0].objectPath, "Level/Spawn");

    // Assigning the same field again replaces rather than stacks.
    await post("/save-scene-bindings", { edits: [{ className: "Game", fieldName: "spawn", objectPath: "Level/Other", objectName: "Other" }] });
    const replaced = readProjectJson("src/game/sceneBindings.json").bindings;
    assert.equal(replaced.length, 1, "the same field was bound twice");
    assert.equal(replaced[0].objectPath, "Level/Other");

    // And removing takes it back out.
    await post("/save-scene-bindings", { edits: [{ className: "Game", fieldName: "spawn", remove: true }] });
    assert.equal(readProjectJson("src/game/sceneBindings.json").bindings.length, 0);
  });

  await t.test("a malformed body is refused with a message, not a stack trace", async () => {
    const response = await fetch(`${origin}/save-colliders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.ok(typeof body.error === "string" && body.error.length > 0);
  });

  await t.test("a save leaves no temp files behind", async () => {
    // Saves are written to a sibling temp file and renamed, so a killed
    // process cannot truncate the client's work. The temp must never survive.
    await post("/save-particles", { systems: [] });
    const strays = fs.readdirSync(path.join(projectDir, "src", "game")).filter((name) => name.includes(".tmp"));
    assert.deepEqual(strays, []);
  });

  await t.test("a save never writes outside the project", async () => {
    // The layout filename is the only client-supplied path segment.
    for (const attempt of ["../../escape.json", "/etc/ion-escape.json", "..\\..\\escape.json", "....//escape.json", "a/../../escape.json"]) {
      const response = await post("/save-layout", { kind: "layout", filename: attempt, data: { version: 1, elements: [] } });
      const body = await response.json().catch(() => ({}));
      if (body.ok) {
        const written = path.resolve(projectDir, body.path);
        assert.ok(written.startsWith(projectDir + path.sep), `"${attempt}" escaped to ${body.path}`);
        assert.ok(!body.path.includes(".."), `"${attempt}" was accepted as ${body.path}, which still contains a dot segment`);
        assert.ok(!/[\\]/.test(body.path), `"${attempt}" was accepted as ${body.path}, which is a path on Windows`);
      }
      assert.ok(!fs.existsSync("/etc/ion-escape.json"), "a save escaped to an absolute path");
    }
  });
});

test("the build endpoint", async (t) => {
  await t.test("reports a missing pipeline as an actionable error, not a crash", async () => {
    // The fixture project has no build system installed, which is exactly the
    // state a client is in before `npm install`.
    const response = await post("/build", {});
    assert.ok([200, 400, 500].includes(response.status), `unexpected status ${response.status}`);
    const body = await response.json();
    if (body.ok === false) {
      assert.ok(typeof body.error === "string" && body.error.length > 10, "the error says nothing useful");
    }
  });

  await t.test("/build-report answers even with no build on disk", async () => {
    const response = await get("/build-report");
    assert.ok([200, 404].includes(response.status));
  });
});
