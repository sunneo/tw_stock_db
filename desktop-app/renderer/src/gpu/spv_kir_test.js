// node renderer/src/gpu/spv_kir_test.js — SPIR-V→KIR（spv_kir.js）。差分測試：同一份 OpenCL C 經「clc 直接編譯成 JS」與「clc_spv→SPIR-V→KIR→FaKir.runJs」兩條路執行，結果要一致；
// 子集之外的核心必須回報原因（載入器退回主機路線）。
const assert = require('assert');
const CLC = require('./clc_js.js'), F = require('./clc_spv.js'), K = require('./spv_kir.js'), KIR = require('./kir.js');
let pass = 0, fail = 0; const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.stack || e.message).split('\n').slice(0, 9).join('\n   ')); } };
const f32 = (n, f) => Float32Array.from({ length: n }, (_, i) => f(i));
function kirOf(src, name) { const il = F.compile(src, ''); assert.ok(il.ok, il.log); const r = K.compile(il.il); assert.ok(r.ok, r.log); const k = r.kernels[name]; return k; }
// bufs：{名稱: Float32Array}、scalars：{名稱: 數字}、order＝參數順序（clc 用）
function diff(src, name, order, bufs, scalars, N) {
  const k = kirOf(src, name); assert.ok(k.kir, '應該能轉成 KIR：' + k.reason); const v = KIR.validate(k.kir); assert.ok(v.ok, v.errors.join(';'));
  const A = {}, B = {}; for (const n in bufs) { A[n] = bufs[n].slice(); B[n] = bufs[n].slice(); }
  const c = CLC.compile(src, ''); assert.ok(c.ok, c.log);
  c.run(name, order.map((n) => (n in A ? c.mkptr(A[n].buffer) : scalars[n])), [N], null, null);
  KIR.runJs(k.kir, B, scalars, N);
  for (const n in bufs) for (let i = 0; i < A[n].length; i++) assert.ok(Object.is(A[n][i], B[n][i]) || Math.abs(A[n][i] - B[n][i]) <= 1e-5 * Math.max(1, Math.abs(A[n][i])), n + '[' + i + ']：clc=' + A[n][i] + ' kir=' + B[n][i]);
  return k.kir;
}
const N = 37;
t('向量相加（含 n 防護）', () => diff('__kernel void vadd(__global const float* a, __global const float* b, __global float* c, int n) { int i = get_global_id(0); if (i < n) c[i] = a[i] + b[i]; }', 'vadd', ['a', 'b', 'c', 'n'], { a: f32(40, (i) => i * 0.5), b: f32(40, (i) => 3 - i), c: new Float32Array(40) }, { n: N }, 40));
t('saxpy＋數學函式（sqrt／fabs／fmax／pow／exp）', () => diff('__kernel void k(__global float* y, __global const float* x, float a, int n) { int i = get_global_id(0); if (i < n) y[i] = fmax(sqrt(fabs(x[i])) * a, 0.25f) + pow(fabs(x[i]), 0.5f) + exp(x[i] * 0.01f); }', 'k', ['y', 'x', 'a', 'n'], { y: new Float32Array(40), x: f32(40, (i) => i - 20) }, { a: 1.5, n: 40 }, 40));
t('內層 for（常數上界）與純量上界', () => { diff('__kernel void k(__global const float* a, __global float* y, float s, int n) { int i = get_global_id(0); if (i < n) { float acc = 0.0f; for (int j = 0; j < 4; j++) acc += a[i * 4 + j] * s; y[i] = acc; } }', 'k', ['a', 'y', 's', 'n'], { a: f32(160, (i) => i * 0.25), y: new Float32Array(40) }, { s: 2, n: 40 }, 40);
  diff('__kernel void k(__global const float* a, __global float* y, int m, int n) { int i = get_global_id(0); if (i < n) { float acc = 0.0f; for (int j = 0; j < m; j++) acc += a[i * 4 + j]; y[i] = acc; } }', 'k', ['a', 'y', 'm', 'n'], { a: f32(160, (i) => i * 0.25), y: new Float32Array(40) }, { m: 3, n: 40 }, 40); });
t('?:（phi）與 if／else', () => { diff('__kernel void k(__global const float* a, __global float* y, int n) { int i = get_global_id(0); if (i < n) { y[i] = a[i] > 0.0f ? a[i] * 2.0f : -a[i]; } }', 'k', ['a', 'y', 'n'], { a: f32(40, (i) => i - 20), y: new Float32Array(40) }, { n: 40 }, 40);
  diff('__kernel void k(__global const float* a, __global float* y, int n) { int i = get_global_id(0); if (i < n) { float v; if (a[i] < -5.0f) v = 1.0f; else if (a[i] < 5.0f) v = 2.0f; else v = 3.0f; y[i] = v + a[i]; } }', 'k', ['a', 'y', 'n'], { a: f32(40, (i) => i - 20), y: new Float32Array(40) }, { n: 40 }, 40); });
t('提早 return（if (i >= n) return;）', () => diff('__kernel void k(__global const float* a, __global float* y, int n) { int i = get_global_id(0); if (i >= n) return; y[i] = a[i] * 3.0f; }', 'k', ['a', 'y', 'n'], { a: f32(40, (i) => i + 1), y: f32(40, () => -1) }, { n: 30 }, 40));
t('整數索引運算與型別轉換', () => diff('__kernel void k(__global const float* a, __global float* y, int n) { int i = get_global_id(0); if (i < n) { int j = (i * 3 + 1) % n; y[i] = a[j] + (float)(i / 2) + (float)((int)(a[i] * 0.5f)); } }', 'k', ['a', 'y', 'n'], { a: f32(40, (i) => i * 1.3), y: new Float32Array(40) }, { n: 40 }, 40));
t('迴圈變數在迴圈後的值（max(0, 上界)）', () => diff('__kernel void k(__global float* y, int n, int m) { int i = get_global_id(0); if (i < n) { int j; float s = 0.0f; for (j = 0; j < m; j++) s += 1.0f; y[i] = s * 10.0f + (float)j; } }', 'k', ['y', 'n', 'm'], { y: new Float32Array(40) }, { n: 40, m: 5 }, 40));
t('子集之外回報原因：二維 gid、整數緩衝區、while、讀寫同一緩衝區、原子', () => {
  for (const [src, why] of [
    ['__kernel void k(__global float* y) { int i = get_global_id(1); y[i] = 1.0f; }', /一維/],
    ['__kernel void k(__global int* y) { y[get_global_id(0)] = 1; }', /float/],
    ['__kernel void k(__global float* y, int n) { int i = get_global_id(0); int j = 0; while (j < n) { y[i] += 1.0f; j++; } }', /迴圈|同時讀寫|子集/],
    ['__kernel void k(__global float* y) { int i = get_global_id(0); y[i] = y[i] + 1.0f; }', /同時讀寫/],
    ['__kernel void k(__global int* y) { atomic_add(&y[0], 1); }', /float|子集|不支援/]]) {
    const il = F.compile(src, ''); if (!il.ok) continue; const r = K.compile(il.il); assert.ok(r.ok); const k = r.kernels.k; assert.ok(!k.kir && why.test(k.reason), src + ' → ' + JSON.stringify(k));
  }
});
t('clc_spv 沒法轉 SPIR-V 的來源不在這裡處理（compile 回 ok:false 由呼叫端略過）', () => { assert.strictEqual(K.compile(new Uint8Array([1, 2, 3])).ok, false); });
console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
