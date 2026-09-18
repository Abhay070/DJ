/** Gain staging: matching track loudness without pushing anything into clipping. */

/** Amplitude ratio for a decibel value. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Decibel value for an amplitude ratio, floored so silence does not go to -Infinity. */
export function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(1e-6, gain));
}

/** Widest correction auto-gain will ever apply, in dB either way. */
export const AUTO_GAIN_LIMIT = 12;

/**
 * Trim in dB that brings a track's programme loudness to `targetLufs`.
 *
 * Two things stop this being a plain subtraction:
 *
 *  - A quiet-but-peaky track (lots of headroom used by transients, low average
 *    level) would need a big boost to hit the target, which would drive its
 *    peaks past full scale. The result is capped so the peak stays just under
 *    0 dBFS.
 *  - A measurement of -70 LUFS or below means effectively silence, where the
 *    figure is meaningless. Return no correction rather than a huge one.
 */
export function autoGainDb(loudnessLufs: number, peak: number, targetLufs: number): number {
  if (!Number.isFinite(loudnessLufs) || loudnessLufs <= -70) return 0;

  const wanted = targetLufs - loudnessLufs;
  // Headroom left above the track's own peak, less half a dB of margin.
  const headroom = -gainToDb(Math.max(1e-6, peak)) - 0.5;

  const limited = Math.min(wanted, headroom);
  return Math.max(-AUTO_GAIN_LIMIT, Math.min(AUTO_GAIN_LIMIT, limited));
}
