// Builds one merged BufferGeometry for a whole population of orbits at once,
// meant to be drawn as a single THREE.LineSegments. Orbits are static in a
// two-body model, so each one is sampled exactly once here, never per frame.
import * as THREE from 'three';
import { stateAt } from '../orbit.js';
import type { OrbitalElements } from '../types.js';

const SEGMENTS = 128;
const VERTS_PER_ORBIT = SEGMENTS * 2; // one pair (a,b) per segment, closed loop

function fillOrbit(
  positions: Float32Array,
  colorArray: Float32Array | null,
  orbitIdx: number,
  elements: OrbitalElements,
  color: THREE.Color | undefined
): void {
  const period = elements.a ** 1.5 * 365.25;
  const points: { x: number; y: number; z: number }[] = new Array(SEGMENTS);
  for (let s = 0; s < SEGMENTS; s++) {
    const jd = elements.epoch + (s / SEGMENTS) * period;
    points[s] = stateAt(elements, jd);
  }

  let ptr = orbitIdx * VERTS_PER_ORBIT * 3;
  let colorPtr = ptr;
  for (let s = 0; s < SEGMENTS; s++) {
    const a = points[s];
    const b = points[(s + 1) % SEGMENTS];
    positions[ptr++] = a.x;
    positions[ptr++] = a.y;
    positions[ptr++] = a.z;
    positions[ptr++] = b.x;
    positions[ptr++] = b.y;
    positions[ptr++] = b.z;

    if (colorArray && color) {
      colorArray[colorPtr++] = color.r;
      colorArray[colorPtr++] = color.g;
      colorArray[colorPtr++] = color.b;
      colorArray[colorPtr++] = color.r;
      colorArray[colorPtr++] = color.g;
      colorArray[colorPtr++] = color.b;
    }
  }
}

/** Synchronous builder. Fine for small populations (e.g. the 8 planets). */
export function buildOrbitLineGeometry(
  elementsList: OrbitalElements[],
  colors?: THREE.Color[]
): THREE.BufferGeometry {
  const positions = new Float32Array(elementsList.length * VERTS_PER_ORBIT * 3);
  const colorArray = colors ? new Float32Array(elementsList.length * VERTS_PER_ORBIT * 3) : null;

  for (let orbitIdx = 0; orbitIdx < elementsList.length; orbitIdx++) {
    fillOrbit(positions, colorArray, orbitIdx, elementsList[orbitIdx], colors?.[orbitIdx]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (colorArray) geometry.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));
  return geometry;
}

/**
 * Same computation as buildOrbitLineGeometry, but chunked across animation
 * frames so a large population (thousands of orbits, each needing 128
 * Kepler solves) doesn't block the main thread for seconds at startup.
 */
export function buildOrbitLineGeometryAsync(
  elementsList: OrbitalElements[],
  colors: THREE.Color[] | undefined,
  onProgress: (done: number, total: number) => void,
  batchSize = 500
): Promise<THREE.BufferGeometry> {
  const positions = new Float32Array(elementsList.length * VERTS_PER_ORBIT * 3);
  const colorArray = colors ? new Float32Array(elementsList.length * VERTS_PER_ORBIT * 3) : null;

  return new Promise((resolve) => {
    let orbitIdx = 0;
    function step() {
      const end = Math.min(orbitIdx + batchSize, elementsList.length);
      for (; orbitIdx < end; orbitIdx++) {
        fillOrbit(positions, colorArray, orbitIdx, elementsList[orbitIdx], colors?.[orbitIdx]);
      }
      onProgress(orbitIdx, elementsList.length);
      if (orbitIdx < elementsList.length) {
        setTimeout(step, 0);
      } else {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        if (colorArray) geometry.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));
        resolve(geometry);
      }
    }
    step();
  });
}
