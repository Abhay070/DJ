/** Small, dependency-free DSP kit used by the analysis worker. */

/** In-place iterative radix-2 FFT. `re`/`im` must be power-of-two length. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error(`fft: length ${n} is not a power of two`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
        const vIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + half] = uRe - vRe;
        im[i + k + half] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

export function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Mix an interleaved-by-channel buffer down to a single mono channel. */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  const inv = 1 / channels.length;
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c];
    for (let i = 0; i < n; i++) out[i] += ch[i] * inv;
  }
  return out;
}

/**
 * Decimate by an integer factor with a simple box pre-filter. Good enough for
 * onset-envelope work, where we only care about energy below ~2 kHz.
 */
export function decimate(input: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return input;
  const outLen = Math.floor(input.length / factor);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    let sum = 0;
    const base = i * factor;
    for (let k = 0; k < factor; k++) sum += input[base + k];
    out[i] = sum / factor;
  }
  return out;
}

/** Normalise to unit peak, in place. Returns the peak that was found. */
export function normalise(x: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
  if (peak > 0) { const inv = 1 / peak; for (let i = 0; i < x.length; i++) x[i] *= inv; }
  return peak;
}

/** Moving-average smoothing with a centred window. */
export function smooth(x: Float32Array, radius: number): Float32Array {
  if (radius < 1) return x;
  const out = new Float32Array(x.length);
  let acc = 0;
  const win = radius * 2 + 1;
  for (let i = 0; i < x.length + radius; i++) {
    if (i < x.length) acc += x[i];
    if (i - win >= 0) acc -= x[i - win];
    const centre = i - radius;
    if (centre >= 0) {
      const lo = Math.max(0, centre - radius);
      const hi = Math.min(x.length - 1, centre + radius);
      out[centre] = acc / (hi - lo + 1);
    }
  }
  return out;
}

/** Biquad coefficients + a one-shot offline filter, used for K-weighting. */
export interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

export function highShelf(fs: number, f0: number, gainDb: number, q: number): Biquad {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const sq = 2 * Math.sqrt(A) * alpha;
  const b0 = A * (A + 1 + (A - 1) * cos + sq);
  const b1 = -2 * A * (A - 1 + (A + 1) * cos);
  const b2 = A * (A + 1 + (A - 1) * cos - sq);
  const a0 = A + 1 - (A - 1) * cos + sq;
  const a1 = 2 * (A - 1 - (A + 1) * cos);
  const a2 = A + 1 - (A - 1) * cos - sq;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function highPass(fs: number, f0: number, q: number): Biquad {
  const w0 = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const b0 = (1 + cos) / 2;
  const b1 = -(1 + cos);
  const b2 = (1 + cos) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function applyBiquad(x: Float32Array, c: Biquad): Float32Array {
  const out = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xn = x[i];
    const yn = c.b0 * xn + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = yn;
    x2 = x1; x1 = xn; y2 = y1; y1 = yn;
  }
  return out;
}
