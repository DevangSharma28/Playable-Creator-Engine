import * as THREE from "three";

/**
 * The static play environment: lighting, ground, and boundary walls.
 * Nothing in here moves or has per-frame update logic — it's set up
 * once in the constructor and left alone.
 */
export class World {
  /** Half-extent minus a small margin — the furthest an entity should travel from center. */
  readonly bound: number;

  constructor(scene: THREE.Scene, size = 10) {
    scene.background = new THREE.Color(0x8ed1ef);
    // near/far tuned for this class's own 10-unit procedural arena, but
    // Game.ts now also drops Cinema_World.glb into the same scene — a
    // ~109×124-unit environment (measured via its own world-space AABB) —
    // and the old far:26 fogged out almost all of it into flat sky-blue.
    // Pushed out to actually cover that footprint; near:30 stays past the
    // player's own gameplay-camera distance (~21 units, see CAMERA_OFFSET
    // in Game.ts) so nothing in the immediate play area fogs.
    scene.fog = new THREE.Fog(0x8ed1ef, 30, 180);

    this.addLights(scene);
    // this.addGround(scene, size);
    // this.addWalls(scene, size);

    this.bound = size;
  }

  private addLights(scene: THREE.Scene): void {
    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    ambient.name = "Ambient Light";
    scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xfff4d6, 1.2);
    sun.name = "Sun";
    sun.position.set(6, 12, 6);
    sun.castShadow = false;
    // sun.shadow.mapSize.set(1024, 1024);
    // sun.shadow.camera.left = -20;
    // sun.shadow.camera.right = 20;
    // sun.shadow.camera.top = 20;
    // sun.shadow.camera.bottom = -20;
    scene.add(sun);

    const fillLight = new THREE.DirectionalLight(0xbfe3ff, 0.35);
    fillLight.name = "Fill Light";
    fillLight.position.set(-6, 4, -4);
    scene.add(fillLight);
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
