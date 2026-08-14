import * as THREE from "three";

/**
 * Owns the camera's follow behavior. Keeping this separate from Game.ts
 * means swapping in a different camera style later (fixed angle, top-down,
 * side-scroller) is a one-file change.
 */
export class CameraHandler {
  private readonly target = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly offset: THREE.Vector3
  ) {
    this.camera.position.copy(offset);
  }

  /** Smoothly follow a world-space focus point (typically the player). */
  update(focusPosition: THREE.Vector3, dt: number): void {
    this.target.set(focusPosition.x, 0, focusPosition.z).add(this.offset);
    // Frame-rate independent smoothing (see Freya Holmér's exponential decay trick).
    this.camera.position.lerp(this.target, 1 - Math.pow(0.001, dt));
    this.camera.lookAt(focusPosition.x, 0.3, focusPosition.z);
  }

  handleResize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}
