import type * as THREE from "three";
import type { InspectorField, InspectorSection } from "./InspectorSections";

export interface SectionRendererOptions {
  /** Resolves the uuid carried by a Hierarchy row drag into the live object — needed by object-reference rows, since DataTransfer can't be read during dragover (see EditorDragSource). */
  resolveDraggedObject?: (uuid: string) => THREE.Object3D | undefined;
  /** The MIME the Hierarchy sets on its drags. Passed in rather than imported so this file stays unaware of the drag plumbing. */
  dragMime?: string;
}

/**
 * Turns InspectorSection descriptors into DOM, and keeps the values in them
 * fresh.
 *
 * Extracted out of EditorInspector so a *second* panel can render the same
 * field vocabulary without a second implementation of it. The Environment
 * panel (EditorEnvironment) isn't attached to a selected object at all —
 * it's three fixed sections in their own dock — but every row it needs
 * (colour swatch, slider, select, vec3, toggle) already existed here for
 * the collider and particle panels. Duplicating ~250 lines of row-building
 * to reuse them would have guaranteed the two copies drifted the first time
 * either gained a field kind.
 *
 * ## The build/refresh split is load-bearing
 *
 * Structure is created once; *values* are written every frame by
 * `refresh()`. Rebuilding the DOM each frame would destroy and recreate the
 * very `<input>` the user is typing into, losing focus and caret position
 * on every keystroke. `refresh()` additionally skips whichever control is
 * focused, so a half-typed "1.2" is never clobbered back to "1" by the
 * frame that lands mid-edit.
 *
 * ## Collapse state outlives a rebuild
 *
 * Remembered per section id, on the renderer rather than on the DOM, because
 * a rebuild happens on every selection change and every structural edit —
 * re-expanding sixteen particle modules (or three environment sections)
 * each time would make the panel unusable.
 */
export class SectionRenderer {
  /** Per-frame value writers for every row currently on screen. */
  private refreshers: (() => void)[] = [];
  private readonly sectionOpen = new Map<string, boolean>();

  constructor(private readonly options: SectionRendererOptions = {}) {}

  /** Drops every per-frame writer from the previous build. Call before clearing and rebuilding whatever container this feeds. */
  reset(): void {
    this.refreshers = [];
  }

  /** Once per editor frame. */
  refresh(): void {
    for (const write of this.refreshers) write();
  }

  /** Builds one section (header, collapse behavior, module switch, rows) and appends it to `parent`. */
  appendSection(parent: HTMLElement, section: InspectorSection): void {
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
      if (toggle.read) this.refreshers.push(() => paintSwitch((toggle.read as () => boolean)()));
    }

    wrap.appendChild(header);

    if (section.collapsible) {
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

    for (const field of section.fields) body.appendChild(this.buildField(field));
    wrap.appendChild(body);
    parent.appendChild(wrap);
  }

  /** Builds one row with no section chrome around it. */
  buildField(field: InspectorField): HTMLElement {
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
      if (field.read) this.refreshers.push(() => setIfIdleText(input, field.read as () => string));
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
      if (field.read) this.refreshers.push(() => setIfIdleNumber(input, (field.read as () => number)()));
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
      if (field.read) this.refreshers.push(() => paint((field.read as () => boolean)()));
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
        this.refreshers.push(() => {
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
        this.refreshers.push(() => {
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
        this.refreshers.push(() => {
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
        this.refreshers.push(() => {
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
        this.refreshers.push(() => {
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
        this.refreshers.push(() => {
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

    if (field.read) this.refreshers.push(() => {
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
}

/** Never overwrite what's mid-typing — see SectionRenderer's class comment. */
export function setIfIdleNumber(input: HTMLInputElement | undefined, value: number): void {
  if (!input || document.activeElement === input) return;
  const rounded = String(round2(value));
  if (input.value !== rounded) input.value = rounded;
}

export function setIfIdleText(input: HTMLInputElement, read: () => string): void {
  if (document.activeElement === input) return;
  const text = read();
  if (input.value !== text) input.value = text;
}

export function round2(value: number): number {
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
export function rgbToHex(rgb: [number, number, number]): string {
  const to255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `#${((1 << 24) | (to255(rgb[0]) << 16) | (to255(rgb[1]) << 8) | to255(rgb[2])).toString(16).slice(1)}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(n)) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
