import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEngine } from '../src/audio/sync';
import type { Deck } from '../src/audio/deck';
import type { DeckId, BeatGrid } from '../src/lib/types';
import { beatAt } from '../src/lib/grid';

/**
 * A simulated deck: a playhead that advances at whatever rate the engine sets,
 * exactly as the worklet's does. Nothing here fakes the phase relationship -
 * the controller has to earn convergence by driving the rate.
 */
class FakeDeck {
  grid: BeatGrid;
  position = 0;
  playing = false;
  duration = 600;
  trackId: string | null = 'track';
  baseRate = 1;
  syncTrim = 1;
  bendFactor = 1;
  keyLock = true;
  keyShift = 0;
  scratching = false;
  analysis = null;
  seekCount = 0;
  playStartedAt: number | null = null;

  constructor(bpm: number, firstBeat = 0) {
    this.grid = { firstBeat, bpm, downbeatOffset: 0, locked: false };
  }

  get hasTrack() { return this.trackId !== null; }
  get targetRate() { return this.baseRate * this.syncTrim * this.bendFactor; }
  get currentBpm() { return this.grid.bpm * this.targetRate; }
  get beatPosition() { return beatAt(this.grid, this.position); }

  setBaseRate(r: number) { this.baseRate = r; }
  setSyncTrim(t: number) { this.syncTrim = t; }
  setBend(b: number) { this.bendFactor = b; }
  seek(p: number) { this.position = Math.max(0, Math.min(this.duration, p)); this.seekCount++; }
  timeAtBeat(beat: number) { return this.grid.firstBeat + beat * (60 / this.grid.bpm); }
  play() { this.playing = true; if (this.playStartedAt === null) this.playStartedAt = FakeDeck.clock++; }
  pause() { this.playing = false; this.playStartedAt = null; }
  static clock = 1;

  /** Advance the playhead by `dt` seconds of wall time at the current rate. */
  advance(dt: number) { if (this.playing) this.position += dt * this.targetRate; }
}

function makeDecks(bpmA: number, bpmB: number, offsetB = 0) {
  const a = new FakeDeck(bpmA);
  const b = new FakeDeck(bpmB, offsetB);
  const decks = new Map<DeckId, Deck>([
    ['A', a as unknown as Deck],
    ['B', b as unknown as Deck],
  ]);
  return { a, b, decks, sync: new SyncEngine(decks) };
}

/** Drive the controller's rAF loop by hand at a fixed simulated frame rate. */
function runFrames(sync: SyncEngine, decks: FakeDeck[], seconds: number, fps = 60) {
  const dt = 1 / fps;
  const frames = Math.round(seconds * fps);
  for (let i = 0; i < frames; i++) {
    // The engine reads positions, then decks advance - the same ordering the
    // real system has, where the controller always sees slightly stale data.
    (sync as unknown as { update(dt: number): void }).update(dt);
    for (const d of decks) d.advance(dt);
  }
}

let raf: number;
beforeEach(() => {
  raf = 0;
  // Stub rAF so ensureRunning() does not schedule anything; the tests step the
  // controller explicitly to keep the simulation deterministic.
  vi.stubGlobal('requestAnimationFrame', () => ++raf);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('performance', { now: () => 0 });
});
afterEach(() => vi.unstubAllGlobals());

describe('master deck selection', () => {
  it('picks the playing deck as master', () => {
    const { a, sync } = makeDecks(128, 124);
    a.play();
    expect(sync.resolveMaster()).toBe('A');
  });

  it('falls back to a loaded deck before anything plays', () => {
    const { sync } = makeDecks(128, 124);
    expect(sync.resolveMaster()).not.toBeNull();
  });

  it('never makes a follower the master', () => {
    const { a, b, sync } = makeDecks(128, 124);
    a.play();
    b.play();
    sync.enable('B');
    expect(sync.resolveMaster()).toBe('A');
  });

  it('honours an explicit master and drops that deck from following', () => {
    const { a, b, sync } = makeDecks(128, 124);
    a.play(); b.play();
    sync.enable('B');
    sync.setMaster('B');
    expect(sync.resolveMaster()).toBe('B');
    expect(sync.isEnabled('B')).toBe(false);
  });

  it('picks the deck that was started first, not the one further along', () => {
    const { a, b, sync } = makeDecks(128, 124);
    a.play();
    b.play();
    // The follower's timeline advances faster once tempo-matched, so it
    // overtakes the master's position. That must not change who leads.
    a.position = 10;
    b.position = 45;
    expect(sync.resolveMaster()).toBe('A');
  });

  it('is not decided by which deck reports itself playing first', () => {
    const { a, b, sync } = makeDecks(128, 124);
    // Play requested on A first, but B's fade-in completes first - the exact
    // race that used to hand the master to the wrong deck and leave SYNC
    // silently refusing to engage.
    a.play();
    a.playing = false;
    b.play();
    expect(sync.resolveMaster()).toBe('A');

    a.playing = true;
    expect(sync.resolveMaster()).toBe('A');
  });

  it('hands the lead on when the master is stopped', () => {
    const { a, b, sync } = makeDecks(128, 124);
    a.play();
    b.play();
    expect(sync.resolveMaster()).toBe('A');
    a.pause();
    expect(sync.resolveMaster()).toBe('B');
  });

  it('lets sync engage immediately after both decks are started', () => {
    const { a, b, sync } = makeDecks(128, 124);
    a.play();
    b.play();
    const status = sync.enable('B');
    expect(status.enabled).toBe(true);
    expect(sync.isEnabled('B')).toBe(true);
    expect(b.baseRate).toBeCloseTo(128 / 124, 9);
  });

  it('reports no master when nothing has a grid', () => {
    const { a, b, sync } = makeDecks(0, 0);
    a.trackId = null; b.trackId = null;
    expect(sync.resolveMaster()).toBeNull();
    expect(sync.masterBpm).toBe(0);
  });
});

describe('tempo matching', () => {
  it('sets the follower rate to the tempo ratio', () => {
    const { a, b, sync } = makeDecks(128, 124);
    a.play();
    sync.enable('B');
    expect(b.baseRate).toBeCloseTo(128 / 124, 9);
    expect(b.currentBpm).toBeCloseTo(128, 6);
  });

  it('follows the master when its pitch fader moves', () => {
    const { a, b, sync } = makeDecks(128, 124);
    a.play(); b.play();
    sync.enable('B');
    a.setBaseRate(1.04); // master pitched up
    runFrames(sync, [a, b], 0.5);
    expect(b.currentBpm).toBeCloseTo(a.currentBpm, 1);
  });

  it('refuses to sync a deck with no beat grid', () => {
    const { a, b, sync } = makeDecks(128, 0);
    a.play();
    b.grid = { firstBeat: 0, bpm: 0, downbeatOffset: 0, locked: false };
    const status = sync.enable('B');
    expect(status.enabled).toBe(false);
    expect(sync.isEnabled('B')).toBe(false);
  });

  it('releases the trim when sync is turned off', () => {
    const { a, b, sync } = makeDecks(128, 124);
    a.play(); b.play();
    sync.enable('B');
    runFrames(sync, [a, b], 1);
    sync.disable('B');
    expect(b.syncTrim).toBe(1);
    expect(sync.statusFor('B').enabled).toBe(false);
  });
});

describe('phase lock', () => {
  it('converges to a locked phase and stays there', () => {
    const { a, b, sync } = makeDecks(128, 124);
    a.play(); b.play();
    a.position = 10;
    b.position = 10.13; // well out of phase
    sync.enable('B');

    runFrames(sync, [a, b], 12);
    const status = sync.statusFor('B');

    expect(status.locked).toBe(true);
    expect(Math.abs(status.phaseError)).toBeLessThan(0.004);
    expect(Math.abs(status.phaseMs)).toBeLessThan(2);
  });

  it('holds lock over a long run without drifting', () => {
    const { a, b, sync } = makeDecks(128, 124);
    a.play(); b.play();
    sync.enable('B');
    runFrames(sync, [a, b], 10);
    expect(sync.statusFor('B').locked).toBe(true);

    // Five more minutes of playback.
    runFrames(sync, [a, b], 300);
    const status = sync.statusFor('B');
    expect(status.locked).toBe(true);
    expect(Math.abs(status.phaseMs)).toBeLessThan(2);
  });

  it('recovers after the master is nudged out from under it', () => {
    const { a, b, sync } = makeDecks(128, 124);
    a.play(); b.play();
    sync.enable('B');
    runFrames(sync, [a, b], 10);
    expect(sync.statusFor('B').locked).toBe(true);

    // Shove the master a quarter beat.
    a.position += 0.117;
    runFrames(sync, [a, b], 15);
    expect(sync.statusFor('B').locked).toBe(true);
  });

  it('corrects phase by trimming rate, never by jumping the playhead', () => {
    const { a, b, sync } = makeDecks(128, 124);
    a.play(); b.play();
    a.position = 20;
    b.position = 20.09;
    sync.enable('B');
    const seeksAfterEnable = b.seekCount;

    runFrames(sync, [a, b], 12);

    // A small error is closed by rate alone. Seeking here would be audible.
    expect(b.seekCount).toBe(seeksAfterEnable);
    expect(b.syncTrim).not.toBe(1);
    expect(sync.statusFor('B').locked).toBe(true);
  });

  it('keeps the rate trim small enough to be inaudible', () => {
    const { a, b, sync } = makeDecks(128, 124);
    a.play(); b.play();
    a.position = 5;
    b.position = 5.2;
    sync.enable('B');
    for (let i = 0; i < 60 * 20; i++) {
      (sync as unknown as { update(dt: number): void }).update(1 / 60);
      a.advance(1 / 60);
      b.advance(1 / 60);
      // Never more than a few percent - a real DJ's nudge, not a lurch.
      expect(Math.abs(b.syncTrim - 1)).toBeLessThanOrEqual(0.0401);
    }
  });

  it('does not report a lock while the follower is stopped', () => {
    const { a, b, sync } = makeDecks(128, 124);
    a.play();
    b.pause();
    sync.enable('B');
    runFrames(sync, [a, b], 2);
    const status = sync.statusFor('B');
    expect(status.locked).toBe(false);
    expect(b.syncTrim).toBe(1);
  });

  it('stands down while the follower is being scratched', () => {
    const { a, b, sync } = makeDecks(128, 124);
    a.play(); b.play();
    sync.enable('B');
    runFrames(sync, [a, b], 5);
    b.scratching = true;
    runFrames(sync, [a, b], 1);
    expect(b.syncTrim).toBe(1);
    expect(sync.statusFor('B').locked).toBe(false);
  });
});

describe('phase alignment on engage', () => {
  it('snaps a stopped deck onto the master beat', () => {
    const { a, b, sync } = makeDecks(128, 128);
    a.play();
    a.position = 10.31;
    b.position = 3.07;
    b.pause();
    sync.enable('B');

    // Both grids are 128 BPM from zero, so aligned positions differ by whole
    // bars only.
    const beatA = beatAt(a.grid, a.position);
    const beatB = beatAt(b.grid, b.position);
    const diff = Math.abs(beatA - beatB);
    expect(Math.abs(diff - Math.round(diff))).toBeLessThan(1e-6);
    expect(b.seekCount).toBeGreaterThan(0);
  });

  it('leaves a playing deck alone when it is already close', () => {
    const { a, b, sync } = makeDecks(128, 128);
    a.play(); b.play();
    a.position = 10;
    b.position = 10.02; // well under a quarter beat out
    const before = b.position;
    sync.enable('B');
    expect(b.position).toBe(before);
  });

  it('forces alignment when asked explicitly', () => {
    const { a, b, sync } = makeDecks(128, 128);
    a.play(); b.play();
    a.position = 10;
    b.position = 10.02;
    sync.enable('B');
    sync.alignPhase('B', true);
    const diff = Math.abs(beatAt(a.grid, a.position) - beatAt(b.grid, b.position));
    expect(Math.abs(diff - Math.round(diff))).toBeLessThan(1e-6);
  });

  it('aligns downbeats to downbeats when bar sync is on', () => {
    const { a, b, sync } = makeDecks(128, 128);
    sync.barSync = true;
    a.play();
    a.position = 10;      // some beat
    b.pause();
    b.position = 0.4;
    sync.enable('B');

    const barA = (beatAt(a.grid, a.position)) / 4;
    const barB = (beatAt(b.grid, b.position)) / 4;
    const diff = Math.abs(barA - barB);
    expect(Math.abs(diff - Math.round(diff))).toBeLessThan(1e-6);
  });
});

describe('starting a deck already in phase', () => {
  it('shifts the requested start onto the master beat', () => {
    const { a, b, sync } = makeDecks(128, 128);
    a.play();
    a.position = 10.31;

    const wanted = 32.17;
    const aligned = sync.alignedStartPosition('B', wanted);

    // The adjustment is small - it only moves to the nearest in-phase point.
    expect(Math.abs(aligned - wanted)).toBeLessThanOrEqual(2 * (60 / 128) + 1e-9);

    // And starting there really is in phase with the master.
    const beatA = beatAt(a.grid, a.position);
    const beatB = beatAt(b.grid, aligned);
    const diff = Math.abs(beatA - beatB);
    expect(Math.abs(diff - Math.round(diff))).toBeLessThan(1e-6);
  });

  it('means the controller has almost nothing left to correct', () => {
    const { a, b, sync } = makeDecks(128, 124);
    a.play();
    a.position = 20.37;

    // Cue the follower where the transition planner asked for, adjusted.
    b.position = sync.alignedStartPosition('B', 41.83);
    b.play();
    sync.enable('B');

    // One controller tick, not six seconds of pulling in.
    runFrames(sync, [a, b], 0.2);
    expect(Math.abs(sync.statusFor('B').phaseError)).toBeLessThan(0.02);
  });

  it('locks almost immediately from an aligned start', () => {
    const { a, b, sync } = makeDecks(128, 124);
    a.play();
    a.position = 20.37;
    b.position = sync.alignedStartPosition('B', 41.83);
    b.play();
    sync.enable('B');
    runFrames(sync, [a, b], 1.5);
    expect(sync.statusFor('B').locked).toBe(true);
  });

  it('leaves the position alone when there is no master playing', () => {
    const { sync } = makeDecks(128, 124);
    expect(sync.alignedStartPosition('B', 12.34)).toBe(12.34);
  });

  it('never pushes the start outside the track', () => {
    const { a, b, sync } = makeDecks(128, 128);
    a.play();
    a.position = 10;
    b.duration = 100;
    // Right at the very end, where an adjustment could overshoot.
    const aligned = sync.alignedStartPosition('B', 99.9);
    expect(aligned).toBeGreaterThanOrEqual(0);
    expect(aligned).toBeLessThanOrEqual(100);
  });
});

describe('quantised scheduling', () => {
  it('returns the next beat boundary ahead of the given time', () => {
    const { a, sync } = makeDecks(128, 124);
    a.play();
    a.position = 10.1;
    const next = sync.nextBeatTime(100, 1);
    expect(next).toBeGreaterThan(100);
    expect(next).toBeLessThanOrEqual(100 + 60 / 128 + 1e-9);
  });

  it('returns the given time unchanged when nothing is playing', () => {
    const { sync } = makeDecks(128, 124);
    expect(sync.nextBeatTime(42)).toBe(42);
  });
});

describe('measured phase', () => {
  it('reports the live offset whether or not sync is engaged', () => {
    const { a, b, sync } = makeDecks(128, 128);
    a.play(); b.play();
    a.position = 10;
    b.position = 10 + (60 / 128) * 0.25; // a quarter beat late
    expect(sync.measuredPhase('B')).toBeCloseTo(-0.25, 3);
  });

  it('reports zero against itself', () => {
    const { a, sync } = makeDecks(128, 128);
    a.play();
    expect(sync.measuredPhase('A')).toBe(0);
  });
});
