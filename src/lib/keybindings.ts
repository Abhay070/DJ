/**
 * Keyboard shortcuts. Every binding is data, stored locally and remappable -
 * nothing is hard-coded into an event handler.
 */
import type { DjConsole } from '../state/console';
import { settingsDb } from './db';
import type { DeckId } from './types';

export interface Action {
  id: string;
  label: string;
  group: string;
  /** Deck-scoped actions receive the focused deck. */
  perDeck: boolean;
  run: (dj: DjConsole, deck: DeckId) => void;
  /** Called on keyup for momentary actions. */
  release?: (dj: DjConsole, deck: DeckId) => void;
}

export const ACTIONS: Action[] = [
  { id: 'play', label: 'Play / pause', group: 'Transport', perDeck: true, run: (d, k) => d.togglePlay(k) },
  { id: 'cue', label: 'Cue', group: 'Transport', perDeck: true, run: (d, k) => (d.engine.deck(k).playing ? d.pressCue(k) : d.cuePlayStart(k)), release: (d, k) => { if (d.engine.deck(k).playing) d.cuePlayEnd(k); } },
  { id: 'sync', label: 'Sync', group: 'Transport', perDeck: true, run: (d, k) => d.toggleSync(k) },
  { id: 'keylock', label: 'Key lock', group: 'Transport', perDeck: true, run: (d, k) => d.setKeyLock(k, !d.store.deck(k).keyLock) },
  { id: 'quantize', label: 'Quantize', group: 'Transport', perDeck: true, run: (d, k) => d.setQuantize(k, !d.store.deck(k).quantize) },
  { id: 'slip', label: 'Slip mode', group: 'Transport', perDeck: true, run: (d, k) => d.setSlip(k, !d.store.deck(k).slip) },
  { id: 'reverse', label: 'Reverse', group: 'Transport', perDeck: true, run: (d, k) => d.setReverse(k, true), release: (d, k) => d.setReverse(k, false) },
  { id: 'start', label: 'Jump to start', group: 'Transport', perDeck: true, run: (d, k) => d.seekToStart(k) },

  { id: 'loop', label: 'Loop on/off', group: 'Loops', perDeck: true, run: (d, k) => d.toggleLoop(k) },
  { id: 'loop-half', label: 'Halve the loop', group: 'Loops', perDeck: true, run: (d, k) => d.halveLoop(k) },
  { id: 'loop-double', label: 'Double the loop', group: 'Loops', perDeck: true, run: (d, k) => d.doubleLoop(k) },
  { id: 'loop4', label: '4 beat loop', group: 'Loops', perDeck: true, run: (d, k) => d.setLoopBeats(k, 4) },
  { id: 'loop8', label: '8 beat loop', group: 'Loops', perDeck: true, run: (d, k) => d.setLoopBeats(k, 8) },

  { id: 'nudge-back', label: 'Nudge back', group: 'Beatmatch', perDeck: true, run: (d, k) => d.bend(k, -0.04), release: (d, k) => d.endBend(k) },
  { id: 'nudge-fwd', label: 'Nudge forward', group: 'Beatmatch', perDeck: true, run: (d, k) => d.bend(k, 0.04), release: (d, k) => d.endBend(k) },
  { id: 'pitch-up', label: 'Pitch up', group: 'Beatmatch', perDeck: true, run: (d, k) => d.setPitchPercent(k, d.store.deck(k).pitchPercent + 0.1) },
  { id: 'pitch-down', label: 'Pitch down', group: 'Beatmatch', perDeck: true, run: (d, k) => d.setPitchPercent(k, d.store.deck(k).pitchPercent - 0.1) },
  { id: 'pitch-reset', label: 'Reset pitch', group: 'Beatmatch', perDeck: true, run: (d, k) => d.resetPitch(k) },

  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
    id: `hotcue${n}`, label: `Hot cue ${n}`, group: 'Hot cues', perDeck: true,
    run: (d: DjConsole, k: DeckId) => void d.setHotCue(k, n - 1),
  })),

  { id: 'jump-back', label: 'Beat jump back 4', group: 'Navigation', perDeck: true, run: (d, k) => d.beatJump(k, -4) },
  { id: 'jump-fwd', label: 'Beat jump forward 4', group: 'Navigation', perDeck: true, run: (d, k) => d.beatJump(k, 4) },
  { id: 'pfl', label: 'Headphone cue', group: 'Mixer', perDeck: true, run: (d, k) => d.togglePfl(k) },

  { id: 'focus-a', label: 'Focus deck A', group: 'Global', perDeck: false, run: () => {} },
  { id: 'focus-b', label: 'Focus deck B', group: 'Global', perDeck: false, run: () => {} },
  { id: 'xf-left', label: 'Crossfader to A', group: 'Mixer', perDeck: false, run: (d) => d.setCrossfader(-1) },
  { id: 'xf-centre', label: 'Crossfader centre', group: 'Mixer', perDeck: false, run: (d) => d.setCrossfader(0) },
  { id: 'xf-right', label: 'Crossfader to B', group: 'Mixer', perDeck: false, run: (d) => d.setCrossfader(1) },
  { id: 'record', label: 'Start / stop recording', group: 'Global', perDeck: false, run: (d) => (d.store.state.recording ? d.stopRecording() : d.startRecording()) },
  { id: 'panic', label: 'Panic - stop everything', group: 'Global', perDeck: false, run: (d) => d.panic() },
  { id: 'fx-off', label: 'All FX off', group: 'Global', perDeck: false, run: (d) => d.resetFx() },
];

export type Bindings = Record<string, string>;

/** Default map: key combination -> action id. */
export const DEFAULT_BINDINGS: Bindings = {
  Space: 'play',
  KeyC: 'cue',
  KeyS: 'sync',
  KeyK: 'keylock',
  KeyQ: 'quantize',
  KeyX: 'slip',
  KeyV: 'reverse',
  Home: 'start',
  KeyL: 'loop',
  BracketLeft: 'loop-half',
  BracketRight: 'loop-double',
  Digit9: 'loop4',
  Digit0: 'loop8',
  ArrowLeft: 'nudge-back',
  ArrowRight: 'nudge-fwd',
  ArrowUp: 'pitch-up',
  ArrowDown: 'pitch-down',
  'shift+ArrowUp': 'pitch-reset',
  Digit1: 'hotcue1',
  Digit2: 'hotcue2',
  Digit3: 'hotcue3',
  Digit4: 'hotcue4',
  Digit5: 'hotcue5',
  Digit6: 'hotcue6',
  Digit7: 'hotcue7',
  Digit8: 'hotcue8',
  Comma: 'jump-back',
  Period: 'jump-fwd',
  KeyH: 'pfl',
  KeyA: 'focus-a',
  KeyB: 'focus-b',
  'shift+KeyA': 'xf-left',
  'shift+KeyM': 'xf-centre',
  'shift+KeyB': 'xf-right',
  KeyR: 'record',
  Escape: 'panic',
  KeyF: 'fx-off',
};

export class Keyboard {
  private dj: DjConsole;
  bindings: Bindings = { ...DEFAULT_BINDINGS };
  focusedDeck: DeckId = 'A';
  /** When set, the next keypress is captured for remapping instead of run. */
  learning: string | null = null;
  onLearn: ((combo: string, actionId: string) => void) | null = null;
  onFocusChange: ((deck: DeckId) => void) | null = null;

  private held = new Set<string>();

  constructor(dj: DjConsole) {
    this.dj = dj;
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
  }

  async load() {
    const saved = await settingsDb.get<Bindings>('keybindings');
    if (saved) this.bindings = { ...DEFAULT_BINDINGS, ...saved };
  }

  async save() {
    await settingsDb.put('keybindings', this.bindings);
  }

  static combo(e: KeyboardEvent): string {
    const parts: string[] = [];
    if (e.ctrlKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    parts.push(e.code);
    return parts.join('+');
  }

  private isTypingTarget(target: EventTarget | null): boolean {
    const node = target as HTMLElement | null;
    if (!node) return false;
    return node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT' || node.isContentEditable;
  }

  private onKeyDown(e: KeyboardEvent) {
    if (this.isTypingTarget(e.target)) return;

    const combo = Keyboard.combo(e);

    if (this.learning) {
      e.preventDefault();
      const actionId = this.learning;
      this.learning = null;
      // Free the combination from whatever held it before.
      for (const [k, v] of Object.entries(this.bindings)) if (v === actionId) delete this.bindings[k];
      this.bindings[combo] = actionId;
      void this.save();
      this.onLearn?.(combo, actionId);
      return;
    }

    const actionId = this.bindings[combo];
    if (!actionId) return;
    e.preventDefault();

    if (actionId === 'focus-a' || actionId === 'focus-b') {
      this.focusedDeck = actionId === 'focus-a' ? 'A' : 'B';
      this.onFocusChange?.(this.focusedDeck);
      return;
    }

    // Auto-repeat would re-fire momentary actions every few milliseconds.
    if (this.held.has(combo)) return;
    this.held.add(combo);

    const action = ACTIONS.find((a) => a.id === actionId);
    action?.run(this.dj, this.focusedDeck);
  }

  private onKeyUp(e: KeyboardEvent) {
    const combo = Keyboard.combo(e);
    // The modifier may have been released first, so clear any held variant.
    for (const held of [...this.held]) {
      if (held === combo || held.endsWith(e.code)) {
        this.held.delete(held);
        const action = ACTIONS.find((a) => a.id === this.bindings[held]);
        action?.release?.(this.dj, this.focusedDeck);
      }
    }
  }

  startLearning(actionId: string) { this.learning = actionId; }
  cancelLearning() { this.learning = null; }

  comboFor(actionId: string): string | null {
    const entry = Object.entries(this.bindings).find(([, v]) => v === actionId);
    return entry ? entry[0] : null;
  }

  async reset() {
    this.bindings = { ...DEFAULT_BINDINGS };
    await this.save();
  }
}

/** Human-readable form of a key combination. */
export function formatCombo(combo: string): string {
  return combo
    .split('+')
    .map((p) => {
      if (p === 'ctrl') return 'Ctrl';
      if (p === 'alt') return 'Alt';
      if (p === 'shift') return 'Shift';
      return p.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '');
    })
    .join(' + ');
}
