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
16. [Commercial distribution](#16--commercial-distribution) — packages, the client boundary, the public API, browser support, editor persistence

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
  engine/        reusable — no game/ imports, verified
  game/          this specific playable ad — freely imports from engine/
```

The dependency direction goes one way only. `engine/` has no idea `HUD`, `Player`, or `CoinField` exist; `game/` builds on top of `engine/`'s generic pieces. Keeping this boundary intact is *the* thing that makes the engine reusable rather than reusable-in-theory, and it now holds with no exception.

`IonEngine.boot(canvas, { createGame })` takes a factory rather than importing a concrete `Game`, so nothing in `engine/` names the game layer — verified by grep across the whole directory, and enforced in practice by `@ion-engine/runtime`, which is built from `src/engine/` alone and would fail to bundle if the import came back.

That inversion is what made packaged distribution possible at all: while `IonEngine` imported `../game/Game`, a client's fresh project pulled ION's reference playable — and its assets — into their bundle. See [§16](#16--commercial-distribution).

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

**`elapsed` is game time in both timestep modes.** `tick(dt, elapsed)` receives seconds accumulated from frames that were actually simulated — zero at boot, frozen while the UI editor overlay or the 3D viewer is open, resumed exactly where it left off. That matches `Scheduler`/`Ion.time` and everything else in this engine.

> It did not always. Fixed-timestep mode advanced by whole steps (correct), while variable mode passed `performance.now() / 1000` — the wall clock since *page* load, which starts at whatever the page had already been open for and keeps counting behind a paused game. So the documented contract held in one mode and not the other, and anything driving animation off `elapsed` (`Coin.update`'s own `rotation.z = elapsed * 2` is the reference game's example) jumped forward by the entire length of an editor session the moment gameplay resumed. Covered by `tests/runtime-lifecycle.test.mjs`'s "frame timing" suite.

A crash — mid-frame or during boot — is reported to the analytics seam as `ion:crash` (with `phase: "frame" | "boot"`) alongside the `onCrash` option, so a host that installed a sink learns about the most expensive failure a playable can have without also wiring `onCrash`. See [`Telemetry.ts`](#telemetryts--the-analytics-seam) in [§9](#9--script-binding-and-ad-network-integration).

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
Ion.track(event, props?)                  // analytics seam — see Telemetry.ts in §9
Ion.colliders                             // ColliderManager
Ion.particles                             // ParticleManager
```

`cta` and `track` are the two entries that work **before** boot and after teardown: both are stateless (one inspects `window`, the other writes to a module-level buffer), so neither goes through the bound context.

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

- `every()` fires **at most once per frame, and never pays off a backlog.** A repeat that fell behind — a 5-second frame spike, a backgrounded tab, a long editor session — re-bases on the current clock instead of advancing one interval at a time. Advancing by one interval was the original behaviour, and it only moved the burst from "50 calls in one update" to "50 calls over 50 consecutive frames"; a 5s repeat that sat behind a 60s pause was twelve intervals in arrears and fired on twelve straight frames on resume. Covered by `tests/engine-core.test.mjs`.
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

**Worked example — the score.** `Game.tick()` publishes `Ion.emit<CoinCollected>("coin-collected", { collected, total })` from the pickup callback, and `HUD`'s constructor takes `Ion.on<CoinCollected>(...)` and updates itself. `HUD` holds no reference to `CoinField` and `CoinField` holds none to `HUD`: a VFX trigger, an achievement tracker or a sound cue can subscribe to the same event without the pickup call site changing at all. `Game.ts` also publishes `game-ended` (`{ won, seconds, collected }`).

Two details the example is there to show:

- **The payload type is named**, in `Game.ts`, and imported `import type` by the subscriber. An event has no compile-time partner the way a method call does, so writing the payload out once and using it at both ends is what keeps `emit` and `on` checked against the same shape.
- **`HUD` never unsubscribes, on purpose.** `IonEngine` clears the whole bus in its teardown, which is the mechanism that stops a hot-reloaded bundle's listeners firing into the new one. A subscription with the same lifetime as the `Game` needs nothing else; one that outlives its owner does.

### 2.6 `AssetLoader.ts`

A small caching loader for textures, GLB models, and audio, built on three.js's own loaders. `preload(manifest)` loads everything up front behind a single `await` — a playable ad cannot afford a stutter the first time an asset is needed mid-gameplay, so **nothing loads lazily**.

Owns the generic manifest types, which live here rather than in game code because they describe the loader's contract, not any game's content:

```ts
type AssetKind = "texture" | "glb" | "audio";
interface AssetEntry { kind: AssetKind; path: string; }
```

**One path, one load, regardless of call timing.** The resolved caches only de-duplicate *sequential* requests — the second call hits because the first already finished. Two overlapping calls both missed, and both started a real fetch: a manifest listing one texture twice (easy once several entity modules contribute entries), or a `loadGlb()` from an entity constructor for a model `preload()` is fetching at that moment, downloaded *and GPU-uploaded* the asset twice and left one copy unreachable for the life of the loader. In-flight promises are now tracked and shared, and dropped on settle rather than on success so a failed load stays retryable. Covered by `tests/engine-core.test.mjs`.

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

### 3.4 `core/ViewportWatcher.ts` — when to re-size

One place that answers "the viewport changed, re-size everything", because a playable ad does not run in a normal browser window and a bare `window.addEventListener("resize", …)` gets three real cases wrong:

| Case | What a plain `resize` listener does | Why it matters |
| --- | --- | --- |
| An ad-network WebView still mid-layout at boot — sometimes literally 0×0 | Never hears about it. MRAID hosts signal through their own `ready` / `sizeChange` / `viewableChange` events and are not required to dispatch a native `resize` once they settle. | A renderer sized once at construction stays wrong, and in the 0×0 case stays *invisible*, for the entire session. |
| Rotation | Fires **before** layout settles on iOS Safari, so the handler measures the pre-rotation size. | The playable renders letterboxed or cropped until something else happens to trigger another resize — often nothing does. |
| Soft keyboard, pinch-zoom, collapsing browser chrome | Nothing. These move `visualViewport` without resizing the window. | UI anchored to the bottom edge drifts off screen. |

```ts
const viewport = new ViewportWatcher(() => this.handleResize(), { settleDelaysMs?, measure? });
viewport.poll();          // re-measure now, fire if it moved
viewport.forceUpdate();   // fire regardless, re-base the comparison
viewport.dispose();
```

It listens to `resize`, `orientationchange`, `screen.orientation`'s own `change`, `visualViewport`'s `resize`, and — only when a host is actually present — MRAID's `ready`/`sizeChange`/`viewableChange`. After **every** signal it re-measures again at 120 ms and 400 ms, which is what catches the late, real dimensions a rotation reports.

Two properties make that safe to point at a handler which resizes a renderer, re-projects two cameras and re-lays-out two UI layouts:

- **It de-duplicates.** `onChange` fires only when the measured size actually differs from the last size reported, so six noisy sources and two settle timers collapse into one call per real change — and a settle pass that finds nothing new costs nothing.
- **Every target is optional.** `screen.orientation` and `visualViewport` are genuinely absent in older WebViews, so each is reached through a guarded helper rather than a hard reference. `MraidAdapter.onReady` is subscribed only when MRAID is present, because it invokes its callback synchronously when it is not — which would schedule a pair of settle timers on every boot for a size that has not changed.

Wired inside `IonGame` (the packaged runtime) and `src/game/Game.ts`, and exported publicly for a project driving its own renderer sizing. Covered by `tests/engine-core.test.mjs`.

> Worth noting what this closed in the *packaged* runtime specifically: `IonGame` had only the plain `window` resize listener. The MRAID handling described above existed solely in `src/game/Game.ts` — i.e. in the reference playable, not in the product every generated project actually builds on.

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

**Shared `@keyframes` are de-duplicated against the DOM, not a module flag.** `ensureKeyframes()` and `ensureSpriteKeyframes(cols, rows)` inject one `<style>` per page and check `document.getElementById` before doing so. A module-scope `let injected = false` is reset by the dev preview's in-place hot reload — which re-executes the module while the *page* survives — so every save appended another identical `<style>` block that nothing ever removed.

Two more implementation notes worth knowing before touching them. **Sprites animate in pure CSS** — an absolutely-positioned sheet inside an `overflow:hidden` window whose `left`/`top` step by whole window-widths via `steps()`, so there is no rAF ticker, nothing to tear down on a hot reload, and no per-frame JS cost; `left`/`top` are two separate properties, which is why the column and row animations compose instead of fighting the way two `transform` animations on one node would. **Declarative actions stay engine-generic**: `show`/`hide`/`toggleVisible`/`setText` are pure UI operations the runtime carries out with no game knowledge, while `cta` and `emit` route out through `onAction()` so `src/game/` decides what `"start-game"` means — the engine never learns any game's vocabulary.

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

Suspending **ends** an in-progress drag rather than forgetting it: every `onDragStart` gets its matching `onDragEnd`, with the last known pointer position. Dropping the gesture silently is the same stuck-flag failure the `blur` handler already exists to prevent for held keys — a camera or a dragged object stayed held for the whole editor session, because the `pointerup` that would have released it arrived while the manager was disabled and was ignored.

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

The reference game wires both for real: `gameStart` starts the music (the host's "you are on screen now" is the earliest legitimate moment, and `playMusic()` is a safe no-op if a user gesture has not unlocked audio yet), and `gameClose` sets a terminal flag that makes `Game.tick()` return immediately and stops the music. Deliberately *not* `dispose()` — the host may still call in afterwards, and tearing down the WebGL context under it would turn a clean stop into a crash.

### `Telemetry.ts` — the analytics seam

The one place a playable reports that something happened. Before it, `onCrash` was the only telemetry seam in the engine, and every network wants more than that — "did they interact", "did they reach the end state", "did they click" are the numbers a campaign is read on.

```ts
Ion.track(event, props?)                      // what a game calls
Telemetry.setSink((event, props, atMs) => …)  // what a host page installs
Telemetry.hasSink / Telemetry.bufferedCount   // diagnostics
Telemetry.reset()
```

Three properties, each answering a specific failure:

- **Events fired before a sink exists are buffered and replayed in order.** An ad network's SDK routinely attaches *after* the playable's own script has run — the same ordering problem `MraidAdapter.onReady` exists for. An unbuffered seam silently drops exactly the boot and first-interaction events, i.e. the ones worth the most. The buffer holds 64 and evicts oldest-first, because a dropped recent event is one the sink will almost certainly see a successor to.
- **A sink that throws cannot take the frame down.** A sink is host code this engine did not write, and an uncaught throw mid-frame would reach `IonEngine`'s crash guard and replace a working playable with the recovery overlay — an analytics bug costing the whole impression. Every call into a sink is wrapped; a throw is logged and otherwise ignored.
- **Stateless with respect to the engine's lifecycle**, like `Cta` — usable before `IonEngine.boot()` and after teardown, which is what makes `Ion.track` one of the two facade entries that work outside a bound context.

The engine emits two events for itself, both reserved under the `ion:` prefix:

| Event | Fired by | Payload |
| --- | --- | --- |
| `ion:cta` | `Cta.open()` | `{ network }` — the host that actually handled the click |
| `ion:crash` | `IonEngine` | `{ phase: "frame" \| "boot", message }` |

`ion:cta` is emitted from `Cta` rather than left to each CTA button precisely because that is the single place in the engine that knows a click happened *and* which network took it. Everything else is the playable's own vocabulary — this imposes no taxonomy, because every network's differs. The reference game adds `game-ended` (`{ won, seconds, collected, total }`).

Covered by `tests/engine-core.test.mjs`.

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
| `GET /version` | Engine Room's version/commit readout. Reports `version` (the installed `@ion-engine/runtime`, falling back to the repo's own `package.json` in this checkout), `projectVersion`, `root`, and the local git HEAD. All read **per request** — they were module-level constants resolved once at boot, which made the pill silently report whatever version the server started with after an engine upgrade or a `npm run packages` rebuild under a live server. `root` exists because an origin is not an identity; see [§11.5](#115-dev-server-ports-and-why-the-page-is-told-its-api-origin). |
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

### 11.5 Dev-server ports, and why the page is told its API origin

`npm run dev` (`scripts/dev.js`) reserves both ports before either child process binds, using the same `packages/project/lib/ports.mjs` the packaged `ion dev` uses — one implementation, not two. Vite gets `--port`; the API gets `ION_API_PORT` and an `ION_DEV_ORIGINS` CORS entry for the port Vite actually got. A moved port is printed (`ion  port 8000 was taken — using 8002`).

`vite.config.mts`'s `ionDevApiOriginPlugin` then injects `window.__ION_API_ORIGIN` into `index.html`, so the Engine Room is **told** where its API is rather than falling back to the hardcoded `http://127.0.0.1:8001` in its own script.

> This is worth the two moving parts because of what the old arrangement did when 8001 was taken. Vite bound 8000 and the API exited with its "port in use" message — and `dev.js` deliberately keeps Vite alive when the API dies, because the game still serves fine without the Build button, so that message just scrolled past. The Engine Room then fell back to 8001, which was **another project's API**. The version pill, the commit hash, the build report and every Save went to that project. Nothing errored, because from the page's point of view nothing had.
>
> The case that actually produced it was worse than a port clash between two live projects: the process on 8001 was an orphaned dev API whose project directory had been moved to the Trash hours earlier. A dev server outlives the folder it was started in. It answered `/version` exactly as confidently as a live one, and the only visible symptom was a version this checkout has never had (`v4.4.0`) beside a commit hash that is not an object in this repository (`9bf731b`).
>
> `GET /version` now also reports `root`, and the pill's tooltip shows it — so *which project answered* is a hover away rather than an investigation.

### 11.6 The Builder and the Build Report

Both live in the Engine Room (`index.html`) and read files `build.sh` already wrote — neither runs a build step of its own beyond the 🚀 Build Now button's `POST /build`.

**Builder panel** (`🛠 Builder`). Pre-build size estimate from `GET /estimate-size`, the Half Float compression toggle, Build Now, and Build Report. The freshness pill says whether the build is current; a line beneath it now says *when* it happened (`Last build: 5m ago · Sep 1, 12:06 PM`). `builtAtMs` had been in that endpoint's response all along and was simply not being shown, so "Up to date" read the same for a build from thirty seconds ago and one from last Tuesday that nothing had touched since.

**Build Report** (`📊 Build Report`). Summary cards, a size-composition bar, per-asset compression detail from glTF-Transform's `inspect()`, unused-asset detection, and data-driven optimization notes. Its top bar carries the build timestamp — `Built 5 minutes ago · Sep 1, 12:06 PM`, small and dim, because it is context for every number on the page rather than a headline. The relative half re-renders every 30s while the modal is open, and only while it is open.

Also: **⧉ Copy** puts a plain-text summary on the clipboard (size, gzip, duration, mesh mode, change vs previous, and any over-budget/compatibility/stale warning) for pasting into a PR or a chat; and **Esc** closes the report without closing the Builder underneath it.

`renderBuiltAt` falls back to the report file's own mtime when `builtAt` is absent, so a `dist/` produced by an older ION still shows a real time rather than a blank.

### 11.7 The favicon

`scripts/make-favicon.mjs` resizes `src/engine/icon/IONENGINE_ICON.png` to 64×64 and stamps it as an inline `data:` URI into every page that shows a browser tab — `index.html`, `tools/ui-editor.html`, and the four guides. Re-run it after changing the logo; it is idempotent (the tag sits between `<!-- ion:favicon -->` markers and is replaced, never appended).

Inlined rather than served as `/favicon.png` because these pages are served by three different things — Vite from the project root, Vite's `public/`, and the packaged Studio's own middleware, which serves a closed list of files off `@ion-engine/editor/studio`. A `<link href="/favicon.png">` would have to be taught to all three plus `build-packages.mjs`'s copy list, and a missing rule shows up as a silently absent icon rather than an error. At 64×64 it is ~3 KB per page.

**`src/index.template.html` is deliberately not in the list.** It becomes the shipped playable, which runs inside an ad network's WebView where there is no browser tab — the bytes could never be seen, and every byte counts against the budget the build gates on. Add it to `PAGES` in that script if you want branded demo links.

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

### 12.5.1 Build timestamps and the previous-build delta

`dist/build-report.json` carries two things beyond the raw numbers:

| Field | What it is |
| --- | --- |
| `builtAt` | When the **build** finished. Distinct from `generatedAt`, which is when the *assets were compressed* — an earlier moment, and absent entirely when the compression step was skipped or failed, which is exactly when a "last build" readout still has to work. |
| `previous` | `{ builtAt, distBytes, gzipBytes }` from the build before this one, or `null` on a first build. |

`previous` is what lets everything answer *"did my change make it bigger?"* — the one question a size budget actually gets asked. The Builder panel shows it as a chip on the Total Size and Gzipped cards, and `npm run build` prints it:

```
  dist/index.html   0.79 MB  (206 KB gzipped)
  change            +20 KB since last build
```

> **Why the previous report is stashed to a temp file.** It cannot simply be read at the point the new report is written, because by then two separate steps have destroyed it: `vite.config.prod.mts` sets `emptyOutDir: true`, so Vite wipes `dist/`; and `compress-assets.mjs` deletes `.build-cache/` before repopulating it, which rules out the one directory that otherwise outlives a build. So `build.sh` copies it to a `mktemp` file before either runs, and removes it on the way out.

> **Sub-kilobyte changes are reported in bytes.** `fmtBytes`' smallest unit is KB to one decimal, so a 7-byte change rendered as "↑ 0.0 KB" — a chip shouting that something grew, next to a number saying it did not.

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
npm test                # typecheck + every node:test suite + the editor smoke pass
npm run test:runtime    # engine lifecycle and the client-facing API
npm run test:serialization
npm run test:project    # generator, dev API, compatibility gate
npm run test:perf       # performance baselines (run with --expose-gc)
npm run test:e2e        # generate → npm install → build → run in Chrome
npm run test:visual     # ION Studio layout regression, real browser
npm run verify:bundle   # run a built dist/index.html in headless Chrome
```

**533 assertions across nineteen suites — 531 passing, 2 skipped, none failing**, plus a clean `tsc --noEmit`. `npm test` runs everything except the three that need a browser or several minutes; CI runs those too.

### 13.1 What runs where

| Suite | Assertions | What it covers |
| --- | --- | --- |
| `runtime-lifecycle` | 21 | Boot, frames reaching the renderer, `elapsed` being game time in both timestep modes, teardown releasing GPU resources, re-boot into the same canvas, crash handling, resize across extreme aspect ratios. |
| `simple-api` | 73 | `Game`, `Entity`, `Prop` and `ION` — scene building, the handle vocabulary (degrees, colour, `spin`, `destroy`, handle identity), camera follow and shake, input, audio, timers and tweens, events, colliders and zones, UI, and the errors each produces when used wrongly. |
| `serialization` | 32 | Round-trips for scene environment, colliders, particles, scene bindings, UI layouts and `ion.config.json`, plus partial and malformed input for each. |
| `editor-history` | 20 | Undo/redo: stack order, redo invalidation, gesture merging, dirty tracking, the 200-entry bound and its discard contract, re-entrancy, subscriptions. |
| `project-generator` | 25 | What `create-ion-project.mjs` writes, the client/engine boundary in the generated tree, template config, and `ion.config.json` validation. |
| `dev-api` | 16 | The endpoints every ION editor saves through: round-trips, validation, atomic writes, and path containment. |
| `compat-scan` | 29 | Each ad-network compatibility rule against the pattern it claims to catch, and the shipped bundle against all of them. |
| `collision-intersect` | 38 | `intersect.ts` directly: every shape pair's overlap answer, argument-order symmetry, scratch-pool reuse, point containment, and `penetration`'s minimum-translation and `up`-constrained behaviour. |
| `packaged-dev-facade` | 9 | `IonGame`'s dev-panel surface: registry-backed stats with no editor open, the orientation gizmo's ownership and its absence from a production build, and that callbacks registered at boot survive to a session opened later — and are replayed onto every subsequent one. |
| `engine-core` | 23 | `Scheduler` (game clock, repeat re-basing, nested scheduling, `clear`), `AssetLoader` (in-flight de-duplication, retryable failures, progress), `Telemetry` (buffering, bounds, a throwing sink), `ViewportWatcher` (de-duplication, deferred re-measure, disposal). |
| `particles` | 40 | The simulation over typed arrays — emission, lifetimes, buffer capacity, seeded determinism, shapes, collision, curves, module gating. |
| `particle-shader` | 6 | The real `#ifdef` structure for every define combination the renderer emits. |
| `scene-environment` | 26 | Config loading, light reconciliation, shadow plumbing, fog, tone mapping, `restore()`, the reference-aspect FOV correction, `dispose()`. |
| `geometry-parity` | 5 | The locked UI-scaling system's mechanical enforcement between `UILayout.ts` and `tools/ui-editor.html`. |
| `render-defaults-parity` | 5 | Every `?? fallback` on a schema field, and that neither side uses `||`. |
| `ui-layout` | 45 | The real `UILayout` against a real DOM: every element type, defaults, `updateScale`, the interactive surface. |
| `ui-editor` | 51 | The editor page through its real controls — insert, transform, multi-select, clipboard, undo, validation, and an old layout still loading. |
| `performance` | 15 | Baselines with thresholds — see §13.4. |
| `build-regression` | 14 | The whole client workflow end to end — see §13.3. Gated behind `ION_E2E=1`. |

`scripts/test-ui-editor.js` is an older end-to-end smoke pass (insert → edit → drag → upload → Save) that overlaps the suites above but exercises the whole flow in one sequence.

### 13.2 The test harness

**`tests/lib/runtime-bundle.mjs`** builds the real published entry (`packages/runtime/src/index.ts`) — what a client can actually import is part of what is under test, so a symbol that stops being exported breaks these suites. It defaults to the **production** build (`import.meta.env.DEV` false) so a test of shipped behaviour cannot accidentally be testing the dev one, and takes `{ dev: true }` for the cases that need the other branch. That matters more than it sounds: most of the `window.__*` panel hooks and the Engine Room's orientation gizmo exist only in the dev build, so asserting anything about them against the production bundle proves nothing — it reports `__getColliderStats is not a function` and looks like a failure of the thing under test. `bootGame({ dev: true })` threads it through.

**`tests/lib/dom-env.mjs`** is what lets the engine's *runtime* half be tested at all. `IonGame` constructs a `THREE.WebGLRenderer` in its constructor and reads `window.innerWidth` on the next line, so testing any of it means providing a browser-shaped environment rather than mocking the classes under test. It supplies:

- **jsdom** for the DOM, restored global-by-global afterwards so one suite cannot leak into the next.
- **A stub WebGL2 context** that answers three.js's capability queries and counts every `create*`/`delete*` call. That counting is the point: "did teardown actually give the driver its textures back" is a question `renderer.info` does not answer, and it is how the hot-reload leak in §13.5 was found and is now prevented from returning.
- **A stub 2D context**, for the procedurally generated particle sprite.
- **A stub WebAudio graph** that records `connect`/`disconnect`/`start`/`stop` instead of making sound — which is how "every one-shot leaked its nodes" became a test rather than a hunch.
- **A hand-driven clock** replacing `requestAnimationFrame` and `performance.now`. The frame loop reschedules itself from inside its own callback, so a real rAF makes every assertion a race; owning the queue and the clock turns "run one frame" into a function call and makes frame-exact assertions possible.

**`tests/lib/runtime-bundle.mjs`** bundles the *published* entry — `packages/runtime/src/index.ts`, not `src/engine/` — so a symbol that stops being exported breaks these tests. `three` stays external, so the bundle and the test share one module instance; two copies would reintroduce exactly the duplicate-facade bug described in §16.7.

**`tests/lib/boot.mjs`** boots through the real `IonEngine.boot()`, because `Ion`'s registries are bound by the engine and a game constructed without it fails in its own constructor. Booting the way a project does puts the frame loop, the crash guard and the generation guard under test rather than around them.

### 13.3 Build regression — the client workflow, end to end

`npm run test:e2e` starts from an empty directory and does what a client does:

1. `node create-ion-project.mjs` — generates a project.
2. `npm install` — resolves and installs the four `@ion-engine/*` packages. No postinstall step.
3. `tsc --noEmit` — the project typechecks against the installed engine.
4. `ion doctor` — reports a healthy project.
5. A deep import into engine internals is asserted to **fail resolution**, which is what makes the boundary in §16.3 real rather than advisory.
6. `npm run build` — a submittable single file, with no sidecar `assets/` directory.
7. The compatibility gate passes.
8. Assets in the manifest are **compressed and inlined**, checked against the log and the byte sizes.
9. The built playable **boots and draws in headless Chrome** with no page errors.
10. The shipped bytes contain **no editor module** and the page builds no editor DOM.
11. An over-budget build **fails** and still leaves the artifact on disk to inspect.
12. An engine file edited inside `node_modules/@ion-engine/*` is **reported by `ion doctor`**, naming the file.
13. Two builds of the same source are **byte-identical**.

### 13.4 Performance baselines

`npm run test:perf`. Thresholds are deliberately loose in absolute terms and tight in *relative* terms — the scaling ratios are what catch a structural regression, and they cannot fail merely because a CI runner is busy.

| Measurement | Typical | Budget |
| --- | --- | --- |
| Boot, empty game | 89 ms | 400 ms |
| Boot, 500 objects | 18 ms | 1500 ms |
| Boot cost, 500 vs 50 objects | 1.4× | 25× |
| Idle frame | 0.03 ms | 8 ms |
| Frame, 500 updating entities | 0.16 ms | 16 ms |
| Frame cost, 1000 vs 100 entities | 3.5× | 20× |
| Heap growth, 300 frames × 200 entities | −1.1 MB | 2 MB |
| Frame, 400 colliders | 0.55 ms | 16 ms |
| Frame cost, 400 vs 50 colliders | 2.1× | 30× |
| Build 200 UI elements | 70 ms | 800 ms |
| Rescale 200 UI elements | 3.3 ms | 20 ms |
| Teardown, 1000 objects | 3.3 ms | 500 ms |
| Heap growth, 12 boot/dispose cycles | 0.25 MB | 48 MB |

The collider ratio is the one worth understanding: 8× the colliders for 2.1× the cost is the broad phase working. An all-pairs regression would still be *correct*, would pass every behavioural test, and would show up here as roughly 64×.

### 13.5 Browser verification

Two scripts drive a real Chrome over the DevTools Protocol.

**`scripts/verify-bundle.mjs`** serves a built `dist/` over http — never `file://`, whose opaque origin changes WebGL and audio behaviour and which no ad network uses — loads it, and reports canvas size, WebGL availability, page errors, and whether any editor symbol survived into the shipped bytes. The production bundle is the one artifact no unit test can stand in for: it is minified, transpiled to ES2015, wrapped in an IIFE, and loaded as one file with no module resolution at all.

**`scripts/visual-regression.mjs`** checks ION Studio's own layout across eight viewports — phone in both orientations, tablet, laptop, wide desktop, and two absurd aspect ratios (2400×320, 320×2000). Deliberately **not** a pixel-diff suite: a screenshot baseline of a 3D editor changes whenever a light moves, which trains everyone to re-bless it. What it asserts instead are the things that are actually wrong when the editor "looks wrong":

- the page never scrolls horizontally,
- every open dock is fully on screen,
- the viewport canvas has a real size at every viewport,
- opening and closing a dock returns the canvas to **exactly** the size it started at,
- nothing throws.

Screenshots are still written to `.visual-regression/`, as evidence for a human rather than as the assertion. The build API it starts is pointed at a **throwaway copy** of `src/game/`, not the real one — that API is what every editor saves through, and a layout test has no business writing to anyone's `colliders.json`. It also uses OS-assigned ports, never the configured 8000/8001 — taking those would either fail outright or, worse, measure whatever project the developer already had running.

### 13.6 What none of this covers

**Pixel appearance.** jsdom applies no styles and the stub GL context draws nothing, so the suites verify structure, computed values and behaviour — not that a gradient looks right. `visual-regression.mjs` measures layout in a real browser but does not compare images.

**The CTA paths.** The six network branches in `Cta.ts` only exist inside a real host page.

**Real GPU behaviour.** Chrome runs under SwiftShader in these scripts, deliberately, so a result never depends on which driver the machine has. Driver-specific rendering bugs are out of scope.

---

## 14 · Known limitations and production readiness

Everything here is a real gap in the current code. Nothing in this document describes any of it as working.

### 14.1 Blocking for commercial production

| # | Gap | Detail |
| --- | --- | --- |
| 1 | ~~No CI~~ — **closed** | `.github/workflows/ci.yml` runs typecheck, every suite, the performance baselines, a real production build, and the full generate → install → build → run-in-Chrome workflow on every push and pull request. See [§13](#13--testing-and-verification). |
| 2 | ~~Compatibility scan is not a gate~~ — **closed** | `build.sh`'s final step is `scripts/check-build-report.mjs`, which exits 2 on a non-empty `compatibilityWarnings` or an over-budget artifact. `npm run build` fails everywhere — CLI, CI, and the Builder panel (which flags it amber rather than reporting a build failure). `ALLOW_COMPAT_WARNINGS=1` is the escape hatch. See [§12.6](#126-the-submittability-gate). |
| 3 | **CTA paths are untestable here** | The six network branches in `Cta.ts` only exist inside a real host page. Re-verify each against the target network's current documentation before every submission. |
| 4 | ~~`engine/` imports `game/`~~ — **closed** | `IonEngine` takes a `createGame` factory instead of importing a concrete `Game`. The engine no longer names the game layer at all, which is what made the packaged runtime in [§16](#16--commercial-distribution) possible. |
| 5 | ~~The endcard is disabled in the reference game~~ — **closed** | Both call sites in `Game.tick()` are live: the 15-second auto-end and the all-coins-collected win. (One had additionally been misspelled `showEndCad`, so re-enabling it alone would not have compiled.) `showEndCard` shows the endcard layout, calls `MindworksAdapter.gameEnd()`, publishes `game-ended` on the bus, and reports it to the analytics seam. |
| 6 | ~~Mindworks lifecycle hooks are no-ops~~ — **closed** | `gameStart` starts the music; `gameClose` sets a terminal flag that makes `Game.tick()` return immediately and stops the music. Deliberately not `dispose()` — see [§9](#mraidadapterts--mindworksadapterts). |
| 7 | **`@ion-engine/*` is not published** | The only real access control is a private registry plus a licence. The generator currently resolves the packages from a local checkout (`--ion-packages`, or auto-detected beside the script). Everything in [§16.3](#163-what-the-boundary-actually-is) is an architectural boundary, not a secrecy one. |

### 14.2 Quality and coverage gaps

| # | Gap | Detail |
| --- | --- | --- |
| 8 | ~~Narrow-phase collision maths is untested directly~~ — **closed** | `tests/collision-intersect.test.mjs` drives `intersect.ts` as the engine calls it: every shape pair, both argument orders, each case repeated after an unrelated call (the scratch-pool stomp guard the file's own header warns about), point containment, and `penetration`'s exact box↔box MTV plus its `up`-constrained behaviour. |
| 8 | ~~No visual regression~~ — **partially closed** | `scripts/visual-regression.mjs` checks ION Studio's layout across eight viewports in a real browser and asserts measurable invariants (no horizontal scroll, docks on screen, dock open/close reversibility). It does **not** compare images, so a wrong gradient or a few-pixel drift still goes unseen. See [§13.5](#135-browser-verification). |
| 9 | ~~No boot-sequence test~~ — **closed** | `tests/runtime-lifecycle.test.mjs` drives the real `IonEngine.boot()` and asserts the ordering directly, including that a re-boot retires the previous game rather than running both. |
| 10a | ~~`packages/` was never typechecked~~ — **closed** | `npm run typecheck` ran `tsc --noEmit` against `src` only — its `include` is `["src"]` — so the entire published product was outside it. The package build did catch type errors (that is how a missing import in `simple/node.ts` was found), but only when someone ran `npm run packages`. The script now also runs both package tsconfigs. |
| 10 | **`index.html` is untyped and untested** | ~2,100 lines of vanilla JS against ~60 silently-guarded `window.__*` hooks, with no shared `.d.ts` and no boot-time hook assertion. `scripts/visual-regression.mjs` now at least fails if it throws while laying out. |
| 11 | ~~`public/ui-editor.html` is a committed build artifact~~ — **closed** | Untracked and gitignored. `scripts/sync-assets.js` (npm's `predev`) still mirrors `tools/ui-editor.html` into `public/` so Vite serves it at `/ui-editor.html`; `tools/` is the single source. |

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
| 18 | **No engine-level audio system — Partial** | `ION.audio` covers one-shots, music, and a master volume, and every sound releases its WebAudio nodes when it ends or when the game is torn down. There is still no SFX pooling, no volume buses, and no spatial helper. |
| 18b | **`World.bound` in the packaged simple API** | The reference game's play area is now measured (see item 23), but the packaged `ION.scene` has no equivalent — a project using the simple API still has no "where may the player go" primitive. |
| 19 | ~~No camera shake~~ — **closed** | `ION.camera.shake(strength, seconds)`. Applied in `IonGame.onLateUpdate`, after the rig has placed the camera — an offset applied before the follow lerp is simply overwritten, which is why the first implementation of this did nothing whenever the camera was following something. FOV punch is still not built. |
| 20 | ~~No `EventBus` worked example~~ — **closed** | `Game.tick()` publishes `coin-collected`; `HUD` subscribes in its own constructor. Neither class holds a reference to the other. See [§2.5](#25-coreeventbusts). |
| 21 | **No localization — Partial** | Analytics and orientation handling are closed: `Ion.track` / `Telemetry` is the analytics seam (see [§9](#telemetryts--the-analytics-seam)) and `ViewportWatcher` handles rotation, MRAID sizing and `visualViewport` (see [§3.4](#34-coreviewportwatcherts--when-to-re-size)). **Localization does not exist in any form** — every string is authored into a layout JSON, with no locale dimension and no runtime switch. |
| 22 | **No `guide-environment.html`** | The in-app guide set covers colliders, particles, and the UI editor, but not the Environment dock. |
| 23 | ~~`World.bound` is vestigial~~ — **closed** | `World` now measures a real `THREE.Box3` from the environment GLB's own `walkablearea` node, and exposes `clamp` / `contains` / `randomPoint` against it. `CoinField` spawns inside the measured area and the `Player` clamp is live again. Still an **AABB over** the walkable polygons, not a point-in-polygon test — an L-shaped floor gets a rectangle drawn round it. See [§15.1](#151-what-the-reference-playable-actually-is). |

---

## 15 · The game layer, and building a new playable

### 15.1 What the reference playable actually is

`src/game/` is a worked example, not part of the engine. It contains:

| File | Role |
| --- | --- |
| `Game.ts` | The composition root: renderer, scene, camera rig, environment, entities, colliders, particles, UI, plus a large dev-facade surface of passthroughs to `EditorRoot` |
| `assets.ts` | This game's manifest — `manifest`, `libGlb`, `libAudio` |
| `world/World.ts` | The play area, measured from the environment GLB's `walkablearea` node — `bounds` / `center` / `halfExtent`, plus `clamp` / `contains` / `randomPoint`. Lighting moved to `environment.json`. |
| `entities/Player.ts` | Character: model, animation mixer, `moveAndSlide` movement, a `World.clamp` backstop, an `Animator`-driven reveal |
| `entities/Coin.ts` · `entities/CoinField.ts` | The `Entity` contract and a pool of them |
| `entities/Environment.ts` | A near-empty holder for scene-bound fields (`collider`, `ambientParticles`) |
| `AreaDemo.ts` | ~40 lines covering the whole collider/trigger runtime API — the reference for it |
| `SoundHandler.ts` | Music + the Audio Reactor's analyser + Control Desk-tunable `volume`/`muted` |
| `ui/HUD.ts` | The `applyBindings` reference — a UI class whose fields are assigned in the editor — and the `EventBus` reference: it subscribes to `coin-collected` rather than being handed the score |

> **Known Limitation.** `Game.ts` is 930 lines, of which roughly 250 are dev-only passthrough methods to `EditorRoot` (collider, particle, environment, history, and gizmo facades). They are all behind `this.editor?.…` so they cost nothing in production, but they make the file harder to read as gameplay code. They are also now **optional** (see `GameDevFacade`, [§2.1](#21-ionenginets)) — this file keeps them because the reference playable wants every dev control working, not because the engine demands them. Moving them onto a separate object the dev hooks reach directly would delete all 250 lines from here; that refactor is known and unmade.

**The play area is measured, not declared.** `World` takes the loaded environment model and builds a `THREE.Box3` from its `walkablearea` node — four flat polygons the artist authored to describe exactly where the player may walk. `CoinField` spawns inside that box (0.3 units in from the edge) and `Player` clamps to it (0.4 units in) as a backstop behind the authored solid colliders.

> This replaced a single scalar half-extent measured from the world origin, which assumed the play area was a square centred on (0, 0, 0). Cinema_World.glb's floor is neither — it spans roughly x ∈ [-5.2, 12.1], z ∈ [-12.8, 3.8] — so a ±10 box put most coin spawns over parts of the world with no floor under them, and `Player`'s clamp against the same number had been commented out precisely because clamping to the wrong box was worse than not clamping at all. Measuring is also what makes it survive dropping in a different environment GLB, which is the first thing anyone building on this does.
>
> **Still an AABB**, not a point-in-polygon test: an L-shaped floor gets a rectangle drawn round it, so a point `World.contains` accepts can sit in the missing corner. That is a per-game design decision, and the rectangle is already correct enough for the two things that read it.

> **Known Limitation — GLB name lookups.** `Game.ts` looks up three nodes by name (`walkablearea`, `cinemafloor`, `Colliders`) to hide them, and `World` looks up the first of those again to measure. Both are guarded and warn rather than throwing, so renaming a node in the GLB degrades (a visible helper mesh; a play area measured from the whole model instead of the floor) rather than producing a dead playable. They would still be better expressed in `sceneBindings.json`.

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

---

## 16 · Commercial distribution

Sections 1–15 describe the engine as it exists in **this** repository. This section describes how it reaches a client: as four npm packages, a project generator, and a boundary that is enforced by module resolution rather than by asking nicely.

### 16.1 The four packages

Built from `src/engine/` and `packages/*/src/` by `node scripts/build-packages.mjs` — never moved, always built, so this repository stays the single source.

| Package | Contents | Dependency kind |
| --- | --- | --- |
| `@ion-engine/runtime` | The engine a game runs on: `IonEngine`, `IonGame`, the simple `Game`/`Entity`/`ION` API, colliders, particles, UI, input, camera, environment, ad-network adapters. One prebuilt browser bundle whose only external is `three`. | `dependencies` |
| `@ion-engine/editor` | ION Studio: the 3D editor, Control Desk, Environment dock, Particle and Collider editors, the visual UI editor. | `devDependencies` |
| `@ion-engine/build` | The production pipeline: `build.sh`, asset compression, the compatibility scan, the submittability gate, the production Vite config, the dev API. | `devDependencies` |
| `@ion-engine/project` | The `ion` command: `dev`, `build`, `preview`, `sync`, `doctor`. | `devDependencies` |

The editor being a **devDependency** is not cosmetic. A production install (`npm ci --omit=dev`) does not have it at all, so the editor cannot reach a shipped build even by accident.

### 16.2 A generated project

```
my-game/
├── package.json           the whole project: scripts, dependencies, config
├── ion.config.json        name, target, orientation, resolution, build, pinned ION version
├── tsconfig.json          maps only "ion"; @ion-engine/* resolves through Node
├── src/
│   ├── main.ts            the entry. Generated once; you rarely touch it.
│   ├── index.template.html
│   └── game/              YOURS. This is where you work.
│       ├── Game.ts  Player.ts  assets.ts
│       ├── entities/ systems/ scenes/ scripts/
│       ├── colliders.json  particles.json  environment.json  scene.json  sceneBindings.json
│       └── ui/            mainLayout.json, endcardLayout.json, bindings.json
├── assets/                yours — models, sounds, images
└── node_modules/          OURS. Four npm packages. Nothing to copy, nothing to sync.
```

```bash
npm install     # once. Installs engine, editor and build tooling.
npm run dev     # ION Studio, on the first free port from 8000
```

That is the entire setup. No postinstall hook, no generated folder, no paths to
configure, and no command anyone has to know about.

**There used to be a fifth thing in that tree.** `ion sync` copied all four
`@ion-engine/*` packages out of `node_modules` into a root-level `IONEngine/`
folder on every install, and *that* folder — not `node_modules` — was what the
dev server and the build actually served. The intent was legibility: a project
that reads as engine-here / game-there at the top level.

It cost more than it bought. Two copies of the engine meant two ways for them
to disagree, and the important one was silent: an `npm update` whose
`postinstall` did not run left the served copy a version behind the installed
one, and every symptom pointed at the wrong place. Keeping the duplicate honest
required a `postinstall` hook, a `sync` command, a version-stamp file, drift
detection in `doctor`, and integrity verification of two locations — a whole
subsystem whose only job was maintaining a copy. And it duplicated ~2 MB of
engine into every project, which is what a package manager exists to avoid.

npm is now the single authority. One copy, in `node_modules`, resolved by
Node's own algorithm — which is also what makes `npm update` work with no
ION-specific step, and what makes pnpm, Yarn, workspaces and `file:` links work
without ION knowing about any of them. `ion sync` remains as a no-op that
explains itself, because projects generated before this still have it in their
`postinstall` and removing the command outright would break their `npm install`
with an error about a missing script.

Resolution goes through `require.resolve` of each package's own `package.json`
(see `packages/project/lib/resolve.mjs`) rather than joining
`node_modules/<name>` — that path is a guess that is right under npm's default
layout and wrong under every other one.

### 16.2.1 Running several projects at once

ION is a tool people keep several windows of open. Every generated project
ships the same `server.port`, because the generator cannot know what else is
running — so "the configured port is free" is the uncommon case.

Before this, the second project did not start. Vite exited with `Port 8000 is
already in use`, and the dev API — a separate process with no `error` handler
on its listener — died first with a raw unhandled `EADDRINUSE` stack trace that
never mentioned ION or suggested another project was the cause.

A configured port is now a **preference**. `ion dev` probes for the first free
port at or above it, then for a free API port derived from the one it actually
got, and prints both:

```
  ION Studio   http://localhost:8004
               port 8000 was in use — this project took 8004
  dev API      http://127.0.0.1:8005
```

Deriving the API port from the *real* server port rather than from the config
is what keeps each project's pair together and readable — `8000/8001`,
`8002/8003`, `8004/8005` — instead of handing the same API port to two
projects. Nothing is written back to `ion.config.json`: which project got which
port is a fact about this machine right now, not about the project, and
rewriting a tracked file on every `npm run dev` would put port churn in the
customer's git history. Pin one with `npm run dev -- --port 9000`.

**Isolation is structural, not managed.** Each project has its own
`node_modules`, its own Vite cache (`node_modules/.vite`), its own
`src/game/*.json` editor state, its own `public/assets` mirror, its own `dist/`,
its own dev-server and HMR socket, and its own dev API process pointed at its
own root by `ION_PROJECT_ROOT`. The Studio page is served per-project with its
own API origin injected, so a browser tab can only ever talk to the server that
served it. Nothing is shared and nothing needs coordinating.

### 16.2.2 The packaged dev facade — two rules

`IonGame` implements the whole `GameDevFacade` on a project's behalf, so a generated project's `Game.ts` contains gameplay and nothing else. Everything in that surface is a forward to the open editor session — **except** for two categories that must not be, and getting either wrong fails silently in a way that reads as a bug somewhere else entirely.

**1. Anything backed by a runtime registry answers from the registry.**

`Ion.colliders` and `Ion.particles` are owned by `IonEngine` and always exist. `getColliderStats()`, `getParticleStats()` and `setParticleQuality()` therefore need no editor.

> They used to forward to `this.editorSession?.…`, so with the editor closed — which is most of the time — the Engine Room's collider readout showed `0 total / 0 enabled / 0 narrow tests` no matter how many colliders were registered and overlapping. That reads as *the collision system is broken*, when collision was the one part working correctly: detection ran, and trigger enter/exit fired exactly once per crossing. Only the readout lied. Verified by driving a generated project in Chrome: `ENTER`/`EXIT` fired while the panel reported zeros.

**2. Callbacks are held by the game, not by the session.**

`IonEngine.installDevHooks` registers the panel's callbacks **once**, immediately after `Game.create()` resolves — long before anyone opens the 3D editor. A forward to `this.editorSession?.onX(cb)` therefore lands on `undefined` and the callback is gone for the life of the process.

| Callback | Delivered how | What its loss looked like |
| --- | --- | --- |
| `onColliderDirty`, `onParticleDirty`, `onEnvironmentDirty`, `onSceneDirty` | Held on `IonGame`, handed to `host.open()` through `EditorOpenOptions` — `EditorRoot` takes them as **constructor** options, so this is the only moment it can accept one | The Exit button never learned the session had unsaved work. Edits were discarded on exit with no warning — and since a Hierarchy re-parent is flagged through `onSceneDirty` like any other scene-graph change, that is exactly what "parenting doesn't stick" was |
| `onGizmoModeChange`, `onInspectorStateChange`, `onEditorHistoryChange` | Held on `IonGame`, re-applied to **every** session in `setFreecam(true)` | Toolbar highlights never followed the keyboard shortcuts (W/E/R/Q, F/G/H/X/C) that change the same state. Applying them only once would still break from the second editor entry onward, since a session is destroyed on Exit and rebuilt on re-entry |

The reference `src/game/Game.ts` has always done both correctly, which is why the engine's own Engine Room worked while a generated project's did not — the two paths had quietly diverged. `tests/packaged-dev-facade.test.mjs` now pins the packaged path to the reference one's behaviour.

**The orientation gizmo belongs to the game, not to a session.** `ViewHelperWidget` was constructed inside the editor session, so on the packaged path it drew only while the 3D editor was open and sat frozen the rest of the time. `IonGame` owns it now and updates it at the end of every `render()` against whichever camera actually drew. Constructed only behind `import.meta.env.DEV` and only when `#er-viewhelper` is in the page, so a production build drops the class — `scripts/verify-bundle.mjs` asserts `ViewHelper` is absent from `dist/index.html`, checked against a generated project's own build as well as this repo's.

### 16.3 What the boundary actually is

**It is not secrecy.** The engine ships as readable JavaScript in `node_modules`. Anyone who wants to read it can. Claiming otherwise would be false, and building on that claim would be worse.

What the boundary *does* guarantee, mechanically:

1. **Deep imports do not resolve.** Each package's `exports` map publishes exactly one path. `import … from "@ion-engine/runtime/src/engine/editor/EditorRoot"` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` — in Node, in Vite, and as `TS2307` in TypeScript. Not a lint rule; a resolution error. `tests/build-regression.test.mjs` asserts it on a real generated project.
2. **Engine edits cannot be committed.** The engine lives only in `node_modules/`, which is git-ignored, so `git status` stays clean, `git add` refuses, and nothing reaches a remote. Every commit in a client's repository is their game.
3. **Engine edits are noticed.** Each package ships a sha256 manifest (`ion-integrity.json`). `ion doctor` verifies the installed packages and names the changed files. There is one copy to verify now; when there were two, verifying only one was a real hole.
4. **The installed version is the version.** `ion doctor` compares what npm resolved against `ion.config.json`'s `ionVersion` and says so when they differ. There is no second copy that can lag behind.

Point 3 is a **correctness** check, not a security control: anyone who can edit the engine can equally edit the manifest, and nothing here tries to stop them. It exists to catch the failure that actually happens — someone debugs by editing engine source, it works, and the fix evaporates on the next `npm ci` with nothing in `git status` to explain why the bug came back.

**Real access control is a private registry plus a licence.** See gap #7 in [§14.1](#141-blocking-for-commercial-production).

### 16.4 What a client may and may not change

| | |
| --- | --- |
| **Yours to change** | `src/game/` in full, `assets/`, `ion.config.json`, `package.json`, `tsconfig.json`, `src/index.template.html`, and `src/main.ts` if you need a different boot. |
| **Not yours** | `node_modules/@ion-engine/*`. Replaced on every install; edits cannot be committed and are reported by `ion doctor`. |
| **Generated, do not hand-edit** | `src/game/colliders.json`, `particles.json`, `environment.json`, `sceneBindings.json`, `ui/*.json`. These are written by the ION editors. They are readable and diffable on purpose, and they load defensively — a partial or malformed one is reported and skipped rather than taking the boot down — but the editors own them. |

### 16.4.1 Three.js is an implementation detail

The rule the API is built to: **a game is written in game vocabulary, and never has to learn three.js to do an ordinary thing.** Three.js is how ION draws, not what a project programs against.

That held right up to the point where the API handed something back. `ION.scene.box()` returned a `THREE.Mesh`, so the second you used what you were given you were in three.js — and the shipped starter template demonstrated it in the first file anyone opens:

```ts
const coin = ION.scene.find(`Coin${i}`);
if (coin) coin.rotation.y += dt * 2;   // radians, per-frame lookup, and no way to free it
```

Every `ION.scene.*` call now returns a **`Prop`**: a handle in the same vocabulary `Entity` already spoke. The same line is now written once, at creation, and never ticked:

```ts
ION.scene.box({ color: "yellow", size: 0.6, name: `Coin${i}` }).spin(120);  // degrees per second
```

| Was, in three.js | Is, on the handle |
| --- | --- |
| `mesh.rotation.y += dt * 2` — radians | `prop.rotateBy(0, 120 * dt, 0)` or `prop.spin(120)` — degrees |
| `mesh.material.color.set(0xff0000)` | `prop.color = "red"` |
| `mesh.material.opacity = 0.5` (renders opaque unless you also set `transparent`) | `prop.opacity = 0.5` |
| `mesh.removeFromParent()` — **leaks the geometry and material** | `prop.destroy()` — unparents *and* frees what ION built |
| `mesh.scale.setScalar(2)` | `prop.size = 2` |

**Rigged models are first class.** `ION.scene.model()` carries the GLB's clips onto the handle, so `hero.play("Run")` works on the thing you were just handed — no `THREE.AnimationMixer`, no `Map` of actions, no per-frame tick to remember, no hand-written crossfade. `animations` lists the names, `play(name, { fade, loop, speed })` blends, `stopAnimation()` returns to the bind pose, and re-playing the clip already running is a **no-op** rather than a restart (calling `play("Run")` from `update()` while a key is held is the obvious way to write movement; restarting each frame would pin it to frame zero). A mixer is built on the first `play()` and registered with the game's frame loop, so a scene full of boxes registers nothing; `destroy()` retires it.

> **The bug this exposed.** `AssetLoader.instantiateGlb` used `Object3D.clone(true)`, which copies a `SkinnedMesh` but leaves its `skeleton` bound to the **original's** bones — verified directly, not assumed: `clone.getObjectByName("Body").skeleton.bones[0]` came back as the *source* bone. Every instance of a character therefore shared one skeleton, so they all played whichever clip started last, in lockstep, and posing one posed the rest. It now clones with `SkeletonUtils.clone`, applied unconditionally — it handles an unrigged tree identically, and a conditional would mean the rigged path only runs in projects that have a rigged model, i.e. the path least likely to be exercised before it ships.

**Vectors are real.** `position`, `scale` and `quaternion` hand back live `Vec3`/`Quat` values with the full maths on them (`add`, `normalize`, `lerp`, `distanceTo`, `cross`, …), and `ION.vec3()` / `ION.quat()` construct them. Both are **type aliases** for three's own classes rather than wrapper classes: a wrapper would mean reimplementing forty methods of well-tested vector maths and allocating a conversion on every crossing into and out of the engine, sixty times a second. A game still never writes `THREE` — it writes `Vec3` and `ION.vec3()`, which is the boundary that matters.

**Reaching inside a model.** `part(name)` returns a named GLB node as its own `Prop` (`hero.part("Sword")?.hide()`), and `castShadow`/`receiveShadow` traverse to every mesh underneath — a per-mesh flag in three.js, where setting it on the group does nothing at all, silently.

**`SceneNode` is the shared half**, and the reason there is one vocabulary rather than two: `Entity` (has an `update()`, you subclass it) and `Prop` (has no behaviour, `ION.scene.*` returns it) both extend it, so `moveBy`, `rotation`, `lookAt`, `distanceTo`, `spin` and `destroy` mean the same thing and take the same units on either. Anything that accepts "something in the world" — `ION.camera.follow`, `ION.colliders.attach`, `ION.particles.play`, `ION.scene.add` — takes a `SceneNode`. Moving a prop to an entity is a change of declaration, not a rewrite. Collapsing the duplicated half also took `Entity` from 225 lines to 99.

**`find()` returns the same handle every time** for the same object, kept in a `WeakMap` keyed by the `Object3D`. Otherwise `find("Coin") === find("Coin")` is false and a `spin()` started through one handle is invisible through the next. A `WeakMap` because the scene owns the objects: when one goes, its handle goes with it and there is no table to sweep.

**`spin()` runs on game time**, like every other ION timer — it freezes while an editor is open instead of turning behind it — and it is applied as a per-frame *delta*, so it composes with whatever else rotates the object rather than stamping over it, and the wrap at the end of each cycle is seamless rather than a snap.

**The escape hatch is still there.** `prop.object3D` / `entity.object3D` is the real three.js object, for the cases the handle does not cover. It is a hatch, not the main road — and the test suite uses it deliberately, so it cannot quietly stop working.

> **A fix that fell out of this.** Both handles free GPU resources through one `releaseSceneResources()`, and writing it once exposed that the old version handed each `ION_OWNED` node to `disposeObject3D`, which walks the **whole subtree**. So anything parented under an ION-built shape was freed along with it, marker or not — attach a model from the asset manifest to a box, destroy the box, and every other clone of that GLB in the scene went blank, because they all share one geometry. The marker claims one node's own resources, not its descendants'; it now disposes accordingly.

### 16.5 The public API

```ts
import { Game, Entity, ION } from "ion";
```

`Prop` and `SceneNode` are exported alongside them for annotating your own helpers (`function collect(thing: Prop)`); you never construct either — `ION.scene.*` returns them. No game needs to `import * as THREE from "three"`, and the generated starter does not.

That is the whole of what a game normally needs. `packages/runtime/src/index.ts` is the *entire* supported surface; the advanced API (`IonGame`, `Ion`, `ColliderManager`, `ParticleManager`, `UILayout`, `CameraHandler`, `AssetLoader`, `ViewportWatcher`, `Telemetry`, the ad-network adapters) is exported alongside it for the cases the simple layer does not cover.

Two of those are worth knowing about even from the simple layer, because they are wired into `IonGame` already and only need to be reached to be used:

```ts
import { Telemetry, ViewportWatcher } from "ion";

// Receive everything the playable reports, including the engine's own
// `ion:cta` and `ion:crash`. Events fired before this call are replayed.
Telemetry.setSink((event, props) => window.someNetworkSdk?.track?.(event, props));
```

`ViewportWatcher` is already driving `IonGame`'s resize path; it is exported for a project that drives its own renderer sizing and wants the same rotation / MRAID / `visualViewport` coverage.

```ts
import { Game, ION } from "ion";
import { Player } from "./Player";

export default class MyGame extends Game {
  player!: Player;

  start() {
    ION.scene.ground({ color: "green", size: 40 });
    this.player = new Player();
    ION.camera.follow(this.player);
    ION.colliders.attach(this.player, { size: 1 });
    ION.colliders.zone({ name: "Goal", size: 4 }).onEnter(() => ION.ui.showEndcard());
  }

  update(dt: number) {
    ION.ui.text("Score", this.score);
  }
}
```

No renderer, no scene graph, no scheduler, no registries, no dependency wiring, and no `three` import. The complexity is not removed — it is owned by `IonGame`, which builds the renderer, camera rig, environment, collider and particle registries, UI layers, input, audio and the editor connection, in the order the authored data files depend on, before `start()` runs.

Two naming decisions are load-bearing. The engine's per-frame method is **`tick()`**, not `update()`, so a game's own `update()` cannot shadow it — when it could, entities and camera follow silently stopped ticking. And `SimpleGameHost` in `packages/runtime/src/simple/context.ts` states exactly what the facade may reach on the running game, rather than letting `ION` hold an `IonGame` and read its protected members, which would hand every game the advanced surface by accident.

### 16.6 Versioning and upgrades

All four packages carry one version, stamped from this repository's `package.json` by the package build. `ion.config.json`'s `ionVersion` records what a project was generated against; `ion doctor` reports drift between that and what npm resolved. There is one installed copy and no second one to fall behind it.

```bash
npm run engine:update    # npm update @ion-engine/runtime @ion-engine/editor @ion-engine/build @ion-engine/project
npm run doctor
```

npm resolves the new versions and that is the whole operation — there is no ION-specific step, because there is nothing to keep in step. `src/game/` is never touched.

### 16.7 Development and production workflow

```bash
npm run dev       # ion dev — Vite + the build API + ION Studio
npm run build     # ion build — the production pipeline
npm run preview   # serve the last build
npm run doctor    # check Node, config, packages, integrity, drift
```

`ion dev` allocates a free port pair (see §16.2.1), serves the project, mirrors `assets/` into `public/assets/` so dev and production resolve the same relative paths, and starts the dev API the editors save through — pointed at this project's root and injected into this project's Studio page as `window.__ION_API_ORIGIN`.

`ion build` runs `@ion-engine/build`'s `build.sh` with everything about *this* project passed as environment (`ION_PROJECT_ROOT`, `ION_BUILD_LIB`, `ION_VITE_CONFIG`, `ION_RUNTIME_ENTRY`, `ION_BUDGET_BYTES`, …), so the script itself is the same file ION develops against. `buildInvocation()` in `packages/project/lib/build.mjs` is the single producer of that invocation — the Studio's Builder button reaches it through the dev API rather than constructing its own, which is what stopped the two from disagreeing about how a build is run.

The pipeline: compress assets → Vite build (IIFE, ES2015 target) → inline every `./assets/…` path as a data URI → strip the module script tag → write the build report → zip → **gate**. The gate is last on purpose: a build that fails it still leaves a complete, inspectable artifact on disk.

`ION_RUNTIME_ENTRY` aliases **both** `ion` and `@ion-engine/runtime` to the same absolute file. Two specifiers resolving to two paths put the engine in the bundle twice, which produced two `Ion` facades — `boot()` bound one and `IonGame`'s constructor read the other, and the result was `Ion used before IonEngine.boot() finished` on a boot that had already finished perfectly. The generated `main.ts` also uses one specifier throughout, so it cannot recur from the other direction.

### 16.8 Browser support

Derived from the compatibility rules in `scripts/compat-scan.mjs` plus the engine's own WebGL2 and WebAudio requirements. Stated rather than implied, because "which devices does this run on" is the first question an ad network asks.

| Environment | Minimum | Notes |
| --- | --- | --- |
| Chrome / Edge (desktop and Android) | 64 | WebGL2, WebAudio, ES2015 bundle. |
| Android System WebView | 64 | What most ad-network review apps embed. |
| Safari (macOS) | 15 | WebGL2 is unflagged from 15. |
| iOS Safari and every iOS in-app WebView | 15.0 | iOS WebViews follow the OS version, not the installed Safari. |
| Firefox | 63 | Not an ad-network target; supported for development. |
| Samsung Internet | 9.2 | Chromium 67-based. |

**Not supported:**

| Environment | Why |
| --- | --- |
| Internet Explorer, any version | No WebGL2, no ES2015. Not a target and will not become one. |
| iOS < 15 | WebGL2 is behind a flag, so the renderer cannot start. |
| Android < 7 / WebView < 64 | No WebGL2. |
| WebGL disabled or unavailable | The engine shows its recovery CTA rather than a blank canvas. |
| Node / SSR | The runtime imports without a DOM, but nothing renders. There is no headless mode. |

The gate checks two classes of problem, and the second is the one that used to get through. **Syntax** — `?.`, `??`, `static{}`, `catch{}`, `||=`, BigInt literals, regex lookbehind — is controlled by the bundler's target, so it only appears after a regression. **Runtime APIs** — `Array.prototype.at`, `Object.hasOwn`, `String.replaceAll`, `structuredClone`, `Promise.allSettled`, `.flatMap` — are not: esbuild's `target` transpiles *syntax* and does not polyfill *methods*, so one of these arriving from a dependency compiles perfectly and throws `undefined is not a function` on the review device. The scan strips inlined base64 payloads before matching, because the base64 alphabet produces sequences like `16n` freely and a gate that reports imaginary BigInt literals is a gate people learn to ignore.

### 16.9 Failure handling

Every layer reports rather than fails silently.

| Failure | What happens |
| --- | --- |
| Gameplay throws in a frame | The loop stops rescheduling (a dead RAF chain rather than one crash per frame), `onCrash` fires, and the recovery CTA overlay is shown. A throwing `onCrash` is caught so the overlay still appears. |
| The game fails to *build* — bad asset path, missing UI layer, a throw in `start()` | Routed to the same crash path with the same overlay, instead of an unhandled promise rejection over a blank canvas. |
| The page is missing `#custom-ui-layer` or `#endcard-layer` | An error naming the element and where the expected markup lives, instead of a `null.appendChild` several frames from the cause. |
| A model or sound is not in the manifest | `ION.scene.model()` throws naming the loaded models; `ION.audio.play()` warns and continues. |
| A colour string is not a colour | Warns and falls back, rather than `parseInt` silently turning `"deepblue"` into a brown. |
| `colliders.json` / `particles.json` / `sceneBindings.json` / `environment.json` is partial or malformed | The bad record is skipped with a warning and everything else loads. One truncated entry used to take the whole file, which reads as "the editor forgot my work". |
| A UI element is missing its `anchor` | Defaults to `top-left`. It used to throw and take the entire HUD down with it. |
| A `scene.json` entry names an object the model no longer has | Skipped with a warning naming the path. A re-export with a renamed node is normal; losing the boot over it is not. |
| An authored `particles.json` / `colliders.json` reaches `tsc` | It typechecks. The loaders take `unknown` and validate, because TypeScript types a JSON array as `number[]` and these schemas use `[number, number, number]` — so `as ParticlesFileData` compiled while the file was empty and failed with TS2352 the moment anyone saved their first effect. See [§16.10](#1610-json-data-files-and-tuple-types). |
| The dev server is interrupted mid-save | Nothing is lost: every save writes a sibling temp file and renames over the target, so a file is either its old content or its new one, never a prefix of either. |
| The WebGL context is lost | Reported, and `ion:context-lost` / `ion:context-restored` are emitted so a game can pause. three.js re-initialises on restore; the scene environment is re-applied. |
| `python3` is missing | The build stops immediately with install instructions per platform, rather than failing inside a heredoc several minutes in. |
| The engine is not installed, or installed but unbuilt | `ion build` and `ion doctor` say which package and what to run. |

Teardown is equally explicit, because a dev reload runs it on every save: the frame loop is retired by generation guard, timers and tweens are cancelled, colliders and particles are cleared, event listeners are removed, every geometry, material and texture in the scene is disposed, the asset loader releases its uploads, and every playing sound is stopped and disconnected. The `WebGLRenderer` is deliberately *kept*, one per canvas — `canvas.getContext()` returns the same context every time, so constructing a renderer per boot did not get a fresh context, it layered another set of three.js's own per-renderer allocations onto the one context, and `renderer.dispose()` does not release those. Six boots now hold exactly the GPU resources one boot holds; before, they held six times as many.

### 16.10 JSON data files and tuple types

`loadColliders`, `loadParticles` and `applySceneBindings` all take their data as **`unknown`**, and that signature is load-bearing rather than lazy.

TypeScript infers a JSON array literal as `number[]`. It never infers a tuple. Every transform in these schemas is `[number, number, number]`. So:

```ts
import particlesRaw from "./particles.json";
loadParticles(Ion.particles, particlesRaw as ParticlesFileData, scene);
//                           ^ TS2352: neither type sufficiently overlaps
```

compiles perfectly while `particles.json` is `{"version":1,"systems":[]}` — there are no emitters, so there are no tuples to disagree about — and fails the moment the file holds one real emitter. The failure therefore arrives not when anyone changes code, but when someone authors their first effect in the Particle Editor and presses Save, and it takes `tsc --noEmit`, `npm test` and CI with it.

Taking `unknown` is also the honest signature: each loader validates every record it is given (see [§16.9](#169-failure-handling)), so it does not in fact rely on the type. `tests/json-import-types.test.mjs` compiles a fixture that always contains populated tuples, and asserts the three signatures have not been narrowed back.

### 16.11 Editor persistence — what is written, and when

Five files, one shape. Each is a real `import` in the entry's module graph, so
everything authored in an editor ships in the production build.

| File | Written by | Contents |
| --- | --- | --- |
| `src/game/scene.json` | the gizmo and the Hierarchy | Object transforms, visibility, names, parenting |
| `src/game/environment.json` | the Environment dock | Camera, ambient and directional lighting, world, fog, tone mapping, shadows |
| `src/game/colliders.json` | Configure Colliders | Trigger volumes and solid geometry, with their attachments |
| `src/game/particles.json` | Particle System mode | Effects, emitters and every module |
| `src/game/sceneBindings.json` | ⊙ Pick | Which scene object a class field holds |

`scene.json` was the one that did not exist. Everything the 3D editor's gizmo
and Hierarchy did — moving an object, hiding it, renaming it, re-parenting it —
was a direct mutation of a live `THREE.Object3D` and nothing more. Those
objects are rebuilt from the model on every boot, so the edit updated the
running game and was gone on the next load.

**Diffed, not dumped, and twice over.** `captureSceneOverrides` compares the
live scene against two snapshots:

- the **load-time** baseline, taken before any override is applied, which
  supplies the stable path keys and the original values. Writing every node
  instead would freeze the artist's model — a later export with a moved prop
  would be silently overridden back by data nobody remembers authoring.
- the **session** baseline, taken when the editor opens, which decides what is
  worth writing at all. A game animates things; a spinning coin differs from
  the load baseline through nobody's authoring. Without this second snapshot a
  single gizmo drag wrote 55 entries and froze the animation's last frame into
  the next boot. Gameplay is paused for the whole session, so anything that
  moves after the editor opens moved because someone moved it.

Records the file already held are kept even when a session does not touch them,
so saving after one small edit cannot delete an earlier session's work.

Keys are **paths, not uuids** — three.js regenerates uuids on every GLB parse,
so a uuid written in one session resolves to nothing in the next. The path
recorded is always the object's path *at load*, which is what makes renaming
and re-parenting survivable: the key does not move when the thing it names does.

### 16.12 Why a save used to survive Exit and not a reload

Two independent faults produced one symptom, and the second is the one that
made it look like a caching problem — because it was one.

**`server.watch.ignored` broke reload freshness.** The four editor-authored
files were excluded from Vite's watcher so that saving one would not hot-reload
the scene out from under the editor session editing it. That goal was right and
the mechanism was wrong: Vite's module graph is invalidated *by* watcher events,
so a file the watcher never sees is a module that never invalidates. The
transformed JSON stayed in the dev server's cache and **a full browser reload
re-served the old data**. Restarting `npm run dev` rebuilt the cache, which is
precisely why the edits "came back" after a restart and why the problem read as
in-memory state.

It also hid the first fault. Camera, lighting and world settings *were* being
written to disk correctly all along — they came back stale for this reason, not
for want of a file.

The fix is `ionEditorDataPlugin` in `vite.config.mts`: the files stay in the
watcher, so they invalidate, and `handleHotUpdate` returns `[]` for them, so no
update is propagated. Vite calls `moduleGraph.onFileChange()` before that hook
runs, so declining the update costs nothing — the cache is already correct for
the next request.

`tests/dev-server-data.test.mjs` pins both halves against a real dev server: the
module must come back fresh **and** the save must not trigger an HMR update,
while an ordinary source file must still hot-update. Reverting to
`watch.ignored` fails four of its five cases.

> **Testing note.** The first attempt to reproduce this fetched
> `/src/game/environment.json` and found it fresh, which appeared to rule the
> theory out. The raw file always was fresh; it is the `?import` module form
> that was cached. A test of this has to request the module.
