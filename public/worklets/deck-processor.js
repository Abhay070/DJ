/**
 * DeckProcessor - the real-time playback core of one DJ deck.
 *
 * Everything that must be sample-accurate happens here, on the audio thread:
 *
 *   - fractional playhead with cubic (Catmull-Rom) interpolated resampling
 *   - WSOLA time-stretching so tempo can change without changing pitch (key lock)
 *   - independent pitch shifting (key shift) via resampling the stretched stream
 *   - sample-accurate looping (the source reader wraps, so grains that straddle
 *     the loop end read the loop start - which is exactly the audio that follows)
 *   - slip mode via a shadow playhead that ignores loops and scratching
 *   - scratching / reverse through direct negative-rate resampling
 *   - de-click ramps on play, pause and seek
 *
 * The playhead maintained here is the single source of truth for position. It is
 * published to the main thread every block, through a SharedArrayBuffer when the
 * page is cross-origin isolated and through postMessage otherwise. The UI never
 * computes position itself.
 *
 * Timing invariant: whichever internal path is active, the source playhead
 * advances by exactly `rate` samples per output sample on average. WSOLA's
 * per-grain correlation offset shifts which samples are *read*, never how far
 * the drift-free analysis pointer advances, so tempo stretching introduces no
 * cumulative drift.
 */

const DECLICK_SECONDS = 0.004;

// WSOLA parameters. HS is the synthesis hop; a periodic Hann window of 2*HS with
// 50% overlap sums to exactly 1.0, so overlap-add is unity-gain.
const HS = 512;
const WIN = HS * 2;
const SEARCH_R = 128; // +/- search radius, in samples, for grain alignment
const CORR_LEN = 256; // correlation template length
const CORR_DECIM = 2; // correlate on a 2x decimated signal to cut CPU
const OUT_RING = 8192; // must be a power of two and > WIN + one render quantum

// Shared state slot indices (Float64Array). Mirrored in src/audio/deck.ts.
const S_POSITION = 0;
const S_PLAYING = 1;
const S_RATE = 2;
const S_TIME = 3;
const S_LOOP_ACTIVE = 4;
const S_ENDED = 5;
const S_SLIP = 6;
const S_DURATION = 7;
const S_SLOTS = 8;

function makeHann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    /** @type {Float32Array[]} decoded source audio, already at context sample rate */
    this.channels = [];
    this.frames = 0;
    this.duration = 0;

    // Transport
    this.playRequested = false;
    this.rendering = false;
    this.sourcePos = 0; // fractional sample index - authoritative playhead
    this.slipPos = 0;
    this.slipActive = false;
    this.ended = false;
    this.endedCount = 0;

    // Rate control
    this.rateTarget = 1;
    this.rate = 1;
    this.scratchActive = false;
    this.rateSmoothing = 0; // computed in process() once sampleRate is known

    // Key lock / pitch
    this.keyLock = false;
    this.pitchRatio = 1; // from key shift in semitones

    // Loop
    this.loopActive = false;
    this.loopStart = 0; // samples
    this.loopEnd = 0; // samples

    // De-click envelope
    this.gain = 0;
    this.gainTarget = 0;
    this.gainStep = 1;
    this.pendingSeek = null;

    // WSOLA state
    this.window = makeHann(WIN);
    this.outRing = [];
    this.olaPos = 0; // absolute index of next grain OLA write
    this.finalized = 0; // absolute index up to which output is complete
    this.readPos = 0; // fractional absolute read index into the ring
    this.analysisPos = 0; // drift-free source pointer for WSOLA
    this.template = null; // natural-continuation template for correlation
    this.wsolaPrimed = false;

    // Shared state
    this.shared = null;
    this.reportCounter = 0;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  // ---------------------------------------------------------------- messages

  onMessage(msg) {
    switch (msg.type) {
      case 'load': {
        this.channels = msg.channels.map((c) => new Float32Array(c));
        this.frames = this.channels.length ? this.channels[0].length : 0;
        this.duration = this.frames / sampleRate;
        this.sourcePos = 0;
        this.slipPos = 0;
        this.playRequested = false;
        this.rendering = false;
        this.gain = 0;
        this.gainTarget = 0;
        this.loopActive = false;
        this.ended = false;
        this.resetWsola();
        this.allocRing();
        this.port.postMessage({ type: 'loaded', duration: this.duration, frames: this.frames });
        break;
      }
      case 'unload': {
        this.channels = [];
        this.frames = 0;
        this.duration = 0;
        this.sourcePos = 0;
        this.playRequested = false;
        this.rendering = false;
        this.gain = 0;
        this.gainTarget = 0;
        this.loopActive = false;
        break;
      }
      case 'play':
        if (!this.frames) break;
        if (this.ended && this.sourcePos >= this.frames - 1) this.sourcePos = 0;
        this.ended = false;
        this.playRequested = true;
        this.rendering = true;
        this.gainTarget = 1;
        break;
      case 'pause':
        this.playRequested = false;
        this.gainTarget = 0;
        break;
      case 'seek':
        this.pendingSeek = Math.max(0, Math.min(this.frames, msg.position * sampleRate));
        this.gainTarget = 0; // ramp out, jump at zero crossing of the envelope
        break;
      case 'setRate':
        this.rateTarget = msg.rate;
        break;
      case 'scratch':
        this.scratchActive = !!msg.active;
        if (msg.rate !== undefined) this.rateTarget = msg.rate;
        break;
      case 'setKeyLock':
        this.keyLock = !!msg.enabled;
        this.resetWsola();
        break;
      case 'setPitch':
        this.pitchRatio = Math.pow(2, (msg.semitones || 0) / 12);
        this.resetWsola();
        break;
      case 'setLoop': {
        const start = Math.max(0, Math.round(msg.start * sampleRate));
        const end = Math.max(start + 16, Math.round(msg.end * sampleRate));
        this.loopStart = start;
        this.loopEnd = Math.min(end, this.frames || end);
        this.loopActive = !!msg.enabled;
        break;
      }
      case 'setLoopActive':
        this.loopActive = !!msg.enabled && this.loopEnd > this.loopStart;
        break;
      case 'setSlip':
        if (msg.enabled && !this.slipActive) this.slipPos = this.sourcePos;
        if (!msg.enabled && this.slipActive) {
          // Leaving slip: jump to where the track would have been.
          this.pendingSeek = Math.max(0, Math.min(this.frames, this.slipPos));
          this.gainTarget = 0;
        }
        this.slipActive = !!msg.enabled;
        break;
      case 'slipReturn':
        this.pendingSeek = Math.max(0, Math.min(this.frames, this.slipPos));
        this.gainTarget = 0;
        break;
      case 'shared':
        this.shared = new Float64Array(msg.sab);
        break;
      default:
        break;
    }
  }

  allocRing() {
    const nch = Math.max(1, this.channels.length);
    this.outRing = [];
    for (let c = 0; c < nch; c++) this.outRing.push(new Float32Array(OUT_RING));
  }

  resetWsola() {
    this.olaPos = 0;
    this.finalized = 0;
    this.readPos = 0;
    this.analysisPos = this.sourcePos;
    this.template = null;
    this.wsolaPrimed = false;
    for (const buf of this.outRing) buf.fill(0);
  }

  // ------------------------------------------------------------ source reads

  /** Wrap a source position into the active loop region. */
  wrap(pos) {
    if (this.loopActive) {
      const len = this.loopEnd - this.loopStart;
      if (len > 0) {
        let p = pos - this.loopStart;
        p = p - Math.floor(p / len) * len;
        return this.loopStart + p;
      }
    }
    return pos;
  }

  /** Catmull-Rom interpolated read of one channel at a fractional position. */
  srcAt(ch, pos) {
    const data = this.channels[ch];
    const n = this.frames;
    if (!data || n === 0) return 0;
    const i = Math.floor(pos);
    const t = pos - i;
    // Neighbour indices are wrapped too so loop boundaries stay continuous.
    const i0 = this.clampIdx(this.wrapIdx(i - 1));
    const i1 = this.clampIdx(this.wrapIdx(i));
    const i2 = this.clampIdx(this.wrapIdx(i + 1));
    const i3 = this.clampIdx(this.wrapIdx(i + 2));
    const p0 = data[i0], p1 = data[i1], p2 = data[i2], p3 = data[i3];
    const a = 2 * p1;
    const b = p2 - p0;
    const c = 2 * p0 - 5 * p1 + 4 * p2 - p3;
    const d = -p0 + 3 * p1 - 3 * p2 + p3;
    return 0.5 * (a + b * t + c * t * t + d * t * t * t);
  }

  wrapIdx(i) {
    if (this.loopActive) {
      const len = this.loopEnd - this.loopStart;
      if (len > 0) {
        let p = i - this.loopStart;
        p = p - Math.floor(p / len) * len;
        return this.loopStart + p;
      }
    }
    return i;
  }

  clampIdx(i) {
    if (i < 0) return 0;
    if (i >= this.frames) return this.frames - 1;
    return i;
  }

  // ------------------------------------------------------------------ WSOLA

  /**
   * Find the offset within +/-SEARCH_R that best continues the previous grain.
   * Correlation runs on a decimated signal - half-sample precision is plenty
   * because overlap-add smooths the join.
   */
  findBestOffset(basePos) {
    if (!this.template) return 0;
    let bestOffset = 0;
    let bestScore = -Infinity;
    const tmpl = this.template;
    const steps = CORR_LEN / CORR_DECIM;
    for (let d = -SEARCH_R; d <= SEARCH_R; d += CORR_DECIM) {
      let dot = 0;
      let energy = 1e-9;
      for (let k = 0; k < steps; k++) {
        const s = this.srcAt(0, basePos + d + k * CORR_DECIM);
        dot += s * tmpl[k];
        energy += s * s;
      }
      // Normalised correlation avoids locking onto loud passages.
      const score = dot / Math.sqrt(energy);
      if (score > bestScore) {
        bestScore = score;
        bestOffset = d;
      }
    }
    return bestOffset;
  }

  captureTemplate(grainStart) {
    const steps = CORR_LEN / CORR_DECIM;
    if (!this.template) this.template = new Float32Array(steps);
    for (let k = 0; k < steps; k++) {
      this.template[k] = this.srcAt(0, grainStart + HS + k * CORR_DECIM);
    }
  }

  /** Produce one WSOLA grain: HS more samples of finalized output. */
  wsolaIteration(stretchRead) {
    const nch = this.outRing.length;

    let grainStart;
    if (!this.wsolaPrimed) {
      grainStart = this.analysisPos;
      this.wsolaPrimed = true;
    } else {
      grainStart = this.analysisPos + this.findBestOffset(this.analysisPos);
    }

    // The tail half of the window has no prior contribution yet - clear it.
    for (let c = 0; c < nch; c++) {
      const ring = this.outRing[c];
      for (let i = HS; i < WIN; i++) ring[(this.olaPos + i) & (OUT_RING - 1)] = 0;
    }

    for (let c = 0; c < nch; c++) {
      const ring = this.outRing[c];
      const src = Math.min(c, this.channels.length - 1);
      for (let i = 0; i < WIN; i++) {
        const s = this.srcAt(src, grainStart + i);
        ring[(this.olaPos + i) & (OUT_RING - 1)] += s * this.window[i];
      }
    }

    this.captureTemplate(grainStart);

    this.olaPos += HS;
    this.finalized = this.olaPos;
    // Drift-free: the analysis pointer always advances by exactly the analysis
    // hop, never by the correlation offset.
    this.analysisPos = this.wrap(this.analysisPos + HS * stretchRead);
  }

  ringAt(ch, pos) {
    const ring = this.outRing[ch];
    const i = Math.floor(pos);
    const t = pos - i;
    const m = OUT_RING - 1;
    const p0 = ring[(i - 1) & m];
    const p1 = ring[i & m];
    const p2 = ring[(i + 1) & m];
    const p3 = ring[(i + 2) & m];
    const a = 2 * p1;
    const b = p2 - p0;
    const c = 2 * p0 - 5 * p1 + 4 * p2 - p3;
    const d = -p0 + 3 * p1 - 3 * p2 + p3;
    return 0.5 * (a + b * t + c * t * t + d * t * t * t);
  }

  // ---------------------------------------------------------------- process

  process(_inputs, outputs) {
    const out = outputs[0];
    const blockSize = out[0].length;
    const nOut = out.length;

    if (this.rateSmoothing === 0) {
      this.gainStep = 1 / Math.max(1, DECLICK_SECONDS * sampleRate);
      // One-pole coefficient for ~12 ms rate smoothing.
      this.rateSmoothing = 1 - Math.exp(-1 / (0.012 * sampleRate));
    }

    if (!this.frames) {
      for (let c = 0; c < nOut; c++) out[c].fill(0);
      this.publish();
      return true;
    }

    // Apply a pending seek once the de-click envelope has reached silence.
    if (this.pendingSeek !== null && this.gain <= 0.0001) {
      this.sourcePos = this.pendingSeek;
      this.slipPos = this.pendingSeek;
      this.pendingSeek = null;
      this.resetWsola();
      this.gainTarget = this.playRequested ? 1 : 0;
    }

    // Choose the signal path. WSOLA only runs when it has work to do and only
    // for forward, non-scratch playback - scratching and reverse are always
    // direct resampling, which is what makes them sound like a record.
    const targetRate = this.rateTarget;
    const usePitchStage = this.keyLock || Math.abs(this.pitchRatio - 1) > 1e-6;
    const forward = targetRate > 0 && !this.scratchActive;
    const useWsola = usePitchStage && forward && this.frames > WIN * 2;

    if (useWsola) this.processStretched(out, blockSize, nOut);
    else this.processDirect(out, blockSize, nOut);

    this.publish();
    return true;
  }

  /** Direct variable-rate resampling. Handles scratch, reverse and no-key-lock. */
  processDirect(out, blockSize, nOut) {
    // Leaving the stretch path invalidates its buffered output.
    if (this.wsolaPrimed) this.resetWsola();

    for (let i = 0; i < blockSize; i++) {
      this.advanceGain();
      const active = this.gain > 0 || this.playRequested;

      if (!active) {
        for (let c = 0; c < nOut; c++) out[c][i] = 0;
        continue;
      }

      if (this.scratchActive) this.rate = this.rateTarget;
      else this.rate += (this.rateTarget - this.rate) * this.rateSmoothing;

      for (let c = 0; c < nOut; c++) {
        const src = Math.min(c, this.channels.length - 1);
        out[c][i] = this.srcAt(src, this.sourcePos) * this.gain;
      }

      if (this.rendering) this.advancePosition(this.rate);
    }
    this.finishBlock();
  }

  /** WSOLA stretch stage followed by a resampling pitch stage. */
  processStretched(out, blockSize, nOut) {
    // speed = stretchRead * pitchRatio, pitch = pitchRatio. Solve for the read
    // rate the stretch stage must consume the source at.
    for (let i = 0; i < blockSize; i++) {
      this.advanceGain();
      const active = this.gain > 0 || this.playRequested;

      if (!active) {
        for (let c = 0; c < nOut; c++) out[c][i] = 0;
        continue;
      }

      this.rate += (this.rateTarget - this.rate) * this.rateSmoothing;

      const pitch = this.keyLock ? this.pitchRatio : this.rate * this.pitchRatio;
      const stretchRead = this.rate / pitch;

      // Keep the ring one render quantum ahead of the reader.
      while (this.finalized - this.readPos < 4) {
        this.wsolaIteration(stretchRead);
      }

      for (let c = 0; c < nOut; c++) {
        const ch = Math.min(c, this.outRing.length - 1);
        out[c][i] = this.ringAt(ch, this.readPos) * this.gain;
      }

      if (this.rendering) {
        this.readPos += pitch;
        // The heard position trails the analysis pointer by whatever the ring
        // still holds, scaled back into source time.
        const pending = this.finalized - this.readPos;
        this.sourcePos = this.wrap(this.analysisPos - pending * stretchRead);
        this.advanceSlip(this.rate);
      }
    }
    this.finishBlock();
  }

  advanceGain() {
    if (this.gain < this.gainTarget) this.gain = Math.min(this.gainTarget, this.gain + this.gainStep);
    else if (this.gain > this.gainTarget) this.gain = Math.max(this.gainTarget, this.gain - this.gainStep);
  }

  advancePosition(rate) {
    this.sourcePos = this.wrap(this.sourcePos + rate);
    this.advanceSlip(rate);
  }

  advanceSlip(rate) {
    // The slip playhead ignores loops and scratching: it tracks where the track
    // would be if you had never touched it.
    this.slipPos += this.slipActive ? Math.abs(this.rateTarget) * Math.sign(rate || 1) : rate;
    if (this.slipActive) this.slipPos = Math.max(0, Math.min(this.frames, this.slipPos));
  }

  finishBlock() {
    // Stop rendering entirely once a pause has fully faded out.
    if (!this.playRequested && this.gain <= 0.0001) this.rendering = false;

    if (!this.loopActive && this.frames) {
      if (this.sourcePos >= this.frames - 1) {
        this.sourcePos = this.frames - 1;
        if (!this.ended) {
          this.ended = true;
          this.endedCount++;
          this.playRequested = false;
          this.gainTarget = 0;
          this.port.postMessage({ type: 'ended' });
        }
      } else if (this.sourcePos < 0) {
        this.sourcePos = 0;
        this.playRequested = false;
        this.gainTarget = 0;
      }
    }
  }

  publish() {
    const playing = this.playRequested && this.gain > 0.0001;
    if (this.shared) {
      this.shared[S_POSITION] = this.sourcePos / sampleRate;
      this.shared[S_PLAYING] = playing ? 1 : 0;
      this.shared[S_RATE] = this.rendering ? this.rate : 0;
      this.shared[S_TIME] = currentTime;
      this.shared[S_LOOP_ACTIVE] = this.loopActive ? 1 : 0;
      this.shared[S_ENDED] = this.endedCount;
      this.shared[S_SLIP] = this.slipActive ? this.slipPos / sampleRate : -1;
      this.shared[S_DURATION] = this.duration;
    } else {
      // Fallback transport: ~60 Hz is enough for the UI when SAB is unavailable.
      this.reportCounter++;
      if (this.reportCounter * 128 >= sampleRate / 60) {
        this.reportCounter = 0;
        this.port.postMessage({
          type: 'position',
          position: this.sourcePos / sampleRate,
          playing,
          rate: this.rendering ? this.rate : 0,
          time: currentTime,
          loopActive: this.loopActive,
          slip: this.slipActive ? this.slipPos / sampleRate : -1,
        });
      }
    }
  }
}

DeckProcessor.SLOTS = S_SLOTS;
registerProcessor('deck-processor', DeckProcessor);
