# Cube Roll — Playable Ad (Three.js + TypeScript)

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
Opens at **http://localhost:8000**. esbuild watches `src/` and rebuilds on
save; the page live-reloads itself. Before starting, a `predev` hook
copies `assets/` into `public/assets/` (via `scripts/sync-assets.js`) so
texture/model/audio paths resolve the same way in dev as in production.
Re-run `npm run dev` (or just `node scripts/sync-assets.js`) after adding
new asset files — or after editing `tools/ui-editor.html` itself — while
the server is already running; esbuild's watcher only covers `src/`, so
neither is picked up automatically otherwise. Editing `tools/ui-editor.html`
while `npm run dev` has been running for a while and the editor overlay
seems stuck on old behavior is almost always this.

`npm run dev` (`scripts/dev.js`) actually runs two processes: esbuild's
own watch+serve on **:8000**, and a tiny build-trigger API
(`scripts/dev-build-api.js`) on **:8001** for the Engine Room panel's
**Builder** button (see below) — both dev-only, both stop cleanly on
Ctrl+C. If the Builder button ever says "API offline", that second
process didn't start; restart `npm run dev`.

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
Bundles + minifies `main.ts` (and Three.js) into `dist/bundle.js`, inlines
it into `dist/index.html`, and copies `assets/` to `dist/assets/`. Open
`dist/index.html` directly — no server needed.

## Visual UI editor (Unity-style)

`tools/ui-editor.html` is a drag-and-drop editor for placing sprites/
images, text, rects, and joysticks on top of the game. Two ways to use it:

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
1. Click **+ Image**/**+ Text**/**+ Rect**/**+ Joystick** to add an
   element (images are embedded as base64, so a saved layout file is
   fully self-contained).
2. Drag it into place on the canvas; drag the red handle to resize (from
   center).
3. Use the **Properties** panel for precise X/Y/width/height, rotation,
   opacity, anchor point (Unity RectTransform-pivot style), an idle
   **animation** (pulse/bob/spin/fadeIn), and whether it's **visible on
   game start** (toggle later via `game.ui.show()`/`hide()`). Each of
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
4. Reorder layers with the ▲/▼ buttons in the **Layers** panel (left).
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
it in the editor.

**Test coverage**: `scripts/test-ui-editor.js` (run with `node
scripts/test-ui-editor.js`) drives the editor headlessly — adding
elements, dragging, resizing, changing anchors, uploading an image, and
saving — and asserts the output JSON matches the schema `UILayout.ts`
expects. Useful as a regression check if you modify the editor.



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
    ui/
      HUD.ts                    thin wrapper over the two UILayout instances: setScore, hideDragHint, showEndCard, onCtaClick
      mainLayout.json            gameplay HUD + joystick (edit via the visual editor, not by hand)
      endcardLayout.json         end-card title + CTA (edit via the visual editor, not by hand)
tools/
  ui-editor.html               standalone visual UI editor — open directly, no build needed
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
- `src/index.template.html` — production page shell with a
  `/*BUNDLE_PLACEHOLDER*/` marker where compiled JS gets inlined
- `public/index.html` — dev-only page shell that loads `bundle.js` as an
  external script (so live-reload works); not shipped in the final build
- `public/assets/` — auto-generated copy of `assets/`, created by
  `scripts/sync-assets.js` before `npm run dev` (gitignored)
- `public/ui-editor.html` — auto-generated copy of `tools/ui-editor.html`,
  same script, so the Engine Room panel's **✏️ Editor** button has
  something to open (gitignored)
- `scripts/dev.js` — runs esbuild's watch+serve and the build-trigger API
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


To point the CTA at your real store listing, edit the `alert(...)` call
in `src/main.ts` and rebuild.
