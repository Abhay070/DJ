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
import {
  findBestTransition, describeTransition, formatCountdown, energyAt,
  type TransitionPoint,
} from './transition-points';

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
  /** Track-time the incoming deck is cued to. */
  entryAt: number;
  steps: TransitionStep[];
  reasoning: string[];
  /** One sentence a beginner can read. */
  summary: string;
}

/** What the console is doing right now, for the simple view to render. */
export interface AutoStatus {
  state: 'idle' | 'playing' | 'waiting' | 'mixing';
  headline: string;
  detail: string;
  /** Seconds until the next blend, when one is scheduled. */
  countdown?: number;
  nextTitle?: string;
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
  /** The blend that is lined up but not started yet. */
  private pending: TransitionPlan | null = null;
  /** Guards against two overlapping async plan/load passes. */
  private planning = false;
  private warnedEmpty = false;

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
  /**
   * Work out where and how to join the two loaded decks.
   *
   * With no style given, both the join point and the technique are chosen
   * automatically from what the analyser found - which is what "do it for me"
   * has to mean. Passing a style overrides the technique but still uses the
   * best join point.
   */
  plan(from: DeckId, to: DeckId, style?: TransitionStyle): TransitionPlan | null {
    const dj = this.dj;
    const outDeck = dj.engine.deck(from);
    const inDeck = dj.engine.deck(to);
    if (!outDeck.hasTrack || !inDeck.hasTrack) return null;

    const reasoning: string[] = [];
    const beatSeconds = outDeck.currentBpm > 0 ? 60 / outDeck.currentBpm : 0.5;
    const phraseBeats = dj.store.state.settings.phraseBeats;

    // ---- find the best place to join --------------------------------------
    let point: TransitionPoint | null = null;
    if (outDeck.analysis && inDeck.analysis) {
      point = findBestTransition(
        { analysis: outDeck.analysis, grid: outDeck.grid, duration: outDeck.duration },
        { analysis: inDeck.analysis, grid: inDeck.grid, duration: inDeck.duration },
        { position: outDeck.position, phraseBeats },
      );
    }

    let startAt: number;
    let entryAt: number;
    let duration: number;

    if (point) {
      startAt = point.exitAt;
      entryAt = point.entryAt;
      duration = point.blendSeconds;
      reasoning.push(...point.reasons);
    } else {
      // No usable grid or analysis: fall back to a plain blend near the end
      // rather than refusing to mix.
      duration = 16 * 4 * beatSeconds;
      startAt = Math.max(outDeck.position + 5, outDeck.duration - duration - 5);
      entryAt = 0;
      reasoning.push('no beat grid on one of these tracks, so this is a straight blend');
    }

    // ---- choose the technique ---------------------------------------------
    const chosen = style ?? this.chooseStyle(from, to, startAt, entryAt);
    if (!style) reasoning.push(this.explainStyle(chosen));

    // A quick cut is not a blend, and a drop transition wants to be short.
    if (chosen === 'quick-cut') duration = Math.max(0.15, beatSeconds);
    else if (chosen === 'long-blend') duration = Math.max(duration, 32 * 4 * beatSeconds);
    else if (chosen === 'drop') duration = Math.min(duration, 8 * 4 * beatSeconds);

    const fromTitle = this.titleOf(from);
    const toTitle = this.titleOf(to);
    const summary = point
      ? describeTransition({ ...point, blendSeconds: duration }, fromTitle, toTitle)
      : `Blending "${fromTitle}" into "${toTitle}" over about ${Math.round(duration)} seconds.`;

    const steps: TransitionStep[] = [];
    const set = (fn: () => void, at: number, label: string) => steps.push({ at, label, run: fn });

    // Every style starts the incoming deck at its chosen entry point, matched
    // in tempo and beat-aligned to the deck already playing.
    set(() => {
      // Work out the in-phase start position *before* seeking, so the deck is
      // beat-matched from its first sample instead of being dragged into
      // place by the controller over the next few seconds.
      if (!dj.sync.isEnabled(to)) dj.toggleSync(to);
      inDeck.seek(dj.sync.alignedStartPosition(to, entryAt));
      dj.play(to);
    }, 0, `Start deck ${to}, matched to deck ${from}`);

    const ramp = (fn: (t: number) => void, label: string, count = 24) => {
      for (let i = 0; i <= count; i++) {
        set(() => fn(i / count), (i / count) * duration, i === 0 ? label : '');
      }
    };

    switch (chosen) {
      case 'quick-cut':
        set(() => { dj.setCrossfader(to === 'B' ? 1 : -1); dj.pause(from); }, 0.05, 'Cut straight across');
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
        set(() => {
          // Back the entry point up so the incoming drop lands exactly as the
          // blend finishes, rather than partway through it.
          const drop = inDeck.analysis?.sections.find(
            (sec) => sec.label === 'drop' && sec.start > entryAt && sec.confidence > 0.4,
          );
          if (drop) {
            const want = Math.max(0, drop.start - duration);
            inDeck.seek(dj.sync.alignedStartPosition(to, want));
          }
        }, 0, 'Line the drop up with the end of the blend');
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
    return { style: chosen, from, to, duration, startAt, entryAt, steps, reasoning, summary };
  }

  private titleOf(deckId: DeckId): string {
    const id = this.dj.engine.deck(deckId).trackId;
    return (id && this.dj.store.state.tracks.get(id)?.title) || `deck ${deckId}`;
  }

  /**
   * Pick the mixing technique from what the two tracks are doing.
   *
   * A beginner should never have to know what a "filter transition" is to get
   * a good result, so this makes the call the same way a DJ would: how far
   * apart are the tempos, do the keys clash, and is there a big jump in energy
   * at the join?
   */
  chooseStyle(from: DeckId, to: DeckId, exitAt: number, entryAt: number): TransitionStyle {
    const dj = this.dj;
    const outDeck = dj.engine.deck(from);
    const inDeck = dj.engine.deck(to);
    const outA = outDeck.analysis;
    const inA = inDeck.analysis;
    if (!outA || !inA) return 'crossfade';

    const stretch = Math.abs(tempoRatio(inDeck.grid.bpm, outDeck.currentBpm) - 1);
    const keyScore = keyCompatibility(outA.key, inA.key);
    const energyOut = energyAt(outA, exitAt);
    const energyIn = energyAt(inA, entryAt);
    const jump = energyIn - energyOut;

    // Too much stretch or a clashing key means a long blend will sound wrong
    // however carefully it is done. Get it over with.
    if (stretch > 0.09) return 'quick-cut';
    if (keyScore < 0.35 && stretch > 0.04) return 'echo-out';

    // A drop arriving right after the join is worth building towards.
    const dropAhead = inA.sections.find(
      (sec) => sec.label === 'drop' && sec.start > entryAt && sec.start < entryAt + 45 && sec.confidence > 0.4,
    );
    if (dropAhead) return 'drop';

    // A big lift needs the old track out of the way quickly.
    if (jump > 0.28) return 'echo-out';

    // Two calm, compatible tracks can take a long, slow blend.
    if (energyOut < 0.55 && Math.abs(jump) < 0.15 && stretch < 0.03 && keyScore > 0.6) return 'long-blend';

    // The workhorse: swap the bass so two kicks never fight.
    return 'eq';
  }

  /** Why that technique, in words a beginner can use. */
  explainStyle(style: TransitionStyle): string {
    switch (style) {
      case 'quick-cut': return 'their speeds are too far apart to blend, so this switches over quickly';
      case 'echo-out': return 'the old track fades out on an echo to make room';
      case 'drop': return 'timed so the new track\'s drop lands as the blend finishes';
      case 'long-blend': return 'they suit each other, so this takes a long, slow blend';
      case 'filter': return 'the old track is filtered away as the new one comes up';
      case 'crossfade': return 'a straightforward fade between the two';
      case 'eq': return 'the bass is swapped over so the two beats never muddy each other';
    }
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

  /**
   * The one button.
   *
   * Works out what should happen next from whatever state the console is in,
   * does it, and returns a sentence explaining what it did. Pressing it again
   * is always safe.
   *
   *  - nothing playing  -> start the best track, queue and prepare the next
   *  - one deck playing -> line up the next track and schedule the blend
   *  - already mixing   -> say so and leave it alone
   *
   * Everything it does is a normal console action, so any control the user
   * touches afterwards simply takes over.
   */
  async mixItForMe(): Promise<string> {
    const dj = this.dj;

    const ready = [...dj.store.state.tracks.values()].filter(
      (t) => t.analysisState === 'done' && t.analysis,
    );
    if (!ready.length) {
      const pending = dj.store.state.analysisQueue;
      return pending > 0
        ? `Still listening to your music - ${pending} track${pending === 1 ? '' : 's'} to go. Try again in a moment.`
        : 'Add some music first, then press this again.';
    }

    if (this.inProgress) return 'Already mixing - sit back.';

    const playing = dj.engine.deckIds.filter((id) => dj.engine.deck(id).playing);

    // ---- nothing playing: start the set ------------------------------------
    if (playing.length === 0) {
      const first = this.pickOpener(ready);
      const deckA = dj.engine.deckIds[0];
      await dj.loadTrack(deckA, first.id, { force: true });
      dj.setCrossfader(deckA === 'A' ? -1 : 1);
      dj.play(deckA);
      this.enable();
      const next = await this.prepareNext(deckA);
      return next
        ? `Playing "${first.title}". Next up is "${next.title}" - I'll blend them automatically.`
        : `Playing "${first.title}". Add another track and I'll mix into it.`;
    }

    // ---- two decks playing: let the running mix finish ----------------------
    if (playing.length > 1) {
      this.enable();
      return 'Both tracks are playing - I\'ll take it from here.';
    }

    // ---- one deck playing: line up the blend --------------------------------
    const from = playing[0];
    const to = dj.engine.deckIds.find((id) => id !== from)!;
    const prepared = dj.engine.deck(to).hasTrack ? null : await this.prepareNext(from);
    if (!dj.engine.deck(to).hasTrack) {
      this.enable();
      return prepared
        ? `Lined up "${prepared.title}".`
        : 'Nothing suitable to play next yet - add a few more tracks.';
    }

    this.enable();
    const plan = this.plan(from, to);
    if (!plan) return 'I could not find a good place to blend these two.';

    this.pending = plan;
    const wait = plan.startAt - dj.engine.deck(from).position;
    return wait > 1
      ? `${plan.summary} Starting in ${formatCountdown(wait)}.`
      : `${plan.summary} Starting now.`;
  }

  /**
   * The first track of a set: the best-rated analysed track, preferring
   * something that starts gently rather than dropping straight in.
   */
  private pickOpener(ready: Track[]): Track {
    const scored = ready.map((t) => {
      const a = t.analysis!;
      const opensGently = a.sections[0]?.label === 'intro' ? 0.2 : 0;
      const rating = t.rating > 0 ? t.rating / 5 : 0.5;
      const unplayed = t.playCount === 0 ? 0.15 : 0;
      return { t, score: rating * 0.6 + opensGently + unplayed };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].t;
  }

  /**
   * Load the best next track onto the free deck and match its tempo, so it is
   * ready to go before the blend is due.
   */
  async prepareNext(fromDeck: DeckId): Promise<Track | null> {
    const dj = this.dj;
    const to = dj.engine.deckIds.find((id) => id !== fromDeck);
    if (!to || dj.engine.deck(to).hasTrack) return null;

    const candidates = this.suggest(fromDeck, 1);
    if (!candidates.length) return null;

    const track = candidates[0].track;
    await dj.loadTrack(to, track.id, { force: true });
    // Match tempo now so the deck is ready; phase is aligned when it starts.
    if (!dj.sync.isEnabled(to)) dj.toggleSync(to);
    return track;
  }

  /**
   * Blend into the next track right now, instead of waiting for the planned
   * moment. The join point is still chosen properly - only the timing changes.
   */
  async blendNow(): Promise<string> {
    const dj = this.dj;
    if (this.inProgress) return 'Already mixing.';

    const playing = dj.engine.deckIds.filter((id) => dj.engine.deck(id).playing);
    if (playing.length !== 1) return 'Start a track first.';
    const from = playing[0];
    const to = dj.engine.deckIds.find((id) => id !== from)!;

    if (!dj.engine.deck(to).hasTrack) {
      const next = await this.prepareNext(from);
      if (!next) return 'Nothing queued up to blend into.';
    }

    const plan = this.plan(from, to);
    if (!plan) return 'I could not work out how to blend these two.';
    this.pending = null;
    this.run(plan);
    return `Blending into "${this.titleOf(to)}" now.`;
  }

  /**
   * Jump straight to the next track. This is a cut, not a blend - it is what
   * "skip" means, and pretending otherwise would just delay the music.
   */
  async skip(): Promise<string> {
    const dj = this.dj;
    const playing = dj.engine.deckIds.filter((id) => dj.engine.deck(id).playing);
    if (!playing.length) return this.mixItForMe();
    const from = playing[0];
    const to = dj.engine.deckIds.find((id) => id !== from)!;

    if (!dj.engine.deck(to).hasTrack) {
      const next = await this.prepareNext(from);
      if (!next) return 'Nothing else to play.';
    }

    const plan = this.plan(from, to, 'quick-cut');
    if (!plan) return 'Could not skip.';
    this.pending = null;
    this.run(plan);
    return `Skipping to "${this.titleOf(to)}".`;
  }

  /** Turn auto mixing on without the toast, for internal use. */
  private enable() {
    if (this.enabled) return;
    this.start();
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this.dj.store.state.mixMode = 'autodj';
    this.dj.store.notify('mode');
    // Poll rather than schedule once: tempo, position and the plan itself can
    // all change underneath us while we wait.
    this.pollTimer = setInterval(() => void this.tick(), 500) as unknown as number;
  }

  stop() {
    this.enabled = false;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.pending = null;
    this.abort();
    if (this.dj.store.state.mixMode === 'autodj') {
      this.dj.store.state.mixMode = 'manual';
      this.dj.store.notify('mode');
    }
  }

  /** What the console is doing, in a sentence a beginner can read. */
  get status(): AutoStatus {
    const dj = this.dj;
    const playing = dj.engine.deckIds.filter((id) => dj.engine.deck(id).playing);

    if (this.inProgress && this.running) {
      return { state: 'mixing', headline: 'Mixing the two tracks together', detail: this.running.summary };
    }
    if (!playing.length) {
      return { state: 'idle', headline: 'Nothing playing', detail: 'Press the big button to start.' };
    }

    const from = playing[0];
    const nowTitle = this.titleOf(from);
    if (this.pending) {
      const wait = this.pending.startAt - dj.engine.deck(from).position;
      return {
        state: 'waiting',
        headline: `Playing "${nowTitle}"`,
        detail: `Blending into "${this.titleOf(this.pending.to)}" in ${formatCountdown(wait)} - ${this.pending.summary}`,
        countdown: Math.max(0, wait),
        nextTitle: this.titleOf(this.pending.to),
      };
    }

    const to = dj.engine.deckIds.find((id) => id !== from);
    const nextLoaded = to && dj.engine.deck(to).hasTrack;
    return {
      state: 'playing',
      headline: `Playing "${nowTitle}"`,
      detail: nextLoaded ? `"${this.titleOf(to!)}" is ready to come in.` : 'Working out what to play next.',
      nextTitle: nextLoaded ? this.titleOf(to!) : undefined,
    };
  }

  /**
   * Keeps the set running. Called twice a second while auto mixing is on.
   *
   * Unlike a fixed "start blending N seconds from the end", this waits for the
   * playhead to reach the join point the planner chose, so the blend happens
   * at the musically right moment rather than a fixed distance from the end.
   */
  private async tick() {
    if (!this.enabled || this.inProgress || this.planning) return;
    const dj = this.dj;

    const playing = dj.engine.deckIds.filter((id) => dj.engine.deck(id).playing);
    if (playing.length !== 1) return;
    const from = playing[0];
    const to = dj.engine.deckIds.find((id) => id !== from);
    if (!to) return;

    const outDeck = dj.engine.deck(from);
    const inDeck = dj.engine.deck(to);

    // Make sure something is queued up.
    if (!inDeck.hasTrack) {
      this.planning = true;
      try {
        const next = await this.prepareNext(from);
        if (!next) {
          // Nothing to play next. Let the current track finish rather than
          // stopping the music dead, and say why once.
          if (!this.warnedEmpty) {
            this.warnedEmpty = true;
            dj.store.toast('Nothing left to play next', 'warn', {
              detail: 'Add more music and I\'ll keep going.',
            });
          }
          return;
        }
        this.warnedEmpty = false;
      } finally {
        this.planning = false;
      }
    }

    // Plan the blend once the next track is loaded, and refresh it while we
    // wait in case the user moves the playhead or changes tempo.
    if (!this.pending || this.pending.to !== to || this.pending.from !== from) {
      this.pending = this.plan(from, to);
      if (this.pending) this.dj.store.notify('mode');
    } else if (this.pending.startAt < outDeck.position - 1) {
      // The playhead moved past the planned join; replan from here.
      this.pending = this.plan(from, to);
    }

    if (!this.pending) return;

    // Fire when the playhead reaches the join point, or if we are running out
    // of track and would otherwise miss it entirely.
    const remaining = outDeck.duration - outDeck.position;
    const reached = outDeck.position >= this.pending.startAt;
    const nearlyOut = remaining <= this.pending.duration + 1;

    if (reached || nearlyOut) {
      const plan = this.pending;
      this.pending = null;
      this.run(plan);
    }
  }
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * Math.max(0, Math.min(1, t)); }

function average(x: Float32Array): number {
  if (!x.length) return 0;
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return s / x.length;
}
