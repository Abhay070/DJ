/**
 * FX rack.
 *
 * Each effect is a small Web Audio subgraph behind a common interface, so the
 * rack can host them uniformly and the UI can drive any of them with the same
 * on/off + dry/wet + two-parameter model.
 *
 * Time-based effects take their timing from the master BPM, so "1/4 echo"
 * really is a quarter note - and it follows when the master tempo moves.
 */

export type FxId =
  | 'filter' | 'echo' | 'delay' | 'reverb' | 'flanger' | 'phaser' | 'chorus'
  | 'distortion' | 'bitcrusher' | 'gate' | 'trans' | 'beatrepeat' | 'pitch' | 'ringmod';

export interface FxDescriptor {
  id: FxId;
  name: string;
  /** Label + range for the two exposed parameters. */
  paramA: { label: string; min: number; max: number; default: number; unit?: string };
  paramB: { label: string; min: number; max: number; default: number; unit?: string };
  /** True when paramA is a beat division rather than a free value. */
  beatSynced: boolean;
}

export const FX_DESCRIPTORS: Record<FxId, FxDescriptor> = {
  filter: { id: 'filter', name: 'Filter', paramA: { label: 'Cutoff', min: -1, max: 1, default: 0 }, paramB: { label: 'Resonance', min: 0.1, max: 18, default: 1 }, beatSynced: false },
  echo: { id: 'echo', name: 'Echo', paramA: { label: 'Time', min: 0, max: 5, default: 2, unit: 'beats' }, paramB: { label: 'Feedback', min: 0, max: 0.92, default: 0.45 }, beatSynced: true },
  delay: { id: 'delay', name: 'Delay', paramA: { label: 'Time', min: 0, max: 5, default: 3, unit: 'beats' }, paramB: { label: 'Feedback', min: 0, max: 0.92, default: 0.3 }, beatSynced: true },
  reverb: { id: 'reverb', name: 'Reverb', paramA: { label: 'Size', min: 0.2, max: 6, default: 2.2, unit: 's' }, paramB: { label: 'Damping', min: 200, max: 18000, default: 6000, unit: 'Hz' }, beatSynced: false },
  flanger: { id: 'flanger', name: 'Flanger', paramA: { label: 'Rate', min: 0, max: 5, default: 4, unit: 'beats' }, paramB: { label: 'Depth', min: 0, max: 0.008, default: 0.003 }, beatSynced: true },
  phaser: { id: 'phaser', name: 'Phaser', paramA: { label: 'Rate', min: 0, max: 5, default: 4, unit: 'beats' }, paramB: { label: 'Depth', min: 100, max: 3000, default: 1200, unit: 'Hz' }, beatSynced: true },
  chorus: { id: 'chorus', name: 'Chorus', paramA: { label: 'Rate', min: 0.1, max: 6, default: 1.2, unit: 'Hz' }, paramB: { label: 'Depth', min: 0, max: 0.01, default: 0.004 }, beatSynced: false },
  distortion: { id: 'distortion', name: 'Distortion', paramA: { label: 'Drive', min: 1, max: 100, default: 25 }, paramB: { label: 'Tone', min: 500, max: 18000, default: 8000, unit: 'Hz' }, beatSynced: false },
  bitcrusher: { id: 'bitcrusher', name: 'Bitcrush', paramA: { label: 'Bits', min: 1, max: 16, default: 6 }, paramB: { label: 'Rate', min: 0.02, max: 1, default: 0.3 }, beatSynced: false },
  gate: { id: 'gate', name: 'Gate', paramA: { label: 'Rate', min: 0, max: 5, default: 1, unit: 'beats' }, paramB: { label: 'Duty', min: 0.05, max: 0.95, default: 0.5 }, beatSynced: true },
  trans: { id: 'trans', name: 'Trans', paramA: { label: 'Rate', min: 0, max: 5, default: 0, unit: 'beats' }, paramB: { label: 'Duty', min: 0.05, max: 0.95, default: 0.5 }, beatSynced: true },
  beatrepeat: { id: 'beatrepeat', name: 'Beat Roll', paramA: { label: 'Length', min: 0, max: 5, default: 1, unit: 'beats' }, paramB: { label: 'Feedback', min: 0, max: 0.95, default: 0.8 }, beatSynced: true },
  pitch: { id: 'pitch', name: 'Pitch', paramA: { label: 'Semitones', min: -12, max: 12, default: 7 }, paramB: { label: 'Mix', min: 0, max: 1, default: 1 }, beatSynced: false },
  ringmod: { id: 'ringmod', name: 'Ring Mod', paramA: { label: 'Freq', min: 20, max: 2000, default: 220, unit: 'Hz' }, paramB: { label: 'Shape', min: 0, max: 1, default: 0 }, beatSynced: false },
};

/** Beat divisions selectable on beat-synced effects. */
export const BEAT_DIVISIONS = [1 / 8, 1 / 4, 1 / 2, 1, 2, 4] as const;
export const BEAT_DIVISION_LABELS = ['1/8', '1/4', '1/2', '1', '2', '4'] as const;

export interface FxNodes {
  input: GainNode;
  output: GainNode;
  /** Called whenever tempo or parameters change. */
  update(params: FxParams, beatSeconds: number): void;
  dispose(): void;
}

export interface FxParams {
  a: number;
  b: number;
  wet: number;
}

function makeImpulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      // Exponentially decaying noise: a cheap but convincing plate.
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

function makeDistortionCurve(drive: number) {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = drive;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

/** Wire a dry/wet pair around a processing chain. */
function wetDry(ctx: BaseAudioContext) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(dry).connect(output);
  wet.connect(output);
  return { input, output, dry, wet };
}

function setWet(dry: GainNode, wet: GainNode, amount: number, now: number) {
  // Equal-power crossfade keeps perceived level steady across the dry/wet sweep.
  const a = Math.max(0, Math.min(1, amount));
  dry.gain.setTargetAtTime(Math.cos((a * Math.PI) / 2), now, 0.01);
  wet.gain.setTargetAtTime(Math.sin((a * Math.PI) / 2), now, 0.01);
}

export function createFx(id: FxId, ctx: BaseAudioContext): FxNodes {
  switch (id) {
    case 'filter': return createFilter(ctx);
    case 'echo': return createEcho(ctx, true);
    case 'delay': return createEcho(ctx, false);
    case 'reverb': return createReverb(ctx);
    case 'flanger': return createFlanger(ctx);
    case 'phaser': return createPhaser(ctx);
    case 'chorus': return createChorus(ctx);
    case 'distortion': return createDistortion(ctx);
    case 'bitcrusher': return createBitcrusher(ctx);
    case 'gate': return createGate(ctx, false);
    case 'trans': return createGate(ctx, true);
    case 'beatrepeat': return createBeatRepeat(ctx);
    case 'pitch': return createPitch(ctx);
    case 'ringmod': return createRingMod(ctx);
  }
}

function createFilter(ctx: BaseAudioContext): FxNodes {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 22050;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 20;
  input.connect(hp).connect(lp).connect(output);

  return {
    input, output,
    update(p) {
      const now = ctx.currentTime;
      // Bipolar: negative sweeps the low-pass down, positive the high-pass up.
      const x = Math.max(-1, Math.min(1, p.a)) * p.wet;
      if (x < 0) {
        lp.frequency.setTargetAtTime(expRange(-x, 22050, 120), now, 0.02);
        hp.frequency.setTargetAtTime(20, now, 0.02);
      } else {
        hp.frequency.setTargetAtTime(expRange(x, 20, 9000), now, 0.02);
        lp.frequency.setTargetAtTime(22050, now, 0.02);
      }
      lp.Q.setTargetAtTime(p.b, now, 0.02);
      hp.Q.setTargetAtTime(p.b, now, 0.02);
    },
    dispose() { input.disconnect(); output.disconnect(); },
  };
}

function expRange(t: number, from: number, to: number): number {
  return from * Math.pow(to / from, Math.max(0, Math.min(1, t)));
}

function createEcho(ctx: BaseAudioContext, filtered: boolean): FxNodes {
  const { input, output, dry, wet } = wetDry(ctx);
  const delay = ctx.createDelay(4);
  const fb = ctx.createGain();
  fb.gain.value = 0.4;
  const damp = ctx.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = filtered ? 3500 : 18000;

  input.connect(delay);
  delay.connect(damp).connect(fb).connect(delay);
  delay.connect(wet);

  return {
    input, output,
    update(p, beatSeconds) {
      const now = ctx.currentTime;
      const beats = BEAT_DIVISIONS[Math.round(p.a)] ?? 1;
      const time = Math.max(0.001, Math.min(4, beats * beatSeconds));
      delay.delayTime.setTargetAtTime(time, now, 0.05);
      fb.gain.setTargetAtTime(Math.min(0.92, p.b), now, 0.02);
      setWet(dry, wet, p.wet, now);
    },
    dispose() { input.disconnect(); output.disconnect(); delay.disconnect(); fb.disconnect(); },
  };
}

function createReverb(ctx: BaseAudioContext): FxNodes {
  const { input, output, dry, wet } = wetDry(ctx);
  const convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(ctx, 2.2, 2.5);
  const damp = ctx.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = 6000;
  input.connect(convolver).connect(damp).connect(wet);

  let currentSize = 2.2;
  return {
    input, output,
    update(p) {
      const now = ctx.currentTime;
      // Rebuilding the impulse is expensive, so only do it on a real change.
      if (Math.abs(p.a - currentSize) > 0.15) {
        currentSize = p.a;
        convolver.buffer = makeImpulse(ctx, Math.max(0.2, p.a), 2.5);
      }
      damp.frequency.setTargetAtTime(p.b, now, 0.05);
      setWet(dry, wet, p.wet, now);
    },
    dispose() { input.disconnect(); output.disconnect(); convolver.disconnect(); },
  };
}

function createFlanger(ctx: BaseAudioContext): FxNodes {
  const { input, output, dry, wet } = wetDry(ctx);
  const delay = ctx.createDelay(0.05);
  delay.delayTime.value = 0.003;
  const fb = ctx.createGain();
  fb.gain.value = 0.6;
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.002;
  lfo.frequency.value = 0.4;
  lfo.connect(lfoGain).connect(delay.delayTime);
  lfo.start();

  input.connect(delay);
  delay.connect(fb).connect(delay);
  delay.connect(wet);

  return {
    input, output,
    update(p, beatSeconds) {
      const now = ctx.currentTime;
      const beats = BEAT_DIVISIONS[Math.round(p.a)] ?? 4;
      const period = Math.max(0.05, beats * beatSeconds * 4);
      lfo.frequency.setTargetAtTime(1 / period, now, 0.05);
      lfoGain.gain.setTargetAtTime(p.b, now, 0.05);
      setWet(dry, wet, p.wet, now);
    },
    dispose() { lfo.stop(); input.disconnect(); output.disconnect(); },
  };
}

function createPhaser(ctx: BaseAudioContext): FxNodes {
  const { input, output, dry, wet } = wetDry(ctx);
  const stages: BiquadFilterNode[] = [];
  let node: AudioNode = input;
  for (let i = 0; i < 4; i++) {
    const ap = ctx.createBiquadFilter();
    ap.type = 'allpass';
    ap.frequency.value = 400 + i * 400;
    ap.Q.value = 6;
    node.connect(ap);
    node = ap;
    stages.push(ap);
  }
  node.connect(wet);

  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 1200;
  lfo.frequency.value = 0.3;
  lfo.connect(lfoGain);
  for (const s of stages) lfoGain.connect(s.frequency);
  lfo.start();

  return {
    input, output,
    update(p, beatSeconds) {
      const now = ctx.currentTime;
      const beats = BEAT_DIVISIONS[Math.round(p.a)] ?? 4;
      const period = Math.max(0.05, beats * beatSeconds * 4);
      lfo.frequency.setTargetAtTime(1 / period, now, 0.05);
      lfoGain.gain.setTargetAtTime(p.b, now, 0.05);
      setWet(dry, wet, p.wet, now);
    },
    dispose() { lfo.stop(); input.disconnect(); output.disconnect(); },
  };
}

function createChorus(ctx: BaseAudioContext): FxNodes {
  const { input, output, dry, wet } = wetDry(ctx);
  const voices: { delay: DelayNode; lfo: OscillatorNode; gain: GainNode }[] = [];
  for (let i = 0; i < 3; i++) {
    const delay = ctx.createDelay(0.1);
    delay.delayTime.value = 0.015 + i * 0.006;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.8 + i * 0.27;
    const gain = ctx.createGain();
    gain.gain.value = 0.004;
    lfo.connect(gain).connect(delay.delayTime);
    lfo.start();
    input.connect(delay).connect(wet);
    voices.push({ delay, lfo, gain });
  }

  return {
    input, output,
    update(p) {
      const now = ctx.currentTime;
      voices.forEach((v, i) => {
        v.lfo.frequency.setTargetAtTime(p.a * (1 + i * 0.3), now, 0.05);
        v.gain.gain.setTargetAtTime(p.b, now, 0.05);
      });
      setWet(dry, wet, p.wet, now);
    },
    dispose() { voices.forEach((v) => v.lfo.stop()); input.disconnect(); output.disconnect(); },
  };
}

function createDistortion(ctx: BaseAudioContext): FxNodes {
  const { input, output, dry, wet } = wetDry(ctx);
  const shaper = ctx.createWaveShaper();
  shaper.curve = makeDistortionCurve(25);
  shaper.oversample = '4x';
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 8000;
  // Trim the level back - waveshaping adds a lot of apparent loudness.
  const comp = ctx.createGain();
  comp.gain.value = 0.6;
  input.connect(shaper).connect(tone).connect(comp).connect(wet);

  let currentDrive = 25;
  return {
    input, output,
    update(p) {
      const now = ctx.currentTime;
      if (Math.abs(p.a - currentDrive) > 0.5) {
        currentDrive = p.a;
        shaper.curve = makeDistortionCurve(p.a);
        comp.gain.setTargetAtTime(1 / (1 + Math.log10(1 + p.a)), now, 0.02);
      }
      tone.frequency.setTargetAtTime(p.b, now, 0.02);
      setWet(dry, wet, p.wet, now);
    },
    dispose() { input.disconnect(); output.disconnect(); },
  };
}

function createBitcrusher(ctx: BaseAudioContext): FxNodes {
  const { input, output, dry, wet } = wetDry(ctx);
  // Quantisation via a stepped waveshaper curve, decimation via a short delay
  // modulated in steps. Cheap, and it sounds like a bitcrusher.
  const shaper = ctx.createWaveShaper();
  const setBits = (bits: number) => {
    const levels = Math.pow(2, Math.max(1, Math.round(bits)));
    const n = 4096;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.round(x * levels) / levels;
    }
    shaper.curve = curve;
  };
  setBits(6);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 6000;
  input.connect(shaper).connect(lp).connect(wet);

  let currentBits = 6;
  return {
    input, output,
    update(p) {
      const now = ctx.currentTime;
      if (Math.round(p.a) !== currentBits) { currentBits = Math.round(p.a); setBits(currentBits); }
      // "Rate" approximates sample-rate reduction with a brickwall.
      lp.frequency.setTargetAtTime(Math.max(300, p.b * 20000), now, 0.02);
      setWet(dry, wet, p.wet, now);
    },
    dispose() { input.disconnect(); output.disconnect(); },
  };
}

/**
 * Gate / Trans. Both chop the signal in time; trans is the hard-edged variant.
 * The chop is scheduled on the audio clock, not a JS timer, so it stays locked
 * to the beat.
 */
function createGate(ctx: BaseAudioContext, hard: boolean): FxNodes {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const vca = ctx.createGain();
  vca.gain.value = 1;
  input.connect(vca).connect(output);

  let scheduledUntil = 0;
  let period = 0.25;
  let duty = 0.5;
  let wet = 0;
  let timer: number | null = null;

  const schedule = () => {
    const now = ctx.currentTime;
    if (wet <= 0.001) {
      vca.gain.cancelScheduledValues(now);
      vca.gain.setTargetAtTime(1, now, 0.01);
      scheduledUntil = now;
      return;
    }
    // Keep half a second of chop scheduled ahead of the audio clock.
    if (scheduledUntil < now) scheduledUntil = now;
    while (scheduledUntil < now + 0.5) {
      const openLevel = 1;
      const closedLevel = 1 - wet;
      const ramp = hard ? 0.0008 : 0.006;
      vca.gain.setTargetAtTime(openLevel, scheduledUntil, ramp);
      vca.gain.setTargetAtTime(closedLevel, scheduledUntil + period * duty, ramp);
      scheduledUntil += period;
    }
  };

  timer = setInterval(schedule, 100) as unknown as number;

  return {
    input, output,
    update(p, beatSeconds) {
      const beats = BEAT_DIVISIONS[Math.round(p.a)] ?? 1;
      const newPeriod = Math.max(0.02, beats * beatSeconds);
      // Re-anchor the pattern when the rate changes so it never smears.
      if (Math.abs(newPeriod - period) > 1e-4) {
        period = newPeriod;
        scheduledUntil = 0;
        vca.gain.cancelScheduledValues(ctx.currentTime);
      }
      duty = p.b;
      wet = p.wet;
    },
    dispose() { if (timer !== null) clearInterval(timer); input.disconnect(); output.disconnect(); },
  };
}

function createBeatRepeat(ctx: BaseAudioContext): FxNodes {
  const { input, output, dry, wet } = wetDry(ctx);
  const delay = ctx.createDelay(4);
  const fb = ctx.createGain();
  fb.gain.value = 0.85;
  input.connect(delay);
  delay.connect(fb).connect(delay);
  delay.connect(wet);
  // With feedback near unity and the dry path muted, a short delay becomes a
  // stutter of the last N beats - the classic roll.
  return {
    input, output,
    update(p, beatSeconds) {
      const now = ctx.currentTime;
      const beats = BEAT_DIVISIONS[Math.round(p.a)] ?? 1;
      delay.delayTime.setTargetAtTime(Math.max(0.01, beats * beatSeconds), now, 0.01);
      fb.gain.setTargetAtTime(Math.min(0.97, p.b), now, 0.01);
      const a = Math.max(0, Math.min(1, p.wet));
      dry.gain.setTargetAtTime(1 - a, now, 0.01);
      wet.gain.setTargetAtTime(a, now, 0.01);
    },
    dispose() { input.disconnect(); output.disconnect(); delay.disconnect(); },
  };
}

/**
 * Pitch shifter built from two crossfaded, ramping delay lines. Granular and
 * a bit lo-fi, which is exactly the character wanted from a performance FX
 * pitch - deck key shifting uses the far higher quality WSOLA path instead.
 */
function createPitch(ctx: BaseAudioContext): FxNodes {
  const { input, output, dry, wet } = wetDry(ctx);
  const grain = 0.1;
  const lines = [0, 1].map((i) => {
    const delay = ctx.createDelay(1);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    input.connect(delay).connect(gain).connect(wet);
    return { delay, gain, phase: i * 0.5 };
  });

  let ratio = Math.pow(2, 7 / 12);
  let raf = 0;
  let last = ctx.currentTime;

  const tick = () => {
    const now = ctx.currentTime;
    const dt = Math.max(0, now - last);
    last = now;
    const speed = ratio - 1;
    for (const line of lines) {
      line.phase = (line.phase + (dt * speed) / grain) % 1;
      if (line.phase < 0) line.phase += 1;
      const d = line.phase * grain;
      line.delay.delayTime.setTargetAtTime(Math.max(0.001, d), now, 0.01);
      // Equal-power window so the two grains crossfade without a level dip.
      line.gain.gain.setTargetAtTime(Math.sin(line.phase * Math.PI), now, 0.01);
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    input, output,
    update(p) {
      ratio = Math.pow(2, p.a / 12);
      setWet(dry, wet, p.wet * p.b, ctx.currentTime);
    },
    dispose() { cancelAnimationFrame(raf); input.disconnect(); output.disconnect(); },
  };
}

function createRingMod(ctx: BaseAudioContext): FxNodes {
  const { input, output, dry, wet } = wetDry(ctx);
  const ring = ctx.createGain();
  ring.gain.value = 0; // fully modulated by the oscillator
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 220;
  osc.connect(ring.gain);
  osc.start();
  input.connect(ring).connect(wet);

  return {
    input, output,
    update(p) {
      const now = ctx.currentTime;
      osc.frequency.setTargetAtTime(p.a, now, 0.02);
      osc.type = p.b > 0.5 ? 'square' : 'sine';
      setWet(dry, wet, p.wet, now);
    },
    dispose() { osc.stop(); input.disconnect(); output.disconnect(); },
  };
}
