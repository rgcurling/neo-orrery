import type { CloseApproach } from './types.js';

/** Close approaches whose closest-approach JD is within `windowDays` of jd. */
export function findActiveApproaches(
  jd: number,
  approaches: CloseApproach[],
  windowDays = 1
): CloseApproach[] {
  return approaches.filter((a) => Math.abs(a.jd - jd) < windowDays);
}
