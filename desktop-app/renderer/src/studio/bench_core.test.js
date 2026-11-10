'use strict';
// 基準測試（暖機、可中斷 3 秒內停、60 秒上限）、一致性四項、快取、autoSelect 四種情境（快取命中／指紋失效／失敗降級／釘選）
const BC = require('./bench_core.js'), B = require('./backend_core.js'), J = require('./backend_cpu_js.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };

// 假後端：可設 probe 結果、基準結果
function fake(id, o) {
  o = o || {};
  return { id, capabilities: { perStep: true, run: false }, async probe() { return B.probeResult(o.available !== false, o.available === false ? (o.reason || '不可用') : '', { name: id }, o.fp || { gpu: 'g1', driver: '1.0' }); },
    async benchmark() { o.calls = (o.calls || 0) + 1; return o.result; }, init: async () => ({}), step: async () => ({ loss: 1 }), evalLoss: async () => ({ loss: 1 }), saveCheckpoint: async () => ({}), loadCheckpoint: async () => {}, dispose: async () => {}, _o: o };
}
const good = (tps) => ({ ok: true, tokPerSec: tps, numericCheck: { pass: true, maxRelErr: 0, lossDelta: 0, failed: [] } });
const bench = (reg) => async (id, signal) => reg.get(id).benchmark({}, { signal });

(async () => {
  // 核心數上限 N−1
  check('基準核心數上限 N−1（至少 1）', BC.benchThreads(8) === 7 && BC.benchThreads(2) === 1 && BC.benchThreads(1) === 1);
  // 一致性四項
  const ref = { loss1: 2, gradNorm1: 1, loss30: 1, hasNonFinite: false };
  const c0 = BC.consistencyCheck(ref, ref); check('完全一致：四項全過', c0.pass && c0.items.length === 4);
  check('第1步loss差 >1e-3 不通過', BC.consistencyCheck(ref, Object.assign({}, ref, { loss1: 2.01 })).failed.join() === '第1步loss');
  check('梯度範數差 >1e-2 不通過', BC.consistencyCheck(ref, Object.assign({}, ref, { gradNorm1: 1.02 })).failed.join() === '第1步梯度範數');
  check('30步後差 3.1% 不通過、2.9% 通過', !BC.consistencyCheck(ref, Object.assign({}, ref, { loss30: 1.031 })).pass && BC.consistencyCheck(ref, Object.assign({}, ref, { loss30: 1.029 })).pass);
  check('半精度 30 步放寬到 5%', BC.consistencyCheck(ref, Object.assign({}, ref, { loss30: 1.045 }), { fp16: true }).pass && !BC.consistencyCheck(ref, Object.assign({}, ref, { loss30: 1.055 }), { fp16: true }).pass);
  check('出現 NaN 不通過', BC.consistencyCheck(ref, Object.assign({}, ref, { hasNonFinite: true })).failed.includes('全程無NaN或Inf'));
  check('NaN loss 也不通過', !BC.consistencyCheck(ref, Object.assign({}, ref, { loss30: NaN })).pass);
  check('通過門檻：四項全過才算', BC.benchPassed(good(1)) && !BC.benchPassed({ ok: true, numericCheck: { pass: false } }) && !BC.benchPassed({ ok: true, tooSlow: true, numericCheck: { pass: true } }) && !BC.benchPassed(null));

  // 真的跑 cpu-js 基準（參考）與一個相同引擎當候選（應通過一致性）
  const js = J.createCpuJsBackend();
  const r1 = await js.benchmark({ cores: 4 }, {});
  check('cpu-js 基準完成：30 個樣本、token/秒 >0、有 p50/p95', r1.ok && r1.samples === 30 && r1.tokPerSec > 0 && r1.stepMsP95 >= r1.stepMsP50, r1);
  check('基準使用的核心數 ≤ N−1', r1.threads === 3, r1.threads);
  const r2 = await js.benchmark({ cores: 4 }, { reference: r1.trace });
  check('相同引擎當候選：四項一致性通過', r2.numericCheck.pass && r2.numericCheck.items.length === 4, r2.numericCheck);
  const r3 = await js.benchmark({ cores: 4, lr: 0.02 }, { reference: r1.trace });
  check('引擎行為不同（學習率不同）：一致性不通過並指出項目', !r3.numericCheck.pass && r3.numericCheck.failed.length > 0, r3.numericCheck);

  // 可中斷：單步卡死也要在中斷後 3 秒內停
  const hang = { id: 'cpu-js', capabilities: { perStep: true }, init: async () => ({}), step: () => new Promise(() => {}), dispose: () => new Promise(() => {}) };
  const ac = new AbortController(); setTimeout(() => ac.abort(), 80);
  const t0 = Date.now(), ra = await BC.stepBenchmark(hang, { makeBatch: () => ({}) }, { signal: ac.signal });
  check('中斷：單步卡死也立即返回、3 秒內停止', ra.aborted && ra.stoppedAfterMs < BC.BENCH.abortWithinMs && Date.now() - t0 < BC.BENCH.abortWithinMs, { ra, took: Date.now() - t0 });
  const pre = new AbortController(); pre.abort();
  const rp = await BC.stepBenchmark(js, { makeBatch: () => ({}) }, { signal: pre.signal });
  check('開始前已中斷：不跑任何一步', rp.aborted === true);
  // 中途中斷（正常快步）：跑一半停
  let nSteps = 0; const slowish = { id: 'cpu-js', capabilities: { perStep: true }, init: async () => ({}), step: async () => { nSteps++; await new Promise((r) => setTimeout(r, 20)); return { loss: 1, gradNorm: 1 }; }, dispose: async () => {} };
  const ac2 = new AbortController(); setTimeout(() => ac2.abort(), 150);
  const rm = await BC.stepBenchmark(slowish, { makeBatch: () => ({}) }, { signal: ac2.signal });
  check('中途中斷：步數不到全部、回報 aborted', rm.aborted && nSteps < 33 && nSteps > 0, { nSteps });
  // 60 秒上限：用假時鐘
  let clock = 0; const tick = { id: 'cpu-js', capabilities: { perStep: true }, init: async () => ({}), step: async () => { clock += 5000; return { loss: 1, gradNorm: 1 }; }, dispose: async () => {} };
  const rs = await BC.stepBenchmark(tick, { makeBatch: () => ({}) }, { now: () => clock });
  check('超過 60 秒中止並標「太慢」', rs.tooSlow && /太慢/.test(rs.reason) && !BC.benchPassed(rs), rs);
  const rex = await BC.stepBenchmark({ id: 'x', init: async () => { throw new Error('裝置遺失'); }, dispose: async () => {} }, {}, {});
  check('初始化失敗回具體原因', !rex.ok && /裝置遺失/.test(rex.reason), rex);
  const rnan = await BC.stepBenchmark({ id: 'x', init: async () => ({}), step: async () => ({ loss: NaN, gradNorm: 1 }), dispose: async () => {} }, { makeBatch: () => ({}) }, { reference: ref });
  check('NaN 的後端基準不通過', !BC.benchPassed(rnan), rnan);

  // 快取：指紋為鍵
  const fpA = { cpu: 'i7', cores: 8, model_sha256: 'm1' };
  check('指紋雜湊與鍵順序無關', BC.hashFingerprint({ a: 1, b: { c: 2, d: 3 } }) === BC.hashFingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  check('指紋差異欄位', BC.diffFingerprint({ a: 1, b: 2 }, { a: 1, b: 3, c: 1 }).join() === 'b,c');
  let saved = null; const cache0 = BC.createBenchCache({ load: async () => saved, save: async (d) => { saved = JSON.parse(JSON.stringify(d)); } });
  check('空快取：none', (await cache0.lookup('cpu-py', fpA)).status === 'none');
  await cache0.store('cpu-py', fpA, good(60));
  check('同指紋命中', (await cache0.lookup('cpu-py', fpA)).status === 'hit');
  const st = await cache0.lookup('cpu-py', Object.assign({}, fpA, { model_sha256: 'm2' }));
  check('指紋任一項改變：失效並指出改了哪項', st.status === 'stale' && st.changed.join() === 'model_sha256', st);
  const cache1 = BC.createBenchCache({ load: async () => saved, save: async () => {} });
  check('快取可由儲存層重新載入（跨重開）', (await cache1.lookup('cpu-py', fpA)).status === 'hit');

  // autoSelect 四種情境
  const mk = (specs) => { const reg = new B.BackendRegistry(); Object.keys(specs).forEach((id) => reg.register(fake(id, specs[id]))); return reg; };
  const lora = (reg, extra) => Object.assign({ kind: 'lora', registry: reg, cache: BC.createBenchCache(null), ctx: { modelSha256: 'm1' }, runBench: bench(reg) }, extra);
  // (0) 符號式
  const s0 = await BC.autoSelect({ kind: 'uml', registry: mk({}), cache: BC.createBenchCache(null) });
  check('符號式五類直接 cpu-js', s0.chosen === 'cpu-js' && s0.source === 'symbolic');
  // (1) 沒快取：自動跑基準、選最快且通過者、並寫入快取
  const specs1 = { 'cpu-py': { result: good(60) }, webgpu: { result: good(300) }, directml: { available: false, reason: '已知失敗' }, vulkan: { result: { ok: true, tokPerSec: 900, numericCheck: { pass: false, failed: ['第1步loss'] } } } };
  const reg1 = mk(specs1), cache1b = BC.createBenchCache(null), logs = [];
  const a1 = await BC.autoSelect(lora(reg1, { cache: cache1b, log: (r) => logs.push(r) }));
  check('沒快取：跑基準後選最快且「通過」者（vulkan 較快但不一致，不可選）', a1.chosen === 'webgpu' && a1.source === 'benchmark' && a1.order.join() === 'webgpu,cpu-py', a1);
  check('不可用的後端沒被拿去跑基準', specs1.directml.calls === undefined && specs1['cpu-py'].calls === 1);
  check('基準未通過有寫紀錄', logs.some((l) => l.at === 'bench_failed' && l.backend === 'vulkan' && /第1步loss/.test(l.text)), logs);
  // (2) 快取命中：不再跑基準
  const a2 = await BC.autoSelect(lora(reg1, { cache: cache1b }));
  check('快取命中：不重跑基準、結果相同', a2.source === 'cache' && a2.chosen === 'webgpu' && specs1['cpu-py'].calls === 1 && specs1.webgpu.calls === 1, a2);
  // (3) 指紋失效：驅動改變 → 提示並重測
  specs1.webgpu.fp = { gpu: 'g1', driver: '2.0' }; const logs3 = [];
  const a3 = await BC.autoSelect(lora(reg1, { cache: cache1b, log: (r) => logs3.push(r) }));
  check('指紋改變：該後端快取失效、重測、其餘命中', specs1.webgpu.calls === 2 && specs1['cpu-py'].calls === 1 && logs3.some((l) => l.at === 'cache_stale' && l.backend === 'webgpu' && l.changed.includes('driver')), { logs3, c: specs1.webgpu.calls });
  check('指紋失效結果有列出 stale', a3.stale.length === 1 && a3.stale[0].id === 'webgpu');
  // 模型改變也失效
  const a3b = await BC.autoSelect(lora(reg1, { cache: cache1b, ctx: { modelSha256: 'm2' } }));
  check('模型 sha256 改變：全部重測', specs1['cpu-py'].calls === 2 && a3b.source === 'benchmark');
  // 同速偏好成熟者（差 <10%）
  const reg4 = mk({ 'cpu-py': { result: good(100) }, webgpu: { result: good(105) }, vulkan: { result: good(95) } });
  const a4 = await BC.autoSelect(lora(reg4));
  check('同速（差<10%）偏好較成熟：cpu-py', a4.chosen === 'cpu-py' && a4.order.join() === 'cpu-py,vulkan,webgpu', a4.order);
  const reg4b = mk({ 'cpu-py': { result: good(100) }, webgpu: { result: good(125) } });
  check('差 ≥10% 以速度為準', (await BC.autoSelect(lora(reg4b))).chosen === 'webgpu');
  // 略過基準 → cpu-py
  const reg5 = mk({ 'cpu-py': { result: good(60) }, webgpu: { result: good(300) } });
  const a5 = await BC.autoSelect(lora(reg5, { skipBench: true }));
  check('略過基準：用 cpu-py 並提示需重測', a5.chosen === 'cpu-py' && a5.needsRebench && reg5.get('cpu-py')._o.calls === undefined, a5);
  const a5b = await BC.autoSelect(lora(mk({ 'cpu-py': { available: false, reason: '找不到 Python' }, webgpu: { result: good(1) } }), { skipBench: true }));
  check('略過基準但 cpu-py 不可用：停下詢問，不硬選', a5b.chosen === null && a5b.ask && /找不到 Python/.test(a5b.reason), a5b);
  // 全部不可用／全部未通過
  const a6 = await BC.autoSelect(lora(mk({ 'cpu-py': { available: false, reason: '找不到 Python' } })));
  check('全部不可用：回具體原因', a6.chosen === null && /找不到 Python/.test(a6.reason));
  const a7 = await BC.autoSelect(lora(mk({ 'cpu-py': { result: { ok: true, tokPerSec: 5, numericCheck: { pass: false, failed: ['全程無NaN或Inf'] } } } })));
  check('全部未通過：不選並列出失敗項目', a7.chosen === null && /NaN/.test(a7.reason), a7);
  // 基準被中斷
  const acs = new AbortController(); const reg8 = mk({ 'cpu-py': { result: good(1) } }); reg8.get('cpu-py').benchmark = async () => { acs.abort(); return { ok: false, aborted: true }; };
  const a8 = await BC.autoSelect(lora(reg8, { signal: acs.signal }));
  check('基準被中斷：不快取、回 aborted', a8.aborted && a8.chosen === null);
  // 基準丟例外：視為失敗、不擋住其他後端
  const reg9 = mk({ 'cpu-py': { result: good(60) }, webgpu: { result: good(1) } }); reg9.get('webgpu').benchmark = async () => { throw new Error('裝置遺失'); };
  const logs9 = []; const a9 = await BC.autoSelect(lora(reg9, { log: (r) => logs9.push(r) }));
  check('基準丟例外：降級選其他後端並記錄', a9.chosen === 'cpu-py' && logs9.some((l) => l.at === 'bench_failed' && /裝置遺失/.test(l.text)), logs9);
  // (4) 釘選
  const reg10 = mk({ 'cpu-py': { result: good(60) }, webgpu: { result: good(300) } });
  const a10 = await BC.autoSelect(lora(reg10, { pin: 'cpu-py' }));
  check('釘選：直接用、不跑基準、失敗時停下', a10.chosen === 'cpu-py' && a10.pinned && a10.stopOnFail && reg10.get('webgpu')._o.calls === undefined && a10.order.length === 1, a10);
  const a11 = await BC.autoSelect(lora(reg10, { pin: 'vulkan' }));
  check('釘選的後端不可用：詢問而不是悄悄換', a11.chosen === null && a11.ask && /vulkan/.test(a11.reason), a11);
  // 失敗自動降級
  const logsD = [], d1 = BC.degrade({ order: a1.order, failed: 'webgpu', step: 137, reason: '裝置遺失', log: (r) => logsD.push(r) });
  check('降級：到下一個候選、紀錄寫明原因與 step、需跨後端比對', d1.to === 'cpu-py' && d1.needsCrossBackendCheck && /由 webgpu 後端失敗降級到 cpu-py，原因：裝置遺失，降級時 step=137/.test(d1.message) && logsD[0].at === 'degrade', d1);
  const d2 = BC.degrade({ order: ['cpu-py'], failed: 'cpu-py', step: 1, reason: '記憶體不足' }); check('沒有下一個候選：停止並說明', d2.stop && /沒有可降級/.test(d2.message));
  const d3 = BC.degrade({ order: ['cpu-py', 'webgpu'], failed: 'cpu-py', step: 9, reason: 'NaN', pinned: true }); check('釘選時失敗：停下詢問、不降級', d3.stop && /釘選/.test(d3.ask) && !d3.to);

  console.log(ok + ' passed, ' + bad.length + ' failed', bad);
  process.exit(bad.length ? 1 : 0);
})();
