'use strict';
// wasm-web 後端：網頁版（也可用於桌面版渲染行程）的 WebAssembly 處理器 LoRA 訓練（DESIGN.TODO.offline-training-studio.md §5.6）。
// 真引擎是 qwen3_layered_engine.js（逐層圖＋onnxruntime-web）；本檔只做「後端介面」與「規範化 float32 檢查點」的轉接，
// 所以能暫停 → 匯出 .fatrain → 在別台（桌面版 cpu-py 或另一台網頁）續訓。引擎由 engineFactory 注入（測試用假引擎，產品用真引擎）。
// 速度不是門檻（使用者 2026-11-11）：正確、可暫停、可搬到別台續訓才是。
const C = require('./checkpoint_core.js');
const B = require('./backend_core.js');
const BC = require('./bench_core.js');

function eachNamed(map, suffix) { const out = []; for (const [k, a] of map) if (!suffix || k.endsWith(suffix)) out.push(k); return out.sort(); }
function T(map, shapes, names) { return names.map((n) => ({ name: n, shape: shapes.get(n), data: map.get(n) })); }

// 引擎介面（注入）：{ shapes:Map, exportState():{t,params,m,v}, importState(st), step(ids,tgt,lr)->{loss,gradNorm}, evalLoss(ids,tgt)->{loss}, dispose() }
function createWasmWebBackend(o) {
  o = o || {};
  const produced = Object.assign({ backend: 'wasm-web', device_fingerprint: 'wasm', engine_version: 'layered-1', precision: 'float32' }, o.produced || {});
  const b = {
    id: 'wasm-web', capabilities: { perStep: true, run: false, fp16: false }, kinds: B.KIND_BACKENDS,
    async probe(ctx) {
      const hw = (ctx && ctx.hw) || {};
      if (typeof WebAssembly !== 'object') return B.probeResult(false, '這個環境沒有 WebAssembly', { name: '' }, { backend: 'wasm-web' });
      const g = typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : {});
      const isolated = !!g.crossOriginIsolated, sab = typeof SharedArrayBuffer !== 'undefined';
      let simd = null; try { simd = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (e) { simd = null; }
      return B.probeResult(true, '', { name: 'WebAssembly 處理器（onnxruntime-web，逐層）', vendor: 'wasm', fp16: false },
        { backend: 'wasm-web', cpu: hw.cpuModel || null, cores: hw.cores || null, engine_version: produced.engine_version, simd, crossOriginIsolated: isolated, sharedArrayBuffer: sab, threadsPossible: isolated && sab });
    },
    async benchmark(cfg, opts) {
      const c = Object.assign({}, cfg, { makeBatch: (cfg && cfg.makeBatch) || ((i) => { const T = (cfg && cfg.seqLen) || 32; const ids = [], tgt = []; for (let k = 0; k < T; k++) { ids.push(1000 + ((i * 131 + k * 7919) % 50000)); tgt.push(1000 + ((i * 131 + (k + 1) * 7919) % 50000)); } return { ids, tgt }; }) });
      return BC.stepBenchmark(b, c, Object.assign({}, opts, { isReference: !(opts && opts.reference), tokensPerStep: (cfg && cfg.seqLen) || 32 }));
    },
    async init(assetState, cfg) {
      if (!o.engineFactory) throw new Error('wasm-web 後端沒有注入引擎（engineFactory）');
      const eng = await o.engineFactory(cfg || {}); const h = { eng, cfg: cfg || {}, step: 0, cursor: C.createCursor((cfg && cfg.orderSeed) || 7), rng: new C.PCG32((cfg && cfg.seed) || 1234, 11), lossTail: [], disposed: false };
      if (assetState && assetState.ckpt) await b.loadCheckpoint(h, assetState);
      return h;
    },
    async step(h, batch) {
      if (h.disposed) throw new Error('handle 已釋放');
      const r = await h.eng.step(batch.ids, batch.tgt, batch.lr, batch.mask); h.step++; h.cursor.consumed_tokens += batch.ids.length; h.lossTail.push(r.loss); if (h.lossTail.length > 50) h.lossTail.shift();
      return { loss: r.loss, gradNorm: r.gradNorm };
    },
    async evalLoss(h, batch) { return h.eng.evalLoss(batch.ids, batch.tgt, batch.mask); },
    async saveCheckpoint(h) {
      const st = h.eng.exportState(), sh = h.eng.shapes, cfg = h.cfg;
      const A = eachNamed(st.params, '.A'), Bn = eachNamed(st.params, '.B'), all = A.concat(Bn);
      const ev = (cfg.evalBatch && h.eng.evalLoss) ? await h.eng.evalLoss(cfg.evalBatch.ids, cfg.evalBatch.tgt) : null;
      return C.makeCheckpoint({
        step: h.step, epoch: h.cursor.epoch, cursor: Object.assign({}, h.cursor), rng: h.rng.snapshot(),
        optimizer: { kind: 'adam', lr: cfg.lr, betas: [0.9, 0.999], eps: 1e-8, wd: 0, step_count: st.t, schedule: { type: 'const' } },
        data_sha256: cfg.data_sha256 || 'none', compat: cfg.compat || { base: 'qwen3-0.6b-q8', base_sha256: 'unknown', rank: cfg.rank, alpha: cfg.alpha, target_modules: ['q', 'k', 'v', 'o', 'gate', 'up', 'down'], prompt_format_version: 1, tool_catalog_sha256: 'none' },
        loss_tail: h.lossTail.slice(), eval_check: ev ? { batch: 'eval', loss: ev.loss } : null, produced_by: produced,
        tensors: { 'lora_A.f32': T(st.params, sh, A), 'lora_B.f32': T(st.params, sh, Bn), 'opt_m.f32': T(st.m, sh, all), 'opt_v.f32': T(st.v, sh, all) },
      });
    },
    async loadCheckpoint(h, cp) {
      const v = C.verifyChecksums(cp); if (!v.ok) throw new Error('檢查點驗證失敗：' + v.bad.join('、'));
      const cc = C.checkCompat(cp.ckpt, { compat: h.cfg.compat || cp.ckpt.compat, data_sha256: h.cfg.data_sha256 || cp.ckpt.data_sha256, optimizer: { kind: 'adam' } });
      if (!cc.ok) { const e = new Error(cc.message); e.compat = cc; throw e; }
      const d = (f) => new Map(C.decodeTensors(cp.files[f]).map((t) => [t.name, t.data]));
      const a = d('lora_A.f32'), bb = d('lora_B.f32'), m = d('opt_m.f32'), vv = d('opt_v.f32'); const params = new Map([...a, ...bb]);
      h.eng.importState({ t: cp.ckpt.optimizer.step_count, params, m, v: vv });
      h.step = cp.ckpt.step; h.cursor = Object.assign({}, cp.ckpt.cursor); h.rng = C.PCG32.fromSnapshot(cp.ckpt.rng); h.lossTail = (cp.ckpt.loss_tail || []).slice();
    },
    async dispose(h) { h.disposed = true; if (h.eng && h.eng.dispose) await h.eng.dispose(); },
    peakMemBytes() { return (typeof performance !== 'undefined' && performance.memory) ? performance.memory.usedJSHeapSize : (typeof process !== 'undefined' && process.memoryUsage ? process.memoryUsage().rss : 0); },
  };
  return b;
}

module.exports = { createWasmWebBackend };
