/**
 * Mixer: channel strips, crossfader, master section and metering.
 * Meters read the per-sample peak values the meter worklet measures, so the
 * clip indicator catches transients an FFT-based meter would miss.
 */
import { el, button, knob, fader, setClass, setText } from './dom';
import type { DjConsole } from '../state/console';
import type { DeckId } from '../lib/types';
import { gainToDb } from '../audio/engine';

interface Strip {
  id: DeckId;
  meterFill: HTMLElement;
  meterHold: HTMLElement;
  clip: HTMLElement;
  pfl: HTMLButtonElement;
  updaters: (() => void)[];
}

export class MixerView {
  readonly root: HTMLElement;
  private dj: DjConsole;
  private strips: Strip[] = [];
  private masterFillL: HTMLElement;
  private masterFillR: HTMLElement;
  private masterHoldL: HTMLElement;
  private masterHoldR: HTMLElement;
  private masterClip: HTMLElement;
  private headroomEl: HTMLElement;

  constructor(dj: DjConsole) {
    this.dj = dj;

    this.masterFillL = el('div', { class: 'meter-fill' });
    this.masterFillR = el('div', { class: 'meter-fill' });
    this.masterHoldL = el('div', { class: 'meter-hold' });
    this.masterHoldR = el('div', { class: 'meter-hold' });
    this.masterClip = el('div', { class: 'clip-led', text: 'CLIP' });
    this.headroomEl = el('span', { class: 'headroom', text: '-∞ dB' });

    const strips = dj.engine.deckIds.map((id) => this.buildStrip(id));

    const crossfader = fader({
      min: -1, max: 1, vertical: false,
      getValue: () => dj.store.state.crossfader,
      onChange: (v) => dj.setCrossfader(v),
      defaultValue: 0,
      sensitivity: 2 / 200,
      className: 'crossfader',
    });
    dj.store.subscribe('mixer', () => crossfader.update());

    const curveSelect = el('select', {
      class: 'curve-select',
      title: 'Crossfader curve',
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value as 'linear' | 'smooth' | 'sharp';
        dj.engine.setCrossfaderCurve(v);
        dj.store.state.settings.crossfaderCurve = v;
        void dj.saveSettings();
      },
    }, [
      el('option', { value: 'smooth', text: 'Smooth' }),
      el('option', { value: 'linear', text: 'Linear' }),
      el('option', { value: 'sharp', text: 'Cut' }),
    ]);
    curveSelect.value = dj.store.state.settings.crossfaderCurve;

    const masterKnobs = el('div', { class: 'master-knobs' }, [
      knob('MASTER', {
        min: 0, max: 1.2, getValue: () => dj.store.state.masterVolume,
        onChange: (v) => dj.setMasterVolume(v), defaultValue: 0.85,
        format: (v) => `${Math.round(v * 100)}`,
      }).root,
      knob('CUE VOL', {
        min: 0, max: 1, getValue: () => dj.store.state.cueVolume,
        onChange: (v) => dj.setCueVolume(v), defaultValue: 0.7,
        format: (v) => `${Math.round(v * 100)}`,
      }).root,
      knob('CUE MIX', {
        min: 0, max: 1, getValue: () => dj.store.state.cueMix,
        onChange: (v) => dj.setCueMix(v), defaultValue: 0.5,
        format: (v) => (v < 0.5 ? 'CUE' : v > 0.5 ? 'MSTR' : 'MID'),
      }).root,
    ]);

    const masterMeter = el('div', { class: 'master-meter' }, [
      el('div', { class: 'meter stereo' }, [
        el('div', { class: 'meter-channel' }, [this.masterFillL, this.masterHoldL]),
        el('div', { class: 'meter-channel' }, [this.masterFillR, this.masterHoldR]),
      ]),
      el('div', { class: 'meter-scale' }, [
        el('span', { text: '0' }), el('span', { text: '-6' }),
        el('span', { text: '-12' }), el('span', { text: '-24' }),
      ]),
    ]);

    this.root = el('div', { class: 'mixer' }, [
      el('div', { class: 'mixer-strips' }, strips),
      el('div', { class: 'mixer-master' }, [
        el('span', { class: 'section-label', text: 'MASTER' }),
        masterMeter,
        this.masterClip,
        this.headroomEl,
        masterKnobs,
        el('div', { class: 'master-toggles' }, [
          this.limiterToggle(),
          button('PANIC', { class: 'panic-btn', title: 'Stop all audio immediately', onclick: () => dj.panic() }),
        ]),
      ]),
      el('div', { class: 'crossfader-row' }, [
        el('span', { class: 'xf-label', text: 'A' }),
        crossfader.root,
        el('span', { class: 'xf-label', text: 'B' }),
        curveSelect,
      ]),
    ]);

    dj.store.subscribe('mixer', () => this.renderSlow());
    dj.store.subscribe('deck', () => this.renderSlow());
  }

  private limiterToggle(): HTMLButtonElement {
    const dj = this.dj;
    const btn = button('LIMITER', {
      class: 'toggle-btn',
      title: 'Brickwall protection on the master output',
      onclick: () => {
        const on = !dj.store.state.settings.limiterEnabled;
        dj.store.state.settings.limiterEnabled = on;
        dj.engine.setLimiterEnabled(on);
        btn.classList.toggle('active', on);
        void dj.saveSettings();
        if (!on) {
          dj.store.toast('Master limiter relaxed', 'warn', {
            detail: 'A hard clamp still protects the output, but loud mixes can now distort.',
          });
        }
      },
    });
    btn.classList.toggle('active', dj.store.state.settings.limiterEnabled);
    return btn;
  }

  private buildStrip(id: DeckId): HTMLElement {
    const dj = this.dj;
    const updaters: (() => void)[] = [];

    const trim = knob('TRIM', {
      min: -12, max: 12, getValue: () => dj.store.deck(id).trim,
      onChange: (v) => dj.setTrim(id, v), defaultValue: 0,
      format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`,
    });
    const high = knob('HIGH', {
      min: -26, max: 12, getValue: () => dj.store.deck(id).eqHigh,
      onChange: (v) => dj.setEq(id, 'high', v), defaultValue: 0,
      format: (v) => (v <= -25.5 ? 'KILL' : `${v > 0 ? '+' : ''}${v.toFixed(0)}`),
    });
    const mid = knob('MID', {
      min: -26, max: 12, getValue: () => dj.store.deck(id).eqMid,
      onChange: (v) => dj.setEq(id, 'mid', v), defaultValue: 0,
      format: (v) => (v <= -25.5 ? 'KILL' : `${v > 0 ? '+' : ''}${v.toFixed(0)}`),
    });
    const low = knob('LOW', {
      min: -26, max: 12, getValue: () => dj.store.deck(id).eqLow,
      onChange: (v) => dj.setEq(id, 'low', v), defaultValue: 0,
      format: (v) => (v <= -25.5 ? 'KILL' : `${v > 0 ? '+' : ''}${v.toFixed(0)}`),
    });
    const filter = knob('FILTER', {
      min: -1, max: 1, getValue: () => dj.store.deck(id).filter,
      onChange: (v) => dj.setFilter(id, v), defaultValue: 0,
      format: (v) => (Math.abs(v) < 0.05 ? 'OFF' : v < 0 ? `LP ${Math.round(-v * 100)}` : `HP ${Math.round(v * 100)}`),
    });
    updaters.push(trim.update, high.update, mid.update, low.update, filter.update);

    const channelFader = fader({
      min: 0, max: 1,
      getValue: () => dj.store.deck(id).fader,
      onChange: (v) => dj.setFader(id, v),
      defaultValue: 1,
      sensitivity: 1 / 170,
      className: 'channel-fader',
    });
    updaters.push(channelFader.update);

    const pfl = button('CUE', {
      class: 'pfl-btn',
      title: 'Pre-fader listen on the headphone output',
      onclick: () => dj.togglePfl(id),
    });

    const meterFill = el('div', { class: 'meter-fill' });
    const meterHold = el('div', { class: 'meter-hold' });
    const clip = el('div', { class: 'clip-led small', text: 'CLIP' });

    this.strips.push({ id, meterFill, meterHold, clip, pfl, updaters });

    // Kill switches: shift-click an EQ knob to slam it to -26 dB.
    const killRow = el('div', { class: 'kill-row' }, [
      this.killBtn(id, 'high'), this.killBtn(id, 'mid'), this.killBtn(id, 'low'),
    ]);

    return el('div', { class: `strip strip-${id}` }, [
      el('span', { class: 'strip-label', text: `CH ${id}` }),
      trim.root,
      el('div', { class: 'eq-stack' }, [high.root, mid.root, low.root]),
      killRow,
      filter.root,
      el('div', { class: 'strip-bottom' }, [
        el('div', { class: 'meter mono' }, [meterFill, meterHold]),
        channelFader.root,
      ]),
      clip,
      pfl,
    ]);
  }

  private killBtn(id: DeckId, band: 'low' | 'mid' | 'high'): HTMLButtonElement {
    const dj = this.dj;
    const btn = button(band[0].toUpperCase(), {
      class: 'kill-btn',
      title: `Kill the ${band} band`,
      onclick: () => {
        const ui = dj.store.deck(id);
        const current = band === 'low' ? ui.eqLow : band === 'mid' ? ui.eqMid : ui.eqHigh;
        const killed = current <= -25.5;
        dj.setEq(id, band, killed ? 0 : -26);
        btn.classList.toggle('active', !killed);
        this.renderSlow();
      },
    });
    return btn;
  }

  private renderSlow() {
    for (const strip of this.strips) {
      for (const u of strip.updaters) u();
      setClass(strip.pfl, 'active', this.dj.store.deck(strip.id).pfl);
    }
  }

  /** Meters run at frame rate off the worklet's measurements. */
  renderFrame() {
    const engine = this.dj.engine;
    for (const strip of this.strips) {
      const m = engine.channelMeters.get(strip.id);
      if (!m) continue;
      const peak = Math.max(m.peakL, m.peakR);
      strip.meterFill.style.height = `${meterScale(peak) * 100}%`;
      strip.meterHold.style.bottom = `${meterScale(Math.max(m.holdL, m.holdR)) * 100}%`;
      setClass(strip.clip, 'lit', m.clipped);
    }

    const m = engine.masterMeter;
    this.masterFillL.style.height = `${meterScale(m.peakL) * 100}%`;
    this.masterFillR.style.height = `${meterScale(m.peakR) * 100}%`;
    this.masterHoldL.style.bottom = `${meterScale(m.holdL) * 100}%`;
    this.masterHoldR.style.bottom = `${meterScale(m.holdR) * 100}%`;
    setClass(this.masterClip, 'lit', m.clipped);

    const peakDb = gainToDb(Math.max(m.holdL, m.holdR));
    setText(this.headroomEl, peakDb < -60 ? '-∞ dB' : `${peakDb.toFixed(1)} dB`);
    setClass(this.headroomEl, 'hot', peakDb > -3);
  }
}

/**
 * Map linear amplitude to meter height on a dB scale. A linear meter spends
 * most of its travel on signals you cannot hear; this puts -24 dB at the
 * bottom, which is where a DJ actually needs resolution.
 */
function meterScale(amplitude: number): number {
  if (amplitude <= 0) return 0;
  const db = 20 * Math.log10(amplitude);
  return Math.max(0, Math.min(1, (db + 48) / 48));
}
