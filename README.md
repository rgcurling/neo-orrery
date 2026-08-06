# Apsis — a browser orrery of near-Earth objects

A real-time, client-only visualization of the Sun, the eight planets, and the
full population of known near-Earth objects (NEOs), propagated with real
Keplerian orbital mechanics from live JPL data. No backend: all NASA/JPL data
is fetched once, at build/refresh time, into static JSON that the browser
reads locally.

Built with Vite + TypeScript + three.js, tested with vitest.

## Quick start

```bash
npm install
npm run fetch-data   # pulls current NEO elements + close approaches from JPL
npm run dev          # http://localhost:5173
```

`npm run dev` and `npm run build` both expect `public/data/neos.json` and
`public/data/close-approaches.json` to already exist — the app never talks to
JPL directly, so `fetch-data` must run at least once before either. See
[Data](#data) below for how those files stay current.

Other scripts:

```bash
npm test              # vitest — physics correctness (see Propagation math)
npm run build          # tsc -b && vite build -> dist/
npm run preview         # serve the production build locally
```

## Controls

- **Scrubber** — drag to jump to any date in range; dragging pauses playback.
- **Play / Pause**, **Speed** — 1 day/sec to 1 year/sec (exponential slider).
- **NEO orbits (dense)** — toggles all ~42k NEO orbit ellipses; built lazily
  on first use since it's an expensive geometry. Off by default: dense.
- **Labels** — toggles planet name labels.
- **Click** any body (Sun, planet, or NEO) — opens an inspector with its
  orbital elements, and a **Follow** button.
- **Follow** — eases the camera onto that body and tracks it as the solar
  system moves; **Esc** (or the on-screen exit button) eases back to the
  original view.
- Close approaches (within ±1 day of a listed encounter) flash the object red
  and surface its name, miss distance (lunar distances), and relative
  velocity.

## Propagation math

All physics lives in [`src/orbit.ts`](src/orbit.ts), pure functions with no
three.js dependency (`src/orbit.test.ts` exercises them directly).

**Units.** Distance in AU, time in Julian years, angles in radians
everywhere except at the JPL data boundary (`scripts/fetch-data.ts` converts
degrees to radians once, at fetch time). Working in AU and Julian years makes
the Sun's heliocentric gravitational parameter exactly

```
mu = 4 * pi^2
```

by Kepler's third law, so no unit conversion constants are needed anywhere
in the propagation itself.

**Solving Kepler's equation.** Given mean anomaly `M` and eccentricity `e`,
`solveKepler` finds eccentric anomaly `E` satisfying `M = E - e*sin(E)` via
Newton-Raphson, seeded at `E = M`, capped at 50 iterations, converging when
the step size drops below `1e-10`.

**Mean anomaly at time `t`.** `meanAnomalyAt` computes mean motion
`n = sqrt(mu / a^3)` (radians per Julian year) and advances the epoch mean
anomaly by `n * (t - epoch)`, wrapped into `[0, 2*pi)`.

**State vector.** `stateAt` solves for `E`, computes the perifocal (PQW)
position `(a*(cos E - e), a*sqrt(1-e^2)*sin E)`, then rotates into the
ecliptic frame with the standard 3-1-3 sequence `R3(-om) * R1(-i) * R3(-w)`
using argument of perihelion `w`, inclination `i`, and longitude of
ascending node `om`.

**Correctness checks** (`src/orbit.test.ts`): Kepler round-trips across a
grid of `M`/`e`; a circular orbit (`e=0`) stays at constant radius; Eros
(433) oscillates between its known perihelion/aphelion band (~1.13–1.78 AU)
across a full period, which is the test that catches a broken rotation
sequence; Earth returns to its starting position after one full year.

Planet elements are hardcoded J2000 mean elements (Standish 1800–2050,
[`src/planets.ts`](src/planets.ts)) — constant, no secular rates, which is
the accepted approximation for a visual orrery at this scale.

## Data

`scripts/fetch-data.ts` (`npm run fetch-data`) is the only code in this
project that talks to JPL. It writes static JSON to `public/data/`, which
Vite serves as-is — the browser only ever reads local files.

- **NEO orbital elements** — `ssd-api.jpl.nasa.gov/sbdb_query.api`,
  `sb-group=neo`, fields confirmed live against that API's `info=field`
  endpoint before being hardcoded (see the `SBDB_FIELDS` comment in the
  script). Objects with eccentricity ≥ 1 (hyperbolic/parabolic) or any
  missing element are dropped.
- **Close approaches** — `ssd-api.jpl.nasa.gov/cad.api`,
  `dist-max=10LD&date-min=now&date-max=+1000` (next ~2.7 years, within 10
  lunar distances).

`public/data/*.json` is committed to the repo (not gitignored) and kept
current by a scheduled GitHub Action
([`.github/workflows/refresh-data.yml`](.github/workflows/refresh-data.yml))
that re-runs `fetch-data` weekly and commits the result if it changed. That
commit's push to `main` also triggers a redeploy. Worth knowing: the NEO
file is ~10 MB and mostly rewritten on every refresh (JPL doesn't provide a
diff/delta endpoint), so this trades steady repo growth (~10 MB/week) for
having versioned, always-buildable data with no runtime dependency on JPL
being reachable. If that growth becomes a problem, the alternative is to
stop committing `public/data` and instead have only the deploy workflow
fetch fresh data at build time.

## Deployment

Deployed to GitHub Pages via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) on every push
to `main` (fetches fresh data, builds, publishes `dist/`).

## Architecture

No backend, no runtime API calls from the browser. Two performance rules
that matter at NEO-population scale (tens of thousands of objects):

- All orbit paths are sampled once and merged into a single `LineSegments`
  `BufferGeometry` — never one `Line` per object.
- All NEO bodies share a single `InstancedMesh`; positions are written into
  the instance matrix array every frame (`instanceMatrix.needsUpdate = true`),
  never individual meshes.
