// 全語音 Live 收音迴圈的單元測試（VAD、重採樣、依序辨識）。執行：node scripts/voice-tests/live_loop.test.js
'use strict';
const path = require('path');
const assert = require('assert');
const L = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'voice', 'live_loop.js'));

const tests = [];
function check(name, fn) { tests.push([name, fn]); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 產生一段正弦波（代表有聲音）或靜音，取樣率 rate，長 ms 毫秒。
function tone(ms, rate, amp) {
  const n = Math.round(ms * rate / 1000), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (amp || 0.2) * Math.sin(2 * Math.PI * 440 * i / rate);
  return out;
}
function silence(ms, rate) { return new Float32Array(Math.round(ms * rate / 1000)); }

// 把一串音訊切成固定大小的區塊餵進 vad，回傳所有切出的句子。
function runVad(vad, parts, rate, blockMs) {
  const out = [];
  const all = Float32Array.from(parts.reduce((a, p) => a.concat(Array.from(p)), []));
  const block = Math.round(blockMs * rate / 1000);
  for (let i = 0; i < all.length; i += block) {
    const seg = vad.feed(all.subarray(i, Math.min(i + block, all.length)), rate);
    if (seg) out.push(seg);
  }
  const last = vad.flush();
  if (last) out.push(last);
  return out;
}

check('rms：靜音為 0，正弦波約為振幅的 1/√2', () => {
  assert.strictEqual(L.rms(new Float32Array(100)), 0);
  const r = L.rms(tone(100, 16000, 0.2));
  assert.ok(Math.abs(r - 0.2 / Math.SQRT2) < 0.01, '正弦 rms 約 0.1414，實際 ' + r);
});

check('重採樣：48k→16k 長度約為三分之一，同取樣率則原樣複製', () => {
  const x = tone(1000, 48000, 0.2);
  const y = L.resampleLinear(x, 48000, 16000);
  assert.ok(Math.abs(y.length - 16000) <= 1, '長度 ' + y.length);
  const same = L.resampleLinear(x, 48000, 48000);
  assert.strictEqual(same.length, x.length);
  assert.notStrictEqual(same, x, '應該是複本');
});

check('重採樣：不合法取樣率丟錯', () => {
  assert.throws(() => L.resampleLinear(new Float32Array(10), 0, 16000));
});

check('VAD：一句話後接足夠的靜音就切出一段，時間長度合理', () => {
  const vad = L.createVad({ threshold: 0.05, silenceMs: 500, minMs: 200 });
  const segs = runVad(vad, [silence(300, 16000), tone(1200, 16000), silence(1000, 16000)], 16000, 100);
  assert.strictEqual(segs.length, 1);
  assert.ok(segs[0].durationMs >= 1100 && segs[0].durationMs <= 1900, '長度 ' + segs[0].durationMs);
});

check('VAD：短暫的雜音（短於 minMs）會被丟掉', () => {
  const vad = L.createVad({ threshold: 0.05, silenceMs: 300, minMs: 500 });
  const segs = runVad(vad, [tone(100, 16000), silence(800, 16000)], 16000, 50);
  assert.strictEqual(segs.length, 0);
});

check('VAD：說話中間的短停頓（小於 silenceMs）不切開', () => {
  const vad = L.createVad({ threshold: 0.05, silenceMs: 800, minMs: 200 });
  const segs = runVad(vad, [tone(600, 16000), silence(300, 16000), tone(600, 16000), silence(1000, 16000)], 16000, 100);
  assert.strictEqual(segs.length, 1);
});

check('VAD：超過 maxMs 強制切段（不會永遠不結束）', () => {
  const vad = L.createVad({ threshold: 0.05, silenceMs: 800, maxMs: 2000, minMs: 200 });
  const segs = runVad(vad, [tone(5000, 16000)], 16000, 100);
  assert.ok(segs.length >= 2, '應該至少切 2 段，實際 ' + segs.length);
  for (const s of segs) assert.ok(s.durationMs <= 2100, '段長 ' + s.durationMs);
});

check('VAD：flush 在說話中途呼叫會收下未結束的一句（夠長的話）', () => {
  const vad = L.createVad({ threshold: 0.05, minMs: 200 });
  vad.feed(tone(400, 16000), 16000);
  const seg = vad.flush();
  assert.ok(seg && seg.durationMs >= 390);
  assert.strictEqual(vad.flush(), null);
});

check('VAD：取樣率不合法丟錯', () => {
  assert.throws(() => L.createVad().feed(new Float32Array(10), 0));
});

check('收音迴圈：一句話送進辨識（16kHz）、文字回傳、依序處理', async () => {
  const texts = [];
  const calls = [];
  const loop = L.createLiveLoop({
    vad: { threshold: 0.05, silenceMs: 300, minMs: 100 },
    startCapture: async (onChunk) => { return { stop: async () => {} }; },
    transcribe: async (pcm) => { calls.push(pcm.length); await sleep(5); return calls.length === 1 ? 'AI 播放音樂' : '  AI 開網頁 '; },
    onText: (t) => texts.push(t),
  });
  await loop.start();
  const rate = 48000;
  loop.ingest(tone(600, rate), rate);
  loop.ingest(silence(500, rate), rate);
  loop.ingest(tone(600, rate), rate);
  loop.ingest(silence(500, rate), rate);
  await loop.stop();
  assert.deepStrictEqual(texts, ['AI 播放音樂', 'AI 開網頁'], '順序與去空白');
  // 每句包含 600ms 語音，加上結束時收進來的靜音區塊（測試裡每塊 500ms），所以 16kHz 樣本數約 9600 到 17600。
  assert.ok(calls.every((n) => n >= 9600 && n <= 17600), '16kHz 樣本數 ' + JSON.stringify(calls));
});

check('收音迴圈：辨識出空字串不回傳文字，不算錯誤', async () => {
  const texts = [];
  const loop = L.createLiveLoop({
    vad: { threshold: 0.05, silenceMs: 200, minMs: 100 },
    startCapture: async () => ({ stop: async () => {} }),
    transcribe: async () => '   ',
    onText: (t) => texts.push(t),
  });
  await loop.start();
  loop.ingest(tone(400, 16000), 16000);
  loop.ingest(silence(400, 16000), 16000);
  await loop.stop();
  assert.deepStrictEqual(texts, []);
  assert.strictEqual(loop.stats().errors, 0);
});

check('收音迴圈：辨識丟錯時呼叫 onError，後面的句子照常處理', async () => {
  const errs = [], texts = [];
  let n = 0;
  const loop = L.createLiveLoop({
    vad: { threshold: 0.05, silenceMs: 200, minMs: 100 },
    startCapture: async () => ({ stop: async () => {} }),
    transcribe: async () => { n++; if (n === 1) throw new Error('模型忙'); return '第二句'; },
    onText: (t) => texts.push(t),
    onError: (e) => errs.push(e.message),
  });
  await loop.start();
  loop.ingest(tone(400, 16000), 16000); loop.ingest(silence(300, 16000), 16000);
  loop.ingest(tone(400, 16000), 16000); loop.ingest(silence(300, 16000), 16000);
  await loop.stop();
  assert.deepStrictEqual(errs, ['模型忙']);
  assert.deepStrictEqual(texts, ['第二句']);
});

check('收音迴圈：stop 會停止擷取並呼叫擷取端的 stop', async () => {
  let stopped = 0;
  const loop = L.createLiveLoop({
    startCapture: async () => ({ stop: async () => { stopped++; } }),
    transcribe: async () => '',
  });
  await loop.start();
  await loop.stop();
  assert.strictEqual(stopped, 1);
  await loop.stop();
  assert.strictEqual(stopped, 1, '重複 stop 不會重複停止');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('[通過] ' + name); }
    catch (e) { fail++; console.log('[失敗] ' + name + '：' + e.message); }
  }
  console.log('\n合計：' + pass + ' 通過，' + fail + ' 失敗');
  process.exit(fail ? 1 : 0);
})();
