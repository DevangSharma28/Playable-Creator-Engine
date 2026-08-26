import * as THREE from "three";
import { propertyCommand, type EditorHistory } from "./EditorHistory";
import type { InspectorField, InspectorSection } from "./InspectorSections";
import { SectionRenderer } from "./SectionRenderer";
import type { SceneEnvironment } from "../scene/SceneEnvironment";
import type { SceneEnvData } from "../scene/SceneEnvTypes";

export interface EditorEnvironmentOptions {
  /** The dock pane this renders into. Its own element, not the Inspector's — the environment isn't a property of the selected object. */
  container: HTMLElement;
  environment: SceneEnvironment;
  /** The shared editor history. Environment edits land on the same stack as collider and particle edits, so one Ctrl+Z walks back through whatever actually happened, in order. */
  history: EditorHistory;
  /** Fired the first time an environment edit happens in a session, so Exit Editor can show there's something to save. */
  onDirty?: () => void;
  /** The camera the editor is currently orbiting with — the source for "Use editor view". Optional; the button is omitted without it. */
  getViewCamera?: () => THREE.Camera;
}

const PROJECTION_OPTIONS = [
  { value: "perspective", label: "Perspective" },
  { value: "orthographic", label: "Orthographic" },
];

const AMBIENT_MODE_OPTIONS = [
  { value: "ambient", label: "Ambient (flat)" },
  { value: "hemisphere", label: "Hemisphere (sky/ground)" },
];

const BACKGROUND_OPTIONS = [
  { value: "none", label: "None (transparent)" },
  { value: "color", label: "Solid colour" },
  { value: "texture", label: "Texture (equirect)" },
];

const ENVIRONMENT_OPTIONS = [
  { value: "none", label: "None" },
  { value: "room", label: "Generated room (IBL)" },
  { value: "background", label: "Background texture" },
];

const FOG_OPTIONS = [
  { value: "none", label: "None" },
  { value: "linear", label: "Linear (near / far)" },
  { value: "exp2", label: "Exponential² (density)" },
];

const TONE_MAPPING_OPTIONS = [
  { value: "none", label: "None" },
  { value: "linear", label: "Linear" },
  { value: "reinhard", label: "Reinhard" },
  { value: "cineon", label: "Cineon" },
  { value: "aces", label: "ACES Filmic" },
  { value: "agx", label: "AgX" },
  { value: "neutral", label: "Khronos Neutral" },
];

const SHADOW_TYPE_OPTIONS = [
  { value: "basic", label: "Basic (hard, cheapest)" },
  { value: "pcf", label: "PCF" },
  { value: "pcfsoft", label: "PCF Soft" },
  { value: "vsm", label: "VSM" },
];

const SHADOW_MAP_SIZES = [256, 512, 1024, 2048, 4096].map((n) => ({ value: String(n), label: `${n} × ${n}` }));

/**
 * The Environment dock: Camera, Lighting, and World, edited live against
 * the running scene.
 *
 * ## Dev-only, by construction
 *
 * Nothing imports this except EditorRoot, which Game only ever constructs
 * behind `import.meta.env.DEV`. So in a production build the whole module —
 * and every option table above it — is statically unreachable and drops out
 * of the bundle, exactly like the collider and particle editors. The half
 * that *does* ship is SceneEnvironment, which just reads environment.json
 * and applies it once at boot.
 *
 * ## Structure vs. values
 *
 * The panel rebuilds its rows only when the *shape* of the config changes —
 * a fog mode swapping near/far for density, a light gaining shadow rows, a
 * directional being added or removed. Ordinary value edits leave the DOM
 * alone and flow back through each row's own `read()` on the next frame.
 * Rebuilding on every change would destroy the `<input>` under the cursor
 * on every keystroke; that's the same build/refresh split EditorInspector
 * runs on, and `structureKey()` below is this panel's equivalent of an
 * InspectorSectionProvider's `version`.
 *
 * ## Undo
 *
 * Every edit snapshots the whole config before and after and restores by
 * writing it back wholesale (SceneEnvironment.restore). A field-level
 * command would be smaller but couldn't express adding or removing a light,
 * and the config is a few hundred bytes — cloning it per history entry
 * costs nothing measurable. Slider drags coalesce through `mergeKey`, so
 * one drag is one undo step rather than two hundred.
 */
export class EditorEnvironment {
  private readonly container: HTMLElement;
  private readonly environment: SceneEnvironment;
  private readonly history: EditorHistory;
  private readonly onDirty: (() => void) | undefined;
  private readonly getViewCamera: (() => THREE.Camera) | undefined;
  private readonly sections = new SectionRenderer();

  private dirty = false;
  /** Last-rendered structural signature — see the class comment. */
  private lastStructure = "";

  /** Scratch for the "Use editor view" button, so reading the orbit camera's transform allocates nothing. */
  private readonly scratchEuler = new THREE.Euler();

  constructor(options: EditorEnvironmentOptions) {
    this.container = options.container;
    this.environment = options.environment;
    this.history = options.history;
    this.onDirty = options.onDirty;
    this.getViewCamera = options.getViewCamera;
    this.rebuild();
  }

  /** Whether anything here has changed since the last successful write to src/game/environment.json. */
  get hasChanges(): boolean {
    return this.dirty;
  }

  markSaved(): void {
    this.dirty = false;
  }

  /** JSON-ready config, for POST /save-environment. */
  serialize(): SceneEnvData {
    return this.environment.snapshot();
  }

  /** Once per editor frame, from EditorRoot.update(). */
  update(): void {
    if (this.structureKey() !== this.lastStructure) {
      this.rebuild();
      return;
    }
    this.sections.refresh();
  }

  dispose(): void {
    this.sections.reset();
    this.container.innerHTML = "";
  }

  // ---------------------------------------------------------------------

  /**
   * Everything that changes which *rows* exist. Values are deliberately
   * absent: a colour or an intensity changing must not rebuild the DOM.
   */
  private structureKey(): string {
    const { camera, ambient, world, directionals } = this.environment.config;
    return [
      camera.projection,
      camera.follow ? "follow" : "fixed",
      ambient.mode,
      ambient.enabled ? "on" : "off",
      world.backgroundMode,
      world.environmentSource,
      world.fogMode,
      world.shadowsEnabled ? "sh" : "nosh",
      directionals.map((d) => `${d.id}:${d.castShadow ? 1 : 0}:${d.enabled ? 1 : 0}`).join(","),
    ].join("|");
  }

  private rebuild(): void {
    this.lastStructure = this.structureKey();
    this.sections.reset();
    this.container.innerHTML = "";
    for (const section of this.describe()) {
      this.sections.appendSection(this.container, section);
    }
  }

  /**
   * Applies a mutation and records it as one undo step.
   *
   * The mutation runs first and the command's `redo` is a re-application,
   * matching EditorHistory.push's contract — the normal edit path never
   * goes through the history at all.
   */
  private edit(label: string, mergeKey: string | undefined, mutate: () => void): void {
    const before = this.environment.snapshot();
    mutate();
    const after = this.environment.snapshot();
    this.history.push(
      propertyCommand({
        label,
        mergeKey,
        before,
        after,
        apply: (data) => this.environment.restore(data),
      })
    );
    const wasClean = !this.dirty;
    this.dirty = true;
    // Only the first edit of a session needs to announce itself — the dev
    // page's flag is a boolean, and firing on every slider event would be
    // hundreds of no-op repaints per drag.
    if (wasClean) this.onDirty?.();
  }

  private describe(): InspectorSection[] {
    return [this.cameraSection(), ...this.lightingSections(), this.worldSection()];
  }

  // ---------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------

  private cameraSection(): InspectorSection {
    const camera = this.environment.config.camera;
    const set = (label: string, mergeKey: string | undefined, patch: () => Parameters<SceneEnvironment["updateCamera"]>[0]): void => {
      this.edit(label, mergeKey, () => this.environment.updateCamera(patch()));
    };

    const fields: InspectorField[] = [
      {
        kind: "select",
        label: "Projection",
        hint: "Orthographic drops perspective foreshortening entirely — the isometric/2.5D look.",
        value: camera.projection,
        options: PROJECTION_OPTIONS,
        read: () => this.environment.config.camera.projection,
        onChange: (value) => set("Camera Projection", "env-cam-projection", () => ({ projection: value as "perspective" | "orthographic" })),
      },
    ];

    if (camera.projection === "perspective") {
      fields.push(
        {
          kind: "number",
          label: "FOV°",
          hint: "Vertical field of view. Larger exaggerates depth and shows more of the scene.",
          value: camera.fov,
          step: 1,
          min: 1,
          read: () => this.environment.config.camera.fov,
          onChange: (value) => set("Camera FOV", "env-cam-fov", () => ({ fov: value })),
        },
        {
          kind: "number",
          label: "Ref. aspect",
          hint: "Aspect this shot was framed at. On a narrower viewport the FOV widens to keep the same horizontal framing — set 0.5625 for a 9:16 design, or 0 to disable.",
          value: camera.referenceAspect,
          step: 0.01,
          min: 0,
          read: () => this.environment.config.camera.referenceAspect,
          onChange: (value) => set("Camera Reference Aspect", "env-cam-refaspect", () => ({ referenceAspect: value })),
        }
      );
    } else {
      fields.push({
        kind: "number",
        label: "Ortho size",
        hint: "Vertical half-extent in world units. Width follows the live aspect.",
        value: camera.orthoSize,
        step: 0.5,
        min: 0.01,
        read: () => this.environment.config.camera.orthoSize,
        onChange: (value) => set("Camera Ortho Size", "env-cam-orthosize", () => ({ orthoSize: value })),
      });
    }

    fields.push(
      {
        kind: "number",
        label: "Near",
        hint: "Anything closer is clipped. Keep it as far out as the shot allows — a tiny near plane against a large far plane spends the whole depth buffer up close and causes z-fighting.",
        value: camera.near,
        step: 0.01,
        min: 0.0001,
        read: () => this.environment.config.camera.near,
        onChange: (value) => set("Camera Near", "env-cam-near", () => ({ near: value })),
      },
      {
        kind: "number",
        label: "Far",
        hint: "Anything further is clipped. There's no reason to keep it much past where fog fully occludes.",
        value: camera.far,
        step: 10,
        min: 0.01,
        read: () => this.environment.config.camera.far,
        onChange: (value) => set("Camera Far", "env-cam-far", () => ({ far: value })),
      },
      {
        kind: "slider",
        label: "Zoom",
        value: camera.zoom,
        min: 0.1,
        max: 4,
        step: 0.01,
        read: () => this.environment.config.camera.zoom,
        onChange: (value) => set("Camera Zoom", "env-cam-zoom", () => ({ zoom: value })),
      },
      {
        kind: "toggle",
        label: "Follow target",
        hint: "On: the rig tracks the player every frame and Offset frames the shot. Off: the camera stays exactly where Position/Rotation put it.",
        value: camera.follow,
        onText: "Following",
        offText: "Fixed",
        read: () => this.environment.config.camera.follow,
        onChange: (value) => set("Camera Follow", undefined, () => ({ follow: value })),
      }
    );

    if (camera.follow) {
      fields.push(
        {
          kind: "vec3",
          label: "Offset",
          hint: "Rig position relative to the focus point — this is the framing control.",
          value: camera.offset,
          step: 0.25,
          read: () => this.environment.config.camera.offset,
          onChange: (axis, value) => {
            const next = [...this.environment.config.camera.offset] as [number, number, number];
            next[axis] = value;
            set("Camera Offset", "env-cam-offset", () => ({ offset: next }));
          },
        },
        {
          kind: "number",
          label: "Look-at height",
          hint: "How far above the focus point the camera aims.",
          value: camera.lookAtHeight,
          step: 0.05,
          read: () => this.environment.config.camera.lookAtHeight,
          onChange: (value) => set("Camera Look-at Height", "env-cam-lookat", () => ({ lookAtHeight: value })),
        },
        {
          kind: "slider",
          label: "Damping",
          hint: "Follow stiffness. Higher catches up faster; frame-rate independent either way.",
          value: camera.damping,
          min: 0.5,
          max: 20,
          step: 0.01,
          read: () => this.environment.config.camera.damping,
          onChange: (value) => set("Camera Damping", "env-cam-damping", () => ({ damping: value })),
        }
      );
    } else {
      fields.push(
        {
          kind: "vec3",
          label: "Position",
          value: camera.position,
          step: 0.25,
          read: () => this.environment.config.camera.position,
          onChange: (axis, value) => {
            const next = [...this.environment.config.camera.position] as [number, number, number];
            next[axis] = value;
            set("Camera Position", "env-cam-position", () => ({ position: next }));
          },
        },
        {
          kind: "vec3",
          label: "Rotation°",
          value: camera.rotation,
          step: 1,
          read: () => this.environment.config.camera.rotation,
          onChange: (axis, value) => {
            const next = [...this.environment.config.camera.rotation] as [number, number, number];
            next[axis] = value;
            set("Camera Rotation", "env-cam-rotation", () => ({ rotation: next }));
          },
        }
      );
    }

    if (this.getViewCamera) {
      fields.push({
        kind: "buttons",
        label: "",
        buttons: [
          {
            text: "⤓ Use editor view",
            title: "Copy the orbit camera's current position and rotation into the authored shot, and switch to Fixed so it sticks",
            onClick: () => this.captureViewCamera(),
          },
        ],
      });
    }

    fields.push({
      kind: "info",
      label: "Live position",
      hint: "Where the gameplay camera actually is this frame — driven by the follow rig while Follow is on.",
      value: "—",
      read: () => formatVector(this.currentCameraPosition()),
    });

    return {
      id: "env-camera",
      title: "📷 Camera",
      fields,
      collapsible: true,
      defaultOpen: true,
    };
  }

  /**
   * Freezes the shot where the editor is currently looking from.
   *
   * Also flips `follow` off in the same edit — copying a hand-picked
   * transform into a config the follow rig overwrites on the very next
   * frame would look like the button did nothing.
   */
  private captureViewCamera(): void {
    const view = this.getViewCamera?.();
    if (!view) return;
    view.updateMatrixWorld();
    this.scratchEuler.setFromQuaternion(view.getWorldQuaternion(new THREE.Quaternion()));
    const position = view.getWorldPosition(new THREE.Vector3());
    this.edit("Camera From View", undefined, () =>
      this.environment.updateCamera({
        follow: false,
        position: [position.x, position.y, position.z],
        rotation: [
          THREE.MathUtils.radToDeg(this.scratchEuler.x),
          THREE.MathUtils.radToDeg(this.scratchEuler.y),
          THREE.MathUtils.radToDeg(this.scratchEuler.z),
        ],
      })
    );
  }

  private currentCameraPosition(): THREE.Vector3 {
    // The rig's own camera, not the editor's — this readout is about what
    // the game will ship, which is the point of having it while orbiting
    // somewhere else entirely.
    return this.environment.config.camera.follow
      ? cameraPositionOf(this.environment)
      : new THREE.Vector3(...this.environment.config.camera.position);
  }

  // ---------------------------------------------------------------------
  // Lighting
  // ---------------------------------------------------------------------

  private lightingSections(): InspectorSection[] {
    const sections: InspectorSection[] = [this.ambientSection()];
    for (const light of this.environment.config.directionals) {
      sections.push(this.directionalSection(light.id));
    }
    sections.push({
      id: "env-lighting-actions",
      title: "💡 Lighting",
      fields: [
        {
          kind: "buttons",
          buttons: [
            {
              text: "＋ Directional Light",
              title: "Add another directional light to the scene",
              onClick: () => this.edit("Add Directional Light", undefined, () => this.environment.addDirectional()),
            },
          ],
        },
      ],
    });
    return sections;
  }

  private ambientSection(): InspectorSection {
    const ambient = this.environment.config.ambient;
    const set = (label: string, mergeKey: string | undefined, patch: Parameters<SceneEnvironment["updateAmbient"]>[0]): void => {
      this.edit(label, mergeKey, () => this.environment.updateAmbient(patch));
    };

    const fields: InspectorField[] = [
      {
        kind: "select",
        label: "Mode",
        hint: "Ambient adds one flat term everywhere. Hemisphere fades sky colour above to ground colour below — more shape for the same cost.",
        value: ambient.mode,
        options: AMBIENT_MODE_OPTIONS,
        read: () => this.environment.config.ambient.mode,
        onChange: (value) => set("Ambient Mode", undefined, { mode: value as "ambient" | "hemisphere" }),
      },
      {
        kind: "color",
        label: ambient.mode === "hemisphere" ? "Sky colour" : "Colour",
        value: ambient.color,
        read: () => this.environment.config.ambient.color,
        onChange: (rgb) => set("Ambient Colour", "env-amb-color", { color: rgb }),
      },
    ];

    if (ambient.mode === "hemisphere") {
      fields.push({
        kind: "color",
        label: "Ground colour",
        hint: "The bounce coming up off the floor.",
        value: ambient.groundColor,
        read: () => this.environment.config.ambient.groundColor,
        onChange: (rgb) => set("Hemisphere Ground Colour", "env-amb-ground", { groundColor: rgb }),
      });
    }

    fields.push({
      kind: "slider",
      label: "Intensity",
      value: ambient.intensity,
      min: 0,
      max: 5,
      step: 0.01,
      read: () => this.environment.config.ambient.intensity,
      onChange: (value) => set("Ambient Intensity", "env-amb-intensity", { intensity: value }),
    });

    return {
      id: "env-ambient",
      title: ambient.mode === "hemisphere" ? "🌗 Hemisphere" : "🌑 Ambient",
      badge: "FILL",
      badgeTone: "solid",
      fields,
      collapsible: true,
      defaultOpen: true,
      moduleToggle: {
        value: ambient.enabled,
        read: () => this.environment.config.ambient.enabled,
        onChange: (value) => set(value ? "Enable Ambient" : "Disable Ambient", undefined, { enabled: value }),
      },
    };
  }

  private directionalSection(id: string): InspectorSection {
    const light = this.environment.config.directionals.find((d) => d.id === id);
    // Defensive: describe() only ever asks for ids it just read out of the
    // config, so this can't legitimately miss.
    if (!light) return { id: `env-dir-${id}`, title: "Directional Light", fields: [] };

    const read = (): typeof light => this.environment.config.directionals.find((d) => d.id === id) ?? light;
    const set = (label: string, mergeKey: string | undefined, patch: Parameters<SceneEnvironment["updateDirectional"]>[1]): void => {
      this.edit(label, mergeKey, () => this.environment.updateDirectional(id, patch));
    };

    const fields: InspectorField[] = [
      {
        kind: "text",
        label: "Name",
        value: light.name,
        placeholder: "Directional Light",
        read: () => read().name,
        onChange: (value) => set("Rename Light", `env-dir-name-${id}`, { name: value }),
      },
      {
        kind: "color",
        label: "Colour",
        value: light.color,
        read: () => read().color,
        onChange: (rgb) => set("Light Colour", `env-dir-color-${id}`, { color: rgb }),
      },
      {
        kind: "slider",
        label: "Intensity",
        value: light.intensity,
        min: 0,
        max: 10,
        step: 0.01,
        read: () => read().intensity,
        onChange: (value) => set("Light Intensity", `env-dir-intensity-${id}`, { intensity: value }),
      },
      {
        kind: "vec3",
        label: "Position",
        hint: "A directional light has no falloff — only the direction from here to Target matters, plus where the shadow frustum sits.",
        value: light.position,
        step: 0.5,
        read: () => read().position,
        onChange: (axis, value) => {
          const next = [...read().position] as [number, number, number];
          next[axis] = value;
          set("Light Position", `env-dir-pos-${id}`, { position: next });
        },
      },
      {
        kind: "vec3",
        label: "Target",
        hint: "World point the light aims at.",
        value: light.target,
        step: 0.5,
        read: () => read().target,
        onChange: (axis, value) => {
          const next = [...read().target] as [number, number, number];
          next[axis] = value;
          set("Light Target", `env-dir-target-${id}`, { target: next });
        },
      },
      {
        kind: "toggle",
        label: "Cast shadow",
        hint: "Costs a full depth pass from this light every frame. Needs Shadows enabled in the World section as well.",
        value: light.castShadow,
        read: () => read().castShadow,
        onChange: (value) => set(value ? "Enable Light Shadow" : "Disable Light Shadow", undefined, { castShadow: value }),
      },
    ];

    if (light.castShadow) {
      fields.push(
        {
          kind: "select",
          label: "Map size",
          hint: "Texels per side. Doubling this quadruples shadow-map memory — 1024 is usually the right call for a playable.",
          value: String(light.shadowMapSize),
          options: SHADOW_MAP_SIZES,
          read: () => String(read().shadowMapSize),
          onChange: (value) => set("Shadow Map Size", undefined, { shadowMapSize: parseInt(value, 10) }),
        },
        {
          kind: "number",
          label: "Bias",
          hint: "Nudges the depth comparison to kill shadow acne. Small negative values; too much detaches the shadow from its caster (peter-panning).",
          value: light.shadowBias,
          step: 0.0001,
          read: () => read().shadowBias,
          onChange: (value) => set("Shadow Bias", `env-dir-bias-${id}`, { shadowBias: value }),
        },
        {
          kind: "number",
          label: "Normal bias",
          hint: "Offsets along the surface normal instead of in depth. Usually the better acne fix on curved geometry.",
          value: light.shadowNormalBias,
          step: 0.005,
          read: () => read().shadowNormalBias,
          onChange: (value) => set("Shadow Normal Bias", `env-dir-nbias-${id}`, { shadowNormalBias: value }),
        },
        {
          kind: "number",
          label: "Radius",
          hint: "Softening width. Ignored under PCF Soft, which derives its own — meaningful under PCF and VSM.",
          value: light.shadowRadius,
          step: 0.5,
          min: 0,
          read: () => read().shadowRadius,
          onChange: (value) => set("Shadow Radius", `env-dir-radius-${id}`, { shadowRadius: value }),
        },
        {
          kind: "number",
          label: "Frustum extent",
          hint: "Half-width of the shadow camera's box. Must cover everything that should cast: too small clips shadows away at the edges, too large spends the map's resolution on empty space.",
          value: light.shadowCameraExtent,
          step: 1,
          min: 0.1,
          read: () => read().shadowCameraExtent,
          onChange: (value) => set("Shadow Frustum Extent", `env-dir-extent-${id}`, { shadowCameraExtent: value }),
        },
        {
          kind: "number",
          label: "Shadow near",
          value: light.shadowCameraNear,
          step: 0.1,
          min: 0.01,
          read: () => read().shadowCameraNear,
          onChange: (value) => set("Shadow Near", `env-dir-snear-${id}`, { shadowCameraNear: value }),
        },
        {
          kind: "number",
          label: "Shadow far",
          value: light.shadowCameraFar,
          step: 5,
          min: 0.02,
          read: () => read().shadowCameraFar,
          onChange: (value) => set("Shadow Far", `env-dir-sfar-${id}`, { shadowCameraFar: value }),
        }
      );
    }

    fields.push({
      kind: "buttons",
      buttons: [
        {
          text: "🗑 Delete",
          title: "Remove this light from the scene",
          danger: true,
          onClick: () => this.edit("Delete Directional Light", undefined, () => this.environment.removeDirectional(id)),
        },
      ],
    });

    return {
      id: `env-dir-${id}`,
      title: light.name || "Directional Light",
      badge: light.castShadow ? "SHADOW" : undefined,
      badgeTone: "trigger",
      fields,
      collapsible: true,
      defaultOpen: false,
      moduleToggle: {
        value: light.enabled,
        read: () => read().enabled,
        onChange: (value) => set(value ? "Enable Light" : "Disable Light", undefined, { enabled: value }),
      },
    };
  }

  // ---------------------------------------------------------------------
  // World
  // ---------------------------------------------------------------------

  private worldSection(): InspectorSection {
    const world = this.environment.config.world;
    const set = (label: string, mergeKey: string | undefined, patch: Parameters<SceneEnvironment["updateWorld"]>[0]): void => {
      this.edit(label, mergeKey, () => this.environment.updateWorld(patch));
    };
    const read = (): typeof world => this.environment.config.world;

    const fields: InspectorField[] = [
      {
        kind: "select",
        label: "Background",
        value: world.backgroundMode,
        options: BACKGROUND_OPTIONS,
        read: () => read().backgroundMode,
        onChange: (value) => set("Background Mode", undefined, { backgroundMode: value as typeof world.backgroundMode }),
      },
    ];

    if (world.backgroundMode !== "none") {
      fields.push({
        kind: "color",
        label: "Colour",
        hint: "Also the fallback when a background texture path can't be resolved.",
        value: world.backgroundColor,
        read: () => read().backgroundColor,
        onChange: (rgb) => set("Background Colour", "env-world-bgcolor", { backgroundColor: rgb }),
      });
    }

    if (world.backgroundMode === "texture") {
      fields.push(
        {
          kind: "text",
          label: "Texture",
          hint: "Equirectangular texture path, resolved through the game's own asset manifest — it must be listed there to be preloaded and inlined by the production build.",
          value: world.backgroundTexture,
          placeholder: "assets/textures/sky.jpg",
          read: () => read().backgroundTexture,
          onChange: (value) => set("Background Texture", "env-world-bgtex", { backgroundTexture: value }),
        },
        {
          kind: "slider",
          label: "Blurriness",
          value: world.backgroundBlurriness,
          min: 0,
          max: 1,
          step: 0.01,
          read: () => read().backgroundBlurriness,
          onChange: (value) => set("Background Blurriness", "env-world-bgblur", { backgroundBlurriness: value }),
        }
      );
    }

    if (world.backgroundMode !== "none") {
      fields.push({
        kind: "slider",
        label: "Bg intensity",
        value: world.backgroundIntensity,
        min: 0,
        max: 3,
        step: 0.01,
        read: () => read().backgroundIntensity,
        onChange: (value) => set("Background Intensity", "env-world-bgint", { backgroundIntensity: value }),
      });
    }

    fields.push(
      {
        kind: "select",
        label: "Environment",
        hint: "What PBR materials reflect. Without one, every metallic material in the scene renders black — a metal with nothing to reflect. The generated room costs no asset.",
        value: world.environmentSource,
        options: ENVIRONMENT_OPTIONS,
        read: () => read().environmentSource,
        onChange: (value) => set("Environment Source", undefined, { environmentSource: value as typeof world.environmentSource }),
      }
    );

    if (world.environmentSource !== "none") {
      fields.push({
        kind: "slider",
        label: "Env intensity",
        value: world.environmentIntensity,
        min: 0,
        max: 3,
        step: 0.01,
        read: () => read().environmentIntensity,
        onChange: (value) => set("Environment Intensity", "env-world-envint", { environmentIntensity: value }),
      });
    }

    fields.push({
      kind: "select",
      label: "Fog",
      value: world.fogMode,
      options: FOG_OPTIONS,
      read: () => read().fogMode,
      onChange: (value) => set("Fog Mode", undefined, { fogMode: value as typeof world.fogMode }),
    });

    if (world.fogMode !== "none") {
      fields.push({
        kind: "color",
        label: "Fog colour",
        hint: "Usually the background colour — anything else reads as haze with a visible edge where the sky starts.",
        value: world.fogColor,
        read: () => read().fogColor,
        onChange: (rgb) => set("Fog Colour", "env-world-fogcolor", { fogColor: rgb }),
      });
    }

    if (world.fogMode === "linear") {
      fields.push(
        {
          kind: "number",
          label: "Fog near",
          hint: "Keep this past the camera's own distance to the action, or the play area itself starts fogging.",
          value: world.fogNear,
          step: 1,
          min: 0,
          read: () => read().fogNear,
          onChange: (value) => set("Fog Near", "env-world-fognear", { fogNear: value }),
        },
        {
          kind: "number",
          label: "Fog far",
          hint: "Fully fogged from here out. Anything past it is invisible, so the camera's Far plane can usually come in to match.",
          value: world.fogFar,
          step: 5,
          min: 0,
          read: () => read().fogFar,
          onChange: (value) => set("Fog Far", "env-world-fogfar", { fogFar: value }),
        }
      );
    } else if (world.fogMode === "exp2") {
      fields.push({
        kind: "number",
        label: "Density",
        value: world.fogDensity,
        step: 0.001,
        min: 0,
        read: () => read().fogDensity,
        onChange: (value) => set("Fog Density", "env-world-fogdensity", { fogDensity: value }),
      });
    }

    fields.push(
      {
        kind: "select",
        label: "Tone mapping",
        hint: "How high dynamic range is compressed for display. With None, anything brighter than white clips flat — ACES rolls it off instead.",
        value: world.toneMapping,
        options: TONE_MAPPING_OPTIONS,
        read: () => read().toneMapping,
        onChange: (value) => set("Tone Mapping", undefined, { toneMapping: value as typeof world.toneMapping }),
      },
      {
        kind: "slider",
        label: "Exposure",
        value: world.toneMappingExposure,
        min: 0,
        max: 3,
        step: 0.01,
        read: () => read().toneMappingExposure,
        onChange: (value) => set("Exposure", "env-world-exposure", { toneMappingExposure: value }),
      },
      {
        kind: "toggle",
        label: "Shadows",
        hint: "Master switch for the renderer's shadow pass. With it off, no light casts regardless of its own setting — and nothing pays for the pass.",
        value: world.shadowsEnabled,
        read: () => read().shadowsEnabled,
        onChange: (value) => set(value ? "Enable Shadows" : "Disable Shadows", undefined, { shadowsEnabled: value }),
      }
    );

    if (world.shadowsEnabled) {
      fields.push({
        kind: "select",
        label: "Shadow type",
        hint: "Filtering quality. Changing this recompiles every material in the scene, so it's a design decision rather than a live knob.",
        value: world.shadowType,
        options: SHADOW_TYPE_OPTIONS,
        read: () => read().shadowType,
        onChange: (value) => set("Shadow Type", undefined, { shadowType: value as typeof world.shadowType }),
      });
    }

    return {
      id: "env-world",
      title: "🌍 World",
      fields,
      collapsible: true,
      defaultOpen: true,
    };
  }
}

function formatVector(v: THREE.Vector3): string {
  const r = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
  return `${r(v.x)}, ${r(v.y)}, ${r(v.z)}`;
}

/** Reads the rig's live camera position without this file needing a reference to the rig itself. */
function cameraPositionOf(environment: SceneEnvironment): THREE.Vector3 {
  return environment.rigCamera.position;
}
