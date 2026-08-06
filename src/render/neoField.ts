// One InstancedMesh for the entire NEO swarm. Positions are recomputed into
// the instance matrix array every frame; individual meshes are never created
// per asteroid.
import * as THREE from 'three';
import { stateAt } from '../orbit.js';
import type { NeoRecord } from '../types.js';

const BASE_COLOR = new THREE.Color(0x7f97b3);
const ACTIVE_COLOR = new THREE.Color(0xff3b3b);

export class NeoField {
  readonly mesh: THREE.InstancedMesh;
  readonly neos: NeoRecord[];
  private readonly dummy = new THREE.Object3D();
  private activeIndices: Set<number> = new Set();

  constructor(neos: NeoRecord[], radius = 0.01) {
    this.neos = neos;
    const geometry = new THREE.SphereGeometry(radius, 6, 6);
    const material = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.mesh = new THREE.InstancedMesh(geometry, material, neos.length);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < neos.length; i++) {
      this.mesh.setColorAt(i, BASE_COLOR);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(jd: number): void {
    for (let i = 0; i < this.neos.length; i++) {
      const p = stateAt(this.neos[i].elements, jd);
      this.dummy.position.set(p.x, p.y, p.z);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  setActive(indices: Set<number>): void {
    let changed = indices.size !== this.activeIndices.size;
    for (const i of this.activeIndices) {
      if (!indices.has(i)) {
        this.mesh.setColorAt(i, BASE_COLOR);
        changed = true;
      }
    }
    for (const i of indices) {
      if (!this.activeIndices.has(i)) {
        this.mesh.setColorAt(i, ACTIVE_COLOR);
        changed = true;
      }
    }
    if (changed && this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
    }
    this.activeIndices = indices;
  }
}
