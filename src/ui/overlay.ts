// Plain DOM overlay controls -- no UI framework. Wires up the elements
// already present in index.html and exposes a small typed API to main.ts.
import { jdToDate } from '../orbit.js';
import type { CloseApproach, NeoRecord } from '../types.js';

export interface OverlayCallbacks {
  onScrub: (jd: number) => void;
  onPlayToggle: (playing: boolean) => void;
  onSpeedChange: (daysPerSec: number) => void;
  onToggleNeoOrbits: (visible: boolean) => void;
  onToggleLabels: (visible: boolean) => void;
}

const MIN_SPEED = 1; // days/sec
const MAX_SPEED = 365.25; // days/sec (1 year/sec)

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

function speedFromSlider(sliderValue: number): number {
  // Exponential mapping: slider 0..100 -> [MIN_SPEED, MAX_SPEED] days/sec.
  return MIN_SPEED * (MAX_SPEED / MIN_SPEED) ** (sliderValue / 100);
}

function formatSpeed(daysPerSec: number): string {
  if (daysPerSec >= 300) return `${(daysPerSec / 365.25).toFixed(2)} yr/s`;
  if (daysPerSec >= 10) return `${daysPerSec.toFixed(0)} day/s`;
  return `${daysPerSec.toFixed(2)} day/s`;
}

function formatDate(jd: number): string {
  const d = jdToDate(jd);
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export class Overlay {
  private readonly scrubber = byId<HTMLInputElement>('scrubber');
  private readonly dateReadout = byId<HTMLDivElement>('date-readout');
  private readonly playPauseBtn = byId<HTMLButtonElement>('play-pause');
  private readonly speedSlider = byId<HTMLInputElement>('speed');
  private readonly speedReadout = byId<HTMLSpanElement>('speed-readout');
  private readonly toggleNeoOrbits = byId<HTMLInputElement>('toggle-neo-orbits');
  private readonly toggleLabels = byId<HTMLInputElement>('toggle-labels');
  private readonly approachList = byId<HTMLDivElement>('approach-list');
  private readonly infoPanel = byId<HTMLDivElement>('info-panel');
  private readonly infoTitle = byId<HTMLHeadingElement>('info-title');
  private readonly infoBody = byId<HTMLPreElement>('info-body');
  private readonly infoClose = byId<HTMLButtonElement>('info-close');
  private readonly perfReadout = byId<HTMLDivElement>('perf-readout');

  private playing = false;

  constructor(minJd: number, maxJd: number, initialJd: number, callbacks: OverlayCallbacks) {
    this.scrubber.min = String(minJd);
    this.scrubber.max = String(maxJd);
    this.scrubber.value = String(initialJd);
    this.setDate(initialJd);

    this.scrubber.addEventListener('input', () => {
      const jd = Number(this.scrubber.value);
      this.dateReadout.textContent = formatDate(jd);
      callbacks.onScrub(jd);
    });

    this.playPauseBtn.addEventListener('click', () => {
      this.setPlaying(!this.playing);
      callbacks.onPlayToggle(this.playing);
    });

    this.speedSlider.addEventListener('input', () => {
      const speed = speedFromSlider(Number(this.speedSlider.value));
      this.speedReadout.textContent = formatSpeed(speed);
      callbacks.onSpeedChange(speed);
    });
    this.speedReadout.textContent = formatSpeed(speedFromSlider(Number(this.speedSlider.value)));

    this.toggleNeoOrbits.addEventListener('change', () => {
      callbacks.onToggleNeoOrbits(this.toggleNeoOrbits.checked);
    });
    this.toggleLabels.addEventListener('change', () => {
      callbacks.onToggleLabels(this.toggleLabels.checked);
    });

    this.infoClose.addEventListener('click', () => this.clearSelection());
  }

  setDate(jd: number): void {
    this.scrubber.value = String(jd);
    this.dateReadout.textContent = formatDate(jd);
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    this.playPauseBtn.textContent = playing ? 'Pause' : 'Play';
  }

  setCloseApproaches(items: CloseApproach[], neoByDesignation: Map<string, NeoRecord>): void {
    if (items.length === 0) {
      this.approachList.textContent = 'none';
      return;
    }
    this.approachList.innerHTML = '';
    for (const item of items) {
      const neo = neoByDesignation.get(item.designation);
      const label = neo?.name ?? neo?.fullName ?? item.designation;
      const div = document.createElement('div');
      div.className = 'approach-item';
      div.innerHTML = `<span class="name">${label}</span><br>` +
        `${item.distLd.toFixed(2)} LD &middot; ${item.vRelKmS.toFixed(2)} km/s &middot; ${item.calendarDate}`;
      this.approachList.appendChild(div);
    }
  }

  setSelection(title: string, body: string): void {
    this.infoTitle.textContent = title;
    this.infoBody.textContent = body;
    this.infoPanel.hidden = false;
  }

  clearSelection(): void {
    this.infoPanel.hidden = true;
  }

  setPerf(fps: number, objectCount: number): void {
    this.perfReadout.textContent = `${fps.toFixed(0)} fps · ${objectCount.toLocaleString()} NEOs`;
  }
}
