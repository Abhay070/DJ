/**
 * MeterProcessor - true peak/RMS metering with peak-hold and clip detection.
 *
 * AnalyserNode only exposes a smoothed FFT snapshot, which misses inter-block
 * transients. Metering per sample on the audio thread is the only way a clip
 * indicator can be trusted.
 */
const DECAY_PER_SECOND = 8; // linear amplitude decay of the falling meter
const HOLD_SECONDS = 1.2;

class MeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.peakL = 0;
    this.peakR = 0;
    this.holdL = 0;
    this.holdR = 0;
    this.holdTimer = 0;
    this.rmsAcc = 0;
    this.rmsCount = 0;
    this.clipped = false;
    this.frames = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    const left = input[0];
    const right = input.length > 1 ? input[1] : input[0];
    const n = left.length;

    let pL = 0;
    let pR = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(left[i]);
      const b = Math.abs(right[i]);
      if (a > pL) pL = a;
      if (b > pR) pR = b;
      this.rmsAcc += (left[i] * left[i] + right[i] * right[i]) * 0.5;
    }
    this.rmsCount += n;

    if (pL >= 0.999 || pR >= 0.999) this.clipped = true;

    const dt = n / sampleRate;
    const decay = DECAY_PER_SECOND * dt;
    this.peakL = Math.max(pL, this.peakL - decay);
    this.peakR = Math.max(pR, this.peakR - decay);

    if (pL > this.holdL || pR > this.holdR) {
      this.holdL = Math.max(this.holdL, pL);
      this.holdR = Math.max(this.holdR, pR);
      this.holdTimer = 0;
    } else {
      this.holdTimer += dt;
      if (this.holdTimer > HOLD_SECONDS) {
        this.holdL = Math.max(this.peakL, this.holdL - decay);
        this.holdR = Math.max(this.peakR, this.holdR - decay);
      }
    }

    this.frames += n;
    if (this.frames >= sampleRate / 30) {
      const rms = Math.sqrt(this.rmsAcc / Math.max(1, this.rmsCount));
      this.port.postMessage({
        peakL: this.peakL,
        peakR: this.peakR,
        holdL: this.holdL,
        holdR: this.holdR,
        rms,
        clipped: this.clipped,
      });
      this.frames = 0;
      this.rmsAcc = 0;
      this.rmsCount = 0;
      this.clipped = false;
    }
    return true;
  }
}
registerProcessor('meter-processor', MeterProcessor);
