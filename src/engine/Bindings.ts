import type { UILayout } from "./ui/UILayout";

/** One drag-and-drop assignment from the UI editor's Scripts panel — "this class's field gets that designed UI element." */
export interface FieldBinding {
  className: string;
  fieldName: string;
  uiElementName: string;
}

export interface BindingsData {
  version: number;
  bindings: FieldBinding[];
}

/**
 * Resolves every binding for `className` against `layouts` and writes each
 * one straight onto `instance` — the runtime half of the UI editor's
 * Scripts panel drag-and-drop (see tools/ui-editor.html's field rows,
 * scripts/dev-build-api.js's /save-binding). A field declared as
 * `public moneyIcon: HTMLElement | undefined;` and drag-assigned to
 * "coin-icon" in the editor gets that element written to it here, instead
 * of the class's own constructor needing to call `main.get("coin-icon")`
 * by hand.
 *
 * This is a single explicit call, not invisible magic — there's no
 * reflection or DI container backing it (plain compiled JS classes have
 * none), so something has to actually invoke this once per instance whose
 * class has editor-assigned fields. Call it right after constructing that
 * instance, same as Game.ts does for HUD. Layouts are searched in the
 * order given; the first one that actually has the named element wins.
 */
export function applyBindings(instance: object, className: string, data: BindingsData, ...layouts: UILayout[]): void {
  for (const binding of data.bindings) {
    if (binding.className !== className) continue;
    const element = layouts.map((layout) => layout.get(binding.uiElementName)).find((el) => el !== undefined);
    if (element !== undefined) {
      (instance as Record<string, unknown>)[binding.fieldName] = element;
    }
  }
}
