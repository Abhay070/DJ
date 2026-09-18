import { describe, it, expect } from 'vitest';
import {
  toCamelot, toNotation, formatKey, parseCamelot, keyRelation,
  keyRelationLabel, keyCompatibility, semitoneDistance, NOTE_NAMES,
} from '../src/lib/music';
import type { MusicalKey } from '../src/lib/music';

const key = (tonic: number, mode: 'major' | 'minor'): MusicalKey => ({ tonic, mode });
const AMin = key(9, 'minor');
const CMaj = key(0, 'major');

describe('Camelot notation', () => {
  it('places the anchor keys correctly', () => {
    // These two are the reference points of the whole wheel.
    expect(toCamelot(AMin)).toBe('8A');
    expect(toCamelot(CMaj)).toBe('8B');
  });

  it('assigns every key a unique wheel position', () => {
    const seen = new Set<string>();
    for (let tonic = 0; tonic < 12; tonic++) {
      for (const mode of ['major', 'minor'] as const) {
        const c = toCamelot(key(tonic, mode));
        expect(c).toMatch(/^\d{1,2}[AB]$/);
        expect(seen.has(c)).toBe(false);
        seen.add(c);
      }
    }
    expect(seen.size).toBe(24);
  });

  it('walks the wheel in fifths', () => {
    // Moving up a fifth moves one step clockwise.
    expect(toCamelot(CMaj)).toBe('8B');
    expect(toCamelot(key(7, 'major'))).toBe('9B');   // G major
    expect(toCamelot(key(2, 'major'))).toBe('10B');  // D major
    expect(toCamelot(key(5, 'major'))).toBe('7B');   // F major
  });

  it('pairs relative major and minor on the same number', () => {
    for (let tonic = 0; tonic < 12; tonic++) {
      const major = key(tonic, 'major');
      const relativeMinor = key((tonic + 9) % 12, 'minor');
      expect(toCamelot(major).replace('B', '')).toBe(toCamelot(relativeMinor).replace('A', ''));
    }
  });

  it('shows two dashes rather than a fake key when there is none', () => {
    expect(toCamelot(null)).toBe('--');
    expect(toNotation(null)).toBe('--');
    expect(formatKey(null, 'both')).toBe('--');
  });
});

describe('key formatting', () => {
  it('renders musical notation', () => {
    expect(toNotation(AMin)).toBe('A Minor');
    expect(toNotation(CMaj)).toBe('C Major');
    expect(toNotation(key(6, 'minor'))).toBe('F# Minor');
  });

  it('honours the chosen style', () => {
    expect(formatKey(AMin, 'camelot')).toBe('8A');
    expect(formatKey(AMin, 'musical')).toBe('A Minor');
    expect(formatKey(AMin, 'both')).toBe('8A · A Minor');
  });

  it('names all twelve pitch classes', () => {
    expect(NOTE_NAMES.length).toBe(12);
    expect(NOTE_NAMES[0]).toBe('C');
    expect(NOTE_NAMES[9]).toBe('A');
  });
});

describe('Camelot parsing', () => {
  it('reads valid codes', () => {
    expect(parseCamelot('8A')).toEqual({ number: 8, ring: 'A' });
    expect(parseCamelot('12b')).toEqual({ number: 12, ring: 'B' });
    expect(parseCamelot(' 1A ')).toEqual({ number: 1, ring: 'A' });
  });

  it('rejects out-of-range and malformed codes', () => {
    expect(parseCamelot('13A')).toBeNull();
    expect(parseCamelot('0A')).toBeNull();
    expect(parseCamelot('8C')).toBeNull();
    expect(parseCamelot('A8')).toBeNull();
    expect(parseCamelot('')).toBeNull();
  });
});

describe('harmonic relationships', () => {
  it('recognises the same key', () => {
    expect(keyRelation(AMin, AMin)).toBe('same');
    expect(keyCompatibility(AMin, AMin)).toBe(1);
  });

  it('recognises relative major and minor', () => {
    expect(keyRelation(AMin, CMaj)).toBe('relative');
    expect(keyCompatibility(AMin, CMaj)).toBeGreaterThan(0.8);
  });

  it('recognises neighbours on the wheel', () => {
    // 8A and 9A, and 8A and 7A.
    expect(keyRelation(AMin, key(4, 'minor'))).toBe('adjacent');
    expect(keyRelation(AMin, key(2, 'minor'))).toBe('adjacent');
  });

  it('recognises the two-step energy boost', () => {
    expect(keyRelation(AMin, key(11, 'minor'))).toBe('energy-boost');
  });

  it('marks unrelated keys as distant', () => {
    // 8A against 2A is directly across the wheel.
    expect(keyRelation(AMin, key(3, 'minor'))).toBe('distant');
    expect(keyCompatibility(AMin, key(3, 'minor'))).toBeLessThan(0.4);
  });

  it('is symmetric', () => {
    for (let a = 0; a < 12; a++) {
      for (let b = 0; b < 12; b++) {
        for (const mode of ['major', 'minor'] as const) {
          expect(keyRelation(key(a, mode), key(b, mode)))
            .toBe(keyRelation(key(b, mode), key(a, mode)));
        }
      }
    }
  });

  it('wraps around the wheel rather than treating 12 and 1 as far apart', () => {
    // 12A and 1A are neighbours despite the numbers looking distant.
    const twelveA = [...Array(12).keys()].map((t) => key(t, 'minor')).find((k) => toCamelot(k) === '12A')!;
    const oneA = [...Array(12).keys()].map((t) => key(t, 'minor')).find((k) => toCamelot(k) === '1A')!;
    expect(keyRelation(twelveA, oneA)).toBe('adjacent');
  });

  it('returns null when either key is unknown', () => {
    expect(keyRelation(null, AMin)).toBeNull();
    expect(keyRelation(AMin, null)).toBeNull();
    expect(keyCompatibility(null, AMin)).toBe(0.5);
  });

  it('labels every relation in plain words', () => {
    for (const rel of ['same', 'relative', 'adjacent', 'energy-boost', 'distant'] as const) {
      expect(keyRelationLabel(rel).length).toBeGreaterThan(3);
    }
    expect(keyRelationLabel(null)).toBe('Unknown');
  });
});

describe('semitone distance', () => {
  it('takes the shortest route', () => {
    expect(semitoneDistance(key(0, 'major'), key(1, 'major'))).toBe(1);
    expect(semitoneDistance(key(0, 'major'), key(11, 'major'))).toBe(-1);
    expect(semitoneDistance(key(0, 'major'), key(0, 'major'))).toBe(0);
  });

  it('never exceeds six semitones', () => {
    for (let a = 0; a < 12; a++) {
      for (let b = 0; b < 12; b++) {
        const d = semitoneDistance(key(a, 'major'), key(b, 'major'));
        expect(Math.abs(d)).toBeLessThanOrEqual(6);
      }
    }
  });
});
