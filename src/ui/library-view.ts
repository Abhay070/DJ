/**
 * Track library: browse, search, filter, sort, rate, and drag onto decks.
 * Compatibility against the currently loaded decks is shown as advice, with
 * the reasoning visible - it never picks for you.
 */
import { el, button, clear, setText, setClass } from './dom';
import type { DjConsole } from '../state/console';
import { formatDuration } from '../state/console';
import type { Track, DeckId } from '../lib/types';
import { formatKey, keyCompatibility, keyRelation, keyRelationLabel } from '../lib/music';
import { tempoRatio } from '../lib/grid';

export class LibraryView {
  readonly root: HTMLElement;
  private dj: DjConsole;
  private tbody: HTMLElement;
  private countEl: HTMLElement;
  private searchInput: HTMLInputElement;
  private suggestEl: HTMLElement;

  constructor(dj: DjConsole) {
    this.dj = dj;
    this.tbody = el('div', { class: 'track-rows' });
    this.countEl = el('span', { class: 'library-count', text: '0 tracks' });
    this.suggestEl = el('div', { class: 'suggestions' });

    this.searchInput = el('input', {
      class: 'search-input',
      type: 'search',
      placeholder: 'Search title, artist, genre or tag',
      oninput: (e: Event) => {
        dj.store.state.search = (e.target as HTMLInputElement).value;
        this.renderRows();
      },
    });

    const importBtn = button('Import files', {
      class: 'primary-btn',
      onclick: () => this.pickFiles(false),
    });
    const importFolder = button('Import folder', {
      class: 'secondary-btn',
      onclick: () => this.pickFiles(true),
    });

    const filters = el('div', { class: 'library-filters' }, [
      this.numberFilter('BPM from', 'bpmMin'),
      this.numberFilter('to', 'bpmMax'),
      this.ratingFilter(),
      button('Clear', {
        class: 'mini-btn',
        onclick: () => {
          dj.store.state.filters = { bpmMin: null, bpmMax: null, key: null, genre: null, rating: null };
          for (const input of this.root.querySelectorAll<HTMLInputElement>('.filter-input')) input.value = '';
          this.renderRows();
        },
      }),
    ]);

    const header = el('div', { class: 'track-header' }, [
      this.headerCell('Title', 'title'),
      this.headerCell('Artist', 'artist'),
      this.headerCell('BPM', 'bpm'),
      this.headerCell('Key', 'key'),
      this.headerCell('Time', 'duration'),
      this.headerCell('Energy', 'rating'),
      this.headerCell('Rating', 'rating'),
      el('span', { class: 'th', text: 'Load' }),
    ]);

    this.root = el('div', { class: 'library' }, [
      el('div', { class: 'library-toolbar' }, [
        this.searchInput, importBtn, importFolder, this.countEl,
      ]),
      filters,
      this.suggestEl,
      el('div', { class: 'track-table' }, [header, this.tbody]),
    ]);

    this.attachDropZone();
    dj.store.subscribe('library', () => this.renderRows());
    dj.store.subscribe('analysis', () => this.renderRows());
    dj.store.subscribe('deck', () => this.renderSuggestions());
    this.renderRows();
  }

  private headerCell(label: string, key: string): HTMLElement {
    const dj = this.dj;
    return el('button', {
      class: 'th sortable',
      type: 'button',
      onclick: () => {
        const s = dj.store.state;
        if (s.sortBy === key) s.sortDir = s.sortDir === 'asc' ? 'desc' : 'asc';
        else { s.sortBy = key as typeof s.sortBy; s.sortDir = 'asc'; }
        this.renderRows();
      },
    }, [label]);
  }

  private numberFilter(label: string, key: 'bpmMin' | 'bpmMax'): HTMLElement {
    return el('label', { class: 'filter' }, [
      el('span', { text: label }),
      el('input', {
        class: 'filter-input', type: 'number', min: 40, max: 220,
        oninput: (e: Event) => {
          const v = (e.target as HTMLInputElement).value;
          this.dj.store.state.filters[key] = v === '' ? null : Number(v);
          this.renderRows();
        },
      }),
    ]);
  }

  private ratingFilter(): HTMLElement {
    return el('label', { class: 'filter' }, [
      el('span', { text: 'Min rating' }),
      el('select', {
        class: 'filter-input',
        onchange: (e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          this.dj.store.state.filters.rating = v === '' ? null : Number(v);
          this.renderRows();
        },
      }, [
        el('option', { value: '', text: 'Any' }),
        ...[1, 2, 3, 4, 5].map((n) => el('option', { value: n, text: '★'.repeat(n) })),
      ]),
    ]);
  }

  private pickFiles(directory: boolean) {
    const input = el('input', { type: 'file', multiple: true, accept: 'audio/*' });
    if (directory) {
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
    }
    input.addEventListener('change', async () => {
      const files = [...(input.files ?? [])];
      if (files.length) {
        this.dj.store.toast(`Importing ${files.length} file${files.length === 1 ? '' : 's'}`, 'info');
        await this.dj.library.importFiles(files);
      }
    });
    input.click();
  }

  private attachDropZone() {
    this.root.addEventListener('dragover', (e) => { e.preventDefault(); this.root.classList.add('drop-target'); });
    this.root.addEventListener('dragleave', (e) => {
      if (e.target === this.root) this.root.classList.remove('drop-target');
    });
    this.root.addEventListener('drop', async (e) => {
      e.preventDefault();
      this.root.classList.remove('drop-target');
      const files = await collectFiles(e.dataTransfer);
      if (files.length) await this.dj.library.importFiles(files);
    });
  }

  // ------------------------------------------------------------- rendering

  private visibleTracks(): Track[] {
    const s = this.dj.store.state;
    const q = s.search.trim().toLowerCase();
    let list = [...s.tracks.values()];

    if (q) {
      list = list.filter((t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.genre.toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.toLowerCase().includes(q)));
    }

    const f = s.filters;
    if (f.bpmMin !== null) list = list.filter((t) => bpmOf(t) >= f.bpmMin!);
    if (f.bpmMax !== null) list = list.filter((t) => bpmOf(t) <= f.bpmMax!);
    if (f.rating !== null) list = list.filter((t) => t.rating >= f.rating!);
    if (f.genre) list = list.filter((t) => t.genre === f.genre);

    const dir = s.sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      let av: string | number;
      let bv: string | number;
      switch (s.sortBy) {
        case 'bpm': av = bpmOf(a); bv = bpmOf(b); break;
        case 'key': av = a.analysis?.key ? formatKey(a.analysis.key, 'camelot') : 'zz'; bv = b.analysis?.key ? formatKey(b.analysis.key, 'camelot') : 'zz'; break;
        case 'duration': av = a.duration; bv = b.duration; break;
        case 'rating': av = a.rating; bv = b.rating; break;
        case 'artist': av = a.artist.toLowerCase(); bv = b.artist.toLowerCase(); break;
        case 'title': av = a.title.toLowerCase(); bv = b.title.toLowerCase(); break;
        default: av = a.dateAdded; bv = b.dateAdded;
      }
      return av < bv ? -dir : av > bv ? dir : 0;
    });
    return list;
  }

  private renderRows() {
    const tracks = this.visibleTracks();
    const total = this.dj.store.state.tracks.size;
    const queue = this.dj.store.state.analysisQueue;
    setText(this.countEl, queue > 0
      ? `${tracks.length} of ${total} tracks · analysing ${queue}`
      : `${tracks.length} of ${total} tracks`);

    clear(this.tbody);
    if (!tracks.length) {
      this.tbody.append(el('p', { class: 'empty-state', text: total
        ? 'No tracks match the current search or filters.'
        : 'Drop audio files here, or use Import, to build your library.' }));
      this.renderSuggestions();
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const track of tracks) fragment.append(this.buildRow(track));
    this.tbody.append(fragment);
    this.renderSuggestions();
  }

  private buildRow(track: Track): HTMLElement {
    const dj = this.dj;
    const bpm = bpmOf(track);
    const analysing = track.analysisState === 'analysing' || track.analysisState === 'pending';

    const bpmCell = el('span', { class: 'td td-bpm' }, [
      analysing ? 'analysing…' :
      track.analysisState === 'failed' ? '!' :
      bpm > 0 ? bpm.toFixed(1) : '--',
    ]);
    if (track.analysisState === 'failed') bpmCell.title = track.analysisError ?? 'Analysis failed';
    if (track.analysis && track.analysis.bpmConfidence < 0.35 && bpm > 0 && !track.bpmOverride) {
      bpmCell.classList.add('uncertain');
      bpmCell.title = 'Low-confidence tempo estimate';
    }

    const rating = el('span', { class: 'td td-rating' },
      [1, 2, 3, 4, 5].map((n) => el('button', {
        class: `star ${track.rating >= n ? 'on' : ''}`,
        type: 'button',
        title: `Rate ${n}`,
        onclick: async (e: Event) => {
          e.stopPropagation();
          track.rating = track.rating === n ? 0 : n;
          await dj.library.persistMeta(track);
          this.renderRows();
        },
      }, ['★'])),
    );

    const energy = track.analysis ? averageEnergy(track.analysis.energy) : 0;
    const energyCell = el('span', { class: 'td td-energy' }, [
      el('span', { class: 'energy-bar', style: `--energy:${Math.round(energy * 100)}%` }),
    ]);
    energyCell.title = `Average energy ${(energy * 100).toFixed(0)}%`;

    const loadButtons = el('span', { class: 'td td-load' },
      dj.engine.deckIds.map((id) => button(id, {
        class: 'load-btn',
        title: `Load onto deck ${id}`,
        onclick: (e: Event) => { e.stopPropagation(); void dj.loadTrack(id, track.id); },
      })),
    );

    const row = el('div', {
      class: 'track-row',
      draggable: true,
      'data-track': track.id,
      onclick: () => {
        dj.store.state.selectedTrack = track.id;
        for (const r of this.tbody.querySelectorAll('.track-row')) r.classList.remove('selected');
        row.classList.add('selected');
        this.renderSuggestions();
      },
      ondblclick: () => {
        // Double-click loads onto whichever deck is free or stopped.
        const free = dj.engine.deckIds.find((id) => !dj.engine.deck(id).hasTrack)
          ?? dj.engine.deckIds.find((id) => !dj.engine.deck(id).playing)
          ?? dj.engine.deckIds[0];
        void dj.loadTrack(free, track.id);
      },
      oncontextmenu: async (e: Event) => {
        e.preventDefault();
        if (confirm(`Remove "${track.title}" from the library? The file is deleted from local storage.`)) {
          await dj.library.remove(track.id);
        }
      },
    }, [
      el('span', { class: 'td td-title', text: track.title, title: track.fileName }),
      el('span', { class: 'td td-artist', text: track.artist }),
      bpmCell,
      el('span', { class: 'td td-key', text: track.analysis?.key ? formatKey(track.analysis.key, dj.store.state.settings.keyStyle) : '--' }),
      el('span', { class: 'td td-time', text: track.duration ? formatDuration(track.duration) : '--' }),
      energyCell,
      rating,
      loadButtons,
    ]);

    setClass(row, 'selected', dj.store.state.selectedTrack === track.id);
    setClass(row, 'analysing', analysing);

    row.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/track-id', track.id);
      e.dataTransfer!.effectAllowed = 'copy';
    });

    return row;
  }

  /**
   * Compatibility readout for the selected track against what is loaded.
   * Presented as reasoning, not a verdict.
   */
  private renderSuggestions() {
    const dj = this.dj;
    clear(this.suggestEl);
    const selectedId = dj.store.state.selectedTrack;
    if (!selectedId) return;
    const track = dj.store.state.tracks.get(selectedId);
    if (!track?.analysis) return;

    const rows: HTMLElement[] = [];
    for (const id of dj.engine.deckIds) {
      const deck = dj.engine.deck(id);
      if (!deck.hasTrack || !deck.analysis) continue;
      rows.push(this.compatibilityRow(id, deck.analysis, track));
    }
    if (!rows.length) return;

    this.suggestEl.append(
      el('span', { class: 'section-label', text: `Mixing "${track.title}" against` }),
      ...rows,
    );
  }

  private compatibilityRow(id: DeckId, loaded: NonNullable<Track['analysis']>, candidate: Track): HTMLElement {
    const deck = this.dj.engine.deck(id);
    const candidateBpm = bpmOf(candidate);
    const loadedBpm = deck.currentBpm || loaded.bpm;

    const ratio = tempoRatio(candidateBpm, loadedBpm);
    const stretchPercent = (ratio - 1) * 100;
    const bpmOk = Math.abs(stretchPercent) <= 6;

    const rel = keyRelation(loaded.key, candidate.analysis!.key);
    const keyScore = keyCompatibility(loaded.key, candidate.analysis!.key);

    const energyDiff = Math.abs(averageEnergy(loaded.energy) - averageEnergy(candidate.analysis!.energy));

    return el('div', { class: 'compat-row' }, [
      el('span', { class: 'compat-deck', text: `Deck ${id}` }),
      el('span', { class: `chip ${bpmOk ? 'good' : 'warn'}` }, [
        `Tempo ${stretchPercent >= 0 ? '+' : ''}${stretchPercent.toFixed(1)}%`,
      ]),
      el('span', { class: `chip ${keyScore >= 0.8 ? 'good' : keyScore >= 0.5 ? 'ok' : 'warn'}`, title: keyRelationLabel(rel) }, [
        rel ? keyRelationLabel(rel) : 'Key unknown',
      ]),
      el('span', { class: `chip ${energyDiff < 0.15 ? 'good' : energyDiff < 0.3 ? 'ok' : 'warn'}` }, [
        `Energy ${energyDiff < 0.15 ? 'similar' : energyDiff < 0.3 ? 'close' : 'different'}`,
      ]),
      el('span', { class: 'chip subtle' }, [
        `${candidateBpm.toFixed(1)} → ${loadedBpm.toFixed(1)} BPM`,
      ]),
    ]);
  }
}

function bpmOf(track: Track): number {
  return track.bpmOverride ?? track.analysis?.bpm ?? 0;
}

function averageEnergy(energy: Float32Array): number {
  if (!energy.length) return 0;
  let sum = 0;
  for (let i = 0; i < energy.length; i++) sum += energy[i];
  return sum / energy.length;
}

/** Walk a drop's directory entries so dropping a folder imports its contents. */
async function collectFiles(dt: DataTransfer | null): Promise<File[]> {
  if (!dt) return [];
  const items = [...dt.items].filter((i) => i.kind === 'file');
  const entries = items.map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() ?? null);
  if (!entries.some(Boolean)) return [...dt.files];

  const out: File[] = [];
  const walk = async (entry: FileSystemEntry | null): Promise<void> => {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) =>
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null)));
      if (file) out.push(file);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns at most 100 at a time, so keep reading until empty.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve) =>
          reader.readEntries((e) => resolve(e), () => resolve([])));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const entry of entries) await walk(entry);
  return out;
}
