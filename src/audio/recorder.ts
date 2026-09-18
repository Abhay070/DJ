/**
 * Master recorder. Captures the exact float samples leaving the master bus and
 * encodes them locally - nothing is uploaded, and the WAV path is lossless.
 */

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  extension: string;
  duration: number;
  sampleRate: number;
}

export class Recorder {
  private chunksL: Float32Array[] = [];
  private chunksR: Float32Array[] = [];
  private frames = 0;
  private node: AudioWorkletNode;
  private readonly sampleRate: number;

  recording = false;
  paused = false;
  startedAt = 0;

  constructor(node: AudioWorkletNode, sampleRate: number) {
    this.node = node;
    this.sampleRate = sampleRate;
    this.node.port.onmessage = (e) => {
      if (e.data.type !== 'chunk' || !this.recording || this.paused) return;
      this.chunksL.push(e.data.left);
      this.chunksR.push(e.data.right);
      this.frames += e.data.left.length;
    };
  }

  start() {
    this.chunksL = [];
    this.chunksR = [];
    this.frames = 0;
    this.recording = true;
    this.paused = false;
    this.startedAt = Date.now();
    this.node.port.postMessage({ type: 'start' });
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  stop(): RecordingResult | null {
    if (!this.recording) return null;
    this.recording = false;
    this.paused = false;
    this.node.port.postMessage({ type: 'stop' });
    if (!this.frames) return null;

    const left = concat(this.chunksL, this.frames);
    const right = concat(this.chunksR, this.frames);
    this.chunksL = [];
    this.chunksR = [];

    const blob = encodeWav(left, right, this.sampleRate);
    return {
      blob,
      mimeType: 'audio/wav',
      extension: 'wav',
      duration: this.frames / this.sampleRate,
      sampleRate: this.sampleRate,
    };
  }

  /** Seconds captured so far. */
  get duration(): number { return this.frames / this.sampleRate; }
  /** Approximate size of the WAV that would be written right now. */
  get byteLength(): number { return 44 + this.frames * 4; }
}

function concat(chunks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

/** 16-bit PCM stereo WAV. */
export function encodeWav(left: Float32Array, right: Float32Array, sampleRate: number): Blob {
  const frames = left.length;
  const bytes = frames * 4;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 2, true);          // stereo
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, bytes, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    // Clamp before quantising so a hot master wraps to full scale, not silence.
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    view.setInt16(offset + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true);
    offset += 4;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
