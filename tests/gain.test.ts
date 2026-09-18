import { describe, it, expect } from 'vitest';
import { autoGainDb, dbToGain, gainToDb, AUTO_GAIN_LIMIT } from '../src/lib/gain';
import { encodeWav } from '../src/audio/recorder';
import { parseFileName } from '../src/lib/filename';

describe('decibel conversion', () => {
  it('round-trips', () => {
    for (const db of [-40, -12, -6, 0, 6, 12]) {
      expect(gainToDb(dbToGain(db))).toBeCloseTo(db, 9);
    }
  });

  it('puts unity gain at 0 dB', () => {
    expect(dbToGain(0)).toBe(1);
    expect(gainToDb(1)).toBe(0);
  });

  it('halves amplitude at -6 dB', () => {
    expect(dbToGain(-6)).toBeCloseTo(0.5, 2);
  });

  it('floors silence instead of returning -Infinity', () => {
    expect(Number.isFinite(gainToDb(0))).toBe(true);
    expect(gainToDb(0)).toBeLessThan(-100);
  });
});

describe('auto gain', () => {
  it('lifts a quiet track to the target', () => {
    // -20 LUFS with plenty of headroom: the full +6 is available.
    expect(autoGainDb(-20, 0.25, -14)).toBeCloseTo(6, 5);
  });

  it('pulls a loud track down to the target', () => {
    expect(autoGainDb(-8, 0.99, -14)).toBeCloseTo(-6, 5);
  });

  it('does nothing when the track is already on target', () => {
    expect(autoGainDb(-14, 0.5, -14)).toBeCloseTo(0, 6);
  });

  it('will not boost a track into clipping', () => {
    // Very quiet average but peaks already near full scale: the boost the
    // target asks for would send those peaks well past 0 dBFS.
    const gain = autoGainDb(-30, 0.98, -14);
    const resultingPeak = 0.98 * dbToGain(gain);
    expect(resultingPeak).toBeLessThanOrEqual(1);
    expect(gain).toBeLessThan(16);
  });

  it('keeps peaks under full scale across a wide range of material', () => {
    for (const loudness of [-30, -24, -18, -14, -9, -6]) {
      for (const peak of [0.2, 0.5, 0.8, 0.95, 1.0]) {
        const gain = autoGainDb(loudness, peak, -14);
        expect(peak * dbToGain(gain)).toBeLessThanOrEqual(1.0001);
      }
    }
  });

  it('never exceeds the correction limit', () => {
    expect(autoGainDb(-60, 0.01, -14)).toBeLessThanOrEqual(AUTO_GAIN_LIMIT);
    expect(autoGainDb(-2, 1.0, -30)).toBeGreaterThanOrEqual(-AUTO_GAIN_LIMIT);
  });

  it('declines to correct a measurement that means silence', () => {
    expect(autoGainDb(-70, 0.5, -14)).toBe(0);
    expect(autoGainDb(-Infinity, 0.5, -14)).toBe(0);
    expect(autoGainDb(NaN, 0.5, -14)).toBe(0);
  });

  it('closes most of the gap between differently mastered tracks', () => {
    const quiet = { loudness: -21, peak: 0.6 };
    const loud = { loudness: -7.5, peak: 0.99 };
    const target = -14;
    const after = (t: { loudness: number; peak: number }) =>
      t.loudness + autoGainDb(t.loudness, t.peak, target);

    const before = Math.abs(quiet.loudness - loud.loudness);
    const gap = Math.abs(after(quiet) - after(loud));

    expect(before).toBeCloseTo(13.5, 1);
    // Most of the difference is removed, so the crossfader stays a blend
    // control rather than a volume rescue.
    expect(gap).toBeLessThan(before / 3);
  });

  it('matches exactly when both tracks have the headroom for it', () => {
    const target = -14;
    const after = (loudness: number, peak: number) => loudness + autoGainDb(loudness, peak, target);
    expect(after(-20, 0.2)).toBeCloseTo(target, 6);
    expect(after(-9, 0.9)).toBeCloseTo(target, 6);
  });

  it('stops short of the target rather than clipping a peaky quiet track', () => {
    // A dynamic master needs +7 dB to hit -14, but its peaks only have 3.9 dB
    // of room. Reaching the target matters less than not distorting: the deck
    // shows the trim it applied so the user can push it further by hand.
    const gain = autoGainDb(-21, 0.6, -14);
    expect(gain).toBeGreaterThan(3);
    expect(gain).toBeLessThan(7);
    expect(0.6 * dbToGain(gain)).toBeLessThanOrEqual(1);
  });
});

describe('WAV encoding', () => {
  const SR = 48000;

  function decode(blobBuffer: ArrayBuffer) {
    const view = new DataView(blobBuffer);
    const str = (o: number, n: number) => String.fromCharCode(...new Uint8Array(blobBuffer, o, n));
    return {
      riff: str(0, 4),
      wave: str(8, 4),
      fmt: str(12, 4),
      format: view.getUint16(20, true),
      channels: view.getUint16(22, true),
      sampleRate: view.getUint32(24, true),
      byteRate: view.getUint32(28, true),
      blockAlign: view.getUint16(32, true),
      bits: view.getUint16(34, true),
      dataTag: str(36, 4),
      dataLength: view.getUint32(40, true),
      sampleAt: (i: number, ch: number) => view.getInt16(44 + i * 4 + ch * 2, true),
    };
  }

  it('writes a valid stereo 16-bit header', async () => {
    const n = 100;
    const blob = encodeWav(new Float32Array(n), new Float32Array(n), SR);
    const d = decode(await blob.arrayBuffer());

    expect(d.riff).toBe('RIFF');
    expect(d.wave).toBe('WAVE');
    expect(d.fmt).toBe('fmt ');
    expect(d.format).toBe(1);        // PCM
    expect(d.channels).toBe(2);
    expect(d.sampleRate).toBe(SR);
    expect(d.bits).toBe(16);
    expect(d.blockAlign).toBe(4);
    expect(d.byteRate).toBe(SR * 4);
    expect(d.dataTag).toBe('data');
    expect(d.dataLength).toBe(n * 4);
    expect(blob.size).toBe(44 + n * 4);
  });

  it('preserves sample values and channel separation', async () => {
    const left = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const right = Float32Array.from([1, -1, 0.25, 0, 0.5]);
    const d = decode(await encodeWav(left, right, SR).arrayBuffer());

    expect(d.sampleAt(0, 0)).toBe(0);
    expect(d.sampleAt(0, 1)).toBe(32767);
    expect(d.sampleAt(1, 0)).toBeCloseTo(16383, -1);
    expect(d.sampleAt(1, 1)).toBe(-32768);
    expect(d.sampleAt(3, 0)).toBe(32767);
    expect(d.sampleAt(4, 0)).toBe(-32768);
  });

  it('clamps out-of-range samples to full scale rather than wrapping', async () => {
    // A hot master must saturate, not fold over into the opposite polarity.
    const left = Float32Array.from([2.5, -2.5]);
    const right = Float32Array.from([-9, 9]);
    const d = decode(await encodeWav(left, right, SR).arrayBuffer());

    expect(d.sampleAt(0, 0)).toBe(32767);
    expect(d.sampleAt(1, 0)).toBe(-32768);
    expect(d.sampleAt(0, 1)).toBe(-32768);
    expect(d.sampleAt(1, 1)).toBe(32767);
  });

  it('handles an empty recording', async () => {
    const blob = encodeWav(new Float32Array(0), new Float32Array(0), SR);
    expect(blob.size).toBe(44);
  });
});

describe('file name parsing', () => {
  it('splits artist and title on a hyphen', () => {
    expect(parseFileName('Daft Punk - Around The World.mp3'))
      .toEqual({ artist: 'Daft Punk', title: 'Around The World' });
  });

  it('keeps hyphens that belong to the title', () => {
    expect(parseFileName('Artist - Some - Title.flac'))
      .toEqual({ artist: 'Artist', title: 'Some - Title' });
  });

  it('strips a leading track number', () => {
    expect(parseFileName('03 - Artist - Title.wav'))
      .toEqual({ artist: 'Artist', title: 'Title' });
    expect(parseFileName('07. Artist - Title.m4a'))
      .toEqual({ artist: 'Artist', title: 'Title' });
  });

  it('converts underscores to spaces', () => {
    expect(parseFileName('Some_Artist - Some_Title.ogg'))
      .toEqual({ artist: 'Some Artist', title: 'Some Title' });
  });

  it('falls back gracefully when there is no artist', () => {
    expect(parseFileName('just-a-filename.mp3').title).toBe('just-a-filename');
    expect(parseFileName('just-a-filename.mp3').artist).toBe('Unknown artist');
  });

  it('never returns an empty title', () => {
    for (const name of ['.mp3', 'x.mp3', '   .wav']) {
      expect(parseFileName(name).title.length).toBeGreaterThan(0);
    }
  });
});
