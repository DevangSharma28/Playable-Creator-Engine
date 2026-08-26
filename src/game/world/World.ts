import * as THREE from "three";

/**
 * The static play environment's *gameplay* extents.
 *
 * Lighting, fog, background, tone mapping, and shadow settings used to be
 * built here by hand. They now live in src/game/environment.json and are
 * applied by the engine's SceneEnvironment, so the 3D editor's Environment
 * dock can author them live — the values it ships with are exactly the ones
 * this class used to hardcode, so nothing looks different by default.
 *
 * What's left is the one thing that genuinely belongs to the *game* rather
 * than to the renderer: how far from the origin gameplay is allowed to
 * reach. Nothing in here moves or has per-frame update logic.
 */
export class World {
  /** Half-extent minus a small margin — the furthest an entity should travel from center. */
  readonly bound: number;

  constructor(_scene: THREE.Scene, size = 10) {
    // this.addGround(_scene, size);
    // this.addWalls(_scene, size);
    this.bound = size;
  }

  private addGround(scene: THREE.Scene, size: number): void {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ color: 0x57c25c, roughness: 0.9 })
    );
    ground.name = "Ground";
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
  }

  private addWalls(scene: THREE.Scene, size: number): void {
    const wallHeight = 0.4;
    const wallGeo = new THREE.BoxGeometry(size + 0.4, wallHeight, 0.4);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x3d8b40, roughness: 0.8 });

    const wallPositions: [number, number, number, number][] = [
      [0, wallHeight / 2, size / 2 + 0.2, 0],
      [0, wallHeight / 2, -size / 2 - 0.2, 0],
      [size / 2 + 0.2, wallHeight / 2, 0, Math.PI / 2],
      [-size / 2 - 0.2, wallHeight / 2, 0, Math.PI / 2],
    ];

    wallPositions.forEach(([x, y, z, ry], i) => {
      const wall = new THREE.Mesh(wallGeo, wallMat);
      wall.name = `Wall ${i + 1}`;
      wall.position.set(x, y, z);
      wall.rotation.y = ry;
      wall.castShadow = true;
      wall.receiveShadow = true;
      scene.add(wall);
    });
  }
}
