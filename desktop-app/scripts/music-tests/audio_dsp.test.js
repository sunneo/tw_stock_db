// node scripts/music-tests/audio_dsp.test.js -- 高通(零相位、沒有訊號不放大)、音高校準估計、校準計畫(不動／整體／漂移／突跳不修)、時間對應
const DSP = require('../../renderer/src/music/audio_dsp.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const SR = 22050;
// 用相位累加產生「音分偏移」的聲音:freqs 是 [Hz, 振幅] 的清單,offCents 讓整體頻率偏離
function tones(sec, list, offCents) { const n = Math.floor(sec * SR), x = new Float32Array(n); const k = Math.pow(2, (offCents || 0) / 1200); for (const [f, a] of list) { let ph = 0; for (let i = 0; i < n; i++) { x[i] += a * Math.sin(ph); ph += 2 * Math.PI * f * k / SR; } } return x; }
const CHORD = [[220, 0.3], [329.63, 0.2], [440, 0.3], [523.25, 0.2], [659.26, 0.15]];
const peak = (x) => { let p = 0; for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i])); return p; };

// 1. 高通
const low60 = tones(2, [[60, 1]]);
const hp60 = DSP.highpass(low60, SR, 200);
check('highpass: pure 60 Hz is removed (output is zero, not amplified)', peak(hp60) === 0, peak(hp60));
const silence = new Float32Array(SR); for (let i = 0; i < silence.length; i++) silence[i] = 1e-6 * Math.sin(i);
check('highpass: near-silent input returns zeros (no amplified float residue)', peak(DSP.highpass(silence, SR, 200)) === 0);
const mix = tones(2, [[60, 0.8], [1000, 0.4]]);
const hpm = DSP.highpass(mix, SR, 200);
check('highpass: mixture keeps the 1 kHz part (peak normalized to input peak)', Math.abs(peak(hpm) - peak(mix)) < 1e-3, [peak(hpm), peak(mix)]);
const click = new Float32Array(SR); click[5000] = 1; const hpc = DSP.highpass(click, SR, 200);
let argmax = 0; for (let i = 0; i < hpc.length; i++) if (Math.abs(hpc[i]) > Math.abs(hpc[argmax])) argmax = i;
check('highpass: zero-phase (forward-backward) keeps the click position', Math.abs(argmax - 5000) <= 1, argmax);

// 2. 音高估計
const est0 = DSP.estimateTuning(tones(4, CHORD, 0), SR, 0, 4 * SR);
check('tuning: A440 recording reads about 0 cents', Math.abs(est0.cents) < 3 && est0.conf > 0.5, est0);
const estSharp = DSP.estimateTuning(tones(4, CHORD, 25), SR, 0, 4 * SR);
check('tuning: +25 cents recording reads about +25', Math.abs(estSharp.cents - 25) < 3, estSharp);
const estFlat = DSP.estimateTuning(tones(4, CHORD, -30), SR, 0, 4 * SR);
check('tuning: -30 cents recording reads about -30', Math.abs(estFlat.cents + 30) < 3, estFlat);
check('tuning: too-short input gives zero confidence', DSP.estimateTuning(tones(0.05, CHORD, 0), SR, 0, 0.05 * SR).conf === 0);
check('wrap: 130 cents folds to 30', Math.abs(DSP.wrap(130) - 30) < 1e-9 && DSP.wrap(-50) === 50);

// 3. 校準計畫
const plan0 = DSP.planWarp(tones(8, CHORD, 0), SR);
check('plan: in tune is left alone (mode none)', plan0.mode === 'none', plan0);
const sharpSig = tones(8, CHORD, 25);
const planG = DSP.planWarp(sharpSig, SR);
check('plan: +25 cents recording gets a global correction', planG.mode === 'global' && Math.abs(planG.offset - 25) < 3, planG);
check('plan: global correction segment cents match offset', planG.mode === 'global' && Math.abs(planG.segments[0].cents - planG.offset) < 1e-9);
const small = DSP.planWarp(tones(8, CHORD, 12), SR);
check('plan: 12 cents (under TUNE_MIN) is not corrected', small.mode === 'none', small);
const fixed = DSP.applyWarp(sharpSig, SR, planG);
const after = DSP.estimateTuning(fixed, SR, 0, fixed.length);
check('apply: corrected signal now reads about 0 cents', Math.abs(after.cents) < 3, after);
check('apply: corrected signal is longer by the rate (+25 cents sharp → longer)', fixed.length > sharpSig.length, [fixed.length, sharpSig.length]);
const map = DSP.makeTimeMap(planG, SR);
const tOrigEnd = map(fixed.length / SR);
check('time map: end of corrected output maps back to the original end (±0.02 s)', Math.abs(tOrigEnd - sharpSig.length / SR) < 0.02, [tOrigEnd, sharpSig.length / SR]);
check('time map: monotonic', map(1) < map(2) && map(2) < map(3));
// 漂移:音高從 0 逐秒變到 -40 音分(每秒 -2 音分),共 20 秒
const drift = (() => { const n = 20 * SR, x = new Float32Array(n); let ph = [0, 0, 0, 0, 0]; const fs = CHORD; for (let i = 0; i < n; i++) { const t = i / SR; const c = -2 * t; const k = Math.pow(2, c / 1200); for (let j = 0; j < fs.length; j++) { ph[j] += 2 * Math.PI * fs[j][0] * k / SR; x[i] += fs[j][1] * Math.sin(ph[j]); } } return x; })();
const planD = DSP.planWarp(drift, SR);
check('plan: slow drift (0 to -40 cents over 20 s) gets a drift correction', planD.mode === 'drift' && planD.segments.length === 20, { mode: planD.mode, n: planD.segments.length, reason: planD.reason });
// 突跳(前 10 秒 0、後 10 秒 -40):相鄰差距大,不是漂移,不修漂移
const step = (() => { const n = 20 * SR, x = new Float32Array(n); for (const [from, to, c] of [[0, 10, 0], [10, 20, -40]]) { const k = Math.pow(2, c / 1200); for (const [f, a] of CHORD) { let ph = 0; for (let i = Math.floor(from * SR); i < to * SR; i++) { ph = 2 * Math.PI * f * k * i / SR; x[i] += a * Math.sin(ph); } } } return x; })();
const planS = DSP.planWarp(step, SR);
check('plan: a sudden jump (singer-like) is not treated as drift', planS.mode !== 'drift', { mode: planS.mode, reason: planS.reason });

// 4. 重新取樣速率
const xx = tones(1, [[440, 1]]);
const same = DSP.resampleRate(xx, 1);
check('resampleRate: rate 1 returns the same samples', same.length === xx.length && Math.abs(same[1000] - xx[1000]) < 1e-6);

console.log('audio_dsp.test: ' + ok + ' ok, ' + bad.length + ' failed');
if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
