/**
 * Waveform rendering.
 *
 * Two canvases per deck: a scrolling detail view centred on the playhead, and
 * a full-track overview. Both are redrawn each frame from the position the
 * audio engine publishes - there are no CSS transitions or timer-driven
 * animations anywhere in here, so what you see is where the audio actually is.
 *
 * Bands are coloured by frequency content: bass red, mids green, highs blue,
 * which is what makes a breakdown or a drop readable at a glance.
 */
import type { Deck } from '../audio/deck';
import type { HotCue, WaveformData } from '../lib/types';
import { beatsBetween, isDownbeat, isPhraseStart } from '../lib/grid';

export interface WaveformStyle {
  bands: boolean;
  phraseBeats: number;
}

const COLOR_LOW = [255, 78, 94] as const;
const COLOR_MID = [104, 214, 122] as const;
const COLOR_HIGH = [90, 170, 255] as const;

export class ScrollingWaveform {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private width = 0;
  private height = 0;

  /** Seconds of audio visible across the full canvas width. */
  secondsVisible = 8;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('This browser could not create a 2D canvas context');
    this.ctx = ctx;
    this.resize();
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  draw(
    deck: Deck,
    position: number,
    cues: HotCue[],
    loop: { start: number; end: number; enabled: boolean },
    style: WaveformStyle,
  ) {
    const { ctx, width: w, height: h } = this;
    const mid = h / 2;

    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, w, h);

    const wave = deck.analysis?.waveform;
    if (!wave || !deck.hasTrack) {
      this.drawEmpty();
      return;
    }

    const half = this.secondsVisible / 2;
    const from = position - half;
    const to = position + half;
    const pxPerSecond = w / this.secondsVisible;
    const sampleRate = deck.analysis!.sampleRate;
    const secondsPerBin = wave.binSize / sampleRate;

    // ---- loop region -------------------------------------------------------
    if (loop.end > loop.start) {
      const x0 = (loop.start - from) * pxPerSecond;
      const x1 = (loop.end - from) * pxPerSecond;
      ctx.fillStyle = loop.enabled ? 'rgba(255, 196, 0, 0.16)' : 'rgba(255, 196, 0, 0.06)';
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
      ctx.strokeStyle = loop.enabled ? 'rgba(255, 196, 0, 0.75)' : 'rgba(255, 196, 0, 0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0 + 0.5, 0); ctx.lineTo(x0 + 0.5, h);
      ctx.moveTo(x1 - 0.5, 0); ctx.lineTo(x1 - 0.5, h);
      ctx.stroke();
    }

    // ---- beat grid ---------------------------------------------------------
    if (deck.grid.bpm > 0) {
      const beats = beatsBetween(deck.grid, from, to);
      for (const beat of beats) {
        const x = Math.round((beat.time - from) * pxPerSecond) + 0.5;
        const phrase = isPhraseStart(deck.grid, beat.index, style.phraseBeats);
        const down = isDownbeat(deck.grid, beat.index);
        if (phrase) { ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 2; }
        else if (down) { ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1.5; }
        else { ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1; }
        ctx.beginPath();
        ctx.moveTo(x, down || phrase ? 0 : h * 0.34);
        ctx.lineTo(x, down || phrase ? h : h * 0.66);
        ctx.stroke();
      }
      // Beat numbers, only when there is room for them.
      if (pxPerSecond * (60 / deck.grid.bpm) > 26) {
        ctx.font = '9px ui-monospace, monospace';
        ctx.textBaseline = 'top';
        for (const beat of beats) {
          const x = (beat.time - from) * pxPerSecond;
          const inBar = (((beat.index - deck.grid.downbeatOffset) % 4) + 4) % 4;
          ctx.fillStyle = inBar === 0 ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.3)';
          ctx.fillText(String(inBar + 1), x + 3, 3);
        }
      }
    }

    // ---- waveform ----------------------------------------------------------
    const startBin = Math.floor(from / secondsPerBin);
    const endBin = Math.ceil(to / secondsPerBin);
    const binsPerPixel = (endBin - startBin) / w;

    ctx.lineWidth = 1;
    for (let px = 0; px < w; px++) {
      const b0 = Math.floor(startBin + px * binsPerPixel);
      const b1 = Math.max(b0 + 1, Math.floor(startBin + (px + 1) * binsPerPixel));
      if (b1 < 0 || b0 >= wave.peak.length) continue;

      let peak = 0;
      let low = 0;
      let midB = 0;
      let high = 0;
      let n = 0;
      for (let b = Math.max(0, b0); b < Math.min(wave.peak.length, b1); b++) {
        peak = Math.max(peak, wave.peak[b]);
        low += wave.low[b]; midB += wave.mid[b]; high += wave.high[b];
        n++;
      }
      if (!n) continue;
      low /= n; midB /= n; high /= n;

      const amp = peak * (h / 2) * 0.94;
      ctx.strokeStyle = style.bands ? bandColor(low, midB, high) : '#7fd3ff';
      ctx.beginPath();
      ctx.moveTo(px + 0.5, mid - amp);
      ctx.lineTo(px + 0.5, mid + amp);
      ctx.stroke();
    }

    // ---- hot cues ----------------------------------------------------------
    ctx.textBaseline = 'top';
    ctx.font = 'bold 9px ui-monospace, monospace';
    for (const cue of cues) {
      if (cue.position < from || cue.position > to) continue;
      const x = Math.round((cue.position - from) * pxPerSecond) + 0.5;
      ctx.strokeStyle = cue.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0); ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = cue.color;
      ctx.fillRect(x, 0, 14, 12);
      ctx.fillStyle = '#05070b';
      ctx.fillText(String(cue.index + 1), x + 4, 2);
    }

    // ---- playhead ----------------------------------------------------------
    const cx = Math.round(w / 2) + 0.5;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, 0); ctx.lineTo(cx, h);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(cx - 5, 0); ctx.lineTo(cx + 5, 0); ctx.lineTo(cx, 7);
    ctx.closePath();
    ctx.fill();
  }

  private drawEmpty() {
    const { ctx, width: w, height: h } = this;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2 + 0.5); ctx.lineTo(w, h / 2 + 0.5);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Drop a track here, or load one from the library', w / 2, h / 2);
    ctx.textAlign = 'left';
  }

  /** Track time at a canvas x coordinate, for click-to-seek. */
  timeAt(clientX: number, position: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const t = (clientX - rect.left) / rect.width;
    return position + (t - 0.5) * this.secondsVisible;
  }
}

export class OverviewWaveform {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cache: HTMLCanvasElement | null = null;
  private cacheKey = '';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('This browser could not create a 2D canvas context');
    this.ctx = ctx;
    this.resize();
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cacheKey = ''; // force a re-render of the cached body
  }

  draw(deck: Deck, position: number, cues: HotCue[], style: WaveformStyle) {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const ctx = this.ctx;

    if (!deck.hasTrack || !deck.analysis) {
      ctx.fillStyle = '#0b0d12';
      ctx.fillRect(0, 0, w, h);
      return;
    }

    // The body of the overview never changes, so render it once per track and
    // blit it each frame - only the playhead actually moves.
    const key = `${deck.trackId}:${w}x${h}:${style.bands}`;
    if (key !== this.cacheKey) {
      this.cache = renderOverview(deck.analysis.overview, w, h, style.bands);
      this.cacheKey = key;
    }
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, w, h);
    if (this.cache) ctx.drawImage(this.cache, 0, 0, w, h);

    const duration = deck.duration || deck.analysis.duration;

    // Section bands along the bottom, dimmed by confidence.
    for (const section of deck.analysis.sections) {
      const x0 = (section.start / duration) * w;
      const x1 = (section.end / duration) * w;
      ctx.fillStyle = sectionColor(section.label, section.confidence);
      ctx.fillRect(x0, h - 4, Math.max(1, x1 - x0), 4);
    }

    for (const cue of cues) {
      const x = Math.round((cue.position / duration) * w) + 0.5;
      ctx.strokeStyle = cue.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 0); ctx.lineTo(x, h - 4);
      ctx.stroke();
    }

    const px = Math.round((position / duration) * w) + 0.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, px, h - 4);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0); ctx.lineTo(px, h);
    ctx.stroke();
  }

  timeAt(clientX: number, duration: number): number {
    const rect = this.canvas.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * duration;
  }
}

function renderOverview(wave: WaveformData, w: number, h: number, bands: boolean): HTMLCanvasElement {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0b0d12';
  ctx.fillRect(0, 0, w, h);

  const n = wave.peak.length;
  const mid = (h - 4) / 2;
  const perPixel = n / w;
  for (let px = 0; px < w; px++) {
    const b0 = Math.floor(px * perPixel);
    const b1 = Math.max(b0 + 1, Math.floor((px + 1) * perPixel));
    let peak = 0;
    let low = 0, midB = 0, high = 0, count = 0;
    for (let b = b0; b < Math.min(n, b1); b++) {
      peak = Math.max(peak, wave.peak[b]);
      low += wave.low[b]; midB += wave.mid[b]; high += wave.high[b];
      count++;
    }
    if (!count) continue;
    const amp = peak * mid * 0.95;
    ctx.strokeStyle = bands ? bandColor(low / count, midB / count, high / count) : '#5f9fd0';
    ctx.beginPath();
    ctx.moveTo(px + 0.5, mid - amp);
    ctx.lineTo(px + 0.5, mid + amp);
    ctx.stroke();
  }
  return c;
}

function bandColor(low: number, mid: number, high: number): string {
  const total = low + mid + high || 1;
  const l = low / total;
  const m = mid / total;
  const hi = high / total;
  const r = Math.round(COLOR_LOW[0] * l + COLOR_MID[0] * m + COLOR_HIGH[0] * hi);
  const g = Math.round(COLOR_LOW[1] * l + COLOR_MID[1] * m + COLOR_HIGH[1] * hi);
  const b = Math.round(COLOR_LOW[2] * l + COLOR_MID[2] * m + COLOR_HIGH[2] * hi);
  // Lift the floor so quiet passages stay visible rather than going black.
  return `rgb(${Math.min(255, r + 40)}, ${Math.min(255, g + 40)}, ${Math.min(255, b + 50)})`;
}

function sectionColor(label: string, confidence: number): string {
  const alpha = 0.25 + confidence * 0.6;
  switch (label) {
    case 'intro': return `rgba(90,170,255,${alpha})`;
    case 'build': return `rgba(255,190,60,${alpha})`;
    case 'drop': return `rgba(255,78,94,${alpha})`;
    case 'breakdown': return `rgba(150,120,255,${alpha})`;
    case 'chorus': return `rgba(104,214,122,${alpha})`;
    case 'outro': return `rgba(120,140,170,${alpha})`;
    default: return `rgba(180,190,210,${alpha * 0.7})`;
  }
}
