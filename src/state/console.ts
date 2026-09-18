/**
 * The DJ state engine.
 *
 * Sits between the UI and the audio engine and owns all *musical* decisions:
 * what a hot cue means, how a loop is sized, when quantisation applies, how
 * gain is staged. It never renders and it never holds playback timing - it
 * asks the engine and reports what the engine says.
 */
import { AudioEngine } from '../audio/engine';
import { autoGainDb, dbToGain, gainToDb } from '../lib/gain';
import { SyncEngine } from '../audio/sync';
import { Library } from './library';
import { Store, DEFAULT_SETTINGS, type Settings } from './store';
import { settingsDb, sessionsDb, playlistsDb, historyDb, type StoredSession } from '../lib/db';
import type { DeckId, HotCue, Track } from '../lib/types';
import { quantise, quantiseForward, beatAt, timeAtBeat, nextPhrase } from '../lib/grid';

export const CUE_COLORS = ['#ff4d5e', '#ffa62b', '#ffe45e', '#5ddc7c', '#4fc3f7', '#9d7bff', '#ff6bd6', '#64ffda'];

export class DjConsole {
  readonly engine: AudioEngine;
  readonly sync: SyncEngine;
  readonly store: Store;
  readonly library: Library;

  /** Position each deck's track started at, for the history log. */
  private historyOpen = new Map<DeckId, number>();
  private loopRollReturn = new Map<DeckId, number>();

  constructor(engine: AudioEngine, store: Store) {
    this.engine = engine;
    this.store = store;
    this.sync = new SyncEngine(engine.decks);
    this.library = new Library(store, (data) => engine.decode(data));

    for (const [id, deck] of engine.decks) {
      deck.on('ended', () => this.onDeckEnded(id));
    }
  }

  // ------------------------------------------------------------------ setup

  async init() {
    const saved = await settingsDb.get<Settings>('settings');
    if (saved) this.store.state.settings = { ...DEFAULT_SETTINGS, ...saved };
    const settings = this.store.state.settings;

    this.engine.setLimiterEnabled(settings.limiterEnabled);
    this.engine.setCrossfaderCurve(settings.crossfaderCurve);
    this.engine.setMasterVolume(this.store.state.masterVolume);
    this.engine.setCueVolume(this.store.state.cueVolume);
    this.engine.setCueMix(this.store.state.cueMix);

    for (const id of this.engine.deckIds) {
      const deck = this.engine.deck(id);
      deck.setKeyLock(settings.keyLockDefault);
      this.store.updateDeck(id, {
        keyLock: settings.keyLockDefault,
        tempoRange: settings.tempoRange,
        quantizeDivision: settings.quantizeDivision,
      });
    }

    this.engine.addFxUnit('echo');
    this.engine.addFxUnit('filter');
    this.syncFxState();

    this.store.state.playlists = await playlistsDb.all();
    this.store.state.history = await historyDb.all();
    await this.library.loadPersisted();
    this.store.notify('library', 'playlists', 'history', 'settings');
  }

  async saveSettings() {
    await settingsDb.put('settings', this.store.state.settings);
    this.store.notify('settings');
  }

  private syncFxState() {
    this.store.state.fx = this.engine.fxUnits.map((u) => ({
      id: u.state.id,
      enabled: u.state.enabled,
      a: u.state.params.a,
      b: u.state.params.b,
      wet: u.state.params.wet,
      routing: { ...u.state.routing } as Record<string, boolean>,
    }));
    this.store.notify('fx');
  }

  // ------------------------------------------------------------- track load

  async loadTrack(deckId: DeckId, trackId: string, options: { force?: boolean } = {}) {
    const deck = this.engine.deck(deckId);
    const track = this.store.state.tracks.get(trackId);
    if (!track) { this.store.toast('That track is not in the library', 'error'); return; }

    if (!options.force && deck.playing) {
      this.store.toast(`Deck ${deckId} is playing`, 'warn', {
        detail: `Loading "${track.title}" will stop it.`,
        sticky: true,
        actions: [{ label: 'Load anyway', run: () => void this.loadTrack(deckId, trackId, { force: true }) }],
      });
      return;
    }

    this.closeHistory(deckId);
    this.store.updateDeck(deckId, { loadingState: 'loading', loadError: null });

    try {
      const buffer = await this.library.getAudio(trackId);
      await deck.load(trackId, buffer, track.analysis, track.bpmOverride);

      // Auto gain: bring every track to the same perceived level, so the
      // crossfader is a blend control and not a volume rescue.
      let autoGain = 0;
      if (this.store.state.settings.autoGainEnabled && track.analysis) {
        autoGain = this.computeAutoGain(track);
      }
      this.engine.setTrim(deckId, autoGain + track.gainOffset);

      const cue = track.cues.find((c) => c.index === -1);
      this.store.updateDeck(deckId, {
        trackId,
        loadingState: 'ready',
        loadError: null,
        hotCues: track.cues.filter((c) => c.index >= 0).map((c) => ({ ...c })),
        cuePoint: cue?.position ?? 0,
        loopEnabled: false,
        loopStart: 0,
        loopEnd: 0,
        pitchPercent: 0,
        keyShift: 0,
        autoGain,
        syncEnabled: false,
        syncLocked: false,
      });
      this.sync.disable(deckId);
      deck.setKeyShift(0);

      // Restore the most recent saved loop so a track comes back how it was left.
      const savedLoop = track.loops[0];
      if (savedLoop) {
        deck.setLoop(savedLoop.start, savedLoop.end, false);
        this.store.updateDeck(deckId, {
          loopStart: savedLoop.start, loopEnd: savedLoop.end, loopBeats: savedLoop.beats,
        });
      }

      track.playCount += 1;
      track.lastPlayed = Date.now();
      await this.library.persistMeta(track);

      this.openHistory(deckId, track);
      this.refreshMasterTempo();
      this.store.notify('library');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.updateDeck(deckId, { loadingState: 'error', loadError: message });
      this.store.toast(`Could not load "${track.title}" onto deck ${deckId}`, 'error', { detail: message });
    }
  }

  /** Gain in dB that brings this track to the configured target loudness. */
  computeAutoGain(track: Track): number {
    if (!track.analysis) return 0;
    return autoGainDb(
      track.analysis.loudness,
      track.analysis.peak,
      this.store.state.settings.targetLoudness,
    );
  }

  unloadDeck(deckId: DeckId) {
    this.closeHistory(deckId);
    this.sync.disable(deckId);
    this.engine.deck(deckId).unload();
    this.store.updateDeck(deckId, {
      trackId: null, loadingState: 'idle', hotCues: [], loopEnabled: false,
      syncEnabled: false, syncLocked: false, isMaster: false,
    });
  }

  // -------------------------------------------------------------- transport

  play(deckId: DeckId) {
    const deck = this.engine.deck(deckId);
    if (!deck.hasTrack) return;
    deck.play();
    this.refreshMasterTempo();
    this.store.notify('transport');
  }

  pause(deckId: DeckId) {
    this.engine.deck(deckId).pause();
    this.store.notify('transport');
  }

  togglePlay(deckId: DeckId) {
    const deck = this.engine.deck(deckId);
    if (!deck.hasTrack) return;
    deck.playing ? this.pause(deckId) : this.play(deckId);
  }

  /**
   * CUE, behaving like a real deck: while stopped, set the cue point here.
   * While playing, jump back to the cue point and stop.
   */
  pressCue(deckId: DeckId) {
    const deck = this.engine.deck(deckId);
    const ui = this.store.deck(deckId);
    if (!deck.hasTrack) return;
    if (deck.playing) {
      deck.pause();
      deck.seek(ui.cuePoint);
    } else {
      const pos = this.maybeQuantise(deckId, deck.position);
      this.store.updateDeck(deckId, { cuePoint: pos });
      deck.seek(pos);
      void this.persistCue(deckId, -1, pos, 'Cue', '#ffffff');
    }
  }

  /** Hold-to-preview from the cue point; release returns and stops. */
  cuePlayStart(deckId: DeckId) {
    const deck = this.engine.deck(deckId);
    const ui = this.store.deck(deckId);
    if (!deck.hasTrack || deck.playing) return;
    deck.seek(ui.cuePoint);
    deck.play();
  }

  cuePlayEnd(deckId: DeckId) {
    const deck = this.engine.deck(deckId);
    const ui = this.store.deck(deckId);
    deck.pause();
    deck.seek(ui.cuePoint);
  }

  seek(deckId: DeckId, position: number) {
    this.engine.deck(deckId).seek(position);
  }

  seekToStart(deckId: DeckId) { this.engine.deck(deckId).seek(0); }

  seekToEnd(deckId: DeckId) {
    const deck = this.engine.deck(deckId);
    deck.seek(Math.max(0, deck.duration - 0.05));
  }

  /** Beat jump by a musical interval, snapped to the grid. */
  beatJump(deckId: DeckId, beats: number) {
    const deck = this.engine.deck(deckId);
    if (!deck.hasTrack || deck.grid.bpm <= 0) return;
    const current = beatAt(deck.grid, deck.position);
    const target = timeAtBeat(deck.grid, current + beats);
    deck.seek(Math.max(0, Math.min(deck.duration, target)));
    // Loops move with the jump so a rolling loop keeps its shape.
    const ui = this.store.deck(deckId);
    if (ui.loopEnabled) {
      const offset = beats * (60 / deck.grid.bpm);
      this.setLoopRegion(deckId, ui.loopStart + offset, ui.loopEnd + offset, true);
    }
  }

  setReverse(deckId: DeckId, on: boolean) {
    const deck = this.engine.deck(deckId);
    const ui = this.store.deck(deckId);
    if (on === ui.reverse) return;
    this.store.updateDeck(deckId, { reverse: on });
    // Reverse is a genuine negative playback rate, not a re-render.
    deck.setBend(on ? -1 : 1);
  }

  // ------------------------------------------------------------ pitch/tempo

  setPitchPercent(deckId: DeckId, percent: number) {
    const ui = this.store.deck(deckId);
    const clamped = Math.max(-ui.tempoRange, Math.min(ui.tempoRange, percent));
    this.store.updateDeck(deckId, { pitchPercent: clamped });
    // With sync engaged the fader drives the *master* tempo instead, which is
    // what every hardware deck does.
    if (this.sync.isEnabled(deckId)) {
      const masterId = this.sync.resolveMaster();
      if (masterId && masterId !== deckId) {
        this.setPitchPercent(masterId, clamped);
        return;
      }
    }
    this.engine.deck(deckId).setBaseRate(1 + clamped / 100);
    this.refreshMasterTempo();
  }

  resetPitch(deckId: DeckId) { this.setPitchPercent(deckId, 0); }

  setTempoRange(deckId: DeckId, range: number) {
    this.store.updateDeck(deckId, { tempoRange: range });
    const ui = this.store.deck(deckId);
    if (Math.abs(ui.pitchPercent) > range) this.setPitchPercent(deckId, Math.sign(ui.pitchPercent) * range);
  }

  /** Momentary tempo nudge, as with a hardware pitch-bend button. */
  bend(deckId: DeckId, amount: number) {
    this.engine.deck(deckId).setBend(1 + amount);
  }

  endBend(deckId: DeckId) {
    const ui = this.store.deck(deckId);
    this.engine.deck(deckId).setBend(ui.reverse ? -1 : 1);
  }

  setKeyLock(deckId: DeckId, on: boolean) {
    this.engine.deck(deckId).setKeyLock(on);
    this.store.updateDeck(deckId, { keyLock: on });
  }

  setKeyShift(deckId: DeckId, semitones: number) {
    const s = Math.max(-12, Math.min(12, Math.round(semitones)));
    this.engine.deck(deckId).setKeyShift(s);
    this.store.updateDeck(deckId, { keyShift: s });
  }

  // -------------------------------------------------------------- beat grid

  /** Correct the BPM by hand and rebuild the grid around it. */
  async setBpm(deckId: DeckId, bpm: number) {
    const deck = this.engine.deck(deckId);
    if (!deck.hasTrack || bpm <= 0) return;
    deck.grid = { ...deck.grid, bpm, locked: true };
    const track = this.store.state.tracks.get(deck.trackId!);
    if (track) {
      track.bpmOverride = bpm;
      await this.library.persistMeta(track);
    }
    this.refreshMasterTempo();
    this.store.notify('deck', 'library');
  }

  /** Declare "the playhead is on beat 1" and slide the grid to match. */
  setGridFirstBeat(deckId: DeckId, position?: number) {
    const deck = this.engine.deck(deckId);
    if (!deck.hasTrack || deck.grid.bpm <= 0) return;
    const at = position ?? deck.position;
    const interval = 60 / deck.grid.bpm;
    // Keep firstBeat inside the first beat period so beat indices stay small.
    const firstBeat = at - Math.floor(at / interval) * interval;
    deck.grid = { ...deck.grid, firstBeat, downbeatOffset: 0, locked: true };
    this.store.notify('deck');
  }

  nudgeGrid(deckId: DeckId, seconds: number) {
    const deck = this.engine.deck(deckId);
    if (!deck.hasTrack) return;
    deck.grid = { ...deck.grid, firstBeat: deck.grid.firstBeat + seconds, locked: true };
    this.store.notify('deck');
  }

  resetGrid(deckId: DeckId) {
    const deck = this.engine.deck(deckId);
    if (!deck.hasTrack || !deck.analysis) return;
    deck.grid = { ...deck.analysis.beatGrid, locked: false };
    this.store.notify('deck');
  }

  toggleGridLock(deckId: DeckId) {
    const deck = this.engine.deck(deckId);
    deck.grid = { ...deck.grid, locked: !deck.grid.locked };
    this.store.notify('deck');
  }

  // ------------------------------------------------------------------- sync

  toggleSync(deckId: DeckId) {
    const status = this.sync.toggle(deckId);
    // Only light SYNC when the engine actually synced something.
    if (!status.enabled && !this.sync.isEnabled(deckId)) {
      this.store.updateDeck(deckId, { syncEnabled: false, syncLocked: false });
      const deck = this.engine.deck(deckId);
      if (deck.hasTrack && deck.grid.bpm <= 0) {
        this.store.toast(`Deck ${deckId} has no beat grid`, 'warn', {
          detail: 'Set the BPM by hand before syncing.',
        });
      }
      return;
    }
    this.store.updateDeck(deckId, { syncEnabled: true });
    const deck = this.engine.deck(deckId);
    this.store.updateDeck(deckId, { pitchPercent: (deck.baseRate - 1) * 100 });
    this.refreshMasterTempo();
  }

  setMaster(deckId: DeckId | null) {
    this.sync.setMaster(deckId);
    for (const id of this.engine.deckIds) {
      this.store.updateDeck(id, { isMaster: this.sync.resolveMaster() === id });
    }
    this.refreshMasterTempo();
  }

  /** Recompute master tempo and push it into every beat-synced effect. */
  refreshMasterTempo() {
    const beatSeconds = this.sync.masterBeatSeconds;
    this.engine.setBeatSeconds(beatSeconds);
    for (const id of this.engine.deckIds) {
      this.store.deck(id).isMaster = this.sync.resolveMaster() === id;
    }
    this.store.notify('deck');
  }

  nudgePhase(deckId: DeckId, beats: number) { this.sync.nudgeBeats(deckId, beats); }
  resetPhase(deckId: DeckId) { this.sync.alignPhase(deckId, true); }

  // ------------------------------------------------------------- quantising

  private maybeQuantise(deckId: DeckId, position: number): number {
    const ui = this.store.deck(deckId);
    const deck = this.engine.deck(deckId);
    if (!ui.quantize || deck.grid.bpm <= 0) return position;
    return quantise(deck.grid, position, ui.quantizeDivision);
  }

  setQuantize(deckId: DeckId, on: boolean) { this.store.updateDeck(deckId, { quantize: on }); }
  setQuantizeDivision(deckId: DeckId, division: number) {
    this.store.updateDeck(deckId, { quantizeDivision: division });
  }

  // --------------------------------------------------------------- hot cues

  async setHotCue(deckId: DeckId, index: number) {
    const deck = this.engine.deck(deckId);
    if (!deck.hasTrack) return;
    const ui = this.store.deck(deckId);
    const existing = ui.hotCues.find((c) => c.index === index);
    if (existing) { this.jumpToCue(deckId, index); return; }

    const position = this.maybeQuantise(deckId, deck.position);
    const cue: HotCue = {
      index, position,
      name: `Cue ${index + 1}`,
      color: CUE_COLORS[index % CUE_COLORS.length],
      type: 'hot',
    };
    ui.hotCues.push(cue);
    ui.hotCues.sort((a, b) => a.index - b.index);
    this.store.notify('deck');
    await this.persistCue(deckId, index, position, cue.name, cue.color);
  }

  jumpToCue(deckId: DeckId, index: number) {
    const ui = this.store.deck(deckId);
    const cue = ui.hotCues.find((c) => c.index === index);
    if (!cue) return;
    const deck = this.engine.deck(deckId);

    if (cue.type === 'loop' && cue.loopLength) {
      deck.seek(cue.position);
      this.setLoopBeats(deckId, cue.loopLength, cue.position);
      return;
    }
    deck.seek(cue.position);
  }

  async deleteHotCue(deckId: DeckId, index: number) {
    const ui = this.store.deck(deckId);
    const i = ui.hotCues.findIndex((c) => c.index === index);
    if (i < 0) return;
    ui.hotCues.splice(i, 1);
    this.store.notify('deck');
    const track = this.trackOf(deckId);
    if (track) {
      track.cues = track.cues.filter((c) => c.index !== index);
      await this.library.persistMeta(track);
    }
  }

  async renameHotCue(deckId: DeckId, index: number, name: string, color?: string) {
    const ui = this.store.deck(deckId);
    const cue = ui.hotCues.find((c) => c.index === index);
    if (!cue) return;
    cue.name = name;
    if (color) cue.color = color;
    this.store.notify('deck');
    await this.persistCue(deckId, index, cue.position, cue.name, cue.color, cue.type, cue.loopLength);
  }

  /** Cues belong to the track, not the deck, so they come back on reload. */
  private async persistCue(
    deckId: DeckId, index: number, position: number, name: string, color: string,
    type: HotCue['type'] = 'hot', loopLength?: number,
  ) {
    const track = this.trackOf(deckId);
    if (!track) return;
    const existing = track.cues.findIndex((c) => c.index === index);
    const cue: HotCue = { index, position, name, color, type, loopLength };
    if (existing >= 0) track.cues[existing] = cue;
    else track.cues.push(cue);
    await this.library.persistMeta(track);
  }

  private trackOf(deckId: DeckId): Track | undefined {
    const id = this.engine.deck(deckId).trackId;
    return id ? this.store.state.tracks.get(id) : undefined;
  }

  // ------------------------------------------------------------------ loops

  /** Auto-loop of N beats starting at (or quantised to) the playhead. */
  setLoopBeats(deckId: DeckId, beats: number, from?: number) {
    const deck = this.engine.deck(deckId);
    if (!deck.hasTrack || deck.grid.bpm <= 0) {
      this.store.toast('Looping needs a beat grid', 'warn', { detail: 'Set the BPM for this track first.' });
      return;
    }
    const ui = this.store.deck(deckId);
    const start = from ?? this.maybeQuantise(deckId, deck.position);
    const end = start + beats * (60 / deck.grid.bpm);
    this.setLoopRegion(deckId, start, end, true);
    this.store.updateDeck(deckId, { loopBeats: beats });
    void this.persistLoop(deckId, start, end, beats);
    if (ui.loopRolling) this.loopRollReturn.set(deckId, deck.position);
  }

  setLoopRegion(deckId: DeckId, start: number, end: number, enabled: boolean) {
    const deck = this.engine.deck(deckId);
    deck.setLoop(start, end, enabled);
    this.store.updateDeck(deckId, { loopStart: start, loopEnd: end, loopEnabled: enabled });
  }

  loopIn(deckId: DeckId) {
    const deck = this.engine.deck(deckId);
    const start = this.maybeQuantise(deckId, deck.position);
    this.store.updateDeck(deckId, { loopStart: start });
  }

  loopOut(deckId: DeckId) {
    const deck = this.engine.deck(deckId);
    const ui = this.store.deck(deckId);
    const end = this.maybeQuantise(deckId, deck.position);
    if (end <= ui.loopStart) return;
    const beats = deck.grid.bpm > 0 ? (end - ui.loopStart) / (60 / deck.grid.bpm) : 0;
    this.setLoopRegion(deckId, ui.loopStart, end, true);
    void this.persistLoop(deckId, ui.loopStart, end, beats);
  }

  toggleLoop(deckId: DeckId) {
    const ui = this.store.deck(deckId);
    if (ui.loopEnd <= ui.loopStart) { this.setLoopBeats(deckId, ui.loopBeats); return; }
    const enabled = !ui.loopEnabled;
    this.engine.deck(deckId).setLoopActive(enabled);
    this.store.updateDeck(deckId, { loopEnabled: enabled });
  }

  exitLoop(deckId: DeckId) {
    this.engine.deck(deckId).setLoopActive(false);
    this.store.updateDeck(deckId, { loopEnabled: false });
  }

  reloop(deckId: DeckId) {
    const ui = this.store.deck(deckId);
    if (ui.loopEnd <= ui.loopStart) return;
    this.engine.deck(deckId).seek(ui.loopStart);
    this.engine.deck(deckId).setLoopActive(true);
    this.store.updateDeck(deckId, { loopEnabled: true });
  }

  halveLoop(deckId: DeckId) {
    const ui = this.store.deck(deckId);
    if (ui.loopEnd <= ui.loopStart) return;
    this.setLoopBeats(deckId, Math.max(1 / 32, ui.loopBeats / 2), ui.loopStart);
  }

  doubleLoop(deckId: DeckId) {
    const ui = this.store.deck(deckId);
    if (ui.loopEnd <= ui.loopStart) return;
    this.setLoopBeats(deckId, Math.min(32, ui.loopBeats * 2), ui.loopStart);
  }

  /**
   * Loop roll: a momentary loop that leaves the underlying timeline running,
   * so releasing it drops you where the track would have been. That is slip
   * behaviour, so the engine's slip playhead does the work.
   */
  startLoopRoll(deckId: DeckId, beats: number) {
    const deck = this.engine.deck(deckId);
    if (!deck.hasTrack || deck.grid.bpm <= 0) return;
    deck.setSlip(true);
    this.setLoopBeats(deckId, beats);
    this.store.updateDeck(deckId, { loopRolling: true });
  }

  endLoopRoll(deckId: DeckId) {
    const deck = this.engine.deck(deckId);
    const ui = this.store.deck(deckId);
    if (!ui.loopRolling) return;
    this.exitLoop(deckId);
    // Slip off makes the engine jump to the shadow playhead.
    if (!ui.slip) deck.setSlip(false);
    else deck.slipReturn();
    this.store.updateDeck(deckId, { loopRolling: false });
  }

  private async persistLoop(deckId: DeckId, start: number, end: number, beats: number) {
    const track = this.trackOf(deckId);
    if (!track) return;
    track.loops = [{ start, end, beats }, ...track.loops.filter((l) => l.start !== start)].slice(0, 8);
    await this.library.persistMeta(track);
  }

  setSlip(deckId: DeckId, on: boolean) {
    this.engine.deck(deckId).setSlip(on);
    this.store.updateDeck(deckId, { slip: on });
  }

  // ------------------------------------------------------------------ mixer

  setCrossfader(v: number) {
    this.engine.setCrossfader(v);
    this.store.state.crossfader = v;
    this.store.notify('mixer');
  }

  setFader(deckId: DeckId, v: number) {
    this.engine.setFader(deckId, v);
    this.store.updateDeck(deckId, { fader: v });
  }

  setEq(deckId: DeckId, band: 'low' | 'mid' | 'high', db: number) {
    this.engine.setEq(deckId, band, db);
    const patch = band === 'low' ? { eqLow: db } : band === 'mid' ? { eqMid: db } : { eqHigh: db };
    this.store.updateDeck(deckId, patch);
  }

  setFilter(deckId: DeckId, v: number) {
    this.engine.setFilter(deckId, v);
    this.store.updateDeck(deckId, { filter: v });
  }

  setTrim(deckId: DeckId, db: number) {
    const ui = this.store.deck(deckId);
    this.engine.setTrim(deckId, ui.autoGain + db);
    this.store.updateDeck(deckId, { trim: db });
    const track = this.trackOf(deckId);
    if (track) { track.gainOffset = db; void this.library.persistMeta(track); }
  }

  togglePfl(deckId: DeckId) {
    const ui = this.store.deck(deckId);
    const on = !ui.pfl;
    this.engine.setCue(deckId, on);
    this.store.updateDeck(deckId, { pfl: on });
    // Opening a PFL with the headphone level at zero is a classic "why can't I
    // hear anything" - lift it to something audible the first time.
    if (on && this.store.state.cueVolume < 0.02) this.setCueVolume(0.7);
  }

  setCueVolume(v: number) {
    this.engine.setCueVolume(v);
    this.store.state.cueVolume = v;
    this.store.notify('mixer');
  }

  setCueMix(v: number) {
    this.engine.setCueMix(v);
    this.store.state.cueMix = v;
    this.store.notify('mixer');
  }

  setMasterVolume(v: number) {
    this.engine.setMasterVolume(v);
    this.store.state.masterVolume = v;
    this.store.notify('mixer');
  }

  // --------------------------------------------------------------------- FX

  setFxEnabled(index: number, on: boolean) { this.engine.setFxEnabled(index, on); this.syncFxState(); }
  setFxParam(index: number, patch: { a?: number; b?: number; wet?: number }) {
    this.engine.setFxParams(index, patch);
    this.syncFxState();
  }
  setFxType(index: number, id: Parameters<AudioEngine['setFxType']>[1]) {
    this.engine.setFxType(index, id);
    this.syncFxState();
  }
  setFxRouting(index: number, deckId: DeckId, on: boolean) {
    this.engine.setFxRouting(index, deckId, on);
    this.syncFxState();
  }

  // -------------------------------------------------------------- recording

  startRecording() {
    this.engine.recorder.start();
    this.store.state.recording = true;
    this.store.state.recordingPaused = false;
    this.store.notify('recording');
    this.store.toast('Recording the master output', 'success');
  }

  pauseRecording() {
    const r = this.engine.recorder;
    if (r.paused) { r.resume(); this.store.state.recordingPaused = false; }
    else { r.pause(); this.store.state.recordingPaused = true; }
    this.store.notify('recording');
  }

  stopRecording(): void {
    const result = this.engine.recorder.stop();
    this.store.state.recording = false;
    this.store.state.recordingPaused = false;
    this.store.notify('recording');
    if (!result) { this.store.toast('Nothing was recorded', 'warn'); return; }

    const url = URL.createObjectURL(result.blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `mix-${stamp}.${result.extension}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);

    this.store.toast(`Saved ${formatDuration(result.duration)} of audio`, 'success', {
      detail: `${a.download} · ${(result.blob.size / 1048576).toFixed(1)} MB`,
    });
  }

  // ----------------------------------------------------------- panic / reset

  panic() {
    this.engine.panic();
    for (const id of this.engine.deckIds) {
      this.sync.disable(id);
      this.store.updateDeck(id, { syncEnabled: false, syncLocked: false, loopEnabled: false, loopRolling: false });
    }
    this.syncFxState();
    this.store.notify('transport', 'fx');
    this.store.toast('All audio stopped', 'warn');
  }

  resetDeck(deckId: DeckId) {
    const deck = this.engine.deck(deckId);
    deck.pause();
    deck.seek(0);
    this.sync.disable(deckId);
    this.exitLoop(deckId);
    this.setPitchPercent(deckId, 0);
    this.setKeyShift(deckId, 0);
    this.setSlip(deckId, false);
    this.setReverse(deckId, false);
    this.store.updateDeck(deckId, { syncEnabled: false, syncLocked: false });
  }

  resetMixer() {
    for (const id of this.engine.deckIds) {
      this.setEq(id, 'low', 0);
      this.setEq(id, 'mid', 0);
      this.setEq(id, 'high', 0);
      this.setFilter(id, 0);
      this.setFader(id, 1);
      this.setTrim(id, 0);
    }
    this.setCrossfader(0);
    this.setMasterVolume(0.85);
  }

  resetFx() {
    this.engine.killAllFx();
    this.syncFxState();
  }

  resetSync() {
    this.sync.resetAll();
    for (const id of this.engine.deckIds) {
      this.store.updateDeck(id, { syncEnabled: false, syncLocked: false });
    }
  }

  // ---------------------------------------------------------------- history

  private openHistory(deckId: DeckId, track: Track) {
    this.historyOpen.set(deckId, Date.now());
    this.store.state.history.push({
      trackId: track.id, title: track.title, artist: track.artist,
      deck: deckId, startedAt: Date.now(), endedAt: null,
    });
    this.store.notify('history');
  }

  private closeHistory(deckId: DeckId) {
    if (!this.historyOpen.has(deckId)) return;
    this.historyOpen.delete(deckId);
    const entry = [...this.store.state.history].reverse().find((h) => h.deck === deckId && h.endedAt === null);
    if (entry) {
      entry.endedAt = Date.now();
      void historyDb.add(entry);
    }
    this.store.notify('history');
  }

  private onDeckEnded(deckId: DeckId) {
    this.store.notify('transport');
    this.store.toast(`Deck ${deckId} reached the end of the track`, 'info');
  }

  // --------------------------------------------------------------- sessions

  /** Everything needed to put the console back exactly as it is now. */
  captureSession() {
    const decks: Record<string, unknown> = {};
    for (const id of this.engine.deckIds) {
      const deck = this.engine.deck(id);
      const ui = this.store.deck(id);
      decks[id] = {
        trackId: deck.trackId,
        position: deck.position,
        grid: deck.grid,
        pitchPercent: ui.pitchPercent,
        keyLock: ui.keyLock,
        keyShift: ui.keyShift,
        hotCues: ui.hotCues,
        cuePoint: ui.cuePoint,
        loop: { start: ui.loopStart, end: ui.loopEnd, enabled: ui.loopEnabled, beats: ui.loopBeats },
        quantize: ui.quantize,
        quantizeDivision: ui.quantizeDivision,
        slip: ui.slip,
        mixer: { trim: ui.trim, eqLow: ui.eqLow, eqMid: ui.eqMid, eqHigh: ui.eqHigh, filter: ui.filter, fader: ui.fader },
        syncEnabled: ui.syncEnabled,
      };
    }
    return {
      version: 1,
      decks,
      crossfader: this.store.state.crossfader,
      masterVolume: this.store.state.masterVolume,
      cueVolume: this.store.state.cueVolume,
      cueMix: this.store.state.cueMix,
      fx: this.store.state.fx,
      master: this.sync.autoMaster ? null : this.sync.masterDeck,
      playlist: this.store.state.activePlaylist,
      settings: this.store.state.settings,
    };
  }

  async saveSession(name: string) {
    const session: StoredSession = {
      id: `session-${Date.now()}`,
      name,
      savedAt: Date.now(),
      data: this.captureSession(),
    };
    await sessionsDb.put(session);
    this.store.state.sessionName = name;
    this.store.notify('settings');
    this.store.toast(`Session saved as "${name}"`, 'success');
    return session.id;
  }

  async loadSession(id: string) {
    const session = await sessionsDb.get(id);
    if (!session) { this.store.toast('That session no longer exists', 'error'); return; }
    const data = session.data as ReturnType<DjConsole['captureSession']>;

    this.store.state.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    this.setCrossfader(data.crossfader);
    this.setMasterVolume(data.masterVolume);
    this.setCueVolume(data.cueVolume);
    this.setCueMix(data.cueMix);

    for (const id2 of this.engine.deckIds) {
      const d = (data.decks as Record<string, any>)[id2];
      if (!d) continue;
      if (d.trackId && this.store.state.tracks.has(d.trackId)) {
        await this.loadTrack(id2, d.trackId, { force: true });
        const deck = this.engine.deck(id2);
        if (d.grid) deck.grid = d.grid;
        deck.seek(d.position ?? 0);
        this.setPitchPercent(id2, d.pitchPercent ?? 0);
        this.setKeyLock(id2, d.keyLock ?? true);
        this.setKeyShift(id2, d.keyShift ?? 0);
        this.store.updateDeck(id2, {
          hotCues: d.hotCues ?? [], cuePoint: d.cuePoint ?? 0,
          quantize: d.quantize ?? true, quantizeDivision: d.quantizeDivision ?? 1,
        });
        if (d.loop && d.loop.end > d.loop.start) {
          this.setLoopRegion(id2, d.loop.start, d.loop.end, d.loop.enabled);
          this.store.updateDeck(id2, { loopBeats: d.loop.beats ?? 4 });
        }
        if (d.mixer) {
          this.setTrim(id2, d.mixer.trim ?? 0);
          this.setEq(id2, 'low', d.mixer.eqLow ?? 0);
          this.setEq(id2, 'mid', d.mixer.eqMid ?? 0);
          this.setEq(id2, 'high', d.mixer.eqHigh ?? 0);
          this.setFilter(id2, d.mixer.filter ?? 0);
          this.setFader(id2, d.mixer.fader ?? 1);
        }
        if (d.slip) this.setSlip(id2, true);
      } else if (d.trackId) {
        this.store.toast('A track from this session is missing', 'warn', {
          detail: 'It is no longer in the local library, so that deck was left empty.',
        });
      }
    }

    if (data.fx) {
      data.fx.forEach((f, i) => {
        if (i >= this.engine.fxUnits.length) this.engine.addFxUnit(f.id);
        this.engine.setFxType(i, f.id);
        this.engine.setFxParams(i, { a: f.a, b: f.b, wet: f.wet });
        this.engine.setFxEnabled(i, f.enabled);
      });
      this.syncFxState();
    }

    this.setMaster(data.master ?? null);
    for (const id2 of this.engine.deckIds) {
      const d = (data.decks as Record<string, any>)[id2];
      if (d?.syncEnabled) this.toggleSync(id2);
    }

    this.store.state.sessionName = session.name;
    this.store.notify('deck', 'mixer', 'fx', 'settings');
    this.store.toast(`Loaded session "${session.name}"`, 'success');
  }

  /** Next phrase boundary on a deck, used by the transition engine. */
  nextPhraseOn(deckId: DeckId): number {
    const deck = this.engine.deck(deckId);
    if (!deck.hasTrack || deck.grid.bpm <= 0) return deck.position;
    return nextPhrase(deck.grid, deck.position, this.store.state.settings.phraseBeats);
  }

  quantiseForwardOn(deckId: DeckId, division: number): number {
    const deck = this.engine.deck(deckId);
    if (deck.grid.bpm <= 0) return deck.position;
    return quantiseForward(deck.grid, deck.position, division);
  }
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00.0';
  const neg = seconds < 0;
  const abs = Math.abs(seconds);
  const m = Math.floor(abs / 60);
  const s = Math.floor(abs % 60);
  const d = Math.floor((abs % 1) * 10);
  return `${neg ? '-' : ''}${m}:${s.toString().padStart(2, '0')}.${d}`;
}

export { dbToGain, gainToDb };
