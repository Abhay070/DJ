/**
 * FX rack and sampler pads.
 * Beat-synced effects show their timing in beats; the engine converts that to
 * seconds from the current master tempo, so the labels stay honest when the
 * master pitch fader moves.
 */
import { el, button, knob, setClass, setText } from './dom';
import type { DjConsole } from '../state/console';
import { FX_DESCRIPTORS, BEAT_DIVISION_LABELS, type FxId } from '../audio/fx';
import type { DeckId } from '../lib/types';

const FX_ORDER: FxId[] = [
  'filter', 'echo', 'delay', 'reverb', 'flanger', 'phaser', 'chorus',
  'distortion', 'bitcrusher', 'gate', 'trans', 'beatrepeat', 'pitch', 'ringmod',
];

export class FxView {
  readonly root: HTMLElement;
  private dj: DjConsole;
  private unitNodes: { enable: HTMLButtonElement; updaters: (() => void)[]; select: HTMLSelectElement; aLabel: HTMLElement }[] = [];

  constructor(dj: DjConsole) {
    this.dj = dj;
    const units = dj.store.state.fx.map((_, i) => this.buildUnit(i));

    this.root = el('div', { class: 'fx-rack' }, [
      el('span', { class: 'section-label', text: 'FX' }),
      el('div', { class: 'fx-units' }, units),
      this.buildPerformancePads(),
    ]);

    dj.store.subscribe('fx', () => this.renderSlow());
    this.renderSlow();
  }

  private buildUnit(index: number): HTMLElement {
    const dj = this.dj;
    const state = () => dj.store.state.fx[index];

    const select = el('select', {
      class: 'fx-select',
      onchange: (e: Event) => {
        dj.setFxType(index, (e.target as HTMLSelectElement).value as FxId);
        this.renderSlow();
      },
    }, FX_ORDER.map((id) => el('option', { value: id, text: FX_DESCRIPTORS[id].name })));
    select.value = state().id;

    const desc = () => FX_DESCRIPTORS[state().id];
    const aLabel = el('span', { class: 'fx-param-label' });

    const knobA = knob('A', {
      min: 0, max: 1,
      getValue: () => state().a,
      onChange: (v) => dj.setFxParam(index, { a: v }),
      format: (v) => {
        const d = desc();
        if (d.beatSynced) return BEAT_DIVISION_LABELS[Math.round(v)] ?? '1';
        return v.toFixed(d.paramA.max > 50 ? 0 : 2);
      },
    });
    const knobB = knob('B', {
      min: 0, max: 1,
      getValue: () => state().b,
      onChange: (v) => dj.setFxParam(index, { b: v }),
      format: (v) => v.toFixed(desc().paramB.max > 50 ? 0 : 2),
    });
    const knobWet = knob('WET', {
      min: 0, max: 1,
      getValue: () => state().wet,
      onChange: (v) => dj.setFxParam(index, { wet: v }),
      defaultValue: 0,
      format: (v) => `${Math.round(v * 100)}%`,
    });

    const enable = button('ON', {
      class: 'fx-enable',
      onclick: () => {
        const on = !state().enabled;
        dj.setFxEnabled(index, on);
        // Turning an effect on with wet at zero does nothing audible, which
        // reads as a broken button. Give it a usable starting mix.
        if (on && state().wet < 0.02) dj.setFxParam(index, { wet: 0.4 });
        this.renderSlow();
      },
    });

    const routing = el('div', { class: 'fx-routing' },
      dj.engine.deckIds.map((id) => {
        const btn = button(id, {
          class: 'fx-route-btn active',
          title: `Send deck ${id} through this effect`,
          onclick: () => {
            const on = !state().routing[id];
            dj.setFxRouting(index, id as DeckId, on);
            btn.classList.toggle('active', on);
          },
        });
        return btn;
      }),
    );

    this.unitNodes.push({ enable, updaters: [knobA.update, knobB.update, knobWet.update], select, aLabel });

    return el('div', { class: 'fx-unit' }, [
      el('div', { class: 'fx-head' }, [select, enable]),
      aLabel,
      el('div', { class: 'fx-knobs' }, [knobA.root, knobB.root, knobWet.root]),
      routing,
    ]);
  }

  /**
   * One-touch performance pads. Held down they engage; released they let go -
   * which is how these get used live.
   */
  private buildPerformancePads(): HTMLElement {
    const dj = this.dj;
    const presets: { label: string; fx: FxId; wet: number; a?: number; b?: number }[] = [
      { label: 'ECHO', fx: 'echo', wet: 0.6, a: 2 },
      { label: 'REVERB', fx: 'reverb', wet: 0.5 },
      { label: 'FILTER', fx: 'filter', wet: 1, a: 0.75 },
      { label: 'FLANGER', fx: 'flanger', wet: 0.7 },
      { label: 'TRANS', fx: 'trans', wet: 0.9, a: 1 },
      { label: 'GATE', fx: 'gate', wet: 0.8, a: 2 },
      { label: 'ROLL', fx: 'beatrepeat', wet: 1, a: 1 },
      { label: 'CRUSH', fx: 'bitcrusher', wet: 0.7 },
    ];

    const pads = presets.map((p) => {
      const pad = button(p.label, { class: 'pad fx-pad' });
      const engage = (e: Event) => {
        e.preventDefault();
        // Performance pads always drive unit 0, so they are predictable.
        dj.setFxType(0, p.fx);
        dj.setFxParam(0, { wet: p.wet, ...(p.a !== undefined ? { a: p.a } : {}), ...(p.b !== undefined ? { b: p.b } : {}) });
        dj.setFxEnabled(0, true);
        pad.classList.add('held');
      };
      const release = () => {
        dj.setFxEnabled(0, false);
        pad.classList.remove('held');
      };
      pad.addEventListener('pointerdown', engage);
      pad.addEventListener('pointerup', release);
      pad.addEventListener('pointerleave', () => { if (pad.classList.contains('held')) release(); });
      return pad;
    });

    return el('div', { class: 'fx-pads' }, [
      el('span', { class: 'section-label', text: 'PERFORMANCE FX (hold)' }),
      el('div', { class: 'pad-grid' }, pads),
    ]);
  }

  private renderSlow() {
    const dj = this.dj;
    this.unitNodes.forEach((node, i) => {
      const state = dj.store.state.fx[i];
      if (!state) return;
      setClass(node.enable, 'active', state.enabled);
      node.select.value = state.id;
      for (const u of node.updaters) u();
      const desc = FX_DESCRIPTORS[state.id];
      const aText = desc.beatSynced
        ? `${desc.paramA.label}: ${BEAT_DIVISION_LABELS[Math.round(state.a)] ?? '1'} beat`
        : `${desc.paramA.label} / ${desc.paramB.label}`;
      setText(node.aLabel, aText);
    });
  }
}

export class SamplerView {
  readonly root: HTMLElement;
  private dj: DjConsole;

  constructor(dj: DjConsole) {
    this.dj = dj;
    const pads = dj.engine.sampler.pads.map((pad) => this.buildPad(pad.index));
    this.root = el('div', { class: 'sampler' }, [
      el('span', { class: 'section-label', text: 'SAMPLER' }),
      el('div', { class: 'pad-grid sampler-grid' }, pads),
      el('p', { class: 'hint', text: 'Drop an audio file on a pad to load it. Right-click to clear.' }),
    ]);
  }

  private buildPad(index: number): HTMLElement {
    const dj = this.dj;
    const sampler = dj.engine.sampler;
    const label = el('span', { class: 'sampler-name', text: sampler.pads[index].name });

    const pad = el('button', {
      class: 'pad sampler-pad',
      type: 'button',
      onclick: () => {
        const p = sampler.pads[index];
        if (!p.buffer) { this.pick(index); return; }
        // Quantised triggers are scheduled on the master grid, not fired now.
        const when = p.quantise ? dj.sync.nextBeatTime(dj.engine.ctx.currentTime, 1) : undefined;
        sampler.trigger(index, when);
        pad.classList.add('hit');
        setTimeout(() => pad.classList.remove('hit'), 140);
      },
      oncontextmenu: (e: Event) => {
        e.preventDefault();
        sampler.clearPad(index);
        label.textContent = sampler.pads[index].name;
        pad.classList.remove('loaded');
      },
    }, [label]);

    pad.style.setProperty('--pad-color', sampler.pads[index].color);

    pad.addEventListener('dragover', (e) => { e.preventDefault(); pad.classList.add('drop-target'); });
    pad.addEventListener('dragleave', () => pad.classList.remove('drop-target'));
    pad.addEventListener('drop', async (e) => {
      e.preventDefault();
      pad.classList.remove('drop-target');
      const file = e.dataTransfer?.files[0];
      if (file) await this.loadInto(index, file, label, pad);
    });

    return pad;
  }

  private pick(index: number) {
    const input = el('input', { type: 'file', accept: 'audio/*' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const padEl = this.root.querySelectorAll<HTMLElement>('.sampler-pad')[index];
      const label = padEl.querySelector<HTMLElement>('.sampler-name')!;
      await this.loadInto(index, file, label, padEl);
    });
    input.click();
  }

  private async loadInto(index: number, file: File, label: HTMLElement, pad: HTMLElement) {
    try {
      const buffer = await this.dj.engine.decode(await file.arrayBuffer());
      const name = file.name.replace(/\.[^.]+$/, '').slice(0, 14);
      this.dj.engine.sampler.loadPad(index, name, buffer);
      label.textContent = name;
      pad.classList.add('loaded');
    } catch {
      this.dj.store.toast(`Could not decode ${file.name}`, 'error', {
        detail: 'The browser does not support this audio format.',
      });
    }
  }
}
