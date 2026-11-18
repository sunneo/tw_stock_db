'use strict';
// onnx_lite 的回傳形狀與錯誤訊息（2026-11-19 修正）：parseModel 必須同時給 m.inits（物件）、m.nodes、m.buf，
// 也給 m.graph（O12f 的 llm_q8_onnx 用，inits 是 Map）；空檔、文字／網頁、截斷、缺 graph 都要丟出寫明位元組數與檔頭的錯誤，
// 不能是 "Cannot read properties of undefined" 或 "m.nodes is not iterable"。純 node，合成的最小模型，不需要真模型。
const assert = require('assert');
const L = require('./onnx_lite.js');
let passes = 0;
function check(name, fn) { fn(); passes++; console.log('ok   ' + name); }

// ---- 最小的 protobuf 編碼（只為測試組位元組）----
const te = new TextEncoder();
function cat(list) { let n = 0; for (const b of list) n += b.length; const o = new Uint8Array(n); let p = 0; for (const b of list) { o.set(b, p); p += b.length; } return o; }
function vint(n) { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return Uint8Array.from(o); }
const fv = (f, v) => cat([vint(f * 8), vint(v)]);
const fb = (f, b) => cat([vint(f * 8 + 2), vint(b.length), b]);
const fs = (f, s) => fb(f, te.encode(s));
// 一個 float32 權重 W=[1.5, -2]（dims [2]），以及一個 Identity 節點 X→Y
function miniModel(opts) {
  opts = opts || {};
  const raw = new Uint8Array(new Float32Array([1.5, -2]).buffer);
  const dims = opts.dims || [2];
  const tensor = cat([...dims.map((d) => fv(1, d)), fv(2, 1), fs(8, 'W'), fb(9, raw)]);
  const node = cat([fs(1, 'X'), fs(2, 'Y'), fs(3, 'n1'), fs(4, 'Identity')]);
  const graph = cat([fb(1, node), fs(2, 'g'), fb(5, tensor)]);
  return cat([fv(1, 8), fb(7, graph)]);
}

check('形狀：parseModel 同時給 inits（物件）、nodes、buf、graph（inits 為 Map，與物件指向同一批張量）', () => {
  const u8 = miniModel();
  const m = L.parseModel(u8);
  assert.strictEqual(typeof m.inits, 'object');
  assert.deepStrictEqual(m.inits.W.dims, [2]);
  assert.strictEqual(m.nodes.length, 1);
  assert.strictEqual(m.nodes[0].op, 'Identity');
  assert.strictEqual(m.buf, u8);
  assert.strictEqual(m.graph.inits.get('W'), m.inits.W);
  assert.strictEqual(m.graph.nodes, m.nodes);
  assert.deepStrictEqual(m.inputs, []);   // 這個合成模型沒有宣告圖輸入（欄位 11）
  assert.deepStrictEqual(m.outputs, []);
});

check('權重取值：tensorBytes 給 8 位元組、tensorArray 給 [1.5, -2]（Float32）', () => {
  const m = L.parseModel(miniModel());
  assert.strictEqual(L.tensorBytes(m, 'W').length, 8);
  const a = L.tensorArray(m.buf, m.inits.W);
  assert.ok(a instanceof Float32Array);
  assert.deepStrictEqual(Array.from(a), [1.5, -2]);
});

check('權重取值：raw_data 從奇數位址開始（不對齊）也能正確取到 Float32', () => {
  const u8 = miniModel();
  const big = new Uint8Array(u8.length + 1);
  big.set(u8, 1);                       // 整個模型往後挪一格
  const m = L.parseModel(big.subarray(1));
  assert.deepStrictEqual(Array.from(L.tensorArray(m.buf, m.inits.W)), [1.5, -2]);
});

check('錯誤：空檔丟出「空的（0 位元組）」，不是 undefined 例外', () => {
  assert.throws(() => L.parseModel(new Uint8Array(0)), /檔案是空的（0 位元組）/);
});

check('錯誤：網頁（HTML）丟出「看起來是文字或網頁」並附位元組數與檔頭', () => {
  const html = te.encode('<!DOCTYPE html><html><body>Not Found</body></html>');
  assert.throws(() => L.parseModel(html), (e) => /看起來是文字或網頁/.test(e.message) && /位元組，前 16 位元組/.test(e.message));
});

check('錯誤：截斷（少了最後 5 位元組）丟出「宣告 … 位元組，但只剩 …」與「可能被截斷」', () => {
  const u8 = miniModel();
  assert.throws(() => L.parseModel(u8.subarray(0, u8.length - 5)), (e) => /可能被截斷/.test(e.message) && /宣告 \d+ 位元組，但只剩 \d+ 位元組/.test(e.message));
});

check('錯誤：varint 讀到檔案結尾（只剩一個延續位元組）丟出 varint 錯誤，不回傳 undefined', () => {
  assert.throws(() => L.parseModel(Uint8Array.from([0x80])), /varint 讀到檔案結尾/);
});

check('錯誤：沒有 graph 丟出「找不到 graph」並列出頂層欄位號', () => {
  const u8 = cat([fv(1, 8)]);
  assert.throws(() => L.parseModel(u8), (e) => /找不到 graph/.test(e.message) && /頂層欄位號：\[1\]/.test(e.message));
});

check('錯誤：raw_data 長度與形狀不符（dims [3] 卻只有 8 位元組）丟出明確錯誤', () => {
  const m = L.parseModel(miniModel({ dims: [3] }));
  assert.throws(() => L.tensorArray(m.buf, m.inits.W), /raw_data 長度 8 與形狀需要的 12 不符/);
});

check('描述：describe 給長度與前 16 位元組的十六進位', () => {
  const s = L.describe(Uint8Array.from([0x08, 0x07, 0x12, 0x0d]));
  assert.strictEqual(s, '4 位元組，前 16 位元組：08 07 12 0d');
});

console.log('onnx_lite_shape_test: ' + passes + ' 項通過');
