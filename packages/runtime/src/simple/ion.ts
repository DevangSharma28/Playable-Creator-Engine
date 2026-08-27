import * as THREE from "three";
import { Ion as IonCore, Easing } from "../../../../src/engine/Ion";
import { Cta } from "../../../../src/engine/Cta";
import type { ScheduledHandle } from "../../../../src/engine/core/Scheduler";
import type { Collider } from "../../../../src/engine/collision";
import { Entity } from "./entity";
import { requireGame, type SimpleGameHost } from "./context";

/**
 * The whole ION surface a game normally needs.
 *
 * Every property below is a shortcut into a system the engine already runs.
 * Nothing here has to be constructed, registered, wired or torn down — that is
 * what separates this from the advanced API, which is still there underneath
 * for the cases this doesn't cover.
 */

let host: SimpleGameHost | undefined;

/** Called by the engine when a game starts. Not part of the public API. */
export function bindIonFacade(next: SimpleGameHost | undefined): void {
  host = next;
}

function game(): SimpleGameHost {
  requireGame("ION");
  return host as SimpleGameHost;
}

const COLORS: Record<string, number> = {
  red: 0xe5484d, orange: 0xe8961e, yellow: 0xf5d90a, green: 0x4c9a52,
  blue: 0x3b82f6, purple: 0x8b5cf6, pink: 0xec4899, white: 0xffffff,
  black: 0x111111, grey: 0x888888, gray: 0x888888, brown: 0x8b5a2b,
};

/** Accepts "orange", "#e8961e" or 0xe8961e — whichever you happen to have. */
function toColor(value: string | number | undefined, fallback = 0xcccccc): number {
  if (value === undefined) return fallback;
  if (typeof value === "number") return value;
  const named = COLORS[value.toLowerCase()];
  if (named !== undefined) return named;
  const hex = parseInt(value.replace("#", ""), 16);
  return Number.isNaN(hex) ? fallback : hex;
}

export interface ShapeOptions {
  color?: string | number;
  /** Uniform size. Use width/height/depth for a non-cube. */
  size?: number;
  width?: number;
  height?: number;
  depth?: number;
  radius?: number;
  x?: number;
  y?: number;
  z?: number;
  /** 0 = matte, 1 = mirror. */
  metal?: number;
  /** 0 = glossy, 1 = completely rough. */
  rough?: number;
  opacity?: number;
  name?: string;
}

function material(o: ShapeOptions): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: toColor(o.color),
    metalness: o.metal ?? 0,
    roughness: o.rough ?? 0.6,
    transparent: o.opacity !== undefined && o.opacity < 1,
    opacity: o.opacity ?? 1,
  });
}

function place(mesh: THREE.Mesh, o: ShapeOptions, defaultName: string): THREE.Mesh {
  mesh.name = o.name ?? defaultName;
  mesh.position.set(o.x ?? 0, o.y ?? 0, o.z ?? 0);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  game().world.add(mesh);
  return mesh;
}

/** Building and finding things in the world. */
const scene = {
  /** A box. `ION.scene.box({ color: "orange", size: 1.5, y: 0.75 })` */
  box(options: ShapeOptions = {}): THREE.Mesh {
    const w = options.width ?? options.size ?? 1;
    const h = options.height ?? options.size ?? 1;
    const d = options.depth ?? options.size ?? 1;
    return place(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material(options)), options, "Box");
  },

  /** A ball. */
  sphere(options: ShapeOptions = {}): THREE.Mesh {
    const r = options.radius ?? (options.size ?? 1) / 2;
    return place(new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), material(options)), options, "Sphere");
  },

  /** A cylinder. */
  cylinder(options: ShapeOptions = {}): THREE.Mesh {
    const r = options.radius ?? (options.size ?? 1) / 2;
    const h = options.height ?? options.size ?? 1;
    return place(new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 24), material(options)), options, "Cylinder");
  },

  /** A flat floor, already lying down and sized to `size`. */
  ground(options: ShapeOptions = {}): THREE.Mesh {
    const s = options.size ?? 40;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(s, s), material({ rough: 0.95, color: "green", ...options }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = options.name ?? "Ground";
    mesh.position.set(options.x ?? 0, options.y ?? 0, options.z ?? 0);
    game().world.add(mesh);
    return mesh;
  },

  /**
   * A model from your asset manifest.
   *
   * `ION.scene.model("./assets/models/player.glb")` — already loaded, because
   * everything in the manifest is preloaded before your game starts.
   */
  model(path: string, options: ShapeOptions = {}): THREE.Object3D {
    const object = game().assetLoader.instantiateGlb(path);
    object.name = options.name ?? path.split("/").pop() ?? "Model";
    object.position.set(options.x ?? 0, options.y ?? 0, options.z ?? 0);
    if (options.size) object.scale.setScalar(options.size);
    object.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    game().world.add(object);
    return object;
  },

  /** Put an entity or raw object into the world yourself. Entities add themselves; this is for anything else. */
  add(thing: Entity | THREE.Object3D): void {
    game().world.add(thing instanceof Entity ? thing.object3D : thing);
  },

  remove(thing: Entity | THREE.Object3D): void {
    const object = thing instanceof Entity ? thing.object3D : thing;
    object.removeFromParent();
  },

  /** Find something by the name it was given — including anything placed in the ION editor. */
  find(name: string): THREE.Object3D | undefined {
    return game().world.getObjectByName(name);
  },
};

/** The camera. Framing, lighting and fog are authored in the editor's Environment dock; this is the runtime side. */
const camera = {
  /** Follow an entity. The offset and smoothing come from the Environment dock. */
  follow(target: Entity | { x: number; y: number; z: number } | undefined): void {
    game().setCameraTarget(target);
  },
  /** Stop following and leave the camera where it is. */
  stopFollow(): void {
    game().setCameraTarget(undefined);
  },
  get position(): THREE.Vector3 {
    return game().rig.camera.position;
  },
  /** Field of view in degrees. */
  get fov(): number {
    return game().rig.perspective.fov;
  },
  /** Shake the camera — `ION.camera.shake(0.4, 0.25)` for a hit. */
  shake(strength = 0.3, seconds = 0.25): void {
    game().shakeCamera(strength, seconds);
  },
};

/** Movement and taps, from touch or keyboard, without caring which. */
const input = {
  /**
   * Direction the player is asking for, from −1 to 1 on each axis.
   *
   * The joystick when one is being held, the keyboard otherwise, so this works
   * on a phone and on a desktop with no branching in your code.
   */
  get axis(): { x: number; y: number } {
    const g = game();
    const joystick = g.stick?.axis;
    if (joystick && (joystick.x !== 0 || joystick.y !== 0)) return joystick;
    return g.inputManager.keyboardAxis;
  },
  /** True while a key is held. `ION.input.isDown(" ")` for space. */
  isDown(key: string): boolean {
    return game().inputManager.isDown(key);
  },
  onTap(handler: (point: { x: number; y: number }) => void): void {
    game().inputManager.onTap((info) => handler({ x: info.x, y: info.y }));
  },
  onSwipe(handler: (direction: "up" | "down" | "left" | "right") => void): void {
    game().inputManager.onSwipe((info) => {
      // The engine reports a vector; a game almost always wants the one word.
      const horizontal = Math.abs(info.dx) > Math.abs(info.dy);
      handler(horizontal ? (info.dx > 0 ? "right" : "left") : info.dy > 0 ? "down" : "up");
    });
  },
};

/** Sounds and music from your asset manifest. */
const audio = {
  /** Play a one-shot. `ION.audio.play("./assets/sounds/coin.ogg")` */
  play(path: string, volume = 1): void {
    game().playSound(path, { volume, loop: false });
  },
  /** Start looping background music. Call again to change track. */
  music(path: string, volume = 0.5): void {
    game().playSound(path, { volume, loop: true, music: true });
  },
  stopMusic(): void {
    game().stopMusic();
  },
  /** 0 to 1, applies to everything. */
  set volume(v: number) {
    game().setMasterVolume(v);
  },
};

/** Effects authored in the editor's Particle System mode. */
const particles = {
  /** Play a named effect, optionally at a position or entity. */
  play(name: string, at?: Entity | { x: number; y: number; z: number }): void {
    const system = IonCore.particles.getByName(name);
    if (!system) {
      console.warn(`ION.particles: no effect named "${name}". Create one in the editor's Particle System mode (P).`);
      return;
    }
    if (at) {
      const p = at instanceof Entity ? at.object3D.position : at;
      system.playAt(new THREE.Vector3(p.x, p.y, p.z));
    } else system.play();
  },
  stop(name: string): void {
    IonCore.particles.getByName(name)?.stop();
  },
  /** "high" | "medium" | "low" — scales every effect at once. */
  quality(level: "high" | "medium" | "low"): void {
    IonCore.particles.setQuality(level);
  },
};

export interface ZoneOptions {
  size?: number;
  width?: number;
  height?: number;
  depth?: number;
  radius?: number;
  x?: number;
  y?: number;
  z?: number;
  name?: string;
  tag?: string;
}

/** Trigger zones and solid volumes. Authoring is easier in the editor (`K`); this is for zones made in code. */
const colliders = {
  /** A box trigger. `ION.colliders.zone({ name: "Exit", size: 4 }).onEnter(() => …)` */
  zone(options: ZoneOptions = {}): SimpleZone {
    const collider = IonCore.colliders.box({
      name: options.name ?? "Zone",
      tag: options.tag ?? options.name ?? "Zone",
      isTrigger: true,
      size: [options.width ?? options.size ?? 2, options.height ?? options.size ?? 2, options.depth ?? options.size ?? 2],
      position: [options.x ?? 0, options.y ?? 0, options.z ?? 0],
    });
    return new SimpleZone(collider);
  },
  /** Find a zone placed in the editor. */
  find(name: string): SimpleZone | undefined {
    const collider = IonCore.colliders.getByName(name);
    return collider ? new SimpleZone(collider) : undefined;
  },
};

/** A trigger volume with plain enter/exit callbacks. */
export class SimpleZone {
  constructor(readonly collider: Collider) {}
  onEnter(handler: () => void): this {
    this.collider.onTriggerEnter(() => handler());
    return this;
  }
  onExit(handler: () => void): this {
    this.collider.onTriggerExit(() => handler());
    return this;
  }
  set enabled(value: boolean) {
    this.collider.setEnabled(value);
  }
}

/** The HUD and endcard you designed in the UI editor. */
const ui = {
  /** Change a text element's contents. */
  text(name: string, value: string | number): void {
    game().hud.setText(name, String(value));
  },
  show(name: string): void {
    game().hud.show(name);
  },
  hide(name: string): void {
    game().hud.hide(name);
  },
  /** Run something when a designed button is pressed. */
  onClick(name: string, handler: () => void): void {
    game().hud.setInteractive(name, handler);
  },
  /** Set a progress bar or slider, 0 to 1. */
  value(name: string, value: number): void {
    game().hud.setValue(name, value);
  },
  /** Show the endcard. Ends the game. */
  showEndcard(): void {
    game().showEndcard();
  },
};

/**
 * `ION` — everything a game normally needs, in one place.
 */
export const ION = {
  scene,
  camera,
  input,
  audio,
  particles,
  colliders,
  ui,

  /** Seconds since the game started. Pauses while the editor is open. */
  get time(): number {
    return IonCore.time;
  },

  /** Run something once, later. */
  after(seconds: number, fn: () => void): ScheduledHandle {
    return IonCore.after(seconds, fn);
  },
  /** Run something on a repeat. */
  every(seconds: number, fn: () => void): ScheduledHandle {
    return IonCore.every(seconds, fn);
  },
  /** Animate numbers on an object over time. `ION.tween(box.scale, { x: 2, y: 2, z: 2 }, 0.3)` */
  tween<T extends object>(target: T, to: Partial<T>, seconds: number, opts?: { easing?: (k: number) => number; onComplete?: () => void }): ScheduledHandle {
    return IonCore.tween(target, to, seconds, opts);
  },
  /** Easing curves for `tween` — `ION.ease.bounce`, `ION.ease.smooth`, … */
  ease: {
    smooth: Easing.Quadratic.InOut,
    in: Easing.Quadratic.In,
    out: Easing.Quadratic.Out,
    bounce: Easing.Bounce.Out,
    elastic: Easing.Elastic.Out,
    back: Easing.Back.Out,
  },

  /** Send a message anywhere in your game. */
  emit<T = void>(event: string, payload?: T): void {
    IonCore.emit(event, payload as T);
  },
  /** Listen for one. */
  on<T = void>(event: string, fn: (payload: T) => void): void {
    IonCore.on<T>(event, fn);
  },

  /** A random number, because every game needs one. */
  random(min = 0, max = 1): number {
    return min + Math.random() * (max - min);
  },
  /** A random whole number, inclusive. */
  randomInt(min: number, max: number): number {
    return Math.floor(min + Math.random() * (max - min + 1));
  },

  /** Open the store listing. This is the install click — route every CTA through it. */
  cta(storeUrl?: string): void {
    Cta.open(storeUrl ?? game().storeUrl);
  },
};
