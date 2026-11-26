// node scripts/music-tests/drum_flux.test.js -- 頻譜法鼓軌:挑峰、存在檢查(合成鼓 / 鋼琴 / 靜音 / 噪音)、GM 音高、非 22050 Hz 輸入
const D = require('../../renderer/src/music/drum_flux.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const SR = 22050;
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
function mixAt(buf, sr, t, fn, len) { const o = Math.floor(t * sr); const n = Math.floor(len * sr); for (let i = 0; i < n && o + i < buf.length; i++) buf[o + i] += fn(i / sr); }
// 合成鼓:大鼓(低頻下掃衰減正弦)、小鼓(200 Hz 本體＋噪音)、踩鑔(高通噪音短衰減)
const kick = (tt) => 0.9 * Math.exp(-tt * 22) * Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-tt * 40)) * tt);
const snare = (tt) => 0.5 * Math.exp(-tt * 28) * (rnd() * 0.9 + 0.5 * Math.sin(2 * Math.PI * 200 * tt));
let prevN = 0; const hat = (tt) => { const n = rnd(); const hp = n - prevN; prevN = n; return 0.4 * Math.exp(-tt * 90) * hp; };
// 120 bpm,8 秒:大鼓在偶數拍、小鼓在奇數拍、踩鑔每八分音符
function drumPattern(sr) {
  const len = 8, buf = new Float32Array(Math.floor(len * sr));
  for (let b = 0; b < 16; b++) { const t = 0.1 + b * 0.5; if (b % 2 === 0) mixAt(buf, sr, t, kick, 0.3); else mixAt(buf, sr, t, snare, 0.25); }
  for (let e = 0; e < 32; e++) { prevN = 0; mixAt(buf, sr, 0.1 + e * 0.25, hat, 0.1); }
  return buf;
}
// 鋼琴式:隨機間隔的泛音音符,衰減較慢(節奏不規律)
function piano(sr, sec) {
  const buf = new Float32Array(Math.floor(sec * sr)); let t = 0.2; const freqs = [220, 262, 294, 330, 392, 440, 523];
  while (t < sec - 1) { const f = freqs[Math.floor(Math.abs(rnd()) * freqs.length) % freqs.length]; mixAt(buf, sr, t, (tt) => 0.3 * Math.exp(-tt * 3) * (Math.sin(2 * Math.PI * f * tt) + 0.4 * Math.sin(4 * Math.PI * f * tt)), 1.5); t += 0.2 + Math.abs(rnd()) * 0.7; }
  return buf;
}

// 1. 挑峰:單一尖峰、間隔以內只留強者、底線濾掉極小起伏
const flatO = new Float64Array(400).fill(1); flatO[200] = 50;
check('pickPeaks: one clear spike is one peak at that frame', (() => { const p = D.pickPeaks(flatO, SR); return p.length === 1 && p[0].f === 200; })());
const twin = new Float64Array(400).fill(1); twin[200] = 50; twin[202] = 40;
check('pickPeaks: two spikes closer than MIN_GAP keep only the stronger', (() => { const p = D.pickPeaks(twin, SR); return p.length === 1 && p[0].f === 200; })(), D.pickPeaks(twin, SR));
const tiny = new Float64Array(400).fill(0.01); tiny[100] = 0.012; tiny[300] = 0.012; // 不到局部中位數的 1.6 倍
check('pickPeaks: bumps below MULT times the local median are ignored', D.pickPeaks(tiny, SR).length === 0, D.pickPeaks(tiny, SR));
const tailO = new Float64Array(400).fill(0.001); tailO[200] = 50; tailO[100] = 0.5; // 0.5 是最大峰的 1%,低於底線(2%)
check('pickPeaks: decay-tail bump under the band floor is ignored', (() => { const p = D.pickPeaks(tailO, SR); return p.length === 1 && p[0].f === 200; })(), D.pickPeaks(tailO, SR));

// 2. 合成鼓:存在、有三種音高、打擊時刻接近 8 個大鼓的拍點
const dr = drumPattern(SR); const rD = D.detect(dr, SR);
check('drums: synthetic pattern detected as drums', rD.present === true, rD.reason);
check('drums: GM notes 36, 38, 42 all present', rD.present && [36, 38, 42].every((n) => rD.hits.some((h) => h.note === n)), rD.hits && rD.hits.slice(0, 5));
const kicks = rD.hits.filter((h) => h.note === 36).map((h) => h.t);
const expectKick = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => 0.1 + i);
check('drums: kick times land near the expected beats (±25 ms)', expectKick.every((e) => kicks.some((t) => Math.abs(t - e) < 0.025)), kicks.map((t) => +t.toFixed(3)));
const snares = rD.hits.filter((h) => h.note === 38).map((h) => h.t);
const expectSnare = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => 0.6 + i);
check('drums: snare times land on the backbeat (±25 ms), 8 of them', expectSnare.every((e) => snares.some((t) => Math.abs(t - e) < 0.025)), snares.map((t) => +t.toFixed(3)));
check('drums: no kick emitted on a snare time (leakage removed)', kicks.every((t) => !snares.some((s) => Math.abs(s - t) < 0.02)), { kicks: kicks.length });
check('drums: velocities in 30..127', rD.hits.every((h) => h.vel >= 30 && h.vel <= 127));
check('drums: hits sorted by time', rD.hits.every((h, i) => i === 0 || rD.hits[i - 1].t <= h.t));
// 非 22050 Hz 輸入(44100)先降取樣後仍能偵測
const up = new Float32Array(dr.length * 2); for (let i = 0; i < dr.length; i++) { up[2 * i] = dr[i]; up[2 * i + 1] = dr[i]; }
const r44 = D.detect(up, 44100);
check('drums: 44100 Hz input is resampled and still detected', r44.present === true, r44.reason);

// 3. 存在檢查:鋼琴、靜音、噪音、太短都不輸出鼓
const pn = piano(SR, 8); const rP = D.detect(pn, SR);
check('no drums: irregular piano is not drums', rP.present === false, rP.reason);
const sil = new Float32Array(SR * 8); const rS = D.detect(sil, SR);
check('no drums: silence is not drums', rS.present === false, rS.reason);
const noise = new Float32Array(SR * 8); for (let i = 0; i < noise.length; i++) noise[i] = 0.3 * rnd();
const rN = D.detect(noise, SR);
check('no drums: pure noise is not drums', rN.present === false, rN.reason);
const rT = D.detect(new Float32Array(100), SR);
check('no drums: too short input is not drums', rT.present === false && rT.hits.length === 0);

// 4. 存在檢查的門檻(boundary):打擊太少
const fewE = new Float64Array(2000), fewK = [{ f: 100, v: 1 }, { f: 300, v: 1 }], fewS = [];
check('presence: fewer than MIN_HITS is rejected', D.presence(fewK, fewS, fewE, fewE, SR).ok === false && /只有/.test(D.presence(fewK, fewS, fewE, fewE, SR).reason));

console.log('drum_flux.test: ' + ok + ' ok, ' + bad.length + ' failed');
if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
