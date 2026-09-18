import { describe, it, expect } from 'vitest';
import {
  findBestTransition, describeSection, sectionAt, energyAt, describeTransition,
  formatCountdown, chooseBlendLength,
  type TrackSide,
} from '../src/lib/transition-points';
import type { Analysis, BeatGrid, Section, SectionLabel } from '../src/lib/types';

const BPM = 128;
const BEAT = 60 / BPM;
const PHRASE = BEAT * 64; // 16 bars ~= 30 s

function grid(bpm = BPM): BeatGrid {
  return { firstBeat: 0, bpm, downbeatOffset: 0, locked: false };
}

/** Build an analysis object with a given shape of sections and energy. */
function analysis(
  duration: number,
  sections: { label: SectionLabel; start: number; end: number; energy: number; confidence?: number }[],
): Analysis {
  const energy = new Float32Array(Math.ceil(duration));
  for (let s = 0; s < energy.length; s++) {
    const section = sections.find((x) => s >= x.start && s < x.end);
    energy[s] = section ? section.energy : 0.5;
  }
  const full: Section[] = sections.map((x) => ({
    start: x.start, end: x.end, label: x.label,
    confidence: x.confidence ?? 0.7, energy: x.energy,
  }));
  const intro = full.find((x) => x.label === 'intro');
  const outro = [...full].reverse().find((x) => x.label === 'outro');
  const empty = { binSize: 1, peak: new Float32Array(1), low: new Float32Array(1), mid: new Float32Array(1), high: new Float32Array(1) };
  return {
    version: 3, duration, sampleRate: 44100,
    bpm: BPM, bpmConfidence: 1, bpmAlternatives: [],
    beatGrid: grid(), beats: new Float32Array(0), downbeats: new Float32Array(0),
    key: null, keyConfidence: 0, loudness: -14, peak: 0.9,
    energy, sections: full,
    introEnd: intro ? intro.end : 0,
    outroStart: outro ? outro.start : duration,
    waveform: empty, overview: empty,
  };
}

/** A conventional dance track: quiet intro, body, drop, quiet outro. */
function typicalTrack(duration = 300): TrackSide {
  const a = analysis(duration, [
    { label: 'intro', start: 0, end: 30, energy: 0.25 },
    { label: 'build', start: 30, end: 60, energy: 0.55 },
    { label: 'drop', start: 60, end: 150, energy: 0.95 },
    { label: 'breakdown', start: 150, end: 180, energy: 0.35 },
    { label: 'chorus', start: 180, end: 250, energy: 0.85 },
    { label: 'outro', start: 250, end: duration, energy: 0.3 },
  ]);
  return { analysis: a, grid: grid(), duration };
}

describe('section lookup', () => {
  const t = typicalTrack();

  it('finds the section containing a moment', () => {
    expect(sectionAt(t.analysis, 10)?.label).toBe('intro');
    expect(sectionAt(t.analysis, 100)?.label).toBe('drop');
    expect(sectionAt(t.analysis, 260)?.label).toBe('outro');
  });

  it('describes sections in words a beginner can read', () => {
    expect(describeSection(t.analysis, 10)).toBe('the intro');
    expect(describeSection(t.analysis, 100)).toBe('the drop');
    expect(describeSection(t.analysis, 165)).toBe('the quiet part');
  });

  it('hedges when the label is not trusted', () => {
    const vague = analysis(120, [{ label: 'drop', start: 0, end: 120, energy: 0.9, confidence: 0.2 }]);
    // A guess should not be stated as though it were a fact.
    expect(describeSection(vague, 60)).not.toBe('the drop');
    expect(describeSection(vague, 60)).toMatch(/calmer/);
  });

  it('reads energy at a moment', () => {
    expect(energyAt(t.analysis, 10)).toBeCloseTo(0.25, 5);
    expect(energyAt(t.analysis, 100)).toBeCloseTo(0.95, 5);
  });

  it('survives a moment outside the track', () => {
    expect(energyAt(t.analysis, -5)).toBeGreaterThanOrEqual(0);
    expect(energyAt(t.analysis, 99999)).toBeGreaterThanOrEqual(0);
  });
});

describe('finding the best place to join two tracks', () => {
  it('plays most of the outgoing track before mixing out of it', () => {
    const point = findBestTransition(typicalTrack(), typicalTrack(), { position: 10 });
    expect(point).not.toBeNull();
    // Mixing out at the halfway mark throws away half the song. A long wait
    // before the blend is the correct outcome, not an impatience to fix.
    expect(point!.exitAt).toBeGreaterThan(300 * 0.6);
    expect(point!.exitAt).toBeLessThan(300);
  });

  it('is not put off by a long wait', () => {
    // A ten-minute track whose outro starts at nine minutes should be blended
    // at nine minutes, however far away that is.
    const long: TrackSide = {
      duration: 600,
      grid: grid(),
      analysis: analysis(600, [
        { label: 'intro', start: 0, end: 30, energy: 0.3 },
        { label: 'drop', start: 30, end: 540, energy: 0.95 },
        { label: 'outro', start: 540, end: 600, energy: 0.3 },
      ]),
    };
    const point = findBestTransition(long, typicalTrack(), { position: 5 })!;
    expect(point.exitAt).toBeGreaterThan(500);
  });

  it('prefers leaving during the outro over leaving during the drop', () => {
    const point = findBestTransition(typicalTrack(), typicalTrack(), { position: 10 })!;
    const section = sectionAt(typicalTrack().analysis, point.exitAt);
    expect(['outro', 'breakdown']).toContain(section!.label);
  });

  it('brings the new track in at or near the start', () => {
    const point = findBestTransition(typicalTrack(), typicalTrack(), { position: 10 })!;
    // Coming in past the first third throws most of the track away.
    expect(point.entryAt).toBeLessThanOrEqual(300 * 0.35 + 1);
    expect(point.entryAt).toBeGreaterThanOrEqual(0);
  });

  it('lands the join on a phrase boundary of both tracks', () => {
    const point = findBestTransition(typicalTrack(), typicalTrack(), { position: 10 })!;
    const g = grid();
    const phraseOf = (t: number) => (t - g.firstBeat) / (60 / g.bpm) / 64;
    expect(Math.abs(phraseOf(point.exitAt) - Math.round(phraseOf(point.exitAt)))).toBeLessThan(1e-6);
    expect(Math.abs(phraseOf(point.entryAt) - Math.round(phraseOf(point.entryAt)))).toBeLessThan(1e-6);
  });

  it('never proposes a join before the playhead', () => {
    for (const position of [0, 60, 150, 240]) {
      const point = findBestTransition(typicalTrack(), typicalTrack(), { position });
      if (point) expect(point.exitAt).toBeGreaterThan(position);
    }
  });

  it('leaves time to set the blend up', () => {
    const point = findBestTransition(typicalTrack(), typicalTrack(), { position: 100, minLeadSeconds: 20 })!;
    expect(point.exitAt - 100).toBeGreaterThanOrEqual(20);
  });

  it('leaves enough of the new track worth playing', () => {
    const incoming = typicalTrack(200);
    const point = findBestTransition(typicalTrack(), incoming, { position: 10, minRunwaySeconds: 60 })!;
    expect(incoming.duration - point.entryAt).toBeGreaterThanOrEqual(60);
  });

  it('explains itself in plain words', () => {
    const point = findBestTransition(typicalTrack(), typicalTrack(), { position: 10 })!;
    expect(point.reasons.length).toBeGreaterThan(0);
    for (const reason of point.reasons) {
      expect(reason.length).toBeGreaterThan(8);
      // No jargon, no numbers-as-explanation.
      expect(reason).not.toMatch(/BPM|LUFS|phase|autocorrelation/i);
    }
    expect(point.exitDescription.length).toBeGreaterThan(3);
    expect(point.entryDescription.length).toBeGreaterThan(3);
  });

  it('gives a blend length in a musically sensible range', () => {
    const point = findBestTransition(typicalTrack(), typicalTrack(), { position: 10 })!;
    // Between 4 and 32 bars at this tempo.
    expect(point.blendSeconds).toBeGreaterThan(BEAT * 16 - 0.01);
    expect(point.blendSeconds).toBeLessThan(BEAT * 128 + 0.01);
  });

  it('picks a blend length from the energy gap', () => {
    // Tested directly: which exit point wins varies with the material, so
    // comparing two whole plans would not isolate this decision.
    const phrase = 30;
    expect(chooseBlendLength(phrase, 0.5, false)).toBeLessThan(chooseBlendLength(phrase, 0.25, false));
    expect(chooseBlendLength(phrase, 0.25, false)).toBeLessThan(chooseBlendLength(phrase, 0.05, true));
    // A big jump gets a short blend so the two tracks do not fight.
    expect(chooseBlendLength(phrase, 0.5, false)).toBeLessThanOrEqual(phrase * 0.3);
    // Two calm, compatible tracks get the long one.
    expect(chooseBlendLength(phrase, 0.05, true)).toBe(phrase);
  });

  it('keeps every blend length musically sensible', () => {
    const phrase = 30;
    for (const gap of [0, 0.1, 0.2, 0.3, 0.4, 0.8]) {
      for (const winding of [true, false]) {
        const length = chooseBlendLength(phrase, gap, winding);
        expect(length).toBeGreaterThanOrEqual(phrase * 0.25);
        expect(length).toBeLessThanOrEqual(phrase);
      }
    }
  });

  it('returns null when a track has no beat grid', () => {
    const noGrid: TrackSide = { ...typicalTrack(), grid: { firstBeat: 0, bpm: 0, downbeatOffset: 0, locked: false } };
    expect(findBestTransition(noGrid, typicalTrack(), { position: 0 })).toBeNull();
    expect(findBestTransition(typicalTrack(), noGrid, { position: 0 })).toBeNull();
  });

  it('returns null rather than a bad answer when the track has run out', () => {
    // Two seconds left and ten seconds of lead-in required.
    expect(findBestTransition(typicalTrack(), typicalTrack(), { position: 298 })).toBeNull();
  });

  it('still finds a join in a short track', () => {
    const short = typicalTrack(90);
    const point = findBestTransition(short, short, { position: 0, minRunwaySeconds: 20 });
    expect(point).not.toBeNull();
    expect(point!.exitAt).toBeGreaterThan(0);
    expect(point!.exitAt).toBeLessThan(90);
  });

  it('prefers an entry where the new track lifts soon afterwards', () => {
    // Same track twice: the planner should still pick an entry with a build
    // or drop arriving within a couple of phrases.
    const point = findBestTransition(typicalTrack(), typicalTrack(), { position: 10 })!;
    const after = typicalTrack().analysis.sections.find(
      (s) => s.start > point.entryAt && s.start < point.entryAt + PHRASE * 2 && (s.label === 'build' || s.label === 'drop'),
    );
    expect(after).toBeDefined();
  });

  it('scores a sensible join higher than a terrible one', () => {
    const good = findBestTransition(typicalTrack(), typicalTrack(), { position: 10 })!;
    expect(good.score).toBeGreaterThan(0.5);
    expect(good.score).toBeLessThanOrEqual(1);
  });
});

describe('describing a transition', () => {
  it('produces one readable sentence', () => {
    const point = findBestTransition(typicalTrack(), typicalTrack(), { position: 10 })!;
    const sentence = describeTransition(point, 'First Song', 'Second Song');
    expect(sentence).toContain('First Song');
    expect(sentence).toContain('Second Song');
    expect(sentence.endsWith('.')).toBe(true);
    expect(sentence.length).toBeLessThan(200);
  });
});

describe('countdown formatting', () => {
  it('formats minutes and seconds', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(9)).toBe('0:09');
    expect(formatCountdown(83)).toBe('1:23');
    expect(formatCountdown(600)).toBe('10:00');
  });

  it('never shows a negative countdown', () => {
    expect(formatCountdown(-5)).toBe('0:00');
  });
});
