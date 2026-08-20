import { Group, Tween, Easing } from "three/examples/jsm/libs/tween.module.js";

/** Re-exported so game code gets easing curves without a second import path (or a second copy of tween.js). `Easing.Quadratic.Out`, `Easing.Back.Out`, `Easing.Elastic.Out`, ... */
export { Easing };

/** Everything scheduled hands one of these back. Cancelling is always safe — twice, after it already ran, or after the Scheduler was cleared. */
export interface ScheduledHandle {
  cancel(): void;
  readonly done: boolean;
}

export interface TweenOptions {
  /** An `Easing.*` curve. Default: linear. */
  easing?: (amount: number) => number;
  /** Seconds to wait before the tween starts moving. */
  delay?: number;
  onUpdate?: () => void;
  onComplete?: () => void;
}

/** One step of a sequence: wait `wait` seconds (from the previous step finishing), then run `then`. */
export interface SequenceStep {
  wait?: number;
  then?: () => void;
}

interface Timer {
  atMs: number;
  intervalMs: number | undefined;
  fn: () => void;
  cancelled: boolean;
  done: boolean;
}

/**
 * Timers, repeats, sequences, and tweens — all on *game time*, not wall
 * clock.
 *
 * That distinction is the whole reason this class owns a clock instead of
 * calling `performance.now()`: it only advances inside update(), which
 * IonEngine only calls when gameplay is actually running. So every timer
 * and tween automatically freezes while the UI editor overlay or the 3D
 * freecam is open, and resumes exactly where it left off — matching how
 * Game.ts's own `playTimeMs` auto-endcard accumulator already behaves.
 * A `setTimeout`-based scheduler would keep counting behind the editor and
 * fire the endcard while someone was mid-edit; this cannot.
 *
 * Playable ads are mostly timed beats — intro, hook, escalation, fail
 * state, endcard — so this is the difference between expressing that
 * shape directly and hand-rolling accumulators in every game class:
 *
 *   Ion.after(3, () => hud.showHook());
 *   Ion.sequence([
 *     { wait: 0.5, then: () => coin.pop() },
 *     { wait: 0.2, then: () => hud.bumpScore() },
 *   ]);
 *   Ion.tween(mesh.scale, { x: 1.4, y: 1.4, z: 1.4 }, 0.25, { easing: Easing.Back.Out });
 *
 * Tweens are three.js's own bundled tween.js (already shipped in the
 * bundle — no new dependency), driven off this same game clock rather
 * than its global `TWEEN.update()`, via a private Group. Nothing here
 * touches the shared/global tween group, so two Schedulers (or a stale
 * one mid-hot-reload) can never step on each other.
 */
export class Scheduler {
  private timers: Timer[] = [];
  private readonly tweens = new Group();
  private timeMs = 0;

  /** Seconds of game time elapsed since this Scheduler was created (i.e. excluding any paused stretches). */
  get now(): number {
    return this.timeMs / 1000;
  }

  /** Call once per frame with the same `dt` gameplay got. IonEngine does this; game code shouldn't need to. */
  update(dt: number): void {
    this.timeMs += dt * 1000;

    // Swap the list out before iterating: a timer callback is free to
    // schedule more work (a sequence step does exactly that), and those
    // new timers must land in the *next* list rather than being walked
    // by the loop that's currently running — otherwise a callback that
    // schedules a zero-delay timer would run it again in the same tick,
    // forever.
    const due = this.timers;
    this.timers = [];

    for (const timer of due) {
      if (timer.cancelled) continue;

      if (this.timeMs >= timer.atMs) {
        if (timer.intervalMs === undefined) {
          timer.done = true;
          timer.fn();
          continue; // one-shot: don't carry forward
        }
        timer.fn();
        if (timer.cancelled) continue;
        // Advance by exactly one interval rather than catching up to now:
        // a repeat slower than the frame rate should not fire a burst of
        // backdated calls after a long pause or a frame spike.
        timer.atMs += timer.intervalMs;
      }

      this.timers.push(timer);
    }

    this.tweens.update(this.timeMs);
  }

  /** Run `fn` once, `seconds` of game time from now. */
  after(seconds: number, fn: () => void): ScheduledHandle {
    return this.addTimer(seconds, undefined, fn);
  }

  /** Run `fn` every `seconds` of game time, starting one interval from now. Fires at most once per update() — a frame spike never produces a catch-up burst. */
  every(seconds: number, fn: () => void): ScheduledHandle {
    // *1000: this is added to atMs, which lives on the millisecond clock —
    // passing raw seconds here made a 0.1s repeat advance its next-fire
    // time by 0.1ms, i.e. fire on essentially every frame.
    return this.addTimer(seconds, Math.max(seconds, 0.001) * 1000, fn);
  }

  /**
   * Run steps back to back, each waiting its own `wait` after the previous
   * one finished. Cancelling the returned handle stops the whole chain,
   * including whichever step is currently pending.
   */
  sequence(steps: SequenceStep[]): ScheduledHandle {
    let index = 0;
    let cancelled = false;
    let finished = false;
    let pending: ScheduledHandle | undefined;

    const runNext = (): void => {
      if (cancelled) return;
      if (index >= steps.length) {
        finished = true;
        return;
      }
      const step = steps[index++];
      pending = this.after(step.wait ?? 0, () => {
        if (cancelled) return;
        step.then?.();
        runNext();
      });
    };
    runNext();

    return {
      cancel: () => {
        cancelled = true;
        pending?.cancel();
      },
      get done(): boolean {
        return finished || cancelled;
      },
    };
  }

  /**
   * Tween `target`'s numeric properties toward `to` over `seconds`.
   * Works on anything with number fields — most usefully a THREE.Vector3
   * (`mesh.position`, `mesh.scale`) or a plain object you read back in
   * onUpdate.
   */
  tween<T extends object>(target: T, to: Partial<T>, seconds: number, opts: TweenOptions = {}): ScheduledHandle {
    let finished = false;
    const tween = new Tween(target, this.tweens)
      .to(to, seconds * 1000)
      .delay((opts.delay ?? 0) * 1000);

    if (opts.easing) tween.easing(opts.easing);
    if (opts.onUpdate) tween.onUpdate(opts.onUpdate);
    tween.onComplete(() => {
      finished = true;
      opts.onComplete?.();
    });
    // Explicit start time on our own clock, not tween.js's default
    // `now()` wall clock — mixing the two would make the tween think it
    // started hours ago (this clock begins at 0) and snap instantly to
    // its end value.
    tween.start(this.timeMs);

    return {
      cancel: () => {
        finished = true;
        tween.stop();
      },
      get done(): boolean {
        return finished;
      },
    };
  }

  /** Drops every pending timer and tween. Called on teardown — see IonEngine's dispose path; without it, a hot-reloaded bundle's old timers would keep firing into the new game instance. */
  clear(): void {
    for (const timer of this.timers) timer.cancelled = true;
    this.timers = [];
    this.tweens.removeAll();
  }

  private addTimer(seconds: number, intervalMs: number | undefined, fn: () => void): ScheduledHandle {
    const timer: Timer = {
      atMs: this.timeMs + Math.max(seconds, 0) * 1000,
      intervalMs,
      fn,
      cancelled: false,
      done: false,
    };
    this.timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
      // "will never fire again" — true whether it ran to completion or was
      // cancelled, matching what sequence()'s handle reports. A caller
      // asking `done` wants to know if it still needs to care about this
      // handle, not which of the two ways it stopped.
      get done(): boolean {
        return timer.done || timer.cancelled;
      },
    };
  }
}
