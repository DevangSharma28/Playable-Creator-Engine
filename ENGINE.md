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
          → bindIon(ctx)                     (Scheduler + EventBus + ColliderManager — before Game.create, so entity constructors can use Ion)
          → Game.create(canvas)              (game/Game.ts — asset preload, scene/camera/renderer, entities, UI)
          → installDevHooks(activeGame)       (window.__* hooks the Engine Room dev panel talks to)
          → requestAnimationFrame loop begins
```

`IonEngine` ([src/engine/IonEngine.ts](src/engine/IonEngine.ts)) owns *running* a game, not the game itself:

- The per-frame rAF loop (`update()`/`render()` each tick, capped `dt`, exponential-moving-average FPS)
- The `Scheduler` (timers/tweens), the `EventBus`, the `ColliderManager` (see `collision/`), and the `Ion` facade binding — created here because the loop is what drives them and teardown is what must retire them. Collider detection runs inside the same not-paused guard as `update()`, so trigger enter/exit freezes with gameplay rather than firing behind an open editor
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
`Ion.after()`, `Ion.every()`, `Ion.sequence()`, `Ion.tween()`, `Ion.on()`/`Ion.once()`/`Ion.emit()`, `Ion.cta()`, `Ion.time`, `Ion.colliders`. A **bound singleton**, not a self-initializing static: `IonEngine.boot()` constructs an `IonContext` and calls `bindIon(ctx)`; teardown calls `unbindIon(ctx)`. Deliberate, for two reasons this codebase already cares about — a static that lazily builds its own services ends up owning engine state nobody can see or reset (the `§28 no hidden global state` rule), and in-place hot reload has to be able to *fully* retire the previous bundle's services or its timers keep firing into the new game. `unbindIon` takes the context being retired so a late dispose from an old bundle can't unbind the live one. Using `Ion` before boot throws with a real explanation instead of a `TypeError` on undefined.

The same services are always reachable directly off the context — `Ion` is a shorthand, never the only way in, so tests can drive a `Scheduler` with no globals at all.

Also re-exports `Easing` (from `core/Scheduler.ts`, itself re-exporting tween.js's), so `import { Ion, Easing } from "./Ion"` is genuinely one line, one path — a caller going through the facade was previously forced into a second import from `core/Scheduler.ts` just for the easing curves, contradicting the whole point of having a facade.

**`Ion` is bound before `Game.create()`, so entity constructors can use it.** `IonEngine.start()` calls `bindIon(ctx)` *before* awaiting `Game.create()`, not after. Nothing in the context (`Scheduler`, `EventBus`, `ColliderManager`) depends on `Game`, so there was never a reason for the bind to wait — and waiting had a real cost: every entity constructor runs inside `Game.create()`, so `Ion.*` threw its not-yet-booted error for exactly the code most likely to reach for it. `Player.ts` registering its own collision volume where it builds its model (see `collision/` below) needs this ordering. It's safe against the stale-dispose case, because `__disposeGame()` has already run by then and `unbindIon` is context-guarded.

This used to be the other way round, and the historical workaround is still visible in `Player.ts`: its popcorn-machine reveal defers off the constructor rather than tweening directly from it. That deferral is no longer *required* for `Ion` to be available — it's about when the reveal should play.

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

### `core/Animator.ts`
A bare 0-to-1 progress driver for anywhere `Ion.tween`'s own "tween these numeric fields toward a target" shape doesn't fit — driving two different properties off two different curves, a shader uniform, a screen-shake magnitude, anything where the caller wants the raw number and will decide what to do with it. `new Animator({ time, delay }, (progress) => { ... }, onComplete?)` — self-driving, same as every other `Ion.*` primitive: construct it and walk away, `onProgress` fires on its own every tick without the caller's own `update()` ever touching it, and nothing needs to hold onto the instance unless it might get cancelled early (`.cancel()`, `.done`).

Deliberately a thin wrapper over `Ion.tween`, not a second animation clock — it tweens a private `{ t: 0 }` object to `{ t: 1 }` and hands `t` to `onProgress`. That's what makes it inherit `Scheduler`'s game-time pausing and hot-reload teardown for free, with nothing Animator-specific to get wrong. `game/entities/Player.ts`'s popcorn-machine reveal is the reference use — two `Animator`s on different `time`/`easing` (scale via `Easing.Elastic.Out`, rotation via `Easing.Back.Out`) so they resolve at different moments instead of reading as one shared progress bar.

Constructing one from an entity constructor is fine now that `bindIon()` runs before `Game.create()` (see the `Ion.ts` section above) — the deferral still visible in `Player.ts` is about *when the reveal should play*, not about whether `Ion` exists yet.

**`LoopAnimator`** — `Animator` that doesn't stop at 1: `new LoopAnimator({ time, loops, yoyo }, (progress) => { ... }, onComplete?)` for a pulsing glow, an idle bob, a spinning coin, anything that's "run this curve repeatedly" instead of once. `loops` defaults to `Infinity` (runs until `cancel()`); `yoyo` alternates direction each cycle (0→1, then 1→0, ...) instead of restarting from 0 every time.

Not a second implementation — each cycle genuinely *is* one real `Animator`, restarted from that one's own `onComplete`. That's the whole reason it doesn't need its own correctness story: every cycle inherits `Animator`'s game-time pausing and teardown because every cycle actually is one. `delay` (from the same `AnimatorOptions` it extends) only applies once, before the first cycle — a delayed *restart* between cycles isn't what "loop" means here. `loops` counts individual cycles, not round trips: `{ loops: 2, yoyo: true }` runs 0→1 then 1→0, not the 0→1→0 pattern twice.

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

### `collision/` — the ION Collider & Area system
Trigger zones, area volumes, character collision shapes, and solid geometry that actually blocks. **Not physics, and not a wrapper around one.** There is no rigidbody, no mass, no velocity, no gravity, no solver. The system answers one question continuously — *which registered volumes overlap right now* — turns the frame-over-frame change in that answer into enter/stay/exit events, and (only when gameplay asks, via `moveAndSlide`) can tell you where something would have to be in order not to be inside a wall. Rapier and its relatives stay entirely out of the bundle.

That's the right trade for a playable ad. Trigger zones, pickup radii, "did the player reach the machine" — none of it wants a simulation step, and all of it has to survive a hard size budget. This costs a few kilobytes of JS and a handful of dot products per frame.

**The runtime ships; the editor for it does not.** `collision/` is ordinary engine runtime, imported by `Game.ts` and present in `dist/index.html`. The authoring half (`editor/EditorColliders.ts`, `editor/ColliderVisuals.ts`) lives under `editor/` and tree-shakes out with the rest of it — verified the same way, by grepping the production bundle.

| File | What it is |
| --- | --- |
| `Collider.ts` | Base class: shape + transform + `tag` + `enabled` + `isTrigger`, the `on*` event subscriptions, and the per-frame transform sync. |
| `BoxCollider.ts` / `SphereCollider.ts` / `CylinderCollider.ts` | The three volumes. Each owns its dimensions and rebuilds its own world-space shape from the node's decomposed transform. |
| `intersect.ts` | Every shape-vs-shape test plus `penetration()` (the minimum translation out), zero-allocation, with the exactness of each pair stated in the file header. |
| `ColliderManager.ts` | The registry, the broad phase, the enter/stay/exit state machine, and `moveAndSlide`/`depenetrate`. Reached as `Ion.colliders`. |
| `ColliderSerialization.ts` | `src/game/colliders.json` ↔ live registry. `loadColliders` runs in production. |
| `ColliderTypes.ts` | Shape/data/world-shape types shared by all of the above. |

#### How one frame works

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

#### Making things solid, without physics

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

#### Mechanics

**Colliders live in their own `COLLIDERS` group, and *attach* to scene objects rather than parent under them.** Every collider's node sits under one engine-owned group at the scene root; `attachTo` makes it *follow* a scene object by recomputing its world transform from that object's world matrix every frame. Two reasons: a GLB-heavy scene is already hundreds of nodes and salting collision data through it makes both harder to read (and a re-export would blow the colliders away with the model), and attachment then survives the target being re-parented or swapped out entirely. The group is held at identity permanently — `Collider.syncWorld` writes world-space transforms straight into each node's local transform on exactly that assumption. Note the name is uppercase: `Cinema_World.glb` already contains a mesh group called `Colliders`, and the two must never be confused.

**The sync is two-way.** If something else moves a collider's node — the 3D editor's transform gizmo is the case that matters — the change is detected (`node.matrix` no longer matches what the collider last wrote) and folded back into the offset instead of being overwritten next frame. That's what makes dragging a collider in the editor actually stick, and it needs no cooperation from the gizmo.

**Tags and masks are two different filters, and it's worth keeping them straight.** `mask` is the *broad-phase* filter: masks are ANDed, so each side has to accept the other, and an empty mask means "accept anything". A pair the mask rejects never reaches an intersection test at all. The optional tag argument to `onTriggerEnter("Player", handler)` is the *handler* filter — it saves every handler from opening with `if (other.tag !== "Player") return;`. The shipped example uses both and they agree, which is the normal case; they're separate because a zone that wants to *see* several tags but *react* differently to each needs a wide mask and narrow handlers.

**Event contract:** enter fires once on the frame the overlap begins; stay fires every frame *after* that while it holds (so enter and stay never both fire for one pair on one frame); exit fires once when it ends — **including** when the other collider is disabled, destroyed, or has its attached object removed from the scene. That last part is what stops the classic stuck-flag bug where a handler runs on enter and never hears the matching exit. If either side of a pair is a trigger, only trigger events fire; two non-triggers report to each other as `onCollision*`.

#### Runtime API

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

#### Authoring and persistence

**Colliders can be assigned to script fields, exactly like scene objects.** A `public zone: Collider | undefined` (or `BoxCollider`/`SphereCollider`/`CylinderCollider`, which additionally enforce the shape) gets a `⊙ Pick` button in Control Desk and accepts a collider dragged out of the Hierarchy's COLLIDERS group or clicked on its volume in the viewport. Two things are worth spelling out:

- **The field receives the `Collider`, not its node.** A collider isn't an `Object3D`, so `EditorRoot.assignmentFor` returns a `value` (what the field gets) separately from the `object` (what was clicked) — one place decides it for both ⊙ Pick and drag-to-assign, so the two can't drift into assigning different things, which is the kind of bug that only surfaces after a reload.
- **It persists by `colliderId`, not by path.** `SceneFieldBinding.colliderId` is set for collider assignments and resolved through the registry at boot rather than by walking the scene, falling back to a lookup by name so renaming a collider stays recoverable.

The ordering constraint that follows: a collider field is populated by `Game.ts`'s `applySceneBindings` pass over `inspectables`, which runs *after* every inspectable is constructed — so a constructor reading it always sees `undefined`. `AreaDemo` shows the pattern: it has a `wire()` method that `Game.ts` calls straight after that pass, rather than subscribing from its constructor.

**Persistence.** `src/game/colliders.json` is a real static import, so **colliders ship**: what you place in the 3D editor is what runs in the production build, exactly as with `sceneBindings.json`. Attachments are recorded by *path*, never uuid, for the same reason `SceneBindings.ts` gives. Colliders created in code (the Player's cylinder) carry `persisted = false` and are deliberately excluded from the file — writing one out would resurrect it as a duplicate next to the one the script creates again on the next boot.

The worked example lives in [`src/game/AreaDemo.ts`](src/game/AreaDemo.ts): a `PlayerZone` trigger from `colliders.json`, masked to `["Player"]`, responding to the Player's own cylinder — the spec'd setup, and about forty lines covering the whole runtime API.

#### Four things that already went wrong here

All four presented identically — "the editor forgot my collider on reload" — and none of them was the editor forgetting anything. Worth knowing before changing any of this back.

- **`loadColliders()` runs after the entities are built**, not just after the environment GLB. A collider records its attachment as a scene path and can only resolve it against a graph that already contains the object — and the most useful thing to attach one to is a character, which doesn't exist until `new Player(...)` has added its model. Loading earlier silently dropped every collider attached to anything an entity builds.
- **Path resolution backtracks** (`SceneBindings.descend`). Sibling name collisions are the default here, not an edge case: every GLB's root node is called `Scene`, so a game with an environment model *and* a character model has two scene children both named `Scene`. A first-match walk went down the environment's branch looking for `Scene/Armature`, found nothing, and gave up — while the node it wanted sat one branch over.
- **`attachToScene()` on a *different* scene retires everything already registered.** Saving in the 3D editor can write two watched files at once (`colliders.json` *and* `sceneBindings.json`), firing two hot reloads back to back. Both new bundles bind their own context but share whichever registry was bound last — so the first reload's Game registered its colliders here, and the second reload's Game then pointed this registry at *its* scene. `syncAll` correctly noticed every collider was attached to objects no longer present and disabled them all. One registry serves one scene.
- **Attaching a collider does not move it.** `attachToObject()` recomputes the offset against the new parent so the volume stays exactly where it is in the world. Keeping the old offset verbatim — the obvious implementation — teleports it: a collider at world (−8, 0, 8) re-homed onto a prop 12 units away lands at *that prop's transform times* (−8, 0, 8), somewhere off in the distance, which from the outside looks exactly like attaching having done nothing.

### `editor/` — the 3D Viewer/Editor
Dev-only, and structurally dev-only: every entry point into this directory is behind `import.meta.env.DEV` (see `Game.setFreecam` and the `ViewHelperWidget` construction), so Rollup drops the whole tree from a production build rather than shipping it guarded by a DOM lookup that never matches. Verified by grepping `dist/index.html` — no `TransformControls`, `OrbitControls`, `BoxHelper`, `GridHelper`, `CameraHelper`, or any editor string survives the build.

Layout is a conventional three-column editor: a full-height dock either side of the viewport, and the viewport itself is `#device-frame` — *the same canvas container the device-preview uses*, laid out between the docks by `currentInsets()` rather than a second canvas or a second renderer. Left dock is Hierarchy over Scripts (even 50/50 split); right dock is Exit, then the View Helper, then Inspector, then Control Desk.

One composition root and a set of single-purpose classes, rather than one large editor class:

| File | Owns |
| ---- | ---- |
| `EditorRoot.ts` | Composition + lifecycle only — constructs, wires, disposes. Owns the editor camera and `OrbitControls`. |
| `EditorSelection.ts` | The single source of truth for what's selected (scene object *and* script), with `subscribe()`. |
| `EditorViewport.ts` | Renderer drawing-buffer size + camera projection against the real container. |
| `EditorResizeManager.ts` | `ResizeObserver` on the viewport container, coalesced to one callback per frame. |
| `EditorObjectPicker.ts` | Click→selection raycasting, and Control Desk's "Pick" assignment mode. |
| `EditorDragSource.ts` | The object currently being dragged out of the Hierarchy, for drag-to-assign. |
| `EditorHierarchy.ts` | The Object3D tree panel — collapsible, reveals the selection on demand. |
| `EditorInspector.ts` | Live transform/visible fields for the selection, plus name/parent/mesh-stats readouts. |
| `objectAssignment.ts` | Declared-TS-type → live-object compatibility for Pick. |
| `InspectorSections.ts` | Field-descriptor vocabulary letting other subsystems contribute a panel to the Inspector. |
| `ColliderVisuals.ts` | The wireframe/fill drawing. Owned by `Game` (it also serves the in-game overlay), borrowed by the editor. |
| `EditorColliders.ts` | "Configure Colliders" mode: creating, fitting, attaching, and the Inspector's collider panel. |
| `core/SceneInspector.ts` | What genuinely belongs to the 3D scene: the transform gizmo, selection outline, debug helpers, and the toggles/shortcuts below. |

**Everything is driven by one selection store.** `EditorSelection` is the reason the Hierarchy, the viewport, the Inspector, the gizmo, and Pick can't disagree: none of them owns a private `selected` field, they all subscribe. Previously `SceneInspector` held selection privately and each panel found out only if whichever code path made the change remembered to tell it, which is exactly how they drifted. Selection changes carry a `source` so a panel can tell *its own* click apart from someone else's — the Hierarchy scroll-into-views a viewport pick but not its own row click.

**Scene-object assignment (Pick, or drag-and-drop).** Control Desk shows a `⊙ Pick` button on any field whose declared type accepts a scene object (`THREE.Object3D`, `THREE.Mesh`, `THREE.Group`, lights, cameras, …) **or an ION collider** (`Collider`, `BoxCollider`, `SphereCollider`, `CylinderCollider` — see the `collision/` section above for what a collider field receives and how it persists) — see `objectAssignment.ts`, which is also what `window.__editorIsPickableField` answers from, so the rule lives in one place rather than being re-derived in `index.html`). Arm it, then click the object **either in the Hierarchy or directly in the 3D viewport** — both routes funnel through `EditorObjectPicker.offerObject()`, so they're genuinely interchangeable. The object is type-checked against the declaration; a mismatch reports why and leaves the pick armed for another try rather than making you re-arm on every near-miss. What lands in the field is the *real live object*, not a copy or an id — same no-serialization contract as `__getInspectable`. Assignments **persist**: they're written to `src/game/sceneBindings.json` and re-applied on every boot by `applySceneBindings` (see `SceneBindings.ts` below), production build included.

Writes are **batched into a single request on Exit Editor**, not made as you pick. `sceneBindings.json` sits inside `main.ts`'s module graph, so writing it trips Vite's watcher and hot-reloads the game — done per-pick, that tears down the very scene you're picking objects out of, at the moment you're picking them. Queuing gives exactly one reload, when you've said you're done, which is also when you want to see the bindings actually re-applied. The Exit button shows the pending count and flushes before closing; a queued edit survives a failed flush (a dead dev API shouldn't trap you inside the editor) instead of being silently dropped.

The same fields are also **drop targets**: drag a row straight out of the Hierarchy onto one. That's the same dual affordance the UI editor's Layers → Scripts panel already offers for UI elements ("drag it, or click ⊙ Pick"), and it lands in exactly the same place — same type check, same live-object assignment, same queued persistence. `EditorDragSource` holds the dragged object beside the drag because `DataTransfer` is deliberately unreadable during `dragover` (the browser exposes only the payload's *types* until the actual `drop`, for privacy) — without it a field couldn't tell you whether it accepts what you're holding until after you let go. The uuid still travels inside the `DataTransfer` under a private MIME type (`application/x-ion-scene-object`, so an unrelated text drag can never look like a scene object) and is what the drop resolves against; the object beside it only drives hover feedback. `dragend` is what clears the payload — it fires on success, refusal, and Escape alike, so a cancelled drag can't leak into the next one.

Type checks go through three.js's own `isMesh`/`isLight`/… flags rather than `instanceof`: after an in-place hot reload the scene can legitimately hold objects built by a previous module instance, and `instanceof THREE.Mesh` would call those frauds.

**Viewport sizing — why the scene is never stretched.** The editor camera is a clone of the gameplay camera, and its projection is driven *only* by `EditorViewport`, from a `ResizeObserver` measurement of the real viewport container. The gameplay camera keeps the game's own aspect untouched (`Game.resizeTo` returns early while the editor is open), which is what keeps the game's logical/design resolution genuinely separate from the editor viewport's — and is also why the `CameraHelper` frustum keeps showing the shape the playable actually ships at instead of the shape of your panel layout.

This was a real bug, not a hypothetical: `CameraHandler.handleResize()` is the only code in the engine that writes `.aspect`, and it holds the gameplay camera exclusively — so the old freecam clone kept whatever aspect it was cloned with, forever. Entering the editor from a Portrait or Landscape device preview projected a letterboxed 9:16 or 16:9 aspect into a full-width viewport, and resizing the window never corrected it. Three rules keep it fixed:

- **Only the container is measured.** Never `window.innerWidth`, never a size someone *intends* the box to become. A CSS transition, a dock width change, and a device-frame mode switch all land identically, after the fact, at the box's real final size.
- **Projection follows the box; the world never scales.** Only `camera.aspect` (or an orthographic camera's frustum bounds, preserving vertical extent) is recomputed, then `updateProjectionMatrix()`. No object transform, no scene scale — world coordinates and camera framing are untouched, so an object at (3, 0, −2) stays there at any aspect; the view just shows more or less around it.
- **CSS owns the displayed size, the renderer owns only the buffer.** `setSize(w, h, false)` — `#game` is CSS-sized `100%`/`100%` of its container, so the two can't disagree even mid-resize. Writing inline px onto the canvas (the `setSize` default) is what let a stale buffer stretch across a differently-sized box.

Two supporting details are load-bearing and easy to undo by accident: `.editor-dock` sets `box-sizing: border-box` so its CSS-variable width *is* the space it occupies (`currentInsets()` reserves exactly that; without it, padding and border put the viewport ~21px underneath a dock), and `editorDockWidth()` **measures the dock element** rather than parsing its CSS variable — a custom property's computed value is an unresolved token stream, so `parseFloat("clamp(150px, 20vw, 264px)")` is `NaN`, which silently became a zero inset and laid the viewport out full-width under both docks. Dock widths are `clamp()`ed so two fixed widths can't exceed a narrow window and collapse the viewport to nothing at 9:16.

Verified in a real browser (Chrome via CDP) at 9:16, 4:5, 1:1, 4:3, 16:9, 21:9, and a deliberately non-round 1237×603 — camera aspect and drawing-buffer aspect both match the container's at every one.

**Show Colliders (Engine Room button, or `Shift+K`) — the in-game overlay.** Draws every collider and trigger volume **over the running game**: no editor, gameplay proceeding normally, so a trigger can be watched turning red as the player walks into it. That's the difference from Configure Colliders below, which is an authoring mode inside the 3D editor with gameplay paused. Both drive the same `ColliderVisuals` layer — `Game` owns it (see `Game.colliderDebug`) and the editor borrows it for the duration of a session, so there's one layer with two independent things that can show it rather than two layers drawing the same volumes twice. `Game.render()` reconciles it once a frame, and it no-ops entirely while nothing is showing. DEV-only in the same way `ViewHelperWidget` is: built behind `import.meta.env.DEV`, so the module and its geometry/materials drop out of a production build while the collision system itself ships untouched.

**Configure Colliders (🧊 in the toolbar, or `K`).** The authoring mode for the ION Collider & Area system described under `collision/` above. Turning it on reveals a second toolbar row and draws every registered collider's volume; turning it off hides the drawing and changes nothing else — the registry and detection are runtime, this is only its editor.

- **`＋ Box` / `＋ Sphere` / `＋ Cylinder`** create a collider. With a scene object selected, the new collider is **attached to it and fitted to its real geometry bounds**; with nothing selected it's a 1-unit volume at the orbit target. The fit is measured in the object's own *local* space, not from `Box3.setFromObject` — a world-space AABB would produce a collider that's too big for any rotated object and wrong again the moment it turns, whereas a local measurement wraps the geometry and then inherits the object's rotation through the attachment, which is the entire point of an oriented collider.
- **Nothing about a render mesh is ever modified.** Fitting reads geometry bounds and writes only the collider; the visuals are separate geometry parented under the collider's own node. Teardown removes all of it and leaves the scene byte-identical.
- **Normal colliders and triggers are visually distinct**: solid volumes draw green, triggers cyan, disabled grey — and any collider *currently overlapping something* turns red, so you can watch a trigger fire instead of reading a console. `👁 Volumes` hides the drawing without stopping detection.
- **Selecting a collider** — in the Hierarchy under the `COLLIDERS` group, or by clicking its volume in the viewport — shows a full collider panel in the Inspector: name, shape dimensions, `Is Trigger`, `Enabled`, `Tag`, `Mask`, the attachment (assignable by `⊙ Pick` *or* by dragging a Hierarchy row onto it, same as Control Desk's object fields), offset transform, a live overlapping/clear readout, and Fit/Duplicate/Delete. A viewport click lands on the translucent volume mesh, which is a child of the collider's node — `EditorObjectPicker`'s `resolveHit` hook maps it back to the node, otherwise the gizmo would attach to the *drawing* and drag it away from the volume.
- The panel reaches the Inspector through `InspectorSections.ts`, not by the Inspector importing collider code. The Inspector knows how to draw a `number` row and nothing else; `EditorColliders` knows what a collider is and nothing about DOM. That split is also what keeps the whole collider editor out of production — in a shipped build the Inspector's provider list is simply empty, because the module that would fill it is never imported.
- **Colliders sync every editor frame via `previewOverlaps()`**, which detects overlaps but dispatches no events. It has to exist because gameplay is paused for the whole editor session: without it a gizmo drag would never fold back into the collider's offset (so the edit wouldn't save) and the wireframes would never light up. Dispatching real events from here would be worse — a trigger firing while you arrange it is the game's logic running behind a paused game.
- **Saved on Exit Editor**, in one `POST /save-colliders` that replaces `src/game/colliders.json` wholesale, for exactly the reasons the batched scene-binding write gives above. The Exit button counts collider changes alongside pending assignments.

**`core/ViewHelperWidget.ts`** is the small red/green/blue axis gizmo mirroring camera orientation — its own tiny Three.js renderer and WebGL context. It is physically re-parented into the right dock while the editor is open and back into the Engine Room on exit; a canvas keeps its context across a re-parent, so this reuses the existing widget rather than building a second one. The Scripts and Control Desk blocks move the same way and for the same reason: their existing logic holds direct element references, so relocating the nodes carries all of it along with no second implementation to keep in sync.

`SceneInspector` also owns a second toolbar cluster, separate from the Select/Move/Rotate/Scale mode buttons (deliberately a distinct `.si-gizmo-modes` DOM group in `index.html` — a shared `#si-gizmo-toolbar button` query used to wire both would sweep up these too and crash the gizmo, since they carry no `data-gizmo` attribute):

| Toggle               | Key | Default | What it does                                                                                                     |
| -------------------- | --- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| Grid                 | G   | off     | `THREE.GridHelper`, purely visual reference                                                                      |
| Camera/light helpers | H   | on      | `CameraHelper` + per-light helpers' visibility                                                                   |
| Snap                 | X   | off     | Fixed increments on the active gizmo (0.25 world units / 15° / 0.1 scale)                                        |
| Space                | C   | world   | `TransformControls`' local vs. world orientation                                                                 |
| Frame selected       | F   | —       | Recenters the orbit target on the selection and dollies the camera to fit it, keeping the current look direction |

All five are exposed as plain methods (`toggleGrid()`, `toggleHelpers()`, `toggleSnap()`, `toggleSpace()`, `frameSelected()`) plus `addStateChangeListener((state: InspectorToolState) => …)` — the same "keyboard shortcut and toolbar button both drive one method, one listener keeps both in sync" pattern `GizmoMode`/`addModeChangeListener` already used, just generalized to more than one boolean. `Game.ts` re-wires a listener onto each new `EditorRoot` (one per session) the same way it already did.

Because the editor's W/E/R/Q shortcuts collide with `InputManager`'s WASD fallback and both listen on `window` — where `stopPropagation` does nothing between two listeners on the same target, and `stopImmediatePropagation` only reaches listeners registered *later* — the editor suspends `InputManager` for its session (`setEnabled(false)`). Without that, pressing W to switch the gizmo to Move also counted as the player's first input and started the background music mid-edit.

**Hierarchy: collapsible, and it can find things.** A GLB-heavy scene is easily hundreds of `Object3D` nodes, so only the true top level (direct children of the scene root) starts expanded — everything else is collapsed behind a ▸/▾ toggle until opened. Open/closed state is a per-uuid `Map`, not reset by a rebuild, so collapsing a subtree survives an unrelated part of the scene changing underneath it (`EditorHierarchy`'s `computeSignature()` still walks the *real* scene graph, not the DOM, so it notices a change inside a currently-collapsed subtree without needing that subtree rendered). Selecting something from *outside* this panel — a viewport click, Control Desk, a hot-reload restoring the selection — opens every collapsed ancestor automatically; a click *inside* the panel doesn't, since the row you clicked is already open by definition (same `source`-tagged-selection reasoning `EditorSelection` exists for elsewhere). Press **`.`** (guarded against Inspector's own number fields, which use `.` for decimals) to re-find whatever's currently selected on demand — opens its ancestors, scrolls it to center, and gives it a brief flash even if it never left the visible area.

**Inspector: visibility is a button, not a checkbox** — an eye icon that reads open/hidden at a glance rather than needing a label to explain a generic tri-state-looking control. Also shows **Name** with a one-click copy button (`navigator.clipboard`, falling back to the classic hidden-`<textarea>` + `execCommand` trick for contexts without clipboard permission), a clickable **Parent** link that moves the selection up the tree (the Hierarchy above then reveals it, same mechanism as external-selection auto-expand), and — for anything with `isMesh`/`geometry` — **Vertices**/**Triangles** counts read straight off the geometry's `position` attribute and index.

**Teardown.** `Game.dispose()` closes the editor first and disposes `ViewHelperWidget`. Neither used to happen: an in-place hot reload with the 3D view open left the entire editor alive — window/canvas listeners still registered, helpers still in the discarded scene, its DOM still in the panels — so clicks drove a scene nothing was rendering, and every reload stacked another one, leaking a WebGL context each time. Relatedly, the editor is re-entered from `IonEngine.installDevHooks` rather than `main.ts`'s hot-accept callback: that callback runs while `start()` is still awaiting `Game.create()`, when `__setFreecamActive` is still the *previous* instance's closure pointing at a just-disposed Game, so the new Game never entered the editor at all and gameplay quietly resumed under the editor chrome.

### Control Desk — live public-field editing, no bespoke UI needed
Not a single file — a mechanism spanning `scripts/dev-build-api.js` (`GET /script-info`, a brace-depth text scan of a `*/ui/*.ts` or gameplay class file for its classes' public/private fields) and `IonEngine.ts`'s `window.__getInspectable(className)` hook (hands back the *real* running instance — Player, World, CoinField, whatever `Game.ts` chose to register in its `inspectables` map — no serialization, dev panel and game share one `window`). The Engine Room's Control Desk panel (`index.html`) combines the two: pick a script, it lists that class's fields; public `number`/`boolean` fields render as real inputs that write straight onto the live instance on edit, everything else renders read-only (`🐞 Debug` widens visibility to private/protected fields too, always read-only).

The reusable part for a new playable: **any gameplay class becomes live-tunable at runtime for free** just by (1) using plain public `number`/`boolean` fields rather than accessors — the field-scan regex only matches plain declarations, a `get`/`set` pair silently never appears — and (2) registering the instance in `Game.ts`'s `inspectables` map under its class name. If the live value needs to actually *do* something beyond sitting there, give the class its own `update()` (or fold into the class's existing per-frame method) that reads its own fields and applies them — Control Desk edits by direct property assignment, so a field that nothing ever reads back is just inert data. `game/SoundHandler.ts`'s `volume`/`muted` fields are the concrete example: `Game.update()` calls `this.soundHandler.update()` every frame, which applies `muted ? 0 : volume` onto the real `THREE.Audio` gain — Control Desk needed zero new code to make that live-editable, it only needed the fields to exist.

### Audio Reactor — same "engine hook, dev-only cost" shape as SceneInspector
The Engine Room's Audio Reactor panel draws a live frequency-spectrum bar graph from whatever a game's `SoundHandler`-equivalent is currently playing, via `window.__getAudioAnalyser`/`__isMusicPlaying` (`IonEngine.ts`, same no-serialization hook pattern as `__getInspectable`). The underlying `THREE.AudioAnalyser` is lazily constructed — nothing in `AssetLoader`/`IonEngine` ever builds one until the panel's own draw loop asks for it, and that loop only runs while the panel is visibly open (`requestAnimationFrame`'d on toggle-open, `cancelAnimationFrame`'d on close) — so a production build that never opens this panel (i.e. always, since it's dev-only chrome) pays nothing for it, same reasoning as `ViewHelperWidget` only existing when `#er-viewhelper` is in the page.

### `ui/UILayout.ts` + `ui/UILayoutTypes.ts`
The runtime half of the visual UI editor. `UILayoutTypes.ts` is the schema (`UIElementData`/`UILayoutData`) — percentage- or pixel-based positioning with 9-point anchors (mirrors Unity's `RectTransform`), image/text/rect/joystick/group element types, `renderOrder` (visual z-index, floats seeded 0.1 apart so inserting between two elements never forces renumbering) and `zOrder` (DOM-order tie-break for touch/pointer hit-priority, independent of visual stacking). `UILayout.ts` renders that JSON into real DOM: a wrapper node per element carries the static anchor transform, a separate content node carries any CSS animation, so the two never fight over the `transform` property.

**Screen resizing/UI scaling — locked, final, verified.** Every element (top-level or nested in a group) is a real DOM descendant of its real parent — the container itself, or the parent group's real rendered box — with no intermediate fixed-resolution wrapper. `%` fields resolve as plain native CSS `%` against that real parent, unchanged from how CSS `%` has always worked (this is what makes a full-bleed background correctly reach the real edges on any aspect ratio). `px` fields (position and size alike) are multiplied by one uniform `pxScale()` factor — `Math.min(scaleX, scaleY)`, where `scaleX`/`scaleY` are the live container size against the layout's own fixed `canvasWidth`×`canvasHeight` design resolution — so a `px` value scales the same amount on every axis regardless of aspect ratio (a joystick stays circular instead of ballooning into an oval in landscape). Text `font-size` is `fontSizePct`% of the container's *current real height*, recomputed every resize — deliberately not a CSS `vh` unit and deliberately not `pxScale()`-corrected. These formulas are written to be **identical** to `tools/ui-editor.html`'s own `pxScale()`/`elemScreenWidth`/`elemScreenHeight`/`elemScreenX`/`elemScreenY`/`renderCanvas()` geometry and its text font-size formula — the editor is the source of truth for what a layout should look like, and `UILayout.ts` is written to reproduce it exactly, not to be "an equivalent system." **If this ever needs to change, change the same formula in both files together** — see the `ion-engine-architect` skill's "Screen Resizing & UI Scaling System" section for the full history of why (an earlier fixed-resolution "stage" + outer `transform: scale()` approach looked correct but stretched text badly enough at extreme aspect ratios to clip words in half; the fix was deleting that stage entirely, not patching around it).

That instruction used to be enforced by this paragraph alone — silent drift here is a known, historically real failure mode in this codebase (the stage bug above shipped without erroring), so it's now backed by `tests/geometry-parity.test.mjs` (`npm run test:geometry`), not just a comment. Both files carry a `// ─── GEOMETRY:BEGIN/END ───` fence around their real formulas (`UILayout.ts`'s is exposed test-only via an additive `public __geometry()` — nothing else changes to support this); the suite extracts both fences with plain text/brace-depth scanning (same philosophy as `/script-info` above — no parser dependency), hashes a normalized version of each to catch *structural* drift, then calls both sides' real formulas across a dense viewport × design-resolution × element × parent-box matrix and asserts `Object.is` equality (exact, not epsilon — rewriting `(a/100)*b` to `a*(b/100)` is mathematically identical but not bit-identical in IEEE-754, and this contract is "reproduce it exactly," not "produce an equivalent result") to catch *numeric* drift. A third layer checks runtime-only invariants (a `px` square stays square at every viewport, `%` reaches the real parent edge, font-size never depends on width) that should hold even if both files drifted together. See `tests/lib/geometry-source.mjs` for how the editor's half gets executed without a browser (`new Function(...)` over the extracted text, never touching `document`/`window`) and the runtime's half without a real DOM (`esbuild.transformSync` + `Object.create(UILayout.prototype)`, skipping the constructor entirely since none of these formulas need it).

### `entities/Entity.ts`
The one contract a game entity needs to satisfy: `{ object3D: THREE.Object3D; update(dt, elapsed): void; dispose?(): void }`. Deliberately minimal — `game/entities/Player.ts` and `game/entities/Coin.ts` both implement it, `game/entities/CoinField.ts` owns a pool of the latter.

### `Bindings.ts`
Runtime half of the UI editor's Scripts panel drag-and-drop. `applyBindings(instance, className, bindingsData, ...layouts)` resolves every saved binding for `className` against the given `UILayout`s and writes each straight onto `instance`. One explicit call per wired class (there's no reflection/DI container behind compiled JS classes to do this invisibly) — see [game/ui/HUD.ts](src/game/ui/HUD.ts) for the pattern: call it once in the constructor, right after `super`/field declarations, so a field like `public moneyIcon: HTMLElement | undefined` gets populated from whatever was assigned in the editor, no manual `layout.get("name")` lookup needed for that field.

### `SceneBindings.ts`
The same idea as `Bindings.ts`, for **3D scene objects instead of UI elements** — the runtime half of the 3D Viewer/Editor's `⊙ Pick`. `applySceneBindings(instance, className, sceneBindingsData, scene)` resolves each saved assignment and writes the real `THREE.Object3D` onto the field, so a field like `public popcornMachine!: THREE.Object3D` is populated at boot instead of being wired by hand.

**Objects are identified by path, never by uuid.** three.js regenerates uuids every time a GLB is parsed, so a uuid saved in one session resolves to nothing in the next — that is exactly why an assignment made in the editor came back `undefined` after a reload. `objectPath` is slash-separated node names from the scene root (`"Scene/props/popcornMachine"`, with unnamed nodes as `#<childIndex>`, since GLB exports are full of them). Resolution **backtracks** through same-named siblings rather than committing to the first match — every GLB root is named `Scene`, so ambiguity is normal, not exotic. `objectName` is kept alongside it as a fallback `getObjectByName()` lookup for when a model is re-exported with a shifted hierarchy but the same node names — the same name-based convention `Game.ts` already relies on for `walkablearea`/`cinemafloor`/`Colliders`, and that `scripts/compress-assets.mjs` deliberately preserves node names to keep working. A binding that stops resolving leaves the field alone rather than throwing, and warns in dev only.

`src/game/sceneBindings.json` is a real static import, so **assignments ship**: the production bundle carries the binding data and re-applies it on boot exactly as the editor does. `Game.ts` applies it across its whole `inspectables` map at the end of the constructor — after `scene.add(sceneModel)`, since a binding can only resolve against objects already in the graph — so registering a class in that map is the only step needed for its scene fields to persist.

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
| `GET /list-scene-bindings`, `POST /save-scene-bindings`                | The 3D editor's `⊙ Pick` field↔scene-object assignments — `src/game/sceneBindings.json`. The save is deliberately *batched* (a whole session's edits in one request, flushed on Exit Editor) rather than one-per-assignment: this file is in `main.ts`'s module graph, so each write hot-reloads the game, and reloading mid-session tears down the scene being picked from |
| `GET /list-colliders`, `POST /save-colliders`                      | The 3D editor's "Configure Colliders" mode — `src/game/colliders.json`. Batched on Exit Editor for the same module-graph reason as the row above, and a *wholesale replace* rather than a merge: the file is entirely the editor's to own, and merging would have to reconcile deletions and reorders for no benefit — a delete that silently didn't stick is a far worse failure than a full overwrite |

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
