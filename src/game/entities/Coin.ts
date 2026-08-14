import * as THREE from "three";
import type { Entity } from "../../engine/entities/Entity";

const geometry = new THREE.CylinderGeometry(0.32, 0.32, 0.1, 20);
const material = new THREE.MeshStandardMaterial({
  color: 0xffd54a,
  metalness: 0.6,
  roughness: 0.25,
  emissive: 0x7a5c00,
  emissiveIntensity: 0.15,
});

/** A single collectible coin. Spawned and owned by CoinField. */
export class Coin implements Entity {
  readonly object3D: THREE.Mesh;
  collected = false;

  constructor(scene: THREE.Scene, position: THREE.Vector3) {
    this.object3D = new THREE.Mesh(geometry, material);
    this.object3D.rotation.x = Math.PI / 2;
    this.object3D.position.copy(position);
    this.object3D.castShadow = true;
    scene.add(this.object3D);
  }

  update(_dt: number, elapsed: number): void {
    if (this.collected) return;
    this.object3D.rotation.z = elapsed * 2;
    this.object3D.position.y = 0.55 + Math.sin(elapsed * 3 + this.object3D.position.x) * 0.08;
  }

  collect(): void {
    this.collected = true;
    this.object3D.visible = false;
  }
}
