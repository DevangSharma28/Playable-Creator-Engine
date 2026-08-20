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
- The `Scheduler` (timers/tweens), the `EventBus`, and the `Ion` facade binding — created here because the loop is what drives them and teardown is what must retire them
- **Crash guard**: `update()`/`render()` run inside a `try/catch`. If gameplay throws, the loop stops rescheduling itself for good (a dead RAF chain is the right outcome — continuing to call into a broken instance just throws again next frame, forever, for no benefit) and `core/CrashOverlay.ts` shows a minimal, dependency-free "Continue" overlay wired to `Cta.open()`, so a mid-game crash still gets its CTA click rather than being a 100% wasted ad. `IonEngineOptions.onCrash` is an optional add-on for logging, itself wrapped in a try/catch so it can't block the recovery UI.
- **Timestep**: variable frame-length `dt` by default (unchanged from how every existing system here was tuned). `IonEngine.boot(canvas, { fixedTimestep: 1/60 })` opts into a fixed-step accumulator instead — `update()` may then run several times per animation frame, always with that exact `dt`, while `render()` still runs once. Turn it on when determinism matters: anything integrating forces or resolving collisions will visibly jitter (or tunnel through a collider) on a frame spike under variable `dt`, because one 50ms step is not three 16ms ones. Capped at 5 steps per frame — past that the backlog is dropped rather than spiralling.
- Dev-only hooks for the Engine Room panel (`index.html`, the dev entry — see `vite.config.mts`) — pause-while-editing, device-frame resize, freecam toggle, gizmo mode, live stats
- In-place hot-reload teardown — `main.ts` self-accepts its own Vite HMR updates (`import.meta.hot.accept()`) after every source/layout save instead of a full page navigation (so the UI editor's undo history and Connect session survive a Save). Each module execution is an isolated closure, so `IonEngine` reaches into the *previous* one via `window.__disposeGame` to tear it down before the new one takes over the same canvas, and a `window.__gameInstanceGeneration` counter stops the old RAF chain from rescheduling itself once superseded.

None of this exists in the production build — nothing in `src/index.template.html` or the shipped bundle ever calls any `window.__*` hook, so it's simply inert there.

## Engine modules

### `IonEngine.ts`
Boot/lifecycle wrapper — see above. Public surface: `IonEngine.boot(canvas)`, plus `.ui`/`.endcardUI` getters for reaching the running game's `UILayout` instances.

### `AssetLoader.ts`
Small caching loader for textures/GLB models/audio, built on Three.js's own loaders. `preload(manifest)` loads everything up front behind a single await — playable ads specifically can't afford a stutter the first time an asset is needed mid-gameplay, so nothing loads lazily. Also owns the generic `AssetKind`/`AssetEntry` types (`{kind: "texture"|"glb"|"audio", path: string}`) that a game's own asset manifest is built from — that shape lives here, not in game-specific code, since it describes the loader's contract, not any particular game's content.

Its `GLTFLoader` has `setMeshoptDecoder(MeshoptDecoder)` wired unconditionally in the constructor (`three/examples/jsm/libs/meshopt_decoder.module.js`) so it can decode `EXT_meshopt_compression` GLBs — see "Production build" below for where that compression actually gets applied. Harmless for a GLB that was never meshopt-compressed (the decoder only engages for primitives that carry the extension), and single-file-safe: that module's WASM is inlined as a base64 byte array in the JS itself, not fetched from a separate `.wasm` file, so it bundles like any other import instead of needing something hosted alongside `dist/index.html`.

### `Ion.ts` — the one-line facade
`Ion.after()`, `Ion.every()`, `Ion.sequence()`, `Ion.tween()`, `Ion.on()`/`Ion.once()`/`Ion.emit()`, `Ion.cta()`, `Ion.time`. A **bound singleton**, not a self-initializing static: `IonEngine.boot()` constructs an `IonContext` and calls `bindIon(ctx)`; teardown calls `unbindIon(ctx)`. Deliberate, for two reasons this codebase already cares about — a static that lazily builds its own services ends up owning engine state nobody can see or reset (the `§28 no hidden global state` rule), and in-place hot reload has to be able to *fully* retire the previous bundle's services or its timers keep firing into the new game. `unbindIon` takes the context being retired so a late dispose from an old bundle can't unbind the live one. Using `Ion` before boot throws with a real explanation instead of a `TypeError` on undefined.

The same services are always reachable directly off the context — `Ion` is a shorthand, never the only way in, so tests can drive a `Scheduler` with no globals at all.

### `core/Scheduler.ts`
Timers, repeats, sequences, and tweens — all on **game time**, not wall clock. It owns a clock that only advances inside `update()`, which `IonEngine` only calls when gameplay is actually running, so everything scheduled freezes while the UI editor overlay or the 3D freecam is open and resumes exactly where it left off. That matches `Game.ts`'s own `playTimeMs` auto-endcard accumulator; a `setTimeout`-based scheduler would keep counting behind the editor and fire the endcard mid-edit.

```ts
Ion.after(3, () => hud.showHook());
Ion.every(0.5, () => spawner.tick());
Ion.sequence([
  { wait: 0.5, then: () => coin.pop() },
  { wait: 0.2, then: () => hud.bumpScore() },
]);
Ion.tween(mesh.scale, { x: 1.4, y: 1.4, z: 1.4 }, 0.25, { easing: Easing.Back.Out });
```

Everything returns a `ScheduledHandle` (`cancel()`, `done`) — safe to cancel twice, after it ran, or after `clear()`. `done` means "will never fire again," true whether it completed or was cancelled.

Behaviors worth knowing (each has a regression test in the verification suite): `every()` fires **at most once per frame** — a 5-second frame spike produces one call, not a 50-call catch-up burst; a callback that schedules more work runs that work on the *next* tick, not the current one (otherwise a zero-delay self-rescheduling timer would spin forever inside one update); tweens run on a **private** tween.js `Group` fed this same game clock, never the library's global `TWEEN.update()`, so two Schedulers — or a stale one mid-hot-reload — can't step on each other.

Tweens are three.js's already-bundled `tween.module.js`. No new dependency: it was already in the bundle (`Easing` is re-exported from `Scheduler.ts` so game code doesn't need a second import path).

### `core/EventBus.ts`
Generic publish/subscribe — `Ion.on(event, fn)` / `Ion.once(event, fn)` / `Ion.emit(event, payload)`. Deliberately **no** globally-declared event-name-to-payload map (no module augmentation, no central event registry) — payload type is inferred from the listener, or given explicitly per call site: `Ion.on<{total: number}>("coin-collected", fn)`. Matches this codebase's existing explicit-over-clever style (the same reasoning `Bindings.ts` gives for not using a reflection/DI container) — a mismatched payload type between an `emit()` and its `on()` is still a real compile error at both sites, just checked locally instead of through a shared declaration.

The reusable part: HUD↔gameplay wiring today mostly means one system holding a direct reference to another (`CoinField` takes an `onCollect` callback, `HUD` is hand-fed the score). A shared bus replaces that with `emit`/`on` by name — `HUD` never needs a `CoinField` reference, and a third listener (an achievement tracker, a VFX trigger) can hook the same event without touching `CoinField`'s constructor. Owned by `IonEngine` (like `Scheduler`) and cleared on teardown for the same reason: a hot-reloaded bundle's old listeners must not keep firing into whatever the new instance emits under the same event name.

### `core/CrashOverlay.ts`
The crash guard's own recovery UI (see the Boot sequence section above) — plain DOM nodes, inline styles only, one call to the stateless `Cta`. Deliberately independent of `Game`/`HUD`/`UILayout`: whatever just threw could have left any of that machinery in a broken state, so the recovery path can't risk depending on it. `setCrashRecoveryUrl(url)` registers the store URL the recovery button's `Cta.open()` call uses — called once by `Game.ts` at module load with the same URL its own CTA buttons use, **not** threaded through `IonEngine.boot()`'s options, so `main.ts` stays genuinely identical across every playable built on this engine (see "Building a new playable ad" below). Safe to leave unset: the three network-owned `Cta` paths (Mindworks/Meta/Google) never read a URL at all.

### `core/InputManager.ts`
Generic pointer input (tap/swipe/drag classification by distance+duration on release) plus a keyboard axis fallback (WASD/arrows) — independent of `DynamicJoystick`, which already owns a locked, working pointer implementation for the one thing it does and isn't touched here. `keyboardAxis` uses the exact same `{x, y}` screen-space sign convention as `DynamicJoystick.axis` (down/right positive) — a drop-in substitute wherever `joystick.axis` is consumed, no sign-flipping at the call site.

Wired into this game's own `Game.ts` as a desktop-testing fallback: `combinedAxis()` returns the joystick's axis whenever it's non-zero (actively held), falling back to `keyboardAxis` only while the joystick is neutral — so a touch drag can never fight a stale held key. Takes an `onFirstInput` constructor callback, same shape and purpose as `DynamicJoystick`'s own — a keyboard-only tester needs to unlock audio too, or music never starts for them. Also guards against stealing keystrokes from a focused `<input>`/`<textarea>`/contenteditable (Control Desk, the UI editor's own fields) — same convention `SceneInspector.onKeyDown` already uses — and clears held keys on window `blur`, so alt-tabbing mid-press can't leave `keyboardAxis` stuck non-zero forever.

### `MraidAdapter.ts` / `MindworksAdapter.ts`
Two ad-network host adapters, each wrapping a different, incompatible convention — read `Cta.ts` below first if the CTA flow is what brought you here; these are the primitives it composes, not something game code should normally call directly outside of lifecycle hooks.

`MraidAdapter` wraps the IAB MRAID API most networks inject (`window.mraid` — Mintegral, AppLovin, Unity Ads, ironSource, Meta, Google Ad Manager). `isPresent` is the "are we in *any* ad network" check every other method depends on. `onReady(fn)` matters more than it looks: MRAID's own methods are unreliable before the host reports `"ready"`, and the WebView hosting the ad can still be mid-layout (sometimes literally 0×0) the instant this script starts — worse, an MRAID host isn't guaranteed to ever fire a native DOM `resize` once it settles, it has its own `ready`/`sizeChange` events instead. `Game.ts` calls `onReady`/`onSizeChange` specifically to force a fresh resize once the host actually confirms ready, independent of whatever the native `resize` listener does or doesn't do — without it, a renderer sized once at construction can stay wrong (invisible, in the 0×0 case) for the whole session. `openStoreUrl` goes through `mraid.open()`, never plain `window.open`/navigation — WebViews routinely block or silently swallow that, and `mraid.open()` is also what fires the install-click event the network bills on.

`MindworksAdapter` wraps a separate, simpler, Mintegral-specific handshake (see [playturbo.com/review/doc](https://www.playturbo.com/review/doc)) — plain `window.install`/`gameEnd`/`gameReady` the host defines and this calls, plus `window.gameStart`/`gameClose` this *exposes* for the host to call in. `gameReady()` matters even though it looks optional: the review tool's own loading overlay waits for it, so a playable that never calls it looks stuck/blank in review despite booting fine. `exposeLifecycleHooks(onStart, onClose)` registers real no-op functions even with nothing to do — the review tool checks they exist as *callable functions*, regardless of whether the host ever actually invokes them. Both `isPresent` checks are independent (a host can speak MRAID without being Mindworks, or vice versa) — that's why `Cta.detect()` checks `MindworksAdapter.isPresent` first rather than folding it into MRAID's own check.

### `Cta.ts` — one call for every ad network
The only thing a CTA/install button should ever call. Every network wants the click routed through its own API, and several explicitly forbid doing anything else on top (Mindworks: `install()` must be the *only* thing; Meta says the same about `FbPlayableAd.onCTAClick`). So the branch has to live somewhere — before this it was duplicated per CTA button in game code.

`Cta.open(storeUrl)` feature-detects and fires **exactly one** handler, returning which network took it (`Cta.detect()` answers the same question without acting, so a dev readout can't drift from what a real click does):

| Order | Host                      | Fires                                                       |
| ----- | ------------------------- | ----------------------------------------------------------- |
| 1     | Mintegral Mindworks       | `window.install()`                                          |
| 2     | Meta / Facebook           | `FbPlayableAd.onCTAClick()`                                 |
| 3     | Google (Ad Manager/AdMob) | `ExitApi.exit()`                                            |
| 4     | ironSource DAPI           | `dapi.openStoreUrl(url)`                                    |
| 5     | MRAID                     | `mraid.open(url)` — via `MraidAdapter`, never `window.open` |
| 6     | plain browser             | `window.open(url, "_blank")`                                |

Order is load-bearing: several networks inject **both** their own API *and* MRAID, and the network-specific one is what actually fires the install-click event they bill on — so MRAID is checked second-to-last. `storeUrl` is only consulted on the paths that take one; network-owned handlers redirect to the listing the network itself configured. Re-verify each hook against the target network's current doc before submission — a silently-wrong CTA is the most expensive bug a playable can ship.

### `core/DynamicJoystick.ts`
Touch-anywhere virtual joystick. Invisible until you touch the screen, then appears centered exactly where you touched — reuses whatever base/knob visuals were designed in the UI editor (color, size), only controls *where*/*when* they appear. Implementation notes worth knowing if you touch this file:
- Re-parents the joystick's `base`/`knob` DOM nodes to `document.body` — they originally live inside a `UILayout`-built wrapper that carries a CSS `transform` for anchor positioning, and a transformed ancestor becomes the *containing block* for any `position: fixed` descendant (per spec), not the viewport. Left nested, the joystick would never actually land under the pointer.
- Creates its own full-screen invisible "catcher" layer (`z-index: -1`, so any real designed button still wins its own clicks) rather than listening on the base/knob directly, since those roam to wherever you last touched.
- `dispose()` removes the body-reparented base explicitly — it's not inside any container a normal teardown would reach, which matters given `IonEngine`'s in-place hot-reload keeps the DOM alive across reloads.

### `core/CameraHandler.ts`
Generic lerp-follow camera — frame-rate-independent exponential smoothing (`1 - 0.001^dt`), takes a world-space focus point and an offset. No game-specific knowledge.

### `core/SceneInspector.ts` / `core/ViewHelperWidget.ts`
Dev-only. `SceneInspector` is the Engine Room's freecam scene hierarchy/inspector/transform-gizmo (Move/Rotate/Scale, click-to-select in the 3D view, live-editable Position/Rotation/Scale/Visible fields). `ViewHelperWidget` is the small red/green/blue axis gizmo mirroring camera orientation — its own tiny Three.js renderer, only constructed if `#er-viewhelper` exists in the page (i.e. never in production).

`SceneInspector` also owns a second toolbar cluster, separate from the Select/Move/Rotate/Scale mode buttons (deliberately a distinct `.si-gizmo-modes` DOM group in `index.html` — a shared `#si-gizmo-toolbar button` query used to wire both would sweep up these too and crash the gizmo, since they carry no `data-gizmo` attribute):

| Toggle               | Key | Default | What it does                                                                                                     |
| -------------------- | --- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| Grid                 | G   | off     | `THREE.GridHelper`, purely visual reference                                                                      |
| Camera/light helpers | H   | on      | `CameraHelper` + per-light helpers' visibility                                                                   |
| Snap                 | X   | off     | Fixed increments on the active gizmo (0.25 world units / 15° / 0.1 scale)                                        |
| Space                | C   | world   | `TransformControls`' local vs. world orientation                                                                 |
| Frame selected       | F   | —       | Recenters the orbit target on the selection and dollies the camera to fit it, keeping the current look direction |

All five are exposed as plain methods (`toggleGrid()`, `toggleHelpers()`, `toggleSnap()`, `toggleSpace()`, `frameSelected()`) plus `addStateChangeListener((state: InspectorToolState) => …)` — the same "keyboard shortcut and toolbar button both drive one method, one listener keeps both in sync" pattern `GizmoMode`/`addModeChangeListener` already used, just generalized to more than one boolean. `Game.ts` re-wires a listener onto each new `SceneInspector` instance (one is constructed per freecam session) the same way it already did for gizmo mode.

### Control Desk — live public-field editing, no bespoke UI needed
Not a single file — a mechanism spanning `scripts/dev-build-api.js` (`GET /script-info`, a brace-depth text scan of a `*/ui/*.ts` or gameplay class file for its classes' public/private fields) and `IonEngine.ts`'s `window.__getInspectable(className)` hook (hands back the *real* running instance — Player, World, CoinField, whatever `Game.ts` chose to register in its `inspectables` map — no serialization, dev panel and game share one `window`). The Engine Room's Control Desk panel (`index.html`) combines the two: pick a script, it lists that class's fields; public `number`/`boolean` fields render as real inputs that write straight onto the live instance on edit, everything else renders read-only (`🐞 Debug` widens visibility to private/protected fields too, always read-only).

The reusable part for a new playable: **any gameplay class becomes live-tunable at runtime for free** just by (1) using plain public `number`/`boolean` fields rather than accessors — the field-scan regex only matches plain declarations, a `get`/`set` pair silently never appears — and (2) registering the instance in `Game.ts`'s `inspectables` map under its class name. If the live value needs to actually *do* something beyond sitting there, give the class its own `update()` (or fold into the class's existing per-frame method) that reads its own fields and applies them — Control Desk edits by direct property assignment, so a field that nothing ever reads back is just inert data. `game/SoundHandler.ts`'s `volume`/`muted` fields are the concrete example: `Game.update()` calls `this.soundHandler.update()` every frame, which applies `muted ? 0 : volume` onto the real `THREE.Audio` gain — Control Desk needed zero new code to make that live-editable, it only needed the fields to exist.

### Audio Reactor — same "engine hook, dev-only cost" shape as SceneInspector
The Engine Room's Audio Reactor panel draws a live frequency-spectrum bar graph from whatever a game's `SoundHandler`-equivalent is currently playing, via `window.__getAudioAnalyser`/`__isMusicPlaying` (`IonEngine.ts`, same no-serialization hook pattern as `__getInspectable`). The underlying `THREE.AudioAnalyser` is lazily constructed — nothing in `AssetLoader`/`IonEngine` ever builds one until the panel's own draw loop asks for it, and that loop only runs while the panel is visibly open (`requestAnimationFrame`'d on toggle-open, `cancelAnimationFrame`'d on close) — so a production build that never opens this panel (i.e. always, since it's dev-only chrome) pays nothing for it, same reasoning as `ViewHelperWidget` only existing when `#er-viewhelper` is in the page.

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

| Endpoint                                                           | Purpose                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /version`                                                     | Engine Room panel's version/commit readout                                                                                                                                                                                                                                                                |
| `POST /build`                                                      | Engine Room's Builder button — runs `build.sh` (body: `{halfFloat: boolean}`, forwarded to the compression step below via `env`, never the shell command string), returns the final `dist/index.html` byte size                                                                                           |
| `GET /estimate-size`                                               | Builder panel's pre-build size bar — the last real `dist/index.html` on disk, flagged `stale` if `src/`/`assets/`/`tools/ui-editor.html` have anything newer (including a deletion — see `isBuildStale`'s own note on why a directory's own mtime, not just its children's, has to be part of that check) |
| `GET /build-report`                                                | The "📊 Build Report" button — `dist/build-report.json` as-is (see "Production build" below), same stale/exists shape as `/estimate-size`                                                                                                                                                                  |
| `POST /save-layout`, `GET /load-layout`, `GET /list-layouts`       | Layout JSON read/write (`src/game/ui/{mainLayout,endcardLayout}.json`, `src/game/ui/layouts/*.json`)                                                                                                                                                                                                      |
| `GET /list-scripts`                                                | Scripts panel file list — `*/ui/*.ts` only (the only files that can have assignable fields)                                                                                                                                                                                                               |
| `GET /script-info`                                                 | A script's classes + public/private fields (brace-depth text scan, not a real TS parse — see the file's own doc comment for why)                                                                                                                                                                          |
| `GET /list-bindings`, `POST /save-binding`, `POST /remove-binding` | The drag-and-drop field↔element assignments — `src/game/ui/bindings.json`                                                                                                                                                                                                                                 |

## Building a new playable ad on this engine

1. Replace everything under `src/game/` with your own entities/world/UI — keep `src/engine/` untouched.
2. `src/main.ts` stays as-is (`IonEngine.boot(canvas)`); it doesn't know or care what game is running.
3. Design your HUD/endcard in the visual editor exactly as before — `tools/ui-editor.html` has no game-specific knowledge either.
4. If a UI-layer class needs a designed element without a manual lookup, follow `HUD.ts`'s pattern: declare a public field, assign it via the Scripts panel (drag or ⊙ Pick), call `applyBindings(this, "YourClassName", bindingsData, ...layouts)` once in the constructor.

## Production build

`build.sh`, in order:

1. **`scripts/compress-assets.mjs`** shrinks `assets/models/*.glb` and `assets/sounds/*.ogg` into `.build-cache/` (never touches `assets/` itself — wiped and rebuilt fresh every run, so a renamed/removed asset's old compressed copy never lingers). Manifest-driven, not a directory walk: it reads `src/game/assets.ts`'s own `"./assets/…"` string literals and only compresses what's actually referenced. This matters for a real reason found while building it — swap which file `libAudio.MainMusic` points at and the *old* file doesn't go anywhere, it's still sitting on disk; a directory walk would keep compressing it and (worse) keep counting it in the Build Report as if it still shipped, when `dist/index.html` embeds none of it. Anything found on disk but unreferenced is reported once as `unusedAssets` instead.

   Per GLB (via `@gltf-transform/*`): `dedup()` + `weld()` + `resample()` + `prune({keepLeaves: true})` + `sparse()` + `textureCompress()` (WebP, capped 2048px) + either `quantize()` (`KHR_mesh_quantization` alone — compact 16-bit-equivalent vertex precision, natively supported by `GLTFLoader`, no extra runtime decoder) or `meshopt()` (that plus `EXT_meshopt_compression` entropy coding on top — needs `AssetLoader`'s `MeshoptDecoder`, see above) depending on the `HALF_FLOAT` env var (the Builder panel's checkbox; defaults on). Deliberately **not** using `flatten`/`join`/`instance`/`simplify` — those restructure or merge the node graph or decimate triangles, and this engine's own `getObjectByName` lookups (`Game.ts`'s `walkablearea`/`cinemafloor`/`Colliders`, or any future one) depend on every node keeping its exact name; `prune`'s `keepLeaves: true` exists for the same reason (its default silently deletes empty named nodes — verified against a real asset with ~60 unreferenced-but-clearly-meant-for-later gameplay anchor points before this got written this way). Audio goes through `ffmpeg` (`libvorbis`, falling back to the native `vorbis -strict -2` encoder some `ffmpeg` builds ship instead) at a real quality target — background music doesn't need the ~500 kbps some source exports come in at.

2. **`npx vite build --config vite.config.prod.mts`** bundles+minifies `src/main.ts` (engine and game code together — there's no separate engine bundle), building `src/index.template.html` — a minimal page shell with none of the dev-only Engine Room chrome — via `vite-plugin-singlefile`, which inlines the built JS directly into the output HTML.

   Two `vite.config.prod.mts` settings exist *specifically* for ad-network review compatibility, both worth understanding before touching either:
   - **`rollupOptions.output.format: "iife"`** — Vite's default output is a real ES module (`<script type="module">`). Ad-network review (Mintegral's Mindworks named it explicitly: *"Do not use crossorigin, type='module', import or export in local files"*) rejects that outright — some review WebViews don't support ES modules, and `file://` blocks module script loading via CORS regardless. IIFE fully inlines everything into one self-executing classic script (zero `import`/`export` left), safe here since nothing in `src/` uses dynamic `import()` — nothing to code-split.
   - **`build.target: "es2015"`** — Vite's default target assumes a genuinely modern browser and leaves recent syntax untouched: class `static {}` blocks (ES2022), optional catch binding `catch {}` (ES2019), optional chaining `?.`/nullish coalescing `??` (ES2020) all showed up as-is in a build against the default — including inside three.js's *own* source, not just this project's. A review WebView without support for one of those throws `SyntaxError: Unexpected token '{'` (exactly what `static{…}` looks like to a parser that's never heard of static blocks) and fails the whole review. `es2015` tells esbuild to down-level all of it, across every module including `node_modules` deps, not just this project's own TypeScript.

3. Vite's HTML-entry build always tags the script `type="module" crossorigin` regardless of `output.format` (format only controls the JS chunk's own syntax, not how an HTML-entry build tags the `<script>` that loads it) — so a **python post-processing step** strips both attributes, *and* relocates the tag to just before `</body>`. The relocation matters: `vite-plugin-singlefile` hoists the inlined script into `<head>`, which only worked with `type="module"` because module scripts are implicitly deferred until the DOM finishes parsing. A classic script has no such deferral (`defer` is spec'd to do nothing for an *inline* script — only one with a `src` to fetch), so left in `<head>` it ran immediately, before `<body>`'s own `#game` canvas existed — `document.getElementById("game")` returned `null`, and `new THREE.WebGLRenderer({canvas: null})` threw reading `canvas.width`. Moving the script to the end of `<body>` (where `src/index.template.html`'s own script tag already sat, before Vite touched it) restores that ordering without needing any deferral mechanism.

4. Every `"./assets/…"` path the bundle references gets base64-inlined as a `data:` URI in place — preferring the matching compressed file under `.build-cache/` from step 1, falling back to the real `assets/` file untouched if compression skipped or failed on it. `AssetLoader`'s Three.js loaders accept a data URI exactly like a file path, so nothing on the loading side needs to know the difference.

5. **Ad-network compatibility pre-flight** — the same `dist/index.html` bytes read for gzip get scanned for the exact patterns known to fail review (`type="module"`, `crossorigin`, real `import`/`export`, `static{}`, `catch{}`, `?.`, `??`). This automates a check that previously only happened by manually re-uploading to a network's review tool and reading the error — every one of these patterns is *supposed* to be impossible given `format:"iife"`/`target:"es2015"` above, so this exists to catch a regression (a dependency upgrade, a loosened setting) the moment it's built, not the next time a submission bounces. Any hit prints a `⚠` warning block to the build's own stdout and populates `compatibilityWarnings` in the report below; a clean build prints `✓ No known ad-network compatibility issues found`.

6. **`dist/build-report.json`** — a sibling dev artifact, never inlined into `dist/index.html` itself. Merges step 1's per-asset before/after sizes and glTF-Transform `inspect()` detail (mesh/vertex/triangle counts, per-texture resolution + GPU memory estimate, animation clips) with the *actual* final base64-inlined size of each asset, total `dist/index.html` size, gzip size, build duration, the `unusedAssets` list from step 1, and step 5's `compatibilityWarnings`. `GET /build-report` (`scripts/dev-build-api.js`) serves it to the Engine Room's "📊 Build Report" button, which renders any compatibility warnings as a red banner **above** the size numbers — the one finding in that whole report that means "this build will fail review," not just "here's room to optimize."

7. Best-effort `dist/index.zip` if `zip` is on `PATH` — some ad-network upload flows want a zip alongside the raw HTML.

Single self-contained `dist/index.html`, no server needed. See README.md's "Going fully single-file" section for further asset-inlining notes.
