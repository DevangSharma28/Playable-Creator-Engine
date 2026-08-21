export interface Axis {
  x: number;
  y: number;
}

export interface TapInfo {
  x: number;
  y: number;
}

export interface SwipeInfo {
  dx: number;
  dy: number;
  distance: number;
  /** Radians, screen convention (0 = right, increasing clockwise since screen-space y grows downward) — atan2(dy, dx). */
  angle: number;
  durationMs: number;
}

export interface DragInfo {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

export interface InputHandle {
  unsubscribe(): void;
}

/** Below this, a press is a tap regardless of how long it was held. */
const TAP_MAX_DISTANCE = 12;
/** Beyond this, a press that already exceeded TAP_MAX_DISTANCE is classified a swipe, not just an aborted tap. */
const SWIPE_MIN_DISTANCE = 30;

// Screen-space keys (dx = right positive, dy = down positive) — matches
// DynamicJoystick.axis's own convention exactly (see its updateStick:
// axis.x/y come straight from clientX/clientY deltas, unmodified), so a
// keyboardAxis value is a drop-in substitute wherever joystick.axis is
// consumed today, no sign-flipping needed at the call site.
const KEY_AXIS: Record<string, [number, number]> = {
  w: [0, -1],
  arrowup: [0, -1],
  s: [0, 1],
  arrowdown: [0, 1],
  a: [-1, 0],
  arrowleft: [-1, 0],
  d: [1, 0],
  arrowright: [1, 0],
};

/**
 * Generic pointer input (tap/swipe/drag) plus a keyboard axis fallback —
 * independent of DynamicJoystick, which already owns a working, locked
 * pointer-catching implementation for the one thing it does (a virtual
 * stick) and isn't touched here. This is for everything DynamicJoystick
 * was never meant to cover: a tap-to-interact mechanic, a swipe-to-dodge
 * gesture, free-drag camera control, or — the case wired into this game,
 * see Game.ts — a keyboard fallback so movement is testable at a desk
 * without a touchscreen.
 *
 * Listens on `target` (default `window`), classifying each press by
 * distance/duration on release: under TAP_MAX_DISTANCE is a tap; over
 * SWIPE_MIN_DISTANCE is a swipe; onDragMove fires continuously for
 * anything in between (or beyond), for callers that want raw deltas
 * regardless of how the gesture ends up classified.
 */
export class InputManager {
  readonly keyboardAxis: Axis = { x: 0, y: 0 };

  private readonly target: EventTarget;
  private readonly tapListeners = new Set<(info: TapInfo) => void>();
  private readonly swipeListeners = new Set<(info: SwipeInfo) => void>();
  private readonly dragStartListeners = new Set<(info: DragInfo) => void>();
  private readonly dragMoveListeners = new Set<(info: DragInfo) => void>();
  private readonly dragEndListeners = new Set<(info: DragInfo) => void>();

  private downX = 0;
  private downY = 0;
  private downAtMs = 0;
  private pointerId: number | null = null;
  private dragging = false;

  /** Which keys are currently held, keyed by the same lowercase strings KEY_AXIS uses — lets multiple keys (e.g. W and D) combine instead of the last keydown silently overwriting the others. */
  private readonly heldKeys = new Set<string>();

  private firedFirstInput = false;

  /**
   * Set false while something else legitimately owns the keyboard — the
   * dev 3D Viewer/Editor does this for its whole session (see
   * Game.setFreecam). W/A/S/D here and the editor's W/E/R/Q gizmo
   * shortcuts both listen on `window`, so they can't be separated by
   * event propagation (stopPropagation does nothing between two listeners
   * on the same target, and stopImmediatePropagation only reaches
   * listeners registered later — this one is registered first, in Game's
   * constructor). Suspending is the honest fix: without it, pressing W to
   * switch the gizmo to Move also counted as the player's very first
   * input and started the background music mid-edit.
   */
  private enabled = true;

  constructor(
    target: EventTarget = window,
    /** Fired once, on whichever comes first: a pointerdown or a movement keydown. Same purpose as DynamicJoystick's own constructor param of the same name (see Game.ts) — a keyboard-only desktop tester needs this too, or nothing ever unlocks audio for them. */
    private readonly onFirstInput?: () => void
  ) {
    this.target = target;
    target.addEventListener("pointerdown", this.onPointerDown as EventListener);
    target.addEventListener("pointermove", this.onPointerMove as EventListener);
    target.addEventListener("pointerup", this.onPointerUp as EventListener);
    target.addEventListener("pointercancel", this.onPointerUp as EventListener);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    // A held key doesn't get a matching keyup if focus leaves the page/tab
    // mid-press (alt-tab, a devtools breakpoint) — without this, keyboardAxis
    // could get stuck non-zero forever, moving the player with no key held.
    window.addEventListener("blur", this.onBlur);
  }

  /** Suspends/resumes keyboard *and* pointer gesture handling. Suspending clears any held keys immediately, so a key still down when the editor opens can't leave the axis stuck non-zero for the whole session. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.heldKeys.clear();
      this.recomputeKeyboardAxis();
      this.pointerId = null;
      this.dragging = false;
    }
  }

  onTap(fn: (info: TapInfo) => void): InputHandle {
    this.tapListeners.add(fn);
    return { unsubscribe: () => this.tapListeners.delete(fn) };
  }

  onSwipe(fn: (info: SwipeInfo) => void): InputHandle {
    this.swipeListeners.add(fn);
    return { unsubscribe: () => this.swipeListeners.delete(fn) };
  }

  onDragStart(fn: (info: DragInfo) => void): InputHandle {
    this.dragStartListeners.add(fn);
    return { unsubscribe: () => this.dragStartListeners.delete(fn) };
  }

  onDragMove(fn: (info: DragInfo) => void): InputHandle {
    this.dragMoveListeners.add(fn);
    return { unsubscribe: () => this.dragMoveListeners.delete(fn) };
  }

  onDragEnd(fn: (info: DragInfo) => void): InputHandle {
    this.dragEndListeners.add(fn);
    return { unsubscribe: () => this.dragEndListeners.delete(fn) };
  }

  dispose(): void {
    this.target.removeEventListener("pointerdown", this.onPointerDown as EventListener);
    this.target.removeEventListener("pointermove", this.onPointerMove as EventListener);
    this.target.removeEventListener("pointerup", this.onPointerUp as EventListener);
    this.target.removeEventListener("pointercancel", this.onPointerUp as EventListener);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.tapListeners.clear();
    this.swipeListeners.clear();
    this.dragStartListeners.clear();
    this.dragMoveListeners.clear();
    this.dragEndListeners.clear();
    this.heldKeys.clear();
    this.keyboardAxis.x = 0;
    this.keyboardAxis.y = 0;
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    if (e.button !== 0 || this.pointerId !== null) return; // one gesture at a time — a second finger down mid-gesture is ignored, not layered on top
    this.pointerId = e.pointerId;
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.downAtMs = performance.now();
    this.dragging = false;
    this.fireFirstInputOnce();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    const dx = e.clientX - this.downX;
    const dy = e.clientY - this.downY;
    if (!this.dragging) {
      this.dragging = true;
      for (const fn of this.dragStartListeners) fn({ x: e.clientX, y: e.clientY, dx, dy });
    }
    for (const fn of this.dragMoveListeners) fn({ x: e.clientX, y: e.clientY, dx, dy });
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    const dx = e.clientX - this.downX;
    const dy = e.clientY - this.downY;
    const distance = Math.hypot(dx, dy);
    const durationMs = performance.now() - this.downAtMs;

    if (this.dragging) {
      for (const fn of this.dragEndListeners) fn({ x: e.clientX, y: e.clientY, dx, dy });
    }

    if (distance <= TAP_MAX_DISTANCE) {
      for (const fn of this.tapListeners) fn({ x: e.clientX, y: e.clientY });
    } else if (distance >= SWIPE_MIN_DISTANCE) {
      const angle = Math.atan2(dy, dx);
      for (const fn of this.swipeListeners) fn({ dx, dy, distance, angle, durationMs });
    }

    this.pointerId = null;
    this.dragging = false;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return; // the 3D Viewer/Editor owns the keyboard — see setEnabled
    if (this.isTypingTarget()) return; // never steal keystrokes from Control Desk / the UI editor's own text fields — same guard SceneInspector.onKeyDown already uses
    const key = e.key.toLowerCase();
    if (!(key in KEY_AXIS)) return;
    this.heldKeys.add(key);
    this.recomputeKeyboardAxis();
    this.fireFirstInputOnce();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const key = e.key.toLowerCase();
    if (!(key in KEY_AXIS)) return;
    this.heldKeys.delete(key);
    this.recomputeKeyboardAxis();
  };

  private onBlur = (): void => {
    this.heldKeys.clear();
    this.recomputeKeyboardAxis();
  };

  private fireFirstInputOnce(): void {
    if (this.firedFirstInput) return;
    this.firedFirstInput = true;
    this.onFirstInput?.();
  }

  private isTypingTarget(): boolean {
    const el = document.activeElement as HTMLElement | null;
    return el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || !!el?.isContentEditable;
  }

  private recomputeKeyboardAxis(): void {
    let x = 0;
    let y = 0;
    for (const key of this.heldKeys) {
      const [kx, ky] = KEY_AXIS[key];
      x += kx;
      y += ky;
    }
    const len = Math.hypot(x, y);
    // Normalize only when combined keys would otherwise exceed magnitude 1
    // (e.g. W+D held together) — a single key's own unit vector is left
    // exactly as-is rather than re-normalized to itself.
    if (len > 1) {
      x /= len;
      y /= len;
    }
    this.keyboardAxis.x = x;
    this.keyboardAxis.y = y;
  }
}
