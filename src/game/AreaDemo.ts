import { Ion } from "../engine/Ion";
import type { Collider, ColliderEventHandle } from "../engine/collision";

/**
 * The worked example for the ION Collider & Area system — every part of
 * the runtime API in about forty lines of gameplay code, wired to the
 * colliders that ship in src/game/colliders.json and the cylinder the
 * Player builds for itself.
 *
 * The setup it demonstrates is the one from the spec: a trigger tagged
 * `PlayerZone` that responds *only* to the player. Two separate mechanisms
 * do that, and they're worth telling apart:
 *
 *  - `mask: ["Player"]` on the zone (set in colliders.json) is the
 *    **broad-phase filter**. A pair the mask rejects is never intersection-
 *    tested at all, so a scene full of colliders costs nothing for a zone
 *    that only cares about one of them.
 *  - The `"Player"` first argument to `onTriggerEnter` below is the
 *    **handler filter**. It's what keeps a handler from having to open with
 *    `if (other.tag !== "Player") return;`.
 *
 * In this game they agree, which is the normal case. They're separate
 * because a zone that wants to *see* several tags but *react* differently
 * to each needs the wide mask and the narrow handlers.
 *
 * Nothing here is physics. Nothing is moved, blocked, or pushed — the zone
 * reports, and gameplay decides.
 */
export class AreaDemo {
  /**
   * The trigger this demo listens to — **assignable from the 3D editor.**
   *
   * A `Collider`-typed public field gets a `⊙ Pick` button in Control Desk
   * exactly like a `THREE.Object3D` one does, and accepts a collider
   * dragged out of the Hierarchy's COLLIDERS group or clicked directly on
   * its volume in the viewport. The assignment persists to
   * `src/game/sceneBindings.json` and is re-applied on every boot, so
   * pointing this at a different zone is a two-click change with no code
   * edit — which is the whole reason the field exists rather than the
   * lookup below being the only way in.
   *
   * Left `undefined` until something assigns it; `wire()` falls back to
   * finding "PlayerZone" by name so the demo works out of the box.
   */
  public zone: Collider | undefined;

  private readonly handles: ColliderEventHandle[] = [];
  private inside = false;
  /** onTriggerStay fires every frame; a console line per frame is unreadable. */
  private lastStayLog = 0;

  /**
   * Subscribes to whatever `zone` ended up pointing at.
   *
   * Deliberately not the constructor. Editor-assigned fields are written by
   * `Game.ts`'s `applySceneBindings` pass, which runs *after* every
   * inspectable has been constructed — so a constructor reading `this.zone`
   * would always see `undefined` and silently fall back, making the
   * assignment look broken. `Game.ts` calls this straight after that pass.
   */
  wire(): void {
    // Editor-authored data can point a field at the wrong kind of thing —
    // an older binding that recorded a collider's *node* instead of the
    // collider, say. Check for the API rather than trusting the type
    // annotation, and fall back instead of taking the boot down with a
    // "not a function" on a field somebody set by clicking.
    if (this.zone && typeof this.zone.onTriggerEnter !== "function") {
      if (import.meta.env.DEV) console.warn("AreaDemo.zone isn't a Collider — re-assign it in Control Desk. Falling back to the PlayerZone lookup.");
      this.zone = undefined;
    }
    const zone = this.zone ?? Ion.colliders.getByName("PlayerZone");
    if (!zone) {
      // Not a crash: colliders.json is editor-authored data, and a zone
      // someone renamed or deleted in the 3D editor shouldn't take the
      // playable down with it.
      if (import.meta.env.DEV) console.warn('AreaDemo: no collider named "PlayerZone" — open the 3D editor\'s Configure Colliders mode to add one, or assign AreaDemo.zone in Control Desk.');
      return;
    }
    // Re-wiring after a hot reload or a re-assignment must not stack a
    // second set of handlers on top of the first.
    this.dispose();
    this.zone = zone;

    this.handles.push(
      zone.onTriggerEnter("Player", (other) => {
        this.inside = true;
        // checkTag() rather than `other.tag === ...`: same answer, and it's
        // the spelling that keeps working if a collider ever carries more
        // than one tag.
        console.log(`[Area] ${other.name} (tag "${other.tag}") entered ${zone.name} — checkTag("Player") = ${other.checkTag("Player")}`);
        Ion.emit("area:enter", { zone: zone.name, other: other.name });
      })
    );

    this.handles.push(
      zone.onTriggerStay("Player", () => {
        if (Ion.time - this.lastStayLog < 1) return;
        this.lastStayLog = Ion.time;
        console.log(`[Area] still inside ${zone.name}`);
      })
    );

    this.handles.push(
      zone.onTriggerExit("Player", (other) => {
        this.inside = false;
        console.log(`[Area] ${other.name} left ${zone.name}`);
        Ion.emit("area:exit", { zone: zone.name, other: other.name });
      })
    );
  }

  /** Whether the player is in the zone right now — the state a real playable would drive a prompt or a bonus multiplier off. */
  get playerInZone(): boolean {
    return this.inside;
  }

  /** Every handler dropped and the subscription list emptied — called from Game.dispose so a hot reload can't leave the old bundle's handlers listening. */
  dispose(): void {
    for (const off of this.handles) off();
    this.handles.length = 0;
  }
}
