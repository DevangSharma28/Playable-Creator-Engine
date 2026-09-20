/**
 * The client-facing API: `Game`, `Entity` and `ION`.
 *
 * This is the surface a project is actually written against, so it is tested
 * the way a project uses it — a real game booted through the real engine,
 * driven a frame at a time — rather than against stand-ins for the host it
 * talks to. Several of the cases here exist because the behaviour they check
 * was silently wrong: shake did nothing while the camera followed, master
 * volume was applied twice, and every one-shot sound left its WebAudio nodes
 * connected for the life of the page.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { bootGame } from "./lib/boot.mjs";
import { loadRuntime } from "./lib/runtime-bundle.mjs";

const runtime = await loadRuntime();
const { ION } = runtime;

class SeededLoader extends runtime.AssetLoader {
  getAudio() { return { duration: 1, sampleRate: 44100, numberOfChannels: 1, length: 1024 }; }
}

/** Boots a game whose start() is supplied by the test. */
function scene(body, options = {}) {
  return bootGame({
    ...options,
    game: ({ Game }) => class Scratch extends Game {
      start() { body?.(this); }
    },
  });
}

test("Entity", async (t) => {
  await t.test("registers itself and receives start() then update()", async () => {
    const log = [];
    const harness = await bootGame({
      game: ({ Game, Entity }) => {
        class Tracked extends Entity {
          start() { log.push("start"); }
          update() { log.push("update"); }
          stop() { log.push("stop"); }
        }
        return class G extends Game { start() { this.tracked = new Tracked("T"); } };
      },
    });
    // start() is deferred rather than called from registerEntity — the
    // subclass constructor has not finished at that point, so its own fields
    // are still undefined. It is flushed at the end of creation, so it has
    // already run by the time the first frame arrives.
    assert.deepEqual(log, ["start"]);
    harness.frames(1);
    assert.deepEqual(log, ["start", "update"]);
    harness.frames(2);
    assert.deepEqual(log, ["start", "update", "update", "update"]);
    harness.game.tracked.destroy();
    harness.frames(1);
    assert.deepEqual(log.at(-1), "stop", "no update after destroy");
    harness.dispose();
  });

  await t.test("an entity created at module top level says what to do", async () => {
    const { Entity } = runtime;
    assert.throws(() => new Entity("Orphan"), /before the game existed/);
  });

  await t.test("position and scale are live views, rotation is degrees", async () => {
    const harness = await scene();
    const entity = new runtime.Entity("E");
    entity.position.y = 3;
    assert.equal(entity.object3D.position.y, 3);
    entity.rotation.y = 90;
    assert.ok(Math.abs(entity.object3D.rotation.y - Math.PI / 2) < 1e-9);
    assert.ok(Math.abs(entity.rotation.y - 90) < 1e-9, "reads back in degrees");
    entity.scale.set(2, 2, 2);
    assert.equal(entity.object3D.scale.x, 2);
    harness.dispose();
  });

  await t.test("the rotation view is the same object every read", async () => {
    // Rebuilding it per access allocated an object and seven closures on every
    // frame for anything that spins, which is a GC pause a playable cannot pay.
    const harness = await scene();
    const entity = new runtime.Entity("E");
    assert.equal(entity.rotation, entity.rotation);
    harness.dispose();
  });

  await t.test("moveTo/moveBy/rotateBy/lookAt/distanceTo behave and chain", async () => {
    const harness = await scene();
    const a = new runtime.Entity("A");
    const b = new runtime.Entity("B");
    assert.equal(a.moveTo(1, 2, 3), a, "chainable");
    assert.deepEqual([a.position.x, a.position.y, a.position.z], [1, 2, 3]);
    a.moveBy(1, 0, 0);
    assert.equal(a.position.x, 2);
    b.moveTo(2, 2, 3);
    assert.equal(a.distanceTo(b), 0);
    assert.equal(a.distanceTo({ x: 2, y: 2, z: 0 }), 3);
    a.rotateBy(0, 180, 0);
    assert.ok(Math.abs(a.rotation.y - 180) < 1e-9);
    harness.dispose();
  });

  await t.test("destroy is idempotent and unregisters exactly once", async () => {
    const harness = await scene();
    const entity = new runtime.Entity("Once");
    let stops = 0;
    entity.stop = () => { stops++; };
    entity.destroy();
    entity.destroy();
    assert.equal(stops, 1);
    assert.equal(entity.isDestroyed, true);
    harness.frames(1);
    harness.dispose();
  });

  await t.test("destroy frees the geometry and material of shapes it owns", async () => {
    // Asserted on the dispose calls rather than on live GL objects, because
    // whether a mesh was ever uploaded depends on frustum culling. The
    // end-to-end GL count is covered in tests/runtime-lifecycle.test.mjs.
    const harness = await scene();
    const entity = new runtime.Entity("Coin");
    const prop = ION.scene.box({ size: 0.4 });
    entity.shape = prop;
    let geometryDisposed = 0;
    let materialDisposed = 0;
    prop.object3D.geometry.addEventListener("dispose", () => geometryDisposed++);
    prop.object3D.material.addEventListener("dispose", () => materialDisposed++);
    entity.destroy();
    assert.equal(geometryDisposed, 1);
    assert.equal(materialDisposed, 1);
    harness.dispose();
  });

  await t.test("destroy leaves a model's shared geometry alone", async () => {
    // Clones from the asset manifest share geometry with the loader's cache
    // and with every other clone. Freeing it on one destroy() would blank the
    // rest of the model in the scene.
    const harness = await scene();
    const shared = new THREE.BoxGeometry();
    let disposed = 0;
    shared.addEventListener("dispose", () => disposed++);
    const clone = new THREE.Mesh(shared, new THREE.MeshBasicMaterial());
    const entity = new runtime.Entity("Model");
    entity.add(clone);
    entity.destroy();
    assert.equal(disposed, 0, "an entity freed geometry it did not own");
    assert.ok(shared.attributes.position, "geometry still usable");
    harness.dispose();
  });

  await t.test("a throwing stop() does not abort a game-wide teardown", async () => {
    const harness = await bootGame({
      game: ({ Game, Entity }) => {
        class Bad extends Entity { stop() { throw new Error("bad teardown"); } }
        class Good extends Entity { constructor() { super("Good"); this.stopped = false; } stop() { this.stopped = true; } }
        return class G extends Game {
          start() { this.bad = new Bad("Bad"); this.good = new Good(); }
        };
      },
    });
    harness.frames(1);
    const realError = console.error;
    console.error = () => {};
    try {
      harness.env.window.__disposeGame();
    } finally {
      console.error = realError;
    }
    assert.equal(harness.game.good.stopped, true, "the entity after the throwing one still ran");
    harness.env.restore();
  });
});

test("ION.scene", async (t) => {
  await t.test("primitives land in the world with the requested size and place", async () => {
    const harness = await scene();
    // Every ION.scene.* call hands back a Prop, not a THREE.Mesh. The geometry
    // assertions go through `.object3D`, which is the documented escape hatch
    // and is exercised here precisely because it must keep working.
    const box = ION.scene.box({ width: 2, height: 3, depth: 4, x: 1, y: 2, z: 3, name: "Crate" });
    assert.equal(box.name, "Crate");
    assert.deepEqual([box.position.x, box.position.y, box.position.z], [1, 2, 3]);
    assert.equal(box.object3D.geometry.parameters.width, 2);
    assert.equal(box.object3D.geometry.parameters.height, 3);
    assert.equal(box.object3D.geometry.parameters.depth, 4);
    assert.equal(ION.scene.sphere({ radius: 5 }).object3D.geometry.parameters.radius, 5);
    assert.equal(ION.scene.cylinder({ radius: 2, height: 7 }).object3D.geometry.parameters.height, 7);
    const ground = ION.scene.ground({ size: 50 });
    assert.equal(ground.object3D.geometry.parameters.width, 50);
    // Degrees, not radians — the whole point of the handle.
    assert.equal(Math.round(ground.rotation.x), -90, "ground is lying down");
    assert.equal(ground.object3D.receiveShadow, true);
    harness.dispose();
  });

  await t.test("find() reaches anything by name, including editor-placed objects", async () => {
    const harness = await scene();
    ION.scene.box({ name: "Findable" });
    assert.equal(ION.scene.find("Findable")?.name, "Findable");
    assert.equal(ION.scene.find("Nope"), undefined);
    harness.dispose();
  });

  await t.test("colours accept names, hex strings, short hex and numbers", async () => {
    const harness = await scene();
    // Read back through the handle's own `color`, which is a #rrggbb string —
    // no reaching into `.material.color` and no three.js Color type.
    assert.equal(ION.scene.box({ color: "orange" }).color, "#e8961e");
    assert.equal(ION.scene.box({ color: "#123456" }).color, "#123456");
    assert.equal(ION.scene.box({ color: "#abc" }).color, "#aabbcc");
    assert.equal(ION.scene.box({ color: 0x00ff00 }).color, "#00ff00");
    harness.dispose();
  });

  await t.test("an unrecognised colour warns instead of parsing into a wrong one", async () => {
    // parseInt stops at the first character it cannot read, so "deepblue" used
    // to come out as 0xde — a plausible brown, and no indication of a typo.
    const harness = await scene();
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const prop = ION.scene.box({ color: "deepblue" });
      assert.equal(prop.color, "#cccccc", "fell back rather than guessed");
    } finally {
      console.warn = realWarn;
    }
    assert.match(warnings.join("\n"), /isn't a colour/);
    harness.dispose();
  });

  await t.test("a model that isn't in the manifest says which ones are", async () => {
    const harness = await scene();
    assert.throws(() => ION.scene.model("./assets/models/missing.glb"), /asset manifest/);
    harness.dispose();
  });

  await t.test("remove() detaches without destroying", async () => {
    const harness = await scene();
    const box = ION.scene.box({ name: "Temp" });
    ION.scene.remove(box);
    assert.equal(ION.scene.find("Temp"), undefined);
    assert.equal(box.object3D.parent, null);
    assert.equal(box.isDestroyed, false, "remove() detaches; destroy() is what frees");
    harness.dispose();
  });
});

test("Prop — the handle ION.scene.* hands back", async (t) => {
  await t.test("rotation is degrees, not radians", async () => {
    // The single most common thing a playable does to a prop is turn it, and
    // the raw three.js `rotation` is radians — which is where the starter
    // template's old `coin.rotation.y += dt * 2` came from, a line nobody
    // could read the units of.
    const harness = await scene();
    const box = ION.scene.box();
    box.rotation.y = 90;
    assert.ok(Math.abs(box.object3D.rotation.y - Math.PI / 2) < 1e-9, "90 degrees is a quarter turn");
    box.rotateBy(0, 90, 0);
    assert.equal(Math.round(box.rotation.y), 180);
    harness.dispose();
  });

  await t.test("colour and opacity are readable and writable by name", async () => {
    const harness = await scene();
    const box = ION.scene.box({ color: "orange" });
    box.color = "blue";
    assert.equal(box.color, "#3b82f6");
    box.opacity = 0.5;
    assert.equal(box.opacity, 0.5);
    // A three.js material with opacity < 1 and transparent false renders fully
    // opaque. Setting both together is the point of the setter existing.
    assert.equal(box.object3D.material.transparent, true, "transparent must follow opacity");
    box.opacity = 1;
    assert.equal(box.object3D.material.transparent, false);
    harness.dispose();
  });

  await t.test("colour reaches every mesh of a loaded model, not just the first", async () => {
    const harness = await scene();
    const box = ION.scene.box();
    // A child mesh with its own material, the shape a GLB actually has.
    const child = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0x000000 }));
    box.object3D.add(child);
    box.color = "red";
    assert.equal(child.material.color.getHex(), 0xe5484d, "the whole subtree is recoloured");
    harness.dispose();
  });

  await t.test("find() returns the same handle every time for the same object", async () => {
    // Otherwise `a === b` is false for one object, and a spin() started through
    // one handle is invisible through the next.
    const harness = await scene();
    const made = ION.scene.box({ name: "Coin" });
    const found = ION.scene.find("Coin");
    assert.equal(found, made, "the handle is the object's identity, not a wrapper per lookup");
    assert.equal(ION.scene.find("Coin"), found);
    harness.dispose();
  });

  await t.test("findAll() reaches a whole row of same-named objects", async () => {
    const harness = await scene();
    ION.scene.box({ name: "Coin" });
    ION.scene.box({ name: "Coin" });
    ION.scene.box({ name: "Other" });
    assert.equal(ION.scene.findAll("Coin").length, 2);
    assert.equal(ION.scene.findAll("Nope").length, 0);
    harness.dispose();
  });

  await t.test("spin() turns on game time and composes with other rotation", async () => {
    const harness = await scene();
    const box = ION.scene.box();
    box.spin(90); // a quarter turn per second
    harness.frames(30, 16.7); // ~0.5s
    const afterHalfSecond = box.rotation.y;
    assert.ok(afterHalfSecond > 20 && afterHalfSecond < 70, `expected roughly 45 degrees, got ${afterHalfSecond}`);

    // A delta, not an absolute angle — so a spin does not stamp over other
    // rotation, and the wrap at the end of each cycle is seamless.
    box.rotateBy(0, 100, 0);
    harness.frames(2, 16.7);
    assert.ok(box.rotation.y > afterHalfSecond + 90, "manual rotation survives the next spin tick");
    harness.dispose();
  });

  await t.test("spin(0) and stopSpin() both stop it where it stands", async () => {
    const harness = await scene();
    const box = ION.scene.box();
    box.spin(360);
    harness.frames(10, 16.7);
    box.stopSpin();
    const settled = box.rotation.y;
    harness.frames(20, 16.7);
    assert.equal(box.rotation.y, settled, "stopSpin leaves it where it got to");

    box.spin(360);
    harness.frames(5, 16.7);
    box.spin(0);
    const settledAgain = box.rotation.y;
    harness.frames(20, 16.7);
    assert.equal(box.rotation.y, settledAgain, "spin(0) is the same as stopping");
    harness.dispose();
  });

  await t.test("a spin freezes with gameplay rather than running behind an open editor", async () => {
    // It is driven by the game clock, like every other ION timer, so an editor
    // session does not come back to a world that kept turning without it.
    const harness = await scene();
    const box = ION.scene.box();
    box.spin(360);
    harness.frames(5, 16.7);
    const before = box.rotation.y;
    harness.env.window.__setUIEditorPaused(true);
    harness.frames(30, 16.7);
    assert.equal(box.rotation.y, before, "paused means paused");
    harness.env.window.__setUIEditorPaused(false);
    harness.frames(5, 16.7);
    assert.ok(box.rotation.y > before, "and it resumes");
    harness.dispose();
  });

  await t.test("destroy() unparents, frees the GPU resources, and stops the spin", async () => {
    const harness = await scene();
    const box = ION.scene.box({ name: "Doomed" });
    box.spin(180);
    let geometryDisposed = 0;
    box.object3D.geometry.addEventListener("dispose", () => geometryDisposed++);

    box.destroy();
    assert.equal(geometryDisposed, 1, "removeFromParent alone would have leaked this");
    assert.equal(box.object3D.parent, null);
    assert.equal(ION.scene.find("Doomed"), undefined);
    assert.equal(box.isDestroyed, true);
    // Safe twice, and the retired spin must not keep writing to a dead object.
    assert.doesNotThrow(() => box.destroy());
    assert.doesNotThrow(() => harness.frames(5, 16.7));
    harness.dispose();
  });

  await t.test("a model's shared geometry is left alone", async () => {
    // Clones from the asset manifest share geometry with the loader's cache and
    // with every other clone, so freeing one would blank the rest.
    const harness = await scene(undefined, { assets: new SeededLoader() });
    const box = ION.scene.box();
    const shared = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    box.object3D.add(shared); // no ION_OWNED marker — not ours to free
    let disposed = 0;
    shared.geometry.addEventListener("dispose", () => disposed++);
    box.destroy();
    assert.equal(disposed, 0);
    harness.dispose();
  });

  await t.test("Entity and Prop share one vocabulary", async () => {
    // The reason SceneNode exists: whichever kind of handle you are holding,
    // the same call means the same thing and takes the same units.
    const harness = await bootGame({
      game: ({ Game, Entity }) => class G extends Game {
        start() { this.thing = new Entity("Thing"); }
      },
    });
    const prop = ION.scene.box();
    const entity = harness.game.thing;
    for (const method of ["moveTo", "moveBy", "rotateBy", "lookAt", "distanceTo", "add", "spin", "stopSpin"]) {
      assert.equal(typeof prop[method], "function", `Prop.${method}`);
      assert.equal(typeof entity[method], "function", `Entity.${method}`);
    }
    prop.moveTo(0, 0, 3);
    entity.moveTo(0, 0, 0);
    assert.equal(entity.distanceTo(prop), 3, "and they measure against each other");
    assert.ok(prop instanceof runtime.SceneNode && entity instanceof runtime.SceneNode);
    harness.dispose();
  });
});

test("rigged models, vectors, and parts", async (t) => {
  /**
   * A GLB with a real skeleton, built in memory.
   *
   * The point of the suite below is what happens when this is cloned twice, so
   * it has to be genuinely rigged — a plain mesh would pass every assertion
   * here while proving nothing.
   */
  function riggedGltf() {
    const root = new THREE.Group();
    root.name = "Hero";
    const hips = new THREE.Bone();
    hips.name = "Hips";
    const spine = new THREE.Bone();
    spine.name = "Spine";
    hips.add(spine);
    root.add(hips);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Array(12).fill(0), 4));
    geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
    const body = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
    body.name = "Body";
    body.bind(new THREE.Skeleton([hips, spine]));
    root.add(body);

    const track = new THREE.QuaternionKeyframeTrack(
      "Spine.quaternion",
      [0, 1],
      [0, 0, 0, 1, 0, 0.7071, 0, 0.7071]
    );
    return {
      scene: root,
      animations: [new THREE.AnimationClip("Run", 1, [track]), new THREE.AnimationClip("Idle", 1, [track])],
    };
  }

  /** An AssetLoader that serves the rigged GLB above for any path. */
  class RiggedLoader extends runtime.AssetLoader {
    constructor() {
      super();
      this.gltf = riggedGltf();
    }
    getGlb() { return this.gltf; }
    getAnimations() { return this.gltf.animations; }
    get cached() { return { textures: [], models: ["./hero.glb"], audio: [] }; }
  }

  await t.test("two instances of one rigged model get separate skeletons", async () => {
    // `Object3D.clone(true)` copies a SkinnedMesh but leaves its skeleton
    // bound to the ORIGINAL's bones, so every instance shares one skeleton:
    // they all play whichever clip started last, in lockstep, and posing one
    // poses the rest. AssetLoader uses SkeletonUtils.clone for exactly this.
    const harness = await scene(undefined, { assets: new RiggedLoader() });
    const a = ION.scene.model("./hero.glb");
    const b = ION.scene.model("./hero.glb", { x: 3 });

    const skinOf = (prop) => {
      let found;
      prop.object3D.traverse((n) => { if (!found && n.isSkinnedMesh) found = n; });
      return found;
    };
    const skinA = skinOf(a);
    const skinB = skinOf(b);
    assert.ok(skinA && skinB, "both instances contain a SkinnedMesh");
    assert.notEqual(skinA.skeleton, skinB.skeleton, "each instance must own its skeleton");
    assert.notEqual(skinA.skeleton.bones[0], skinB.skeleton.bones[0], "and its own bones");
    // The decisive one: neither may point back at the source model.
    assert.ok(a.object3D.getObjectByName("Hips"), "the clone has its own bone in its own tree");
    assert.equal(skinA.skeleton.bones[0], a.object3D.getObjectByName("Hips"), "bound to its own copy, not the source");
    harness.dispose();
  });

  await t.test("a model's clips arrive on the handle", async () => {
    const harness = await scene(undefined, { assets: new RiggedLoader() });
    const hero = ION.scene.model("./hero.glb");
    assert.deepEqual(hero.animations, ["Run", "Idle"], "named clips, no three.js needed to read them");
    assert.equal(hero.currentAnimation, undefined);
    assert.equal(hero.isPlaying, false);
    harness.dispose();
  });

  await t.test("play() starts a clip and advances it on the game's own frames", async () => {
    const harness = await scene(undefined, { assets: new RiggedLoader() });
    const hero = ION.scene.model("./hero.glb");
    hero.play("Run", { fade: 0 });
    assert.equal(hero.currentAnimation, "Run");
    assert.equal(hero.isPlaying, true);

    let spine;
    hero.object3D.traverse((n) => { if (n.name === "Spine") spine = n; });
    const before = spine.quaternion.clone();
    harness.frames(20, 16.7);
    assert.ok(before.angleTo(spine.quaternion) > 0.01, "the pose actually moved — the mixer is being ticked");
    harness.dispose();
  });

  await t.test("two instances can play different clips at the same time", async () => {
    // The behaviour the skeleton fix exists for, asserted end to end.
    const harness = await scene(undefined, { assets: new RiggedLoader() });
    const a = ION.scene.model("./hero.glb");
    const b = ION.scene.model("./hero.glb", { x: 3 });
    a.play("Run", { fade: 0 });
    b.play("Idle", { fade: 0, speed: 0 });
    harness.frames(20, 16.7);
    assert.equal(a.currentAnimation, "Run");
    assert.equal(b.currentAnimation, "Idle");

    const spineOf = (prop) => {
      let s;
      prop.object3D.traverse((n) => { if (n.name === "Spine") s = n; });
      return s;
    };
    assert.ok(spineOf(a).quaternion.angleTo(spineOf(b).quaternion) > 0.01, "the two poses diverged");
    harness.dispose();
  });

  await t.test("re-playing the clip already running does not restart it", async () => {
    // Calling play("Run") from update() while a key is held is the obvious way
    // to write movement; restarting each frame would pin it to frame zero.
    const harness = await scene(undefined, { assets: new RiggedLoader() });
    const hero = ION.scene.model("./hero.glb");
    hero.play("Run", { fade: 0 });
    harness.frames(10, 16.7);
    let spine;
    hero.object3D.traverse((n) => { if (n.name === "Spine") spine = n; });
    const midway = spine.quaternion.clone();
    hero.play("Run", { fade: 0 });
    harness.frames(1, 16.7);
    assert.ok(midway.angleTo(spine.quaternion) < 0.5, "kept going rather than snapping back to the start");
    harness.dispose();
  });

  await t.test("an unknown clip warns with the names that do exist", async () => {
    const harness = await scene(undefined, { assets: new RiggedLoader() });
    const hero = ION.scene.model("./hero.glb");
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      hero.play("Sprint");
    } finally {
      console.warn = realWarn;
    }
    assert.match(warnings.join("\n"), /no such animation/);
    assert.match(warnings.join("\n"), /Run, Idle/);
    assert.equal(hero.currentAnimation, undefined, "and nothing started");
    harness.dispose();
  });

  await t.test("destroy() retires the mixer instead of leaving it ticking", async () => {
    const harness = await scene(undefined, { assets: new RiggedLoader() });
    const hero = ION.scene.model("./hero.glb");
    hero.play("Run", { fade: 0 });
    hero.destroy();
    assert.equal(hero.currentAnimation, undefined);
    // A retired mixer being ticked would throw or animate a detached tree.
    assert.doesNotThrow(() => harness.frames(5, 16.7));
    harness.dispose();
  });

  await t.test("a shape with no clips says so rather than throwing", async () => {
    const harness = await scene();
    const box = ION.scene.box();
    assert.deepEqual(box.animations, []);
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      assert.doesNotThrow(() => box.play("Run"));
    } finally {
      console.warn = realWarn;
    }
    harness.dispose();
  });

  await t.test("position and scale are live vectors with maths on them", async () => {
    const harness = await scene();
    const box = ION.scene.box();
    box.position.set(3, 4, 0);
    assert.equal(box.position.length(), 5, "real vector maths, no three.js import in game code");
    box.position.add(ION.vec3(0, 0, 12));
    assert.equal(box.position.z, 12, "and it is live — the object actually moved");
    box.scale.setScalar(2);
    assert.equal(box.object3D.scale.x, 2);

    const direction = ION.vec3().subVectors(ION.vec3(0, 0, 10), box.position).normalize();
    assert.ok(Math.abs(direction.length() - 1) < 1e-6);
    harness.dispose();
  });

  await t.test("part() reaches a named node inside a model", async () => {
    const harness = await scene(undefined, { assets: new RiggedLoader() });
    const hero = ION.scene.model("./hero.glb");
    const body = hero.part("Body");
    assert.ok(body, "found by the name the artist gave it");
    body.hide();
    assert.equal(body.object3D.visible, false);
    assert.equal(hero.part("NoSuchNode"), undefined);
    // The same node asked for twice is the same handle, like scene.find().
    assert.equal(hero.part("Body"), body);
    harness.dispose();
  });

  await t.test("castShadow reaches every mesh, not just the group", async () => {
    // `castShadow` on a Group does nothing at all in three.js, silently — it
    // is a per-mesh flag, which for a loaded model means traversing it.
    const harness = await scene(undefined, { assets: new RiggedLoader() });
    const hero = ION.scene.model("./hero.glb");
    hero.castShadow = false;
    let any = false;
    hero.object3D.traverse((n) => { if (n.isMesh) any = any || n.castShadow; });
    assert.equal(any, false, "every mesh underneath was set");
    hero.castShadow = true;
    let all = true;
    hero.object3D.traverse((n) => { if (n.isMesh) all = all && n.castShadow; });
    assert.equal(all, true);
    harness.dispose();
  });
});

test("ION.camera", async (t) => {
  await t.test("follow() moves the rig toward the target", async () => {
    const harness = await bootGame({
      data: { environment: { version: 1, camera: { follow: true } } },
      game: ({ Game, Entity }) => class G extends Game {
        start() { this.hero = new Entity("Hero"); this.hero.moveTo(20, 0, 20); ION.camera.follow(this.hero); }
      },
    });
    const start = harness.game.rig.camera.position.clone();
    harness.frames(30);
    const moved = harness.game.rig.camera.position.distanceTo(start);
    assert.ok(moved > 1, `the camera should have chased the target, moved ${moved}`);
    harness.dispose();
  });

  await t.test("stopFollow() leaves the camera where it is", async () => {
    const harness = await bootGame({
      data: { environment: { version: 1, camera: { follow: true } } },
      game: ({ Game, Entity }) => class G extends Game {
        start() { this.hero = new Entity("Hero"); this.hero.moveTo(30, 0, 30); ION.camera.follow(this.hero); }
      },
    });
    harness.frames(20);
    ION.camera.stopFollow();
    const parked = harness.game.rig.camera.position.clone();
    harness.game.hero.moveTo(-40, 0, -40);
    harness.frames(20);
    assert.ok(harness.game.rig.camera.position.distanceTo(parked) < 1e-6);
    harness.dispose();
  });

  await t.test("shake() displaces the camera even while following", async () => {
    // The follow lerp writes an absolute position, so a shake applied during
    // onUpdate — before the rig runs — was overwritten every frame and never
    // visible. This is the regression guard for that.
    const harness = await bootGame({
      data: { environment: { version: 1, camera: { follow: true } } },
      game: ({ Game, Entity }) => class G extends Game {
        start() { this.hero = new Entity("Hero"); ION.camera.follow(this.hero); }
      },
    });
    harness.frames(60); // let the follow settle so any movement is the shake
    const settled = harness.game.rig.camera.position.clone();
    harness.frames(1);
    const drift = harness.game.rig.camera.position.distanceTo(settled);

    ION.camera.shake(4, 1);
    harness.frames(1);
    const shaken = harness.game.rig.camera.position.distanceTo(settled);
    assert.ok(shaken > drift * 10 && shaken > 0.1, `shake was invisible: drift ${drift}, shaken ${shaken}`);
    harness.dispose();
  });

  await t.test("shake decays back to no displacement", async () => {
    const harness = await scene();
    const rest = harness.game.rig.camera.position.clone();
    ION.camera.shake(2, 0.2);
    harness.frames(60);
    assert.ok(harness.game.rig.camera.position.distanceTo(rest) < 1e-9, "shake left a permanent offset");
    harness.dispose();
  });
});

test("ION.audio", async (t) => {
  await t.test("master volume is applied once, by the listener", async () => {
    // It used to be multiplied into each sound as well, so 0.5 played new
    // sounds at 0.25 while already-playing ones were at 0.5.
    const harness = await scene(undefined, { assets: new SeededLoader() });
    ION.audio.volume = 0.5;
    assert.equal(ION.audio.volume, 0.5, "readable, not write-only");
    assert.equal(harness.game.audioListener.getMasterVolume(), 0.5);
    harness.dispose();
  });

  await t.test("a one-shot releases its WebAudio nodes when it ends", async () => {
    const harness = await scene(undefined, { assets: new SeededLoader() });
    const before = harness.env.audio.disconnected;
    ION.audio.play("./sfx.ogg");
    assert.ok(harness.env.audio.live.size > 0, "the sound built nodes");
    harness.game.stopMusic();
    // Ending a source is asynchronous, the way a real BufferSource is.
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.dispose();
    assert.ok(harness.env.audio.disconnected > before, "nodes were taken back off the graph");
  });

  await t.test("teardown silences everything the game started", async () => {
    const harness = await scene(undefined, { assets: new SeededLoader() });
    ION.audio.music("./music.ogg");
    for (let i = 0; i < 25; i++) ION.audio.play("./sfx.ogg");
    const beforeStops = harness.env.audio.stopped;
    harness.env.window.__disposeGame();
    assert.ok(harness.env.audio.stopped > beforeStops, "sounds were stopped on teardown");
    harness.env.restore();
  });

  await t.test("music() replaces the previous track rather than layering", async () => {
    const harness = await scene(undefined, { assets: new SeededLoader() });
    ION.audio.music("./one.ogg");
    const afterFirst = harness.env.audio.stopped;
    ION.audio.music("./two.ogg");
    assert.ok(harness.env.audio.stopped > afterFirst, "the first track was stopped");
    harness.dispose();
  });

  await t.test("a sound that isn't in the manifest warns and keeps playing the game", async () => {
    const harness = await scene();
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      assert.doesNotThrow(() => ION.audio.play("./nope.ogg"));
    } finally {
      console.warn = realWarn;
    }
    assert.match(warnings.join("\n"), /asset manifest/);
    harness.dispose();
  });
});

test("ION timing and events", async (t) => {
  await t.test("after() fires once, on game time", async () => {
    const harness = await scene();
    let fired = 0;
    ION.after(0.5, () => fired++);
    harness.frames(10, 16); // 0.16s
    assert.equal(fired, 0);
    harness.frames(30, 16); // past 0.5s
    assert.equal(fired, 1);
    harness.frames(60, 16);
    assert.equal(fired, 1, "one-shot did not repeat");
    harness.dispose();
  });

  await t.test("every() repeats and cancels", async () => {
    const harness = await scene();
    let ticks = 0;
    const handle = ION.every(0.1, () => ticks++);
    harness.frames(40, 16);
    assert.ok(ticks >= 4, `expected repeats, got ${ticks}`);
    const atCancel = ticks;
    handle.cancel();
    harness.frames(40, 16);
    assert.equal(ticks, atCancel);
    assert.equal(handle.done, true);
    harness.dispose();
  });

  await t.test("tween moves a value and completes", async () => {
    const harness = await scene();
    const box = ION.scene.box();
    let completed = false;
    ION.tween(box.scale, { x: 2, y: 2, z: 2 }, 0.2, { easing: ION.ease.smooth, onComplete: () => { completed = true; } });
    harness.frames(30, 16);
    assert.ok(Math.abs(box.scale.x - 2) < 1e-6, `scale reached ${box.scale.x}`);
    assert.equal(completed, true);
    harness.dispose();
  });

  await t.test("timers freeze while the editor pauses gameplay", async () => {
    const harness = await scene();
    let fired = 0;
    ION.after(0.3, () => fired++);
    harness.env.window.__setUIEditorPaused(true);
    harness.frames(60, 16);
    assert.equal(fired, 0, "game time advanced behind a paused editor");
    harness.env.window.__setUIEditorPaused(false);
    harness.frames(30, 16);
    assert.equal(fired, 1);
    harness.dispose();
  });

  await t.test("emit/on carry a payload", async () => {
    const harness = await scene();
    const seen = [];
    ION.on("scored", (payload) => seen.push(payload.total));
    ION.emit("scored", { total: 7 });
    ION.emit("scored", { total: 8 });
    assert.deepEqual(seen, [7, 8]);
    harness.dispose();
  });

  await t.test("listeners from a retired game do not survive into the next one", async () => {
    const harness = await scene();
    let fired = 0;
    ION.on("stale", () => fired++);
    harness.dispose();

    const second = await scene();
    ION.emit("stale", undefined);
    assert.equal(fired, 0, "a listener from the previous game fired into the new one");
    second.dispose();
  });
});

test("ION.random", async (t) => {
  await t.test("random() stays inside its range and randomInt() is inclusive", async () => {
    const harness = await scene();
    for (let i = 0; i < 500; i++) {
      const value = ION.random(-3, 5);
      assert.ok(value >= -3 && value < 5);
    }
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(ION.randomInt(1, 3));
    assert.deepEqual([...seen].sort(), [1, 2, 3], "both endpoints reachable");
    harness.dispose();
  });
});

test("ION.colliders", async (t) => {
  await t.test("a zone fires enter and exit exactly once per crossing", async () => {
    const harness = await bootGame({
      game: ({ Game, Entity }) => class G extends Game {
        start() {
          this.hero = new Entity("Hero");
          this.hero.shape = ION.scene.box({ size: 1 });
          ION.colliders.attach(this.hero, { size: 1 });
          this.enters = 0;
          this.exits = 0;
          ION.colliders.zone({ name: "Goal", size: 4 }).onEnter(() => this.enters++).onExit(() => this.exits++);
          this.hero.moveTo(10, 0, 0);
        }
        update() { this.hero.moveBy(-0.4, 0, 0); }
      },
    });
    harness.frames(60);
    assert.equal(harness.game.enters, 1, "entered once");
    assert.equal(harness.game.exits, 1, "exited once");
    harness.dispose();
  });

  await t.test("a disabled zone stops reporting", async () => {
    const harness = await bootGame({
      game: ({ Game, Entity }) => class G extends Game {
        start() {
          this.hero = new Entity("Hero");
          ION.colliders.attach(this.hero, { size: 1 });
          this.enters = 0;
          this.zone = ION.colliders.zone({ name: "Off", size: 4 }).onEnter(() => this.enters++);
          this.zone.enabled = false;
          this.hero.moveTo(6, 0, 0);
        }
        update() { this.hero.moveBy(-0.3, 0, 0); }
      },
    });
    harness.frames(60);
    assert.equal(harness.game.enters, 0);
    harness.dispose();
  });

  await t.test("a body is retired with the entity it belongs to", async () => {
    const harness = await bootGame({
      game: ({ Game, Entity }) => class G extends Game {
        start() {
          this.hero = new Entity("Hero");
          ION.colliders.attach(this.hero, { size: 1 });
          this.enters = 0;
          ION.colliders.zone({ name: "Goal", size: 4 }).onEnter(() => this.enters++);
          this.hero.moveTo(10, 0, 0);
        }
      },
    });
    harness.frames(2);
    harness.game.hero.destroy();
    harness.game.hero.moveTo(0, 0, 0);
    harness.frames(10);
    assert.equal(harness.game.enters, 0, "a destroyed entity's collider still triggered");
    assert.equal(ION.colliders.find("Hero"), undefined);
    harness.dispose();
  });

  await t.test("find() reaches a zone by name", async () => {
    const harness = await scene(() => { ION.colliders.zone({ name: "Named" }); });
    assert.ok(ION.colliders.find("Named"));
    assert.equal(ION.colliders.find("Absent"), undefined);
    harness.dispose();
  });
});

test("ION.ui", async (t) => {
  const layout = {
    version: 1,
    canvasWidth: 400,
    canvasHeight: 711,
    elements: [
      { id: "s", name: "Score", type: "text", x: 10, y: 10, width: 100, height: 30, text: "0", visible: true, opacity: 1 },
      { id: "b", name: "Play", type: "button", x: 10, y: 60, width: 120, height: 40, text: "Play", visible: true, opacity: 1 },
    ],
  };

  await t.test("text/show/hide reach the designed elements", async () => {
    const harness = await bootGame({
      data: { mainLayout: layout },
      game: ({ Game }) => class G extends Game { start() {} },
    });
    ION.ui.text("Score", 42);
    assert.match(harness.env.document.getElementById("custom-ui-layer").textContent, /42/);
    assert.doesNotThrow(() => ION.ui.hide("Score"));
    assert.doesNotThrow(() => ION.ui.show("Score"));
    harness.dispose();
  });

  await t.test("onClick wires a designed button", async () => {
    const harness = await bootGame({
      data: { mainLayout: layout },
      game: ({ Game }) => class G extends Game { start() {} },
    });
    let clicks = 0;
    ION.ui.onClick("Play", () => clicks++);
    const node = [...harness.env.document.querySelectorAll("*")].find((el) => el.textContent === "Play" && el.style.cursor === "pointer");
    assert.ok(node, "the button rendered as an interactive node");
    node.dispatchEvent(new harness.env.window.MouseEvent("click", { bubbles: true }));
    assert.equal(clicks, 1);
    harness.dispose();
  });

  await t.test("naming an element that doesn't exist does not crash the game", async () => {
    const harness = await bootGame({
      data: { mainLayout: layout },
      game: ({ Game }) => class G extends Game { start() {} },
    });
    assert.doesNotThrow(() => ION.ui.text("Nope", 1));
    assert.doesNotThrow(() => ION.ui.value("Nope", 0.5));
    harness.dispose();
  });

  await t.test("showEndcard reveals the endcard layer", async () => {
    const harness = await scene();
    ION.ui.showEndcard();
    assert.notEqual(harness.env.document.getElementById("endcard-layer").style.display, "none");
    harness.dispose();
  });
});

test("ION used before a game exists", async (t) => {
  await t.test("says where to move the call", async () => {
    assert.throws(() => ION.scene.box(), /before the game started/);
    assert.throws(() => ION.camera.shake(), /before the game started/);
    assert.throws(() => ION.ui.text("x", 1), /before the game started/);
  });
});
