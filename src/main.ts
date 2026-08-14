import { Game } from "./Game";

const canvas = document.getElementById("game") as HTMLCanvasElement;

/**
 * Dev-only hooks, both inert in the production build (no caller exists
 * there — nothing in src/index.template.html or the shipped bundle calls
 * either of these).
 *
 * __setUIEditorPaused: the "Edit UI" overlay in public/index.html calls
 * this to pause gameplay (joystick input, coin collection, the 15s
 * auto-endcard timer) while it's open, without blanking the screen —
 * render() still runs every frame, so the last frame stays visible as a
 * live backdrop.
 *
 * __resizeGameTo: the device-frame simulator in public/index.html calls
 * this to size the renderer/camera to a letterboxed box instead of the
 * real window, for previewing a fixed aspect ratio (e.g. 16:9 landscape)
 * within your actual browser window.
 *
 * __getEngineStats: the Engine Room panel polls this for its FPS/draw
 * calls/triangles readout.
 *
 * __setFreecamActive: the Engine Room "3D View" button calls this to pause
 * gameplay update() (same reason as __setUIEditorPaused — player/camera
 * would otherwise fight OrbitControls) while it hands the camera to
 * Game.setFreecam(); render() keeps running so the scene stays visible.
 *
 * __setGizmoMode: the Engine Room panel's Select/Move/Rotate/Scale toolbar
 * (only meaningful, and only shown, while freecam/3D View is active) calls
 * this to switch SceneInspector's transform gizmo.
 *
 * __onGizmoModeChanged: the reverse direction — SceneInspector also lets you
 * switch modes via keyboard (W/E/R/Q), so this is how the Engine Room
 * panel's toolbar buttons find out and update their own active-highlight
 * to match, instead of only ever reflecting clicks on themselves.
 *
 * __disposeGame / __gameInstanceGeneration: dev-only, in-place hot-reload.
 * public/index.html swaps in a freshly-rebuilt bundle.js after every
 * source/layout save (see its own comment on the "/esbuild" change
 * listener) instead of doing a full page navigation, specifically so the
 * UI editor overlay's own in-memory session (undo history, unsaved edits,
 * Connect state) survives a Save — a full reload used to wipe all of it
 * out from under you every time. Each bundle execution is its own isolated
 * closure with no shared state, so the *new* one has to reach back into the
 * *old* one via `window` to tear it down — see main() below.
 */
let uiEditorPaused =
  // Derived from the real DOM, not defaulted to false — this module-level
  // state resets to its initial value on every in-place reload, but the
  // editor overlay's own visibility (owned by public/index.html, never
  // touched by a bundle swap) doesn't. Without this, saving a layout while
  // the editor is open would silently un-pause gameplay underneath it —
  // the joystick, coin pickup, and the 15s auto-endcard timer would all
  // start running again behind the still-open editor.
  document.getElementById("ui-editor-frame")?.style.display === "block";
let freecamActive = false;
let game: Game | undefined;
let fps = 0;
const win = window as unknown as {
  __setUIEditorPaused?: (paused: boolean) => void;
  __resizeGameTo?: (width: number, height: number) => void;
  __getEngineStats?: () => { fps: number; drawCalls: number; triangles: number };
  __setFreecamActive?: (active: boolean) => void;
  __setGizmoMode?: (mode: string) => void;
  __onGizmoModeChanged?: (mode: string) => void;
  __disposeGame?: () => void;
  __gameInstanceGeneration?: number;
};
win.__setUIEditorPaused = (paused) => {
  uiEditorPaused = paused;
};
win.__resizeGameTo = (width, height) => {
  game?.resizeTo(width, height);
};
win.__setFreecamActive = (active) => {
  freecamActive = active;
  game?.setFreecam(active);
};
win.__getEngineStats = () => ({
  fps: Math.round(fps),
  drawCalls: game?.rendererStats.drawCalls ?? 0,
  triangles: game?.rendererStats.triangles ?? 0,
});
win.__setGizmoMode = (mode) => {
  game?.setGizmoMode(mode as Parameters<Game["setGizmoMode"]>[0]);
};

async function main(): Promise<void> {
  // Tear down whatever a *previous* bundle execution left running on this
  // same canvas before creating a new one — a no-op on a real first page
  // load (nothing's registered this hook yet). See the doc comment above.
  win.__disposeGame?.();

  const activeGame = await Game.create(canvas);
  game = activeGame;
  win.__disposeGame = () => activeGame.dispose();
  activeGame.onGizmoModeChange((mode) => win.__onGizmoModeChanged?.(mode));

  // Every bundle execution bumps this and captures its own copy below —
  // loop() checks it's still the most recent one on every frame, so an
  // old, superseded execution's RAF chain quietly stops rescheduling
  // itself instead of rendering alongside the new one into the same
  // canvas/WebGL context.
  win.__gameInstanceGeneration = (win.__gameInstanceGeneration ?? 0) + 1;
  const myGeneration = win.__gameInstanceGeneration;

  let lastTime = performance.now();

  function loop(now: number): void {
    if (win.__gameInstanceGeneration !== myGeneration) return;

    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    // Exponential moving average — an instantaneous 1/dt reading jitters
    // too much frame to frame to be readable.
    if (dt > 0) fps = fps === 0 ? 1 / dt : fps * 0.9 + (1 / dt) * 0.1;

    if (!uiEditorPaused && !freecamActive) activeGame.update(dt, now / 1000);
    activeGame.render();

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

main();
