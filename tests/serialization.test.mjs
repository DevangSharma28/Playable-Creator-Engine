/**
 * Round-tripping every file the ION editors write.
 *
 * These files are the client's work: colliders placed in the viewport,
 * particle systems tuned over an afternoon, an environment lit by hand, a UI
 * laid out element by element. A serializer that drops a field loses that work
 * silently — the editor still opens, the scene still renders, and one property
 * is simply back at its default with nothing to indicate it was ever set.
 *
 * So the shape of every test here is the same: build a non-default state, write
 * it, read it back into a fresh world, and assert the second state equals the
 * first. Partial and malformed input is tested alongside, because an older
 * project's file *is* partial input, and a hand-edited one is often malformed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { bootGame } from "./lib/boot.mjs";
import { installDom } from "./lib/dom-env.mjs";
import { loadRuntime } from "./lib/runtime-bundle.mjs";

// The particle system builds its render meshes and materials eagerly, which
// reaches for a canvas — so even the serializers need a DOM in scope.
const dom = installDom();
test.after(() => dom.restore());

const runtime = await loadRuntime();
const {
  loadSceneEnv, serializeSceneEnv, defaultSceneEnv, cloneSceneEnv,
  loadColliders, ColliderManager, loadParticles, serializeParticles, ParticleManager,
  applySceneBindings, sceneObjectPath, resolveSceneObject, UILayout, EMPTY_LAYOUT,
} = runtime;

test("scene environment", async (t) => {
  await t.test("a fully authored environment survives a round trip", () => {
    const authored = cloneSceneEnv(defaultSceneEnv());
    authored.camera.projection = "orthographic";
    authored.camera.fov = 42;
    authored.camera.near = 0.25;
    authored.camera.far = 512;
    authored.camera.zoom = 1.75;
    authored.camera.position = [3, 9, -4];
    authored.camera.rotation = [-30, 15, 5];
    authored.camera.offset = [0, 12, 14];
    authored.camera.follow = false;
    authored.camera.damping = 4.5;
    authored.camera.orthoSize = 8;
    authored.camera.referenceAspect = 0.5625;
    authored.camera.lookAtHeight = 1.2;
    authored.ambient.mode = "hemisphere";
    authored.ambient.intensity = 0.65;
    authored.ambient.skyColor = [0.2, 0.4, 0.9];
    authored.ambient.groundColor = [0.3, 0.2, 0.1];
    authored.world.backgroundMode = "texture";
    authored.world.backgroundTexture = "./assets/image/sky.png";
    authored.world.backgroundBlurriness = 0.35;
    authored.world.fogMode = "exp2";
    authored.world.fogDensity = 0.014;
    authored.world.toneMappingExposure = 1.4;
    authored.world.toneMapping = "ACESFilmic";
    authored.directionals[0].intensity = 2.25;
    authored.directionals[0].castShadow = true;
    authored.directionals[0].shadowBias = -0.0007;

    const restored = loadSceneEnv(JSON.parse(JSON.stringify(serializeSceneEnv(authored))));
    assert.deepEqual(restored, authored);
  });

  await t.test("a file with only one field keeps the defaults for the rest", () => {
    const restored = loadSceneEnv({ version: 1, camera: { fov: 80 } });
    assert.equal(restored.camera.fov, 80);
    assert.equal(restored.camera.near, defaultSceneEnv().camera.near);
    assert.ok(Array.isArray(restored.directionals));
  });

  await t.test("garbage in is defaults out, not undefined in a uniform", () => {
    for (const nonsense of [null, undefined, 42, "nope", [], { camera: "not an object" }]) {
      const restored = loadSceneEnv(nonsense);
      assert.equal(typeof restored.camera.fov, "number", `${JSON.stringify(nonsense)} produced a non-numeric fov`);
      assert.ok(Number.isFinite(restored.world.toneMappingExposure), `${JSON.stringify(nonsense)} produced a non-numeric exposure`);
    }
  });

  await t.test("serialize is stable — the same data twice produces the same JSON", () => {
    const data = loadSceneEnv({ version: 1 });
    assert.equal(JSON.stringify(serializeSceneEnv(data)), JSON.stringify(serializeSceneEnv(data)));
  });

  await t.test("a round trip through the live scene reproduces the same lights", async () => {
    const authored = cloneSceneEnv(defaultSceneEnv());
    authored.ambient.mode = "hemisphere";
    authored.directionals[0].castShadow = true;

    const first = await bootGame({
      data: { environment: serializeSceneEnv(authored) },
      game: ({ Game }) => class E extends Game { start() {} },
    });
    const describe = (game) => {
      const lights = [];
      game.world.traverse((node) => { if (node.isLight) lights.push(`${node.type}:${node.intensity}`); });
      return lights.sort();
    };
    const before = describe(first.game);
    const serialized = serializeSceneEnv(loadSceneEnv(serializeSceneEnv(authored)));
    first.dispose();

    const second = await bootGame({
      data: { environment: serialized },
      game: ({ Game }) => class E2 extends Game { start() {} },
    });
    assert.deepEqual(describe(second.game), before);
    second.dispose();
  });
});

test("colliders", async (t) => {
  /** The same save path the editor's Exit Editor button uses. */
  const serializeCollider = (collider, scene) => runtime.colliderToData(collider, scene);

  function world() {
    const scene = new THREE.Scene();
    const anchor = new THREE.Object3D();
    anchor.name = "Anchor";
    anchor.position.set(2, 0, -3);
    scene.add(anchor);
    return { scene, anchor };
  }

  const offset = (position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) => ({ position, rotation, scale });
  const authored = {
    version: 1,
    colliders: [
      { id: "c1", name: "Goal", tag: "goal", mask: [], shape: "box", isTrigger: true, enabled: true, size: [4, 2, 4], attachPath: "Anchor", attachName: "Anchor", offset: offset([1, 0.5, -2], [0, 45, 0]) },
      { id: "c2", name: "Ball", tag: "ball", mask: ["goal"], shape: "sphere", isTrigger: false, enabled: true, radius: 1.25, attachPath: "", attachName: "", offset: offset([-3, 1, 0]) },
      { id: "c3", name: "Post", tag: "post", mask: [], shape: "cylinder", isTrigger: false, enabled: false, radius: 0.4, height: 3, attachPath: "", attachName: "", offset: offset([0, 1.5, 5]) },
    ],
  };

  await t.test("every shape, tag, flag and attachment survives a round trip", async () => {
    const { colliderToData } = await import("../packages/runtime/src/index.ts").catch(() => ({}));
    const { scene } = world();
    const manager = new ColliderManager();
    manager.attachToScene(scene);
    loadColliders(manager, JSON.parse(JSON.stringify(authored)), scene);
    assert.equal(manager.all.length, 3);

    // Save, then load into a fresh world, then save again. Comparing the two
    // saves is what catches a field the writer emits and the reader ignores —
    // a one-way test passes with the data already lost.
    const first = manager.all.map((collider) => serializeCollider(collider, scene));
    const secondScene = world().scene;
    const secondManager = new ColliderManager();
    secondManager.attachToScene(secondScene);
    loadColliders(secondManager, { version: 1, colliders: JSON.parse(JSON.stringify(first)) }, secondScene);
    const second = secondManager.all.map((collider) => serializeCollider(collider, secondScene));
    assert.deepEqual(second, first);
  });

  await t.test("loading reproduces shape, trigger flag, enabled state and tag", () => {
    const { scene } = world();
    const manager = new ColliderManager();
    manager.attachToScene(scene);
    loadColliders(manager, JSON.parse(JSON.stringify(authored)), scene);

    const goal = manager.getByName("Goal");
    assert.ok(goal);
    assert.equal(goal.tag, "goal");
    assert.equal(goal.isTrigger, true);
    assert.equal(goal.attached?.name, "Anchor", "the attachment path did not resolve");

    const post = manager.getByName("Post");
    assert.equal(post.enabled, false, "a disabled collider loaded enabled");

    const ball = manager.getByName("Ball");
    assert.equal(ball.isTrigger, false);
  });

  await t.test("an empty file loads to an empty registry rather than throwing", () => {
    const { scene } = world();
    const manager = new ColliderManager();
    manager.attachToScene(scene);
    assert.doesNotThrow(() => loadColliders(manager, { version: 1, colliders: [] }, scene));
    assert.equal(manager.all.length, 0);
  });

  await t.test("a collider whose attachment no longer exists still loads", () => {
    // Renaming a node in the editor is normal. Losing every collider in the
    // file because one path went stale is not.
    const { scene } = world();
    const manager = new ColliderManager();
    manager.attachToScene(scene);
    const orphaned = { version: 1, colliders: [{ ...authored.colliders[0], attachPath: "Nonexistent/Deep/Path" }] };
    assert.doesNotThrow(() => loadColliders(manager, orphaned, scene));
    assert.equal(manager.all.length, 1);
  });

  await t.test("malformed records are skipped, not fatal", () => {
    const { scene } = world();
    const manager = new ColliderManager();
    manager.attachToScene(scene);
    const broken = { version: 1, colliders: [{ id: "ok", name: "Fine", shape: "box", size: [1, 1, 1], position: [0, 0, 0] }, null, { shape: "not-a-shape" }] };
    let loaded;
    assert.doesNotThrow(() => { loaded = loadColliders(manager, broken, scene); });
    assert.ok(manager.getByName("Fine"), "the valid record was lost along with the invalid ones");
  });
});

test("particles", async (t) => {
  await t.test("a system round-trips through save and load", () => {
    const scene = new THREE.Scene();
    const manager = new ParticleManager();
    manager.attachToScene(scene);

    // The real config is modular — main/emission/shape/renderer — matching what
    // the Particle Editor writes into src/game/particles.json.
    const authored = {
      version: 1,
      systems: [{
        id: "sys1",
        name: "Explosion",
        emitters: [{
          id: "em1",
          name: "Core",
          enabled: true,
          position: [0, 1, 0],
          rotation: [0, 45, 0],
          scale: [1, 1, 1],
          attachPath: "",
          attachName: "",
          main: { maxParticles: 250, startLifetime: { min: 0.4, max: 1.2 }, startSpeed: { min: 2, max: 6 }, simulationSpace: "world" },
          emission: { enabled: true, rateOverTime: { min: 45, max: 45 }, bursts: [] },
          shape: { kind: "sphere", radius: 1.5 },
          renderer: { blending: "additive", opacity: 0.8, renderOrder: 3 },
        }],
      }],
    };

    loadParticles(manager, JSON.parse(JSON.stringify(authored)), scene);
    const system = manager.getByName("Explosion");
    assert.ok(system, "the system did not load");

    const written = serializeParticles(manager, scene);
    assert.equal(written.length, 1);
    assert.equal(written[0].name, "Explosion");
    assert.equal(written[0].emitters.length, 1);
    assert.equal(written[0].emitters[0].main.maxParticles, 250, "an authored value was lost on save");
    assert.equal(written[0].emitters[0].emission.rateOverTime.min, 45);
    assert.equal(written[0].emitters[0].renderer.blending, "additive");
    assert.equal(written[0].emitters[0].renderer.opacity, 0.8);
    assert.deepEqual(written[0].emitters[0].position, [0, 1, 0], "the emitter transform was lost");

    // The second load is what proves the write is readable — a serializer that
    // emits a shape its own loader rejects passes a one-way test.
    const second = new ParticleManager();
    const secondScene = new THREE.Scene();
    second.attachToScene(secondScene);
    loadParticles(second, { version: 1, systems: JSON.parse(JSON.stringify(written)) }, secondScene);
    const reloaded = serializeParticles(second, secondScene);
    assert.deepEqual(reloaded, written, "a second round trip changed the data");
  });

  await t.test("an emitter with only a name gets defaults for everything else", () => {
    const scene = new THREE.Scene();
    const manager = new ParticleManager();
    manager.attachToScene(scene);
    loadParticles(manager, { version: 1, systems: [{ id: "s", name: "Sparse", emitters: [{ id: "e", name: "Only" }] }] }, scene);
    const [written] = serializeParticles(manager, scene);
    const emitter = written.emitters[0];
    assert.ok(Number.isFinite(emitter.main.maxParticles), "maxParticles came back non-numeric");
    assert.ok(Number.isFinite(emitter.emission.rateOverTime.min), "emission rate came back non-numeric");
    assert.ok(Number.isFinite(emitter.main.startLifetime.min));
    assert.ok(emitter.renderer && typeof emitter.renderer.blending === "string", "the renderer module came back without a blend mode");
    assert.ok(Number.isFinite(emitter.renderer.opacity));
  });

  await t.test("an empty or malformed file loads to an empty registry", () => {
    const scene = new THREE.Scene();
    const manager = new ParticleManager();
    manager.attachToScene(scene);
    for (const input of [{ version: 1, systems: [] }, { version: 1 }, {}]) {
      assert.doesNotThrow(() => loadParticles(manager, input, scene));
    }
    assert.equal(serializeParticles(manager, scene).length, 0);
  });
});

test("scene bindings", async (t) => {
  function world() {
    const scene = new THREE.Scene();
    const parent = new THREE.Object3D();
    parent.name = "Level";
    const child = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    child.name = "SpawnPoint";
    parent.add(child);
    scene.add(parent);
    return { scene, parent, child };
  }

  await t.test("a path written for an object resolves back to that object", () => {
    const { scene, child } = world();
    const binding = { className: "Game", fieldName: "spawn", objectPath: sceneObjectPath(child, scene), objectName: child.name };
    assert.equal(resolveSceneObject(scene, binding), child);
  });

  await t.test("a path survives an unrelated sibling being added", () => {
    const { scene, parent, child } = world();
    const path = sceneObjectPath(child, scene);
    const sibling = new THREE.Object3D();
    sibling.name = "Decoration";
    parent.add(sibling);
    assert.equal(resolveSceneObject(scene, { className: "Game", fieldName: "spawn", objectPath: path, objectName: child.name }), child);
  });

  await t.test("a stale path resolves to nothing instead of the wrong object", () => {
    const { scene, child } = world();
    const path = sceneObjectPath(child, scene);
    child.name = "Renamed";
    assert.equal(resolveSceneObject(scene, { className: "Game", fieldName: "spawn", objectPath: path, objectName: "SpawnPoint" }), undefined);
  });

  await t.test("applying bindings assigns the field and leaves unbound fields alone", () => {
    const { scene, child } = world();
    const target = { spawn: undefined, untouched: "original" };
    applySceneBindings(target, "Game", {
      version: 1,
      bindings: [{ className: "Game", fieldName: "spawn", objectPath: sceneObjectPath(child, scene), objectName: child.name }],
    }, scene);
    assert.equal(target.spawn, child);
    assert.equal(target.untouched, "original");
  });

  await t.test("a binding for a different class is ignored", () => {
    const { scene, child } = world();
    const target = { spawn: undefined };
    applySceneBindings(target, "Game", {
      version: 1,
      bindings: [{ className: "SomethingElse", fieldName: "spawn", objectPath: sceneObjectPath(child, scene), objectName: child.name }],
    }, scene);
    assert.equal(target.spawn, undefined);
  });

  await t.test("an empty or malformed bindings file changes nothing", () => {
    const { scene } = world();
    const target = { spawn: "untouched" };
    // `{version:1}` and `{}` are what a truncated write leaves behind. They
    // used to throw "data.bindings is not iterable" out of the constructor.
    for (const input of [{ version: 1, bindings: [] }, { version: 1 }, {}, null, undefined, { bindings: "nope" }]) {
      assert.doesNotThrow(() => applySceneBindings(target, "Game", input, scene), `threw on ${JSON.stringify(input)}`);
    }
    assert.equal(target.spawn, "untouched");
  });
});

test("UI layouts", async (t) => {
  const authored = {
    version: 1,
    canvasWidth: 400,
    canvasHeight: 711,
    elements: [
      { id: "t", name: "Score", type: "text", x: 12, y: 18, width: 140, height: 40, text: "0", visible: true, opacity: 0.9, renderOrder: 2 },
      { id: "b", name: "Install", type: "button", x: 40, y: 600, width: 320, height: 88, text: "Install", visible: true, opacity: 1, renderOrder: 5 },
      { id: "h", name: "Hidden", type: "sprite", x: 0, y: 0, width: 10, height: 10, visible: false, opacity: 1, renderOrder: 1 },
    ],
  };

  function mount(layout) {
    const host = globalThis.document.createElement("div");
    globalThis.document.body.appendChild(host);
    return new UILayout(host, JSON.parse(JSON.stringify(layout)));
  }

  await t.test("every declared element is built, including hidden ones", async () => {
    const harness = await bootGame({ data: { mainLayout: authored }, game: ({ Game }) => class U extends Game { start() {} } });
    const layer = harness.env.document.getElementById("custom-ui-layer");
    assert.equal(layer.children.length, authored.elements.length);
    assert.match(layer.textContent, /Install/);
    harness.dispose();
  });

  await t.test("an empty layout renders nothing and does not throw", async () => {
    const harness = await bootGame({ data: { mainLayout: EMPTY_LAYOUT }, game: ({ Game }) => class U extends Game { start() {} } });
    assert.equal(harness.env.document.getElementById("custom-ui-layer").children.length, 0);
    harness.dispose();
  });

  await t.test("a missing layout falls back to an empty one rather than crashing the boot", async () => {
    const harness = await bootGame({ data: {}, game: ({ Game }) => class U extends Game { start() {} } });
    assert.ok(harness.game.ui);
    assert.equal(harness.env.document.getElementById("custom-ui-layer").children.length, 0);
    harness.dispose();
  });

  await t.test("the same layout produces the same DOM twice", async () => {
    const first = await bootGame({ data: { mainLayout: authored }, game: ({ Game }) => class U extends Game { start() {} } });
    const firstHtml = first.env.document.getElementById("custom-ui-layer").innerHTML;
    first.dispose();
    const second = await bootGame({ data: { mainLayout: authored }, game: ({ Game }) => class U2 extends Game { start() {} } });
    assert.equal(second.env.document.getElementById("custom-ui-layer").innerHTML, firstHtml);
    second.dispose();
  });

  await t.test("rescaling for a different viewport keeps every element", async () => {
    const harness = await bootGame({ dom: { width: 400, height: 711 }, data: { mainLayout: authored }, game: ({ Game }) => class U extends Game { start() {} } });
    const layer = harness.env.document.getElementById("custom-ui-layer");
    for (const [width, height] of [[400, 711], [800, 400], [1920, 1080], [320, 1400]]) {
      harness.env.resize(width, height);
      harness.frames(1);
      assert.equal(layer.children.length, authored.elements.length, `elements lost at ${width}x${height}`);
    }
    harness.dispose();
  });
});

test("project configuration", async (t) => {
  const { loadConfig, DEFAULTS } = await import("../packages/project/lib/config.mjs");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  await t.test("a config written from defaults reads back as those defaults", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ion-cfg-rt-"));
    fs.writeFileSync(path.join(dir, "ion.config.json"), JSON.stringify(DEFAULTS, null, 2));
    const loaded = loadConfig(dir);
    assert.deepEqual(loaded, DEFAULTS);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test("loading is idempotent — writing what was read changes nothing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ion-cfg-rt-"));
    fs.writeFileSync(path.join(dir, "ion.config.json"), JSON.stringify({ name: "round", build: { budgetBytes: 2048 } }));
    const once = loadConfig(dir);
    fs.writeFileSync(path.join(dir, "ion.config.json"), JSON.stringify(once, null, 2));
    assert.deepEqual(loadConfig(dir), once);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
