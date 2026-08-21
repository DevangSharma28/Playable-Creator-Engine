import type * as THREE from "three";
import type { EditorSelection } from "./EditorSelection";
import type { EditorObjectPicker } from "./EditorObjectPicker";
import { OBJECT_DRAG_MIME, type EditorDragSource } from "./EditorDragSource";

export interface EditorHierarchyOptions {
  scene: THREE.Scene;
  container: HTMLElement;
  /** Editor-owned debug visuals — hidden from the tree, same set the picker refuses to select. */
  excluded: Set<THREE.Object3D>;
  selection: EditorSelection;
  /** Clicks route through the picker so a hierarchy click can resolve an armed Control Desk "Pick" exactly like a viewport click does. */
  picker: EditorObjectPicker;
  /** Rows are draggable straight onto a Control Desk object field — the drag's payload rides here (see EditorDragSource for why the object travels beside the DataTransfer, not only inside it). */
  dragSource: EditorDragSource;
}

/**
 * The scene's full Object3D tree, as a clickable, collapsible list.
 *
 * Things it does that a flat always-expanded list doesn't:
 *
 *  - **It's collapsible.** A GLB-heavy scene is easily hundreds of nodes;
 *    only the top level (direct children of the scene root) starts
 *    expanded, everything else starts collapsed behind a ▸/▾ toggle. Open
 *    state is per-uuid (`openState`), not reset by a rebuild, so
 *    collapsing a subtree survives the scene changing elsewhere.
 *  - **It refreshes.** `refreshIfChanged()` runs from the editor's frame
 *    update and rebuilds only when the graph's actual shape changed
 *    (`computeSignature()` walks the *real* scene graph, not the DOM, so
 *    this still notices a change inside a currently-collapsed subtree) —
 *    so a static scene costs one cheap traversal per frame and nothing
 *    else.
 *  - **It follows selection it didn't cause**, expanding whatever
 *    ancestors are necessary. Selecting an object in the 3D viewport (or
 *    pressing `.` to re-find the current selection — see `revealSelection`)
 *    opens every collapsed ancestor, highlights the row, and scrolls it
 *    into view. That's the `source` field on EditorSelection earning its
 *    keep: when the click came from this panel the row is already visible
 *    and expanding/scrolling would just yank the list under the cursor.
 */
export class EditorHierarchy {
  private readonly opts: EditorHierarchyOptions;
  private readonly unsubscribe: () => void;
  private readonly rowsByUuid = new Map<string, HTMLElement>();
  /** Explicit open/closed overrides, keyed by uuid — absent means "use the default" (see isOpen). Persists across rebuilds so collapsing a subtree survives an unrelated part of the scene changing. */
  private readonly openState = new Map<string, boolean>();
  /** Cheap shape signature of the last build — compared per frame to decide whether a rebuild is warranted. */
  private lastSignature = "";

  constructor(opts: EditorHierarchyOptions) {
    this.opts = opts;
    this.unsubscribe = opts.selection.subscribe((state) => {
      // An external selection (viewport click, Control Desk, a hot-reload
      // restoring state) may point at something inside a collapsed
      // subtree — open whatever's necessary before trying to highlight or
      // scroll to it. A selection made *from this panel* skips this: the
      // row the user just clicked is already open and visible by
      // definition.
      if (state.object && state.source !== "hierarchy") this.ensureAncestorsOpen(state.object);
      this.rebuild();
    });
    window.addEventListener("keydown", this.onKeyDown);
    this.rebuild();
  }

  /** Called once per editor frame — cheap when nothing changed. */
  refreshIfChanged(): void {
    if (this.computeSignature() !== this.lastSignature) this.rebuild();
  }

  /**
   * "." — re-finds whatever's currently selected: opens every collapsed
   * ancestor, scrolls its row to the center of the panel, and gives it a
   * brief highlight flash so it's unmistakable even if it was already
   * visible.
   */
  revealSelection(): void {
    const obj = this.opts.selection.object;
    if (!obj) return;
    this.ensureAncestorsOpen(obj);
    this.rebuild();
    const row = this.rowsByUuid.get(obj.uuid);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.classList.add("flash");
    window.setTimeout(() => row.classList.remove("flash"), 650);
  }

  dispose(): void {
    this.unsubscribe();
    window.removeEventListener("keydown", this.onKeyDown);
    this.rowsByUuid.clear();
    this.openState.clear();
    this.opts.container.innerHTML = "";
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== ".") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const active = document.activeElement as HTMLElement | null;
    if (active?.tagName === "INPUT" || active?.tagName === "TEXTAREA" || active?.isContentEditable) return; // Inspector's number fields use "." for decimals — never steal it there
    e.preventDefault();
    this.revealSelection();
  };

  /** Default open state: only true top-level nodes (direct children of the scene) start expanded — everything deeper starts collapsed until toggled or revealed. */
  private isOpen(node: THREE.Object3D): boolean {
    const explicit = this.openState.get(node.uuid);
    return explicit ?? node.parent === this.opts.scene;
  }

  private setOpen(node: THREE.Object3D, open: boolean): void {
    this.openState.set(node.uuid, open);
  }

  private toggleOpen(node: THREE.Object3D): void {
    this.setOpen(node, !this.isOpen(node));
  }

  /** Opens every ancestor of `object` (never `object` itself — its own open state only governs whether *its* children show) so its row actually exists in the tree once rebuilt. */
  private ensureAncestorsOpen(object: THREE.Object3D): void {
    let node = object.parent;
    while (node && node !== this.opts.scene) {
      if (!this.isOpen(node)) this.setOpen(node, true);
      node = node.parent;
    }
  }

  private hasVisibleChildren(obj: THREE.Object3D): boolean {
    return obj.children.some((child) => !this.opts.excluded.has(child));
  }

  private rebuild(): void {
    this.rowsByUuid.clear();
    this.opts.container.innerHTML = "";
    this.opts.container.appendChild(this.buildRows(this.opts.scene, 0));
    this.lastSignature = this.computeSignature();
    this.applySelection(this.opts.selection.object, this.opts.selection.state.source);
  }

  /**
   * Identity + structure, not just a count: a pooled object being swapped
   * for another at the same index changes the uuid list without changing
   * its length, and that has to still count as "the tree changed". Walks
   * the real scene graph, not the DOM, so it still notices a change inside
   * a currently-collapsed (and therefore unrendered) subtree.
   */
  private computeSignature(): string {
    const parts: string[] = [];
    const walk = (obj: THREE.Object3D, depth: number): void => {
      for (const child of obj.children) {
        if (this.opts.excluded.has(child)) continue;
        parts.push(`${depth}:${child.uuid}`);
        walk(child, depth + 1);
      }
    };
    walk(this.opts.scene, 0);
    return parts.join("|");
  }

  private buildRows(obj: THREE.Object3D, depth: number): DocumentFragment {
    const fragment = document.createDocumentFragment();
    for (const child of obj.children) {
      if (this.opts.excluded.has(child)) continue;
      const hasChildren = this.hasVisibleChildren(child);
      const open = hasChildren && this.isOpen(child);

      const row = document.createElement("div");
      row.className = "si-row";
      row.style.paddingLeft = `${depth * 12 + 4}px`;
      row.title = `${child.name || "(unnamed)"} — ${child.type}`;
      row.dataset.uuid = child.uuid;

      const toggle = document.createElement("span");
      toggle.className = "si-row-toggle";
      if (hasChildren) {
        toggle.textContent = open ? "▾" : "▸"; // ▾ / ▸
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          this.toggleOpen(child);
          this.rebuild();
        });
      } else {
        toggle.classList.add("si-row-toggle-spacer");
      }
      row.appendChild(toggle);

      const label = document.createElement("span");
      label.className = "si-row-label";
      label.textContent = `${iconFor(child)} ${child.name || child.type}`;
      row.appendChild(label);

      row.addEventListener("click", (e) => {
        e.stopPropagation();
        this.opts.picker.offerObject(child, "hierarchy");
      });

      // Drag straight onto a Control Desk object field — the second way to
      // assign one, alongside the ⊙ Pick button, matching the affordance
      // the UI editor's Layers -> Scripts panel already offers for UI
      // elements. The uuid is the payload; the live object rides on
      // dragSource because DataTransfer can't be read during dragover (see
      // EditorDragSource).
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        this.opts.dragSource.begin(child);
        e.dataTransfer?.setData(OBJECT_DRAG_MIME, child.uuid);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => {
        // Fires on success, refusal, and Escape alike — the one place that
        // reliably clears the drag.
        this.opts.dragSource.end();
        row.classList.remove("dragging");
      });

      this.rowsByUuid.set(child.uuid, row);
      fragment.appendChild(row);
      if (open) fragment.appendChild(this.buildRows(child, depth + 1));
    }
    return fragment;
  }

  private applySelection(object: THREE.Object3D | undefined, source: string): void {
    for (const row of this.rowsByUuid.values()) row.classList.remove("selected");
    if (!object) return;
    const row = this.rowsByUuid.get(object.uuid);
    if (!row) return; // still inside a collapsed subtree — ensureAncestorsOpen only runs for non-hierarchy sources, see the constructor's subscribe callback
    row.classList.add("selected");
    // Only when the user's attention isn't already on this list — see the
    // class doc comment.
    if (source !== "hierarchy") row.scrollIntoView({ block: "nearest" });
  }
}

function iconFor(obj: THREE.Object3D): string {
  if ((obj as THREE.Light).isLight) return "\u{1F4A1}"; // 💡
  if ((obj as THREE.Camera).isCamera) return "\u{1F3A5}"; // 🎥
  if ((obj as THREE.Mesh).isMesh) return "\u{1F536}"; // 🔶
  return "\u{1F4E6}"; // 📦
}
