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

export type InspectorField = TextField | NumberField | ToggleField | Vector3Field | InfoField | ButtonsField | ObjectRefField;

export interface InspectorSection {
  /** Stable across rebuilds — used as the DOM key so a rebuild doesn't restart a CSS transition mid-flight. */
  id: string;
  title: string;
  /** Small pill after the title, e.g. "TRIGGER". */
  badge?: string;
  badgeTone?: "trigger" | "solid" | "off";
  fields: InspectorField[];
}

/**
 * Contributes zero or one section for the currently-selected object.
 *
 * `version` must change whenever the section's *structure* would differ
 * (a collider's shape switching from box to sphere swaps a vec3 row for
 * two number rows) — the Inspector polls it to decide when a rebuild is
 * actually warranted, instead of rebuilding every frame or never.
 */
export interface InspectorSectionProvider {
  readonly version: number;
  describe(object: THREE.Object3D): InspectorSection | undefined;
}
