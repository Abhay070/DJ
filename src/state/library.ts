/**
 * Track import and the analysis queue.
 *
 * Import is: read file -> hash -> decode -> cache audio -> analyse (worker).
 * Analysis results are cached by content hash and never recomputed unless the
 * user asks for a re-analysis or the analysis format version moves on.
 */
import { tracksDb, audioDb, analysisDb, hashFile } from '../lib/db';
import type { Analysis, Track, TrackMeta } from '../lib/types';
import { ANALYSIS_VERSION, type AnalyseResponse } from '../analysis/protocol';
import { parseFileName } from '../lib/filename';
import type { Store } from './store';

const SUPPORTED = /\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|aiff?|webm)$/i;

export interface ImportProgress {
  total: number;
  done: number;
  current: string;
}

export class Library {
  private worker: Worker;
  private pending = new Map<string, { resolve: (a: Analysis) => void; reject: (e: Error) => void }>();
  private queue: string[] = [];
  private busy = false;
  private store: Store;
  private decode: (data: ArrayBuffer) => Promise<AudioBuffer>;

  onProgress: ((stage: string, progress: number, trackId: string) => void) | null = null;

  constructor(store: Store, decode: (data: ArrayBuffer) => Promise<AudioBuffer>) {
    this.store = store;
    this.decode = decode;
    this.worker = new Worker(new URL('../analysis/analysis-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<AnalyseResponse>) => this.onWorkerMessage(e.data);
    this.worker.onerror = (e) => {
      // A worker-level failure would otherwise leave every request hanging.
      for (const [, p] of this.pending) p.reject(new Error(e.message || 'Analysis worker crashed'));
      this.pending.clear();
      this.busy = false;
    };
  }

  private onWorkerMessage(msg: AnalyseResponse) {
    if (msg.type === 'progress') {
      this.onProgress?.(msg.stage, msg.progress, msg.id);
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.type === 'done') entry.resolve(msg.analysis);
    else entry.reject(new Error(msg.message));
  }

  async loadPersisted(): Promise<void> {
    const metas = await tracksDb.all();
    for (const meta of metas) {
      const analysis = meta.analysisState === 'done' ? await analysisDb.get(meta.id) : undefined;
      const track: Track = { ...meta, analysis: analysis ?? null };
      // A track cached from an older analyser gets re-queued rather than shown
      // with stale data.
      if (analysis && analysis.version !== ANALYSIS_VERSION) {
        track.analysis = null;
        track.analysisState = 'pending';
      }
      this.store.state.tracks.set(track.id, track);
      if (track.analysisState === 'pending' || track.analysisState === 'analysing') {
        this.enqueue(track.id);
      }
    }
    this.store.notify('library');
  }

  /** Import a batch of files. Returns the ids that were added or already known. */
  async importFiles(files: File[]): Promise<string[]> {
    const audio = files.filter((f) => SUPPORTED.test(f.name) || f.type.startsWith('audio/'));
    const skipped = files.length - audio.length;
    if (skipped > 0) {
      this.store.toast(
        `Skipped ${skipped} file${skipped === 1 ? '' : 's'} that ${skipped === 1 ? 'is' : 'are'} not audio`,
        'warn',
      );
    }

    const ids: string[] = [];
    for (const file of audio) {
      try {
        const id = await this.importFile(file);
        if (id) ids.push(id);
      } catch (err) {
        this.store.toast(
          `Could not import ${file.name}`,
          'error',
          { detail: err instanceof Error ? err.message : String(err) },
        );
      }
    }
    this.store.notify('library');
    return ids;
  }

  private async importFile(file: File): Promise<string | null> {
    const id = await hashFile(file);
    const existing = this.store.state.tracks.get(id);
    if (existing) return id;

    const stored = await tracksDb.get(id);
    if (stored) {
      const analysis = await analysisDb.get(id);
      this.store.state.tracks.set(id, { ...stored, analysis: analysis ?? null });
      return id;
    }

    const tags = parseFileName(file.name);
    const meta: TrackMeta = {
      id,
      title: tags.title,
      artist: tags.artist,
      album: '',
      genre: '',
      duration: 0,
      fileName: file.name,
      fileSize: file.size,
      dateAdded: Date.now(),
      playCount: 0,
      lastPlayed: null,
      rating: 0,
      tags: [],
      bpmOverride: null,
      cues: [],
      loops: [],
      gainOffset: 0,
      analysisState: 'pending',
    };

    await audioDb.put(id, file);
    await tracksDb.put(meta);
    this.store.state.tracks.set(id, { ...meta, analysis: null });
    this.enqueue(id);
    return id;
  }

  enqueue(id: string) {
    if (!this.queue.includes(id)) {
      this.queue.push(id);
      this.store.state.analysisQueue = this.queue.length + (this.busy ? 1 : 0);
      this.store.notify('analysis');
    }
    void this.drain();
  }

  /** Force a fresh analysis, optionally with a user-supplied BPM. */
  async reanalyse(id: string, bpmHint?: number) {
    const track = this.store.state.tracks.get(id);
    if (!track) return;
    await analysisDb.delete(id);
    track.analysis = null;
    track.analysisState = 'pending';
    if (bpmHint) track.bpmOverride = bpmHint;
    await this.persistMeta(track);
    this.enqueue(id);
  }

  private async drain() {
    if (this.busy) return;
    const id = this.queue.shift();
    if (!id) {
      this.store.state.analysisQueue = 0;
      this.store.notify('analysis');
      return;
    }
    this.busy = true;
    this.store.state.analysisQueue = this.queue.length + 1;
    this.store.notify('analysis');

    const track = this.store.state.tracks.get(id);
    if (!track) { this.busy = false; void this.drain(); return; }

    track.analysisState = 'analysing';
    this.store.notify('library', 'analysis');

    try {
      const cached = await analysisDb.get(id);
      if (cached && cached.version === ANALYSIS_VERSION) {
        track.analysis = cached;
        track.duration = cached.duration;
        track.analysisState = 'done';
      } else {
        const blob = await audioDb.get(id);
        if (!blob) throw new Error('The audio for this track is no longer in local storage');
        const buffer = await this.decodeSafely(blob, track.fileName);
        const analysis = await this.runAnalysis(id, buffer, track.bpmOverride ?? undefined);
        await analysisDb.put(id, analysis);
        track.analysis = analysis;
        track.duration = analysis.duration;
        track.analysisState = 'done';

        if (analysis.bpm === 0) {
          this.store.toast(`Could not determine the BPM of "${track.title}"`, 'warn', {
            detail: 'Set it by hand on the deck, or try re-analysing.',
          });
        } else if (analysis.bpmConfidence < 0.35) {
          const spread = Math.max(2, Math.round(analysis.bpm * 0.03));
          this.store.toast(`BPM for "${track.title}" is uncertain`, 'warn', {
            detail: `Detected ${analysis.bpm.toFixed(1)} BPM ± ${spread}. Confirm or correct it on the deck.`,
          });
        }
      }
      delete track.analysisError;
    } catch (err) {
      track.analysisState = 'failed';
      track.analysisError = err instanceof Error ? err.message : String(err);
      this.store.toast(`Analysis failed for "${track.title}"`, 'error', { detail: track.analysisError });
    }

    await this.persistMeta(track);
    this.store.notify('library', 'analysis');
    this.busy = false;
    void this.drain();
  }

  private async decodeSafely(blob: Blob, fileName: string): Promise<AudioBuffer> {
    const data = await blob.arrayBuffer();
    try {
      return await this.decode(data);
    } catch {
      const ext = fileName.split('.').pop()?.toUpperCase() ?? 'this format';
      throw new Error(
        `This browser could not decode ${ext}. Try MP3, WAV, FLAC, M4A or OGG, ` +
        'or convert the file first - decoding uses the browser\'s own codecs.',
      );
    }
  }

  private runAnalysis(id: string, buffer: AudioBuffer, bpmHint?: number): Promise<Analysis> {
    return new Promise((resolve, reject) => {
      const channels: Float32Array[] = [];
      const transfer: ArrayBufferLike[] = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const copy = new Float32Array(buffer.length);
        buffer.copyFromChannel(copy, c);
        channels.push(copy);
        transfer.push(copy.buffer);
      }
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(
        { id, channels, sampleRate: buffer.sampleRate, duration: buffer.duration, bpmHint },
        transfer as Transferable[],
      );
    });
  }

  async persistMeta(track: Track) {
    const { analysis: _analysis, ...meta } = track;
    await tracksDb.put(meta as TrackMeta);
  }

  async remove(id: string) {
    await tracksDb.delete(id);
    await audioDb.delete(id);
    await analysisDb.delete(id);
    this.store.state.tracks.delete(id);
    this.store.notify('library');
  }

  async getAudio(id: string): Promise<AudioBuffer> {
    const track = this.store.state.tracks.get(id);
    const blob = await audioDb.get(id);
    if (!blob) throw new Error('The audio for this track is no longer in local storage');
    return this.decodeSafely(blob, track?.fileName ?? 'file');
  }
}

export { parseFileName };
