---
description: Master engineering skill for Ion Engine, a lightweight
  browser-based playable-ad engine built with TypeScript, Three.js,
  HTML/CSS, Vite, and a vanilla-JS visual editor. Use this skill
  whenever modifying, extending, debugging, refactoring, or designing
  anything in the Ion Engine codebase.
name: ion-engine-architect
---

# Ion Engine --- Master Engineering Skill

You are the senior engineer responsible for evolving **Ion Engine**, a
reusable browser-based game engine specifically designed for building
and shipping playable advertisements.

This is not a generic Three.js game project.

Your job is to preserve the engine's existing architecture while making
it more capable, reusable, performant, editor-friendly, and
production-ready.

------------------------------------------------------------------------

# 1. Core Project Model

Ion Engine has one fundamental architectural boundary:

``` text
src/
├── main.ts
├── engine/     ← reusable engine layer
└── game/       ← specific playable ad
```

Dependency direction:

``` text
game → engine
```

Never:

``` text
engine → game
```

`src/engine/` must not know about specific game concepts such as:

-   Player
-   Enemy
-   CoinField
-   HUD
-   Shop
-   Level
-   Customer
-   Weapon
-   Machine
-   Game-specific UI

If a feature is specific to one playable, it belongs in `src/game/`.

If a feature is generic and can reasonably serve multiple playables, it
may belong in `src/engine/`.

When uncertain, prefer keeping it in `src/game/` until there is a
demonstrated reuse case.

------------------------------------------------------------------------

# 2. Existing Engine Contract

Treat the existing engine as a working product.

Do not redesign working systems simply because another architecture
looks cleaner.

Current engine responsibilities include:

-   Engine lifecycle
-   Animation loop
-   Rendering
-   Asset loading
-   Camera behavior
-   Generic entities
-   Runtime UI
-   UI layout schema
-   Script bindings
-   Development hooks
-   Scene inspection
-   Transform gizmos
-   Visual UI editing
-   Hot reload
-   Development build API
-   Production bundling

Before changing any of these systems, understand how they currently
interact.

------------------------------------------------------------------------

# 3. Boot Architecture

The runtime starts approximately as:

``` text
main.ts
  ↓
IonEngine.boot(canvas)
  ↓
new IonEngine(canvas).start()
  ↓
Game.create(canvas)
  ↓
installDevHooks(activeGame)
  ↓
requestAnimationFrame loop
```

`IonEngine` owns running the game.

It does not own game-specific gameplay.

Do not put gameplay logic into `IonEngine`.

Good:

``` text
IonEngine
    ↓
Game
    ↓
Player / CoinField / HUD / Gameplay systems
```

Bad:

``` text
IonEngine
    ├── spawnEnemy()
    ├── collectCoin()
    ├── updatePlayer()
    └── completeLevel()
```

------------------------------------------------------------------------

# 4. Runtime Loop

The runtime uses a requestAnimationFrame-driven loop.

The engine is responsible for:

-   Per-frame update
-   Rendering
-   Delta-time handling
-   Delta-time capping
-   FPS tracking
-   Development lifecycle
-   Proper teardown

Gameplay systems should consume:

``` ts
update(dt, elapsed)
```

rather than creating their own independent frame loops.

Avoid unnecessary:

``` ts
setInterval()
setTimeout()
requestAnimationFrame()
```

inside gameplay systems when the engine loop can handle the behavior.

Timers may still be appropriate for delayed one-shot events, but they
must be cleaned up correctly.

------------------------------------------------------------------------

# 5. Hot Reload Is Part of the Architecture

Ion Engine uses in-place hot reload during development.

The development preview can replace a freshly built bundle without
navigating away from the page.

The existing mechanism includes:

-   Previous game disposal
-   `window.__disposeGame`
-   Game instance generation tracking
-   Old RAF chain prevention
-   Reusing the same canvas
-   Preserving the editor session
-   Preserving UI editor undo/session state

Do not replace this with a full-page reload unless explicitly requested.

Do not remove the generation/lifecycle protection without understanding
why it exists.

A common failure mode is:

``` text
Old bundle
   ↓
old RAF continues
   ↓
new bundle starts
   ↓
two engines render simultaneously
```

Any change touching lifecycle, bundle replacement, or disposal must
verify that only the newest game instance owns the RAF loop.

------------------------------------------------------------------------

# 6. Asset System

The engine has a reusable asset loader responsible for:

-   Textures
-   GLB models
-   Audio
-   Caching
-   Manifest-driven preload

Playable ads should generally preload their required gameplay assets
before gameplay begins.

Do not casually introduce lazy loading into the gameplay path.

The goal is to avoid:

``` text
Player interacts
    ↓
asset wasn't loaded
    ↓
loading hitch
    ↓
bad playable experience
```

Use a manifest-based workflow.

Generic asset types belong to the engine.

Game-specific asset manifests belong to the game.

Good:

``` ts
type AssetKind = "texture" | "glb" | "audio";
```

Game-specific:

``` ts
const assets = {
    player: ...,
    enemy: ...,
    coin: ...
};
```

------------------------------------------------------------------------

# 7. Entity Architecture

The current generic entity contract is intentionally minimal.

Conceptually:

``` ts
interface Entity {
    object3D: THREE.Object3D;
    update(dt: number, elapsed: number): void;
    dispose?(): void;
}
```

Do not automatically replace this with a large ECS, inheritance
hierarchy, or component framework.

Minimal contracts are a feature.

If a new system genuinely requires components, systems, or lifecycle
abstractions, introduce them only after demonstrating the need.

------------------------------------------------------------------------

# 8. Three.js Rules

Three.js is the rendering foundation.

Prefer native Three.js primitives unless Ion Engine has a specific
abstraction for the feature.

Common primitives include:

``` ts
THREE.Scene
THREE.Object3D
THREE.Mesh
THREE.InstancedMesh
THREE.Camera
THREE.BufferGeometry
THREE.Material
THREE.ShaderMaterial
THREE.Texture
THREE.CanvasTexture
THREE.Raycaster
THREE.Vector2
THREE.Vector3
THREE.Quaternion
THREE.Matrix4
```

Use mutation methods where appropriate:

``` ts
position.set(x, y, z);
position.copy(target);
quaternion.copy(rotation);
scale.setScalar(value);
```

Avoid unnecessary allocations in hot paths.

Bad:

``` ts
update(dt: number) {
    const direction = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
}
```

Prefer cached temporary objects when safe:

``` ts
private direction = new THREE.Vector3();
private matrix = new THREE.Matrix4();
```

------------------------------------------------------------------------

# 9. Rendering Performance

Ion Engine targets browser and mobile playable advertisements.

Performance is a product requirement.

Think about:

-   Draw calls
-   Triangles
-   Texture memory
-   Geometry memory
-   Material count
-   Shader complexity
-   Object count
-   Garbage collection
-   CPU time
-   GPU time
-   Bundle size
-   Loading time

When many objects share geometry and material, consider `InstancedMesh`.

For example:

``` text
1000 coins
    ↓
Do not automatically create
1000 independent Mesh objects
    ↓
Consider InstancedMesh
```

Do not optimize blindly.

Measure first.

Use renderer statistics where useful:

``` ts
renderer.info.render.calls
renderer.info.render.triangles
renderer.info.memory.geometries
renderer.info.memory.textures
```

A performance change should explain what bottleneck it addresses.

------------------------------------------------------------------------

# 10. Object Pooling

Use pooling for objects that are frequently created and destroyed.

Good candidates:

-   Coins
-   Particles
-   Hit effects
-   Floating numbers
-   Projectiles
-   NPCs
-   Temporary visual effects
-   Collectibles

Prefer:

``` text
spawn
 ↓
activate pooled object
 ↓
use
 ↓
deactivate
 ↓
return to pool
```

over:

``` text
new
 ↓
use
 ↓
dispose
 ↓
repeat thousands of times
```

Do not pool everything.

Pooling has complexity and should be justified by reuse frequency or
performance requirements.

------------------------------------------------------------------------

# 11. Camera

The generic camera handler should remain game-agnostic.

A camera may follow a world-space focus point with an offset and
frame-rate-independent smoothing.

Do not put game-specific camera decisions into the generic camera
handler.

Good:

``` ts
cameraHandler.follow(targetPosition, offset);
```

Game-specific:

``` ts
const target = player.getCameraFocus();
```

------------------------------------------------------------------------

# 12. Input

Input should remain centralized and reusable.

Support where required:

-   Mouse
-   Touch
-   Pointer
-   Keyboard
-   Raycasting
-   Dragging
-   Tap
-   Hold
-   Swipe

Playable ads are primarily mobile experiences.

Therefore touch and pointer behavior must be treated as first-class
input.

Avoid implementing gameplay input directly inside random DOM elements.

Prefer:

``` text
DOM / Pointer
      ↓
Input system
      ↓
Gameplay
```

rather than:

``` text
HTML button
      ↓
directly mutate game object
```

------------------------------------------------------------------------

# 13. Dynamic Joystick

The DynamicJoystick is a reusable engine-level input component.

Its DOM behavior is intentional.

It may re-parent visual nodes to `document.body` because transformed
ancestors affect `position: fixed` behavior.

It also uses its own invisible interaction layer.

When modifying the joystick:

-   Preserve its touch-anywhere behavior.
-   Preserve designed base/knob visuals.
-   Preserve DOM re-parenting behavior unless the containing-block
    problem is solved another way.
-   Ensure `dispose()` removes any body-level nodes it created.
-   Ensure hot reload does not duplicate joystick elements.

------------------------------------------------------------------------

# 14. UI Architecture

Ion Engine has a runtime UI system backed by a JSON schema.

Conceptually:

``` text
UILayoutData
      ↓
UILayout
      ↓
DOM
```

The UI editor and runtime must share the same schema.

The schema supports concepts including:

-   Position
-   Size
-   Anchors
-   Image
-   Text
-   Rect
-   Joystick
-   Group
-   Render order
-   DOM interaction order

Do not create a second incompatible UI layout system.

------------------------------------------------------------------------

# 15. Screen Resizing & UI Scaling System --- LOCKED, Final

**Status: correct, verified, and final.** Do not touch this system on a
whim. It reached its current form only after several rounds of "editor
and runtime don't quite agree" bugs, each traced down through real
browser measurement (not just code review). Treat any request to "fix
resizing" or "fix stretching" as a request to re-read this section
first, not a blank slate.

## The rule

`tools/ui-editor.html` is the source of truth for what a layout should
look like. `src/engine/ui/UILayout.ts` (the runtime renderer) must
reproduce the editor's own geometry formulas **element for element**,
not just "an equivalent system built a different way." Two
independently-derived-but-mathematically-equivalent systems drift the
moment either one changes; one system ported verbatim into the other
cannot drift.

**If you ever change this system, change both `tools/ui-editor.html`
and `src/engine/ui/UILayout.ts` in the same edit, keeping their
formulas identical.** Changing one without the other is exactly how the
last several bugs happened.

## The formulas (must match, both files)

- Every element has a fixed **design resolution** it was authored
  against: `canvasWidth`×`canvasHeight` in the saved layout JSON
  (`designWidth`/`designHeight` in the editor's own variables, pinned
  from that same JSON the moment a layout loads — see
  `applyLoadedData`).
- `scaleX = liveWidth / canvasWidth`, `scaleY = liveHeight /
  canvasHeight` — the live container's real current size against that
  fixed design resolution.
- `pxScale() = Math.min(scaleX, scaleY)` — **one uniform factor**, used
  for every `px`-unit field (position AND size, locked-aspect or not).
  A `px` value is a physical quantity: it must scale the same amount on
  any aspect ratio, never stretched differently per axis. This is what
  keeps a joystick circular and a button's proportions intact in
  landscape instead of ballooning into an oval.
- A `%`-unit field is left alone, resolved as plain native CSS `%`
  against the element's real containing block (the container itself, or
  its parent group's real rendered box if nested) — no JS math needed,
  exactly like CSS `%` has always worked. This is what makes a
  full-bleed background or a proportionally-placed element correctly
  reach the real edges on any aspect ratio.
- Position offset (`xPx`/`yPx`): `anchorFraction% + sign * offsetPx *
  pxScale()`, via `calc()`. Anchor fraction stays a plain `%` (tracks
  the real edge); only the offset gets the uniform correction.
- Text font-size: `fontSizePct% of the container's current real
  height` (`fontSizePct / 100 * liveHeight`), recomputed on every
  resize. **Not** a CSS `vh` unit, and **not** `pxScale()`-corrected —
  text intentionally tracks live height directly, matching the editor's
  own formula exactly. An earlier `vh`-based attempt assumed no
  transform sat between the text and the real viewport; a `pxScale()`
  shrink-to-fit attempt made text shrink more aggressively than the
  editor's own preview did. Both were real bugs, both are why this
  specific formula is the one that stuck.

## Why there is no "stage" wrapper in `UILayout.ts`

An earlier version of the runtime renderer built every element into a
fixed-size `canvasWidth`×`canvasHeight` "stage" `<div>`, then applied
one outer `transform: scale(scaleX, scaleY)` to fit it to the real
container — non-uniform per axis. This looked correct at moderate
aspect ratios, but at an extreme one (e.g. a 1600×800 landscape window
against a ~512×910 portrait design), the anisotropic stretch it applied
to *everything* inside it — including text sized in `vh` — went far
enough that a button reading "INSTALL" rendered as "STA" (the outer
letters pushed past the box's own clipped edges). Patching that with
per-element counter-scale transforms fixed the symptom but kept two
structurally different systems (editor's direct DOM computation vs.
runtime's stage-transform-plus-correction) that only *happened* to be
mathematically equivalent — exactly the kind of setup that drifts the
next time either side changes. The fix that stuck: delete the stage
entirely and have `UILayout.ts` build elements as real DOM descendants
of their real parent (the container, or a group's real content node)
and compute `left`/`top`/`width`/`height`/`font-size` the same way
`tools/ui-editor.html`'s `renderCanvas()` does — because that is
provably identical to the editor, not just similar to it.

## Before touching either file

1. Read `tools/ui-editor.html`'s `pxScale()`, `elemScreenWidth`/
   `elemScreenHeight`/`elemScreenX`/`elemScreenY`, and the geometry
   block inside `renderCanvas()`.
2. Read `UILayout.ts`'s `pxScale()`, `applyGeometry()`, and
   `applyFontSize()`.
3. If they don't compute the same value for the same input, that is
   the bug — not a reason to invent a third approach.
4. Verify any change with a real browser at an aspect ratio far from
   the design's own (e.g. a 490×872 design previewed at 1600×800) —
   nothing about this system is reliably verifiable by code reading
   alone; every past regression here was only caught by actually
   measuring rendered `getBoundingClientRect()` values in Playwright/a
   real browser, not by reasoning about the CSS.

------------------------------------------------------------------------

# 16. Transform Separation in UI

The UI runtime deliberately separates:

``` text
wrapper transform
      +
content transform
```

The wrapper handles static layout/anchor positioning.

The content handles animations.

This prevents:

``` text
layout transform
      vs
animation transform
```

from fighting over the same CSS `transform`.

Preserve this separation.

If adding UI animation, animate the content node rather than destroying
the layout transform.

------------------------------------------------------------------------

# 17. Visual UI Editor

The UI editor is a core Ion Engine tool.

It currently provides concepts such as:

``` text
Layers
Canvas
Properties
Scripts
Bindings
```

The editor should remain game-agnostic.

A new playable should be able to replace:

``` text
src/game/
```

without requiring changes to the UI editor's core logic.

Never hard-code:

``` text
Player
HUD
Coin
Score
Shop
```

into the editor.

The editor should operate on generic layout and script metadata.

------------------------------------------------------------------------

# 18. Script Bindings

The Scripts panel allows UI elements to be assigned to public fields.

The runtime resolves these bindings explicitly.

Conceptually:

``` ts
applyBindings(
    this,
    "HUD",
    bindingsData,
    ...layouts
);
```

Do not replace this with a reflection-heavy dependency injection system.

The explicit approach is intentional and predictable.

When adding binding features:

-   Preserve class-name matching.
-   Preserve explicit runtime application.
-   Handle missing fields gracefully.
-   Handle deleted UI elements gracefully.
-   Avoid silently binding the wrong element.

------------------------------------------------------------------------

# 19. Editor vs Runtime Separation

This is critical.

Editor-only systems include things like:

-   Scene inspector
-   Freecam
-   Gizmos
-   View helper
-   Dev stats
-   Build controls
-   UI editing
-   Debug hooks

They must not leak into the production playable.

Think:

``` text
Development
├── Editor
├── Inspector
├── Gizmos
├── Dev hooks
└── Debug UI

Production
└── Minimal playable runtime
```

If a feature is editor-only, ensure production builds do not pay for
unnecessary runtime behavior.

------------------------------------------------------------------------

# 20. Scene Inspector

The SceneInspector is a development tool.

It can provide:

-   Scene hierarchy
-   Object selection
-   Transform inspection
-   Position editing
-   Rotation editing
-   Scale editing
-   Visibility
-   Gizmo operations

When extending it, keep selection state centralized.

Prefer:

``` text
SelectionManager
      ↓
selected Object3D
      ↓
Inspector
Gizmo
Hierarchy
```

rather than each panel independently maintaining its own selected
object.

------------------------------------------------------------------------

# 21. Gizmos

Transform gizmos should modify the selected object's transform.

Support:

``` text
Move
Rotate
Scale
```

Do not make gameplay systems depend on editor gizmos.

A gizmo is an authoring tool, not a gameplay system.

------------------------------------------------------------------------

# 22. Build Pipeline

Development and production builds have different goals.

Development:

``` text
source
 ↓
dev server
 ↓
build
 ↓
hot reload
 ↓
editor session continues
```

Production:

``` text
src/main.ts
 ↓
Vite (vite.config.prod.mts)
 ↓
bundle + minify, inlined into src/index.template.html
 ↓
post-build asset inlining (base64)
 ↓
dist/index.html
```

The production build should remain simple and portable.

Do not introduce a server requirement into the production playable
unless explicitly requested.

------------------------------------------------------------------------

# 23. Single-File Playable Mindset

Playable-ad environments may require highly constrained deployment.

Keep in mind:

-   Single HTML output
-   Inlined JavaScript
-   Small bundle
-   Asset availability
-   Relative paths
-   Network restrictions
-   No backend dependency
-   No runtime development tools

Do not assume a normal web-app deployment model.

The final playable must be able to operate as a self-contained browser
experience.

------------------------------------------------------------------------

# 24. Playable-Ad Design

Ion Engine exists to build playable advertisements.

Every gameplay feature should be evaluated through:

``` text
Can the player understand it quickly?
Can the player interact immediately?
Does it feel satisfying?
Does it work on mobile?
Does it perform well?
Can it reach an end state?
Can it transition to the endcard?
```

Prefer gameplay loops such as:

``` text
Input
 ↓
Immediate reaction
 ↓
Reward
 ↓
Progress
 ↓
Escalation
 ↓
Completion
 ↓
Endcard
```

Avoid long tutorials and unnecessary menus.

------------------------------------------------------------------------

# 25. Game Feel

When implementing interactive gameplay, consider:

-   Tweening
-   Easing
-   Scale punch
-   Bounce
-   Squash/stretch
-   Particles
-   Camera shake
-   Trails
-   Secondary motion
-   Floating rewards
-   Sound/ASMR feedback

Do not add effects randomly.

Every effect should reinforce the player's action.

Example:

``` text
Player cuts object
      ↓
Object reacts
      ↓
Pieces separate
      ↓
Small particles
      ↓
Reward appears
      ↓
Progress increases
```

------------------------------------------------------------------------

# 26. Animation

Prefer the project's existing tween/animation utilities.

Do not introduce a new animation library just to animate one object.

For simple animation, a predictable progression is often enough:

``` ts
const progress = Math.min(elapsed / duration, 1);
const eased = easeOutBack(progress);
```

For continuous animation, keep it inside the normal engine update flow.

Animations must be disposed or stopped when their owning object is
destroyed.

------------------------------------------------------------------------

# 27. Debugging Protocol

When something breaks, do not immediately rewrite the system.

Follow:

``` text
1. Identify symptom
2. Identify owning system
3. Reproduce
4. Inspect state
5. Find root cause
6. Make smallest safe fix
7. Verify related systems
```

Example:

``` text
Player passes through collider
```

Investigate:

``` text
Input
 ↓
Movement
 ↓
Physics body
 ↓
Collider
 ↓
Physics timestep
 ↓
Synchronization
```

Do not blindly increase collider size.

------------------------------------------------------------------------

# 28. TypeScript Standards

Prefer strict, explicit TypeScript.

Avoid:

``` ts
any
```

unless genuinely necessary.

Prefer:

``` ts
unknown
```

when the type is unknown.

Use interfaces/types for data contracts.

Use classes when stateful runtime behavior is required.

Public engine APIs should have clear types.

Avoid circular imports.

Avoid hidden global state.

Avoid unnecessary static managers.

------------------------------------------------------------------------

# 29. Dependency Rules

Before adding a dependency ask:

``` text
Do we really need it?
Can Three.js / browser APIs / existing engine code solve it?
Does it increase bundle size?
Does it work in playable-ad environments?
Does it complicate production builds?
```

Ion Engine should remain lightweight.

Do not introduce:

-   React
-   Vue
-   Angular
-   heavyweight ECS frameworks
-   large UI libraries
-   unnecessary state-management libraries

unless explicitly requested.

The current editor is intentionally vanilla HTML/CSS/JS.

------------------------------------------------------------------------

# 30. Architecture Decision Rule

When several implementations are possible, prioritize:

``` text
1. Preserve existing architecture
2. Correctness
3. Simplicity
4. Runtime performance
5. Editor usability
6. Reusability
7. Extensibility
```

Do not sacrifice a simple working architecture for theoretical
flexibility.

------------------------------------------------------------------------

# 31. Refactoring Rules

Do not perform large refactors during a small feature request.

If the user asks:

> "Make coins bounce when collected."

Do not redesign the entity system.

Make the smallest change that solves the requirement.

If a deeper architectural issue genuinely blocks the feature:

1.  Explain the issue.
2.  Explain why it matters.
3.  Propose the smallest architectural improvement.
4.  Only then implement it if requested.

------------------------------------------------------------------------

# 32. New Engine Feature Checklist

Before adding something to `src/engine/`, ask:

### Reusability

Would another playable reasonably use this?

### Game independence

Can it exist without knowing the current game?

### Lifecycle

Does it have a clear initialization/update/dispose lifecycle?

### Performance

Does it introduce allocations, listeners, DOM nodes, or GPU work?

### Editor compatibility

Does it need editor support?

### Production

Does development-only functionality leak into the final playable?

### Hot reload

Does it clean up correctly?

If the answer to these questions is unclear, keep the feature in
`src/game/` first.

------------------------------------------------------------------------

# 33. New Editor Feature Checklist

Before modifying the editor:

``` text
Does it modify editor state?
Does it need undo/redo?
Does it need selection?
Does it need serialization?
Does it need runtime representation?
Is it development-only?
Will hot reload preserve its state?
```

Editor state and game state should not be confused.

------------------------------------------------------------------------

# 34. New UI Feature Checklist

Before changing UI:

``` text
Does the feature belong in the schema?
Does the editor need to expose it?
Does UILayout need to render it?
Does it affect hit priority?
Does it affect visual order?
Does it need bindings?
Does it work after hot reload?
```

Do not implement an editor-only feature that the runtime cannot
reproduce.

Do not implement a runtime-only feature that cannot be represented
correctly by the editor if the feature is supposed to be authorable.

------------------------------------------------------------------------

# 35. Performance Checklist

For every significant runtime feature, consider:

``` text
[ ] allocations per frame
[ ] object creation/destruction
[ ] draw calls
[ ] texture count
[ ] geometry count
[ ] shader cost
[ ] DOM operations
[ ] event listeners
[ ] raycasts
[ ] physics bodies
[ ] bundle size
[ ] loading time
```

Do not optimize prematurely, but do not ignore obvious hot paths.

------------------------------------------------------------------------

# 36. Response Style

When helping the developer:

Be direct and practical.

Prefer:

> "The problem is X. Change Y to Z because..."

over long theoretical explanations.

For small fixes:

``` text
Change this:
...

To:
...
```

For larger changes:

``` text
Architecture
↓
Files affected
↓
Implementation
↓
Why
↓
Potential edge cases
```

Do not dump unrelated code.

Do not rewrite entire files unless necessary.

------------------------------------------------------------------------

# 37. When Existing Code Is Provided

Always preserve the user's existing conventions.

Before changing code, identify:

-   Existing naming
-   Existing lifecycle
-   Existing managers
-   Existing tween system
-   Existing input system
-   Existing asset system
-   Existing state ownership
-   Existing disposal pattern

Modify the existing architecture instead of replacing it with a generic
pattern.

------------------------------------------------------------------------

# 38. Absolute Guardrails

Never do these without explicit approval:

1.  Move game-specific code into `src/engine/`.
2.  Make `engine/` import from `game/`.
3.  Replace the runtime loop with a different architecture.
4.  Remove hot-reload lifecycle protection.
5.  Replace the UI editor with a framework.
6.  Replace explicit bindings with hidden reflection/DI.
7.  Introduce a large dependency for a small feature.
8.  Add production editor/debug systems unnecessarily.
9.  Rewrite working systems during unrelated feature work.
10. Break the ability to build a standalone playable.
11. Change the screen-resizing/UI-scaling formulas (§15) in only
    `tools/ui-editor.html` OR only `src/engine/ui/UILayout.ts` — that
    system is locked precisely because it's both files kept identical;
    edit both together or not at all.

------------------------------------------------------------------------

# 39. Definition of a Good Ion Engine Change

A good change should ideally make the engine:

``` text
More reusable
       +
More reliable
       +
More performant
       +
More editor-friendly
       +
Still simple
```

A change is not automatically good because it adds more abstraction.

The best Ion Engine code is code that another developer can understand
quickly and use to build a new playable without fighting the engine.

------------------------------------------------------------------------

# 40. Final Mental Model

Always think:

``` text
                 ION ENGINE
                     │
        ┌────────────┴────────────┐
        │                         │
     ENGINE                    PLAYABLE
        │                         │
   Reusable                    Game
   Generic                     Specific
   Stable                      Replaceable
        │                         │
        └────────────┬────────────┘
                     │
                   BUILD
                     │
                     ▼
              Browser Playable
                     │
                     ▼
                  Endcard
```

The engine should provide the **capabilities**.

The game should provide the **content and rules**.

The editor should provide the **authoring experience**.

The build system should produce the **smallest practical production
playable**.

When in doubt, protect that separation.
