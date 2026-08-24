import * as THREE from "three";
import type { EditorSelection } from "./EditorSelection";
import type { InspectorField, InspectorSection, InspectorSectionProvider } from "./InspectorSections";

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
  /** Per-frame value writers for every provider-contributed row currently on screen. */
  private sectionRefreshers: (() => void)[] = [];
  /** Collapse state per collapsible section id. Deliberately outlives a rebuild (and every selection change) — see buildSection. */
  private readonly sectionOpen = new Map<string, boolean>();

  constructor(
    private readonly container: HTMLElement,
    private readonly selection: EditorSelection,
    private readonly options: EditorInspectorOptions = {}
  ) {
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
    for (const write of this.sectionRefreshers) write();
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
    this.sectionRefreshers = [];
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
        for (const section of described) this.buildSection(section);
      } else {
        this.buildSection(described);
      }
    }
  }

  private buildSection(section: InspectorSection): void {
    const wrap = document.createElement("div");
    wrap.className = "si-insp-section";
    wrap.dataset.sectionId = section.id;

    const header = document.createElement("div");
    header.className = "si-insp-section-title";

    const body = document.createElement("div");
    body.className = "si-insp-section-body";

    let caret: HTMLElement | undefined;
    if (section.collapsible) {
      wrap.classList.add("collapsible");
      caret = document.createElement("i");
      caret.className = "si-insp-section-caret";
      header.appendChild(caret);
    }

    const title = document.createElement("span");
    title.textContent = section.title;
    header.appendChild(title);

    if (section.badge) {
      const badge = document.createElement("em");
      badge.className = `si-insp-badge tone-${section.badgeTone ?? "solid"}`;
      badge.textContent = section.badge;
      header.appendChild(badge);
    }

    // The module enable switch, in the header. Clicking it must not also
    // toggle the collapse — hence the stopPropagation.
    if (section.moduleToggle) {
      const toggle = section.moduleToggle;
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "si-insp-module-switch";
      const paintSwitch = (on: boolean): void => {
        sw.classList.toggle("on", on);
        sw.setAttribute("aria-pressed", String(on));
        sw.title = on ? "Module enabled — click to disable" : "Module disabled — click to enable";
        wrap.classList.toggle("module-off", !on);
      };
      paintSwitch(toggle.value);
      sw.addEventListener("click", (e) => {
        e.stopPropagation();
        const next = !sw.classList.contains("on");
        toggle.onChange(next);
        paintSwitch(next);
      });
      header.appendChild(sw);
      if (toggle.read) this.sectionRefreshers.push(() => paintSwitch((toggle.read as () => boolean)()));
    }

    wrap.appendChild(header);

    if (section.collapsible) {
      // Collapse state is remembered per section id across rebuilds — a
      // rebuild happens on every selection change and every structural
      // edit, and re-expanding sixteen modules each time would make the
      // panel unusable.
      const remembered = this.sectionOpen.get(section.id);
      const open = remembered ?? section.defaultOpen ?? false;
      this.sectionOpen.set(section.id, open);
      const paintOpen = (isOpen: boolean): void => {
        wrap.classList.toggle("open", isOpen);
        body.style.display = isOpen ? "" : "none";
        if (caret) caret.textContent = isOpen ? "▾" : "▸";
      };
      paintOpen(open);
      header.addEventListener("click", () => {
        const next = !wrap.classList.contains("open");
        this.sectionOpen.set(section.id, next);
        paintOpen(next);
      });
      header.style.cursor = "pointer";
    }

    for (const field of section.fields) body.appendChild(this.buildSectionField(field));
    wrap.appendChild(body);
    this.container.appendChild(wrap);
  }

  private buildSectionField(field: InspectorField): HTMLElement {
    if (field.kind === "buttons") return this.buildButtonsField(field);
    const row = document.createElement("div");
    row.className = `si-insp-field kind-${field.kind}`;
    if (field.hint) row.title = field.hint;
    const label = document.createElement("span");
    label.className = "si-insp-field-label";
    label.textContent = field.label;
    row.appendChild(label);

    if (field.kind === "text") {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "si-insp-text";
      input.value = field.value;
      if (field.placeholder) input.placeholder = field.placeholder;
      input.addEventListener("input", () => field.onChange(input.value));
      row.appendChild(input);
      if (field.read) this.sectionRefreshers.push(() => setIfIdleText(input, field.read as () => string));
    } else if (field.kind === "number") {
      const input = document.createElement("input");
      input.type = "number";
      input.className = "si-insp-number";
      input.step = String(field.step ?? 0.05);
      if (field.min !== undefined) input.min = String(field.min);
      input.value = String(round2(field.value));
      input.addEventListener("input", () => {
        const v = parseFloat(input.value);
        if (!Number.isNaN(v)) field.onChange(v);
      });
      row.appendChild(input);
      if (field.read) this.sectionRefreshers.push(() => setIfIdleNumber(input, (field.read as () => number)()));
    } else if (field.kind === "toggle") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "si-insp-switch";
      const paint = (on: boolean): void => {
        button.classList.toggle("on", on);
        button.setAttribute("aria-pressed", String(on));
        button.textContent = on ? (field.onText ?? "On") : (field.offText ?? "Off");
      };
      paint(field.value);
      button.addEventListener("click", () => {
        const next = !button.classList.contains("on");
        field.onChange(next);
        paint(next);
      });
      row.appendChild(button);
      if (field.read) this.sectionRefreshers.push(() => paint((field.read as () => boolean)()));
    } else if (field.kind === "vec3") {
      row.classList.add("stacked");
      const grid = document.createElement("div");
      grid.className = "si-insp-axisgrid";
      const labels = field.axisLabels ?? ["X", "Y", "Z"];
      const inputs: HTMLInputElement[] = [];
      for (let i = 0; i < 3; i++) {
        const cell = document.createElement("label");
        cell.className = `si-insp-axisfield axis-${["x", "y", "z"][i]}`;
        const tag = document.createElement("span");
        tag.textContent = labels[i];
        const input = document.createElement("input");
        input.type = "number";
        input.step = String(field.step ?? 0.05);
        input.value = String(round2(field.value[i]));
        const axis = i as 0 | 1 | 2;
        input.addEventListener("input", () => {
          const v = parseFloat(input.value);
          if (!Number.isNaN(v)) field.onChange(axis, v);
        });
        cell.append(tag, input);
        grid.appendChild(cell);
        inputs.push(input);
      }
      row.appendChild(grid);
      if (field.read) {
        this.sectionRefreshers.push(() => {
          const values = (field.read as () => [number, number, number])();
          for (let i = 0; i < 3; i++) setIfIdleNumber(inputs[i], values[i]);
        });
      }
    } else if (field.kind === "info") {
      const value = document.createElement("b");
      value.className = `si-insp-info-value accent-${field.accent ?? "normal"}`;
      value.textContent = field.value;
      row.appendChild(value);
      if (field.read || field.readAccent) {
        this.sectionRefreshers.push(() => {
          if (field.read) {
            const text = field.read();
            if (value.textContent !== text) value.textContent = text;
          }
          if (field.readAccent) value.className = `si-insp-info-value accent-${field.readAccent()}`;
        });
      }
    } else if (field.kind === "select") {
      const select = document.createElement("select");
      select.className = "si-insp-select";
      for (const option of field.options) {
        const el = document.createElement("option");
        el.value = option.value;
        el.textContent = option.label;
        select.appendChild(el);
      }
      select.value = field.value;
      select.addEventListener("change", () => field.onChange(select.value));
      row.appendChild(select);
      if (field.read) {
        this.sectionRefreshers.push(() => {
          if (document.activeElement === select) return;
          const v = (field.read as () => string)();
          if (select.value !== v) select.value = v;
        });
      }
    } else if (field.kind === "range") {
      const wrap = document.createElement("div");
      wrap.className = "si-insp-range";
      const minInput = document.createElement("input");
      const maxInput = document.createElement("input");
      for (const input of [minInput, maxInput]) {
        input.type = "number";
        input.step = String(field.step ?? 0.05);
        if (field.clampMin !== undefined) input.min = String(field.clampMin);
      }
      minInput.value = String(round2(field.min));
      maxInput.value = String(round2(field.max));
      const commit = (): void => {
        let lo = parseFloat(minInput.value);
        let hi = parseFloat(maxInput.value);
        if (Number.isNaN(lo)) lo = field.min;
        if (Number.isNaN(hi)) hi = field.max;
        if (field.clampMin !== undefined) {
          lo = Math.max(field.clampMin, lo);
          hi = Math.max(field.clampMin, hi);
        }
        // Never let min exceed max: a range with an inverted pair samples
        // to a negative span and silently produces nonsense (a negative
        // lifetime kills the particle on its birth frame).
        if (hi < lo) hi = lo;
        field.onChange(lo, hi);
      };
      minInput.addEventListener("input", commit);
      maxInput.addEventListener("input", commit);
      const dash = document.createElement("i");
      dash.textContent = "–";
      dash.className = "si-insp-range-dash";
      wrap.append(minInput, dash, maxInput);
      row.appendChild(wrap);
      if (field.read) {
        this.sectionRefreshers.push(() => {
          const [lo, hi] = (field.read as () => [number, number])();
          setIfIdleNumber(minInput, lo);
          setIfIdleNumber(maxInput, hi);
        });
      }
    } else if (field.kind === "color") {
      const input = document.createElement("input");
      input.type = "color";
      input.className = "si-insp-color";
      input.value = rgbToHex(field.value);
      input.addEventListener("input", () => field.onChange(hexToRgb(input.value)));
      row.appendChild(input);
      if (field.read) {
        this.sectionRefreshers.push(() => {
          if (document.activeElement === input) return;
          const hex = rgbToHex((field.read as () => [number, number, number])());
          if (input.value !== hex) input.value = hex;
        });
      }
    } else if (field.kind === "slider") {
      const wrap = document.createElement("div");
      wrap.className = "si-insp-slider";
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(field.min);
      input.max = String(field.max);
      input.step = String(field.step ?? 0.01);
      input.value = String(field.value);
      const readout = document.createElement("b");
      readout.textContent = String(round2(field.value));
      input.addEventListener("input", () => {
        const v = parseFloat(input.value);
        readout.textContent = String(round2(v));
        field.onChange(v);
      });
      wrap.append(input, readout);
      row.appendChild(wrap);
      if (field.read) {
        this.sectionRefreshers.push(() => {
          if (document.activeElement === input) return;
          const v = (field.read as () => number)();
          const s = String(v);
          if (input.value !== s) {
            input.value = s;
            readout.textContent = String(round2(v));
          }
        });
      }
    } else {
      row.appendChild(this.buildObjectRefControl(field));
    }
    return row;
  }

  private buildObjectRefControl(field: Extract<InspectorField, { kind: "objectRef" }>): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "si-insp-objectref";
    const value = document.createElement("span");
    value.className = "si-insp-objectref-value";
    value.textContent = field.value;
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "si-insp-mini-btn";
    pick.textContent = "⊙";
    pick.title = "Pick — then click an object in the viewport or the Hierarchy";
    pick.addEventListener("click", () => field.onPick());
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "si-insp-mini-btn";
    clear.textContent = "✕";
    clear.title = "Detach (world space)";
    clear.addEventListener("click", () => field.onClear());
    wrap.append(value, pick, clear);

    // The second way to assign one, matching the affordance Control Desk's
    // object fields already offer: drag a Hierarchy row onto it. The uuid
    // is all DataTransfer carries; the live object is resolved through the
    // drag source, because dragover can't read a payload's contents.
    const mime = this.options.dragMime;
    const resolve = this.options.resolveDraggedObject;
    if (mime && resolve) {
      wrap.addEventListener("dragover", (e) => {
        if (!e.dataTransfer?.types.includes(mime)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        wrap.classList.add("drop-ok");
      });
      wrap.addEventListener("dragleave", () => wrap.classList.remove("drop-ok"));
      wrap.addEventListener("drop", (e) => {
        wrap.classList.remove("drop-ok");
        const uuid = e.dataTransfer?.getData(mime);
        if (!uuid) return;
        e.preventDefault();
        const object = resolve(uuid);
        if (object) field.onDropObject(object);
      });
    }

    if (field.read) this.sectionRefreshers.push(() => {
      const text = (field.read as () => string)();
      if (value.textContent !== text) value.textContent = text;
    });
    return wrap;
  }

  private buildButtonsField(field: Extract<InspectorField, { kind: "buttons" }>): HTMLElement {
    const row = document.createElement("div");
    row.className = "si-insp-buttonrow";
    for (const spec of field.buttons) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = spec.danger ? "si-insp-action danger" : "si-insp-action";
      button.textContent = spec.text;
      if (spec.title) button.title = spec.title;
      button.addEventListener("click", () => spec.onClick());
      row.appendChild(button);
    }
    return row;
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

/** Never overwrite what's mid-typing — see the class doc comment. */
function setIfIdleNumber(input: HTMLInputElement | undefined, value: number): void {
  if (!input || document.activeElement === input) return;
  const rounded = String(round2(value));
  if (input.value !== rounded) input.value = rounded;
}

function setIfIdleText(input: HTMLInputElement, read: () => string): void {
  if (document.activeElement === input) return;
  const text = read();
  if (input.value !== text) input.value = text;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 0..1 linear RGB to a `#rrggbb` hex string for `<input type="color">`.
 *
 * No gamma conversion on purpose. The values here are what go straight
 * into a THREE.Color the shader multiplies by, and round-tripping them
 * through sRGB would mean the number shown in the swatch stops matching
 * the number stored in the config — which makes a hand-edited
 * particles.json and the editor disagree about the same effect.
 */
function rgbToHex(rgb: [number, number, number]): string {
  const to255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `#${((1 << 24) | (to255(rgb[0]) << 16) | (to255(rgb[1]) << 8) | to255(rgb[2])).toString(16).slice(1)}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(n)) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
