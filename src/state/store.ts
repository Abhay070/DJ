/**
 * Central application state.
 *
 * A plain observable store with per-channel subscriptions. There is no virtual
 * DOM here on purpose: at 60 fps with two scrolling waveforms, four meters and
 * a pair of jog wheels, diffing a component tree is the wrong tool. Views
 * subscribe to the specific channels they care about and touch only the nodes
 * that changed; anything animating reads engine state directly in a rAF loop.
 *
 * Nothing in here is ever the source of truth for audio timing. Playhead,
 * playing flag and actual rate always come from the engine.
 */
import type { DeckId, HotCue, Track, Playlist, HistoryEntry } from '../lib/types';
import type { FxId } from '../audio/fx';
import type { CrossfaderCurve } from '../audio/engine';

/**
 * 'simple' is the default: one button, plain language, no deck controls.
 * The other two are the full console, with 'advanced' adding the technical
 * surface (grid editing, beat jump, routing, debug).
 */
export type UiMode = 'simple' | 'performance' | 'advanced';
export type MixMode = 'manual' | 'assisted' | 'autodj';
export type KeyStyle = 'camelot' | 'musical' | 'both';

export interface DeckUiState {
  trackId: string | null;
  /** Mirrors the engine's sync state - set from SyncEngine, never guessed. */
  syncEnabled: boolean;
  syncLocked: boolean;
  phaseError: number;
  isMaster: boolean;
  keyLock: boolean;
  keyShift: number;
  quantize: boolean;
  quantizeDivision: number;
  slip: boolean;
  reverse: boolean;
  tempoRange: number;
  pitchPercent: number;
  cuePoint: number;
  hotCues: HotCue[];
  loopEnabled: boolean;
  loopStart: number;
  loopEnd: number;
  loopBeats: number;
  loopRolling: boolean;
  pfl: boolean;
  trim: number;
  eqLow: number;
  eqMid: number;
  eqHigh: number;
  filter: number;
  fader: number;
  zoom: number;
  jogMode: 'vinyl' | 'cdj';
  autoGain: number;
  loadingState: 'idle' | 'loading' | 'ready' | 'error';
  loadError: string | null;
}

export interface FxUiState {
  id: FxId;
  enabled: boolean;
  a: number;
  b: number;
  wet: number;
  routing: Record<string, boolean>;
}

export interface Settings {
  keyStyle: KeyStyle;
  tempoRange: number;
  quantizeDivision: number;
  autoGainEnabled: boolean;
  targetLoudness: number;
  keyLockDefault: boolean;
  limiterEnabled: boolean;
  crossfaderCurve: CrossfaderCurve;
  latencyHint: AudioContextLatencyCategory;
  sampleRate: number | null;
  waveformStyle: 'bands' | 'mono';
  theme: 'dark' | 'darker';
  recordFormat: 'wav';
  phraseBeats: number;
  features: Record<string, boolean>;
}

export const DEFAULT_SETTINGS: Settings = {
  keyStyle: 'both',
  tempoRange: 16,
  quantizeDivision: 1,
  autoGainEnabled: true,
  targetLoudness: -14,
  keyLockDefault: true,
  limiterEnabled: true,
  crossfaderCurve: 'smooth',
  latencyHint: 'interactive',
  sampleRate: null,
  waveformStyle: 'bands',
  theme: 'dark',
  recordFormat: 'wav',
  phraseBeats: 64,
  features: {
    beatSync: true,
    keyDetection: true,
    fx: true,
    loops: true,
    sampler: true,
    recording: true,
    midi: false,
    autoDj: false,
    assistant: true,
  },
};

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'warn' | 'error' | 'success';
  detail?: string;
  actions?: { label: string; run: () => void }[];
  sticky?: boolean;
}

export interface AppState {
  engineReady: boolean;
  uiMode: UiMode;
  mixMode: MixMode;
  decks: Record<DeckId, DeckUiState>;
  crossfader: number;
  masterVolume: number;
  cueVolume: number;
  cueMix: number;
  micEnabled: boolean;
  micGain: number;
  fx: FxUiState[];
  tracks: Map<string, Track>;
  playlists: Playlist[];
  activePlaylist: string | null;
  history: HistoryEntry[];
  selectedTrack: string | null;
  search: string;
  sortBy: keyof Track | 'bpm' | 'key';
  sortDir: 'asc' | 'desc';
  filters: { bpmMin: number | null; bpmMax: number | null; key: string | null; genre: string | null; rating: number | null };
  recording: boolean;
  recordingPaused: boolean;
  analysisQueue: number;
  settings: Settings;
  toasts: Toast[];
  debugVisible: boolean;
  sessionName: string;
}

export function makeDeckState(): DeckUiState {
  return {
    trackId: null,
    syncEnabled: false,
    syncLocked: false,
    phaseError: 0,
    isMaster: false,
    keyLock: true,
    keyShift: 0,
    quantize: true,
    quantizeDivision: 1,
    slip: false,
    reverse: false,
    tempoRange: 16,
    pitchPercent: 0,
    cuePoint: 0,
    hotCues: [],
    loopEnabled: false,
    loopStart: 0,
    loopEnd: 0,
    loopBeats: 4,
    loopRolling: false,
    pfl: false,
    trim: 0,
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0,
    filter: 0,
    fader: 1,
    zoom: 1,
    jogMode: 'vinyl',
    autoGain: 0,
    loadingState: 'idle',
    loadError: null,
  };
}

export type Channel =
  | 'deck' | 'mixer' | 'fx' | 'library' | 'transport' | 'settings'
  | 'toast' | 'mode' | 'recording' | 'analysis' | 'history' | 'playlists';

type Listener = (state: AppState) => void;

export class Store {
  state: AppState;
  private listeners = new Map<Channel, Set<Listener>>();
  private pending = new Set<Channel>();
  private flushScheduled = false;
  private toastId = 1;

  constructor(deckIds: DeckId[]) {
    const decks = {} as Record<DeckId, DeckUiState>;
    for (const id of deckIds) decks[id] = makeDeckState();

    this.state = {
      engineReady: false,
      uiMode: 'simple',
      mixMode: 'manual',
      decks,
      crossfader: 0,
      masterVolume: 0.85,
      cueVolume: 0,
      cueMix: 0.5,
      micEnabled: false,
      micGain: 0,
      fx: [],
      tracks: new Map(),
      playlists: [],
      activePlaylist: null,
      history: [],
      selectedTrack: null,
      search: '',
      sortBy: 'dateAdded',
      sortDir: 'desc',
      filters: { bpmMin: null, bpmMax: null, key: null, genre: null, rating: null },
      recording: false,
      recordingPaused: false,
      analysisQueue: 0,
      settings: { ...DEFAULT_SETTINGS },
      toasts: [],
      debugVisible: false,
      sessionName: 'Untitled session',
    };
  }

  subscribe(channel: Channel, fn: Listener): () => void {
    let set = this.listeners.get(channel);
    if (!set) { set = new Set(); this.listeners.set(channel, set); }
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Mark channels dirty; listeners run once per frame, coalesced. */
  notify(...channels: Channel[]) {
    for (const c of channels) this.pending.add(c);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      const channels2 = [...this.pending];
      this.pending.clear();
      for (const c of channels2) {
        this.listeners.get(c)?.forEach((fn) => fn(this.state));
      }
    });
  }

  deck(id: DeckId): DeckUiState { return this.state.decks[id]; }

  updateDeck(id: DeckId, patch: Partial<DeckUiState>) {
    Object.assign(this.state.decks[id], patch);
    this.notify('deck');
  }

  toast(message: string, kind: Toast['kind'] = 'info', options: Partial<Toast> = {}) {
    const toast: Toast = { id: this.toastId++, message, kind, ...options };
    this.state.toasts.push(toast);
    this.notify('toast');
    if (!toast.sticky) {
      setTimeout(() => this.dismissToast(toast.id), kind === 'error' ? 8000 : 4000);
    }
    return toast.id;
  }

  dismissToast(id: number) {
    const i = this.state.toasts.findIndex((t) => t.id === id);
    if (i >= 0) { this.state.toasts.splice(i, 1); this.notify('toast'); }
  }
}
