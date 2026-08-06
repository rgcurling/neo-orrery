// Hardcoded J2000 mean orbital elements for the eight planets, from JPL's
// "Keplerian Elements for Approximate Positions of the Major Planets"
// (Standish, 1800-2050 AD table). Constant elements -- no secular rates --
// which is the accepted approximation for a visual orrery; see README.
import type { OrbitalElements } from './types.js';

const DEG2RAD = Math.PI / 180;
const J2000 = 2451545.0;

interface RawPlanetElements {
  name: string;
  color: number;
  a: number; // AU
  e: number;
  iDeg: number;
  omDeg: number; // longitude of ascending node
  varpiDeg: number; // longitude of perihelion
  lDeg: number; // mean longitude at epoch
}

const RAW: RawPlanetElements[] = [
  { name: 'Mercury', color: 0x9c9c94, a: 0.38709927, e: 0.20563593, iDeg: 7.00497902, omDeg: 48.33076593, varpiDeg: 77.45779628, lDeg: 252.25032350 },
  { name: 'Venus', color: 0xe6c229, a: 0.72333566, e: 0.00677672, iDeg: 3.39467605, omDeg: 76.67984255, varpiDeg: 131.60246718, lDeg: 181.97909950 },
  { name: 'Earth', color: 0x3d85c6, a: 1.00000261, e: 0.01671123, iDeg: -0.00001531, omDeg: 0.0, varpiDeg: 102.93768193, lDeg: 100.46457166 },
  { name: 'Mars', color: 0xc1440e, a: 1.52371034, e: 0.09339410, iDeg: 1.84969142, omDeg: 49.55953891, varpiDeg: -23.94362959, lDeg: -4.55343205 },
  { name: 'Jupiter', color: 0xd8ca9d, a: 5.20288700, e: 0.04838624, iDeg: 1.30439695, omDeg: 100.47390909, varpiDeg: 14.72847983, lDeg: 34.39644051 },
  { name: 'Saturn', color: 0xead6b8, a: 9.53667594, e: 0.05386179, iDeg: 2.48599187, omDeg: 113.66242448, varpiDeg: 92.59887831, lDeg: 49.95424423 },
  { name: 'Uranus', color: 0x9fe3de, a: 19.18916464, e: 0.04725744, iDeg: 0.77263783, omDeg: 74.01692503, varpiDeg: 170.95427630, lDeg: 313.23810451 },
  { name: 'Neptune', color: 0x4b70dd, a: 30.06992276, e: 0.00859048, iDeg: 1.77004347, omDeg: 131.78422574, varpiDeg: 44.96476227, lDeg: -55.12002969 },
];

export interface Planet {
  name: string;
  color: number;
  elements: OrbitalElements;
}

function wrapDeg(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

export const PLANETS: Planet[] = RAW.map((p) => ({
  name: p.name,
  color: p.color,
  elements: {
    a: p.a,
    e: p.e,
    i: p.iDeg * DEG2RAD,
    om: wrapDeg(p.omDeg) * DEG2RAD,
    w: wrapDeg(p.varpiDeg - p.omDeg) * DEG2RAD,
    ma: wrapDeg(p.lDeg - p.varpiDeg) * DEG2RAD,
    epoch: J2000,
  },
}));

export const EARTH = PLANETS.find((p) => p.name === 'Earth')!;
