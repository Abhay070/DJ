import { describe, it, expect } from 'vitest';
import { loadProcessor, sineTrack, rampTrack, maxDiscontinuity } from './worklet-harness';

const SR = 48000;
const BLOCK = 128;

function loaded(channels: Float32Array[], sampleRate = SR) {
  const p = loadProcessor(sampleRate);
  p.send({ type: 'load', channels });
  return p;
}

describe('deck processor: transport', () => {
  it('reports the track duration after loading', () => {
    const p = loaded([sineTrack(2, 440)]);
    const msg = p.outbox.find((m) => m.type === 'loaded');
    expect(msg).toBeDefined();
    expect(msg!.duration).toBeCloseTo(2, 6);
  });

  it('stays silent and at zero until told to play', () => {
    const p = loaded([sineTrack(2, 440)]);
    const { left } = p.render(20);
    expect(Math.max(...left.map(Math.abs))).toBe(0);
    expect(p.position()).toBe(0);
  });

  it('produces audio once playing', () => {
    const p = loaded([sineTrack(2, 440)]);
    p.send({ type: 'play' });
    const { left } = p.render(40);
    // Skip the de-click fade-in before measuring.
    const body = left.slice(1000);
    expect(Math.max(...body.map(Math.abs))).toBeGreaterThan(0.3);
  });

  it('fades in rather than starting with a step', () => {
    const p = loaded([sineTrack(2, 440)]);
    p.send({ type: 'play' });
    const { left } = p.render(10);
    // A hard start on a sine at phase 0 is small, so check the envelope grows.
    expect(Math.abs(left[0])).toBeLessThan(0.01);
    expect(maxDiscontinuity(left)).toBeLessThan(0.05);
  });

  it('fades out on pause instead of cutting', () => {
    const p = loaded([sineTrack(2, 440)]);
    p.send({ type: 'play' });
    p.render(40);
    p.send({ type: 'pause' });
    const { left } = p.render(40);
    expect(maxDiscontinuity(left)).toBeLessThan(0.05);
    // Fully silent by the end of the fade.
    expect(Math.max(...left.slice(-256).map(Math.abs))).toBeLessThan(1e-6);
  });

  it('reaches the end of the track and reports it once', () => {
    const p = loaded([sineTrack(0.2, 440)]);
    p.send({ type: 'play' });
    p.render(200);
    const ended = p.outbox.filter((m) => m.type === 'ended');
    expect(ended.length).toBe(1);
    expect(p.position()).toBeLessThanOrEqual(0.2);
  });
});

describe('deck processor: timing invariant', () => {
  /**
   * The core guarantee: the playhead advances by exactly `rate` samples per
   * output sample. If this drifts, two synced decks separate over a set.
   */
  for (const rate of [1, 1.05, 0.94, 1.3333, 0.75]) {
    it(`advances at exactly ${rate}x with key lock off`, () => {
      const p = loaded([sineTrack(30, 220)]);
      p.send({ type: 'setKeyLock', enabled: false });
      p.send({ type: 'setRate', rate });
      p.send({ type: 'play' });

      // Let the rate smoother settle before measuring.
      p.render(200);
      const start = p.position();
      const blocks = 4000;
      p.render(blocks);
      const elapsedOutput = (blocks * BLOCK) / SR;
      const advanced = p.position() - start;

      expect(advanced / elapsedOutput).toBeCloseTo(rate, 5);
    });
  }

  for (const rate of [1.05, 0.94, 1.2]) {
    it(`advances at exactly ${rate}x with key lock on (WSOLA path)`, () => {
      const p = loaded([sineTrack(30, 220)]);
      p.send({ type: 'setKeyLock', enabled: true });
      p.send({ type: 'setRate', rate });
      p.send({ type: 'play' });

      p.render(400);
      const start = p.position();
      const blocks = 4000;
      p.render(blocks);
      const elapsedOutput = (blocks * BLOCK) / SR;
      const advanced = p.position() - start;

      // WSOLA jitters within a grain but must not accumulate error. One grain
      // is ~10 ms, so a 10 s measurement tolerates well under 0.5% deviation.
      expect(advanced / elapsedOutput).toBeCloseTo(rate, 2);
      expect(Math.abs(advanced / elapsedOutput - rate)).toBeLessThan(0.005);
    });
  }

  it('does not drift over a long run', () => {
    const p = loaded([sineTrack(120, 220)]);
    p.send({ type: 'setKeyLock', enabled: true });
    p.send({ type: 'setRate', rate: 1.032 });
    p.send({ type: 'play' });
    p.render(400);

    const start = p.position();
    const blocks = 30000; // 80 seconds of output
    p.render(blocks);
    const expected = start + ((blocks * BLOCK) / SR) * 1.032;
    const error = Math.abs(p.position() - expected);

    // Under 20 ms of accumulated error across 80 seconds - well inside a
    // grain, and far below anything a phase controller could not absorb.
    expect(error).toBeLessThan(0.02);
  });

  it('keeps pitch unchanged when key lock is on', () => {
    const freq = 440;
    const rate = 1.25;
    const p = loaded([sineTrack(20, freq)]);
    p.send({ type: 'setKeyLock', enabled: true });
    p.send({ type: 'setRate', rate });
    p.send({ type: 'play' });
    p.render(500);
    const { left } = p.render(400);

    expect(dominantFrequency(left, SR)).toBeCloseTo(freq, -1);
  });

  it('shifts pitch with tempo when key lock is off', () => {
    const freq = 440;
    const rate = 1.25;
    const p = loaded([sineTrack(20, freq)]);
    p.send({ type: 'setKeyLock', enabled: false });
    p.send({ type: 'setRate', rate });
    p.send({ type: 'play' });
    p.render(500);
    const { left } = p.render(400);

    expect(dominantFrequency(left, SR)).toBeCloseTo(freq * rate, -1);
  });

  it('applies a key shift in semitones', () => {
    const freq = 440;
    const p = loaded([sineTrack(20, freq)]);
    p.send({ type: 'setKeyLock', enabled: true });
    p.send({ type: 'setPitch', semitones: 12 });
    p.send({ type: 'play' });
    p.render(500);
    const { left } = p.render(400);

    expect(dominantFrequency(left, SR)).toBeCloseTo(freq * 2, -2);
  });
});

describe('deck processor: looping', () => {
  it('wraps exactly at the loop boundary', () => {
    const p = loaded([rampTrack(10)]);
    p.send({ type: 'setLoop', start: 1, end: 2, enabled: true });
    p.send({ type: 'seek', position: 1 });
    p.send({ type: 'play' });
    p.render(40); // absorb the seek fade

    // Play well past the loop end; position must stay inside the region.
    for (let i = 0; i < 60; i++) {
      p.render(20);
      const pos = p.position();
      expect(pos).toBeGreaterThanOrEqual(1 - 1e-6);
      expect(pos).toBeLessThanOrEqual(2 + 1e-6);
    }
  });

  it('loops for exactly the requested duration', () => {
    const p = loaded([rampTrack(10)]);
    p.send({ type: 'setLoop', start: 2, end: 3, enabled: true });
    p.send({ type: 'seek', position: 2 });
    p.send({ type: 'play' });
    p.render(60);

    // Count wraps over a known span of output time.
    let wraps = 0;
    let prev = p.position();
    const blocks = Math.round((5 * SR) / BLOCK); // 5 seconds
    for (let i = 0; i < blocks; i++) {
      p.render(1);
      const pos = p.position();
      if (pos < prev) wraps++;
      prev = pos;
    }
    // A 1 second loop played for 5 seconds wraps 5 times (+/- one boundary).
    expect(wraps).toBeGreaterThanOrEqual(4);
    expect(wraps).toBeLessThanOrEqual(6);
  });

  it('turns the loop off without jumping', () => {
    const p = loaded([rampTrack(10)]);
    p.send({ type: 'setLoop', start: 1, end: 2, enabled: true });
    p.send({ type: 'seek', position: 1 });
    p.send({ type: 'play' });
    p.render(200);
    const before = p.position();
    p.send({ type: 'setLoopActive', enabled: false });
    p.render(4);
    expect(p.position()).toBeGreaterThanOrEqual(before);
    expect(p.position() - before).toBeLessThan(0.05);
  });

  it('loops cleanly with key lock engaged', () => {
    const p = loaded([sineTrack(10, 220)]);
    p.send({ type: 'setKeyLock', enabled: true });
    p.send({ type: 'setLoop', start: 1, end: 1.5, enabled: true });
    p.send({ type: 'seek', position: 1 });
    p.send({ type: 'play' });
    p.render(100);
    const { left } = p.render(400);
    // Overlap-add across the wrap should not produce a step discontinuity.
    expect(maxDiscontinuity(left)).toBeLessThan(0.2);
    for (let i = 0; i < 20; i++) {
      p.render(20);
      expect(p.position()).toBeGreaterThanOrEqual(1 - 1e-6);
      expect(p.position()).toBeLessThanOrEqual(1.5 + 1e-6);
    }
  });
});

describe('deck processor: scratch and reverse', () => {
  it('moves backwards at a negative rate', () => {
    const p = loaded([rampTrack(10)]);
    p.send({ type: 'seek', position: 5 });
    p.send({ type: 'play' });
    p.render(40);
    const before = p.position();
    p.send({ type: 'scratch', rate: -1, active: true });
    p.render(200);
    expect(p.position()).toBeLessThan(before);
  });

  it('returns to the set rate when a scratch ends', () => {
    const p = loaded([rampTrack(10)]);
    p.send({ type: 'setRate', rate: 1 });
    p.send({ type: 'seek', position: 5 });
    p.send({ type: 'play' });
    p.render(40);
    p.send({ type: 'scratch', rate: -2, active: true });
    p.render(50);
    p.send({ type: 'scratch', rate: 0, active: false });
    p.send({ type: 'setRate', rate: 1 });
    p.render(200);
    const a = p.position();
    p.render(200);
    const b = p.position();
    expect(b).toBeGreaterThan(a);
    expect((b - a) / ((200 * BLOCK) / SR)).toBeCloseTo(1, 1);
  });

  it('holds position when the rate is zero', () => {
    const p = loaded([rampTrack(10)]);
    p.send({ type: 'seek', position: 4 });
    p.send({ type: 'play' });
    p.render(40);
    p.send({ type: 'scratch', rate: 0, active: true });
    const before = p.position();
    p.render(200);
    expect(p.position()).toBeCloseTo(before, 6);
  });
});

describe('deck processor: seeking and slip', () => {
  it('lands exactly on the requested position', () => {
    const p = loaded([rampTrack(10)]);
    p.send({ type: 'seek', position: 3.75 });
    p.render(60);
    expect(p.position()).toBeCloseTo(3.75, 4);
  });

  it('seeks without a click', () => {
    const p = loaded([sineTrack(10, 440)]);
    p.send({ type: 'play' });
    p.render(100);
    p.send({ type: 'seek', position: 5 });
    const { left } = p.render(100);
    expect(maxDiscontinuity(left)).toBeLessThan(0.05);
  });

  it('returns to the shadow playhead when slip is released', () => {
    const p = loaded([rampTrack(20)]);
    p.send({ type: 'seek', position: 2 });
    p.send({ type: 'play' });
    p.render(60);

    p.send({ type: 'setSlip', enabled: true });
    p.send({ type: 'setLoop', start: 2, end: 2.25, enabled: true });
    const blocks = 1200; // ~3.2 s of looping
    p.render(blocks);
    const loopedPos = p.position();
    expect(loopedPos).toBeLessThanOrEqual(2.25 + 1e-6);

    p.send({ type: 'setLoopActive', enabled: false });
    p.send({ type: 'setSlip', enabled: false });
    p.render(60);

    // The timeline kept running underneath, so we land far past the loop.
    expect(p.position()).toBeGreaterThan(loopedPos + 2);
  });
});

describe('deck processor: robustness', () => {
  it('renders silence with no track loaded', () => {
    const p = loadProcessor();
    p.send({ type: 'play' });
    const { left } = p.render(20);
    expect(Math.max(...left.map(Math.abs))).toBe(0);
  });

  it('survives being unloaded mid-playback', () => {
    const p = loaded([sineTrack(5, 440)]);
    p.send({ type: 'play' });
    p.render(50);
    p.send({ type: 'unload' });
    const { left } = p.render(50);
    expect(Math.max(...left.map(Math.abs))).toBe(0);
  });

  it('upmixes a mono source to both channels', () => {
    const p = loaded([sineTrack(2, 440)]);
    p.send({ type: 'play' });
    const { left, right } = p.render(60);
    expect(Array.from(right.slice(2000, 2100))).toEqual(Array.from(left.slice(2000, 2100)));
  });

  it('keeps stereo channels independent', () => {
    const l = sineTrack(2, 440);
    const r = sineTrack(2, 880);
    const p = loaded([l, r]);
    p.send({ type: 'play' });
    const out = p.render(200);
    expect(dominantFrequency(out.left.slice(4000), SR)).toBeCloseTo(440, -1);
    expect(dominantFrequency(out.right.slice(4000), SR)).toBeCloseTo(880, -1);
  });

  it('never emits a non-finite sample', () => {
    const p = loaded([sineTrack(5, 440)]);
    p.send({ type: 'setKeyLock', enabled: true });
    p.send({ type: 'setRate', rate: 1.17 });
    p.send({ type: 'setLoop', start: 0.5, end: 0.9, enabled: true });
    p.send({ type: 'play' });
    const { left, right } = p.render(600);
    for (let i = 0; i < left.length; i++) {
      expect(Number.isFinite(left[i])).toBe(true);
      expect(Number.isFinite(right[i])).toBe(true);
      expect(Math.abs(left[i])).toBeLessThan(4);
    }
  });
});

/** Peak-picked dominant frequency via a coarse Goertzel sweep. */
function dominantFrequency(x: Float32Array, sampleRate: number): number {
  let bestFreq = 0;
  let bestPower = -Infinity;
  for (let f = 60; f <= 2000; f += 1) {
    const power = goertzel(x, sampleRate, f);
    if (power > bestPower) { bestPower = power; bestFreq = f; }
  }
  return bestFreq;
}

function goertzel(x: Float32Array, sampleRate: number, freq: number): number {
  const n = Math.min(x.length, 8192);
  const k = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(k);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    s0 = x[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}
