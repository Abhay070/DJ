/**
 * Application entry point.
 *
 * Wires the engine, state and views together and owns the single animation
 * frame loop. Everything that moves at 60 fps - waveforms, jog wheels, meters,
 * time and BPM readouts - is driven from here by reading the audio engine, so
 * there is exactly one place where "what the UI shows" is derived from "what
 * the audio is doing".
 */
import './styles.css';
import { AudioEngine } from './audio/engine';
import { Store } from './state/store';
import { DjConsole } from './state/console';
import { AutoDj } from './lib/autodj';
import { Assistant } from './lib/assistant';
import { Keyboard } from './lib/keybindings';
import { MidiController } from './lib/midi';
import { DeckView } from './ui/deck-view';
import { MixerView } from './ui/mixer-view';
import { FxView, SamplerView } from './ui/fx-view';
import { LibraryView } from './ui/library-view';
import { TopBar, Modal, DebugPanel, Toasts, buildSettings, buildAssistant, buildSession } from './ui/panels';
import { el, button, qs } from './ui/dom';
import type { DeckId } from './lib/types';

const DECK_IDS: DeckId[] = ['A', 'B'];

async function boot() {
  const splash = qs('#splash');
  const app = qs('#app');

  const engine = new AudioEngine(DECK_IDS);
  const store = new Store(DECK_IDS);

  // An AudioContext cannot start until the user interacts with the page, so
  // the splash screen doubles as that gesture.
  const startBtn = qs<HTMLButtonElement>('#start-btn');
  const startError = qs('#start-error');

  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    startBtn.textContent = 'Starting the audio engine…';
    try {
      await engine.start({ latencyHint: 'interactive' });
      splash.classList.add('hidden');
      app.classList.remove('hidden');
      await run(engine, store);
    } catch (err) {
      startBtn.disabled = false;
      startBtn.textContent = 'Try again';
      startError.textContent = err instanceof Error ? err.message : String(err);
      startError.classList.remove('hidden');
    }
  });
}

async function run(engine: AudioEngine, store: Store) {
  const dj = new DjConsole(engine, store);
  await dj.init();

  const auto = new AutoDj(dj);
  const assistant = new Assistant(dj, auto);
  const keyboard = new Keyboard(dj);
  await keyboard.load();
  const midi = new MidiController(dj);
  if (store.state.settings.features.midi) void midi.connect();

  store.state.engineReady = true;
  document.body.dataset.uiMode = store.state.uiMode;

  // ---- views ---------------------------------------------------------------
  const deckViews = DECK_IDS.map((id) => new DeckView(dj, id));
  const mixerView = new MixerView(dj);
  const fxView = new FxView(dj);
  const samplerView = new SamplerView(dj);
  const libraryView = new LibraryView(dj);
  const debugPanel = new DebugPanel(dj);
  const modal = new Modal();
  const toasts = new Toasts(dj);

  const topBar = new TopBar(dj, auto, (panel) => {
    switch (panel) {
      case 'settings': modal.show('Settings', buildSettings(dj, keyboard, midi)); break;
      case 'assistant': modal.show('DJ assistant', buildAssistant(dj, assistant, auto)); break;
      case 'session': modal.show('Sessions', buildSession(dj)); break;
      case 'debug': debugPanel.toggle(); break;
    }
  });

  // Focused deck: deck shortcuts act on whichever deck you last touched.
  const setFocus = (id: DeckId) => {
    keyboard.focusedDeck = id;
    for (const view of deckViews) {
      view.root.classList.toggle('focused', view.root.dataset.deck === id);
    }
  };
  keyboard.onFocusChange = setFocus;
  for (const view of deckViews) {
    view.root.addEventListener('pointerdown', () => setFocus(view.root.dataset.deck as DeckId), true);
  }
  setFocus('A');

  const app = qs('#app');
  app.append(
    topBar.root,
    el('main', { class: 'console' }, [
      el('div', { class: 'decks-row' }, [
        deckViews[0].root,
        mixerView.root,
        deckViews[1].root,
      ]),
      el('div', { class: 'performance-row' }, [fxView.root, samplerView.root]),
      libraryView.root,
    ]),
    modal.root,
  );

  // Toasts and the debug panel are fixed-position overlays, so they hang off
  // the body rather than the app container, where the console's own layout
  // and scrolling would clip them.
  document.body.append(toasts.root, debugPanel.root);

  // ---- shortcuts help ------------------------------------------------------
  app.append(el('footer', { class: 'statusbar' }, [
    el('span', { class: 'hint' }, [
      'Space play · S sync · C cue · 1-8 hot cues · L loop · ←→ nudge · ↑↓ pitch · ' +
      'A/B focus deck · R record · Esc panic. All remappable in Settings → Keyboard.',
    ]),
    button('Keyboard', {
      class: 'mini-btn',
      onclick: () => modal.show('Settings', buildSettings(dj, keyboard, midi)),
    }),
  ]));

  // ---- the one frame loop --------------------------------------------------
  let lastFrame = performance.now();
  let frameMsAvg = 0;
  let cpuAvg = 0;

  const frame = () => {
    const t0 = performance.now();
    const delta = t0 - lastFrame;
    lastFrame = t0;

    for (const view of deckViews) view.renderFrame();
    mixerView.renderFrame();

    const work = performance.now() - t0;
    // Exponential averages: raw per-frame numbers are far too noisy to read.
    frameMsAvg = frameMsAvg * 0.9 + work * 0.1;
    // Rough load estimate: our own work against the frame budget.
    const budget = Math.max(8, delta);
    cpuAvg = cpuAvg * 0.9 + Math.min(100, (work / budget) * 100) * 0.1;

    topBar.renderFrame(cpuAvg);
    debugPanel.renderFrame(cpuAvg, frameMsAvg);

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // Keep beat-synced FX following the master tempo even when nothing else
  // triggers a refresh.
  setInterval(() => dj.refreshMasterTempo(), 500);

  // ---- global guards -------------------------------------------------------
  window.addEventListener('beforeunload', (e) => {
    if (store.state.recording || DECK_IDS.some((id) => engine.deck(id).playing)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // The browser can suspend the context when a device disappears.
  engine.ctx.addEventListener('statechange', () => {
    if (engine.ctx.state === 'suspended' && store.state.engineReady) {
      store.toast('The audio engine was suspended', 'warn', {
        sticky: true,
        detail: 'The output device may have changed or been unplugged.',
        actions: [{
          label: 'Resume',
          run: () => void engine.resume().then(() => store.toast('Audio engine running', 'success')),
        }],
      });
    }
  });

  window.addEventListener('error', (e) => {
    store.toast('Something went wrong', 'error', { detail: e.message });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason instanceof Error ? e.reason.message : String(e.reason);
    store.toast('Something went wrong', 'error', { detail: reason });
  });

  // Debug handle. The console is entirely local, so exposing it costs nothing
  // and makes the engine inspectable from devtools - `__dj.engine.deck('A')`
  // and friends - which is the same state the debug panel renders.
  (window as unknown as { __dj: DjConsole }).__dj = dj;

  store.toast('Audio engine running', 'success', {
    detail: `${engine.sampleRate} Hz · ${(engine.latency * 1000).toFixed(1)} ms · ` +
      `${self.crossOriginIsolated ? 'shared-memory playhead' : 'message-port playhead'}`,
  });
}

void boot();
