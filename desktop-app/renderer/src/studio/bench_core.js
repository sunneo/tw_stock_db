'use strict';
// 基準測試、一致性檢查、結果快取與自動選擇（DESIGN.TODO.offline-training-studio.md §4.1、§5.8）。純核心、依賴注入（時鐘、儲存、記錄都由呼叫端給）。
const crypto = require('crypto');
const B = require('./backend_core.js');

// §5.8 設計初值（階段 2 以真實測量校準後才固定）
const BENCH = { warmup: 3, steps: 30, samples: 16, seqLen: 256, batch: 1, deadlineMs: 60000, abortWithinMs: 3000 };
const CONSIST = { loss1: 1e-3, gradNorm1: 1e-2, loss30: 0.03, loss30Fp16: 0.05 };
const TIE = 0.10;       // 同速：差 <10%

// 基準本身也要遵守「電腦保持可用」：核心數上限 N−1，至少 1
const benchThreads = (cores) => Math.max(1, (cores | 0) - 1);

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
function percentile(sorted, p) { if (!sorted.length) return 0; const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1)); return sorted[i]; }
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

// ---- 一致性檢查四項（以參考後端的 trace 為準）----
// trace = { loss1, gradNorm1, loss30, hasNonFinite }
function consistencyCheck(ref, cand, o) {
  o = o || {}; const fp16 = !!o.fp16;
  const items = [
    { name: '第1步loss', value: rel(cand.loss1, ref.loss1), tol: CONSIST.loss1 },
    { name: '第1步梯度範數', value: rel(cand.gradNorm1, ref.gradNorm1), tol: CONSIST.gradNorm1 },
    { name: '30步後loss', value: rel(cand.loss30, ref.loss30), tol: fp16 ? CONSIST.loss30Fp16 : CONSIST.loss30 },
  ].map((x) => Object.assign(x, { pass: finite(x.value) && x.value <= x.tol }));
  items.push({ name: '全程無NaN或Inf', value: cand.hasNonFinite ? 1 : 0, tol: 0, pass: !cand.hasNonFinite });
  const failed = items.filter((x) => !x.pass).map((x) => x.name);
  return { pass: failed.length === 0, items, failed, fp16, maxRelErr: Math.max(items[0].value, items[1].value), lossDelta: items[2].value };
}

// ---- 可中斷的逐步基準（perStep 後端共用）----
// opts: { signal, now(), reference(trace), fp16, isReference, deadlineMs, warmup, steps, tokensPerStep }
// cfg.makeBatch(i) 給第 i 步的批次（固定種子的 16 筆樣本由呼叫端決定）
async function stepBenchmark(backend, cfg, opts) {
  opts = opts || {}; const now = opts.now || (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now()), signal = opts.signal || null;
  const warm = opts.warmup === undefined ? BENCH.warmup : opts.warmup, steps = opts.steps === undefined ? BENCH.steps : opts.steps;
  const deadline = opts.deadlineMs === undefined ? BENCH.deadlineMs : opts.deadlineMs, tokens = opts.tokensPerStep || (BENCH.seqLen * BENCH.batch);
  const t0 = now(); let abortedAt = null, handle = null, tooSlow = false;
  let abortReject; const abortP = new Promise((_, rej) => { abortReject = rej; });
  abortP.catch(() => {});
  const onAbort = () => { if (abortedAt === null) abortedAt = now(); abortReject(new Error('__aborted__')); };
  if (signal) { if (signal.aborted) onAbort(); else if (signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true }); }
  const guard = (p) => Promise.race([Promise.resolve(p), abortP]);       // 單步卡住也能在中斷後立刻返回
  const times = [], losses = []; let gn1 = null, nonFinite = false, peak = 0, err = null;
  try {
    handle = await guard(backend.init(null, Object.assign({}, cfg, { threads: cfg.threads || benchThreads(cfg.cores || 2) })));
    for (let i = 0; i < warm + steps; i++) {
      if (abortedAt !== null) break;
      if (now() - t0 > deadline) { tooSlow = true; break; }
      const s0 = now(); const r = await guard(backend.step(handle, cfg.makeBatch ? cfg.makeBatch(i) : { index: i })); const dt = now() - s0;
      if (!finite(r.loss) || (r.gradNorm !== undefined && !finite(r.gradNorm))) nonFinite = true;
      if (i === 0) gn1 = r.gradNorm;
      if (i >= warm) { times.push(dt); losses.push(r.loss); }
      else if (i === 0) losses.unshift(r.loss);   // 第 1 步 loss 放最前面當 loss1（暖機的其餘步不計入速度）
      if (backend.peakMemBytes) { try { peak = Math.max(peak, backend.peakMemBytes(handle) || 0); } catch (e) {} }
    }
  } catch (e) { if (!(e && e.message === '__aborted__')) err = e; }
  finally {
    if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
    if (handle) { try { await Promise.race([Promise.resolve(backend.dispose(handle)), new Promise((r) => setTimeout(r, 2000))]); } catch (e) {} }
  }
  const stoppedAfterMs = abortedAt === null ? null : now() - abortedAt;
  if (abortedAt !== null) return { ok: false, aborted: true, stoppedAfterMs, elapsedMs: now() - t0, reason: '使用者中斷' };
  if (err) return { ok: false, error: String(err && err.message || err), reason: '基準測試失敗：' + (err && err.message || err), elapsedMs: now() - t0 };
  if (tooSlow) return { ok: false, tooSlow: true, reason: '太慢：超過 ' + Math.round(deadline / 1000) + ' 秒仍未跑完 ' + (warm + steps) + ' 步', elapsedMs: now() - t0 };
  const sorted = times.slice().sort((a, b) => a - b), med = percentile(sorted, 0.5);
  const trace = { loss1: losses[0], gradNorm1: gn1, loss30: losses[losses.length - 1], hasNonFinite: nonFinite };
  const res = { ok: true, tokPerSec: med > 0 ? tokens / (med / 1000) : 0, peakMemBytes: peak || null, stepMsP50: med, stepMsP95: percentile(sorted, 0.95), samples: times.length, trace, elapsedMs: now() - t0, threads: cfg.threads || benchThreads(cfg.cores || 2), fp16: !!opts.fp16 };
  if (opts.isReference) res.numericCheck = { pass: !nonFinite, maxRelErr: 0, lossDelta: 0, reference: true, items: [], failed: nonFinite ? ['全程無NaN或Inf'] : [] };
  else if (opts.reference) { const c = consistencyCheck(opts.reference, trace, { fp16: opts.fp16 }); res.numericCheck = { pass: c.pass, maxRelErr: c.maxRelErr, lossDelta: c.lossDelta, items: c.items, failed: c.failed }; }
  else res.numericCheck = { pass: false, maxRelErr: null, lossDelta: null, items: [], failed: ['沒有參考後端的結果可比對'] };
  return res;
}
// 通過門檻：四項全過、沒超時、沒錯誤才算通過（才可被「自動」選用）
const benchPassed = (r) => !!(r && r.ok && !r.tooSlow && r.numericCheck && r.numericCheck.pass);

// ---- 快取：以硬體指紋為鍵 ----
function stableStringify(o) { if (o === null || typeof o !== 'object') return JSON.stringify(o); if (Array.isArray(o)) return '[' + o.map(stableStringify).join(',') + ']'; return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}'; }
const hashFingerprint = (fp) => crypto.createHash('sha256').update(stableStringify(fp || {})).digest('hex').slice(0, 16);
function diffFingerprint(a, b) { const keys = new Set(Object.keys(a || {}).concat(Object.keys(b || {}))), out = []; keys.forEach((k) => { if (stableStringify((a || {})[k]) !== stableStringify((b || {})[k])) out.push(k); }); return out; }
// store: { load() -> obj|null, save(obj) }（可非同步）；沒給就用記憶體
function createBenchCache(store, now) {
  now = now || (() => Date.now()); let mem = null;
  const load = async () => { if (mem) return mem; let d = null; try { d = store ? await store.load() : null; } catch (e) {} mem = d && d.version === 1 ? d : { version: 1, entries: {}, latest: {} }; return mem; };
  const persist = async () => { if (store) try { await store.save(mem); } catch (e) {} };
  return {
    // 回傳 {status:'hit'|'stale'|'none', result?, changed?}
    async lookup(id, fp) {
      const d = await load(), h = hashFingerprint(fp), e = d.entries[id + '|' + h];
      if (e) return { status: 'hit', result: e.result, at: e.at };
      const last = d.latest[id]; return last ? { status: 'stale', changed: diffFingerprint(last.fingerprint, fp), previous: last } : { status: 'none' };
    },
    async store(id, fp, result) { const d = await load(), h = hashFingerprint(fp); const slim = Object.assign({}, result); d.entries[id + '|' + h] = { result: slim, at: now(), fingerprint: fp }; d.latest[id] = { hash: h, fingerprint: fp }; await persist(); },
    async clear() { mem = { version: 1, entries: {}, latest: {} }; await persist(); },
  };
}

// ---- 自動選擇 ----
// o: { kind, registry, cache, ctx(傳給 probe；ctx.modelSha256 併入指紋), pin, skipBench, runBench(id, signal)->結果, signal, log(rec) }
async function autoSelect(o) {
  const log = o.log || (() => {}), events = [];
  const ev = (rec) => { events.push(rec); log(rec); };
  if (B.isSymbolicKind(o.kind)) return { chosen: 'cpu-js', order: ['cpu-js'], source: 'symbolic', needsRebench: false, stale: [], events, reason: '符號式訓練只需處理器（cpu-js）' };
  const ids = o.registry.supportedFor(o.kind), probes = {}, fps = {};
  for (const id of ids) {
    const b = o.registry.get(id);
    probes[id] = b ? await B.safeProbe(b, o.ctx) : B.probeResult(false, '後端 ' + id + ' 沒有登錄');
    fps[id] = Object.assign({}, probes[id].fingerprint, { model_sha256: (o.ctx && o.ctx.modelSha256) || null, backend: id });
  }
  const avail = ids.filter((id) => probes[id].available);
  // 釘選：不自動換；不可用就停下詢問
  if (o.pin) {
    if (probes[o.pin] && probes[o.pin].available) {
      const c = await o.cache.lookup(o.pin, fps[o.pin]);
      return { chosen: o.pin, order: [o.pin], pinned: true, stopOnFail: true, source: 'pin', needsRebench: c.status !== 'hit', stale: [], warning: c.status === 'hit' && !benchPassed(c.result) ? '釘選的後端未通過一致性檢查：' + ((c.result.numericCheck && c.result.numericCheck.failed) || [c.result.reason]).join('、') : '', events };
    }
    return { chosen: null, order: [], pinned: true, ask: true, source: 'pin', needsRebench: false, stale: [], events, reason: '釘選的後端 ' + o.pin + ' 不可用：' + ((probes[o.pin] && probes[o.pin].reason) || '沒有這個後端') + '；要改用別的後端嗎？' };
  }
  if (!avail.length) return { chosen: null, order: [], source: 'none', needsRebench: false, stale: [], events, reason: '沒有可用的後端：' + ids.map((i) => i + '＝' + probes[i].reason).join('；') };
  const results = {}, stale = []; const missing = [];
  for (const id of avail) {
    const c = await o.cache.lookup(id, fps[id]);
    if (c.status === 'hit') results[id] = c.result;
    else { missing.push(id); if (c.status === 'stale') { stale.push({ id, changed: c.changed }); ev({ at: 'cache_stale', backend: id, changed: c.changed, text: id + ' 的硬體指紋改變（' + c.changed.join('、') + '），快取失效，需重新跑基準測試' }); } }
  }
  let source = missing.length ? 'benchmark' : 'cache';
  if (missing.length && o.skipBench) {
    // 略過基準：用 cpu-py（沒有就停下詢問，不拿未驗證的後端硬上）
    ev({ at: 'bench_skipped', text: '略過基準測試，使用 cpu-py' });
    if (probes['cpu-py'] && probes['cpu-py'].available) return { chosen: 'cpu-py', order: ['cpu-py'], source: 'skip-bench', needsRebench: true, stale, events };
    return { chosen: null, order: [], ask: true, source: 'skip-bench', needsRebench: true, stale, events, reason: '略過基準測試時預設用 cpu-py，但它不可用：' + probes['cpu-py'].reason };
  }
  for (const id of missing) {
    if (o.signal && o.signal.aborted) { ev({ at: 'bench_aborted', backend: id, text: '基準測試被中斷' }); return { chosen: null, order: [], aborted: true, source: 'benchmark', needsRebench: true, stale, events, reason: '基準測試被使用者中斷' }; }
    let r; try { r = await o.runBench(id, o.signal); } catch (e) { r = { ok: false, error: String(e && e.message || e), reason: '基準測試丟出例外：' + (e && e.message || e) }; }
    if (r && r.aborted) { ev({ at: 'bench_aborted', backend: id, text: '基準測試被中斷' }); return { chosen: null, order: [], aborted: true, source: 'benchmark', needsRebench: true, stale, events, reason: '基準測試被使用者中斷' }; }
    if (!benchPassed(r)) ev({ at: 'bench_failed', backend: id, text: id + ' 基準測試未通過：' + (r && (r.reason || (r.numericCheck && r.numericCheck.failed && r.numericCheck.failed.join('、'))) || '未知原因') });
    results[id] = r; await o.cache.store(id, fps[id], r);
  }
  const cands = avail.filter((id) => benchPassed(results[id]));
  if (!cands.length) return { chosen: null, order: [], source, needsRebench: false, stale, events, reason: '可用的後端都沒通過基準測試／一致性檢查：' + avail.map((i) => i + '＝' + ((results[i] && (results[i].reason || (results[i].numericCheck && results[i].numericCheck.failed.join('、')))) || '無結果')).join('；') };
  const speed = (id) => results[id].tokPerSec || 0, top = Math.max.apply(null, cands.map(speed));
  const cmp = (a, b) => { const na = speed(a) >= top * (1 - TIE), nb = speed(b) >= top * (1 - TIE); if (na && nb) return B.maturityRank(a) - B.maturityRank(b) || speed(b) - speed(a); if (na !== nb) return na ? -1 : 1; return speed(b) - speed(a); };
  const order = cands.slice().sort(cmp);
  return { chosen: order[0], order, source, needsRebench: false, stale, events, table: avail.map((id) => ({ id, result: results[id], passed: benchPassed(results[id]) })) };
}

// ---- 失敗自動降級（訓練中後端失敗：已存檢查點，換下一個候選）----
function degrade(o) {   // o: { order, failed, step, reason, pinned, log }
  const log = o.log || (() => {});
  if (o.pinned) { const m = '釘選的後端 ' + o.failed + ' 失敗（' + o.reason + '，step=' + o.step + '），已停下；要換成別的後端嗎？'; log({ at: 'pinned_failed', backend: o.failed, step: o.step, reason: o.reason, text: m }); return { stop: true, ask: m }; }
  const rest = (o.order || []).filter((x) => x !== o.failed), to = rest[0];
  if (!to) { const m = '後端 ' + o.failed + ' 失敗（' + o.reason + '，step=' + o.step + '），沒有可降級的候選'; log({ at: 'degrade_none', backend: o.failed, step: o.step, reason: o.reason, text: m }); return { stop: true, message: m }; }
  const text = '由 ' + o.failed + ' 後端失敗降級到 ' + to + '，原因：' + o.reason + '，降級時 step=' + o.step;
  log({ at: 'degrade', from: o.failed, to, step: o.step, reason: o.reason, text });
  return { stop: false, to, order: rest, message: text, needsCrossBackendCheck: true };
}

module.exports = { BENCH, CONSIST, TIE, benchThreads, percentile, consistencyCheck, stepBenchmark, benchPassed, stableStringify, hashFingerprint, diffFingerprint, createBenchCache, autoSelect, degrade };
