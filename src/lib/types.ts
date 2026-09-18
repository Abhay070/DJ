import type { MusicalKey } from './music';

export type DeckId = 'A' | 'B' | 'C' | 'D';

/** Per-bin waveform data, split into three frequency bands for colouring. */
export interface WaveformData {
  /** Samples per bin at this resolution. */
  binSize: number;
  /** Peak amplitude per bin, 0..1. */
  peak: Float32Array;
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
}

export type SectionLabel = 'intro' | 'build' | 'drop' | 'verse' | 'chorus' | 'breakdown' | 'outro';

export interface Section {
  start: number;
  end: number;
  label: SectionLabel;
  /** 0..1 - how much to trust this label. Sections are heuristic, not ground truth. */
  confidence: number;
  energy: number;
}

export interface BeatGrid {
  /** Seconds of the first detected beat. */
  firstBeat: number;
  /** Beats per minute of the grid itself (the track's natural tempo). */
  bpm: number;
  /** Index within the bar of the first beat, 0 = downbeat. */
  downbeatOffset: number;
  /** True once a human has edited or confirmed the grid. */
  locked: boolean;
}

export interface Analysis {
  version: number;
  duration: number;
  sampleRate: number;
  bpm: number;
  /** 0..1 - low values should surface the "confirm BPM" prompt, not a fake number. */
  bpmConfidence: number;
  /** Runner-up tempo, usually the half/double-time alternative. */
  bpmAlternatives: number[];
  beatGrid: BeatGrid;
  beats: Float32Array;
  downbeats: Float32Array;
  key: MusicalKey | null;
  keyConfidence: number;
  /** Integrated programme loudness, approximate LUFS. */
  loudness: number;
  peak: number;
  /** Energy curve, one value per second, 0..1. */
  energy: Float32Array;
  sections: Section[];
  introEnd: number;
  outroStart: number;
  waveform: WaveformData;
  overview: WaveformData;
}

export interface HotCue {
  index: number;
  position: number;
  name: string;
  color: string;
  type: 'hot' | 'loop' | 'memory' | 'fade';
  loopLength?: number;
}

export interface SavedLoop {
  start: number;
  end: number;
  beats: number;
}

export interface TrackMeta {
  id: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  duration: number;
  fileName: string;
  fileSize: number;
  dateAdded: number;
  playCount: number;
  lastPlayed: number | null;
  rating: number;
  tags: string[];
  /** User-corrected BPM overrides the analysed value when present. */
  bpmOverride: number | null;
  cues: HotCue[];
  loops: SavedLoop[];
  /** Manual gain trim in dB, on top of auto-gain. */
  gainOffset: number;
  analysisState: 'pending' | 'analysing' | 'done' | 'failed';
  analysisError?: string;
}

export interface Track extends TrackMeta {
  analysis: Analysis | null;
}

export interface Playlist {
  id: string;
  name: string;
  trackIds: string[];
  createdAt: number;
}

export interface HistoryEntry {
  trackId: string;
  title: string;
  artist: string;
  deck: DeckId;
  startedAt: number;
  endedAt: number | null;
}
