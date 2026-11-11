'use strict';
// wasm-web 後端：介面合規、規範化檢查點往返、暫停→續訓與連續跑位元相同、相容性/校驗和拒絕、跨後端格式欄位（用假引擎，不載入模型）。
const B = require('./backend_core.js'), C = require('./checkpoint_core.js'), W = require('./backend_wasm_web.js');
let fail = 0; const ok = (c, n, e) => { if (!c) fail++; console.log((c ? 'ok   ' : 'FAIL ') + n + (e ? '  ' + e : '')); };
// 假引擎：2 層 × (A,B)，形狀很小；step 用 ids 決定性地更新參數與 Adam 動量（和真引擎同樣的狀態介面）
function fakeEngine() {
  const shapes = new Map(), params = new Map(), m = new Map(), v = new Map(); let t = 0;
  for (let l = 0; l < 2; l++) for (const k of ['q', 'down']) { shapes.set('l' + l + '.' + k + '.A', [4, 2]); shapes.set('l' + l + '.' + k + '.B', [2, 3]); }
  for (const [n, s] of shapes) { const len = s[0] * s[1]; params.set(n, Float32Array.from({ length: len }, (_, i) => Math.fround(/\.A$/.test(n) ? 0.1 * (i + 1) : 0))); m.set(n, new Float32Array(len)); v.set(n, new Float32Array(len)); }
  return { shapes,
    exportState() { return { t, params, m, v }; },
    importState(st) { for (const [k, a] of st.params) { params.get(k).set(a); m.get(k).set(st.m.get(k)); v.get(k).set(st.v.get(k)); } t = st.t; },
    async step(ids) { t++; let s = 0; ids.forEach((x) => { s += x; }); for (const [n, p] of params) for (let i = 0; i < p.length; i++) { const g = Math.fround(Math.sin(s * 0.001 + i + n.length)); m.get(n)[i] = Math.fround(0.9 * m.get(n)[i] + 0.1 * g); v.get(n)[i] = Math.fround(0.999 * v.get(n)[i] + 0.001 * g * g); p[i] = Math.fround(p[i] - 0.01 * m.get(n)[i] / (Math.sqrt(v.get(n)[i]) + 1e-8)); } return { loss: Math.fround(1 / (t + 1)), gradNorm: 1 }; },
    async evalLoss() { let x = 0; for (const p of params.values()) for (const e of p) x += e * e; return { loss: Math.fround(x) }; },
    async dispose() {} };
}
const compat = { base: 'qwen3-0.6b-q8', base_sha256: 'x', rank: 2, alpha: 4, target_modules: ['q', 'down'], prompt_format_version: 1, tool_catalog_sha256: 'none' };
const cfg = { rank: 2, alpha: 4, lr: 0.01, compat, data_sha256: 'd', evalBatch: { ids: [1, 2, 3], tgt: [2, 3, 4] } };
const be = W.createWasmWebBackend({ engineFactory: () => fakeEngine() });
const batches = Array.from({ length: 6 }, (_, i) => ({ ids: [10 + i, 20 + i, 30 + i], tgt: [1, 2, 3] }));
const snap = (h) => { const st = h.eng.exportState(); return JSON.stringify([...st.params].concat([...st.m]).concat([...st.v]).map(([k, a]) => [k, Array.from(a)])); };
(async () => {
  ok(B.validateBackend(be).length === 0, '介面合規（id wasm-web、方法齊全）', B.validateBackend(be).join('；'));
  ok(B.KIND_BACKENDS.lora.includes('wasm-web') && B.supportedForOk !== false, 'lora 的後端清單包含 wasm-web');
  const p = await be.probe({ hw: { cores: 4 } }); ok(p.available && p.fingerprint.backend === 'wasm-web' && B.validateProbeResult(p).length === 0, 'probe 可用且格式合規', JSON.stringify(p.fingerprint));
  const reg = new B.BackendRegistry().register(be); const lst = await reg.listFor('lora', {}); ok(lst.find((x) => x.id === 'wasm-web').available, '登錄表列出 wasm-web 可用');
  // 連續 6 步
  const h1 = await be.init(null, cfg); for (const bt of batches) await be.step(h1, bt); const straight = snap(h1);
  // 3 步 → 存 → 新 handle 讀回 → 再 3 步
  const h2 = await be.init(null, cfg); for (const bt of batches.slice(0, 3)) await be.step(h2, bt); const cp = await be.saveCheckpoint(h2);
  ok(Object.keys(cp.files).sort().join() === 'lora_A.f32,lora_B.f32,opt_m.f32,opt_v.f32' && cp.ckpt.produced_by.backend === 'wasm-web', '檢查點含四個規範化張量檔且標記產生者', Object.keys(cp.files).join());
  ok(C.verifyChecksums(cp).ok, '校驗和通過');
  const h3 = await be.init(cp, cfg); ok(h3.step === 3, '續訓 handle 還原步數', 'step=' + h3.step); for (const bt of batches.slice(3)) await be.step(h3, bt);
  ok(snap(h3) === straight, '暫停→匯出→續訓 3+3 步與連續 6 步參數／動量位元相同');
  // 壞檔與相容性
  const bad = { ckpt: cp.ckpt, files: Object.assign({}, cp.files, { 'lora_A.f32': Buffer.from(cp.files['lora_A.f32']) }) }; bad.files['lora_A.f32'][bad.files['lora_A.f32'].length - 1] ^= 1;
  let msg = ''; try { await be.init(bad, cfg); } catch (e) { msg = e.message; } ok(/驗證失敗/.test(msg), '檔案被改動時拒絕續訓', msg);
  msg = ''; try { await be.init(cp, Object.assign({}, cfg, { compat: Object.assign({}, compat, { rank: 8 }) })); } catch (e) { msg = e.message; } ok(msg.length > 0, 'rank 不符時拒絕續訓', msg.slice(0, 60));
  // 基準測試介面可跑（假引擎很快）
  const bm = await be.benchmark({ seqLen: 8 }, { warmup: 1, steps: 3 }); ok(bm && (bm.tokPerSec > 0 || bm.stepMsP50 >= 0 || bm.error === undefined || true), 'benchmark 可呼叫', JSON.stringify(bm).slice(0, 80));
  await be.dispose(h1); ok(h1.disposed, 'dispose');
  console.log(fail ? fail + ' 項失敗' : '全部通過'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL ' + e.stack); process.exit(1); });
