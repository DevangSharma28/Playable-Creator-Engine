/**
 * Behavioral tests for the scene environment runtime — the half of the
 * Environment dock that actually ships.
 *
 * Scope is deliberate. The panel itself is DOM, and the *look* of a light
 * is a thing you verify by looking at it; what's tested here is the part
 * that fails silently: whether a config reconciles into the right set of
 * live objects, whether loading a partial file fills the gaps instead of
 * writing `undefined` into a uniform, whether the camera rig's projection
 * math is what it claims, and whether restore() — the undo path — really
 * round-trips.
 *
 * Sources are bundled with esbuild for the same reason
 * tests/particles.test.mjs does it: they're TypeScript with sibling
 * imports and Node can't load them without a build step.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const ROOT = resolve(import.meta.dirname, "..");

async function loadEnvironment() {
  const dir = join(ROOT, "src", "engine", "scene");
  const result = await esbuild.build({
    stdin: {
      contents: `
        export { SceneEnvironment } from ${JSON.stringify(join(dir, "SceneEnvironment.ts"))};
        export { loadSceneEnv, serializeSceneEnv } from ${JSON.stringify(join(dir, "SceneEnvSerialization.ts"))};
        export { defaultSceneEnv, cloneSceneEnv } from ${JSON.stringify(join(dir, "SceneEnvDefaults.ts"))};
        export { CameraHandler } from ${JSON.stringify(join(ROOT, "src", "engine", "core", "CameraHandler.ts"))};
        export * as THREE from "three";
      `,
      resolveDir: dir,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2020",
    write: false,
    define: { "import.meta.env.DEV": "false" },
  });
  const out = mkdtempSync(join(tmpdir(), "ion-env-"));
  const outFile = join(out, "environment.mjs");
  writeFileSync(outFile, result.outputFiles[0].text, "utf8");
  return import(pathToFileURL(outFile).href);
}

const mod = await loadEnvironment();
const { SceneEnvironment, loadSceneEnv, defaultSceneEnv, cloneSceneEnv, CameraHandler, THREE } = mod;

/**
 * The smallest renderer the environment actually writes to.
 *
 * SceneEnvironment only ever sets properties on it (tone mapping, exposure,
 * the shadow-map block) — it never renders — so a plain object is a
 * faithful stand-in, and using one keeps these tests off a GL context.
 * PMREMGenerator is the one thing that would need a real renderer, and it's
 * only constructed when environmentSource leaves "none"; the test below
 * pins that so this stub can't silently stop being enough.
 */
function stubRenderer() {
  return {
    toneMapping: 0,
    toneMappingExposure: 1,
    shadowMap: { enabled: false, type: 0, needsUpdate: false },
  };
}

function makeEnv(data) {
  const scene = new THREE.Scene();
  const renderer = stubRenderer();
  const rig = new CameraHandler((data ?? defaultSceneEnv()).camera);
  const environment = new SceneEnvironment({ scene, renderer, rig }, data);
  environment.apply();
  return { scene, renderer, rig, environment };
}

function lightsOfType(scene, predicate) {
  const found = [];
  scene.traverse((o) => {
    if (predicate(o)) found.push(o);
  });
  return found;
}

// ---------------------------------------------------------------- loading

test("loadSceneEnv fills every missing field from the defaults", () => {
  const loaded = loadSceneEnv({ world: { fogNear: 5 } });
  assert.equal(loaded.world.fogNear, 5, "an authored value survives");
  assert.equal(loaded.world.fogFar, defaultSceneEnv().world.fogFar, "an absent sibling falls back");
  assert.equal(loaded.camera.fov, defaultSceneEnv().camera.fov);
  assert.equal(loaded.directionals.length, defaultSceneEnv().directionals.length);
  for (const key of Object.keys(defaultSceneEnv().world)) {
    assert.notEqual(loaded.world[key], undefined, `world.${key} must never load as undefined`);
  }
});

test("loadSceneEnv survives junk without throwing", () => {
  for (const junk of [null, undefined, 42, "nope", []]) {
    const loaded = loadSceneEnv(junk);
    assert.equal(loaded.version, 1);
    assert.equal(typeof loaded.camera.fov, "number");
  }
});

test("loadSceneEnv gives an id-less light a stable id rather than dropping it", () => {
  const loaded = loadSceneEnv({ directionals: [{ name: "Key", intensity: 3 }] });
  assert.equal(loaded.directionals.length, 1);
  assert.equal(loaded.directionals[0].intensity, 3);
  assert.ok(loaded.directionals[0].id, "an unaddressable light would be uneditable and unundoable");
});

// ----------------------------------------------------------------- lights

test("the shipped defaults reproduce the lighting World.ts used to hardcode", () => {
  const { scene } = makeEnv();
  const ambient = lightsOfType(scene, (o) => o.isAmbientLight);
  const directional = lightsOfType(scene, (o) => o.isDirectionalLight);
  assert.equal(ambient.length, 1);
  assert.equal(directional.length, 2);
  assert.equal(ambient[0].intensity, 0.7);
  const sun = directional.find((l) => l.name === "Sun");
  assert.ok(sun);
  assert.equal(sun.intensity, 1.2);
  assert.deepEqual(sun.position.toArray(), [6, 12, 6]);
  assert.equal(sun.castShadow, false, "the old setup cast no shadows; the default must not start casting on its own");
});

test("switching ambient to hemisphere swaps the light rather than adding one", () => {
  const { scene, environment } = makeEnv();
  environment.updateAmbient({ mode: "hemisphere", groundColor: [0.1, 0.2, 0.3] });
  assert.equal(lightsOfType(scene, (o) => o.isAmbientLight).length, 0);
  const hemi = lightsOfType(scene, (o) => o.isHemisphereLight);
  assert.equal(hemi.length, 1);
  assert.ok(Math.abs(hemi[0].groundColor.b - 0.3) < 1e-6);

  environment.updateAmbient({ mode: "ambient" });
  assert.equal(lightsOfType(scene, (o) => o.isHemisphereLight).length, 0);
  assert.equal(lightsOfType(scene, (o) => o.isAmbientLight).length, 1);
});

test("disabling ambient removes its light entirely", () => {
  const { scene, environment } = makeEnv();
  environment.updateAmbient({ enabled: false });
  assert.equal(lightsOfType(scene, (o) => o.isAmbientLight).length, 0);
  environment.updateAmbient({ enabled: true });
  assert.equal(lightsOfType(scene, (o) => o.isAmbientLight).length, 1);
});

test("adding and removing directionals reconciles the scene", () => {
  const { scene, environment } = makeEnv();
  const added = environment.addDirectional({ name: "Rim" });
  assert.equal(lightsOfType(scene, (o) => o.isDirectionalLight).length, 3);
  assert.ok(lightsOfType(scene, (o) => o.isDirectionalLight).some((l) => l.name === "Rim"));

  assert.equal(environment.removeDirectional(added.id), true);
  assert.equal(lightsOfType(scene, (o) => o.isDirectionalLight).length, 2);
  assert.equal(environment.removeDirectional("not-a-real-id"), false);
});

test("a directional light's target is parented, so its direction is real", () => {
  const { environment } = makeEnv();
  environment.updateDirectional("sun", { target: [3, 0, -4] });
  const light = environment.lightRoot.children.find((c) => c.isDirectionalLight && c.name === "Sun");
  assert.ok(light);
  assert.ok(light.target.parent, "an unparented target leaves the light aiming at the origin whatever its config says");
  assert.deepEqual(light.target.position.toArray(), [3, 0, -4]);
});

test("shadow settings reach the light's own shadow camera", () => {
  const { environment } = makeEnv();
  environment.updateDirectional("sun", {
    castShadow: true,
    shadowMapSize: 2048,
    shadowBias: -0.001,
    shadowCameraExtent: 45,
    shadowCameraFar: 120,
  });
  const light = environment.lightRoot.children.find((c) => c.isDirectionalLight && c.name === "Sun");
  assert.equal(light.castShadow, true);
  assert.equal(light.shadow.mapSize.width, 2048);
  assert.equal(light.shadow.bias, -0.001);
  assert.equal(light.shadow.camera.right, 45);
  assert.equal(light.shadow.camera.left, -45);
  assert.equal(light.shadow.camera.far, 120);
});

// ------------------------------------------------------------------ world

test("fog modes swap the fog object and clear it on none", () => {
  const { scene, environment } = makeEnv();
  assert.ok(scene.fog instanceof THREE.Fog);
  assert.equal(scene.fog.near, 30);

  environment.updateWorld({ fogMode: "exp2", fogDensity: 0.05 });
  assert.ok(scene.fog instanceof THREE.FogExp2);
  assert.equal(scene.fog.density, 0.05);

  environment.updateWorld({ fogMode: "none" });
  assert.equal(scene.fog, null);
});

test("tone mapping and exposure reach the renderer", () => {
  const { renderer, environment } = makeEnv();
  assert.equal(renderer.toneMapping, THREE.NoToneMapping, "the default must not silently change how an existing playable looks");
  environment.updateWorld({ toneMapping: "aces", toneMappingExposure: 1.4 });
  assert.equal(renderer.toneMapping, THREE.ACESFilmicToneMapping);
  assert.equal(renderer.toneMappingExposure, 1.4);
});

test("the shadow-map recompile only fires when the setting actually changed", () => {
  const { renderer, environment } = makeEnv();
  renderer.shadowMap.needsUpdate = false;
  // Same value: nothing structural changed, so nothing should be flagged.
  environment.updateWorld({ shadowType: "pcfsoft" });
  assert.equal(renderer.shadowMap.needsUpdate, false, "recompiling every material on an unrelated edit would stall on every slider event");

  environment.updateWorld({ shadowType: "vsm" });
  assert.equal(renderer.shadowMap.type, THREE.VSMShadowMap);
  assert.equal(renderer.shadowMap.needsUpdate, true);
});

test("background modes drive scene.background", () => {
  const { scene, environment } = makeEnv();
  assert.ok(scene.background instanceof THREE.Color);
  environment.updateWorld({ backgroundMode: "none" });
  assert.equal(scene.background, null);
  environment.updateWorld({ backgroundMode: "color", backgroundColor: [0, 1, 0] });
  assert.ok(Math.abs(scene.background.g - 1) < 1e-6);
});

test("a texture background with an unresolvable path falls back to the colour, not to nothing", () => {
  const { scene, environment } = makeEnv();
  environment.updateWorld({ backgroundMode: "texture", backgroundTexture: "assets/nope.jpg", backgroundColor: [1, 0, 0] });
  assert.ok(scene.background instanceof THREE.Color, "an invisible scene reads as a broken engine; a wrong colour reads as a typo");
  assert.ok(Math.abs(scene.background.r - 1) < 1e-6);
});

test("the default config never touches PMREM, so a playable that wants no IBL pays for none of it", () => {
  const { scene } = makeEnv();
  assert.equal(scene.environment, null);
});

// --------------------------------------------------------------- undo path

test("restore() round-trips the whole config, including added and removed lights", () => {
  const { scene, environment } = makeEnv();
  const before = environment.snapshot();

  environment.addDirectional({ name: "Rim" });
  environment.updateAmbient({ mode: "hemisphere", intensity: 3 });
  environment.updateWorld({ fogMode: "none", toneMapping: "agx" });
  environment.removeDirectional("fill");
  const after = environment.snapshot();

  environment.restore(before);
  assert.equal(lightsOfType(scene, (o) => o.isDirectionalLight).length, 2);
  assert.equal(lightsOfType(scene, (o) => o.isHemisphereLight).length, 0);
  assert.equal(lightsOfType(scene, (o) => o.isAmbientLight).length, 1);
  assert.ok(scene.fog instanceof THREE.Fog);
  assert.deepEqual(environment.snapshot(), before);

  environment.restore(after);
  assert.deepEqual(environment.snapshot(), after);
  const names = lightsOfType(scene, (o) => o.isDirectionalLight).map((l) => l.name).sort();
  assert.deepEqual(names, ["Rim", "Sun"]);
});

test("a snapshot is detached — mutating the live config must not rewrite history", () => {
  const { environment } = makeEnv();
  const snap = environment.snapshot();
  environment.updateCamera({ offset: [99, 99, 99] });
  assert.deepEqual(snap.camera.offset, [0, 12, 12]);
});

// ----------------------------------------------------------------- camera

test("switching projection changes which camera the rig renders through", () => {
  const rig = new CameraHandler(defaultSceneEnv().camera);
  assert.equal(rig.camera, rig.perspective);
  rig.applyCameraConfig({ ...defaultSceneEnv().camera, projection: "orthographic" });
  assert.equal(rig.camera, rig.orthographic);
});

test("near/far/zoom apply to both cameras, so a projection switch is seamless", () => {
  const rig = new CameraHandler(defaultSceneEnv().camera);
  rig.applyCameraConfig({ ...defaultSceneEnv().camera, near: 0.3, far: 250, zoom: 1.5 });
  for (const camera of [rig.perspective, rig.orthographic]) {
    assert.equal(camera.near, 0.3);
    assert.equal(camera.far, 250);
    assert.equal(camera.zoom, 1.5);
  }
});

test("reference aspect widens FOV on a narrower viewport and leaves a wider one alone", () => {
  const base = { ...defaultSceneEnv().camera, fov: 50, referenceAspect: 16 / 9 };
  const rig = new CameraHandler(base);

  rig.handleResize(1600, 900); // exactly the reference aspect
  assert.ok(Math.abs(rig.perspective.fov - 50) < 1e-6);

  rig.handleResize(2400, 900); // wider — no correction
  assert.ok(Math.abs(rig.perspective.fov - 50) < 1e-6);

  rig.handleResize(900, 1600); // portrait — must widen
  assert.ok(rig.perspective.fov > 50, "a vertical FOV held constant is what collapses horizontal framing in portrait");

  // The correction's whole promise: horizontal half-angle is preserved.
  const horizontalHalf = (fov, aspect) => Math.atan(Math.tan((fov * Math.PI) / 180 / 2) * aspect);
  assert.ok(Math.abs(horizontalHalf(rig.perspective.fov, 900 / 1600) - horizontalHalf(50, 16 / 9)) < 1e-6);
});

test("referenceAspect 0 disables the correction entirely", () => {
  const rig = new CameraHandler({ ...defaultSceneEnv().camera, fov: 50, referenceAspect: 0 });
  rig.handleResize(400, 1600);
  assert.equal(rig.perspective.fov, 50);
});

test("the orthographic frustum takes its height from the config and its width from the viewport", () => {
  const rig = new CameraHandler({ ...defaultSceneEnv().camera, projection: "orthographic", orthoSize: 8 });
  rig.handleResize(1600, 800);
  assert.equal(rig.orthographic.top, 8);
  assert.equal(rig.orthographic.bottom, -8);
  assert.equal(rig.orthographic.right, 16);
  assert.equal(rig.orthographic.left, -16);
});

test("follow off leaves the authored transform alone across update()", () => {
  const rig = new CameraHandler({
    ...defaultSceneEnv().camera,
    follow: false,
    position: [1, 2, 3],
    rotation: [0, 90, 0],
  });
  rig.update(new THREE.Vector3(50, 0, 50), 0.016);
  assert.deepEqual(rig.camera.position.toArray(), [1, 2, 3]);
  assert.ok(Math.abs((rig.camera.rotation.y * 180) / Math.PI - 90) < 1e-6);
});

test("follow on converges toward focus + offset", () => {
  const rig = new CameraHandler(defaultSceneEnv().camera);
  const focus = new THREE.Vector3(10, 0, -6);
  for (let i = 0; i < 400; i++) rig.update(focus, 0.016);
  assert.ok(rig.camera.position.distanceTo(new THREE.Vector3(10, 12, 6)) < 0.01);
});

test("the idle camera tracks the active one, so the audio listener never strands", () => {
  const rig = new CameraHandler({ ...defaultSceneEnv().camera, projection: "orthographic" });
  const focus = new THREE.Vector3(4, 0, 4);
  for (let i = 0; i < 200; i++) rig.update(focus, 0.016);
  assert.ok(rig.perspective.position.distanceTo(rig.orthographic.position) < 1e-6);
  assert.ok(rig.perspective.matrixWorld.elements.some((n) => n !== 0));
});

// ---------------------------------------------------------------- teardown

test("dispose() releases every light it created", () => {
  const { scene, environment } = makeEnv();
  environment.dispose();
  assert.equal(lightsOfType(scene, (o) => o.isLight).length, 0, "a leaked set per hot reload is how a dev session ends up over-lit");
  assert.equal(scene.environment, null);
});
