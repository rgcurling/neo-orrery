// Phase 3-6 renderer: Sun, the eight planets with visible orbit lines, the
// full NEO swarm as a single InstancedMesh, DOM controls (scrubber,
// play/pause, speed, NEO-orbit/label toggles), close-approach flashing,
// click-to-inspect, a visual pass (selective bloom, additive NEO haze,
// distance-faded orbit lines, starfield, ecliptic dimming), and a follow
// cam that locks onto a selected body with an eased transition in and out.
// Positions come from the pure physics in orbit.ts -- this file only turns
// state vectors into pixels.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLANETS } from './planets.js';
import { stateAt, dateToJD, jdToDate, type Vec3 } from './orbit.js';
import type { CloseApproach, NeoRecord, OrbitalElements, SentryRecord } from './types.js';

const ORBIT_SAMPLES = 128;
const PROFILE_WINDOW_FRAMES = 30;
const PROFILE_READY_AFTER_FRAMES = 150;
const CLOSE_APPROACH_WINDOW_DAYS = 1;
const RAD2DEG = 180 / Math.PI;
const BLOOM_SCENE = 1;
const FOLLOW_TRANSITION_MS = 1200;

function smoothstep(t: number): number {
  const x = Math.min(Math.max(t, 0), 1);
  return x * x * (3 - 2 * x);
}

// Body sizes are visually exaggerated for legibility -- at true scale every
// planet would be an invisible speck next to Mercury's 0.39 AU orbit. Orbit
// geometry itself uses real AU distances, unscaled.
const SUN_RADIUS = 0.25;
const PLANET_RADIUS: Record<string, number> = {
  Mercury: 0.035,
  Venus: 0.05,
  Earth: 0.052,
  Mars: 0.04,
  Jupiter: 0.14,
  Saturn: 0.12,
  Uranus: 0.08,
  Neptune: 0.078,
};
const NEO_RADIUS = 0.008;
const NEO_BASE_COLOR = new THREE.Color(0x6f93b8);
const NEO_FLASH_COLOR = new THREE.Color(0xff3b3b);
const SENTRY_SCALE = 3; // Sentry-tracked NEOs render larger so they're findable in the haze

// Real axial tilt (obliquity to orbit, degrees) and sidereal rotation period
// (days; negative = retrograde). Both applied as a deterministic function of
// simJd (like orbital position), never an accumulated per-frame delta, so
// scrubbing the timeline snaps rotation to the correct angle instead of
// depending on playback history.
const PLANET_TILT_DEG: Record<string, number> = {
  Mercury: 0.034,
  Venus: 177.4,
  Earth: 23.44,
  Mars: 25.19,
  Jupiter: 3.13,
  Saturn: 26.73,
  Uranus: 97.77,
  Neptune: 28.32,
};
const PLANET_ROTATION_DAYS: Record<string, number> = {
  Mercury: 58.646,
  Venus: -243.025,
  Earth: 0.99727,
  Mars: 1.02595,
  Jupiter: 0.41354,
  Saturn: 0.44401,
  Uranus: -0.71833,
  Neptune: 0.6713,
};
const EARTH_CLOUDS_ROTATION_DAYS = 5; // faster drift than the surface, for visual life

const TEXTURE_BASE = `${import.meta.env.BASE_URL}textures/`;
const HIRES_TEXTURE_BASE = `${import.meta.env.BASE_URL}textures-hires/`;
const textureLoader = new THREE.TextureLoader();

function loadTextureFrom(url: string, colorSpace: THREE.ColorSpace): Promise<THREE.Texture> {
  return textureLoader.loadAsync(url).then((tex) => {
    tex.colorSpace = colorSpace;
    return tex;
  });
}
function loadTexture(file: string, colorSpace: THREE.ColorSpace): Promise<THREE.Texture> {
  return loadTextureFrom(TEXTURE_BASE + file, colorSpace);
}

/** One-time runtime invert for the specular map: bright (ocean) in the
 * source should mean LOW roughness (shiny), but roughnessMap reads its
 * green channel directly, so the source needs inverting first. No build
 * tool available for this (no ImageMagick/PIL in this environment), and a
 * 2048x1024 canvas invert is cheap and one-shot, so it happens here instead
 * of at fetch time. */
function invertToRoughnessMap(source: THREE.Texture): THREE.Texture {
  const img = source.image as HTMLImageElement;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i];
    data[i + 1] = 255 - data[i + 1];
    data[i + 2] = 255 - data[i + 2];
  }
  ctx.putImageData(imageData, 0, 0);
  return new THREE.CanvasTexture(canvas);
}

/** RingGeometry's default UVs map u tangentially (around the ring) -- wrong
 * for a texture whose gradient runs radially. Rewrites u to normalized
 * radius (0 at innerRadius, 1 at outerRadius) so the ring texture reads
 * correctly instead of smearing into nonsense. */
function fixRingUVs(geometry: THREE.RingGeometry, innerRadius: number, outerRadius: number): void {
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const radius = Math.sqrt(v.x * v.x + v.y * v.y);
    const u = (radius - innerRadius) / (outerRadius - innerRadius);
    uv.setXY(i, u, 0.5);
  }
  uv.needsUpdate = true;
}

// Palermo Scale risk tiers, per JPL's own interpretation of the scale:
// PS < -2 no likely consequence, -2..0 merits careful monitoring, >=0 merits
// concern. Colors are the app's fixed status palette (good/serious/critical) --
// never reused for ordinary series data, always paired with a label in the UI.
interface SentryTier {
  key: string;
  label: string;
  color: THREE.Color;
}
const SENTRY_TIERS: SentryTier[] = [
  { key: 'critical', label: 'PS ≥ 0 — merits concern', color: new THREE.Color(0xd03b3b) },
  { key: 'serious', label: '-2 ≤ PS < 0 — merits monitoring', color: new THREE.Color(0xec835a) },
  { key: 'good', label: 'PS < -2 — no likely consequence', color: new THREE.Color(0x0ca30c) },
];
function sentryTierFor(psCum: number): SentryTier {
  if (psCum >= 0) return SENTRY_TIERS[0];
  if (psCum >= -2) return SENTRY_TIERS[1];
  return SENTRY_TIERS[2];
}

// --- Featured asteroids: the largest few dozen NEOs by known diameter get
// pulled out of the anonymous swarm as individually modeled, clickable
// bodies -- real shape+texture for 433 Eros (the only one in this dataset
// ever actually visited by a spacecraft), a deformed-icosahedron "rock" with
// a generic cratered-surface texture for the rest. Sized on a compressed
// (sqrt) scale, deliberately capped below Mercury's radius: true 1:1 scale
// would make even the largest (Ganymed, ~38 km) an invisible speck next to
// any planet, so this reads as "small but findable," never "planet-sized."
const FEATURED_ASTEROID_COUNT = 20;
const FEATURED_MIN_RADIUS = 0.012;
const FEATURED_MAX_RADIUS = 0.028; // stays under Mercury's 0.035
const FEATURED_SPIN_HOURS_MIN = 4;
const FEATURED_SPIN_HOURS_MAX = 11;

/** Deterministic hash for turning a designation into a stable pseudo-random
 * value -- so each generic asteroid gets its own consistent bump pattern,
 * spin rate, and color tint across reloads, without a seeded PRNG library. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0) / 0xffffffff; // -> [0, 1)
}

/** A lumpy, non-spherical "rock" shape via smooth low-frequency trig
 * displacement in spherical-angle space (not per-vertex hash noise, which
 * would look spiky/uncorrelated between neighboring vertices). */
function buildIrregularAsteroidGeometry(radius: number, seed: number): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(radius, 3);
  const pos = geometry.attributes.position;
  const v = new THREE.Vector3();
  const s = seed * 37.1;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const theta = Math.atan2(v.z, v.x);
    const phi = Math.acos(THREE.MathUtils.clamp(v.y / radius, -1, 1));
    let bump = 0;
    bump += Math.sin(theta * 3 + s) * Math.cos(phi * 2 + s) * 0.5;
    bump += Math.sin(theta * 5 + s * 2.1) * Math.cos(phi * 4 + s * 1.3) * 0.25;
    bump += Math.sin(theta * 9 + s * 0.7) * Math.cos(phi * 7 + s * 3.3) * 0.125;
    v.multiplyScalar(1 + bump * 0.28);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Position on an orbit's fixed ellipse at mean anomaly M, independent of time. */
function orbitPositionAtM(elements: OrbitalElements, M: number): Vec3 {
  return stateAt({ ...elements, ma: M }, elements.epoch);
}

/** One merged LineSegments geometry for all given orbits -- never one Line per object. */
function buildOrbitLineGeometry(elementsList: OrbitalElements[]): THREE.BufferGeometry {
  const positions = new Float32Array(elementsList.length * ORBIT_SAMPLES * 2 * 3);
  let idx = 0;
  for (const elements of elementsList) {
    const pts: Vec3[] = [];
    for (let k = 0; k < ORBIT_SAMPLES; k++) {
      pts.push(orbitPositionAtM(elements, (k / ORBIT_SAMPLES) * Math.PI * 2));
    }
    for (let k = 0; k < ORBIT_SAMPLES; k++) {
      const p0 = pts[k];
      const p1 = pts[(k + 1) % ORBIT_SAMPLES];
      positions[idx++] = p0.x;
      positions[idx++] = p0.y;
      positions[idx++] = p0.z;
      positions[idx++] = p1.x;
      positions[idx++] = p1.y;
      positions[idx++] = p1.z;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

/** Orbit-line material that fades to transparent with camera distance, so
 * distant rings recede instead of the whole scene turning into wire wool. */
function createFadingLineMaterial(color: number, baseOpacity: number, fadeNear: number, fadeFar: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: baseOpacity },
      uFadeNear: { value: fadeNear },
      uFadeFar: { value: fadeFar },
    },
    vertexShader: `
      varying float vDist;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vDist = -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uFadeNear;
      uniform float uFadeFar;
      varying float vDist;
      void main() {
        float fade = 1.0 - smoothstep(uFadeNear, uFadeFar, vDist);
        gl_FragColor = vec4(uColor, uOpacity * fade);
      }
    `,
    transparent: true,
    depthWrite: false,
  });
}

function buildStarfield(): THREE.Points {
  const STAR_COUNT = 6000;
  const STAR_RADIUS = 400;
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  const color = new THREE.Color();

  for (let i = 0; i < STAR_COUNT; i++) {
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = STAR_RADIUS * (0.85 + Math.random() * 0.15);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    const tint = Math.random();
    const lightness = 0.75 + Math.random() * 0.25;
    if (tint < 0.15) {
      color.setHSL(0.08, 0.35, lightness); // warm
    } else if (tint > 0.85) {
      color.setHSL(0.58, 0.35, lightness); // cool
    } else {
      color.setHSL(0, 0, lightness); // white
    }
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 1.3,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
  });
  return new THREE.Points(geometry, material);
}

function formatElements(elements: OrbitalElements): string {
  return (
    `a: ${elements.a.toFixed(4)} AU\n` +
    `e: ${elements.e.toFixed(4)}\n` +
    `i: ${(elements.i * RAD2DEG).toFixed(2)}°\n` +
    `om: ${(elements.om * RAD2DEG).toFixed(2)}°\n` +
    `w: ${(elements.w * RAD2DEG).toFixed(2)}°\n` +
    `ma: ${(elements.ma * RAD2DEG).toFixed(2)}°\n` +
    `epoch: JD ${elements.epoch.toFixed(1)}`
  );
}

async function main() {
  const statsEl = document.getElementById('stats')!;
  const dateReadoutEl = document.getElementById('date-readout')!;
  const scrubberEl = document.getElementById('scrubber') as HTMLInputElement;
  const playPauseEl = document.getElementById('play-pause') as HTMLButtonElement;
  const speedEl = document.getElementById('speed') as HTMLInputElement;
  const speedLabelEl = document.getElementById('speed-label')!;
  const toggleNeoOrbitsEl = document.getElementById('toggle-neo-orbits') as HTMLInputElement;
  const toggleLabelsEl = document.getElementById('toggle-labels') as HTMLInputElement;
  const inspectorEl = document.getElementById('inspector')!;
  const bannerEl = document.getElementById('close-approach-banner')!;
  const labelsEl = document.getElementById('labels')!;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000308);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 500);
  camera.position.set(0, 22, 42);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  document.getElementById('app')!.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // Sun light: decay=0 (no inverse-square falloff) so every planet gets the
  // same illumination regardless of AU distance. Physically-correct decay=2
  // would put Neptune (30 AU) at ~1/900th of Mercury's (0.39 AU) light --
  // effectively black -- and would need per-planet intensity compensation
  // to fix, which is more magic numbers than this scene needs. Body sizes
  // here are already visually exaggerated for legibility (see PLANET_RADIUS
  // above); uniform lighting regardless of distance is the same trade.
  // Ambient is kept low so the day/night terminator (and Earth's night-side
  // city lights, once textured) actually reads instead of being washed out.
  scene.add(new THREE.AmbientLight(0x223344, 0.15));
  scene.add(new THREE.PointLight(0xffffff, 4.5, 0, 0));

  scene.add(buildStarfield());

  // --- Selective bloom setup: only objects tagged with BLOOM_SCENE feed the
  // bloom pass. Everything else is swapped to solid black for that pass so
  // it neither triggers the brightness threshold nor smears into the blur.
  const bloomLayer = new THREE.Layers();
  bloomLayer.set(BLOOM_SCENE);
  const darkMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const materialCache = new Map<string, THREE.Material | THREE.Material[]>();

  // Keyed on "has a material" rather than .isMesh -- Points (the starfield)
  // and LineSegments (orbit lines) don't set .isMesh but still need to be
  // excluded from bloom, or they leak into the pass unblackened.
  function darkenNonBloomed(obj: THREE.Object3D) {
    const renderable = obj as THREE.Mesh;
    if (renderable.material && !bloomLayer.test(renderable.layers)) {
      materialCache.set(renderable.uuid, renderable.material);
      renderable.material = darkMaterial;
    }
  }
  function restoreMaterial(obj: THREE.Object3D) {
    const renderable = obj as THREE.Mesh;
    const cached = materialCache.get(renderable.uuid);
    if (cached) {
      renderable.material = cached;
      materialCache.delete(renderable.uuid);
    }
  }

  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_RADIUS, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xfff2b0 }),
  );
  sun.layers.enable(BLOOM_SCENE); // blooms hard
  scene.add(sun);

  statsEl.textContent = 'Loading textures...';
  const SRGB = THREE.SRGBColorSpace;
  const LINEAR = THREE.NoColorSpace;
  const PLANET_TEXTURE_FILE: Record<string, string> = {
    Mercury: 'mercury.webp',
    Venus: 'venus.webp',
    Mars: 'mars.webp',
    Jupiter: 'jupiter.webp',
    Saturn: 'saturn.webp',
    Uranus: 'uranus.webp',
    Neptune: 'neptune.webp',
  };
  const [surfaceTextures, earthDaymap, earthNightmap, earthCloudsTex, earthSpecularSrc, saturnRingTex] =
    await Promise.all([
      Promise.all(
        Object.entries(PLANET_TEXTURE_FILE).map(async ([name, file]) => [name, await loadTexture(file, SRGB)] as const),
      ).then((entries) => new Map(entries)),
      loadTexture('earth_daymap.webp', SRGB),
      loadTexture('earth_nightmap.webp', SRGB),
      loadTexture('earth_clouds.webp', SRGB),
      loadTexture('earth_specular.webp', LINEAR),
      loadTexture('saturn_ring.webp', SRGB),
    ]);
  const earthRoughnessMap = invertToRoughnessMap(earthSpecularSrc);

  const planetMeshes: {
    name: string;
    group: THREE.Group;
    mesh: THREE.Mesh;
    clouds: THREE.Mesh | null;
    ring: THREE.Mesh | null;
    elements: OrbitalElements;
    label: HTMLDivElement;
    rotationDays: number;
  }[] = PLANETS.map((planet) => {
    const radius = PLANET_RADIUS[planet.name] ?? 0.05;
    const isEarth = planet.name === 'Earth';

    const material = isEarth
      ? new THREE.MeshStandardMaterial({
          map: earthDaymap,
          roughnessMap: earthRoughnessMap,
          roughness: 1,
          metalness: 0.1,
          emissiveMap: earthNightmap,
          emissive: 0xffffff,
          emissiveIntensity: 1.4,
        })
      : new THREE.MeshStandardMaterial({
          map: surfaceTextures.get(planet.name) ?? null,
          color: surfaceTextures.has(planet.name) ? 0xffffff : planet.color,
          roughness: 0.75,
          metalness: 0.05,
        });

    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 48), material);

    // Faint glow proxy: bloom-layer only (never in the base render), so
    // planets get a soft halo without blowing out the crisp planet sphere.
    const glowProxy = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.8, 12, 12),
      new THREE.MeshBasicMaterial({
        color: planet.color,
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    glowProxy.layers.set(BLOOM_SCENE);
    mesh.add(glowProxy);

    // Axial tilt lives on a parent group so it doesn't get tangled up with
    // the per-frame spin on `mesh` -- the group carries orbital position +
    // fixed obliquity, `mesh` (and clouds/rings, as siblings) just rotate
    // around the group's already-tilted local Y each frame.
    const group = new THREE.Group();
    const tiltRad = (PLANET_TILT_DEG[planet.name] ?? 0) * (Math.PI / 180);
    group.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), tiltRad);
    group.add(mesh);

    let clouds: THREE.Mesh | null = null;
    if (isEarth) {
      clouds = new THREE.Mesh(
        new THREE.SphereGeometry(radius * 1.02, 48, 48),
        new THREE.MeshStandardMaterial({
          map: earthCloudsTex,
          alphaMap: earthCloudsTex,
          transparent: true,
          depthWrite: false,
          roughness: 1,
        }),
      );
      group.add(clouds);
    }

    let ring: THREE.Mesh | null = null;
    if (planet.name === 'Saturn') {
      const innerRadius = radius * 1.3;
      const outerRadius = radius * 2.3;
      const ringGeometry = new THREE.RingGeometry(innerRadius, outerRadius, 128, 1);
      fixRingUVs(ringGeometry, innerRadius, outerRadius);
      ring = new THREE.Mesh(
        ringGeometry,
        new THREE.MeshStandardMaterial({
          map: saturnRingTex,
          alphaMap: saturnRingTex,
          transparent: true,
          side: THREE.DoubleSide,
          roughness: 0.9,
        }),
      );
      ring.rotation.x = Math.PI / 2; // RingGeometry is built in the XY plane; lay it flat on the equator
      group.add(ring);
    }

    scene.add(group);

    const label = document.createElement('div');
    label.className = 'planet-label';
    label.textContent = planet.name;
    labelsEl.appendChild(label);

    return {
      name: planet.name,
      group,
      mesh,
      clouds,
      ring,
      elements: planet.elements,
      label,
      rotationDays: PLANET_ROTATION_DAYS[planet.name] ?? 1,
    };
  });

  const planetOrbits = new THREE.LineSegments(
    buildOrbitLineGeometry(PLANETS.map((p) => p.elements)),
    createFadingLineMaterial(0x5577aa, 0.55, 15, 90),
  );
  scene.add(planetOrbits);

  statsEl.textContent = 'Loading NEOs...';
  const [neos, closeApproaches, sentryRecords]: [NeoRecord[], CloseApproach[], SentryRecord[]] = await Promise.all([
    fetch(`${import.meta.env.BASE_URL}data/neos.json`).then((res) => res.json()),
    fetch(`${import.meta.env.BASE_URL}data/close-approaches.json`).then((res) => res.json()),
    fetch(`${import.meta.env.BASE_URL}data/sentry.json`).then((res) => res.json()),
  ]);

  const designationToIndex = new Map<string, number>();
  neos.forEach((neo, i) => designationToIndex.set(neo.designation, i));

  const sentryByDesignation = new Map<string, SentryRecord>();
  sentryRecords.forEach((s) => sentryByDesignation.set(s.designation, s));

  // Additive + low opacity so the NEO cloud reads as a haze that thickens
  // where orbits cluster, rather than a scatter of hard dots.
  const neoMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  // Dim instances by their distance from the ecliptic (z=0) plane, computed
  // on the GPU from the instance transform -- no extra per-frame CPU cost
  // beyond the position update the swarm already needs.
  neoMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vEclipticDim;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  float instZ = instanceMatrix[3].z;
#else
  float instZ = 0.0;
#endif
  vEclipticDim = 1.0 / (1.0 + abs(instZ) * 2.5);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vEclipticDim;')
      .replace(
        '#include <dithering_fragment>',
        `gl_FragColor.rgb *= mix(0.2, 1.0, vEclipticDim);\n#include <dithering_fragment>`,
      );
  };

  const neoMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(NEO_RADIUS, 0), neoMaterial, neos.length);
  neoMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < neos.length; i++) {
    neoMesh.setColorAt(i, NEO_BASE_COLOR);
  }

  // Impact-risk overlay: only Sentry objects that actually merit attention
  // (Palermo scale >= -2 -- "serious" or "critical") get tinted and enlarged.
  // The other ~99.9% ("good", no likely consequence) blend back into the
  // ordinary swarm -- highlighting all 2,175 tracked objects made "tracked
  // by Sentry" look like a risk signal on its own, when for nearly all of
  // them it isn't. sentryRestColor remembers each tinted instance's resting
  // color so close-approach flashing (below) can revert to the right color.
  const sentryRestColor = new Map<number, THREE.Color>();
  const neoScale = new Float32Array(neos.length).fill(1);
  const sentryTierCounts = new Map<string, number>();
  for (const record of sentryRecords) {
    const idx = designationToIndex.get(record.designation);
    if (idx === undefined) continue;
    const tier = sentryTierFor(record.psCum);
    sentryTierCounts.set(tier.key, (sentryTierCounts.get(tier.key) ?? 0) + 1);
    if (tier.key === 'good') continue;
    neoMesh.setColorAt(idx, tier.color);
    sentryRestColor.set(idx, tier.color);
    neoScale[idx] = SENTRY_SCALE;
  }

  neoMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
  scene.add(neoMesh);

  const legendEl = document.getElementById('sentry-legend')!;
  legendEl.innerHTML =
    `<h3>Impact risk (Sentry) — ${sentryRecords.length.toLocaleString()} tracked</h3>` +
    SENTRY_TIERS.map((tier) => {
      const count = sentryTierCounts.get(tier.key) ?? 0;
      const highlighted = tier.key !== 'good';
      const swatchStyle = highlighted
        ? `background:#${tier.color.getHexString()}`
        : `background:transparent;border:1px solid #556677`;
      return (
        `<div class="legend-row"><span class="swatch" style="${swatchStyle}"></span>` +
        `${tier.label} <span class="legend-count">(${count}${highlighted ? '' : ', not highlighted'})</span></div>`
      );
    }).join('');

  // --- Featured asteroids: the largest known-diameter NEOs, pulled out of
  // the instanced swarm as individually modeled bodies. Real shape+texture
  // for 433 Eros (NASA/NEAR Shoemaker, the only one here ever visited by a
  // spacecraft); a generic deformed "rock" for the rest -- lightcurve-only
  // shape data exists for some of them, but that's a rough convex silhouette
  // with no actual surface imagery, so claiming a specific texture for it
  // would be faking detail we don't have.
  statsEl.textContent = 'Loading featured asteroids...';
  const featuredCandidates = neos
    .filter((n) => n.diameterKm !== null)
    .sort((a, b) => b.diameterKm! - a.diameterKm!)
    .slice(0, FEATURED_ASTEROID_COUNT);
  const featuredDiameters = featuredCandidates.map((n) => n.diameterKm!);
  const minFeaturedD = Math.min(...featuredDiameters);
  const maxFeaturedD = Math.max(...featuredDiameters);
  function featuredRadiusFor(diameterKm: number): number {
    if (maxFeaturedD === minFeaturedD) return (FEATURED_MIN_RADIUS + FEATURED_MAX_RADIUS) / 2;
    const t = (Math.sqrt(diameterKm) - Math.sqrt(minFeaturedD)) / (Math.sqrt(maxFeaturedD) - Math.sqrt(minFeaturedD));
    return FEATURED_MIN_RADIUS + t * (FEATURED_MAX_RADIUS - FEATURED_MIN_RADIUS);
  }

  const [asteroidGenericTex, erosGltf] = await Promise.all([
    loadTexture('asteroid_generic.webp', SRGB),
    new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/eros.glb`),
  ]);

  const featuredAsteroids: {
    neo: NeoRecord;
    mesh: THREE.Object3D;
    pickMesh: THREE.Object3D;
    radius: number;
    spinDays: number;
    label: HTMLDivElement;
  }[] = featuredCandidates.map((neo) => {
    const radius = featuredRadiusFor(neo.diameterKm!);
    const seed = hashString(neo.designation);
    const isEros = neo.designation === '433';

    let body: THREE.Object3D;
    let pickMesh: THREE.Object3D;
    if (isEros) {
      const erosScene = erosGltf.scene.clone(true);
      const box = new THREE.Box3().setFromObject(erosScene);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      erosScene.scale.setScalar((radius * 2) / maxDim);
      body = erosScene;
      // Raycasting uses non-recursive intersectObjects (see click handler),
      // matching every other target in that list -- so the actual leaf mesh
      // inside the glTF scene graph has to be the target, not the group.
      pickMesh = body;
      body.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) pickMesh = child;
      });
    } else {
      const tint = new THREE.Color().setHSL(0.08 + seed * 0.06, 0.15 + seed * 0.1, 0.42 + seed * 0.12);
      body = new THREE.Mesh(
        buildIrregularAsteroidGeometry(radius, seed * 100),
        new THREE.MeshStandardMaterial({ map: asteroidGenericTex, color: tint, roughness: 0.95, metalness: 0.05 }),
      );
      pickMesh = body;
    }
    // Random but deterministic tumble axis + orientation so they don't all
    // spin in visual lockstep.
    body.rotation.set(seed * 6.28, seed * 3.14, seed * 9.42);
    scene.add(body);

    const label = document.createElement('div');
    label.className = 'planet-label';
    label.textContent = neo.name ?? neo.fullName;
    labelsEl.appendChild(label);

    const idx = designationToIndex.get(neo.designation);
    if (idx !== undefined) neoScale[idx] = 0; // hide from the instanced swarm -- this mesh replaces it

    return {
      neo,
      mesh: body,
      pickMesh,
      radius,
      spinDays: (FEATURED_SPIN_HOURS_MIN + seed * (FEATURED_SPIN_HOURS_MAX - FEATURED_SPIN_HOURS_MIN)) / 24,
      label,
    };
  });

  // NEO orbit lines: built lazily on first toggle-on, since 42k merged
  // ellipses is expensive to compute and nobody needs it by default.
  let neoOrbits: THREE.LineSegments | null = null;
  let buildingNeoOrbits = false;
  function ensureNeoOrbitsBuilt() {
    if (neoOrbits || buildingNeoOrbits) return;
    buildingNeoOrbits = true;
    toggleNeoOrbitsEl.disabled = true;
    const prevLabel = toggleNeoOrbitsEl.parentElement!.lastChild!.textContent;
    toggleNeoOrbitsEl.parentElement!.lastChild!.textContent = ` Building ${neos.length.toLocaleString()} NEO orbits...`;
    requestAnimationFrame(() => {
      neoOrbits = new THREE.LineSegments(
        buildOrbitLineGeometry(neos.map((n) => n.elements)),
        createFadingLineMaterial(0x3f5a78, 0.12, 5, 40),
      );
      scene.add(neoOrbits);
      buildingNeoOrbits = false;
      toggleNeoOrbitsEl.disabled = false;
      toggleNeoOrbitsEl.parentElement!.lastChild!.textContent = prevLabel;
      neoOrbits.visible = toggleNeoOrbitsEl.checked;
    });
  }

  // --- Postprocessing: bloom-only composer feeds a final additive-combine pass ---
  const renderScale = Math.min(window.devicePixelRatio, 2);
  const bloomComposer = new EffectComposer(renderer);
  bloomComposer.renderToScreen = false;
  bloomComposer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    1.1, // strength
    0.55, // radius
    0.75, // threshold (was 0.15 -- see Phase 4 note below)
  );
  bloomComposer.addPass(bloomPass);

  const combineShader = {
    uniforms: {
      baseTexture: { value: null as THREE.Texture | null },
      bloomTexture: { value: bloomComposer.renderTarget2.texture },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D baseTexture;
      uniform sampler2D bloomTexture;
      varying vec2 vUv;
      void main() {
        vec4 base = texture2D(baseTexture, vUv);
        vec4 bloom = texture2D(bloomTexture, vUv);
        gl_FragColor = base + bloom;
      }
    `,
  };
  const finalComposer = new EffectComposer(renderer);
  finalComposer.addPass(new RenderPass(scene, camera));
  const combinePass = new ShaderPass(new THREE.ShaderMaterial(combineShader), 'baseTexture');
  combinePass.needsSwap = true;
  finalComposer.addPass(combinePass);
  finalComposer.addPass(new OutputPass());

  function setComposerSize(width: number, height: number) {
    bloomComposer.setSize(width, height);
    finalComposer.setSize(width, height);
    bloomPass.setSize(width, height);
  }
  setComposerSize(window.innerWidth, window.innerHeight);
  void renderScale;

  function renderFrame() {
    scene.traverse(darkenNonBloomed);
    bloomComposer.render();
    scene.traverse(restoreMaterial);
    finalComposer.render();
  }

  // --- Playback state ---
  const now = new Date();
  const scrubMinJd = dateToJD(new Date(now.getTime() - 365 * 86_400_000));
  const scrubMaxJd = dateToJD(new Date(now.getTime() + 1000 * 86_400_000));
  scrubberEl.min = String(scrubMinJd);
  scrubberEl.max = String(scrubMaxJd);

  let simJd = dateToJD(now);
  let playing = true;
  scrubberEl.value = String(simJd);

  function daysPerSecondFromSpeedSlider(): number {
    // Exponential map: slider 0 -> 1 day/sec, slider 1 -> 365 days/sec (1 year/sec).
    return Math.pow(365, Number(speedEl.value));
  }
  function updateSpeedLabel() {
    const dps = daysPerSecondFromSpeedSlider();
    speedLabelEl.textContent = dps >= 60 ? `${(dps / 365).toFixed(2)} yr/s` : `${dps.toFixed(1)} d/s`;
  }
  updateSpeedLabel();
  speedEl.addEventListener('input', updateSpeedLabel);

  playPauseEl.addEventListener('click', () => {
    playing = !playing;
    playPauseEl.textContent = playing ? 'Pause' : 'Play';
  });

  scrubberEl.addEventListener('input', () => {
    playing = false;
    playPauseEl.textContent = 'Play';
    simJd = Number(scrubberEl.value);
  });

  toggleNeoOrbitsEl.addEventListener('change', () => {
    if (toggleNeoOrbitsEl.checked) {
      ensureNeoOrbitsBuilt();
      if (neoOrbits) neoOrbits.visible = true;
    } else if (neoOrbits) {
      neoOrbits.visible = false;
    }
  });

  toggleLabelsEl.addEventListener('change', () => {
    labelsEl.classList.toggle('hidden', !toggleLabelsEl.checked);
  });

  // --- Follow cam: locks onto a selected body with an eased transition in
  // and out, then tracks it frame-to-frame while preserving the user's
  // current viewing angle and still letting OrbitControls orbit/zoom on top.
  const followHudEl = document.getElementById('follow-hud')!;
  const followHudLabelEl = document.getElementById('follow-hud-label')!;
  const followExitBtnEl = document.getElementById('follow-exit-btn') as HTMLButtonElement;

  interface FollowTarget {
    label: string;
    getPosition: () => Vec3;
    viewDistance: number;
    planetEntry?: (typeof planetMeshes)[number];
  }

  // --- Lazy high-res swap: fetched only when follow-cam locks onto that
  // specific planet, disposed on exit, at most one hi-res set resident at a
  // time. Hosted in a separate committed directory (public/textures-hires/)
  // rather than hotlinked from the Solar System Scope CDN -- confirmed live
  // that CDN doesn't send Access-Control-Allow-Origin, so a WebGL texture
  // upload from it throws a cross-origin SecurityError regardless of
  // crossOrigin='anonymous' on this end. Self-hosting is the only option
  // that actually works from a static GitHub Pages site with no proxy.
  // Resized to 4096x2048 rather than the source 8K: the full 8K set for
  // these bodies ran ~32MB even at WebP q85, disproportionate for an
  // opt-in follow-cam upgrade; 4K is still a real sharpness jump over the
  // base 2K set at ~7.4MB. Uranus and Neptune have no resolution beyond 2K
  // published by the source at all, so follow-cam on them is a no-op here.
  const HIRES_AVAILABLE = new Set(['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn']);
  const HIRES_PLANET_FILE: Record<string, string> = {
    Mercury: 'mercury.webp',
    Venus: 'venus.webp',
    Mars: 'mars.webp',
    Jupiter: 'jupiter.webp',
    Saturn: 'saturn.webp',
  };

  let hiResGeneration = 0;
  let activeHiRes: { textures: THREE.Texture[]; revert: () => void } | null = null;

  function disposeActiveHiRes() {
    if (!activeHiRes) return;
    activeHiRes.revert();
    for (const tex of activeHiRes.textures) tex.dispose();
    activeHiRes = null;
  }

  async function swapInHiRes(entry: (typeof planetMeshes)[number]) {
    if (!HIRES_AVAILABLE.has(entry.name)) return;
    disposeActiveHiRes();
    const generation = ++hiResGeneration;
    const material = entry.mesh.material as THREE.MeshStandardMaterial;
    const stillCurrent = () => generation === hiResGeneration;

    if (entry.name === 'Earth') {
      const [daymap, nightmap, cloudsTex, specularSrc] = await Promise.all([
        loadTextureFrom(HIRES_TEXTURE_BASE + 'earth_daymap.webp', SRGB),
        loadTextureFrom(HIRES_TEXTURE_BASE + 'earth_nightmap.webp', SRGB),
        loadTextureFrom(HIRES_TEXTURE_BASE + 'earth_clouds.webp', SRGB),
        loadTextureFrom(HIRES_TEXTURE_BASE + 'earth_specular.webp', LINEAR),
      ]);
      const roughnessMap = invertToRoughnessMap(specularSrc);
      specularSrc.dispose(); // only the inverted copy is kept resident
      if (!stillCurrent()) {
        [daymap, nightmap, cloudsTex, roughnessMap].forEach((t) => t.dispose());
        return;
      }

      const prevMap = material.map;
      const prevEmissiveMap = material.emissiveMap;
      const prevRoughnessMap = material.roughnessMap;
      material.map = daymap;
      material.emissiveMap = nightmap;
      material.roughnessMap = roughnessMap;
      material.needsUpdate = true;

      const cloudsMaterial = entry.clouds?.material as THREE.MeshStandardMaterial | undefined;
      const prevCloudsMap = cloudsMaterial?.map ?? null;
      if (cloudsMaterial) {
        cloudsMaterial.map = cloudsTex;
        cloudsMaterial.alphaMap = cloudsTex;
        cloudsMaterial.needsUpdate = true;
      }

      activeHiRes = {
        textures: [daymap, nightmap, roughnessMap, cloudsTex],
        revert: () => {
          material.map = prevMap ?? null;
          material.emissiveMap = prevEmissiveMap ?? null;
          material.roughnessMap = prevRoughnessMap ?? null;
          material.needsUpdate = true;
          if (cloudsMaterial) {
            cloudsMaterial.map = prevCloudsMap;
            cloudsMaterial.alphaMap = prevCloudsMap;
            cloudsMaterial.needsUpdate = true;
          }
        },
      };
      return;
    }

    const file = HIRES_PLANET_FILE[entry.name];
    if (!file) return;
    const tex = await loadTextureFrom(HIRES_TEXTURE_BASE + file, SRGB);
    if (!stillCurrent()) {
      tex.dispose();
      return;
    }
    const prevMap = material.map;
    material.map = tex;
    material.needsUpdate = true;
    const textures = [tex];

    const ringMaterial = entry.ring?.material as THREE.MeshStandardMaterial | undefined;
    let prevRingMap: THREE.Texture | null = null;
    if (entry.name === 'Saturn' && ringMaterial) {
      const ringTex = await loadTextureFrom(HIRES_TEXTURE_BASE + 'saturn_ring.webp', SRGB);
      if (stillCurrent()) {
        prevRingMap = ringMaterial.map;
        ringMaterial.map = ringTex;
        ringMaterial.alphaMap = ringTex;
        ringMaterial.needsUpdate = true;
        textures.push(ringTex);
      } else {
        ringTex.dispose();
      }
    }

    activeHiRes = {
      textures,
      revert: () => {
        material.map = prevMap ?? null;
        material.needsUpdate = true;
        if (ringMaterial && prevRingMap !== null) {
          ringMaterial.map = prevRingMap;
          ringMaterial.alphaMap = prevRingMap;
          ringMaterial.needsUpdate = true;
        }
      },
    };
  }

  type FollowPhase = 'none' | 'entering' | 'following' | 'exiting';
  let followPhase: FollowPhase = 'none';
  let followTarget: FollowTarget | null = null;
  let followTransitionStart = 0;
  const followTransitionFromPos = new THREE.Vector3();
  const followTransitionFromTarget = new THREE.Vector3();
  const followPrevTargetPos = new THREE.Vector3();
  const preFollowCameraPos = new THREE.Vector3();
  const preFollowTarget = new THREE.Vector3();

  function startFollow(target: FollowTarget) {
    if (followPhase === 'none') {
      preFollowCameraPos.copy(camera.position);
      preFollowTarget.copy(controls.target);
    }
    followTarget = target;
    followTransitionStart = performance.now();
    followTransitionFromPos.copy(camera.position);
    followTransitionFromTarget.copy(controls.target);
    followPhase = 'entering';
    followHudEl.hidden = false;
    followHudLabelEl.textContent = target.label;

    if (target.planetEntry) {
      swapInHiRes(target.planetEntry);
    } else {
      disposeActiveHiRes();
    }
  }

  function stopFollow() {
    if (followPhase === 'none') return;
    followTransitionStart = performance.now();
    followTransitionFromPos.copy(camera.position);
    followTransitionFromTarget.copy(controls.target);
    followPhase = 'exiting';
    disposeActiveHiRes();
  }

  followExitBtnEl.addEventListener('click', stopFollow);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') stopFollow();
  });

  function updateFollowCam() {
    if (followPhase === 'entering') {
      const p = followTarget!.getPosition();
      const currentTargetPos = new THREE.Vector3(p.x, p.y, p.z);
      const viewDir = followTransitionFromPos.clone().sub(followTransitionFromTarget).normalize();
      const desiredCamPos = currentTargetPos.clone().addScaledVector(viewDir, followTarget!.viewDistance);
      const alpha = smoothstep((performance.now() - followTransitionStart) / FOLLOW_TRANSITION_MS);
      camera.position.lerpVectors(followTransitionFromPos, desiredCamPos, alpha);
      controls.target.lerpVectors(followTransitionFromTarget, currentTargetPos, alpha);
      followPrevTargetPos.copy(currentTargetPos);
      if (alpha >= 1) followPhase = 'following';
    } else if (followPhase === 'following') {
      const p = followTarget!.getPosition();
      const newTargetPos = new THREE.Vector3(p.x, p.y, p.z);
      const delta = newTargetPos.clone().sub(followPrevTargetPos);
      camera.position.add(delta);
      controls.target.copy(newTargetPos);
      followPrevTargetPos.copy(newTargetPos);
    } else if (followPhase === 'exiting') {
      const alpha = smoothstep((performance.now() - followTransitionStart) / FOLLOW_TRANSITION_MS);
      camera.position.lerpVectors(followTransitionFromPos, preFollowCameraPos, alpha);
      controls.target.lerpVectors(followTransitionFromTarget, preFollowTarget, alpha);
      if (alpha >= 1) {
        followPhase = 'none';
        followTarget = null;
        followHudEl.hidden = true;
      }
    }
    controls.update();
  }

  // --- Click-to-inspect ---
  // Shared inspector body for any NeoRecord -- used for both an instanced-
  // swarm hit and a featured-asteroid hit, which otherwise show identical
  // information (designation/H/diameter/PHA/elements, plus Sentry fields if
  // tracked). Each caller appends its own Follow button, since getPosition
  // and viewDistance differ between the two.
  function buildNeoInspectorHtml(neo: NeoRecord): string {
    const sentry = sentryByDesignation.get(neo.designation);
    return (
      `<h3>${neo.name ?? neo.fullName}</h3><dl>` +
      `<dt>designation</dt><dd>${neo.designation}</dd>` +
      (neo.h !== null ? `<dt>H</dt><dd>${neo.h}</dd>` : '') +
      (neo.diameterKm !== null ? `<dt>diameter</dt><dd>${neo.diameterKm} km</dd>` : '') +
      `<dt>PHA</dt><dd>${neo.pha ? 'yes' : 'no'}</dd>` +
      formatElements(neo.elements)
        .split('\n')
        .map((line) => {
          const [k, v] = line.split(/:\s(.+)/);
          return `<dt>${k}</dt><dd>${v}</dd>`;
        })
        .join('') +
      `</dl>` +
      (sentry
        ? `<h3 class="sentry-heading">Sentry — ${sentryTierFor(sentry.psCum).label}</h3><dl>` +
          `<dt>PS (cum.)</dt><dd>${sentry.psCum.toFixed(2)}</dd>` +
          `<dt>PS (max)</dt><dd>${sentry.psMax.toFixed(2)}</dd>` +
          `<dt>impact prob.</dt><dd>${sentry.impactProbability.toExponential(2)}</dd>` +
          `<dt>potential impacts</dt><dd>${sentry.potentialImpactCount}</dd>` +
          `<dt>years</dt><dd>${sentry.yearRange}</dd>` +
          `</dl>`
        : '')
    );
  }

  // Each shows the inspector + wires its Follow button for one body. Shared
  // between click-to-inspect (below) and the "jump to" picker, so there's
  // exactly one way each body's inspector gets built rather than two
  // (in-3D click and picker) drifting out of sync over time.
  function showSunInspector() {
    inspectorEl.hidden = false;
    inspectorEl.innerHTML =
      `<h3>Sun</h3><div>Sol, G-type main-sequence star.</div>` +
      `<button id="inspector-follow-btn" type="button">Follow ▶</button>`;
    inspectorEl.querySelector('#inspector-follow-btn')!.addEventListener('click', () =>
      startFollow({ label: 'the Sun', getPosition: () => ({ x: 0, y: 0, z: 0 }), viewDistance: SUN_RADIUS * 5 }),
    );
  }

  function showPlanetInspector(planetHit: (typeof planetMeshes)[number]) {
    inspectorEl.hidden = false;
    inspectorEl.innerHTML =
      `<h3>${planetHit.name}</h3><dl>` +
      formatElements(planetHit.elements)
        .split('\n')
        .map((line) => {
          const [k, v] = line.split(/:\s(.+)/);
          return `<dt>${k}</dt><dd>${v}</dd>`;
        })
        .join('') +
      `</dl>` +
      `<button id="inspector-follow-btn" type="button">Follow ▶</button>`;
    inspectorEl.querySelector('#inspector-follow-btn')!.addEventListener('click', () =>
      startFollow({
        label: planetHit.name,
        getPosition: () => stateAt(planetHit.elements, simJd),
        viewDistance: (PLANET_RADIUS[planetHit.name] ?? 0.05) * 7,
        planetEntry: planetHit,
      }),
    );
  }

  function showFeaturedInspector(featuredHit: (typeof featuredAsteroids)[number]) {
    const { neo, radius } = featuredHit;
    inspectorEl.hidden = false;
    inspectorEl.innerHTML = buildNeoInspectorHtml(neo) + `<button id="inspector-follow-btn" type="button">Follow ▶</button>`;
    inspectorEl.querySelector('#inspector-follow-btn')!.addEventListener('click', () =>
      startFollow({
        label: neo.name ?? neo.fullName,
        getPosition: () => stateAt(neo.elements, simJd),
        viewDistance: radius * 7,
      }),
    );
  }

  function showSwarmNeoInspector(neo: NeoRecord) {
    inspectorEl.hidden = false;
    inspectorEl.innerHTML = buildNeoInspectorHtml(neo) + `<button id="inspector-follow-btn" type="button">Follow ▶</button>`;
    inspectorEl.querySelector('#inspector-follow-btn')!.addEventListener('click', () =>
      startFollow({
        label: neo.name ?? neo.fullName,
        getPosition: () => stateAt(neo.elements, simJd),
        viewDistance: NEO_RADIUS * 8,
      }),
    );
  }

  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  renderer.domElement.addEventListener('click', (event) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerNdc, camera);

    const targets: THREE.Object3D[] = [
      sun,
      ...planetMeshes.map((p) => p.mesh),
      ...featuredAsteroids.map((f) => f.pickMesh),
      neoMesh,
    ];
    const hits = raycaster.intersectObjects(targets, false);
    if (hits.length === 0) {
      inspectorEl.hidden = true;
      return;
    }

    const hit = hits[0];
    if (hit.object === sun) {
      showSunInspector();
      return;
    }
    const planetHit = planetMeshes.find((p) => p.mesh === hit.object);
    if (planetHit) {
      showPlanetInspector(planetHit);
      return;
    }
    const featuredHit = featuredAsteroids.find((f) => f.pickMesh === hit.object);
    if (featuredHit) {
      showFeaturedInspector(featuredHit);
      return;
    }
    if (hit.object === neoMesh && hit.instanceId !== undefined) {
      showSwarmNeoInspector(neos[hit.instanceId]);
    }
  });

  // --- Jump-to picker: the ~29 known-interesting bodies (Sun, planets,
  // featured asteroids) are genuinely hard to click in 3D -- tiny targets
  // among 42k instanced dots. A plain <select> sidesteps that entirely, and
  // gets typeahead search for free from the browser.
  const jumpToEl = document.getElementById('jump-to') as HTMLSelectElement;
  {
    const sunOption = new Option('☉ Sun', 'sun');
    jumpToEl.add(sunOption);

    const planetGroup = document.createElement('optgroup');
    planetGroup.label = 'Planets';
    for (const p of planetMeshes) planetGroup.appendChild(new Option(p.name, `planet:${p.name}`));
    jumpToEl.add(planetGroup);

    const featuredGroup = document.createElement('optgroup');
    featuredGroup.label = 'Featured asteroids';
    for (const f of featuredAsteroids) {
      featuredGroup.appendChild(new Option(f.neo.name ?? f.neo.fullName, `featured:${f.neo.designation}`));
    }
    jumpToEl.add(featuredGroup);
  }
  jumpToEl.addEventListener('change', () => {
    const value = jumpToEl.value;
    jumpToEl.selectedIndex = 0; // reset to placeholder -- this is a jump action, not a persistent selection
    if (!value) return;
    if (value === 'sun') {
      showSunInspector();
      return;
    }
    if (value.startsWith('planet:')) {
      const planetHit = planetMeshes.find((p) => p.name === value.slice('planet:'.length));
      if (planetHit) showPlanetInspector(planetHit);
      return;
    }
    if (value.startsWith('featured:')) {
      const featuredHit = featuredAsteroids.find((f) => f.neo.designation === value.slice('featured:'.length));
      if (featuredHit) showFeaturedInspector(featuredHit);
    }
  });

  // --- Close-approach flashing ---
  const activeApproachDesignations = new Set<string>();

  function updateCloseApproaches(currentJd: number) {
    const active = closeApproaches.filter((ca) => Math.abs(ca.jd - currentJd) <= CLOSE_APPROACH_WINDOW_DAYS);
    const activeDesignations = new Set(active.map((a) => a.designation));

    let colorChanged = false;
    for (const designation of activeDesignations) {
      if (!activeApproachDesignations.has(designation)) {
        const idx = designationToIndex.get(designation);
        if (idx !== undefined) {
          neoMesh.setColorAt(idx, NEO_FLASH_COLOR);
          colorChanged = true;
        }
      }
    }
    for (const designation of activeApproachDesignations) {
      if (!activeDesignations.has(designation)) {
        const idx = designationToIndex.get(designation);
        if (idx !== undefined) {
          neoMesh.setColorAt(idx, sentryRestColor.get(idx) ?? NEO_BASE_COLOR);
          colorChanged = true;
        }
      }
    }
    if (colorChanged) neoMesh.instanceColor!.needsUpdate = true;

    activeApproachDesignations.clear();
    for (const d of activeDesignations) activeApproachDesignations.add(d);

    if (active.length === 0) {
      bannerEl.hidden = true;
      return;
    }
    bannerEl.hidden = false;
    bannerEl.innerHTML = active
      .map((a) => {
        const neo = designationToIndex.has(a.designation) ? neos[designationToIndex.get(a.designation)!] : null;
        const label = neo?.name ?? neo?.fullName ?? a.designation;
        return `<div><strong>${label}</strong> — ${a.distLd.toFixed(2)} LD, ${a.vRelKmS.toFixed(1)} km/s (${a.calendarDate})</div>`;
      })
      .join('');
  }

  // --- Animation loop ---
  const instanceTransform = new THREE.Matrix4();
  const scaleVector = new THREE.Vector3();
  const projected = new THREE.Vector3();
  let lastFrameTime = performance.now();
  let frameCount = 0;
  let profileFrameTimeAccum = 0;

  function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const dtMs = now - lastFrameTime;
    lastFrameTime = now;

    if (playing) {
      simJd += (dtMs / 1000) * daysPerSecondFromSpeedSlider();
      if (simJd > scrubMaxJd) simJd = scrubMinJd + (simJd - scrubMaxJd);
      scrubberEl.value = String(simJd);
    }

    const simDate = jdToDate(simJd);
    dateReadoutEl.textContent = simDate.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

    for (const { group, mesh, clouds, elements, label, rotationDays } of planetMeshes) {
      const p = stateAt(elements, simJd);
      group.position.set(p.x, p.y, p.z);

      // Spin (and cloud drift) is a deterministic function of simJd, same as
      // orbital position -- scrubbing the timeline snaps to the right angle
      // instead of depending on how playback got there.
      mesh.rotation.y = ((simJd - elements.epoch) / rotationDays) * Math.PI * 2;
      if (clouds) {
        clouds.rotation.y = ((simJd - elements.epoch) / EARTH_CLOUDS_ROTATION_DAYS) * Math.PI * 2;
      }

      if (!labelsEl.classList.contains('hidden')) {
        projected.copy(group.position).project(camera);
        label.style.left = `${((projected.x + 1) / 2) * window.innerWidth}px`;
        label.style.top = `${((1 - projected.y) / 2) * window.innerHeight}px`;
        label.style.display = projected.z < 1 ? 'block' : 'none';
      }
    }

    for (const { mesh, neo, spinDays, label } of featuredAsteroids) {
      const p = stateAt(neo.elements, simJd);
      mesh.position.set(p.x, p.y, p.z);
      // Spin rate is a plausible generic range, not a real measured period
      // (we don't have that data for most of these) -- visual life, not a claim.
      mesh.rotation.y = ((simJd - neo.elements.epoch) / spinDays) * Math.PI * 2;

      if (!labelsEl.classList.contains('hidden')) {
        projected.copy(mesh.position).project(camera);
        label.style.left = `${((projected.x + 1) / 2) * window.innerWidth}px`;
        label.style.top = `${((1 - projected.y) / 2) * window.innerHeight}px`;
        label.style.display = projected.z < 1 ? 'block' : 'none';
      }
    }

    for (let i = 0; i < neos.length; i++) {
      const p = stateAt(neos[i].elements, simJd);
      instanceTransform.makeTranslation(p.x, p.y, p.z);
      const scale = neoScale[i];
      if (scale !== 1) instanceTransform.scale(scaleVector.setScalar(scale));
      neoMesh.setMatrixAt(i, instanceTransform);
    }
    neoMesh.instanceMatrix.needsUpdate = true;

    updateCloseApproaches(simJd);

    updateFollowCam();
    renderFrame();

    frameCount++;
    profileFrameTimeAccum += dtMs;
    if (frameCount % PROFILE_WINDOW_FRAMES === 0) {
      const avgFrameMs = profileFrameTimeAccum / PROFILE_WINDOW_FRAMES;
      const fps = 1000 / avgFrameMs;
      statsEl.textContent =
        `${neos.length.toLocaleString()} NEOs + 8 planets\n` + `${avgFrameMs.toFixed(2)} ms/frame · ${fps.toFixed(1)} fps`;
      profileFrameTimeAccum = 0;
      if (frameCount >= PROFILE_READY_AFTER_FRAMES) {
        statsEl.dataset.ready = 'true';
      }
    }
  }
  animate();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    setComposerSize(window.innerWidth, window.innerHeight);
  });
}

main();
