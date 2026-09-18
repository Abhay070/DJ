/**
 * Simple mode - the default.
 *
 * Add music, press one button, it DJs. No decks, no faders, no jargon: the
 * whole screen is one instruction at a time, and the status is a sentence
 * rather than a row of numbers.
 *
 * Everything it does goes through the same console the full interface drives,
 * so nothing here is a special case or a simulation. Switching to the full
 * console mid-mix keeps playing without a gap.
 */
import { el, button, clear, setText, setClass } from './dom';
import type { DjConsole } from '../state/console';
import { formatDuration } from '../state/console';
import type { AutoDj } from '../lib/autodj';
import { formatCountdown } from '../lib/transition-points';

export class SimpleView {
  readonly root: HTMLElement;
  private dj: DjConsole;
  private auto: AutoDj;

  private bigButton: HTMLButtonElement;
  private bigButtonLabel: HTMLElement;
  private statusHeadline: HTMLElement;
  private statusDetail: HTMLElement;
  private countEl: HTMLElement;
  private progressFill: HTMLElement;
  private progressTime: HTMLElement;
  private nowPlaying: HTMLElement;
  private upNext: HTMLElement;
  private controls: HTMLElement;
  private queueList: HTMLElement;
  private busy = false;

  constructor(dj: DjConsole, auto: AutoDj, onShowConsole: () => void) {
    this.dj = dj;
    this.auto = auto;

    this.countEl = el('p', { class: 'simple-count', text: 'No music added yet' });
    this.bigButtonLabel = el('span', { class: 'big-label', text: 'Start mixing' });
    this.bigButton = button('', { class: 'big-button', onclick: () => void this.press() });
    clear(this.bigButton);
    this.bigButton.append(
      el('span', { class: 'big-icon', text: '▶' }),
      this.bigButtonLabel,
    );

    this.statusHeadline = el('p', { class: 'simple-headline', text: 'Nothing playing yet' });
    this.statusDetail = el('p', { class: 'simple-detail', text: 'Add a few songs, then press the button.' });
    this.nowPlaying = el('div', { class: 'now-playing' });
    this.upNext = el('div', { class: 'up-next' });
    this.progressFill = el('div', { class: 'simple-progress-fill' });
    this.progressTime = el('span', { class: 'simple-progress-time', text: '0:00' });
    this.queueList = el('div', { class: 'simple-queue' });

    this.controls = el('div', { class: 'simple-controls' }, [
      button('Blend into the next song now', {
        class: 'secondary-btn',
        title: 'Do not wait for the planned moment - start the blend right away',
        onclick: () => void this.runAction(() => this.auto.blendNow()),
      }),
      button('Skip', {
        class: 'secondary-btn',
        title: 'Jump straight to the next song',
        onclick: () => void this.runAction(() => this.auto.skip()),
      }),
      button('Stop', {
        class: 'secondary-btn',
        onclick: () => {
          this.auto.stop();
          this.dj.panic();
          this.update();
        },
      }),
    ]);

    const volume = el('input', {
      class: 'simple-volume',
      type: 'range', min: 0, max: 100, value: 85,
      oninput: (e: Event) => dj.setMasterVolume(Number((e.target as HTMLInputElement).value) / 100),
    });

    this.root = el('div', { class: 'simple' }, [
      el('div', { class: 'simple-card' }, [
        // Step one.
        el('section', { class: 'simple-step' }, [
          el('span', { class: 'step-number', text: '1' }),
          el('div', { class: 'step-body' }, [
            el('h2', { text: 'Add your music' }),
            el('div', { class: 'step-actions' }, [
              button('Choose songs', { class: 'primary-btn', onclick: () => this.pick(false) }),
              button('Choose a folder', { class: 'secondary-btn', onclick: () => this.pick(true) }),
            ]),
            el('p', { class: 'simple-hint', text: 'Or drag files anywhere onto this page. Your music stays on this computer.' }),
            this.countEl,
          ]),
        ]),

        // Step two.
        el('section', { class: 'simple-step' }, [
          el('span', { class: 'step-number', text: '2' }),
          el('div', { class: 'step-body' }, [
            el('h2', { text: 'Let it DJ' }),
            this.bigButton,
            el('p', { class: 'simple-hint' }, [
              'It listens to every song, works out the speed and the beat, ' +
              'finds where they fit together best, and blends them - matching ' +
              'speed and beat automatically.',
            ]),
          ]),
        ]),

        // Live status.
        el('section', { class: 'simple-status' }, [
          this.statusHeadline,
          this.statusDetail,
          this.nowPlaying,
          el('div', { class: 'simple-progress' }, [this.progressFill]),
          el('div', { class: 'simple-progress-row' }, [this.progressTime, this.upNext]),
          this.controls,
        ]),

        el('section', { class: 'simple-extras' }, [
          el('label', { class: 'simple-volume-row' }, [
            el('span', { text: 'Volume' }),
            volume,
          ]),
          this.queueList,
          button('Show the full DJ console', {
            class: 'link-btn',
            onclick: onShowConsole,
          }),
        ]),
      ]),
    ]);

    this.attachDropZone();
    dj.store.subscribe('library', () => this.update());
    dj.store.subscribe('analysis', () => this.update());
    this.update();
  }

  // -------------------------------------------------------------- actions

  private async press() {
    await this.runAction(() => this.auto.mixItForMe());
  }

  /** Run an auto-DJ action, showing its plain-language answer. */
  private async runAction(fn: () => Promise<string> | string) {
    if (this.busy) return;
    this.busy = true;
    this.bigButton.disabled = true;
    try {
      const message = await fn();
      setText(this.statusDetail, message);
      this.dj.store.toast(message, 'info');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.dj.store.toast('That did not work', 'error', { detail });
    } finally {
      this.busy = false;
      this.bigButton.disabled = false;
      this.update();
    }
  }

  private pick(directory: boolean) {
    const input = el('input', { type: 'file', multiple: true, accept: 'audio/*' });
    if (directory) {
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
    }
    input.addEventListener('change', async () => {
      const files = [...(input.files ?? [])];
      if (files.length) await this.importFiles(files);
    });
    input.click();
  }

  private async importFiles(files: File[]) {
    setText(this.countEl, `Listening to ${files.length} file${files.length === 1 ? '' : 's'}…`);
    await this.dj.library.importFiles(files);
    this.update();
  }

  private attachDropZone() {
    // The whole page is a drop target in simple mode - there is no library
    // panel to aim at, and "drag it anywhere" is one less thing to explain.
    const over = (e: DragEvent) => {
      e.preventDefault();
      this.root.classList.add('drop-target');
    };
    this.root.addEventListener('dragover', over);
    this.root.addEventListener('dragenter', over);
    this.root.addEventListener('dragleave', (e) => {
      if (e.target === this.root) this.root.classList.remove('drop-target');
    });
    this.root.addEventListener('drop', async (e) => {
      e.preventDefault();
      this.root.classList.remove('drop-target');
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) await this.importFiles(files);
    });
  }

  // ------------------------------------------------------------ rendering

  /** Library counts and the queue - only when something actually changed. */
  private update() {
    const tracks = [...this.dj.store.state.tracks.values()];
    const ready = tracks.filter((t) => t.analysisState === 'done');
    const pending = tracks.length - ready.length;

    if (!tracks.length) {
      setText(this.countEl, 'No music added yet');
    } else if (pending > 0) {
      setText(this.countEl, `${ready.length} ready · listening to ${pending} more…`);
    } else {
      setText(this.countEl, `${ready.length} song${ready.length === 1 ? '' : 's'} ready`);
    }
    setClass(this.countEl, 'ready', ready.length > 0 && pending === 0);
    setClass(this.countEl, 'working', pending > 0);

    this.bigButton.disabled = this.busy || ready.length === 0;
    setClass(this.root, 'has-music', ready.length > 0);

    // Queue: what is coming after the track that is loaded next.
    clear(this.queueList);
    const suggestions = this.auto.suggest(
      this.dj.engine.deckIds.find((id) => this.dj.engine.deck(id).playing) ?? this.dj.engine.deckIds[0],
      3,
    );
    if (suggestions.length) {
      this.queueList.append(el('span', { class: 'queue-label', text: 'Then probably' }));
      for (const s of suggestions) {
        this.queueList.append(el('div', { class: 'queue-item' }, [
          el('span', { class: 'queue-title', text: `${s.track.artist} — ${s.track.title}` }),
        ]));
      }
    }
  }

  /** Live status, once per frame, read from the engine. */
  renderFrame() {
    const status = this.auto.status;
    setText(this.statusHeadline, status.headline);
    if (!this.busy) setText(this.statusDetail, status.detail);
    setClass(this.root, 'is-mixing', status.state === 'mixing');
    setClass(this.controls, 'visible', status.state !== 'idle');

    setText(this.bigButtonLabel,
      status.state === 'idle' ? 'Start mixing'
      : status.state === 'mixing' ? 'Mixing…'
      : 'Keep it going');

    const playingId = this.dj.engine.deckIds.find((id) => this.dj.engine.deck(id).playing);
    if (!playingId) {
      this.progressFill.style.width = '0%';
      setText(this.progressTime, '');
      setText(this.upNext, '');
      clear(this.nowPlaying);
      return;
    }

    const deck = this.dj.engine.deck(playingId);
    const track = deck.trackId ? this.dj.store.state.tracks.get(deck.trackId) : null;
    const position = deck.position;
    const duration = deck.duration || 1;

    this.progressFill.style.width = `${Math.min(100, (position / duration) * 100)}%`;
    setText(this.progressTime, `${formatDuration(position)} / ${formatDuration(duration)}`);

    if (this.nowPlaying.dataset.track !== (deck.trackId ?? '')) {
      this.nowPlaying.dataset.track = deck.trackId ?? '';
      clear(this.nowPlaying);
      if (track) {
        this.nowPlaying.append(
          el('span', { class: 'np-title', text: track.title }),
          el('span', { class: 'np-artist', text: track.artist }),
        );
      }
    }

    setText(this.upNext, status.countdown !== undefined && status.nextTitle
      ? `Next: ${status.nextTitle} in ${formatCountdown(status.countdown)}`
      : status.nextTitle ? `Next: ${status.nextTitle}` : '');
  }
}
