import * as THREE from "three";
import { IonGame, type IonGameOptions } from "../ion-game";
import { Entity } from "./entity";
import { SceneNode } from "./node";
import { bindActiveGame, type SimpleGameHost } from "./context";
import { bindIonFacade } from "./ion";

/**
 * The base class your game extends.
 *
 * ```ts
 * export default class MyGame extends Game {
 *   start() { ION.scene.ground(); }
 *   update(dt: number) { … }
 * }
 * ```
 *
 * That is the whole contract. The renderer, camera rig, lighting, colliders,
 * particles, UI layers, input, audio, the editor connection and every asset
 * and JSON file the ION editors write are loaded and wired before `start()`
 * runs. None of it appears in your code because none of it is your decision.
 *
 * Entities look after themselves too: `new Player()` puts it in the world and
 * starts calling its `update`, and `player.destroy()` takes it back out.
 */
export abstract class Game extends IonGame implements SimpleGameHost {
  /** Every live entity, in creation order. */
  private readonly entities: Entity[] = [];
  private pendingStart: Entity[] = [];
  private cameraTarget: SceneNode | { x: number; y: number; z: number } | undefined;
  private shake = { strength: 0, remaining: 0, total: 0 };
  private readonly shakeOffset = new THREE.Vector3();

  /** The store link `ION.cta()` opens. Set it in ion.config.json or override here. */
  storeUrl = "https://example.com";

  constructor(options: IonGameOptions) {
    super(options);
    // Bound before onCreate so `new Player()` and `ION.*` work from the very
    // first line of a game's start().
    bindActiveGame(this);
    bindIonFacade(this);
  }

  /** Build your world. Runs once, before authored collider/particle data loads. */
  abstract start(): void;

  /** Runs every frame. `dt` is seconds since the last one. */
  update(_dt: number): void {}

  /** Runs after every editor-authored file has loaded and every ⊙ Pick binding resolved. */
  ready(): void {}

  /** Runs when the game is torn down. */
  stop(): void {}

  // ── plumbing ────────────────────────────────────────────────────────────

  protected onCreate(): void {
    this.start();
  }

  protected onReady(): void {
    this.flushPendingStarts();
    this.ready();
  }

  protected onUpdate(dt: number, _elapsed: number): void {
    this.flushPendingStarts();
    // The user's own per-frame code. Named `update` because that is what it
    // is; the engine's own frame method is `tick`, so the two cannot collide.
    this.update(dt);
    // A copy, because an entity's update may create or destroy others and
    // mutating the array mid-iteration silently skips one.
    for (const entity of [...this.entities]) {
      if (!entity.isDestroyed) entity.update(dt);
    }
  }

  /**
   * Camera shake, applied after the rig has already placed the camera.
   *
   * It cannot run in onUpdate: the follow lerp writes an absolute position, so
   * an offset added beforehand is overwritten before anything is drawn — which
   * is exactly why `ION.camera.shake()` did nothing whenever the camera was
   * following the player.
   */
  protected onLateUpdate(dt: number): void {
    this.applyShake(dt);
  }

  protected onDispose(): void {
    // The subclass's own teardown runs first and while `ION` is still bound:
    // stopping music or cancelling a timer from stop() is the obvious thing to
    // write there, and unbinding first made every one of those throw
    // "ION was used before the game started".
    this.stop();
    for (const entity of [...this.entities]) entity.destroy();
    this.entities.length = 0;
    this.pendingStart.length = 0;
    this.stopAllSounds();
    bindActiveGame(undefined);
    bindIonFacade(undefined);
  }

  protected getCameraFocus(): THREE.Vector3 | undefined {
    if (!this.cameraTarget) return undefined;
    const p = this.cameraTarget instanceof SceneNode ? this.cameraTarget.object3D.position : this.cameraTarget;
    return p instanceof THREE.Vector3 ? p : new THREE.Vector3(p.x, p.y, p.z);
  }

  // ── the SimpleGameHost surface ──────────────────────────────────────────
  // Narrow, public accessors onto members the engine keeps protected. Each
  // exists because one `ION.*` call needs it; nothing here widens the
  // advanced API for game code, which still cannot reach past this class.

  /** @internal */ get world() { return this.scene; }
  /** @internal */ get assetLoader() { return this.assets; }
  /** @internal */ get rig() { return this.camera; }
  /** @internal */ get hud() { return this.ui; }
  /** @internal */ get inputManager() { return this.input; }
  /** @internal */ get stick() { return this.joystick; }

  /** @internal — Entity's constructor calls this. */
  registerEntity(entity: Entity): void {
    this.entities.push(entity);
    this.scene.add(entity.object3D);
    // Deferred by one tick rather than called here: the subclass constructor
    // has not finished running yet, so its own fields are still undefined and
    // a start() touching them would fail in a way that is very hard to read.
    this.pendingStart.push(entity);
  }

  /** @internal */
  unregisterEntity(entity: Entity): void {
    const index = this.entities.indexOf(entity);
    if (index >= 0) this.entities.splice(index, 1);
  }

  private flushPendingStarts(): void {
    while (this.pendingStart.length) {
      const batch = this.pendingStart;
      this.pendingStart = [];
      for (const entity of batch) if (!entity.isDestroyed) entity.start();
    }
  }

  /** @internal — ION.camera.follow */
  setCameraTarget(target: SceneNode | { x: number; y: number; z: number } | undefined): void {
    this.cameraTarget = target;
  }

  /** @internal — ION.camera.shake */
  shakeCamera(strength: number, seconds: number): void {
    this.shake = { strength, remaining: seconds, total: seconds };
  }

  private applyShake(dt: number): void {
    // Read per frame, never cached: the rig swaps camera identity when the
    // environment config switches between perspective and orthographic.
    const camera = this.camera.camera;
    // Always undo last frame's offset first, so shakes can't accumulate into
    // a permanent displacement of the rig.
    camera.position.sub(this.shakeOffset);
    this.shakeOffset.set(0, 0, 0);
    if (this.shake.remaining > 0) {
      this.shake.remaining = Math.max(0, this.shake.remaining - dt);
      const falloff = this.shake.total > 0 ? this.shake.remaining / this.shake.total : 0;
      const amount = this.shake.strength * falloff;
      this.shakeOffset.set((Math.random() - 0.5) * amount, (Math.random() - 0.5) * amount, (Math.random() - 0.5) * amount);
      camera.position.add(this.shakeOffset);
    }
  }

  // ── audio ───────────────────────────────────────────────────────────────

  private music: THREE.Audio | undefined;
  private masterVolume = 1;
  /**
   * Every sound still holding WebAudio nodes.
   *
   * A `THREE.Audio` connects a gain node into the listener on play() and does
   * not take it back off when the buffer runs out — so a coin sound fired a
   * few hundred times over a playable left a few hundred live nodes attached,
   * and nothing stopped when the game was torn down. Tracked here so a
   * finished one-shot disconnects itself and teardown can stop the rest.
   */
  private readonly liveSounds = new Set<THREE.Audio>();

  /** @internal — ION.audio.play / .music */
  playSound(path: string, opts: { volume?: number; loop?: boolean; music?: boolean } = {}): void {
    let buffer: AudioBuffer;
    try {
      buffer = this.assets.getAudio(path);
    } catch {
      console.warn(`ION.audio: "${path}" isn't in your asset manifest — add it to src/game/assets.ts.`);
      return;
    }
    if (opts.music) this.stopMusic();
    const sound = new THREE.Audio(this.audioListener);
    sound.setBuffer(buffer);
    sound.setLoop(opts.loop ?? false);
    // The per-sound volume only. Master is the listener's job — multiplying it
    // in here as well applied it twice, so `ION.audio.volume = 0.5` actually
    // played new sounds at a quarter, while sounds already playing were only
    // halved.
    sound.setVolume(opts.volume ?? 1);
    this.liveSounds.add(sound);
    // A looping sound never ends on its own; a one-shot releases its nodes the
    // moment the buffer finishes.
    if (!(opts.loop ?? false)) {
      // three.js's own onEnded is what clears `isPlaying`; replacing it
      // outright rather than wrapping it would leave every finished sound
      // claiming to still be playing.
      const whenThreeIsDone = sound.onEnded.bind(sound);
      sound.onEnded = () => {
        whenThreeIsDone();
        this.releaseSound(sound);
      };
    }
    sound.play();
    if (opts.music) this.music = sound;
  }

  /** @internal */
  stopMusic(): void {
    if (!this.music) return;
    this.releaseSound(this.music);
    this.music = undefined;
  }

  /** Stops a sound if it is playing and takes its nodes back off the graph. */
  private releaseSound(sound: THREE.Audio): void {
    if (!this.liveSounds.delete(sound)) return;
    try {
      if (sound.isPlaying) sound.stop();
      sound.disconnect();
    } catch {
      // A source already ended cannot be stopped twice; nothing to recover.
    }
  }

  /** Silences everything this game started. Part of teardown — see onDispose. */
  private stopAllSounds(): void {
    for (const sound of [...this.liveSounds]) this.releaseSound(sound);
    this.music = undefined;
  }

  /** @internal */
  setMasterVolume(value: number): void {
    this.masterVolume = Math.max(0, Math.min(1, value));
    this.audioListener.setMasterVolume(this.masterVolume);
  }

  /** @internal — ION.audio.volume reads this back. */
  get volume(): number {
    return this.masterVolume;
  }

  /** @internal — ION.ui.showEndcard */
  showEndcard(): void {
    this.endcardUI.setVisible(true);
  }
}
