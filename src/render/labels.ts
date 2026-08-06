// Plain DOM labels for the planets, positioned by projecting their 3D
// position to screen space each frame. No UI framework, no CSS2DRenderer.
import * as THREE from 'three';

export class PlanetLabels {
  private readonly elements: HTMLDivElement[] = [];
  private visible = true;

  constructor(container: HTMLElement, names: string[]) {
    for (const name of names) {
      const el = document.createElement('div');
      el.className = 'planet-label';
      el.textContent = name;
      container.appendChild(el);
      this.elements.push(el);
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const el of this.elements) el.style.display = visible ? 'block' : 'none';
  }

  update(positions: THREE.Vector3[], camera: THREE.Camera, width: number, height: number): void {
    if (!this.visible) return;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i].clone().project(camera);
      const behind = p.z > 1;
      const el = this.elements[i];
      if (behind) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = 'block';
      el.style.left = `${((p.x + 1) / 2) * width}px`;
      el.style.top = `${((1 - p.y) / 2) * height}px`;
    }
  }
}
