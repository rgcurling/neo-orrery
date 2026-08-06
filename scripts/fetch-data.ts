// Prefetches NEO orbital elements and upcoming close-approach data from the
// JPL SBDB/CAD APIs into static JSON under public/data/. Run via `npm run
// fetch-data`. The browser app never talks to JPL directly.
//
// Field names below were confirmed live against
// https://ssd-api.jpl.nasa.gov/sbdb_query.api?info=field before writing this
// script -- see README.md for the enumerated list. Do not add fields without
// re-checking that endpoint.
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { CloseApproach, NeoRecord, OrbitalElements, SentryRecord } from '../src/types.js';

const DATA_DIR = path.resolve(import.meta.dirname, '../public/data');

const DEG2RAD = Math.PI / 180;
const AU_PER_LD = 384_400 / 149_597_870.7; // lunar distance expressed in AU

const SBDB_FIELDS = [
  'full_name',
  'pdes',
  'name',
  'epoch',
  'e',
  'a',
  'i',
  'om',
  'w',
  'ma',
  'H',
  'diameter',
  'pha',
] as const;

interface SbdbResponse {
  fields: string[];
  data: (string | null)[][];
  count: number;
}

interface CadResponse {
  fields: string[];
  data: (string | null)[][];
  count: number;
}

interface SentrySummaryRow {
  des: string;
  ps_cum: string;
  ps_max: string;
  ts_max: string;
  ip: string;
  n_imp: number;
  range: string;
}

interface SentryResponse {
  count: number;
  data: SentrySummaryRow[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText} — ${url}`);
  }
  return (await res.json()) as T;
}

function rowToRecord(fields: string[], row: (string | null)[]): Record<string, string | null> {
  const record: Record<string, string | null> = {};
  fields.forEach((field, idx) => {
    record[field] = row[idx];
  });
  return record;
}

async function fetchNeos(): Promise<NeoRecord[]> {
  const url = `https://ssd-api.jpl.nasa.gov/sbdb_query.api?sb-group=neo&fields=${SBDB_FIELDS.join(',')}`;
  const res = await fetchJson<SbdbResponse>(url);
  console.log(`sbdb_query.api: ${res.count} NEOs returned`);

  const kept: NeoRecord[] = [];
  let droppedHyperbolic = 0;
  let droppedIncomplete = 0;

  for (const row of res.data) {
    const r = rowToRecord(res.fields, row);

    const a = r.a === null ? null : Number(r.a);
    const e = r.e === null ? null : Number(r.e);
    const i = r.i === null ? null : Number(r.i);
    const om = r.om === null ? null : Number(r.om);
    const w = r.w === null ? null : Number(r.w);
    const ma = r.ma === null ? null : Number(r.ma);
    const epoch = r.epoch === null ? null : Number(r.epoch);

    if (
      a === null || e === null || i === null || om === null || w === null ||
      ma === null || epoch === null ||
      !Number.isFinite(a) || !Number.isFinite(e) || !Number.isFinite(i) ||
      !Number.isFinite(om) || !Number.isFinite(w) || !Number.isFinite(ma) ||
      !Number.isFinite(epoch)
    ) {
      droppedIncomplete++;
      continue;
    }

    if (e >= 1) {
      droppedHyperbolic++;
      continue;
    }

    const elements: OrbitalElements = {
      a,
      e,
      i: i * DEG2RAD,
      om: om * DEG2RAD,
      w: w * DEG2RAD,
      ma: ma * DEG2RAD,
      epoch,
    };

    kept.push({
      designation: (r.pdes ?? r.full_name ?? '').trim(),
      name: r.name ? r.name.trim() : null,
      fullName: (r.full_name ?? '').trim(),
      h: r.H === null ? null : Number(r.H),
      diameterKm: r.diameter === null ? null : Number(r.diameter),
      pha: r.pha === 'Y',
      elements,
    });
  }

  console.log(
    `NEOs kept: ${kept.length} (dropped ${droppedHyperbolic} hyperbolic/parabolic, ` +
    `${droppedIncomplete} missing elements)`
  );

  return kept;
}

async function fetchCloseApproaches(): Promise<CloseApproach[]> {
  const url = 'https://ssd-api.jpl.nasa.gov/cad.api?dist-max=10LD&date-min=now&date-max=%2B1000&sort=dist';
  const res = await fetchJson<CadResponse>(url);
  console.log(`cad.api: ${res.count} close approaches returned`);

  const approaches: CloseApproach[] = res.data.map((row) => {
    const r = rowToRecord(res.fields, row);
    const distAu = Number(r.dist);
    return {
      designation: (r.des ?? '').trim(),
      jd: Number(r.jd),
      calendarDate: r.cd ?? '',
      distAu,
      distLd: distAu / AU_PER_LD,
      vRelKmS: Number(r.v_rel),
    };
  });

  console.log(`Close approaches kept: ${approaches.length}`);
  return approaches;
}

/** Impact-monitoring summary data (Palermo scale, impact probability, etc.)
 * from JPL's Sentry system -- confirmed live against
 * https://ssd-api.jpl.nasa.gov/doc/sentry.html before writing this function.
 * Mode selection is param-driven and easy to get wrong: `all=1` selects
 * Mode V (every individual virtual-impactor record, ~46k rows, `ps` per-VI)
 * -- passing NO query params at all is what selects Mode S, the one-row-
 * per-object summary with `ps_cum`/`ps_max` this app actually wants. */
async function fetchSentryData(): Promise<SentryRecord[]> {
  const url = 'https://ssd-api.jpl.nasa.gov/sentry.api';
  const res = await fetchJson<SentryResponse>(url);
  console.log(`sentry.api: ${res.count} Sentry-monitored objects returned`);

  const records: SentryRecord[] = res.data.map((row) => ({
    designation: row.des.trim(),
    psCum: Number(row.ps_cum),
    psMax: Number(row.ps_max),
    tsMax: Number(row.ts_max),
    impactProbability: Number(row.ip),
    potentialImpactCount: row.n_imp,
    yearRange: row.range,
  }));

  console.log(`Sentry records kept: ${records.length}`);
  return records;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const [neos, closeApproaches, sentry] = await Promise.all([
    fetchNeos(),
    fetchCloseApproaches(),
    fetchSentryData(),
  ]);

  await writeFile(path.join(DATA_DIR, 'neos.json'), JSON.stringify(neos));
  await writeFile(path.join(DATA_DIR, 'close-approaches.json'), JSON.stringify(closeApproaches));
  await writeFile(path.join(DATA_DIR, 'sentry.json'), JSON.stringify(sentry));

  console.log(
    `Wrote ${neos.length} NEOs, ${closeApproaches.length} close approaches, and ` +
    `${sentry.length} Sentry records to ${DATA_DIR}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
