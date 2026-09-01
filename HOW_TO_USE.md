# How to Use Ion Engine

A practical, step-by-step guide to actually *using* this project day to day — designing a screen, wiring it to code, tuning gameplay live, and shipping it. Not an architecture reference (see [ENGINE.md](ENGINE.md) for that) and not a setup manual (see [README.md](README.md) for that) — this is "I have it running, now what do I click."

## 1. Start it up

```bash
npm install
npm run dev
```

Open the URL it prints (usually `http://127.0.0.1:8000`). You'll see the game running full-screen with a dark **Engine Room** panel docked on the right — that panel, and everything in it, only exists in this dev preview. It never ships in the real playable.

## 2. The three tools you'll use

| Tool | What it's for | How to open it |
|---|---|---|
| **UI Editor** | Design the HUD/endcard — buttons, text, images, the joystick | `✏️ Editor` button, top of Engine Room |
| **Engine Room panel** | Build, 3D View (inspect the live scene), FPS/stats | Always visible, right-hand dock |
| **Control Desk** | Live-tweak gameplay numbers/booleans while the game runs | Scroll down in Engine Room → pick a script |

## 3. Design a screen (UI Editor)

1. Click **✏️ Editor**. The editor opens as an overlay on top of the running game — you're editing live, not in a separate preview.
2. **＋ Insert** (or press <kbd>I</kbd>) opens the element palette: **Text, Rect, Button, Group, Progress, Slider, Toggle, Checkbox, Shape, Icon, Sprite, Video, Joystick**. Images come in through the 🖼️ button next to it, since there's nothing to place until you've picked a file.
3. Click any element to select it. Eight handles resize it (drag pins the opposite edge; hold <kbd>Alt</kbd> to scale about the center, <kbd>Shift</kbd> to keep the ratio), and the grip above it rotates (<kbd>Shift</kbd> snaps to 15°). Dragging snaps to other elements' edges and centers, and to any guides you've pulled off a ruler.
4. The **Properties** panel (right side) is split into collapsible sections:
   - **Layout** — **X / Y** with a per-axis **PX / %** toggle (PX scales uniformly and never stretches; % tracks that axis), the 3×3 **Anchor point** grid deciding which edge the element pins to as the screen resizes, **⊙ Center (0, 0)**, Width/Height, Rotation.
   - **Appearance** — opacity, visibility at game start, blend mode.
   - **Fill & border** — solid colour *or* a linear/radial gradient, corner radius, border, drop shadow.
   - **Typography** (text, buttons, icons) — size, colour, alignment, weight, letter spacing, uppercase, outline and text shadow.
   - **Animation**, **States** (hover / pressed / disabled), **Actions** (see below).
   - **R Order** is visual stacking; **Z Order** is touch priority, independent of it.
5. **Actions** let a button do something without any code: `show`, `hide`, `toggleVisible` and `setText` run entirely in the runtime; `cta` opens the store link; `emit` sends a named event your game handles via `ui.onAction((event, el) => …)`.
6. **Layers** (left side) lists everything, with a filter box, collapsible groups, and per-row lock 🔒 and visibility toggles. Drag rows to reorder, drag one onto a group to nest it. The **Assets** tab keeps images you can reuse across layouts; **Prefabs** stores a selection you can stamp back in later (as a copy — edits don't flow back).
7. Watch the **✅ badge** in the toolbar. It flags things that only break much later otherwise: two elements sharing a name (which makes one unreachable from code), a missing image source, a zero-size element, an action pointing at something you deleted. Click a finding to jump to the element.
8. **Save** writes straight to `src/game/ui/mainLayout.json` (or the endcard layout) via the local dev API — no file picker, no permissions dialog. The button turns green with a ✓ to confirm, and the running game hot-reloads immediately.

Press <kbd>?</kbd> at any time for the full shortcut list.

Everything you place here becomes a named element the game code can reach by name — which is exactly what step 4 is for.

## 4. Wire a UI element to code (Scripts panel)

Say you added a text element named `moneyIcon` in the editor and want `HUD.ts` to control it directly, instead of doing a manual lookup.

1. In the UI Editor, open the **Scripts** panel (below Layers).
2. Pick a script — only files under `*/ui/*.ts` show up here, since those are the classes with UI-assignable fields.
3. Selecting a script shows its public fields. A field that's still `undefined` needs assigning.
4. Drag the element from the Layers panel onto the field — or click the **⊙ Pick** button next to the field and then click the element on the canvas (more reliable than drag-and-drop across panels).
5. That's it — no code to write. The field gets populated automatically at runtime via `applyBindings(...)`, called once in that class's own constructor.

Toggle **🔴 Debug** in this panel to also see *private* fields (dimmed, read-only, just for visibility — you can't assign to them).

## 5. Tune gameplay live (Control Desk)

This is for actual gameplay *values* — player speed, a coin count, anything that's a public `number` or `boolean` on a running game object — not UI layout.

1. Scroll down in the Engine Room panel to **📜 Scripts** — this list is different from the editor's Scripts panel: it shows `src/game/` files *except* anything under `ui/` (UI binding is step 4's job, not this one).
2. Click a script (e.g. `entities/Player.ts`). **🕹 Control Desk** below it shows every public field on that class, live:
   - **number** fields → editable input, updates the running instance as you type.
   - **boolean** fields → checkbox.
   - **arrays** → a read-only dropdown of current contents (view-only, not editable here).
   - anything else (strings, `THREE.Vector3`, other objects) → read-only text.
   - a green **● live** badge means an instance is actually running right now; a field only becomes editable once it is.
3. **🐞 Debug** also reveals private/protected fields — dimmed, always read-only, just for inspecting internal state.
4. **💾 Save** writes whatever you just tweaked straight back into the `.ts` source as that field's new default — so it survives the next reload instead of resetting. This edits real source code on disk; the dev build watcher picks it up and hot-reloads automatically.

### Grouping fields with `Header()`

Drop a comment directly above a field:

```ts
// Header("Player settings")
public speed: number = 5;
```

Everything below that comment (down to the next `Header(...)` or the end of the class) shows grouped under a **"Player settings"** divider in Control Desk. Add as many as you want, wherever you want — it's read straight from source, no registration step.

## 6. Debug audio (Audio Reactor)

**🎧 Audio Reactor** (Engine Room, below 3D View) shows a live frequency-spectrum bar graph of whatever background music is actually playing — confirms a track is really running (not just "should be"), and lets you eyeball levels while tuning volume.

1. Click **🎧 Audio Reactor** to open the panel (bottom-left).
2. The status dot + text reads **Playing** (green, pulsing) or **Stopped — tap the game to start music** — browsers block audio until a real tap/click/keypress happens, so this is usually the first sign something's wrong if music won't start.
3. The bar graph and the level readout (e.g. `42 / 255`) only animate while music is actually playing — a flat line with the panel open means nothing's loaded, or nothing's unlocked audio yet.

Dev-only readout, same as 3D View and Control Desk — nothing here ships in the real playable.

## 7. Inspect and edit the 3D scene (3D Viewer/Editor)

Click **🧭 3D Viewer/Editor** at the top of Engine Room. It orbits the *actual* running scene — not a separate preview — so what you click is what's really there.

The screen splits into two docks either side of the viewport:

- **Left**: **Hierarchy** on top (every object in the scene), **Scripts** below it (same list Control Desk uses).
- **Right**: **Exit**, a small camera-orientation compass, **Inspector**, and **Control Desk**.

### Hierarchy

- Only the top level is open at first — click **▸** to expand a branch, **▾** to collapse it. A GLB-heavy scene can be hundreds of objects; this keeps it browsable.
- Click any row to select that object. Selection is shared everywhere — the viewport, Inspector, and Control Desk all update together, whichever one you clicked in.
- Press **`.`** any time to jump straight back to whatever's currently selected — it opens whatever was collapsed to reveal it, and gives the row a quick flash.
- Drag a row out and drop it on a Control Desk field to assign it (see below).

### Inspector

Whatever's selected shows here, live:

- **Name** — with a 📋 button next to it to copy it.
- **Parent** — click it to jump to the parent object instead. Useful for walking back out of a deeply nested GLB node.
- **Vertices** / **Triangles** — shown for a mesh.
- **👁 Visible** — click the eye icon to show/hide the object. Slashed eye = hidden.
- **Position / Rotation / Scale** — real number inputs. Type a value to move/rotate/scale the object directly, or drag the gizmo in the viewport for the same effect — both stay in sync.

### Assign a scene object to a script field

Say `Player.ts` has a field like:

```ts
public popcornMachine!: THREE.Object3D;
```

1. In the 3D Editor, click `entities/Player.ts` in the **Scripts** list (left side).
2. Control Desk (right side) shows a **⊙ Pick** button next to `popcornMachine` automatically — any field typed as `THREE.Object3D`, `Mesh`, `Group`, a light, or a camera gets one; a plain `number`/`string` field doesn't.
3. Either:
   - Click **⊙ Pick**, then click the object you want — in the Hierarchy or directly in the viewport, both work the same.
   - Or skip Pick entirely and drag the row straight out of the Hierarchy onto the field.
4. Click **✕ Exit Editor**. That's the actual save — the button shows how many assignments are waiting first, e.g. **✕ Exit & Save (1)**.

Once saved, the assignment survives every reload from then on. It's written to `src/game/sceneBindings.json` and re-applied automatically every time the game boots — nothing else to do.

**If a class needs the object inside its own constructor** (not just later, in `update()`), populate it yourself the same way `HUD.ts` does for UI bindings — see `applySceneBindings`:

```ts
import { applySceneBindings, type SceneBindingsData } from "../../engine/SceneBindings";
import sceneBindingsRaw from "../sceneBindings.json";

constructor(scene: THREE.Scene) {
  applySceneBindings(this, "Player", sceneBindingsRaw as SceneBindingsData, scene);
  // this.popcornMachine is populated from this point on
}
```

`Game.ts` also re-applies every saved assignment automatically — but only *after* every constructor has already finished running. A constructor that reads the field immediately needs to call this itself first.

## 8. Code, explained like you're new

Everything above is buttons to click. This is the typing.

It's written plainly on purpose — if a sentence needs a computer-science degree, it's a bad sentence. **You never import `three`.** ION hides all of that.

> **The big idea.** Think of a box of LEGO. ION is the table, the lights, the camera and the bricks. You don't build the table. You just decide what to make and where to put it.

### Three words, and you know the whole thing

| Word | What it is |
|---|---|
| **Game** | The *whole* thing. You get exactly one. It says what exists and what happens. |
| **Prop** | A thing that just sits there — a coin, a wall, a tree. It has no brain. Every `ION.scene.*` call hands you one. |
| **Entity** | A thing with a brain — a player, an enemy. It gets to think every frame. |

A Prop and an Entity understand the *same words*. `moveBy` means the same thing on both, in the same units. So if a coin later needs a brain, you change one line, not the file.

### 8.1 The whole game

Four blanks to fill in. That's the file.

```ts
import { Game, ION } from "ion";

export default class MyGame extends Game {

  start() {
    // Runs ONCE, at the very beginning. Build your world here.
  }

  update(dt: number) {
    // Runs EVERY frame — about 60 times a second.
  }

  ready() {
    // Runs once more, after the editor's saved files have loaded.
  }

  stop() {
    // Runs at the very end. Tidy up here if you need to.
  }
}
```

> **What is `dt`?** It's how many seconds passed since the last frame — a small number, usually about `0.016` (one sixtieth of a second).
>
> Always multiply movement by `dt`. A fast phone draws more frames than a slow one, so `x += 5` would move **twice as fast on a better phone**. `x += 5 * dt` moves 5 units per second on every phone. Same game for everyone.

### 8.2 Making things

Five ways to put something in the world. All of them hand you back a **Prop**.

```ts
// A box.
const crate = ION.scene.box({ color: "brown", size: 1, x: 0, y: 0.5, z: 0 });

// A ball.
const ball = ION.scene.sphere({ color: "red", radius: 0.5, y: 1 });

// A tube.
const pillar = ION.scene.cylinder({ color: "grey", radius: 0.3, height: 3 });

// The floor. It's already lying down flat — you don't have to turn it.
ION.scene.ground({ color: "green", size: 40 });

// A model you made in Blender. It must be in src/game/assets.ts first, or ION
// tells you so — by name — instead of silently drawing nothing.
const hero = ION.scene.model("./assets/models/hero.glb", { y: 0, size: 1 });
```

Every option is optional. Leave one out and you get a sensible default.

| Option | What it does |
|---|---|
| `color` | A name — `"red"`, `"orange"`, `"blue"` — or `"#e8961e"`, or `0xe8961e`. Typo it and ION says so instead of guessing a wrong colour. |
| `size` | How big, all round. `1` is one metre-ish. |
| `width`, `height`, `depth` | Use these instead of `size` when it isn't a cube. |
| `radius` | For balls and tubes. |
| `x`, `y`, `z` | Where to put it. **x** = left/right, **y** = up/down, **z** = towards you / away. |
| `opacity` | `1` is solid, `0` is invisible, `0.5` is see-through. |
| `metal`, `rough` | How shiny. `metal: 1` is a mirror, `rough: 1` is chalk. |
| `name` | A label, so you can find it again later by that name. |

### 8.3 What you can do to a thing

This is the same list for a Prop **and** for an Entity. Learn it once.

```ts
const coin = ION.scene.box({ color: "yellow", size: 0.5, name: "Coin" });

// ── Where it is ─────────────────────────────────────────
coin.moveTo(2, 1, 0);          // go exactly there
coin.moveBy(0, 0.1, 0);        // go a little bit up from wherever you are
coin.position.y = 3;           // or just set one number

// ── Which way it's facing (DEGREES, like a protractor) ──
coin.rotation.y = 90;          // a quarter turn
coin.rotateBy(0, 45, 0);       // turn 45 more
coin.spin(120);                // keep turning, 120 degrees every second, forever
coin.stopSpin();               // stop where it is

// ── How it looks ────────────────────────────────────────
coin.color = "gold";
coin.opacity = 0.5;
coin.size = 2;                 // twice as big
coin.visible = false;          // hide it (it's still there)

// ── Talking about other things ──────────────────────────
coin.lookAt(player);                    // turn to face something
const far = coin.distanceTo(player);    // how far apart, in a straight line
coin.add(sparkle);                      // stick something on, so it moves along too

// ── Getting rid of it ───────────────────────────────────
coin.destroy();                // gone, and its memory is handed back
```

> **Two traps ION takes away from you.**
>
> **Turning is in degrees.** A half circle is `180`. Raw Three.js uses *radians*, where half a circle is `3.14159…`. You never have to think about that here.
>
> **Always `destroy()`, never just hide.** If you make and throw away coins all game long without `destroy()`, the phone's memory fills up and the ad gets slower and slower. `destroy()` hands the memory back.

### 8.4 Finding something again

If you gave it a `name`, you can ask for it back — including things you placed in the **3D editor** rather than in code.

```ts
const coin  = ION.scene.find("Coin");     // one thing, or undefined
const coins = ION.scene.findAll("Coin");  // every thing with that name, as a list

if (coin) coin.spin(90);
for (const c of coins) c.destroy();
```

Asking twice gives you back the *same* handle, not a copy. So `find("Coin") === find("Coin")` is true, and a `spin()` you started through one is visible through the other.

### 8.5 A thing with a brain — Entity

A Prop just sits there. When something needs to *decide* things every frame, make it an Entity.

```ts
import { Entity, ION } from "ion";

export class Player extends Entity {
  speed = 6;

  start() {
    // Runs once, when it's created. Give it something to look like.
    this.shape = ION.scene.box({ color: "orange", size: 1, y: 0.5 });
  }

  update(dt: number) {
    // Runs every frame, all by itself. You never call this.
    const move = ION.input.axis;
    this.moveBy(move.x * this.speed * dt, 0, move.y * this.speed * dt);
  }

  stop() {
    // Runs when it's destroyed.
  }
}
```

Using it is one line. Making it puts it in the world — there is no "add" step to forget:

```ts
start() {
  this.player = new Player();
  ION.camera.follow(this.player);
}
```

### 8.6 The player's finger

```ts
// The joystick, and WASD / arrow keys, both at once. You don't choose.
// x and y are between -1 and 1. Both are 0 when nobody is touching.
const move = ION.input.axis;

// Is a key held down right now?
if (ION.input.isDown(" ")) jump();          // " " is the space bar

// A quick tap anywhere.
ION.input.onTap((point) => console.log("tapped at", point.x, point.y));

// A flick.
ION.input.onSwipe((direction) => {
  if (direction === "up") jump();           // "up" | "down" | "left" | "right"
});
```

Most playable ads are played with a thumb. `ION.input.axis` already works for touch **and** keyboard, so you can test at a desk without a touchscreen and change nothing later.

### 8.7 The camera

```ts
ION.camera.follow(this.player);   // glide along behind them
ION.camera.stopFollow();          // stay put from now on
ION.camera.shake(0.4, 0.3);       // how hard, for how many seconds — a hit or a crash

ION.camera.position.y = 12;       // move it yourself
const zoom = ION.camera.fov;      // how wide it sees, in degrees
```

How far back and how smoothly it follows are set in the **Environment** dock in the 3D editor, not in code — so you can nudge the shot while the game runs.

### 8.8 Bumping into things

A **zone** is an invisible box. When something walks into it, you get told.

```ts
// 1. Give the player a body, so there is something to notice.
ION.colliders.attach(this.player, { size: 1 });

// 2. Put an invisible box somewhere.
const goal = ION.colliders.zone({ name: "Goal", size: 3, x: 5, y: 0.5, z: 0 });

// 3. Say what happens.
goal.onEnter(() => ION.ui.showEndcard());
goal.onExit(() => console.log("left the goal"));

goal.enabled = false;             // switch it off without deleting it

// Find a zone you drew in the editor (press K) instead of in code.
ION.colliders.find("Goal")?.onEnter(() => win());
```

> **A zone with nothing to notice never fires.** If `onEnter` never happens, you almost certainly forgot step 1 — `ION.colliders.attach(...)` on the thing that's meant to walk in.

### 8.9 Sound

```ts
ION.audio.play("./assets/sounds/coin.ogg");        // a one-off "ding"
ION.audio.play("./assets/sounds/coin.ogg", 0.4);   // quieter

ION.audio.music("./assets/sounds/theme.ogg");      // loops forever
ION.audio.stopMusic();

ION.audio.volume = 0.5;                            // everything, 0 to 1
```

**Why is there no sound at the start?** Phone browsers refuse to make noise until the player touches the screen once. That's a rule of the browser, not a bug. ION starts the audio for you the moment they first touch — you don't write anything.

### 8.10 Sparkles and explosions

You *draw* effects in the editor (press <kbd>P</kbd>), then set them off from code by name.

```ts
ION.particles.play("Coin Burst");              // where you drew it
ION.particles.play("Coin Burst", this.player); // or at something
ION.particles.play("Coin Burst", { x: 0, y: 1, z: 0 });

ION.particles.stop("Rain");
ION.particles.quality("low");                  // fewer bits, for slow phones
```

### 8.11 Words and buttons on the screen

You *design* the screen in the UI Editor and give each piece a name. Code just changes them.

```ts
ION.ui.text("score", 12);                 // change some words
ION.ui.show("hint");
ION.ui.hide("hint");
ION.ui.value("progress", 0.75);           // a bar, 0 to 1
ION.ui.onClick("play-button", () => start());
ION.ui.showEndcard();                     // the "Install now" screen
```

> **Every playable ad must be able to end.** If nothing ever calls `ION.ui.showEndcard()`, the player can never reach the install screen — and ad networks reject it. Wire it early, not last.

### 8.12 Waiting, repeating, and smooth movement

```ts
ION.after(3, () => ION.ui.show("hint"));      // once, in 3 seconds
ION.every(0.5, () => spawnCoin());            // again and again, every half second

// Slide numbers from where they are to where you want, smoothly.
ION.tween(coin.position, { y: 3 }, 0.4);
ION.tween(coin.scale, { x: 2, y: 2, z: 2 }, 0.3, { easing: ION.ease.bounce });

const seconds = ION.time;                     // how long the game has been going
```

Easing is *how* it moves. Try them and pick what feels good:

| Curve | What it feels like |
|---|---|
| `ION.ease.smooth` | Slow, fast, slow. The safe one. |
| `ION.ease.out` | Starts fast, gently stops. |
| `ION.ease.in` | Starts slow, speeds up. |
| `ION.ease.bounce` | Lands and bounces, like a dropped ball. |
| `ION.ease.elastic` | Wobbles past and springs back. |
| `ION.ease.back` | Overshoots a little, then settles. Great for pop-ins. |

**These all run on game time.** Open the UI editor or the 3D view and every timer freezes with it, then carries on exactly where it stopped. So your endcard can't fire while you're halfway through moving a button.

### 8.13 Letting parts of your game talk

Instead of the coin needing to know about the scoreboard, it just shouts. Whoever cares, listens.

```ts
// Somewhere a coin is picked up:
ION.emit("coin-collected", { total: 5 });

// Somewhere else entirely — this doesn't know coins exist:
ION.on("coin-collected", (info) => ION.ui.text("score", info.total));
```

Use the same word on both sides and it works. Nothing to declare anywhere.

### 8.14 Rolling dice

```ts
ION.random();            // somewhere between 0 and 1
ION.random(-3, 3);       // somewhere between -3 and 3
ION.randomInt(1, 6);     // a whole number: 1, 2, 3, 4, 5 or 6
```

### 8.15 The install button

```ts
ION.ui.onClick("install-button", () => ION.cta());
```

> **Always `ION.cta()`, never `window.open()`.** Every ad network wants the click sent through its *own* door, and several will reject an ad that opens a link by itself. `ION.cta()` works out which network is running the ad and uses the right door — and falls back to a normal new tab when you're just testing.

### 8.16 A whole small game

Everything above, in one file that actually runs. Collect five coins, then the endcard.

```ts
import { Game, Entity, ION, type Prop } from "ion";

class Player extends Entity {
  speed = 6;
  start() {
    this.shape = ION.scene.box({ color: "orange", size: 1, y: 0.5 });
    ION.colliders.attach(this, { size: 1 });
  }
  update(dt: number) {
    const move = ION.input.axis;
    this.moveBy(move.x * this.speed * dt, 0, move.y * this.speed * dt);
  }
}

export default class MyGame extends Game {
  player!: Player;
  score = 0;

  start() {
    ION.scene.ground({ color: "green", size: 40 });

    this.player = new Player();
    ION.camera.follow(this.player);

    // Five coins. Each one spins by itself and has its own little zone.
    for (let i = 0; i < 5; i++) {
      const x = ION.random(-4, 4);
      const z = ION.random(-4, 4);

      const coin = ION.scene.box({ color: "yellow", size: 0.5, x, y: 0.5, z, name: "Coin" + i });
      coin.spin(120);

      ION.colliders.zone({ name: "Coin" + i, size: 1, x, y: 0.5, z })
        .onEnter(() => this.collect(coin));
    }

    ION.ui.text("score", "0 / 5");
  }

  collect(coin: Prop) {
    if (coin.isDestroyed) return;      // only count it once
    coin.destroy();

    this.score += 1;
    ION.ui.text("score", this.score + " / 5");
    ION.audio.play("./assets/sounds/coin.ogg");
    ION.particles.play("Coin Burst", coin);
    ION.camera.shake(0.2, 0.15);

    if (this.score >= 5) ION.after(0.6, () => ION.ui.showEndcard());
  }

  ready() {
    ION.ui.onClick("install-button", () => ION.cta());
  }
}
```

No renderer, no scene graph, no loop, no `three` import, nothing to remember to register. That's the whole point.

### 8.17 When you really do need Three.js

Rare, but not blocked. Every handle keeps the real object on `.object3D`.

```ts
const crate = ION.scene.box();
crate.object3D.material.wireframe = true;   // an escape hatch, not the main road
```

If you find yourself using it a lot, that's worth reporting — it usually means the plain API is missing something it should have.

### Code cheat sheet

| I want to… | Write |
|---|---|
| Make a shape | `ION.scene.box / sphere / cylinder / ground / model` |
| Find it again | `ION.scene.find(name)` · `ION.scene.findAll(name)` |
| Move it | `moveTo(x,y,z)` · `moveBy(x,y,z)` · `position.y = 2` |
| Turn it (degrees) | `rotation.y = 90` · `rotateBy(0,45,0)` · `spin(120)` |
| Change how it looks | `color` · `opacity` · `size` · `visible` |
| Throw it away | `thing.destroy()` |
| Give it a brain | `class X extends Entity` — `start` / `update(dt)` / `stop` |
| Read the joystick | `ION.input.axis` · `isDown(key)` · `onTap` · `onSwipe` |
| Camera | `follow` · `stopFollow` · `shake(strength, seconds)` |
| Notice a bump | `ION.colliders.attach(thing, {size})` then `zone(...).onEnter(fn)` |
| Sound | `ION.audio.play` · `music` · `stopMusic` · `volume` |
| Effects | `ION.particles.play(name, at?)` · `stop` · `quality` |
| Screen | `ION.ui.text` · `show` · `hide` · `value` · `onClick` · `showEndcard` |
| Later / repeat / glide | `ION.after` · `ION.every` · `ION.tween` · `ION.ease.*` |
| Talk between parts | `ION.emit(name, data)` · `ION.on(name, fn)` |
| Dice | `ION.random(a,b)` · `ION.randomInt(a,b)` |
| Install click | `ION.cta()` |
| Escape hatch | `thing.object3D` |

## 9. Advanced: the engine API underneath

> Everything in section 8 is the plain API — what a game is normally written against, and what a generated
> project's starter uses. This section is the layer beneath it: the engine's own classes, for the cases the
> plain API doesn't cover. **You don't need any of it to build a playable.**

### 9.1 Write gameplay code with Ion

Everything above is the visual tools. This is for writing actual gameplay logic — timed beats, tweens, cross-system events — without hand-rolling timers or holding direct references between classes.

Import `Ion` from `src/engine/Ion.ts` in any gameplay class:

```ts
import { Ion, Easing } from "../engine/Ion";

Ion.after(3, () => hud.showHook());                     // once, 3s from now
Ion.every(0.5, () => spawner.tick());                    // repeating
Ion.sequence([                                           // back-to-back beats
  { wait: 0.5, then: () => coin.pop() },
  { wait: 0.2, then: () => hud.bumpScore() },
]);
Ion.tween(mesh.scale, { x: 1.4, y: 1.4, z: 1.4 }, 0.25, { easing: Easing.Back.Out });

Ion.on("coin-collected", (p) => hud.setScore(p.total));  // subscribe
Ion.emit("coin-collected", { total: 5 });                // fire, from anywhere else

Ion.cta(STORE_URL);                                        // a CTA button's click handler
```

Worth knowing:
- Everything on `Ion` runs on **game time**, not wall-clock — it automatically pauses while the UI editor or 3D View is open and resumes exactly where it left off. No extra code needed.
- Call `Ion.*` from a constructor, `update()`, or an event handler — not a file's top-level module code. `Ion` only exists once `IonEngine.boot()` has actually created a game; calling it too early throws a clear error saying exactly that.
- `Ion.on`/`Ion.emit` don't need event names declared anywhere — use the same string on both sides. Type the payload at the call site if you want it checked: `Ion.on<{total: number}>("coin-collected", fn)`.

### 9.2 Animate anything with `Animator`

`Ion.tween` is for animating a target's *own* fields toward a value directly (`mesh.scale`, `mesh.position`). `Animator` is for when you want the raw progress number yourself instead — driving two different things together, a custom formula, anything that isn't "move these fields to this value."

```ts
import { Animator } from "../engine/core/Animator";
import { Easing } from "../engine/Ion";

// progress goes from 0 to 1 over 0.5 seconds, eased with Back.Out
new Animator({ time: 0.5, easing: Easing.Back.Out }, (progress) => {
  mesh.scale.setScalar(progress);
});

// delay is optional; no easing = plain linear 0 -> 1; third argument
// (optional) runs once, the moment progress reaches 1
new Animator({ time: 1, delay: 0.3 }, (progress) => {
  door.rotation.y = progress * Math.PI;
}, () => {
  console.log("door fully open");
});
```

Nothing to call every frame yourself — construct it and move on, it drives itself exactly like `Ion.tween` does. Same rule as everything else on `Ion`: it only works after the game has actually booted (see "worth knowing" above) — a class built *during* `Game.create()` (most entity constructors) is too early. If you need one to fire from a constructor, defer it to that entity's own first `update()` tick instead, guarded so it only fires once:

```ts
private revealed = false;

update(dt: number): void {
  if (!this.revealed) {
    this.revealed = true;
    new Animator({ time: 0.5 }, (p) => this.mesh.scale.setScalar(p));
  }
}
```

Movement input also has a desktop fallback now: **WASD or arrow keys** move the player alongside the joystick automatically — no setup, useful for testing at a desk without touching the canvas.

See [ENGINE.md](ENGINE.md)'s `Ion.ts` / `core/Scheduler.ts` / `core/Animator.ts` / `core/EventBus.ts` / `core/InputManager.ts` sections for the full API and the reasoning behind each piece.

## 10. Ship it

**🛠 Builder** (top of Engine Room) runs `build.sh`: compresses every model/audio asset, bundles `src/main.ts` with Vite, inlines the JS directly into `src/index.template.html` (`vite-plugin-singlefile`), then base64-inlines every real asset straight into that same file — one genuinely self-contained `dist/index.html`, no `dist/assets/` folder, nothing else to upload. It opens directly via `file://` and works on any ad network that only accepts a single file, including the exact syntax/module checks Mintegral's Mindworks review enforces (build.sh checks for those automatically on every build — see 📊 Build Report below). None of the Engine Room/dev-only code above is included in it; the production template never references any of it.

Clicking Builder opens a modal with:
- A glowing progress bar showing the final file size against the ~5MB budget most ad networks enforce.
- **Half Float mesh compression** checkbox (on by default) — extra geometry compression at no visual cost. Leave it on unless you have a specific reason not to.
- **🚀 Build Now** — runs the real build.
- **📊 Build Report** — enabled once a build exists (this session's, or a teammate's `npm run build` from the CLI). Opens a full breakdown of what actually shipped: size composition by asset, before/after compression per model/audio file (dimensions, triangle count, texture sizes), any files sitting unused in `assets/` that never got referenced, and — most importantly — a red banner if the build somehow still contains something ad-network review would reject. Check this before uploading anywhere.

If gameplay ever throws an unhandled error mid-session in the shipped build, players see a minimal "Continue" screen with a working install button instead of a dead frame — the ad spend isn't a total loss even if something breaks. Nothing to configure, it's automatic (see ENGINE.md's crash-guard note under the Boot sequence section for the details).

You can also run it from the terminal:

```bash
bash build.sh
```

## Cheat sheet

| I want to... | Do this |
|---|---|
| Move something to an exact pixel position | Select it → Properties → switch X/Y to **PX** |
| Reset an element back to its anchor's center | **⊙ Center (0, 0)** button |
| Add any element type | **＋ Insert**, or press <kbd>I</kbd> |
| See every keyboard shortcut | Press <kbd>?</kbd> |
| Line several elements up / space them evenly | Select 2+ → **⌗** in the toolbar, or the align row in Properties |
| Make a button do something without writing code | Properties → **Actions** → `show` / `hide` / `setText` / `cta` |
| Send a custom event to your game from a button | Action type **emit** → handle it with `ui.onAction((event, el) => …)` |
| Stop grabbing a finished background by accident | Select it → 🔒 in the toolbar or the Layers row (<kbd>Ctrl+L</kbd>) |
| Check a layout for problems before shipping | The **✅ badge** in the toolbar — click a finding to select the element |
| Preview animations without them fighting your edits | They're paused by default — press <kbd>P</kbd> or ▶ to play |
| Reuse an image across several layouts | Sidebar → **Assets** tab |
| Save a group of elements to stamp in later | Select → sidebar **Prefabs** → ＋ From selection |
| Recover work after the tab died | Reopen the editor — it offers the autosave on boot |
| Give a script field a UI element | UI Editor → Scripts panel → drag or **⊙ Pick** |
| Change a gameplay number while the game's running | Engine Room → Scripts (bottom list) → Control Desk |
| Make a tweak permanent | Control Desk → edit the value → **💾 Save** |
| Group related fields in Control Desk | `// Header("Name")` comment above the first field in the group |
| See private fields for debugging | **🐞 Debug** toggle (Scripts panel *or* Control Desk — separate toggles) |
| See the actual running 3D scene / move the camera | **🧭 3D View** button |
| Toggle grid/helpers/snap/local-world/frame-selected in 3D View | Buttons in the 3D View toolbar, or keys **G/H/X/C/F** |
| Assign a scene object to a script field | 3D View → pick the script in **Scripts** → drag the object from **Hierarchy** onto the field, or click **⊙ Pick** then click it in the Hierarchy or the viewport |
| Find the selected object in the Hierarchy | Press **.** |
| Hide/show an object | Select it → click the eye icon in the Inspector |
| Copy an object's name | Select it → click the 📋 icon next to Name in the Inspector |
| Make that assignment stick after a reload | It saves automatically when you hit **Exit Editor** — the button shows how many are pending |
| Test movement without a touchscreen | Hold **WASD** or arrow keys — works alongside the joystick automatically |
| Check whether music is actually playing | **🎧 Audio Reactor** button |
| Write a timed beat, tween, or cross-system event in code | `Ion.after/every/sequence/tween/on/emit` — see step 8 |
| Animate something with your own 0→1 progress value | `new Animator({ time, delay }, progress => ..., onDone)` — see step 8 |
| Check a build for ad-network rejects before uploading | **📊 Build Report**, inside the Builder modal, after a build |
| Produce the final ad file | **🛠 Builder** button, or `bash build.sh` |

## Where things live

```
src/
  main.ts        entry point — don't touch when building a new playable
  engine/         reusable — see ENGINE.md
  game/           this playable's actual content — entities, world, UI
    ui/           HUD/endcard layout JSON + UI-layer scripts (Scripts panel territory)
```

Replacing everything under `src/game/` (keeping `src/engine/` as-is) is how you'd start a brand-new playable on this same engine — see ENGINE.md's "Building a new playable ad on this engine" for the full checklist.
