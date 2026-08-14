import * as THREE from "three";

/**
 * Dev-only "which way is the camera looking" gizmo — a small X/Y/Z axes
 * triad rendered into its own tiny canvas (Engine Room panel), independent
 * of the main renderer/scene. Mirrors the main camera's orientation each
 * frame so it reads like a compass for the 3D view.
 */
export class ViewHelperWidget {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
  private readonly axesRoot: THREE.Group;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height, false);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1.4, 1.4, 1.4, -1.4, 0.1, 10);
    this.camera.position.set(0, 0, 3);

    this.axesRoot = new THREE.Group();
    this.axesRoot.add(new THREE.AxesHelper(1)); // built-in Three.js helper: red X, green Y, blue Z
    this.scene.add(this.axesRoot);
  }

  /** Call once per frame with the main scene's camera. */
  update(sourceCamera: THREE.Camera): void {
    // The gizmo shows the world axes as currently seen from the main
    // camera, so it rotates opposite to the camera itself — same
    // convention as Blender/Unity's navigation gizmo.
    this.axesRoot.quaternion.copy(sourceCamera.quaternion).invert();
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
