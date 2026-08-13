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
 */
let uiEditorPaused = false;
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
  const activeGame = await Game.create(canvas);
  game = activeGame;
  activeGame.onGizmoModeChange((mode) => win.__onGizmoModeChanged?.(mode));

  let lastTime = performance.now();

  function loop(now: number): void {
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
