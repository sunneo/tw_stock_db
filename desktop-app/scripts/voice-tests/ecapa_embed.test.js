// ECAPA 嵌入模組的單元測試（用假 session，不載入真模型）。執行：node scripts/voice-tests/ecapa_embed.test.js
'use strict';
const path = require('path');
const assert = require('assert');
const base = path.join(__dirname, '..', '..', 'renderer', 'src', 'voice');
const E = require(path.join(base, 'ecapa_embed.js'));
const FB = require(path.join(base, 'fbank.js'));

const tests = [];
function check(name, fn) { tests.push([name, fn]); }

// 假的 ort：Tensor 只是個容器
const fakeOrt = { Tensor: function (type, data, dims) { this.type = type; this.data = data; this.dims = dims; } };
// 假的 session：記錄輸入，輸出 192 維（取輸入的前 192 個值，形狀 [1,1,192]）
function fakeSession(log) {
  return {
    inputNames: ['feats'], outputNames: ['emb'],
    run: async (feeds) => {
      const x = feeds.feats; log.push(x);
      const d = new Float32Array(192);
      for (let i = 0; i < 192; i++) d[i] = x.data[i] + 1;
      return { emb: { dims: [1, 1, 192], data: d } };
    },
  };
}
function sine(hz, ms) {
  const n = Math.round(16000 * ms / 1000), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.3 * Math.sin(2 * Math.PI * hz * i / 16000);
  return out;
}

check('輸出是 192 維且 L2 正規化（長度為 1）', async () => {
  const log = [];
  const e = E.createEmbedder({ ort: fakeOrt, session: fakeSession(log), fbank: FB });
  const v = await e.embed(sine(300, 1000));
  assert.strictEqual(v.length, 192);
  let s = 0; for (const x of v) s += x * x;
  assert.ok(Math.abs(Math.sqrt(s) - 1) < 1e-5);
});

check('輸入張量形狀是 [1, 幀數, 80]，名稱用 session 的 feats', async () => {
  const log = [];
  const e = E.createEmbedder({ ort: fakeOrt, session: fakeSession(log), fbank: FB });
  await e.embed(sine(300, 1000));
  assert.deepStrictEqual(log[0].dims, [1, 98, 80]);
  assert.strictEqual(e.inputName, 'feats');
  assert.strictEqual(e.outputName, 'emb');
});

check('太短的語音（少於 0.5 秒）丟錯', async () => {
  const e = E.createEmbedder({ ort: fakeOrt, session: fakeSession([]), fbank: FB });
  await assert.rejects(() => e.embed(sine(300, 300)), /太短/);
});

check('cmn：每個 mel 維度的平均變成 0', () => {
  const frames = 10, m = 80, d = new Float32Array(frames * m);
  for (let t = 0; t < frames; t++) for (let k = 0; k < m; k++) d[t * m + k] = 5 + t + k;
  E.cmnInPlace(d, frames, m);
  for (let k = 0; k < m; k++) {
    let s = 0; for (let t = 0; t < frames; t++) s += d[t * m + k];
    assert.ok(Math.abs(s) < 1e-3, 'mel ' + k + ' 平均 ' + s);
  }
});

check('cmn 可關閉：關閉時輸入不被平移', async () => {
  const logOn = [], logOff = [];
  const on = E.createEmbedder({ ort: fakeOrt, session: fakeSession(logOn), fbank: FB, cmn: true });
  const off = E.createEmbedder({ ort: fakeOrt, session: fakeSession(logOff), fbank: FB, cmn: false });
  await on.embed(sine(300, 1000)); await off.embed(sine(300, 1000));
  const a = Array.from(logOn[0].data), b = Array.from(logOff[0].data);
  assert.ok(a.some((x, i) => Math.abs(x - b[i]) > 1e-6), '兩種設定的輸入應該不同');
});

check('缺少 ort／session／fbank 丟錯', () => {
  assert.throws(() => E.createEmbedder({ ort: fakeOrt, session: fakeSession([]) }));
});

(async function run() {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('[通過] ' + name); }
    catch (e) { fail++; console.log('[失敗] ' + name + '：' + e.message); }
  }
  console.log('\n合計：' + pass + ' 通過，' + fail + ' 失敗');
  process.exit(fail ? 1 : 0);
})();
