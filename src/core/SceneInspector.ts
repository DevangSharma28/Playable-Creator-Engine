import * as THREE from "three";

/**
 * Dev-only scene debug tool, live for as long as the Engine Room "3D View"
 * freecam is active (see Game.ts#setFreecam). Three jobs:
 *  - a flat-rendered (always-expanded) hierarchy tree of the live scene
 *    graph into `hierarchyEl`, click a row to select that object
 *  - a small read-only inspector of the selected object's transform into
 *    `inspectorEl`, refreshed every update() so a moving object (e.g. the
 *    player) stays live
 *  - light/camera helper gizmos (THREE's built-in *Helper classes) added to
 *    the scene so the sun/fill light directions and the *main gameplay*
 *    camera's frustum are visible while you're looking at the scene through
 *    a separate freecam — `mainCamera` is passed in explicitly rather than
 *    read off the renderer because during freecam the renderer is drawing
 *    through a different (orbit) camera entirely.
 * Entirely self-contained: dispose() removes every helper it added and
 * clears both DOM panels, leaving the scene exactly as it found it.
 */
export class SceneInspector {
  private readonly cameraHelper: THREE.CameraHelper;
  private readonly lightHelpers: THREE.Object3D[] = [];
  private readonly ownedHelpers = new Set<THREE.Object3D>();

  private selected: THREE.Object3D | undefined;
  private selectedRow: HTMLElement | undefined;
  private selectionHelper: THREE.BoxHelper | undefined;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly mainCamera: THREE.PerspectiveCamera,
    private readonly hierarchyEl: HTMLElement,
    private readonly inspectorEl: HTMLElement
  ) {
    this.cameraHelper = new THREE.CameraHelper(mainCamera);
    this.scene.add(this.cameraHelper);
    this.ownedHelpers.add(this.cameraHelper);

    this.scene.traverse((obj) => {
      const helper = this.makeLightHelper(obj);
      if (helper) {
        this.lightHelpers.push(helper);
        this.scene.add(helper);
        this.ownedHelpers.add(helper);
      }
    });

    this.renderHierarchy();
    this.renderInspector();
  }

  /** Call once per frame while active — refreshes helper gizmos and the live inspector readout. */
  update(): void {
    this.cameraHelper.update();
    for (const helper of this.lightHelpers) {
      (helper as { update?: () => void }).update?.();
    }
    this.selectionHelper?.update();
    if (this.selected) this.renderInspector();
  }

  dispose(): void {
    for (const helper of this.ownedHelpers) this.scene.remove(helper);
    if (this.selectionHelper) this.scene.remove(this.selectionHelper);
    this.hierarchyEl.innerHTML = "";
    this.inspectorEl.innerHTML = "";
  }

  private makeLightHelper(obj: THREE.Object3D): THREE.Object3D | undefined {
    // AmbientLight has no position/direction — nothing meaningful to draw.
    if (obj instanceof THREE.DirectionalLight) return new THREE.DirectionalLightHelper(obj, 1);
    if (obj instanceof THREE.PointLight) return new THREE.PointLightHelper(obj, 0.3);
    if (obj instanceof THREE.SpotLight) return new THREE.SpotLightHelper(obj);
    if (obj instanceof THREE.HemisphereLight) return new THREE.HemisphereLightHelper(obj, 1);
    return undefined;
  }

  private select(obj: THREE.Object3D): void {
    this.selectedRow?.classList.remove("selected");
    this.selected = obj;

    if (this.selectionHelper) this.scene.remove(this.selectionHelper);
    this.selectionHelper = new THREE.BoxHelper(obj, 0xffe066);
    this.scene.add(this.selectionHelper);

    const row = this.hierarchyEl.querySelector<HTMLElement>(`[data-uuid="${obj.uuid}"]`);
    row?.classList.add("selected");
    this.selectedRow = row ?? undefined;

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
      this.inspectorEl.innerHTML = '<div class="si-insp-empty">Select an object in the hierarchy</div>';
      return;
    }

    const row = (label: string, value: string) => `<div class="si-insp-row"><span>${label}</span><b>${value}</b></div>`;
    const section = (label: string) => `<div class="si-insp-sub">${label}</div>`;
    const deg = (rad: number) => `${THREE.MathUtils.radToDeg(rad).toFixed(1)}°`;

    this.inspectorEl.innerHTML =
      row("Name", obj.name || "(unnamed)") +
      row("Type", obj.type) +
      row("Visible", String(obj.visible)) +
      section("Position") +
      row("x", obj.position.x.toFixed(2)) +
      row("y", obj.position.y.toFixed(2)) +
      row("z", obj.position.z.toFixed(2)) +
      section("Rotation") +
      row("x", deg(obj.rotation.x)) +
      row("y", deg(obj.rotation.y)) +
      row("z", deg(obj.rotation.z)) +
      section("Scale") +
      row("x", obj.scale.x.toFixed(2)) +
      row("y", obj.scale.y.toFixed(2)) +
      row("z", obj.scale.z.toFixed(2));
  }
}
