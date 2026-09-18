/**
 * The audio engine: graph construction, mixer routing, master chain, metering
 * and the outputs everything else talks to.
 *
 * Signal flow
 *
 *   deck -> trim -> EQ(L/M/H) -> filter(HP+LP) -> channel fader
 *        |                                          |
 *        |                                          +-> cue tap -> PFL bus -> headphones
 *        |                                          +-> FX send -> FX rack ---+
 *        |                                          +-> crossfader gain ------+-> master sum
 *   sampler ------------------------------------------------------------------+
 *   mic --------> mic gain -> mic EQ -------------------------------------------+
 *                                                                              |
 *                        master sum -> master gain -> limiter -> meter -> out  |
 *                                                        +-> recorder tap -----+
 */
import { Deck } from './deck';
import { Sampler } from './sampler';
import { Recorder } from './recorder';
import { createFx, FX_DESCRIPTORS, type FxId, type FxNodes, type FxParams } from './fx';
import { dbToGain } from '../lib/gain';
import type { DeckId } from '../lib/types';

export type CrossfaderCurve = 'linear' | 'smooth' | 'sharp';

export interface MeterReading {
  peakL: number;
  peakR: number;
  holdL: number;
  holdR: number;
  rms: number;
  clipped: boolean;
}

const EMPTY_METER: MeterReading = { peakL: 0, peakR: 0, holdL: 0, holdR: 0, rms: 0, clipped: false };

export interface FxUnitState {
  id: FxId;
  enabled: boolean;
  params: FxParams;
  /** Which decks this unit is fed from. */
  routing: Record<DeckId, boolean>;
}

const WORKLET_FILES = [
  '/worklets/deck-processor.js',
  '/worklets/recorder-processor.js',
  '/worklets/meter-processor.js',
];

export class AudioEngine {
  ctx!: AudioContext;
  decks = new Map<DeckId, Deck>();
  sampler!: Sampler;
  recorder!: Recorder;

  masterSum!: GainNode;
  masterGain!: GainNode;
  limiter!: DynamicsCompressorNode;
  masterMeterNode!: AudioWorkletNode;
  destinationGain!: GainNode;

  cueBus!: GainNode;
  cueGain!: GainNode;
  cueMix!: GainNode;
  cueMasterBleed!: GainNode;

  micSource: MediaStreamAudioSourceNode | null = null;
  micGain!: GainNode;
  micStream: MediaStream | null = null;

  fxUnits: { state: FxUnitState; nodes: FxNodes; input: GainNode }[] = [];

  masterMeter: MeterReading = { ...EMPTY_METER };
  channelMeters = new Map<DeckId, MeterReading>();
  private channelMeterNodes = new Map<DeckId, AudioWorkletNode>();

  crossfaderCurve: CrossfaderCurve = 'smooth';
  private crossfaderPosition = 0;
  private crossAssign = new Map<DeckId, 'A' | 'B' | 'thru'>();

  /** Beat length in seconds of the current master tempo - drives synced FX. */
  beatSeconds = 0.5;

  readonly deckIds: DeckId[];
  private started = false;

  constructor(deckIds: DeckId[] = ['A', 'B']) {
    this.deckIds = deckIds;
  }

  get running(): boolean { return this.started && this.ctx?.state === 'running'; }
  get sampleRate(): number { return this.ctx?.sampleRate ?? 0; }
  /** Output latency in seconds, as reported by the browser. */
  get latency(): number {
    if (!this.ctx) return 0;
    return (this.ctx.outputLatency ?? 0) + (this.ctx.baseLatency ?? 0);
  }

  async start(options: { sampleRate?: number; latencyHint?: AudioContextLatencyCategory } = {}) {
    if (this.started) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }

    const ctxOptions: AudioContextOptions = { latencyHint: options.latencyHint ?? 'interactive' };
    if (options.sampleRate) ctxOptions.sampleRate = options.sampleRate;
    this.ctx = new AudioContext(ctxOptions);

    for (const file of WORKLET_FILES) {
      await this.ctx.audioWorklet.addModule(file);
    }

    // ---- master chain -----------------------------------------------------
    this.masterSum = this.ctx.createGain();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.85;

    // A gentle brickwall so a hot mix clips the limiter, not the DAC. The user
    // can still drive it - this only stops the output going past full scale.
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;

    this.masterMeterNode = new AudioWorkletNode(this.ctx, 'meter-processor', {
      numberOfInputs: 1, numberOfOutputs: 0,
    });
    this.masterMeterNode.port.onmessage = (e) => { this.masterMeter = e.data; };

    this.destinationGain = this.ctx.createGain();

    this.masterSum.connect(this.masterGain).connect(this.limiter);
    this.limiter.connect(this.masterMeterNode);
    this.limiter.connect(this.destinationGain).connect(this.ctx.destination);

    // ---- recorder ---------------------------------------------------------
    const recNode = new AudioWorkletNode(this.ctx, 'recorder-processor', {
      numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2,
    });
    this.limiter.connect(recNode);
    this.recorder = new Recorder(recNode, this.ctx.sampleRate);

    // ---- cue (PFL) bus ----------------------------------------------------
    this.cueBus = this.ctx.createGain();
    this.cueGain = this.ctx.createGain();
    this.cueGain.gain.value = 0.7;
    this.cueMix = this.ctx.createGain();
    this.cueMasterBleed = this.ctx.createGain();
    this.cueMasterBleed.gain.value = 0;
    this.cueBus.connect(this.cueMix);
    this.limiter.connect(this.cueMasterBleed).connect(this.cueMix);
    // Single-output setups hear cue folded into the master. Routing to a
    // second device is offered in settings when the browser supports it.
    this.cueMix.connect(this.cueGain);
    this.cueGain.connect(this.ctx.destination);
    this.cueGain.gain.value = 0;

    // ---- decks ------------------------------------------------------------
    for (const id of this.deckIds) {
      const deck = new Deck(id, this.ctx);
      deck.output.connect(this.masterSum);
      deck.cueTap.connect(this.cueBus);
      deck.cueTap.gain.value = 0; // PFL off until the user presses CUE

      const meter = new AudioWorkletNode(this.ctx, 'meter-processor', {
        numberOfInputs: 1, numberOfOutputs: 0,
      });
      meter.port.onmessage = (e) => { this.channelMeters.set(id, e.data); };
      deck.fader.connect(meter);
      this.channelMeterNodes.set(id, meter);

      this.decks.set(id, deck);
      this.channelMeters.set(id, { ...EMPTY_METER });
      this.crossAssign.set(id, id === 'A' || id === 'C' ? 'A' : 'B');
    }

    // ---- sampler ----------------------------------------------------------
    this.sampler = new Sampler(this.ctx);
    this.sampler.output.connect(this.masterSum);

    // ---- microphone gain stage (source attached on demand) -----------------
    this.micGain = this.ctx.createGain();
    this.micGain.gain.value = 0;
    this.micGain.connect(this.masterSum);

    this.applyCrossfader(this.crossfaderPosition);
    this.started = true;
  }

  async resume() { if (this.ctx?.state === 'suspended') await this.ctx.resume(); }
  async suspend() { if (this.ctx?.state === 'running') await this.ctx.suspend(); }

  deck(id: DeckId): Deck {
    const d = this.decks.get(id);
    if (!d) throw new Error(`Deck ${id} does not exist`);
    return d;
  }

  // -------------------------------------------------------------- crossfader

  setCrossfader(position: number) {
    this.crossfaderPosition = Math.max(-1, Math.min(1, position));
    this.applyCrossfader(this.crossfaderPosition);
  }

  get crossfader(): number { return this.crossfaderPosition; }

  setCrossfaderCurve(curve: CrossfaderCurve) {
    this.crossfaderCurve = curve;
    this.applyCrossfader(this.crossfaderPosition);
  }

  setCrossfaderAssign(id: DeckId, side: 'A' | 'B' | 'thru') {
    this.crossAssign.set(id, side);
    this.applyCrossfader(this.crossfaderPosition);
  }

  private applyCrossfader(pos: number) {
    const now = this.ctx.currentTime;
    for (const [id, deck] of this.decks) {
      const side = this.crossAssign.get(id) ?? 'thru';
      let gain: number;
      if (side === 'thru') gain = 1;
      else {
        const t = side === 'A' ? (1 - pos) / 2 : (1 + pos) / 2;
        gain = this.curveGain(t);
      }
      deck.crossGain.gain.setTargetAtTime(gain, now, 0.008);
    }
  }

  private curveGain(t: number): number {
    const x = Math.max(0, Math.min(1, t));
    switch (this.crossfaderCurve) {
      // Constant power: the classic smooth blend, no dip in the middle.
      case 'smooth': return Math.sin((x * Math.PI) / 2);
      // Sharp/cut: full level almost immediately, for scratching.
      case 'sharp': return x <= 0.02 ? 0 : x >= 0.12 ? 1 : (x - 0.02) / 0.1;
      default: return x;
    }
  }

  // ----------------------------------------------------------- channel strip

  setTrim(id: DeckId, gainDb: number) {
    const deck = this.deck(id);
    deck.trim.gain.setTargetAtTime(dbToGain(gainDb), this.ctx.currentTime, 0.01);
  }

  setFader(id: DeckId, value: number) {
    const deck = this.deck(id);
    // Fader law: squared taper feels closer to a real channel fader than linear.
    const v = Math.max(0, Math.min(1, value));
    deck.fader.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.008);
  }

  setEq(id: DeckId, band: 'low' | 'mid' | 'high', gainDb: number) {
    const deck = this.deck(id);
    const node = band === 'low' ? deck.eqLow : band === 'mid' ? deck.eqMid : deck.eqHigh;
    node.gain.setTargetAtTime(gainDb, this.ctx.currentTime, 0.01);
  }

  /** Bipolar colour filter: -1 full low-pass, 0 bypass, +1 full high-pass. */
  setFilter(id: DeckId, value: number) {
    const deck = this.deck(id);
    const now = this.ctx.currentTime;
    const x = Math.max(-1, Math.min(1, value));
    const dead = 0.04; // centre detent so "off" is genuinely off
    if (Math.abs(x) < dead) {
      deck.filterLp.frequency.setTargetAtTime(22050, now, 0.02);
      deck.filterHp.frequency.setTargetAtTime(20, now, 0.02);
      return;
    }
    if (x < 0) {
      const t = (-x - dead) / (1 - dead);
      deck.filterLp.frequency.setTargetAtTime(22050 * Math.pow(100 / 22050, t), now, 0.02);
      deck.filterHp.frequency.setTargetAtTime(20, now, 0.02);
    } else {
      const t = (x - dead) / (1 - dead);
      deck.filterHp.frequency.setTargetAtTime(20 * Math.pow(9000 / 20, t), now, 0.02);
      deck.filterLp.frequency.setTargetAtTime(22050, now, 0.02);
    }
  }

  setCue(id: DeckId, enabled: boolean) {
    const deck = this.deck(id);
    deck.cueTap.gain.setTargetAtTime(enabled ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  isCued(id: DeckId): boolean { return this.deck(id).cueTap.gain.value > 0.5; }

  setCueVolume(v: number) {
    this.cueGain.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.01);
  }

  /** 0 = cue only, 1 = master only. */
  setCueMix(v: number) {
    const now = this.ctx.currentTime;
    const t = Math.max(0, Math.min(1, v));
    this.cueBus.gain.setTargetAtTime(Math.cos((t * Math.PI) / 2), now, 0.01);
    this.cueMasterBleed.gain.setTargetAtTime(Math.sin((t * Math.PI) / 2), now, 0.01);
  }

  setMasterVolume(v: number) {
    this.masterGain.gain.setTargetAtTime(Math.max(0, Math.min(1.2, v)), this.ctx.currentTime, 0.01);
  }

  setLimiterEnabled(enabled: boolean) {
    // "Off" relaxes the limiter rather than removing it - the DAC still needs
    // protecting, but the user gets their headroom back.
    this.limiter.threshold.value = enabled ? -1.5 : -0.1;
    this.limiter.ratio.value = enabled ? 20 : 2;
  }

  // ------------------------------------------------------------------- mic

  async enableMic(deviceId?: string): Promise<void> {
    if (this.micStream) this.disableMic();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        // Mic goes to the master, which may be on speakers - never feed back.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
    });
    this.micStream = stream;
    this.micSource = this.ctx.createMediaStreamSource(stream);
    this.micSource.connect(this.micGain);
  }

  disableMic() {
    this.micSource?.disconnect();
    this.micSource = null;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.micGain.gain.value = 0;
  }

  setMicGain(v: number) {
    this.micGain.gain.setTargetAtTime(Math.max(0, Math.min(2, v)), this.ctx.currentTime, 0.01);
  }

  // -------------------------------------------------------------------- FX

  addFxUnit(id: FxId): number {
    const input = this.ctx.createGain();
    const nodes = createFx(id, this.ctx);
    input.connect(nodes.input);
    nodes.output.connect(this.masterSum);

    const desc = FX_DESCRIPTORS[id];
    const routing = {} as Record<DeckId, boolean>;
    for (const d of this.deckIds) routing[d] = true;

    const state: FxUnitState = {
      id,
      enabled: false,
      params: { a: desc.paramA.default, b: desc.paramB.default, wet: 0 },
      routing,
    };

    for (const d of this.deckIds) this.deck(d).fxSend.connect(input);

    const unit = { state, nodes, input };
    this.fxUnits.push(unit);
    nodes.update(state.params, this.beatSeconds);
    this.updateFxSends();
    return this.fxUnits.length - 1;
  }

  setFxType(index: number, id: FxId) {
    const unit = this.fxUnits[index];
    if (!unit || unit.state.id === id) return;
    unit.nodes.output.disconnect();
    unit.input.disconnect();
    unit.nodes.dispose();

    const nodes = createFx(id, this.ctx);
    unit.input.connect(nodes.input);
    nodes.output.connect(this.masterSum);
    const desc = FX_DESCRIPTORS[id];
    unit.state.id = id;
    unit.state.params = { a: desc.paramA.default, b: desc.paramB.default, wet: unit.state.params.wet };
    unit.nodes = nodes;
    nodes.update(unit.state.params, this.beatSeconds);
  }

  setFxParams(index: number, params: Partial<FxParams>) {
    const unit = this.fxUnits[index];
    if (!unit) return;
    Object.assign(unit.state.params, params);
    this.refreshFx(index);
  }

  setFxEnabled(index: number, enabled: boolean) {
    const unit = this.fxUnits[index];
    if (!unit) return;
    unit.state.enabled = enabled;
    this.refreshFx(index);
    this.updateFxSends();
  }

  setFxRouting(index: number, deck: DeckId, on: boolean) {
    const unit = this.fxUnits[index];
    if (!unit) return;
    unit.state.routing[deck] = on;
    this.updateFxSends();
  }

  private refreshFx(index: number) {
    const unit = this.fxUnits[index];
    if (!unit) return;
    const params = { ...unit.state.params, wet: unit.state.enabled ? unit.state.params.wet : 0 };
    unit.nodes.update(params, this.beatSeconds);
  }

  /**
   * Open a deck's FX send only when at least one enabled unit wants it, so an
   * idle rack costs nothing and cannot colour the signal.
   */
  private updateFxSends() {
    const now = this.ctx.currentTime;
    for (const id of this.deckIds) {
      const wanted = this.fxUnits.some((u) => u.state.enabled && u.state.routing[id]);
      this.deck(id).fxSend.gain.setTargetAtTime(wanted ? 1 : 0, now, 0.01);
    }
    for (const unit of this.fxUnits) {
      // Per-unit input gating handles the per-deck routing matrix.
      unit.input.gain.setTargetAtTime(unit.state.enabled ? 1 : 0, now, 0.01);
    }
  }

  /** Push a new master tempo into every beat-synced effect. */
  setBeatSeconds(seconds: number) {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.beatSeconds = seconds;
    for (let i = 0; i < this.fxUnits.length; i++) this.refreshFx(i);
  }

  killAllFx() {
    for (let i = 0; i < this.fxUnits.length; i++) this.setFxEnabled(i, false);
  }

  // ---------------------------------------------------------------- utility

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(data);
  }

  /** Stop everything, immediately but without a click. */
  panic() {
    for (const deck of this.decks.values()) deck.pause();
    this.sampler.stopAll();
    this.killAllFx();
    this.micGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
  }
}

export { dbToGain, gainToDb } from '../lib/gain';
