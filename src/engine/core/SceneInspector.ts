import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export type GizmoMode = "none" | "translate" | "rotate" | "scale";

/** Grid/helper visibility, snap-on-drag, and gizmo space — surfaced to the Engine Room toolbar via addStateChangeListener so its buttons stay in sync whether toggled by keyboard shortcut or by clicking the button itself (same pattern as GizmoMode/onModeChange). */
export interface InspectorToolState {
  grid: boolean;
  helpers: boolean;
  snap: boolean;
  space: "local" | "world";
}

export interface SceneInspectorOptions {
  scene: THREE.Scene;
  /** The real gameplay camera — its frustum is drawn via CameraHelper so you can see what it sees while freely orbiting with a different camera. */
  gameplayCamera: THREE.PerspectiveCamera;
  /** The camera actually being rendered through (freecam) — what the transform gizmo and click-to-select raycast against. */
  viewCamera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
  /** Disabled while dragging a gizmo handle so orbiting and transforming never fight over the same drag gesture. */
  orbitControls: OrbitControls;
  hierarchyEl: HTMLElement;
  inspectorEl: HTMLElement;
}

/**
 * Dev-only scene debug + light editing tool, live for as long as the Engine
 * Room "3D View" freecam is active (see Game.ts#setFreecam). Beyond the
 * original read-only hierarchy/inspector, this now behaves like the start
 * of a real in-engine editor:
 *  - click any object directly in the viewport (not just its hierarchy row)
 *    to select it — a raycast against everything except this class's own
 *    debug visuals, gated to real clicks (not orbit-drags — see the
 *    down/up distance check in onPointerUp)
 *  - a Move/Rotate/Scale gizmo (three.js's TransformControls) attaches to
 *    whatever's selected; drag it to edit the object live, or use the
 *    W/E/R/Q keyboard shortcuts (same convention as Blender/Unity/Unreal)
 *  - the inspector's Position/Rotation/Scale/Visible fields are now real
 *    inputs, not read-only text — typing in one edits the live object the
 *    same way dragging the gizmo does, and both stay in sync automatically
 *    each frame (see refreshInspectorValues)
 * Nothing here persists — edits are live/in-session only, since (unlike
 * src/ui/*.json for the 2D layouts) there's no data-driven description of
 * the 3D scene to save back to yet. That's the natural next step toward a
 * full 3D editor; this class is written so that step doesn't require
 * restructuring it — selection, gizmo, and field-editing are already
 * cleanly separated.
 * Entirely self-contained: dispose() removes every helper/listener it
 * added and clears both DOM panels, leaving the scene exactly as it found it.
 */
export class SceneInspector {
  private readonly scene: THREE.Scene;
  private readonly gameplayCamera: THREE.PerspectiveCamera;
  private readonly viewCamera: THREE.Camera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly orbitControls: OrbitControls;
  private readonly hierarchyEl: HTMLElement;
  private readonly inspectorEl: HTMLElement;

  private readonly cameraHelper: THREE.CameraHelper;
  private readonly lightHelpers: THREE.Object3D[] = [];
  private readonly gridHelper: THREE.GridHelper;
  private readonly ownedHelpers = new Set<THREE.Object3D>();
  private readonly transformControls: TransformControls;
  /** TransformControls itself isn't an Object3D (it extends the newer three.js Controls base) — its rendered gizmo lives on this helper, returned by getHelper(), which is what actually needs adding to the scene and toggling visible. */
  private readonly gizmoHelper: THREE.Object3D;
  private readonly raycaster = new THREE.Raycaster();

  private selected: THREE.Object3D | undefined;
  private selectedRow: HTMLElement | undefined;
  private selectionHelper: THREE.BoxHelper | undefined;
  private mode: GizmoMode = "translate";
  private downPos: { x: number; y: number } | null = null;
  private readonly onModeChange = new Set<(mode: GizmoMode) => void>();

  /** Off by default — the camera/light helpers below were always-on before this existed, grid is new and would just be clutter until asked for. */
  private gridVisible = false;
  private helpersVisible = true;
  private snapEnabled = false;
  private readonly onStateChange = new Set<(state: InspectorToolState) => void>();

  /** Built once per selected object (see buildInspectorFields), then just refreshed in place every frame — rebuilding the whole innerHTML each frame would steal focus/cursor position out of whichever field you're mid-typing in. */
  private posInputs: AxisInputs | undefined;
  private rotInputs: AxisInputs | undefined;
  private scaleInputs: AxisInputs | undefined;
  private visibleCheckbox: HTMLInputElement | undefined;

  constructor(opts: SceneInspectorOptions) {
    this.scene = opts.scene;
    this.gameplayCamera = opts.gameplayCamera;
    this.viewCamera = opts.viewCamera;
    this.renderer = opts.renderer;
    this.orbitControls = opts.orbitControls;
    this.hierarchyEl = opts.hierarchyEl;
    this.inspectorEl = opts.inspectorEl;

    this.cameraHelper = new THREE.CameraHelper(this.gameplayCamera);
    this.scene.add(this.cameraHelper);
    this.ownedHelpers.add(this.cameraHelper);

    this.gridHelper = new THREE.GridHelper(20, 20, 0x666666, 0x333333);
    this.gridHelper.visible = this.gridVisible;
    this.scene.add(this.gridHelper);
    this.ownedHelpers.add(this.gridHelper);

    this.scene.traverse((obj) => {
      const helper = this.makeLightHelper(obj);
      if (helper) {
        this.lightHelpers.push(helper);
        this.scene.add(helper);
        this.ownedHelpers.add(helper);
      }
    });

    this.transformControls = new TransformControls(this.viewCamera, this.renderer.domElement);
    this.transformControls.setMode("translate");
    this.gizmoHelper = this.transformControls.getHelper();
    this.scene.add(this.gizmoHelper);
    this.ownedHelpers.add(this.gizmoHelper);
    // Prevents orbiting and dragging a gizmo handle from fighting over the
    // same mouse gesture — the instant a handle-drag starts, hand control
    // of the pointer over to TransformControls exclusively.
    this.transformControls.addEventListener("dragging-changed", (event) => {
      this.orbitControls.enabled = !(event as unknown as { value: boolean }).value;
    });
    this.transformControls.addEventListener("objectChange", () => {
      if (this.selected) this.refreshInspectorValues(this.selected);
    });

    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("keydown", this.onKeyDown);

    this.renderHierarchy();
    this.renderInspector();
  }

  /** Call once per frame while active — refreshes helper gizmos and the live inspector readout. TransformControls' own gizmo re-syncs to the selected object automatically via the normal scene render (its helper overrides updateMatrixWorld), so it needs no explicit update() call here. */
  update(): void {
    this.cameraHelper.update();
    for (const helper of this.lightHelpers) {
      (helper as { update?: () => void }).update?.();
    }
    this.selectionHelper?.update();
    if (this.selected) this.refreshInspectorValues(this.selected);
  }

  /** Move / Rotate / Scale / off — also switchable via the W/E/R/Q keys (see onKeyDown). */
  setMode(mode: GizmoMode): void {
    this.mode = mode;
    if (mode === "none") {
      this.transformControls.enabled = false;
      this.gizmoHelper.visible = false;
    } else {
      this.transformControls.enabled = true;
      this.gizmoHelper.visible = true;
      this.transformControls.setMode(mode);
    }
    for (const cb of this.onModeChange) cb(mode);
  }

  getMode(): GizmoMode {
    return this.mode;
  }

  /** Notified whenever setMode()/the W/E/R/Q shortcuts change the active gizmo mode — lets outer UI (the Engine Room panel) keep its own toolbar buttons in sync. */
  addModeChangeListener(cb: (mode: GizmoMode) => void): void {
    this.onModeChange.add(cb);
  }

  /** Toggleable via G or the Engine Room toolbar — off by default, see gridVisible's field comment. */
  toggleGrid(): boolean {
    this.gridVisible = !this.gridVisible;
    this.gridHelper.visible = this.gridVisible;
    this.emitStateChange();
    return this.gridVisible;
  }

  /** Camera frustum + light helpers, toggleable via H — separate from the grid since it's existing always-on debug visuals, not a new opt-in. */
  toggleHelpers(): boolean {
    this.helpersVisible = !this.helpersVisible;
    this.cameraHelper.visible = this.helpersVisible;
    for (const helper of this.lightHelpers) helper.visible = this.helpersVisible;
    this.emitStateChange();
    return this.helpersVisible;
  }

  /** Fixed increments (0.25 world units / 15° / 0.1 scale) rather than a configurable amount — this is a quick on/off for "line things up roughly," not a precision-authoring feature yet. */
  toggleSnap(): boolean {
    this.snapEnabled = !this.snapEnabled;
    this.transformControls.setTranslationSnap(this.snapEnabled ? 0.25 : null);
    this.transformControls.setRotationSnap(this.snapEnabled ? THREE.MathUtils.degToRad(15) : null);
    this.transformControls.setScaleSnap(this.snapEnabled ? 0.1 : null);
    this.emitStateChange();
    return this.snapEnabled;
  }

  /** World (default) vs. the selected object's own local axes — same toggle Blender/Unity expose next to their gizmo. */
  toggleSpace(): "local" | "world" {
    const next = this.transformControls.space === "world" ? "local" : "world";
    this.transformControls.setSpace(next);
    this.emitStateChange();
    return next;
  }

  /** F — recenters the orbit target on the selected object and dollies the camera back just far enough to fit it, keeping the camera's current look direction rather than snapping to a canned angle. No-op with nothing selected. */
  frameSelected(): void {
    if (!this.selected) return;
    const box = new THREE.Box3().setFromObject(this.selected);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 0.5);

    const dir = this.viewCamera.position.clone().sub(this.orbitControls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();

    this.orbitControls.target.copy(center);
    this.viewCamera.position.copy(center).addScaledVector(dir, radius * 3);
    this.orbitControls.update();
  }

  getToolState(): InspectorToolState {
    return { grid: this.gridVisible, helpers: this.helpersVisible, snap: this.snapEnabled, space: this.transformControls.space as "local" | "world" };
  }

  /** Notified whenever grid/helpers/snap/space change, by keyboard shortcut or toolbar click alike — same reasoning as addModeChangeListener. */
  addStateChangeListener(cb: (state: InspectorToolState) => void): void {
    this.onStateChange.add(cb);
  }

  private emitStateChange(): void {
    const state = this.getToolState();
    for (const cb of this.onStateChange) cb(state);
  }

  dispose(): void {
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("keydown", this.onKeyDown);
    this.transformControls.detach();
    this.transformControls.dispose();
    for (const helper of this.ownedHelpers) this.scene.remove(helper);
    if (this.selectionHelper) this.scene.remove(this.selectionHelper);
    this.hierarchyEl.innerHTML = "";
    this.inspectorEl.innerHTML = "";
    this.onModeChange.clear();
    this.onStateChange.clear();
  }

  private makeLightHelper(obj: THREE.Object3D): THREE.Object3D | undefined {
    // AmbientLight has no position/direction — nothing meaningful to draw.
    if (obj instanceof THREE.DirectionalLight) return new THREE.DirectionalLightHelper(obj, 1);
    if (obj instanceof THREE.PointLight) return new THREE.PointLightHelper(obj, 0.3);
    if (obj instanceof THREE.SpotLight) return new THREE.SpotLightHelper(obj);
    if (obj instanceof THREE.HemisphereLight) return new THREE.HemisphereLightHelper(obj, 1);
    return undefined;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const tag = (document.activeElement as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (document.activeElement as HTMLElement | null)?.isContentEditable) return;
    const key = e.key.toLowerCase();
    if (key === "q") this.setMode("none");
    else if (key === "w") this.setMode("translate");
    else if (key === "e") this.setMode("rotate");
    else if (key === "r") this.setMode("scale");
    else if (key === "escape") this.deselect();
    else if (key === "f") this.frameSelected();
    else if (key === "g") this.toggleGrid();
    else if (key === "h") this.toggleHelpers();
    else if (key === "x") this.toggleSnap();
    else if (key === "c") this.toggleSpace();
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.downPos = { x: event.clientX, y: event.clientY };
  };

  /** Click-to-select — gated on pointerup, not pointerdown, and only when the pointer barely moved, so an orbit-drag (also left-button, via OrbitControls on this same canvas) never gets misread as a click. */
  private onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.downPos) return;
    const dx = event.clientX - this.downPos.x;
    const dy = event.clientY - this.downPos.y;
    this.downPos = null;
    if (Math.hypot(dx, dy) > 5) return;
    if (this.transformControls.dragging || this.transformControls.axis !== null) return; // the click was on a gizmo handle — TransformControls already owns it

    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.viewCamera);
    const pickable = this.scene.children.filter((c) => !this.ownedHelpers.has(c));
    const hits = this.raycaster.intersectObjects(pickable, true);
    if (hits.length > 0) this.select(hits[0].object);
    else this.deselect();
  };

  private select(obj: THREE.Object3D): void {
    this.selectedRow?.classList.remove("selected");
    this.selected = obj;

    if (this.selectionHelper) {
      this.scene.remove(this.selectionHelper);
      this.ownedHelpers.delete(this.selectionHelper);
    }
    this.selectionHelper = new THREE.BoxHelper(obj, 0xffe066);
    this.scene.add(this.selectionHelper);
    // Pre-existing bug this fixes: without this, the yellow outline itself
    // was a pickable scene child (the raycast filter in onPointerUp only
    // excludes ownedHelpers) — clicking it attached TransformControls to
    // the BoxHelper instead of the real object, which then crashes the
    // gizmo's own render (it expects a normal scene-graph parent).
    this.ownedHelpers.add(this.selectionHelper);

    if (this.mode !== "none") this.transformControls.attach(obj);

    const row = this.hierarchyEl.querySelector<HTMLElement>(`[data-uuid="${obj.uuid}"]`);
    row?.classList.add("selected");
    this.selectedRow = row ?? undefined;

    this.renderInspector();
  }

  private deselect(): void {
    this.selectedRow?.classList.remove("selected");
    this.selectedRow = undefined;
    this.selected = undefined;
    if (this.selectionHelper) {
      this.scene.remove(this.selectionHelper);
      this.ownedHelpers.delete(this.selectionHelper);
      this.selectionHelper = undefined;
    }
    this.transformControls.detach();
    this.renderInspector();
  }

  private renderHierarchy(): void {
    this.hierarchyEl.innerHTML = "";
    this.hierarchyEl.appendChild(this.buildRows(this.scene, 0));
  }

  private buildRows(obj: THREE.Object3D, depth: number): DocumentFragment {
    const fragment = document.createDocumentFragment();

    // Skip our own gizmos — they're debug visuals, not scene content.
    for (const child of obj.children) {
      if (this.ownedHelpers.has(child)) continue;

      const row = document.createElement("div");
      row.className = "si-row";
      row.style.paddingLeft = `${depth * 12 + 6}px`;
      row.textContent = `${this.iconFor(child)} ${child.name || child.type}`;
      row.dataset.uuid = child.uuid;
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        this.select(child);
      });
      fragment.appendChild(row);
      fragment.appendChild(this.buildRows(child, depth + 1));
    }

    return fragment;
  }

  private iconFor(obj: THREE.Object3D): string {
    if ((obj as THREE.Light).isLight) return "\u{1F4A1}"; // 💡
    if ((obj as THREE.Camera).isCamera) return "\u{1F3A5}"; // 🎥
    if ((obj as THREE.Mesh).isMesh) return "\u{1F536}"; // 🔶
    return "\u{1F4E6}"; // 📦
  }

  private renderInspector(): void {
    const obj = this.selected;
    if (!obj) {
      this.posInputs = this.rotInputs = this.scaleInputs = undefined;
      this.visibleCheckbox = undefined;
      this.inspectorEl.innerHTML = '<div class="si-insp-empty">Select an object — click it in the viewport, or in the hierarchy</div>';
      return;
    }
    this.buildInspectorFields(obj);
    this.refreshInspectorValues(obj);
  }

  /** Static structure only — built once per newly-selected object. Values are filled in separately by refreshInspectorValues, called both right after this and every frame after, so per-frame updates never tear down and rebuild (and steal focus from) a field the user is actively typing in. */
  private buildInspectorFields(obj: THREE.Object3D): void {
    this.inspectorEl.innerHTML = "";

    const info = document.createElement("div");
    const row = (label: string, value: string) => `<div class="si-insp-row"><span>${label}</span><b>${value}</b></div>`;
    info.innerHTML = row("Name", obj.name || "(unnamed)") + row("Type", obj.type);
    this.inspectorEl.appendChild(info);

    const visRow = document.createElement("label");
    visRow.className = "si-insp-visible-row";
    const visCheckbox = document.createElement("input");
    visCheckbox.type = "checkbox";
    visCheckbox.addEventListener("change", () => {
      obj.visible = visCheckbox.checked;
    });
    const visLabel = document.createElement("span");
    visLabel.textContent = "Visible";
    visRow.append(visCheckbox, visLabel);
    this.inspectorEl.appendChild(visRow);
    this.visibleCheckbox = visCheckbox;

    this.posInputs = this.buildAxisRow("Position", (axis, v) => {
      obj.position[axis] = v;
    });
    this.rotInputs = this.buildAxisRow("Rotation °", (axis, v) => {
      obj.rotation[axis] = THREE.MathUtils.degToRad(v);
    });
    this.scaleInputs = this.buildAxisRow("Scale", (axis, v) => {
      obj.scale[axis] = v;
    });
  }

  private buildAxisRow(label: string, onChange: (axis: "x" | "y" | "z", value: number) => void): AxisInputs {
    const wrap = document.createElement("div");
    wrap.className = "si-insp-sub";
    wrap.textContent = label;
    this.inspectorEl.appendChild(wrap);

    const grid = document.createElement("div");
    grid.className = "si-insp-axisgrid";
    this.inspectorEl.appendChild(grid);

    const makeAxisInput = (axis: "x" | "y" | "z"): HTMLInputElement => {
      const field = document.createElement("label");
      field.className = `si-insp-axisfield axis-${axis}`;
      const tag = document.createElement("span");
      tag.textContent = axis.toUpperCase();
      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.05";
      field.append(tag, input);
      grid.appendChild(field);
      input.addEventListener("input", () => {
        const v = parseFloat(input.value);
        if (!Number.isNaN(v)) onChange(axis, v);
      });
      return input;
    };

    return { x: makeAxisInput("x"), y: makeAxisInput("y"), z: makeAxisInput("z") };
  }

  private refreshInspectorValues(obj: THREE.Object3D): void {
    const setIfIdle = (input: HTMLInputElement | undefined, value: number) => {
      if (!input || document.activeElement === input) return; // never overwrite what's mid-typing
      const rounded = String(Math.round(value * 100) / 100);
      if (input.value !== rounded) input.value = rounded;
    };
    setIfIdle(this.posInputs?.x, obj.position.x);
    setIfIdle(this.posInputs?.y, obj.position.y);
    setIfIdle(this.posInputs?.z, obj.position.z);
    setIfIdle(this.rotInputs?.x, THREE.MathUtils.radToDeg(obj.rotation.x));
    setIfIdle(this.rotInputs?.y, THREE.MathUtils.radToDeg(obj.rotation.y));
    setIfIdle(this.rotInputs?.z, THREE.MathUtils.radToDeg(obj.rotation.z));
    setIfIdle(this.scaleInputs?.x, obj.scale.x);
    setIfIdle(this.scaleInputs?.y, obj.scale.y);
    setIfIdle(this.scaleInputs?.z, obj.scale.z);
    if (this.visibleCheckbox && document.activeElement !== this.visibleCheckbox) this.visibleCheckbox.checked = obj.visible;
  }
}

interface AxisInputs {
  x: HTMLInputElement;
  y: HTMLInputElement;
  z: HTMLInputElement;
}
