import { describe, it, expect } from 'vitest';
import {
  beatAt, timeAtBeat, barPhase, quantise, quantiseForward, phaseError,
  barPhaseError, tempoRatio, effectiveBpm, beatsBetween, isDownbeat,
  isPhraseStart, nextPhrase, MAX_FOLDED_STRETCH,
} from '../src/lib/grid';
import type { BeatGrid } from '../src/lib/types';

const grid128: BeatGrid = { firstBeat: 0.25, bpm: 128, downbeatOffset: 0, locked: false };

describe('beat grid mathematics', () => {
  it('maps time to beats and back without loss', () => {
    for (const beat of [0, 1, 3.5, 64, 127.25, 1000]) {
      expect(beatAt(grid128, timeAtBeat(grid128, beat))).toBeCloseTo(beat, 9);
    }
  });

  it('puts beat zero at the first detected beat', () => {
    expect(timeAtBeat(grid128, 0)).toBeCloseTo(0.25, 10);
    expect(beatAt(grid128, 0.25)).toBeCloseTo(0, 10);
  });

  it('spaces beats by exactly 60/bpm seconds', () => {
    const interval = 60 / 128;
    expect(timeAtBeat(grid128, 1) - timeAtBeat(grid128, 0)).toBeCloseTo(interval, 12);
    expect(timeAtBeat(grid128, 501) - timeAtBeat(grid128, 500)).toBeCloseTo(interval, 12);
  });

  it('reports bar phase in the range [0, 4)', () => {
    for (let b = 0; b < 32; b++) {
      const phase = barPhase(grid128, timeAtBeat(grid128, b + 0.5));
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(4);
      expect(phase).toBeCloseTo((b % 4) + 0.5, 9);
    }
  });

  it('respects a non-zero downbeat offset', () => {
    const offset: BeatGrid = { ...grid128, downbeatOffset: 2 };
    // Beat 2 is the downbeat, so bar phase there must be 0.
    expect(barPhase(offset, timeAtBeat(offset, 2))).toBeCloseTo(0, 9);
    expect(isDownbeat(offset, 2)).toBe(true);
    expect(isDownbeat(offset, 6)).toBe(true);
    expect(isDownbeat(offset, 3)).toBe(false);
  });

  it('returns the position unchanged when there is no tempo', () => {
    const noGrid: BeatGrid = { firstBeat: 0, bpm: 0, downbeatOffset: 0, locked: false };
    expect(quantise(noGrid, 12.34, 1)).toBe(12.34);
    expect(quantiseForward(noGrid, 12.34, 1)).toBe(12.34);
    expect(beatAt(noGrid, 99)).toBe(0);
  });
});

describe('quantisation', () => {
  it('snaps to the nearest beat', () => {
    const interval = 60 / 128;
    // Just past beat 4 snaps back to beat 4.
    expect(quantise(grid128, timeAtBeat(grid128, 4) + interval * 0.1, 1))
      .toBeCloseTo(timeAtBeat(grid128, 4), 9);
    // Just before beat 5 snaps forward to beat 5.
    expect(quantise(grid128, timeAtBeat(grid128, 5) - interval * 0.1, 1))
      .toBeCloseTo(timeAtBeat(grid128, 5), 9);
  });

  it('snaps to bars when the division is 4', () => {
    const t = timeAtBeat(grid128, 6);
    // Beat 6 is closer to bar 2 (beat 8) than bar 1 (beat 4).
    expect(quantise(grid128, t, 4)).toBeCloseTo(timeAtBeat(grid128, 8), 9);
  });

  it('never moves backwards when quantising forward', () => {
    for (const offset of [0.001, 0.2, 0.49, 0.5, 0.99]) {
      const from = timeAtBeat(grid128, 10 + offset);
      const snapped = quantiseForward(grid128, from, 1);
      expect(snapped).toBeGreaterThanOrEqual(from - 1e-9);
      expect(snapped).toBeCloseTo(timeAtBeat(grid128, 11), 9);
    }
  });

  it('leaves an exact grid position alone when quantising forward', () => {
    const on = timeAtBeat(grid128, 12);
    expect(quantiseForward(grid128, on, 1)).toBeCloseTo(on, 9);
  });

  it('supports sub-beat divisions', () => {
    const interval = 60 / 128;
    const t = timeAtBeat(grid128, 4) + interval * 0.26;
    expect(quantise(grid128, t, 0.25)).toBeCloseTo(timeAtBeat(grid128, 4.25), 9);
  });
});

describe('phase error', () => {
  it('is zero for identical positions', () => {
    expect(phaseError(10.5, 10.5)).toBeCloseTo(0, 12);
  });

  it('always takes the short way round', () => {
    // 0.9 beats ahead is really 0.1 beats behind.
    expect(phaseError(10.9, 10.0)).toBeCloseTo(-0.1, 9);
    expect(phaseError(10.0, 10.9)).toBeCloseTo(0.1, 9);
  });

  it('stays within half a beat for any input', () => {
    for (let i = 0; i < 400; i++) {
      const a = Math.random() * 1000;
      const b = Math.random() * 1000;
      const err = phaseError(a, b);
      expect(err).toBeGreaterThanOrEqual(-0.5);
      expect(err).toBeLessThan(0.5);
    }
  });

  it('ignores whole-beat differences', () => {
    expect(phaseError(100.25, 4.25)).toBeCloseTo(0, 9);
  });

  it('aligns to bars within +/- 2 beats', () => {
    expect(barPhaseError(0, 3)).toBeCloseTo(1, 9);   // forward 1 beat, not back 3
    expect(barPhaseError(0, 1)).toBeCloseTo(-1, 9);
    for (let i = 0; i < 200; i++) {
      const err = barPhaseError(Math.random() * 400, Math.random() * 400);
      expect(err).toBeGreaterThanOrEqual(-2);
      expect(err).toBeLessThan(2);
    }
  });
});

describe('tempo ratio', () => {
  it('matches equal tempos at unity', () => {
    expect(tempoRatio(128, 128)).toBeCloseTo(1, 12);
  });

  it('computes a straightforward stretch', () => {
    // 124 -> 128 is about +3.2%.
    expect(tempoRatio(124, 128)).toBeCloseTo(128 / 124, 12);
    expect((tempoRatio(124, 128) - 1) * 100).toBeCloseTo(3.2258, 3);
  });

  it('folds half and double time by octaves rather than stretching 2x', () => {
    // A 70 BPM track against a 140 BPM master should play at 1.0, not 2.0.
    expect(tempoRatio(70, 140)).toBeCloseTo(1, 12);
    expect(tempoRatio(140, 70)).toBeCloseTo(1, 12);
    expect(tempoRatio(64, 128)).toBeCloseTo(1, 12);
    expect(tempoRatio(174, 87)).toBeCloseTo(1, 12);
    // 90 against 128 folds to the double-time relationship: it plays at
    // half speed so its beats land on every other master beat.
    const r = tempoRatio(90, 128);
    expect(effectiveBpm({ ...grid128, bpm: 90 }, r)).toBeCloseTo(64, 6);
  });

  it('always folds into one octave centred on unity', () => {
    for (let from = 50; from <= 220; from += 0.5) {
      for (const to of [100, 120, 128, 140, 174]) {
        const r = tempoRatio(from, to);
        expect(r).toBeGreaterThanOrEqual(1 / MAX_FOLDED_STRETCH - 1e-9);
        expect(r).toBeLessThanOrEqual(MAX_FOLDED_STRETCH + 1e-9);
      }
    }
  });

  it('picks the octave that stretches least', () => {
    for (let from = 50; from <= 220; from += 0.5) {
      const to = 128;
      const r = tempoRatio(from, to);
      // No other octave of the raw ratio is closer to 1.
      const raw = to / from;
      for (const k of [-2, -1, 0, 1, 2]) {
        const alt = raw / Math.pow(2, k);
        expect(Math.abs(Math.log2(r))).toBeLessThanOrEqual(Math.abs(Math.log2(alt)) + 1e-9);
      }
    }
  });

  it('lands the follower on the master tempo, or an octave of it', () => {
    for (const from of [70, 87, 90, 124, 128, 140, 174]) {
      const to = 128;
      const sounding = from * tempoRatio(from, to);
      const octaves = Math.log2(to / sounding);
      expect(Math.abs(octaves - Math.round(octaves))).toBeLessThan(1e-9);
    }
  });

  it('returns unity rather than dividing by zero', () => {
    expect(tempoRatio(0, 128)).toBe(1);
    expect(tempoRatio(128, 0)).toBe(1);
  });
});

describe('grid iteration', () => {
  it('lists every beat in a window', () => {
    const beats = beatsBetween(grid128, 0.25, 0.25 + (60 / 128) * 8);
    // Inclusive of both ends, plus the guard beat either side.
    expect(beats.length).toBeGreaterThanOrEqual(9);
    for (let i = 1; i < beats.length; i++) {
      expect(beats[i].time - beats[i - 1].time).toBeCloseTo(60 / 128, 10);
      expect(beats[i].index - beats[i - 1].index).toBe(1);
    }
  });

  it('refuses to materialise an absurd number of lines', () => {
    expect(beatsBetween(grid128, 0, 100000).length).toBe(0);
  });

  it('identifies 16-bar phrase starts', () => {
    expect(isPhraseStart(grid128, 0, 64)).toBe(true);
    expect(isPhraseStart(grid128, 64, 64)).toBe(true);
    expect(isPhraseStart(grid128, 32, 64)).toBe(false);
  });

  it('finds the next phrase boundary going forward', () => {
    const from = timeAtBeat(grid128, 70);
    const next = nextPhrase(grid128, from, 64);
    expect(next).toBeGreaterThan(from);
    expect(beatAt(grid128, next)).toBeCloseTo(128, 6);
  });

  it('stays put when already exactly on a phrase boundary', () => {
    const on = timeAtBeat(grid128, 64);
    expect(nextPhrase(grid128, on, 64)).toBeCloseTo(on, 9);
  });
});
