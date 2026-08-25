# ION Engine — Playable Ad and Web Game (Three.js + TypeScript)

A tiny playable ad: roll a character around a platform with a virtual
joystick, collect 6 coins, get an "Install Now" end card either when you
collect them all or after 15s.

## Setup
```bash
npm install
```

## Live preview on localhost (while editing)
```bash
npm run dev
```
Opens at **http://localhost:8000**. Vite watches `src/` and hot-reloads on
save — `src/main.ts` self-accepts its own updates (`import.meta.hot.accept()`)
so a save re-runs `IonEngine.boot()` in place instead of a full page
reload, which is what lets the UI editor overlay's undo history/unsaved
edits survive a Save instead of getting wiped out by a navigation. Before
starting, a `predev` hook copies `assets/` into `public/assets/` (via
`scripts/sync-assets.js`) so texture/model/audio paths resolve the same
way in dev as in production. Re-run `npm run dev` (or just `node
scripts/sync-assets.js`) after adding new asset files — or after editing
`tools/ui-editor.html` itself — while the server is already running;
Vite's own watcher only covers `src/`, so neither is picked up
automatically otherwise. Editing `tools/ui-editor.html` while `npm run
dev` has been running for a while and the editor overlay seems stuck on
old behavior is almost always this.

`npm run dev` (`scripts/dev.js`) actually runs two processes: Vite's own
dev server on **:8000** (config: `vite.config.mts`), and a tiny
build-trigger API (`scripts/dev-build-api.js`) on **:8001** for the
Engine Room panel's **Builder** button (see below) — both dev-only, both
stop cleanly on Ctrl+C. If the Builder button ever says "API offline",
that second process didn't start; restart `npm run dev`.

## Engine Room (dev panel)

Top-right of the dev preview, dev-only. Two rows today, room for more:
- **✏️ Editor** / **🛠 Builder** buttons. Editor opens the same UI layout
  editor overlay as before (just moved here from its old top-left spot).
  Builder POSTs to the local API above, which runs the real `build.sh`
  and opens a small modal reporting the final `dist/index.html` size
  against the ~5MB single-file budget — same build as running it from
  the terminal, just without leaving the browser.
- **Live stats**: FPS (smoothed), draw calls, and triangle count, read
  straight from `renderer.info` every ~400ms — real numbers from the
  actual running scene, not an estimate. Below that, a small view-helper
  gizmo (red/green/blue X/Y/Z axes) mirrors the main camera's current
  orientation each frame — `src/engine/core/ViewHelperWidget.ts`, a separate
  tiny Three.js renderer, not tied to the main scene.

None of this exists in the production build — `Game.ts` only creates the
view helper if `#er-viewhelper` is actually in the page, and the stats/
build hooks in `main.ts` are simply never called there.

## Type-check only (no bundling)
```bash
npm run typecheck
```

## Production build (single self-contained file)
```bash
npm run build      # or ./build.sh
```
Bundles + minifies `main.ts` (and Three.js) via Vite (config:
`vite.config.prod.mts`), inlines it directly into `dist/index.html`
(`vite-plugin-singlefile`), then base64-inlines every real asset
(textures, models, audio) straight into that same file — no
`dist/assets/` folder, nothing else to upload. Open `dist/index.html`
directly — no server needed.

## Visual UI editor (Unity-style)

`tools/ui-editor.html` is a drag-and-drop editor for building the UI that
sits on top of the game. Fourteen element types — image, text, rect,
group, joystick, button, progress bar, slider, toggle, checkbox, sprite
(spritesheet-animated), video, shape and icon — plus gradients, masks,
shadows, hover/pressed/disabled states, and declarative click actions.
Two ways to use it:

- **Embedded, live** (recommended): click **✏️ Editor** in the
  **Engine Room** panel, top-right of the dev preview (`npm run dev`).
  It opens as a transparent overlay
  *inside the running game* — you're editing directly against the real
  3D scene, not a mockup — and pauses gameplay (joystick, coin
  collection, the 15s auto-endcard timer) while it's open so drag
  gestures don't fight the game's own input. Click **✕ Close** (top
  right of the toolbar) to dismiss it and resume.
- **Standalone**: open `tools/ui-editor.html` directly in a browser (or
  double-click it). Useful outside a running dev server; shows a plain
  dark backdrop instead of the live game since there's nothing to show
  through.

```bash
open tools/ui-editor.html      # macOS
xdg-open tools/ui-editor.html  # Linux
```

Either way the canvas is always the real, current viewport at true 1:1
scale — there's no separate design-canvas size or zoom to manage. Check
an element's **🔒 Lock aspect ratio** (or use a **PX** size — see below)
to keep its shape from stretching if you test at a different window size
or orientation.

**Device-frame simulator** — the **Real / Landscape 16:9 / Portrait
16:9** tabs top-center of the dev preview letterbox the actual running
game (not a mockup) to a fixed aspect ratio within your browser window,
so you can preview a phone-ish shape without resizing the window itself.
This resizes the real Three.js renderer/camera and the real HUD, and its
exact box is broadcast into the editor overlay too, so whichever tab is
active, both the game and the editor agree on where the "screen" is.
Switching tabs works whether the editor is open or closed.

**Workflow:**
1. **＋ Insert** (or <kbd>I</kbd>) opens the element palette; images come
   in through the 🖼️ button beside it and are embedded as base64, so a
   saved layout file is fully self-contained.
2. Drag it into place — it snaps to sibling edges/centers and to guides
   pulled off a ruler. Eight handles resize it (dragging pins the
   opposite edge; **Alt** scales about the center, **Shift** keeps the
   ratio), and the grip above it rotates.
3. Use the **Properties** panel for precise X/Y/width/height, rotation,
   opacity, anchor point (Unity RectTransform-pivot style), fill (solid
   or gradient), typography, an idle **animation**, hover/pressed
   **states**, click **actions**, and whether it's **visible on game
   start** (toggle later via `game.ui.show()`/`hide()`). Each of
   X/Y/Width/Height has its own **%** / **PX** toggle:
   - **%** (default) stretches proportionally with the screen — the
     right choice for anything that should stay centered or
     proportionally placed on any screen shape.
   - **PX** is a literal, fixed pixel value that never stretches — for
     size, that's what stops a locked-aspect shape (e.g. the joystick)
     from ballooning into an oval on an unusual aspect ratio. For
     position, it's an offset from the *anchor's own point* (Unity's
     `anchoredPosition`): a middle-center anchor's point is the true
     center, so `0,0` sits exactly there on any screen; a corner anchor's
     point is that corner, so e.g. bottom-left `32,32` sits 32px in from
     it — matching the real joystick-base's own hardcoded
     `left: 32px; bottom: 32px` in `public/index.html`.
4. Reorder layers with the ▲/▼ buttons in the **Layers** panel (left),
   which also has a filter box, collapsible groups, and per-row lock and
   visibility toggles. The **Assets** and **Prefabs** tabs beside it hold
   reusable images and saved selections. Watch the **✅ badge** in the
   toolbar for problems (duplicate names, missing sources, dead action
   targets) before they become a broken ad.
5. **Project sync** — Save/Load write straight into the project, no
   download-and-move step, via whichever of these is available:
   - **Local dev server** (default whenever `npm run dev` is running):
     detected automatically, no setup — `scripts/dev-build-api.js` already
     has real filesystem access rooted at the actual project directory, so
     there's no folder to pick and no browser permission to grant. The
     **🔗 Connect** button hides itself entirely once this is active.
   - **🔗 Connect Project** (Chrome/Edge only — File System Access API):
     fallback for when the dev server isn't reachable. Pick your project's
     root folder or `src/game/ui/` directly — either works, it finds
     `src/game/ui/` automatically — once. This also auto-loads
     `mainLayout.json`, so the editor opens already showing what you're
     actually looking at.
   - Either way: **💾 Save** writes straight to
     `src/game/ui/layouts/<Layout name>.json` (type a **Layout name** +
     optional **Tag** in the toolbar first). **📂 Load** shows only *this
     project's* saved layouts from `src/game/ui/layouts/`, each labeled
     with its tag — not a generic OS file browser. **⭐ Set as Main**
     writes the current layout to `src/game/ui/mainLayout.json` — the
     gameplay HUD, joystick, and anything else visible while playing.
     **🏁 Set as Endcard** writes to `src/game/ui/endcardLayout.json` —
     hidden until the game ends (win or the 15s timer), then shown as one
     group. Both are what `Game.ts` actually bundles; the dev server picks
     up either and live-reloads automatically.
   - With neither available (no dev server, unsupported browser, never
     connected), **Save**/**Load** fall back to a plain download/pick-a-file
     flow — move the file to `src/game/ui/mainLayout.json` or
     `src/game/ui/endcardLayout.json` by hand and rebuild.

There is no hardcoded game UI anywhere in `public/index.html` or
`src/index.template.html` — score, title, drag hint, the joystick, and
the end card's title/CTA button are all just named elements in one of
these two layouts, same as any sprite you place. The joystick specifically
must be a `"joystick"`-type element named exactly **`joystick`** in
`mainLayout.json` (the toolbar's **+ Joystick** button already names it
that) — `Game.ts` looks it up by that name and wires real touch input to
whatever base/knob you designed; if it's missing, the game throws loudly
on load rather than shipping with no controls. The end card's button is
similarly just a rect named **`cta-button-bg`** with `setInteractive`
called on it from `HUD.ts`.

Everything renders through `src/engine/ui/UILayout.ts` at runtime. Each layout is
decorative by default (doesn't block touches); call
`game.ui.setInteractive("layerName", onClick)` (mainLayout) or
`game.endcardUILayout.setInteractive(...)` (endcardLayout) from `Game.ts`
if you want a specific placed sprite to act as a button, or `.setText(...)`
/ `.setImage(...)` to update something at runtime by the `name` you gave
it in the editor. Controls have their own accessors —
`.setValue(name, n)` / `.getValue(name)` for a progress bar or slider,
`.isOn(name)` for a toggle or checkbox.

Buttons can also do things without any code. `show`, `hide`,
`toggleVisible` and `setText` actions run entirely in the runtime; `cta`
fires the configured store link; and `emit` sends a named event to
`ui.onAction((event, el) => …)`, which is how a designed button triggers
something game-specific without the engine ever learning your game's
vocabulary.

**Keyboard**: press `?` in the editor for the full list.

**Test coverage**: `npm test` runs everything. The UI-specific suites are
`tests/ui-editor.test.mjs` (drives the editor page headlessly through its
real controls), `tests/ui-layout.test.mjs` (the runtime renderer against a
real DOM), `tests/geometry-parity.test.mjs` (asserts the editor and the
runtime compute *identical* geometry, exactly — not approximately), and
`tests/render-defaults-parity.test.mjs` (asserts they agree on every
default too). Run them if you modify either side; they exist because
editor/runtime drift here has shipped silently before.



`src/game/assets.ts` is the single source of truth for every asset path,
grouped by type:

```ts
import { libTex, libGlb, libAudio } from "./assets";

libTex.coin        // "./assets/textures/coin.png"
libGlb.cube        // "./assets/models/cube.glb"
libAudio.bgMusic   // "./assets/audio/bg_music.mp3"
```

Add new assets by (1) dropping the file under `assets/<textures|models|audio|fonts>/`
and (2) adding a line to the matching namespace in `assets.ts`, plus an
entry in `manifest` if you want it preloaded automatically.

`src/engine/AssetLoader.ts` is a small cached, typed loader built on top of that
registry:

```ts
import { AssetLoader } from "./AssetLoader";
import { manifest, libTex } from "./assets";

const loader = new AssetLoader();

await loader.preload(manifest, (loaded, total) => {
  console.log(`Loading ${loaded}/${total}`);
});

const coinTexture = loader.getTexture(libTex.coin);   // sync, already resolved
const cubeModel = loader.instantiateGlb(libGlb.cube);  // fresh clone, safe to place multiple times
scene.add(cubeModel);
```

Why preload everything up front instead of loading lazily during
gameplay: a hitch the first time something spawns (e.g. the first coin)
reads as jank in a 15–30 second ad and hurts engagement. Gate your game
start on `preload()` resolving and show a loading bar/spinner instead.

The player character (`assets/models/MainCharacter.glb`, incl. animation
clips) is loaded through this registry via `Game.create()`. `libTex` /
`libAudio` / `libFont` are still empty — add entries there the same way
when you wire in textures, sound, or fonts.

### Single-file by default (zero extra HTTP requests)

`build.sh` inlines every `./assets/...` path the bundle references as a
base64 `data:` URI directly into `dist/index.html` — there's no
`dist/assets/` folder, no relative paths, nothing else to upload.
`AssetLoader` doesn't care — `THREE.TextureLoader` and friends accept a
data URI exactly like a file path, so `assets.ts` keeps using normal
paths (`"./assets/models/player.glb"`) and never needs hand-written data
URIs. The result opens directly via `file://` and works on any ad network
that only accepts one file.

The Engine Room panel's **🛠 Builder** button runs this and reports the
final size against most networks' ~5MB single-file budget.

## Architecture

`Game.ts` is the top-level orchestrator: every system is built once in its
constructor and driven each frame from `update()`/`render()`. `IonEngine.ts`
owns *running* that — the rAF loop, the dev-only Engine Room hooks, and the
in-place hot-reload dance — so it's the one piece meant to stay identical
across any playable ad built on this engine; `Game.ts` (Player, CoinField,
the coin-collect win condition, ...) is what actually differs between them.
`main.ts` itself is just the entry point that connects a canvas to the two:

`src/` itself is split in two: `engine/` is everything reusable across any
playable ad built on this engine (rAF loop, dev tooling, camera/joystick/
UI-layout systems, asset loading); `game/` is everything specific to *this*
one (Player, CoinField, the coin-collect win condition, this HUD's exact
element names, ...). The dependency direction only ever goes one way —
`game/` freely imports from `engine/`, `engine/` never imports anything
from `game/` — so `engine/` stays honestly reusable if you start a second
playable ad from this same base later.

```
src/
  main.ts                 entry point: canvas -> IonEngine.boot() (4 lines)
  engine/                  reusable across any playable ad built on this engine
    IonEngine.ts             engine wrapper — rAF loop, dev hooks, hot-reload
    AssetLoader.ts           cached loader (textures/GLB/audio) with progress reporting; also owns the generic AssetKind/AssetEntry shape
    core/
      DynamicJoystick.ts       touch-anywhere virtual joystick -> normalized {x,y} axis
      CameraHandler.ts         generic lerp-follow camera behavior
      SceneInspector.ts        dev-only Engine Room freecam hierarchy/inspector/gizmo
      ViewHelperWidget.ts      dev-only Engine Room X/Y/Z gizmo — its own tiny renderer, only built if #er-viewhelper exists
    ui/
      UILayout.ts                runtime renderer for layouts designed in tools/ui-editor.html
      UILayoutTypes.ts           shared schema for the layout JSON
    particles/                 ION Particle & VFX — GPU-instanced, one draw call per emitter
      ParticleManager.ts         registry + PARTICLES group + frame driver (Ion.particles)
      ParticleSimulation.ts      the single per-frame update pipeline over every module
      ParticleRenderer.ts        InstancedBufferGeometry + instanced attributes
      ...                        see ENGINE.md for the full module list
    entities/
      Entity.ts                shared contract: object3D + update() + optional dispose()
  game/                    this specific playable ad
    Game.ts                  this ad's orchestrator — wiring + game-specific logic
    assets.ts                typed registry of every asset path this ad uses (libTex/libGlb/libAudio)
    world/
      World.ts                 static scene setup: lights, ground, walls, fog
    entities/
      Player.ts                 the controllable character (animated GLB model)
      Coin.ts                   a single collectible
      CoinField.ts              owns all coins: spawning, animation, pickup detection
    particles.json              particle effects authored in the 3D editor's Particle System mode
    ui/
      HUD.ts                    thin wrapper over the two UILayout instances: setScore, hideDragHint, showEndCard, onCtaClick
      mainLayout.json            gameplay HUD + joystick (edit via the visual editor, not by hand)
      endcardLayout.json         end-card title + CTA (edit via the visual editor, not by hand)
tools/
  ui-editor.html               standalone visual UI editor — open directly, no build needed
tests/
  particles.test.mjs           particle simulation over typed arrays
  particle-shader.test.mjs     every #ifdef combination the renderer emits compiles
  geometry-parity.test.mjs     editor and runtime compute identical geometry, exactly
  render-defaults-parity.test.mjs  ...and identical defaults, with no `||` fallbacks
  ui-layout.test.mjs           runtime renderer against a real DOM
  ui-editor.test.mjs           the editor page driven through its real controls
  lib/                         shared source-extraction / TS-loading helpers
```

**Adding a new gameplay object** (Enemy, Worker, a particle burst, a second
collectible type, etc.) follows the same shape every time:
1. Create `src/game/entities/Enemy.ts` implementing `Entity` (from
   `src/engine/entities/Entity.ts` — an `object3D` plus an
   `update(dt, elapsed)` method, widen the signature if it needs more
   inputs, the way `Player.update()` takes a joystick axis).
2. Instantiate it in `Game`'s constructor.
3. Call its `update()` from `Game.update()`.

Nothing else needs to change — `main.ts` and the render loop stay
untouched, and other systems don't need to know the new entity exists.

**Why this split**: each file answers one question (how does the camera
move? what does the joystick report? what does the ground look like?) so
changes stay local — swapping the camera style or redesigning the HUD
touches exactly one file, not `Game.ts`.

## Other files
- `index.html` — dev-only page shell (the Engine Room panel, device-frame
  simulator, UI editor overlay), Vite's dev entry (`vite.config.mts`);
  loads `/src/main.ts` as a real ES module, not shipped in the final build
- `src/index.template.html` — production page shell, Vite's build entry
  for `build.sh` (`vite.config.prod.mts`) — a minimal shell with none of
  the dev-only Engine Room chrome, loading `./main.ts`
- `public/assets/` — auto-generated copy of `assets/`, created by
  `scripts/sync-assets.js` before `npm run dev` (gitignored)
- `public/ui-editor.html` — auto-generated copy of `tools/ui-editor.html`,
  same script, so the Engine Room panel's **✏️ Editor** button has
  something to open (gitignored)
- `vite.config.mts` / `vite.config.prod.mts` — dev-server and
  production-build Vite configs, respectively (deliberately separate —
  see `vite.config.prod.mts`'s own doc comment for why)
- `scripts/dev.js` — runs Vite's dev server and the build-trigger API
  together for `npm run dev`; forwards Ctrl+C to both
- `scripts/dev-build-api.js` — the Engine Room **🛠 Builder** button's
  backing API, `127.0.0.1:8001`, dev-only, runs `build.sh` on request
- `scripts/sync-assets.js` — copies `assets/` -> `public/assets/` and
  `tools/ui-editor.html` -> `public/ui-editor.html` for dev serving
- `assets/` — your actual texture/model/audio/font files
- `src/game/ui/layouts/` — saved layout variants from the UI editor's
  **🔗 Connect Project** sync (created on first connect; tracked in git
  like any other source file — not build output)
- `dist/` — build output (`npm run build`)


## Particle & VFX system

The 3D editor's **✨ Particle System** mode (toolbar, or `P` while the
editor is open) authors ION particle effects: Box/Sphere/Cone emitters
with sixteen collapsible modules, live preview transport, emission-volume
gizmos, thirteen starter presets (Smoke, Fire, Sparks, Dust, Explosion,
Magic, Hit Impact, Coin Burst, Confetti, Trail, Rain, Snow, Energy
Burst), and a measured cost readout. Effects live under an engine-owned
`PARTICLES` group in the Hierarchy and save to `src/game/particles.json`,
which is a real import — so what you author is what ships.

From gameplay:

```ts
import { Ion } from "../engine/Ion";

Ion.particles.getByName("Coin Burst")?.playAt(coin.position);
Ion.particles.setQuality("low");   // scales every effect down at once
```

See [ENGINE.md](ENGINE.md)'s `particles/` section for the architecture —
why it's instanced quads rather than `THREE.Points`, how the
structure-of-arrays buffer works, and what makes a disabled module
genuinely free.

## Tests

```bash
npm test            # typecheck + particle simulation + UI geometry parity
npm run test:particles
npm run test:geometry
```

`tests/particles.test.mjs` covers the simulation math — emission rates and
bursts, lifetimes, buffer capacity and swap-remove, gravity, seeded
determinism in both directions, shape sampling, collision, module gating,
curves and gradients, and the lifecycle transitions.

---

To point the CTA at your real store listing, edit `STORE_URL` in
`src/game/Game.ts` and rebuild. Every CTA (HUD button, endcard, and the
crash-recovery overlay) routes through that one constant via
`Cta.open()`, which picks the right ad-network API automatically.
