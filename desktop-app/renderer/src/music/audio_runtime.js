// 音訊轉 MIDI 的模型執行層:用 onnxruntime-web 載入 Basic Pitch、YAMNet、Demucs 6 軌,包成流程要的三個可插拔函式。
// 執行環境三條路:webgpu(有就用,失敗自動退)→ wasm(多執行緒需要跨來源隔離,沒有就單執行緒)→ 都失敗就回報,流程退回規則做法。
// 張量形狀、輸出順序都是 2026-11-01 用 onnxruntime 實測(Basic Pitch、YAMNet)或依模型卡(Demucs)。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./audio_pipeline.js'), require('./basic_pitch.js'), require('./instrument_classify.js')); else root.FaAudioRuntime = factory(root.FaAudioPipeline || (typeof FaAudioPipeline !== 'undefined' ? FaAudioPipeline : undefined), root.FaBasicPitch || (typeof FaBasicPitch !== 'undefined' ? FaBasicPitch : undefined), root.FaInstrumentClassify || (typeof FaInstrumentClassify !== 'undefined' ? FaInstrumentClassify : undefined)); })(typeof self !== 'undefined' ? self : this, function (P, BP, IC) {
  'use strict';
  const ORT_VERSION = '1.22.0', ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VERSION + '/dist/ort.webgpu.min.mjs', ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VERSION + '/dist/';
  const SEG = 343980, DSR = 44100, STEMS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];
  // 同一個網址 import 只會得到同一個 ort 實例,env.wasm.proxy 是實例全域的:proxy 開著(音訊模型)和關著(midigenai GPU 版要 preferredOutputLocation)互相切換會讓已初始化的 wasm 後端壞掉(worker not ready)。
  // 所以兩種模式用不同網址查詢字串各拿一個獨立實例,各自設定一次後快取,不再互相改。
  const _ortCache = {};
  async function importOrt(url, proxy, imp) { const u = proxy ? url : url + (url.indexOf('?') < 0 ? '?' : '&') + 'np=1'; if (!_ortCache[u]) _ortCache[u] = (imp ? Promise.resolve().then(() => imp(u)) : import(u)).catch((e) => { delete _ortCache[u]; throw e; }); return _ortCache[u]; }
  async function loadOrt(opts) { opts = opts || {}; const proxy = opts.proxy !== false; const ort = opts.ort || await importOrt(opts.ortUrl || ORT_URL, proxy, opts.importFn); ort.env.wasm.wasmPaths = opts.wasmBase || ORT_BASE; ort.env.wasm.proxy = proxy; ort.env.wasm.numThreads = (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) ? Math.min(4, (navigator.hardwareConcurrency || 2)) : 1; return ort; }
  // 建立工作階段:依序試 eps(預設 webgpu、wasm),回傳 { session, ep, tried }
  async function createSession(ort, bytes, eps, opts) { const tried = []; const list = eps || ['webgpu', 'wasm']; /* 多種執行方式時每次給一份副本:proxy 模式建 session 會把傳入的緩衝轉移掉(detached),失敗後換下一種就沒資料了 */ for (const ep of list) { try { if (ep === 'webgpu' && !(typeof navigator !== 'undefined' && navigator.gpu)) throw new Error('沒有 WebGPU'); const session = await ort.InferenceSession.create(list.length > 1 && bytes && bytes.slice ? bytes.slice(0) : bytes, { executionProviders: [ep], graphOptimizationLevel: (opts && opts.opt) || 'all' }); return { session, ep, tried }; } catch (e) { tried.push(ep + ':' + (e && e.message || e)); } } throw new Error('所有執行方式都失敗:' + tried.join(';')); }
  function makeTranscriber(ort, session, onFrame) {
    const name = session.inputNames[0];
    return async function (mono, sr) { const x = P.resample(mono, sr, BP.SR), ws = BP.windows(x), res = []; for (let i = 0; i < ws.length; i++) { const out = await session.run({ [name]: new ort.Tensor('float32', ws[i], [1, BP.WIN, 1]) }); const o = session.outputNames; res.push({ onset: out[o[0]].data, note: out[o[1]].data }); if (onFrame) onFrame(i + 1, ws.length); } return BP.decode(BP.stitch(res, x.length)).map((n) => ({ t: n.t, d: n.d, n: n.n, v: n.v })); };
  }
  function makeClassifier(ort, session) {
    return async function (mono16k) { const out = await session.run({ waveform: new ort.Tensor('float32', mono16k, [mono16k.length]) }); const sc = out[session.outputNames[0]]; const r = IC.pick(sc.data, sc.dims[0]); return r && r.confident ? r.label : null; };
  }
  function makeSeparator(ort, session) {
    const f = async function (c) {
      const n = c.left.length, L = P.resample(c.left, c.sr, DSR), R = c.right ? P.resample(c.right, c.sr, DSR) : L, buf = new Float32Array(2 * SEG);
      buf.set(L.subarray(0, Math.min(SEG, L.length)), 0); buf.set(R.subarray(0, Math.min(SEG, R.length)), SEG);
      const out = await session.run({ mix: new ort.Tensor('float32', buf, [1, 2, SEG]) }), d = out[session.outputNames[0]].data, res = {};
      STEMS.forEach((s, k) => { const m = new Float32Array(Math.min(SEG, L.length)); for (let i = 0; i < m.length; i++) m[i] = 0.5 * (d[(k * 2) * SEG + i] + d[(k * 2 + 1) * SEG + i]); const back = P.resample(m, DSR, c.sr); const o = new Float32Array(n); o.set(back.subarray(0, Math.min(n, back.length))); res[s] = o; });
      return res;
    };
    f.segmentSec = SEG / DSR; return f;
  }
  const DEMUCS_OPT = 'disabled'; // 實測:Demucs 圖形最佳化會讓 wasm 與 webgpu 建立工作階段失敗,關掉最佳化 wasm 才載得起來
  return { DEMUCS_OPT, ORT_VERSION, ORT_URL, SEG, STEMS, loadOrt, createSession, makeTranscriber, makeClassifier, makeSeparator };
});
