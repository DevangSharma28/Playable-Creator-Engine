export type Listener<T> = (payload: T) => void;

export interface EventHandle {
  unsubscribe(): void;
}

/**
 * Generic publish/subscribe. `on()`/`emit()` take an explicit type
 * parameter per call site (`bus.on<{ total: number }>("score", fn)`)
 * rather than a globally-declared event-name-to-payload map — no module
 * augmentation, no central registry of every event a game might ever
 * fire. That's a deliberate fit with this codebase's own style (explicit
 * over clever — see Bindings.ts's own "no reflection/DI container" note):
 * a payload type mismatch between an emit() and its on() is still a real
 * TypeScript error at both call sites, it's just checked locally instead
 * of through a shared declaration.
 *
 * The reusable part for a new playable: HUD/gameplay wiring today mostly
 * means one system reaching into another directly (CoinField takes an
 * onCollect callback, HUD is handed the score to display). A shared bus
 * replaces that with `emit("coin-collected", {total})` /
 * `on("coin-collected", fn)` — HUD never needs a reference to CoinField,
 * and a third system (an achievement tracker, a VFX trigger) can listen
 * to the same event without CoinField's constructor changing at all.
 */
export class EventBus {
  private readonly listeners = new Map<string, Set<Listener<unknown>>>();

  on<T = void>(event: string, fn: Listener<T>): EventHandle {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener<unknown>);
    return {
      unsubscribe: () => {
        set!.delete(fn as Listener<unknown>);
      },
    };
  }

  /** Auto-unsubscribes after the first matching emit(). */
  once<T = void>(event: string, fn: Listener<T>): EventHandle {
    const handle = this.on<T>(event, (payload) => {
      handle.unsubscribe();
      fn(payload);
    });
    return handle;
  }

  emit<T = void>(event: string, payload: T): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    // Snapshot before iterating — a handler unsubscribing itself (once())
    // or subscribing a new one mid-emit must not mutate the live Set
    // while this loop is walking it.
    for (const fn of [...set]) (fn as Listener<T>)(payload);
  }

  /** Drops every listener. Called on teardown — see IonEngine's dispose path; without it a hot-reloaded bundle's old listeners would keep firing into whatever the new instance emits with the same event name. */
  clear(): void {
    this.listeners.clear();
  }
}
