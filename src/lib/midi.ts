/**
 * Web MIDI support with a learn mode.
 *
 * Mappings are stored as "device:status:data1" -> target, so the same physical
 * control keeps its assignment across sessions and across controllers plugged
 * into different ports.
 */
import type { DjConsole } from '../state/console';
import { settingsDb } from './db';
import type { DeckId } from './types';

export type MidiTargetKind = 'button' | 'knob' | 'fader' | 'jog';

export interface MidiTarget {
  id: string;
  label: string;
  kind: MidiTargetKind;
  perDeck: boolean;
  /** Continuous controls receive 0..1; buttons receive 1 on press, 0 on release. */
  apply: (dj: DjConsole, deck: DeckId, value: number) => void;
}

export const MIDI_TARGETS: MidiTarget[] = [
  { id: 'play', label: 'Play / pause', kind: 'button', perDeck: true, apply: (d, k, v) => { if (v > 0.5) d.togglePlay(k); } },
  { id: 'cue', label: 'Cue', kind: 'button', perDeck: true, apply: (d, k, v) => (v > 0.5 ? d.cuePlayStart(k) : d.cuePlayEnd(k)) },
  { id: 'sync', label: 'Sync', kind: 'button', perDeck: true, apply: (d, k, v) => { if (v > 0.5) d.toggleSync(k); } },
  { id: 'loop', label: 'Loop on/off', kind: 'button', perDeck: true, apply: (d, k, v) => { if (v > 0.5) d.toggleLoop(k); } },
  { id: 'pfl', label: 'Headphone cue', kind: 'button', perDeck: true, apply: (d, k, v) => { if (v > 0.5) d.togglePfl(k); } },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
    id: `hotcue${n}`, label: `Hot cue ${n}`, kind: 'button' as const, perDeck: true,
    apply: (d: DjConsole, k: DeckId, v: number) => { if (v > 0.5) void d.setHotCue(k, n - 1); },
  })),
  { id: 'tempo', label: 'Tempo fader', kind: 'fader', perDeck: true, apply: (d, k, v) => d.setPitchPercent(k, (v * 2 - 1) * d.store.deck(k).tempoRange) },
  { id: 'volume', label: 'Channel fader', kind: 'fader', perDeck: true, apply: (d, k, v) => d.setFader(k, v) },
  { id: 'trim', label: 'Trim', kind: 'knob', perDeck: true, apply: (d, k, v) => d.setTrim(k, (v * 2 - 1) * 12) },
  { id: 'eq-high', label: 'EQ high', kind: 'knob', perDeck: true, apply: (d, k, v) => d.setEq(k, 'high', v <= 0.01 ? -26 : (v * 2 - 1) * 12) },
  { id: 'eq-mid', label: 'EQ mid', kind: 'knob', perDeck: true, apply: (d, k, v) => d.setEq(k, 'mid', v <= 0.01 ? -26 : (v * 2 - 1) * 12) },
  { id: 'eq-low', label: 'EQ low', kind: 'knob', perDeck: true, apply: (d, k, v) => d.setEq(k, 'low', v <= 0.01 ? -26 : (v * 2 - 1) * 12) },
  { id: 'filter', label: 'Filter', kind: 'knob', perDeck: true, apply: (d, k, v) => d.setFilter(k, v * 2 - 1) },
  { id: 'jog', label: 'Jog wheel', kind: 'jog', perDeck: true, apply: (d, k, v) => {
    // Relative encoders send values around the centre; map that to a bend.
    const delta = (v - 0.5) * 2;
    d.bend(k, Math.max(-0.4, Math.min(0.4, delta * 0.3)));
  } },
  { id: 'crossfader', label: 'Crossfader', kind: 'fader', perDeck: false, apply: (d, _k, v) => d.setCrossfader(v * 2 - 1) },
  { id: 'master', label: 'Master volume', kind: 'knob', perDeck: false, apply: (d, _k, v) => d.setMasterVolume(v * 1.2) },
  { id: 'cue-volume', label: 'Headphone volume', kind: 'knob', perDeck: false, apply: (d, _k, v) => d.setCueVolume(v) },
  { id: 'fx-wet', label: 'FX 1 dry/wet', kind: 'knob', perDeck: false, apply: (d, _k, v) => d.setFxParam(0, { wet: v }) },
  { id: 'fx-on', label: 'FX 1 on/off', kind: 'button', perDeck: false, apply: (d, _k, v) => d.setFxEnabled(0, v > 0.5) },
];

export interface MidiMapping {
  targetId: string;
  deck: DeckId | null;
  /** Relative encoders report deltas around 64 rather than absolute values. */
  relative?: boolean;
}

export type MidiMappings = Record<string, MidiMapping>;

export interface MidiDevice { id: string; name: string; connected: boolean }

export class MidiController {
  private dj: DjConsole;
  private access: MIDIAccess | null = null;
  mappings: MidiMappings = {};
  devices: MidiDevice[] = [];
  learning: { targetId: string; deck: DeckId | null } | null = null;

  onLearn: ((key: string, mapping: MidiMapping) => void) | null = null;
  onDevicesChanged: (() => void) | null = null;
  onActivity: ((key: string, value: number) => void) | null = null;

  constructor(dj: DjConsole) {
    this.dj = dj;
  }

  get supported(): boolean { return typeof navigator.requestMIDIAccess === 'function'; }

  async connect(): Promise<boolean> {
    if (!this.supported) {
      this.dj.store.toast('This browser has no Web MIDI support', 'warn', {
        detail: 'Chrome and Edge support it; Safari and Firefox currently do not.',
      });
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (err) {
      this.dj.store.toast('MIDI access was refused', 'error', {
        detail: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    this.access.onstatechange = () => { this.refreshDevices(); };
    this.refreshDevices();
    this.attachInputs();
    await this.load();
    return true;
  }

  private refreshDevices() {
    if (!this.access) return;
    this.devices = [...this.access.inputs.values()].map((i) => ({
      id: i.id,
      name: i.name ?? 'Unnamed MIDI device',
      connected: i.state === 'connected',
    }));
    this.attachInputs();
    this.onDevicesChanged?.();

    const lost = this.devices.filter((d) => !d.connected);
    if (lost.length) {
      this.dj.store.toast(`MIDI device disconnected: ${lost[0].name}`, 'warn');
    }
  }

  private attachInputs() {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = (e) => this.onMessage(input.name ?? input.id, e);
    }
  }

  private onMessage(deviceName: string, e: MIDIMessageEvent) {
    const data = e.data;
    if (!data || data.length < 2) return;
    const status = data[0] & 0xf0;
    const channel = data[0] & 0x0f;
    const d1 = data[1];
    const d2 = data.length > 2 ? data[2] : 0;

    // Ignore clock, active sensing and other system realtime traffic.
    if (data[0] >= 0xf8) return;

    const key = `${deviceName}:${status}:${channel}:${d1}`;

    if (this.learning) {
      const mapping: MidiMapping = { targetId: this.learning.targetId, deck: this.learning.deck };
      this.learning = null;
      // Drop any previous binding for this target so one control owns it.
      for (const [k, m] of Object.entries(this.mappings)) {
        if (m.targetId === mapping.targetId && m.deck === mapping.deck) delete this.mappings[k];
      }
      this.mappings[key] = mapping;
      void this.save();
      this.onLearn?.(key, mapping);
      return;
    }

    const mapping = this.mappings[key];
    this.onActivity?.(key, d2 / 127);
    if (!mapping) return;

    const target = MIDI_TARGETS.find((t) => t.id === mapping.targetId);
    if (!target) return;

    let value: number;
    if (status === 0x90 || status === 0x80) {
      // Note on with velocity 0 is a note off on most controllers.
      value = status === 0x80 || d2 === 0 ? 0 : 1;
    } else if (mapping.relative) {
      value = 0.5 + (d2 > 64 ? (d2 - 128) : d2) / 128;
    } else {
      value = d2 / 127;
    }

    const deck = mapping.deck ?? 'A';
    target.apply(this.dj, deck, value);
  }

  startLearning(targetId: string, deck: DeckId | null) {
    this.learning = { targetId, deck };
  }

  cancelLearning() { this.learning = null; }

  clearMapping(key: string) {
    delete this.mappings[key];
    void this.save();
  }

  keyFor(targetId: string, deck: DeckId | null): string | null {
    const entry = Object.entries(this.mappings).find(([, m]) => m.targetId === targetId && m.deck === deck);
    return entry ? entry[0] : null;
  }

  async load() {
    const saved = await settingsDb.get<MidiMappings>('midi-mappings');
    if (saved) this.mappings = saved;
  }

  async save() { await settingsDb.put('midi-mappings', this.mappings); }

  async reset() { this.mappings = {}; await this.save(); }
}
