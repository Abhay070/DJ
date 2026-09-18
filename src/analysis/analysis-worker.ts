/// <reference lib="webworker" />
/**
 * Analysis worker. Decoded audio arrives as transferred Float32Arrays so the
 * main thread never blocks on DSP, and the UI stays at 60 fps while a folder
 * import churns through a backlog.
 */
import { toMono } from '../lib/dsp';
import {
  onsetEnvelope, estimateTempo, estimateGrid, estimateKey,
  integratedLoudness, energyCurve, detectSections, buildWaveform,
} from './detect';
import type { Analysis } from '../lib/types';
import { ANALYSIS_VERSION, type AnalyseRequest, type AnalyseResponse } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<AnalyseRequest>) => {
  const req = e.data;
  try {
    const analysis = analyse(req, (stage, progress) => {
      ctx.postMessage({ type: 'progress', id: req.id, stage, progress } satisfies AnalyseResponse);
    });
    // Transfer the big arrays back rather than structured-cloning them.
    const transfer: ArrayBufferLike[] = [
      analysis.beats.buffer, analysis.downbeats.buffer, analysis.energy.buffer,
      analysis.waveform.peak.buffer, analysis.waveform.low.buffer,
      analysis.waveform.mid.buffer, analysis.waveform.high.buffer,
      analysis.overview.peak.buffer, analysis.overview.low.buffer,
      analysis.overview.mid.buffer, analysis.overview.high.buffer,
    ];
    ctx.postMessage({ type: 'done', id: req.id, analysis } satisfies AnalyseResponse, transfer as Transferable[]);
  } catch (err) {
    ctx.postMessage({
      type: 'error', id: req.id,
      message: err instanceof Error ? err.message : String(err),
    } satisfies AnalyseResponse);
  }
};

function analyse(req: AnalyseRequest, report: (stage: string, p: number) => void): Analysis {
  const { channels, sampleRate, duration } = req;
  if (!channels.length || !channels[0].length) throw new Error('Track contains no audio samples');

  report('Preparing audio', 0.05);
  const mono = toMono(channels);

  let peak = 0;
  for (let i = 0; i < mono.length; i++) { const a = Math.abs(mono[i]); if (a > peak) peak = a; }

  report('Detecting onsets', 0.15);
  const env = onsetEnvelope(mono, sampleRate);

  report('Estimating tempo', 0.35);
  let bpm: number;
  let bpmConfidence: number;
  let alternatives: number[];
  if (req.bpmHint && req.bpmHint > 0) {
    bpm = req.bpmHint;
    bpmConfidence = 1;
    alternatives = [];
  } else {
    const tempo = estimateTempo(env, duration);
    bpm = tempo.bpm;
    bpmConfidence = tempo.confidence;
    alternatives = tempo.alternatives;
    if (!bpm || !Number.isFinite(bpm)) {
      // No usable tempo. Say so rather than inventing one - the UI prompts.
      bpm = 0;
      bpmConfidence = 0;
    }
  }

  report('Building beat grid', 0.5);
  const grid = bpm > 0
    ? estimateGrid(env, bpm, duration)
    : { firstBeat: 0, beats: new Float32Array(0), downbeats: new Float32Array(0), downbeatOffset: 0, phaseConfidence: 0 };

  report('Detecting key', 0.62);
  const keyEst = estimateKey(mono, sampleRate);

  report('Measuring loudness', 0.74);
  const loudness = integratedLoudness(channels, sampleRate);

  report('Mapping energy', 0.82);
  const energy = energyCurve(mono, duration);

  report('Finding structure', 0.88);
  const beatInterval = bpm > 0 ? 60 / bpm : 0.5;
  const sections = detectSections(energy, duration, beatInterval);

  report('Rendering waveform', 0.93);
  // Detail waveform is sized for scrolling zoom; overview is one screen wide.
  const detailBins = Math.min(240000, Math.max(4000, Math.round(duration * 220)));
  const waveform = buildWaveform(channels, sampleRate, detailBins);
  const overview = buildWaveform(channels, sampleRate, 1600);

  const intro = sections.find((s) => s.label === 'intro');
  const outro = [...sections].reverse().find((s) => s.label === 'outro');

  report('Done', 1);

  // Combine tempo certainty with grid-phase certainty - a confident tempo whose
  // phase will not lock is still not a grid you should trust.
  const combinedConfidence = bpm > 0
    ? Math.max(0, Math.min(1, bpmConfidence * 0.7 + grid.phaseConfidence * 0.3))
    : 0;

  return {
    version: ANALYSIS_VERSION,
    duration,
    sampleRate,
    bpm,
    bpmConfidence: combinedConfidence,
    bpmAlternatives: alternatives,
    beatGrid: {
      firstBeat: grid.firstBeat,
      bpm,
      downbeatOffset: grid.downbeatOffset,
      locked: false,
    },
    beats: grid.beats,
    downbeats: grid.downbeats,
    key: keyEst.key,
    keyConfidence: keyEst.confidence,
    loudness,
    peak,
    energy,
    sections,
    introEnd: intro ? intro.end : Math.min(duration * 0.1, 30),
    outroStart: outro ? outro.start : Math.max(0, duration - Math.min(duration * 0.12, 45)),
    waveform,
    overview,
  };
}
