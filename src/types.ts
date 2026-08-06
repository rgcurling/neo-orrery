export interface OrbitalElements {
  /** Semi-major axis, AU */
  a: number;
  /** Eccentricity */
  e: number;
  /** Inclination, radians */
  i: number;
  /** Longitude of ascending node, radians */
  om: number;
  /** Argument of perihelion, radians */
  w: number;
  /** Mean anomaly at epoch, radians */
  ma: number;
  /** Epoch, Julian Date (TDB) */
  epoch: number;
}

export interface NeoRecord {
  /** Primary designation, e.g. "433" */
  designation: string;
  /** IAU name, e.g. "Eros", if named */
  name: string | null;
  /** Full name/designation string as given by SBDB, e.g. "433 Eros (A898 PA)" */
  fullName: string;
  /** Absolute magnitude H */
  h: number | null;
  /** Diameter, km, from equivalent sphere (sparse) */
  diameterKm: number | null;
  /** Potentially Hazardous Asteroid flag */
  pha: boolean;
  elements: OrbitalElements;
}

export interface CloseApproach {
  /** Designation, matches NeoRecord.designation for numbered/provisional bodies */
  designation: string;
  /** Time of closest approach, Julian Date (TDB) */
  jd: number;
  /** Human-readable calendar date/time of closest approach */
  calendarDate: string;
  /** Nominal miss distance, AU */
  distAu: number;
  /** Nominal miss distance, lunar distances */
  distLd: number;
  /** Relative velocity at close approach, km/s */
  vRelKmS: number;
}
