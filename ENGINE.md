# Ion Engine

Reference for the reusable engine layer this playable ad is built on — `src/engine/`. If you're building a *new* playable ad from this codebase, this is the part that's meant to carry over unchanged; `src/game/` is what you'd actually replace.

See [README.md](README.md) for setup, running, and the visual UI editor's day-to-day workflow. This file is about the engine's own architecture.

## The engine/game split

```
src/
  main.ts        entry point: canvas -> IonEngine.boot() (4 lines)
  engine/         reusable — never imports anything from game/
  game/           this specific playable ad — freely imports from engine/
```

The dependency direction only ever goes one way. `engine/` has no idea `HUD`, `Player`, or `CoinField` exist; `game/` builds on top of `engine/`'s generic pieces. Keeping this boundary intact is *the* thing that makes the engine actually reusable rather than reusable-in-theory.

## Boot sequence

```
main.ts
  → IonEngine.boot(canvas)
      → new IonEngine(canvas).start()
          → Game.create(canvas)              (game/Game.ts — asset preload, scene/camera/renderer, entities, UI)
          → installDevHooks(activeGame)       (window.__* hooks the Engine Room dev panel talks to)
          → requestAnimationFrame loop begins
```

`IonEngine` ([src/engine/IonEngine.ts](src/engine/IonEngine.ts)) owns *running* a game, not the game itself:

- The per-frame rAF loop (`update()`/`render()` each tick, capped `dt`, exponential-moving-average FPS)
- Dev-only hooks for the Engine Room panel (`index.html`, the dev entry — see `vite.config.mts`) — pause-while-editing, device-frame resize, freecam toggle, gizmo mode, live stats
- In-place hot-reload teardown — `main.ts` self-accepts its own Vite HMR updates (`import.meta.hot.accept()`) after every source/layout save instead of a full page navigation (so the UI editor's undo history and Connect session survive a Save). Each module execution is an isolated closure, so `IonEngine` reaches into the *previous* one via `window.__disposeGame` to tear it down before the new one takes over the same canvas, and a `window.__gameInstanceGeneration` counter stops the old RAF chain from rescheduling itself once superseded.

None of this exists in the production build — nothing in `src/index.template.html` or the shipped bundle ever calls any `window.__*` hook, so it's simply inert there.

## Engine modules

### `IonEngine.ts`
Boot/lifecycle wrapper — see above. Public surface: `IonEngine.boot(canvas)`, plus `.ui`/`.endcardUI` getters for reaching the running game's `UILayout` instances.

### `AssetLoader.ts`
Small caching loader for textures/GLB models/audio, built on Three.js's own loaders. `preload(manifest)` loads everything up front behind a single await — playable ads specifically can't afford a stutter the first time an asset is needed mid-gameplay, so nothing loads lazily. Also owns the generic `AssetKind`/`AssetEntry` types (`{kind: "texture"|"glb"|"audio", path: string}`) that a game's own asset manifest is built from — that shape lives here, not in game-specific code, since it describes the loader's contract, not any particular game's content.

### `core/DynamicJoystick.ts`
Touch-anywhere virtual joystick. Invisible until you touch the screen, then appears centered exactly where you touched — reuses whatever base/knob visuals were designed in the UI editor (color, size), only controls *where*/*when* they appear. Implementation notes worth knowing if you touch this file:
- Re-parents the joystick's `base`/`knob` DOM nodes to `document.body` — they originally live inside a `UILayout`-built wrapper that carries a CSS `transform` for anchor positioning, and a transformed ancestor becomes the *containing block* for any `position: fixed` descendant (per spec), not the viewport. Left nested, the joystick would never actually land under the pointer.
- Creates its own full-screen invisible "catcher" layer (`z-index: -1`, so any real designed button still wins its own clicks) rather than listening on the base/knob directly, since those roam to wherever you last touched.
- `dispose()` removes the body-reparented base explicitly — it's not inside any container a normal teardown would reach, which matters given `IonEngine`'s in-place hot-reload keeps the DOM alive across reloads.

### `core/CameraHandler.ts`
Generic lerp-follow camera — frame-rate-independent exponential smoothing (`1 - 0.001^dt`), takes a world-space focus point and an offset. No game-specific knowledge.

### `core/SceneInspector.ts` / `core/ViewHelperWidget.ts`
Dev-only. `SceneInspector` is the Engine Room's freecam scene hierarchy/inspector/transform-gizmo (Move/Rotate/Scale, click-to-select in the 3D view, live-editable Position/Rotation/Scale/Visible fields). `ViewHelperWidget` is the small red/green/blue axis gizmo mirroring camera orientation — its own tiny Three.js renderer, only constructed if `#er-viewhelper` exists in the page (i.e. never in production).

### `ui/UILayout.ts` + `ui/UILayoutTypes.ts`
The runtime half of the visual UI editor. `UILayoutTypes.ts` is the schema (`UIElementData`/`UILayoutData`) — percentage- or pixel-based positioning with 9-point anchors (mirrors Unity's `RectTransform`), image/text/rect/joystick/group element types, `renderOrder` (visual z-index, floats seeded 0.1 apart so inserting between two elements never forces renumbering) and `zOrder` (DOM-order tie-break for touch/pointer hit-priority, independent of visual stacking). `UILayout.ts` renders that JSON into real DOM: a wrapper node per element carries the static anchor transform, a separate content node carries any CSS animation, so the two never fight over the `transform` property.

**Screen resizing/UI scaling — locked, final, verified.** Every element (top-level or nested in a group) is a real DOM descendant of its real parent — the container itself, or the parent group's real rendered box — with no intermediate fixed-resolution wrapper. `%` fields resolve as plain native CSS `%` against that real parent, unchanged from how CSS `%` has always worked (this is what makes a full-bleed background correctly reach the real edges on any aspect ratio). `px` fields (position and size alike) are multiplied by one uniform `pxScale()` factor — `Math.min(scaleX, scaleY)`, where `scaleX`/`scaleY` are the live container size against the layout's own fixed `canvasWidth`×`canvasHeight` design resolution — so a `px` value scales the same amount on every axis regardless of aspect ratio (a joystick stays circular instead of ballooning into an oval in landscape). Text `font-size` is `fontSizePct`% of the container's *current real height*, recomputed every resize — deliberately not a CSS `vh` unit and deliberately not `pxScale()`-corrected. These formulas are written to be **identical** to `tools/ui-editor.html`'s own `pxScale()`/`elemScreenWidth`/`elemScreenHeight`/`elemScreenX`/`elemScreenY`/`renderCanvas()` geometry and its text font-size formula — the editor is the source of truth for what a layout should look like, and `UILayout.ts` is written to reproduce it exactly, not to be "an equivalent system." **If this ever needs to change, change the same formula in both files together** — see the `ion-engine-architect` skill's "Screen Resizing & UI Scaling System" section for the full history of why (an earlier fixed-resolution "stage" + outer `transform: scale()` approach looked correct but stretched text badly enough at extreme aspect ratios to clip words in half; the fix was deleting that stage entirely, not patching around it).

### `entities/Entity.ts`
The one contract a game entity needs to satisfy: `{ object3D: THREE.Object3D; update(dt, elapsed): void; dispose?(): void }`. Deliberately minimal — `game/entities/Player.ts` and `game/entities/Coin.ts` both implement it, `game/entities/CoinField.ts` owns a pool of the latter.

### `Bindings.ts`
Runtime half of the UI editor's Scripts panel drag-and-drop. `applyBindings(instance, className, bindingsData, ...layouts)` resolves every saved binding for `className` against the given `UILayout`s and writes each straight onto `instance`. One explicit call per wired class (there's no reflection/DI container behind compiled JS classes to do this invisibly) — see [game/ui/HUD.ts](src/game/ui/HUD.ts) for the pattern: call it once in the constructor, right after `super`/field declarations, so a field like `public moneyIcon: HTMLElement | undefined` gets populated from whatever was assigned in the editor, no manual `layout.get("name")` lookup needed for that field.

## The UI editor and its dev-server API

`tools/ui-editor.html` (standalone) / `public/ui-editor.html` (synced copy, embedded as an overlay iframe in the dev preview) is a single-file vanilla-JS visual editor — Layers panel, canvas at true 1:1 scale, Properties panel, and a read-only Scripts panel.

It talks to `scripts/dev-build-api.js` (localhost:8001, dev-only, started by `npm run dev`) rather than the browser's File System Access API whenever that server is reachable — no folder-picker step, no permission dialog, no risk of writing to the wrong directory, works in any browser:

| Endpoint | Purpose |
|---|---|
| `GET /version` | Engine Room panel's version/commit readout |
| `POST /build` | Engine Room's Builder button — runs `build.sh`, returns the final `dist/index.html` byte size |
| `POST /save-layout`, `GET /load-layout`, `GET /list-layouts` | Layout JSON read/write (`src/game/ui/{mainLayout,endcardLayout}.json`, `src/game/ui/layouts/*.json`) |
| `GET /list-scripts` | Scripts panel file list — `*/ui/*.ts` only (the only files that can have assignable fields) |
| `GET /script-info` | A script's classes + public/private fields (brace-depth text scan, not a real TS parse — see the file's own doc comment for why) |
| `GET /list-bindings`, `POST /save-binding`, `POST /remove-binding` | The drag-and-drop field↔element assignments — `src/game/ui/bindings.json` |

## Building a new playable ad on this engine

1. Replace everything under `src/game/` with your own entities/world/UI — keep `src/engine/` untouched.
2. `src/main.ts` stays as-is (`IonEngine.boot(canvas)`); it doesn't know or care what game is running.
3. Design your HUD/endcard in the visual editor exactly as before — `tools/ui-editor.html` has no game-specific knowledge either.
4. If a UI-layer class needs a designed element without a manual lookup, follow `HUD.ts`'s pattern: declare a public field, assign it via the Scripts panel (drag or ⊙ Pick), call `applyBindings(this, "YourClassName", bindingsData, ...layouts)` once in the constructor.

## Production build

`build.sh` bundles+minifies `src/main.ts` (engine and game code together — there's no separate engine bundle) via Vite (`vite.config.prod.mts` + `vite-plugin-singlefile`), building `src/index.template.html` — a minimal page shell with none of the dev-only Engine Room chrome — into a single `dist/index.html` with the JS inlined directly. A post-build step then base64-inlines every real asset (textures, models, audio — referenced as plain runtime string paths in `assets.ts`, so Vite's own module graph never sees them) straight into that same file. Single self-contained `dist/index.html`, no server needed. See README.md's "Going fully single-file" section for the asset-inlining caveat if you need a true one-file upload for an ad network.
