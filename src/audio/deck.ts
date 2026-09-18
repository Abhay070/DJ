/**
 * Main-thread face of one deck.
 *
 * Owns the AudioWorkletNode plus the channel strip (EQ -> filter -> gain), and
 * mirrors - never invents - the playhead the worklet publishes. Every getter
 * here reads engine state; if the worklet says it is at 1:23.456, that is what
 * the UI shows.
 */
import type { Analysis, DeckId, BeatGrid } from '../lib/types';
import { beatAt, timeAtBeat, effectiveBpm } from '../lib/grid';

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// Mirrors the slot layout in public/worklets/deck-processor.js
const S_POSITION = 0;
const S_PLAYING = 1;
const S_RATE = 2;
const S_TIME = 3;
const S_LOOP_ACTIVE = 4;
const S_ENDED = 5;
const S_SLIP = 6;
const S_SLOTS = 8;

export interface DeckSnapshot {
  position: number;
  playing: boolean;
  rate: number;
  loopActive: boolean;
  slipPosition: number;
  duration: number;
}

export type DeckEvent = 'ended' | 'loaded' | 'position';

export class Deck {
  readonly id: DeckId;
  readonly node: AudioWorkletNode;

  // Channel strip
  readonly eqLow: BiquadFilterNode;
  readonly eqMid: BiquadFilterNode;
  readonly eqHigh: BiquadFilterNode;
  readonly filterLp: BiquadFilterNode;
  readonly filterHp: BiquadFilterNode;
  readonly trim: GainNode;
  readonly fader: GainNode;
  readonly crossGain: GainNode;
  /** Post-fader, pre-crossfader tap - this is what PFL listens to. */
  readonly cueTap: GainNode;
  readonly fxSend: GainNode;
  readonly output: GainNode;

  analysis: Analysis | null = null;
  trackId: string | null = null;
  duration = 0;

  /** Grid actually in use - may be a user-edited copy of the analysed grid. */
  grid: BeatGrid = { firstBeat: 0, bpm: 0, downbeatOffset: 0, locked: false };

  private shared: Float64Array | null = null;
  private fallback: DeckSnapshot = {
    position: 0, playing: false, rate: 0, loopActive: false, slipPosition: -1, duration: 0,
  };
  private lastEndedCount = 0;
  private listeners = new Map<DeckEvent, Set<(payload?: unknown) => void>>();

  // Desired rate before sync trim, i.e. what the pitch fader asks for.
  baseRate = 1;
  /** Multiplicative correction applied by the sync PLL. */
  syncTrim = 1;
  /** Temporary pitch-bend multiplier (nudge). */
  bendFactor = 1;
  keyLock = true;
  keyShift = 0;
  scratching = false;

  /**
   * When play was last *requested*, as a performance.now() timestamp.
   *
   * Deliberately not "when the engine started producing sound": the worklet
   * fades in over a few milliseconds, so two decks started microseconds apart
   * can report themselves playing in either order depending on which render
   * quantum the fade lands in. The sync engine picks its master by who started
   * first, and that ordering has to be stable, so it comes from the request.
   */
  playStartedAt: number | null = null;

  constructor(id: DeckId, ctx: BaseAudioContext) {
    this.id = id;
    this.node = new AudioWorkletNode(ctx, 'deck-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    this.node.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'position') {
        this.fallback = {
          position: msg.position,
          playing: msg.playing,
          rate: msg.rate,
          loopActive: msg.loopActive,
          slipPosition: msg.slip,
          duration: this.duration,
        };
        this.emit('position');
      } else if (msg.type === 'ended') {
        this.playStartedAt = null;
        this.emit('ended');
      } else if (msg.type === 'loaded') {
        this.duration = msg.duration;
        this.emit('loaded');
      }
    };

    // SharedArrayBuffer gives the UI a jitter-free playhead without flooding
    // the message port. Falls back automatically when not cross-origin isolated.
    if (typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated) {
      try {
        const sab = new SharedArrayBuffer(S_SLOTS * 8);
        this.shared = new Float64Array(sab);
        this.node.port.postMessage({ type: 'shared', sab });
      } catch {
        this.shared = null;
      }
    }

    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 220;

    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1200;
    this.eqMid.Q.value = 0.9;

    this.eqHigh = ctx.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 3500;

    this.filterHp = ctx.createBiquadFilter();
    this.filterHp.type = 'highpass';
    this.filterHp.frequency.value = 20;
    this.filterHp.Q.value = 0.9;

    this.filterLp = ctx.createBiquadFilter();
    this.filterLp.type = 'lowpass';
    this.filterLp.frequency.value = 22050;
    this.filterLp.Q.value = 0.9;

    this.trim = ctx.createGain();
    this.fader = ctx.createGain();
    this.crossGain = ctx.createGain();
    this.cueTap = ctx.createGain();
    this.fxSend = ctx.createGain();
    this.fxSend.gain.value = 0;
    this.output = ctx.createGain();

    this.node
      .connect(this.trim)
      .connect(this.eqLow)
      .connect(this.eqMid)
      .connect(this.eqHigh)
      .connect(this.filterHp)
      .connect(this.filterLp)
      .connect(this.fader);

    // PFL is pre-crossfader so you can cue a track with the crossfader closed.
    this.fader.connect(this.cueTap);
    this.fader.connect(this.fxSend);
    this.fader.connect(this.crossGain).connect(this.output);
  }

  // ------------------------------------------------------------- listeners

  on(event: DeckEvent, fn: (payload?: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(fn);
    return () => set!.delete(fn);
  }

  private emit(event: DeckEvent, payload?: unknown) {
    this.listeners.get(event)?.forEach((fn) => fn(payload));
  }

  // ------------------------------------------------------------- transport

  async load(trackId: string, buffer: AudioBuffer, analysis: Analysis | null, bpmOverride: number | null) {
    this.trackId = trackId;
    this.analysis = analysis;
    this.duration = buffer.duration;

    const bpm = bpmOverride ?? analysis?.bpm ?? 0;
    this.grid = analysis
      ? { ...analysis.beatGrid, bpm, locked: analysis.beatGrid.locked || bpmOverride !== null }
      : { firstBeat: 0, bpm, downbeatOffset: 0, locked: false };

    const channels: Float32Array[] = [];
    const transfer: ArrayBufferLike[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const copy = new Float32Array(buffer.length);
      buffer.copyFromChannel(copy, c);
      channels.push(copy);
      transfer.push(copy.buffer);
    }
    this.node.port.postMessage({ type: 'load', channels }, transfer as Transferable[]);

    this.playStartedAt = null;
    this.baseRate = 1;
    this.syncTrim = 1;
    this.bendFactor = 1;
    this.pushRate();
    this.setKeyLock(this.keyLock);
    this.setKeyShift(0);
  }

  unload() {
    this.node.port.postMessage({ type: 'unload' });
    this.playStartedAt = null;
    this.trackId = null;
    this.analysis = null;
    this.duration = 0;
    this.grid = { firstBeat: 0, bpm: 0, downbeatOffset: 0, locked: false };
    if (this.shared) { this.shared[S_POSITION] = 0; this.shared[S_PLAYING] = 0; }
    this.fallback = { position: 0, playing: false, rate: 0, loopActive: false, slipPosition: -1, duration: 0 };
  }

  play() {
    if (!this.trackId) return;
    if (this.playStartedAt === null) this.playStartedAt = now();
    this.node.port.postMessage({ type: 'play' });
  }

  pause() {
    this.playStartedAt = null;
    this.node.port.postMessage({ type: 'pause' });
  }
  togglePlay() { this.playing ? this.pause() : this.play(); }
  seek(position: number) {
    this.node.port.postMessage({ type: 'seek', position: Math.max(0, Math.min(this.duration, position)) });
  }

  // ------------------------------------------------------------------ rate

  /** Recompute and push the effective rate: fader x sync trim x bend. */
  pushRate() {
    const rate = this.baseRate * this.syncTrim * this.bendFactor;
    this.node.port.postMessage({ type: 'setRate', rate });
  }

  setBaseRate(rate: number) { this.baseRate = rate; this.pushRate(); }
  setSyncTrim(trim: number) { this.syncTrim = trim; this.pushRate(); }
  setBend(factor: number) { this.bendFactor = factor; this.pushRate(); }

  setKeyLock(enabled: boolean) {
    this.keyLock = enabled;
    this.node.port.postMessage({ type: 'setKeyLock', enabled });
  }

  setKeyShift(semitones: number) {
    this.keyShift = semitones;
    this.node.port.postMessage({ type: 'setPitch', semitones });
  }

  scratch(rate: number, active: boolean) {
    this.scratching = active;
    this.node.port.postMessage({ type: 'scratch', rate, active });
    if (!active) this.pushRate();
  }

  // ------------------------------------------------------------------ loop

  setLoop(start: number, end: number, enabled: boolean) {
    this.node.port.postMessage({ type: 'setLoop', start, end, enabled });
  }

  setLoopActive(enabled: boolean) {
    this.node.port.postMessage({ type: 'setLoopActive', enabled });
  }

  setSlip(enabled: boolean) {
    this.node.port.postMessage({ type: 'setSlip', enabled });
  }

  slipReturn() {
    this.node.port.postMessage({ type: 'slipReturn' });
  }

  // ----------------------------------------------------------- engine state

  /** Live snapshot straight from the audio thread. */
  get state(): DeckSnapshot {
    if (this.shared) {
      const endedCount = this.shared[S_ENDED];
      if (endedCount !== this.lastEndedCount) {
        this.lastEndedCount = endedCount;
        // The port message also fires; this is belt and braces for SAB mode.
      }
      return {
        position: this.shared[S_POSITION],
        playing: this.shared[S_PLAYING] > 0.5,
        rate: this.shared[S_RATE],
        loopActive: this.shared[S_LOOP_ACTIVE] > 0.5,
        slipPosition: this.shared[S_SLIP],
        duration: this.duration,
      };
    }
    return this.fallback;
  }

  /** Audio-thread timestamp of the last published position, when available. */
  get stateTime(): number { return this.shared ? this.shared[S_TIME] : 0; }

  get position(): number { return this.state.position; }
  get playing(): boolean { return this.state.playing; }
  /** Rate the engine is actually running at - 0 when stopped. */
  get actualRate(): number { return this.state.rate; }
  /** Rate the engine will run at once playing. */
  get targetRate(): number { return this.baseRate * this.syncTrim * this.bendFactor; }

  /** Fractional beat number at the current playhead. */
  get beatPosition(): number {
    return this.grid.bpm > 0 ? beatAt(this.grid, this.position) : 0;
  }

  /** Tempo the deck is sounding at right now. */
  get currentBpm(): number {
    return effectiveBpm(this.grid, this.targetRate);
  }

  get originalBpm(): number { return this.grid.bpm; }

  timeAtBeat(beat: number): number { return timeAtBeat(this.grid, beat); }

  get hasTrack(): boolean { return this.trackId !== null; }
}
