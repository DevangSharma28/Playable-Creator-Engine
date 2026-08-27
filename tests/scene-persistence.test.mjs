/**
 * 3D-editor scene edits must survive a full page reload.
 *
 * The bug this suite exists for: moving an object with the gizmo updated the
 * running game and then vanished on reload, while camera/lighting/world
 * settings persisted fine. It read like a cache — it was not. Object
 * transforms, visibility, names and parenting had no file behind them at all.
 * They were live mutations of `THREE.Object3D` instances, and every one of
 * those is rebuilt from the model on the next boot.
 *
 * So the shape of every test here is the round trip a person actually
 * performs: build a scene, change it the way the editor does, serialize what
 * the Save button would send, throw the whole game away, boot a *new* one with
 * that data, and assert the new scene matches the old one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { bootGame } from "./lib/boot.mjs";
import { loadRuntime } from "./lib/runtime-bundle.mjs";

const runtime = await loadRuntime();
const { snapshotScene, captureSceneOverrides, applySceneOverrides, loadSceneEnv, serializeSceneEnv, cloneSceneEnv, defaultSceneEnv } = runtime;

/** A scene shaped like a loaded GLB: nested, named, a couple of meshes. */
function buildLevel() {
  const scene = new THREE.Scene();
  const level = new THREE.Object3D();
  level.name = "Level";
  const crate = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  crate.name = "Crate";
  crate.position.set(1, 0, 1);
  const lamp = new THREE.Object3D();
  lamp.name = "Lamp";
  lamp.position.set(-4, 3, 0);
  const props = new THREE.Object3D();
  props.name = "Props";
  level.add(crate, lamp);
  scene.add(level, props);
  return { scene, level, crate, lamp, props };
}

/** The full round trip: capture what Save would write, JSON it, apply to a fresh scene. */
function reload(edit) {
  const first = buildLevel();
  const baseline = snapshotScene(first.scene);
  edit(first);
  const written = JSON.parse(JSON.stringify({ version: 1, objects: captureSceneOverrides(first.scene, baseline) }));

  const second = buildLevel();
  applySceneOverrides(second.scene, written);
  return { before: first, after: second, written };
}

test("scene overrides survive a reload", async (t) => {
  await t.test("a moved object comes back where it was left", () => {
    const { after, written } = reload(({ crate }) => crate.position.set(5, 2, -3));
    assert.equal(written.objects.length, 1, "only the object that changed should be written");
    assert.deepEqual(written.objects[0].position, [5, 2, -3]);
    const crate = after.scene.getObjectByName("Crate");
    assert.deepEqual([crate.position.x, crate.position.y, crate.position.z], [5, 2, -3]);
  });

  await t.test("rotation round-trips through degrees", () => {
    const { after } = reload(({ crate }) => crate.rotation.set(0, Math.PI / 2, 0));
    const crate = after.scene.getObjectByName("Crate");
    assert.ok(Math.abs(crate.rotation.y - Math.PI / 2) < 1e-9, `rotation came back as ${crate.rotation.y}`);
  });

  await t.test("scale survives", () => {
    const { after } = reload(({ crate }) => crate.scale.set(2, 0.5, 3));
    const crate = after.scene.getObjectByName("Crate");
    assert.deepEqual([crate.scale.x, crate.scale.y, crate.scale.z], [2, 0.5, 3]);
  });

  await t.test("visibility survives", () => {
    const { after, written } = reload(({ lamp }) => { lamp.visible = false; });
    assert.equal(written.objects[0].visible, false);
    assert.equal(after.scene.getObjectByName("Lamp").visible, false);
  });

  await t.test("a rename survives, and is keyed by the original path", () => {
    const { after, written } = reload(({ crate }) => { crate.name = "TreasureChest"; });
    assert.equal(written.objects[0].objectPath, "Level/Crate", "the key must be the pre-rename path");
    assert.equal(written.objects[0].name, "TreasureChest");
    assert.ok(after.scene.getObjectByName("TreasureChest"), "the renamed object is not in the reloaded scene");
    assert.equal(after.scene.getObjectByName("Crate"), undefined);
  });

  await t.test("re-parenting survives", () => {
    const { after, written } = reload(({ crate, props }) => props.add(crate));
    assert.equal(written.objects[0].parentPath, "Props");
    const crate = after.scene.getObjectByName("Crate");
    assert.equal(crate.parent.name, "Props", `crate came back under ${crate.parent.name}`);
  });

  await t.test("several edits to several objects all survive together", () => {
    const { after } = reload(({ crate, lamp, props }) => {
      crate.position.set(9, 1, 9);
      crate.name = "Chest";
      lamp.visible = false;
      lamp.scale.set(2, 2, 2);
      props.position.set(-7, 0, 0);
    });
    const chest = after.scene.getObjectByName("Chest");
    assert.deepEqual([chest.position.x, chest.position.y, chest.position.z], [9, 1, 9]);
    const lamp = after.scene.getObjectByName("Lamp");
    assert.equal(lamp.visible, false);
    assert.equal(lamp.scale.x, 2);
    assert.equal(after.scene.getObjectByName("Props").position.x, -7);
  });

  await t.test("an untouched scene writes nothing", () => {
    // A save that writes every node would freeze the artist's model: a later
    // export with a moved prop would be silently overridden back.
    const { written } = reload(() => {});
    assert.deepEqual(written.objects, []);
  });

  await t.test("selecting an object without moving it is not a change", () => {
    // Reading a transform and writing the identical value back is what an
    // Inspector field does on focus. With an exact comparison, that alone
    // would mark the scene dirty forever.
    const { written } = reload(({ crate }) => {
      crate.position.set(crate.position.x, crate.position.y, crate.position.z);
      crate.updateMatrixWorld(true);
    });
    assert.deepEqual(written.objects, []);
  });

  await t.test("saving twice in a row is idempotent", () => {
    const first = buildLevel();
    const baseline = snapshotScene(first.scene);
    first.crate.position.set(3, 3, 3);
    const once = captureSceneOverrides(first.scene, baseline);

    // A second boot that loads those overrides and saves again must produce
    // the same file — otherwise every session would rewrite or lose history.
    const second = buildLevel();
    const secondBaseline = snapshotScene(second.scene);
    applySceneOverrides(second.scene, { version: 1, objects: once });
    const twice = captureSceneOverrides(second.scene, secondBaseline);
    assert.deepEqual(twice, once, "a load-then-save cycle changed the file");
  });

  await t.test("undoing back to the start clears the override", () => {
    const first = buildLevel();
    const baseline = snapshotScene(first.scene);
    first.crate.position.set(4, 4, 4);
    assert.equal(captureSceneOverrides(first.scene, baseline).length, 1);
    first.crate.position.set(1, 0, 1); // what Undo does
    assert.deepEqual(captureSceneOverrides(first.scene, baseline), [], "an undone edit still counted as a change");
  });
});

test("only what the session actually touched is written", async (t) => {
  // A game animates things. Coins spin, characters walk. Every one of those
  // differs from the load-time baseline the moment the editor opens, through
  // nobody's authoring — and writing them turned a single gizmo drag into a
  // 55-entry file that froze the animation's last frame into the next boot.
  await t.test("an object the game animated is not mistaken for an edit", () => {
    const level = buildLevel();
    const loadBaseline = snapshotScene(level.scene);

    // Time passes; gameplay moves things.
    level.lamp.position.set(0, 5, 0);
    level.lamp.rotation.set(0, 1.2, 0);

    // Now the editor opens and the user moves exactly one object.
    const sessionBaseline = snapshotScene(level.scene);
    level.crate.position.set(7, 0, 0);

    const written = captureSceneOverrides(level.scene, loadBaseline, { touchedSince: sessionBaseline });
    assert.equal(written.length, 1, `expected one override, got ${JSON.stringify(written.map((w) => w.objectPath))}`);
    assert.equal(written[0].objectPath, "Level/Crate");
    assert.deepEqual(written[0].position, [7, 0, 0]);
  });

  await t.test("a record the file already had survives a session that did not touch it", () => {
    // Otherwise opening the editor, moving one thing and saving would silently
    // delete every override authored in an earlier session.
    const level = buildLevel();
    const loadBaseline = snapshotScene(level.scene);
    // What a previous session saved, applied at boot.
    applySceneOverrides(level.scene, { version: 1, objects: [{ objectPath: "Level/Lamp", objectName: "Lamp", visible: false }] });

    const sessionBaseline = snapshotScene(level.scene);
    level.crate.position.set(7, 0, 0);

    const written = captureSceneOverrides(level.scene, loadBaseline, {
      touchedSince: sessionBaseline,
      alsoKeep: new Set(["Level/Lamp"]),
    });
    const paths = written.map((entry) => entry.objectPath).sort();
    assert.deepEqual(paths, ["Level/Crate", "Level/Lamp"], "an earlier session's override was dropped");
    assert.equal(written.find((entry) => entry.objectPath === "Level/Lamp").visible, false);
  });

  await t.test("a re-parent during the session is detected", () => {
    const level = buildLevel();
    const loadBaseline = snapshotScene(level.scene);
    const sessionBaseline = snapshotScene(level.scene);
    level.props.add(level.crate);
    const written = captureSceneOverrides(level.scene, loadBaseline, { touchedSince: sessionBaseline });
    assert.equal(written.length, 1);
    assert.equal(written[0].parentPath, "Props");
  });

  await t.test("a rename during the session is detected", () => {
    const level = buildLevel();
    const loadBaseline = snapshotScene(level.scene);
    const sessionBaseline = snapshotScene(level.scene);
    level.crate.name = "Chest";
    const written = captureSceneOverrides(level.scene, loadBaseline, { touchedSince: sessionBaseline });
    assert.equal(written.length, 1);
    assert.equal(written[0].name, "Chest");
  });
});

test("the file is defensive", async (t) => {
  await t.test("a path that no longer exists is skipped, not fatal", () => {
    // Re-exporting the model with a renamed node is normal. Losing the boot
    // over it is not.
    const { scene } = buildLevel();
    assert.doesNotThrow(() =>
      applySceneOverrides(scene, { version: 1, objects: [{ objectPath: "Level/Gone", objectName: "Gone", position: [1, 1, 1] }] })
    );
  });

  await t.test("malformed input changes nothing and does not throw", () => {
    for (const input of [null, undefined, {}, { version: 1 }, { objects: "nope" }, { version: 1, objects: [null, 42, {}] }]) {
      const { scene, crate } = buildLevel();
      assert.doesNotThrow(() => applySceneOverrides(scene, input), `threw on ${JSON.stringify(input)}`);
      assert.deepEqual([crate.position.x, crate.position.y, crate.position.z], [1, 0, 1]);
    }
  });

  await t.test("a cyclic re-parent is refused rather than detaching the branch", () => {
    // Parenting Level under its own child would take the whole branch out of
    // the scene, and nothing would render.
    const { scene, level, crate } = buildLevel();
    applySceneOverrides(scene, { version: 1, objects: [{ objectPath: "Level", objectName: "Level", parentPath: "Level/Crate" }] });
    assert.equal(level.parent, scene, "Level was re-parented under its own descendant");
    assert.equal(crate.parent, level);
  });

  await t.test("engine-owned groups are never captured", () => {
    // Colliders and particles persist through their own files; capturing them
    // here would write the same data twice and let the two disagree.
    const { scene } = buildLevel();
    const colliders = new THREE.Object3D();
    colliders.name = "COLLIDERS";
    const volume = new THREE.Object3D();
    volume.name = "Zone";
    colliders.add(volume);
    scene.add(colliders);

    const baseline = snapshotScene(scene);
    volume.position.set(5, 5, 5);
    colliders.visible = false;
    assert.deepEqual(captureSceneOverrides(scene, baseline), []);
  });
});

test("the whole boot path, through a real engine", async (t) => {
  await t.test("edit → save → reload restores the identical scene", async () => {
    // The end-to-end claim, driven through IonEngine rather than around it:
    // boot, change the scene the way the gizmo does, capture what Save sends,
    // dispose the entire game, boot a fresh one with that data, compare.
    const first = await bootGame({
      game: ({ Game, ION }) => class Level1 extends Game {
        start() {
          const root = ION.scene.box({ name: "Platform", size: 4, y: -1 });
          const prop = ION.scene.box({ name: "Prop", size: 1, x: 2 });
          root.add(prop);
        }
      },
    });
    first.frames(2);

    const baseline = snapshotScene(first.game.world);
    const platform = first.game.world.getObjectByName("Platform");
    const prop = first.game.world.getObjectByName("Prop");
    platform.position.set(6, 1, -2);
    prop.visible = false;
    prop.name = "HiddenProp";

    const saved = JSON.parse(JSON.stringify({ version: 1, objects: captureSceneOverrides(first.game.world, baseline) }));
    assert.ok(saved.objects.length >= 2, `expected two overrides, got ${JSON.stringify(saved.objects)}`);

    // The live game is still correct — this is the half that already worked
    // and must not regress.
    assert.equal(first.game.world.getObjectByName("Platform").position.x, 6);
    first.dispose();

    // A full page reload: nothing survives but the file.
    const second = await bootGame({
      data: { scene: saved },
      game: ({ Game, ION }) => class Level2 extends Game {
        start() {
          const root = ION.scene.box({ name: "Platform", size: 4, y: -1 });
          const prop = ION.scene.box({ name: "Prop", size: 1, x: 2 });
          root.add(prop);
        }
      },
    });
    second.frames(2);

    const reloadedPlatform = second.game.world.getObjectByName("Platform");
    assert.ok(reloadedPlatform, "Platform is missing after reload");
    assert.deepEqual(
      [reloadedPlatform.position.x, reloadedPlatform.position.y, reloadedPlatform.position.z],
      [6, 1, -2],
      "the moved object did not come back where it was left"
    );
    const reloadedProp = second.game.world.getObjectByName("HiddenProp");
    assert.ok(reloadedProp, "the renamed object is missing after reload");
    assert.equal(reloadedProp.visible, false, "visibility did not survive the reload");
    second.dispose();
  });

  await t.test("camera, lighting and world settings survive the same reload", async () => {
    // These already persisted — asserted here so the two halves of "the editor
    // state is restored" are covered by one suite rather than assumed.
    const authored = cloneSceneEnv(defaultSceneEnv());
    authored.camera.fov = 73;
    authored.camera.position = [4, 9, 12];
    authored.camera.follow = false;
    authored.ambient.intensity = 0.42;
    authored.world.fogMode = "linear";
    authored.directionals[0].intensity = 2.75;

    const harness = await bootGame({
      data: { environment: JSON.parse(JSON.stringify(serializeSceneEnv(authored))) },
      game: ({ Game }) => class Env extends Game { start() {} },
    });
    harness.frames(2);

    assert.equal(harness.game.rig.perspective.fov, 73, "camera fov was not restored");
    assert.deepEqual(
      [harness.game.rig.camera.position.x, harness.game.rig.camera.position.y, harness.game.rig.camera.position.z],
      [4, 9, 12],
      "camera position was not restored"
    );
    const lights = [];
    harness.game.world.traverse((node) => { if (node.isLight) lights.push(node); });
    assert.ok(lights.some((light) => Math.abs(light.intensity - 2.75) < 1e-6), "directional intensity was not restored");
    assert.ok(lights.some((light) => Math.abs(light.intensity - 0.42) < 1e-6), "ambient intensity was not restored");
    assert.ok(harness.game.world.fog, "fog was not restored");
    harness.dispose();
  });

  await t.test("colliders and particles are unaffected by scene overrides", async () => {
    // Scene overrides are applied before both load, so a collider attached by
    // path still resolves and sees the final transform.
    const saved = { version: 1, objects: [{ objectPath: "Anchor", objectName: "Anchor", position: [8, 0, 0] }] };
    const harness = await bootGame({
      data: {
        scene: saved,
        colliders: {
          version: 1,
          colliders: [{
            id: "c1", name: "Zone", shape: "box", size: [2, 2, 2], isTrigger: true, enabled: true,
            tag: "zone", mask: [], attachPath: "Anchor", attachName: "Anchor",
            offset: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          }],
        },
      },
      game: ({ Game, ION }) => class Attached extends Game {
        start() { ION.scene.box({ name: "Anchor" }); }
      },
    });
    harness.frames(2);
    const zone = runtime.Ion.colliders.getByName("Zone");
    assert.ok(zone, "the collider did not load");
    assert.equal(zone.attached?.name, "Anchor", "the collider lost its attachment");
    assert.equal(harness.game.world.getObjectByName("Anchor").position.x, 8, "the override did not apply");
    // The collider follows the object, so it must have moved with it.
    harness.frames(2);
    assert.ok(Math.abs(zone.worldCenter.x - 8) < 1e-6, `the collider is at ${zone.worldCenter.x}, not on its anchor`);
    harness.dispose();
  });
});
