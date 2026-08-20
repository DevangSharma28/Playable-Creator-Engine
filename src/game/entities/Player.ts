// ============================================================================
// 📦 IMPORTS
// ============================================================================

import * as THREE from "three";
import { Group } from "three/examples/jsm/libs/tween.module.js";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";


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


  public me!: THREE.Group

  // ==========================================================================
  // 🔒 PRIVATE VARIABLES
  // Internal data used only by Player
  // ==========================================================================

  // Header("Player settings")
  public speed: number = 4;

  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private currentAction: THREE.AnimationAction | null = null;


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
  }
}

enum PlayerAnimation {
  Idle = "Idle",
  Run = "Run"
}