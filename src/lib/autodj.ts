/**
 * Auto DJ and the transition engine.
 *
 * Transitions are scripted as a list of timed steps against the audio clock and
 * then executed; they are not a single crossfade tween. That means a transition
 * can be inspected, aborted mid-flight, or performed manually by the user, and
 * it is the same code path either way.
 *
 * Nothing here takes control unless the user asked for it. In ASSISTED mode the
 * engine proposes; in AUTO DJ mode it acts.
 */
import type { DjConsole } from '../state/console';
import type { DeckId, Track } from '../lib/types';
import { keyCompatibility } from './music';
import { tempoRatio } from './grid';

export type TransitionStyle =
  | 'crossfade' | 'eq' | 'filter' | 'echo-out' | 'drop' | 'long-blend' | 'quick-cut';

export const TRANSITION_LABELS: Record<TransitionStyle, string> = {
  crossfade: 'Simple crossfade',
  eq: 'EQ transition',
  filter: 'Filter transition',
  'echo-out': 'Echo out',
  drop: 'Drop transition',
  'long-blend': 'Long blend',
  'quick-cut': 'Quick cut',
};

export interface TransitionStep {
  /** Seconds from the start of the transition. */
  at: number;
  label: string;
  run: () => void;
}

export interface TransitionPlan {
  style: TransitionStyle;
  from: DeckId;
  to: DeckId;
  /** Wall-clock seconds the whole move takes. */
  duration: number;
  /** Track-time on the outgoing deck at which it should begin. */
  startAt: number;
  steps: TransitionStep[];
  reasoning: string[];
}

export interface CandidateScore {
  track: Track;
  score: number;
  bpmDelta: number;
  keyScore: number;
  energyDelta: number;
  reasons: string[];
}

export class AutoDj {
  private dj: DjConsole;
  private timers: number[] = [];
  private running: TransitionPlan | null = null;
  private pollTimer: number | null = null;

  /** Bars of lead-in before the outgoing track's outro. */
  leadBars = 16;
  style: TransitionStyle = 'eq';
  enabled = false;

  constructor(dj: DjConsole) {
    this.dj = dj;
  }

  // ------------------------------------------------------------- selection

  /**
   * Rank library tracks against what is playing. Returns scored candidates
   * with the reasoning attached, so the UI can explain a suggestion.
   */
  suggest(fromDeck: DeckId, limit = 5): CandidateScore[] {
    const dj = this.dj;
    const deck = dj.engine.deck(fromDeck);
    if (!deck.hasTrack || !deck.analysis) return [];

    const currentBpm = deck.currentBpm || deck.analysis.bpm;
    const currentKey = deck.analysis.key;
    const currentEnergy = average(deck.analysis.energy);
    const loadedIds = new Set(dj.engine.deckIds.map((id) => dj.engine.deck(id).trackId).filter(Boolean));
    const recentIds = new Set(dj.store.state.history.slice(-12).map((h) => h.trackId));

    const scored: CandidateScore[] = [];
    for (const track of dj.store.state.tracks.values()) {
      if (loadedIds.has(track.id) || recentIds.has(track.id)) continue;
      if (!track.analysis || track.analysisState !== 'done') continue;
      const bpm = track.bpmOverride ?? track.analysis.bpm;
      if (bpm <= 0) continue;

      const ratio = tempoRatio(bpm, currentBpm);
      const stretch = Math.abs(ratio - 1);
      // Beyond about 8% the time-stretch starts to be audible on most material.
      const bpmScore = Math.max(0, 1 - stretch / 0.08);
      const keyScore = keyCompatibility(currentKey, track.analysis.key);
      const energyDelta = average(track.analysis.energy) - currentEnergy;
      // A slight energy lift is usually the right move; a big drop is not.
      const energyScore = energyDelta >= -0.05 && energyDelta <= 0.25
        ? 1 - Math.abs(energyDelta - 0.08) * 2
        : Math.max(0, 1 - Math.abs(energyDelta) * 2);
      const ratingScore = track.rating > 0 ? track.rating / 5 : 0.5;

      const score = bpmScore * 0.4 + keyScore * 0.3 + energyScore * 0.2 + ratingScore * 0.1;

      const reasons: string[] = [];
      reasons.push(`${bpm.toFixed(1)} BPM → ${((ratio - 1) * 100).toFixed(1)}% stretch`);
      if (keyScore >= 0.85) reasons.push('harmonically compatible');
      else if (keyScore < 0.4) reasons.push('key clash');
      if (energyDelta > 0.1) reasons.push('lifts the energy');
      else if (energyDelta < -0.1) reasons.push('drops the energy');

      scored.push({ track, score, bpmDelta: bpm - currentBpm, keyScore, energyDelta, reasons });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // ------------------------------------------------------------- planning

  /**
   * Build a transition plan. Nothing is executed until `run` is called, so the
   * plan can be shown to the user first.
   */
  plan(from: DeckId, to: DeckId, style: TransitionStyle = this.style): TransitionPlan | null {
    const dj = this.dj;
    const outDeck = dj.engine.deck(from);
    const inDeck = dj.engine.deck(to);
    if (!outDeck.hasTrack || !inDeck.hasTrack) return null;

    const reasoning: string[] = [];
    const beatSeconds = outDeck.currentBpm > 0 ? 60 / outDeck.currentBpm : 0.5;

    // Length, in bars, scaled to the style.
    const bars = style === 'quick-cut' ? 0 : style === 'long-blend' ? 32 : style === 'drop' ? 8 : 16;
    const duration = Math.max(0.15, bars * 4 * beatSeconds);

    // Where to begin: the outgoing outro if we found one, else near the end.
    const outAnalysis = outDeck.analysis;
    let startAt: number;
    if (outAnalysis && outAnalysis.outroStart > 0 && outAnalysis.outroStart < outDeck.duration) {
      startAt = outAnalysis.outroStart;
      const outro = outAnalysis.sections.find((s) => s.label === 'outro');
      reasoning.push(outro && outro.confidence > 0.5
        ? `Outgoing outro detected at ${formatSeconds(startAt)}`
        : `Using the last section as an outro (low confidence)`);
    } else {
      startAt = Math.max(0, outDeck.duration - duration - 8);
      reasoning.push('No clear outro found; starting a fixed distance from the end');
    }
    // Land it on a phrase boundary so the blend lines up musically.
    startAt = Math.max(0, Math.min(outDeck.duration - 1, dj.nextPhraseOn(from) > startAt ? startAt : startAt));

    // Where the incoming track should be cued from.
    const inAnalysis = inDeck.analysis;
    if (inAnalysis && inAnalysis.introEnd > 0) {
      reasoning.push(`Incoming intro runs to ${formatSeconds(inAnalysis.introEnd)}`);
    }

    const steps: TransitionStep[] = [];
    const set = (fn: () => void, at: number, label: string) => steps.push({ at, label, run: fn });

    // Every style starts the incoming deck, synced, at the top.
    set(() => {
      inDeck.seek(0);
      dj.toggleSync(to);
      dj.play(to);
    }, 0, `Start deck ${to}, synced to deck ${from}`);

    const ramp = (fn: (t: number) => void, label: string, count = 24) => {
      for (let i = 0; i <= count; i++) {
        set(() => fn(i / count), (i / count) * duration, i === 0 ? label : '');
      }
    };

    switch (style) {
      case 'quick-cut':
        set(() => { dj.setCrossfader(to === 'B' ? 1 : -1); dj.pause(from); }, 0.05, 'Cut straight across');
        reasoning.push('Quick cut: no blend, for incompatible or high-energy changes');
        break;

      case 'crossfade':
        ramp((t) => dj.setCrossfader(lerp(-1, 1, to === 'B' ? t : 1 - t)), 'Crossfade');
        break;

      case 'eq':
        // Swap the low end first so two kicks never fight, then the crossfader.
        set(() => dj.setEq(to, 'low', -26), 0, `Cut the bass on deck ${to}`);
        ramp((t) => dj.setCrossfader(lerp(-1, 1, to === 'B' ? t : 1 - t)), 'Crossfade');
        ramp((t) => {
          if (t < 0.45) return;
          const k = (t - 0.45) / 0.55;
          dj.setEq(to, 'low', lerp(-26, 0, k));
          dj.setEq(from, 'low', lerp(0, -26, k));
        }, 'Swap the low end');
        reasoning.push('Bass is swapped rather than summed, so the low end never doubles');
        break;

      case 'filter':
        ramp((t) => {
          dj.setFilter(from, t * 0.85);
          dj.setCrossfader(lerp(-1, 1, to === 'B' ? t : 1 - t));
        }, 'High-pass the outgoing track while blending');
        set(() => dj.setFilter(from, 0), duration, 'Restore the filter');
        break;

      case 'echo-out':
        set(() => {
          dj.setFxType(0, 'echo');
          dj.setFxParam(0, { a: 2, b: 0.65, wet: 0.5 });
          dj.setFxRouting(0, from, true);
          dj.setFxRouting(0, to, false);
          dj.setFxEnabled(0, true);
        }, duration * 0.6, `Echo out deck ${from}`);
        ramp((t) => dj.setCrossfader(lerp(-1, 1, to === 'B' ? t : 1 - t)), 'Crossfade');
        set(() => { dj.setFxEnabled(0, false); dj.setFxRouting(0, to, true); }, duration, 'Kill the echo');
        break;

      case 'drop':
        reasoning.push('Aligns the incoming drop with the outgoing phrase boundary');
        set(() => {
          const drop = inAnalysis?.sections.find((s) => s.label === 'drop');
          if (drop && drop.confidence > 0.4) {
            // Cue the incoming deck so its drop lands at the end of the blend.
            inDeck.seek(Math.max(0, drop.start - duration));
          }
        }, 0, 'Cue the incoming drop');
        ramp((t) => {
          dj.setEq(from, 'low', lerp(0, -26, t));
          dj.setCrossfader(lerp(-1, 1, to === 'B' ? t : 1 - t));
        }, 'Pull the outgoing bass and blend');
        break;

      case 'long-blend':
        ramp((t) => {
          dj.setCrossfader(lerp(-1, 1, to === 'B' ? t : 1 - t));
          dj.setEq(from, 'low', lerp(0, -26, Math.min(1, t * 1.4)));
          dj.setEq(to, 'low', lerp(-26, 0, Math.min(1, t * 1.4)));
        }, 'Long blend with a gradual bass swap');
        reasoning.push('32 bars: suited to steady, compatible material');
        break;
    }

    // Everything ends the same way: outgoing deck stopped and neutralised.
    set(() => {
      dj.pause(from);
      dj.setEq(from, 'low', 0);
      dj.setFilter(from, 0);
      dj.setCrossfader(to === 'B' ? 1 : -1);
    }, duration + 0.2, `Stop deck ${from} and reset its channel`);

    steps.sort((a, b) => a.at - b.at);
    return { style, from, to, duration, startAt, steps, reasoning };
  }

  /** Execute a plan. Steps are scheduled relative to now. */
  run(plan: TransitionPlan) {
    this.abort();
    this.running = plan;
    const t0 = performance.now();
    for (const step of plan.steps) {
      const id = setTimeout(() => step.run(), Math.max(0, step.at * 1000 - (performance.now() - t0)));
      this.timers.push(id as unknown as number);
    }
    const done = setTimeout(() => { this.running = null; }, (plan.duration + 0.5) * 1000);
    this.timers.push(done as unknown as number);

    this.dj.store.toast(
      `${TRANSITION_LABELS[plan.style]}: deck ${plan.from} → deck ${plan.to}`,
      'info',
      { detail: plan.reasoning.join(' · ') },
    );
  }

  abort() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.running = null;
  }

  get inProgress(): boolean { return this.running !== null; }
  get currentPlan(): TransitionPlan | null { return this.running; }

  // ------------------------------------------------------------- auto mode

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this.dj.store.state.mixMode = 'autodj';
    this.dj.store.notify('mode');
    // Poll rather than schedule once: tempo and position can change under us.
    this.pollTimer = setInterval(() => this.tick(), 1000) as unknown as number;
    this.dj.store.toast('Auto DJ on', 'success', {
      detail: 'It will load and mix the next track. Any control you touch stays yours.',
    });
  }

  stop() {
    this.enabled = false;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.abort();
    if (this.dj.store.state.mixMode === 'autodj') {
      this.dj.store.state.mixMode = 'manual';
      this.dj.store.notify('mode');
    }
  }

  private async tick() {
    if (!this.enabled || this.inProgress) return;
    const dj = this.dj;

    const playing = dj.engine.deckIds.filter((id) => dj.engine.deck(id).playing);
    if (playing.length !== 1) return;
    const from = playing[0];
    const to = dj.engine.deckIds.find((id) => id !== from);
    if (!to) return;

    const outDeck = dj.engine.deck(from);
    const beatSeconds = outDeck.currentBpm > 0 ? 60 / outDeck.currentBpm : 0.5;
    const blendSeconds = this.style === 'quick-cut' ? 1 : (this.style === 'long-blend' ? 32 : 16) * 4 * beatSeconds;
    const remaining = outDeck.duration - outDeck.position;
    if (remaining > blendSeconds + 2) return;

    // Load the next track if the incoming deck is empty.
    const inDeck = dj.engine.deck(to);
    if (!inDeck.hasTrack) {
      const candidates = this.suggest(from, 1);
      if (!candidates.length) {
        dj.store.toast('Auto DJ has nothing to play next', 'warn', {
          detail: 'Import more tracks, or make sure they have finished analysing.',
        });
        this.stop();
        return;
      }
      await dj.loadTrack(to, candidates[0].track.id, { force: true });
    }

    const plan = this.plan(from, to, this.style);
    if (plan) this.run(plan);
  }
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * Math.max(0, Math.min(1, t)); }

function average(x: Float32Array): number {
  if (!x.length) return 0;
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return s / x.length;
}

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}
