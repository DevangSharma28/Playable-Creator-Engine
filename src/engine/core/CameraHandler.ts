import * as THREE from "three";
import { DEFAULT_CAMERA } from "../scene/SceneEnvDefaults";
import type { CameraEnvConfig, CameraRig } from "../scene/SceneEnvTypes";

/**
 * The camera rig: owns the cameras, the follow behavior, and how both
 * respond to a resize.
 *
 * Keeping this separate from Game.ts means swapping in a different camera
 * style later (fixed angle, top-down, side-scroller) is a one-file change —
 * and it's why this class, not Game, is what the environment system's
 * `camera` block drives (see CameraRig).
 *
 * ## Why there are two cameras
 *
 * A perspective/orthographic switch can't be done in place: they're
 * different classes, and `isPerspectiveCamera`/`isOrthographicCamera` are
 * what three.js itself and several editor systems branch on. So both exist
 * for the rig's whole life and `camera` returns whichever the config
 * selects.
 *
 * Both are kept at the *same* transform every frame, even the inactive one.
 * That isn't redundancy: the AudioListener is parented to the perspective
 * camera (see SoundHandler) and needs a current world matrix regardless of
 * which projection is rendering, and the editor's CameraHelper draws
 * whichever one is active without having to be told the rig moved.
 *
 * ## Follow
 *
 * With `follow` on, the rig tracks a world-space focus point at `offset`,
 * smoothed with frame-rate-independent exponential decay. With it off the
 * camera sits at the authored position/rotation and nothing moves it —
 * that's what makes a hand-placed shot from the editor panel stick instead
 * of being overwritten on the next frame.
 */
export class CameraHandler implements CameraRig {
  /** Always exists, active or not. The AudioListener's host and the editor's clone source. */
  readonly perspective: THREE.PerspectiveCamera;
  readonly orthographic: THREE.OrthographicCamera;

  private config: CameraEnvConfig;
  private active: THREE.PerspectiveCamera | THREE.OrthographicCamera;

  private readonly target = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly euler = new THREE.Euler();

  /** Last size handleResize() was given. Needed because an aspect change has to re-derive the ortho frustum and the reference-aspect FOV correction, and those are also re-derived whenever the config changes. */
  private viewWidth = 1;
  private viewHeight = 1;

  constructor(config: CameraEnvConfig = DEFAULT_CAMERA) {
    this.config = { ...config };
    this.perspective = new THREE.PerspectiveCamera(config.fov, 1, config.near, config.far);
    this.perspective.name = "Gameplay Camera";
    this.orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, config.near, config.far);
    this.orthographic.name = "Gameplay Camera (Ortho)";
    this.active = this.perspective;

    this.offset.set(...config.offset);
    this.perspective.position.copy(this.offset);
    this.orthographic.position.copy(this.offset);
    this.applyCameraConfig(config);
  }

  /** The camera to render through this frame. Identity changes when the projection mode does — read it per frame rather than caching it. */
  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.active;
  }

  /** Applies an authored camera block. Cheap and idempotent — the editor calls it on every slider event. */
  applyCameraConfig(config: CameraEnvConfig): void {
    this.config = { ...config };
    this.offset.set(...config.offset);
    this.active = config.projection === "orthographic" ? this.orthographic : this.perspective;

    for (const camera of [this.perspective, this.orthographic]) {
      camera.near = config.near;
      camera.far = config.far;
      camera.zoom = config.zoom;
    }

    if (!config.follow) {
      // Authored transform wins outright — update() will not touch it.
      this.euler.set(
        THREE.MathUtils.degToRad(config.rotation[0]),
        THREE.MathUtils.degToRad(config.rotation[1]),
        THREE.MathUtils.degToRad(config.rotation[2])
      );
      for (const camera of [this.perspective, this.orthographic]) {
        camera.position.set(...config.position);
        camera.rotation.copy(this.euler);
      }
    }

    this.applyProjection();
    this.syncIdleCamera();
  }

  /**
   * Smoothly follow a world-space focus point (typically the player).
   *
   * A no-op while `follow` is off, so a shot hand-placed in the editor
   * survives gameplay resuming.
   */
  update(focusPosition: THREE.Vector3, dt: number): void {
    if (!this.config.follow) return;
    this.target.set(focusPosition.x, 0, focusPosition.z).add(this.offset);
    // Frame-rate independent smoothing (see Freya Holmér's exponential
    // decay trick). `damping` is the decay rate: the default 6.91 is
    // ln(1/0.001), i.e. exactly the literal 0.001-per-second constant this
    // replaced.
    const alpha = 1 - Math.exp(-this.config.damping * dt);
    this.active.position.lerp(this.target, alpha);
    this.active.lookAt(focusPosition.x, this.config.lookAtHeight, focusPosition.z);
    this.syncIdleCamera();
  }

  /**
   * Keeps the camera that *isn't* rendering at the active one's transform.
   *
   * The explicit updateMatrixWorld() is the part that matters and isn't
   * obvious: neither camera is in the scene graph, so nothing traverses
   * them — three.js updates the world matrix of the camera it's rendering
   * through and no other. The AudioListener is parented to the perspective
   * camera, and its own updateMatrixWorld() is what moves the WebAudio
   * listener; without this call, switching the game to orthographic would
   * silently freeze positional audio wherever the camera last was.
   */
  private syncIdleCamera(): void {
    const idle = this.active === this.perspective ? this.orthographic : this.perspective;
    idle.position.copy(this.active.position);
    idle.quaternion.copy(this.active.quaternion);
    idle.updateMatrixWorld(true);
  }

  handleResize(width: number, height: number): void {
    this.viewWidth = Math.max(1, width);
    this.viewHeight = Math.max(1, height);
    this.applyProjection();
  }

  /**
   * Rebuilds both projections for the current viewport and config.
   *
   * The reference-aspect correction is the part that matters for a
   * playable: `fov` is a *vertical* angle, so on a portrait viewport the
   * horizontal field collapses and the player sees a narrow slice of the
   * shot that was framed in landscape. Widening the vertical FOV by the
   * aspect ratio keeps the horizontal framing constant instead. With
   * `referenceAspect` at 0 the correction is off and `fov` is used as
   * authored.
   */
  private applyProjection(): void {
    const aspect = this.viewWidth / this.viewHeight;
    const config = this.config;

    let fov = config.fov;
    if (config.referenceAspect > 0 && aspect < config.referenceAspect) {
      const halfTan = Math.tan(THREE.MathUtils.degToRad(config.fov) / 2);
      fov = THREE.MathUtils.radToDeg(2 * Math.atan((halfTan * config.referenceAspect) / aspect));
    }
    this.perspective.aspect = aspect;
    this.perspective.fov = fov;
    this.perspective.updateProjectionMatrix();

    // Vertical half-extent is the authored value; horizontal follows the
    // live aspect, so an ortho shot reframes on resize the way perspective
    // does rather than stretching.
    const halfHeight = Math.max(0.001, config.orthoSize);
    const halfWidth = halfHeight * aspect;
    this.orthographic.left = -halfWidth;
    this.orthographic.right = halfWidth;
    this.orthographic.top = halfHeight;
    this.orthographic.bottom = -halfHeight;
    this.orthographic.updateProjectionMatrix();
  }
}
