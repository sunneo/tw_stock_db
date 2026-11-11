'use strict';
// 網頁版訓練服務：開始→狀態→暫停→(匯出→換一台匯入)→續訓與連續跑位元相同、配額滿了明確停止、壞檔拒絕、重複啟動拒絕。假引擎＋記憶體交換空間。
const W = require('./web_train_core.js'), BW = require('./backend_wasm_web.js'), S = require('./swap_store.js');
let fail = 0; const ok = (c, n, e) => { if (!c) fail++; console.log((c ? 'ok   ' : 'FAIL ') + n + (e ? '  ' + e : '')); };
function fakeEngine() {
  const shapes = new Map(), params = new Map(), m = new Map(), v = new Map(); let t = 0;
  for (let l = 0; l < 2; l++) for (const k of ['q', 'down']) { shapes.set('l' + l + '.' + k + '.A', [4, 2]); shapes.set('l' + l + '.' + k + '.B', [2, 3]); }
  for (const [n, s] of shapes) { const len = s[0] * s[1]; params.set(n, Float32Array.from({ length: len }, (_, i) => Math.fround(/\.A$/.test(n) ? 0.1 * (i + 1) : 0))); m.set(n, new Float32Array(len)); v.set(n, new Float32Array(len)); }
  return { shapes, exportState() { return { t, params, m, v }; }, importState(st) { for (const [k, a] of st.params) { params.get(k).set(a); m.get(k).set(st.m.get(k)); v.get(k).set(st.v.get(k)); } t = st.t; },
    async step(ids, tgt, lr) { t++; let s = 0; ids.forEach((x) => { s += x; }); for (const [n, p] of params) for (let i = 0; i < p.length; i++) { const g = Math.fround(Math.sin(s * 0.001 + i + n.length)); m.get(n)[i] = Math.fround(0.9 * m.get(n)[i] + 0.1 * g); v.get(n)[i] = Math.fround(0.999 * v.get(n)[i] + 0.001 * g * g); p[i] = Math.fround(p[i] - (lr || 0.01) * m.get(n)[i] / (Math.sqrt(v.get(n)[i]) + 1e-8)); } return { loss: Math.fround(1 / (t + 1)), gradNorm: 1 }; },
    async evalLoss() { return { loss: 0 }; }, async dispose() {} };
}
const compat = { base: 'qwen3-0.6b-q8', base_sha256: 'x', rank: 2, alpha: 4, target_modules: ['q', 'down'], prompt_format_version: 1, tool_catalog_sha256: 'none' };
const engines = []; const mk = (quota) => { const be = BW.createWasmWebBackend({ engineFactory: () => { const e = fakeEngine(); engines.push(e); return e; } }); const store = S.createMemorySwap({ quotaBytes: quota || 1e7 });
  return { be, store, svc: W.createWebTrainService({ backend: be, store, makeData: async () => ({ total: 5, sha: 'd', batch: (i) => ({ ids: [10 + i, 20 + i, 30 + i], tgt: [1, 2, 3] }) }), yieldFn: () => new Promise((r) => setImmediate(r)) }) }; };
const cfgOf = (steps) => ({ steps, lr: 0.01, rank: 2, alpha: 4, compat });
const snap = (e) => { const st = e.exportState(); return JSON.stringify([...st.params].concat([...st.m]).concat([...st.v]).map(([k, a]) => [k, Array.from(a)])); };
const waitState = async (svc, id, states) => { for (let i = 0; i < 2000; i++) { const s = svc.status(id); if (states.indexOf(s.state) >= 0) return s; await new Promise((r) => setImmediate(r)); } return svc.status(id); };
(async () => {
  // 連續 8 步
  const A = mk(); const r1 = await A.svc.start({ name: 'x', cfg: cfgOf(8) }); ok(r1.ok, '開始訓練', r1.error); const d1 = await waitState(A.svc, r1.jobId, ['done', 'error']); ok(d1.state === 'done' && d1.step === 8, '連續跑完 8 步', JSON.stringify(d1).slice(0, 120)); const straight = snap(engines[engines.length - 1]);
  // 暫停→續訓（同一台）
  const Bx = mk(); const r2 = await Bx.svc.start({ name: 'y', cfg: cfgOf(8) }); await new Promise((r) => setImmediate(r)); const p = await Bx.svc.pause(r2.jobId); ok(p.ok && p.checkpoint && p.step > 0 && p.step <= 8, '暫停存檢查點', 'step=' + p.step);
  const st = Bx.svc.status(r2.jobId); ok(st.state === 'paused' || st.state === 'done', '狀態 paused', st.state);
  if (st.state === 'paused') {
    const r3 = await Bx.svc.start({ name: 'y', cfg: cfgOf(8), resume: true }); ok(r3.ok && r3.resumedFromStep === p.step, '續訓從暫停步數接續', JSON.stringify(r3)); await waitState(Bx.svc, r3.jobId, ['done', 'error']);
    ok(snap(engines[engines.length - 1]) === straight, '暫停→續訓與連續跑參數／動量位元相同');
    // 匯出 → 換一台（新 store、新服務）匯入 → 續訓
    const ex = await Bx.svc.exportCheckpoint('y'); ok(ex.ok && /\.fackpt$/.test(ex.name) && ex.bytes.length > 100, '匯出 .fackpt', ex.name + ' ' + (ex.bytes && ex.bytes.length));
    const Cx = mk(); const im = await Cx.svc.importCheckpoint(ex.bytes, 'z'); ok(im.ok && im.step === 8 && im.produced_by.backend === 'wasm-web', '另一台匯入（驗證校驗和）', JSON.stringify(im).slice(0, 100));
    const r4 = await Cx.svc.start({ name: 'z', cfg: cfgOf(12), resume: true }); ok(r4.ok && r4.resumedFromStep === 8, '另一台從第 8 步續訓到 12', JSON.stringify(r4)); const d4 = await waitState(Cx.svc, r4.jobId, ['done', 'error']); ok(d4.state === 'done' && d4.step === 12, '續訓完成', d4.state + ' step=' + d4.step);
  }
  // 壞檔
  const D = mk(); const ex2 = await Bx.svc.exportCheckpoint('y'); const bad = Uint8Array.from(ex2.bytes); bad[Math.floor(bad.length * 0.3)] ^= 1; const im2 = await D.svc.importCheckpoint(bad, 'q'); ok(!im2.ok, '壞檔匯入被拒', im2.error);
  const im3 = await D.svc.importCheckpoint(new Uint8Array(50), 'q'); ok(!im3.ok && /不是有效/.test(im3.error), '非 zip 被拒');
  // 沒有檢查點不能續訓
  const E = mk(); const r5 = await E.svc.start({ name: 'none', cfg: cfgOf(3), resume: true }); ok(!r5.ok && /沒有 none 的檢查點/.test(r5.error), '沒有檢查點時續訓被拒', r5.error);
  // 配額太小：存檢查點時明確失敗並停止，狀態 error
  const F = mk(50); const r6 = await F.svc.start({ name: 'f', cfg: cfgOf(3) }); const d6 = await waitState(F.svc, r6.jobId, ['done', 'error']); ok(d6.state === 'error' && d6.errorName === 'SwapFullError' && /已滿/.test(d6.error), '配額滿了：工作進入 error 並說明', d6.error && d6.error.slice(0, 50));
  // 重複啟動
  const G = mk(); const g1 = await G.svc.start({ name: 'g', cfg: cfgOf(50) }); const g2 = await G.svc.start({ name: 'h', cfg: cfgOf(5) }); ok(!g2.ok && /已有一個訓練在跑/.test(g2.error), '同時只允許一個訓練'); const sp = await G.svc.stop(g1.jobId); ok(sp.ok, '停止');
  console.log(fail ? fail + ' 項失敗' : '全部通過'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL ' + e.stack); process.exit(1); });
