import type { Scheduler, ScheduledHandle, SequenceStep, TweenOptions } from "./core/Scheduler";
import type { EventBus, EventHandle, Listener } from "./core/EventBus";
import type { ColliderManager } from "./collision/ColliderManager";
import { Cta, type CtaNetwork } from "./Cta";

/** Re-exported so `import { Ion, Easing } from "./Ion"` is one line, one path — Scheduler.ts already re-exports it from tween.js for the same reason, this just closes the loop for callers going through the facade instead of Scheduler directly. `Easing.Quadratic.Out`, `Easing.Back.Out`, `Easing.Elastic.Out`, ... */
export { Easing } from "./core/Scheduler";

/**
 * The one-line-call facade over the engine's runtime services.
 *
 * Bound once by IonEngine.boot() (see bindIon below) and unbound on
 * teardown — deliberately *not* a self-initializing static singleton
 * holding its own state. The difference matters for two reasons this
 * codebase already cares about:
 *
 *  - Hidden global state is the thing that quietly rots the engine/game
 *    split: a static that lazily builds its own Scene/Scheduler on first
 *    touch ends up owning engine state nobody can see, reset, or inject.
 *    Here the state lives in a real IonContext that IonEngine constructs
 *    and owns; `Ion` is only a typed shorthand for reaching it.
 *  - In-place hot reload (see IonEngine's dispose path) has to be able to
 *    fully retire the previous bundle's services. An unbindable facade
 *    can do that; a lazily-self-initializing one can't, and the old
 *    instance's timers would keep firing into the new game.
 *
 * Using it before boot throws with a real explanation rather than a
 * TypeError on undefined — that mistake is otherwise very confusing,
 * since it only happens at module top level or in a constructor that runs
 * before Game.create() resolves.
 *
 *   Ion.after(3, () => hud.showHook());
 *   Ion.tween(mesh.scale, { x: 1.4, y: 1.4, z: 1.4 }, 0.25, { easing: Easing.Back.Out });
 *   Ion.cta(STORE_URL);
 *
 * For tests (or anything wanting no globals at all), the same services
 * are reachable directly off the context — `Ion` is a convenience, never
 * the only way in.
 */
export interface IonContext {
  scheduler: Scheduler;
  bus: EventBus;
  colliders: ColliderManager;
}

let context: IonContext | undefined;

/** Called by IonEngine.boot() once a Game and its services actually exist. */
export function bindIon(ctx: IonContext): void {
  context = ctx;
}

/**
 * Called on teardown. Pass the context being retired so a *stale* dispose
 * (an old bundle tearing down after the new one already bound its own
 * context — real, and exactly what IonEngine's generation counter guards
 * the RAF loop against) can't unbind the live one out from under it.
 */
export function unbindIon(ctx?: IonContext): void {
  if (!ctx || context === ctx) context = undefined;
}

function required(): IonContext {
  if (!context) {
    throw new Error(
      "Ion used before IonEngine.boot() finished — Ion's services only exist once a Game has been created. " +
      "Move this call into gameplay code (a constructor that runs after Game.create(), an update(), or an event handler) rather than module top level."
    );
  }
  return context;
}

export const Ion = {
  /** Seconds of game time since boot — excludes any stretch where gameplay was paused (UI editor, freecam). */
  get time(): number {
    return required().scheduler.now;
  },

  /**
   * The ION Collider & Area system — trigger zones, area volumes, and the
   * player's own collision shape. Not physics: no rigidbodies, no forces,
   * no gravity, nothing that moves a scene object. See
   * engine/collision/ColliderManager.ts.
   *
   *   const zone = Ion.colliders.box({ name: "PlayerZone", tag: "PlayerZone", isTrigger: true, mask: ["Player"], size: [4, 3, 4] });
   *   zone.onTriggerEnter("Player", () => hud.showPrompt());
   *
   * Unlike the rest of this facade, this one is deliberately usable from an
   * *entity constructor*: IonEngine binds the context before Game.create()
   * runs precisely so an entity can register its own collider at the point
   * it builds its model, rather than deferring to its first update() tick.
   */
  get colliders(): ColliderManager {
    return required().colliders;
  },

  /** Run `fn` once, `seconds` from now (game time — pauses with gameplay). */
  after(seconds: number, fn: () => void): ScheduledHandle {
    return required().scheduler.after(seconds, fn);
  },

  /** Run `fn` every `seconds` (game time). Fires at most once per frame — no catch-up bursts after a spike. */
  every(seconds: number, fn: () => void): ScheduledHandle {
    return required().scheduler.every(seconds, fn);
  },

  /** Run steps back to back; cancelling the handle stops the whole chain. The natural way to express a playable's beat structure. */
  sequence(steps: SequenceStep[]): ScheduledHandle {
    return required().scheduler.sequence(steps);
  },

  /** Tween numeric properties (a THREE.Vector3, a plain object, ...) over `seconds`. */
  tween<T extends object>(target: T, to: Partial<T>, seconds: number, opts?: TweenOptions): ScheduledHandle {
    return required().scheduler.tween(target, to, seconds, opts);
  },

  /**
   * Fire the install/click-through through whichever ad-network API is
   * actually present. Stateless — the only thing here that works before
   * boot, since it just inspects `window`. See engine/Cta.ts.
   */
  cta(storeUrl: string): CtaNetwork {
    return Cta.open(storeUrl);
  },

  /** Subscribe to `event`. Payload type is inferred from `fn`, or pass it explicitly: `Ion.on<{total: number}>("coin-collected", fn)`. See core/EventBus.ts for why there's no global event-name registry. */
  on<T = void>(event: string, fn: Listener<T>): EventHandle {
    return required().bus.on(event, fn);
  },

  /** Same as on(), but auto-unsubscribes after the first matching emit. */
  once<T = void>(event: string, fn: Listener<T>): EventHandle {
    return required().bus.once(event, fn);
  },

  /** Fire `event` — every current subscriber runs synchronously, in subscription order. */
  emit<T = void>(event: string, payload: T): void {
    required().bus.emit(event, payload);
  },
};
