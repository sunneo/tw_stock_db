// 原生 ONNX 工作階段（桌面版）：把「onnxruntime-node 子程序（main-ext.js 的 NRT）」包成跟 onnxruntime-web 的 InferenceSession 同介面的物件
// （inputNames、outputNames、run(feeds)→{名稱:{data,dims,type}}），這樣 audio_runtime.js 的 makeTranscriber／makeClassifier／makeSeparator 不用改。
// 控制訊息與張量都走主程序的信箱（見 floating-assistant.js 的 _nrCall）：張量寫成 <信箱>/t-<編號>/ 下的原始二進位檔，用完就刪。
// 純邏輯（UMD）：依賴全部由呼叫端傳入（call、rawfs、box、sep），所以能用假的橋接做單元測試。
// 失敗不靜默：run 失敗時 withFallback 會切到呼叫端給的網頁版（WASM）工作階段並回報原因（backend、lastError），結果格式不變。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaNativeOrt = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TYPED = { float32: Float32Array, float64: Float64Array, int32: Int32Array, int64: BigInt64Array, uint8: Uint8Array };
  class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
  function toB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function fromB64(b64) { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  const pad = (i) => String(i).padStart(5, '0');
  const msgOf = (e) => String((e && e.message) || e);

  // deps：{ call(op, payload, timeoutMs) → {ok, ...}, rawfs（readFile(path,'base64')、writeFile(path,{base64})、remove(path,recursive)）, box（信箱資料夾）, sep（路徑分隔字元）, uid() → 字串 }
  function create(deps) {
    const { call, rawfs, box, sep } = deps; const uid = deps.uid || (() => Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    // 原生能不能用（執行包有沒有、模型檔裝好沒）。entry：{ id, file, bytes, sha256 }。回傳 { ok, installed, reason }
    async function state(entry) {
      const r = await call('onnx_status', { id: entry.id, file: entry.file, bytes: entry.bytes, sha256: entry.sha256 }, 8000);
      if (!r || !r.ok) return { ok: false, installed: false, reason: '原生執行器：' + ((r && (r.message || r.code)) || '沒有回應') };
      return { ok: true, installed: !!r.installed, reason: '' };
    }
    // 把 IndexedDB 裡已下載好的分片（FaAudioModels 的 model:<id>:<sha8>:<i>）依序寫到信箱，請主程序串接、核對大小與 SHA-256、放進 native-models。一次只讀一片，不把整個檔放進記憶體。
    async function installFromStore(entry, o) {
      const chunk = o.chunk, n = Math.ceil(entry.bytes / chunk), dir = box + sep + 'models-in' + sep + entry.id, parts = [];
      for (let i = 0; i < n; i++) {
        const want = Math.min(entry.bytes, (i + 1) * chunk) - i * chunk, c = await o.store.get(o.keyOf(i));
        if (!c || c.length !== want) throw new Error('瀏覽器裡的模型分片 ' + (i + 1) + '/' + n + ' 不完整（' + (c ? c.length : 0) + ' / ' + want + ' 位元組）');
        await rawfs.writeFile(dir + sep + pad(i) + '.part', { base64: toB64(c) }); parts.push(pad(i) + '.part');
        if (o.onProgress) o.onProgress({ done: Math.min(entry.bytes, (i + 1) * chunk), total: entry.bytes });
      }
      const r = await call('onnx_install', { id: entry.id, file: entry.file, bytes: entry.bytes, sha256: entry.sha256, parts }, 600000);
      if (!r || !r.ok) throw new Error('原生模型安裝失敗：' + ((r && (r.message || r.code)) || '沒有回應'));
      return r;
    }
    // 把一個 Blob（例如瀏覽器快取裡 transformers.js 已經下載好的模型檔）依序切片寫到信箱，請主程序串接放進 native-models。不下載、不重複佔記憶體（一次一片）。
    async function installFromBlob(entry, blob, o) {
      o = o || {}; const chunk = o.chunk || 8 * 1048576, n = Math.ceil(blob.size / chunk), dir = box + sep + 'models-in' + sep + entry.id, parts = [];
      if (entry.bytes && blob.size !== entry.bytes) throw new Error('模型檔大小不符：' + blob.size + ' / ' + entry.bytes);
      for (let i = 0; i < n; i++) {
        const u8 = new Uint8Array(await blob.slice(i * chunk, Math.min(blob.size, (i + 1) * chunk)).arrayBuffer());
        await rawfs.writeFile(dir + sep + pad(i) + '.part', { base64: toB64(u8) }); parts.push(pad(i) + '.part');
        if (o.onProgress) o.onProgress({ done: Math.min(blob.size, (i + 1) * chunk), total: blob.size });
      }
      const r = await call('onnx_install', { id: entry.id, file: entry.file, bytes: blob.size, sha256: entry.sha256, parts }, 600000);
      if (!r || !r.ok) throw new Error('原生模型安裝失敗：' + ((r && (r.message || r.code)) || '沒有回應'));
      return r;
    }
    // 載入並回傳 session。opts：{ threads, graphOpt, timeoutMs }
    async function open(entry, opts) {
      opts = opts || {};
      const L = await call('onnx_load', { id: entry.id, file: entry.file, bytes: entry.bytes, sha256: entry.sha256, threads: opts.threads || 4, graph_opt: opts.graphOpt || 'all' }, opts.loadTimeoutMs || 180000);
      if (!L || !L.ok) { const e = new Error((L && (L.message || L.code)) || '沒有回應'); e.code = (L && L.code) || 'internal'; throw e; }
      const session = {
        inputNames: L.input_names, outputNames: L.output_names, backend: 'native', loadMs: L.ms,
        async run(feeds) {
          // 小張量（輸入合計不到 6 MB）直接放在請求裡、輸出也直接放在回應裡（少幾次檔案讀寫與行程間通訊，每窗一次呼叫的小模型才不會被固定成本吃掉）；大張量才寫成檔
          const tStart = Date.now(), names = Object.keys(feeds); let bytes = 0;
          for (const name of names) { const t = feeds[name], C = TYPED[t.type]; if (!C || !(t.data instanceof C)) throw new Error('輸入 ' + name + ' 的型別不支援或與 dtype 不符：' + t.type); bytes += t.data.byteLength; }
          const small = bytes <= 6 * 1048576, dirName = small ? '' : 't-' + uid(), dir = box + sep + dirName, inputs = [], timeout = opts.runTimeoutMs || 120000;
          try {
            let i = 0;
            for (const name of names) {
              const t = feeds[name], u8 = new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength);
              if (small) inputs.push({ name, dtype: t.type, dims: Array.from(t.dims), b64: toB64(u8) });
              else { const file = 'in-' + (i++) + '.bin'; await rawfs.writeFile(dir + sep + file, { base64: toB64(u8) }); inputs.push({ name, dtype: t.type, dims: Array.from(t.dims), file }); }
            }
            const payload = { id: entry.id, inputs, timeout_ms: timeout }; if (small) payload.inline_out = true; else payload.dir = dirName;
            const tCall = Date.now(); const r = await call('onnx_run', payload, timeout + 15000);
            session.lastRun = { childMs: r && r.ms, callMs: Date.now() - tCall, prepMs: tCall - tStart };
            if (!r || !r.ok) { const e = new Error((r && (r.message || r.code)) || '沒有回應'); e.code = (r && r.code) || 'internal'; throw e; }
            const out = {};
            for (const o of r.outputs) {
              const C = TYPED[o.dtype]; if (!C) throw new Error('輸出 ' + o.name + ' 的型別不支援：' + o.dtype);
              let b64 = o.b64; if (b64 === undefined) { const rd = await rawfs.readFile((r.dir ? box + sep + r.dir : dir) + sep + o.file, 'base64'); b64 = rd.base64 !== undefined ? rd.base64 : rd; }
              const u = fromB64(b64);
              if (u.length !== o.bytes) throw new Error('輸出 ' + o.name + ' 位元組數不符：' + u.length + ' / ' + o.bytes);
              out[o.name] = new Tensor(o.dtype, new C(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength)), o.dims);
            }
            return out;
          } finally { if (!small) { try { await rawfs.remove(dir, true); } catch (_) { /* 暫存資料夾刪不掉不影響結果 */ } } }
        },
        async release() { try { await call('onnx_release', { id: entry.id }, 8000); } catch (_) { /* 已結束 */ } },
      };
      return session;
    }
    return { state, installFromStore, installFromBlob, open };
  }

  // 原生優先、失敗退回：native 是 open() 回傳的 session；fallbackFactory() → Promise<{ session, ort }>（網頁版 WASM，晚點才建）。
  // run 第一次失敗就記下原因、永久切到退路（不在兩者之間來回），結果格式（{名稱:{data,dims}}）不變。onEvent({ type:'fallback', reason })。
  function withFallback(native, fallbackFactory, onEvent) {
    let fb = null, mode = 'native', lastError = '';
    const s = {
      inputNames: native.inputNames, outputNames: native.outputNames,
      get backend() { return mode === 'native' ? 'native' : 'wasm'; }, get lastError() { return lastError; }, get lastRun() { return native.lastRun; },
      async run(feeds) {
        if (mode === 'native') {
          try { return await native.run(feeds); }
          catch (e) { lastError = msgOf(e); mode = 'fallback'; if (onEvent) onEvent({ type: 'fallback', reason: lastError }); try { await native.release(); } catch (_) { /* */ } }
        }
        if (!fb) { try { fb = await fallbackFactory(); } catch (e) { throw new Error('原生失敗（' + lastError + '），退回網頁版也失敗：' + msgOf(e)); } }
        const f2 = {}; for (const k of Object.keys(feeds)) { const t = feeds[k]; f2[k] = new fb.ort.Tensor(t.type, t.data, t.dims); }
        return fb.session.run(f2);
      },
      async release() { try { await native.release(); } catch (_) { /* */ } if (fb && fb.session && fb.session.release) { try { await fb.session.release(); } catch (_) { /* */ } } },
    };
    return s;
  }
  // ---- 深度估計（Depth Anything V2 Small）的前後處理：跟 transformers.js 的 DPTImageProcessor 同一套規則（preprocessor_config：短邊對到 518、保持長寬比、取 14 的倍數、
  // 縮放用雙三次、值除以 255 再用 ImageNet 平均與標準差正規化）。縮放本身用瀏覽器畫布（跟 transformers.js 在瀏覽器裡做的一樣），所以像素值會有細微差別。
  const depth = (function () {
    const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225], MULT = 14, SIZE = 518;
    const constrain = (val) => Math.round(val / MULT) * MULT;
    // 原圖寬高 → 模型輸入寬高。scale 取離 1 較近的那一個，兩邊共用（保持長寬比）
    function targetSize(srcW, srcH) {
      let sh = SIZE / srcH, sw = SIZE / srcW;
      if (Math.abs(1 - sw) < Math.abs(1 - sh)) sh = sw; else sw = sh;
      return { w: Math.max(MULT, constrain(sw * srcW)), h: Math.max(MULT, constrain(sh * srcH)) };
    }
    // RGBA（已縮到目標尺寸）→ Float32 NCHW 正規化
    function toChw(rgba, w, h) {
      const out = new Float32Array(3 * w * h), plane = w * h;
      for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) out[c * plane + i] = (rgba[i * 4 + c] / 255 - MEAN[c]) / STD[c];
      return out;
    }
    // 雙線性縮放（半像素中心、邊界夾住，與 PyTorch 的 align_corners=False 相同）：transformers.js 的深度管線會把模型輸出縮回原圖大小，網頁版 Worker 回傳的就是縮回後的
    function resizeBilinear(src, sw, sh, dw, dh) {
      if (sw === dw && sh === dh) return Float32Array.from(src);
      const out = new Float32Array(dw * dh), xs = sw / dw, ys = sh / dh;
      for (let y = 0; y < dh; y++) {
        let fy = (y + 0.5) * ys - 0.5; if (fy < 0) fy = 0; const y0 = Math.min(sh - 1, Math.floor(fy)), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
        for (let x = 0; x < dw; x++) {
          let fx = (x + 0.5) * xs - 0.5; if (fx < 0) fx = 0; const x0 = Math.min(sw - 1, Math.floor(fx)), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
          out[y * dw + x] = (src[y0 * sw + x0] * (1 - wx) + src[y0 * sw + x1] * wx) * (1 - wy) + (src[y1 * sw + x0] * (1 - wx) + src[y1 * sw + x1] * wx) * wy;
        }
      }
      return out;
    }
    // deps：{ decode(blob) → { width, height, close() }, resize(img, w, h) → RGBA Uint8ClampedArray }。回傳跟網頁版 Worker 相同形狀 { w, h, data, srcW, srcH }
    async function estimate(blob, session, deps) {
      const img = await deps.decode(blob);
      try {
        const t = targetSize(img.width, img.height), rgba = deps.resize(img, t.w, t.h), name = session.inputNames[0];
        const out = await session.run({ [name]: new Tensor('float32', toChw(rgba, t.w, t.h), [1, 3, t.h, t.w]) });
        const o = out[session.outputNames[0]], d = o.dims, h = d[d.length - 2], w = d[d.length - 1];
        return { w: img.width, h: img.height, data: resizeBilinear(o.data, w, h, img.width, img.height), srcW: img.width, srcH: img.height };
      } finally { if (img.close) img.close(); }
    }
    return { targetSize, toChw, resizeBilinear, estimate, MEAN, STD };
  })();
  // ---- 逐模型的原生註冊表（部分原生）：只有「已實作並驗證」的模型才列在這裡，才會走原生；不在表裡的模型一律維持舊做法（瀏覽器端／WASM），不報錯、不影響其他功能。
  // 每個模型另有開關（localStorage 的 fa.native.model.<id>，'0'＝關；預設開）。核心的聊天／呼叫工具／食譜的原生（qwen3-0.6b）有自己的路徑與判斷，不經過這張表。
  // 新增模型的規則：實作並用真 Electron 驗證（含退回）之後，才把它加進這張表。
  const REGISTRY = {
    'basic-pitch': { kind: 'audio', verified: '2026-11-05' },
    'yamnet': { kind: 'audio', verified: '2026-11-05' },
    'demucs-6s': { kind: 'audio', verified: '2026-11-05' },
    'depth-anything-v2-small': { kind: 'depth', verified: '2026-11-05' },
  };
  const switchKey = (id) => 'fa.native.model.' + id;
  // getFlag(key) → 字串或 null（呼叫端傳 localStorage 讀取；讀不到就當沒設定＝開）。回傳 { native, why }
  function routed(id, getFlag) {
    if (!Object.prototype.hasOwnProperty.call(REGISTRY, id)) return { native: false, why: '這個模型還沒有原生實作，維持舊做法' };
    let f = null; try { f = getFlag ? getFlag(switchKey(id)) : null; } catch (_) { f = null; }
    return f === '0' ? { native: false, why: '這個模型的原生開關被關閉' } : { native: true, why: '' };
  }
  return { create, withFallback, Tensor, toB64, fromB64, TYPED, depth, REGISTRY, routed, switchKey };
});
