/**
 * Beat, tempo, key and structure detection.
 *
 * Deliberately conservative: every estimator returns a confidence alongside its
 * value so the UI can ask the user instead of presenting a guess as fact.
 */
import { fft, hann, toMono, decimate, smooth, applyBiquad, highPass, highShelf } from '../lib/dsp';
import type { MusicalKey } from '../lib/music';
import type { Section, SectionLabel, WaveformData } from '../lib/types';

const ONSET_FFT = 1024;
const ONSET_HOP = 256;
/** Onset envelope runs on audio decimated to roughly this rate. */
const ONSET_SR_TARGET = 11025;

export interface OnsetEnvelope {
  /** Spectral flux per frame. Coarse in time, good for tempo. */
  flux: Float32Array;
  /** Low-band flux only - kick drums, which carry the beat. */
  lowFlux: Float32Array;
  /** Frames per second of the coarse envelope. */
  rate: number;
  /**
   * High-time-resolution low-band attack function.
   *
   * The STFT envelope above is smeared by its 93 ms window, which puts a fixed
   * latency of well over 100 ms on any onset it reports - far too coarse to
   * place a beat grid, where a few milliseconds of error is audible as a
   * flam. Tempo needs the long window (it is a periodicity measurement);
   * phase needs time resolution. So phase is located on this separate,
   * short-window envelope instead.
   */
  fine: Float32Array;
  /** Frames per second of the fine envelope. */
  fineRate: number;
}

/**
 * Spectral flux onset envelope. Half-wave rectified difference of the
 * magnitude spectrum, which responds to note onsets rather than raw loudness.
 */
export function onsetEnvelope(mono: Float32Array, sampleRate: number): OnsetEnvelope {
  const factor = Math.max(1, Math.round(sampleRate / ONSET_SR_TARGET));
  const x = decimate(mono, factor);
  const sr = sampleRate / factor;

  const win = hann(ONSET_FFT);
  const frames = Math.max(1, Math.floor((x.length - ONSET_FFT) / ONSET_HOP));
  const flux = new Float32Array(frames);
  const lowFlux = new Float32Array(frames);

  const re = new Float32Array(ONSET_FFT);
  const im = new Float32Array(ONSET_FFT);
  const mag = new Float32Array(ONSET_FFT / 2);
  const prev = new Float32Array(ONSET_FFT / 2);

  // Bin index for ~250 Hz, the top of the "kick and bass" band.
  const lowBins = Math.max(2, Math.round((250 / (sr / 2)) * (ONSET_FFT / 2)));

  for (let f = 0; f < frames; f++) {
    const base = f * ONSET_HOP;
    for (let i = 0; i < ONSET_FFT; i++) {
      re[i] = x[base + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    let sum = 0;
    let lowSum = 0;
    for (let k = 0; k < ONSET_FFT / 2; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      // Log compression keeps quiet passages from being ignored entirely.
      const m = Math.log1p(mag[k] * 8);
      const d = m - prev[k];
      if (d > 0) {
        sum += d;
        if (k < lowBins) lowSum += d;
      }
      prev[k] = m;
    }
    flux[f] = sum;
    lowFlux[f] = lowSum;
  }

  return { flux, lowFlux, rate: sr / ONSET_HOP, ...fineEnvelope(x, sr) };
}

/**
 * Window and hop of the fine attack detector, in samples of the decimated
 * (~11 kHz) signal. 64 samples is about 5.8 ms.
 *
 * The residual timing bias of this detector scales with the window, measured
 * at roughly 5 ms here against synthetic kicks - about 1% of a beat at 128 BPM,
 * below the threshold where a flam is audible. Shortening it further starts to
 * make the energy measurement noisy on real material. Any remaining bias is
 * common to both decks and so cancels in the phase controller, which aligns
 * grids against each other rather than against absolute time.
 */
const FINE_WIN = 64;
const FINE_HOP = 16;

/**
 * Short-window attack detector on the low band.
 *
 * Energy is measured over a ~12 ms window every ~1.5 ms; the half-wave
 * rectified difference peaks when the window has just filled with a new
 * transient, so labelling each frame with its window *centre* puts the
 * reported onset on the attack itself rather than a window-length behind it.
 */
function fineEnvelope(x: Float32Array, sr: number): { fine: Float32Array; fineRate: number } {
  // One-pole low-pass around 300 Hz isolates kick and bass attacks, which are
  // what a beat grid should lock to.
  const coef = Math.exp((-2 * Math.PI * 300) / sr);
  const low = new Float32Array(x.length);
  let z = 0;
  for (let i = 0; i < x.length; i++) {
    z = x[i] + coef * (z - x[i]);
    low[i] = z;
  }

  const frames = Math.max(1, Math.floor((low.length - FINE_WIN) / FINE_HOP));
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const base = f * FINE_HOP;
    let acc = 0;
    for (let i = 0; i < FINE_WIN; i++) acc += low[base + i] * low[base + i];
    energy[f] = Math.log1p(Math.sqrt(acc / FINE_WIN) * 40);
  }

  const fine = new Float32Array(frames);
  for (let f = 1; f < frames; f++) fine[f] = Math.max(0, energy[f] - energy[f - 1]);

  return { fine, fineRate: sr / FINE_HOP };
}

/**
 * Convert a fine-envelope frame index to a time in seconds, correcting for the
 * analysis window so the value refers to the attack, not the window start.
 */
function fineFrameTime(frame: number, env: OnsetEnvelope): number {
  const sr = env.fineRate * FINE_HOP;
  return (frame * FINE_HOP + FINE_WIN / 2) / sr;
}

/** Time in seconds back to a fractional fine-envelope frame index. */
function fineTimeFrame(seconds: number, env: OnsetEnvelope): number {
  const sr = env.fineRate * FINE_HOP;
  return (seconds * sr - FINE_WIN / 2) / FINE_HOP;
}

/**
 * Score a candidate tempo by laying a pulse train over the fine envelope and
 * keeping the best phase. Returns both, so tempo and phase are estimated
 * jointly rather than one after the other.
 */
function combScore(env: OnsetEnvelope, bpm: number, duration: number, phaseSteps: number):
  { score: number; phase: number } {
  const fine = env.fine;
  const n = fine.length;
  const beatFrames = (60 / bpm) * env.fineRate;
  if (beatFrames < 4 || n < beatFrames * 4) return { score: 0, phase: 0 };

  // Sampling tolerance of about 3 ms absorbs performance jitter without
  // letting neighbouring beats bleed into each other.
  const tol = Math.max(1, Math.round(env.fineRate * 0.003));

  let bestScore = -Infinity;
  let bestPhase = 0;
  for (let s = 0; s < phaseSteps; s++) {
    const phase = (s / phaseSteps) * beatFrames;
    let acc = 0;
    let count = 0;
    for (let t = phase; t < n; t += beatFrames) {
      const i = Math.round(t);
      let peak = 0;
      const lo = Math.max(0, i - tol);
      const hi = Math.min(n - 1, i + tol);
      for (let k = lo; k <= hi; k++) if (fine[k] > peak) peak = fine[k];
      acc += peak;
      count++;
    }
    if (!count) continue;
    const score = acc / count;
    if (score > bestScore) { bestScore = score; bestPhase = phase; }
  }
  void duration;
  return { score: bestScore === -Infinity ? 0 : bestScore, phase: bestPhase };
}

/**
 * Sweep tempo finely around a coarse estimate, scoring each candidate with the
 * comb above. The coarse autocorrelation can only resolve integer frame lags -
 * roughly 3 BPM at 130 - which would let a grid drift a whole beat within a
 * minute. This recovers the fraction.
 */
function refineTempo(env: OnsetEnvelope, coarseBpm: number, duration: number): number {
  if (coarseBpm <= 0) return 0;

  let best = coarseBpm;
  let bestScore = -Infinity;

  // Pass one: +/-6% at 0.1 BPM, enough to cross a whole coarse lag bin.
  for (let bpm = coarseBpm * 0.94; bpm <= coarseBpm * 1.06; bpm += 0.1) {
    const { score } = combScore(env, bpm, duration, 24);
    if (score > bestScore) { bestScore = score; best = bpm; }
  }

  // Pass two: +/-0.15 BPM at 0.005, with a finer phase sweep.
  let refined = best;
  bestScore = -Infinity;
  for (let bpm = best - 0.15; bpm <= best + 0.15; bpm += 0.005) {
    const { score } = combScore(env, bpm, duration, 64);
    if (score > bestScore) { bestScore = score; refined = bpm; }
  }

  return Math.round(refined * 100) / 100;
}

export interface TempoEstimate {
  bpm: number;
  confidence: number;
  alternatives: number[];
}

const MIN_BPM = 60;
const MAX_BPM = 200;
/**
 * Tempo prior centred on 125 BPM.
 *
 * Its job is narrow: break the half/double-time tie, which is genuinely
 * ambiguous because both readings describe the same grid. It is deliberately
 * gentle - a sharper prior drags legitimately fast music (drum and bass at
 * 174, hard techno at 150) down to a comfortable-looking wrong answer. Errors
 * that are *not* octave-related are settled by how well a grid actually fits
 * the onsets, not by this.
 */
function tempoPrior(bpm: number): number {
  const centre = 125;
  const width = 55;
  const z = Math.log2(bpm / centre) * (120 / width);
  return Math.exp(-0.5 * z * z);
}

/**
 * Tempo estimation: autocorrelation for the octave, comb refinement for the
 * fraction. `duration` lets the refinement stage use the whole track.
 */
export function estimateTempo(env: OnsetEnvelope, duration?: number): TempoEstimate {
  const x = env.flux;
  const n = x.length;
  if (n < 32) return { bpm: 0, confidence: 0, alternatives: [] };

  // Remove the DC/slow component so loud sections do not dominate.
  const base = smooth(x, Math.round(env.rate * 0.75));
  const detr = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) { detr[i] = Math.max(0, x[i] - base[i]); mean += detr[i]; }
  mean /= n;
  for (let i = 0; i < n; i++) detr[i] -= mean;

  const minLag = Math.max(2, Math.floor((60 / MAX_BPM) * env.rate));
  const maxLag = Math.min(n - 1, Math.ceil((60 / MIN_BPM) * env.rate));

  const scores: { bpm: number; score: number }[] = [];
  let norm0 = 0;
  for (let i = 0; i < n; i++) norm0 += detr[i] * detr[i];
  if (norm0 <= 0) return { bpm: 0, confidence: 0, alternatives: [] };

  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += detr[i] * detr[i + lag];
    let r = acc / norm0;

    // Reinforce with integer multiples: a true beat period also correlates at
    // 2x and 4x, which separates the beat from an off-beat eighth.
    //
    // Only powers of two. Including 3x lets a candidate borrow support from a
    // peak two thirds of the way along, so a 174 BPM track scores well at 116
    // (174 x 2/3) and the prior then finishes the job - a real failure this
    // used to have. 4/4 is the assumption everywhere else in the app.
    let harmonics = 1;
    for (const mult of [2, 4]) {
      const l2 = lag * mult;
      if (l2 > maxLag) break;
      let acc2 = 0;
      for (let i = 0; i + l2 < n; i++) acc2 += detr[i] * detr[i + l2];
      r += (acc2 / norm0) * (1 / mult);
      harmonics += 1 / mult;
    }
    r /= harmonics;

    const bpm = (60 * env.rate) / lag;
    scores.push({ bpm, score: r * tempoPrior(bpm) });
  }

  scores.sort((a, b) => b.score - a.score);
  if (!scores.length || scores[0].score <= 0) return { bpm: 0, confidence: 0, alternatives: [] };

  // Shortlist distinct candidates (not within 2% of one already listed).
  const shortlist: number[] = [];
  for (const s of scores) {
    if (shortlist.length >= 5) break;
    if (!shortlist.some((b) => Math.abs(b - s.bpm) / b < 0.02)) shortlist.push(s.bpm);
  }

  const trackSeconds = duration ?? env.flux.length / env.rate;

  /*
   * Decide between the shortlisted tempos by how well each one's grid actually
   * lands on the onsets, not by the autocorrelation alone.
   *
   * Autocorrelation is easily fooled here: the lag for 116 BPM is one and a
   * half beats of a 174 BPM track, so its 2x and 4x harmonics both sit on real
   * peaks and it scores well despite half its grid falling on silence. Laying
   * the grid down and measuring catches that immediately.
   *
   * The comb cannot distinguish octaves - at half tempo every grid point still
   * lands on a beat - so the prior is applied here too, which is the one job
   * it is actually good for.
   */
  let bestBpm = shortlist[0];
  let bestFit = -Infinity;
  const fits = new Map<number, number>();

  for (const candidate of shortlist) {
    const refinedCandidate = refineTempo(env, candidate, trackSeconds);
    const bpmCandidate = refinedCandidate > 0 && Math.abs(refinedCandidate - candidate) / candidate < 0.08
      ? refinedCandidate
      : round2(candidate);
    const fit = combScore(env, bpmCandidate, trackSeconds, 64).score;
    fits.set(bpmCandidate, fit);
    // Squared so grid fit dominates, with the prior as the octave tie-break.
    const weighted = fit * fit * tempoPrior(bpmCandidate);
    if (weighted > bestFit) { bestFit = weighted; bestBpm = bpmCandidate; }
  }

  const alternatives = [...fits.keys()]
    .filter((b) => Math.abs(b - bestBpm) / bestBpm >= 0.02)
    .slice(0, 3)
    .map(round2);

  return {
    bpm: round2(bestBpm),
    confidence: contrastToConfidence(gridContrast(env, bestBpm, trackSeconds)),
    alternatives,
  };
}

/**
 * How much more onset energy lands on a grid at `bpm` than on clearly wrong
 * grids. Returned raw; `contrastToConfidence` maps it onto 0..1.
 *
 * Lay the grid down at the winning tempo and at several clearly wrong ones,
 * and compare how much onset energy lands on each. A real tempo concentrates
 * the attacks; a wrong one spreads them, and noise looks the same either way.
 *
 * The autocorrelation margin this replaced could report high confidence for
 * white noise, simply because one arbitrary lag happened to beat the others.
 */
export function gridContrast(env: OnsetEnvelope, bpm: number, duration: number): number {
  if (bpm <= 0) return 0;
  const onGrid = combScore(env, bpm, duration, 64).score;
  if (onGrid <= 0) return 0;

  // Detune factors deliberately avoid simple ratios, which would land on real
  // subdivisions and understate the contrast.
  let baseline = 0;
  let count = 0;
  for (const factor of [0.79, 0.87, 1.11, 1.21]) {
    baseline += combScore(env, bpm * factor, duration, 64).score;
    count++;
  }
  baseline /= Math.max(1, count);
  if (baseline <= 0) return 0;

  return onGrid / baseline;
}

/**
 * Map a raw contrast onto 0..1 confidence.
 *
 * Calibrated against measured values rather than guessed: a clean programmed
 * loop reads 13-15, a loosely played one with 20 ms of timing jitter reads
 * 3.5-4, and white noise reads under 1.3. The floor sits above the noise
 * ceiling, so material with no real pulse reports zero confidence and the UI
 * asks the user rather than presenting a number as settled.
 */
export function contrastToConfidence(contrast: number): number {
  return Math.max(0, Math.min(1, (contrast - 1.6) / 2.6));
}

function round2(x: number): number { return Math.round(x * 100) / 100; }

export interface GridEstimate {
  firstBeat: number;
  beats: Float32Array;
  downbeats: Float32Array;
  downbeatOffset: number;
  phaseConfidence: number;
}

/**
 * Lock a constant-tempo grid to the onset envelope: slide a pulse train across
 * one beat period and keep the phase with the strongest response.
 */
export function estimateGrid(env: OnsetEnvelope, bpm: number, duration: number): GridEstimate {
  // Phase is located on the fine envelope. Using the STFT flux here would put
  // the grid a fixed ~165 ms behind the music - most of a beat at 130 BPM.
  const period = (60 / bpm) * env.fineRate;
  const n = env.fine.length;
  // Sweep at roughly 1 ms resolution; anything coarser is audible as a flam.
  const steps = Math.max(32, Math.min(1024, Math.round(env.fineRate * (60 / bpm))));

  let bestPhase = 0;
  let bestScore = -Infinity;
  let total = 0;
  const tol = Math.max(1, Math.round(env.fineRate * 0.003));

  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * period;
    let score = 0;
    let count = 0;
    for (let t = phase; t < n; t += period) {
      const i = Math.round(t);
      let peak = 0;
      const lo = Math.max(0, i - tol);
      const hi = Math.min(n - 1, i + tol);
      for (let k = lo; k <= hi; k++) if (env.fine[k] > peak) peak = env.fine[k];
      score += peak;
      count++;
    }
    if (count) score /= count;
    total += score;
    if (score > bestScore) { bestScore = score; bestPhase = phase; }
  }

  const meanScore = total / steps;
  const phaseConfidence = meanScore > 0 ? Math.max(0, Math.min(1, (bestScore / meanScore - 1) * 1.5)) : 0;

  // Frame index back to a real time, correcting for the analysis window.
  let firstBeat = fineFrameTime(bestPhase, env);
  const beatInterval = 60 / bpm;
  // Keep the anchor inside the first beat period so beat indices stay small.
  firstBeat -= Math.floor(firstBeat / beatInterval) * beatInterval;
  const beatCount = Math.max(0, Math.floor((duration - firstBeat) / beatInterval) + 1);
  const beats = new Float32Array(beatCount);
  for (let i = 0; i < beatCount; i++) beats[i] = firstBeat + i * beatInterval;

  // Downbeat: of the four positions in the bar, the one whose low-band flux is
  // strongest across the track is almost always beat 1.
  let bestOffset = 0;
  let bestLow = -Infinity;
  for (let off = 0; off < 4; off++) {
    let acc = 0;
    let count = 0;
    for (let i = off; i < beatCount; i += 4) {
      const f = Math.round(fineTimeFrame(beats[i], env));
      if (f >= 0 && f < env.fine.length) { acc += env.fine[f]; count++; }
    }
    if (count) acc /= count;
    if (acc > bestLow) { bestLow = acc; bestOffset = off; }
  }

  const downCount = Math.max(0, Math.ceil((beatCount - bestOffset) / 4));
  const downbeats = new Float32Array(downCount);
  for (let i = 0; i < downCount; i++) downbeats[i] = beats[bestOffset + i * 4];

  return { firstBeat, beats, downbeats, downbeatOffset: bestOffset, phaseConfidence };
}

// ------------------------------------------------------------------ key

/** Krumhansl-Kessler key profiles, normalised at use. */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface KeyEstimate { key: MusicalKey | null; confidence: number }

/** Chromagram + profile correlation. */
export function estimateKey(mono: Float32Array, sampleRate: number): KeyEstimate {
  const size = 4096;
  const hop = 2048;
  const win = hann(size);
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  const chroma = new Float64Array(12);

  const frames = Math.floor((mono.length - size) / hop);
  if (frames < 4) return { key: null, confidence: 0 };

  // Only bins between 65 Hz (C2) and 2 kHz carry useful pitch information.
  const loBin = Math.max(1, Math.floor((65 / sampleRate) * size));
  const hiBin = Math.min(size / 2 - 1, Math.ceil((2000 / sampleRate) * size));

  for (let f = 0; f < frames; f++) {
    const base = f * hop;
    for (let i = 0; i < size; i++) { re[i] = mono[base + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = loBin; k <= hiBin; k++) {
      const freq = (k * sampleRate) / size;
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      if (mag <= 0) continue;
      const midi = 69 + 12 * Math.log2(freq / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pc] += mag;
    }
  }

  let sum = 0;
  for (let i = 0; i < 12; i++) sum += chroma[i];
  if (sum <= 0) return { key: null, confidence: 0 };
  for (let i = 0; i < 12; i++) chroma[i] /= sum;

  let best: MusicalKey | null = null;
  let bestScore = -Infinity;
  let second = -Infinity;

  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      const profile = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE;
      const score = correlate(chroma, profile, tonic);
      if (score > bestScore) {
        second = bestScore;
        bestScore = score;
        best = { tonic, mode };
      } else if (score > second) {
        second = score;
      }
    }
  }

  const confidence = bestScore > 0 ? Math.max(0, Math.min(1, (bestScore - second) * 4)) : 0;
  return { key: best, confidence };
}

function correlate(chroma: Float64Array, profile: number[], rotation: number): number {
  let cMean = 0;
  let pMean = 0;
  for (let i = 0; i < 12; i++) { cMean += chroma[i]; pMean += profile[i]; }
  cMean /= 12; pMean /= 12;
  let num = 0, dc = 0, dp = 0;
  for (let i = 0; i < 12; i++) {
    const c = chroma[(i + rotation) % 12] - cMean;
    const p = profile[i] - pMean;
    num += c * p; dc += c * c; dp += p * p;
  }
  return dc > 0 && dp > 0 ? num / Math.sqrt(dc * dp) : 0;
}

// ------------------------------------------------------- loudness & energy

/**
 * Approximate integrated loudness in LUFS, following the ITU-R BS.1770
 * K-weighting and gating scheme. Close enough for gain staging between tracks,
 * which is all we use it for.
 */
export function integratedLoudness(channels: Float32Array[], sampleRate: number): number {
  const weighted = channels.map((ch) => {
    const shelved = applyBiquad(ch, highShelf(sampleRate, 1681.97, 3.999, 1 / Math.SQRT2));
    return applyBiquad(shelved, highPass(sampleRate, 38.13, 0.5));
  });

  const blockLen = Math.round(0.4 * sampleRate);
  const step = Math.round(0.1 * sampleRate);
  const blocks: number[] = [];
  const n = weighted[0].length;

  for (let start = 0; start + blockLen <= n; start += step) {
    let power = 0;
    for (const ch of weighted) {
      let s = 0;
      for (let i = start; i < start + blockLen; i++) s += ch[i] * ch[i];
      power += s / blockLen;
    }
    blocks.push(power);
  }
  if (!blocks.length) return -70;

  const toLufs = (p: number) => -0.691 + 10 * Math.log10(Math.max(p, 1e-12));

  // Absolute gate at -70 LUFS, then a relative gate 10 LU below the ungated mean.
  const gatedAbs = blocks.filter((p) => toLufs(p) > -70);
  if (!gatedAbs.length) return -70;
  const meanAbs = gatedAbs.reduce((a, b) => a + b, 0) / gatedAbs.length;
  const relThreshold = toLufs(meanAbs) - 10;
  const gated = gatedAbs.filter((p) => toLufs(p) > relThreshold);
  const finalBlocks = gated.length ? gated : gatedAbs;
  const mean = finalBlocks.reduce((a, b) => a + b, 0) / finalBlocks.length;
  return toLufs(mean);
}

/** One RMS-derived energy value per second, normalised to the track's own max. */
export function energyCurve(mono: Float32Array, duration: number): Float32Array {
  const seconds = Math.max(1, Math.ceil(duration));
  const out = new Float32Array(seconds);
  const per = Math.floor(mono.length / seconds);
  for (let s = 0; s < seconds; s++) {
    let acc = 0;
    const base = s * per;
    const end = Math.min(mono.length, base + per);
    for (let i = base; i < end; i++) acc += mono[i] * mono[i];
    out[s] = Math.sqrt(acc / Math.max(1, end - base));
  }
  let max = 0;
  for (let i = 0; i < seconds; i++) max = Math.max(max, out[i]);
  if (max > 0) for (let i = 0; i < seconds; i++) out[i] /= max;
  return smooth(out, 2);
}

// ------------------------------------------------------------- structure

/**
 * Segment the track on energy novelty and label the segments heuristically.
 *
 * These labels are guesses. Each carries a confidence, and the transition
 * engine weighs them rather than trusting them.
 */
export function detectSections(energy: Float32Array, duration: number, beatInterval: number): Section[] {
  const n = energy.length;
  if (n < 8) {
    return [{ start: 0, end: duration, label: 'verse', confidence: 0.1, energy: 0.5 }];
  }

  // Novelty = absolute change in smoothed energy.
  const sm = smooth(energy, 3);
  const novelty = new Float32Array(n);
  for (let i = 1; i < n; i++) novelty[i] = Math.abs(sm[i] - sm[i - 1]);

  // Peak-pick novelty into boundaries, keeping segments at least 8 seconds long.
  let threshold = 0;
  for (let i = 0; i < n; i++) threshold += novelty[i];
  threshold = (threshold / n) * 1.8;

  const bounds: number[] = [0];
  for (let i = 4; i < n - 4; i++) {
    if (novelty[i] > threshold && novelty[i] >= novelty[i - 1] && novelty[i] >= novelty[i + 1]) {
      if (i - bounds[bounds.length - 1] >= 8) bounds.push(i);
    }
  }
  bounds.push(n);

  // Snap boundaries to the nearest bar so sections line up with the grid.
  const barSeconds = beatInterval * 4;
  const snap = (t: number) => (barSeconds > 0 ? Math.round(t / barSeconds) * barSeconds : t);

  const segments: Section[] = [];
  let maxEnergy = 0;
  for (let i = 0; i < n; i++) maxEnergy = Math.max(maxEnergy, sm[i]);

  for (let b = 0; b < bounds.length - 1; b++) {
    const from = bounds[b];
    const to = bounds[b + 1];
    let acc = 0;
    for (let i = from; i < to; i++) acc += sm[i];
    const avg = acc / Math.max(1, to - from);
    const rel = maxEnergy > 0 ? avg / maxEnergy : 0;

    const start = Math.max(0, snap(from));
    const end = Math.min(duration, snap(to));
    if (end - start < 2) continue;

    const position = from / n;
    let label: SectionLabel;
    let confidence: number;

    // Rising energy within the segment reads as a build.
    const rising = to - from > 3 && sm[to - 1] - sm[from] > 0.12;

    if (position < 0.12 && rel < 0.7) { label = 'intro'; confidence = 0.65; }
    else if (position > 0.85 && rel < 0.75) { label = 'outro'; confidence = 0.6; }
    else if (rel < 0.45) { label = 'breakdown'; confidence = 0.5; }
    else if (rising) { label = 'build'; confidence = 0.45; }
    else if (rel > 0.85) { label = 'drop'; confidence = 0.5; }
    else if (rel > 0.65) { label = 'chorus'; confidence = 0.3; }
    else { label = 'verse'; confidence = 0.3; }

    segments.push({ start, end, label, confidence, energy: rel });
  }

  if (!segments.length) {
    return [{ start: 0, end: duration, label: 'verse', confidence: 0.1, energy: 0.5 }];
  }
  return segments;
}

// -------------------------------------------------------------- waveform

/** Build peak + 3-band data at a given bin size. */
export function buildWaveform(channels: Float32Array[], sampleRate: number, bins: number): WaveformData {
  const mono = toMono(channels);
  const binSize = Math.max(1, Math.floor(mono.length / bins));
  const count = Math.max(1, Math.floor(mono.length / binSize));

  // Cheap 3-band split via cascaded one-pole filters. We only need relative
  // band energy for colouring, not a surgical crossover.
  const low = new Float32Array(count);
  const mid = new Float32Array(count);
  const high = new Float32Array(count);
  const peak = new Float32Array(count);

  const lowCoef = Math.exp((-2 * Math.PI * 200) / sampleRate);
  const highCoef = Math.exp((-2 * Math.PI * 2000) / sampleRate);
  let lp1 = 0;
  let lp2 = 0;

  for (let b = 0; b < count; b++) {
    const base = b * binSize;
    const end = Math.min(mono.length, base + binSize);
    let p = 0;
    let lAcc = 0;
    let mAcc = 0;
    let hAcc = 0;
    for (let i = base; i < end; i++) {
      const s = mono[i];
      const a = Math.abs(s);
      if (a > p) p = a;
      lp1 = s + lowCoef * (lp1 - s);   // < 200 Hz
      lp2 = s + highCoef * (lp2 - s);  // < 2 kHz
      const lowS = lp1;
      const midS = lp2 - lp1;
      const highS = s - lp2;
      lAcc += lowS * lowS;
      mAcc += midS * midS;
      hAcc += highS * highS;
    }
    const len = Math.max(1, end - base);
    peak[b] = p;
    low[b] = Math.sqrt(lAcc / len);
    mid[b] = Math.sqrt(mAcc / len);
    high[b] = Math.sqrt(hAcc / len);
  }

  for (const band of [low, mid, high]) {
    let max = 0;
    for (let i = 0; i < count; i++) max = Math.max(max, band[i]);
    if (max > 0) for (let i = 0; i < count; i++) band[i] /= max;
  }

  return { binSize, peak, low, mid, high };
}
