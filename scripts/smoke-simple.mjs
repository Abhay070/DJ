/**
 * End-to-end test of Simple mode - the beginner path.
 *
 * Does exactly what someone using this for the first time would do: land on
 * the page, add some songs, press the one button, and wait. Asserts that the
 * console started playing, queued a second track, chose a sensible place to
 * join them, and matched their tempos - all without touching a deck control.
 *
 *   npm run build && npm run preview     # in one terminal
 *   npm run smoke:simple                 # in another
 */
import { chromium } from 'playwright';

const URL = process.env.APP_URL || 'http://localhost:4173';
const errors = [];

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.click('#start-btn');
await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });

// A first-time user should land in simple mode with the console hidden.
const landing = await page.evaluate(() => ({
  mode: document.body.dataset.uiMode,
  simpleVisible: !!document.querySelector('.simple')?.checkVisibility?.(),
  consoleVisible: !!document.querySelector('.console')?.checkVisibility?.(),
  bigButton: document.querySelector('.big-button')?.textContent?.trim(),
  bigButtonDisabled: document.querySelector('.big-button')?.disabled,
  headline: document.querySelector('.simple-headline')?.textContent,
}));
console.log('LANDING:', JSON.stringify(landing));

// Add music, the way the page tells you to.
await page.evaluate(async () => {
  function wav(bpm, seconds, freq, quietTail) {
    const sr = 44100, n = Math.round(seconds * sr);
    const buf = new ArrayBuffer(44 + n * 2), view = new DataView(buf);
    const s = (o, t) => { for (let i = 0; i < t.length; i++) view.setUint8(o + i, t.charCodeAt(i)); };
    s(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); s(8, 'WAVE'); s(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    s(36, 'data'); view.setUint32(40, n * 2, true);
    const beat = 60 / bpm;
    for (let i = 0; i < n; i++) {
      const t = i / sr, phase = t % beat;
      // Quiet intro and outro, loud middle - so the analyser has real
      // structure to find and the planner has a sensible place to blend.
      const frac = t / seconds;
      const shape = quietTail ? (frac < 0.15 ? 0.25 : frac > 0.75 ? 0.3 : 1) : 1;
      const kick = phase < 0.12 ? Math.sin(2 * Math.PI * (150 * Math.exp(-phase * 26) + 45) * phase) * Math.exp(-phase * 30) : 0;
      const tone = Math.sin(2 * Math.PI * freq * t) * 0.12;
      const v = Math.max(-1, Math.min(1, (kick * 0.8 + tone) * shape));
      view.setInt16(44 + i * 2, v * 32767, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }
  const files = [
    new File([wav(126, 100, 220, true)], 'Someone - First Song.wav', { type: 'audio/wav' }),
    new File([wav(128, 100, 330, true)], 'Someone - Second Song.wav', { type: 'audio/wav' }),
    new File([wav(124, 100, 165, true)], 'Someone - Third Song.wav', { type: 'audio/wav' }),
  ];
  await window.__dj.library.importFiles(files);
});

await page.waitForFunction(() => {
  const t = [...window.__dj.store.state.tracks.values()];
  return t.length >= 3 && t.every((x) => x.analysisState === 'done' || x.analysisState === 'failed');
}, { timeout: 180000 });

const counted = await page.textContent('.simple-count');
console.log('AFTER IMPORT:', counted);

// Press the one button.
await page.click('.big-button');
await page.waitForTimeout(3500);

const afterPress = await page.evaluate(() => {
  const dj = window.__dj;
  const playing = dj.engine.deckIds.filter((id) => dj.engine.deck(id).playing);
  const loaded = dj.engine.deckIds.filter((id) => dj.engine.deck(id).hasTrack);
  return {
    detail: document.querySelector('.simple-detail')?.textContent,
    headline: document.querySelector('.simple-headline')?.textContent,
    upNext: document.querySelector('.up-next')?.textContent,
    playing, loaded,
    bpm: Object.fromEntries(dj.engine.deckIds.map((id) => [id, dj.engine.deck(id).currentBpm])),
    syncOn: Object.fromEntries(dj.engine.deckIds.map((id) => [id, dj.sync.isEnabled(id)])),
    autoOn: dj.store.state.mixMode,
  };
});
console.log('AFTER PRESS:', JSON.stringify(afterPress, null, 1));

// Inspect the plan the console chose without waiting minutes for it.
const planned = await page.evaluate(() => {
  const dj = window.__dj;
  const from = dj.engine.deckIds.find((id) => dj.engine.deck(id).playing);
  const to = dj.engine.deckIds.find((id) => id !== from);
  const auto = window.__auto;
  const plan = auto.plan(from, to);
  if (!plan) return null;
  return {
    style: plan.style,
    exitAt: plan.startAt,
    entryAt: plan.entryAt,
    blend: plan.duration,
    outgoingDuration: dj.engine.deck(from).duration,
    summary: plan.summary,
    reasoning: plan.reasoning,
  };
});
console.log('PLAN:', JSON.stringify(planned, null, 1));

// Force the blend rather than waiting, and confirm both decks end up playing
// and beat-matched.
const blended = await page.evaluate(async () => {
  const dj = window.__dj;
  const msg = await window.__auto.blendNow();
  await new Promise((r) => setTimeout(r, 6000));
  const playing = dj.engine.deckIds.filter((id) => dj.engine.deck(id).playing);
  const follower = dj.engine.deckIds.find((id) => dj.sync.isEnabled(id));
  return {
    msg, playing,
    locked: follower ? dj.sync.statusFor(follower).locked : false,
    phaseMs: follower ? dj.sync.statusFor(follower).phaseMs : null,
    bpm: Object.fromEntries(dj.engine.deckIds.map((id) => [id, dj.engine.deck(id).currentBpm])),
    crossfader: dj.store.state.crossfader,
  };
});
console.log('BLEND:', JSON.stringify(blended, null, 1));

if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

const failures = [];
const check = (name, ok, detail) => { if (!ok) failures.push(`${name}: ${detail}`); };

check('lands in simple mode', landing.mode === 'simple', landing.mode);
check('console hidden at first', landing.consoleVisible === false, `visible=${landing.consoleVisible}`);
check('button disabled with no music', landing.bigButtonDisabled === true, 'button was enabled');
check('one press starts a track', afterPress.playing.length >= 1, JSON.stringify(afterPress.playing));
check('one press queues the next', afterPress.loaded.length === 2, JSON.stringify(afterPress.loaded));
check('next track tempo-matched', Math.abs(afterPress.bpm.A - afterPress.bpm.B) < 0.5,
  `${afterPress.bpm.A} vs ${afterPress.bpm.B}`);
check('auto mixing is on', afterPress.autoOn === 'autodj', afterPress.autoOn);
check('status is a sentence', (afterPress.detail || '').length > 25, afterPress.detail);
check('a plan exists', planned !== null, 'planner returned nothing');
if (planned) {
  check('blend point is late in the track', planned.exitAt > planned.outgoingDuration * 0.4,
    `${planned.exitAt} of ${planned.outgoingDuration}`);
  check('blend point leaves room', planned.exitAt < planned.outgoingDuration,
    `${planned.exitAt} of ${planned.outgoingDuration}`);
  check('plan explains itself', planned.reasoning.length > 0, 'no reasoning');
  check('summary is readable', /Blending/.test(planned.summary), planned.summary);
}
check('both decks play during the blend', blended.playing.length === 2, JSON.stringify(blended.playing));
check('beats locked during the blend', blended.locked, `phase ${blended.phaseMs}`);
check('tempos matched during the blend', Math.abs(blended.bpm.A - blended.bpm.B) < 0.5,
  `${blended.bpm.A} vs ${blended.bpm.B}`);

console.log('ERRORS:', errors.length ? JSON.stringify(errors, null, 1) : 'none');
if (failures.length) { console.log('FAILED CHECKS:'); for (const f of failures) console.log('  -', f); }
else console.log('ALL CHECKS PASSED');

await browser.close();
process.exit(errors.length || failures.length ? 1 : 0);
