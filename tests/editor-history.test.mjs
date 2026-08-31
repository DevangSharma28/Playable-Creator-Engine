/**
 * Undo and Redo.
 *
 * The editors are where a client's real time goes, and history is the thing
 * standing between a mis-drag and losing it. The properties worth pinning down
 * are the ones that are easy to get subtly wrong and impossible to notice
 * until they matter: that a redo stack is dropped the moment you diverge, that
 * a slider drag is one step rather than sixty, that the dirty flag follows the
 * state rather than "has anything ever happened", and that a bounded history
 * releases what it drops.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { installDom } from "./lib/dom-env.mjs";

const dom = installDom();
test.after(() => dom.restore());

// fileURLToPath, not the URL's own .pathname: a file:// URL's pathname on
// Windows is "/D:/Self/...", which readFileSync then resolves against the
// process's current drive, producing "D:\D:\Self\..." — fileURLToPath is
// the platform-correct way to turn a file URL back into an fs path.
const { EditorHistory, propertyCommand } = await import("./lib/load-ts.mjs").then(({ loadTsModule }) =>
  loadTsModule(fileURLToPath(new URL("../src/engine/editor/EditorHistory.ts", import.meta.url)))
);

/** A command that just moves a number, with a record of what was called. */
function valueCommand(box, from, to, options = {}) {
  return {
    label: options.label ?? "Set value",
    mergeKey: options.mergeKey,
    undo() { box.value = from; box.undos = (box.undos ?? 0) + 1; },
    redo() { box.value = to; box.redos = (box.redos ?? 0) + 1; },
    discard(state) { (box.discarded ??= []).push(state); },
  };
}

test("basic stack behaviour", async (t) => {
  await t.test("starts empty and clean", () => {
    const history = new EditorHistory();
    assert.equal(history.canUndo, false);
    assert.equal(history.canRedo, false);
    assert.equal(history.isDirty, false);
    assert.equal(history.undo(), false, "undo on an empty stack should report that it did nothing");
    assert.equal(history.redo(), false);
  });

  await t.test("undo and redo walk the stack in order", () => {
    const history = new EditorHistory();
    const box = { value: 0 };
    box.value = 1;
    history.push(valueCommand(box, 0, 1, { label: "First" }));
    box.value = 2;
    history.push(valueCommand(box, 1, 2, { label: "Second" }));

    assert.equal(history.undoLabel, "Second");
    assert.equal(history.undo(), true);
    assert.equal(box.value, 1);
    assert.equal(history.undo(), true);
    assert.equal(box.value, 0);
    assert.equal(history.canUndo, false);

    assert.equal(history.redoLabel, "First");
    history.redo();
    assert.equal(box.value, 1);
    history.redo();
    assert.equal(box.value, 2);
    assert.equal(history.canRedo, false);
  });

  await t.test("a new edit after an undo discards the redo stack", () => {
    // Diverging has to drop the future, or Redo replays a change against a
    // state it was never recorded on.
    const history = new EditorHistory();
    const box = { value: 0 };
    history.push(valueCommand(box, 0, 1));
    history.undo();
    assert.equal(history.canRedo, true);
    history.push(valueCommand(box, 0, 9));
    assert.equal(history.canRedo, false, "the redo stack survived a divergent edit");
  });

  await t.test("a discarded command is told which side it was on", () => {
    const history = new EditorHistory();
    const box = { value: 0 };
    history.push(valueCommand(box, 0, 1));
    history.undo();
    // Now on the redo stack: its undo() is the live state, so it is "unapplied".
    history.push(valueCommand(box, 0, 2));
    assert.deepEqual(box.discarded, ["unapplied"]);
  });

  await t.test("clear() empties both stacks and releases every entry", () => {
    const history = new EditorHistory();
    const box = { value: 0 };
    history.push(valueCommand(box, 0, 1));
    history.push(valueCommand(box, 1, 2));
    history.undo();
    history.clear();
    assert.equal(history.canUndo, false);
    assert.equal(history.canRedo, false);
    assert.equal(box.discarded?.length, 2, "clear() dropped entries without discarding them");
  });
});

test("merging", async (t) => {
  await t.test("a drag collapses into one step that undoes to where it started", () => {
    const history = new EditorHistory();
    const box = { value: 0 };
    // Sixty slider events with the same merge key — one gesture.
    for (let step = 1; step <= 60; step++) {
      history.push(valueCommand(box, step - 1, step, { mergeKey: "emitter.rate" }));
      box.value = step;
    }
    assert.equal(history.depth, 1, `a drag produced ${history.depth} undo steps`);
    history.undo();
    assert.equal(box.value, 0, "undo did not return to the value the gesture started from");
    history.redo();
    assert.equal(box.value, 60, "redo did not return to the value the gesture ended at");
  });

  await t.test("different keys do not merge", () => {
    const history = new EditorHistory();
    const box = { value: 0 };
    history.push(valueCommand(box, 0, 1, { mergeKey: "a" }));
    history.push(valueCommand(box, 1, 2, { mergeKey: "b" }));
    assert.equal(history.depth, 2);
  });

  await t.test("commands with no key never merge", () => {
    const history = new EditorHistory();
    const box = { value: 0 };
    for (let i = 0; i < 5; i++) history.push(valueCommand(box, i, i + 1));
    assert.equal(history.depth, 5);
  });
});

test("dirty tracking", async (t) => {
  await t.test("undoing back to the saved point reports clean again", () => {
    // Tracked by depth rather than a boolean, so this actually holds.
    const history = new EditorHistory();
    const box = { value: 0 };
    history.push(valueCommand(box, 0, 1));
    assert.equal(history.isDirty, true);
    history.markSaved();
    assert.equal(history.isDirty, false);
    history.push(valueCommand(box, 1, 2));
    assert.equal(history.isDirty, true);
    history.undo();
    assert.equal(history.isDirty, false, "undoing back to the save point still reported unsaved changes");
    history.redo();
    assert.equal(history.isDirty, true);
  });
});

test("bounds", async (t) => {
  await t.test("the stack is capped and drops its oldest entries", () => {
    // Delete commands hold detached objects and their GPU buffers, so an
    // unbounded history is a leak with a long fuse.
    const history = new EditorHistory();
    const box = { value: 0 };
    for (let i = 0; i < 500; i++) history.push(valueCommand(box, i, i + 1));
    assert.ok(history.depth <= 200, `history grew to ${history.depth}`);
    assert.ok(box.discarded.length >= 300, "dropped entries were never discarded");
    assert.ok(box.discarded.every((state) => state === "applied"), "an evicted applied command was discarded as unapplied");
  });
});

test("re-entrancy", async (t) => {
  await t.test("a change made by undo() is not recorded as a new user action", () => {
    // Editor change handlers fire while a command is being applied. Without
    // the guard, undo pushes its own inverse and the stack becomes unusable.
    const history = new EditorHistory();
    const box = { value: 0 };
    history.push({
      label: "Reentrant",
      undo() {
        assert.equal(history.isApplying, true, "isApplying was not set during undo");
        history.push(valueCommand(box, 0, 1));
      },
      redo() {},
    });
    history.undo();
    assert.equal(history.depth, 0, "a push made during undo was recorded");
  });
});

test("notification", async (t) => {
  await t.test("listeners fire on push, undo, redo and clear", () => {
    const history = new EditorHistory();
    let calls = 0;
    const unsubscribe = history.subscribe(() => calls++);
    const box = { value: 0 };
    history.push(valueCommand(box, 0, 1));
    const afterPush = calls;
    history.undo();
    const afterUndo = calls;
    history.redo();
    history.clear();
    assert.ok(afterPush > 0, "push did not notify");
    assert.ok(afterUndo > afterPush, "undo did not notify");
    assert.ok(calls > afterUndo, "redo/clear did not notify");

    // Unsubscribing has to actually stop them: the editor rebuilds panels
    // constantly, and a listener that outlives its panel keeps a disposed one
    // alive and repaints into detached DOM.
    unsubscribe();
    const afterUnsubscribe = calls;
    history.push(valueCommand(box, 0, 1));
    assert.equal(calls, afterUnsubscribe, "an unsubscribed listener still fired");
  });
});

test("propertyCommand", async (t) => {
  await t.test("captures before and after and restores through the setter", () => {
    const target = { intensity: 1 };
    const command = propertyCommand({
      label: "Intensity",
      mergeKey: "light.intensity",
      before: 1,
      after: 2.5,
      apply: (value) => { target.intensity = value; },
    });
    target.intensity = 2.5;
    command.undo();
    assert.equal(target.intensity, 1);
    command.redo();
    assert.equal(target.intensity, 2.5);
    assert.equal(command.mergeKey, "light.intensity");
  });
});
