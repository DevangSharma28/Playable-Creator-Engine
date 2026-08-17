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
2. Along the top: **Image / Text / Rect / Joystick / Group** — click one to drop a new element onto the canvas.
3. Click any element to select it. The **Properties** panel (right side) shows everything about it:
   - **X / Y** — position. Toggle **PX / %** per-axis; PX is exact pixels, % is relative to screen size. New elements default to PX.
   - **Anchor point** — the 3×3 grid; this decides which corner/edge the element is pinned to as the screen resizes.
   - **⊙ Center (0, 0)** — snaps the element back to its anchor's exact center in one click.
   - **Width / Height**, **Rotation**, **Opacity** (shown as 0–1), **Visible on game start**.
   - For **Text**: content, font size, color (native color picker), and a 3-way **Align** control.
   - **Z Order** (light blue label) — touch/click priority, independent from visual stacking (**R Order**).
4. **Layers** panel (left side) lists everything on the canvas. Drag rows to reorder, drag one row onto another to group them, click the eye icon to toggle visibility.
5. **Save** (top bar) writes straight to `src/game/ui/mainLayout.json` (or the endcard layout) via the local dev API — no file picker, no permissions dialog. The running game hot-reloads immediately.

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

## 6. Ship it

**🛠 Builder** (top of Engine Room) runs `build.sh`: bundles `src/main.ts` with esbuild, inlines every asset (textures, models, audio) as base64 straight into the bundle, then inlines that into `src/index.template.html` — one genuinely self-contained `dist/index.html`, no `dist/assets/` folder, nothing else to upload. It opens directly via `file://` and works on any ad network that only accepts a single file. None of the Engine Room/dev-only code above is included in it; the production template never references any of it.

Clicking Builder opens a small modal with a glowing progress bar showing the final file size against the ~5MB budget most ad networks enforce for a single-file upload.

You can also run it from the terminal:

```bash
bash build.sh
```

## Cheat sheet

| I want to... | Do this |
|---|---|
| Move something to an exact pixel position | Select it → Properties → switch X/Y to **PX** |
| Reset an element back to its anchor's center | **⊙ Center (0, 0)** button |
| Give a script field a UI element | UI Editor → Scripts panel → drag or **⊙ Pick** |
| Change a gameplay number while the game's running | Engine Room → Scripts (bottom list) → Control Desk |
| Make a tweak permanent | Control Desk → edit the value → **💾 Save** |
| Group related fields in Control Desk | `// Header("Name")` comment above the first field in the group |
| See private fields for debugging | **🐞 Debug** toggle (Scripts panel *or* Control Desk — separate toggles) |
| See the actual running 3D scene / move the camera | **🧭 3D View** button |
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
