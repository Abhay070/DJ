/**
 * Virtual jog wheel.
 *
 * Vinyl mode: touching the platter takes over playback rate entirely, so
 * dragging genuinely scrubs the audio backwards and forwards - the worklet's
 * direct-resampling path handles negative rates, which is what makes it sound
 * like a record rather than a seek.
 *
 * CDJ mode: the platter bends pitch without ever stopping playback.
 *
 * The rotation you see is driven by the engine's playhead, so the platter
 * cannot drift out of step with the audio.
 */
import type { Deck } from '../audio/deck';

export type JogMode = 'vinyl' | 'cdj';

export interface JogCallbacks {
  onScratch: (rate: number, active: boolean) => void;
  onBend: (amount: number) => void;
  onBendEnd: () => void;
  onSeek: (delta: number) => void;
}

/** Revolutions per second of a 33 1/3 RPM record. */
const RPS = 33.333 / 60;

export class JogWheel {
  readonly root: HTMLElement;
  private platter: HTMLElement;
  private marker: HTMLElement;
  private deck: Deck;
  private cb: JogCallbacks;

  mode: JogMode = 'vinyl';
  private dragging = false;
  private lastAngle = 0;
  private lastTime = 0;
  private velocity = 0;
  /** Exponential average of pointer velocity - raw deltas are far too jumpy. */
  private smoothed = 0;

  constructor(deck: Deck, cb: JogCallbacks) {
    this.deck = deck;
    this.cb = cb;

    this.marker = document.createElement('div');
    this.marker.className = 'jog-marker';
    this.platter = document.createElement('div');
    this.platter.className = 'jog-platter';
    this.platter.append(this.marker);

    const ring = document.createElement('div');
    ring.className = 'jog-ring';
    ring.append(this.platter);

    this.root = document.createElement('div');
    this.root.className = 'jog';
    this.root.append(ring);

    this.attach();
  }

  private angleFor(e: PointerEvent): number {
    const rect = this.platter.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return Math.atan2(e.clientY - cy, e.clientX - cx);
  }

  private attach() {
    const move = (e: PointerEvent) => {
      if (!this.dragging) return;
      const now = performance.now();
      const angle = this.angleFor(e);
      let delta = angle - this.lastAngle;
      // Unwrap across the +/-pi discontinuity.
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      const dt = Math.max(0.001, (now - this.lastTime) / 1000);
      this.lastAngle = angle;
      this.lastTime = now;

      // Turns per second, expressed as a playback rate against 33 1/3 RPM.
      const turns = delta / (2 * Math.PI);
      this.velocity = turns / dt / RPS;
      this.smoothed = this.smoothed * 0.6 + this.velocity * 0.4;

      if (this.mode === 'vinyl') {
        this.cb.onScratch(this.smoothed, true);
      } else {
        // CDJ: platter motion is a bend around the current rate, clamped so a
        // fast flick cannot launch the deck.
        this.cb.onBend(Math.max(-0.35, Math.min(0.35, this.smoothed * 0.12)));
      }
    };

    const up = () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.root.classList.remove('touched');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (this.mode === 'vinyl') this.cb.onScratch(0, false);
      else this.cb.onBendEnd();
      this.smoothed = 0;
    };

    this.platter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.dragging = true;
      this.root.classList.add('touched');
      this.lastAngle = this.angleFor(e);
      this.lastTime = performance.now();
      this.smoothed = 0;
      if (this.mode === 'vinyl') this.cb.onScratch(0, true);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    // The outer ring is a search/nudge control on real hardware too.
    this.root.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cb.onSeek(-Math.sign(e.deltaY) * (e.shiftKey ? 0.05 : 0.5));
    }, { passive: false });
  }

  /** Rotate the platter to match the engine's playhead. */
  render(position: number) {
    const angle = position * RPS * 360;
    this.platter.style.transform = `rotate(${angle}deg)`;
    this.root.classList.toggle('spinning', this.deck.playing);
  }

  setMode(mode: JogMode) {
    this.mode = mode;
    this.root.classList.toggle('cdj', mode === 'cdj');
  }
}
