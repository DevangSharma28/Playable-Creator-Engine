# ION Engine — Technical Reference

Authoritative documentation for the ION Engine as it is actually implemented in this repository. Every class, file, endpoint, and behaviour described here was verified against the source at the time of writing.

This is a **reference for the engine**, not a roadmap. Where something is incomplete, unwired, or absent, it is marked as such rather than described as if it worked. See [Known limitations & production readiness](#14--known-limitations-and-production-readiness) for the consolidated list.

- [README.md](README.md) — setup, running, day-to-day UI editor workflow.
- [HOW_TO_USE.md](HOW_TO_USE.md) — task-oriented guide.
- `public/guide.html` (and `guide-colliders.html`, `guide-particles.html`, `guide-ui-editor.html`) — the in-app Engine Guide, reachable from the Engine Room's **Engine Guide** button.

### Status markers

| Marker | Meaning |
| --- | --- |
| **Implemented** | Present, wired, and reachable through a documented entry point. |
| **Partial** | The code path exists but something required to use it is missing or unwired. The gap is stated inline. |
| **Planned** | Explicitly not built. Named only where its absence shapes how you should use what does exist. |
| **Known Limitation** | Implemented, but with a caveat that will affect real work. |

Unmarked sections are **Implemented**.

### Contents

1. [Architecture](#1--architecture)
2. [Runtime core](#2--runtime-core)
3. [Camera, lighting, and world](#3--camera-lighting-and-world)
4. [ION Collider & Area system — `engine/collision/`](#4--ion-collider--area-system--enginecollision)
5. [ION Particle & VFX system — `engine/particles/`](#5--ion-particle--vfx-system--engineparticles)
6. [UI runtime — `engine/ui/`](#6--ui-runtime--engineui)
7. [Input](#7--input)
8. [Audio](#8--audio)
9. [Script binding and ad-network integration](#9--script-binding-and-ad-network-integration)
10. [Editor and dev-only systems](#10--editor-and-dev-only-systems)
11. [Dev tooling reference](#11--dev-tooling-reference)
12. [Build and production](#12--build-and-production)
13. [Testing and verification](#13--testing-and-verification)
14. [Known limitations and production readiness](#14--known-limitations-and-production-readiness)
15. [The game layer, and building a new playable](#15--the-game-layer-and-building-a-new-playable)

---

## 1 · Architecture

### 1.1 The four layers

The single most important thing to keep straight in this codebase is which of four layers a given file belongs to. They have different lifetimes, different consumers, and — critically — different fates in a production build.

```
┌──────────────────────────────────────────────────────────────────────┐
│  RUNTIME            src/engine/**  (except editor/)                  │
│                     Ships in dist/index.html. Generic, game-agnostic.│
│                     IonEngine · Ion · Scheduler · EventBus           │
│                     AssetLoader · CameraHandler · SceneEnvironment    │
│                     collision/ · particles/ · ui/UILayout             │
│                     Bindings · SceneBindings · Cta · adapters         │
├──────────────────────────────────────────────────────────────────────┤
│  GAME               src/game/**                                      │
│                     Ships. Replaceable per playable. Imports RUNTIME. │
│                     Game · Player · CoinField · Coin · World · HUD    │
│                     SoundHandler · AreaDemo · Environment · assets     │
│                     + the authored JSON data files                    │
├──────────────────────────────────────────────────────────────────────┤
│  EDITOR / DEV       src/engine/editor/** · core/SceneInspector.ts     │
│                     core/ViewHelperWidget.ts · index.html             │
│                     tools/ui-editor.html · scripts/dev-build-api.js   │
│                     NEVER ships. Tree-shaken or simply not built.     │
├──────────────────────────────────────────────────────────────────────┤
│  BUILD / PRODUCTION build.sh · vite.config.prod.mts                   │
│                     scripts/compress-assets.mjs                       │
│                     src/index.template.html                           │
│                     Produces dist/index.html + dist/build-report.json │
└──────────────────────────────────────────────────────────────────────┘
```

**Why the RUNTIME/EDITOR split is structural rather than conventional.** Every entry point into `src/engine/editor/` sits behind `import.meta.env.DEV` (see `Game.setFreecam`, and the `ViewHelperWidget` / `ColliderVisuals` / `ParticleVisuals` constructions in `Game`'s constructor). Rollup evaluates that to `false` in a production build and drops the whole tree, rather than shipping it guarded by a DOM lookup that never matches. This is verified empirically, not assumed — see [§12.4](#124-what-actually-ships).

**Why the RUNTIME/GAME split matters.** `engine/` is what carries over to the next playable unchanged; `game/` is what you replace. See [§1.2](#12-the-enginegame-split).

### 1.2 The engine/game split

```
src/
  main.ts        entry point: canvas → IonEngine.boot()  (4 lines + an HMR accept)
  engine/        reusable — see the one exception below
  game/          this specific playable ad — freely imports from engine/
```

The dependency direction is meant to go one way only. `engine/` should have no idea `HUD`, `Player`, or `CoinField` exist; `game/` builds on top of `engine/`'s generic pieces. Keeping this boundary intact is *the* thing that makes the engine reusable rather than reusable-in-theory.

> **Known Limitation — one real violation exists.** [`src/engine/IonEngine.ts:2`](src/engine/IonEngine.ts#L2) statically imports `Game` from `../game/Game`:
> ```ts
> import { Game } from "../game/Game";
> ```
> `IonEngine` constructs the game itself rather than being handed a factory. Consequence: **`src/engine/` does not currently compile without a `src/game/Game.ts` exposing a compatible `Game.create()`**, so "drop in a new `src/game/`" is true in practice only because the replacement keeps the same entry-point shape.
>
> The fix is small and mechanical — `IonEngine.boot(canvas, { createGame })`, with `main.ts` passing `Game.create` — but it has not been made, and this document does not claim otherwise. Everything else in `engine/` is genuinely game-agnostic; this is the single exception, verified by grep across the whole directory.

### 1.3 Project structure

```
src/
  main.ts                       IonEngine.boot(canvas) + Vite HMR self-accept
  index.template.html           production page shell (no dev chrome)

  engine/                       ─── RUNTIME (ships) ───
    IonEngine.ts                lifecycle, frame loop, crash guard, dev hooks
    Ion.ts                      the one-line facade + bindIon/unbindIon
    AssetLoader.ts              texture/GLB/audio preload + cache
    Bindings.ts                 UI-element → script-field binding runtime
    SceneBindings.ts            scene-object/collider → script-field binding runtime
    Cta.ts                      one call-through for every ad network
    MraidAdapter.ts             IAB MRAID host wrapper
    MindworksAdapter.ts         Mintegral Mindworks host wrapper
    core/
      Scheduler.ts              game-time timers, repeats, sequences, tweens
      Animator.ts               Animator + LoopAnimator (0→1 progress drivers)
      EventBus.ts               generic pub/sub
      CameraHandler.ts          the camera rig (perspective + orthographic)
      InputManager.ts           pointer classification + keyboard axis fallback
      DynamicJoystick.ts        touch-anywhere virtual joystick
      CrashOverlay.ts           dependency-free crash recovery CTA
      SceneInspector.ts         DEV — gizmo, helpers, viewport shortcuts
      ViewHelperWidget.ts       DEV — axis orientation widget
    scene/                      scene environment (camera/lighting/world)
      SceneEnvTypes.ts          config shapes + the CameraRig interface
      SceneEnvDefaults.ts       defaults + deep clone
      SceneEnvironment.ts       config → live lights / scene / renderer
      SceneEnvSerialization.ts  environment.json ↔ config
      index.ts
    collision/                  ION Collider & Area system
      Collider.ts BoxCollider.ts SphereCollider.ts CylinderCollider.ts
      ColliderManager.ts intersect.ts ColliderSerialization.ts
      ColliderTypes.ts index.ts
    particles/                  ION Particle & VFX system
      ParticleTypes.ts ParticleBuffer.ts ParticleSimulation.ts
      ParticleShapes.ts ParticleRandom.ts ParticleRenderer.ts
      ParticleMaterial.ts ParticleTrails.ts ParticleEmitter.ts
      ParticleSystem.ts ParticleManager.ts ParticleDefaults.ts
      ParticlePresets.ts ParticleSerialization.ts index.ts
    ui/
      UILayout.ts               runtime renderer for the visual UI editor's JSON
      UILayoutTypes.ts          the shared layout schema
    entities/Entity.ts          the minimal entity contract
    editor/                     ─── EDITOR ONLY (never ships) ───
      EditorRoot.ts             composition root + lifecycle
      EditorSelection.ts        the single selection store
      EditorViewport.ts         renderer buffer size + camera projection
      EditorResizeManager.ts    ResizeObserver, coalesced per frame
      EditorObjectPicker.ts     click→selection raycasting + Pick mode
      EditorDragSource.ts       drag payload for drag-to-assign
      EditorHierarchy.ts        the Object3D tree panel
      EditorInspector.ts        transform/visibility/identity panel
      SectionRenderer.ts        shared field-descriptor → DOM renderer
      InspectorSections.ts      the field-descriptor vocabulary
      EditorHistory.ts          one undo/redo stack for every mode
      EditorColliders.ts        "Configure Colliders" mode
      ColliderVisuals.ts        collider wireframe/fill drawing
      EditorParticles.ts        "Particle System" mode
      ParticleVisuals.ts        emission-volume / direction / bounds gizmos
      EditorEnvironment.ts      the Environment dock (Camera/Lighting/World)
      objectAssignment.ts       declared-TS-type → live-object compatibility

  game/                         ─── GAME (ships, replaceable) ───
    Game.ts                     the playable: scene, entities, UI, dev facade
    assets.ts                   this game's asset manifest
    AreaDemo.ts                 worked example of the collider/trigger API
    SoundHandler.ts             music/SFX + the Audio Reactor's analyser
    world/World.ts              gameplay play-area extent
    entities/                   Player.ts Coin.ts CoinField.ts Environment.ts
    ui/HUD.ts                   UI-layer class wired by Bindings
    ui/mainLayout.json          authored by the UI editor
    ui/endcardLayout.json       authored by the UI editor
    ui/bindings.json            UI element ↔ script field assignments
    sceneBindings.json          scene object / collider ↔ script field assignments
    colliders.json              authored by Configure Colliders
    particles.json              authored by the Particle System mode
    environment.json            authored by the Environment dock

create-ion-project.mjs          one-file scaffolder for a new playable — see §15.2
index.html                      DEV entry — the Engine Room panel + editor chrome
tools/ui-editor.html            the visual UI editor (single file, standalone)
public/ui-editor.html           synced copy served by the dev server
public/guide*.html, guide.css   the in-app Engine Guide
scripts/
  dev.js                        runs Vite + the dev build API together
  dev-build-api.js              localhost:8001 — the editors' file/build API
  compress-assets.mjs           GLB + audio compression into .build-cache/
  sync-assets.js                assets/ → public/assets/, tools/ → public/
  test-ui-editor.js             end-to-end UI editor smoke pass
  check-build-report.mjs        CI gate over dist/build-report.json
.github/workflows/ci.yml        CI — tests + a real production build
tests/                          seven node:test suites — see §13
build.sh                        the production pipeline
vite.config.mts                 dev server config
vite.config.prod.mts            production build config
```

> **Known Limitation.** `tools/ui-editor.html` and `public/ui-editor.html` are **both committed**, byte-identical, 8,184 lines each. `scripts/sync-assets.js` copies the former to the latter on `npm run predev`. The `public/` copy is a build artifact under version control — it produces duplicate diffs on every editor change and can drift if someone edits the wrong file. `tools/` is the source of truth.

### 1.4 Runtime lifecycle

```
main.ts
  └─ IonEngine.boot(canvas, options?)
       └─ new IonEngine(canvas, options).start()
            ├─ __disposeGame()                 retire the previous bundle's game (hot reload only)
            ├─ __gameInstanceGeneration++      supersede the previous RAF chain
            ├─ bindIon({ scheduler, bus, colliders, particles })
            │                                  ← BEFORE Game.create, so entity
            │                                    constructors can use Ion.*
            ├─ await Game.create(canvas)       asset preload → scene, rig, environment,
            │                                    entities, colliders, particles, UI
            ├─ installDevHooks(activeGame)     window.__* — DEV only, inert in production
            ├─ __onGameReady?.()               the dev page sizes the renderer here
            └─ requestAnimationFrame(loop)
```

**One frame**, exactly as implemented in `IonEngine.start`'s `loop`:

```
loop(now)
  ├─ if generation superseded → return          (stops a stale bundle's chain for good)
  ├─ dt = min(now − last, 0.05)                 hard cap: a tab-out must not teleport anything
  ├─ fps = EMA(1/dt)
  ├─ try {
  │    if (!uiEditorPaused && !freecamActive) {   ← the "gameplay is running" guard
  │       game.update(dt, elapsed)
  │       scheduler.update(dt)                    timers/tweens on game time
  │       colliders.update()                      AFTER update — sees this frame's positions
  │       particles.update(dt)                    AFTER colliders — a trigger's VFX starts this frame
  │    }
  │    game.render()                              ← OUTSIDE the guard: the last frame stays
  │  }                                              visible as a live backdrop while editing
  └─ catch → console.error → onCrash?.() → showCrashOverlay() → do NOT reschedule
```

Two details in that ordering are load-bearing and were both fixed rather than designed:

- **Collision and particle stepping sit inside the not-paused guard**, so trigger enter/exit and VFX freeze with gameplay instead of running behind an open editor.
- **`render()` sits outside it**, so opening the UI editor overlay or the 3D viewer does not blank the screen.

**Fixed timestep** (**Implemented**, opt-in). `IonEngine.boot(canvas, { fixedTimestep: 1/60 })` swaps the variable-`dt` path for an accumulator: `update()` may run several times per animation frame, always with that exact `dt`, while `render()` still runs once. Capped at `MAX_FIXED_STEPS_PER_FRAME = 5`; past that the backlog is dropped rather than spiralling. Default is variable `dt`, which is what every existing system here was tuned against. Turn it on when determinism matters — anything integrating forces or resolving collisions visibly jitters (or tunnels) on a frame spike under variable `dt`, because one 50 ms step is not three 16 ms ones.

**Crash guard** (**Implemented**). `update()`/`render()` run inside a `try/catch`. If gameplay throws, the loop stops rescheduling itself permanently — a dead RAF chain is the right outcome, since continuing to call into a broken instance just throws again next frame forever — and `core/CrashOverlay.ts` shows a minimal, dependency-free "Continue" overlay wired to `Cta.open()`. A mid-game crash still gets its CTA click rather than being a wholly wasted impression. `IonEngineOptions.onCrash` is an optional logging hook, itself wrapped in a `try/catch` so it cannot block the recovery UI.

**Teardown.** `Game.dispose()` closes the 3D editor first, then releases: the window resize listener, `ViewHelperWidget` (a second WebGL context), `AreaDemo`'s collider subscriptions, both input systems, `SoundHandler`, both `UILayout`s' DOM listeners, `SceneEnvironment` (every light it created plus any PMREM render target), and finally the renderer. `IonEngine` additionally clears the `Scheduler`, the `EventBus`, the `ColliderManager`, and the `ParticleManager`, and calls `unbindIon(ctx)`.

### 1.5 Data flow

```
                AUTHORING (dev only)                    RUNTIME (ships)

  tools/ui-editor.html ──POST /save-layout──▶  ui/mainLayout.json ──┐
                       ──POST /save-binding─▶  ui/bindings.json ────┤
                                                                     ├─▶ UILayout ──▶ DOM
  3D Editor                                                          │   + applyBindings
   ├ ⊙ Pick / drag ─────POST /save-scene-bindings▶ sceneBindings.json┼─▶ applySceneBindings
   ├ Configure Colliders POST /save-colliders ──▶  colliders.json ───┼─▶ loadColliders ──▶ Ion.colliders
   ├ Particle System ────POST /save-particles ──▶  particles.json ───┼─▶ loadParticles ──▶ Ion.particles
   └ Environment dock ───POST /save-environment ▶  environment.json ─┴─▶ SceneEnvironment
                                                                          ├─▶ scene lights / fog / background
                                                                          ├─▶ renderer tone mapping / shadows
                                                                          └─▶ CameraHandler (the CameraRig)

  Control Desk ─────────POST /save-inspectable-values ▶ the .ts source file itself
```

Every one of those JSON files is a **real static import** in `Game.ts`, so all of it ships: what you author in an editor is what the production playable runs. None of them is fetched at runtime.

---

## 2 · Runtime core

### 2.1 `IonEngine.ts`

Owns *running* a game, not the game itself.

**Public surface:**

```ts
IonEngine.boot(canvas: HTMLCanvasElement, options?: IonEngineOptions): void
engine.ui: UILayout | undefined          // the running game's main layout
engine.endcardUI: UILayout | undefined   // the running game's endcard layout

interface IonEngineOptions {
  fixedTimestep?: number;               // seconds; omit for variable dt
  onCrash?: (error: unknown) => void;   // logging hook, cannot block recovery
}
```

Responsibilities: the rAF loop and `dt` capping, EMA FPS tracking, ownership and teardown of the `Scheduler` / `EventBus` / `ColliderManager` / `ParticleManager`, the `Ion` binding, the crash guard, the in-place hot-reload handshake, and — DEV only — the `window.__*` hook surface the Engine Room panel talks to (see [§11.1](#111-dev-hook-surface)).

**The `Game` contract is four members.** `static create(canvas): Promise<Game>`, `update(dt, elapsed)`, `render()`, `dispose()`. That is everything `IonEngine` requires to run a game.

Everything else the Engine Room can ask for — 59 members covering the collider, particle, environment, history, gizmo, Control Desk, and audio panels — is declared **optional** on the `GameDevFacade` interface in this same file, and `installDevHooks` reaches them through `activeGame as Game & Partial<GameDevFacade>`. Implement a member and the matching dev control starts working; omit it and that control does nothing, which is correct for a game that never wired it. Every Engine Room call site is already written `window.__x && window.__x()`, so the degradation is graceful by construction, and the few hooks whose declared return is non-optional fall back to a zeroed value (`rendererStats`, `getColliderStats`, `getParticleStats`, `getParticlePresets`) or `false`.

> This used to be a hard requirement, because `installDevHooks` is not behind `import.meta.env.DEV` — the hook bodies dead-code-eliminate at build time, but TypeScript still type-checks every `activeGame.x()` reference. Measured on a minimal game, that forced **64 of 108 lines of `Game.ts` to be pure stubs** before it would compile. The same minimal game is now 31 lines.

### 2.2 `Ion.ts` — the one-line facade

```ts
Ion.time                                  // seconds of game time since boot (excludes paused stretches)
Ion.after(seconds, fn)                    // → ScheduledHandle
Ion.every(seconds, fn)
Ion.sequence([{ wait, then }, …])
Ion.tween(target, to, seconds, opts?)
Ion.on<T>(event, fn) / Ion.once<T>(…) / Ion.emit<T>(event, payload)
Ion.cta(storeUrl)                         // → CtaNetwork
Ion.colliders                             // ColliderManager
Ion.particles                             // ParticleManager
```

Also re-exports `Easing`, so `import { Ion, Easing } from "./Ion"` is genuinely one line and one path.

A **bound singleton**, not a self-initializing static: `IonEngine.boot()` constructs an `IonContext` and calls `bindIon(ctx)`; teardown calls `unbindIon(ctx)`. Deliberate, for two reasons this codebase cares about — a static that lazily builds its own services ends up owning engine state nobody can see or reset, and in-place hot reload has to be able to *fully* retire the previous bundle's services or its timers keep firing into the new game. `unbindIon` takes the context being retired, so a late dispose from an old bundle cannot unbind the live one. Using `Ion` before boot throws with a real explanation rather than a `TypeError` on undefined.

The same services are always reachable directly off the context — `Ion` is a shorthand, never the only way in, so tests can drive a `Scheduler` with no globals at all.

**`Ion` is bound before `Game.create()`, so entity constructors can use it.** Nothing in the context depends on `Game`, and waiting had a real cost: every entity constructor runs inside `Game.create()`, so `Ion.*` threw its not-yet-booted error for exactly the code most likely to reach for it. `Player.ts` registering its own collision volume where it builds its model needs this ordering.

### 2.3 `core/Scheduler.ts` — timers, sequences, tweens

All on **game time**, not wall clock. The clock only advances inside `update()`, which `IonEngine` only calls while gameplay is running — so everything scheduled freezes while the UI editor overlay or the 3D viewer is open and resumes exactly where it left off. A `setTimeout`-based scheduler would keep counting behind the editor and fire an endcard mid-edit.

```ts
Ion.after(3, () => hud.showHook());
Ion.every(0.5, () => spawner.tick());
Ion.sequence([
  { wait: 0.5, then: () => coin.pop() },
  { wait: 0.2, then: () => hud.bumpScore() },
]);
Ion.tween(mesh.scale, { x: 1.4, y: 1.4, z: 1.4 }, 0.25, { easing: Easing.Back.Out });
```

Everything returns a `ScheduledHandle` (`cancel()`, `done`) — safe to cancel twice, after it ran, or after `clear()`. `done` means "will never fire again", true whether it completed or was cancelled.

Behaviours worth knowing, each with a regression test:

- `every()` fires **at most once per frame** — a 5-second frame spike produces one call, not a 50-call catch-up burst.
- A callback that schedules more work runs that work on the *next* tick, not the current one; otherwise a zero-delay self-rescheduling timer spins forever inside one update.
- Tweens run on a **private** tween.js `Group` fed this same game clock, never the library's global `TWEEN.update()`, so two Schedulers — or a stale one mid-hot-reload — cannot step on each other.

Tweens use three.js's already-bundled `tween.module.js`. No new dependency.

### 2.4 `core/Animator.ts` — `Animator` and `LoopAnimator`

A bare 0-to-1 progress driver for anywhere `Ion.tween`'s "tween these numeric fields toward a target" shape does not fit — two properties on two different curves, a shader uniform, a screen-shake magnitude, anything where the caller wants the raw number.

```ts
new Animator({ time, delay }, (progress) => { … }, onComplete?)
new LoopAnimator({ time, delay, loops, yoyo }, (progress) => { … }, onComplete?)
```

Self-driving: construct it and walk away. Nothing needs to hold the instance unless it might be cancelled early (`.cancel()`, `.done`).

Deliberately a thin wrapper over `Ion.tween`, not a second animation clock — it tweens a private `{ t: 0 }` to `{ t: 1 }` and hands `t` to `onProgress`, which is what makes it inherit `Scheduler`'s game-time pausing and hot-reload teardown for free.

`LoopAnimator` does not stop at 1. Each cycle genuinely *is* one real `Animator`, restarted from that one's `onComplete` — which is why it needs no separate correctness story. `loops` defaults to `Infinity`; `yoyo` alternates direction each cycle. `delay` applies once, before the first cycle. `loops` counts individual cycles, not round trips: `{ loops: 2, yoyo: true }` runs 0→1 then 1→0.

Reference use: `game/entities/Player.ts`'s reveal — two `Animator`s on different `time`/`easing` (scale via `Easing.Elastic.Out`, rotation via `Easing.Back.Out`) so they resolve at different moments instead of reading as one shared progress bar.

### 2.5 `core/EventBus.ts`

`Ion.on(event, fn)` / `Ion.once(event, fn)` / `Ion.emit(event, payload)`. Deliberately **no** globally-declared event-name-to-payload map — payload type is inferred from the listener, or given explicitly per call site: `Ion.on<{ total: number }>("coin-collected", fn)`. A mismatched payload type between an `emit()` and its `on()` is still a real compile error at both sites, just checked locally rather than through a shared declaration.

Owned by `IonEngine` and cleared on teardown, for the same reason the `Scheduler` is: a hot-reloaded bundle's old listeners must not keep firing into whatever the new instance emits under the same name.

> **Known Limitation.** The shipped reference game does not actually use the bus — HUD↔gameplay wiring is still direct references (`CoinField` takes an `onCollect` callback, `HUD` is hand-fed the score). The bus is available and tested, but the worked example for it does not exist yet.

### 2.6 `AssetLoader.ts`

A small caching loader for textures, GLB models, and audio, built on three.js's own loaders. `preload(manifest)` loads everything up front behind a single `await` — a playable ad cannot afford a stutter the first time an asset is needed mid-gameplay, so **nothing loads lazily**.

Owns the generic manifest types, which live here rather than in game code because they describe the loader's contract, not any game's content:

```ts
type AssetKind = "texture" | "glb" | "audio";
interface AssetEntry { kind: AssetKind; path: string; }
```

Its `GLTFLoader` has `setMeshoptDecoder(MeshoptDecoder)` wired unconditionally in the constructor so it can decode `EXT_meshopt_compression` GLBs — see [§12.2](#122-asset-compression) for where that compression is applied. Harmless for a GLB that was never meshopt-compressed (the decoder only engages for primitives carrying the extension), and single-file-safe: that module's WASM is inlined as a base64 byte array in the JS itself, not fetched as a separate `.wasm`.

### 2.7 `entities/Entity.ts`

The one contract a game entity needs to satisfy:

```ts
interface Entity {
  readonly object3D: THREE.Object3D;
  update(dt: number, elapsed: number): void;
  dispose?(): void;
}
```

Deliberately minimal — no ECS, no component framework, no inheritance hierarchy. `game/entities/Player.ts` and `game/entities/Coin.ts` implement it; `CoinField` owns a pool of the latter.

---

## 3 · Camera, lighting, and world

Camera framing, lighting, and world settings are one authored system: a plain-data config (`src/game/environment.json`), a runtime that applies it (`engine/scene/`), and a dev-only dock that edits it live (`editor/EditorEnvironment.ts`). The runtime half ships; the dock does not.

### 3.1 `core/CameraHandler.ts` — the camera rig

Owns the cameras, the follow behaviour, and how both respond to a resize. Implements the `CameraRig` interface from `scene/SceneEnvTypes.ts`, which is what the environment system's `camera` block drives.

```ts
class CameraHandler implements CameraRig {
  readonly perspective: THREE.PerspectiveCamera;
  readonly orthographic: THREE.OrthographicCamera;
  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera;   // the active one
  constructor(config?: CameraEnvConfig);
  applyCameraConfig(config: CameraEnvConfig): void;
  update(focusPosition: THREE.Vector3, dt: number): void;
  handleResize(width: number, height: number): void;
}
```

**Why there are two cameras.** A perspective/orthographic switch cannot be done in place — they are different classes, and `isPerspectiveCamera` / `isOrthographicCamera` are what three.js and several editor systems branch on. Both exist for the rig's whole life and `camera` returns whichever the config selects. **Read it per frame rather than caching it**: its identity changes when the projection mode does.

**Both cameras are kept at the same transform every frame**, including the inactive one, and `updateMatrixWorld(true)` is called on it explicitly. That is not redundancy: neither camera is in the scene graph, so nothing traverses them — three.js updates the world matrix of the camera it renders through and no other. The `AudioListener` is parented to the perspective camera, and its own `updateMatrixWorld()` is what moves the WebAudio listener. Without the explicit sync, switching the game to orthographic would silently freeze positional audio wherever the camera last was.

**Follow.** With `follow: true` the rig tracks a world-space focus point at `offset`, smoothed with frame-rate-independent exponential decay: `alpha = 1 − exp(−damping · dt)`. The default `damping` of `6.91` is `ln(1/0.001)` — exactly the `1 − 0.001^dt` literal this replaced, so follow feel is unchanged from before the rig existed. With `follow: false` the camera sits at the authored `position`/`rotation` and `update()` is a no-op, which is what makes a shot hand-placed in the editor stick instead of being overwritten on the next frame.

**Orientation adaptation** (**Implemented**, off by default). `fov` is a *vertical* angle, so on a portrait viewport the horizontal field collapses and the player sees a narrow slice of a shot framed in landscape. Set `referenceAspect` to the aspect the shot was framed at (e.g. `0.5625` for 9:16) and the vertical FOV widens on any narrower viewport so horizontal framing is preserved:

```
fov' = 2·atan( tan(fov/2) · referenceAspect / aspect )      when aspect < referenceAspect
```

`referenceAspect: 0` — the shipped default — disables the correction entirely and uses `fov` as authored, preserving the engine's pre-rig behaviour. `tests/scene-environment.test.mjs` asserts the horizontal half-angle is genuinely preserved across the correction.

**Orthographic framing.** `orthoSize` is the vertical half-extent in world units; the horizontal half-extent follows the live aspect. An ortho shot therefore reframes on resize the way a perspective one does, rather than stretching.

> **Known Limitation.** `follow` uses only the focus point's X and Z (`target.set(focus.x, 0, focus.z)`), so the rig does not track vertical movement. Correct for the flat reference playable; it will need changing for a game with ramps, stairs, or jumping.

> **Planned.** No camera shake, no FOV punch, no look-ahead. `Ion.tween` can drive a shake, but there is no seam on the rig to add a transient offset without fighting the follow lerp.

### 3.2 `scene/` — the scene environment

**Files**

| File | What it is |
| --- | --- |
| `SceneEnvTypes.ts` | The config shapes (`CameraEnvConfig`, `AmbientLightConfig`, `DirectionalLightConfig`, `WorldEnvConfig`, `SceneEnvData`) and the `CameraRig` interface. Pure data + one interface; no THREE objects held. |
| `SceneEnvDefaults.ts` | `DEFAULT_CAMERA` / `DEFAULT_AMBIENT` / `DEFAULT_DIRECTIONALS` / `DEFAULT_WORLD`, `defaultSceneEnv()`, and `cloneSceneEnv()`. |
| `SceneEnvironment.ts` | Reconciles the config into live lights, scene state, renderer state, and the rig. |
| `SceneEnvSerialization.ts` | `loadSceneEnv(raw)` / `serializeSceneEnv(data)`. |

Colors are `[r, g, b]` in 0..1 linear — `THREE.Color`'s own range, and the same convention the particle system's color fields already use, so the value in the file is the value in the swatch is the value in the shader.

**`SceneEnvironment` owns every light in the scene.** They live under one group named `Environment Lights` at the scene root. Nothing else in the game may add scene lighting — a second set added elsewhere would be lighting the scene while the Environment dock edited something invisible. `game/world/World.ts` used to build three lights by hand; those are now the two entries in `DEFAULT_DIRECTIONALS` plus `DEFAULT_AMBIENT`, with identical colours and intensities, and `World` no longer touches lighting, fog, or background at all.

**`apply()` is idempotent and reconciling, not rebuilding**, so the editor can call it on every slider event. The one genuinely expensive path — a shadow-map type or enable change, which requires every material in the scene to recompile — is change-detected and runs only when the value actually changed.

**Mutation API** (all bump a `version` counter the editor polls, and re-apply the affected block):

```ts
env.updateCamera(patch)  env.updateAmbient(patch)
env.updateDirectional(id, patch)  env.addDirectional(partial?)  env.removeDirectional(id)
env.updateWorld(patch)
env.snapshot(): SceneEnvData      // detached deep copy — the undo/save unit
env.restore(data)                 // whole-config restore — the undo path
env.config  env.version  env.lightRoot  env.rigCamera
env.dispose()
```

#### Camera block

| Field | Meaning |
| --- | --- |
| `projection` | `"perspective"` \| `"orthographic"` |
| `fov` | Vertical FOV in degrees (perspective) |
| `orthoSize` | Vertical half-extent in world units (orthographic) |
| `near`, `far` | Clipping planes, applied to **both** cameras |
| `zoom` | `THREE.Camera.zoom` — works in both projections |
| `referenceAspect` | Aspect the shot was framed at; `0` disables the correction |
| `follow` | Rig follows a focus point, or sits at the authored transform |
| `offset` | Rig position relative to the focus point — the framing control |
| `lookAtHeight` | Height above the focus point the camera aims at |
| `damping` | Follow stiffness (exponential decay rate) |
| `position`, `rotation` | Used only while `follow` is off; `rotation` in degrees, XYZ order |

#### Lighting block

`ambient` is one light with two modes: `"ambient"` (a flat term added everywhere) or `"hemisphere"` (sky colour above fading to `groundColor` below). Switching mode swaps the light rather than adding one; `enabled: false` removes it from the scene entirely.

`directionals` is a list. Each entry has `id`, `name`, `enabled`, `color`, `intensity`, `position`, `target`, and a shadow block: `castShadow`, `shadowMapSize`, `shadowBias`, `shadowNormalBias`, `shadowRadius`, `shadowCameraExtent`, `shadowCameraNear`, `shadowCameraFar`.

Implementation notes that matter:

- **A directional light's `target` is a real `Object3D` and is parented** into the light root. An unparented target leaves the light aiming at the origin no matter what its position says.
- **Changing `shadowMapSize` disposes the existing shadow map** and nulls it, so three.js reallocates at the new size on the next shadow pass. Without that the resolution setting silently does nothing.
- `shadowCameraExtent` sets the orthographic shadow frustum's `left`/`right`/`top`/`bottom` to `±extent`. Too small silently clips shadows away at the frustum edges; too large spends the map's resolution on empty space.

#### World block

| Field | Notes |
| --- | --- |
| `backgroundMode` | `"none"` (transparent) \| `"color"` \| `"texture"` (equirectangular) |
| `backgroundColor` | Also the fallback when a texture path cannot be resolved |
| `backgroundTexture` | Manifest path, resolved through the game's own `AssetLoader` |
| `backgroundBlurriness`, `backgroundIntensity` | `THREE.Scene` properties |
| `environmentSource` | `"none"` \| `"room"` (runtime-generated IBL) \| `"background"` (reuse the background texture) |
| `environmentIntensity` | `THREE.Scene.environmentIntensity` |
| `fogMode` | `"none"` \| `"linear"` (near/far) \| `"exp2"` (density) |
| `fogColor`, `fogNear`, `fogFar`, `fogDensity` | Fog params; the mode selects which apply |
| `toneMapping` | `"none"` \| `"linear"` \| `"reinhard"` \| `"cineon"` \| `"aces"` \| `"agx"` \| `"neutral"` |
| `toneMappingExposure` | `WebGLRenderer.toneMappingExposure` |
| `shadowsEnabled` | Master switch for the renderer's shadow pass |
| `shadowType` | `"basic"` \| `"pcf"` \| `"pcfsoft"` \| `"vsm"` |

**Environment (IBL) is the highest-value control here.** With `environmentSource: "none"` — the shipped default — every material with `metalness > 0` has nothing to reflect and renders near-black. `"room"` generates a neutral studio IBL at runtime via `PMREMGenerator` + `RoomEnvironment`, costing no shipped asset (about 2 KB of code in the bundle). It is off by default only so that turning on the environment system changed nothing about how the existing playable looks.

**A texture background that will not resolve falls back to the colour**, never to nothing: an invisible scene reads as a broken engine, a wrong colour reads as a typo.

#### Serialization and defaults

`loadSceneEnv(raw)` merges field-by-field over the defaults rather than casting. The file is hand-editable and outlives the code that wrote it, so a config saved before a setting existed picks up that setting's default instead of arriving as `undefined` and becoming a `NaN` inside a shader uniform three frames later. Junk input (`null`, a number, a string, an array) returns the defaults rather than throwing. A directional entry with no `id` is given a stable one derived from its index rather than being dropped — an unaddressable light would be uneditable and un-undoable.

`serializeSceneEnv` is a plain deep copy: every field in the config is authored, so there is nothing to filter out.

**The shipped defaults reproduce the engine's pre-environment-system appearance exactly** — sky `#8ed1ef`, linear fog 30→180, ambient white at 0.7, a warm `#fff4d6` sun at 1.2 from `(6, 12, 6)`, a cool `#bfe3ff` fill at 0.35 from `(−6, 4, −4)`, `toneMapping: "none"`, `environmentSource: "none"`, shadows enabled with PCF-soft filtering but **no light casting**. `tests/scene-environment.test.mjs` asserts this, so the defaults cannot silently drift into changing an existing playable's look.

### 3.3 Rendering setup

The renderer is created in `Game`'s constructor and is game-layer, not engine-layer:

```ts
new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
```

Everything else about the renderer's visual configuration — tone mapping, exposure, shadow enable, shadow filter type — is owned by `SceneEnvironment` and authored in `environment.json`.

`Game.render()`, once per frame:

```
activeCamera = editor?.camera ?? cameraHandler.camera
editor?.update()            // editor frame: orbit, gizmos, collider sync, panels
colliderDebug?.update()     // DEV overlay — no-ops entirely while nothing is showing
Ion.particles.setCamera(activeCamera)   // billboarding + distance sort read the CURRENT camera
Ion.particles.render()
renderer.render(scene, activeCamera)
viewHelper?.update(activeCamera)        // DEV
```

> **Known Limitation — shadows are configured but nothing casts.** The shipped `environment.json` has `shadowsEnabled: true` with `shadowType: "pcfsoft"`, every mesh in the environment GLB has `castShadow`/`receiveShadow` set, and both directional lights have `castShadow: false`. The result is zero shadows on screen while every material still compiles its shadow-map defines. Either turn `castShadow` on for the sun in the Environment dock (and size `shadowCameraExtent` to the real environment footprint — the shipped `20` was tuned for a 10-unit arena, not the ~109×124-unit environment model), or turn `shadowsEnabled` off for a free win. The engine supports both; the shipped configuration commits to neither.

> **Known Limitation — depth precision.** The default camera `near` is `0.01` against a `far` of `1000`, a 100,000:1 ratio that spends the depth buffer up close and invites z-fighting on coplanar GLB geometry. Nothing in the reference playable comes within a unit of the camera. Both are now authorable in the Environment dock.

---

## 4 · ION Collider & Area system — `engine/collision/`
Trigger zones, area volumes, character collision shapes, and solid geometry that actually blocks. **Not physics, and not a wrapper around one.** There is no rigidbody, no mass, no velocity, no gravity, no solver. The system answers one question continuously — *which registered volumes overlap right now* — turns the frame-over-frame change in that answer into enter/stay/exit events, and (only when gameplay asks, via `moveAndSlide`) can tell you where something would have to be in order not to be inside a wall. Rapier and its relatives stay entirely out of the bundle.

That's the right trade for a playable ad. Trigger zones, pickup radii, "did the player reach the machine" — none of it wants a simulation step, and all of it has to survive a hard size budget. This costs a few kilobytes of JS and a handful of dot products per frame.

**The runtime ships; the editor for it does not.** `collision/` is ordinary engine runtime, imported by `Game.ts` and present in `dist/index.html`. The authoring half (`editor/EditorColliders.ts`, `editor/ColliderVisuals.ts`) lives under `editor/` and tree-shakes out with the rest of it — verified by grepping the production bundle, see [§12.4](#124-what-actually-ships).

| File | What it is |
| --- | --- |
| `Collider.ts` | Base class: shape + transform + `tag` + `enabled` + `isTrigger`, the `on*` event subscriptions, and the per-frame transform sync. |
| `BoxCollider.ts` / `SphereCollider.ts` / `CylinderCollider.ts` | The three volumes. Each owns its dimensions and rebuilds its own world-space shape from the node's decomposed transform. |
| `intersect.ts` | Every shape-vs-shape test plus `penetration()` (the minimum translation out), zero-allocation, with the exactness of each pair stated in the file header. |
| `ColliderManager.ts` | The registry, the broad phase, the enter/stay/exit state machine, and `moveAndSlide`/`depenetrate`. Reached as `Ion.colliders`. |
| `ColliderSerialization.ts` | `src/game/colliders.json` ↔ live registry. `loadColliders` runs in production. |
| `ColliderTypes.ts` | Shape/data/world-shape types shared by all of the above. |

### How one frame works

`IonEngine` calls `Ion.colliders.update()` immediately after `activeGame.update(dt)`, inside the same not-paused guard as everything else — so detection sees where things actually moved to this frame, and freezes with gameplay rather than firing behind an open editor.

**1 · Sync.** For each *enabled* collider, `Collider.syncWorld()`:

```
attached.updateWorldMatrix(true, false)      // force-refresh: this runs before three.js's own render traversal
nodeWorld = attached.matrixWorld × offsetMatrix
decompose nodeWorld into node.position / quaternion / scale
rebuild the world-space shape (centre, unit axes, half-extents / radius / halfHeight)
```

The forced refresh is what makes detection current instead of one frame stale for anything that moved this frame. The same step also detects and folds back an *external* edit to the node — see "the sync is two-way" below.

**2 · Broad phase.** Sweep-and-prune along X over world bounding spheres:

```
sort entries by min-X
for i, for j > i:  if entries[j].min > entries[i].max → break   // sorted, so nothing further along can reach
```

The sort is an insertion sort, because the array is almost always already sorted between frames (colliders move a little; they don't teleport) — the case insertion sort is O(n) on. Single-axis sweep rather than a BVH or spatial hash on purpose: for the collider counts a playable holds, maintaining either costs more per frame than it saves.

**3 · Filter, before any math.** `canPair(a, b)` — both enabled, not the same collider, and each side's tag mask accepts the other (see "tags and masks" below) — then a bounding-sphere reject. A pair rejected here never reaches an intersection test at all, which is what makes a mask a genuine optimization rather than an `if` at the top of your handler.

**4 · Narrow test** (`intersect.ts`), dispatched on the two shape kinds:

| Pair | How | Exact? |
| --- | --- | --- |
| sphere ↔ sphere | squared centre distance vs summed radii | yes |
| sphere ↔ box | closest point on the OBB, clamped in the box's own frame | yes |
| box ↔ box | SAT over 15 axes — 6 face normals + 9 edge cross products | yes |
| sphere ↔ cylinder | clamp the centre into the capped volume: radially, then along the axis | yes |
| cylinder ↔ cylinder, near-parallel axes | 1D extent overlap along the shared axis + 2D circle test across it | yes |
| cylinder ↔ cylinder skewed, box ↔ cylinder | SAT against the cylinder's tight OBB **and** distance to its axis segment | conservative |

*Conservative* means never a false negative, occasionally a false positive within a fraction of the cylinder's radius near a corner — a genuine overlap always passes both tests. Closing that last fraction of a radius would mean a GJK/EPA solver, which is frame budget spent on precision nobody can see in a playable.

Every function here borrows from a fixed pool of module-level scratch vectors rather than allocating — these run O(pairs) times per frame, and the pool is partitioned by purpose so the one case that nests (box↔cylinder calls both) can't stomp on itself.

**5 · Diff and dispatch.** Overlapping pairs live in a `Map` keyed by two collider ids packed into a single integer:

- key absent → **enter**, age 0
- key present → age++, **stay**
- key in the map but not seen this frame → **exit**, delete

Nothing traverses the scene graph anywhere in those five steps. Cost scales with the number of *colliders*, not the size of the scene — which is the entire reason for a dedicated registry.

### Making things solid, without physics

Detection alone doesn't stop anything — the five steps above report overlaps and never move a scene object. That's deliberate, and it's also not what you want when a wall should be a wall. `moveAndSlide` is the bridge:

```ts
// Player.update(), instead of position.x += ...
moveDelta.set(axis.x * speed * dt, 0, axis.y * speed * dt);
Ion.colliders.moveAndSlide(this.collider, this.player.position, moveDelta, { up: UP });
```

It applies the delta, then pushes back out of every **solid** collider the volume ended up inside, twice by default so inside corners settle instead of oscillating between two walls. Still no physics: no velocity, no restitution, no friction, and nothing else in the scene is touched — you're simply placed where you'd have to be in order not to be inside a wall. **Sliding falls out of that for free**: the push is perpendicular to the surface, so the component of your movement *along* the wall survives untouched.

"Solid" means neither side is a trigger. A trigger is a volume you walk through by definition, so it never contributes a push — that's the whole distinction between the two, and it's why `PlayerZone` stays enterable while `Arena Wall` stops you dead.

The push itself comes from `intersect.penetration()`, a generic SAT over a per-pair candidate axis set, measured with each shape's exact **support function** (a cylinder's is `halfHeight·|axis·L| + radius·√(1−(axis·L)²)`, which is its true silhouette in any direction). One loop therefore serves all six shape pairs instead of six bespoke routines. It's the exact MTV for box↔box; for curved pairs the true minimal direction can sit slightly off the candidate set, in which case the answer is a *larger* push along a nearby axis — which errs the safe way, always fully separating rather than leaving you clipped inside geometry.

**Pass `up` for anything that walks.** Without it every candidate axis is fair game, and the cheapest way out of a knee-high kerb is genuinely *over the top* — so the player climbs the scenery instead of being stopped by it. With `up`, candidates are projected into the horizontal plane before being measured, giving the minimum *horizontal* escape. Measured: a 1.8-tall cylinder standing in a 0.5-tall kerb resolves to `(0, 0.5, 0)` free and `(0.7, 0, 0)` with `up` set.

`depenetrate()` is the same computation without the movement — it returns the correction and leaves the caller to decide what to do with it, for anything that isn't a straightforward character move.

### Mechanics

**Colliders live in their own `COLLIDERS` group, and *attach* to scene objects rather than parent under them.** Every collider's node sits under one engine-owned group at the scene root; `attachTo` makes it *follow* a scene object by recomputing its world transform from that object's world matrix every frame. Two reasons: a GLB-heavy scene is already hundreds of nodes and salting collision data through it makes both harder to read (and a re-export would blow the colliders away with the model), and attachment then survives the target being re-parented or swapped out entirely. The group is held at identity permanently — `Collider.syncWorld` writes world-space transforms straight into each node's local transform on exactly that assumption. Note the name is uppercase: `Cinema_World.glb` already contains a mesh group called `Colliders`, and the two must never be confused.

**The sync is two-way.** If something else moves a collider's node — the 3D editor's transform gizmo is the case that matters — the change is detected (`node.matrix` no longer matches what the collider last wrote) and folded back into the offset instead of being overwritten next frame. That's what makes dragging a collider in the editor actually stick, and it needs no cooperation from the gizmo.

**Tags and masks are two different filters, and it's worth keeping them straight.** `mask` is the *broad-phase* filter: masks are ANDed, so each side has to accept the other, and an empty mask means "accept anything". A pair the mask rejects never reaches an intersection test at all. The optional tag argument to `onTriggerEnter("Player", handler)` is the *handler* filter — it saves every handler from opening with `if (other.tag !== "Player") return;`. The shipped example uses both and they agree, which is the normal case; they're separate because a zone that wants to *see* several tags but *react* differently to each needs a wide mask and narrow handlers.

**Event contract:** enter fires once on the frame the overlap begins; stay fires every frame *after* that while it holds (so enter and stay never both fire for one pair on one frame); exit fires once when it ends — **including** when the other collider is disabled, destroyed, or has its attached object removed from the scene. That last part is what stops the classic stuck-flag bug where a handler runs on enter and never hears the matching exit. If either side of a pair is a trigger, only trigger events fire; two non-triggers report to each other as `onCollision*`.

### Runtime API

In the shape gameplay actually uses it:

```ts
const zone = Ion.colliders.getByName("PlayerZone");
zone.onTriggerEnter("Player", (other) => hud.showPrompt());
zone.onTriggerStay("Player", () => score.tickBonus());
zone.onTriggerExit("Player", () => hud.hidePrompt());
zone.setEnabled(false);                       // fires exit on anything inside

// Solid colliders blocking a character — see "making things solid" above.
Ion.colliders.moveAndSlide(this.collider, this.player.position, delta, { up: UP });
Ion.colliders.depenetrate(this.collider, { up: UP });   // the push, without applying it

// An entity registering its own volume, in its own constructor:
this.collider = Ion.colliders.cylinder({ name: "Player Collider", tag: "Player", radius: 0.4, height: 1.8, attachTo: this.group, position: [0, 0.9, 0] });

// Ad-hoc queries, for the "what's near me right now" question you ask once
// rather than every frame:
Ion.colliders.overlapSphere(point, 3, "Pickup");
Ion.colliders.queryPoint(point);
Ion.colliders.getByTag("Solid");
```

### Authoring and persistence

**Colliders can be assigned to script fields, exactly like scene objects.** A `public zone: Collider | undefined` (or `BoxCollider`/`SphereCollider`/`CylinderCollider`, which additionally enforce the shape) gets a `⊙ Pick` button in Control Desk and accepts a collider dragged out of the Hierarchy's COLLIDERS group or clicked on its volume in the viewport. Two things are worth spelling out:

- **The field receives the `Collider`, not its node.** A collider isn't an `Object3D`, so `EditorRoot.assignmentFor` returns a `value` (what the field gets) separately from the `object` (what was clicked) — one place decides it for both ⊙ Pick and drag-to-assign, so the two can't drift into assigning different things, which is the kind of bug that only surfaces after a reload.
- **It persists by `colliderId`, not by path.** `SceneFieldBinding.colliderId` is set for collider assignments and resolved through the registry at boot rather than by walking the scene, falling back to a lookup by name so renaming a collider stays recoverable.

The ordering constraint that follows: a collider field is populated by `Game.ts`'s `applySceneBindings` pass over `inspectables`, which runs *after* every inspectable is constructed — so a constructor reading it always sees `undefined`. `AreaDemo` shows the pattern: it has a `wire()` method that `Game.ts` calls straight after that pass, rather than subscribing from its constructor.

**Persistence.** `src/game/colliders.json` is a real static import, so **colliders ship**: what you place in the 3D editor is what runs in the production build, exactly as with `sceneBindings.json`. Attachments are recorded by *path*, never uuid, for the same reason `SceneBindings.ts` gives. Colliders created in code (the Player's cylinder) carry `persisted = false` and are deliberately excluded from the file — writing one out would resurrect it as a duplicate next to the one the script creates again on the next boot.

The worked example lives in [`src/game/AreaDemo.ts`](src/game/AreaDemo.ts): a `PlayerZone` trigger from `colliders.json`, masked to `["Player"]`, responding to the Player's own cylinder — the spec'd setup, and about forty lines covering the whole runtime API.

### Full `ColliderManager` surface

```ts
attachToScene(scene) · detachFromScene() · currentScene
box(init) · sphere(init) · cylinder(init) · remove(collider, keepAlive?) · clear()
all · get(id) · getByName(name) · getByTag(tag) · fromNode(object3D)
update()                      // the real per-frame pass: detect AND dispatch events
previewOverlaps()             // detect only, dispatch nothing — the editor's pass
isOverlapping(collider) · queryPoint(point, tag?) · overlapSphere(centre, radius, tag?)
moveAndSlide(collider, position, delta, options?) · depenetrate(collider, options?, out?)
onColliderDeactivated(collider) · getStats()
```

> **Known Limitation — no automated coverage.** `ColliderManager.ts` (590 lines) and `intersect.ts` (468 lines) have **zero tests**, while being among the most-churned files in the repository's recent history. The narrow-phase maths is pure and DOM-free — the same shape as the particle suite, and just as cheap to write. See [§14](#14--known-limitations-and-production-readiness).

### Four things that already went wrong here

All four presented identically — "the editor forgot my collider on reload" — and none of them was the editor forgetting anything. Worth knowing before changing any of this back.

- **`loadColliders()` runs after the entities are built**, not just after the environment GLB. A collider records its attachment as a scene path and can only resolve it against a graph that already contains the object — and the most useful thing to attach one to is a character, which doesn't exist until `new Player(...)` has added its model. Loading earlier silently dropped every collider attached to anything an entity builds.
- **Path resolution backtracks** (`SceneBindings.descend`). Sibling name collisions are the default here, not an edge case: every GLB's root node is called `Scene`, so a game with an environment model *and* a character model has two scene children both named `Scene`. A first-match walk went down the environment's branch looking for `Scene/Armature`, found nothing, and gave up — while the node it wanted sat one branch over.
- **`attachToScene()` on a *different* scene retires everything already registered.** Saving in the 3D editor can write two watched files at once (`colliders.json` *and* `sceneBindings.json`), firing two hot reloads back to back. Both new bundles bind their own context but share whichever registry was bound last — so the first reload's Game registered its colliders here, and the second reload's Game then pointed this registry at *its* scene. `syncAll` correctly noticed every collider was attached to objects no longer present and disabled them all. One registry serves one scene.
- **Attaching a collider does not move it.** `attachToObject()` recomputes the offset against the new parent so the volume stays exactly where it is in the world. Keeping the old offset verbatim — the obvious implementation — teleports it: a collider at world (−8, 0, 8) re-homed onto a prop 12 units away lands at *that prop's transform times* (−8, 0, 8), somewhere off in the distance, which from the outside looks exactly like attaching having done nothing.

## 5 · ION Particle & VFX system — `engine/particles/`

A GPU-instanced particle system built for playable ads: one draw call per emitter, preallocated typed-array storage, zero per-frame allocation in steady state, and every expensive feature genuinely optional. **No `Object3D` is ever created per particle.**

**The runtime ships; the editor for it does not.** `particles/` is ordinary engine runtime, imported by `Game.ts` and present in `dist/index.html`. The authoring half (`editor/EditorParticles.ts`, `editor/ParticleVisuals.ts`) lives under `editor/` and tree-shakes out with the rest of it — verified the same way as the collider editor, see [§12.4](#124-what-actually-ships).

| File | What it is |
| --- | --- |
| `ParticleTypes.ts` | The module config shapes and the serialized form. Pure data, no behavior — both runtime and editor agree on it without importing each other. |
| `ParticleBuffer.ts` | Structure-of-arrays particle storage. Densely packed, allocated once at `maxParticles`. |
| `ParticleSimulation.ts` | The single per-frame update pipeline over every module. |
| `ParticleShapes.ts` | Box/sphere/cone emission sampling, allocation-free. |
| `ParticleRandom.ts` | Seeded mulberry32 PRNG, curve/gradient evaluation, value noise. |
| `ParticleRenderer.ts` | `InstancedBufferGeometry` + instanced attributes → one draw call. |
| `ParticleMaterial.ts` | The shader, its `#define` set, and the shared default texture. |
| `ParticleTrails.ts` | Pooled camera-facing ribbon trails. Not constructed at all when disabled. |
| `ParticleEmitter.ts` | Config + buffer + simulation + renderer, plus lifecycle and the local/world decision. |
| `ParticleSystem.ts` | A named group of emitters, and sub-emitter routing between them. |
| `ParticleManager.ts` | The registry, the `PARTICLES` group, the frame driver, quality tiers, and stats. Reached as `Ion.particles`. |
| `ParticleDefaults.ts` | Complete defaults + the normalizer that fills a partial config out. |
| `ParticlePresets.ts` | Thirteen starter effects, as data. Editor-only in practice — see *Authoring and persistence* below. |
| `ParticleSerialization.ts` | `src/game/particles.json` ↔ live registry. `loadParticles` runs in production. |

### Why instanced quads, not Points or Sprites

`THREE.Points` looks like the obvious fit and isn't: `gl_PointSize` is driver-capped (commonly 64–255px, and *silently* — a large soft smoke puff just stops growing), points can't rotate, can't stretch along velocity, and clip against the near plane as whole points rather than per fragment. `THREE.Sprite` fixes rotation but is one `Object3D` and one draw call *per particle*.

An `InstancedBufferGeometry` of one quad plus per-instance attributes gives one draw call per emitter, arbitrary size, free GPU-side billboarding/rotation/stretching, and a flipbook for the cost of a UV offset. The CPU writes eleven floats per particle per frame; the GPU does the rest. Four render modes share the same geometry: camera-facing billboard, velocity-aligned, stretched-by-speed, and real mesh instancing.

### Structure of arrays, and why particles pack densely

Every attribute is its own `Float32Array` indexed by slot. An array of `{position, velocity, age, …}` objects would cost one allocation and one GC-tracked reference per particle and scatter each particle's fields across the heap — at 2000 particles × 60fps that difference is the whole frame budget.

Live particles always occupy `[0, count)`. Killing particle `i` copies the last live one into its slot and decrements `count`. That keeps the array contiguous, which matters twice: the simulation loop is a straight `for (i = 0; i < count; i++)` with no liveness check per slot, and the renderer uploads `[0, count)` directly as `instanceCount` with no compaction pass. A free list would avoid the copy but reintroduce holes — and then every consumer needs an `if (alive[i])` inside the hottest loop in the system, plus a GPU upload that has to compact anyway.

The one thing swap-remove costs is stable ordering, which is why `birthId` exists: trails and sub-emitters need to know that slot 7 holds a *different* particle than it did last frame, and the slot index alone can't answer that.

### One pass, and disabled modules that are genuinely free

Every module is a branch inside **one** loop rather than its own iteration or a per-particle callback. A per-module pass would read and write the same particle's position and velocity once per module, blowing cache each time; a per-particle callback would add an indirect call per particle per module. Here a particle's fields load into locals once, every enabled module operates on those locals, and they write back once.

Each module's `enabled` flag is hoisted into a `const` *before* the loop, so a disabled module costs one already-predicted branch per particle and touches nothing. That's what backs "a simple emitter stays extremely cheap no matter how many features exist" — the feature set is opt-in at runtime, not just at author time. Trails go further: with the module off, `ParticleTrails` is never constructed, so there's no geometry, no material, no pool, and no per-frame call.

### Modules

`Main` (always on) · `Emission` (rate + bursts) · `Shape` (box/sphere/cone) · `Velocity` (linear/orbital/radial) · `Force` (+ drag) · `Limit Velocity` · `Noise` · `Color over Lifetime` · `Size over Lifetime` · `Rotation` · `Texture Sheet` (flipbook) · `Renderer` · `Trails` · `Collision` · `Sub Emitters` · `Quality/LOD`.

Values are constants or min/max ranges (`min === max` *is* the constant case, so a constant is branch-free), with real curves for size and real gradients for color.

### Simulation space

`local` — particles are integrated in the emitter's frame and the render mesh carries its transform, so moving the emitter drags its particles along. `world` — the emitter transform is baked into position and direction once, at birth, and the mesh sits under the identity-held `PARTICLES` group, so particles stay where they were released.

Gravity is resolved *into whichever frame is active*: world-down is rotated into the emitter's local frame when simulating locally. Without that, a tilted emitter's smoke rises along the emitter's up instead of the world's — which looks fine at zero rotation and obviously broken the moment anyone tilts it.

### Sub-emitters

`ParticleSimulation` emits birth/death/collision events and knows nothing about other emitters — that's what keeps it a pure per-particle loop. `ParticleSystem` routes those into siblings by name, converting the trigger point between simulation spaces first. Without that conversion, a world-space parent spawning a local-space child places every child particle at the world coordinate read as a local offset — visibly flung away by exactly the emitter's own position. Chains are depth-limited to 3, which is cheaper and more predictable than cycle detection in the graph.

A sub-emitter spawn is *placed* by its trigger point, so a world-space child must strip its own world translation back off after applying its world matrix — otherwise the child's position is added on top of the trigger point and an explosion's smoke appears at (emitter + debris) rather than at the debris.

### Determinism

Each emitter owns its own `ParticleRandom`, so reproducibility is a per-emitter property rather than a global one. `Math.random()` couldn't do this even if JS let you seed it: it's a single stream, and two emitters drawing from it interleave differently depending on frame timing. `setSeed(n)` + the same `dt` sequence reproduces an effect exactly — there's a regression test for both directions of that.

**Nothing in the simulation path may reach for `Math.random()`.** Sub-emitter probability did, and one call on the unseeded global stream is enough to make any effect using a sub-emitter irreproducible no matter what `setSeed()` was given — it now rolls off the parent's own generator (`ParticleEmitter.nextRandom`).

### Lifecycle

**A constructor must not start simulating.** `ParticleEmitter` records `playOnStart` and does nothing with it; `autoStart()` is called afterwards, by `ParticleManager.add` for a whole system and by the editor after its own `setWorldRoot`. Folding that back into the constructor broke two things at once:

- `play()` runs `prewarm()`, which spawns immediately, which fires `onBirth` into `ParticleSystem`'s sub-emitter routing — while that system's own `const emitter = new ParticleEmitter(...)` was still evaluating. The closure captured a binding in its temporal dead zone: *Cannot access 'emitter' before initialization*.
- Prewarm at construction also runs *before* `setWorldRoot()` and the first `syncTransform()`, so `simulation.worldMatrix` is undefined and a world-space emitter bakes an identity transform into its entire backlog — dumping every prewarmed particle at the origin instead of at the emitter. Silently wrong rather than crashing, which is worse.

`play()` and `restart()` therefore refresh the transform *before* prewarming, and prewarm requires `loop` — prewarming a one-shot would consume its whole duration at play time and leave it instantly finished.

### Runtime API

```ts
const burst = Ion.particles.getByName("Coin Burst");
burst?.playAt(coin.position);          // move + restart, one call
burst?.setSeed(1234);                  // reproducible from here on

const emitter = burst?.get("Coins");
emitter?.emit(20);                     // ignore rate/duration, fire now
emitter?.isPlaying();
emitter?.settings.main.startSpeed;     // live config, editable at runtime

Ion.particles.setQuality("low");       // scales rate/bursts across every effect
Ion.particles.getStats();              // measured, not estimated
```

`play() · pause() · stop() · restart() · clear() · emit(n) · setSeed(n) · isPlaying() · isFinished()` exist on both `ParticleSystem` and `ParticleEmitter`. `stop()` deliberately lets live particles finish their lifetimes — a smoke plume that vanished the instant you stopped the emitter would be wrong in every case anyone actually stops one; `clear()` is the immediate version.

### Authoring and persistence

`src/game/particles.json` is a real static import, so **effects ship**: what you author in the Particle Editor is what runs in production, exactly as with `colliders.json` and `sceneBindings.json`. Attachments are recorded by *path*, never uuid, for the same reason `SceneBindings.ts` gives.

**Only the configuration is serialized; the particles never are.** A saved effect is its emitter configs and nothing else — no positions, no ages, no buffer state. That's what makes `particles.json` a small diffable file describing an effect rather than a snapshot of one mid-play, and why a loaded effect starts from its own beginning rather than resuming from wherever it was when someone hit save.

The worked examples shipped in `src/game/particles.json` cover all three emission shapes — a box-based **Ambient Dust**, a sphere-based **Explosion** (debris → smoke via a sub-emitter), a cone-based **Campfire** (fire + smoke), and a **Coin Burst** with pooled trails. It's editor-authored data, so treat that list as the starting point rather than the current contents.

**Presets are editor-only in practice.** `PARTICLE_PRESETS` is engine data a game *could* use at runtime, but `Game.ts` reaches it through `EditorRoot.getParticlePresets()` rather than importing it directly — an ungated import shipped all thirteen preset configs into the production bundle for a dropdown that only ever exists in the editor. Caught by grepping the built file; worth not undoing.

**`normalizeEmitterConfig` deep-copies on the way out**, and that is load-bearing rather than tidiness. Its module spreads carry the arrays inside each module (`gradient`, `curve`, `bursts`, `entries`) and the tuples (`startColor`, `boxSize`, `pivot`) through *by reference* — straight from either a shared literal in `PARTICLE_PRESETS` or the cached `particles.json` module object. Without the copy, two effects built from one preset shared a gradient array, so editing one recoloured the other and permanently mutated the preset for the rest of the session.

### Things that already went wrong here

Every one of these was live in the code and is now covered by a test that was checked to fail against the original.

- **A `#ifdef` block ending in `return` is not exclusive.** The mesh render path did that and left the billboard path unguarded after it, so with `USE_MESH` defined both declared `mvPosition` in one scope and the shader failed to compile — mesh mode was dead on arrival. The preprocessor only strips a *false* branch; `#else` is what makes branches exclusive. `tests/particle-shader.test.mjs` now preprocesses all nine define combinations and checks each one.
- **A burst at time 0 fires once and never again on a loop**, if the cycle wrap leaves `time` at a remainder rather than 0. The burst then falls *before* the next window, is skipped, and is still consumed. Fixed by slicing the frame at cycle boundaries so every cycle genuinely begins at 0 — the alternative (special-casing `from === 0`) only works for the first cycle.
- **Ageing and expiry-counting are two passes, not one.** The trail sweep aged points in the same loop that counted expired ones, and that loop breaks at the first survivor (they're stored oldest-first) — so a point only aged once it *became* the oldest. Trails lasted roughly `lifetime × maxPoints` and the alpha ramp was flat for all but one point.
- **A subsystem holding its own copy of a config has to be told when it changes.** `ParticleTrails` copies the trail module at construction (it reads it in two hot loops), and nothing called `setConfig` — so every trail control in the Inspector silently did nothing. `ParticleEmitter.applyConfig` now forwards it.
- **An attached emitter's node holds a *world* transform.** `syncTransform` decomposes `attached.matrixWorld × local` into the node, so `adoptNodeTransform` copying `node.position` straight into `config.position` stores a world position in a field read back as a local offset — compounding by the attachment's transform every frame, which sent attached emitters off toward infinity within a second of the editor opening. It now inverts through the attachment, making adopt∘compose the identity.

### Full `ParticleManager` surface

```ts
attachToScene(scene) · detachFromScene() · currentScene
create(config) · add(system) · remove(system, keepAlive?) · readd(system) · clear()
all · get(id) · getByName(name) · allEmitters
emitterFromNode(object3D) · systemFromNode(object3D)
setCamera(camera) · update(dt) · render()
setQuality("high"|"medium"|"low") · getQuality()
pauseAll() · playAll() · clearAllParticles()
setDepthTexture(depth, near, far)      // see Soft particles below
getStats() · disposeSharedResources()
```

`setQuality` scales emission **rates and burst counts**, never particle size or the buffer cap — a thinner effect reads as the same effect, while a smaller one reads as a different one.

### Soft particles — **Partial**

The `Renderer` module carries a `softParticles` flag, `ParticleMaterial` compiles a depth-fade path behind a `#define`, and `ParticleManager.setDepthTexture(depth, near, far)` propagates a depth texture down to every emitter's material.

**Nothing calls `setDepthTexture`.** There is no depth pre-pass in `Game.render()` and no engine-side render target, so with nothing wired the flag compiles out and enabling it in the Inspector has no visible effect. To use it, a host would need to render the scene depth into a `THREE.DepthTexture` before the particle pass and hand it to the manager each frame. The shader and plumbing are complete; the producer of the depth texture is not.

### Undo-friendly removal

`ParticleManager.remove`, `ParticleSystem.removeEmitter`, and `ColliderManager.remove` all take a `keepAlive` flag that detaches without releasing GPU resources, so the editor's undo can put *the same instance* back — see [§10.12](#1012-undo--redo--save) for why identity matters more than it looks. Anything holding a detached object owns it and must re-add or dispose it. `detach()`/`reattach()` are symmetric on purpose: a **world-space** emitter's render mesh is parented under the manager's `PARTICLES` group rather than its own system's group, so removing the system group alone would leave its particles hanging in the scene.


---

## 6 · UI runtime — `engine/ui/`
The runtime half of the visual UI editor. `UILayoutTypes.ts` is the schema (`UIElementData`/`UILayoutData`) — percentage- or pixel-based positioning with 9-point anchors (mirrors Unity's `RectTransform`), `renderOrder` (visual stacking, floats seeded 0.1 apart so inserting between two elements never forces renumbering) and `zOrder` (DOM-order tie-break for touch/pointer hit-priority, independent of visual stacking). `UILayout.ts` renders that JSON into real DOM: a wrapper node per element carries the static anchor transform, a separate content node carries any CSS animation, so the two never fight over the `transform` property.

**Element types.** The original five were `image`/`text`/`rect`/`joystick`/`group`; the set is now `button`, `progress`, `slider`, `toggle`, `checkbox`, `sprite`, `video`, `shape` and `icon` as well. Every one exists in **both** `UILayout.ts`'s `buildContent()` and `tools/ui-editor.html`'s `buildContentNode()` — an element the editor can author but the runtime can't render (or vice versa) is the editor-only/runtime-only split the architecture forbids. Four things people ask for as "types" are deliberately fields instead, because a separate type would have produced markup already reachable another way: a **mask** is `clipContent` on a group, a **gradient** is `fillType`/`gradient` on any box-ish element, and **panel**/**container** are both just a group.

Two implementation notes worth knowing before touching them. **Sprites animate in pure CSS** — an absolutely-positioned sheet inside an `overflow:hidden` window whose `left`/`top` step by whole window-widths via `steps()`, so there is no rAF ticker, nothing to tear down on a hot reload, and no per-frame JS cost; `left`/`top` are two separate properties, which is why the column and row animations compose instead of fighting the way two `transform` animations on one node would. **Declarative actions stay engine-generic**: `show`/`hide`/`toggleVisible`/`setText` are pure UI operations the runtime carries out with no game knowledge, while `cta` and `emit` route out through `onAction()` so `src/game/` decides what `"start-game"` means — the engine never learns any game's vocabulary.

**`z-index` is an integer rank, never the raw `renderOrder`.** CSS defines `z-index` as `auto | <integer>`, so a fractional value is invalid and browsers drop the declaration outright. Because the editor seeds `renderOrder` at 0 and steps it by 0.1, emitting it directly meant every element after the first was rendering with **no `z-index` at all** — stacking silently fell back to DOM order, in the preview and the shipped playable alike, so the Properties panel's "R Order" control only appeared to work whenever DOM order happened to agree with it. `buildStackRanks()` (present identically in both files) sorts by `renderOrder ?? zIndex` and assigns contiguous integers, keeping the float authoring model — which is genuinely nicer to edit — while emitting something CSS will actually honor. Ties keep array order, so `zOrder`/DOM-order tie-breaking is unchanged.

**Defaults are part of the parity contract, not just the formulas.** Every `?? fallback` in `UILayout.ts` has a character-for-character twin in the editor's render path. They were `||` on the editor side, which swallows *any* falsy authored value: `fontSizePct: 0` previewed at 4% and shipped at 0px — text that looked right to the designer and was invisible in the ad — and the same trap sat under every `|| "#color"`. `tests/render-defaults-parity.test.mjs` now fails the build if either side reintroduces a `||` default or the two disagree on a literal.

**Screen resizing/UI scaling — locked, final, verified.** Every element (top-level or nested in a group) is a real DOM descendant of its real parent — the container itself, or the parent group's real rendered box — with no intermediate fixed-resolution wrapper. `%` fields resolve as plain native CSS `%` against that real parent, unchanged from how CSS `%` has always worked (this is what makes a full-bleed background correctly reach the real edges on any aspect ratio). `px` fields (position and size alike) are multiplied by one uniform `pxScale()` factor — `Math.min(scaleX, scaleY)`, where `scaleX`/`scaleY` are the live container size against the layout's own fixed `canvasWidth`×`canvasHeight` design resolution — so a `px` value scales the same amount on every axis regardless of aspect ratio (a joystick stays circular instead of ballooning into an oval in landscape). Text `font-size` is `fontSizePct`% of the container's *current real height*, recomputed every resize — deliberately not a CSS `vh` unit and deliberately not `pxScale()`-corrected. These formulas are written to be **identical** to `tools/ui-editor.html`'s own `pxScale()`/`elemScreenWidth`/`elemScreenHeight`/`elemScreenX`/`elemScreenY`/`renderCanvas()` geometry and its text font-size formula — the editor is the source of truth for what a layout should look like, and `UILayout.ts` is written to reproduce it exactly, not to be "an equivalent system." **If this ever needs to change, change the same formula in both files together** — see the `ion-engine-architect` skill's "Screen Resizing & UI Scaling System" section for the full history of why (an earlier fixed-resolution "stage" + outer `transform: scale()` approach looked correct but stretched text badly enough at extreme aspect ratios to clip words in half; the fix was deleting that stage entirely, not patching around it).

That instruction used to be enforced by this paragraph alone — silent drift here is a known, historically real failure mode in this codebase (the stage bug above shipped without erroring), so it's now backed by `tests/geometry-parity.test.mjs` (`npm run test:geometry`), not just a comment. **Worth knowing that this suite was itself red for some time**: the editor's `elemFontSizePx` read `(d.fontSizePct || 4) * (liveH / 100)` against the runtime's `((d.fontSizePct ?? 4) / 100) * liveH` — different in operator *and* in operation order — so Layers 1 and 2 were both failing and the "mechanically enforced" guarantee wasn't actually holding. Having the test is not the same as having it green; run `npm test` before assuming this contract is intact. Both files carry a `// ─── GEOMETRY:BEGIN/END ───` fence around their real formulas (`UILayout.ts`'s is exposed test-only via an additive `public __geometry()` — nothing else changes to support this); the suite extracts both fences with plain text/brace-depth scanning (same philosophy as `/script-info` above — no parser dependency), hashes a normalized version of each to catch *structural* drift, then calls both sides' real formulas across a dense viewport × design-resolution × element × parent-box matrix and asserts `Object.is` equality (exact, not epsilon — rewriting `(a/100)*b` to `a*(b/100)` is mathematically identical but not bit-identical in IEEE-754, and this contract is "reproduce it exactly," not "produce an equivalent result") to catch *numeric* drift. A third layer checks runtime-only invariants (a `px` square stays square at every viewport, `%` reaches the real parent edge, font-size never depends on width) that should hold even if both files drifted together. See `tests/lib/geometry-source.mjs` for how the editor's half gets executed without a browser (`new Function(...)` over the extracted text, never touching `document`/`window`) and the runtime's half without a real DOM (`esbuild.transformSync` + `Object.create(UILayout.prototype)`, skipping the constructor entirely since none of these formulas need it).


### `UILayout` public surface

```ts
new UILayout(container: HTMLElement, data: UILayoutData)
updateScale(width, height)                    // re-derives px geometry + font sizes
get(name): HTMLElement | undefined
getJoystick(name): { base, knob } | undefined
setVisible(visible) · show(name) · hide(name)
setImage(name, src) · setText(name, text)
setValue(name, value) · getValue(name) · isOn(name)
setInteractive(nameOrElement, onClick?)
onAction(handler: (event: string, element: UIElementData) => void)
dispose()
```

`UILayoutTypes.ts` additionally exports `EMPTY_LAYOUT`, `IMPLICITLY_INTERACTIVE` (`button`, `slider`, `toggle`, `checkbox`) and `BOX_TYPES` (`rect`, `group`, `button`, `shape`, `progress`, `slider`, `toggle`, `checkbox`), plus the state-override (`hover`/`pressed`/`disabled`), gradient, and action schemas.

---

## 7 · Input

### `core/DynamicJoystick.ts`

Touch-anywhere virtual joystick. Invisible until you touch the screen, then appears centred exactly where you touched. It reuses whatever base/knob visuals were designed in the UI editor (colour, size) and only controls *where* and *when* they appear — the joystick is a real, editable layout element of type `joystick`, not hardcoded HTML.

Implementation notes worth knowing before touching this file:

- **Re-parents the `base`/`knob` DOM nodes to `document.body`.** They originally live inside a `UILayout`-built wrapper that carries a CSS `transform` for anchor positioning, and a transformed ancestor becomes the *containing block* for any `position: fixed` descendant (per spec), not the viewport. Left nested, the joystick would never land under the pointer.
- **Creates its own full-screen invisible catcher layer** (`z-index: -1`, so any real designed button still wins its own clicks) rather than listening on the base/knob directly, since those roam to wherever you last touched.
- **`dispose()` removes the body-reparented nodes explicitly** — they are not inside any container a normal teardown would reach, which matters because in-place hot reload keeps the DOM alive across reloads.

Takes an `onFirstInput` callback: the first real user gesture in the whole playable is also what unlocks audio (a browser `AudioContext` stays suspended, and `.play()` silently no-ops, until one).

### `core/InputManager.ts`

Generic pointer input — tap/swipe/drag classification by distance and duration on release — plus a keyboard axis fallback (WASD/arrows). Independent of `DynamicJoystick`, which already owns a locked, working pointer implementation for the one thing it does.

`keyboardAxis` uses the exact same `{x, y}` screen-space sign convention as `DynamicJoystick.axis` (down/right positive), so it is a drop-in substitute wherever `joystick.axis` is consumed, with no sign-flipping at the call site.

Wired into the reference game as a desktop-testing fallback: `Game.combinedAxis()` returns the joystick's axis whenever it is non-zero (actively held), falling back to `keyboardAxis` only while the joystick is neutral — so a touch drag can never fight a stale held key. Takes the same `onFirstInput` callback for the same audio-unlock reason.

Guards against stealing keystrokes from a focused `<input>` / `<textarea>` / contenteditable (Control Desk, the UI editor's own fields), and clears held keys on window `blur`, so alt-tabbing mid-press cannot leave `keyboardAxis` stuck non-zero forever.

`setEnabled(false)` suspends it. The 3D editor calls this for its session because the editor's W/E/R/Q gizmo shortcuts collide with the WASD fallback and both listen on `window`, where `stopPropagation` does nothing between two listeners on the same target. Without it, pressing **W** to switch the gizmo to Move also counted as the player's first input and started the background music mid-edit.

---

## 8 · Audio

Audio is **game-layer**, not engine-layer: `src/game/SoundHandler.ts` owns the `THREE.AudioListener`, the music `THREE.Audio`, and the `SoundType` enum. There is no `engine/audio/` module.

What the engine provides is the seam: the `AudioListener` is parented to `CameraHandler.perspective` (see [§3.1](#31-corecamerahandlerts--the-camera-rig) for why the inactive camera's world matrix is kept current), `AssetLoader` loads `audio` manifest entries into `AudioBuffer`s, and `IonEngine` exposes `__getAudioAnalyser` / `__isMusicPlaying` for the dev Audio Reactor panel.

The `THREE.AudioAnalyser` is **lazily constructed** — nothing builds one until the Audio Reactor panel's draw loop asks for it, and that loop only runs while the panel is visibly open. A production build pays nothing for it.

`SoundHandler` is also the reference example for Control Desk live-tuning: its public `volume` / `muted` fields are edited directly by the panel, and `SoundHandler.update()` — called every frame from `Game.update()` — applies `muted ? 0 : volume` onto the real gain. Control Desk needed zero new code for that; it only needed the fields to exist and something to read them back.

> **Planned.** There is no generic engine-level audio system — no SFX pooling, no per-sound volume buses, no spatial-audio helper. A new playable copies or replaces `SoundHandler.ts`.

---

## 9 · Script binding and ad-network integration

### `Bindings.ts` — UI elements → script fields

Runtime half of the UI editor's Scripts panel drag-and-drop.

```ts
applyBindings(instance, className, bindingsData, ...layouts)
```

Resolves every saved binding for `className` against the given `UILayout`s and writes each straight onto `instance`. One explicit call per wired class — there is no reflection/DI container behind compiled JS classes to do this invisibly, and the explicitness is intentional. See [`game/ui/HUD.ts`](src/game/ui/HUD.ts): call it once in the constructor, right after field declarations, and a field like `public moneyIcon: HTMLElement | undefined` is populated from whatever was assigned in the editor.

### `SceneBindings.ts` — scene objects and colliders → script fields

The same idea for 3D objects — the runtime half of the 3D editor's `⊙ Pick`.

```ts
applySceneBindings(instance, className, sceneBindingsData, scene)
sceneObjectPath(object, scene): string
resolveSceneObject(scene, binding): THREE.Object3D | undefined
```

**Objects are identified by path, never by uuid.** three.js regenerates uuids every time a GLB is parsed, so a uuid saved in one session resolves to nothing in the next — that is exactly why an assignment made in the editor came back `undefined` after a reload. `objectPath` is slash-separated node names from the scene root (`"Scene/props/popcornMachine"`, with unnamed nodes as `#<childIndex>`, since GLB exports are full of them).

**Resolution backtracks** through same-named siblings rather than committing to the first match. Every GLB root node is named `Scene`, so a game with an environment model *and* a character model has two scene children both called `Scene` — ambiguity is the norm here, not an edge case. `objectName` is kept alongside as a fallback `getObjectByName()` lookup for when a model is re-exported with a shifted hierarchy but the same node names. A binding that stops resolving leaves the field alone rather than throwing, and warns in dev only.

**Collider fields persist by `colliderId`**, not by path — `SceneFieldBinding.colliderId` is set for collider assignments and resolved through the registry at boot, falling back to a lookup by name so renaming a collider stays recoverable.

`src/game/sceneBindings.json` is a real static import, so **assignments ship**. `Game.ts` applies it across its whole `inspectables` map at the end of the constructor — after `scene.add(sceneModel)`, since a binding can only resolve against objects already in the graph — so registering a class in that map is the only step needed for its scene fields to persist.

**Ordering constraint.** A bound field is populated by that pass, which runs *after* every inspectable is constructed — so a constructor reading it always sees `undefined`. `AreaDemo` shows the pattern: a `wire()` method that `Game.ts` calls straight after the pass, rather than subscribing from its constructor.

### `Cta.ts` — one call for every ad network

The only thing a CTA/install button should ever call. Every network wants the click routed through its own API, and several explicitly forbid doing anything else on top (Mindworks: `install()` must be the *only* thing; Meta says the same about `FbPlayableAd.onCTAClick`).

`Cta.open(storeUrl)` feature-detects and fires **exactly one** handler, returning which network took it. `Cta.detect()` answers the same question without acting, so a dev readout cannot drift from what a real click does.

| Order | Host | Fires |
| --- | --- | --- |
| 1 | Mintegral Mindworks | `window.install()` |
| 2 | Meta / Facebook | `FbPlayableAd.onCTAClick()` |
| 3 | Google (Ad Manager / AdMob) | `ExitApi.exit()` |
| 4 | ironSource DAPI | `dapi.openStoreUrl(url)` |
| 5 | MRAID | `mraid.open(url)` — via `MraidAdapter`, never `window.open` |
| 6 | plain browser | `window.open(url, "_blank")` |

Order is load-bearing: several networks inject **both** their own API *and* MRAID, and the network-specific one is what fires the install-click event they bill on — so MRAID is checked second-to-last. `storeUrl` is only consulted on the paths that take one; network-owned handlers redirect to the listing the network itself configured.

> **Known Limitation.** Re-verify each hook against the target network's current documentation before submission. A silently-wrong CTA is the most expensive bug a playable can ship, and nothing in this repo can test these paths — they only exist inside a real network's host page.

### `MraidAdapter.ts` / `MindworksAdapter.ts`

Two host adapters wrapping different, incompatible conventions. These are the primitives `Cta` composes, not something game code normally calls directly outside lifecycle hooks.

**`MraidAdapter`** wraps the IAB MRAID API most networks inject (`window.mraid` — Mintegral, AppLovin, Unity Ads, ironSource, Meta, Google Ad Manager). `isPresent` is the "are we in *any* ad network" check every other method depends on.

`onReady(fn)` matters more than it looks. MRAID's own methods are unreliable before the host reports `"ready"`, and the WebView hosting the ad can still be mid-layout — sometimes literally 0×0 — the instant this script starts. Worse, an MRAID host is not guaranteed to ever fire a native DOM `resize` once it settles; it has its own `ready`/`sizeChange` events instead. `Game.ts` calls `onReady`/`onSizeChange` specifically to force a fresh resize once the host confirms ready, independent of whatever the native `resize` listener does. Without it, a renderer sized once at construction can stay wrong — invisible, in the 0×0 case — for the whole session.

`openStoreUrl` goes through `mraid.open()`, never plain `window.open`/navigation — WebViews routinely block or silently swallow that, and `mraid.open()` is also what fires the install-click event the network bills on.

**`MindworksAdapter`** wraps a separate, simpler, Mintegral-specific handshake ([playturbo.com/review/doc](https://www.playturbo.com/review/doc)) — plain `window.install` / `gameEnd` / `gameReady` the host defines and this calls, plus `window.gameStart` / `gameClose` this *exposes* for the host to call in.

`gameReady()` matters even though it looks optional: the review tool's own loading overlay waits for it, so a playable that never calls it looks stuck or blank in review despite booting fine. `exposeLifecycleHooks(onStart, onClose)` registers real no-op functions even with nothing to do — the review tool checks they exist as *callable functions*, regardless of whether the host ever invokes them.

Both `isPresent` checks are independent (a host can speak MRAID without being Mindworks, or vice versa) — which is why `Cta.detect()` checks `MindworksAdapter.isPresent` first rather than folding it into MRAID's check.

> **Known Limitation.** The reference game registers `MindworksAdapter.exposeLifecycleHooks(() => {}, () => {})` with genuine no-ops — it has no countdown or pause system to wire them to. A commercial playable should pause gameplay and audio on `gameClose` and resume on `gameStart`.

### `core/CrashOverlay.ts`

The crash guard's recovery UI — plain DOM nodes, inline styles only, one call to the stateless `Cta`. Deliberately independent of `Game` / `HUD` / `UILayout`: whatever just threw could have left any of that machinery broken, so the recovery path cannot risk depending on it.

`setCrashRecoveryUrl(url)` registers the store URL the recovery button uses. Called once by `Game.ts` at module load with the same URL its own CTA buttons use — **not** threaded through `IonEngine.boot()`'s options, so `main.ts` stays genuinely identical across every playable built on this engine. Safe to leave unset: the three network-owned `Cta` paths never read a URL at all.

---

## 10 · Editor and dev-only systems

Everything in this section is **DEV only** and reaches production in no form. Structurally, not by convention: every entry point into `src/engine/editor/` is behind `import.meta.env.DEV`, so Rollup drops the tree rather than shipping it guarded by a DOM lookup that never matches. Verified by grepping `dist/index.html` — see [§12.4](#124-what-actually-ships).

### 10.1 The Engine Room (`index.html`)

`index.html` is the **dev entry only** — Vite serves it at the project root, and the production build uses `src/index.template.html` instead, a minimal shell with none of this. It is a single 5,600-line file: ~3,400 lines of CSS, ~250 of markup, ~2,100 of vanilla JS talking to the `window.__*` hooks.

The Engine Room is the collapsed dev sidebar. Its controls:

| Control | What it does |
| --- | --- |
| ✏️ **UI Editor** | Opens `tools/ui-editor.html` as a full-screen overlay iframe over the running game, and pauses gameplay via `__setUIEditorPaused` |
| 🛠 **Builder** | Modal: live size estimate against a 5 MB budget, freshness dot, Half-Float compression toggle, **Build Now** (`POST /build`), **Build Report** |
| 🧭 **3D Viewer/Editor** | Enters the freecam editor — see [§10.2](#102-the-3d-viewereditor--layout-and-composition) |
| 🎧 **Audio Reactor** | Live frequency-spectrum readout of the game's music |
| 🧊 **Show Colliders** (`Shift+K`) | Draws collider/trigger volumes over the **running** game |
| **Engine Guide** | Opens `public/guide.html` in a new tab |
| Stats readout | FPS · draw calls · triangles, polled from `__getEngineStats` |
| View helper | The red/green/blue axis orientation widget |
| Scripts + Control Desk | Live public-field inspection and editing (see [§10.8](#108-control-desk)) |
| Device Preview bar | Portrait 16:9 / Landscape 16:9 / Real — letterboxes `#device-frame` and drives `__resizeGameTo` |
| Version readout | From `GET /version` |

**Build Report modal** renders `dist/build-report.json`: ad-network compatibility warnings as a red banner *above* everything else, summary cards, a size-composition bar, per-asset cards with before/after sizes and texture detail, unused assets, and optimization notes.

> **Known Limitation.** None of `index.html` is typechecked or tested. Every `window.__*` call site is guarded (`window.__x && window.__x()`), so renaming a hook in TypeScript degrades the dev screen **silently** rather than loudly — the worst failure mode for a dev tool. There is no shared `.d.ts` between `IonEngine`'s `Window` interface and this file, and no boot-time assertion that the expected hooks exist.

### 10.2 The 3D Viewer/Editor — layout and composition

**Three full-height docks flank the viewport**, and the viewport itself is `#device-frame` — *the same canvas container the device preview uses*, laid out between the docks by `currentInsets()` rather than a second canvas or a second renderer.

```
┌────────────┬────────────┬──────────────────────────┬──────────────┐
│ 🌐 ENVIRON │ 🌳 HIERARCHY│                          │ ✕ Exit Editor│
│    MENT    │            │                          │  view helper │
│  Camera    ├────────────┤      #device-frame       ├──────────────┤
│  Lighting  │ 📜 SCRIPTS │      (the viewport)      │ 🎛 INSPECTOR │
│  World     │            │                          ├──────────────┤
│            │            │   [gizmo toolbar]        │ 🕹 CONTROL   │
│            │            │   [mode toolbar]         │    DESK      │
└────────────┴────────────┴──────────────────────────┴──────────────┘
   #editor-env  #editor-left                            #editor-right
```

The Environment dock **collapses to a rail** (a 30 px accent strip with a vertical label) so three docks plus a usable 3D view still fit on a narrow window. Collapsing hands the reclaimed width straight back to the viewport, because `editorDockWidth()` measures the dock's real box and `currentInsets()` sums both left docks.

`ViewHelperWidget`, the Scripts block, and the Control Desk block are **physically re-parented** into the editor docks on entry and back into the Engine Room on exit (`moveEditorPanels()`). Moved, never duplicated — the existing logic holds direct element references, so relocating the nodes carries all of it along with no second implementation to keep in sync. A canvas keeps its WebGL context across a re-parent, which is why the view helper is reused rather than rebuilt.

One composition root and a set of single-purpose classes, rather than one large editor class:

| File | Owns |
| --- | --- |
| `EditorRoot.ts` | Composition + lifecycle only — constructs, wires, disposes. Owns the editor camera and `OrbitControls`. |
| `EditorSelection.ts` | The single source of truth for what is selected (scene object *and* script), with `subscribe()`. |
| `EditorViewport.ts` | Renderer drawing-buffer size + camera projection against the real container. |
| `EditorResizeManager.ts` | `ResizeObserver` on the viewport container, coalesced to one callback per frame. |
| `EditorObjectPicker.ts` | Click→selection raycasting, and Control Desk's "Pick" assignment mode. |
| `EditorDragSource.ts` | The object currently being dragged out of the Hierarchy, for drag-to-assign. |
| `EditorHierarchy.ts` | The `Object3D` tree panel — collapsible, reveals the selection on demand. |
| `EditorInspector.ts` | Identity, mesh stats, visibility, and transform for the selection; hosts provider sections. |
| `SectionRenderer.ts` | Turns `InspectorSection` descriptors into DOM and keeps their values fresh. Shared by the Inspector and the Environment dock. |
| `InspectorSections.ts` | The field-descriptor vocabulary — `text`/`number`/`toggle`/`vec3`/`info`/`buttons`/`objectRef`/`select`/`range`/`color`/`slider`, collapsible sections, per-module enable switches. A provider may return one section or many. |
| `objectAssignment.ts` | Declared-TS-type → live-object compatibility for Pick. |
| `EditorHistory.ts` | The one undo/redo stack, shared by every mode. |
| `ColliderVisuals.ts` | Collider wireframe/fill drawing. Owned by `Game` (it also serves the in-game overlay), borrowed by the editor. |
| `EditorColliders.ts` | "Configure Colliders" mode. |
| `ParticleVisuals.ts` | Emission-volume / direction / bounds gizmos. Owned by `Game`, borrowed, same as `ColliderVisuals`. |
| `EditorParticles.ts` | "Particle System" mode. Also drives the particle simulation for the whole editor session, in every mode. |
| `EditorEnvironment.ts` | The Environment dock — Camera, Lighting, World. |
| `core/SceneInspector.ts` | What genuinely belongs to the 3D scene: the transform gizmo, selection outline, debug helpers, and the toggles/shortcuts. |

**Everything is driven by one selection store.** `EditorSelection` is the reason the Hierarchy, the viewport, the Inspector, the gizmo, and Pick cannot disagree: none of them owns a private `selected` field, they all subscribe. Selection changes carry a `source` (`"hierarchy"` | `"viewport"` | `"script-panel"` | `"api"`) so a panel can tell *its own* click apart from someone else's — the Hierarchy scrolls a viewport pick into view but not its own row click.

**The editor camera is its own camera.** `EditorRoot` clones the gameplay camera when that is perspective, and builds a fresh `PerspectiveCamera` (copying `near`/`far` and the transform) when the game is set to orthographic — orbiting an orthographic view gives no depth cue at all, and the projection you author *for the game* is a property of the game, not of how you look at it. `EditorRootOptions.getGameplayCamera` is a **getter, not a value**, because the Environment dock can switch the rig's projection mid-session, which changes the camera's identity; `EditorRoot.update()` re-syncs `SceneInspector`'s `CameraHelper` whenever the environment's `version` changes.

### 10.3 Viewport sizing — why the scene is never stretched

The editor camera's projection is driven *only* by `EditorViewport`, from a `ResizeObserver` measurement of the real viewport container. The gameplay camera keeps the game's own aspect untouched (`Game.resizeTo` returns early while the editor is open), which is what keeps the game's logical/design resolution genuinely separate from the editor viewport's — and why the `CameraHelper` frustum keeps showing the shape the playable actually ships at rather than the shape of your panel layout.

Four rules keep it correct:

- **Only the container is measured.** Never `window.innerWidth`, never a size someone *intends* the box to become. A CSS transition, a dock collapse, and a device-frame mode switch all land identically, after the fact, at the box's real final size.
- **Projection follows the box; the world never scales.** Only `camera.aspect` (or an orthographic camera's frustum bounds, preserving vertical extent) is recomputed, then `updateProjectionMatrix()`. No object transform, no scene scale — an object at (3, 0, −2) stays there at any aspect; the view just shows more or less around it.
- **CSS owns the displayed size; the renderer owns only the drawing buffer.** `setSize(w, h, false)` — `#game` is CSS-sized `100%`/`100%` of its container, so the two cannot disagree even mid-resize.
- **`EditorViewport`'s constructor clears the canvas's inline `width`/`height`.** This is what makes the previous rule actually hold. `Game`'s own sizing path calls `setSize(w, h)` with three.js's default `updateStyle: true`, which writes inline px onto the canvas; an inline style beats the `#game { width: 100% }` rule, and `Game.resizeTo()` early-returns while the editor is open, so nothing ever updates them again. The canvas stayed frozen at whatever size the viewport was at editor entry — the drawing buffer tracked the container correctly while the displayed box did not, so every later viewport change rendered a correctly-sized image squashed into a stale box. Exiting restores the inline size on its own, via `Game.applyCurrentSize()`.

Two supporting details are load-bearing and easy to undo by accident:

- `.editor-dock` sets `box-sizing: border-box`, so its CSS-variable width *is* the space it occupies. Without it, padding and border put the viewport ~21 px underneath a dock.
- `editorDockWidth()` **measures the dock element** rather than parsing its CSS variable. A custom property's computed value is an unresolved token stream, so `parseFloat("clamp(150px, 20vw, 264px)")` is `NaN`, which silently became a zero inset and laid the viewport out full-width under the docks.
- Each dock's resting `transform` is declared **per id** (`#editor-env.visible`, `#editor-left.visible`, `#editor-right.visible`), not once on `.editor-dock.visible`. An id selector outranks a two-class one, so the shared `translateX(0)` never won and all three docks sat permanently 14 px off their edges — leaving a 14 px gap between each dock and the viewport, because `currentInsets()` reserves the docks' *widths* and knows nothing about a transform displacing them.

Verified in a real browser (Chrome via CDP) at 9:16, 4:5, 1:1, 4:3, 16:9, 21:9, a non-round 1237×603, and across dock collapse/expand and editor enter/exit — camera aspect, drawing-buffer size, and the canvas's CSS box all match the container at every one.

### 10.4 Hierarchy and Inspector

**Hierarchy: collapsible, and it can find things.** A GLB-heavy scene is easily hundreds of nodes, so only the true top level starts expanded — everything else is collapsed behind a ▸/▾ toggle. Open/closed state is a per-uuid `Map`, not reset by a rebuild, so collapsing a subtree survives an unrelated part of the scene changing underneath it. `computeSignature()` walks the *real* scene graph rather than the DOM, so it notices a change inside a currently-collapsed subtree without needing it rendered — which is also why lights added or removed by the Environment dock appear and disappear with no prompting.

Selecting something from *outside* this panel — a viewport click, Control Desk, a hot reload restoring the selection — opens every collapsed ancestor automatically; a click *inside* the panel does not, since the row you clicked is already open by definition. Press **`.`** (guarded against the Inspector's own number fields, which use `.` for decimals) to re-find whatever is selected: opens its ancestors, scrolls it to centre, and flashes it even if it never left view.

**Inspector.** Shows **Name** with a one-click copy button (`navigator.clipboard`, falling back to the hidden-`<textarea>` + `execCommand` trick for contexts without clipboard permission), a clickable **Parent** link that moves the selection up the tree, **Type**, and — for anything with `isMesh`/`geometry` — **Vertices**/**Triangles** read straight off the geometry's `position` attribute and index. Visibility is an **eye button**, not a checkbox, so it reads open/hidden at a glance. Then position / rotation (degrees) / scale.

Between the identity block and the transform fields sit any **provider sections** (see `InspectorSections.ts`). A provider hands back field descriptors, `SectionRenderer` renders them, and their `read()` callbacks feed the same per-frame refresh as the transform fields. A provider's `version` changing is the signal to rebuild — which is what makes switching a collider from box to sphere swap a Size row for a Radius row without rebuilding anything every frame.

**The build/refresh split is load-bearing.** Structure is created once per newly-selected object; *values* are written every frame. Rebuilding the DOM each frame would destroy and recreate the very `<input>` the user is typing into. `refresh()` additionally skips whichever control is focused, so a half-typed `1.2` is never clobbered back to `1` by the frame that lands mid-edit.

`SectionRenderer` was extracted out of `EditorInspector` so the Environment dock could render the same field vocabulary without a second implementation of it — the Environment dock is not attached to a selected object at all, but every row it needs already existed for the collider and particle panels.

### 10.5 Environment dock — Camera / Lighting / World

Three collapsible sections in the far-left dock, editing the live `SceneEnvironment` ([§3.2](#32-scene--the-scene-environment)) with every change visible in the viewport on the next frame. Unlike Configure Colliders and Particle System it is **not a mode** — it is simply present for the whole session.

**Camera section** — Projection (perspective/orthographic); FOV° and Ref. aspect, *or* Ortho size, depending on projection; Near; Far; Zoom slider; Follow target toggle; then either Offset / Look-at height / Damping (while following) or Position / Rotation° (while fixed); **⤓ Use editor view**, which copies the orbit camera's current world transform into the authored shot and switches to Fixed in the same undo step; and a live read-only **Live position** readout of where the gameplay camera actually is this frame.

**Lighting sections** — one **Ambient / Hemisphere** panel (mode, colour, ground colour in hemisphere mode, intensity) with an enable switch in its header, then one panel **per directional light** (name, colour, intensity, position, target, cast shadow, and — only when casting — map size, bias, normal bias, radius, frustum extent, shadow near/far) each with its own enable switch and a Delete button, then a **＋ Directional Light** action.

**World section** — Background mode / colour / texture path / blurriness / intensity; Environment source and intensity; Fog mode / colour / near+far or density; Tone mapping; Exposure; Shadows master toggle; Shadow type.

Two implementation properties worth knowing:

- **Rows rebuild only on *structural* change.** `structureKey()` hashes projection, follow state, ambient mode, background mode, environment source, fog mode, the shadows toggle, and the list of light ids with their cast-shadow/enabled flags — deliberately no values. An ordinary edit leaves the DOM alone and flows back through each row's own `read()`. This is the panel's equivalent of an `InspectorSectionProvider`'s `version`.
- **Undo snapshots the whole config.** Every edit captures `SceneEnvironment.snapshot()` before and after and restores by writing it back wholesale. A field-level command would be smaller but could not express adding or removing a light, and the config is a few hundred bytes. Slider drags coalesce through `mergeKey`, so one drag is one undo step.

Saved by the dock's own 💾 button (`POST /save-environment`) and again on Exit Editor as a catch-all.

### 10.6 Configure Colliders (🧊, or `K`)

The authoring mode for the ION Collider & Area system ([§4](#4--ion-collider--area-system--enginecollision)). Turning it on reveals a second toolbar row and draws every registered collider's volume; turning it off hides the drawing and changes nothing else — the registry and detection are runtime, this is only its editor.

- **`＋ Box` / `＋ Sphere` / `＋ Cylinder`** create a collider. With a scene object selected the new collider is **attached to it and fitted to its real geometry bounds**; with nothing selected it is a 1-unit volume at the orbit target. The fit is measured in the object's own *local* space, not from `Box3.setFromObject` — a world-space AABB produces a collider too big for any rotated object, and wrong again the moment it turns, whereas a local measurement wraps the geometry and then inherits the object's rotation through the attachment.
- **Nothing about a render mesh is ever modified.** Fitting reads geometry bounds and writes only the collider; the visuals are separate geometry parented under the collider's own node. Teardown removes all of it and leaves the scene byte-identical.
- **Normal colliders and triggers are visually distinct** — solid volumes green, triggers cyan, disabled grey, and any collider *currently overlapping something* red, so you can watch a trigger fire instead of reading a console. `👁 Volumes` hides the drawing without stopping detection.
- **Selecting a collider** — in the Hierarchy under the `COLLIDERS` group, or by clicking its volume in the viewport — shows a full panel: name, shape dimensions, `Is Trigger`, `Enabled`, `Tag`, `Mask`, the attachment (assignable by `⊙ Pick` *or* by dragging a Hierarchy row onto it), offset transform, a live overlapping/clear readout, and Fit / Duplicate / Delete. A viewport click lands on the translucent volume mesh, which is a child of the collider's node — `EditorObjectPicker`'s `resolveHit` hook maps it back, otherwise the gizmo would attach to the *drawing* and drag it away from the volume.
- **Colliders sync every editor frame via `previewOverlaps()`**, which detects overlaps but dispatches no events. It has to exist because gameplay is paused for the whole session: without it a gizmo drag would never fold back into the collider's offset (so the edit would not save) and the wireframes would never light up. Dispatching real events from here would be worse — a trigger firing while you arrange it is the game's logic running behind a paused game.

### 10.7 Particle System (✨, or `P`)

The authoring mode for the ION Particle & VFX system ([§5](#5--ion-particle--vfx-system--engineparticles)). Turning it on reveals every emission volume and hands the particle registry the *editor* camera for the session — otherwise every billboard would face wherever the gameplay camera happens to be pointing while you orbit around them.

- **The docks re-lay out.** The Hierarchy/Scripts dock becomes an **Inspector-only, full-height panel**, Control Desk is hidden entirely (it edits script fields, which has nothing to do with authoring a VFX), and the Hierarchy moves to the right dock so selecting an emitter out of the `PARTICLES` group still works. Panels are *moved*, never duplicated.
- **Sixteen collapsible modules** — Main, Emission, Shape, Velocity, Force, Limit Velocity, Noise, Color over Lifetime, Size over Lifetime, Rotation, Texture, Renderer, Trails, Collision, Sub Emitters, Quality/LOD — each with its own enable switch in its header, plus an emitter header block and a Diagnostics panel. Collapse state is remembered per section id across rebuilds.
- **Live preview.** Gameplay is paused for the whole session, so `EditorParticles` drives the preview off the editor's own wall clock, capped the same way the engine loop caps `dt`. ▶ ⏸ ↻ ⏹ ✕ control that preview, not gameplay.
- **Edits are live.** Almost every field mutates the config object the running simulation already holds, so the preview updates on the very next frame. Only genuinely structural changes go through a rebuild — `maxParticles` (the buffer is allocated once, by design), the trail pool, and simulation space (existing particles are expressed in the space being left and would teleport).
- **Presets** populate the toolbar dropdown from the engine's own table via `__getParticlePresets`, so the list cannot drift from what `createSystemFromPreset` accepts. Creating with a scene object selected attaches the new effect to it.
- **Gizmos** for emission volumes (amber, deliberately a different hue family from the collider layer's green/cyan), the direction axis, and live particle bounds, each toggleable without touching the effect.
- **Diagnostics are measured, not estimated** — active/max off the buffers, draw calls off the renderers, bytes off the real typed-array allocations, and update cost off a `performance.now()` pair around the actual simulation pass. A guessed cost readout is worse than none, because it gets trusted.

### 10.8 Control Desk

Not a single file — a mechanism spanning `scripts/dev-build-api.js` (`GET /list-logic-scripts` and `GET /script-info`, a brace-depth text scan of a class file for its public/private fields), `IonEngine`'s `window.__getInspectable(className)` hook (hands back the *real* running instance — no serialization, the dev panel and the game share one `window`), and the panel in `index.html` that combines them.

Pick a script; it lists that class's fields. Public `number`/`boolean` fields render as real inputs that write straight onto the live instance on edit; everything else renders read-only. **🐞 Debug** widens visibility to private/protected fields, always read-only.

**💾 Save writes the live values back into the TypeScript source** (`POST /save-inspectable-values`), so a value you tuned at runtime becomes the checked-in default rather than being lost on reload.

Fields whose declared type accepts a scene object or an ION collider additionally get a **⊙ Pick** button and act as drag-drop targets — see [§10.9](#109-object-picking-and-references).

**Making a class live-tunable takes no new code**, only two things:

1. Use plain public `number` / `boolean` fields rather than accessors — the field-scan regex only matches plain declarations, and a `get`/`set` pair silently never appears.
2. Register the instance in `Game.ts`'s `inspectables` map under its class name.

If the live value needs to *do* something, give the class an `update()` that reads its own fields and applies them. Control Desk edits by direct property assignment, so a field nothing reads back is inert data. `game/SoundHandler.ts`'s `volume`/`muted` are the worked example.

The reference game registers: `Game`, `World`, `Player`, `Environment`, `CoinField`, `AreaDemo`, `SoundHandler`.

### 10.9 Object picking and references

Control Desk and the collider panel both show a `⊙ Pick` button on any field whose declared type accepts a scene object (`THREE.Object3D`, `THREE.Mesh`, `THREE.Group`, lights, cameras, …) **or an ION collider** (`Collider`, `BoxCollider`, `SphereCollider`, `CylinderCollider`, which additionally enforce the shape). The rule lives in `objectAssignment.ts`, which is also what `window.__editorIsPickableField` answers from, so it is not re-derived in `index.html`.

Arm it, then click the object **either in the Hierarchy or directly in the 3D viewport** — both routes funnel through `EditorObjectPicker.offerObject()`, so they are genuinely interchangeable. The object is type-checked against the declaration; a mismatch reports why and leaves the pick armed for another try. What lands in the field is the *real live object*, never a copy or an id.

The same fields are **drop targets**: drag a row straight out of the Hierarchy onto one. `EditorDragSource` holds the dragged object beside the drag because `DataTransfer` is deliberately unreadable during `dragover` (the browser exposes only the payload's *types* until the actual `drop`) — without it a field could not tell you whether it accepts what you are holding until after you let go. The uuid still travels inside the `DataTransfer` under a private MIME type (`application/x-ion-scene-object`, so an unrelated text drag can never look like a scene object) and is what the drop resolves against. `dragend` clears the payload — it fires on success, refusal, and Escape alike.

**A collider field receives the `Collider`, not its node.** A collider is not an `Object3D`, so `EditorRoot.assignmentFor` returns a `value` (what the field gets) separately from the `object` (what was clicked) — one place decides it for both ⊙ Pick and drag-to-assign, so the two cannot drift into assigning different things.

**Type checks go through three.js's own `isMesh`/`isLight`/… flags rather than `instanceof`.** After an in-place hot reload the scene can legitimately hold objects built by a previous module instance, and `instanceof THREE.Mesh` would call those frauds.

Assignments are **batched into a single request on Exit Editor**, not made as you pick. `sceneBindings.json` sits inside `main.ts`'s module graph, so writing it trips Vite's watcher and hot-reloads the game — done per-pick, that tears down the very scene you are picking objects out of. The Exit button shows the pending count and flushes before closing; a queued edit survives a failed flush rather than being silently dropped.

### 10.10 Gizmos, helpers, and shortcuts

`SceneInspector` owns the transform gizmo (`TransformControls`), the yellow selection outline (`BoxHelper`), the gameplay camera's frustum (`CameraHelper`), per-light helpers, and the grid.

| Control | Key | Default | What it does |
| --- | --- | --- | --- |
| Select | Q | — | Click objects without transforming them |
| Move | W | ✓ | Translate gizmo |
| Rotate | E | — | Rotate gizmo |
| Scale | R | — | Scale gizmo |
| Grid | G | off | `THREE.GridHelper`, purely visual reference |
| Camera/light helpers | H | on | `CameraHelper` + per-light helper visibility |
| Snap | X | off | Fixed increments (0.25 units / 15° / 0.1 scale) |
| Space | C | world | `TransformControls`' local vs. world orientation |
| Frame selected | F | — | Recentres the orbit target on the selection and dollies to fit, keeping the current look direction |
| Configure Colliders | K | off | See [§10.6](#106-configure-colliders--or-k) |
| Particle System | P | off | See [§10.7](#107-particle-system--or-p) |
| Show Colliders | Shift+K | off | The in-game overlay, independent of the editor |

All the toggles are plain methods (`toggleGrid()`, `toggleHelpers()`, `toggleSnap()`, `toggleSpace()`, `frameSelected()`) plus `addStateChangeListener((state: InspectorToolState) => …)`, so a keyboard shortcut and a toolbar button drive one method and one listener keeps both in sync.

Two methods exist specifically for the Environment dock's live changes:

- **`setGameplayCamera(camera)`** rebuilds the `CameraHelper`, which binds to one camera at construction. Without it, switching the game to orthographic would leave the editor drawing the frustum of a camera the game stopped rendering through. A no-op when the identity has not changed, so `EditorRoot` can call it every frame.
- **`refreshLightHelpers()`** reconciles light helpers against whatever lights are in the scene right now, so a light added or deleted from the Environment dock gains or loses its helper immediately. Existing helpers are left alone — rebuilding them all would flicker every gizmo in the scene on a colour tweak.

The mode buttons live in a distinct `.si-gizmo-modes` DOM group in `index.html`: a shared `#si-gizmo-toolbar button` query used to wire both clusters would sweep up the toggles too and crash the gizmo, since they carry no `data-gizmo` attribute.

**`core/ViewHelperWidget.ts`** is the red/green/blue axis gizmo mirroring camera orientation. It owns its own tiny three.js renderer and WebGL context, which is why `Game.dispose()` must dispose it — browsers cap live WebGL contexts, and leaking one per hot reload eventually starts force-losing them.

### 10.11 Show Colliders — the in-game overlay

Draws every collider and trigger volume **over the running game**: no editor, gameplay proceeding normally, so a trigger can be watched turning red as the player walks into it. That is the difference from Configure Colliders, which is an authoring mode with gameplay paused.

Both drive the same `ColliderVisuals` layer — `Game` owns it and the editor borrows it for the duration of a session, so there is one layer with two independent things that can show it rather than two layers drawing the same volumes twice. `Game.render()` reconciles it once a frame, and it no-ops entirely while nothing is showing. DEV-only, built behind `import.meta.env.DEV`, so the module and its geometry/materials drop out of a production build while the collision system itself ships untouched.

### 10.12 Undo / redo / save

Owned by `EditorRoot` and shared by every mode.

**The scene never stops.** Opening or leaving the 3D editor does not stop, reset, destroy, or pause a running particle system. `EditorParticles.setActive` changes what is *drawn* and nothing else; playback only ever changes on an explicit Pause or Stop. Because gameplay itself is paused for the session, `EditorParticles.update` drives the simulation off the editor's own wall clock — in **every** mode, so effects keep running while you are moving a collider.

**Save is immediate for the three editor-owned files.** Colliders, particles, and the environment each have a 💾 with an unsaved dot and a brief green confirm. That is only safe because `vite.config.mts` stops watching `colliders.json`, `particles.json`, and `environment.json` — all three are real imports in `main.ts`'s module graph, so writing one would otherwise trip HMR and tear the scene (and the undo history) down mid-session. Ignoring them is correct because the editor already holds the live objects: the file is persistence, not the running session's source of truth. `sceneBindings.json` is pointedly still watched and still deferred to exit, because re-applying assignments only happens through `applySceneBindings` at boot.

**Each file marks itself saved, independently, and there is deliberately no call that marks them all.** There was one, and it silently destroyed work: clearing every dirty flag meant saving colliders disarmed the particle save, so `flushParticles` saw no pending changes and returned without writing. The symptom reads as the *loader* being broken rather than the writer — everything looks correct in-session, then a restart comes back to whatever the last successful save wrote. `markCollidersSaved`, `markParticlesSaved`, and `markEnvironmentSaved` each touch only their own flag, which makes the cross-clear unrepresentable rather than merely fixed.

**One undo stack across every mode** (`EditorHistory`), so switching between Configure Colliders, Particle System, and the Environment dock never discards it and a single Undo walks back through whatever actually happened, in order. `Ctrl+Z` undoes; `Ctrl+Y` or `Ctrl+Shift+Z` redoes. Both are guarded against text fields, where the browser's own undo should win. Bounded at 200 entries.

- **Commands, not snapshots.** Each entry carries its own `undo`/`redo` closures. A whole-scene snapshot is easier to write and wrong where it matters: restoring one destroys and rebuilds every object, so a script field holding a `Collider`, a sub-emitter resolving a sibling by name, and the current selection all end up pointing at things that no longer exist.
- **Deleted objects are kept alive, not recreated.** `ColliderManager.remove`, `ParticleManager.remove`, and `ParticleSystem.removeEmitter` all take a `keepAlive` flag; a delete command holds the real object in its closure, so undo puts *the same instance* back. `HistoryCommand.discard(state)` is the other half: when a command falls off the stack for good it is told which side it was on (`"applied"` vs `"unapplied"`) and releases whatever it was holding — without that distinction, discarding would free objects still in the scene.
- **Property edits mutate in place.** `applyColliderData` writes a record onto an existing collider rather than rebuilding it; the particle path hands a cloned config back through `applyConfig` on the same emitter; the environment path restores a whole config onto the same `SceneEnvironment`. Identity survives an undo in all three.
- **Continuous gestures are one step.** A gizmo drag has a real begin/end (`SceneInspector.onGizmoDrag`, off `TransformControls`' `dragging-changed`), so it captures on the leading edge and pushes exactly one command on release. Sliders and text fields have no such edge, so consecutive pushes sharing a `mergeKey` within 700 ms collapse. The particle Inspector has ~90 property rows, so its merge key is derived from the mutation closure's own source text rather than threaded through every call site by hand.
- **Dirty is a depth, not a boolean.** `isDirty` compares the stack depth against the depth at the last save, so undoing back past your edits correctly reports clean again.

Undo history is per-session: `EditorRoot.dispose()` clears it, which is also what releases anything a delete command was still holding. It deliberately does *not* survive a hot reload — a command closing over objects from a torn-down scene corrupts state rather than restoring it.

> **Known Limitation.** The per-file *dirty flags* are one-way booleans: undoing back past every environment/collider/particle edit correctly reports the history clean, but the file's own dirty flag stays set until a save. The worst case is a redundant write, not lost work.

### 10.13 Audio Reactor

Draws a live frequency-spectrum bar graph from whatever the game's `SoundHandler` is playing, via `__getAudioAnalyser` / `__isMusicPlaying`. The `THREE.AudioAnalyser` is lazily constructed and the panel's draw loop only runs while it is visibly open (`requestAnimationFrame`'d on toggle-open, `cancelAnimationFrame`'d on close), so nothing outside this panel ever pays for it. Independent of freecam — it opens and closes purely off its own button.

### 10.14 Hot reload

`main.ts` self-accepts its own Vite HMR updates, so a source or layout-JSON save re-executes just that module in place instead of Vite's default full-page reload. That specifically preserves the UI editor overlay's in-memory session — undo history, unsaved edits, Connect state — which a full reload used to wipe every time you pressed Save.

Each module execution is an isolated closure with no shared state, so the *new* one reaches back into the *old* one via `window`:

- **`window.__disposeGame`** — the previous instance's teardown, called before the new one takes over the same canvas. Without it every save leaked a WebGL context plus a full set of window-level input listeners.
- **`window.__gameInstanceGeneration`** — a counter the loop checks every frame, so a superseded execution's RAF chain quietly stops rescheduling itself instead of rendering alongside the new one into the same context.

The editor is re-entered from `IonEngine.installDevHooks` rather than `main.ts`'s hot-accept callback: that callback runs while `start()` is still awaiting `Game.create()`, when `__setFreecamActive` is still the *previous* instance's closure pointing at a just-disposed `Game` — so the new `Game` never entered the editor at all and gameplay quietly resumed under the editor chrome.

### 10.15 The Engine Guide

`public/guide.html` plus `guide-colliders.html`, `guide-particles.html`, `guide-ui-editor.html` and a shared `guide.css` — static in-app documentation opened from the Engine Room's **Engine Guide** button. Served by the dev server only; not part of the production build.

> **Known Limitation.** There is no `guide-environment.html`. The Environment dock is documented here and nowhere in the in-app guide set.

---

## 11 · Dev tooling reference

### 11.1 Dev hook surface

`IonEngine.installDevHooks(activeGame)` installs ~60 `window.__*` functions. Nothing in `src/index.template.html` or the shipped bundle ever calls any of them, so the whole surface is simply inert in production.

| Group | Hooks |
| --- | --- |
| Lifecycle | `__disposeGame` · `__gameInstanceGeneration` · `__onGameReady` |
| Pause / sizing | `__setUIEditorPaused` · `__resizeGameTo` · `__getEngineStats` |
| Freecam | `__setFreecamActive` · `__wasFreecamActive` |
| Gizmo + tools | `__setGizmoMode` · `__onGizmoModeChanged` · `__toggleGrid` · `__toggleHelpers` · `__toggleSnap` · `__toggleSpace` · `__frameSelected` · `__onInspectorStateChanged` |
| Control Desk | `__getInspectable` · `__editorIsPickableField` · `__editorRequestPick` · `__editorCancelPick` · `__editorDragAssign` · `__editorAssignmentFor` · `__editorDragMime` |
| Colliders | `__setColliderMode` · `__createCollider` · `__deleteSelectedCollider` · `__toggleColliderVisible` · `__getColliderStats` · `__serializeColliders` · `__hasColliderChanges` · `__markCollidersSaved` · `__onColliderDirty` · `__setColliderDebug` · `__toggleColliderDebug` |
| Particles | `__setParticleMode` · `__createParticleSystem` · `__addParticleEmitter` · `__deleteSelectedEmitter` · `__duplicateSelectedEmitter` · `__particlePlay` · `__particlePause` · `__particleStop` · `__particleRestart` · `__particleClear` · `__isParticlePreviewPlaying` · `__toggleParticleGizmo` · `__getParticlePresets` · `__setParticleQuality` · `__getParticleStats` · `__serializeParticles` · `__hasParticleChanges` · `__markParticlesSaved` · `__onParticleDirty` |
| Environment | `__serializeEnvironment` · `__hasEnvironmentChanges` · `__markEnvironmentSaved` · `__onEnvironmentDirty` |
| Undo / redo | `__editorUndo` · `__editorRedo` · `__getEditorHistory` · `__onEditorHistoryChanged` |
| Viewport | `__getEditorViewportInfo` |
| Audio | `__getAudioAnalyser` · `__isMusicPlaying` |

Hooks named `__on*` are the **reverse** direction: the engine calls them so the dev page can update itself without polling.

> **Known Limitation.** This contract is duplicated between `IonEngine.ts`'s `Window` interface declaration and untyped call sites in `index.html`, with no shared `.d.ts` and no boot-time assertion. See [§10.1](#101-the-engine-room-indexhtml).

### 11.2 The UI editor (`tools/ui-editor.html`)

`tools/ui-editor.html` (standalone) / `public/ui-editor.html` (synced copy, embedded as an overlay iframe in the dev preview) is a single-file vanilla-JS visual editor.

**Still deliberately one file.** It is served standalone over `file://` as well as from the dev server, and ES modules can't load over `file://` at all (the same CORS restriction that forces the production build to `format: "iife"`), so splitting it into modules would break opening it by double-click. `tests/geometry-parity.test.mjs` also text-scans this exact path for its fence. One file, sectioned internally.

Layout: **one** top toolbar carrying everything — insert, edit/clipboard/lock, group/arrange, and the view controls (zoom, rulers, snap, safe-area, animation playback, validation badge) — a tabbed left sidebar (**Layers** with filter, collapse and per-row lock/visibility; **Assets**, a `localStorage` image library shared across layouts; **Prefabs**, saved selections that stamp in as copies) above the read-only Scripts panel, the canvas, and a sectioned Properties panel on the right. The view controls briefly lived in a floating bar over the canvas; they were folded into the toolbar so there is one place to look for a control and no chrome floats over the artboard.

**Chrome geometry is measured, never assumed.** Every fixed panel, ruler and the canvas itself position from `--toolbar-h`, which a `ResizeObserver` on `#toolbar` writes at runtime (see `trackToolbarHeight`). It used to be a literal `53px` repeated across seven CSS rules — and the toolbar is `flex-wrap: wrap`, so on a narrow window (or simply after gaining buttons) it grows a second row and every one of those panels silently detached from it. `--sidebar-w` / `--props-w` / `--ruler-w` are constants in the same block so the arithmetic lives in one place.

**The canvas occupies the free region, not the whole window.** It was `0,0,100%,100%` with the toolbar, both side panels and the rulers all painted on top at higher z-index, so its top/left/right edges were permanently behind chrome — you could place an element there and simply never see it. `layoutCanvas()` now fits it between the chrome, measuring the real panels (`chromeInsets()`) rather than trusting the CSS variables, since some panels are hidden in embedded mode and only measurement can tell. The one case that must *not* be inset is a device frame driving the canvas: there it sits at exactly the simulator's letterboxed rect, because the entire point is lining up 1:1 with the real game showing through underneath.

Authoring specifics that aren't obvious from the UI:

- **Eight resize handles plus a rotate grip**, replacing the single bottom-right handle that always scaled about the element's center. Resizing now pins the opposite edge (Alt restores scale-from-center, Shift keeps the ratio). Dragging snaps to sibling edges/centers, container centers and dragged-out ruler guides, and the guide line is drawn at whichever line actually caught rather than always through the center.
- **Zoom/pan work in logical space.** `applyCanvasSize()` and `logicalRect()` divide the measured box by `zoom`, and every pointer delta is divided exactly once in `logicalDelta()`, so the fenced geometry formulas — which take plain numbers and have no idea a view transform exists — keep operating in the pixels the layout is actually authored in. Without that, a drag at 200% would move an element twice as far in the saved data as it did on screen. Embedded, any zoom other than 1:1 stops the canvas overlaying the running game, so the editor says so out loud rather than leaving you wondering why the game drifted.
- **Animations are held still until you press play** (`P`). Elements moving while you position them is the opposite of useful.
- **Live validation** (the ✅/⚠/⛔ badge) catches what otherwise only surfaces as a broken ad much later: duplicate names (which make an element permanently unreachable from `UILayout.get()` and every Scripts binding), missing image/video sources, zero-size or fully-transparent elements, `fontSizePct: 0`, sprite `frameCount` exceeding the grid, elements positioned entirely outside their container, and actions pointing at a target that no longer exists. Clicking a finding selects the element.
- **Autosave** mirrors the working layout to `localStorage` on a debounce and offers recovery on boot. It is explicitly *not* a substitute for Save — it never writes a project file and never changes what the running game loads; it exists so a dead tab doesn't cost a session's work.
- **View state is deliberately outside the undo snapshot.** Undo should walk back through what you built, never through where you happened to be looking.
- **Rulers draw in strip-local coordinates.** Ticks are absolutely positioned children of their own ruler strip, so `renderRulers()` converts the canvas origin into each strip's space exactly once. Emitting viewport coordinates (which it originally did) pushed every horizontal tick right by the sidebar's width and every vertical one down by the toolbar's, so the numbers lined up with nothing. The horizontal strip starts *after* `#ruler-corner` so the two strips tile the chrome and its left edge matches the canvas's — which is why the origin arithmetic now lands on a clean `0`. Minor ticks subdivide the labeled interval; guide positions and the live pointer are mirrored onto both strips, the latter by moving two nodes rather than rebuilding the strips, since it runs at pointer rate.
- **Save confirms on the button itself** — green, with a tick, naming what was written ("Main saved", "Saved as new", "Downloaded"). The only previous success signal was the small "Synced" label at the opposite end of the toolbar from where you clicked, which reads as ambient status rather than "your click worked". Failures keep their existing `alert()`; async writes mark the button busy so a slow save doesn't look like a dead click. The tick lives in its own node that gets rebuilt each time, so a repeat save to the same file re-pops instead of looking like a button that was already green.

It talks to `scripts/dev-build-api.js` (localhost:8001, dev-only, started by `npm run dev`) rather than the browser's File System Access API whenever that server is reachable — no folder-picker step, no permission dialog, no risk of writing to the wrong directory, works in any browser. Full endpoint table in [§11.3](#113-dev-server-api).

### 11.3 Dev-server API

`scripts/dev-build-api.js` — localhost:8001, dev-only, started by `npm run dev` alongside Vite (see `scripts/dev.js`). CORS is restricted to `http://localhost:8000` and `http://127.0.0.1:8000`; every file-writing endpoint resolves its path against a fixed category root and refuses anything that escapes it.

| Endpoint | Purpose |
| --- | --- |
| `GET /version` | Engine Room's version/commit readout |
| `POST /build` | Builder's **Build Now** — runs `build.sh` (body `{ halfFloat: boolean }`, forwarded via `env`, never as a shell string), returns the final `dist/index.html` byte size |
| `GET /estimate-size` | Builder's pre-build size bar — the last real `dist/index.html` on disk, flagged `stale` if `src/` / `assets/` / `tools/ui-editor.html` have anything newer (a *deletion* counts too, which is why a directory's own mtime is part of the check) |
| `GET /build-report` | The 📊 **Build Report** button — `dist/build-report.json` as-is, same stale/exists shape |
| `POST /save-layout` · `GET /load-layout` · `GET /list-layouts` | Layout JSON read/write — `src/game/ui/{mainLayout,endcardLayout}.json` and `src/game/ui/layouts/*.json` |
| `GET /list-scripts` | UI editor's Scripts panel file list — `*/ui/*.ts` only (the files that can have assignable UI fields) |
| `GET /list-logic-scripts` | Control Desk's file list — the inverse filter: `src/game/` files **outside** `ui/`, never `src/engine/` |
| `GET /script-info` | A script's classes + public/private fields (brace-depth text scan, not a real TS parse) |
| `POST /save-inspectable-values` | Control Desk's 💾 — writes tuned live values back into the `.ts` source |
| `GET /list-bindings` · `POST /save-binding` · `POST /remove-binding` | UI element ↔ script field assignments — `src/game/ui/bindings.json` |
| `GET /list-scene-bindings` · `POST /save-scene-bindings` | `⊙ Pick` scene-object/collider assignments — `src/game/sceneBindings.json`. Deliberately **batched** (a whole session in one request, flushed on Exit Editor) because this file is in `main.ts`'s module graph and each write hot-reloads the game |
| `GET /list-colliders` · `POST /save-colliders` | Configure Colliders — `src/game/colliders.json`. A **wholesale replace**, not a merge: the file is entirely the editor's to own, and merging would have to reconcile deletions and reorders for no benefit — a delete that silently did not stick is a far worse failure than a full overwrite |
| `GET /list-particles` · `POST /save-particles` | Particle System — `src/game/particles.json`. Same wholesale-replace contract. Only emitter *configuration* is written, never live particle state |
| `GET /list-environment` · `POST /save-environment` | Environment dock — `src/game/environment.json`. Same wholesale-replace contract; validated for the `camera`/`ambient`/`world` blocks, a `directionals` array, and an `id` on every light |

`GET /list-environment` returns `{ version: 1 }` when no file exists rather than an error — `loadSceneEnv` fills every missing field from its own defaults, so an empty object is a valid answer for a project that has never opened the dock.

### 11.4 Data files

Every one is a **real static import** in `Game.ts`, so all of it ships.

| File | Written by | Read by | Watched by Vite? |
| --- | --- | --- | --- |
| `ui/mainLayout.json` · `ui/endcardLayout.json` | UI editor | `new UILayout(...)` | yes |
| `ui/bindings.json` | UI editor Scripts panel | `applyBindings` | yes |
| `sceneBindings.json` | 3D editor ⊙ Pick / drag | `applySceneBindings` | **yes** — deliberately, because re-applying only happens at boot |
| `colliders.json` | Configure Colliders | `loadColliders` | no |
| `particles.json` | Particle System | `loadParticles` | no |
| `environment.json` | Environment dock | `loadSceneEnv` → `SceneEnvironment` | no |

> **Known Limitation.** `src/game/environment.json` is a new file and may still be untracked in git in a working copy that predates it. `Game.ts` imports it statically, so a clone without it **will not build**. Commit it.

---

## 12 · Build and production

### 12.1 The pipeline

`build.sh`, in order:

```
SECONDS=0
 1 ─ node scripts/compress-assets.mjs        assets/ → .build-cache/   (warns on failure, never fatal)
 2 ─ npx vite build --config vite.config.prod.mts
       src/main.ts + src/index.template.html → dist/index.template.html   (singlefile: JS inlined)
 3 ─ mv → dist/index.html
 4 ─ python3: strip type="module" + crossorigin, relocate <script> to just before </body>
 5 ─ python3: base64-inline every "./assets/…" path as a data: URI
               (prefers .build-cache/, falls back to the real assets/ file)
 6 ─ python3: gzip size + ad-network compatibility scan
 7 ─ python3: write dist/build-report.json
 8 ─ zip -j dist/index.zip dist/index.html      (best-effort, only if `zip` is on PATH)
 9 ─ node scripts/check-build-report.mjs        THE GATE — exits 2 if not submittable
```

Note the ordering: the gate is last, so every output above it exists on disk even when the build is rejected. See [§12.6](#126-the-submittability-gate).

Output: a single self-contained `dist/index.html`. No server, no `dist/assets/` folder, no relative paths — it works opened directly over `file://`.

### 12.2 Asset compression

`scripts/compress-assets.mjs` shrinks `assets/models/*.glb` and `assets/sounds/*.ogg` into `.build-cache/`. It **never touches `assets/` itself**, and the cache is wiped and rebuilt fresh every run so a renamed or removed asset's old compressed copy never lingers.

**Manifest-driven, not a directory walk.** It reads `src/game/assets.ts`'s own `"./assets/…"` string literals and compresses only what is actually referenced. This matters for a real reason found while building it: swap which file `libAudio.MainMusic` points at and the *old* file is still sitting on disk — a directory walk would keep compressing it and, worse, keep counting it in the Build Report as if it still shipped, when `dist/index.html` embeds none of it. Anything found on disk but unreferenced is reported once as `unusedAssets` instead.

Per GLB, via `@gltf-transform/*`:

```
dedup() · weld() · resample() · prune({ keepLeaves: true }) · sparse()
textureCompress()   → WebP, capped 2048 px
quantize()          → KHR_mesh_quantization alone            (HALF_FLOAT off)
meshopt()           → + EXT_meshopt_compression entropy coding (HALF_FLOAT on, the default)
```

`HALF_FLOAT` is the Builder panel's checkbox, forwarded through `POST /build`'s body into the environment. Quantize-only is natively supported by `GLTFLoader` with no extra runtime decoder; meshopt additionally needs `AssetLoader`'s unconditionally-wired `MeshoptDecoder`.

**Deliberately *not* used: `flatten` / `join` / `instance` / `simplify`.** Those restructure or merge the node graph, or decimate triangles, and this engine's `getObjectByName` lookups and `SceneBindings`' path resolution depend on every node keeping its exact name. `prune`'s `keepLeaves: true` exists for the same reason — its default silently deletes empty named nodes, verified against a real asset carrying ~60 unreferenced-but-clearly-intentional gameplay anchor points.

Audio goes through `ffmpeg` (`libvorbis`, falling back to the native `vorbis -strict -2` encoder some builds ship instead) at a real quality target — background music does not need the ~500 kbps some source exports arrive at.

Compression is a size optimization, not a build requirement: a failure here (missing devDependency, no `ffmpeg`) only warns, and step 5 falls back to the real `assets/` files.

### 12.3 Single-file output and ad-network compatibility

Two `vite.config.prod.mts` settings exist *specifically* for ad-network review, both worth understanding before touching either:

- **`rollupOptions.output.format: "iife"`** — Vite's default output is a real ES module. Ad-network review rejects that outright (Mintegral's Mindworks names it: *"Do not use crossorigin, type='module', import or export in local files"*) — some review WebViews do not support ES modules, and `file://` blocks module script loading via CORS regardless. IIFE fully inlines everything into one self-executing classic script with zero `import`/`export` left. Safe here because nothing in `src/` uses dynamic `import()`, so there is nothing to code-split.
- **`build.target: "es2015"`** — Vite's default target leaves recent syntax untouched: class `static {}` blocks (ES2022), optional catch binding `catch {}` (ES2019), and `?.` / `??` (ES2020) all appeared as-is in a build against the default, **including inside three.js's own source**. A review WebView without support for one of those throws `SyntaxError: Unexpected token '{'` and fails the whole review. `es2015` down-levels all of it across every module including `node_modules`.

**Step 4's post-processing is not optional.** Vite's HTML-entry build always tags the script `type="module" crossorigin` regardless of `output.format` — format controls the JS chunk's own syntax, not how an HTML-entry build tags the `<script>` that loads it. The python step strips both attributes *and* relocates the tag to just before `</body>`. The relocation matters: `vite-plugin-singlefile` hoists the inlined script into `<head>`, which only worked with `type="module"` because module scripts are implicitly deferred until the DOM finishes parsing. A classic script has no such deferral (`defer` is spec'd to do nothing for an *inline* script), so left in `<head>` it ran before `<body>`'s `#game` canvas existed — `getElementById("game")` returned `null` and `new THREE.WebGLRenderer({ canvas: null })` threw.

**Step 6's compatibility pre-flight** re-reads the final `dist/index.html` bytes and scans for the exact patterns known to fail review: `type="module"`, `crossorigin`, real `import`/`export`, `static{}`, `catch{}`, `?.`, `??`. Every one is *supposed* to be impossible given the two settings above, so this exists to catch a regression — a dependency upgrade, a loosened setting — the moment it is built rather than the next time a submission bounces. Any hit prints a `⚠` block to stdout and populates `compatibilityWarnings` in the report; a clean build prints `✓ No known ad-network compatibility issues found`.

**Step 7 is the gate.** `scripts/check-build-report.mjs` reads `dist/build-report.json` and fails the build on a non-empty `compatibilityWarnings` **or** an over-budget `distBytes`, printing both plus the size, gzip, duration, compression mode and unused-asset figures. `npm run build` therefore exits non-zero on either, everywhere — locally, in CI, and through the Builder panel.

It is deliberately the **last** step, after `dist/index.html`, `dist/build-report.json` and `dist/index.zip` have all been written. A failing build still leaves a complete, inspectable artifact on disk: you get the non-zero exit code *and* the output to look at, which is usually how you work out what caused the finding.

**Exit codes are load-bearing:**

| Code | Means |
| --- | --- |
| `0` | Clean, or downgraded to a report |
| `1` | Could not check — no report, or it is not valid JSON |
| `2` | Checked, and the build is **not submittable** |

`2` is distinct from `1` because they mean opposite things to a caller. `POST /build` branches on it: exit 2 means the build genuinely succeeded and the Builder panel should still paint the real size figures — just flagged — while any other non-zero exit is a build failure with nothing worth painting. See [§12.6](#126-the-submittability-gate).

**Escape hatch:** `ALLOW_COMPAT_WARNINGS=1 npm run build`, or `--allow-warnings` when invoking the checker directly. `npm run check:build` re-runs the check against the last build without rebuilding.

### 12.4 What actually ships

Confirmed by grepping a real production build (`npx vite build --config vite.config.prod.mts`):

| Grep | Count in `dist/index.html` |
| --- | --- |
| `EditorEnvironment`, `si-environment`, `ACES Filmic`, `Frustum extent` | 0 |
| `Configure Colliders` | 0 |
| `TransformControls`, `OrbitControls`, `BoxHelper`, `GridHelper`, `CameraHelper` | 0 |
| `PMREMGenerator` | 0 (minified) |
| `RoomEnvironment` | 1 — legitimate runtime, ~2 KB, reachable via `environmentSource: "room"` |

The whole editor tree, all thirteen particle presets' editor-facing labels, and every dev string drop out. `PARTICLE_PRESETS` is reached through `EditorRoot.getParticlePresets()` rather than imported directly by `Game.ts` for exactly this reason — an ungated import previously shipped all thirteen preset configs for a dropdown that only exists in the editor.

Reference build at the time of writing: **839 KB** raw, **236 KB** gzipped, against the Builder panel's 5 MB budget bar.

### 12.5 `dist/build-report.json`

A sibling dev artifact, never inlined into `dist/index.html`. Merges:

- step 1's per-asset before/after sizes and glTF-Transform `inspect()` detail (mesh/vertex/triangle counts, per-texture resolution + GPU memory estimate, animation clips)
- the *actual* final base64-inlined size of each asset
- total `dist/index.html` size, gzip size, build duration
- the `unusedAssets` list
- step 6's `compatibilityWarnings`

Served by `GET /build-report` to the Engine Room's 📊 **Build Report** button.

### 12.6 The submittability gate

Three consumers, one source of truth.

```
build.sh
  └─ step 7: node scripts/check-build-report.mjs
       reads dist/build-report.json
       exit 0 clean · 1 cannot check · 2 not submittable
            │
            ├─▶ CLI            `npm run build` exits non-zero. The artifact is still on disk.
            │
            ├─▶ CI             .github/workflows/ci.yml fails the build job. A second,
            │                  continue-on-error run of the same script writes the size
            │                  and compatibility table into the run's job summary.
            │
            └─▶ Builder panel  POST /build sees err.code === 2 and returns
                               { ok: true, submittable: false, findings, overBudget, sizeBytes }
                               with HTTP 200 — NOT a 500. The panel paints the real size,
                               turns the button amber ("Not submittable"), sets the freshness
                               pill to "Built — will fail review", names the findings, and
                               points at 📊 Build Report.
```

The panel distinction matters: a build that is merely un-submittable is not a build failure, and reporting it as one would throw away every number the Builder exists to show. The findings are re-read from `dist/build-report.json` rather than scraped out of stdout, so the panel's flag and the Build Report modal can never disagree about what was wrong.

> **Known Limitation.** The Builder panel's amber state is not covered by any test — `index.html` has no test harness at all (see [§10.1](#101-the-engine-room-indexhtml)). It was verified manually by running the real build against a deliberately-lowered budget and a deliberately-matching compatibility pattern, and confirming `POST /build` returned `ok: true, submittable: false` with populated `findings`/`overBudget` and a real `sizeBytes`.

### 12.7 Configuration reference

| File | Role |
| --- | --- |
| `vite.config.mts` | Dev server. Port 8000, `strictPort`, bound to `127.0.0.1` (Vite 5+ defaults to IPv6-only loopback, which breaks the CORS allowlist). `server.watch.ignored` excludes `colliders.json`, `particles.json`, `environment.json` — see [§10.12](#1012-undo--redo--save). Root and `publicDir` stay at their defaults. |
| `vite.config.prod.mts` | Production. `format: "iife"`, `target: "es2015"`, `vite-plugin-singlefile`, entry `src/index.template.html`. |
| `tsconfig.json` | `strict: true`, `target: ES2019`, `module: ESNext`, `moduleResolution: bundler`, `resolveJsonModule: true`, `noEmitOnError: true`, `types: ["vite/client"]`. `noUnusedLocals` is **off**. |
| `package.json` | See scripts below. |
| `.github/workflows/ci.yml` | CI. Two parallel jobs — tests and a production build — on push to `main`, on pull requests, and via `workflow_dispatch`. Node 22, npm cache, `npm ci`, per-job timeouts, concurrency cancellation. |

```
npm run dev            sync-assets → Vite (8000) + dev-build-api (8001)
npm run build          bash build.sh
npm run check:build    node scripts/check-build-report.mjs   (re-checks the last build, no rebuild)
ALLOW_COMPAT_WARNINGS=1 npm run build        build anyway, gate downgraded to a report
npm run typecheck      tsc --noEmit
npm test               typecheck + every suite below + the editor smoke pass
npm run test:particles      tests/particles.test.mjs tests/particle-shader.test.mjs
npm run test:geometry       tests/geometry-parity.test.mjs
npm run test:environment    tests/scene-environment.test.mjs
npm run test:ui             tests/ui-layout.test.mjs tests/ui-editor.test.mjs
                            tests/render-defaults-parity.test.mjs
npm run test:ui-editor-smoke  node scripts/test-ui-editor.js
```

Dependencies: `three` is the only runtime dependency. Dev dependencies are `@gltf-transform/*`, `meshoptimizer`, `sharp`, `esbuild`, `jsdom`, `typescript`, `vite`, `vite-plugin-singlefile`, `@types/three`.

---

## 13 · Testing and verification

```bash
npm test                      # typecheck + all seven suites + the editor smoke pass
npm run typecheck
npm run test:particles
npm run test:geometry
npm run test:environment
npm run test:ui
npm run test:ui-editor-smoke
```

At the time of writing: **178 assertions across seven suites, all passing**, plus a clean `tsc --noEmit`.

> **Known Limitation — nothing runs these automatically.** There is no `.github/` directory and no CI of any kind. This is the repository's weakest link, and not hypothetically: the geometry-parity suite — the mechanical enforcement the locked UI-scaling system depends on — sat **red** through several commits, because having a test and running it are different things. Two of the three UI bugs it was meant to catch reached `src/game/ui/mainLayout.json`. Until `npm test` runs on push, every guarantee in this document is only as good as someone remembering to type it.

Each suite covers something that cannot be caught by reading the code:

- **`tests/particles.test.mjs`** (46) drives the simulation directly over typed arrays — emission rates and bursts, lifetimes, buffer capacity and swap-remove, gravity, seeded determinism in both directions, shape sampling, collision, module gating, curves and gradients, lifecycle, `EditorHistory` semantics, and the detach/re-add identity contract. Its `regression:` cases each reproduce a bug that was genuinely in the code; every one was checked to *fail* against the original before being kept.
- **`tests/particle-shader.test.mjs`** (5) preprocesses the real `#ifdef` structure for all nine define combinations the renderer emits and asserts each compiles to something valid. A GLSL error only surfaces when a GL context links the program, which in practice means "the render mode nobody opened in a browser is silently broken" — exactly how mesh mode shipped dead.
- **`tests/scene-environment.test.mjs`** (26) covers the scene environment runtime: partial/junk config loading, light reconciliation (ambient↔hemisphere swap, enable/disable, add/remove directionals), light-target parenting, shadow-camera plumbing, fog mode switching, tone mapping reaching the renderer, the recompile-only-when-changed guard, background fallback, `restore()` round-tripping (including added and removed lights), snapshot detachment, the reference-aspect FOV correction (asserting the horizontal half-angle is genuinely preserved), the orthographic frustum, follow on/off, idle-camera sync, and `dispose()` leaking no lights. It also pins the shipped defaults against the pre-environment-system appearance.
- **`tests/geometry-parity.test.mjs`** is the locked UI-scaling system's mechanical enforcement. Both `UILayout.ts` and `tools/ui-editor.html` carry a `// ─── GEOMETRY:BEGIN/END ───` fence around their real formulas; the suite extracts both with plain text/brace-depth scanning, hashes a normalized version of each to catch *structural* drift, then calls both sides' real formulas across a dense viewport × design-resolution × element × parent-box matrix and asserts `Object.is` equality — exact, not epsilon, because rewriting `(a/100)*b` to `a*(b/100)` is mathematically identical but not bit-identical.
- **`tests/render-defaults-parity.test.mjs`** guards the *other* half of that contract: every `?? fallback` on a schema field. It fails if either render path defaults a field with `||` (which swallows an authored `0`/`""` — precisely how `fontSizePct: 0` came to preview at 4% and ship at 0 px) or if the two files disagree on a literal, and it asserts both sides still rank `z-index` through `buildStackRanks` rather than emitting an invalid fractional value. Its small exemption list is itself checked for staleness so it cannot rot into a hiding place for real divergence.
- **`tests/ui-layout.test.mjs`** exercises the real `UILayout` against a real (jsdom) DOM: every element type builds the nodes it claims to, documented defaults are the ones that actually apply, `updateScale` re-derives px geometry / font-size / scaled styles and ignores a zero-size container, and the interactive surface (values, states, actions, `dispose`) behaves as the editor promises.
- **`tests/ui-editor.test.mjs`** drives the editor page through its real controls rather than its internals — which are closure-private inside the page's IIFE anyway, and, more to the point, "the button does the thing" is what actually regresses. Covers inserting every type, the transform rig, sectioned and multi-select property editing, clipboard/undo, validation, view controls, and a 2024-vintage layout still loading unchanged. Its `beforeEach` asserts the page threw nothing during boot, which catches the temporal-dead-zone class of error a syntax check cannot.
- **`scripts/test-ui-editor.js`** is an older end-to-end smoke pass (insert → edit → drag → upload an image → Save) asserting the emitted JSON matches the schema `UILayout.ts` expects. It predates and overlaps the suites above, but it exercises the whole flow in one sequence rather than a feature at a time — which is what would catch two individually-correct steps that break when run back to back.

**Test harness notes.** The particle and environment suites bundle the DOM-free modules by name with esbuild rather than importing the package barrel — `particles/index.ts` reaches `MraidAdapter`, which reads `window` at module scope, and stubbing a browser to test arithmetic would hide a real dependency rather than expose it. The environment suite uses a plain-object renderer stub (`SceneEnvironment` only ever *sets* properties on it) and pins that the default config never constructs a `PMREMGenerator`, so the stub cannot silently stop being enough. Both UI suites stub `getBoundingClientRect` (jsdom has no layout engine); the editor one deliberately honours the canvas's own `scale()` transform, because the editor divides the measured box by `zoom` to recover logical pixels and a constant stub would make zooming *appear* to shrink the design resolution.

**What none of this covers: pixel appearance.** jsdom applies no styles and lays nothing out, so these verify structure, computed inline values, and behaviour — not that a gradient looks right or that a rotated element visually lands where you expect. Confirm those in a browser. Per the locked-system rules, verify any resize change at an aspect ratio far from the design's own by measuring real `getBoundingClientRect()` values, not by reasoning about the CSS.

**Browser verification has been done manually, via Chrome over CDP**, for the editor viewport sizing rules ([§10.3](#103-viewport-sizing--why-the-scene-is-never-stretched)) — but it is a manual procedure, not a checked-in test. See the gap list below.

---

## 14 · Known limitations and production readiness

Everything here is a real gap in the current code. Nothing in this document describes any of it as working.

### 14.1 Blocking for commercial production

| # | Gap | Detail |
| --- | --- | --- |
| 1 | ~~No CI~~ — **closed** | `.github/workflows/ci.yml` runs typecheck, all seven suites, and a real production build on every push and pull request. See [§13](#13--testing-and-verification). |
| 2 | ~~Compatibility scan is not a gate~~ — **closed** | `build.sh`'s final step is `scripts/check-build-report.mjs`, which exits 2 on a non-empty `compatibilityWarnings` or an over-budget artifact. `npm run build` fails everywhere — CLI, CI, and the Builder panel (which flags it amber rather than reporting a build failure). `ALLOW_COMPAT_WARNINGS=1` is the escape hatch. See [§12.6](#126-the-submittability-gate). |
| 3 | **CTA paths are untestable here** | The six network branches in `Cta.ts` only exist inside a real host page. Re-verify each against the target network's current documentation before every submission. |
| 4 | **`engine/` imports `game/`** | `IonEngine.ts:2`. See [§1.2](#12-the-enginegame-split). Blocks a clean engine extraction. |
| 5 | **The endcard is disabled in the reference game** | Both `showEndCard` call sites in `Game.update()` are commented out — the 15-second auto-end and the all-coins-collected win. One of them is additionally misspelled `showEndCad`. The endcard layout, `HUD.showEndCard`, and `MindworksAdapter.gameEnd()` all exist and work; nothing currently calls them. **A playable with no reachable end state will not pass review.** |
| 6 | **Mindworks lifecycle hooks are no-ops** | `exposeLifecycleHooks(() => {}, () => {})`. The review tool only checks they are callable, but a commercial playable should pause gameplay and audio on `gameClose`. |

### 14.2 Quality and coverage gaps

| # | Gap | Detail |
| --- | --- | --- |
| 7 | **No collision tests** | `ColliderManager.ts` (590 lines) and `intersect.ts` (468 lines) have zero coverage while being among the most-churned files here. The narrow-phase maths is pure and DOM-free — the same shape as the particle suite. |
| 8 | **No visual regression** | jsdom applies no styles, so nothing catches a wrong gradient, a rotated element landing a few pixels off, or text clipping at an extreme aspect ratio. That last one has shipped before. Needs Playwright, not jsdom. |
| 9 | **No boot-sequence test** | The suites cover pieces; ordering bugs (`bindIon` before `Game.create()`, dev hooks installed before `__onGameReady` fires) live in the sequence between them. |
| 10 | **`index.html` is untyped and untested** | ~2,100 lines of vanilla JS against ~60 silently-guarded `window.__*` hooks, with no shared `.d.ts` and no boot-time hook assertion. |
| 11 | **`public/ui-editor.html` is a committed build artifact** | Byte-identical duplicate of `tools/ui-editor.html`. Diff noise, and a drift risk if someone edits the wrong copy. |

### 14.3 Configured but not committed

| # | Gap | Detail |
| --- | --- | --- |
| 12 | **Shadows: on, but nothing casts** | `shadowsEnabled: true` with `shadowType: "pcfsoft"`, every environment mesh flagged, and both lights at `castShadow: false`. Full cost, zero shadows. See [§3.3](#33-rendering-setup). |
| 13 | **No IBL by default** | `environmentSource: "none"`, so every metallic material renders near-black. `"room"` costs ~2 KB and no asset. |
| 14 | **No tone mapping by default** | `toneMapping: "none"` — highlights clip flat. Deliberate (it preserves the pre-environment-system look), but a commercial build should choose. |
| 15 | **`referenceAspect: 0`** | Orientation-adaptive FOV is implemented and tested but disabled by default, so a shot framed in one orientation still crops in the other. |
| 16 | **`near: 0.01` / `far: 1000`** | A 100,000:1 depth ratio invites z-fighting. Both are now authorable. |

### 14.4 Not built

| # | Gap | Detail |
| --- | --- | --- |
| 17 | **Soft particles — Partial** | Shader path and `setDepthTexture` plumbing complete; no depth pre-pass produces the texture, so the flag compiles out. See [§5](#soft-particles--partial). |
| 18 | **No engine-level audio system — Planned** | No SFX pooling, no volume buses, no spatial helper. `game/SoundHandler.ts` is the whole story. |
| 19 | **No camera shake / FOV punch — Planned** | Listed because playable-ad game feel usually wants it and there is no seam on the rig for a transient offset. |
| 20 | **No `EventBus` worked example** | The bus is implemented and tested; the reference game still wires HUD↔gameplay with direct references. |
| 21 | **No localization, no analytics hooks, no orientation-change handling** | None of these exist in any form. `onCrash` is the only telemetry seam. |
| 22 | **No `guide-environment.html`** | The in-app guide set covers colliders, particles, and the UI editor, but not the Environment dock. |
| 23 | **`World.bound` is vestigial** | Defaults to `10` while the environment GLB is ~109×124 units. Its only remaining consumer is `CoinField`'s spawn extent — the `Player` clamp that used to read it is commented out — so six coins scatter in a 20-unit box in the middle of a cinema. |

---

## 15 · The game layer, and building a new playable

### 15.1 What the reference playable actually is

`src/game/` is a worked example, not part of the engine. It contains:

| File | Role |
| --- | --- |
| `Game.ts` | The composition root: renderer, scene, camera rig, environment, entities, colliders, particles, UI, plus a large dev-facade surface of passthroughs to `EditorRoot` |
| `assets.ts` | This game's manifest — `manifest`, `libGlb`, `libAudio` |
| `world/World.ts` | `bound` only, since lighting moved to `environment.json` |
| `entities/Player.ts` | Character: model, animation mixer, `moveAndSlide` movement, an `Animator`-driven reveal |
| `entities/Coin.ts` · `entities/CoinField.ts` | The `Entity` contract and a pool of them |
| `entities/Environment.ts` | A near-empty holder for scene-bound fields (`collider`, `ambientParticles`) |
| `AreaDemo.ts` | ~40 lines covering the whole collider/trigger runtime API — the reference for it |
| `SoundHandler.ts` | Music + the Audio Reactor's analyser + Control Desk-tunable `volume`/`muted` |
| `ui/HUD.ts` | The `applyBindings` reference — a UI class whose fields are assigned in the editor |

> **Known Limitation.** `Game.ts` is 930 lines, of which roughly 250 are dev-only passthrough methods to `EditorRoot` (collider, particle, environment, history, and gizmo facades). They are all behind `this.editor?.…` so they cost nothing in production, but they make the file harder to read as gameplay code. They are also now **optional** (see `GameDevFacade`, [§2.1](#21-ionenginets)) — this file keeps them because the reference playable wants every dev control working, not because the engine demands them. Moving them onto a separate object the dev hooks reach directly would delete all 250 lines from here; that refactor is known and unmade.

> **Known Limitation — unguarded GLB name lookups.** `Game.ts` does three unchecked `getObjectByName` casts (`walkablearea`, `cinemafloor`, `Colliders`) and immediately reads `.visible`. Rename any of those nodes in the GLB export and the constructor throws a `TypeError` — a dead playable with no message. They belong in `sceneBindings.json` or behind a guarded helper.

### 15.2 Building a new playable on this engine

**Start with the scaffolder.** `create-ion-project.mjs` is a single, dependency-free file: drop it in an empty folder, run it, and it lays down the engine, the Engine Room, the UI editor, the build pipeline, CI, and a runnable starter game.

```bash
mkdir my-playable && cd my-playable
curl -O https://raw.githubusercontent.com/DevangSharma28/Playable-Creator-Engine/main/create-ion-project.mjs
node create-ion-project.mjs
npm install
npm run dev                                    # http://localhost:8000
```

`--from /path/to/a/checkout` skips the network entirely. Other flags: `--name`, `--repo` (any GitHub slug or git URL), `--ref`, `--token` (or `GITHUB_TOKEN` / `GH_TOKEN` / an authenticated `gh`), `--interactive` (let git prompt for credentials).

It copies `src/engine/`, `src/main.ts`, `src/index.template.html`, `index.html`, `tools/ui-editor.html`, `scripts/`, `build.sh`, both vite configs, `tsconfig.json`, `.gitignore` and `.github/workflows/ci.yml` verbatim, then generates a fresh `src/game/` (a ground plane, a rotating cube, a `UILayout`, and the six authored JSON files), a `package.json`, and a README. It deliberately does **not** copy `src/game/`, `assets/`, `public/`, `tests/`, or this project's own docs — those belong to the reference playable, not to yours.

**Source resolution**, tried in order, so it works whether or not the repo is reachable anonymously:

| # | Route | When it applies |
| --- | --- | --- |
| 1 | `--from <path>` | A local checkout. Offline. |
| 2 | Authenticated tarball | `--token`, `GITHUB_TOKEN`/`GH_TOKEN`, or an authenticated `gh` CLI |
| 3 | Anonymous tarball | Public repos — the default path |
| 4 | `git clone --depth 1` | Private forks and self-hosted mirrors, reusing the machine's existing git credentials |

Two things it will never do: hang, or make a security decision for you. `GIT_TERMINAL_PROMPT=0` and `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` mean every route fails fast rather than sitting on a prompt — `stdio: "ignore"` is *not* sufficient for the latter, because ssh reads host-key and passphrase questions from `/dev/tty` rather than stdin. And it deliberately does not pass `StrictHostKeyChecking=no`/`accept-new`: trusting an unverified host key on first contact is a real decision, and a scaffolder is the wrong place to make it silently. `--interactive` opts into letting git ask for credentials (SSH stays non-interactive regardless).

> **Why a scaffolder rather than `npm install ion-engine`.** The engine is not a published package and cannot become one unchanged: `main.ts` imports it by relative path, the production build inlines its *source* into a single HTML file, and both the Engine Room (`index.html`) and the UI editor (`tools/ui-editor.html`) are project files rather than library exports. Copying the tree in is what works today — and it puts the engine in `src/engine/` where it can be read and modified, which is how playables actually get built.

Doing it by hand instead:

1. Replace everything under `src/game/` with your own entities, world, and UI. Keep `src/engine/` untouched — except that `IonEngine.ts` currently imports `Game` by path, so your replacement must still export a `Game` class with a static `create(canvas): Promise<Game>` and instance `update(dt, elapsed)` / `render()` / `dispose()`. Nothing beyond those four is required — see [§2.1](#21-ionenginets).
2. `src/main.ts` stays as-is. It does not know or care what game is running.
3. Write your asset manifest in `src/game/assets.ts` using `AssetEntry`. Everything preloads before gameplay; nothing loads lazily.
4. Design your HUD and endcard in `tools/ui-editor.html`, which has no game-specific knowledge either.
5. For a UI class that needs a designed element without a manual lookup, follow `HUD.ts`: declare a public field, assign it in the Scripts panel (drag or ⊙ Pick), and call `applyBindings(this, "YourClassName", bindingsData, ...layouts)` once in the constructor.
6. For a gameplay class that needs a scene object or a collider, register the instance in `Game.ts`'s `inspectables` map, declare a public field of the right type, assign it with ⊙ Pick, and let `applySceneBindings` populate it at boot. Read it in a `wire()` method called after that pass — never in the constructor.
7. Author lighting, camera framing, fog, and tone mapping in the Environment dock rather than in code. Set `referenceAspect` to your design aspect if the playable ships in both orientations.
8. Place trigger zones and solid geometry in Configure Colliders; author VFX in the Particle System mode. Both ship.
9. Point `STORE_URL` in `Game.ts` at the real listing, route **every** CTA through `Cta.open()`, and wire a real end state — see gap #5 in [§14.1](#141-blocking-for-commercial-production).
10. `npm run build`, then open the Build Report and confirm `compatibilityWarnings` is empty before submitting.
