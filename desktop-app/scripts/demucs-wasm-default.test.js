'use strict';
// 拆軌預設走 WASM：_audioGpuSession 在 demucs-6s 且沒有 opt-in 時要直接回傳 null（不碰 GPU、不等看門狗）。
// 這是對原始碼結構的守門測試，加上用同一段邏輯的行為測試。
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', 'floating-assistant.js'), 'utf8');
const i = src.indexOf('async _audioGpuSession(id, c)');
assert(i > 0, '找不到 _audioGpuSession');
const body = src.slice(i, i + 4000);
const guard = body.indexOf("getItem('fa.audio.demucsGpu')");
assert(guard > 0, '少了 fa.audio.demucsGpu 的 opt-in 判斷');
const firstGpuUse = Math.min(...['_audioGpuOn()', '_gpuLostRecord()', 'navigator.gpu', '_omGpuInfo'].map((k) => { const j = body.indexOf(k); return j < 0 ? Infinity : j; }));
assert(guard < firstGpuUse, 'opt-in 判斷必須在任何 GPU 相關呼叫之前');
assert(/id === 'demucs-6s'/.test(body.slice(Math.max(0, guard - 400), guard)), '守門只能針對 demucs-6s，不能影響 yamnet／basic-pitch');
console.log('通過  原始碼：demucs-6s 預設不走 GPU，opt-in 判斷在所有 GPU 呼叫之前，且只針對 demucs-6s');

// 行為：把守門那一段抽出來單獨跑
function gate(id, store) {
  const c = { notes: [] }, label = 'Demucs';
  const localStorage = { getItem: (k) => (k in store ? store[k] : null) };
  if (id === 'demucs-6s') {
    let optIn = false; try { optIn = localStorage.getItem('fa.audio.demucsGpu') === '1'; } catch (_) { /* */ }
    if (!optIn) { c.notes.push(label); return { skip: true, c }; }
  }
  return { skip: false, c };
}
assert.strictEqual(gate('demucs-6s', {}).skip, true, '預設要略過 GPU');
assert.strictEqual(gate('demucs-6s', { 'fa.audio.demucsGpu': '0' }).skip, true, '0 也要略過');
assert.strictEqual(gate('demucs-6s', { 'fa.audio.demucsGpu': '1' }).skip, false, '1 才放行');
assert.strictEqual(gate('yamnet', {}).skip, false, 'yamnet 不受影響');
assert.strictEqual(gate('basic-pitch', {}).skip, false, 'basic-pitch 不受影響');
console.log('通過  行為：預設略過、設 1 才放行、其他模型不受影響');
console.log('demucs-wasm-default 測試：全部通過');
