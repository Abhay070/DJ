import { describe, it, expect } from 'vitest';
import {
  onsetEnvelope, estimateTempo, estimateGrid, estimateKey,
  integratedLoudness, energyCurve, detectSections, buildWaveform,
  gridContrast, contrastToConfidence,
} from '../src/analysis/detect';
import { fft, toMono, decimate, smooth, nextPow2 } from '../src/lib/dsp';

const SR = 44100;

/**
 * A synthetic four-on-the-floor loop: kick on every beat, hat on the offbeats,
 * with a defined tempo we can check the estimator against.
 */
function drumTrack(bpm: number, seconds: number, sampleRate = SR, startOffset = 0): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const beat = 60 / bpm;

  const addKick = (at: number) => {
    const start = Math.round(at * sampleRate);
    const len = Math.round(0.11 * sampleRate);
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / sampleRate;
      const env = Math.exp(-t * 34);
      // Pitch-dropping sine: the characteristic shape of a kick transient.
      out[start + i] += Math.sin(2 * Math.PI * (150 * Math.exp(-t * 26) + 42) * t) * env * 0.9;
    }
  };

  const addHat = (at: number) => {
    const start = Math.round(at * sampleRate);
    const len = Math.round(0.035 * sampleRate);
    for (let i = 0; i < len && start + i < n; i++) {
      out[start + i] += (Math.random() * 2 - 1) * Math.exp(-(i / sampleRate) * 150) * 0.22;
    }
  };

  for (let t = startOffset; t < seconds; t += beat) {
    addKick(t);
    if (t + beat / 2 < seconds) addHat(t + beat / 2);
  }
  return out;
}

/** A chord held for the whole buffer, for key detection. */
function chordTrack(midiNotes: number[], seconds: number, sampleRate = SR): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (const midi of midiNotes) {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    for (let i = 0; i < n; i++) {
      // Two partials so the chroma has some harmonic weight.
      out[i] += (Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.28
        + Math.sin((2 * Math.PI * freq * 2 * i) / sampleRate) * 0.1) / midiNotes.length;
    }
  }
  return out;
}

describe('DSP primitives', () => {
  it('computes an FFT whose peak sits at the input frequency', () => {
    const n = 2048;
    const freq = 1000;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * freq * i) / SR);
    fft(re, im);

    let bestBin = 0;
    let best = -Infinity;
    for (let k = 1; k < n / 2; k++) {
      const mag = re[k] * re[k] + im[k] * im[k];
      if (mag > best) { best = mag; bestBin = k; }
    }
    expect((bestBin * SR) / n).toBeCloseTo(freq, -2);
  });

  it('rejects a non power-of-two length rather than returning nonsense', () => {
    expect(() => fft(new Float32Array(1000), new Float32Array(1000))).toThrow(/power of two/);
  });

  it('rounds up to the next power of two', () => {
    expect(nextPow2(1)).toBe(1);
    expect(nextPow2(1000)).toBe(1024);
    expect(nextPow2(1024)).toBe(1024);
  });

  it('averages channels when mixing to mono', () => {
    const l = Float32Array.from([1, 1, 1]);
    const r = Float32Array.from([-1, 0, 1]);
    expect(Array.from(toMono([l, r]))).toEqual([0, 0.5, 1]);
  });

  it('returns the input untouched when there is one channel', () => {
    const x = Float32Array.from([0.5, 0.25]);
    expect(toMono([x])).toBe(x);
  });

  it('decimates by an integer factor', () => {
    const x = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(Array.from(decimate(x, 2))).toEqual([0.5, 2.5, 4.5, 6.5]);
    expect(decimate(x, 1)).toBe(x);
  });

  it('smooths without shifting the signal', () => {
    const x = new Float32Array(100).fill(1);
    const s = smooth(x, 3);
    for (let i = 0; i < 100; i++) expect(s[i]).toBeCloseTo(1, 5);
  });
});

describe('tempo detection', () => {
  for (const bpm of [100, 120, 124, 128, 140, 150, 174]) {
    it(`detects ${bpm} BPM from a four-on-the-floor pattern`, () => {
      const est = estimateTempo(onsetEnvelope(drumTrack(bpm, 24), SR), 24);
      expect(est.bpm).toBeCloseTo(bpm, 0);
    });
  }

  it('does not drag fast music down to a comfortable tempo', () => {
    // Drum and bass at 174 used to come back as 116 - a 3:2 error, not an
    // octave, created by the autocorrelation borrowing support from its own
    // harmonics and a tempo prior that was too eager.
    const est = estimateTempo(onsetEnvelope(drumTrack(174, 24), SR), 24);
    expect(est.bpm).toBeGreaterThan(170);
    expect(est.bpm).toBeLessThan(178);
  });

  it('offers the octave readings as alternatives', () => {
    const est = estimateTempo(onsetEnvelope(drumTrack(128, 24), SR), 24);
    // Half or double time is a legitimate reading of the same grid, so it
    // should be offered rather than silently discarded.
    const hasOctave = est.alternatives.some((alt) => {
      const octaves = Math.log2(alt / est.bpm);
      return Math.abs(octaves - Math.round(octaves)) < 0.03 && Math.round(octaves) !== 0;
    });
    expect(hasOctave).toBe(true);
  });

  it('resolves the exact tempo, not just the nearest analysis bin', () => {
    // The coarse autocorrelation can only resolve about 3 BPM at this tempo.
    // The comb refinement has to recover the fraction, or a grid drifts a
    // whole beat inside a minute.
    for (const bpm of [124, 126.5, 128, 130, 132]) {
      const est = estimateTempo(onsetEnvelope(drumTrack(bpm, 24), SR), 24);
      expect(est.bpm).toBeGreaterThan(bpm - 0.4);
      expect(est.bpm).toBeLessThan(bpm + 0.4);
    }
  });

  it('is accurate enough that a grid will not drift across a long track', () => {
    const bpm = 128;
    const duration = 40;
    const est = estimateTempo(onsetEnvelope(drumTrack(bpm, duration), SR), duration);
    // Error in beats accumulated over the whole track.
    const drift = Math.abs(est.bpm - bpm) / bpm * (duration / 60) * bpm;
    expect(drift).toBeLessThan(0.25);
  });

  it('reports a confidence and alternative readings', () => {
    const est = estimateTempo(onsetEnvelope(drumTrack(128, 24), SR), 24);
    expect(est.confidence).toBeGreaterThan(0.8);
    expect(est.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(est.alternatives)).toBe(true);
  });

  it('returns zero rather than inventing a tempo for silence', () => {
    const est = estimateTempo(onsetEnvelope(new Float32Array(SR * 5), SR), 5);
    expect(est.bpm).toBe(0);
    expect(est.confidence).toBe(0);
  });

  it('flags noise as low confidence instead of reporting a tempo as fact', () => {
    const noise = new Float32Array(SR * 12);
    for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 2 - 1) * 0.3;
    const random = estimateTempo(onsetEnvelope(noise, SR), 12);
    const steady = estimateTempo(onsetEnvelope(drumTrack(128, 24), SR), 24);

    expect(steady.confidence).toBeGreaterThan(random.confidence);
    // Below the threshold at which the UI stops presenting a tempo as settled
    // and asks the user to confirm it instead.
    expect(random.confidence).toBeLessThan(0.35);
    expect(steady.confidence).toBeGreaterThan(0.8);
  });

  it('separates a real pulse from noise by a wide margin of grid contrast', () => {
    const music = gridContrast(onsetEnvelope(drumTrack(128, 20), SR), 128, 20);
    const noise = new Float32Array(SR * 12);
    for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 2 - 1) * 0.3;
    const noiseContrast = gridContrast(onsetEnvelope(noise, SR), 128, 12);

    expect(music).toBeGreaterThan(6);
    expect(noiseContrast).toBeLessThan(1.6);
    expect(music).toBeGreaterThan(noiseContrast * 4);
  });

  it('maps contrast onto confidence with noise pinned at zero', () => {
    expect(contrastToConfidence(1.0)).toBe(0);
    expect(contrastToConfidence(1.5)).toBe(0);
    expect(contrastToConfidence(14)).toBe(1);
    // Loosely played material lands in between rather than at either extreme.
    const loose = contrastToConfidence(3.8);
    expect(loose).toBeGreaterThan(0.5);
    expect(loose).toBeLessThan(1);
  });

  it('stays confident when a human plays slightly off the grid', () => {
    const bpm = 128;
    const beat = 60 / bpm;
    const n = Math.round(20 * SR);
    const audio = new Float32Array(n);
    for (let t = 0; t < 20; t += beat) {
      // +/- 15 ms of timing jitter, as a live drummer would have.
      const at = t + (Math.random() * 2 - 1) * 0.015;
      const start = Math.round(at * SR);
      if (start < 0) continue;
      for (let i = 0; i < Math.round(0.11 * SR) && start + i < n; i++) {
        const tt = i / SR;
        audio[start + i] += Math.sin(2 * Math.PI * (150 * Math.exp(-tt * 26) + 42) * tt) * Math.exp(-tt * 34) * 0.9;
      }
    }
    const est = estimateTempo(onsetEnvelope(audio, SR), 20);
    expect(est.bpm).toBeCloseTo(bpm, 0);
    expect(est.confidence).toBeGreaterThan(0.4);
  });
});

describe('beat grid', () => {
  it('locks the grid phase onto the kicks', () => {
    const offset = 0.137;
    const bpm = 128;
    const audio = drumTrack(bpm, 24, SR, offset);
    const env = onsetEnvelope(audio, SR);
    const grid = estimateGrid(env, bpm, 24);

    // firstBeat should coincide with a kick, modulo whole beats.
    const beat = 60 / bpm;
    const err = Math.abs(((grid.firstBeat - offset) % beat + beat) % beat);
    const wrapped = Math.min(err, beat - err);
    // Within 10 ms of the real kick: below the point a flam becomes audible,
    // and any constant component cancels between two synced decks.
    expect(wrapped).toBeLessThan(0.01);
  });

  it('locks phase correctly whatever the track offset', () => {
    const bpm = 128;
    const beat = 60 / bpm;
    for (const offset of [0, 0.081, 0.137, 0.3, 0.44]) {
      const grid = estimateGrid(onsetEnvelope(drumTrack(bpm, 20, SR, offset), SR), bpm, 20);
      const err = Math.abs(((grid.firstBeat - offset) % beat + beat) % beat);
      expect(Math.min(err, beat - err)).toBeLessThan(0.012);
    }
  });

  it('places the anchor inside the first beat period', () => {
    const grid = estimateGrid(onsetEnvelope(drumTrack(128, 20), SR), 128, 20);
    expect(grid.firstBeat).toBeGreaterThanOrEqual(0);
    expect(grid.firstBeat).toBeLessThan(60 / 128 + 1e-9);
  });

  it('emits evenly spaced beats covering the track', () => {
    const grid = estimateGrid(onsetEnvelope(drumTrack(120, 20), SR), 120, 20);
    expect(grid.beats.length).toBeGreaterThan(35);
    for (let i = 1; i < grid.beats.length; i++) {
      // Beats are stored as Float32, so ~7 significant digits is the ceiling.
      expect(grid.beats[i] - grid.beats[i - 1]).toBeCloseTo(0.5, 5);
    }
    expect(grid.beats[grid.beats.length - 1]).toBeLessThanOrEqual(20);
  });

  it('marks a downbeat every four beats', () => {
    const grid = estimateGrid(onsetEnvelope(drumTrack(128, 20), SR), 128, 20);
    expect(grid.downbeats.length).toBeGreaterThan(8);
    for (let i = 1; i < grid.downbeats.length; i++) {
      expect(grid.downbeats[i] - grid.downbeats[i - 1]).toBeCloseTo(4 * (60 / 128), 5);
    }
    expect(grid.downbeatOffset).toBeGreaterThanOrEqual(0);
    expect(grid.downbeatOffset).toBeLessThan(4);
  });
});

describe('key detection', () => {
  it('finds A minor from an A minor triad', () => {
    // A3 C4 E4
    const est = estimateKey(chordTrack([57, 60, 64], 6), SR);
    expect(est.key).not.toBeNull();
    expect(est.key!.tonic).toBe(9);
    expect(est.key!.mode).toBe('minor');
  });

  it('finds C major from a C major triad', () => {
    // C4 E4 G4
    const est = estimateKey(chordTrack([60, 64, 67], 6), SR);
    expect(est.key).not.toBeNull();
    expect(est.key!.tonic).toBe(0);
    expect(est.key!.mode).toBe('major');
  });

  it('returns no key for silence instead of guessing', () => {
    const est = estimateKey(new Float32Array(SR * 3), SR);
    expect(est.key).toBeNull();
    expect(est.confidence).toBe(0);
  });

  it('gives a confidence between zero and one', () => {
    const est = estimateKey(chordTrack([60, 64, 67], 6), SR);
    expect(est.confidence).toBeGreaterThanOrEqual(0);
    expect(est.confidence).toBeLessThanOrEqual(1);
  });
});

describe('loudness and energy', () => {
  it('measures a louder signal as louder', () => {
    const quiet = new Float32Array(SR * 4);
    const loud = new Float32Array(SR * 4);
    for (let i = 0; i < quiet.length; i++) {
      const s = Math.sin((2 * Math.PI * 1000 * i) / SR);
      quiet[i] = s * 0.05;
      loud[i] = s * 0.5;
    }
    const lQuiet = integratedLoudness([quiet], SR);
    const lLoud = integratedLoudness([loud], SR);
    expect(lLoud).toBeGreaterThan(lQuiet);
    // A 20 dB amplitude increase should read as roughly 20 LU.
    expect(lLoud - lQuiet).toBeCloseTo(20, 0);
  });

  it('floors at -70 LUFS for silence', () => {
    expect(integratedLoudness([new Float32Array(SR * 2)], SR)).toBeLessThanOrEqual(-70);
  });

  it('produces one normalised energy value per second', () => {
    const audio = drumTrack(128, 12);
    const energy = energyCurve(audio, 12);
    expect(energy.length).toBe(12);
    let max = 0;
    for (const v of energy) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1.0001);
      max = Math.max(max, v);
    }
    expect(max).toBeGreaterThan(0.5);
  });

  it('tracks a loud section as higher energy than a quiet one', () => {
    const n = SR * 20;
    const audio = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const loud = i > n / 2;
      audio[i] = Math.sin((2 * Math.PI * 200 * i) / SR) * (loud ? 0.8 : 0.08);
    }
    const energy = energyCurve(audio, 20);
    const first = energy.slice(1, 8).reduce((a, b) => a + b, 0) / 7;
    const second = energy.slice(12, 19).reduce((a, b) => a + b, 0) / 7;
    expect(second).toBeGreaterThan(first * 3);
  });
});

describe('structure detection', () => {
  it('always covers the track with at least one labelled section', () => {
    const energy = energyCurve(drumTrack(128, 60), 60);
    const sections = detectSections(energy, 60, 60 / 128);
    expect(sections.length).toBeGreaterThanOrEqual(1);
    for (const s of sections) {
      expect(s.end).toBeGreaterThan(s.start);
      expect(s.confidence).toBeGreaterThanOrEqual(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('never claims certainty it does not have', () => {
    const energy = energyCurve(drumTrack(128, 60), 60);
    const sections = detectSections(energy, 60, 60 / 128);
    // Structure labels are heuristic; nothing should be reported as certain.
    for (const s of sections) expect(s.confidence).toBeLessThan(0.95);
  });

  it('splits a quiet intro from a loud body', () => {
    const duration = 90;
    const n = SR * duration;
    const audio = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const gain = t < 30 ? 0.06 : 0.85;
      audio[i] = Math.sin((2 * Math.PI * 180 * i) / SR) * gain;
    }
    const sections = detectSections(energyCurve(audio, duration), duration, 60 / 128);
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(sections[0].energy).toBeLessThan(sections[sections.length - 1].energy);
  });

  it('handles a track too short to segment', () => {
    const sections = detectSections(new Float32Array(3).fill(0.5), 3, 0.5);
    expect(sections.length).toBe(1);
    expect(sections[0].confidence).toBeLessThan(0.3);
  });
});

describe('waveform data', () => {
  it('produces the requested resolution and normalised bands', () => {
    const audio = drumTrack(128, 20);
    const wave = buildWaveform([audio], SR, 2000);
    expect(wave.peak.length).toBeGreaterThan(1900);
    expect(wave.peak.length).toBe(wave.low.length);
    expect(wave.peak.length).toBe(wave.mid.length);
    expect(wave.peak.length).toBe(wave.high.length);

    for (const band of [wave.low, wave.mid, wave.high]) {
      let max = 0;
      for (const v of band) {
        expect(v).toBeGreaterThanOrEqual(0);
        max = Math.max(max, v);
      }
      expect(max).toBeCloseTo(1, 5);
    }
  });

  it('puts kick energy in the low band', () => {
    const audio = drumTrack(128, 12);
    const wave = buildWaveform([audio], SR, 1000);
    const avg = (x: Float32Array) => x.reduce((a, b) => a + b, 0) / x.length;
    expect(avg(wave.low)).toBeGreaterThan(avg(wave.high));
  });

  it('reads zero everywhere for silence', () => {
    const wave = buildWaveform([new Float32Array(SR * 2)], SR, 200);
    expect(Math.max(...wave.peak)).toBe(0);
  });
});
