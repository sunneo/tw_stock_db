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
    return { state, installFromStore, open };
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
  return { create, withFallback, Tensor, toB64, fromB64, TYPED };
});
