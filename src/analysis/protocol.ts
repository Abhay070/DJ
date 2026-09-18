/**
 * Types shared between the analysis worker and its caller.
 *
 * Kept separate from the worker module itself so importing these does not drag
 * in the worker's top-level `self.onmessage` wiring, which only makes sense
 * inside a worker.
 */
import type { Analysis } from '../lib/types';

/** Bump when the analysis format changes; cached results below this are redone. */
export const ANALYSIS_VERSION = 3;

export interface AnalyseRequest {
  id: string;
  channels: Float32Array[];
  sampleRate: number;
  duration: number;
  /** When set, tempo detection is skipped and the grid is locked to this BPM. */
  bpmHint?: number;
}

export type AnalyseResponse =
  | { type: 'progress'; id: string; stage: string; progress: number }
  | { type: 'done'; id: string; analysis: Analysis }
  | { type: 'error'; id: string; message: string };
