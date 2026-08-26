import * as THREE from "three";
import type { EditorSelection } from "./EditorSelection";
import type { InspectorSectionProvider } from "./InspectorSections";
import { SectionRenderer, round2, setIfIdleNumber } from "./SectionRenderer";

interface AxisInputs {
  x: HTMLInputElement;
  y: HTMLInputElement;
  z: HTMLInputElement;
}

const EYE_OPEN_SVG = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none"><path d="M1 10s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="10" cy="10" r="2.6" stroke="currentColor" stroke-width="1.6"/></svg>';
const EYE_OFF_SVG = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none"><path d="M1 10s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="10" cy="10" r="2.6" stroke="currentColor" stroke-width="1.6"/><path d="M2 18 18 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const COPY_SVG = '<svg viewBox="0 0 20 20" width="11" height="11" fill="none"><rect x="6.5" y="6.5" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M13.5 6.5V4.5A1.5 1.5 0 0 0 12 3H4.5A1.5 1.5 0 0 0 3 4.5V12a1.5 1.5 0 0 0 1.5 1.5h2" stroke="currentColor" stroke-width="1.5"/></svg>';

export interface EditorInspectorOptions {
  /** Resolves the uuid carried by a Hierarchy row drag into the live object — needed by object-reference rows, since DataTransfer can't be read during dragover (see EditorDragSource). */
  resolveDraggedObject?: (uuid: string) => THREE.Object3D | undefined;
  /** The MIME the Hierarchy sets on its drags. Passed in rather than imported so this file stays unaware of the drag plumbing. */
  dragMime?: string;
}

/**
 * Live transform readout/editor for whatever EditorSelection currently
 * holds — plus any extra panels other subsystems contribute.
 *
 * The build/refresh split is load-bearing and predates this file's
 * extraction: structure is created once per newly-selected object, while
 * *values* are written every frame by `refresh()`. Rebuilding the DOM each
 * frame would destroy and recreate the very `<input>` the user is typing
 * into, losing focus and caret position on every keystroke. `refresh()`
 * additionally skips whichever input is focused, so a half-typed "1.2" is
 * never clobbered back to "1" by the frame that lands mid-edit.
 *
 * **Section providers** (see InspectorSections.ts) are how the collider
 * editor gets a panel here without this file knowing what a collider is:
 * a provider hands back a list of field descriptors, this renders them,
 * and their own `read()` callbacks feed the same per-frame refresh as the
 * transform fields. A provider's `version` changing is the signal to
 * rebuild — that's what makes switching a collider from box to sphere swap
 * a Size row for a Radius row without rebuilding anything every frame.
 */
export class EditorInspector {
  private readonly unsubscribe: () => void;
  private current: THREE.Object3D | undefined;
  private posInputs: AxisInputs | undefined;
  private rotInputs: AxisInputs | undefined;
  private scaleInputs: AxisInputs | undefined;
  private visibleButton: HTMLButtonElement | undefined;
  private visibleLabel: HTMLElement | undefined;

  private readonly providers: InspectorSectionProvider[] = [];
  /** Last-seen `version` per provider — compared each frame to decide whether the section's rows need rebuilding. */
  private readonly providerVersions = new Map<InspectorSectionProvider, number>();
  /**
   * Renders provider-contributed sections and drives their per-frame value
   * writers. Shared with the Environment panel rather than reimplemented —
   * see SectionRenderer's own class comment.
   */
  private readonly sections: SectionRenderer;

  constructor(
    private readonly container: HTMLElement,
    private readonly selection: EditorSelection,
    private readonly options: EditorInspectorOptions = {}
  ) {
    this.sections = new SectionRenderer(options);
    this.unsubscribe = selection.subscribe((state) => this.setObject(state.object));
    this.setObject(selection.object);
  }

  /** Adds a panel contributor. Order is registration order, and every provider sits between the identity block and the transform fields. */
  addSectionProvider(provider: InspectorSectionProvider): void {
    this.providers.push(provider);
    this.providerVersions.set(provider, -1);
    if (this.current) this.setObject(this.current, true);
  }

  /** Once per editor frame — keeps the fields in step with gizmo drags and any gameplay-side changes. */
  refresh(): void {
    if (!this.current) return;
    if (this.providersChanged()) {
      this.setObject(this.current, true);
      return;
    }
    this.writeValues(this.current);
    this.sections.refresh();
  }

  dispose(): void {
    this.unsubscribe();
    this.clearFieldRefs();
    this.container.innerHTML = "";
  }

  private providersChanged(): boolean {
    let changed = false;
    for (const provider of this.providers) {
      if (this.providerVersions.get(provider) !== provider.version) changed = true;
    }
    return changed;
  }

  private setObject(obj: THREE.Object3D | undefined, force = false): void {
    if (obj === this.current && !force) return;
    this.current = obj;
    if (!obj) {
      this.clearFieldRefs();
      this.container.innerHTML = '<div class="si-insp-empty">Select an object — click it in the viewport, or in the Hierarchy</div>';
      return;
    }
    this.buildFields(obj);
    this.writeValues(obj);
  }

  private clearFieldRefs(): void {
    this.posInputs = this.rotInputs = this.scaleInputs = undefined;
    this.visibleButton = this.visibleLabel = undefined;
    this.sections.reset();
  }

  private buildFields(obj: THREE.Object3D): void {
    this.clearFieldRefs();
    this.container.innerHTML = "";

    const nameRow = document.createElement("div");
    nameRow.className = "si-insp-row si-insp-name-row";
    const nameLabel = document.createElement("span");
    nameLabel.textContent = "Name";
    const nameValue = document.createElement("b");
    nameValue.textContent = obj.name || "(unnamed)";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "si-insp-copy-btn";
    copyBtn.innerHTML = COPY_SVG;
    copyBtn.title = "Copy name";
    copyBtn.addEventListener("click", () => this.copyToClipboard(obj.name || obj.type, copyBtn));
    nameRow.append(nameLabel, nameValue, copyBtn);
    this.container.appendChild(nameRow);

    const info = document.createElement("div");
    const row = (label: string, value: string): string => `<div class="si-insp-row"><span>${label}</span><b>${escapeHtml(value)}</b></div>`;
    info.innerHTML = row("Type", obj.type);
    this.container.appendChild(info);

    // Parent — a real navigation link, not just a readout: clicking it
    // moves the selection up the tree, which the Hierarchy then reveals
    // (see EditorHierarchy's non-"hierarchy"-sourced selection handling) —
    // one click to walk up out of a deeply nested part of a GLB instead of
    // hunting for the parent row by hand.
    if (obj.parent) {
      const parent = obj.parent;
      const parentRow = document.createElement("div");
      parentRow.className = "si-insp-row si-insp-parent-row";
      const parentLabel = document.createElement("span");
      parentLabel.textContent = "Parent";
      const parentLink = document.createElement("button");
      parentLink.type = "button";
      parentLink.className = "si-insp-parent-link";
      parentLink.textContent = parent.name || parent.type;
      parentLink.title = `Select parent — ${parent.name || "(unnamed)"} (${parent.type})`;
      parentLink.addEventListener("click", () => this.selection.selectObject(parent, "api"));
      parentRow.append(parentLabel, parentLink);
      this.container.appendChild(parentRow);
    }

    // Mesh stats — the "how heavy is this" numbers a GLB-heavy playable
    // actually cares about, right where you're already looking at the
    // object. Vertex/triangle count only (not material — kept intentionally
    // small, this is a debug readout, not a full material inspector).
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      const position = mesh.geometry.getAttribute("position");
      const vertexCount = position ? position.count : 0;
      const triangleCount = mesh.geometry.index ? mesh.geometry.index.count / 3 : vertexCount / 3;
      const statsInfo = document.createElement("div");
      statsInfo.innerHTML = row("Vertices", vertexCount.toLocaleString()) + row("Triangles", Math.round(triangleCount).toLocaleString());
      this.container.appendChild(statsInfo);
    }

    this.buildProviderSections(obj);

    const visRow = document.createElement("div");
    visRow.className = "si-insp-visible-row";
    const visBtn = document.createElement("button");
    visBtn.type = "button";
    visBtn.className = "si-insp-eye-btn";
    visBtn.addEventListener("click", () => {
      obj.visible = !obj.visible;
      this.paintVisible(obj.visible);
    });
    const visLabel = document.createElement("span");
    visRow.append(visBtn, visLabel);
    this.container.appendChild(visRow);
    this.visibleButton = visBtn;
    this.visibleLabel = visLabel;
    this.paintVisible(obj.visible);

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

  private buildProviderSections(obj: THREE.Object3D): void {
    for (const provider of this.providers) {
      this.providerVersions.set(provider, provider.version);
      const described = provider.describe(obj);
      if (!described) continue;
      // A provider may contribute one section or many — the particle
      // editor's sixteen modules are one registration, not sixteen.
      if (Array.isArray(described)) {
        for (const section of described) this.sections.appendSection(this.container, section);
      } else {
        this.sections.appendSection(this.container, described);
      }
    }
  }

  /** Icon + label + pressed-state for the eye button, in one place so a click and the per-frame sync below (writeValues) never drift out of step with each other. */
  private paintVisible(visible: boolean): void {
    if (!this.visibleButton || !this.visibleLabel) return;
    this.visibleButton.innerHTML = visible ? EYE_OPEN_SVG : EYE_OFF_SVG;
    this.visibleButton.classList.toggle("off", !visible);
    this.visibleButton.setAttribute("aria-pressed", String(visible));
    this.visibleButton.title = visible ? "Visible — click to hide" : "Hidden — click to show";
    this.visibleLabel.textContent = visible ? "Visible" : "Hidden";
  }

  /** navigator.clipboard needs a secure context/permission that isn't always available (older browsers, some embedded/headless setups) — falls back to the classic hidden-textarea + execCommand trick, which works everywhere the button itself renders. Either way, a brief "Copied" swap on the button is the only feedback — no toast system exists here and this doesn't need one. */
  private copyToClipboard(text: string, button: HTMLButtonElement): void {
    const flash = (): void => {
      const original = button.innerHTML;
      button.innerHTML = "✓";
      button.classList.add("copied");
      window.setTimeout(() => {
        button.innerHTML = original;
        button.classList.remove("copied");
      }, 900);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(flash, () => this.copyViaTextarea(text, flash));
    } else {
      this.copyViaTextarea(text, flash);
    }
  }

  private copyViaTextarea(text: string, onDone: () => void): void {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* nothing more we can do — the button just won't flash "copied" */
    }
    document.body.removeChild(ta);
    onDone();
  }

  private buildAxisRow(label: string, onChange: (axis: "x" | "y" | "z", value: number) => void): AxisInputs {
    const wrap = document.createElement("div");
    wrap.className = "si-insp-sub";
    wrap.textContent = label;
    this.container.appendChild(wrap);

    const grid = document.createElement("div");
    grid.className = "si-insp-axisgrid";
    this.container.appendChild(grid);

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

  private writeValues(obj: THREE.Object3D): void {
    setIfIdleNumber(this.posInputs?.x, obj.position.x);
    setIfIdleNumber(this.posInputs?.y, obj.position.y);
    setIfIdleNumber(this.posInputs?.z, obj.position.z);
    setIfIdleNumber(this.rotInputs?.x, THREE.MathUtils.radToDeg(obj.rotation.x));
    setIfIdleNumber(this.rotInputs?.y, THREE.MathUtils.radToDeg(obj.rotation.y));
    setIfIdleNumber(this.rotInputs?.z, THREE.MathUtils.radToDeg(obj.rotation.z));
    setIfIdleNumber(this.scaleInputs?.x, obj.scale.x);
    setIfIdleNumber(this.scaleInputs?.y, obj.scale.y);
    setIfIdleNumber(this.scaleInputs?.z, obj.scale.z);
    // Kept in sync every frame too, not just on click — the gizmo/hierarchy
    // never toggle visibility directly today, but Control Desk or a
    // gameplay script legitimately could while this object stays selected.
    if (this.visibleButton && this.visibleButton.classList.contains("off") !== !obj.visible) this.paintVisible(obj.visible);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
