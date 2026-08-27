import type { Entity } from "./entity";

/**
 * The running game, for the high-level API to reach.
 *
 * `ION.*` and `new Entity()` have to work from inside a game class without the
 * caller passing anything around — that is most of what makes the simple API
 * simple. A module-level slot, bound by the game at construction and cleared
 * on teardown, is what allows it. It is deliberately not a lazily-created
 * singleton: a hot reload must be able to fully retire the previous game, and
 * something that rebuilds itself on first touch cannot be retired.
 */
/**
 * What the simple API is allowed to reach on the running game.
 *
 * Stated explicitly rather than letting `ION` hold an `IonGame` and read its
 * internals: the engine's own members are protected for a reason, and a
 * facade that widens them to public for its own convenience would hand every
 * game the advanced surface by accident. This lists exactly what the simple
 * layer needs and nothing else.
 */
export interface SimpleGameHost {
  registerEntity(entity: Entity): void;
  unregisterEntity(entity: Entity): void;

  readonly world: import("three").Scene;
  readonly assetLoader: import("../../../../src/engine/AssetLoader").AssetLoader;
  readonly rig: import("../../../../src/engine/core/CameraHandler").CameraHandler;
  readonly hud: import("../../../../src/engine/ui/UILayout").UILayout;
  readonly inputManager: import("../../../../src/engine/core/InputManager").InputManager;
  readonly stick: import("../../../../src/engine/core/DynamicJoystick").DynamicJoystick | undefined;
  readonly storeUrl: string;

  setCameraTarget(target: Entity | { x: number; y: number; z: number } | undefined): void;
  shakeCamera(strength: number, seconds: number): void;
  playSound(path: string, opts?: { volume?: number; loop?: boolean; music?: boolean }): void;
  stopMusic(): void;
  setMasterVolume(value: number): void;
  readonly volume: number;
  showEndcard(): void;
}

let active: SimpleGameHost | undefined;

export function bindActiveGame(host: SimpleGameHost | undefined): void {
  active = host;
}

export function getActiveGame(): SimpleGameHost | undefined {
  return active;
}

/** Throws a message that says what to do, rather than a TypeError on undefined. */
export function requireGame(what: string): SimpleGameHost {
  if (!active) {
    throw new Error(
      `${what} was used before the game started.\n` +
        "  Use it inside start() or update() in your game class, not at module top level."
    );
  }
  return active;
}
