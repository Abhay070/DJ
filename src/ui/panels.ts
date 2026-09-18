/**
 * Top bar, settings, debug panel, assistant console and toasts.
 */
import { el, button, clear, setText, setClass } from './dom';
import type { DjConsole } from '../state/console';
import { formatDuration } from '../state/console';
import type { AutoDj, TransitionStyle } from '../lib/autodj';
import { TRANSITION_LABELS } from '../lib/autodj';
import type { Assistant } from '../lib/assistant';
import type { Keyboard } from '../lib/keybindings';
import { ACTIONS, formatCombo } from '../lib/keybindings';
import type { MidiController } from '../lib/midi';
import { MIDI_TARGETS } from '../lib/midi';
import { sessionsDb, estimateStorage, analysisDb } from '../lib/db';
import type { DeckId } from '../lib/types';

export class TopBar {
  readonly root: HTMLElement;
  private dj: DjConsole;
  private recBtn: HTMLButtonElement;
  private recTime: HTMLElement;
  private cpuEl: HTMLElement;
  private latencyEl: HTMLElement;
  private queueEl: HTMLElement;
  private masterBpmEl: HTMLElement;

  constructor(dj: DjConsole, auto: AutoDj, onOpen: (panel: string) => void) {
    this.dj = dj;

    this.recBtn = button('● REC', {
      class: 'rec-btn',
      onclick: () => (dj.store.state.recording ? dj.stopRecording() : dj.startRecording()),
    });
    this.recTime = el('span', { class: 'rec-time', text: '' });
    this.cpuEl = el('span', { class: 'stat', text: 'CPU --' });
    this.latencyEl = el('span', { class: 'stat', text: 'Latency --' });
    this.queueEl = el('span', { class: 'stat', text: '' });
    this.masterBpmEl = el('span', { class: 'master-bpm', text: '-- BPM' });

    const modeSelect = el('select', {
      class: 'mode-select',
      title: 'How much the console does for you',
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value as 'manual' | 'assisted' | 'autodj';
        dj.store.state.mixMode = v;
        if (v === 'autodj') auto.start();
        else auto.stop();
        dj.store.notify('mode');
      },
    }, [
      el('option', { value: 'manual', text: 'MANUAL' }),
      el('option', { value: 'assisted', text: 'ASSISTED' }),
      el('option', { value: 'autodj', text: 'AUTO DJ' }),
    ]);

    const uiModeBtn = button('PERFORMANCE', {
      class: 'ui-mode-btn',
      title: 'Switch between the stripped-back performance layout and the full one',
      onclick: () => {
        const next = dj.store.state.uiMode === 'performance' ? 'advanced' : 'performance';
        dj.store.state.uiMode = next;
        document.body.dataset.uiMode = next;
        uiModeBtn.textContent = next.toUpperCase();
        dj.store.notify('mode');
      },
    });

    this.root = el('header', { class: 'topbar' }, [
      el('span', { class: 'brand', text: 'DJ CONSOLE' }),
      el('div', { class: 'master-clock' }, [
        el('span', { class: 'stat-label', text: 'MASTER' }),
        this.masterBpmEl,
      ]),
      modeSelect,
      uiModeBtn,
      el('div', { class: 'topbar-spacer' }),
      this.queueEl,
      this.cpuEl,
      this.latencyEl,
      this.recTime,
      this.recBtn,
      button('Assistant', { class: 'secondary-btn', onclick: () => onOpen('assistant') }),
      button('Session', { class: 'secondary-btn', onclick: () => onOpen('session') }),
      button('Settings', { class: 'secondary-btn', onclick: () => onOpen('settings') }),
      button('Debug', { class: 'secondary-btn', onclick: () => onOpen('debug') }),
    ]);

    dj.store.subscribe('recording', () => this.renderSlow());
    dj.store.subscribe('analysis', () => this.renderSlow());
  }

  private renderSlow() {
    const s = this.dj.store.state;
    setClass(this.recBtn, 'active', s.recording);
    setText(this.recBtn, s.recording ? '■ STOP' : '● REC');
    setText(this.queueEl, s.analysisQueue > 0 ? `Analysing ${s.analysisQueue}` : '');
    setClass(this.queueEl, 'visible', s.analysisQueue > 0);
  }

  renderFrame(cpuPercent: number) {
    const dj = this.dj;
    const bpm = dj.sync.masterBpm;
    setText(this.masterBpmEl, bpm > 0 ? `${bpm.toFixed(2)} BPM` : '-- BPM');
    setText(this.cpuEl, `CPU ${cpuPercent.toFixed(0)}%`);
    setClass(this.cpuEl, 'hot', cpuPercent > 80);
    setText(this.latencyEl, `Latency ${(dj.engine.latency * 1000).toFixed(1)} ms`);
    if (dj.store.state.recording) {
      const r = dj.engine.recorder;
      setText(this.recTime, `${formatDuration(r.duration)} · ${(r.byteLength / 1048576).toFixed(1)} MB`);
    } else {
      setText(this.recTime, '');
    }
  }
}

// --------------------------------------------------------------- modal shell

export class Modal {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private titleEl: HTMLElement;

  constructor() {
    this.titleEl = el('h2', { class: 'modal-title' });
    this.body = el('div', { class: 'modal-body' });
    const close = button('✕', { class: 'modal-close', onclick: () => this.hide() });
    this.root = el('div', { class: 'modal-backdrop hidden', onclick: (e: Event) => {
      if (e.target === this.root) this.hide();
    } }, [
      el('div', { class: 'modal' }, [
        el('div', { class: 'modal-head' }, [this.titleEl, close]),
        this.body,
      ]),
    ]);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.root.classList.contains('hidden')) {
        e.stopPropagation();
        this.hide();
      }
    }, true);
  }

  show(title: string, content: Node) {
    this.titleEl.textContent = title;
    clear(this.body);
    this.body.append(content);
    this.root.classList.remove('hidden');
  }

  hide() { this.root.classList.add('hidden'); }
}

// ------------------------------------------------------------------ settings

export function buildSettings(dj: DjConsole, keyboard: Keyboard, midi: MidiController): HTMLElement {
  const s = dj.store.state.settings;

  const section = (title: string, ...rows: (Node | null)[]) =>
    el('section', { class: 'settings-section' }, [el('h3', { text: title }), ...rows.filter(Boolean)]);

  const row = (label: string, control: Node, hint?: string) =>
    el('div', { class: 'settings-row' }, [
      el('label', { class: 'settings-label' }, [label, hint ? el('small', { text: hint }) : null]),
      control,
    ]);

  const select = (value: string, options: [string, string][], onChange: (v: string) => void) => {
    const node = el('select', { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
      options.map(([v, t]) => el('option', { value: v, text: t })));
    node.value = value;
    return node;
  };

  const check = (value: boolean, onChange: (v: boolean) => void) =>
    el('input', { type: 'checkbox', checked: value, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) });

  const number = (value: number, min: number, max: number, step: number, onChange: (v: number) => void) =>
    el('input', { type: 'number', value, min, max, step, onchange: (e: Event) => onChange(Number((e.target as HTMLInputElement).value)) });

  const save = () => void dj.saveSettings();

  // ---- audio ---------------------------------------------------------------
  const audioInfo = el('p', { class: 'hint' }, [
    `Engine ${dj.engine.running ? 'running' : 'stopped'} · ${dj.engine.sampleRate} Hz · ` +
    `${(dj.engine.latency * 1000).toFixed(1)} ms round trip`,
  ]);

  const deviceNote = el('p', { class: 'hint' }, [
    'The browser sends audio to the system default output. Separate master and ' +
    'headphone devices need the OS-level output picker, or a browser that exposes ' +
    'setSinkId for AudioContext - the cue bus is folded into the main output here, ' +
    'controlled by the CUE MIX knob.',
  ]);

  const audio = section('Audio',
    audioInfo,
    row('Latency profile', select(s.latencyHint, [
      ['interactive', 'Interactive (lowest latency)'],
      ['balanced', 'Balanced'],
      ['playback', 'Playback (most stable)'],
    ], (v) => {
      s.latencyHint = v as AudioContextLatencyCategory;
      save();
      dj.store.toast('Latency profile saved', 'info', { detail: 'It takes effect the next time the page loads.' });
    })),
    row('Master limiter', check(s.limiterEnabled, (v) => { s.limiterEnabled = v; dj.engine.setLimiterEnabled(v); save(); })),
    deviceNote,
    row('Microphone', button(dj.store.state.micEnabled ? 'Disable' : 'Enable', {
      class: 'secondary-btn',
      onclick: async (e: Event) => {
        const btn = e.target as HTMLButtonElement;
        if (dj.store.state.micEnabled) {
          dj.engine.disableMic();
          dj.store.state.micEnabled = false;
          btn.textContent = 'Enable';
        } else {
          try {
            await dj.engine.enableMic();
            dj.engine.setMicGain(0.6);
            dj.store.state.micEnabled = true;
            btn.textContent = 'Disable';
            dj.store.toast('Microphone live', 'success', {
              detail: 'Echo cancellation is on to stop the speakers feeding back.',
            });
          } catch (err) {
            dj.store.toast('Could not open the microphone', 'error', {
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        }
      },
    })),
  );

  // ---- DJ ------------------------------------------------------------------
  const dj2 = section('DJ',
    row('Key notation', select(s.keyStyle, [
      ['camelot', 'Camelot (8A)'], ['musical', 'Musical (A Minor)'], ['both', 'Both'],
    ], (v) => { s.keyStyle = v as typeof s.keyStyle; save(); dj.store.notify('deck', 'library'); })),
    row('Default tempo range', select(String(s.tempoRange), [['6', '±6%'], ['8', '±8%'], ['10', '±10%'], ['16', '±16%'], ['50', '±50%'], ['100', '±100%']],
      (v) => { s.tempoRange = Number(v); save(); })),
    row('Quantize division', select(String(s.quantizeDivision), [['0.25', '1/4 beat'], ['0.5', '1/2 beat'], ['1', '1 beat'], ['4', '1 bar']],
      (v) => { s.quantizeDivision = Number(v); for (const id of dj.engine.deckIds) dj.setQuantizeDivision(id, Number(v)); save(); })),
    row('Key lock by default', check(s.keyLockDefault, (v) => { s.keyLockDefault = v; save(); })),
    row('Automatic gain', check(s.autoGainEnabled, (v) => { s.autoGainEnabled = v; save(); }),
      'Levels every track to the same loudness on load'),
    row('Target loudness', number(s.targetLoudness, -24, -6, 0.5, (v) => { s.targetLoudness = v; save(); }), 'LUFS'),
    row('Phrase length', select(String(s.phraseBeats), [['16', '4 bars'], ['32', '8 bars'], ['64', '16 bars'], ['128', '32 bars']],
      (v) => { s.phraseBeats = Number(v); save(); })),
  );

  // ---- appearance ----------------------------------------------------------
  const appearance = section('Appearance',
    row('Waveform', select(s.waveformStyle, [['bands', 'Frequency coloured'], ['mono', 'Single colour']],
      (v) => { s.waveformStyle = v as typeof s.waveformStyle; save(); })),
  );

  // ---- shortcuts -----------------------------------------------------------
  const shortcutRows = el('div', { class: 'shortcut-list' });
  const renderShortcuts = () => {
    clear(shortcutRows);
    let group = '';
    for (const action of ACTIONS) {
      if (action.group !== group) {
        group = action.group;
        shortcutRows.append(el('h4', { text: group }));
      }
      const combo = keyboard.comboFor(action.id);
      const btn = button(combo ? formatCombo(combo) : 'unassigned', {
        class: `shortcut-key ${combo ? '' : 'unset'}`,
        onclick: () => {
          btn.textContent = 'press a key…';
          btn.classList.add('learning');
          keyboard.startLearning(action.id);
        },
      });
      shortcutRows.append(el('div', { class: 'settings-row' }, [
        el('span', { class: 'settings-label', text: action.label }), btn,
      ]));
    }
  };
  keyboard.onLearn = () => renderShortcuts();
  renderShortcuts();

  const shortcuts = section('Keyboard',
    el('p', { class: 'hint', text: 'Click a shortcut, then press the key you want. Deck actions apply to the focused deck (A / B).' }),
    shortcutRows,
    button('Restore defaults', { class: 'secondary-btn', onclick: async () => { await keyboard.reset(); renderShortcuts(); } }),
  );

  // ---- MIDI ----------------------------------------------------------------
  const midiBody = el('div', { class: 'midi-body' });
  const renderMidi = () => {
    clear(midiBody);
    if (!midi.supported) {
      midiBody.append(el('p', { class: 'hint', text: 'This browser does not implement Web MIDI. Chrome or Edge do.' }));
      return;
    }
    midiBody.append(el('p', { class: 'hint' }, [
      midi.devices.length
        ? `Connected: ${midi.devices.map((d) => d.name).join(', ')}`
        : 'No MIDI devices detected. Plug a controller in and press Connect.',
    ]));
    for (const target of MIDI_TARGETS) {
      const decks: (DeckId | null)[] = target.perDeck ? (dj.engine.deckIds as DeckId[]) : [null];
      for (const deck of decks) {
        const key = midi.keyFor(target.id, deck);
        const btn = button(key ? key.split(':').slice(1).join('/') : 'learn', {
          class: `shortcut-key ${key ? '' : 'unset'}`,
          onclick: () => {
            btn.textContent = 'move a control…';
            btn.classList.add('learning');
            midi.startLearning(target.id, deck);
          },
        });
        midiBody.append(el('div', { class: 'settings-row' }, [
          el('span', { class: 'settings-label', text: deck ? `${target.label} (deck ${deck})` : target.label }),
          btn,
        ]));
      }
    }
  };
  midi.onLearn = () => renderMidi();
  midi.onDevicesChanged = () => renderMidi();

  const midiSection = section('MIDI',
    button('Connect MIDI', {
      class: 'primary-btn',
      onclick: async () => { if (await midi.connect()) renderMidi(); },
    }),
    midiBody,
    button('Clear all mappings', { class: 'secondary-btn', onclick: async () => { await midi.reset(); renderMidi(); } }),
  );

  // ---- library -------------------------------------------------------------
  const storageEl = el('p', { class: 'hint', text: 'Checking local storage…' });
  void estimateStorage().then((est) => {
    if (!est) { storageEl.textContent = 'Storage usage is not reported by this browser.'; return; }
    storageEl.textContent =
      `Local storage: ${(est.usage / 1048576).toFixed(0)} MB used of ${(est.quota / 1073741824).toFixed(1)} GB available.`;
  });

  const library = section('Library',
    storageEl,
    el('p', { class: 'hint', text: 'Audio and analysis live in this browser\'s IndexedDB. Nothing is uploaded.' }),
    button('Clear analysis cache', {
      class: 'secondary-btn',
      onclick: async () => {
        if (!confirm('Clear cached analysis for every track? They will be re-analysed on next load.')) return;
        await analysisDb.clear();
        for (const t of dj.store.state.tracks.values()) { t.analysis = null; t.analysisState = 'pending'; }
        dj.store.notify('library');
        dj.store.toast('Analysis cache cleared', 'info');
      },
    }),
  );

  // ---- features ------------------------------------------------------------
  const features = section('Features',
    el('p', { class: 'hint', text: 'Turn subsystems off to simplify the interface or isolate a problem.' }),
    ...Object.keys(s.features).map((key) =>
      row(key, check(s.features[key], (v) => {
        s.features[key] = v;
        save();
        document.body.dataset[`feature${key[0].toUpperCase()}${key.slice(1)}`] = String(v);
      }))),
  );

  return el('div', { class: 'settings' }, [audio, dj2, appearance, shortcuts, midiSection, library, features]);
}

// -------------------------------------------------------------------- debug

export class DebugPanel {
  readonly root: HTMLElement;
  private pre: HTMLElement;
  private dj: DjConsole;

  constructor(dj: DjConsole) {
    this.dj = dj;
    this.pre = el('pre', { class: 'debug-pre' });
    this.root = el('div', { class: 'debug-panel hidden' }, [
      el('div', { class: 'debug-head' }, [
        el('span', { text: 'ENGINE STATE' }),
        button('✕', { class: 'modal-close', onclick: () => this.hide() }),
      ]),
      this.pre,
    ]);
  }

  show() { this.root.classList.remove('hidden'); }
  hide() { this.root.classList.add('hidden'); }
  toggle() { this.root.classList.toggle('hidden'); }
  get visible() { return !this.root.classList.contains('hidden'); }

  renderFrame(cpu: number, frameMs: number) {
    if (!this.visible) return;
    const dj = this.dj;
    const lines: string[] = [];

    lines.push(`AudioContext   ${dj.engine.ctx.state}  ${dj.engine.sampleRate} Hz`);
    lines.push(`Clock          ${dj.engine.ctx.currentTime.toFixed(3)} s`);
    lines.push(`Base latency   ${((dj.engine.ctx.baseLatency ?? 0) * 1000).toFixed(2)} ms`);
    lines.push(`Output latency ${((dj.engine.ctx.outputLatency ?? 0) * 1000).toFixed(2)} ms`);
    lines.push(`Frame time     ${frameMs.toFixed(2)} ms   CPU ~${cpu.toFixed(0)}%`);
    lines.push(`Position feed  ${self.crossOriginIsolated ? 'SharedArrayBuffer' : 'postMessage fallback'}`);
    lines.push('');

    const masterId = dj.sync.resolveMaster();
    lines.push(`Master deck    ${masterId ?? 'none'}   ${dj.sync.masterBpm.toFixed(3)} BPM`);
    lines.push(`Beat length    ${(dj.sync.masterBeatSeconds * 1000).toFixed(2)} ms`);
    lines.push('');

    for (const id of dj.engine.deckIds) {
      const deck = dj.engine.deck(id);
      const st = deck.state;
      const sync = dj.sync.statusFor(id);
      lines.push(`── DECK ${id} ──────────────────────────────`);
      lines.push(`  track        ${deck.trackId ?? '(empty)'}`);
      lines.push(`  playing      ${st.playing}    ended-safe`);
      lines.push(`  position     ${st.position.toFixed(6)} s / ${deck.duration.toFixed(3)} s`);
      lines.push(`  actual rate  ${st.rate.toFixed(6)}   target ${deck.targetRate.toFixed(6)}`);
      lines.push(`  base/trim/bend ${deck.baseRate.toFixed(5)} / ${deck.syncTrim.toFixed(6)} / ${deck.bendFactor.toFixed(3)}`);
      lines.push(`  grid bpm     ${deck.grid.bpm.toFixed(3)}  first ${deck.grid.firstBeat.toFixed(4)} s  dbOffset ${deck.grid.downbeatOffset}  ${deck.grid.locked ? '[locked]' : ''}`);
      lines.push(`  beat pos     ${deck.beatPosition.toFixed(4)}   effective ${deck.currentBpm.toFixed(3)} BPM`);
      lines.push(`  sync         ${sync.enabled ? (sync.locked ? 'LOCKED' : 'converging') : 'off'}  err ${sync.phaseError.toFixed(5)} beats (${sync.phaseMs.toFixed(2)} ms)`);
      lines.push(`  loop         ${st.loopActive ? 'active' : 'off'}  ${dj.store.deck(id).loopStart.toFixed(3)} → ${dj.store.deck(id).loopEnd.toFixed(3)}`);
      lines.push(`  slip         ${st.slipPosition >= 0 ? st.slipPosition.toFixed(4) + ' s' : 'off'}`);
      lines.push(`  keylock      ${deck.keyLock}   shift ${deck.keyShift} st   scratch ${deck.scratching}`);
      const m = dj.engine.channelMeters.get(id);
      if (m) lines.push(`  meter        peak ${m.peakL.toFixed(3)}/${m.peakR.toFixed(3)}  rms ${m.rms.toFixed(4)}${m.clipped ? '  CLIP' : ''}`);
    }

    lines.push('');
    lines.push('── FX ─────────────────────────────────────');
    dj.store.state.fx.forEach((f, i) => {
      lines.push(`  ${i}: ${f.id.padEnd(11)} ${f.enabled ? 'ON ' : 'off'}  a=${f.a.toFixed(2)} b=${f.b.toFixed(2)} wet=${f.wet.toFixed(2)}`);
    });
    const mm = dj.engine.masterMeter;
    lines.push('');
    lines.push(`Master meter   L ${mm.peakL.toFixed(4)}  R ${mm.peakR.toFixed(4)}  rms ${mm.rms.toFixed(4)}${mm.clipped ? '  CLIPPING' : ''}`);
    lines.push(`Recording      ${dj.store.state.recording ? `${dj.engine.recorder.duration.toFixed(1)} s` : 'off'}`);

    this.pre.textContent = lines.join('\n');
  }
}

// ---------------------------------------------------------------- assistant

export function buildAssistant(dj: DjConsole, assistant: Assistant, auto: AutoDj): HTMLElement {
  const log = el('div', { class: 'assistant-log' });
  const input = el('input', {
    class: 'assistant-input',
    type: 'text',
    placeholder: 'Sync deck B · loop 8 beats · echo out · bass down on A · transition after the next phrase',
  });

  const submit = () => {
    const text = input.value;
    if (!text.trim()) return;
    input.value = '';
    log.append(el('div', { class: 'assistant-line user', text: `> ${text}` }));
    const reply = assistant.run(text);
    const block = el('div', { class: `assistant-line ${reply.ok ? 'ok' : 'fail'}` },
      reply.lines.map((l) => el('div', { text: l })));
    log.append(block);
    log.scrollTop = log.scrollHeight;
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // do not let deck shortcuts fire while typing
    if (e.key === 'Enter') submit();
  });

  const transitionStyles: TransitionStyle[] = ['crossfade', 'eq', 'filter', 'echo-out', 'drop', 'long-blend', 'quick-cut'];
  const styleSelect = el('select', {
    class: 'transition-style',
    onchange: (e: Event) => { auto.style = (e.target as HTMLSelectElement).value as TransitionStyle; },
  }, transitionStyles.map((sType) => el('option', { value: sType, text: TRANSITION_LABELS[sType] })));
  styleSelect.value = auto.style;

  const suggestions = el('div', { class: 'assistant-suggestions' });
  const refreshSuggestions = () => {
    clear(suggestions);
    const from = dj.engine.deckIds.find((id) => dj.engine.deck(id).playing)
      ?? dj.engine.deckIds.find((id) => dj.engine.deck(id).hasTrack);
    if (!from) {
      suggestions.append(el('p', { class: 'hint', text: 'Load a track to see suggestions.' }));
      return;
    }
    const list = auto.suggest(from, 5);
    if (!list.length) {
      suggestions.append(el('p', { class: 'hint', text: 'No analysed tracks available to suggest yet.' }));
      return;
    }
    suggestions.append(el('span', { class: 'section-label', text: `Next after deck ${from}` }));
    for (const c of list) {
      suggestions.append(el('div', { class: 'suggestion' }, [
        el('span', { class: 'suggestion-title', text: `${c.track.artist} - ${c.track.title}` }),
        el('span', { class: 'suggestion-why', text: c.reasons.join(' · ') }),
        button('Load', {
          class: 'mini-btn',
          onclick: () => {
            const to = dj.engine.deckIds.find((id) => id !== from)!;
            void dj.loadTrack(to, c.track.id);
          },
        }),
      ]));
    }
  };

  return el('div', { class: 'assistant' }, [
    el('p', { class: 'hint' }, [
      'Commands run real console actions and report what the engine actually did. ' +
      'Everything is local and rule-based - no network calls.',
    ]),
    log,
    el('div', { class: 'assistant-row' }, [input, button('Run', { class: 'primary-btn', onclick: submit })]),
    el('div', { class: 'assistant-row' }, [
      el('span', { class: 'settings-label', text: 'Transition style' }),
      styleSelect,
      button('Refresh suggestions', { class: 'secondary-btn', onclick: refreshSuggestions }),
    ]),
    suggestions,
  ]);
}

// ------------------------------------------------------------------ session

export function buildSession(dj: DjConsole): HTMLElement {
  const list = el('div', { class: 'session-list' });

  const refresh = async () => {
    clear(list);
    const sessions = await sessionsDb.all();
    sessions.sort((a, b) => b.savedAt - a.savedAt);
    if (!sessions.length) {
      list.append(el('p', { class: 'hint', text: 'No saved sessions yet.' }));
      return;
    }
    for (const session of sessions) {
      list.append(el('div', { class: 'settings-row' }, [
        el('span', { class: 'settings-label' }, [
          session.name,
          el('small', { text: new Date(session.savedAt).toLocaleString() }),
        ]),
        button('Load', { class: 'primary-btn', onclick: () => void dj.loadSession(session.id) }),
        button('Delete', {
          class: 'secondary-btn',
          onclick: async () => { await sessionsDb.delete(session.id); await refresh(); },
        }),
      ]));
    }
  };

  const nameInput = el('input', { class: 'session-name', type: 'text', value: dj.store.state.sessionName });
  nameInput.addEventListener('keydown', (e) => e.stopPropagation());

  void refresh();

  return el('div', { class: 'session-panel' }, [
    el('p', { class: 'hint' }, [
      'A session stores the loaded tracks, playhead positions, beat grids, cues, loops, ' +
      'FX and the whole mixer, so you can pick a set back up exactly where you left it.',
    ]),
    el('div', { class: 'assistant-row' }, [
      nameInput,
      button('Save session', {
        class: 'primary-btn',
        onclick: async () => { await dj.saveSession(nameInput.value || 'Untitled session'); await refresh(); },
      }),
    ]),
    list,
    el('h3', { text: 'Emergency' }),
    el('div', { class: 'assistant-row' }, [
      button('Master stop', { class: 'panic-btn', onclick: () => dj.panic() }),
      button('Reset mixer', { class: 'secondary-btn', onclick: () => dj.resetMixer() }),
      button('Reset FX', { class: 'secondary-btn', onclick: () => dj.resetFx() }),
      button('Reset sync', { class: 'secondary-btn', onclick: () => dj.resetSync() }),
      ...dj.engine.deckIds.map((id) => button(`Reset deck ${id}`, {
        class: 'secondary-btn', onclick: () => dj.resetDeck(id),
      })),
    ]),
  ]);
}

// ------------------------------------------------------------------- toasts

export class Toasts {
  readonly root: HTMLElement;

  constructor(dj: DjConsole) {
    this.root = el('div', { class: 'toasts' });
    dj.store.subscribe('toast', () => {
      clear(this.root);
      for (const toast of dj.store.state.toasts) {
        this.root.append(el('div', { class: `toast toast-${toast.kind}` }, [
          el('span', { class: 'toast-message', text: toast.message }),
          toast.detail ? el('span', { class: 'toast-detail', text: toast.detail }) : null,
          toast.actions?.length
            ? el('div', { class: 'toast-actions' }, toast.actions.map((a) => button(a.label, {
                class: 'mini-btn',
                onclick: () => { a.run(); dj.store.dismissToast(toast.id); },
              })))
            : null,
          button('✕', { class: 'toast-close', onclick: () => dj.store.dismissToast(toast.id) }),
        ]));
      }
    });
  }
}
