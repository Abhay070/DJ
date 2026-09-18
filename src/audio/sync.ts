/**
 * Beat sync: master clock, tempo matching and continuous phase lock.
 *
 * The approach, and why it is not `setInterval(() => b.position = a.position)`:
 *
 *  1. Tempo match is exact and instantaneous. The follower's playback rate is
 *     set to (masterBpm / followerBpm), folded by octaves so a 70 BPM track
 *     syncs to a 140 BPM master at 1.0x instead of 2.0x.
 *
 *  2. Phase is aligned *once*, at the moment sync engages, by a single seek to
 *     the correct beat - quantised to the bar so downbeats meet downbeats.
 *     That is the only time sync ever writes a position.
 *
 *  3. From then on, phase is held by a proportional-integral controller that
 *     trims the follower's *rate* by fractions of a percent. Errors are
 *     measured from the playheads the audio thread publishes, which are
 *     sample-accurate. Correcting with rate rather than position means the
 *     audio is never cut or jumped - it just runs imperceptibly fast or slow
 *     until the error is gone, exactly as a DJ nudging a platter would.
 *
 * The controller runs at ~50 Hz on the main thread. That rate only bounds how
 * quickly a *disturbance* is noticed; it does not bound accuracy, because the
 * integrator drives steady-state error to zero and the measurement itself
 * comes from the audio clock.
 */
import type { Deck } from './deck';
import type { DeckId } from '../lib/types';
import { beatAt, phaseError, barPhaseError, tempoRatio } from '../lib/grid';

/**
 * Controller gains.
 *
 * The plant is an integrator: a rate trim accumulates into phase. Working the
 * dynamics through rather than guessing:
 *
 *   d(error)/dt = -(bpm/60) * correction,  correction = KP * error
 *
 * gives a first-order settle with time constant 60/(bpm*KP). At KP = 0.5 and
 * 128 BPM that is about 0.94 s - fast enough to recover from a shove within a
 * bar or two, slow enough that the speed change is not audible as a lurch,
 * and far slower than the ~16 ms controller period, so sampling delay cannot
 * destabilise it.
 *
 * KP also sets where the output saturates: MAX_TRIM/KP = 0.08 beats. Beyond
 * that the loop drives at the limit and closes a quarter-beat offset in about
 * three seconds. An earlier, much smaller KP took the best part of a minute
 * to do the same thing, which is a sync that looks broken.
 *
 * KI removes the residual offset a P-only loop leaves when the tempo estimate
 * is slightly off. With KP = 0.5, KI = 0.05 the loop is overdamped, so it
 * converges without hunting around the lock point.
 */
const KP = 0.5;
const KI = 0.05;
/** Hard clamp on trim so a bad grid can never run a deck away. */
const MAX_TRIM = 0.04;
/** Below this, the decks are locked and the controller stops fidgeting. */
const LOCK_THRESHOLD = 0.004; // beats, ~1.9 ms at 128 BPM
/** Above this the P term saturates, so the integrator is held off to avoid windup. */
const SLEW_BAND = MAX_TRIM / KP;

export interface SyncStatus {
  enabled: boolean;
  /** True only when the engine is genuinely inside the lock threshold. */
  locked: boolean;
  /** Signed phase error in beats. */
  phaseError: number;
  /** Same error expressed in milliseconds at the current tempo. */
  phaseMs: number;
  trim: number;
}

const IDLE: SyncStatus = { enabled: false, locked: false, phaseError: 0, phaseMs: 0, trim: 1 };

export class SyncEngine {
  private decks: Map<DeckId, Deck>;
  private enabled = new Set<DeckId>();
  private integral = new Map<DeckId, number>();
  private status = new Map<DeckId, SyncStatus>();
  private raf = 0;
  private lastTick = 0;

  /** Explicit master, or null for "whichever deck is playing and leading". */
  masterDeck: DeckId | null = null;
  autoMaster = true;
  /** Align to bars (4 beats) rather than single beats. */
  barSync = true;

  constructor(decks: Map<DeckId, Deck>) {
    this.decks = decks;
    for (const id of decks.keys()) this.status.set(id, { ...IDLE });
  }

  // ------------------------------------------------------------------ master

  /**
   * The deck other decks follow. With auto-master on, that is whichever
   * playing deck with a usable grid started first; falls back to any loaded
   * deck with a grid so the tempo display still means something before
   * anything is playing.
   *
   * The master has to be a *stable* choice, because the phase controller
   * measures against it every frame. Two rules that look reasonable and are
   * not:
   *
   *  - "whichever deck is further into its track" - a follower running at
   *    128/124 moves through its own timeline faster than the master does and
   *    overtakes it within seconds, so the master flips every frame and
   *    nothing ever locks.
   *  - "whichever deck reports itself playing first" - the worklet fades in
   *    over a few milliseconds, so decks started microseconds apart can come
   *    up in either order.
   *
   * Deck.playStartedAt records when play was *requested*, which is stable.
   */
  resolveMaster(): DeckId | null {
    if (!this.autoMaster && this.masterDeck && this.hasGrid(this.masterDeck)) return this.masterDeck;

    let best: DeckId | null = null;
    let bestSince = Infinity;
    for (const [id, deck] of this.decks) {
      if (!deck.hasTrack || deck.grid.bpm <= 0) continue;
      if (this.enabled.has(id)) continue; // a follower cannot be the master
      // A deck counts as leading from the moment play is asked for, so the
      // choice settles before the first sound comes out.
      const since = deck.playStartedAt;
      if (since === null) continue;
      // Strict less-than means a tie keeps the deck declared first, so the
      // choice is deterministic rather than dependent on iteration order.
      if (since < bestSince) { bestSince = since; best = id; }
    }
    if (best) return best;

    for (const [id, deck] of this.decks) {
      if (deck.hasTrack && deck.grid.bpm > 0 && !this.enabled.has(id)) return id;
    }
    return null;
  }

  private hasGrid(id: DeckId): boolean {
    const d = this.decks.get(id);
    return !!d && d.hasTrack && d.grid.bpm > 0;
  }

  setMaster(id: DeckId | null) {
    this.masterDeck = id;
    this.autoMaster = id === null;
    // A deck cannot lead and follow at once.
    if (id) this.disable(id);
  }

  /** Master tempo in BPM, or 0 when nothing can lead. */
  get masterBpm(): number {
    const id = this.resolveMaster();
    if (!id) return 0;
    const deck = this.decks.get(id)!;
    return deck.currentBpm;
  }

  get masterBeatSeconds(): number {
    const bpm = this.masterBpm;
    return bpm > 0 ? 60 / bpm : 0.5;
  }

  /** Fractional beat position of the master, for quantising other actions. */
  get masterBeat(): number {
    const id = this.resolveMaster();
    if (!id) return 0;
    const deck = this.decks.get(id)!;
    return beatAt(deck.grid, deck.position);
  }

  // ------------------------------------------------------------------ enable

  /**
   * Engage sync on a deck: match tempo, then align phase once.
   *
   * Returns the status actually achieved. If the deck has no usable grid this
   * returns `enabled: false` - the caller must not light a SYNC lamp for a
   * deck the engine did not actually sync.
   */
  enable(id: DeckId): SyncStatus {
    const follower = this.decks.get(id);
    const masterId = this.resolveMaster();
    if (!follower || !masterId || masterId === id) return { ...IDLE };

    const master = this.decks.get(masterId)!;
    if (follower.grid.bpm <= 0 || master.grid.bpm <= 0) return { ...IDLE };

    this.enabled.add(id);
    this.integral.set(id, 0);

    // 1. Tempo.
    const ratio = tempoRatio(follower.grid.bpm, master.currentBpm);
    follower.setBaseRate(ratio);

    // 2. Phase - the one and only position write sync performs.
    this.alignPhase(id);

    this.ensureRunning();

    // Publish a status straight away rather than waiting for the first
    // controller tick, which has not run yet. Enabled is true because it is;
    // locked is false because the loop has not converged, and claiming
    // otherwise is exactly the kind of lie the UI must never tell.
    const err = this.measuredPhase(id);
    const beatMs = follower.currentBpm > 0 ? (60 / follower.currentBpm) * 1000 : 0;
    const status: SyncStatus = {
      enabled: true,
      locked: false,
      phaseError: err,
      phaseMs: err * beatMs,
      trim: follower.syncTrim,
    };
    this.status.set(id, status);
    return { ...status };
  }

  disable(id: DeckId) {
    this.enabled.delete(id);
    this.integral.delete(id);
    const deck = this.decks.get(id);
    if (deck) deck.setSyncTrim(1);
    this.status.set(id, { ...IDLE });
  }

  toggle(id: DeckId): SyncStatus {
    if (this.enabled.has(id)) { this.disable(id); return { ...IDLE }; }
    return this.enable(id);
  }

  isEnabled(id: DeckId): boolean { return this.enabled.has(id); }

  /**
   * Snap the follower onto the master's beat (or bar) immediately.
   *
   * A stopped follower is moved to the aligned position outright. A playing one
   * is only moved when it is more than a quarter beat out - smaller errors are
   * left to the controller, because seeking is audible and trimming is not.
   */
  alignPhase(id: DeckId, force = false): number {
    const follower = this.decks.get(id);
    const masterId = this.resolveMaster();
    if (!follower || !masterId || masterId === id) return 0;
    const master = this.decks.get(masterId)!;
    if (follower.grid.bpm <= 0 || master.grid.bpm <= 0) return 0;

    const masterBeat = beatAt(master.grid, master.position) - master.grid.downbeatOffset;
    const followerBeat = beatAt(follower.grid, follower.position) - follower.grid.downbeatOffset;

    const err = this.barSync
      ? barPhaseError(masterBeat, followerBeat)
      : phaseError(masterBeat, followerBeat);

    if (!force && follower.playing && Math.abs(err) < 0.25) return err;

    const target = followerBeat + err + follower.grid.downbeatOffset;
    const targetTime = follower.timeAtBeat(target);
    if (targetTime >= 0 && targetTime <= follower.duration) {
      follower.seek(targetTime);
      this.integral.set(id, 0);
    }
    return err;
  }

  /**
   * Adjust a position so that starting there lands the deck in phase with the
   * master, without needing a correction afterwards.
   *
   * Cueing a deck and *then* aligning it does not work: a seek is a message to
   * the audio thread, so the position has not moved yet when the alignment
   * runs, and the controller is left pulling in from up to half a beat - which
   * takes seconds and is audible as the new track sliding into place. Working
   * out the in-phase start position first makes the deck correct from its very
   * first sample.
   *
   * Only the master's live playhead is read here, so there is no race.
   */
  alignedStartPosition(followerId: DeckId, desiredPosition: number): number {
    const follower = this.decks.get(followerId);
    const masterId = this.resolveMaster();
    if (!follower || !masterId || masterId === followerId) return desiredPosition;
    const master = this.decks.get(masterId)!;
    if (follower.grid.bpm <= 0 || master.grid.bpm <= 0 || !master.playing) return desiredPosition;

    const masterBeat = beatAt(master.grid, master.position) - master.grid.downbeatOffset;
    const followerBeat = beatAt(follower.grid, desiredPosition) - follower.grid.downbeatOffset;
    const err = this.barSync
      ? barPhaseError(masterBeat, followerBeat)
      : phaseError(masterBeat, followerBeat);

    const target = followerBeat + err + follower.grid.downbeatOffset;
    const time = follower.timeAtBeat(target);
    // Never push the start outside the track just to gain a fraction of a beat.
    if (time < 0 || time > follower.duration) return desiredPosition;
    return time;
  }

  /** Nudge a deck by a fraction of a beat without disturbing sync tempo. */
  nudgeBeats(id: DeckId, beats: number) {
    const deck = this.decks.get(id);
    if (!deck || deck.grid.bpm <= 0) return;
    deck.seek(deck.position + beats * (60 / deck.grid.bpm));
    this.integral.set(id, 0);
  }

  // -------------------------------------------------------------- controller

  private ensureRunning() {
    if (this.raf) return;
    this.lastTick = performance.now();
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min(0.1, (now - this.lastTick) / 1000);
      this.lastTick = now;
      this.update(dt);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private update(dt: number) {
    const masterId = this.resolveMaster();
    if (!masterId) {
      for (const id of this.enabled) this.status.set(id, { ...IDLE, enabled: true });
      return;
    }
    const master = this.decks.get(masterId)!;

    for (const id of this.enabled) {
      const follower = this.decks.get(id);
      if (!follower || !follower.hasTrack || follower.grid.bpm <= 0) {
        this.status.set(id, { ...IDLE });
        continue;
      }

      // Keep tempo tracking the master even as the master's pitch fader moves.
      const desiredRate = tempoRatio(follower.grid.bpm, master.currentBpm);
      if (Math.abs(desiredRate - follower.baseRate) > 1e-6) follower.setBaseRate(desiredRate);

      // Phase is only meaningful while both decks are actually producing audio.
      if (!master.playing || !follower.playing || follower.scratching) {
        follower.setSyncTrim(1);
        this.integral.set(id, 0);
        this.status.set(id, {
          enabled: true, locked: false, phaseError: 0, phaseMs: 0, trim: 1,
        });
        continue;
      }

      const masterBeat = beatAt(master.grid, master.position) - master.grid.downbeatOffset;
      const followerBeat = beatAt(follower.grid, follower.position) - follower.grid.downbeatOffset;
      const err = phaseError(masterBeat, followerBeat);

      let integral = this.integral.get(id) ?? 0;
      if (Math.abs(err) > SLEW_BAND) {
        // Saturated: the proportional term is already at the limit, so letting
        // the integrator keep charging would only overshoot once we arrive.
        integral = 0;
      } else {
        integral += err * dt;
        const iLimit = MAX_TRIM / Math.max(KI, 1e-6);
        integral = Math.max(-iLimit, Math.min(iLimit, integral));
      }
      this.integral.set(id, integral);

      const correction = Math.max(-MAX_TRIM, Math.min(MAX_TRIM, KP * err + KI * integral));
      const trim = 1 + correction;
      follower.setSyncTrim(trim);

      const beatMs = (60 / Math.max(1, follower.currentBpm)) * 1000;
      this.status.set(id, {
        enabled: true,
        locked: Math.abs(err) < LOCK_THRESHOLD,
        phaseError: err,
        phaseMs: err * beatMs,
        trim,
      });
    }
  }

  statusFor(id: DeckId): SyncStatus {
    return this.status.get(id) ?? { ...IDLE };
  }

  /**
   * Live phase error against the master, whether or not sync is engaged - the
   * phase meter shows this so manual beatmatching has something to aim at.
   */
  measuredPhase(id: DeckId): number {
    const masterId = this.resolveMaster();
    const follower = this.decks.get(id);
    if (!masterId || masterId === id || !follower || follower.grid.bpm <= 0) return 0;
    const master = this.decks.get(masterId)!;
    if (master.grid.bpm <= 0) return 0;
    const m = beatAt(master.grid, master.position) - master.grid.downbeatOffset;
    const f = beatAt(follower.grid, follower.position) - follower.grid.downbeatOffset;
    return phaseError(m, f);
  }

  /** Next master beat boundary as an AudioContext timestamp, for quantising. */
  nextBeatTime(ctxTime: number, division = 1): number {
    const masterId = this.resolveMaster();
    if (!masterId) return ctxTime;
    const master = this.decks.get(masterId)!;
    if (!master.playing || master.grid.bpm <= 0) return ctxTime;
    const beatSeconds = 60 / master.currentBpm;
    const beat = beatAt(master.grid, master.position) / division;
    const frac = beat - Math.floor(beat);
    return ctxTime + (1 - frac) * beatSeconds * division;
  }

  resetAll() {
    for (const id of [...this.enabled]) this.disable(id);
  }
}
