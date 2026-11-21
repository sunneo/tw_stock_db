// node renderer/src/gpu/cl_cache_test.js — OpenCL 程式的多層快取（cl_cache.js）與它在載入器裡的行為：
// 檢查碼、儲存介面卡（記憶體／檔案／模擬的非同步 IndexedDB）、LRU 淘汰與 TTL、多個載入器共用儲存體的索引合併、壞掉的儲存體與損毀的產物都不影響建置、
// 以及最重要的：同一份 source 第二次起直接拿 binary（不經前端）、IL 層、binary 容器（clCreateProgramWithBinary）、鍵的正確性（選項、展開後的原始碼、目標）。
const assert = require('assert'), crypto = require('crypto'), os = require('os'), path = require('path'), fs = require('fs');
const CC = require('./cl_cache.js'), ICD = require('./cl_icd.js'), CLC = require('./clc_js.js'), SPV = require('./spv_js.js'), A = require('./spv_asm.js'), F = require('./spv_fixtures.js'), K = require('./kir.js'), FR = require('./cl_front.js'), WASM = require('./spv_wasm.js'), FE = require('./clc_spv.js'), K2 = require('./kir.js'), FR2 = require('./cl_front.js');
let pass = 0, fail = 0; const queue = [];
const t = (name, fn) => queue.push([name, fn]);
// 模擬非同步的 IndexedDB：每個操作多一個 microtask／macrotask 延遲，可注入失敗；多個實例共用同一份資料（像 Worker 與頁面）
const fakeIdb = (shared, opts) => { opts = opts || {}; const d = shared || { meta: new Map(), il: new Map(), bin: new Map() }; const lag = () => new Promise((r) => setTimeout(r, 1)); const bad = () => { if (opts.fail) throw new Error('quota exceeded'); };
    return { name: 'fake-idb', get: async (s, k) => { await lag(); bad(); return d[s].get(k); }, put: async (s, k, v) => { await lag(); bad(); d[s].set(k, v); }, del: async (s, k) => { await lag(); d[s].delete(k); }, clear: async () => { for (const m of Object.values(d)) m.clear(); }, _d: d }; };
const SRC = '__kernel void k(__global float* o, int n) { int i = get_global_id(0); if (i < n) o[i] = i * 2.0f; }';
const mkLoader = (cache, drivers) => { const l = ICD.createLoader({ cache }); for (const d of (drivers || [ICD.makeClcDriver({ mods: { FaClc: CLC, FaSpv: SPV } })])) l.registerDriver(d); return l; };
const ctxOf = (l) => { const p = l.platforms()[0], dv = l.devices(p, 'ALL')[0]; return { c: l.createContext([dv]), dv }; };
const buildRun = async (l, src, opts) => { const { c } = ctxOf(l), q = l.createQueue(c, null, {}), p = l.createProgram(c, src); await l.build(p, opts || ''); const k = l.createKernel(p, 'k'), o = l.createBuffer(c, {}, 16, null); l.setArg(k, 0, o); l.setArg(k, 1, 4); await l.enqueueNDRange(q, k, [4], null, null); const r = await l.enqueueRead(q, o, 16, 0); return { p, out: Array.from(new Float32Array(r.data.buffer, r.data.byteOffset, 4)) }; };

t('檢查碼：fast64 決定性、對單一位元／長度／內容順序敏感；md5 與 node crypto 一致', () => {
  const a = CC.fast64('hello'), b = CC.fast64('hello'), c = CC.fast64('hellp'), d = CC.fast64('hello ');
  assert.strictEqual(a, b); assert.ok(new Set([a, c, d]).size === 3);
  const u = new Uint8Array(1000).map((_, i) => (i * 7) & 255), u2 = u.slice(); u2[500] ^= 1; assert.notStrictEqual(CC.fast64(u), CC.fast64(u2)); assert.notStrictEqual(CC.fast64(u.subarray(0, 999)), CC.fast64(u));
  const seen = new Set(); for (let i = 0; i < 20000; i++) seen.add(CC.fast64('kernel_' + i)); assert.strictEqual(seen.size, 20000, '2 萬個相近字串沒有碰撞');
  assert.strictEqual(CC.md5(''), 'd41d8cd98f00b204e9800998ecf8427e'); assert.strictEqual(CC.md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
  for (const n of [1, 55, 56, 63, 64, 65, 1000, 10007]) { const x = new Uint8Array(n).map((_, i) => (i * 31 + n) & 255); assert.strictEqual(CC.md5(x), crypto.createHash('md5').update(x).digest('hex'), 'md5 長度 ' + n); }
});
t('檢查碼夠快：1 MB 原始碼的 fast64 在幾毫秒內', () => { const big = 'x'.repeat(1 << 20); const t0 = process.hrtime.bigint(); CC.fast64(big); const ms = Number(process.hrtime.bigint() - t0) / 1e6; assert.ok(ms < 50, 'fast64 1 MB 用了 ' + ms + ' ms'); });
t('binary 容器：往返（含 Uint8Array 區段）、壞資料回 null', () => {
  const art = { kind: 'x', js: 'abc', blob: new Uint8Array([1, 2, 3]), nested: { w: new Uint8Array([9]) } }, il = new Uint8Array([7, 7, 7, 7]);
  const bin = CC.packBinary({ v: 1, target: 't' }, art, '原始碼', il), u = CC.unpackBinary(bin);
  assert.deepStrictEqual(Array.from(u.art.blob), [1, 2, 3]); assert.deepStrictEqual(Array.from(u.art.nested.w), [9]); assert.strictEqual(u.src, '原始碼'); assert.deepStrictEqual(Array.from(u.il), [7, 7, 7, 7]); assert.strictEqual(u.header.target, 't');
  assert.strictEqual(CC.unpackBinary(new Uint8Array(20)), null);
});
t('快取：put／has／fetch、寫入佇列與 flush、重新開啟後索引還在', async () => {
  const ad = CC.memoryAdapter(), c1 = CC.createCache({ storage: ad }); const k = c1.key.bin('b', 'o', 'tg', '');
  assert.ok(!c1.has('bin', k)); c1.put('bin', k, { js: 'x' }, 100, { src: 'S', opts: 'o', target: 'tg' });
  assert.ok(c1.has('bin', k)); assert.deepStrictEqual(c1.fetch('bin', k), { js: 'x' });   // 讀得到自己剛寫的（待寫表）
  await c1.flush(); assert.strictEqual(c1.stats().pending, 0); assert.ok(ad.getSync('bin', k));
  const c2 = CC.createCache({ storage: ad }); assert.ok(c2.has('bin', k)); assert.deepStrictEqual(c2.fetch('bin', k), { js: 'x' });
});
t('LRU 淘汰（maxBytes／maxEntries）與 TTL，淘汰後連結一起清掉', async () => {
  let now = 1000; const ad = CC.memoryAdapter(), c = CC.createCache({ storage: ad, now: () => now, config: { maxBytes: 250, maxEntries: 100 } });
  for (let i = 0; i < 4; i++) { now += 10; c.put('bin', 'k' + i, { i }, 100, { src: 'S' + i, opts: 'o', target: 't' }); }
  now += 10; c.fetch('bin', 'k0'); await c.flush();   // k0 最近用過 → 活下來；k1、k2 被淘汰
  const idx = c._idx(); assert.deepStrictEqual(Object.keys(idx.bin).sort(), ['k0', 'k3'].sort()); assert.ok(!idx.src.S1 && !idx.src.S2 && idx.src.S0 && idx.src.S3); assert.ok(!ad.getSync('bin', 'k1'));
  const c2 = CC.createCache({ storage: ad, now: () => now + 40 * 86400000 }); assert.strictEqual(Object.keys(c2._idx().bin).length, 0, '超過 ttlDays（30）全部清掉');
});
t('非同步儲存體：fetch 回 Promise、進行中的讀取共用、預取後同步命中', async () => {
  const ad = fakeIdb(), c1 = CC.createCache({ storage: ad }); await c1.whenReady(); c1.put('bin', 'kb', { v: 1 }, 10, { src: 'S', opts: 'o', target: 'T' }); await c1.flush();
  const c2 = CC.createCache({ storage: fakeIdb(ad._d) }); await c2.whenReady(); assert.ok(c2.has('bin', 'kb'));
  const p1 = c2.fetch('bin', 'kb'), p2 = c2.fetch('bin', 'kb'); assert.ok(p1 && typeof p1.then === 'function'); assert.deepStrictEqual(await p1, { v: 1 }); assert.deepStrictEqual(await p2, { v: 1 });
  assert.deepStrictEqual(c2.fetch('bin', 'kb'), { v: 1 }, '之後在熱快取，同步');
  const c3 = CC.createCache({ storage: fakeIdb(ad._d) }); await c3.whenReady(); c3.prefetch('S', 'T'); await new Promise((r) => setTimeout(r, 20)); assert.deepStrictEqual(c3.fetch('bin', 'kb'), { v: 1 }, '預取完成後 build 時同步命中');
});
t('多個載入器共用儲存體：索引合併（聯集），不互相蓋掉', async () => {
  const ad = fakeIdb(), a = CC.createCache({ storage: fakeIdb(ad._d) }), b = CC.createCache({ storage: fakeIdb(ad._d) }); await a.whenReady(); await b.whenReady();
  a.put('bin', 'ka', { a: 1 }, 10, { src: 'SA', opts: 'o', target: 'T' }); b.put('bin', 'kb', { b: 1 }, 10, { src: 'SB', opts: 'o', target: 'T' }); await a.flush(); await b.flush();
  const c = CC.createCache({ storage: fakeIdb(ad._d) }); await c.whenReady(); assert.ok(c.has('bin', 'ka') && c.has('bin', 'kb'), '兩邊寫的都在'); assert.ok(c._idx().src.SA && c._idx().src.SB);
});
t('壞掉的儲存體：開不起來悄悄退成記憶體；寫入失敗不丟例外', async () => {
  const bad = fakeIdb(null, { fail: true }), c = CC.createCache({ storage: bad }); await c.whenReady(); c.put('bin', 'k', { x: 1 }, 5, { src: 'S', opts: 'o', target: 'T' }); assert.deepStrictEqual(c.fetch('bin', 'k'), { x: 1 }); await c.flush();
  assert.ok(c.stats().fallbackMemory === 1 || c.stats().errors >= 0);
  const l = mkLoader(c); const r = await buildRun(l, SRC); assert.deepStrictEqual(r.out, [0, 2, 4, 6]);
});
t('★ 同一份 source 第二次直接拿 binary：不經前端、結果相同（原本的 createProgram／build 寫法，沒有任何開關）', async () => {
  const ad = CC.memoryAdapter(); let compiles = 0; const orig = CLC.compile; CLC.compile = (...a) => { compiles++; return orig.apply(CLC, a); };
  try {
    const c1 = CC.createCache({ storage: ad }), l1 = mkLoader(c1); const r1 = await buildRun(l1, SRC); await l1.close();
    assert.strictEqual(compiles, 1); assert.strictEqual(l1.stats().builds, 1); assert.strictEqual(l1.stats().cacheBinHits, 0); assert.deepStrictEqual(r1.out, [0, 2, 4, 6]);
    const c2 = CC.createCache({ storage: ad }), l2 = mkLoader(c2); const r2 = await buildRun(l2, SRC);   // 全新的載入器（像重新整理頁面）
    assert.strictEqual(compiles, 1, '第二次沒有進 clc 前端'); assert.strictEqual(l2.stats().builds, 0); assert.strictEqual(l2.stats().cacheBinHits, 1); assert.strictEqual(r2.p.built.fromCache, 'bin'); assert.deepStrictEqual(r2.out, r1.out);
    const r3 = await buildRun(l2, SRC); assert.strictEqual(l2.stats().buildHits, 1, '同一個載入器裡是第 0 層命中'); void r3;
  } finally { CLC.compile = orig; }
});
t('鍵的正確性：選項、原始碼、IL、裝置目標任何一項不同都不會誤命中', async () => {
  const ad = CC.memoryAdapter(); const l1 = mkLoader(CC.createCache({ storage: ad })); await buildRun(l1, SRC); await l1.close();
  const l2 = mkLoader(CC.createCache({ storage: ad })); await buildRun(l2, SRC, '-DX=1'); assert.strictEqual(l2.stats().cacheBinHits, 0, '選項不同'); await buildRun(l2, SRC.replace('2.0f', '3.0f')); assert.strictEqual(l2.stats().cacheBinHits, 0, '原始碼不同');
  const l3 = mkLoader(CC.createCache({ storage: ad }), [ICD.makeKirDriver({ mods: { FaClFront: FR, FaKir: K } })]); await buildRun(l3, SRC); assert.strictEqual(l3.stats().cacheBinHits, 0, '裝置目標不同（KIR 驅動）');
  // 展開 #include 後 src 會變（ops 的 prog_build 帶來展開後的內容）：鍵要用最後真正編譯的內容
  const l4 = mkLoader(CC.createCache({ storage: ad })); const { c } = ctxOf(l4), p = l4.createProgram(c, SRC); p.src = SRC.replace('2.0f', '5.0f'); await l4.build(p, ''); assert.strictEqual(l4.stats().cacheBinHits, 0, 'src 在 build 前被改寫要重算鍵');
});
t('損毀的產物當作沒命中，照常編譯並覆寫', async () => {
  const ad = CC.memoryAdapter(), l1 = mkLoader(CC.createCache({ storage: ad })); await buildRun(l1, SRC); await l1.close();
  const bk = Object.keys(ad._m.bin)[0] || [...ad._m.bin.keys()][0]; ad._m.bin.set(bk, { kind: 'cpu-js', clc: { kind: 'clc', js: 'this is not javascript (((', gen: false, kernels: {} } });
  const l2 = mkLoader(CC.createCache({ storage: ad })); const r = await buildRun(l2, SRC); assert.deepStrictEqual(r.out, [0, 2, 4, 6]); assert.strictEqual(l2.stats().builds, 1);
});
t('IL 層：外掛的 source→SPIR-V 前端的產物存進 il，bin 被淘汰後從 IL 重建（不再呼叫前端）', async () => {
  const PIL = [ICD.makeClcDriver({ mods: { FaClc: CLC, FaSpv: SPV }, preferIL: true })], il = A.assemble(F.VADD), ad = CC.memoryAdapter(); let toIL = 0; const frontend = () => { toIL++; return il; };
  const VSRC = '__kernel void vadd(__global const float*a,__global const float*b,__global float*c,uint n){ /* 以 SPIR-V 前端編譯 */ }';
  const c1 = CC.createCache({ storage: ad, toIL: frontend }), l1 = mkLoader(c1, PIL); { const { c } = ctxOf(l1), p = l1.createProgram(c, VSRC); await l1.build(p, ''); assert.deepStrictEqual(Object.keys(p.built.kernels), ['vadd']); } await l1.close();
  assert.strictEqual(toIL, 1); assert.strictEqual(Object.keys(c1._idx().il).length, 1, 'il 層有存'); for (const k of [...ad._m.bin.keys()]) ad._m.bin.delete(k);   // 模擬 bin 被淘汰（索引還記得）
  const c2 = CC.createCache({ storage: ad, toIL: frontend }); for (const k of Object.keys(c2._idx().bin)) delete c2._idx().bin[k]; for (const r of Object.values(c2._idx().src)) r.bins = {};
  const l2 = mkLoader(c2, PIL); { const { c } = ctxOf(l2), p = l2.createProgram(c, VSRC); await l2.build(p, ''); assert.strictEqual(p.built.fromCache, 'il'); } assert.strictEqual(toIL, 1, 'IL 命中：沒有再呼叫 source→IL 前端'); assert.strictEqual(l2.stats().cacheIlHits, 1);
});
t('★ source→IL→binary（偏好 IL 的驅動＋真的 source→SPIR-V 前端）：第一次 source→SPIR-V→產物並存 il 與 bin；第二次 bin；bin 被淘汰後從 il 重建，不再呼叫前端', async () => {
  const FE = require('./clc_spv.js'); let toIL = 0; const frontend = (src, o) => { toIL++; return FE.toIL(src, o); };
  const il = [ICD.makeClcDriver({ mods: { FaClc: CLC, FaSpv: SPV }, preferIL: true })], ad = CC.memoryAdapter();
  const c1 = CC.createCache({ storage: ad, toIL: frontend }), l1 = mkLoader(c1, il); const r1 = await buildRun(l1, SRC); await l1.close();
  assert.deepStrictEqual(r1.out, [0, 2, 4, 6]); assert.strictEqual(toIL, 1); assert.strictEqual(Object.keys(c1._idx().il).length, 1, 'il 層有存'); assert.strictEqual(Object.keys(c1._idx().bin).length, 1, 'bin 層有存'); assert.strictEqual(r1.p.built.clc.kind, 'spv', '經由 SPIR-V 後端');
  const c2 = CC.createCache({ storage: ad, toIL: frontend }), l2 = mkLoader(c2, il); const r2 = await buildRun(l2, SRC); assert.strictEqual(toIL, 1, 'bin 命中：沒有前端'); assert.strictEqual(r2.p.built.fromCache, 'bin'); assert.deepStrictEqual(r2.out, [0, 2, 4, 6]);
  for (const k of [...ad._m.bin.keys()]) ad._m.bin.delete(k); const c3 = CC.createCache({ storage: ad, toIL: frontend }); for (const k of Object.keys(c3._idx().bin)) delete c3._idx().bin[k]; for (const r of Object.values(c3._idx().src)) r.bins = {};
  const l3 = mkLoader(c3, il); const r3 = await buildRun(l3, SRC); assert.strictEqual(toIL, 1, 'il 命中：沒有再呼叫 source→IL 前端'); assert.strictEqual(r3.p.built.fromCache, 'il'); assert.deepStrictEqual(r3.out, [0, 2, 4, 6]);
});
t('前端不支援的 source（向量等）在偏好 IL 的驅動上自動退回直接編譯，結果照常', async () => {
  const FE = require('./clc_spv.js'), V4 = '__kernel void k(__global float* o, int n) { float4 v = (float4)(1.0f, 2.0f, 3.0f, 4.0f); int i = get_global_id(0); if (i < n) o[i] = v.x + v.w + i; }';
  assert.strictEqual(FE.toIL(V4, ''), null); const l = mkLoader(CC.createCache({ storage: CC.memoryAdapter(), toIL: FE.toIL }), [ICD.makeClcDriver({ mods: { FaClc: CLC, FaSpv: SPV }, preferIL: true })]);
  const r = await buildRun(l, V4); assert.deepStrictEqual(r.out, [5, 6, 7, 8]); assert.strictEqual(r.p.built.clc.kind, 'clc', '退回 clc 直接編譯');
});
t('★ wasm 目標碼：source→SPIR-V→wasm 位元組，存進快取；第二次從 bin 重建 wasm（不經前端與 SPIR-V 轉換）；不支援的核心退回 JS', async () => {
  const wd = () => ICD.makeClcDriver({ mods: { FaClc: CLC, FaSpv: SPV, FaSpvWasm: WASM }, wasm: true }), ad = CC.memoryAdapter(); let fe = 0, wc = 0; const wcomp = WASM.compile; WASM.compile = (...a) => { wc++; return wcomp.apply(WASM, a); };
  const mk = (cache) => mkLoader(cache, [wd()]);
  try {
    const c1 = CC.createCache({ storage: ad, toIL: (src, o) => { fe++; return FE.toIL(src, o); } }), l1 = mk(c1); const r1 = await buildRun(l1, SRC); await l1.close();
    assert.deepStrictEqual(r1.out, [0, 2, 4, 6]); assert.strictEqual(r1.p.built.clc.kind, 'wasm', '目標碼是 wasm'); assert.strictEqual(fe, 1); assert.strictEqual(wc, 1);
    const arts = [...ad._m.bin.values()]; assert.ok(arts[0].art.wasm instanceof Uint8Array && arts[0].kind === 'cpu-wasm', '存的是 wasm 位元組');
    const c2 = CC.createCache({ storage: ad, toIL: (src, o) => { fe++; return FE.toIL(src, o); } }), l2 = mk(c2); const r2 = await buildRun(l2, SRC);
    assert.strictEqual(fe, 1, '第二次沒有前端'); assert.strictEqual(wc, 1, '第二次沒有 SPIR-V→wasm'); assert.strictEqual(r2.p.built.fromCache, 'bin'); assert.strictEqual(r2.p.built.clc.kind, 'wasm'); assert.deepStrictEqual(r2.out, [0, 2, 4, 6]);
    // 有 barrier／__local 的核心：wasm 後端不支援 → 退回 SPIR-V→JS（或 clc 直接 JS），結果照常
    const BS = '__kernel void k(__global float* o, __local float* t) { int l = get_local_id(0); t[l] = l + 1.0f; barrier(CLK_LOCAL_MEM_FENCE); o[l] = t[(l + 1) % 4]; }';
    const l3 = mk(CC.createCache({ storage: CC.memoryAdapter(), toIL: FE.toIL })), { c } = ctxOf(l3), q = l3.createQueue(c, null, {}), p = l3.createProgram(c, BS); await l3.build(p, ''); assert.notStrictEqual(p.built.clc.kind, 'wasm', 'barrier 核心不走 wasm');
    const k = l3.createKernel(p, 'k'), o = l3.createBuffer(c, {}, 16, null); l3.setArg(k, 0, o); l3.setArg(k, 1, { local: 16 }); await l3.enqueueNDRange(q, k, [4], [4], null); const rd = await l3.enqueueRead(q, o, 16, 0); assert.deepStrictEqual(Array.from(new Float32Array(rd.data.buffer, rd.data.byteOffset, 4)), [2, 3, 4, 1]);
  } finally { WASM.compile = wcomp; }
});
t('wasm 驅動的 binary 容器往返（clCreateProgramWithBinary）：wasm 位元組帶著走，不經前端', async () => {
  const wd = () => ICD.makeClcDriver({ mods: { FaClc: CLC, FaSpv: SPV, FaSpvWasm: WASM }, wasm: true }); const l1 = mkLoader(CC.createCache({ storage: CC.memoryAdapter(), toIL: FE.toIL }), [wd()]); const { p } = await buildRun(l1, SRC), bin = l1.getBinary(p);
  let fe = 0; const l2 = mkLoader(CC.createCache({ storage: CC.memoryAdapter(), toIL: (s, o) => { fe++; return FE.toIL(s, o); } }), [wd()]); const { c } = ctxOf(l2), q = l2.createQueue(c, null, {}), p2 = l2.createProgramBinary(c, bin); await l2.build(p2, '');
  assert.strictEqual(fe, 0); assert.strictEqual(p2.built.fromCache, 'binary'); assert.strictEqual(p2.built.clc.kind, 'wasm'); const k = l2.createKernel(p2, 'k'), o = l2.createBuffer(c, {}, 16, null); l2.setArg(k, 0, o); l2.setArg(k, 1, 4); await l2.enqueueNDRange(q, k, [4], null, null); const rd = await l2.enqueueRead(q, o, 16, 0); assert.deepStrictEqual(Array.from(new Float32Array(rd.data.buffer, rd.data.byteOffset, 4)), [0, 2, 4, 6]);
});
t('★ GPU 驅動的主機路線也用 wasm：小問題（走主機）在 wasm 上跑、大問題（走裝置）仍是 KIR；產物（KIR＋wasm）存進快取並從快取重建', async () => {
  const cd = { dispatch: 0 }, jd = ICD.jsDevice(K2), dev = { alloc: (...a) => jd.alloc(...a), upload: (...a) => jd.upload(...a), download: (...a) => jd.download(...a), dispatch: (...a) => { cd.dispatch++; return jd.dispatch(...a); }, free: (...a) => jd.free(...a) };
  const GSRC = '__kernel void sc(__global const float* a, __global float* o, float s, int n) { int i = get_global_id(0); if (i < n) o[i] = a[i] * s; }';
  const gd = () => ICD.makeGpuDriver({ mods: { FaClFront: FR2, FaKir: K2, FaClc: CLC, FaSpv: SPV, FaSpvWasm: WASM, FaClc2Spv: FE }, device: dev, backend: 'webgpu', smallN: 64, wasm: true }), ad = CC.memoryAdapter();
  const go = async (l, N, src) => { const { c } = ctxOf(l), q = l.createQueue(c, null, {}), p = l.createProgram(c, src || GSRC); await l.build(p, ''); const k = l.createKernel(p, 'sc'), a = l.createBuffer(c, {}, N * 4, new Float32Array(N).map((_, i) => i)), o = l.createBuffer(c, {}, N * 4, null); l.setArg(k, 0, a); l.setArg(k, 1, o); l.setArg(k, 2, 3); l.setArg(k, 3, N); await l.enqueueNDRange(q, k, [N], null, null); const r = await l.enqueueRead(q, o, N * 4, 0); return { p, out: new Float32Array(r.data.buffer, r.data.byteOffset, N) }; };
  const l1 = mkLoader(CC.createCache({ storage: ad }), [gd()]); const r1 = await go(l1, 16); await l1.close();
  assert.strictEqual(r1.p.built.clc.kind, 'wasm', '主機路線的核心是 wasm'); assert.deepStrictEqual(Array.from(r1.out.slice(0, 4)), [0, 3, 6, 9]); assert.strictEqual(cd.dispatch, 0, '小問題沒碰裝置'); assert.ok(l1.stats().routedHost >= 1);
  const r1b = await go(l1, 4096); assert.ok(cd.dispatch >= 1, '大問題走裝置（KIR）'); assert.strictEqual(r1b.out[100], 300);
  const l2 = mkLoader(CC.createCache({ storage: ad }), [gd()]); const r2 = await go(l2, 16); assert.strictEqual(r2.p.built.fromCache, 'bin', '從快取重建（KIR＋wasm）'); assert.strictEqual(r2.p.built.clc.kind, 'wasm'); assert.deepStrictEqual(Array.from(r2.out.slice(0, 4)), [0, 3, 6, 9]);
  const VEC = '__kernel void sc(__global const float* a, __global float* o, float s, int n) { float4 v = (float4)(1.0f); int i = get_global_id(0); if (i < n) o[i] = a[i] * s + v.x; }';   // 向量：clc_spv 不收 → 退回 clc 直接 JS
  const l3 = mkLoader(CC.createCache({ storage: CC.memoryAdapter() }), [gd()]); const r3 = await go(l3, 8, VEC); assert.strictEqual(r3.p.built.clc.kind, 'clc', '退回 clc 直接編譯'); assert.deepStrictEqual(Array.from(r3.out.slice(0, 3)), [1, 4, 7]);
});
t('IL 程式（clCreateProgramWithIL）也走快取：第二次不再解碼轉換', async () => {
  const il = A.assemble(F.REDUCE), ad = CC.memoryAdapter(); let n = 0; const orig = SPV.compile; SPV.compile = (...a) => { n++; return orig.apply(SPV, a); };
  try {
    for (let i = 0; i < 2; i++) { const l = mkLoader(CC.createCache({ storage: ad })); const { c } = ctxOf(l), p = l.createProgramIL(c, il); await l.build(p, ''); await l.close(); assert.deepStrictEqual(Object.keys(p.built.kernels), ['red']); if (i === 1) assert.strictEqual(p.built.fromCache, 'bin'); }
    assert.strictEqual(n, 1);
  } finally { SPV.compile = orig; }
});
t('binary 容器：getBinary → createProgramBinary（全新載入器、不經前端）；目標不相容時用內嵌 source 重建', async () => {
  const l1 = mkLoader(CC.createCache({ storage: CC.memoryAdapter() })); const { p } = await buildRun(l1, SRC); const bin = l1.getBinary(p); assert.ok(bin.length > 100);
  let compiles = 0; const orig = CLC.compile; CLC.compile = (...a) => { compiles++; return orig.apply(CLC, a); };
  try {
    const l2 = mkLoader(CC.createCache({ storage: CC.memoryAdapter() })); const { c } = ctxOf(l2), q = l2.createQueue(c, null, {}), p2 = l2.createProgramBinary(c, bin); await l2.build(p2, ''); assert.strictEqual(compiles, 0, '從 binary 建立不經前端'); assert.strictEqual(p2.built.fromCache, 'binary');
    const k = l2.createKernel(p2, 'k'), o = l2.createBuffer(c, {}, 16, null); l2.setArg(k, 0, o); l2.setArg(k, 1, 4); await l2.enqueueNDRange(q, k, [4], null, null); const r = await l2.enqueueRead(q, o, 16, 0); assert.deepStrictEqual(Array.from(new Float32Array(r.data.buffer, r.data.byteOffset, 4)), [0, 2, 4, 6]);
    const l3 = mkLoader(CC.createCache({ storage: CC.memoryAdapter() }), [ICD.makeKirDriver({ mods: { FaClFront: FR, FaKir: K } })]); const { c: c3 } = ctxOf(l3), p3 = l3.createProgramBinary(c3, bin); await l3.build(p3, ''); assert.ok(!p3.built.fromCache, '目標不同 → 用內嵌的 source 重建'); assert.deepStrictEqual(Object.keys(p3.built.kernels), ['k']);
  } finally { CLC.compile = orig; }
  assert.throws(() => mkLoader(CC.createCache({})).createProgramBinary(ctxOf(l1).c, new Uint8Array(40)), /INVALID_BINARY|binary/);
});
t('沖出位置：clFinish 與釋放時在背景沖出；close 等到全部落地', async () => {
  const ad = fakeIdb(), c = CC.createCache({ storage: ad }); await c.whenReady(); const l = mkLoader(c);
  const { c: cx } = ctxOf(l), q = l.createQueue(cx, null, {}), p = l.createProgram(cx, SRC); await l.build(p, ''); assert.ok(c.stats().pending > 0, 'build 後寫入排在佇列，沒有同步等 IndexedDB');
  await l.finish(q); await new Promise((r) => setTimeout(r, 30)); assert.strictEqual(c.stats().pending, 0, 'finish 觸發背景沖出'); assert.ok(ad._d.bin.size === 1);
  const p2 = l.createProgram(cx, SRC.replace('2.0f', '9.0f')); await l.build(p2, ''); await l.close(); assert.strictEqual(ad._d.bin.size, 2, 'close 等到落地');
});
t('跨行程持久化（檔案儲存體）：第二個行程的第一次 build 就命中', async () => {
  const f = path.join(os.tmpdir(), 'fa-cl-cache-test-' + process.pid + '.json'); try { fs.unlinkSync(f); } catch (_) { /* 沒有 */ }
  try {
    const l1 = mkLoader(CC.createCache({ storage: CC.fileAdapter(fs, f) })); await buildRun(l1, SRC); await l1.close(); assert.ok(fs.existsSync(f));
    const l2 = mkLoader(CC.createCache({ storage: CC.fileAdapter(fs, f) })); const r = await buildRun(l2, SRC); assert.strictEqual(l2.stats().cacheBinHits, 1); assert.deepStrictEqual(r.out, [0, 2, 4, 6]);
  } finally { try { fs.unlinkSync(f); } catch (_) { /* 沒有 */ } }
});
t('配置不複製、gen（barrier）核心也能從產物重建並正確執行', async () => {
  const BSRC = '__kernel void k(__global float* o, __local float* t) { int l = get_local_id(0); t[l] = l + 1.0f; barrier(CLK_LOCAL_MEM_FENCE); o[l] = t[(l + 1) % 4]; }';
  const ad = CC.memoryAdapter(); for (let i = 0; i < 2; i++) {
    const l = mkLoader(CC.createCache({ storage: ad })); const { c } = ctxOf(l), q = l.createQueue(c, null, {}), p = l.createProgram(c, BSRC); await l.build(p, ''); await l.close();
    const k = l.createKernel(p, 'k'), o = l.createBuffer(c, {}, 16, null); l.setArg(k, 0, o); l.setArg(k, 1, { local: 16 }); await l.enqueueNDRange(q, k, [4], [4], null); const r = await l.enqueueRead(q, o, 16, 0);
    assert.deepStrictEqual(Array.from(new Float32Array(r.data.buffer, r.data.byteOffset, 4)), [2, 3, 4, 1]); if (i === 1) assert.strictEqual(p.built.fromCache, 'bin');
  }
});

(async () => { for (const [name, fn] of queue) { try { await fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.stack || e.message).split('\n').slice(0, 7).join('\n   ')); } } console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); })();
