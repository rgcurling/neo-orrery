import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { dateToJD, stateAt } from './orbit.js';
import { PLANETS } from './planets.js';
import { buildOrbitLineGeometry, buildOrbitLineGeometryAsync } from './render/orbitLines.js';
import { NeoField } from './render/neoField.js';
import { PlanetLabels } from './render/labels.js';
import { Overlay } from './ui/overlay.js';
import { findActiveApproaches } from './closeApproach.js';
import type { CloseApproach, NeoRecord, OrbitalElements } from './types.js';

const RAD2DEG = 180 / Math.PI;

async function loadData() {
  const [neosRes, approachesRes] = await Promise.all([
    fetch('/data/neos.json'),
    fetch('/data/close-approaches.json'),
  ]);
  if (!neosRes.ok || !approachesRes.ok) {
    throw new Error('Failed to load prefetched data. Did you run `npm run fetch-data`?');
  }
  const neos: NeoRecord[] = await neosRes.json();
  const closeApproaches: CloseApproach[] = await approachesRes.json();
  return { neos, closeApproaches };
}

function formatElements(elements: OrbitalElements): string {
  return [
    `a       ${elements.a.toFixed(4)} AU`,
    `e       ${elements.e.toFixed(4)}`,
    `i       ${(elements.i * RAD2DEG).toFixed(3)} deg`,
    `node    ${(elements.om * RAD2DEG).toFixed(3)} deg`,
    `peri    ${(elements.w * RAD2DEG).toFixed(3)} deg`,
    `M0      ${(elements.ma * RAD2DEG).toFixed(3)} deg`,
    `epoch   JD ${elements.epoch.toFixed(1)}`,
  ].join('\n');
}

async function main() {
  const { neos, closeApproaches } = await loadData();
  console.log(`Loaded ${neos.length} NEOs, ${closeApproaches.length} close approaches`);

  const neoByDesignation = new Map(neos.map((n) => [n.designation, n]));
  const neoIndexByDesignation = new Map(neos.map((n, i) => [n.designation, i]));

  // ---- three.js scene setup ------------------------------------------------
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.01,
    5000
  );
  camera.position.set(0, 18, 32);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Sun: emissive, no external light needed.
  const sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 32, 32),
    new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffcc55, emissiveIntensity: 1.3 })
  );
  scene.add(sunMesh);
  scene.add(new THREE.PointLight(0xffffff, 2, 0, 0));

  // Planets: only 8, individual meshes are fine.
  const planetRadii: Record<string, number> = {
    Mercury: 0.02,
    Venus: 0.035,
    Earth: 0.037,
    Mars: 0.028,
    Jupiter: 0.09,
    Saturn: 0.08,
    Uranus: 0.055,
    Neptune: 0.053,
  };
  const planetMeshes = PLANETS.map((planet) => {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(planetRadii[planet.name] ?? 0.03, 24, 24),
      new THREE.MeshBasicMaterial({ color: planet.color })
    );
    scene.add(mesh);
    return mesh;
  });

  const planetOrbitGeometry = buildOrbitLineGeometry(
    PLANETS.map((p) => p.elements),
    PLANETS.map((p) => new THREE.Color(p.color))
  );
  const planetOrbits = new THREE.LineSegments(
    planetOrbitGeometry,
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6 })
  );
  scene.add(planetOrbits);

  // Chunked across frames: 128 Kepler solves x tens of thousands of orbits
  // would otherwise block the main thread for seconds at startup.
  const loadingEl = document.getElementById('loading') as HTMLDivElement;
  const neoOrbitGeometry = await buildOrbitLineGeometryAsync(
    neos.map((n) => n.elements),
    undefined,
    (done, total) => {
      loadingEl.textContent = `Building orbit lines... ${done.toLocaleString()} / ${total.toLocaleString()}`;
    }
  );
  loadingEl.style.display = 'none';
  const neoOrbits = new THREE.LineSegments(
    neoOrbitGeometry,
    new THREE.LineBasicMaterial({ color: 0x334455, transparent: true, opacity: 0.25 })
  );
  scene.add(neoOrbits);

  const neoField = new NeoField(neos, 0.01);
  scene.add(neoField.mesh);

  const labelsLayer = document.getElementById('labels-layer') as HTMLDivElement;
  const planetLabels = new PlanetLabels(
    labelsLayer,
    PLANETS.map((p) => p.name)
  );

  // ---- time state ------------------------------------------------------
  const todayJd = dateToJD(new Date());
  const minJd = todayJd - 2 * 365.25;
  const maxJd = todayJd + 3 * 365.25;
  let currentJd = todayJd;
  let playing = false;
  let speedDaysPerSec = 1;

  const overlay = new Overlay(minJd, maxJd, currentJd, {
    onScrub: (jd) => {
      currentJd = jd;
    },
    onPlayToggle: (isPlaying) => {
      playing = isPlaying;
    },
    onSpeedChange: (speed) => {
      speedDaysPerSec = speed;
    },
    onToggleNeoOrbits: (visible) => {
      neoOrbits.visible = visible;
    },
    onToggleLabels: (visible) => {
      planetLabels.setVisible(visible);
    },
  });

  // ---- selection (click to inspect) -------------------------------------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  canvas.addEventListener('click', (event) => {
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const hits = raycaster.intersectObjects([neoField.mesh, sunMesh, ...planetMeshes]);
    if (hits.length === 0) return;
    const hit = hits[0];

    if (hit.object === neoField.mesh && hit.instanceId !== undefined) {
      const neo = neos[hit.instanceId];
      const header = neo.name ?? neo.fullName;
      const extra = [
        neo.h !== null ? `H = ${neo.h}` : null,
        neo.diameterKm !== null ? `diameter = ${neo.diameterKm} km` : null,
        neo.pha ? 'Potentially Hazardous Asteroid' : null,
      ]
        .filter(Boolean)
        .join('\n');
      overlay.setSelection(header, [formatElements(neo.elements), extra].filter(Boolean).join('\n\n'));
      return;
    }

    if (hit.object === sunMesh) {
      overlay.setSelection('Sun', 'The Sun (origin of the heliocentric frame).');
      return;
    }

    const planetIdx = planetMeshes.findIndex((m) => m === hit.object);
    if (planetIdx !== -1) {
      const planet = PLANETS[planetIdx];
      overlay.setSelection(planet.name, formatElements(planet.elements));
    }
  });

  // ---- animation loop ----------------------------------------------------
  let lastFrameTime = performance.now();
  let fpsAccumTime = 0;
  let fpsAccumFrames = 0;
  let lastComputedJd: number | null = null;

  function tick(now: number) {
    const dtMs = now - lastFrameTime;
    lastFrameTime = now;

    if (playing) {
      currentJd += speedDaysPerSec * (dtMs / 1000);
      if (currentJd > maxJd) currentJd = maxJd;
      if (currentJd < minJd) currentJd = minJd;
      overlay.setDate(currentJd);
    }

    // Positions only depend on currentJd, which is static while paused --
    // skip the O(n) Kepler-solve pass entirely when nothing has moved so an
    // idle/paused scene still renders at native framerate while orbiting the
    // camera.
    if (currentJd !== lastComputedJd) {
      lastComputedJd = currentJd;

      for (let i = 0; i < PLANETS.length; i++) {
        const p = stateAt(PLANETS[i].elements, currentJd);
        planetMeshes[i].position.set(p.x, p.y, p.z);
      }

      neoField.update(currentJd);

      const active = findActiveApproaches(currentJd, closeApproaches, 1);
      overlay.setCloseApproaches(active, neoByDesignation);
      const activeIndices = new Set<number>();
      for (const approach of active) {
        const idx = neoIndexByDesignation.get(approach.designation);
        if (idx !== undefined) activeIndices.add(idx);
      }
      neoField.setActive(activeIndices);
    }
    sunMesh.rotation.y += 0.001;

    planetLabels.update(
      planetMeshes.map((m) => m.position),
      camera,
      window.innerWidth,
      window.innerHeight
    );

    controls.update();
    renderer.render(scene, camera);

    fpsAccumTime += dtMs;
    fpsAccumFrames += 1;
    if (fpsAccumTime >= 500) {
      overlay.setPerf((fpsAccumFrames * 1000) / fpsAccumTime, neos.length);
      fpsAccumTime = 0;
      fpsAccumFrames = 0;
    }

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);

  // Test/debug hook (harmless in production, used for perf verification).
  (window as unknown as { __orrery: unknown }).__orrery = {
    getJd: () => currentJd,
    setPlaying: (p: boolean) => {
      playing = p;
      overlay.setPlaying(p);
    },
    setSpeed: (s: number) => {
      speedDaysPerSec = s;
    },
  };
}

main().catch((err) => {
  console.error(err);
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#f66;font-family:monospace;padding:2rem;text-align:center;';
  el.textContent = String(err);
  document.body.appendChild(el);
});
