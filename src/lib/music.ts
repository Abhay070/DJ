/** Musical key handling: notation, Camelot wheel, and harmonic compatibility. */

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export interface MusicalKey {
  /** 0-11, C = 0 */
  tonic: number;
  mode: 'major' | 'minor';
}

/**
 * Camelot wheel numbers indexed by tonic. Minor keys are the "A" ring, major
 * the "B" ring. 8A = A minor, 8B = C major.
 */
const CAMELOT_MINOR: Record<number, number> = { 9: 8, 4: 9, 11: 10, 6: 11, 1: 12, 8: 1, 3: 2, 10: 3, 5: 4, 0: 5, 7: 6, 2: 7 };
const CAMELOT_MAJOR: Record<number, number> = { 0: 8, 7: 9, 2: 10, 9: 11, 4: 12, 11: 1, 6: 2, 1: 3, 8: 4, 3: 5, 10: 6, 5: 7 };

export function toCamelot(key: MusicalKey | null): string {
  if (!key) return '--';
  const n = key.mode === 'minor' ? CAMELOT_MINOR[key.tonic] : CAMELOT_MAJOR[key.tonic];
  return `${n}${key.mode === 'minor' ? 'A' : 'B'}`;
}

export function toNotation(key: MusicalKey | null): string {
  if (!key) return '--';
  return `${NOTE_NAMES[key.tonic]} ${key.mode === 'minor' ? 'Minor' : 'Major'}`;
}

export function formatKey(key: MusicalKey | null, style: 'camelot' | 'musical' | 'both'): string {
  if (!key) return '--';
  if (style === 'camelot') return toCamelot(key);
  if (style === 'musical') return toNotation(key);
  return `${toCamelot(key)} · ${toNotation(key)}`;
}

export function parseCamelot(text: string): { number: number; ring: 'A' | 'B' } | null {
  const m = /^(\d{1,2})\s*([AB])$/i.exec(text.trim());
  if (!m) return null;
  const number = parseInt(m[1], 10);
  if (number < 1 || number > 12) return null;
  return { number, ring: m[2].toUpperCase() as 'A' | 'B' };
}

export type KeyRelation =
  | 'same'
  | 'relative'      // same Camelot number, other ring (relative major/minor)
  | 'adjacent'      // +/- 1 on the wheel, same ring
  | 'energy-boost'  // +2 on the wheel, same ring
  | 'distant';

/** Harmonic relationship between two keys, using Camelot-wheel adjacency. */
export function keyRelation(a: MusicalKey | null, b: MusicalKey | null): KeyRelation | null {
  if (!a || !b) return null;
  const ca = parseCamelot(toCamelot(a));
  const cb = parseCamelot(toCamelot(b));
  if (!ca || !cb) return null;
  if (ca.number === cb.number && ca.ring === cb.ring) return 'same';
  if (ca.number === cb.number) return 'relative';

  // Distance the short way round a 12-position wheel: 12 and 1 are neighbours,
  // so a plain subtraction would call them eleven steps apart.
  const raw = (((ca.number - cb.number) % 12) + 12) % 12;
  const circular = Math.min(raw, 12 - raw);

  // Two steps is treated as a boost in either direction, which keeps the
  // relation symmetric - "how well do these two blend" cannot depend on
  // which one you happen to name first.
  if (ca.ring === cb.ring && circular === 1) return 'adjacent';
  if (ca.ring === cb.ring && circular === 2) return 'energy-boost';
  return 'distant';
}

export function keyRelationLabel(rel: KeyRelation | null): string {
  switch (rel) {
    case 'same': return 'Same key';
    case 'relative': return 'Relative major/minor';
    case 'adjacent': return 'Neighbouring key';
    case 'energy-boost': return 'Energy boost (+2)';
    case 'distant': return 'Not harmonically close';
    default: return 'Unknown';
  }
}

/** 0..1 score for how well two keys blend. Advisory only - never enforced. */
export function keyCompatibility(a: MusicalKey | null, b: MusicalKey | null): number {
  switch (keyRelation(a, b)) {
    case 'same': return 1;
    case 'relative': return 0.9;
    case 'adjacent': return 0.85;
    case 'energy-boost': return 0.6;
    case 'distant': return 0.25;
    default: return 0.5;
  }
}

/** Semitone distance needed to move `from` onto `to`, in [-6, 6]. */
export function semitoneDistance(from: MusicalKey, to: MusicalKey): number {
  let d = (to.tonic - from.tonic + 12) % 12;
  if (d > 6) d -= 12;
  return d;
}
