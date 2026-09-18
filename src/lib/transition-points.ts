/**
 * Finding the best place to join two tracks.
 *
 * This is the part that makes "do it for me" mean something. A crossfade at an
 * arbitrary moment sounds like a crossfade at an arbitrary moment; a good DJ
 * leaves the first track where it is winding down and brings the second in
 * where it is ready to take over. That decision is what this module makes.
 *
 * It scores every sensible pair of (leave the old track here, start the new
 * track there), using the section labels, energy curve and beat grid the
 * analyser produced, and returns the winner with the reasoning in plain words
 * so the interface can say *why* rather than just doing something.
 */
import type { Analysis, BeatGrid, Section, SectionLabel } from './types';
import { beatAt, timeAtBeat } from './grid';

export interface TrackSide {
  analysis: Analysis;
  grid: BeatGrid;
  duration: number;
}

export interface TransitionPoint {
  /** Track-time on the outgoing deck where the blend should begin. */
  exitAt: number;
  /** Track-time the incoming track should be cued to. */
  entryAt: number;
  /** How long the blend should last, in seconds. */
  blendSeconds: number;
  /** 0..1, how good this join looks. */
  score: number;
  /** Plain-language explanation, safe to show a beginner. */
  reasons: string[];
  /** Where in each track the join happens, in friendly words. */
  exitDescription: string;
  entryDescription: string;
}

/** Friendly names for the analyser's section labels. */
const SECTION_WORDS: Record<SectionLabel, string> = {
  intro: 'the intro',
  build: 'the build-up',
  drop: 'the drop',
  verse: 'a verse',
  chorus: 'the main part',
  breakdown: 'the quiet part',
  outro: 'the outro',
};

export function describeSection(analysis: Analysis, at: number): string {
  const section = sectionAt(analysis, at);
  if (!section) return 'the track';
  // Low-confidence labels are hedged rather than stated as fact.
  return section.confidence < 0.4 ? `a calmer stretch` : SECTION_WORDS[section.label];
}

export function sectionAt(analysis: Analysis, at: number): Section | null {
  for (const s of analysis.sections) {
    if (at >= s.start && at < s.end) return s;
  }
  return analysis.sections[analysis.sections.length - 1] ?? null;
}

/** Energy at a moment, 0..1. The curve holds one value per second. */
export function energyAt(analysis: Analysis, at: number): number {
  if (!analysis.energy.length) return 0.5;
  const i = Math.max(0, Math.min(analysis.energy.length - 1, Math.round(at)));
  return analysis.energy[i];
}

/** Phrase boundaries between two times, as track-time seconds. */
function phraseBoundaries(
  grid: BeatGrid, from: number, to: number, phraseBeats: number, limit = 64,
): number[] {
  if (grid.bpm <= 0 || to <= from) return [];
  const out: number[] = [];
  const startPhrase = Math.ceil((beatAt(grid, from) - grid.downbeatOffset) / phraseBeats);
  const endPhrase = Math.floor((beatAt(grid, to) - grid.downbeatOffset) / phraseBeats);
  for (let p = startPhrase; p <= endPhrase && out.length < limit; p++) {
    out.push(timeAtBeat(grid, p * phraseBeats + grid.downbeatOffset));
  }
  return out;
}

export interface FindOptions {
  /** Where the outgoing deck is right now. */
  position: number;
  /** Beats per phrase, usually 64 (16 bars). */
  phraseBeats: number;
  /** Don't propose a blend starting sooner than this - there must be time. */
  minLeadSeconds: number;
  /** Shortest amount of the incoming track worth playing after the join. */
  minRunwaySeconds: number;
}

const DEFAULTS: Omit<FindOptions, 'position'> = {
  phraseBeats: 64,
  minLeadSeconds: 10,
  minRunwaySeconds: 45,
};

/**
 * Pick the best place to join two tracks.
 *
 * Returns null only when the tracks have no usable beat grid, or the outgoing
 * one has already run out of room. Callers should fall back to a plain
 * crossfade in that case rather than refusing to mix.
 */
export function findBestTransition(
  outgoing: TrackSide,
  incoming: TrackSide,
  opts: Partial<FindOptions> & { position: number },
): TransitionPoint | null {
  const o = { ...DEFAULTS, ...opts };
  if (outgoing.grid.bpm <= 0 || incoming.grid.bpm <= 0) return null;

  const beatSeconds = 60 / outgoing.grid.bpm;
  const phraseSeconds = beatSeconds * o.phraseBeats;

  // ---- candidate exit points on the outgoing track -----------------------
  // Leave enough room after the blend that we are not cut off by the end.
  const latestExit = outgoing.duration - phraseSeconds * 0.5;
  const earliestExit = o.position + o.minLeadSeconds;
  let exits = phraseBoundaries(outgoing.grid, earliestExit, latestExit, o.phraseBeats);

  // Half-phrase resolution as a fallback when the track is too short to offer
  // several full phrases.
  if (exits.length < 2) {
    exits = phraseBoundaries(outgoing.grid, earliestExit, latestExit, o.phraseBeats / 2);
  }
  if (!exits.length) return null;

  // ---- candidate entry points on the incoming track ----------------------
  // A track is normally brought in at its start or just after the intro;
  // coming in past the first third means throwing most of it away.
  const latestEntry = Math.min(
    incoming.duration - o.minRunwaySeconds,
    Math.max(incoming.analysis.introEnd + phraseSeconds * 2, incoming.duration * 0.35),
  );
  let entries = phraseBoundaries(incoming.grid, 0, Math.max(0, latestEntry), o.phraseBeats);
  if (!entries.length) entries = [0];
  // Starting from the very top is always worth considering.
  if (entries[0] > 0.01) entries.unshift(0);

  // ---- score every pair --------------------------------------------------
  let best: TransitionPoint | null = null;

  for (const exitAt of exits) {
    const exitScore = scoreExit(outgoing, exitAt, o.position);
    for (const entryAt of entries) {
      const runway = incoming.duration - entryAt;
      if (runway < o.minRunwaySeconds) continue;

      const entryScore = scoreEntry(incoming, entryAt, phraseSeconds);
      const pairScore = scorePair(outgoing, exitAt, incoming, entryAt);

      const total = exitScore.score * 0.4 + entryScore.score * 0.35 + pairScore.score * 0.25;
      if (best && total <= best.score) continue;

      const energyGap = Math.abs(
        energyAt(outgoing.analysis, exitAt) - energyAt(incoming.analysis, entryAt),
      );
      best = {
        exitAt,
        entryAt,
        blendSeconds: chooseBlendLength(phraseSeconds, energyGap, exitScore.winding),
        score: total,
        reasons: [...exitScore.reasons, ...entryScore.reasons, ...pairScore.reasons],
        exitDescription: describeSection(outgoing.analysis, exitAt),
        entryDescription: describeSection(incoming.analysis, entryAt),
      };
    }
  }

  return best;
}

interface PartialScore { score: number; reasons: string[] }

/**
 * How good a place this is to leave the outgoing track.
 *
 * Wants: near the end but not at it, energy coming down, ideally inside an
 * outro or a quiet passage. Mixing out of a drop is possible but it takes a
 * hard cut, and that is not what "do it for me" should choose by default.
 */
function scoreExit(
  side: TrackSide, at: number, position: number,
): PartialScore & { winding: boolean } {
  const reasons: string[] = [];
  const { analysis, duration } = side;

  const through = duration > 0 ? at / duration : 0;
  // Playing 65-90% of a track before mixing out is the sweet spot.
  const positionScore = through < 0.4 ? through / 0.4 * 0.5
    : through > 0.95 ? 0.4
    : 1 - Math.abs(through - 0.8) * 1.6;

  const section = sectionAt(analysis, at);
  const energy = energyAt(analysis, at);
  // Compare against energy a phrase earlier to see whether it is falling.
  const earlier = energyAt(analysis, Math.max(0, at - 20));
  const winding = energy <= earlier + 0.02;

  let structureScore = 0.5;
  if (section) {
    switch (section.label) {
      case 'outro': structureScore = 1; break;
      case 'breakdown': structureScore = 0.85; break;
      case 'verse': structureScore = 0.7; break;
      case 'chorus': structureScore = 0.5; break;
      case 'build': structureScore = 0.25; break;  // leaving mid-build is jarring
      case 'drop': structureScore = 0.2; break;
      case 'intro': structureScore = 0.3; break;
    }
    // A label we barely trust should not swing the decision much.
    structureScore = 0.5 + (structureScore - 0.5) * Math.max(0.35, section.confidence);
  }

  const energyScore = 1 - energy * 0.5;      // calmer is easier to leave
  const windingBonus = winding ? 0.12 : 0;

  if (section?.label === 'outro' && section.confidence > 0.5) reasons.push('the first track is winding down');
  else if (section?.label === 'breakdown') reasons.push('leaving during the quiet part');
  else if (winding) reasons.push('the energy is easing off there');

  // Note there is deliberately no penalty for a long wait. Mixing out near the
  // end of a track means a long gap before anything changes, and that is
  // correct - it means the track got played. An earlier version docked points
  // for waits over four minutes to feel "responsive", and the result was that
  // it mixed out halfway through a five-minute track. Responsiveness is the
  // job of the button starting music immediately, not of cutting songs short.
  void position;

  return {
    score: Math.max(0, Math.min(1, positionScore * 0.4 + structureScore * 0.35 + energyScore * 0.25 + windingBonus)),
    reasons,
    winding,
  };
}

/**
 * How good a place this is to start the incoming track.
 *
 * Wants: at or just after the intro, quiet enough to slide underneath, with a
 * lift arriving soon afterwards so the mix goes somewhere.
 */
function scoreEntry(side: TrackSide, at: number, phraseSeconds: number): PartialScore {
  const reasons: string[] = [];
  const { analysis, duration } = side;

  const introEnd = analysis.introEnd;
  // Starting at the top, or right where the intro hands over, both read well.
  const atTop = at < 1;
  const nearIntroEnd = Math.abs(at - introEnd) < phraseSeconds;
  const positionScore = atTop ? 0.85 : nearIntroEnd ? 1 : at < duration * 0.25 ? 0.7 : 0.4;

  const energy = energyAt(analysis, at);
  // A quiet entry slides under the outgoing track instead of fighting it.
  const energyScore = 1 - energy * 0.6;

  // Is there a lift within the next couple of phrases?
  const ahead = analysis.sections.find(
    (s) => s.start > at && s.start < at + phraseSeconds * 2 && (s.label === 'drop' || s.label === 'build'),
  );
  const liftBonus = ahead ? 0.2 * Math.max(0.4, ahead.confidence) : 0;

  const runway = duration - at;
  const runwayScore = runway > 120 ? 1 : runway / 120;

  if (nearIntroEnd) reasons.push('starting the next track where its intro ends');
  else if (atTop) reasons.push('starting the next track from the beginning');
  if (ahead?.label === 'drop') reasons.push('its drop lands shortly after the blend');
  else if (ahead?.label === 'build') reasons.push('it builds straight after coming in');

  return {
    score: Math.max(0, Math.min(1, positionScore * 0.4 + energyScore * 0.3 + runwayScore * 0.3 + liftBonus)),
    reasons,
  };
}

/** How well the two moments sit together. */
function scorePair(
  outgoing: TrackSide, exitAt: number, incoming: TrackSide, entryAt: number,
): PartialScore {
  const reasons: string[] = [];
  const a = energyAt(outgoing.analysis, exitAt);
  const b = energyAt(incoming.analysis, entryAt);

  // A close match blends invisibly. A small lift is good too - that is how a
  // set builds. A big drop in energy kills the room.
  const delta = b - a;
  let score: number;
  if (delta >= -0.08 && delta <= 0.2) {
    score = 1;
    if (Math.abs(delta) < 0.08) reasons.push('both tracks are at a similar energy there');
    else reasons.push('the new track lifts the energy slightly');
  } else if (delta > 0.2) {
    score = Math.max(0.3, 1 - (delta - 0.2) * 2);
  } else {
    score = Math.max(0.2, 1 + (delta + 0.08) * 2);
    reasons.push('the new track is calmer, so the blend eases things down');
  }

  return { score, reasons };
}

/**
 * How long the blend should run.
 *
 * Similar energy and a track that is winding down can take a long, luxurious
 * blend. A jump in energy wants to be shorter so the two do not fight.
 */
export function chooseBlendLength(phraseSeconds: number, energyGap: number, winding: boolean): number {
  if (energyGap > 0.35) return phraseSeconds * 0.25;  // 4 bars
  if (energyGap > 0.2) return phraseSeconds * 0.5;    // 8 bars
  if (winding) return phraseSeconds;                  // 16 bars
  return phraseSeconds * 0.75;                        // 12 bars
}

/** One sentence a beginner can read, describing the chosen join. */
export function describeTransition(point: TransitionPoint, fromTitle: string, toTitle: string): string {
  const bars = Math.round(point.blendSeconds);
  return `Blending out of "${fromTitle}" at ${point.exitDescription} into "${toTitle}" at ${point.entryDescription}, over about ${bars} seconds.`;
}

/** Format seconds as a countdown like "1:23". */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}
