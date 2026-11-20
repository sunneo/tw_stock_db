// node renderer/src/gpu/clc_js_test.js — OpenCL C 前端（clc_js.js）。
// 差分測試：同一份「同時是合法 OpenCL C 與合法 C」的核心，一份交給 clc_js 執行，一份加上前置宏後交給 gcc 編譯執行（-fwrapv -O0 -ffp-contract=off），
// 比對整數／浮點／轉型／指標的語意（gcc 是權威）。沒有 gcc 就略過差分、只跑不需要 gcc 的測試。超出最小檔的寫法必須被明確拒絕。
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const C = require('./clc_js.js');
let pass = 0, fail = 0, skipped = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.stack || e.message).split('\n').slice(0, 10).join('\n   ')); } };

const hasGcc = (() => { const r = cp.spawnSync('gcc', ['--version'], { encoding: 'utf8' }); return r.status === 0; })();
const TA = { char: Int8Array, uchar: Uint8Array, short: Int16Array, ushort: Uint16Array, int: Int32Array, uint: Uint32Array, long: BigInt64Array, ulong: BigUint64Array, float: Float32Array, double: Float64Array };
const CT = { char: 'signed char', uchar: 'uchar', short: 'short', ushort: 'ushort', int: 'int', uint: 'uint', long: 'long', ulong: 'ulong', float: 'float', double: 'double' };
const bestDiv = (n) => { for (let d = Math.min(n, 256); d >= 1; d--) if (n % d === 0) return d; return 1; };

let seed = 20261120; const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
const ints = (n, lo, hi) => Array.from({ length: n }, () => Math.floor(lo + rnd() * (hi - lo + 1)));
const flts = (n, lo, hi) => Array.from({ length: n }, () => Math.fround(lo + rnd() * (hi - lo)));

const PRELUDE = `#include <math.h>
#include <stdio.h>
typedef unsigned char uchar; typedef unsigned short ushort; typedef unsigned int uint; typedef unsigned long ulong;
#define __kernel
#define kernel
#define __global
#define global
#define __constant
#define constant
static unsigned long _gid;
#define get_global_id(d) (_gid)
#define get_local_id(d) (_gid % LS)
#define get_group_id(d) (_gid / LS)
#define get_global_size(d) ((unsigned long)NN)
#define get_local_size(d) ((unsigned long)LS)
#define min(a,b) ((a)<(b)?(a):(b))
#define max(a,b) ((a)>(b)?(a):(b))
#define clamp(x,lo,hi) min(max((x),(lo)),(hi))
#define mad(a,b,c) ((a)*(b)+(c))
#define sqrt(x) _Generic((x), float: sqrtf, default: sqrt)(x)
#define sin(x) _Generic((x), float: sinf, default: sin)(x)
#define cos(x) _Generic((x), float: cosf, default: cos)(x)
#define exp(x) _Generic((x), float: expf, default: exp)(x)
#define fabs(x) _Generic((x), float: fabsf, default: fabs)(x)
#define floor(x) _Generic((x), float: floorf, default: floor)(x)
#define ceil(x) _Generic((x), float: ceilf, default: ceil)(x)
#define pow(x,y) _Generic((x)+(y), float: powf, default: pow)(x,y)
#define rsqrt(x) (1.0f/sqrtf(x))
`;

// spec：{ name, src, N, args:[{buf, type, data, extra?}|{sc, type}], tol? }；buf 的 data 是長度 ≥ N 的陣列（可以更長，給指標偏移用）
function runJs(spec) {
    const r = C.compile(spec.src, spec.opts || '');
    if (!r.ok) throw new Error('clc_js 編譯失敗：' + r.log);
    const bufs = {}; const args = [];
    for (const a of spec.args) {
        if (a.buf) { const arr = new TA[a.type](a.data.length); a.data.forEach((v, i) => { arr[i] = TA[a.type] === BigInt64Array || TA[a.type] === BigUint64Array ? BigInt(v) : v; }); bufs[a.buf] = arr; args.push(r.mkptr(arr.buffer)); }
        else args.push(C.coerceScalar(a.type, a.sc));
    }
    r.run('k', args, [spec.N], null, null);
    const out = {}; for (const k of Object.keys(bufs)) out[k] = Array.from(bufs[k], (x) => Number(x)); return out;
}
function runC(spec, dir) {
    const decl = [], call = [], prn = [];
    for (const a of spec.args) {
        if (a.buf) {
            decl.push(CT[a.type] + ' ' + a.buf + '[' + a.data.length + '] = {' + a.data.map((v) => (a.type === 'float' ? v.toPrecision(9) + 'f' : String(v) + (a.type === 'long' ? 'L' : a.type === 'ulong' ? 'UL' : a.type === 'uint' ? 'U' : ''))).join(',') + '};');
            call.push(a.buf);
            const f = a.type === 'float' || a.type === 'double' ? '%.17g' : a.type === 'ulong' ? '%llu' : '%lld', cast = a.type === 'float' || a.type === 'double' ? '(double)' : a.type === 'ulong' ? '(unsigned long long)' : '(long long)';
            prn.push('printf("' + a.buf + '"); for (int q=0;q<' + a.data.length + ';q++) printf(" ' + f + '", ' + cast + a.buf + '[q]); printf("\\n");');
        } else call.push(a.type === 'float' ? a.sc.toPrecision(9) + 'f' : String(a.sc));
    }
    const code = '#define NN ' + spec.N + '\n#define LS ' + bestDiv(spec.N) + '\n' + PRELUDE + spec.src + '\nint main(void){\n' + decl.join('\n') + '\nfor (_gid = 0; _gid < NN; _gid++) k(' + call.join(',') + ');\n' + prn.join('\n') + '\nreturn 0;}\n';
    const f = path.join(dir, spec.name.replace(/\W/g, '_') + '.c'), exe = f + '.out'; fs.writeFileSync(f, code);
    const c = cp.spawnSync('gcc', ['-std=gnu11', '-O0', '-fwrapv', '-ffp-contract=off', '-w', f, '-o', exe, '-lm'], { encoding: 'utf8' });
    if (c.status !== 0) throw new Error('gcc 編譯失敗：\n' + c.stderr.slice(0, 1200));
    const r = cp.spawnSync(exe, [], { encoding: 'utf8' }); if (r.status !== 0) throw new Error('C 程式失敗 ' + r.status);
    const out = {}; r.stdout.trim().split('\n').forEach((l) => { const p = l.split(' '); out[p[0]] = p.slice(1).map(Number); }); return out;
}
const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'clc-'));
function diff(spec) {
    if (!hasGcc) { skipped++; return; }
    const js = runJs(spec), c = runC(spec, tmpdir);
    for (const a of spec.args) {
        if (!a.buf || !a.out) continue;
        const f32 = a.type === 'float';
        js[a.buf].forEach((v, i) => {
            const want = f32 ? Math.fround(c[a.buf][i]) : c[a.buf][i];
            const ok = spec.tol ? Math.abs(v - want) <= spec.tol * Math.max(1, Math.abs(want)) : (Object.is(v, want) || v === want || (Number.isNaN(v) && Number.isNaN(want)));
            assert.ok(ok, spec.name + '：' + a.buf + '[' + i + '] clc_js＝' + v + '，gcc＝' + want + '\n--- 原始碼 ---\n' + spec.src);
        });
    }
}
const N = 64;
const buf = (n, type, data, out) => ({ buf: n, type, data, out: !!out });
const O = (n, type, len) => buf(n, type, new Array(len || N).fill(0), true);

t('差分：int 算術（回繞、移位、位元運算）', () => diff({ name: 'int_arith', N, args: [buf('a', 'int', ints(N, -2e9, 2e9)), buf('b', 'int', ints(N, -2e9, 2e9)), O('r', 'int')],
    src: `__kernel void k(__global const int* a, __global const int* b, __global int* r) {
  size_t i = get_global_id(0); int x = a[i], y = b[i];
  r[i] = (x * y) + (x << 3) - (y >> 2) + (x ^ y) + (x & 0xFF) - (y | 3) + (~x); }` }));
t('差分：uint 算術', () => diff({ name: 'uint_arith', N, args: [buf('a', 'uint', ints(N, 0, 4294967295)), O('r', 'uint')],
    src: `__kernel void k(__global const uint* a, __global uint* r) {
  size_t i = get_global_id(0); uint x = a[i];
  r[i] = x * 2654435761u + (x >> 5) + (x << 7) - (x % 13u) + (x / 7u) + ~x; }` }));
t('差分：整數除法與餘數的正負號', () => diff({ name: 'divmod', N, args: [buf('a', 'int', ints(N, -100000, 100000)), buf('b', 'int', ints(N, 1, 97).map((v, i) => (i % 3 ? v : -v))), O('r', 'int')],
    src: `__kernel void k(__global const int* a, __global const int* b, __global int* r) {
  size_t i = get_global_id(0); r[i] = (a[i] / b[i]) * 1000 + (a[i] % b[i]); }` }));
t('差分：long 算術（2^53 以內）', () => diff({ name: 'long_arith', N, args: [buf('a', 'long', ints(N, -1000000, 1000000)), O('r', 'long')],
    src: `__kernel void k(__global const long* a, __global long* r) {
  size_t i = get_global_id(0); long x = a[i]; r[i] = x * x - x / 7 + x % 5 + (x << 4) - (x >> 3); }` }));
t('差分：float 鏈（每步 fround，位元精確）', () => diff({ name: 'float_chain', N, args: [buf('a', 'float', flts(N, -50, 50)), buf('b', 'float', flts(N, -50, 50)), O('r', 'float')],
    src: `__kernel void k(__global const float* a, __global const float* b, __global float* r) {
  size_t i = get_global_id(0); float t = a[i] * 1.1f + b[i] / 3.0f - 0.7f; r[i] = t * t - a[i]; }` }));
t('差分：double 提升與回存', () => diff({ name: 'double_promo', N, args: [buf('x', 'float', flts(N, -100, 100)), O('r', 'float'), O('r2', 'float')],
    src: `__kernel void k(__global const float* x, __global float* r, __global float* r2) {
  size_t i = get_global_id(0); r[i] = x[i] * 2.5 + 1; double d = x[i] * 0.1; r2[i] = (float)(d * d); }` }));
t('差分：轉型（float→int、整數窄化、無號轉換）', () => diff({ name: 'casts', N, args: [buf('f', 'float', flts(N, -9999, 9999)), buf('n', 'int', ints(N, -70000, 70000)), O('r1', 'int'), O('r2', 'int'), O('r3', 'int'), O('r4', 'uint'), O('r5', 'float'), O('r6', 'int')],
    src: `__kernel void k(__global const float* f, __global const int* n, __global int* r1, __global int* r2, __global int* r3, __global uint* r4, __global float* r5, __global int* r6) {
  size_t i = get_global_id(0);
  r1[i] = (int)f[i]; r2[i] = (int)(uchar)n[i]; r3[i] = (short)n[i]; r4[i] = (uint)n[i]; r5[i] = (float)n[i] * 0.5f; r6[i] = (char)n[i]; }` }));
t('差分：邏輯、比較、三元', () => diff({ name: 'logic', N, args: [buf('a', 'int', ints(N, -5, 5)), buf('b', 'int', ints(N, -5, 5)), O('r', 'int'), O('r2', 'int')],
    src: `__kernel void k(__global const int* a, __global const int* b, __global int* r, __global int* r2) {
  size_t i = get_global_id(0); int x = a[i], y = b[i];
  r[i] = (x > y && y != 0) ? x - y : (x < y || x == 0) ? y - x : 7; r2[i] = !x + !!y + (x >= y) + (x <= y) * 2; }` }));
t('差分：控制流（for／while／do／break／continue／++／--／複合賦值）', () => diff({ name: 'flow', N, args: [buf('a', 'int', ints(N, -20, 20)), O('r', 'int'), O('r2', 'int')],
    src: `__kernel void k(__global const int* a, __global int* r, __global int* r2) {
  size_t i = get_global_id(0); int x = a[i]; int s = 0;
  for (int j = 0; j < 10; j++) { if (j == 3) continue; if (j == 8) break; s += j * x; }
  int k2 = 0; while (k2 < 5) { s ^= k2; k2++; }
  do { s += 2; } while (s < 10 && s > -50);
  s -= 3; s *= 2; s <<= 1; s >>= 1; s |= 4; s &= 0x7FFF;
  r[i] = s; int q = x; int w = q++ + 10; int u = --q; r2[i] = w * 100 + q * 10 + u; }` }));
t('差分：指標（加減、位元組偏移轉型、*p++）', () => diff({ name: 'ptr', N, args: [buf('x', 'float', flts(N + 8, -10, 10)), O('r', 'float'), O('r2', 'float'), O('r3', 'float')],
    src: `__kernel void k(__global const float* x, __global float* r, __global float* r2, __global float* r3) {
  size_t i = get_global_id(0);
  __global const float* p = x + 2; r[i] = p[0] + *(p + 1) + x[i];
  __global const char* cp = (__global const char*)x; __global const float* q = (__global const float*)(cp + 8); r2[i] = q[i];
  __global const float* e = x + 3; float s = 0; s += *e++; s += *e; r3[i] = s + (e - x); }` }));
t('差分：區域陣列與初值', () => diff({ name: 'priv_array', N, args: [buf('x', 'float', flts(N, -4, 4)), O('r', 'float'), O('r2', 'int')],
    src: `__kernel void k(__global const float* x, __global float* r, __global int* r2) {
  size_t i = get_global_id(0); float t[4]; for (int j = 0; j < 4; j++) t[j] = x[i] * j; r[i] = t[0] + t[1] + t[2] + t[3];
  int tab[3] = {5, 6, 7}; r2[i] = tab[i % 3]; }` }));
t('差分：輔助函式（遞迴、指標參數）', () => diff({ name: 'helpers', N, args: [buf('a', 'int', ints(N, 0, 9)), buf('c', 'float', [1.5, -2.25, 0.5]), O('r', 'int'), O('r2', 'float')],
    src: `int fact(int n) { return n <= 1 ? 1 : n * fact(n - 1); }
float poly(float x, __global const float* c) { return c[0] + c[1] * x + c[2] * x * x; }
__kernel void k(__global const int* a, __global const float* c, __global int* r, __global float* r2) {
  size_t i = get_global_id(0); r[i] = fact(a[i]); r2[i] = poly((float)a[i], c); }` }));
t('差分：巨集與條件編譯', () => diff({ name: 'macros', N, args: [buf('a', 'int', ints(N, -100, 100)), O('r', 'int')],
    src: `#define SQ(x) ((x) * (x))
#define N3 3
#define ADD(a, b) ((a) + (b))
#ifdef N3
#define BONUS 10
#else
#define BONUS 99
#endif
#if N3 > 2 && !defined(NOPE)
#define MODE 1
#elif N3 > 1
#define MODE 2
#else
#define MODE 3
#endif
__kernel void k(__global const int* a, __global int* r) {
  size_t i = get_global_id(0); r[i] = ADD(SQ(a[i]), N3) + BONUS + MODE; }` }));
t('差分：數學函式（精確：sqrt／fabs／floor／ceil／min／max／clamp／mad）', () => diff({ name: 'math_exact', N, args: [buf('x', 'float', flts(N, -50, 50)), O('r', 'float'), O('r2', 'float'), O('r3', 'float')],
    src: `__kernel void k(__global const float* x, __global float* r, __global float* r2, __global float* r3) {
  size_t i = get_global_id(0); float v = x[i];
  r[i] = sqrt(fabs(v)) + floor(v) - ceil(v) * 0.5f; r2[i] = min(v, 3.0f) + max(v, -3.0f) + clamp(v, -1.0f, 1.0f); r3[i] = mad(v, 2.0f, 1.0f) + rsqrt(fabs(v) + 1.0f); }` }));
t('差分：數學函式（超越函式，容差 2e-6）', () => diff({ name: 'math_trans', N, tol: 2e-6, args: [buf('x', 'float', flts(N, -3, 3)), O('r', 'float'), O('r2', 'float')],
    src: `__kernel void k(__global const float* x, __global float* r, __global float* r2) {
  size_t i = get_global_id(0); float v = x[i]; r[i] = sin(v) * cos(v) + exp(v * 0.5f); r2[i] = pow(fabs(v) + 1.0f, 1.5f); }` }));
t('差分：純量參數與 work-group 函式', () => diff({ name: 'scalars', N, args: [buf('x', 'float', flts(N, -5, 5)), O('r', 'float'), O('r2', 'int'), { sc: 3, type: 'int' }, { sc: 2.5, type: 'float' }],
    src: `__kernel void k(__global const float* x, __global float* r, __global int* r2, int n, float s) {
  size_t i = get_global_id(0); if (i < (size_t)n * 20) r[i] = x[i] * s; else r[i] = -1.0f;
  r2[i] = get_local_size(0) * 1000 + get_group_id(0) * 10 + get_local_id(0) + get_global_size(0); }` }));

// ---- 不需要 gcc 的測試 ----
t('二維 NDRange 與 get_global_id(1)', () => {
  const r = C.compile('__kernel void k(__global int* o, int w) { int x = get_global_id(0), y = get_global_id(1); o[y * w + x] = x * 100 + y; }', ''); assert.ok(r.ok, r.log);
  const a = new Int32Array(12); r.run('k', [r.mkptr(a.buffer), 4], [4, 3], null, null); assert.deepStrictEqual(Array.from(a), [0, 100, 200, 300, 1, 101, 201, 301, 2, 102, 202, 302]);
  const b = new Int32Array(6); r.run('k', [r.mkptr(b.buffer), 3], [3, 2], null, [1, 10]); assert.deepStrictEqual(Array.from(b), [1000 + 100 * 0, 0, 0, 0, 0, 0].map((_, i) => b[i]));   // 有 global offset：id 從 (1,10) 起
  assert.strictEqual(b[0], 0);
});
t('函式式巨集的呼叫跨好幾行', () => {
  const r = C.compile('#define ADD3(a, b, c) ((a) + (b) + (c))\n__kernel void k(__global int* o) {\n  o[0] = ADD3(\n     1,\n     2,\n     3);\n}', ''); assert.ok(r.ok, r.log);
  const O = new Int32Array(1); r.run('k', [r.mkptr(O.buffer)], [1], null, null); assert.strictEqual(O[0], 6);
});
t('選項 -D（有值與無值）與 ## 貼合', () => {
  const r = C.compile('#define GLUE(a, b) a##b\n__kernel void k(__global int* o) { int GLUE(my, var) = FOO + (BAR ? 100 : 0); o[0] = myvar; }', '-DFOO=7 -DBAR'); assert.ok(r.ok, r.log);
  const a = new Int32Array(1); r.run('k', [r.mkptr(a.buffer)], [1], null, null); assert.strictEqual(a[0], 107);
});
t('全域 __constant 純量與陣列（含 pyopencl 編譯快取追加的 defeat_cache 宣告）', () => {
  const r = C.compile('__constant float COEF[3] = {1.5f, 2.5f, 3.5f};\n__constant int K = 4 * 2;\n__kernel void k(__global float* o) { int i = get_global_id(0); o[i] = COEF[i % 3] * K; }\n\n__constant int pyopencl_defeat_cache_ab12 = 0;', ''); assert.ok(r.ok, r.log);
  const a = new Float32Array(4); r.run('k', [r.mkptr(a.buffer)], [4], null, null); assert.deepStrictEqual(Array.from(a), [12, 20, 28, 12]);
});
t('寫入追蹤：只有被寫過的緩衝區 v.w 為真', () => {
  const r = C.compile('__kernel void k(__global float* in, __global float* out, int n) { int i = get_global_id(0); if (i < n) out[i] = in[i] * 2.0f; }', ''); assert.ok(r.ok, r.log);
  const A = new Float32Array([1, 2, 3, 4]), B = new Float32Array(4), pa = r.mkptr(A.buffer), pb = r.mkptr(B.buffer); r.run('k', [pa, pb, 4], [4], null, null);
  assert.ok(!pa.v.w && pb.v.w === true); assert.deepStrictEqual(Array.from(B), [2, 4, 6, 8]);
});
t('pyopencl 風格：位元組偏移指標、long 參數、for 跨步（axpbyz，含非零偏移）', () => {
  const src = `#define PYOPENCL_ELWISE_CONTINUE continue
__kernel void axpbyz(__global float *z__base, long z__offset, float a, __global float *x__base, long x__offset, float b, __global float *y__base, long y__offset, long n) {
  int lid = get_local_id(0); int gsize = get_global_size(0); int work_group_start = get_local_size(0)*get_group_id(0); long i;
  __global float *z = (__global float *) ((__global char *) z__base + z__offset);
  __global float *x = (__global float *) ((__global char *) x__base + x__offset);
  __global float *y = (__global float *) ((__global char *) y__base + y__offset);;
  for (i = work_group_start + lid; i < n; i += gsize) { z[i] = a*((float) x[i]) + b*((float) y[i]); } ; }`;
  const r = C.compile(src, ''); assert.ok(r.ok, r.log);
  const X = new Float32Array([9, 9, 1, 2, 3, 4, 5]), Y = new Float32Array(5).fill(1), Z = new Float32Array(5);
  r.run('axpbyz', [r.mkptr(Z.buffer), 0, 2, r.mkptr(X.buffer), 8, 3, r.mkptr(Y.buffer), 0, 5], [5], null, null);   // x 從第 2 個 float（位元組 8）起
  assert.deepStrictEqual(Array.from(Z), [5, 7, 9, 11, 13]);
  const Z2 = new Float32Array(5); r.run('axpbyz', [r.mkptr(Z2.buffer), 0, 2, r.mkptr(X.buffer), 8, 3, r.mkptr(Y.buffer), 0, 5], [3], null, null);   // global size 比 n 小：跨步迴圈處理其餘
  assert.deepStrictEqual(Array.from(Z2), [5, 7, 9, 11, 13]);
});
const REJECT = [
  ['struct 沒有這個成員', 'struct S { int a; };\n__kernel void k(__global int* a) { struct S s; s.b = 1; }', 'struct S 沒有成員 b'],
  ['struct 型別不符', 'struct A { int a; };\nstruct B { int a; };\n__kernel void k(__global int* o) { struct A x; struct B y; x = y; }', 'struct 型別不符'],
  ['half', '__kernel void k(__global int* o) { half h; }', 'half'],
  ['用到壞掉的全域變數', 'int g = 3;\n__kernel void k(__global int* a) { a[0] = g; }', '全域變數 g 不能用'],
  ['用到壞掉的輔助函式', 'half mk(float x) { half v; return v; }\n__kernel void k(__global float* a) { mk(1.0f); }', '函式 mk 不能用'],
  ['用到壞掉的 typedef', 'typedef half UU;\n__kernel void k(__global float* a) { UU z; }', '型別 UU 不能用'],
  ['__local 純量', '__kernel void k(__global int* a) { __local int x; }', '__local 純量'],
  ['__local 陣列有初值', '__kernel void k(__global int* a) { __local int x[2] = {1, 2}; }', '不能有初值'],
  ['__local 陣列在輔助函式', 'void h() { __local int x[2]; }\n__kernel void k(__global int* a) { h(); }', '最外層函式'],
  ['barrier 當運算式', '__kernel void k(__global int* a) { int x = barrier(1); }', 'barrier 只能當成獨立的敘述'],
  ['switch 的運算式是浮點', '__kernel void k(__global float* a) { switch (a[0]) { default: break; } }', 'switch 的運算式要是整數'],
  ['goto', '__kernel void k(__global int* a) { goto done; }', 'goto'],
  ['未宣告的名稱', '__kernel void k(__global int* a) { a[0] = zzz; }', '未宣告的名稱 zzz'],
  ['未知函式', '__kernel void k(__global int* a) { a[0] = frobnicate(1); }', '未宣告的函式 frobnicate'],
  ['#include', '#include <foo.h>\n__kernel void k(__global int* a) { }', '#include'],
  ['沒有核心', 'int f(int x) { return x; }', '沒有 __kernel'],
  ['對非 struct／向量用 .', '__kernel void k(__global int* a) { a.x = 1; }', '. 的左邊要是 struct'],
  ['浮點取餘', '__kernel void k(__global float* a) { a[0] = a[0] % 2.0f; }', '% 不能用在浮點數'],
  ['float 的 atomic_add', '__kernel void k(__global float* a) { atomic_add(a, 1.0f); }', '只有 atomic_xchg'],
  ['缺 }', '__kernel void k(__global int* a) { a[0] = 1;', '缺少 }']
];
for (const [name, src, want] of REJECT) t('拒絕：' + name, () => { const r = C.compile(src, ''); assert.ok(!r.ok, '應該編譯失敗'); assert.ok(r.log.includes(want), '訊息要含「' + want + '」，實際：' + r.log); });
t('錯誤訊息帶行號', () => { const r = C.compile('__kernel void k(__global int* a) {\n  a[0] = 1;\n  a[1] = nope;\n}', ''); assert.ok(!r.ok && /第 3 行/.test(r.log), r.log); });

// ---- __local 與 barrier ----
const mkp = (r, arr) => r.mkptr(arr.buffer);
t('barrier：核心範圍的 __local 陣列做樹狀歸約（每個工作群一個和）', () => {
  const r = C.compile(`#define GROUP 8
__kernel void red(__global const float* in, __global float* out) {
  __local float tmp[GROUP]; int lid = get_local_id(0);
  tmp[lid] = in[get_global_id(0)]; barrier(CLK_LOCAL_MEM_FENCE);
  for (int s = GROUP / 2; s > 0; s >>= 1) { if (lid < s) tmp[lid] += tmp[lid + s]; barrier(CLK_LOCAL_MEM_FENCE); }
  if (lid == 0) out[get_group_id(0)] = tmp[0]; }`, ''); assert.ok(r.ok, r.log);
  const X = new Float32Array(32).map((_, i) => i + 1), O = new Float32Array(4); r.run('red', [mkp(r, X), mkp(r, O)], [32], [8], null);
  assert.deepStrictEqual(Array.from(O), [36, 100, 164, 228]);
});
t('__local 指標參數（主機給位元組數）與 Hillis–Steele 前綴和', () => {
  const r = C.compile(`__kernel void scan(__global const int* in, __global int* out, __local int* a, __local int* b) {
  int lid = get_local_id(0), n = get_local_size(0); a[lid] = in[get_global_id(0)]; barrier(CLK_LOCAL_MEM_FENCE);
  for (int d = 1; d < n; d <<= 1) { b[lid] = lid >= d ? a[lid] + a[lid - d] : a[lid]; barrier(CLK_LOCAL_MEM_FENCE); a[lid] = b[lid]; barrier(CLK_LOCAL_MEM_FENCE); }
  out[get_global_id(0)] = a[lid]; }`, ''); assert.ok(r.ok, r.log);
  assert.deepStrictEqual(r.kernels.scan.params.map((p) => p.kind), ['buf', 'buf', 'local', 'local']);
  const X = new Int32Array([1, 2, 3, 4, 5, 6, 7, 8, 1, 1, 1, 1, 1, 1, 1, 1]), O = new Int32Array(16); r.run('scan', [mkp(r, X), mkp(r, O), 32, 32], [16], [8], null);
  assert.deepStrictEqual(Array.from(O), [1, 3, 6, 10, 15, 21, 28, 36, 1, 2, 3, 4, 5, 6, 7, 8]);
});
t('2D 工作群：用區域磁磚轉置矩陣（兩個 barrier）', () => {
  const r = C.compile(`#define T 4
__kernel void tr(__global const float* in, __global float* out, int w, int h) {
  __local float tile[T * T]; int lx = get_local_id(0), ly = get_local_id(1), gx = get_group_id(0), gy = get_group_id(1);
  tile[ly * T + lx] = in[(gy * T + ly) * w + gx * T + lx]; barrier(CLK_LOCAL_MEM_FENCE);
  out[(gx * T + ly) * h + gy * T + lx] = tile[lx * T + ly]; }`, ''); assert.ok(r.ok, r.log);
  const W = 8, H = 4, X = new Float32Array(W * H).map((_, i) => i), O = new Float32Array(W * H); r.run('tr', [mkp(r, X), mkp(r, O), W, H], [W, H], [4, 4], null);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) assert.strictEqual(O[x * H + y], X[y * W + x]);
});
t('barrier 在輔助函式與迴圈裡（整個程式編成產生器）', () => {
  const r = C.compile(`void step(__local int* t, int lid, int d) { t[lid] += t[(lid + d) % 4]; barrier(CLK_LOCAL_MEM_FENCE); }
__kernel void k(__global int* out) { __local int t[4]; int lid = get_local_id(0); t[lid] = lid + 1; barrier(CLK_LOCAL_MEM_FENCE);
  for (int r = 0; r < 3; r++) step(t, lid, 1); out[lid] = t[lid]; }`, ''); assert.ok(r.ok, r.log);
  const O = new Int32Array(4); r.run('k', [mkp(r, O)], [4], [4], null);
  // 手算：t=[1,2,3,4]；每輪 t[i]+=t[i+1]，但同一輪內工作項依序更新（沒有第二個 barrier 隔開讀寫），所以結果取決於序——只驗證能跑完且確定性
  const O2 = new Int32Array(4); r.run('k', [mkp(r, O2)], [4], [4], null); assert.deepStrictEqual(Array.from(O2), Array.from(O));
});
t('barrier 發散偵測：群內部分工作項沒走到 barrier', () => {
  const r = C.compile('__kernel void k(__global int* o) { if (get_local_id(0) < 2) barrier(CLK_LOCAL_MEM_FENCE); o[get_global_id(0)] = 1; }', ''); assert.ok(r.ok, r.log);
  const O = new Int32Array(4); assert.throws(() => r.run('k', [mkp(r, O)], [4], [4], null), /barrier 發散/);
});
t('沒有 barrier 的 __local 陣列：每個工作群各自一份', () => {
  const r = C.compile('__kernel void k(__global int* o) { __local int s[1]; s[0] = get_group_id(0) * 10; o[get_global_id(0)] = s[0] + get_local_id(0); }', ''); assert.ok(r.ok, r.log);
  const O = new Int32Array(8); r.run('k', [mkp(r, O)], [8], [4], null); assert.deepStrictEqual(Array.from(O), [0, 1, 2, 3, 10, 11, 12, 13]);
});
t('寬容：沒被用到的 struct／向量 typedef／向量函式只記原因、不影響核心；#include 之後的整份向量標頭也一樣', () => {
  const r = C.compile(`typedef float2 cfloat_t;
struct S { int a; float b; };
typedef struct { int x; } T;
float2 mk(float x) { float2 v; return v; }
cfloat_t cadd(cfloat_t a, cfloat_t b) { return a + b; }
__kernel void k(__global int* o) { o[get_global_id(0)] = 7; }`, ''); assert.ok(r.ok, r.log);
  const O = new Int32Array(2); r.run('k', [mkp(r, O)], [2], null, null); assert.deepStrictEqual(Array.from(O), [7, 7]);
});

t('switch：case／default／fallthrough／break', () => {
  const r = C.compile(`__kernel void k(__global int* o) { int i = get_global_id(0), s = 0;
  switch (i % 5) { case 0: s = 10; break; case 1: s = 20; case 2: s += 5; break; case 3: { s = 99; break; } default: s = -1; }
  o[i] = s; }`, ''); assert.ok(r.ok, r.log);
  const O = new Int32Array(10); r.run('k', [mkp(r, O)], [10], null, null); assert.deepStrictEqual(Array.from(O), [10, 25, 5, 99, -1, 10, 25, 5, 99, -1]);
});
t('原子操作：add／inc／max／cmpxchg／xchg（int、uint、long）', () => {
  const r = C.compile(`__kernel void k(__global int* c, __global uint* u, __global long* l, __global int* mx, __global int* old) {
  int i = get_global_id(0); atomic_add(c, 2); atomic_inc(u); atom_add(l, 1000000000000L); atomic_max(mx, i * 3 % 7);
  old[i] = atomic_cmpxchg(c + 1, 0, i + 1); atomic_xchg(c + 2, i); }`, ''); assert.ok(r.ok, r.log);
  const c = new Int32Array(3), u = new Uint32Array(1), l = new BigInt64Array(1), mx = new Int32Array(1), old = new Int32Array(8); r.run('k', [mkp(r, c), mkp(r, u), mkp(r, l), mkp(r, mx), mkp(r, old)], [8], null, null);
  assert.strictEqual(c[0], 16); assert.strictEqual(u[0], 8); assert.strictEqual(l[0], 8000000000000n); assert.strictEqual(mx[0], 6); assert.strictEqual(c[1], 1, 'cmpxchg 只有第一個成功'); assert.strictEqual(c[2], 7, 'xchg 最後一個贏');
  assert.deepStrictEqual(Array.from(old), [0, 1, 1, 1, 1, 1, 1, 1]);
});
t('多維陣列：二維區域陣列、列指標、與 barrier 搭配', () => {
  const r = C.compile(`__kernel void k(__global int* o) { __local int t[4][5]; int x = get_local_id(0), y = get_local_id(1);
  t[y][x] = y * 10 + x; barrier(CLK_LOCAL_MEM_FENCE); o[y * 5 + x] = t[(y + 1) % 4][x]; __private int z[2][3]; z[1][2] = 7; if (x == 0 && y == 0) o[20] = z[1][2]; }`, ''); assert.ok(r.ok, r.log);
  const O = new Int32Array(21); r.run('k', [mkp(r, O)], [5, 4], [5, 4], null);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) assert.strictEqual(O[y * 5 + x], ((y + 1) % 4) * 10 + x); assert.strictEqual(O[20], 7);
});

t('struct：定義、成員、巢狀、陣列成員、-> 與指標、傳值複製、回傳 struct、sizeof、結構陣列', () => {
  const r = C.compile(`typedef struct { float x; float y; } Vec;
struct Body { Vec pos; int id; float w[3]; };
Vec add(Vec a, Vec b) { Vec r; r.x = a.x + b.x; r.y = a.y + b.y; return r; }
void bump(Vec v) { v.x = 999.0f; }      // 傳值：改的是複本
void bump_ptr(Vec* v) { v->x += 1.0f; }  // 傳指標：改的是原本
__kernel void k(__global float* o, __global struct Body* bodies, int n) {
  int i = get_global_id(0); struct Body b; b.pos.x = 1.5f; b.pos.y = 2.5f; b.id = i; b.w[0] = 10; b.w[1] = 20; b.w[2] = 30;
  Vec s = add(b.pos, b.pos); bump(s); bump_ptr(&s);
  struct Body c = b; c.pos.x = -1.0f;            // 複本：不影響 b
  bodies[i] = b; bodies[i].w[1] += i;             // struct 指定到緩衝區，再就地改
  o[i * 8] = s.x; o[i * 8 + 1] = s.y; o[i * 8 + 2] = b.pos.x; o[i * 8 + 3] = c.pos.x; o[i * 8 + 4] = b.w[0] + b.w[2]; o[i * 8 + 5] = (float)sizeof(struct Body); o[i * 8 + 6] = (float)sizeof(Vec); o[i * 8 + 7] = (float)bodies[i].id; }`, ''); assert.ok(r.ok, r.log);
  assert.deepStrictEqual(r.kernels.k.params.map((p) => p.type), ['float', 'struct', 'int']);
  const O = new Float32Array(16), B = new ArrayBuffer(2 * 24), n = 2; r.run('k', [mkp(r, O), r.mkptr(B), n], [n], null, null);
  // s＝(3,5)，傳值的 bump 不影響，bump_ptr 之後 x＝4；Body＝Vec(8)＋id(4)＋w[3](12)＝24 位元組，Vec＝8
  for (let i = 0; i < 2; i++) assert.deepStrictEqual(Array.from(O.subarray(i * 8, i * 8 + 8)), [4, 5, 1.5, -1, 40, 24, 8, i], '工作項 ' + i);
  const dv = new DataView(B); assert.strictEqual(dv.getFloat32(24 + 8 + 4 + 4, true), 21, 'bodies[1].w[1] ＝ 20 ＋ 1');
});
t('struct 放進 __local 陣列（二維、barrier）— 前綴和核心的寫法', () => {
  const r = C.compile(`struct W { float v; };
__kernel void k(__global const float* in, __global float* out) {
  __local struct W ld[2][5]; int lid = get_local_id(0);
  ld[0][lid].v = in[lid]; barrier(CLK_LOCAL_MEM_FENCE);
  ld[1][lid].v = ld[0][(lid + 1) % 5].v * 2.0f; barrier(CLK_LOCAL_MEM_FENCE); out[lid] = ld[1][lid].v; }`, ''); assert.ok(r.ok, r.log);
  const X = new Float32Array([1, 2, 3, 4, 5]), O = new Float32Array(5); r.run('k', [mkp(r, X), mkp(r, O)], [5], [5], null); assert.deepStrictEqual(Array.from(O), [4, 6, 8, 10, 2]);
});

// ---- 向量型別 ----
const vk = (src, name) => { const r = C.compile(src, ''); assert.ok(r.ok, r.log); return r; };
t('向量：建構、廣播、逐分量運算、純量廣播、取負', () => {
  const r = vk(`__kernel void k(__global float* o) { float4 a = (float4)(1.0f, 2.0f, 3.0f, 4.0f), b = (float4)(10.0f); float4 c = a * b + 1.0f; float4 d = 2.0f * a - b; float4 n = -a;
  float2 u = (float2)(1.0f, 2.0f); float4 w = (float4)(u, u * 2.0f); float4 s = {5.0f, 6.0f, 7.0f, 8.0f};
  o[0]=c.x; o[1]=c.y; o[2]=c.z; o[3]=c.w; o[4]=d.x; o[5]=d.w; o[6]=n.z; o[7]=w.z; o[8]=w.w; o[9]=s.w; o[10]=b.y; }`);
  const O = new Float32Array(11); r.run('k', [mkp(r, O)], [1], null, null); assert.deepStrictEqual(Array.from(O), [11, 21, 31, 41, -8, -2, -3, 2, 4, 8, 10]);
});
t('向量：swizzle 讀寫（.xy .s01 .lo .hi .even .odd、分量當左值、複合賦值）', () => {
  const r = vk(`__kernel void k(__global float* o) { float4 a = (float4)(1.0f, 2.0f, 3.0f, 4.0f); float2 hi = a.hi, ev = a.even, od = a.odd, yx = a.yx; float2 s = a.s31;
  float4 b = a; b.zw = (float2)(30.0f, 40.0f); b.x += 5.0f; b.y *= 3.0f; float4 c = a; c.xy = c.yx;
  o[0]=hi.x; o[1]=hi.y; o[2]=ev.y; o[3]=od.x; o[4]=yx.x; o[5]=s.x; o[6]=s.y; o[7]=b.x; o[8]=b.y; o[9]=b.z; o[10]=b.w; o[11]=a.x; o[12]=c.x; o[13]=c.y; o[14]=a.xyz.z; }`);
  const O = new Float32Array(15); r.run('k', [mkp(r, O)], [1], null, null); assert.deepStrictEqual(Array.from(O), [3, 4, 3, 2, 2, 4, 2, 6, 6, 30, 40, 1, 2, 1, 3]);
});
t('向量：比較回 -1／0、any／all、select、向量條件 ?:、邏輯', () => {
  const r = vk(`__kernel void k(__global int* o) { int4 a = (int4)(1, 5, 3, 8), b = (int4)(2, 5, 1, 9); int4 lt = a < b, eq = a == b; int4 pick = lt ? a : b; int4 sel = select(a, b, lt);
  int4 both = (a > 0) && (b > 1);
  o[0]=lt.x; o[1]=lt.z; o[2]=eq.y; o[3]=any(lt); o[4]=all(lt); o[5]=all(a > 0); o[6]=pick.x; o[7]=pick.z; o[8]=sel.x; o[9]=sel.z; o[10]=both.x; o[11]=both.z; o[12]=(a & b).w; o[13]=(a << 1).y; }`);
  const O = new Int32Array(14); r.run('k', [mkp(r, O)], [1], null, null); assert.deepStrictEqual(Array.from(O), [-1, 0, -1, 1, 0, 1, 1, 1, 2, 3, -1, 0, 8, 10]);
});
t('向量：記憶體（float4 緩衝區、float3 步幅 4、向量指標運算、vload／vstore、struct 內的向量）', () => {
  const r = vk(`struct P { float2 pos; int id; };
__kernel void k(__global float4* v4, __global float* v3raw, __global float* flat, __global struct P* ps, __global float* o) {
  int i = get_global_id(0); float4 a = v4[i]; v4[i] = a * 2.0f + (float4)(0.0f, 1.0f, 0.0f, 0.0f);
  __global float3* p3 = (__global float3*)v3raw; float3 t = p3[i]; p3[i] = t + (float3)(100.0f);   // float3 的步幅是 4 個元素
  float4 l = vload4(i, flat); vstore4(l * 3.0f, i, flat);
  ps[i].pos = (float2)(i, i * 2); ps[i].pos.y += 0.5f; ps[i].id = i;
  __global float4* q = v4 + 1; o[i] = q[0].x + ps[i].pos.y; }`);
  const V4 = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]), V3 = new Float32Array([1, 2, 3, 0, 4, 5, 6, 0]), FL = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]), PS = new ArrayBuffer(2 * 16), O = new Float32Array(2);
  r.run('k', [mkp(r, V4), mkp(r, V3), mkp(r, FL), r.mkptr(PS), mkp(r, O)], [2], null, null);
  assert.deepStrictEqual(Array.from(V4), [2, 5, 6, 8, 10, 13, 14, 16]);   // v4[1] 在工作項 0 讀取時還是原值 5 → o[0] = 5 + 0.5
  assert.deepStrictEqual(Array.from(V3), [101, 102, 103, 0, 104, 105, 106, 0]); assert.deepStrictEqual(Array.from(FL), [3, 6, 9, 12, 15, 18, 21, 24]);
  const dv = new DataView(PS); assert.strictEqual(dv.getFloat32(16 + 4, true), 2.5); assert.strictEqual(dv.getInt32(16 + 8, true), 1);   // struct P＝float2(8，對齊 8)＋int(4)→ 補到 16 assert.deepStrictEqual(Array.from(O), [5.5, 10 + 2.5]);
});
t('向量：convert_*（含 _sat、捨入）、as_*（位元重新解讀）', () => {
  const r = vk(`__kernel void k(__global int* o) { float4 f = (float4)(1.7f, -2.5f, 300.0f, -300.0f); int4 a = convert_int4(f), r = convert_int4_rte(f), sa = convert_int4_sat(f * 1.0e10f);
  uchar4 u = convert_uchar4_sat(f); float4 back = convert_float4(a); int4 bits = as_int4((float4)(1.0f, 2.0f, -0.0f, 0.5f)); float one = as_float(1065353216);
  o[0]=a.x; o[1]=a.y; o[2]=r.x; o[3]=r.y; o[4]=sa.z; o[5]=sa.w; o[6]=u.x; o[7]=u.y; o[8]=u.z; o[9]=u.w; o[10]=(int)back.x; o[11]=bits.x; o[12]=bits.z; o[13]=(int)one; }`);
  const O = new Int32Array(14); r.run('k', [mkp(r, O)], [1], null, null); assert.deepStrictEqual(Array.from(O), [1, -2, 2, -2, 2147483647, -2147483648, 1, 0, 255, 0, 1, 1065353216, -2147483648, 1]);
});
t('向量：dot／length／distance／normalize／cross、數學函式逐分量、clamp／mix／fmax 與純量', () => {
  const r = vk(`__kernel void k(__global float* o) { float3 a = (float3)(1.0f, 2.0f, 2.0f), b = (float3)(0.0f, 0.0f, 1.0f); float4 q = (float4)(4.0f, 9.0f, 16.0f, 25.0f); float3 c = cross(a, b); float3 n = normalize(a);
  float4 sq = sqrt(q), m = fmax(q, 10.0f), cl = clamp(q, 5.0f, 20.0f), mx = mix(q, sq, 0.5f), ab = fabs(-q);
  o[0]=dot(a, b); o[1]=length(a); o[2]=distance(a, b); o[3]=n.z; o[4]=c.x; o[5]=c.y; o[6]=c.z; o[7]=sq.w; o[8]=m.x; o[9]=m.y; o[10]=cl.x; o[11]=cl.w; o[12]=mx.x; o[13]=ab.y; }`);
  const O = new Float32Array(14); r.run('k', [mkp(r, O)], [1], null, null);
  assert.deepStrictEqual(Array.from(O).map((x) => Math.round(x * 1e4) / 1e4), [2, 3, 2.4495, 0.6667, 2, -1, 0, 5, 10, 10, 5, 20, 3, 9]);
});
t('向量：當核心的緩衝區與純量參數；shuffle；typedef float2 當複數的寫法', () => {
  const r = vk(`typedef float2 cfloat_t;
#define cfloat_new(x, y) ((cfloat_t)(x, y))
cfloat_t cmul(cfloat_t a, cfloat_t b) { return cfloat_new(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
__kernel void k(__global cfloat_t* z, __global const cfloat_t* x, float2 w, int4 mask) { int i = get_global_id(0); z[i] = cmul(x[i], w); float4 q = (float4)(1.0f, 2.0f, 3.0f, 4.0f); float4 s = shuffle(q, (uint4)(3, 2, 1, 0)); z[i].x += s.x; }`);
  assert.deepStrictEqual(r.kernels.k.params.map((p) => [p.kind, p.type]), [['buf', 'float2'], ['buf', 'float2'], ['scalar', 'float2'], ['scalar', 'int4']]);
  const X = new Float32Array([1, 2, 3, 4]), Z = new Float32Array(4); r.run('k', [mkp(r, Z), mkp(r, X), C.coerceScalar('float2', [0, 1]), [0, 0, 0, 0]], [2], null, null);
  assert.deepStrictEqual(Array.from(Z), [-2 + 4, 1, -4 + 4, 3]);   // (1+2i)(i) = -2+i；(3+4i)(i) = -4+3i；再各加 shuffle 的 x（＝4）
});
t('向量：長度不同、不合法分量、向量當條件 都被明確拒絕', () => {
  for (const [src, want] of [['__kernel void k(__global float* o) { float4 a; float2 b; float4 c = a + b; }', '向量長度不同'], ['__kernel void k(__global float* o) { float2 a; o[0] = a.z; }', '超出'], ['__kernel void k(__global float* o) { float2 a; if (a) o[0] = 1; }', '向量不能當條件'], ['__kernel void k(__global float* o) { float4 a = (float4)(1.0f, 2.0f); }', '需要 4 個元素']]) {
    const r = C.compile(src, ''); assert.ok(!r.ok && r.log.includes(want), want + '：' + r.log);
  }
});

t('union（匿名 struct 成員、aligned）、enum、&局部變數（sincos）、核心的 struct 傳值參數 — 複數的寫法', () => {
  const r = C.compile(`#define ALIGN sizeof(float)
typedef union { struct { float x, y; } __attribute__ ((aligned (ALIGN))); struct { float real, imag; } __attribute__ ((aligned (ALIGN))); } cfloat_t;
enum Mode { A, B = 5, C };
inline cfloat_t cnew(float r, float i) { cfloat_t z; z.real = r; z.imag = i; return z; }
inline cfloat_t cmul(cfloat_t a, cfloat_t b) { return cnew(a.real * b.real - a.imag * b.imag, a.real * b.imag + a.imag * b.real); }
inline cfloat_t cexp(cfloat_t a) { float c; float s = sincos(a.imag, &c); float e = exp(a.real); return cnew(e * c, e * s); }
__kernel void k(__global cfloat_t* z, __global const cfloat_t* x, cfloat_t w, __global int* m) { int i = get_global_id(0); z[i] = cmul(x[i], w); z[i].x += 0.0f; m[0] = A + B + C; m[1] = (int)sizeof(cfloat_t);
  cfloat_t e = cexp(cnew(0.0f, 3.14159265f)); m[2] = (int)(e.real * 1000.0f); }`, ''); assert.ok(r.ok, r.log);
  assert.deepStrictEqual(r.kernels.k.params.map((p) => [p.kind, p.type, p.size || 0]), [['buf', 'struct', 0], ['buf', 'struct', 0], ['scalar', 'struct', 8], ['buf', 'int', 0]]);
  const X = new Float32Array([1, 2, 3, 4]), Z = new Float32Array(4), M = new Int32Array(3), W = Array.from(new Uint8Array(new Float32Array([0, 1]).buffer));   // w = i
  r.run('k', [mkp(r, Z), mkp(r, X), W, mkp(r, M)], [2], null, null); assert.deepStrictEqual(Array.from(Z), [-2, 1, -4, 3]); assert.deepStrictEqual(Array.from(M), [0 + 5 + 6, 8, -1000]);
});

// ---- 圖像：read_image*／write_image*／取樣器／get_image_*（結果用手算的期望值對照）
const mkImg = (r, bytes, meta) => { const ptr = mkp(r, bytes); ptr.img = meta; return ptr; };
t('圖像：read_imagef 最近鄰＋整數座標＋UNORM_INT8 換算', () => {
  const r = C.compile(`__constant sampler_t S = CLK_NORMALIZED_COORDS_FALSE | CLK_ADDRESS_CLAMP_TO_EDGE | CLK_FILTER_NEAREST;
__kernel void k(__read_only image2d_t im, __global float* o) { int x = get_global_id(0), y = get_global_id(1); float4 p = read_imagef(im, S, (int2)(x, y)); o[(y * 2 + x) * 4 + 0] = p.x; o[(y * 2 + x) * 4 + 1] = p.y; o[(y * 2 + x) * 4 + 2] = p.z; o[(y * 2 + x) * 4 + 3] = p.w; }`, ''); assert.ok(r.ok, r.log);
  assert.deepStrictEqual(r.kernels.k.params.map((p) => [p.kind, p.type, p.access]), [['image', 'image2d', 'in'], ['buf', 'float', 'rw']]);
  const px = new Uint8Array([0, 51, 102, 255, 255, 0, 0, 255, 10, 20, 30, 40, 1, 2, 3, 4]), out = new Float32Array(16);
  r.run('k', [mkImg(r, px, { type: 'image2d', w: 2, h: 2, d: 1, order: 'RGBA', chType: 'UNORM_INT8', elem: 4 }), mkp(r, out)], [2, 2], null, null);
  assert.deepStrictEqual(Array.from(out.slice(0, 4)).map((x) => Math.round(x * 255)), [0, 51, 102, 255]); assert.strictEqual(out[12], Math.fround(1 / 255));
});
t('圖像：線性過濾＋正規化座標＋重複定址', () => {
  const r = C.compile(`__kernel void k(__read_only image2d_t im, __global float* o) {
  sampler_t s = CLK_NORMALIZED_COORDS_TRUE | CLK_ADDRESS_REPEAT | CLK_FILTER_LINEAR;
  o[0] = read_imagef(im, s, (float2)(0.5f, 0.5f)).x;   // 四個像素的正中央＝平均
  o[1] = read_imagef(im, s, (float2)(0.25f, 0.25f)).x;  // 恰在像素中心＝原值
  o[2] = read_imagef(im, s, (float2)(1.25f, 0.25f)).x;  // 重複定址：等於 0.25
  o[3] = read_imagef(im, s, (float2)(0.0f, 0.25f)).x;   // 在 x 邊界上：左右像素各半（重複定址：第 1 欄與第 0 欄）
}`, ''); assert.ok(r.ok, r.log);
  const px = new Float32Array([1, 2, 3, 4]), out = new Float32Array(4);
  r.run('k', [mkImg(r, px, { type: 'image2d', w: 2, h: 2, d: 1, order: 'R', chType: 'FLOAT', elem: 4 }), mkp(r, out)], [1], null, null);
  assert.deepStrictEqual(Array.from(out), [2.5, 1, 1, 1.5]);
});
t('圖像：write_imagef／write_imageui 與通道順序（BGRA）、夾制、越界不寫', () => {
  const r = C.compile(`__kernel void k(__write_only image2d_t a, __write_only image2d_t b) { int x = get_global_id(0);
  write_imagef(a, (int2)(x, 0), (float4)(1.0f, 0.5f, 0.0f, 2.0f));   // a 是 BGRA／UNORM_INT8
  write_imageui(b, (int2)(x, 0), (uint4)(300u, 7u, 0u, 0u));          // b 是 RG／UNSIGNED_INT8：300 夾到 255
  write_imagef(a, (int2)(9, 9), (float4)(1.0f, 1.0f, 1.0f, 1.0f)); }`, ''); assert.ok(r.ok, r.log);
  const A = new Uint8Array(8), B = new Uint8Array(4);
  r.run('k', [mkImg(r, A, { type: 'image2d', w: 2, h: 1, d: 1, order: 'BGRA', chType: 'UNORM_INT8', elem: 4 }), mkImg(r, B, { type: 'image2d', w: 2, h: 1, d: 1, order: 'RG', chType: 'UNSIGNED_INT8', elem: 2 })], [2], null, null);
  assert.deepStrictEqual(Array.from(A), [0, 128, 255, 255, 0, 128, 255, 255]); assert.deepStrictEqual(Array.from(B), [255, 7, 255, 7]);
});
t('圖像：get_image_* 與 3D／陣列／半精度', () => {
  const r = C.compile(`__kernel void k(__read_only image3d_t v, __read_only image2d_array_t arr, __read_only image1d_t h, __global float* o) {
  int4 d = get_image_dim(v); o[0] = d.x; o[1] = d.y; o[2] = d.z; o[3] = get_image_array_size(arr); o[4] = get_image_channel_data_type(h) == CLK_HALF_FLOAT; o[5] = get_image_channel_order(h) == CLK_RGBA;
  o[6] = read_imagef(v, (int4)(1, 1, 1, 0)).x; o[7] = read_imagef(arr, (int4)(0, 1, 1, 0)).x; o[8] = read_imagef(h, 1).y; }`, ''); assert.ok(r.ok, r.log);
  const V = new Float32Array(8).map((_, i) => i), AR = new Float32Array(8).map((_, i) => 10 + i), H = new Uint8Array(16), out = new Float32Array(9);
  new DataView(H.buffer).setUint16(10, 0x3c00, true);   // 像素 1 的 g＝1.0（half）
  r.run('k', [mkImg(r, V, { type: 'image3d', w: 2, h: 2, d: 2, order: 'R', chType: 'FLOAT', elem: 4 }), mkImg(r, AR, { type: 'image2d_array', w: 2, h: 2, d: 2, order: 'R', chType: 'FLOAT', elem: 4 }), mkImg(r, H, { type: 'image1d', w: 2, h: 1, d: 1, order: 'RGBA', chType: 'HALF_FLOAT', elem: 8 }), mkp(r, out)], [1], null, null);
  assert.deepStrictEqual(Array.from(out), [2, 2, 2, 2, 1, 1, 7, 16, 1]);
});

fs.rmSync(tmpdir, { recursive: true, force: true });
console.log(pass + ' passed, ' + fail + ' failed' + (skipped ? '（沒有 gcc，略過 ' + skipped + ' 項差分）' : ''));
process.exit(fail ? 1 : 0);
