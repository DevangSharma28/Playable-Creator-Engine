// ============================================================================
// 📦 IMPORTS
// ============================================================================

import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { applySceneBindings, type SceneBindingsData } from "../../engine/SceneBindings";
import sceneBindingsRaw from "../sceneBindings.json";
import { Easing } from "../../engine/Ion";
import { Animator, LoopAnimator } from "../../engine/core/Animator";
import { Ion } from "../../engine/Ion";
import type { CylinderCollider } from "../../engine/collision";
import type { World } from "../world/World";
import { lerp } from "three/src/math/MathUtils.js";


// ============================================================================
// ⚙️ CONSTANTS
// ============================================================================

const CROSSFADE_DURATION = 0.2;

/**
 * World up, handed to every moveAndSlide call.
 *
 * Without it a collider resolves along whichever axis is cheapest to
 * escape, and for a knee-high wall that's straight up — the player would
 * climb the scenery instead of being stopped by it. See
 * ColliderManager.moveAndSlide.
 */
const UP = new THREE.Vector3(0, 1, 0);
/** Reused every frame — this runs in update(), where a per-frame Vector3 is garbage the collector has to keep up with. */
const moveDelta = new THREE.Vector3();
/** How far in from the play area's edge the player is held — roughly the character's own radius, so the body stays off the wall rather than intersecting it. */
const PLAYER_EDGE_MARGIN = 0.4;


// ============================================================================
// 🎮 PLAYER CLASS
// Handles:
// - Character Model
// - Movement
// - Animation
// - Rotation
// ============================================================================


export class Player {

  // ==========================================================================
  // 📌 PUBLIC PROPERTIES
  // Accessible from outside the class
  // ==========================================================================

  private readonly player: THREE.Group;


  public popcornMachine!: THREE.Object3D

  // ==========================================================================
  // 🔒 PRIVATE VARIABLES
  // Internal data used only by Player
  // ==========================================================================

  // Header("Player settings")
  public speed: number = 4;

  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private currentAction: THREE.AnimationAction | null = null;
  /** One-shot guard for revealPopcornMachine() — see its own call site in update() for why this can't just fire from the constructor. */
  private aAnimator: Animator | undefined

  /**
   * The player's own collision volume — a cylinder, the standard character
   * shape: rotation-invariant about the up axis (so walking into a doorway
   * behaves the same whichever way you're facing, which a box does not)
   * while still having a real height, which a sphere does not.
   *
   * Not physics. It never blocks or pushes the player — movement is still
   * the clamp in update(). All it does is let *other* colliders notice the
   * player, which is what makes the `PlayerZone` trigger in colliders.json
   * work (see src/game/AreaDemo.ts).
   */
  public collider: CylinderCollider | undefined;


  // ==========================================================================
  // 🚀 CONSTRUCTOR
  // Initializes player, animations and model
  // ==========================================================================

  constructor(
    scene: THREE.Scene,
    /** The measured play area. Was a single origin-centred half-extent, which is why the clamp in update() below had been commented out — see World's doc comment. */
    private readonly world: World,
    model: THREE.Group,
    clips: THREE.AnimationClip[]
  ) {

    // ------------------------------------------------------------------------
    // Clone Character
    // ------------------------------------------------------------------------

    this.player = skeletonClone(model) as THREE.Group;

    // ------------------------------------------------------------------------
    // Animation Mixer
    // ------------------------------------------------------------------------

    this.mixer = new THREE.AnimationMixer(this.player);


    // ------------------------------------------------------------------------
    // Editor-Assigned Scene Objects
    // ------------------------------------------------------------------------
    // Same pattern (and same reason) as HUD.ts's applyBindings call: Game.ts
    // also applies scene bindings across its whole inspectables map, but that
    // runs *after* `new Player(...)` has already returned — so any field
    // assigned in the 3D editor is still undefined inside this constructor
    // unless the class populates it itself, right here. The scene graph is
    // ready by now (Game.ts adds the environment GLB before constructing the
    // player), so the binding resolves.
    applySceneBindings(this, "Player", sceneBindingsRaw as SceneBindingsData, scene);

    // Still guarded: a binding only resolves if the object it points at is
    // actually in the scene. Rename or remove that node in the GLB and this
    // field goes undefined again — the `!` on its declaration silences the
    // compiler about that, it doesn't prevent it.
    if (this.popcornMachine) {
      this.popcornMachine.visible = true;
      this.popcornMachine.scale.setScalar(0);
    }


    // ------------------------------------------------------------------------
    // Load All Animations
    // ------------------------------------------------------------------------

    for (const clip of clips) {
      const action = this.mixer.clipAction(clip);
      this.actions.set(clip.name, action);
    }


    // ------------------------------------------------------------------------
    // Play Default Idle Animation
    // ------------------------------------------------------------------------

    const idle = this.actions.get("Idle")
    if (idle) {
      idle.play();
      this.currentAction = idle;
    }


    // ------------------------------------------------------------------------
    // Hide Unused Objects
    // ------------------------------------------------------------------------

    this.player.traverse((child) => {
      if (
        child.name === "Main_Character" ||
        child.name === "Arrow" ||
        child.name === "Main_Female_Character_Upgrade_2"
        // child.name === "Main_Character_Upgrade_1"                             
      ) {
        child.visible = false;
      }
    });


    // ------------------------------------------------------------------------
    // Enable Shadow Casting
    // ------------------------------------------------------------------------

    this.player.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true;
      }
    });


    // ------------------------------------------------------------------------
    // Add Player To Scene
    // ------------------------------------------------------------------------

    scene.add(this.player);


    // ------------------------------------------------------------------------
    // Collision Volume
    // ------------------------------------------------------------------------
    // Attached to the player group rather than positioned each frame:
    // ColliderManager recomputes the collider's world transform from the
    // group's world matrix every frame, so it follows movement and turning
    // for free and there is nothing to keep in sync here.
    //
    // Safe to do in a constructor, unlike Animator: IonEngine binds the Ion
    // context *before* Game.create() runs precisely so entities can
    // register their own colliders where they build their model. Ion.after/
    // Ion.tween are fine here now too — the deferred reveal below is left
    // as-is because it's about timing, not availability.
    // this.collider = Ion.colliders.cylinder({
    //   name: "Player Collider",
    //   tag: "Player",
    //   radius: 0.3,
    //   height: 1.5,
    //   attachTo: this.player,
    //   // Half the height, so the cylinder stands on the ground plane instead
    //   // of being centered on the player's feet and sinking half of it.
    //   position: [0, 0.8, 0],
    // });

    setTimeout(() => {
      this.revealPopcornMachine(this.popcornMachine);
    }, 1000);

  }


  // ==========================================================================
  // 📍 GETTERS
  // Read-only properties
  // ==========================================================================

  get position(): THREE.Vector3 {
    return this.player.position;
  }


  // ==========================================================================
  // 🎬 ANIMATION
  // Handles animation switching with smooth crossfade
  // ==========================================================================

  play(name: string): void {

    const action = this.actions.get(name);

    if (!action || action === this.currentAction)
      return;

    if (this.currentAction) {
      this.currentAction.crossFadeTo(
        action,
        CROSSFADE_DURATION,
        false
      );
    }

    action.reset().play();
    this.currentAction = action;
  }


  // ==========================================================================
  // 🔄 UPDATE
  // Called every frame
  // ==========================================================================
  update(
    dt: number,
    _elapsed: number,
    axis: { x: number; y: number }
  ): void {

    // ------------------------------------------------------------------------
    // Check Movement
    // ------------------------------------------------------------------------

    const moving = axis.x !== 0 || axis.y !== 0;
    // ------------------------------------------------------------------------
    // Move Character
    // ------------------------------------------------------------------------



    if (moving) {

      // --------------------------------------------------------------------
      // Move, and let solid colliders stop us
      // --------------------------------------------------------------------
      // moveAndSlide applies the delta and then pushes back out of any
      // non-trigger collider we ended up inside — walls, props, anything
      // marked solid in the 3D editor's Configure Colliders mode. Still no
      // physics: nothing pushes back, we're just placed where we'd have to
      // be in order not to be inside a wall. Sliding along one falls out of
      // that for free, since the push is perpendicular to the surface and
      // the along-the-wall part of the movement survives it.
      //
      // Triggers are deliberately not solid, so PlayerZone keeps being
      // something you walk into rather than something that blocks you.
      moveDelta.set(axis.x * this.speed * dt, 0, axis.y * this.speed * dt);
      if (this.collider) { Ion.colliders.moveAndSlide(this.collider, this.player.position, moveDelta, { up: UP }); }
      else { this.player.position.add(moveDelta); }


      // ----------------------------------------------------------------------
      // Keep Player Inside Bounds
      // ----------------------------------------------------------------------

      // A backstop behind the solid colliders above, not a replacement for
      // them: colliders stop you at the walls that were actually authored,
      // and this stops you leaving the room through a gap where none was.
      // It clamps to the *measured* play area — the version of this that
      // clamped to a ±10 box around the origin pinned the player to a
      // corner of a room that isn't centred there, which is why it had been
      // commented out rather than fixed.
      this.world.clamp(this.player.position, PLAYER_EDGE_MARGIN);

      // The clamp can move the body without the collider knowing, and the
      // next frame's moveAndSlide starts from the collider's last synced
      // world shape — so re-sync here or a clamped frame depenetrates from
      // where the player would have been.
      this.collider?.syncWorld();


      // ----------------------------------------------------------------------
      // Rotate Towards Movement Direction
      // ----------------------------------------------------------------------

      const targetRotationY = Math.atan2(axis.x, axis.y);

      // Normalize angle difference to [-PI, PI]
      let delta = targetRotationY - this.player.rotation.y;

      delta = Math.atan2(Math.sin(delta), Math.cos(delta));

      // Smooth rotation (frame-rate independent)
      this.player.rotation.y += delta * Math.min(1, dt * 12);


      // ----------------------------------------------------------------------
      // Play Run Animation
      // ----------------------------------------------------------------------

      if (this.actions.has(PlayerAnimation.Run))
        this.play(PlayerAnimation.Run);
    }

    // ------------------------------------------------------------------------
    // Idle State
    // ------------------------------------------------------------------------

    else {
      if (this.actions.has(PlayerAnimation.Idle))
        this.play(PlayerAnimation.Idle);
    }


    // ------------------------------------------------------------------------
    // Update Animation Mixer
    // ------------------------------------------------------------------------

    this.mixer.update(dt);

    // Not the constructor: Player is built *during* Game.create(), which
    // IonEngine only calls bindIon() after — so Animator (a thin wrapper
    // over Ion.tween) would throw "used before IonEngine.boot() finished"
    // if constructed from there. The first real update() tick is the
    // earliest point in this class's lifecycle where Ion is guaranteed
    // bound.
    // if (!this.popcornMachineRevealed && this.popcornMachine) {
    //   this.popcornMachineRevealed = true;
    //   this.revealPopcornMachine(this.popcornMachine);
    // }
  }

  /**
   * The popcorn machine's unlock reveal — scale alone reading as "pop in"
   * needs more than a linear 0->1 ramp (that's a fade with extra steps,
   * not an unlock moment). Two Animators started together, deliberately
   * on different curves so they resolve at different times instead of
   * looking like one shared progress bar driving both properties:
   *
   *  - Scale: Elastic.Out springs past 1 and rings back down before
   *    settling — the "sprung open" bounce of an unlock, not a grow.
   *  - Rotation: wound back a bit at the start, then Back.Out snaps it
   *    forward with a single punchy overshoot onto its real facing.
   *
   * Both are self-driving (see Animator's own doc comment) — nothing here
   * needs to touch `update()` again, and both correctly freeze/resume if
   * the UI editor or 3D freecam opens mid-animation, same as every other
   * timer in this game.
   */
  private revealPopcornMachine(obj: THREE.Object3D): void {
    new Animator({ time: 0.7, easing: Easing.Elastic.Out, delay: 0 }, (progress) => {
      obj.scale.setScalar(progress);

    });

    new LoopAnimator({ time: 1, yoyo: true }, (o) => {
      const t = Easing.Quadratic.InOut(o)
      obj.scale.setScalar(t);
    })

    const settledRotationY = obj.rotation.y;
    const startRotationY = settledRotationY - Math.PI * 0.6;
    obj.rotation.y = startRotationY;
    new Animator({ time: 0.5, easing: Easing.Back.Out }, (progress) => {
      obj.rotation.y = lerp(startRotationY, settledRotationY, progress);
    });
  }
}

enum PlayerAnimation {
  Idle = "Idle",
  Run = "Run"
}