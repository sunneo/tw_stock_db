// 音訊轉 MIDI 的模型執行層:用 onnxruntime-web 載入 Basic Pitch、YAMNet、Demucs 6 軌,包成流程要的三個可插拔函式。
// 執行環境三條路:webgpu(有就用,失敗自動退)→ wasm(多執行緒需要跨來源隔離,沒有就單執行緒)→ 都失敗就回報,流程退回規則做法。
// 張量形狀、輸出順序都是 2026-11-01 用 onnxruntime 實測(Basic Pitch、YAMNet)或依模型卡(Demucs)。
// 階段三:Basic Pitch 高低音分開跑(MIDI 55 以上用 200 Hz 高通後的版本轉,其餘用原混音轉);Demucs 可接任意長度的一段(內部切成模型長度的小段,各留 0.5 秒邊界)。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./audio_pipeline.js'), require('./basic_pitch.js'), require('./instrument_classify.js'), require('./note_postprocess.js'), require('./audio_dsp.js')); else root.FaAudioRuntime = factory(root.FaAudioPipeline || (typeof FaAudioPipeline !== 'undefined' ? FaAudioPipeline : undefined), root.FaBasicPitch || (typeof FaBasicPitch !== 'undefined' ? FaBasicPitch : undefined), root.FaInstrumentClassify || (typeof FaInstrumentClassify !== 'undefined' ? FaInstrumentClassify : undefined), root.FaNotePost || (typeof FaNotePost !== 'undefined' ? FaNotePost : undefined), root.FaAudioDsp || (typeof FaAudioDsp !== 'undefined' ? FaAudioDsp : undefined)); })(typeof self !== 'undefined' ? self : this, function (P, BP, IC, NP, DSP) {
  'use strict';
  const ORT_VERSION = '1.22.0', ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VERSION + '/dist/ort.webgpu.min.mjs', ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VERSION + '/dist/';
  const SEG = 343980, DSR = 44100, STEMS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];
  const SPLIT_MIDI = 55;     // 高低音分界:MIDI 55(G3)以上由高通版本轉出;54 以下是低音。邊界 55 歸高音
  const DEMUCS_MARGIN = 0.5; // Demucs 每一小段兩側各多給的秒數,核心段才取用
  // 同一個網址 import 只會得到同一個 ort 實例,env.wasm.proxy 是實例全域的:proxy 開著(音訊模型)和關著(midigenai GPU 版要 preferredOutputLocation)互相切換會讓已初始化的 wasm 後端壞掉(worker not ready)。
  // 所以兩種模式用不同網址查詢字串各拿一個獨立實例,各自設定一次後快取,不再互相改。
  const _ortCache = {};
  async function importOrt(url, proxy, imp) { const u = proxy ? url : url + (url.indexOf('?') < 0 ? '?' : '&') + 'np=1'; if (!_ortCache[u]) _ortCache[u] = (imp ? Promise.resolve().then(() => imp(u)) : import(u)).catch((e) => { delete _ortCache[u]; throw e; }); return _ortCache[u]; }
  // 執行緒數：與文字／看圖路徑（floating-assistant.js 的 _omThreadSupport）同一條規則——SharedArrayBuffer 存在、能傳給 Worker、WebAssembly 執行緒指令驗證通過就用，不要求 crossOriginIsolated。
  // 桌面版實測（scripts/eval/native_threads_baseline.eval.js）：頁面 crossOriginIsolated 為 false，但 postMessage(SharedArrayBuffer) 成功，文字路徑 resolveThreads 為 4。
  function ortThreadCount() {
    let ok = false;
    try {
      if (typeof SharedArrayBuffer !== 'undefined') { new MessageChannel().port1.postMessage(new SharedArrayBuffer(1)); ok = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 1, 10, 11, 1, 9, 0, 65, 0, 254, 16, 2, 0, 26, 11])); }
    } catch (_) { ok = false; }
    return ok ? Math.min(4, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2)) : 1;
  }
  async function loadOrt(opts) { opts = opts || {}; const proxy = opts.proxy !== false; const ort = opts.ort || await importOrt(opts.ortUrl || ORT_URL, proxy, opts.importFn); ort.env.wasm.wasmPaths = opts.wasmBase || ORT_BASE; ort.env.wasm.proxy = proxy; ort.env.wasm.numThreads = ortThreadCount(); return ort; }
  // 建立工作階段:依序試 eps(預設 webgpu、wasm),回傳 { session, ep, tried }
  async function createSession(ort, bytes, eps, opts) { const tried = []; const list = eps || ['webgpu', 'wasm']; /* 多種執行方式時每次給一份副本:proxy 模式建 session 會把傳入的緩衝轉移掉(detached),失敗後換下一種就沒資料了 */ for (const ep of list) { try { if (ep === 'webgpu' && !(typeof navigator !== 'undefined' && navigator.gpu)) throw new Error('沒有 WebGPU'); const session = await ort.InferenceSession.create(list.length > 1 && bytes && bytes.slice ? bytes.slice(0) : bytes, { executionProviders: [ep], graphOptimizationLevel: (opts && opts.opt) || 'all' }); return { session, ep, tried }; } catch (e) { tried.push(ep + ':' + (e && e.message || e)); } } throw new Error('所有執行方式都失敗:' + tried.join(';')); }

  // Basic Pitch 轉譜:一次整段跑(視窗切好、解碼、併回假切、最短音);高低音分開跑時 runOne 會被呼叫兩次
  function makeTranscriber(ort, session, onFrame) {
    const name = session.inputNames[0];
    async function runOne(mono, sr) {
      const x = P.resample(mono, sr, BP.SR), ws = BP.windows(x), res = [];
      for (let i = 0; i < ws.length; i++) { const out = await session.run({ [name]: new ort.Tensor('float32', ws[i], [1, BP.WIN, 1]) }); const o = session.outputNames; res.push({ onset: out[o[0]].data, note: out[o[1]].data }); if (onFrame) onFrame(i + 1, ws.length); }
      const st = BP.stitch(res, x.length); let notes = BP.decode(st, { minFrames: 4 });
      if (NP) { const evAt = NP.evidenceFromActivations(st); notes = NP.enforceMinLength(NP.joinSplitNotes(notes, evAt), evAt); }
      return notes;
    }
    const split = !!DSP;
    const fn = async function (mono, sr) {
      const low = await runOne(mono, sr);
      let notes = low;
      if (split) { const high = await runOne(DSP.highpass(mono, sr, DSP.HP_FC), sr); notes = low.filter((n) => n.n < SPLIT_MIDI).concat(high.filter((n) => n.n >= SPLIT_MIDI)).sort((a, b) => a.t - b.t || a.n - b.n); }
      return notes.map((n) => ({ t: n.t, d: n.d, n: n.n, v: n.v }));
    };
    fn.methods = split ? ['＋高低音分跑'] : [];
    return fn;
  }
  function makeClassifier(ort, session) {
    return async function (mono16k) { const out = await session.run({ waveform: new ort.Tensor('float32', mono16k, [mono16k.length]) }); const sc = out[session.outputNames[0]]; const r = IC.pick(sc.data, sc.dims[0]); return r && r.confident ? r.label : null; };
  }
  // Demucs 分軌:模型一次只吃 SEG 長(約 7.8 秒)。這裡把任意長度切成核心段(SEG 扣掉兩側邊界),每段多給 DEMUCS_MARGIN 秒當邊界,只取核心部分接起來。
  function makeSeparator(ort, session) {
    const CORE_SEC = SEG / DSR - 2 * DEMUCS_MARGIN;
    async function runWindow(Lw, Rw) {
      const buf = new Float32Array(2 * SEG);
      buf.set(Lw.subarray(0, Math.min(SEG, Lw.length)), 0); buf.set(Rw.subarray(0, Math.min(SEG, Rw.length)), SEG);
      const out = await session.run({ mix: new ort.Tensor('float32', buf, [1, 2, SEG]) }); return out[session.outputNames[0]].data;
    }
    const f = async function (c) {
      const n = c.left.length, sr = c.sr, R0 = c.right || c.left, res = {}; STEMS.forEach((s) => { res[s] = new Float32Array(n); });
      const core = Math.max(1, Math.round(CORE_SEC * sr)), m = Math.round(DEMUCS_MARGIN * sr);
      for (let p0 = 0; p0 < n; p0 += core) {
        const p1 = Math.min(n, p0 + core), w0 = Math.max(0, p0 - m), w1 = Math.min(n, p1 + m);
        const Lw = P.resample(c.left.subarray(w0, w1), sr, DSR), Rw = P.resample(R0.subarray(w0, w1), sr, DSR);
        const d = await runWindow(Lw, Rw), len = Math.min(SEG, Lw.length);
        STEMS.forEach((s, k) => {
          const mm = new Float32Array(len); for (let i = 0; i < len; i++) mm[i] = 0.5 * (d[(k * 2) * SEG + i] + d[(k * 2 + 1) * SEG + i]);
          const back = P.resample(mm, DSR, sr), off = p0 - w0;
          for (let i = 0; i < p1 - p0; i++) { const src = Math.min(back.length - 1, off + i); res[s][p0 + i] = src >= 0 ? back[src] : 0; }
        });
      }
      return res;
    };
    f.segmentSec = CORE_SEC; return f;
  }
  const DEMUCS_OPT = 'disabled'; // 實測:Demucs 圖形最佳化會讓 wasm 與 webgpu 建立工作階段失敗,關掉最佳化 wasm 才載得起來
  return { DEMUCS_OPT, ORT_VERSION, ORT_URL, SEG, STEMS, SPLIT_MIDI, loadOrt, createSession, makeTranscriber, makeClassifier, makeSeparator };
});
