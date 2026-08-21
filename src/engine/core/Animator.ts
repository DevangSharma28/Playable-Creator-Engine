import { Ion, Easing } from "../Ion";
import type { ScheduledHandle } from "./Scheduler";

export interface AnimatorOptions {
  /** Seconds for progress to go from 0 to 1. */
  time: number;
  /** Seconds to wait before progress starts moving. Default 0. */
  delay?: number;
  /** Shapes the raw linear progress before it reaches onProgress — `Easing.Back.Out`, `Easing.Elastic.Out`, etc. (see Scheduler.ts's re-export). Default: linear, i.e. progress really is `elapsed / time`. */
  easing?: (amount: number) => number;
}

/**
 * `new Animator({ time, delay }, (progress) => { ... }, onComplete)` — a
 * bare 0-to-1 progress driver for anything that isn't a plain "tween this
 * object's numeric fields toward a target" (Ion.tween already does that
 * one directly). Scale-and-rotate-together, a shader uniform, a screen
 * shake magnitude, driving a custom easing curve by hand — anywhere the
 * caller wants the raw number and will decide what to do with it itself.
 *
 * Self-driving: construct it and walk away. `onProgress` fires on its own
 * every tick until it reaches 1 — nothing needs to call into this from a
 * game object's own `update()`, and nothing needs to hold onto the
 * instance either (the underlying tween registers itself with the
 * Scheduler's tween group directly, so it isn't reference-counted; keep
 * the instance around only if you might want to `cancel()` it early).
 *
 * A thin wrapper over `Ion.tween`, deliberately — not a second animation
 * clock. It tweens a private `{ t: 0 }` object to `{ t: 1 }` and hands
 * `t` to `onProgress` on every update, so it inherits everything
 * `Ion.tween`/`Scheduler` already gets right for free: game-time pausing
 * (freezes correctly while the UI editor or 3D freecam is open, same as
 * every other timer in this engine), and teardown (`Scheduler.clear()` on
 * hot-reload/dispose cancels it along with everything else — nothing
 * Animator-specific to clean up).
 *
 * Same constraint as any other `Ion.*` call: usable only once
 * `IonEngine.boot()` has actually bound a running game — a class built
 * *during* `Game.create()` (most entity constructors) is too early. Defer
 * to that entity's own first `update()` tick instead (see `Player.ts`'s
 * `revealPopcornMachine` for the pattern) — see `Ion.ts`'s own doc
 * comment for the full reasoning.
 */
export class Animator {
  private readonly handle: ScheduledHandle;

  constructor(options: AnimatorOptions, onProgress: (progress: number) => void, onComplete?: () => void) {
    const state = { t: 0 };
    this.handle = Ion.tween(state, { t: 1 }, options.time, {
      delay: options.delay,
      easing: options.easing ?? Easing.Linear.None,
      onUpdate: () => onProgress(state.t),
      onComplete,
    });
  }

  /** Stops the animation wherever it currently is — onComplete does not fire. Safe to call twice, or after it already finished. */
  cancel(): void {
    this.handle.cancel();
  }

  /** True once finished or cancelled — never fires again either way. */
  get done(): boolean {
    return this.handle.done;
  }
}

export interface LoopAnimatorOptions extends AnimatorOptions {
  /** How many cycles to run before stopping and calling onComplete. Default `Infinity` — runs until `cancel()`. */
  loops?: number;
  /** Alternate direction each cycle (0→1, then 1→0, then 0→1, ...) instead of restarting from 0→1 every time — a back-and-forth pulse/breathe/shake instead of a repeating ramp. Default false. */
  yoyo?: boolean;
}

/**
 * `new LoopAnimator({ time, loops, yoyo }, (progress) => { ... }, onComplete)`
 * — `Animator`, but it doesn't stop at 1. A pulsing glow, an idle bob, a
 * spinning coin, a screen-shake that decays over a few cycles: anything
 * that's "run this progress curve repeatedly" instead of once.
 *
 * Not a second implementation — each cycle *is* a real `Animator`,
 * restarted from that one's own `onComplete`. That's what keeps this
 * exempt from needing its own correctness story: every cycle inherits
 * `Animator`'s (game-time pausing, hot-reload teardown) exactly, because
 * every cycle genuinely is one.
 *
 * `delay` (from `AnimatorOptions`) only applies once, before the first
 * cycle — a delayed *restart* between cycles isn't what "loop" means here.
 * `loops` counts individual cycles, not round trips: `{ loops: 2, yoyo:
 * true }` runs 0→1 then 1→0, not 0→1→0 twice.
 *
 * Same too-early-for-`Ion` constraint as `Animator` — see its own doc
 * comment.
 */
export class LoopAnimator {
  private current: Animator | undefined;
  private cancelled = false;
  private cyclesLeft: number;
  private reversed = false;

  constructor(
    private readonly options: LoopAnimatorOptions,
    private readonly onProgress: (progress: number) => void,
    private readonly onComplete?: () => void
  ) {
    this.cyclesLeft = options.loops ?? Infinity;
    this.startCycle(options.delay);
  }

  /** Stops after the current cycle's next tick — onComplete does not fire. Safe to call twice, or after it already finished. */
  cancel(): void {
    this.cancelled = true;
    this.current?.cancel();
  }

  /** True once every requested cycle has finished, or it was cancelled. Never true for the default `loops: Infinity`, short of cancelling it. */
  get done(): boolean {
    return this.cancelled || this.cyclesLeft <= 0;
  }

  private startCycle(delay?: number): void {
    this.current = new Animator({ time: this.options.time, delay, easing: this.options.easing }, (t) => this.onProgress(this.reversed ? 1 - t : t), () => this.onCycleComplete());
  }

  private onCycleComplete(): void {
    if (this.cancelled) return;
    if (this.options.yoyo) this.reversed = !this.reversed;

    if (this.cyclesLeft !== Infinity) {
      this.cyclesLeft--;
      if (this.cyclesLeft <= 0) {
        this.onComplete?.();
        return;
      }
    }
    this.startCycle(); // no delay — only the very first cycle waits
  }
}
