/**
 * End-to-end smoke test in a real browser.
 *
 * Unit tests prove the algorithms; this proves the assembled application. It
 * boots the built app in Chromium, starts the audio engine, generates two WAV
 * files at known tempos, pushes them through the real import and analysis
 * path, loads both decks, plays them, engages sync, and then asserts on what
 * the engine reports - tempo detected, phase locked, loop length, recording.
 *
 *   npm run build && npm run preview     # in one terminal
 *   npm run smoke                        # in another
 *
 * Exits non-zero if the page logged any error.
 */
import { chromium } from 'playwright';

const URL = process.env.APP_URL || 'http://localhost:4173';
const errors = [];
const logs = [];
void logs;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: [
    '--autoplay-policy=no-user-gesture-required',
    // Render audio without a sound card present.
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
});
const page = await browser.newPage();
page.on('console', (m) => {
  logs.push(`${m.type()}: ${m.text()}`);
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(URL, { waitUntil: 'networkidle' });
console.log('LOADED:', await page.title());

// Cross-origin isolation is what enables the SharedArrayBuffer playhead.
console.log('crossOriginIsolated:', await page.evaluate(() => self.crossOriginIsolated));

await page.click('#start-btn');
await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
console.log('ENGINE STARTED');

// Wait for the engine to be fully wired.
await page.waitForFunction(() => document.querySelectorAll('.deck').length >= 2, { timeout: 10000 });
const deckCount = await page.locator('.deck').count();
console.log('DECKS:', deckCount);

// Generate two test tracks in-page and push them through the real import path.
const imported = await page.evaluate(async () => {
  function wav(bpm, seconds, freq) {
    const sr = 44100;
    const n = Math.round(seconds * sr);
    const buf = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buf);
    const s = (o, t) => { for (let i = 0; i < t.length; i++) view.setUint8(o + i, t.charCodeAt(i)); };
    s(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); s(8, 'WAVE'); s(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    s(36, 'data'); view.setUint32(40, n * 2, true);
    const beat = 60 / bpm;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const phase = t % beat;
      // Kick on each beat plus a steady tone, so analysis has something real.
      const kick = phase < 0.12 ? Math.sin(2 * Math.PI * (150 * Math.exp(-phase * 26) + 45) * phase) * Math.exp(-phase * 30) : 0;
      const tone = Math.sin(2 * Math.PI * freq * t) * 0.12;
      const v = Math.max(-1, Math.min(1, kick * 0.8 + tone));
      view.setInt16(44 + i * 2, v * 32767, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  const dj = window.__dj;
  if (!dj) return { error: 'console handle not exposed' };

  const files = [
    new File([wav(124, 20, 220)], 'Test Artist - Track A.wav', { type: 'audio/wav' }),
    new File([wav(128, 20, 330)], 'Test Artist - Track B.wav', { type: 'audio/wav' }),
  ];
  const ids = await dj.library.importFiles(files);
  return { ids };
});
console.log('IMPORTED:', JSON.stringify(imported));
if (imported.error) { errors.push(imported.error); }

// Wait for analysis of both tracks to finish.
await page.waitForFunction(
  () => {
    const dj = window.__dj;
    if (!dj) return false;
    const tracks = [...dj.store.state.tracks.values()];
    return tracks.length >= 2 && tracks.every((t) => t.analysisState === 'done' || t.analysisState === 'failed');
  },
  { timeout: 90000 },
);

const analysis = await page.evaluate(() => [...window.__dj.store.state.tracks.values()].map((t) => ({
  title: t.title,
  state: t.analysisState,
  error: t.analysisError ?? null,
  bpm: t.analysis?.bpm ?? null,
  conf: t.analysis?.bpmConfidence?.toFixed(2) ?? null,
  key: t.analysis?.key ? `${t.analysis.key.tonic}${t.analysis.key.mode}` : null,
  beats: t.analysis?.beats.length ?? 0,
  loudness: t.analysis?.loudness?.toFixed(1) ?? null,
})));
console.log('ANALYSIS:', JSON.stringify(analysis, null, 1));

// Load onto both decks and play.
const playback = await page.evaluate(async () => {
  const dj = window.__dj;
  const ids = [...dj.store.state.tracks.keys()];
  await dj.loadTrack('A', ids[0], { force: true });
  await dj.loadTrack('B', ids[1], { force: true });
  dj.play('A');
  dj.play('B');
  await new Promise((r) => setTimeout(r, 1500));
  return {
    a: { pos: dj.engine.deck('A').position, playing: dj.engine.deck('A').playing, bpm: dj.engine.deck('A').currentBpm },
    b: { pos: dj.engine.deck('B').position, playing: dj.engine.deck('B').playing, bpm: dj.engine.deck('B').currentBpm },
    masterMeter: dj.engine.masterMeter.peakL,
  };
});
console.log('PLAYBACK:', JSON.stringify(playback));

// Engage sync and let the controller converge.
const synced = await page.evaluate(async () => {
  const dj = window.__dj;
  dj.toggleSync('B');
  await new Promise((r) => setTimeout(r, 6000));
  const st = dj.sync.statusFor('B');
  return {
    master: dj.sync.resolveMaster(),
    masterBpm: dj.sync.masterBpm,
    enabled: dj.sync.isEnabled('B'),
    locked: st.locked,
    phaseMs: st.phaseMs,
    bpmA: dj.engine.deck('A').currentBpm,
    bpmB: dj.engine.deck('B').currentBpm,
  };
});
console.log('SYNC:', JSON.stringify(synced));

// Loop, FX, sampler, recording.
const features = await page.evaluate(async () => {
  const dj = window.__dj;
  dj.setLoopBeats('A', 4);
  await new Promise((r) => setTimeout(r, 300));
  const loopActive = dj.engine.deck('A').state.loopActive;
  const ui = dj.store.deck('A');
  const loopLen = ui.loopEnd - ui.loopStart;
  const expected = 4 * (60 / dj.engine.deck('A').grid.bpm);

  dj.setFxType(0, 'echo');
  dj.setFxParam(0, { wet: 0.5 });
  dj.setFxEnabled(0, true);

  dj.startRecording();
  await new Promise((r) => setTimeout(r, 1200));
  const recDuration = dj.engine.recorder.duration;
  dj.exitLoop('A');

  return { loopActive, loopLen, expected, recDuration, fxOn: dj.store.state.fx[0].enabled };
});
console.log('FEATURES:', JSON.stringify(features));

if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: false });
// Assertions on what the engine actually reported.
const failures = [];
const check = (name, ok, detail) => { if (!ok) failures.push(`${name}: ${detail}`); };

check('analysis completed', analysis.every((t) => t.state === 'done'),
  JSON.stringify(analysis.map((t) => [t.title, t.state, t.error])));
check('tempo A within 1 BPM of 124', Math.abs((analysis[0]?.bpm ?? 0) - 124) < 1, `got ${analysis[0]?.bpm}`);
check('tempo B within 1 BPM of 128', Math.abs((analysis[1]?.bpm ?? 0) - 128) < 1, `got ${analysis[1]?.bpm}`);
check('both decks playing', playback.a.playing && playback.b.playing, JSON.stringify(playback));
check('master bus has signal', playback.masterMeter > 0.01, `peak ${playback.masterMeter}`);
check('sync engaged', synced.enabled, JSON.stringify(synced));
check('sync locked', synced.locked, JSON.stringify(synced));
check('phase within 5 ms', Math.abs(synced.phaseMs) < 5, `${synced.phaseMs} ms`);
check('follower matched master tempo', Math.abs(synced.bpmA - synced.bpmB) < 0.5,
  `${synced.bpmA} vs ${synced.bpmB}`);
check('loop is active', features.loopActive, 'engine reported no active loop');
check('loop length is exactly 4 beats', Math.abs(features.loopLen - features.expected) < 1e-9,
  `${features.loopLen} vs ${features.expected}`);
check('recording captured audio', features.recDuration > 0.5, `${features.recDuration}s`);
check('fx engaged', features.fxOn, 'fx unit reported off');

console.log('ERRORS:', errors.length ? JSON.stringify(errors, null, 1) : 'none');
if (failures.length) {
  console.log('FAILED CHECKS:');
  for (const f of failures) console.log('  -', f);
} else {
  console.log('ALL CHECKS PASSED');
}
await browser.close();
process.exit(errors.length || failures.length ? 1 : 0);
