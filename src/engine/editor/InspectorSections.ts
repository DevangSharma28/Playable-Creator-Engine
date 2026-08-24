import type * as THREE from "three";

/**
 * A tiny field-descriptor vocabulary that lets a subsystem contribute a
 * panel to the Inspector without either side knowing about the other.
 *
 * The alternative — EditorInspector importing EditorColliders and growing
 * an `if (isCollider(obj))` branch — puts collider knowledge inside the
 * generic transform panel, and would do it again for the next system that
 * wants a panel. Here the Inspector knows how to draw a `number` row and
 * nothing else; EditorColliders knows what a collider is and nothing about
 * DOM. That split is also what keeps the whole collider editor out of the
 * production bundle: the Inspector's provider list is simply empty there,
 * because the module that would fill it is never imported.
 *
 * The `read()` on most field kinds is load-bearing, and mirrors the
 * build/refresh split EditorInspector already runs on: the row's DOM is
 * built once when the selection (or a provider's `version`) changes, while
 * `read()` supplies the current value every frame. Rebuilding rows per
 * frame would destroy the `<input>` under the user's cursor on every
 * keystroke.
 */

interface FieldBase {
  label: string;
  /** Tooltip. Worth writing for anything whose effect isn't obvious from the label — masks and triggers both qualify. */
  hint?: string;
}

export interface TextField extends FieldBase {
  kind: "text";
  value: string;
  placeholder?: string;
  onChange(value: string): void;
  read?(): string;
}

export interface NumberField extends FieldBase {
  kind: "number";
  value: number;
  step?: number;
  min?: number;
  onChange(value: number): void;
  read?(): number;
}

export interface ToggleField extends FieldBase {
  kind: "toggle";
  value: boolean;
  onText?: string;
  offText?: string;
  onChange(value: boolean): void;
  read?(): boolean;
}

export interface Vector3Field extends FieldBase {
  kind: "vec3";
  value: [number, number, number];
  step?: number;
  /** Defaults to X/Y/Z. Box size reads better as W/H/D. */
  axisLabels?: [string, string, string];
  onChange(axis: 0 | 1 | 2, value: number): void;
  read?(): [number, number, number];
}

export interface InfoField extends FieldBase {
  kind: "info";
  value: string;
  /** Tints the value — used for the live "Overlapping / Clear" readout. */
  accent?: "normal" | "good" | "warn";
  read?(): string;
  readAccent?(): "normal" | "good" | "warn";
}

export interface ButtonsField {
  kind: "buttons";
  label?: string;
  buttons: { text: string; title?: string; danger?: boolean; onClick(): void }[];
}

/** A reference to a scene object, assignable by the same two gestures Control Desk uses: the ⊙ Pick button, or a Hierarchy row dragged onto it. */
export interface ObjectRefField extends FieldBase {
  kind: "objectRef";
  value: string;
  onPick(): void;
  onClear(): void;
  /** Called with the dragged object once a Hierarchy row is dropped on the row. */
  onDropObject(object: THREE.Object3D): void;
  read?(): string;
}

/** A fixed set of choices — a shape kind, a blend mode, a simulation space. Rendered as a native `<select>`. */
export interface SelectField extends FieldBase {
  kind: "select";
  value: string;
  options: { value: string; label: string }[];
  onChange(value: string): void;
  read?(): string;
}

/**
 * A min/max pair on one row.
 *
 * Its own kind rather than two NumberFields because a range is one
 * concept: the label belongs to the pair, and the particle system has
 * roughly twenty of them (lifetime, speed, size, rotation, alpha, rate,
 * angular velocity, …). Two separate rows per range would double the
 * Inspector's height for no gain and would let min drift above max with
 * nothing noticing — this clamps on write.
 */
export interface RangeField extends FieldBase {
  kind: "range";
  min: number;
  max: number;
  step?: number;
  /** Lower bound on both ends. A lifetime below zero is never meaningful. */
  clampMin?: number;
  onChange(min: number, max: number): void;
  read?(): [number, number];
}

/** An RGB color, edited through a native swatch. Values are 0..1 linear (THREE.Color's own range), converted to/from hex at the DOM edge. */
export interface ColorField extends FieldBase {
  kind: "color";
  value: [number, number, number];
  onChange(rgb: [number, number, number]): void;
  read?(): [number, number, number];
}

/** A bounded scalar with a visible track — for the 0..1 knobs (opacity, probability, thickness) where dragging beats typing. */
export interface SliderField extends FieldBase {
  kind: "slider";
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange(value: number): void;
  read?(): number;
}

export type InspectorField =
  | TextField
  | NumberField
  | ToggleField
  | Vector3Field
  | InfoField
  | ButtonsField
  | ObjectRefField
  | SelectField
  | RangeField
  | ColorField
  | SliderField;

export interface InspectorSection {
  /** Stable across rebuilds — used as the DOM key so a rebuild doesn't restart a CSS transition mid-flight, and as the key the Inspector remembers collapse state under. */
  id: string;
  title: string;
  /** Small pill after the title, e.g. "TRIGGER". */
  badge?: string;
  badgeTone?: "trigger" | "solid" | "off";
  fields: InspectorField[];
  /**
   * Renders with a ▸/▾ header that hides the body.
   *
   * The particle Inspector has sixteen modules; without collapsing,
   * selecting an emitter produces a wall of a hundred-odd rows and finding
   * the one you want is scrolling, not looking. Collider panels don't set
   * this and are unaffected.
   */
  collapsible?: boolean;
  /** Only consulted the first time a section id is seen — after that the user's own collapse state wins and survives rebuilds. */
  defaultOpen?: boolean;
  /**
   * An enable switch rendered *in the header*.
   *
   * This is what makes "modules can be enabled/disabled independently so
   * the editor only evaluates what is actually active" a visible property
   * of the panel rather than a buried row: the toggle sits next to the
   * module's name, and a disabled module collapses its body away.
   */
  moduleToggle?: {
    value: boolean;
    onChange(value: boolean): void;
    read?(): boolean;
  };
}

/**
 * Contributes sections for the currently-selected object.
 *
 * `version` must change whenever a section's *structure* would differ (a
 * collider's shape switching from box to sphere swaps a vec3 row for two
 * number rows; a particle emitter's shape doing the same) — the Inspector
 * polls it to decide when a rebuild is actually warranted, instead of
 * rebuilding every frame or never.
 *
 * `describe` may return one section or several. One provider contributing
 * many sections is how the particle editor shows its sixteen modules as
 * sixteen collapsible panels while still being a single registration.
 */
export interface InspectorSectionProvider {
  readonly version: number;
  describe(object: THREE.Object3D): InspectorSection | InspectorSection[] | undefined;
}
