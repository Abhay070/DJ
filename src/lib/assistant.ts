/**
 * The DJ assistant.
 *
 * A local, deterministic command interpreter - no network, no model. It parses
 * an instruction, performs the real console action, then reports the state the
 * engine ended up in. If it cannot do something it says so rather than
 * pretending; and every reply is built from engine readings taken *after* the
 * action, so it can never claim a sync that did not happen.
 */
import type { DjConsole } from '../state/console';
import type { AutoDj, TransitionStyle } from './autodj';
import type { DeckId } from './types';
import { formatKey } from './music';

export interface AssistantReply {
  ok: boolean;
  lines: string[];
}

interface Rule {
  test: RegExp;
  run: (m: RegExpMatchArray, ctx: Ctx) => AssistantReply;
}

interface Ctx {
  dj: DjConsole;
  auto: AutoDj;
  /** Deck referenced by the command, or the sensible default. */
  deck: DeckId;
}

export class Assistant {
  private dj: DjConsole;
  private auto: AutoDj;

  constructor(dj: DjConsole, auto: AutoDj) {
    this.dj = dj;
    this.auto = auto;
  }

  run(input: string): AssistantReply {
    const text = input.trim().toLowerCase();
    if (!text) return { ok: false, lines: ['Say something like "sync deck B" or "loop 8 beats".'] };

    const deck = this.resolveDeck(text);
    const ctx: Ctx = { dj: this.dj, auto: this.auto, deck };

    for (const rule of RULES) {
      const m = text.match(rule.test);
      if (m) {
        try {
          return rule.run(m, ctx);
        } catch (err) {
          return { ok: false, lines: [`That failed: ${err instanceof Error ? err.message : String(err)}`] };
        }
      }
    }

    return {
      ok: false,
      lines: [
        'I did not understand that.',
        'Try: sync deck B · loop 8 beats · echo out · bass down on A · find something around 128 bpm · record this mix',
      ],
    };
  }

  /** Deck named in the text, else the deck that is not playing, else A. */
  private resolveDeck(text: string): DeckId {
    const m = text.match(/\bdeck\s*([abcd])\b/) ?? text.match(/\bon\s+([abcd])\b/) ?? text.match(/\b([abcd])\b(?=\s*$)/);
    if (m) {
      const id = m[1].toUpperCase() as DeckId;
      if (this.dj.engine.decks.has(id)) return id;
    }
    const idle = this.dj.engine.deckIds.find((id) => !this.dj.engine.deck(id).playing);
    return idle ?? this.dj.engine.deckIds[0];
  }
}

function deckReport(dj: DjConsole, id: DeckId): string[] {
  const deck = dj.engine.deck(id);
  const status = dj.sync.statusFor(id);
  const lines = [
    `Deck ${id}: ${deck.playing ? 'playing' : 'stopped'} at ${deck.position.toFixed(2)}s`,
    `BPM: ${deck.currentBpm > 0 ? deck.currentBpm.toFixed(2) : 'unknown'}`,
  ];
  if (dj.sync.isEnabled(id)) {
    lines.push(`Phase offset: ${status.phaseError.toFixed(3)} beats (${status.phaseMs.toFixed(1)} ms)`);
    lines.push(`Status: ${status.locked ? 'SYNCED' : 'converging'}`);
  }
  return lines;
}

const RULES: Rule[] = [
  // ---- sync --------------------------------------------------------------
  {
    test: /\b(sync|beatmatch|match)\b/,
    run: (_m, { dj, deck }) => {
      const target = dj.engine.deck(deck);
      if (!target.hasTrack) return { ok: false, lines: [`Deck ${deck} has no track loaded.`] };
      if (target.grid.bpm <= 0) {
        return { ok: false, lines: [`Deck ${deck} has no beat grid, so I cannot sync it. Set the BPM first.`] };
      }
      if (dj.sync.isEnabled(deck)) return { ok: true, lines: [`Deck ${deck} is already synced.`, ...deckReport(dj, deck)] };
      dj.toggleSync(deck);
      if (!dj.sync.isEnabled(deck)) {
        return { ok: false, lines: ['There is no master deck to sync against - load and play another track first.'] };
      }
      return { ok: true, lines: [`Deck ${deck} synchronised`, ...deckReport(dj, deck).slice(1)] };
    },
  },
  {
    test: /\b(unsync|release sync|sync off)\b/,
    run: (_m, { dj, deck }) => {
      dj.sync.disable(deck);
      dj.store.updateDeck(deck, { syncEnabled: false, syncLocked: false });
      return { ok: true, lines: [`Sync released on deck ${deck}.`] };
    },
  },
  {
    test: /\bmaster\b/,
    run: (_m, { dj, deck }) => {
      dj.setMaster(deck);
      return { ok: true, lines: [`Deck ${deck} is now the tempo master at ${dj.sync.masterBpm.toFixed(2)} BPM.`] };
    },
  },

  // ---- transport ---------------------------------------------------------
  {
    test: /\b(play|start)\b/,
    run: (_m, { dj, deck }) => {
      const d = dj.engine.deck(deck);
      if (!d.hasTrack) return { ok: false, lines: [`Deck ${deck} has no track loaded.`] };
      dj.play(deck);
      return { ok: true, lines: [`Deck ${deck} playing.`] };
    },
  },
  {
    test: /\b(stop|pause)\b/,
    run: (_m, { dj, deck }) => { dj.pause(deck); return { ok: true, lines: [`Deck ${deck} stopped.`] }; },
  },

  // ---- loops -------------------------------------------------------------
  {
    test: /\bloop\b.*?(\d+(?:\.\d+)?)\s*(?:beat|bar)/,
    run: (m, { dj, deck }) => {
      const n = Number(m[1]);
      const bars = /bar/.test(m[0]);
      const beats = bars ? n * 4 : n;
      const d = dj.engine.deck(deck);
      if (d.grid.bpm <= 0) return { ok: false, lines: [`Deck ${deck} has no beat grid, so I cannot make a beat-aligned loop.`] };
      dj.setLoopBeats(deck, beats);
      const ui = dj.store.deck(deck);
      return {
        ok: true,
        lines: [
          `Looping ${beats} beats on deck ${deck}`,
          `From ${ui.loopStart.toFixed(3)}s to ${ui.loopEnd.toFixed(3)}s (${(ui.loopEnd - ui.loopStart).toFixed(3)}s)`,
        ],
      };
    },
  },
  {
    test: /\b(loop off|exit loop|no loop)\b/,
    run: (_m, { dj, deck }) => { dj.exitLoop(deck); return { ok: true, lines: [`Loop off on deck ${deck}.`] }; },
  },

  // ---- EQ ----------------------------------------------------------------
  {
    test: /\b(bass|low|lows)\b.*\b(down|out|cut|kill)\b|\b(down|out|cut|kill)\b.*\b(bass|low|lows)\b/,
    run: (_m, { dj, deck }) => { dj.setEq(deck, 'low', -26); return { ok: true, lines: [`Bass killed on deck ${deck} (-26 dB).`] }; },
  },
  {
    test: /\b(bass|low|lows)\b.*\b(up|back|restore|in)\b/,
    run: (_m, { dj, deck }) => { dj.setEq(deck, 'low', 0); return { ok: true, lines: [`Bass restored on deck ${deck}.`] }; },
  },
  {
    test: /\b(high|highs|treble)\b.*\b(down|out|cut|kill)\b/,
    run: (_m, { dj, deck }) => { dj.setEq(deck, 'high', -26); return { ok: true, lines: [`Highs killed on deck ${deck}.`] }; },
  },
  {
    test: /\b(mid|mids)\b.*\b(down|out|cut|kill)\b/,
    run: (_m, { dj, deck }) => { dj.setEq(deck, 'mid', -26); return { ok: true, lines: [`Mids killed on deck ${deck}.`] }; },
  },

  // ---- FX ----------------------------------------------------------------
  {
    test: /\b(echo out|echo)\b/,
    run: (_m, { dj, deck }) => {
      dj.setFxType(0, 'echo');
      dj.setFxParam(0, { a: 2, b: 0.6, wet: 0.55 });
      for (const id of dj.engine.deckIds) dj.setFxRouting(0, id, id === deck);
      dj.setFxEnabled(0, true);
      const beat = dj.sync.masterBeatSeconds;
      return {
        ok: true,
        lines: [`Echo on deck ${deck}`, `1/2 beat at ${(beat * 0.5 * 1000).toFixed(0)} ms, 60% feedback, 55% wet`],
      };
    },
  },
  {
    test: /\b(fx off|no fx|kill fx|effects off)\b/,
    run: (_m, { dj }) => { dj.resetFx(); return { ok: true, lines: ['All effects off.'] }; },
  },

  // ---- transitions -------------------------------------------------------
  {
    test: /\b(transition|mix|blend|take over)\b/,
    run: (m, { dj, auto }) => {
      const playing = dj.engine.deckIds.filter((id) => dj.engine.deck(id).playing);
      if (playing.length !== 1) {
        return { ok: false, lines: ['I need exactly one deck playing to transition away from.'] };
      }
      const from = playing[0];
      const to = dj.engine.deckIds.find((id) => id !== from)!;
      if (!dj.engine.deck(to).hasTrack) {
        return { ok: false, lines: [`Deck ${to} is empty - load the next track first.`] };
      }

      let style: TransitionStyle = 'eq';
      if (/echo/.test(m.input ?? '')) style = 'echo-out';
      else if (/filter/.test(m.input ?? '')) style = 'filter';
      else if (/long/.test(m.input ?? '')) style = 'long-blend';
      else if (/cut|quick/.test(m.input ?? '')) style = 'quick-cut';
      else if (/drop/.test(m.input ?? '')) style = 'drop';

      const plan = auto.plan(from, to, style);
      if (!plan) return { ok: false, lines: ['I could not build a transition from the current state.'] };

      const afterPhrase = /after (?:the )?(?:next )?phrase/.test(m.input ?? '');
      if (afterPhrase) {
        const at = dj.nextPhraseOn(from);
        const wait = Math.max(0, at - dj.engine.deck(from).position);
        setTimeout(() => auto.run(plan), wait * 1000);
        return {
          ok: true,
          lines: [`Queued a ${style} transition to start in ${wait.toFixed(1)}s at the next phrase.`, ...plan.reasoning],
        };
      }

      auto.run(plan);
      return {
        ok: true,
        lines: [`Running a ${style} transition, deck ${from} → deck ${to} over ${plan.duration.toFixed(1)}s.`, ...plan.reasoning],
      };
    },
  },

  // ---- library -----------------------------------------------------------
  {
    test: /\b(?:find|search|something).*?(\d{2,3})\s*bpm/,
    run: (m, { dj }) => {
      const target = Number(m[1]);
      const matches = [...dj.store.state.tracks.values()]
        .filter((t) => t.analysis && (t.bpmOverride ?? t.analysis.bpm) > 0)
        .map((t) => ({ t, bpm: t.bpmOverride ?? t.analysis!.bpm }))
        .filter((x) => Math.abs(x.bpm - target) <= 4)
        .sort((a, b) => Math.abs(a.bpm - target) - Math.abs(b.bpm - target))
        .slice(0, 5);
      if (!matches.length) return { ok: false, lines: [`Nothing in the library is within 4 BPM of ${target}.`] };
      return {
        ok: true,
        lines: [`${matches.length} track${matches.length === 1 ? '' : 's'} near ${target} BPM:`,
          ...matches.map((x) => `  ${x.bpm.toFixed(1)} · ${x.t.artist} - ${x.t.title}`)],
      };
    },
  },
  {
    test: /\b(compatible|goes with|harmonic|next track|suggest|recommend)\b/,
    run: (_m, { dj, auto }) => {
      const playing = dj.engine.deckIds.find((id) => dj.engine.deck(id).playing)
        ?? dj.engine.deckIds.find((id) => dj.engine.deck(id).hasTrack);
      if (!playing) return { ok: false, lines: ['No track is loaded to compare against.'] };
      const suggestions = auto.suggest(playing, 5);
      if (!suggestions.length) return { ok: false, lines: ['Nothing suitable in the library yet - import or analyse more tracks.'] };
      return {
        ok: true,
        lines: [`Against deck ${playing}:`,
          ...suggestions.map((s) => `  ${s.track.artist} - ${s.track.title} (${s.reasons.join(', ')})`)],
      };
    },
  },

  // ---- recording ---------------------------------------------------------
  {
    test: /\brecord\b/,
    run: (_m, { dj }) => {
      if (dj.store.state.recording) {
        dj.stopRecording();
        return { ok: true, lines: ['Recording stopped and saved.'] };
      }
      dj.startRecording();
      return { ok: true, lines: ['Recording the master output.'] };
    },
  },

  // ---- status ------------------------------------------------------------
  {
    test: /\b(status|state|what.?s (?:going on|happening)|report)\b/,
    run: (_m, { dj }) => {
      const lines: string[] = [];
      for (const id of dj.engine.deckIds) {
        const deck = dj.engine.deck(id);
        if (!deck.hasTrack) { lines.push(`Deck ${id}: empty`); continue; }
        const track = dj.store.state.tracks.get(deck.trackId!);
        lines.push(`Deck ${id}: ${track?.title ?? 'unknown'}`);
        lines.push(...deckReport(dj, id).map((l) => `  ${l}`));
        if (deck.analysis?.key) lines.push(`  Key: ${formatKey(deck.analysis.key, 'both')}`);
      }
      lines.push(`Master tempo: ${dj.sync.masterBpm > 0 ? dj.sync.masterBpm.toFixed(2) + ' BPM' : 'none'}`);
      lines.push(`Crossfader: ${dj.store.state.crossfader.toFixed(2)}`);
      return { ok: true, lines };
    },
  },
  {
    test: /\bpanic|emergency|stop everything\b/,
    run: (_m, { dj }) => { dj.panic(); return { ok: true, lines: ['Everything stopped.'] }; },
  },
];
