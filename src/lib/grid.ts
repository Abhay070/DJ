/**
 * Beat-grid mathematics.
 *
 * Pure, side-effect free, and shared by the sync engine, the quantiser, the
 * loop system and the waveform renderer, so they can never disagree about
 * where a beat is. Everything here works in *track time* (seconds at the
 * track's natural tempo); the engine converts to wall-clock via playback rate.
 */
import type { BeatGrid } from './types';

/** Fractional beat number at a given track-time position. Can be negative. */
export function beatAt(grid: BeatGrid, seconds: number): number {
  if (grid.bpm <= 0) return 0;
  return (seconds - grid.firstBeat) / (60 / grid.bpm);
}

/** Track-time position of a (possibly fractional) beat number. */
export function timeAtBeat(grid: BeatGrid, beat: number): number {
  if (grid.bpm <= 0) return 0;
  return grid.firstBeat + beat * (60 / grid.bpm);
}

export function beatInterval(grid: BeatGrid): number {
  return grid.bpm > 0 ? 60 / grid.bpm : 0;
}

/** Bar number (4/4) at a position, accounting for where the downbeat sits. */
export function barAt(grid: BeatGrid, seconds: number): number {
  return (beatAt(grid, seconds) - grid.downbeatOffset) / 4;
}

/**
 * Phase within the bar, 0..4. 0 means exactly on the downbeat.
 */
export function barPhase(grid: BeatGrid, seconds: number): number {
  const b = beatAt(grid, seconds) - grid.downbeatOffset;
  return ((b % 4) + 4) % 4;
}

/** Snap a position to the nearest grid division. */
export function quantise(grid: BeatGrid, seconds: number, division: number): number {
  if (grid.bpm <= 0 || division <= 0) return seconds;
  const beat = beatAt(grid, seconds);
  const snapped = Math.round(beat / division) * division;
  return timeAtBeat(grid, snapped);
}

/** Snap forward to the next grid division (never backwards). */
export function quantiseForward(grid: BeatGrid, seconds: number, division: number): number {
  if (grid.bpm <= 0 || division <= 0) return seconds;
  const beat = beatAt(grid, seconds);
  const snapped = Math.ceil(beat / division - 1e-9) * division;
  return timeAtBeat(grid, snapped);
}

/**
 * Signed phase error between two decks, in beats, wrapped to [-0.5, +0.5).
 *
 * This is the number the sync engine drives to zero. Wrapping to half a beat
 * means correction always takes the short way round, so a deck never crawls
 * most of a bar to catch up.
 */
export function phaseError(beatA: number, beatB: number): number {
  let d = (beatA - beatB) % 1;
  if (d >= 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
}

/**
 * Same as phaseError but aligned to bars, so downbeats land on downbeats.
 * Returned in beats, wrapped to [-2, +2).
 */
export function barPhaseError(barBeatA: number, barBeatB: number): number {
  let d = (barBeatA - barBeatB) % 4;
  if (d >= 2) d -= 4;
  if (d < -2) d += 4;
  return d;
}

/**
 * Tempo ratio needed to play `from` at `to`'s tempo, folded by octaves so a
 * 70 BPM track syncs to a 140 BPM master at 1.0x rather than 2.0x.
 *
 * Folding picks the power of two that puts the ratio closest to unity, which
 * minimises how hard the time-stretcher has to work. The result therefore
 * always lands in [1/sqrt(2), sqrt(2)) - at most about 41% stretch, which is
 * the worst case any octave-folded match can have.
 *
 * Note there is no "maximum stretch" clamp here, and deliberately so: a window
 * narrower than a full octave cannot contain every ratio, so clamping would
 * silently return a value outside its own bound. Whether a given stretch is
 * musically acceptable is the caller's judgement - the Auto DJ scorer marks
 * anything past a few percent down.
 */
export function tempoRatio(fromBpm: number, toBpm: number): number {
  if (fromBpm <= 0 || toBpm <= 0) return 1;
  const raw = toBpm / fromBpm;
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const octaves = Math.round(Math.log2(raw));
  return raw / Math.pow(2, octaves);
}

/** Largest stretch `tempoRatio` can ever return, as a ratio. */
export const MAX_FOLDED_STRETCH = Math.SQRT2;

/**
 * The effective BPM a deck is sounding at, given its grid and playback rate.
 */
export function effectiveBpm(grid: BeatGrid, rate: number): number {
  return grid.bpm * rate;
}

/** Convert a rate to the pitch-fader percentage the UI shows. */
export function ratePercent(rate: number): number {
  return (rate - 1) * 100;
}

export function percentRate(percent: number): number {
  return 1 + percent / 100;
}

/** Nearest beat position to `seconds`, clamped into the track. */
export function nearestBeat(grid: BeatGrid, seconds: number, duration: number): number {
  const t = quantise(grid, seconds, 1);
  return Math.max(0, Math.min(duration, t));
}

/**
 * Build the list of visible beat lines between two times, so the renderer never
 * materialises a grid for the whole track.
 */
export function beatsBetween(grid: BeatGrid, from: number, to: number): { time: number; index: number }[] {
  const out: { time: number; index: number }[] = [];
  if (grid.bpm <= 0 || to <= from) return out;
  const interval = 60 / grid.bpm;
  // Guard against pathological zoom levels producing millions of lines.
  if ((to - from) / interval > 4096) return out;
  const startBeat = Math.floor(beatAt(grid, from));
  const endBeat = Math.ceil(beatAt(grid, to));
  for (let b = startBeat; b <= endBeat; b++) {
    out.push({ time: timeAtBeat(grid, b), index: b });
  }
  return out;
}

/** Is this beat index a downbeat (beat 1 of a bar)? */
export function isDownbeat(grid: BeatGrid, beatIndex: number): boolean {
  return (((beatIndex - grid.downbeatOffset) % 4) + 4) % 4 === 0;
}

/** Is this beat index a phrase start? Phrases are assumed to be 16 bars. */
export function isPhraseStart(grid: BeatGrid, beatIndex: number, phraseBeats = 64): boolean {
  return (((beatIndex - grid.downbeatOffset) % phraseBeats) + phraseBeats) % phraseBeats === 0;
}

/** Next phrase boundary at or after `seconds`. */
export function nextPhrase(grid: BeatGrid, seconds: number, phraseBeats = 64): number {
  if (grid.bpm <= 0) return seconds;
  const b = beatAt(grid, seconds) - grid.downbeatOffset;
  const next = Math.ceil(b / phraseBeats - 1e-9) * phraseBeats + grid.downbeatOffset;
  return timeAtBeat(grid, next);
}
