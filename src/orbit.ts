// Pure two-body Keplerian propagation. No three.js imports here -- this
// module is independently testable and reused by both the fetch-time sanity
// checks and the renderer.
//
// Units: AU for distance, Julian years for time. This makes the heliocentric
// gravitational parameter exactly mu = 4 * pi^2 (Kepler's third law with the
// Sun's mass, AU, and year as the base units). Angles are radians throughout
// this module -- the fetch script converts JPL's degrees to radians once, at
// prefetch time, so nothing here ever touches degrees.
import type { OrbitalElements } from './types.js';

export const MU = 4 * Math.PI ** 2;
const DAYS_PER_JULIAN_YEAR = 365.25;
const TWO_PI = 2 * Math.PI;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Wraps an angle into [0, 2*PI). */
function wrapAngle(angle: number): number {
  const wrapped = angle % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

/**
 * Solves Kepler's equation M = E - e*sin(E) for the eccentric anomaly E,
 * given mean anomaly M and eccentricity e, via Newton-Raphson.
 */
export function solveKepler(M: number, e: number): number {
  let E = M;
  for (let iter = 0; iter < 50; iter++) {
    const delta = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= delta;
    if (Math.abs(delta) < 1e-10) break;
  }
  return E;
}

/** Mean anomaly at Julian Date jd, wrapped into [0, 2*PI). */
export function meanAnomalyAt(elements: OrbitalElements, jd: number): number {
  const n = Math.sqrt(MU / elements.a ** 3); // mean motion, rad/Julian year
  const dtYears = (jd - elements.epoch) / DAYS_PER_JULIAN_YEAR;
  return wrapAngle(elements.ma + n * dtYears);
}

/** Heliocentric ecliptic position at Julian Date jd, in AU. */
export function stateAt(elements: OrbitalElements, jd: number): Vec3 {
  const { a, e, i, om, w } = elements;
  const M = meanAnomalyAt(elements, jd);
  const E = solveKepler(M, e);

  // Perifocal (PQW) coordinates.
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);

  // Rotate PQW -> ecliptic via the standard 3-1-3 sequence R3(-om) R1(-i) R3(-w).
  const cosOm = Math.cos(om);
  const sinOm = Math.sin(om);
  const cosI = Math.cos(i);
  const sinI = Math.sin(i);
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);

  const x = xp * (cosOm * cosW - sinOm * sinW * cosI) + yp * (-cosOm * sinW - sinOm * cosW * cosI);
  const y = xp * (sinOm * cosW + cosOm * sinW * cosI) + yp * (-sinOm * sinW + cosOm * cosW * cosI);
  const z = xp * (sinW * sinI) + yp * (cosW * sinI);

  return { x, y, z };
}

/** Unix-epoch-based UTC -> Julian Date. Precise to well under a second, which is
 * more than sufficient for a visual orrery (TDB/UTC differ by ~69s). */
export function dateToJD(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

export function jdToDate(jd: number): Date {
  return new Date((jd - 2_440_587.5) * 86_400_000);
}
