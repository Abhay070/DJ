/**
 * One deck's user interface.
 *
 * Every readout in here is pulled from the engine on each animation frame.
 * There is deliberately no path by which the UI can claim a state the audio
 * engine is not in - SYNC only lights when SyncEngine reports a lock, the BPM
 * shown is grid BPM times the rate the worklet is actually running at, and the
 * loop badge reads the engine's own loop flag.
 */
import { el, button, setClass, setText, fader, clamp } from './dom';
import { ScrollingWaveform, OverviewWaveform } from './waveform';
import { JogWheel } from './jog';
import type { DjConsole } from '../state/console';
import { formatTime } from '../state/console';
import type { DeckId } from '../lib/types';
import { formatKey, keyRelation, keyRelationLabel } from '../lib/music';

const LOOP_SIZES = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
const LOOP_LABELS = ['1/32', '1/16', '1/8', '1/4', '1/2', '1', '2', '4', '8', '16', '32'];
const ROLL_SIZES = [1 / 16, 1 / 8, 1 / 4, 1 / 2];
const ROLL_LABELS = ['1/16', '1/8', '1/4', '1/2'];
const JUMP_SIZES = [1, 2, 4, 8, 16, 32];
const TEMPO_RANGES = [6, 8, 10, 16, 50, 100];

export class DeckView {
  readonly root: HTMLElement;
  private dj: DjConsole;
  private id: DeckId;

  private scrolling: ScrollingWaveform;
  private overview: OverviewWaveform;
  private jog: JogWheel;

  // Cached nodes, so the frame loop never queries the DOM.
  private titleEl: HTMLElement;
  private artistEl: HTMLElement;
  private timeEl: HTMLElement;
  private remainEl: HTMLElement;
  private bpmEl: HTMLElement;
  private originalBpmEl: HTMLElement;
  private pitchEl: HTMLElement;
  private keyEl: HTMLElement;
  private phaseBar: HTMLElement;
  private phaseText: HTMLElement;
  private playBtn: HTMLButtonElement;
  private syncBtn: HTMLButtonElement;
  private masterBadge: HTMLElement;
  private loopBadge: HTMLElement;
  private cuePads: HTMLButtonElement[] = [];
  private tempoFader: { root: HTMLElement; update: () => void };
  private statusEl: HTMLElement;
  private bpmConfidenceEl: HTMLElement;

  constructor(dj: DjConsole, id: DeckId) {
    this.dj = dj;
    this.id = id;

    const scrollCanvas = el('canvas', { class: 'wave-detail' });
    const overviewCanvas = el('canvas', { class: 'wave-overview' });

    this.titleEl = el('span', { class: 'deck-title', text: 'No track loaded' });
    this.artistEl = el('span', { class: 'deck-artist', text: '--' });
    this.timeEl = el('span', { class: 'time-elapsed', text: '0:00.0' });
    this.remainEl = el('span', { class: 'time-remaining', text: '-0:00.0' });
    this.bpmEl = el('span', { class: 'bpm-value', text: '--' });
    this.originalBpmEl = el('span', { class: 'bpm-original', text: 'orig --' });
    this.pitchEl = el('span', { class: 'pitch-value', text: '0.00%' });
    this.keyEl = el('span', { class: 'key-value', text: '--' });
    this.phaseBar = el('div', { class: 'phase-bar-fill' });
    this.phaseText = el('span', { class: 'phase-text', text: '--' });
    this.masterBadge = el('span', { class: 'badge badge-master', text: 'MASTER' });
    this.loopBadge = el('span', { class: 'badge badge-loop', text: 'LOOP' });
    this.statusEl = el('span', { class: 'deck-status' });
    this.bpmConfidenceEl = el('span', { class: 'bpm-confidence' });

    this.scrolling = new ScrollingWaveform(scrollCanvas);
    this.overview = new OverviewWaveform(overviewCanvas);

    const deck = dj.engine.deck(id);
    this.jog = new JogWheel(deck, {
      onScratch: (rate, active) => deck.scratch(rate, active),
      onBend: (amount) => dj.bend(id, amount),
      onBendEnd: () => dj.endBend(id),
      onSeek: (delta) => deck.seek(deck.position + delta),
    });

    this.playBtn = button('PLAY', { class: 'transport-btn play-btn', onclick: () => dj.togglePlay(id) });
    this.syncBtn = button('SYNC', { class: 'transport-btn sync-btn', onclick: () => dj.toggleSync(id) });

    this.tempoFader = fader({
      min: -1, max: 1,
      getValue: () => {
        const ui = dj.store.deck(id);
        return -ui.pitchPercent / Math.max(1, ui.tempoRange);
      },
      onChange: (v) => {
        const ui = dj.store.deck(id);
        dj.setPitchPercent(id, -v * ui.tempoRange);
      },
      defaultValue: 0,
      sensitivity: 1 / 150,
    });

    this.root = this.build(scrollCanvas, overviewCanvas);
    this.attachWaveformInteraction(scrollCanvas, overviewCanvas);
    this.attachDropTarget();

    dj.store.subscribe('deck', () => this.renderSlow());
    dj.store.subscribe('library', () => this.renderSlow());
    this.renderSlow();
  }

  // ------------------------------------------------------------------ build

  private build(scrollCanvas: HTMLCanvasElement, overviewCanvas: HTMLCanvasElement): HTMLElement {
    const dj = this.dj;
    const id = this.id;

    const header = el('div', { class: 'deck-header' }, [
      el('div', { class: 'deck-id' }, [String(id)]),
      el('div', { class: 'deck-track' }, [this.titleEl, this.artistEl]),
      el('div', { class: 'deck-badges' }, [this.masterBadge, this.loopBadge, this.statusEl]),
    ]);

    const readouts = el('div', { class: 'deck-readouts' }, [
      el('div', { class: 'readout readout-time' }, [this.timeEl, this.remainEl]),
      el('div', { class: 'readout readout-bpm' }, [
        this.bpmEl,
        el('div', { class: 'readout-sub' }, [this.originalBpmEl, this.bpmConfidenceEl]),
      ]),
      el('div', { class: 'readout readout-key' }, [
        this.keyEl,
        el('span', { class: 'readout-label', text: 'KEY' }),
      ]),
      el('div', { class: 'readout readout-pitch' }, [
        this.pitchEl,
        el('span', { class: 'readout-label', text: 'PITCH' }),
      ]),
    ]);

    const phase = el('div', { class: 'phase-meter', title: 'Phase difference against the master deck' }, [
      el('span', { class: 'phase-label', text: 'PHASE' }),
      el('div', { class: 'phase-bar' }, [el('div', { class: 'phase-centre' }), this.phaseBar]),
      this.phaseText,
    ]);

    const transport = el('div', { class: 'transport' }, [
      button('CUE', {
        class: 'transport-btn cue-btn',
        onpointerdown: (e: Event) => {
          e.preventDefault();
          const deck = dj.engine.deck(id);
          if (deck.playing) dj.pressCue(id);
          else dj.cuePlayStart(id);
        },
        onpointerup: () => {
          const deck = dj.engine.deck(id);
          if (deck.playing) dj.cuePlayEnd(id);
        },
        onclick: () => { if (!dj.engine.deck(id).playing) dj.pressCue(id); },
      }),
      this.playBtn,
      this.syncBtn,
    ]);

    const toggles = el('div', { class: 'deck-toggles' }, [
      this.toggle('KEY LOCK', () => dj.store.deck(id).keyLock, (v) => dj.setKeyLock(id, v)),
      this.toggle('QUANT', () => dj.store.deck(id).quantize, (v) => dj.setQuantize(id, v)),
      this.toggle('SLIP', () => dj.store.deck(id).slip, (v) => dj.setSlip(id, v)),
      this.toggle('REV', () => dj.store.deck(id).reverse, (v) => dj.setReverse(id, v)),
    ]);

    // ---- hot cues ----------------------------------------------------------
    const cueGrid = el('div', { class: 'pad-grid cue-grid' });
    for (let i = 0; i < 8; i++) {
      const pad = button(String(i + 1), {
        class: 'pad cue-pad',
        title: `Hot cue ${i + 1} - click to set or jump, shift-click to delete`,
        onclick: (e: Event) => {
          // Shift-click clears a cue rather than jumping to it.
          if ((e as MouseEvent).shiftKey) void dj.deleteHotCue(id, i);
          else void dj.setHotCue(id, i);
        },
        oncontextmenu: (e: Event) => {
          e.preventDefault();
          const cue = dj.store.deck(id).hotCues.find((c) => c.index === i);
          if (!cue) return;
          const name = prompt('Cue name', cue.name);
          if (name !== null) void dj.renameHotCue(id, i, name);
        },
      });
      this.cuePads.push(pad);
      cueGrid.append(pad);
    }

    // ---- loops -------------------------------------------------------------
    const loopSizes = el('div', { class: 'pad-grid loop-grid' },
      LOOP_SIZES.map((beats, i) => button(LOOP_LABELS[i], {
        class: 'pad loop-pad',
        title: `${LOOP_LABELS[i]} beat auto loop`,
        onclick: () => dj.setLoopBeats(id, beats),
      })),
    );

    const loopControls = el('div', { class: 'loop-controls' }, [
      button('IN', { class: 'mini-btn', onclick: () => dj.loopIn(id) }),
      button('OUT', { class: 'mini-btn', onclick: () => dj.loopOut(id) }),
      button('½', { class: 'mini-btn', title: 'Halve the loop', onclick: () => dj.halveLoop(id) }),
      button('×2', { class: 'mini-btn', title: 'Double the loop', onclick: () => dj.doubleLoop(id) }),
      button('ON', { class: 'mini-btn', onclick: () => dj.toggleLoop(id) }),
      button('RELOOP', { class: 'mini-btn', onclick: () => dj.reloop(id) }),
      button('EXIT', { class: 'mini-btn', onclick: () => dj.exitLoop(id) }),
    ]);

    const rollPads = el('div', { class: 'pad-grid roll-grid' },
      ROLL_SIZES.map((beats, i) => {
        const pad = button(ROLL_LABELS[i], { class: 'pad roll-pad', title: `${ROLL_LABELS[i]} beat loop roll` });
        // Momentary: held down it rolls, released the timeline carries on.
        pad.addEventListener('pointerdown', (e) => { e.preventDefault(); dj.startLoopRoll(id, beats); });
        pad.addEventListener('pointerup', () => dj.endLoopRoll(id));
        pad.addEventListener('pointerleave', () => dj.endLoopRoll(id));
        return pad;
      }),
    );

    const jumpPads = el('div', { class: 'pad-grid jump-grid' }, [
      ...JUMP_SIZES.slice().reverse().map((n) => button(`-${n}`, {
        class: 'pad jump-pad', onclick: () => dj.beatJump(id, -n),
      })),
      ...JUMP_SIZES.map((n) => button(`+${n}`, {
        class: 'pad jump-pad', onclick: () => dj.beatJump(id, n),
      })),
    ]);

    // ---- tempo -------------------------------------------------------------
    const rangeSelect = el('select', {
      class: 'tempo-range',
      onchange: (e: Event) => dj.setTempoRange(id, Number((e.target as HTMLSelectElement).value)),
    }, TEMPO_RANGES.map((r) => el('option', { value: r, text: `±${r}%` })));
    rangeSelect.value = String(dj.store.deck(id).tempoRange);

    const tempoCol = el('div', { class: 'tempo-column' }, [
      el('div', { class: 'tempo-head' }, [
        button('−', { class: 'mini-btn', title: 'Pitch bend down (hold)', onpointerdown: () => dj.bend(id, -0.04), onpointerup: () => dj.endBend(id), onpointerleave: () => dj.endBend(id) }),
        button('+', { class: 'mini-btn', title: 'Pitch bend up (hold)', onpointerdown: () => dj.bend(id, 0.04), onpointerup: () => dj.endBend(id), onpointerleave: () => dj.endBend(id) }),
      ]),
      this.tempoFader.root,
      button('RESET', { class: 'mini-btn', onclick: () => { dj.resetPitch(id); this.tempoFader.update(); } }),
      rangeSelect,
    ]);

    // ---- grid editing (advanced mode) --------------------------------------
    const gridTools = el('div', { class: 'grid-tools advanced-only' }, [
      el('span', { class: 'section-label', text: 'BEAT GRID' }),
      button('SET ⏱', { class: 'mini-btn', title: 'Mark the playhead as beat 1', onclick: () => dj.setGridFirstBeat(id) }),
      button('◀', { class: 'mini-btn', title: 'Nudge the grid earlier', onclick: () => dj.nudgeGrid(id, -0.005) }),
      button('▶', { class: 'mini-btn', title: 'Nudge the grid later', onclick: () => dj.nudgeGrid(id, 0.005) }),
      button('BPM', {
        class: 'mini-btn',
        title: 'Type the correct BPM',
        onclick: () => {
          const deck = dj.engine.deck(id);
          const answer = prompt('BPM for this track', deck.grid.bpm ? deck.grid.bpm.toFixed(2) : '');
          const value = Number(answer);
          if (answer !== null && Number.isFinite(value) && value > 0) void dj.setBpm(id, value);
        },
      }),
      button('×2', { class: 'mini-btn', onclick: () => void dj.setBpm(id, dj.engine.deck(id).grid.bpm * 2) }),
      button('÷2', { class: 'mini-btn', onclick: () => void dj.setBpm(id, dj.engine.deck(id).grid.bpm / 2) }),
      button('RESET', { class: 'mini-btn', onclick: () => dj.resetGrid(id) }),
      button('LOCK', { class: 'mini-btn', onclick: () => dj.toggleGridLock(id) }),
      el('span', { class: 'section-label', text: 'PHASE' }),
      button('◀ NUDGE', { class: 'mini-btn', onclick: () => dj.nudgePhase(id, -0.02) }),
      button('NUDGE ▶', { class: 'mini-btn', onclick: () => dj.nudgePhase(id, 0.02) }),
      button('ALIGN', { class: 'mini-btn', onclick: () => dj.resetPhase(id) }),
      el('span', { class: 'section-label', text: 'KEY SHIFT' }),
      button('−1', { class: 'mini-btn', onclick: () => dj.setKeyShift(id, dj.store.deck(id).keyShift - 1) }),
      button('0', { class: 'mini-btn', onclick: () => dj.setKeyShift(id, 0) }),
      button('+1', { class: 'mini-btn', onclick: () => dj.setKeyShift(id, dj.store.deck(id).keyShift + 1) }),
    ]);

    const zoomControls = el('div', { class: 'zoom-controls' }, [
      button('−', { class: 'mini-btn', onclick: () => this.setZoom(this.scrolling.secondsVisible * 2) }),
      el('span', { class: 'section-label', text: 'ZOOM' }),
      button('+', { class: 'mini-btn', onclick: () => this.setZoom(this.scrolling.secondsVisible / 2) }),
      el('span', { class: 'spacer' }),
      button('VINYL', {
        class: 'mini-btn jog-mode-btn',
        onclick: (e: Event) => {
          const ui = dj.store.deck(id);
          const next = ui.jogMode === 'vinyl' ? 'cdj' : 'vinyl';
          dj.store.updateDeck(id, { jogMode: next });
          this.jog.setMode(next);
          (e.target as HTMLElement).textContent = next.toUpperCase();
        },
      }),
    ]);

    return el('div', { class: `deck deck-${id}`, 'data-deck': id }, [
      header,
      overviewCanvas,
      scrollCanvas,
      zoomControls,
      readouts,
      phase,
      el('div', { class: 'deck-main' }, [
        el('div', { class: 'deck-left' }, [this.jog.root, transport, toggles]),
        tempoCol,
      ]),
      el('div', { class: 'deck-pads' }, [
        el('div', { class: 'pad-section' }, [el('span', { class: 'section-label', text: 'HOT CUES' }), cueGrid]),
        el('div', { class: 'pad-section' }, [el('span', { class: 'section-label', text: 'AUTO LOOP' }), loopSizes, loopControls]),
        el('div', { class: 'pad-section' }, [el('span', { class: 'section-label', text: 'LOOP ROLL' }), rollPads]),
        el('div', { class: 'pad-section advanced-only' }, [el('span', { class: 'section-label', text: 'BEAT JUMP' }), jumpPads]),
      ]),
      gridTools,
    ]);
  }

  private toggle(label: string, get: () => boolean, set: (v: boolean) => void): HTMLButtonElement {
    const btn = button(label, {
      class: 'toggle-btn',
      onclick: () => { set(!get()); btn.classList.toggle('active', get()); },
    });
    btn.classList.toggle('active', get());
    btn.dataset.toggle = label;
    return btn;
  }

  private setZoom(seconds: number) {
    this.scrolling.secondsVisible = clamp(seconds, 1, 64);
  }

  // ------------------------------------------------------------ interaction

  private attachWaveformInteraction(detail: HTMLCanvasElement, overview: HTMLCanvasElement) {
    const dj = this.dj;
    const id = this.id;
    const deck = dj.engine.deck(id);

    detail.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dj.seek(id, this.scrolling.timeAt(e.clientX, deck.position));
    });
    detail.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.setZoom(this.scrolling.secondsVisible * (e.deltaY > 0 ? 1.25 : 0.8));
    }, { passive: false });

    overview.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !deck.hasTrack) return;
      dj.seek(id, this.overview.timeAt(e.clientX, deck.duration));
    });

    const ro = new ResizeObserver(() => { this.scrolling.resize(); this.overview.resize(); });
    ro.observe(detail);
    ro.observe(overview);
  }

  private attachDropTarget() {
    const dj = this.dj;
    const id = this.id;
    this.root.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.root.classList.add('drop-target');
    });
    this.root.addEventListener('dragleave', (e) => {
      if (e.target === this.root) this.root.classList.remove('drop-target');
    });
    this.root.addEventListener('drop', async (e) => {
      e.preventDefault();
      this.root.classList.remove('drop-target');
      const trackId = e.dataTransfer?.getData('text/track-id');
      if (trackId) { await dj.loadTrack(id, trackId); return; }
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) {
        const ids = await dj.library.importFiles(files);
        if (ids[0]) await dj.loadTrack(id, ids[0]);
      }
    });
  }

  // -------------------------------------------------------------- rendering

  /** Non-animated state - runs only when the store says something changed. */
  private renderSlow() {
    const dj = this.dj;
    const id = this.id;
    const ui = dj.store.deck(id);
    const deck = dj.engine.deck(id);
    const track = ui.trackId ? dj.store.state.tracks.get(ui.trackId) : null;

    setText(this.titleEl, track?.title ?? 'No track loaded');
    setText(this.artistEl, track?.artist ?? '--');

    for (let i = 0; i < this.cuePads.length; i++) {
      const cue = ui.hotCues.find((c) => c.index === i);
      const pad = this.cuePads[i];
      setClass(pad, 'set', !!cue);
      pad.style.setProperty('--cue-color', cue?.color ?? 'transparent');
      pad.title = cue ? `${cue.name} - ${formatTime(cue.position)}` : `Set hot cue ${i + 1}`;
    }

    for (const btn of this.root.querySelectorAll<HTMLElement>('.toggle-btn')) {
      const label = btn.dataset.toggle;
      const on =
        label === 'KEY LOCK' ? ui.keyLock :
        label === 'QUANT' ? ui.quantize :
        label === 'SLIP' ? ui.slip :
        label === 'REV' ? ui.reverse : false;
      setClass(btn, 'active', on);
    }

    const analysis = deck.analysis;
    const keyStyle = dj.store.state.settings.keyStyle;
    let keyText = analysis?.key ? formatKey(analysis.key, keyStyle) : '--';
    if (analysis?.key && ui.keyShift !== 0) keyText += ` ${ui.keyShift > 0 ? '+' : ''}${ui.keyShift}`;
    setText(this.keyEl, keyText);
    this.keyEl.classList.toggle('uncertain', !!analysis && analysis.keyConfidence < 0.3);

    // Harmonic hint against the other deck.
    const otherId = dj.engine.deckIds.find((d) => d !== id);
    if (otherId && analysis?.key) {
      const other = dj.engine.deck(otherId).analysis;
      if (other?.key) {
        const rel = keyRelation(analysis.key, other.key);
        this.keyEl.title = `${keyRelationLabel(rel)} vs deck ${otherId}`;
      } else {
        this.keyEl.title = 'Musical key';
      }
    }

    if (analysis && analysis.bpm > 0 && analysis.bpmConfidence < 0.35 && !deck.grid.locked) {
      setText(this.bpmConfidenceEl, `±${Math.max(2, Math.round(analysis.bpm * 0.03))}?`);
      this.bpmConfidenceEl.title = 'The tempo estimate is not confident. Set it by hand if the grid drifts.';
      setClass(this.bpmConfidenceEl, 'visible', true);
    } else {
      setClass(this.bpmConfidenceEl, 'visible', false);
    }

    setClass(this.statusEl, 'visible', ui.loadingState === 'loading' || ui.loadingState === 'error');
    setText(this.statusEl, ui.loadingState === 'loading' ? 'LOADING' : ui.loadingState === 'error' ? 'LOAD FAILED' : '');
    this.statusEl.title = ui.loadError ?? '';

    this.tempoFader.update();
    const rangeSelect = this.root.querySelector<HTMLSelectElement>('.tempo-range');
    if (rangeSelect) rangeSelect.value = String(ui.tempoRange);
  }

  /** Per-frame state - everything here comes from the audio engine. */
  renderFrame() {
    const dj = this.dj;
    const id = this.id;
    const deck = dj.engine.deck(id);
    const ui = dj.store.deck(id);
    const state = deck.state;

    const position = state.position;
    const duration = deck.duration;

    setText(this.timeEl, formatTime(position));
    setText(this.remainEl, formatTime(-(Math.max(0, duration - position))));

    // Effective BPM = grid tempo x the rate the engine is actually running.
    const liveRate = state.playing ? state.rate : deck.targetRate;
    const bpm = deck.grid.bpm > 0 ? deck.grid.bpm * liveRate : 0;
    setText(this.bpmEl, bpm > 0 ? bpm.toFixed(2) : '--');
    setText(this.originalBpmEl, deck.grid.bpm > 0 ? `orig ${deck.grid.bpm.toFixed(2)}` : 'orig --');
    setText(this.pitchEl, `${((liveRate - 1) * 100).toFixed(2)}%`);

    setClass(this.playBtn, 'active', state.playing);
    setText(this.playBtn, state.playing ? 'PAUSE' : 'PLAY');

    // SYNC lights only when the sync engine says it is actually locked, and
    // shows a "working on it" state while the loop converges.
    const syncStatus = dj.sync.statusFor(id);
    const engaged = dj.sync.isEnabled(id);
    setClass(this.syncBtn, 'active', engaged && syncStatus.locked);
    setClass(this.syncBtn, 'pending', engaged && !syncStatus.locked);
    setText(this.syncBtn, engaged ? (syncStatus.locked ? 'SYNCED' : 'SYNCING') : 'SYNC');
    if (ui.syncEnabled !== engaged || ui.syncLocked !== syncStatus.locked) {
      ui.syncEnabled = engaged;
      ui.syncLocked = syncStatus.locked;
    }

    const isMaster = dj.sync.resolveMaster() === id;
    setClass(this.masterBadge, 'visible', isMaster);
    setClass(this.loopBadge, 'visible', state.loopActive);
    if (state.loopActive) setText(this.loopBadge, `LOOP ${formatLoopLength(ui.loopBeats)}`);

    // Phase meter: real measured error against the master.
    const phase = dj.sync.measuredPhase(id);
    const pct = clamp(phase * 2, -1, 1);
    this.phaseBar.style.transform = `translateX(${pct * 50}%)`;
    const beatMs = deck.currentBpm > 0 ? (60 / deck.currentBpm) * 1000 : 0;
    setText(this.phaseText, deck.hasTrack && beatMs > 0 ? `${(phase * beatMs).toFixed(1)} ms` : '--');
    setClass(this.phaseText, 'locked', Math.abs(phase) < 0.004);

    this.jog.render(position);

    const style = {
      bands: dj.store.state.settings.waveformStyle === 'bands',
      phraseBeats: dj.store.state.settings.phraseBeats,
    };
    this.scrolling.draw(deck, position, ui.hotCues, {
      start: ui.loopStart, end: ui.loopEnd, enabled: state.loopActive,
    }, style);
    this.overview.draw(deck, position, ui.hotCues, style);
  }
}

function formatLoopLength(beats: number): string {
  if (beats >= 1) return `${beats}`;
  return `1/${Math.round(1 / beats)}`;
}
