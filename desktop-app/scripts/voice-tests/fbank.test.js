// 聲紋特徵（log-mel）的單元測試。執行：node scripts/voice-tests/fbank.test.js
'use strict';
const path = require('path');
const assert = require('assert');
const F = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'voice', 'fbank.js'));

const tests = [];
function check(name, fn) { tests.push([name, fn]); }

function sine(hz, ms, amp) {
  const n = Math.round(16000 * ms / 1000), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (amp || 0.3) * Math.sin(2 * Math.PI * hz * i / 16000);
  return out;
}

check('FFT：單一頻率的正弦在正確的 bin 出現峰值', () => {
  const N = 512, re = new Float64Array(N), im = new Float64Array(N);
  const k0 = 32; // 32 * 16000 / 512 = 1000 Hz
  for (let i = 0; i < N; i++) re[i] = Math.cos(2 * Math.PI * k0 * i / N);
  F.fftInPlace(re, im);
  let best = 0, bi = -1;
  for (let k = 0; k <= N / 2; k++) { const p = re[k] * re[k] + im[k] * im[k]; if (p > best) { best = p; bi = k; } }
  assert.strictEqual(bi, k0);
});

check('mel 換算互逆（誤差很小）', () => {
  for (const f of [100, 1000, 4000, 7900]) assert.ok(Math.abs(F.mel2hz(F.hz2mel(f)) - f) < 1e-6, '' + f);
});

check('幀數：1 秒 16kHz 音訊 → 98 幀（視窗 400、位移 160）', () => {
  const r = F.fbank(sine(440, 1000), 16000);
  assert.strictEqual(r.frames, 98);
  assert.strictEqual(r.data.length, 98 * 80);
  assert.strictEqual(r.nMels, 80);
});

check('太短的音訊（少於一個視窗）回傳 0 幀', () => {
  const r = F.fbank(new Float32Array(100), 16000);
  assert.strictEqual(r.frames, 0);
  assert.strictEqual(r.data.length, 0);
});

check('靜音的每個 mel 都是下限 log(1e-10)', () => {
  const r = F.fbank(new Float32Array(3200), 16000);
  const floor = Math.log(1e-10);
  for (let i = 0; i < r.data.length; i++) assert.ok(Math.abs(r.data[i] - floor) < 1e-4, '第 ' + i + ' 個值 ' + r.data[i]);
});

check('440Hz 的正弦：能量最強的 mel 濾波器中心頻率接近 440Hz', () => {
  const r = F.fbank(sine(440, 500), 16000);
  const t = 10;
  let best = -Infinity, bi = -1;
  for (let m = 0; m < 80; m++) { const v = r.data[t * 80 + m]; if (v > best) { best = v; bi = m; } }
  // 80 個 mel 濾波器在 0–8000Hz 間等距於 mel 尺度；算出 bi 的中心頻率（左右邊界中點的近似）
  const mlo = F.hz2mel(0), mhi = F.hz2mel(8000);
  const center = F.mel2hz(mlo + (mhi - mlo) * (bi + 1) / 81);
  assert.ok(center > 300 && center < 600, '峰值濾波器中心約 ' + center.toFixed(0) + 'Hz');
});

check('相同輸入得到相同輸出（決定性）', () => {
  const a = F.fbank(sine(300, 300), 16000), b = F.fbank(sine(300, 300), 16000);
  assert.deepStrictEqual(Array.from(a.data), Array.from(b.data));
});

check('非 16kHz 直接丟錯（呼叫端要先重採樣）', () => {
  assert.throws(() => F.fbank(new Float32Array(1000), 48000));
});

(function run() {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try { fn(); pass++; console.log('[通過] ' + name); }
    catch (e) { fail++; console.log('[失敗] ' + name + '：' + e.message); }
  }
  console.log('\n合計：' + pass + ' 通過，' + fail + ' 失敗');
  process.exit(fail ? 1 : 0);
})();
