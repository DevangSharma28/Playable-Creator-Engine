import * as THREE from "three";
import type { ParticleManager } from "../particles/ParticleManager";
import type { ParticleSystem } from "../particles/ParticleSystem";
import type { ParticleEmitter } from "../particles/ParticleEmitter";
import type { EmitterShapeKind, ParticleEmitterConfig, ScalarRange } from "../particles/ParticleTypes";
import { cloneEmitterConfig, defaultEmitterConfig, newParticleId } from "../particles/ParticleDefaults";
import { PARTICLE_PRESETS, createEmptySystem, createSystemFromPreset } from "../particles/ParticlePresets";
import type { ParticleVisuals } from "./ParticleVisuals";
import type { EditorSelection } from "./EditorSelection";
import type { EditorObjectPicker } from "./EditorObjectPicker";
import type { EditorHistory } from "./EditorHistory";
import type { InspectorField, InspectorSection, InspectorSectionProvider } from "./InspectorSections";

export interface EditorParticlesOptions {
  manager: ParticleManager;
  visuals: ParticleVisuals;
  scene: THREE.Scene;
  selection: EditorSelection;
  /** Used by the "Attached To" row's ⊙ button — the same arm/resolve flow Control Desk's field picking uses. */
  picker: EditorObjectPicker;
  /** Where a new emitter is dropped: the orbit target, i.e. the middle of what you're looking at. */
  getFocusPoint: () => THREE.Vector3;
  /** Resolves a texture path through the game's own AssetLoader — the editor never loads assets itself, so particle textures go through the same pipeline (and the same production inlining) as every other asset. */
  resolveTexture?: (path: string) => THREE.Texture | undefined;
  /** Shared with the collider editor, so undo survives a mode switch. */
  history: EditorHistory;
  /** Notified whenever something changed that a save would need to write. */
  onDirty?: () => void;
}

/**
 * "Particle System" — the 3D editor's particle authoring mode, and the
 * sixteen-module Inspector panel that goes with it.
 *
 * Everything about editing particles lives here: creating systems from
 * presets, adding/duplicating/deleting emitters, playback transport, and
 * describing every module to the Inspector. It owns **no DOM** — the
 * Inspector renders whatever `describe()` hands back (see
 * InspectorSections.ts), which is what keeps this file about particles
 * instead of about `<input>` elements, and what keeps the whole module out
 * of a production build.
 *
 * Three invariants it holds throughout, matching EditorColliders exactly:
 *
 *  - **It never modifies scene content.** Emitters live under the
 *    engine-owned PARTICLES group and *attach* to scene objects rather
 *    than parenting under them. No material, geometry, transform, or
 *    visibility of anything in the game scene is touched.
 *  - **It never exists in production.** Reachable only from EditorRoot,
 *    which Game constructs behind `import.meta.env.DEV`, so this module,
 *    ParticleVisuals, the preset table, and their geometry/materials all
 *    drop out of a shipped build. The particle *runtime* is entirely
 *    independent of it and ships normally.
 *  - **Edits are live.** Almost every field mutates the config object the
 *    running simulation already holds, so the preview updates on the very
 *    next frame with no rebuild. Only genuinely structural changes
 *    (max particles, simulation space, render mode) go through a rebuild
 *    path, and those are the ones that visibly can't be done in place.
 */
export class EditorParticles implements InspectorSectionProvider {
  private readonly opts: EditorParticlesOptions;
  private readonly visuals: ParticleVisuals;
  private readonly unsubscribe: () => void;

  private active = false;
  private dirty = false;
  /** Bumped whenever the Inspector would need different *rows* — a shape swap, a render-mode change, a create/delete. See InspectorSectionProvider.version. */
  private structureVersion = 0;
  private newCount = 0;
  /**
   * Whether particles are advancing.
   *
   * **Starts true and is only ever cleared by the user pressing Pause or
   * Stop.** Entering or leaving the 3D editor must not touch it: an effect
   * that was running keeps running, at the state it had reached, because
   * an editor is a lens on a live scene rather than a mode the scene stops
   * for. This used to default to false and be forced false again on exit,
   * which froze every effect the moment the editor opened and left them
   * stopped after it closed.
   */
  private previewPlaying = true;
  /** Transform captured on the leading edge of a gizmo drag, so the trailing edge pushes one undo entry for the gesture. */
  private dragSnapshot: { emitter: ParticleEmitter; config: ParticleEmitterConfig } | undefined;

  constructor(opts: EditorParticlesOptions) {
    this.opts = opts;
    this.visuals = opts.visuals;
    // Highlight only. Deliberately does not bump structureVersion — the
    // Inspector already rebuilds on a selection change by itself, and
    // bumping here would force a *second* rebuild a frame later, yanking
    // focus out of a field the user just clicked into. Same reasoning
    // EditorColliders gives for its own selection subscription.
    this.unsubscribe = opts.selection.subscribe((state) => {
      this.visuals.setSelected(this.emitterFor(state.object)?.id);
    });
  }

  // ---------------------------------------------------------------------
  // Mode
  // ---------------------------------------------------------------------

  /**
   * Toolbar "Particle System". Turning it on reveals every emission volume
   * and hands the particle system the editor camera; turning it off hides
   * the gizmos and restores gameplay's own preview state.
   */
  setActive(active: boolean): boolean {
    this.active = active;
    this.visuals.setEditorVisible(active);
    this.structureVersion++;
    // Deliberately does NOT touch playback. Toggling the authoring mode is
    // a change of what's *drawn* (gizmos) and nothing else — it must never
    // stop, reset, or pause a running effect. Only the transport buttons
    // below, driven by an explicit user press, change `previewPlaying`.
    return this.active;
  }

  get isActive(): boolean {
    return this.active;
  }

  get isPreviewPlaying(): boolean {
    return this.previewPlaying;
  }

  /**
   * Once per editor frame, from EditorRoot.update().
   *
   * Gameplay is paused for the whole editor session, so this is the only
   * thing advancing particles while the editor is open — which is exactly
   * what makes the live preview a preview rather than a frozen frame.
   * `dt` comes from the editor's own clock, not gameplay's.
   */
  update(dt: number): void {
    // Simulation runs whenever the editor is open, in *any* mode — not
    // only while the Particle mode is active. Gameplay is paused for the
    // whole editor session, so this is the only thing advancing particles;
    // gating it on `active` meant every effect in the scene froze the
    // moment you opened the editor to do something unrelated, like moving
    // a collider.
    if (this.previewPlaying) this.opts.manager.update(dt);

    // GPU upload is deliberately NOT done here — Game.render() calls
    // manager.render() once a frame for gameplay and the editor alike, so
    // doing it here too would upload every emitter twice per frame.

    if (!this.active) return;

    // Fold any gizmo drag back into the emitter's config, so dragging an
    // emitter in the viewport actually persists. Same two-way sync
    // Collider.syncWorld performs for colliders. Only while the mode is
    // active: outside it there's no gizmo attached to an emitter, and
    // reading the node back every frame would fight an undo that had just
    // written the config.
    for (const emitter of this.opts.manager.allEmitters) emitter.adoptNodeTransform();
    this.visuals.update();
  }

  dispose(): void {
    this.unsubscribe();
    this.visuals.setEditorVisible(false);
    this.visuals.setSelected(undefined);
  }

  // ---------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------

  /** Play — the selected system if there is one, otherwise everything. */
  play(): void {
    this.previewPlaying = true;
    const system = this.selectedSystem;
    if (system) system.play();
    else this.opts.manager.playAll();
  }

  pause(): void {
    this.previewPlaying = false;
    this.opts.manager.pauseAll();
  }

  /** Stop emitting; live particles finish their lifetimes (see ParticleSimulation.stop). */
  stop(): void {
    const system = this.selectedSystem;
    if (system) system.stop();
    else for (const s of this.opts.manager.all) s.stop();
  }

  restart(): void {
    this.previewPlaying = true;
    const system = this.selectedSystem;
    if (system) system.restart();
    else for (const s of this.opts.manager.all) s.restart();
  }

  /** Kill every live particle immediately, without stopping emission. */
  clearParticles(): void {
    const system = this.selectedSystem;
    if (system) system.clear();
    else this.opts.manager.clearAllParticles();
  }

  // ---------------------------------------------------------------------
  // Authoring
  // ---------------------------------------------------------------------

  /**
   * Creates a system, from a preset key or empty.
   *
   * With a scene object selected, the new system is **attached to it** and
   * placed at its origin — the case that's actually useful, since an
   * effect almost always belongs to something. With nothing selected it
   * lands at the view's focus point, ready to be dragged.
   */
  createSystem(presetKey?: string): ParticleSystem | undefined {
    const config = presetKey ? createSystemFromPreset(presetKey) : createEmptySystem();
    if (!config) return undefined;
    config.name = this.uniqueSystemName(config.name);
    const system = this.opts.manager.create(config);

    const target = this.selectedSceneObject();
    const focus = this.opts.getFocusPoint();
    for (const emitter of system.all) {
      emitter.persisted = true;
      if (target) {
        emitter.attached = target;
        emitter.settings.attachName = target.name;
      } else {
        emitter.settings.position = [focus.x, focus.y, focus.z];
        emitter.applyNodeTransform();
      }
    }

    this.markDirty();
    this.structureVersion++;
    // Select the first emitter, not the system group: the emitter is what
    // has an Inspector panel, so selecting the group would show an empty
    // one right after creating something.
    if (system.all.length > 0) this.opts.selection.selectObject(system.all[0].node, "api");
    system.play();

    this.opts.history.push({
      label: `Create ${system.name}`,
      undo: () => {
        if (this.selectedSystem === system) this.opts.selection.selectObject(undefined, "api");
        this.opts.manager.remove(system, true);
        this.structureVersion++;
        this.markDirty();
      },
      redo: () => {
        this.opts.manager.readd(system);
        system.play();
        this.structureVersion++;
        this.markDirty();
      },
      // A detached system still owns every emitter's GPU buffers, so it
      // has to be released once redo can no longer bring it back.
      discard: (state) => {
        if (state === "unapplied") system.dispose();
      },
    });
    return system;
  }

  /** Adds another emitter to the selected system — how a one-emitter effect grows into a layered one. */
  addEmitter(): ParticleEmitter | undefined {
    const system = this.selectedSystem ?? this.opts.manager.all[0];
    if (!system) return undefined;
    const config = defaultEmitterConfig(this.uniqueEmitterName(system, "Emitter"));
    const emitter = system.addEmitter(config);
    emitter.persisted = true;
    // Before autoStart, for the reason ParticleManager.add spells out: a
    // prewarm bakes the world matrix into every particle it spawns.
    emitter.setWorldRoot(this.opts.manager.group);
    emitter.autoStart();
    system.wireSubEmitters();
    this.structureVersion++;
    this.recordEmitterCreate(system, emitter, `Add ${emitter.name}`);
    this.opts.selection.selectObject(emitter.node, "api");
    return emitter;
  }

  /** Same settings, new id and name. The fast way to build a layered effect from one tuned emitter. */
  duplicateEmitter(emitter: ParticleEmitter): ParticleEmitter | undefined {
    const system = this.systemFor(emitter);
    if (!system) return undefined;
    const config = cloneEmitterConfig(emitter.settings);
    config.id = newParticleId("em");
    config.name = this.uniqueEmitterName(system, emitter.name);
    const copy = system.addEmitter(config);
    copy.persisted = true;
    copy.attached = emitter.attached;
    copy.setWorldRoot(this.opts.manager.group);
    copy.autoStart();
    system.wireSubEmitters();
    this.structureVersion++;
    this.recordEmitterCreate(system, copy, `Duplicate ${emitter.name}`);
    this.opts.selection.selectObject(copy.node, "api");
    return copy;
  }

  /**
   * Removes an emitter, and the whole system with it if it was the last
   * one.
   *
   * Detached with `keepAlive` rather than disposed, so undo restores the
   * identical instance — which matters here beyond references: a sibling's
   * sub-emitter entry targets this one by name, and recreating a copy
   * would leave that entry pointing at a different object.
   */
  removeEmitter(emitter: ParticleEmitter): boolean {
    const system = this.systemFor(emitter);
    if (!system) return false;
    const wasSelected = this.opts.selection.object === emitter.node;
    if (wasSelected) this.opts.selection.selectObject(undefined, "api");

    system.removeEmitter(emitter, true);
    // Removing the last emitter takes the (now empty) system with it, and
    // undo has to put both back in the right order.
    const systemEmptied = system.all.length === 0;
    if (systemEmptied) this.opts.manager.remove(system, true);
    else system.wireSubEmitters();
    this.markDirty();
    this.structureVersion++;

    this.opts.history.push({
      label: `Delete ${emitter.name}`,
      undo: () => {
        if (systemEmptied) this.opts.manager.readd(system);
        system.readdEmitter(emitter);
        system.wireSubEmitters();
        this.structureVersion++;
        this.markDirty();
        if (wasSelected) this.opts.selection.selectObject(emitter.node, "api");
      },
      redo: () => {
        if (this.opts.selection.object === emitter.node) this.opts.selection.selectObject(undefined, "api");
        system.removeEmitter(emitter, true);
        if (system.all.length === 0) this.opts.manager.remove(system, true);
        else system.wireSubEmitters();
        this.structureVersion++;
        this.markDirty();
      },
      discard: (state) => {
        if (state !== "applied") return;
        emitter.dispose();
        if (systemEmptied) system.dispose();
      },
    });
    return true;
  }

  /** The toolbar's 🗑 — deletes whatever emitter is selected. */
  removeSelected(): boolean {
    const emitter = this.selected;
    return emitter ? this.removeEmitter(emitter) : false;
  }

  get selected(): ParticleEmitter | undefined {
    return this.emitterFor(this.opts.selection.object);
  }

  get selectedSystem(): ParticleSystem | undefined {
    const object = this.opts.selection.object;
    if (!object) return undefined;
    const emitter = this.emitterFor(object);
    if (emitter) return this.systemFor(emitter);
    return this.opts.manager.systemFromNode(object);
  }

  /**
   * Maps a viewport raycast hit to the emitter node it belongs to.
   *
   * Clicks land on a gizmo wireframe, which is a child of the emitter's
   * node — without this, selecting an emitter in the viewport would select
   * the *drawing* and attach the transform gizmo to it, dragging the
   * wireframe away from the volume it's meant to be drawing. Exactly the
   * problem EditorColliders.resolveHit solves for colliders.
   */
  resolveHit(object: THREE.Object3D): THREE.Object3D {
    const emitter = this.opts.manager.emitterFromNode(object);
    return emitter ? emitter.node : object;
  }

  // ---------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------

  get hasChanges(): boolean {
    return this.dirty;
  }

  markSaved(): void {
    this.dirty = false;
  }

  get persistedCount(): number {
    return this.opts.manager.allEmitters.filter((e) => e.persisted).length;
  }

  // ---------------------------------------------------------------------
  // Inspector
  // ---------------------------------------------------------------------

  get version(): number {
    return this.structureVersion;
  }

  describe(object: THREE.Object3D): InspectorSection[] | undefined {
    const emitter = this.emitterFor(object);
    if (!emitter) return undefined;

    return [
      this.identitySection(emitter),
      this.mainSection(emitter),
      this.emissionSection(emitter),
      this.shapeSection(emitter),
      this.velocitySection(emitter),
      this.forceSection(emitter),
      this.limitVelocitySection(emitter),
      this.noiseSection(emitter),
      this.colorSection(emitter),
      this.sizeSection(emitter),
      this.rotationSection(emitter),
      this.textureSection(emitter),
      this.rendererSection(emitter),
      this.trailsSection(emitter),
      this.collisionSection(emitter),
      this.subEmitterSection(emitter),
      this.lodSection(emitter),
      this.diagnosticsSection(emitter),
    ];
  }

  // --- Sections ---------------------------------------------------------

  private identitySection(emitter: ParticleEmitter): InspectorSection {
    const c = emitter.settings;
    const system = this.systemFor(emitter);
    return {
      id: `particle:id:${emitter.id}`,
      title: "Particle Emitter",
      badge: emitter.enabled ? (emitter.isPlaying() ? "PLAYING" : "IDLE") : "OFF",
      badgeTone: emitter.enabled ? (emitter.isPlaying() ? "trigger" : "solid") : "off",
      fields: [
        {
          kind: "text",
          label: "Name",
          value: emitter.name,
          placeholder: "Emitter",
          hint: "Also how sub-emitters reference this one, and how gameplay finds it: system.get(\"…\").",
          read: () => emitter.name,
          onChange: (v) => {
            emitter.name = v || "Emitter";
            system?.wireSubEmitters();
            this.markDirty();
          },
        },
        { kind: "info", label: "System", value: system?.name ?? "—" },
        {
          kind: "toggle",
          label: "Enabled",
          value: emitter.enabled,
          onText: "Active",
          offText: "Off",
          hint: "A disabled emitter stops simulating and hides, but stays registered and editable.",
          read: () => emitter.enabled,
          onChange: (v) => {
            emitter.setEnabled(v);
            if (v) emitter.play();
            this.markDirty();
          },
        },
        {
          kind: "objectRef",
          label: "Attached To",
          value: emitter.attached ? emitter.attached.name || emitter.attached.type : "— world space —",
          hint: "The scene object this emitter follows. It tracks that object's movement/rotation/scale every frame without ever modifying it.",
          read: () => (emitter.attached ? emitter.attached.name || emitter.attached.type : "— world space —"),
          onPick: () => this.armAttachPick(emitter),
          onClear: () => this.recordAttach(emitter, undefined, `Detach ${emitter.name}`),
          onDropObject: (dropped) => {
            if (this.opts.manager.emitterFromNode(dropped)) return; // attaching an emitter to another emitter's node is a loop nobody wants
            this.recordAttach(emitter, dropped, `Attach ${emitter.name} to ${dropped.name || dropped.type}`);
          },
        },
        {
          kind: "buttons",
          buttons: [
            { text: "▶ Play", title: "Play this emitter", onClick: () => { this.previewPlaying = true; emitter.play(); } },
            { text: "⏸ Pause", title: "Pause this emitter", onClick: () => emitter.pause() },
            { text: "↻ Restart", title: "Rewind and replay from the beginning", onClick: () => { this.previewPlaying = true; emitter.restart(); } },
          ],
        },
        {
          kind: "buttons",
          buttons: [
            { text: "⧉ Duplicate", title: "New emitter with the same settings", onClick: () => this.duplicateEmitter(emitter) },
            { text: "✕ Clear", title: "Kill every live particle right now", onClick: () => emitter.clear() },
            { text: "🗑 Delete", title: "Remove this emitter", danger: true, onClick: () => this.removeEmitter(emitter) },
          ],
        },
      ],
    };
  }

  private mainSection(emitter: ParticleEmitter): InspectorSection {
    const m = emitter.settings.main;
    return {
      id: `particle:main:${emitter.id}`,
      title: "Main",
      collapsible: true,
      defaultOpen: true,
      fields: [
        num("Duration", m.duration, 0.1, 0.01, (v) => this.edit(emitter, () => (m.duration = Math.max(0.01, v)))),
        tog("Loop", m.loop, (v) => this.edit(emitter, () => (m.loop = v)), "Restart the cycle when duration elapses."),
        tog("Prewarm", m.prewarm, (v) => this.edit(emitter, () => (m.prewarm = v)), "Start already populated, as though the effect had been running. Looping effects only."),
        tog("Play On Start", m.playOnStart, (v) => this.edit(emitter, () => (m.playOnStart = v))),
        rng("Start Delay", m.startDelay, 0.05, 0, (lo, hi) => this.edit(emitter, () => setRange(m.startDelay, lo, hi))),
        rng("Lifetime", m.startLifetime, 0.05, 0.01, (lo, hi) => this.edit(emitter, () => setRange(m.startLifetime, lo, hi))),
        rng("Start Speed", m.startSpeed, 0.1, undefined, (lo, hi) => this.edit(emitter, () => setRange(m.startSpeed, lo, hi))),
        rng("Start Size", m.startSize, 0.02, 0, (lo, hi) => this.edit(emitter, () => setRange(m.startSize, lo, hi))),
        rng("Start Rotation °", m.startRotation, 5, undefined, (lo, hi) => this.edit(emitter, () => setRange(m.startRotation, lo, hi))),
        col("Start Color", m.startColor, (rgb) => this.edit(emitter, () => (m.startColor = rgb))),
        rng("Start Alpha", m.startAlpha, 0.05, 0, (lo, hi) => this.edit(emitter, () => setRange(m.startAlpha, lo, hi))),
        num("Gravity", m.gravityModifier, 0.05, undefined, (v) => this.edit(emitter, () => (m.gravityModifier = v)), "Multiplier on real gravity (9.81). Negative floats particles upward."),
        num("Sim Speed", m.simulationSpeed, 0.1, 0, (v) => this.edit(emitter, () => (m.simulationSpeed = Math.max(0, v))), "Scales dt for this emitter only. 0 freezes it."),
        {
          kind: "select",
          label: "Space",
          value: m.simulationSpace,
          hint: "Local — particles move with the emitter. World — particles are left behind. Changing this clears live particles, since they're expressed in the space being left.",
          options: [
            { value: "local", label: "Local" },
            { value: "world", label: "World" },
          ],
          read: () => m.simulationSpace,
          onChange: (v) => {
            m.simulationSpace = v as "local" | "world";
            emitter.applyConfig(emitter.settings);
            this.markDirty();
            this.structureVersion++;
          },
        },
        {
          kind: "number",
          label: "Max Particles",
          value: m.maxParticles,
          step: 10,
          min: 1,
          hint: "Hard cap. The buffer is allocated to exactly this once, so changing it rebuilds the emitter (live particles are lost).",
          read: () => m.maxParticles,
          onChange: (v) => {
            const next = Math.max(1, Math.min(100000, Math.floor(v)));
            if (next === m.maxParticles) return;
            m.maxParticles = next;
            this.recreateEmitter(emitter);
          },
        },
        tog("Auto Seed", m.autoRandomSeed, (v) => this.edit(emitter, () => (m.autoRandomSeed = v)), "Re-seed on every play so repeated one-shots don't look identical. Turn off for a reproducible effect."),
        {
          kind: "number",
          label: "Seed",
          value: m.seed,
          step: 1,
          min: 0,
          hint: "Same seed + same dt sequence reproduces the effect exactly. Only used when Auto Seed is off.",
          read: () => m.seed,
          onChange: (v) => {
            emitter.setSeed(Math.max(0, Math.floor(v)));
            this.markDirty();
          },
        },
      ],
    };
  }

  private emissionSection(emitter: ParticleEmitter): InspectorSection {
    const e = emitter.settings.emission;
    const fields: InspectorField[] = [
      rng("Rate / sec", e.rateOverTime, 1, 0, (lo, hi) => this.edit(emitter, () => setRange(e.rateOverTime, lo, hi))),
      { kind: "info", label: "Bursts", value: `${e.bursts.length}` , read: () => `${e.bursts.length}` },
    ];
    e.bursts.forEach((burst, index) => {
      fields.push(num(`  #${index + 1} Time`, burst.time, 0.05, 0, (v) => this.edit(emitter, () => (burst.time = Math.max(0, v)))));
      fields.push(rng(`  #${index + 1} Count`, burst.count, 1, 0, (lo, hi) => this.edit(emitter, () => setRange(burst.count, lo, hi))));
      fields.push(num(`  #${index + 1} Cycles`, burst.cycles, 1, 1, (v) => this.edit(emitter, () => (burst.cycles = Math.max(1, Math.floor(v))))));
      fields.push(num(`  #${index + 1} Interval`, burst.interval, 0.05, 0.001, (v) => this.edit(emitter, () => (burst.interval = Math.max(0.001, v)))));
      fields.push(sld(`  #${index + 1} Chance`, burst.probability, 0, 1, (v) => this.edit(emitter, () => (burst.probability = v))));
      fields.push({
        kind: "buttons",
        buttons: [{ text: `🗑 Remove burst #${index + 1}`, danger: true, onClick: () => { e.bursts.splice(index, 1); this.markDirty(); this.structureVersion++; } }],
      });
    });
    fields.push({
      kind: "buttons",
      buttons: [{ text: "＋ Add burst", title: "A burst emits a batch at a fixed time in the cycle", onClick: () => { e.bursts.push({ time: 0, count: { min: 20, max: 30 }, cycles: 1, interval: 0.01, probability: 1 }); this.markDirty(); this.structureVersion++; } }],
    });

    return {
      id: `particle:emission:${emitter.id}`,
      title: "Emission",
      collapsible: true,
      defaultOpen: true,
      moduleToggle: { value: e.enabled, read: () => e.enabled, onChange: (v) => this.edit(emitter, () => (e.enabled = v)) },
      fields,
    };
  }

  private shapeSection(emitter: ParticleEmitter): InspectorSection {
    const s = emitter.settings.shape;
    const shapeSpecific: InspectorField[] =
      s.kind === "box"
        ? [
            {
              kind: "vec3",
              label: "Box Size",
              axisLabels: ["W", "H", "D"],
              value: s.boxSize,
              step: 0.1,
              read: () => s.boxSize,
              onChange: (axis, v) => this.edit(emitter, () => (s.boxSize[axis] = Math.max(0, v))),
            },
          ]
        : s.kind === "sphere"
          ? [num("Radius", s.radius, 0.05, 0.001, (v) => this.edit(emitter, () => (s.radius = Math.max(0.001, v))))]
          : [
              num("Radius", s.radius, 0.05, 0.001, (v) => this.edit(emitter, () => (s.radius = Math.max(0.001, v)))),
              num("Cone Angle °", s.coneAngle, 1, 0, (v) => this.edit(emitter, () => (s.coneAngle = THREE.MathUtils.clamp(v, 0, 89)))),
              num("Cone Height", s.coneHeight, 0.05, 0, (v) => this.edit(emitter, () => (s.coneHeight = Math.max(0, v)))),
            ];

    return {
      id: `particle:shape:${emitter.id}`,
      title: "Shape",
      badge: s.kind.toUpperCase(),
      collapsible: true,
      defaultOpen: true,
      moduleToggle: { value: s.enabled, read: () => s.enabled, onChange: (v) => this.edit(emitter, () => (s.enabled = v)) },
      fields: [
        {
          kind: "select",
          label: "Shape",
          value: s.kind,
          options: [
            { value: "box", label: "Box" },
            { value: "sphere", label: "Sphere" },
            { value: "cone", label: "Cone" },
          ],
          read: () => s.kind,
          onChange: (v) => {
            s.kind = v as EmitterShapeKind;
            this.markDirty();
            this.structureVersion++; // different shape = different rows
          },
        },
        ...shapeSpecific,
        sld("Thickness", s.radiusThickness, 0, 1, (v) => this.edit(emitter, () => (s.radiusThickness = v)), "0 emits from the surface shell only; 1 fills the whole volume."),
        num("Arc °", s.arc, 5, 0, (v) => this.edit(emitter, () => (s.arc = THREE.MathUtils.clamp(v, 0, 360))), "How much of the shape's circumference is used. 360 is the whole thing."),
        {
          kind: "vec3",
          label: "Offset",
          value: s.position,
          step: 0.05,
          read: () => s.position,
          onChange: (axis, v) => this.edit(emitter, () => (s.position[axis] = v)),
        },
        {
          kind: "vec3",
          label: "Rotation °",
          value: s.rotation,
          step: 5,
          read: () => s.rotation,
          onChange: (axis, v) => this.edit(emitter, () => (s.rotation[axis] = v)),
        },
        sld("Randomize Dir", s.randomizeDirection, 0, 1, (v) => this.edit(emitter, () => (s.randomizeDirection = v)), "Blends each particle's direction toward a fully random one."),
        tog("Align To Direction", s.alignToDirection, (v) => this.edit(emitter, () => (s.alignToDirection = v))),
      ],
    };
  }

  private velocitySection(emitter: ParticleEmitter): InspectorSection {
    const v = emitter.settings.velocity;
    return {
      id: `particle:velocity:${emitter.id}`,
      title: "Velocity",
      collapsible: true,
      moduleToggle: { value: v.enabled, read: () => v.enabled, onChange: (on) => this.edit(emitter, () => (v.enabled = on)) },
      fields: [
        rng("Linear X", v.linear.x, 0.1, undefined, (lo, hi) => this.edit(emitter, () => setRange(v.linear.x, lo, hi))),
        rng("Linear Y", v.linear.y, 0.1, undefined, (lo, hi) => this.edit(emitter, () => setRange(v.linear.y, lo, hi))),
        rng("Linear Z", v.linear.z, 0.1, undefined, (lo, hi) => this.edit(emitter, () => setRange(v.linear.z, lo, hi))),
        rng("Orbital", v.orbital, 0.1, undefined, (lo, hi) => this.edit(emitter, () => setRange(v.orbital, lo, hi))),
        rng("Radial", v.radial, 0.1, undefined, (lo, hi) => this.edit(emitter, () => setRange(v.radial, lo, hi))),
      ],
    };
  }

  private forceSection(emitter: ParticleEmitter): InspectorSection {
    const f = emitter.settings.force;
    return {
      id: `particle:force:${emitter.id}`,
      title: "Force",
      collapsible: true,
      moduleToggle: { value: f.enabled, read: () => f.enabled, onChange: (on) => this.edit(emitter, () => (f.enabled = on)) },
      fields: [
        rng("Force X", f.force.x, 0.1, undefined, (lo, hi) => this.edit(emitter, () => setRange(f.force.x, lo, hi))),
        rng("Force Y", f.force.y, 0.1, undefined, (lo, hi) => this.edit(emitter, () => setRange(f.force.y, lo, hi))),
        rng("Force Z", f.force.z, 0.1, undefined, (lo, hi) => this.edit(emitter, () => setRange(f.force.z, lo, hi))),
        num("Drag", f.drag, 0.05, 0, (val) => this.edit(emitter, () => (f.drag = Math.max(0, val))), "Velocity is scaled by (1 - drag·dt) each step."),
      ],
    };
  }

  private limitVelocitySection(emitter: ParticleEmitter): InspectorSection {
    const l = emitter.settings.limitVelocity;
    return {
      id: `particle:limit:${emitter.id}`,
      title: "Limit Velocity",
      collapsible: true,
      moduleToggle: { value: l.enabled, read: () => l.enabled, onChange: (on) => this.edit(emitter, () => (l.enabled = on)) },
      fields: [
        num("Speed Limit", l.speedLimit, 0.1, 0, (v) => this.edit(emitter, () => (l.speedLimit = Math.max(0, v)))),
        sld("Dampen", l.dampen, 0, 1, (v) => this.edit(emitter, () => (l.dampen = v)), "1 clamps immediately; lower values ease toward the limit like air resistance."),
      ],
    };
  }

  private noiseSection(emitter: ParticleEmitter): InspectorSection {
    const n = emitter.settings.noise;
    return {
      id: `particle:noise:${emitter.id}`,
      title: "Noise",
      collapsible: true,
      moduleToggle: { value: n.enabled, read: () => n.enabled, onChange: (on) => this.edit(emitter, () => (n.enabled = on)) },
      fields: [
        num("Strength", n.strength, 0.05, 0, (v) => this.edit(emitter, () => (n.strength = Math.max(0, v)))),
        num("Frequency", n.frequency, 0.05, 0.001, (v) => this.edit(emitter, () => (n.frequency = Math.max(0.001, v)))),
        num("Scroll Speed", n.scrollSpeed, 0.05, undefined, (v) => this.edit(emitter, () => (n.scrollSpeed = v))),
        num("Octaves", n.octaves, 1, 1, (v) => this.edit(emitter, () => (n.octaves = THREE.MathUtils.clamp(Math.floor(v), 1, 4))), "Each extra octave is another noise sample per particle per axis per frame — real cost."),
        sld("Damping", n.damping, 0, 1, (v) => this.edit(emitter, () => (n.damping = v))),
      ],
    };
  }

  private colorSection(emitter: ParticleEmitter): InspectorSection {
    const c = emitter.settings.colorOverLifetime;
    const fields: InspectorField[] = [];
    c.gradient.forEach((key, index) => {
      fields.push(sld(`  #${index + 1} Position`, key.t, 0, 1, (v) => this.edit(emitter, () => (key.t = v))));
      fields.push(col(`  #${index + 1} Color`, key.color, (rgb) => this.edit(emitter, () => (key.color = rgb))));
      fields.push(sld(`  #${index + 1} Alpha`, key.alpha, 0, 1, (v) => this.edit(emitter, () => (key.alpha = v))));
      fields.push({
        kind: "buttons",
        buttons: [{ text: `🗑 Remove stop #${index + 1}`, danger: true, onClick: () => { c.gradient.splice(index, 1); this.markDirty(); this.structureVersion++; } }],
      });
    });
    fields.push({
      kind: "buttons",
      buttons: [
        {
          text: "＋ Add stop",
          onClick: () => {
            c.gradient.push({ t: 1, color: [1, 1, 1], alpha: 0 });
            // Gradient evaluation assumes sorted keys — sorting on insert
            // rather than on every sample keeps the per-particle path a
            // straight walk.
            c.gradient.sort((a, b) => a.t - b.t);
            this.markDirty();
            this.structureVersion++;
          },
        },
      ],
    });
    return {
      id: `particle:color:${emitter.id}`,
      title: "Color over Lifetime",
      collapsible: true,
      moduleToggle: { value: c.enabled, read: () => c.enabled, onChange: (v) => this.edit(emitter, () => (c.enabled = v)) },
      fields,
    };
  }

  private sizeSection(emitter: ParticleEmitter): InspectorSection {
    const s = emitter.settings.sizeOverLifetime;
    const fields: InspectorField[] = [];
    s.curve.forEach((key, index) => {
      fields.push(sld(`  #${index + 1} Position`, key.t, 0, 1, (v) => this.edit(emitter, () => (key.t = v))));
      fields.push(num(`  #${index + 1} Scale`, key.v, 0.05, 0, (v) => this.edit(emitter, () => (key.v = Math.max(0, v)))));
      fields.push({
        kind: "buttons",
        buttons: [{ text: `🗑 Remove key #${index + 1}`, danger: true, onClick: () => { s.curve.splice(index, 1); this.markDirty(); this.structureVersion++; } }],
      });
    });
    fields.push({
      kind: "buttons",
      buttons: [{ text: "＋ Add key", onClick: () => { s.curve.push({ t: 1, v: 0 }); s.curve.sort((a, b) => a.t - b.t); this.markDirty(); this.structureVersion++; } }],
    });
    return {
      id: `particle:size:${emitter.id}`,
      title: "Size over Lifetime",
      collapsible: true,
      moduleToggle: { value: s.enabled, read: () => s.enabled, onChange: (v) => this.edit(emitter, () => (s.enabled = v)) },
      fields,
    };
  }

  private rotationSection(emitter: ParticleEmitter): InspectorSection {
    const r = emitter.settings.rotation_;
    return {
      id: `particle:rotation:${emitter.id}`,
      title: "Rotation",
      collapsible: true,
      moduleToggle: { value: r.enabled, read: () => r.enabled, onChange: (v) => this.edit(emitter, () => (r.enabled = v)) },
      fields: [rng("Angular Vel °/s", r.angularVelocity, 5, undefined, (lo, hi) => this.edit(emitter, () => setRange(r.angularVelocity, lo, hi)))],
    };
  }

  private textureSection(emitter: ParticleEmitter): InspectorSection {
    const t = emitter.settings.textureSheet;
    const rnd = emitter.settings.renderer;
    return {
      id: `particle:texture:${emitter.id}`,
      title: "Texture",
      collapsible: true,
      moduleToggle: { value: t.enabled, read: () => t.enabled, onChange: (v) => this.edit(emitter, () => (t.enabled = v)) },
      fields: [
        {
          kind: "text",
          label: "Texture Path",
          value: rnd.texturePath,
          placeholder: "./assets/textures/smoke.png",
          hint: "Resolved through the game's AssetLoader, so it's preloaded and base64-inlined by the production build like any other asset. Empty uses the built-in soft dot.",
          read: () => rnd.texturePath,
          onChange: (v) => {
            rnd.texturePath = v;
            emitter.setTexture(v ? this.opts.resolveTexture?.(v) : undefined);
            this.markDirty();
          },
        },
        num("Tiles X", t.tilesX, 1, 1, (v) => this.edit(emitter, () => (t.tilesX = Math.max(1, Math.floor(v))), true)),
        num("Tiles Y", t.tilesY, 1, 1, (v) => this.edit(emitter, () => (t.tilesY = Math.max(1, Math.floor(v))), true)),
        {
          kind: "select",
          label: "Frame Mode",
          value: t.mode,
          options: [
            { value: "lifetime", label: "Over Lifetime" },
            { value: "fps", label: "Fixed FPS" },
            { value: "speed", label: "By Speed" },
          ],
          read: () => t.mode,
          onChange: (v) => this.edit(emitter, () => (t.mode = v as typeof t.mode)),
        },
        num("FPS", t.fps, 1, 0, (v) => this.edit(emitter, () => (t.fps = Math.max(0, v)))),
        num("Cycles", t.cycles, 1, 0, (v) => this.edit(emitter, () => (t.cycles = Math.max(0, v)))),
        tog("Random Start Frame", t.startFrameRandom, (v) => this.edit(emitter, () => (t.startFrameRandom = v))),
      ],
    };
  }

  private rendererSection(emitter: ParticleEmitter): InspectorSection {
    const r = emitter.settings.renderer;
    return {
      id: `particle:renderer:${emitter.id}`,
      title: "Renderer",
      badge: r.mode.toUpperCase(),
      collapsible: true,
      defaultOpen: true,
      fields: [
        {
          kind: "select",
          label: "Mode",
          value: r.mode,
          hint: "Billboard faces the camera. Velocity aligns to travel direction. Stretched also scales by speed. Mesh instances real geometry.",
          options: [
            { value: "billboard", label: "Billboard" },
            { value: "velocity", label: "Velocity Aligned" },
            { value: "stretched", label: "Stretched" },
            { value: "mesh", label: "Mesh" },
          ],
          read: () => r.mode,
          onChange: (v) => {
            r.mode = v as typeof r.mode;
            emitter.applyConfig(emitter.settings);
            this.markDirty();
            this.structureVersion++;
          },
        },
        {
          kind: "select",
          label: "Blending",
          value: r.blending,
          options: [
            { value: "normal", label: "Normal (alpha)" },
            { value: "additive", label: "Additive (glow)" },
            { value: "multiply", label: "Multiply" },
          ],
          read: () => r.blending,
          onChange: (v) => {
            r.blending = v as typeof r.blending;
            emitter.applyConfig(emitter.settings);
            this.markDirty();
          },
        },
        sld("Opacity", r.opacity, 0, 1, (v) => this.editRenderer(emitter, () => (r.opacity = v))),
        num("Stretch", r.stretchFactor, 0.01, 0, (v) => this.editRenderer(emitter, () => (r.stretchFactor = Math.max(0, v)))),
        num("Render Order", r.renderOrder, 1, undefined, (v) => this.editRenderer(emitter, () => (r.renderOrder = Math.floor(v)))),
        tog("Depth Write", r.depthWrite, (v) => { r.depthWrite = v; emitter.applyConfig(emitter.settings); this.markDirty(); }, "Off for transparent particles — on makes them occlude each other in draw order."),
        tog("Depth Test", r.depthTest, (v) => { r.depthTest = v; emitter.applyConfig(emitter.settings); this.markDirty(); }),
        {
          kind: "select",
          label: "Sort",
          value: r.sortMode,
          hint: "Only matters for alpha blending — additive draw order is mathematically irrelevant, so leave this off unless you can see the difference.",
          options: [
            { value: "none", label: "None (fastest)" },
            { value: "byDistance", label: "By Distance" },
            { value: "oldestFirst", label: "Oldest First" },
            { value: "youngestFirst", label: "Youngest First" },
          ],
          read: () => r.sortMode,
          onChange: (v) => this.editRenderer(emitter, () => (r.sortMode = v as typeof r.sortMode)),
        },
        tog("Soft Particles", r.softParticles, (v) => { r.softParticles = v; emitter.applyConfig(emitter.settings); this.markDirty(); }, "Fades where particles intersect solid geometry. Needs a depth texture wired by the host — inert otherwise."),
      ],
    };
  }

  private trailsSection(emitter: ParticleEmitter): InspectorSection {
    const t = emitter.settings.trails;
    return {
      id: `particle:trails:${emitter.id}`,
      title: "Trails",
      collapsible: true,
      moduleToggle: {
        value: t.enabled,
        read: () => t.enabled,
        onChange: (v) => {
          t.enabled = v;
          // Trails allocate a whole pool, so turning them on/off is a
          // rebuild rather than a live toggle — that's what keeps a
          // trail-less emitter genuinely free of any trail cost.
          this.recreateEmitter(emitter);
        },
      },
      // Every row here goes through editRenderer (which re-applies the
      // whole config) rather than edit(): ParticleTrails keeps its own
      // copy of this module, so a plain in-place mutation never reaches
      // it. See ParticleEmitter.applyConfig.
      fields: [
        sld("Ratio", t.ratio, 0, 1, (v) => this.editRenderer(emitter, () => (t.ratio = v)), "Fraction of particles that get a trail. The pool is sized from this when the emitter is built, so lowering it takes effect at once while raising it past the original is capped until a rebuild (changing Max Points forces one)."),
        num("Trail Lifetime", t.lifetime, 0.05, 0.01, (v) => this.editRenderer(emitter, () => (t.lifetime = Math.max(0.01, v)))),
        num("Min Distance", t.minVertexDistance, 0.01, 0.001, (v) => this.editRenderer(emitter, () => (t.minVertexDistance = Math.max(0.001, v))), "How far the particle must move before a new point is recorded — the main cost control."),
        num("Max Points", t.maxPoints, 1, 2, (v) => { t.maxPoints = THREE.MathUtils.clamp(Math.floor(v), 2, 128); this.recreateEmitter(emitter); }),
        num("Width Start", t.widthStart, 0.01, 0, (v) => this.editRenderer(emitter, () => (t.widthStart = Math.max(0, v)))),
        num("Width End", t.widthEnd, 0.01, 0, (v) => this.editRenderer(emitter, () => (t.widthEnd = Math.max(0, v)))),
        tog("Inherit Particle Color", t.inheritParticleColor, (v) => this.editRenderer(emitter, () => (t.inheritParticleColor = v)), "Trail takes its colour from the particle it follows, tracking Color over Lifetime. Off uses the flat colour below."),
        col("Trail Color", t.color, (rgb) => this.editRenderer(emitter, () => (t.color = rgb))),
      ],
    };
  }

  private collisionSection(emitter: ParticleEmitter): InspectorSection {
    const c = emitter.settings.collision;
    return {
      id: `particle:collision:${emitter.id}`,
      title: "Collision",
      collapsible: true,
      moduleToggle: { value: c.enabled, read: () => c.enabled, onChange: (v) => this.edit(emitter, () => (c.enabled = v)) },
      fields: [
        {
          kind: "info",
          label: "Mode",
          value: "Ground plane",
          hint: "A single world-Y plane, deliberately — per-particle queries against real colliders or a depth buffer cost more than a playable's whole particle budget. Set the plane to your floor height.",
        },
        num("Plane Y", c.planeY, 0.05, undefined, (v) => this.edit(emitter, () => (c.planeY = v))),
        sld("Bounce", c.bounce, 0, 1, (v) => this.edit(emitter, () => (c.bounce = v))),
        sld("Friction", c.friction, 0, 1, (v) => this.edit(emitter, () => (c.friction = v))),
        sld("Lifetime Loss", c.lifetimeLoss, 0, 1, (v) => this.edit(emitter, () => (c.lifetimeLoss = v))),
        tog("Kill On Contact", c.killOnContact, (v) => this.edit(emitter, () => (c.killOnContact = v))),
      ],
    };
  }

  private subEmitterSection(emitter: ParticleEmitter): InspectorSection {
    const s = emitter.settings.subEmitters;
    const system = this.systemFor(emitter);
    const siblings = (system?.all ?? []).filter((e) => e !== emitter).map((e) => ({ value: e.name, label: e.name }));
    const fields: InspectorField[] = [];

    if (siblings.length === 0) {
      fields.push({ kind: "info", label: "No targets", value: "Add a second emitter first", hint: "A sub-emitter fires another emitter in the same system — there has to be one to fire." });
    }

    s.entries.forEach((entry, index) => {
      fields.push({
        kind: "select",
        label: `  #${index + 1} Trigger`,
        value: entry.trigger,
        options: [
          { value: "birth", label: "On Birth" },
          { value: "death", label: "On Death" },
          { value: "collision", label: "On Collision" },
        ],
        read: () => entry.trigger,
        onChange: (v) => this.edit(emitter, () => (entry.trigger = v as typeof entry.trigger)),
      });
      fields.push({
        kind: "select",
        label: `  #${index + 1} Emitter`,
        value: entry.emitter,
        options: siblings.length > 0 ? siblings : [{ value: entry.emitter, label: entry.emitter || "—" }],
        read: () => entry.emitter,
        onChange: (v) => this.edit(emitter, () => (entry.emitter = v)),
      });
      fields.push(num(`  #${index + 1} Count`, entry.count, 1, 1, (v) => this.edit(emitter, () => (entry.count = Math.max(1, Math.floor(v))))));
      fields.push(sld(`  #${index + 1} Chance`, entry.probability, 0, 1, (v) => this.edit(emitter, () => (entry.probability = v))));
      fields.push(sld(`  #${index + 1} Inherit Vel`, entry.inheritVelocity, 0, 1, (v) => this.edit(emitter, () => (entry.inheritVelocity = v))));
      fields.push({
        kind: "buttons",
        buttons: [{ text: `🗑 Remove #${index + 1}`, danger: true, onClick: () => { s.entries.splice(index, 1); this.markDirty(); this.structureVersion++; } }],
      });
    });

    if (siblings.length > 0) {
      fields.push({
        kind: "buttons",
        buttons: [
          {
            text: "＋ Add sub-emitter",
            onClick: () => {
              s.entries.push({ trigger: "death", emitter: siblings[0].value, count: 1, probability: 1, inheritVelocity: 0 });
              this.markDirty();
              this.structureVersion++;
            },
          },
        ],
      });
    }

    return {
      id: `particle:sub:${emitter.id}`,
      title: "Sub Emitters",
      collapsible: true,
      moduleToggle: { value: s.enabled, read: () => s.enabled, onChange: (v) => this.edit(emitter, () => (s.enabled = v)) },
      fields,
    };
  }

  private lodSection(emitter: ParticleEmitter): InspectorSection {
    const l = emitter.settings.lod;
    return {
      id: `particle:lod:${emitter.id}`,
      title: "Quality / LOD",
      collapsible: true,
      moduleToggle: { value: l.enabled, read: () => l.enabled, onChange: (v) => this.edit(emitter, () => (l.enabled = v)) },
      fields: [
        num("Cull Distance", l.cullDistance, 1, 0, (v) => this.edit(emitter, () => (l.cullDistance = Math.max(0, v))), "Beyond this distance from the camera the emitter stops simulating entirely. 0 disables the check."),
        {
          kind: "select",
          label: "Global Quality",
          value: this.opts.manager.getQuality(),
          hint: "Scales emission rate and burst counts across every effect at once — the same authored effect running thinner on a low-end device.",
          options: [
            { value: "high", label: "High (100%)" },
            { value: "medium", label: "Medium (65%)" },
            { value: "low", label: "Low (35%)" },
          ],
          read: () => this.opts.manager.getQuality(),
          onChange: (v) => this.opts.manager.setQuality(v as "high" | "medium" | "low"),
        },
      ],
    };
  }

  /**
   * Live cost readout.
   *
   * Every number here is measured rather than estimated — active/max come
   * straight off the buffers, draw calls off the renderers, bytes off the
   * real typed-array allocations, and the update time off a
   * `performance.now()` pair around the actual simulation pass. A guessed
   * cost readout is worse than none, because it gets trusted.
   */
  private diagnosticsSection(emitter: ParticleEmitter): InspectorSection {
    const manager = this.opts.manager;
    return {
      id: `particle:diag:${emitter.id}`,
      title: "Diagnostics",
      collapsible: true,
      defaultOpen: true,
      fields: [
        {
          kind: "info",
          label: "This emitter",
          value: "—",
          read: () => `${emitter.activeParticles} / ${emitter.maxParticles} particles`,
          readAccent: () => (emitter.activeParticles >= emitter.maxParticles ? "warn" : "good"),
        },
        { kind: "info", label: "Emitter buffers", value: "—", read: () => formatBytes(emitter.byteLength()) },
        { kind: "info", label: "Draw calls", value: "—", read: () => `${emitter.drawCalls}` },
        { kind: "info", label: "Scene systems", value: "—", read: () => `${manager.getStats().systems} systems · ${manager.getStats().emitters} emitters` },
        {
          kind: "info",
          label: "Scene particles",
          value: "—",
          read: () => {
            const s = manager.getStats();
            return `${s.activeParticles} / ${s.maxParticles}`;
          },
        },
        { kind: "info", label: "Simulating", value: "—", read: () => `${manager.getStats().simulating} emitters` },
        { kind: "info", label: "Scene draw calls", value: "—", read: () => `${manager.getStats().drawCalls}` },
        { kind: "info", label: "Total memory", value: "—", read: () => formatBytes(manager.getStats().bufferBytes) },
        {
          kind: "info",
          label: "Update cost",
          value: "—",
          hint: "Measured wall time inside the last particle update pass, for every system in the scene.",
          read: () => `${manager.getStats().lastUpdateMs.toFixed(2)} ms`,
          readAccent: () => (manager.getStats().lastUpdateMs > 2 ? "warn" : "good"),
        },
      ],
    };
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * Mutate the live config, record it, and mark dirty. The preview picks
   * the change up on the very next frame — no rebuild, no restart.
   *
   * `label`/`mergeKey` are optional only so the many call sites stay
   * readable; anything without a merge key becomes its own undo step.
   */
  private edit(emitter: ParticleEmitter, mutate: () => void, refreshRenderer = false, label = "Edit emitter", mergeKey?: string): void {
    this.record(emitter, label, mutate, mergeKey, refreshRenderer);
  }

  /** Same, for fields that need the renderer's uniforms re-pushed but not a rebuild. */
  private editRenderer(emitter: ParticleEmitter, mutate: () => void, label = "Edit renderer", mergeKey?: string): void {
    this.record(emitter, label, mutate, mergeKey, true);
  }

  /**
   * Rebuilds an emitter in place.
   *
   * Needed only for changes the running instance genuinely can't absorb —
   * `maxParticles` (the buffer is allocated once, by design) and the trail
   * pool. Everything else is a live mutation, which is why this is rare
   * enough to afford losing the current particles.
   */
  private recreateEmitter(emitter: ParticleEmitter): void {
    const system = this.systemFor(emitter);
    if (!system) return;
    const config = cloneEmitterConfig(emitter.settings);
    const attached = emitter.attached;
    const wasSelected = this.opts.selection.object === emitter.node;
    system.removeEmitter(emitter);
    const rebuilt = system.addEmitter(config);
    rebuilt.persisted = true;
    rebuilt.attached = attached;
    rebuilt.setWorldRoot(this.opts.manager.group);
    system.wireSubEmitters();
    if (wasSelected) this.opts.selection.selectObject(rebuilt.node, "api");
    // play() rather than autoStart(): a rebuild triggered mid-preview
    // should resume regardless of playOnStart, since the emitter it
    // replaced was demonstrably running.
    if (this.previewPlaying) rebuilt.play();
    else rebuilt.autoStart();
    this.markDirty();
    this.structureVersion++;
  }

  private armAttachPick(emitter: ParticleEmitter): void {
    this.opts.picker.beginPickRequest({
      validate: (object) =>
        this.opts.manager.emitterFromNode(object) ? { ok: false, reason: "That's a particle emitter — pick a scene object for it to follow." } : { ok: true, reason: "" },
      onResolve: (object) => {
        this.recordAttach(emitter, object, `Attach ${emitter.name} to ${object.name || object.type}`);
        // Back to the emitter, not the object just picked: the panel you
        // were configuring is the one you want to still be looking at.
        this.opts.selection.selectObject(emitter.node, "api");
      },
    });
  }

  /**
   * Re-parents an emitter onto a scene object (or detaches it), as one
   * undo step.
   *
   * `attached` is a live object reference, not part of the serialized
   * config, so the generic `record()` path can't capture it — this
   * captures both the reference and the config's own attach fields so an
   * undo restores the emitter to exactly the thing it was following.
   */
  private recordAttach(emitter: ParticleEmitter, target: THREE.Object3D | undefined, label: string): void {
    const previous = emitter.attached;
    const previousName = emitter.settings.attachName;
    const previousPath = emitter.settings.attachPath;

    const apply = (object: THREE.Object3D | undefined, name: string, path: string): void => {
      emitter.attached = object;
      emitter.settings.attachName = name;
      // Cleared on detach so a stale path can't resurrect the old
      // attachment at the next load; re-derived on save for an attachment.
      emitter.settings.attachPath = path;
      this.structureVersion++;
      this.markDirty();
    };

    apply(target, target?.name ?? "", target ? emitter.settings.attachPath : "");
    if (this.opts.history.isApplying) return;

    this.opts.history.push({
      label,
      undo: () => apply(previous, previousName, previousPath),
      redo: () => apply(target, target?.name ?? "", target ? previousPath : ""),
    });
  }

  private emitterFor(object: THREE.Object3D | undefined): ParticleEmitter | undefined {
    return object ? this.opts.manager.emitterFromNode(object) : undefined;
  }

  private systemFor(emitter: ParticleEmitter): ParticleSystem | undefined {
    return this.opts.manager.all.find((system) => system.all.includes(emitter));
  }

  /** The selection, unless it's a particle node — creating an effect "on" another effect isn't a thing. */
  private selectedSceneObject(): THREE.Object3D | undefined {
    const selected = this.opts.selection.object;
    if (!selected) return undefined;
    if (this.opts.manager.emitterFromNode(selected) || this.opts.manager.systemFromNode(selected)) return undefined;
    return selected;
  }

  private uniqueSystemName(base: string): string {
    const taken = new Set(this.opts.manager.all.map((s) => s.name));
    if (!taken.has(base)) return base;
    let n = ++this.newCount;
    let candidate = `${base} ${n}`;
    while (taken.has(candidate)) candidate = `${base} ${++n}`;
    return candidate;
  }

  private uniqueEmitterName(system: ParticleSystem, base: string): string {
    const taken = new Set(system.all.map((e) => e.name));
    if (!taken.has(base)) return base;
    let n = 1;
    let candidate = `${base} ${n}`;
    while (taken.has(candidate)) candidate = `${base} ${++n}`;
    return candidate;
  }

  private markDirty(): void {
    this.dirty = true;
    this.opts.onDirty?.();
  }

  // ---------------------------------------------------------------------
  // Undo / redo
  // ---------------------------------------------------------------------

  /**
   * Runs `mutate` and records it as one undoable property change.
   *
   * Clones the emitter's config before and after and restores by handing
   * the clone back through `applyConfig` — which keeps the *same emitter
   * instance*, so sub-emitters resolving it by name and anything holding a
   * reference stay valid. `mergeKey` collapses a slider drag into one
   * entry (see EditorHistory.push).
   */
  private record(emitter: ParticleEmitter, label: string, mutate: () => void, mergeKey?: string, restructure = false): void {
    if (this.opts.history.isApplying) {
      mutate();
      if (restructure) emitter.applyConfig(emitter.settings);
      return;
    }
    const before = cloneEmitterConfig(emitter.settings);
    mutate();
    if (restructure) emitter.applyConfig(emitter.settings);
    const after = cloneEmitterConfig(emitter.settings);
    this.opts.history.push({
      label,
      // Auto-derived per field when the caller doesn't name one. The
      // Inspector has ~90 property rows, and threading an explicit key
      // through every one is a lot of surface for a value that is, by
      // definition, "which row is this". A closure's own source text is
      // exactly that: stable across every call from one row, different
      // between rows. This is editor-only code and never minified, so the
      // text is the authored source; and the worst case if two rows ever
      // did collide is coarser undo granularity, not incorrect state.
      mergeKey: mergeKey ?? `pt:${emitter.id}:${fieldKey(mutate)}`,
      undo: () => this.restoreEmitter(emitter, before),
      redo: () => this.restoreEmitter(emitter, after),
    });
    this.markDirty();
  }

  private restoreEmitter(emitter: ParticleEmitter, config: ParticleEmitterConfig): void {
    emitter.applyConfig(cloneEmitterConfig(config));
    // applyConfig writes the node from the config, but an *unattached*
    // emitter's syncTransform never pushes config -> node on its own — so
    // without this the very next frame's adoptNodeTransform would read the
    // stale node back over the value the undo just restored, silently
    // reverting it.
    emitter.applyNodeTransform();
    this.systemFor(emitter)?.wireSubEmitters();
    // The Inspector closures captured the *previous* config object, so
    // they must be rebuilt or edits after an undo would write into a
    // detached object.
    this.structureVersion++;
    this.markDirty();
  }

  /**
   * Records a create/duplicate of an emitter so undo removes it and redo
   * brings the same instance back.
   *
   * `keepAlive` removal is what makes redo restore the identical object
   * rather than a copy; `discard("unapplied")` releases it once the
   * command can never be replayed, since a detached emitter still owns its
   * GPU buffers.
   */
  private recordEmitterCreate(system: ParticleSystem, emitter: ParticleEmitter, label: string): void {
    this.opts.history.push({
      label,
      undo: () => {
        if (this.opts.selection.object === emitter.node) this.opts.selection.selectObject(undefined, "api");
        system.removeEmitter(emitter, true);
        system.wireSubEmitters();
        this.structureVersion++;
        this.markDirty();
      },
      redo: () => {
        system.readdEmitter(emitter);
        system.wireSubEmitters();
        this.structureVersion++;
        this.markDirty();
      },
      discard: (state) => {
        if (state === "unapplied") emitter.dispose();
      },
    });
    this.markDirty();
  }

  /** Begin/end of a gizmo drag — routed here by EditorRoot from SceneInspector. */
  onGizmoDrag(dragging: boolean): void {
    const emitter = this.selected;
    if (dragging) {
      this.dragSnapshot = emitter ? { emitter, config: cloneEmitterConfig(emitter.settings) } : undefined;
      return;
    }
    const snapshot = this.dragSnapshot;
    this.dragSnapshot = undefined;
    if (!snapshot || snapshot.emitter !== emitter || !emitter) return;
    // The per-frame adoptNodeTransform has already folded the drag into the
    // config by now, so this is the post-drag state.
    const after = cloneEmitterConfig(emitter.settings);
    const moved =
      JSON.stringify(snapshot.config.position) !== JSON.stringify(after.position) ||
      JSON.stringify(snapshot.config.rotation) !== JSON.stringify(after.rotation) ||
      JSON.stringify(snapshot.config.scale) !== JSON.stringify(after.scale);
    if (!moved) return; // a click that selected without moving anything
    this.opts.history.push({
      label: `Transform ${emitter.name}`,
      undo: () => this.restoreEmitter(emitter, snapshot.config),
      redo: () => this.restoreEmitter(emitter, after),
    });
    this.markDirty();
  }

  /** The preset list the toolbar's dropdown is built from. */
  static get presets(): { key: string; label: string; description: string }[] {
    return PARTICLE_PRESETS.map((p) => ({ key: p.key, label: p.label, description: p.description }));
  }
}

// ---------------------------------------------------------------------------
// Field builders — small, because sixteen module sections built by hand would
// otherwise be a wall of near-identical object literals.
// ---------------------------------------------------------------------------

function num(label: string, value: number, step: number, min: number | undefined, onChange: (v: number) => void, hint?: string): InspectorField {
  return { kind: "number", label, value, step, min, hint, read: undefined, onChange };
}

function tog(label: string, value: boolean, onChange: (v: boolean) => void, hint?: string): InspectorField {
  return { kind: "toggle", label, value, hint, onText: "On", offText: "Off", onChange };
}

function rng(label: string, range: ScalarRange, step: number, clampMin: number | undefined, onChange: (lo: number, hi: number) => void, hint?: string): InspectorField {
  return { kind: "range", label, min: range.min, max: range.max, step, clampMin, hint, read: () => [range.min, range.max], onChange };
}

function col(label: string, value: [number, number, number], onChange: (rgb: [number, number, number]) => void, hint?: string): InspectorField {
  return { kind: "color", label, value, hint, onChange };
}

function sld(label: string, value: number, min: number, max: number, onChange: (v: number) => void, hint?: string): InspectorField {
  return { kind: "slider", label, value, min, max, step: 0.01, hint, onChange };
}

/**
 * A short, stable identifier for the Inspector row a mutation came from,
 * derived from the closure's own source text.
 *
 * Hashed rather than used raw only to keep the key small — the full source
 * would work identically. FNV-1a: four ops per character, no allocation
 * beyond the string itself, and collision resistance far beyond the ~90
 * distinct rows this ever sees.
 */
function fieldKey(fn: () => void): string {
  const text = String(fn);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function setRange(range: ScalarRange, min: number, max: number): void {
  range.min = min;
  range.max = max;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Re-exported so Game.ts can hand the emitter config type through without importing from two places. */
export type { ParticleEmitterConfig };
