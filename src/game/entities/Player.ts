// ============================================================================
// 📦 IMPORTS
// ============================================================================

import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { applySceneBindings, type SceneBindingsData } from "../../engine/SceneBindings";
import sceneBindingsRaw from "../sceneBindings.json";
import { Easing } from "../../engine/Ion";
import { Animator, LoopAnimator } from "../../engine/core/Animator";
import { lerp } from "three/src/math/MathUtils.js";


// ============================================================================
// ⚙️ CONSTANTS
// ============================================================================

const CROSSFADE_DURATION = 0.2;


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


  // ==========================================================================
  // 🚀 CONSTRUCTOR
  // Initializes player, animations and model
  // ==========================================================================

  constructor(
    scene: THREE.Scene,
    private readonly bound: number,
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

      this.player.position.x += axis.x * this.speed * dt;
      this.player.position.z += axis.y * this.speed * dt;


      // ----------------------------------------------------------------------
      // Keep Player Inside Bounds
      // ----------------------------------------------------------------------

      this.player.position.x = THREE.MathUtils.clamp(
        this.player.position.x,
        -this.bound,
        this.bound
      );

      this.player.position.z = THREE.MathUtils.clamp(
        this.player.position.z,
        -this.bound,
        this.bound
      );


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