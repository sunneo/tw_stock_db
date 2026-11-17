'use strict';
// llm_arch（O12a）：架構描述表的驗證。純資料，不需要 GPU。
const assert = require('assert');
const A = require('./llm_arch.js');
let passes = 0;
function check(name, fn) { fn(); passes++; console.log('ok   ' + name); }
const clone = (name) => A.archFor(name);

check('已支援的描述全部通過驗證，且 isSupported 為真', () => {
  for (const name of Object.keys(A.FAMILIES)) {
    const d = A.FAMILIES[name];
    if (d.status !== 'supported') continue;
    const v = A.validateArch(d);
    assert.strictEqual(v.ok, true, name + '：' + v.errors.join('；'));
    assert.strictEqual(A.isSupported(name), true, name);
  }
});

check('Llama 系列與 Qwen3 都在表裡，且族名正確', () => {
  assert.strictEqual(A.archFor('llama-3.2-1b').family, 'llama');
  assert.strictEqual(A.archFor('tinyllama-1.1b').family, 'llama');
  assert.strictEqual(A.archFor('smollm2-135m').family, 'llama');
  assert.strictEqual(A.archFor('qwen3-0.6b').family, 'qwen3');
});

check('Qwen3 的 head 維度與 hidden／heads 不相等仍合法（headDim 以描述為準）', () => {
  const q = A.archFor('qwen3-0.6b');
  assert.strictEqual(q.hidden / q.heads, 64);
  assert.strictEqual(A.headDimOf(q), 128);
  assert.strictEqual(A.validateArch(q).ok, true);
});

check('GQA：heads 是 kvHeads 的整數倍（Llama 3.2 1B：32 對 8）', () => {
  const d = A.archFor('llama-3.2-1b');
  assert.strictEqual(d.heads / d.kvHeads, 4);
  assert.strictEqual(A.headDimOf(d), 64);
});

check('Gemma／Phi 只是 pending：不支援、不要求數字，且不通過 isSupported', () => {
  for (const name of ['gemma', 'phi']) {
    const v = A.validateArch(A.FAMILIES[name]);
    assert.strictEqual(v.ok, true, name + '：' + v.errors.join('；'));
    assert.strictEqual(A.isSupported(name), false, name);
  }
});

check('未知的模型名：archFor 回傳 null，isSupported 為假', () => {
  assert.strictEqual(A.archFor('no-such-model'), null);
  assert.strictEqual(A.isSupported('no-such-model'), false);
});

check('archFor 回傳複製品：改了不影響表本身', () => {
  const d = A.archFor('smollm2-135m');
  d.layers = 999;
  assert.strictEqual(A.FAMILIES['smollm2-135m'].layers, 30);
});

check('錯誤：hidden 不能被 heads 整除（沒給 headDim 時）', () => {
  const d = clone('smollm2-135m'); delete d.headDim; d.hidden = 577;
  const v = A.validateArch(d);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /hidden 必須能被 heads 整除/.test(e)), v.errors.join('；'));
});

check('錯誤：heads 不是 kvHeads 的整數倍（GQA 不合法）', () => {
  const d = clone('llama-3.2-1b'); d.kvHeads = 5;
  const v = A.validateArch(d);
  assert.ok(v.errors.some((e) => /整數倍/.test(e)), v.errors.join('；'));
});

check('錯誤：kvHeads 大於 heads', () => {
  const d = clone('llama-3.2-1b'); d.kvHeads = 64;
  const v = A.validateArch(d);
  assert.ok(v.errors.some((e) => /kvHeads 不能大於 heads/.test(e)), v.errors.join('；'));
});

check('錯誤：啟動、歸一化、RoPE 風格不認得', () => {
  const d = clone('tinyllama-1.1b'); d.act = 'relu'; d.norm = 'batchnorm'; d.rope.style = 'diagonal';
  const v = A.validateArch(d);
  assert.ok(v.errors.some((e) => /act 只能是/.test(e)), v.errors.join('；'));
  assert.ok(v.errors.some((e) => /norm 只能是/.test(e)), v.errors.join('；'));
  assert.ok(v.errors.some((e) => /rope.style 只能是/.test(e)), v.errors.join('；'));
});

check('錯誤：量化格式不認得、缺欄位、status 不對', () => {
  const d = clone('tinyllama-1.1b'); d.quant = ['q2']; delete d.bias; d.status = 'maybe';
  const v = A.validateArch(d);
  assert.ok(v.errors.some((e) => /不認得的格式：q2/.test(e)), v.errors.join('；'));
  assert.ok(v.errors.some((e) => /缺少欄位 bias/.test(e)), v.errors.join('；'));
  assert.ok(v.errors.some((e) => /status 只能是/.test(e)), v.errors.join('；'));
});

check('錯誤：eps 超出範圍、數字欄位為負或非數字', () => {
  const d = clone('tinyllama-1.1b'); d.eps = 2; d.layers = -1; d.ffn = 'big';
  const v = A.validateArch(d);
  assert.ok(v.errors.some((e) => /eps 必須在/.test(e)), v.errors.join('；'));
  assert.ok(v.errors.some((e) => /layers 必須是正數/.test(e)), v.errors.join('；'));
  assert.ok(v.errors.some((e) => /ffn 必須是正數/.test(e)), v.errors.join('；'));
});

check('錯誤：非物件的描述直接拒絕', () => {
  assert.strictEqual(A.validateArch(null).ok, false);
  assert.strictEqual(A.validateArch('llama').ok, false);
});

console.log('llm_arch_test: ' + passes + ' 項通過');
