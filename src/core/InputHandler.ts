/**
 * Virtual joystick input, built on pointer events (no external libs).
 * Exposes a normalized -1..1 axis that any entity (Player today, maybe
 * a vehicle or a second character later) can read each frame.
 */
export class InputHandler {
  /** Normalized -1..1 input axis. Read this each frame; do not mutate it. */
  readonly axis = { x: 0, y: 0 };

  private active = false;
  private pointerId: number | null = null;
  private readonly center = { x: 0, y: 0 };
  private readonly radius: number;

  constructor(
    private readonly base: HTMLElement,
    private readonly stick: HTMLElement,
    radius = 45,
    private readonly onFirstInput?: () => void
  ) {
    this.radius = radius;
    this.base.addEventListener("pointerdown", this.handlePointerDown);
    window.addEventListener("pointermove", this.handlePointerMove);
    window.addEventListener("pointerup", this.handlePointerUp);
    window.addEventListener("pointercancel", this.handlePointerUp);
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Removes all listeners this handler registered. Call if you ever tear down the game. */
  dispose(): void {
    this.base.removeEventListener("pointerdown", this.handlePointerDown);
    window.removeEventListener("pointermove", this.handlePointerMove);
    window.removeEventListener("pointerup", this.handlePointerUp);
    window.removeEventListener("pointercancel", this.handlePointerUp);
  }

  private getCenter(): void {
    const rect = this.base.getBoundingClientRect();
    this.center.x = rect.left + rect.width / 2;
    this.center.y = rect.top + rect.height / 2;
  }

  private handlePointerDown = (e: PointerEvent): void => {
    this.active = true;
    this.pointerId = e.pointerId;
    this.getCenter();
    this.updateStick(e.clientX, e.clientY);
    this.base.setPointerCapture(e.pointerId);
    this.onFirstInput?.();
  };

  private handlePointerMove = (e: PointerEvent): void => {
    if (!this.active || e.pointerId !== this.pointerId) return;
    this.updateStick(e.clientX, e.clientY);
  };

  private handlePointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.active = false;
    this.pointerId = null;
    this.axis.x = 0;
    this.axis.y = 0;
    this.stick.style.transform = "translate(0%, 0%)";
  };

  private updateStick(clientX: number, clientY: number): void {
    let dx = clientX - this.center.x;
    let dy = clientY - this.center.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > this.radius) {
      dx = (dx / dist) * this.radius;
      dy = (dy / dist) * this.radius;
    }
    this.stick.style.transform = `translate(calc(0% + ${dx}px), calc(0% + ${dy}px))`;
    this.axis.x = dx / this.radius;
    this.axis.y = dy / this.radius;
  }
}
