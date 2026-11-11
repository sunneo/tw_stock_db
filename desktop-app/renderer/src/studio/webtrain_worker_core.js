'use strict';
/* 網頁版頁內訓練的 Worker 端邏輯（DESIGN.TODO.offline-training-studio.md §5.6）。純核心、依賴注入，能在 Node 測試也能在 Worker 內跑。
 *  做的事：取得基底模型（Qwen3-0.6B 的 q8 ONNX）→ 載入 onnxruntime-web → 用逐層引擎訓練；訓練資料的分詞與遮罩、檢查點（IndexedDB 專屬庫）、
 *  暫停／續訓／停止／匯出匯入、進度回報。
 *  基底權重來源（不新增託管）：和網頁版 AI 助理載入同一個模型（transformers.js 的瀏覽器快取 'transformers-cache' 裡的
 *  https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/main/onnx/model_quantized.onnx）；快取沒有才由使用者的瀏覽器向同一個網址下載（約 617MB，並寫回同一個快取，之後 AI 助理也能用）。
 *  找不到時回具體原因，不假裝。
 *  env 注入：importModule(url)、caches、indexedDB、fetch、now。 */
const Q = require('./qwen3_graph.js'), E = require('./qwen3_layered_engine.js'), SW = require('./swap_store.js'), BW = require('./backend_wasm_web.js'), WT = require('./web_train_core.js'), Asset = require('./asset_core.js');

const MODEL_REPO = 'onnx-community/Qwen3-0.6B-ONNX', MODEL_URL = 'https://huggingface.co/' + MODEL_REPO + '/resolve/main/onnx/model_quantized.onnx';
const ORT_VERSION = '1.22.0', ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VERSION + '/dist/ort.wasm.min.mjs', ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VERSION + '/dist/';
const TF_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5/+esm';
const CACHE_NAME = 'transformers-cache';
const mb = (x) => (x / 1048576).toFixed(0) + 'MB';

// 一筆資料 → {ids, tgt, mask}（長度固定 T；只對答案 token 算損失，提示部分與補齊的位置 mask=0；太長就保留尾端）
function layoutRow(promptIds, answerIds, T) {
  const all = promptIds.concat(answerIds); let input = all.slice(0, -1), tgt = all.slice(1), mask = tgt.map((_, i) => (i + 1 >= promptIds.length ? 1 : 0));
  if (input.length > T) { input = input.slice(-T); tgt = tgt.slice(-T); mask = mask.slice(-T); }
  while (input.length < T) { input.push(0); tgt.push(0); mask.push(0); }
  return { ids: input, tgt, mask };
}

function createWorkerHost(env) {
  const state = { phase: '', modelBytes: 0 }; let ort = null, model = null, tokP = null, svc = null, modelMeta = null;
  const ckptStore = SW.createIdbSwap({ indexedDB: env.indexedDB, quotaBytes: 2 * 1073741824, dbName: 'fa-train-ckpt' });
  const setPhase = (s) => { state.phase = s; };

  const openCache = async () => { try { return env.caches ? await env.caches.open(CACHE_NAME) : null; } catch (e) { return null; } };   // file:// 頁面等環境沒有可用的 Cache Storage 時回 null
  async function cachedModel() { try { const c = await openCache(); return !!(c && await c.match(MODEL_URL)); } catch (e) { return false; } }
  async function loadModelBytes(urlOverride) {
    if (model) return model;
    let bytes = null; const cache = await openCache(); const hit = cache ? await cache.match(MODEL_URL) : null;
    if (hit) { setPhase('讀取瀏覽器快取裡的 Qwen3 q8 模型'); bytes = new Uint8Array(await hit.arrayBuffer()); }
    else {
      setPhase('下載 Qwen3-0.6B q8 模型（約 617MB，來源與 AI 助理相同）');
      let res; try { res = await env.fetch(urlOverride || MODEL_URL); } catch (e) { throw new Error('下載失敗：' + String((e && e.message) || e)); }
      if (!res.ok) throw new Error('下載失敗：HTTP ' + res.status);
      const total = +res.headers.get('content-length') || 0; const rd = res.body && res.body.getReader ? res.body.getReader() : null;
      if (rd) { const chunks = []; let got = 0; for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(value); got += value.length; setPhase('下載 Qwen3 q8 模型 ' + mb(got) + (total ? ' / ' + mb(total) : '')); } bytes = new Uint8Array(got); let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.length; } }
      else bytes = new Uint8Array(await res.arrayBuffer());
      if (cache) { try { await cache.put(MODEL_URL, new Response(bytes)); } catch (e) { /* 快取寫不進去（配額）不影響這次訓練 */ } }
    }
    model = Q.openModel(bytes); state.modelBytes = bytes.length;
    let h = 2166136261; for (let i = 0; i < bytes.length; i += 4099) { h ^= bytes[i]; h = Math.imul(h, 16777619) >>> 0; }
    modelMeta = { base: 'Qwen/Qwen3-0.6B（' + MODEL_REPO + ' q8）', base_sha256: 'q8-' + bytes.length + '-' + h.toString(16) };
    return model;
  }
  async function loadOrt() { if (!ort) { setPhase('載入 onnxruntime-web ' + ORT_VERSION); ort = await env.importModule(ORT_URL); ort.env.wasm.wasmPaths = ORT_BASE; ort.env.wasm.numThreads = 1; } return ort; }
  let remoteHost = null;   // 測試掛鉤：分詞器檔案改從這個主機取（預設 huggingface.co）
  async function getTok() {
    if (!tokP) tokP = (async () => { setPhase('載入分詞器'); const tf = await env.importModule(TF_URL); tf.env.allowLocalModels = false; if (remoteHost) tf.env.remoteHost = remoteHost; return tf.AutoTokenizer.from_pretrained(MODEL_REPO); })();
    return tokP;
  }

  async function makeData(cfg) {
    const rows = cfg.rows || []; delete cfg.rows; const T = cfg.seqLen; const out = [];
    const fit = (r) => { let ids = r.ids.slice(-T), tgt = r.tgt.slice(-T), mask = (r.mask || r.ids.map(() => 1)).slice(-T); while (ids.length < T) { ids.push(0); tgt.push(0); mask.push(0); } return { ids, tgt, mask }; };
    if (rows.length && rows.every((r) => r && Array.isArray(r.ids) && Array.isArray(r.tgt))) rows.forEach((r) => out.push(fit(r)));      // 已經是 token 的資料（測試／匯入）
    else {
      const tok = await getTok(); setPhase('分詞 ' + rows.length + ' 筆');
      for (const r of rows) {
        const ans = r.completion !== undefined ? r.completion : (r.chosen !== undefined ? r.chosen : r.answer); if (!r.messages || ans === undefined) continue;
        const prompt = tok.apply_chat_template(r.messages, { tools: r.tools || undefined, add_generation_prompt: true, enable_thinking: false, tokenize: false }) + (r.prefill || '');
        const enc = (s) => { const x = tok.encode(s, { add_special_tokens: false }); return Array.from(x.input_ids ? x.input_ids : x).map(Number); };
        out.push(layoutRow(enc(prompt), enc(String(ans) + '<|im_end|>'), T));
      }
    }
    if (!out.length) throw new Error('資料裡沒有可用的列（需要 messages＋completion，或已分詞的 ids／tgt）');
    const sha = Asset.sha256Hex(new TextEncoder().encode(JSON.stringify(out.map((x) => [x.ids, x.tgt, x.mask]))));
    return { total: out.length, sha, batch: (i) => out[i % out.length] };
  }

  async function start(p) {
    if (svc) { const s = svc.status(); if (s.ok && (s.state === 'running' || s.state === 'pausing')) return { ok: false, error: '已有一個訓練在跑，請先暫停或停止' }; }
    const cfg = Object.assign({ seqLen: 64, rank: 8, steps: 100, lr: 0.001, swap: true }, p.cfg || {}); cfg.alpha = 2 * cfg.rank; cfg.rows = p.rows;
    if (p.testHooks && p.testHooks.remoteHost) remoteHost = p.testHooks.remoteHost;
    let M; try { M = await loadModelBytes(p.testHooks && p.testHooks.modelUrl); } catch (e) { setPhase(''); return { ok: false, error: '找不到可用的 Qwen3-0.6B q8 模型：' + String((e && e.message) || e) + '。網頁版訓練使用 AI 助理載入的同一個模型來源（' + MODEL_URL + '）；請先到 AI 助理載入 Qwen3 0.6B 一次，或檢查網路後重試' }; }
    let O; try { O = await loadOrt(); } catch (e) { setPhase(''); return { ok: false, error: '無法載入 onnxruntime-web（' + ORT_URL + '）：' + String((e && e.message) || e) }; }
    cfg.compat = { base: modelMeta.base, base_sha256: modelMeta.base_sha256, rank: cfg.rank, alpha: cfg.alpha, target_modules: ['q', 'k', 'v', 'o', 'gate', 'up', 'down'], prompt_format_version: 1, tool_catalog_sha256: 'none' };
    const layerStore = cfg.swap ? SW.createIdbSwap({ indexedDB: env.indexedDB, quotaBytes: 3 * 1073741824, dbName: 'fa-train-swap' }) : null;
    const backend = BW.createWasmWebBackend({ engineFactory: async (c) => {
      const eng = new E.LayeredEngine({ ort: O, ep: 'wasm', M, T: c.seqLen, rank: c.rank, layers: 28, lr: c.lr, keepSessions: !layerStore, headChunks: 8,
        layerSource: layerStore ? SW.createSwapLayerSource(layerStore, async (kind, l) => { const G = require('./onnx_grad_core.js'); const b = kind === 'F' ? Q.buildLayerF(M, l, c.seqLen, c.rank) : kind === 'B' ? Q.buildLayerB(M, l, c.seqLen, c.rank) : Q.buildHead(M, c.seqLen, { headChunks: 8 }); return G.toOnnx(b.g, { name: kind + l }); }, 'k:' + modelMeta.base_sha256 + ':' + c.seqLen + ':' + c.rank + ':') : null });
      eng.initParams(null, c.seed || 7); return eng;
    } });
    svc = WT.createWebTrainService({ backend, store: ckptStore, makeData, yieldFn: () => new Promise((r) => setTimeout(r, 0)) });
    setPhase('準備訓練'); const r = await svc.start({ name: p.name, cfg, resume: !!p.resume }); if (!r.ok) setPhase(''); else setPhase('訓練中');
    return r;
  }

  const api = {
    async probe() {
      if (typeof WebAssembly !== 'object') return { available: false, reason: '這個瀏覽器沒有 WebAssembly', device: { name: '' }, fingerprint: { backend: 'wasm-web' } };
      const cached = await cachedModel();
      return { available: true, reason: '', device: { name: 'WebAssembly 處理器（onnxruntime-web ' + ORT_VERSION + '，逐層訓練）', vendor: 'wasm', fp16: false }, fingerprint: { backend: 'wasm-web', ort: ORT_VERSION }, note: cached ? '基底模型已在瀏覽器快取' : '基底模型（約 617MB）還沒有在瀏覽器快取；開始訓練時會向 ' + MODEL_URL + ' 下載' };
    },
    start,
    status(p) { if (!svc) return { ok: true, state: 'idle', phase: state.phase }; const s = svc.status(p && p.jobId); if (s.ok) s.phase = (s.engPhase ? s.engPhase + '　' : '') + state.phase; return s; },
    async pause(p) { if (!svc) return { ok: false, error: '沒有訓練工作' }; return svc.pause(p && p.jobId); },
    async stop(p) { if (!svc) return { ok: true }; return svc.stop(p && p.jobId); },
    async exportCheckpoint(p) { const s = svc || WT.createWebTrainService({ backend: null, store: ckptStore, makeData: null }); return s.exportCheckpoint(p.name); },
    async importCheckpoint(p) { const s = svc || WT.createWebTrainService({ backend: null, store: ckptStore, makeData: null }); return s.importCheckpoint(p.bytes, p.name); },
  };
  return { handle: async (op, p) => { if (!api[op]) throw new Error('未知操作 ' + op); return api[op](p || {}); }, layoutRow, state };
}

module.exports = { createWorkerHost, layoutRow, MODEL_URL, MODEL_REPO, ORT_URL };
