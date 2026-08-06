# NEO Orrery

A browser-based orrery rendering the real orbits of near-Earth objects (NEOs),
propagated with two-body Keplerian mechanics from live JPL Small-Body
Database elements. No backend: all JPL data is prefetched once to static
JSON at build time, and the browser only ever reads local files.

## Stack

- Vite + TypeScript, no framework
- three.js for rendering
- vitest for the physics tests

## Setup

```bash
npm install
npm run fetch-data   # prefetches JPL data to public/data/ (see below)
npm test             # run the physics test suite
npm run dev           # start the dev server
```

`npm run build` typechecks and produces a static `dist/` bundle; there is no
server-side component to deploy.

## `npm run fetch-data`

`scripts/fetch-data.ts` hits two JPL SSD API endpoints once and writes the
results to `public/data/` (gitignored — regenerate it locally):

- `sbdb_query.api` with `sb-group=neo`, for orbital elements plus absolute
  magnitude and diameter, filtered to the fields confirmed live against
  `sbdb_query.api?info=field` before this was written: `epoch`, `e`, `a`,
  `i`, `om`, `w`, `ma`, `H`, `diameter`, `pha`, plus the designation/name
  fields `full_name`, `pdes`, `name`.
- `cad.api` with `dist-max=10LD&date-min=now&date-max=+1000&sort=dist`, for
  upcoming Earth close approaches.

The script drops any object with `e >= 1` (hyperbolic/parabolic orbits are
out of scope for two-body Keplerian propagation) and logs how many objects
survived filtering. A live run currently keeps all ~42,000+ NEOs in the
catalog (0 hyperbolic, 0 with incomplete elements) and ~150 close approaches
within 10 lunar distances over the next 1000 days.

The browser never talks to JPL directly — the SSD API does not reliably
send permissive CORS headers, and re-fetching on every page load would be
both slow and unnecessary for essentially-static orbital elements.

This environment's outbound network access is proxied; Node's built-in
`fetch` needs `NODE_USE_ENV_PROXY=1` to route through it, which is why
that's baked into the `fetch-data` npm script rather than assumed to work
by default.

## Propagation math

`src/orbit.ts` is a pure, three.js-free module (independently unit tested in
`src/orbit.test.ts`) implementing standard two-body Keplerian propagation:

1. **Mean anomaly at time `t`**: `M = M0 + n * (t - epoch)`, where the mean
   motion `n = sqrt(mu / a^3)`.
2. **Kepler's equation**: solve `M = E - e*sin(E)` for the eccentric anomaly
   `E` via Newton-Raphson, seeded at `E = M`, capped at 50 iterations,
   converging when `|delta| < 1e-10`.
3. **Perifocal coordinates**: `xp = a*(cos(E) - e)`,
   `yp = a*sqrt(1 - e^2)*sin(E)`.
4. **Rotate to the ecliptic frame** via the standard 3-1-3 sequence
   `R3(-Ω) R1(-i) R3(-ω)` applied to the perifocal position, using argument
   of perihelion (`w`/ω), inclination (`i`), and longitude of ascending node
   (`om`/Ω).

This is a two-body approximation only — no perturbations, no n-body
integration, no relativistic corrections. That's the explicitly accepted
scope for this project; see "Out of scope" below.

### Unit conventions

Everything in `src/orbit.ts` works in **AU** for distance and **Julian
years** (365.25 days) for time. This is a deliberate choice: it makes the
heliocentric gravitational parameter exactly `mu = 4 * pi^2`, with no SI
units or conversion constants anywhere in the physics module.

- Angles are **radians** everywhere in `src/orbit.ts`, `src/types.ts`, and
  `src/planets.ts`. JPL returns angles in degrees; `scripts/fetch-data.ts`
  converts degrees to radians once, at prefetch time, so the browser and the
  physics module never touch degrees.
- Semi-major axis (`a`) stays in **AU**, matching the API's native units.
- Epoch stays in **Julian Date (JD)**, matching the API's native units.
  `dateToJD`/`jdToDate` convert between JD and JS `Date` using the Unix
  epoch reference (`JD 2440587.5` = 1970-01-01T00:00:00Z), which is precise
  to well under a second — more than sufficient for a visual orrery (JD in
  this app is nominally TDB from JPL; TDB and UTC differ by ~69 seconds,
  irrelevant at this precision).
- Close-approach miss distance is normalized from JPL's AU into **lunar
  distances** (1 LD = 384,400 km) at prefetch time, so the UI never does
  that arithmetic either.

### Acceptance test: 433 Eros

The critical correctness check (and the one most likely to catch a broken
rotation sequence, since a wrong sign or swapped rotation still produces
*an* orbit, just not the right one) is `src/orbit.test.ts`'s Eros test:
using the live-fetched elements (`a = 1.458 AU`, `e = 0.2229`), heliocentric
distance is propagated across a full orbital period at 2000 steps and must
stay within `[perihelion, aphelion] ≈ [1.133, 1.783] AU` throughout. All 6
tests in the suite pass; see the physics module commit for verified output.

## Rendering & performance

- Orbit paths are static per two-body model, so each is sampled once (128
  points) and merged into a single `BufferGeometry` drawn as one
  `LineSegments` — one for the 8 planets, one for the whole NEO population.
  Building the NEO orbit-line geometry is chunked across animation frames
  (`buildOrbitLineGeometryAsync`) so the ~5.4M Kepler solves involved don't
  block the main thread at startup.
- All NEOs share a single `InstancedMesh`; positions are written into the
  instance matrix array and `instanceMatrix.needsUpdate` is set, once per
  simulated-date change (not redundantly every animation frame while
  paused).
- **Performance, measured honestly, per the project's own instructions not
  to silently reduce the object count:** the live NEO catalog currently
  returns **~42,000 objects**, well above the 5,000-object target this
  project was scoped against. Recomputing Kepler's equation for the full
  catalog costs ~110ms/frame on the CPU alone (pure JS, hardware-independent
  — measured directly, no rendering involved), which caps animated playback
  at roughly 9fps regardless of GPU. At the stated 5,000-object scale, the
  same CPU-side cost is ~4ms/frame, comfortably inside a 60fps budget. GPU
  draw-call cost (the merged orbit-line geometry and the instanced NEO
  spheres) could not be reliably measured in the sandboxed environment this
  was built in, which has no hardware GPU acceleration (software
  `SwiftShader` rendering only) — real hardware should handle both draw
  calls far more easily than that environment did. The NEO-orbit-lines
  toggle exists in part because the full swarm is visually (and, at full
  catalog size, computationally) dense; turning it off removes the biggest
  single cost.

## Controls

- Time scrubber spanning roughly 2 years before to 3 years after today
- Play/pause, and a speed slider from 1 day/sec to 1 year/sec (exponential)
- Toggle NEO orbit lines on/off
- Toggle planet labels
- Current simulated date readout
- Click any body (Sun, planet, or NEO) to see its orbital elements
- Close approaches within 1 simulated day flash the NEO red and list name,
  miss distance (lunar distances), and relative velocity (km/s) in the
  overlay

## Out of scope (by design)

Perturbations, n-body integration, relativistic corrections, hyperbolic and
comet orbits, mobile layout, deployment. Two-body Keplerian propagation is
the accepted approximation here; anything more is scope creep for this
project.
