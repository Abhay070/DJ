/** Tiny DOM helpers. No framework - see the note at the top of store.ts. */

type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Attrs = {}, children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      node.className = String(v);
    } else if (k === 'text') {
      node.textContent = String(v);
    } else if (k === 'html') {
      node.innerHTML = String(v);
    } else if (v === true) {
      node.setAttribute(k, '');
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node: Element) { while (node.firstChild) node.removeChild(node.firstChild); }

export function qs<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const node = root.querySelector<T>(sel);
  if (!node) throw new Error(`Element not found: ${sel}`);
  return node;
}

/**
 * A pointer-drag knob/fader binding. Works for rotary knobs (vertical drag)
 * and linear faders alike, with shift for fine control and double-click to
 * return to a default.
 */
export interface DragOptions {
  onChange: (value: number) => void;
  getValue: () => number;
  min: number;
  max: number;
  /** Units of value per pixel of drag. */
  sensitivity?: number;
  axis?: 'y' | 'x';
  defaultValue?: number;
  onStart?: () => void;
  onEnd?: () => void;
}

export function bindDrag(node: HTMLElement, opts: DragOptions) {
  const range = opts.max - opts.min;
  const sensitivity = opts.sensitivity ?? range / 160;
  let startValue = 0;
  let startPos = 0;
  let dragging = false;

  const move = (e: PointerEvent) => {
    if (!dragging) return;
    const pos = opts.axis === 'x' ? e.clientX : e.clientY;
    const delta = opts.axis === 'x' ? pos - startPos : startPos - pos;
    const fine = e.shiftKey ? 0.2 : 1;
    const next = clamp(startValue + delta * sensitivity * fine, opts.min, opts.max);
    opts.onChange(next);
  };

  const up = () => {
    if (!dragging) return;
    dragging = false;
    node.classList.remove('dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    opts.onEnd?.();
  };

  node.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    node.classList.add('dragging');
    startValue = opts.getValue();
    startPos = opts.axis === 'x' ? e.clientX : e.clientY;
    opts.onStart?.();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  node.addEventListener('dblclick', () => {
    if (opts.defaultValue !== undefined) opts.onChange(opts.defaultValue);
  });

  node.addEventListener('wheel', (e) => {
    e.preventDefault();
    const step = (e.shiftKey ? 0.2 : 1) * range * 0.02;
    opts.onChange(clamp(opts.getValue() - Math.sign(e.deltaY) * step, opts.min, opts.max));
  }, { passive: false });
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Map a value in [min,max] onto [0,1]. */
export function norm(v: number, min: number, max: number): number {
  return max === min ? 0 : clamp((v - min) / (max - min), 0, 1);
}

export function knob(label: string, opts: Omit<DragOptions, 'onStart' | 'onEnd'> & { format?: (v: number) => string }) {
  const dial = el('div', { class: 'knob-dial' }, [el('span', { class: 'knob-pointer' })]);
  const readout = el('span', { class: 'knob-value' });
  const wrap = el('div', { class: 'knob' }, [
    dial,
    el('span', { class: 'knob-label', text: label }),
    readout,
  ]);

  const update = () => {
    const t = norm(opts.getValue(), opts.min, opts.max);
    // 270 degrees of travel, centred at 12 o'clock.
    dial.style.setProperty('--angle', `${-135 + t * 270}deg`);
    readout.textContent = opts.format ? opts.format(opts.getValue()) : opts.getValue().toFixed(1);
  };

  bindDrag(dial, { ...opts, onChange: (v) => { opts.onChange(v); update(); } });
  update();
  return { root: wrap, update };
}

export function fader(opts: DragOptions & { vertical?: boolean; className?: string }) {
  const handle = el('div', { class: 'fader-handle' });
  const track = el('div', { class: 'fader-track' }, [handle]);
  const root = el('div', { class: `fader ${opts.vertical === false ? 'horizontal' : 'vertical'} ${opts.className ?? ''}` }, [track]);

  const update = () => {
    const t = norm(opts.getValue(), opts.min, opts.max);
    if (opts.vertical === false) handle.style.left = `${t * 100}%`;
    else handle.style.bottom = `${t * 100}%`;
  };

  bindDrag(track, {
    ...opts,
    axis: opts.vertical === false ? 'x' : 'y',
    onChange: (v) => { opts.onChange(v); update(); },
  });
  update();
  return { root, update };
}

export function button(label: string, attrs: Attrs = {}) {
  return el('button', { type: 'button', ...attrs }, [label]);
}

/** Toggle a class based on a boolean, only touching the DOM when it changes. */
export function setClass(node: Element, name: string, on: boolean) {
  if (on === node.classList.contains(name)) return;
  node.classList.toggle(name, on);
}

/** Set textContent only when it differs - avoids needless layout work at 60fps. */
export function setText(node: Node, text: string) {
  if (node.textContent !== text) node.textContent = text;
}
