/**
 * Runs the real deck-processor.js - the same file the browser loads - inside a
 * stubbed AudioWorkletGlobalScope, so the engine's timing guarantees are tested
 * against the shipping code rather than a reimplementation.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const WORKLET_PATH = join(here, '..', 'public', 'worklets', 'deck-processor.js');

export interface ProcessorHandle {
  /** Send a message exactly as the main thread would. */
  send(msg: Record<string, unknown>): void;
  /** Render `blocks` render quanta and return the stereo output. */
  render(blocks: number): { left: Float32Array; right: Float32Array };
  /** Current source playhead, in seconds. */
  position(): number;
  /** Messages the processor posted back. */
  outbox: Record<string, unknown>[];
  raw: Record<string, never> & { [k: string]: unknown };
}

const BLOCK = 128;

export function loadProcessor(sampleRate = 48000): ProcessorHandle {
  const source = readFileSync(WORKLET_PATH, 'utf8');
  const outbox: Record<string, unknown>[] = [];
  let currentTime = 0;

  // Minimal stand-ins for the globals an AudioWorkletProcessor is given.
  class AudioWorkletProcessorStub {
    port = {
      onmessage: null as ((e: { data: unknown }) => void) | null,
      postMessage: (msg: Record<string, unknown>) => { outbox.push(msg); },
    };
  }

  let ProcessorClass: (new () => Record<string, unknown>) | null = null;
  const registerProcessor = (_name: string, cls: new () => Record<string, unknown>) => {
    ProcessorClass = cls;
  };

  // The worklet reads `sampleRate` and `currentTime` as bare globals.
  const factory = new Function(
    'AudioWorkletProcessor', 'registerProcessor', 'sampleRate', 'getCurrentTime',
    `${source.replace(/\bcurrentTime\b/g, 'getCurrentTime()')}`,
  );
  factory(AudioWorkletProcessorStub, registerProcessor, sampleRate, () => currentTime);

  if (!ProcessorClass) throw new Error('deck-processor.js did not register a processor');
  const proc = new (ProcessorClass as new () => Record<string, unknown>)() as Record<string, unknown> & {
    port: { onmessage: ((e: { data: unknown }) => void) | null };
    process: (inputs: unknown, outputs: Float32Array[][]) => boolean;
    sourcePos: number;
  };

  return {
    outbox,
    raw: proc as never,
    send(msg) { proc.port.onmessage?.({ data: msg }); },
    position() { return proc.sourcePos / sampleRate; },
    render(blocks) {
      const left = new Float32Array(blocks * BLOCK);
      const right = new Float32Array(blocks * BLOCK);
      const outL = new Float32Array(BLOCK);
      const outR = new Float32Array(BLOCK);
      for (let b = 0; b < blocks; b++) {
        outL.fill(0);
        outR.fill(0);
        proc.process([], [[outL, outR]]);
        left.set(outL, b * BLOCK);
        right.set(outR, b * BLOCK);
        currentTime += BLOCK / sampleRate;
      }
      return { left, right };
    },
  };
}

/** A sine tone, useful because its continuity is easy to assert on. */
export function sineTrack(seconds: number, freq: number, sampleRate = 48000): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.5;
  return out;
}

/** A click train - one impulse every `period` seconds - for timing assertions. */
export function clickTrack(seconds: number, period: number, sampleRate = 48000): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let t = 0; t < seconds; t += period) {
    const i = Math.round(t * sampleRate);
    if (i < n) out[i] = 1;
  }
  return out;
}

/** A ramp from 0 to 1 across the whole buffer: position is readable from value. */
export function rampTrack(seconds: number, sampleRate = 48000): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = i / n;
  return out;
}

/** Largest absolute sample-to-sample jump, a proxy for audible clicks. */
export function maxDiscontinuity(x: Float32Array, from = 0): number {
  let worst = 0;
  for (let i = Math.max(1, from); i < x.length; i++) {
    worst = Math.max(worst, Math.abs(x[i] - x[i - 1]));
  }
  return worst;
}
