/**
 * Sampler pads. Each pad holds a decoded buffer and plays it through its own
 * gain + rate control. Triggers can be quantised to the master grid, in which
 * case the sample is scheduled on the audio clock rather than fired immediately.
 */

export interface SamplerPad {
  index: number;
  name: string;
  buffer: AudioBuffer | null;
  volume: number;
  pitch: number;
  loop: boolean;
  quantise: boolean;
  color: string;
}

export const PAD_COLORS = [
  '#ff4d5e', '#ff9f43', '#ffd93d', '#6bcB77',
  '#4d9de0', '#8b6bff', '#ff6bd6', '#2ec4b6',
];

export class Sampler {
  readonly output: GainNode;
  readonly pads: SamplerPad[] = [];
  private voices = new Map<number, AudioBufferSourceNode[]>();
  private ctx: BaseAudioContext;

  constructor(ctx: BaseAudioContext, padCount = 8) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    for (let i = 0; i < padCount; i++) {
      this.pads.push({
        index: i,
        name: `Pad ${i + 1}`,
        buffer: null,
        volume: 0.8,
        pitch: 0,
        loop: false,
        quantise: true,
        color: PAD_COLORS[i % PAD_COLORS.length],
      });
    }
  }

  loadPad(index: number, name: string, buffer: AudioBuffer) {
    const pad = this.pads[index];
    if (!pad) return;
    pad.buffer = buffer;
    pad.name = name;
  }

  clearPad(index: number) {
    this.stop(index);
    const pad = this.pads[index];
    if (pad) { pad.buffer = null; pad.name = `Pad ${index + 1}`; }
  }

  /**
   * Trigger a pad. `when` is an AudioContext timestamp; pass the quantised
   * time from the master clock to lock the hit to the grid.
   */
  trigger(index: number, when?: number) {
    const pad = this.pads[index];
    if (!pad?.buffer) return;
    if (!pad.loop) this.stop(index);

    const src = this.ctx.createBufferSource();
    src.buffer = pad.buffer;
    src.loop = pad.loop;
    src.playbackRate.value = Math.pow(2, pad.pitch / 12);

    const gain = this.ctx.createGain();
    gain.gain.value = pad.volume;
    src.connect(gain).connect(this.output);

    const start = when !== undefined ? Math.max(when, this.ctx.currentTime) : this.ctx.currentTime;
    src.start(start);

    const list = this.voices.get(index) ?? [];
    list.push(src);
    this.voices.set(index, list);
    src.onended = () => {
      const current = this.voices.get(index);
      if (current) this.voices.set(index, current.filter((v) => v !== src));
    };
  }

  stop(index: number) {
    const list = this.voices.get(index);
    if (!list) return;
    for (const v of list) { try { v.stop(); } catch { /* already stopped */ } }
    this.voices.set(index, []);
  }

  stopAll() { for (const i of this.voices.keys()) this.stop(i); }
}
