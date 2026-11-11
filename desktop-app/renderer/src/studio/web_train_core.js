'use strict';
/* 網頁版訓練服務（頁內，沒有子行程）：把 wasm-web 後端包成「開始／狀態／暫停／續訓／停止／匯出檢查點／匯入檢查點」。
 *  純核心、依賴注入（不碰 window／indexedDB）；產品把 backend、資料提供者、檢查點儲存（IndexedDB 專屬 store）注入進來。
 *  資料提供者 makeData(cfg) → { total, batch(i) → {ids, tgt}, sha }：把訓練資料轉成 token 序列的工作在宿主（分詞器＋提示格式）。
 *  檢查點儲存 store：{ put(key,u8), get(key), delete(key) }（swap_store 的 createIdbSwap／createMemorySwap；滿了會丟 SwapFullError，這裡原樣往外丟並停止）。
 *  檢查點匯出容器：zip（fatrain_core.writeZip 存放式），內容 = ckpt.json＋四個張量檔；副檔名 .fackpt（和 .fatrain 同容器技術，內容是續訓狀態不是資產）。 */
const Fat = require('./fatrain_core.js');
const C = require('./checkpoint_core.js');

const enc = (s) => new TextEncoder().encode(s), dec = (u) => new TextDecoder('utf-8').decode(u);
const sleep0 = () => new Promise((r) => setTimeout(r, 0));

function packCheckpoint(cp) {
  const entries = [{ name: 'ckpt.json', data: enc(JSON.stringify(cp.ckpt)) }];
  Object.keys(cp.files).sort().forEach((f) => entries.push({ name: f, data: cp.files[f] instanceof Uint8Array ? cp.files[f] : new Uint8Array(cp.files[f]) }));
  return Fat.writeZip(entries);
}
function unpackCheckpoint(bytes) {
  const es = Fat.readZip(bytes, {}); const by = {}; es.forEach((e) => { by[e.name] = e.data; });
  if (!by['ckpt.json']) throw new Error('不是續訓檢查點（缺少 ckpt.json）');
  const ckpt = JSON.parse(dec(by['ckpt.json'])); const files = {}; Object.keys(by).forEach((n) => { if (n !== 'ckpt.json') files[n] = by[n]; });
  return { ckpt, files };
}

function createWebTrainService(o) {
  const backend = o.backend, makeData = o.makeData, store = o.store, now = o.now || (() => Date.now()), yieldFn = o.yieldFn || sleep0;
  const jobs = new Map(); let seq = 0, activeId = null;
  const keyOf = (name) => 'ckpt:' + name;

  async function saveCkpt(job) {
    const cp = await backend.saveCheckpoint(job.h); const bytes = packCheckpoint(cp);
    await store.put(keyOf(job.name), bytes);              // 滿了：SwapFullError 原樣往外丟，不吞
    job.lastCkptStep = job.h.step; return { step: job.h.step, bytes: bytes.length };
  }
  async function loop(job) {
    try {
      while (job.state === 'running' && job.h.step < job.total) {
        const t0 = now(); const b = job.data.batch(job.h.step % job.data.total); const r = await backend.step(job.h, Object.assign({ lr: job.cfg.lr }, b));
        job.loss = r.loss; job.gradNorm = r.gradNorm; job.losses.push(r.loss); if (job.losses.length > 200) job.losses.shift(); job.tokens += b.ids.length; job.ms += now() - t0;
        if (job.cfg.saveSteps && job.h.step % job.cfg.saveSteps === 0) await saveCkpt(job);
        await yieldFn();
      }
      if (job.state === 'running') { await saveCkpt(job); job.state = 'done'; }
      else if (job.state === 'pausing') { await saveCkpt(job); job.state = 'paused'; }
      else if (job.state === 'stopping') job.state = 'stopped';
    } catch (e) { job.state = 'error'; job.error = String((e && e.message) || e); job.errorName = e && e.name; }
    finally { job.idle = true; if (job.waiters) job.waiters.forEach((w) => w()); }
  }

  const svc = {
    packCheckpoint, unpackCheckpoint,
    async start(p) {
      if (activeId && jobs.get(activeId) && ['running', 'pausing'].indexOf(jobs.get(activeId).state) >= 0) return { ok: false, error: '已有一個訓練在跑（' + activeId + '），請先暫停或停止' };
      const cfg = Object.assign({ steps: 100, lr: 0.001, rank: 8, alpha: 16, saveSteps: 0 }, p.cfg || {});
      let data; try { data = await makeData(cfg); } catch (e) { return { ok: false, error: '無法準備訓練資料：' + String((e && e.message) || e) }; }
      if (!data || !(data.total > 0)) return { ok: false, error: '訓練資料是空的（沒有可用的 token 序列）' };
      cfg.data_sha256 = data.sha;
      let assetState = null;
      if (p.resume) {
        let u = null; try { u = await store.get(keyOf(p.name)); } catch (e) { return { ok: false, error: '讀取檢查點失敗：' + String((e && e.message) || e) }; }
        if (!u) return { ok: false, error: '沒有 ' + p.name + ' 的檢查點可續訓（先暫停一次，或匯入 .fackpt）' };
        try { assetState = unpackCheckpoint(u); } catch (e) { return { ok: false, error: '檢查點損毀：' + String((e && e.message) || e) }; }
      }
      let h; try { h = await backend.init(assetState, cfg); } catch (e) { return { ok: false, error: String((e && e.message) || e), compat: e && e.compat }; }
      const job = { id: 'web' + (++seq) + '_' + now().toString(36), name: p.name, cfg, data, h, total: cfg.steps, state: 'running', loss: null, gradNorm: null, losses: [], tokens: 0, ms: 0, idle: false, startedAt: now(), resumedFrom: assetState ? h.step : 0 };
      jobs.set(job.id, job); activeId = job.id; job.promise = loop(job);
      return { ok: true, jobId: job.id, resumedFromStep: job.resumedFrom };
    },
    status(id) {
      const j = jobs.get(id || activeId); if (!j) return { ok: false, error: '沒有這個訓練工作' };
      return { ok: true, jobId: j.id, name: j.name, state: j.state, step: j.h.step, total: j.total, loss: j.loss, gradNorm: j.gradNorm, lossTail: j.losses.slice(-50), tokPerSec: j.ms > 0 ? j.tokens / (j.ms / 1000) : null, error: j.error || null, errorName: j.errorName || null, lastCkptStep: j.lastCkptStep === undefined ? null : j.lastCkptStep, backend: 'wasm-web' };
    },
    async _settle(j) { if (!j.idle) await new Promise((r) => { (j.waiters = j.waiters || []).push(r); }); },
    async pause(id) {
      const j = jobs.get(id || activeId); if (!j) return { ok: false, error: '沒有這個訓練工作' };
      if (j.state === 'paused') return { ok: true, step: j.h.step, checkpoint: true };
      if (j.state !== 'running') return { ok: false, error: '目前狀態（' + j.state + '）不能暫停' };
      j.state = 'pausing'; await svc._settle(j);
      if (j.state === 'error') return { ok: false, error: j.error, errorName: j.errorName };
      return { ok: true, step: j.h.step, checkpoint: true };
    },
    async stop(id) {
      const j = jobs.get(id || activeId); if (!j) return { ok: true };
      if (j.state === 'running' || j.state === 'pausing') { j.state = 'stopping'; await svc._settle(j); }
      return { ok: true, state: j.state };
    },
    // 匯出：取該名稱最新的檢查點（暫停或完成時存的）
    async exportCheckpoint(name) { const u = await store.get(keyOf(name)); if (!u) return { ok: false, error: '沒有 ' + name + ' 的檢查點可匯出（先暫停或等訓練完成）' }; return { ok: true, name: name + '.fackpt', bytes: u }; },
    // 匯入：先驗證容器與校驗和再存；name 缺省用檢查點內記的資產名稱沒有就用 imported
    async importCheckpoint(bytes, name) {
      let cp; try { cp = unpackCheckpoint(bytes); } catch (e) { return { ok: false, error: '不是有效的 .fackpt：' + String((e && e.message) || e) }; }
      const v = C.verifyChecksums(cp); if (!v.ok) return { ok: false, error: '檢查點驗證失敗：' + v.bad.join('、') };
      const nm = name || 'imported'; await store.put(keyOf(nm), bytes);
      return { ok: true, name: nm, step: cp.ckpt.step, produced_by: cp.ckpt.produced_by, compat: cp.ckpt.compat, loss_tail: (cp.ckpt.loss_tail || []).slice(-5) };
    },
  };
  return svc;
}

module.exports = { createWebTrainService, packCheckpoint, unpackCheckpoint };
