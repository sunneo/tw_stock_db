// node scripts/tts-tests/voice_clean.test.js -- 參考錄音清理：降噪、爆音修補、挑最好的一段、錯誤翻譯
const C = require('../../renderer/src/tts/voice_clean.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const RATE = 24000;
function rnd(seed) { let a = seed >>> 0 || 1; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
// 像人聲的合成訊號：音高 140Hz 的諧波、音節式起伏（約 4 個音節／秒，中間有停頓）
function voice(sec, seed) {
  const n = Math.round(sec * RATE), out = new Float32Array(n), r = rnd(seed || 1);
  for (let i = 0; i < n; i++) {
    const t = i / RATE, syl = Math.max(0, Math.sin(2 * Math.PI * 2.2 * t)) ** 0.5, f0 = 140 + 15 * Math.sin(2 * Math.PI * 0.7 * t); let s = 0;
    for (let h = 1; h <= 14; h++) s += Math.sin(2 * Math.PI * f0 * h * t) / h * Math.exp(-Math.pow((f0 * h - 700) / 900, 2));
    out[i] = 0.25 * s * syl;
  }
  return out;
}
function addNoise(v, snrDb, seed, hum) {
  const r = rnd(seed), out = new Float32Array(v.length); let talk = 0, c = 0; for (let i = 0; i < v.length; i++) if (Math.abs(v[i]) > 0.01) { talk += v[i] * v[i]; c++; }
  const talkRms = Math.sqrt(talk / Math.max(1, c)), nRms = talkRms / Math.pow(10, snrDb / 20);
  for (let i = 0; i < v.length; i++) { const w = (r() + r() + r() + r() - 2) * 1.7; out[i] = v[i] + nRms * w + (hum ? nRms * 0.8 * Math.sin(2 * Math.PI * 50 * i / RATE) : 0); }
  return out;
}
function rms(a) { let t = 0; for (let i = 0; i < a.length; i++) t += a[i] * a[i]; return Math.sqrt(t / a.length); }
function corr(a, b) { const n = Math.min(a.length, b.length); let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += a[i] * b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; } return sab / Math.sqrt(saa * sbb + 1e-12); }

check('fft: a pure tone shows up in the right bin and the inverse restores the signal', (() => {
  const N = C.N, re = new Float32Array(N), im = new Float32Array(N); for (let i = 0; i < N; i++) re[i] = Math.sin(2 * Math.PI * 16 * i / N); const orig = Float32Array.from(re);
  C.fft(re, im, false); let mx = 0, at = 0; for (let k = 0; k < N / 2; k++) { const m = Math.hypot(re[k], im[k]); if (m > mx) { mx = m; at = k; } }
  C.fft(re, im, true); let err = 0; for (let i = 0; i < N; i++) err = Math.max(err, Math.abs(re[i] / N - orig[i])); return at === 16 && err < 1e-4;
})());

const clean = voice(8, 3), noisy = addNoise(clean, 0, 9, true), r0 = C.clean(noisy, RATE, { maxSec: 20 });
check('clean: a recording whose noise is as loud as the voice (0 dB) comes out much cleaner (SNR up by 12+ dB) and still resembles the voice', r0.report.denoised && r0.report.snrAfter - r0.report.snrBefore >= 12 && corr(r0.samples, (() => { const s = new Float32Array(clean.length); const g = r0.samples.length / clean.length; return clean; })()) > corr(noisy, clean) + 0.1, [r0.report, corr(r0.samples, clean), corr(noisy, clean)]);
check('clean: the result is finite, normalised to about -1 dBFS, and as long as the input when it is shorter than the window', Array.from(r0.samples).every(Number.isFinite) && Math.abs(Math.max.apply(null, Array.from(r0.samples).map(Math.abs)) - 0.89) < 0.02 && r0.samples.length === noisy.length, [r0.samples.length, noisy.length]);
const mild = addNoise(clean, 18, 4, false), r1 = C.clean(mild, RATE), quiet = C.clean(voice(6, 5), RATE);
check('clean: a mild noise gets a light touch (the voice is kept: correlation stays above 0.9); a noise-free recording skips the denoise step', corr(r1.samples, clean) > 0.9 && quiet.report.denoised === false, [corr(r1.samples, clean), quiet.report]);
check('clean: a very noisy one (-3 dB, voice buried) still returns something usable and improves', (() => { const r = C.clean(addNoise(clean, -3, 11, true), RATE, { maxSec: 20 }); return r.report.snrAfter > r.report.snrBefore + 8 && Array.from(r.samples).every(Number.isFinite); })());

// 爆音
const loud = Float32Array.from(clean, (v) => Math.max(-1, Math.min(1, v * 9))), rl = C.clean(loud, RATE, { denoise: false });
check('clean: a clipped (flat-topped) recording is repaired and reported', rl.report.steps.some((s) => /爆音/.test(s)) && Array.from(rl.samples).every(Number.isFinite));

// 直流偏移與低頻
const dc = Float32Array.from(clean, (v, i) => v + 0.2 + 0.1 * Math.sin(2 * Math.PI * 20 * i / RATE)), hp = C.highpass(dc, RATE);
check('highpass: removes the DC offset and the 20 Hz rumble', Math.abs(hp.reduce((a, b) => a + b, 0) / hp.length) < 0.01 && rms(hp) < rms(dc) * 0.5);

// 挑最好的一段：前 10 秒只有雜音、後面才有人聲
const junk = addNoise(new Float32Array(10 * RATE), 0, 21, false), speech = addNoise(voice(14, 6), 12, 22, false), long = new Float32Array(junk.length + speech.length); long.set(junk, 0); long.set(speech, junk.length);
const w = C.bestWindow(long, RATE, 12);
check('bestWindow: picks the part with a voice, not the noisy start; a short recording is taken whole', w.start >= 9 * RATE && w.end - w.start === 12 * RATE && C.bestWindow(clean, RATE, 12).end === clean.length, [w.start / RATE, w.end / RATE]);
check('clean: a long recording is cut to the best window', C.clean(long, RATE, { maxSec: 12, denoise: false }).report.seconds <= 12.01);
check('clean: a tiny recording does not crash', Array.from(C.clean(new Float32Array(500), RATE).samples).length === 500 && C.clean(new Float32Array(0), RATE).samples.length === 0);

// 錯誤翻譯
check('explainEngineError: a bare number becomes a readable message that is worth retrying; an ordinary message is kept and not retried', (() => { const a = C.explainEngineError(new Error('11864224')), b = C.explainEngineError('文字切不出可以念的內容'), c = C.explainEngineError(11864224); return /代碼 11864224/.test(a.text) && a.retry && /記憶體/.test(a.text) && !b.retry && b.text === '文字切不出可以念的內容' && c.retry; })());
check('LADDER: starts as before and ends with the shortest reference; fresh engine from the second step on', C.LADDER[0].frames === 250 && !C.LADDER[0].fresh && C.LADDER[1].fresh && C.LADDER[C.LADDER.length - 1].frames <= 60);
console.log('voice_clean: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED\n - ' + bad.join('\n - ') : '')); process.exit(bad.length ? 1 : 0);
