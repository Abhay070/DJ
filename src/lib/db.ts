/**
 * Local persistence, on IndexedDB.
 *
 * Everything stays on this machine. Audio files are stored as blobs so a
 * library survives a reload without asking the user to re-pick their folder,
 * and analysis is cached by content hash so a track is never analysed twice.
 */
import type { Analysis, TrackMeta, Playlist, HistoryEntry } from './types';

const DB_NAME = 'dj-console';
const DB_VERSION = 1;

const STORE_TRACKS = 'tracks';
const STORE_AUDIO = 'audio';
const STORE_ANALYSIS = 'analysis';
const STORE_PLAYLISTS = 'playlists';
const STORE_SESSIONS = 'sessions';
const STORE_SETTINGS = 'settings';
const STORE_HISTORY = 'history';
const STORE_SAMPLES = 'samples';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TRACKS)) db.createObjectStore(STORE_TRACKS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_AUDIO)) db.createObjectStore(STORE_AUDIO);
      if (!db.objectStoreNames.contains(STORE_ANALYSIS)) db.createObjectStore(STORE_ANALYSIS);
      if (!db.objectStoreNames.contains(STORE_PLAYLISTS)) db.createObjectStore(STORE_PLAYLISTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) db.createObjectStore(STORE_SETTINGS);
      if (!db.objectStoreNames.contains(STORE_HISTORY)) db.createObjectStore(STORE_HISTORY, { autoIncrement: true });
      if (!db.objectStoreNames.contains(STORE_SAMPLES)) db.createObjectStore(STORE_SAMPLES);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the local database'));
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error(`Database operation failed on ${store}`));
      }),
  );
}

// ------------------------------------------------------------------ tracks

export const tracksDb = {
  all: () => tx<TrackMeta[]>(STORE_TRACKS, 'readonly', (s) => s.getAll() as IDBRequest<TrackMeta[]>),
  get: (id: string) => tx<TrackMeta | undefined>(STORE_TRACKS, 'readonly', (s) => s.get(id)),
  put: (t: TrackMeta) => tx(STORE_TRACKS, 'readwrite', (s) => s.put(t)),
  delete: (id: string) => tx(STORE_TRACKS, 'readwrite', (s) => s.delete(id)),
};

export const audioDb = {
  get: (id: string) => tx<Blob | undefined>(STORE_AUDIO, 'readonly', (s) => s.get(id)),
  put: (id: string, blob: Blob) => tx(STORE_AUDIO, 'readwrite', (s) => s.put(blob, id)),
  delete: (id: string) => tx(STORE_AUDIO, 'readwrite', (s) => s.delete(id)),
};

/**
 * Analysis is stored with its typed arrays converted to plain arrays, because
 * structured clone handles those reliably across browsers and versions.
 */
type StoredAnalysis = Omit<Analysis, 'beats' | 'downbeats' | 'energy' | 'waveform' | 'overview'> & {
  beats: number[];
  downbeats: number[];
  energy: number[];
  waveform: StoredWaveform;
  overview: StoredWaveform;
};

interface StoredWaveform { binSize: number; peak: number[]; low: number[]; mid: number[]; high: number[] }

function packWave(w: Analysis['waveform']): StoredWaveform {
  return {
    binSize: w.binSize,
    peak: Array.from(w.peak),
    low: Array.from(w.low),
    mid: Array.from(w.mid),
    high: Array.from(w.high),
  };
}

function unpackWave(w: StoredWaveform): Analysis['waveform'] {
  return {
    binSize: w.binSize,
    peak: Float32Array.from(w.peak),
    low: Float32Array.from(w.low),
    mid: Float32Array.from(w.mid),
    high: Float32Array.from(w.high),
  };
}

export const analysisDb = {
  async get(id: string): Promise<Analysis | undefined> {
    const raw = await tx<StoredAnalysis | undefined>(STORE_ANALYSIS, 'readonly', (s) => s.get(id));
    if (!raw) return undefined;
    return {
      ...raw,
      beats: Float32Array.from(raw.beats),
      downbeats: Float32Array.from(raw.downbeats),
      energy: Float32Array.from(raw.energy),
      waveform: unpackWave(raw.waveform),
      overview: unpackWave(raw.overview),
    };
  },
  put(id: string, a: Analysis) {
    const stored: StoredAnalysis = {
      ...a,
      beats: Array.from(a.beats),
      downbeats: Array.from(a.downbeats),
      energy: Array.from(a.energy),
      waveform: packWave(a.waveform),
      overview: packWave(a.overview),
    };
    return tx(STORE_ANALYSIS, 'readwrite', (s) => s.put(stored, id));
  },
  delete: (id: string) => tx(STORE_ANALYSIS, 'readwrite', (s) => s.delete(id)),
  clear: () => tx(STORE_ANALYSIS, 'readwrite', (s) => s.clear()),
};

// --------------------------------------------------------------- playlists

export const playlistsDb = {
  all: () => tx<Playlist[]>(STORE_PLAYLISTS, 'readonly', (s) => s.getAll() as IDBRequest<Playlist[]>),
  put: (p: Playlist) => tx(STORE_PLAYLISTS, 'readwrite', (s) => s.put(p)),
  delete: (id: string) => tx(STORE_PLAYLISTS, 'readwrite', (s) => s.delete(id)),
};

// ---------------------------------------------------------------- sessions

export interface StoredSession {
  id: string;
  name: string;
  savedAt: number;
  data: unknown;
}

export const sessionsDb = {
  all: () => tx<StoredSession[]>(STORE_SESSIONS, 'readonly', (s) => s.getAll() as IDBRequest<StoredSession[]>),
  get: (id: string) => tx<StoredSession | undefined>(STORE_SESSIONS, 'readonly', (s) => s.get(id)),
  put: (s0: StoredSession) => tx(STORE_SESSIONS, 'readwrite', (s) => s.put(s0)),
  delete: (id: string) => tx(STORE_SESSIONS, 'readwrite', (s) => s.delete(id)),
};

// ---------------------------------------------------------------- settings

export const settingsDb = {
  get: <T>(key: string) => tx<T | undefined>(STORE_SETTINGS, 'readonly', (s) => s.get(key)),
  put: (key: string, value: unknown) => tx(STORE_SETTINGS, 'readwrite', (s) => s.put(value, key)),
};

// ----------------------------------------------------------------- history

export const historyDb = {
  all: () => tx<HistoryEntry[]>(STORE_HISTORY, 'readonly', (s) => s.getAll() as IDBRequest<HistoryEntry[]>),
  add: (e: HistoryEntry) => tx(STORE_HISTORY, 'readwrite', (s) => s.add(e)),
  clear: () => tx(STORE_HISTORY, 'readwrite', (s) => s.clear()),
};

// ----------------------------------------------------------------- samples

export const samplesDb = {
  get: (key: string) => tx<{ name: string; blob: Blob } | undefined>(STORE_SAMPLES, 'readonly', (s) => s.get(key)),
  put: (key: string, value: { name: string; blob: Blob }) => tx(STORE_SAMPLES, 'readwrite', (s) => s.put(value, key)),
  delete: (key: string) => tx(STORE_SAMPLES, 'readwrite', (s) => s.delete(key)),
};

/**
 * Content hash used as the track id, so the same file imported twice reuses its
 * cached analysis instead of being analysed again.
 */
export async function hashFile(file: File): Promise<string> {
  // Hash the head, the tail and the size. Hashing whole multi-megabyte files
  // on import is slow and buys nothing for collision resistance here.
  const head = await file.slice(0, 65536).arrayBuffer();
  const tail = await file.slice(Math.max(0, file.size - 65536)).arrayBuffer();
  const combined = new Uint8Array(head.byteLength + tail.byteLength + 8);
  combined.set(new Uint8Array(head), 0);
  combined.set(new Uint8Array(tail), head.byteLength);
  new DataView(combined.buffer).setFloat64(head.byteLength + tail.byteLength, file.size);
  const digest = await crypto.subtle.digest('SHA-256', combined);
  return Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const est = await navigator.storage.estimate();
  return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
}
