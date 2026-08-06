import { describe, expect, it } from 'vitest';
import { dateToJD, jdToDate, meanAnomalyAt, solveKepler, stateAt } from './orbit.js';
import { EARTH } from './planets.js';
import type { OrbitalElements } from './types.js';

function magnitude(v: { x: number; y: number; z: number }): number {
  return Math.sqrt(v.x ** 2 + v.y ** 2 + v.z ** 2);
}

describe('solveKepler', () => {
  it('round-trips M = E - e*sin(E) to within 1e-9 across a grid of M and e', () => {
    const mValues = Array.from({ length: 13 }, (_, i) => (i / 12) * 2 * Math.PI);
    const eValues = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 0.95];

    for (const M of mValues) {
      for (const e of eValues) {
        const E = solveKepler(M, e);
        const recovered = E - e * Math.sin(E);
        // Kepler's equation is 2*pi-periodic in M; compare modulo that.
        const diff = Math.atan2(Math.sin(recovered - M), Math.cos(recovered - M));
        expect(Math.abs(diff)).toBeLessThan(1e-9);
      }
    }
  });
});

describe('stateAt: circular orbit sanity', () => {
  it('holds heliocentric distance at exactly 1.0 AU for e=0, a=1', () => {
    const elements: OrbitalElements = { a: 1, e: 0, i: 0, om: 0, w: 0, ma: 0, epoch: 2451545.0 };
    for (let days = 0; days <= 730; days += 17) {
      const r = magnitude(stateAt(elements, elements.epoch + days));
      expect(Math.abs(r - 1.0)).toBeLessThan(1e-9);
    }
  });
});

describe('stateAt: 433 Eros', () => {
  // Live-fetched elements for 433 Eros (see public/data/neos.json), not
  // invented -- this is the acceptance test the task calls out by name.
  const eros: OrbitalElements = {
    a: 1.458,
    e: 0.2229,
    i: 0.1890191579909859,
    om: 5.3105133150431465,
    w: 3.122743097668254,
    ma: 1.0910053154216555,
    epoch: 2461200.5,
  };

  it('oscillates between perihelion and aphelion and never leaves that band', () => {
    const perihelion = eros.a * (1 - eros.e); // ~1.1330 AU
    const aphelion = eros.a * (1 + eros.e); // ~1.7830 AU
    expect(perihelion).toBeCloseTo(1.13, 1);
    expect(aphelion).toBeCloseTo(1.78, 1);

    const periodDays = eros.a ** 1.5 * 365.25;
    const steps = 2000;
    let min = Infinity;
    let max = -Infinity;
    const tolerance = 1e-6; // numerical slack only

    for (let i = 0; i <= steps; i++) {
      const jd = eros.epoch + (i / steps) * periodDays;
      const r = magnitude(stateAt(eros, jd));
      min = Math.min(min, r);
      max = Math.max(max, r);
      expect(r).toBeGreaterThanOrEqual(perihelion - tolerance);
      expect(r).toBeLessThanOrEqual(aphelion + tolerance);
    }

    // Over a full period it should actually reach both extremes.
    expect(min).toBeCloseTo(perihelion, 3);
    expect(max).toBeCloseTo(aphelion, 3);
  });
});

describe('stateAt: Earth', () => {
  it('returns to its starting position after one full orbital period', () => {
    const periodDays = EARTH.elements.a ** 1.5 * 365.25;
    const start = stateAt(EARTH.elements, EARTH.elements.epoch);
    const after = stateAt(EARTH.elements, EARTH.elements.epoch + periodDays);

    expect(after.x).toBeCloseTo(start.x, 6);
    expect(after.y).toBeCloseTo(start.y, 6);
    expect(after.z).toBeCloseTo(start.z, 6);
  });
});

describe('meanAnomalyAt', () => {
  it('wraps into [0, 2*PI)', () => {
    const elements: OrbitalElements = { a: 1, e: 0.1, i: 0, om: 0, w: 0, ma: 0, epoch: 2451545.0 };
    const periodDays = elements.a ** 1.5 * 365.25;
    for (let k = -3; k <= 3; k++) {
      const M = meanAnomalyAt(elements, elements.epoch + k * periodDays * 1.37);
      expect(M).toBeGreaterThanOrEqual(0);
      expect(M).toBeLessThan(2 * Math.PI);
    }
  });
});

describe('dateToJD / jdToDate', () => {
  it('round-trip and match the known J2000 epoch', () => {
    const j2000 = new Date('2000-01-01T12:00:00Z');
    expect(dateToJD(j2000)).toBeCloseTo(2451545.0, 6);

    const now = new Date('2026-08-06T00:00:00Z');
    const jd = dateToJD(now);
    const back = jdToDate(jd);
    expect(back.getTime()).toBe(now.getTime());
  });
});
