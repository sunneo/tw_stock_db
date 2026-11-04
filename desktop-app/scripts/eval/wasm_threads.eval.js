// 原生推論執行器 第 0 步：量測 WASM 是否單執行緒（只讀，不改產品程式、不下載任何模型）。
// 記錄：crossOriginIsolated、navigator.hardwareConcurrency、typeof SharedArrayBuffer、
//       FaAudioRuntime.loadOrt() 之後實際的 ort.env.wasm.numThreads 與 proxy 設定、
//       工作者（Worker）內是否也 crossOriginIsolated、SharedArrayBuffer 是否可用。
// 用法：node scripts/eval/run_eval.js scripts/eval/wasm_threads.eval.js [埠]
const R = {};
R.location_protocol = location.protocol;
R.crossOriginIsolated = typeof crossOriginIsolated === 'undefined' ? 'undefined' : crossOriginIsolated;
R.hardwareConcurrency = navigator.hardwareConcurrency;
R.typeof_SharedArrayBuffer = typeof SharedArrayBuffer;
R.webgpu_available = !!navigator.gpu;

// 工作者內的隔離狀態（工作者繼承建立它的文件的隔離狀態，這裡實測確認）
try {
    const src = 'self.postMessage({ coi: typeof crossOriginIsolated === "undefined" ? "undefined" : crossOriginIsolated, sab: typeof SharedArrayBuffer });';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const w = new Worker(url);
    R.worker = await new Promise((resolve) => {
        const t = setTimeout(() => resolve({ error: 'timeout' }), 5000);
        w.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
        w.onerror = (e) => { clearTimeout(t); resolve({ error: String(e.message || 'onerror') }); };
    });
    w.terminate(); URL.revokeObjectURL(url);
} catch (e) { R.worker = { error: String((e && e.message) || e) }; }

// 載入 ORT 的 loadOrt（真的 onnxruntime-web 1.22.0，CDN 來源；若沒網路會記錄錯誤）
const loader = (typeof FaAudioRuntime !== 'undefined' && FaAudioRuntime) || null;
R.FaAudioRuntime_exposed = !!loader && typeof loader.loadOrt === 'function';
if (loader && loader.loadOrt) {
    try {
        const ortA = await loader.loadOrt({});
        R.loadOrt_default = {
            numThreads: ortA.env.wasm.numThreads,
            proxy: ortA.env.wasm.proxy,
            wasmPaths: ortA.env.wasm.wasmPaths,
            version: ortA.env && ortA.env.versions ? ortA.env.versions : null,
        };
        const ortB = await loader.loadOrt({ proxy: false });
        R.loadOrt_noProxy = { numThreads: ortB.env.wasm.numThreads, proxy: ortB.env.wasm.proxy };
    } catch (e) {
        R.loadOrt_error = String((e && e.message) || e);
    }
} else {
    R.loadOrt_error = 'FaAudioRuntime 不存在';
}

// 比對：ORT 的 numThreads 是否跟 crossOriginIsolated 一致（loadOrt 的規則：隔離才用執行緒）
R.note = '真量測值見上；推測項目（未直接量到）：numThreads 大於 1 才代表多執行緒 WASM 會被啟用。';
console.log('[eval-file] wasm_threads ' + JSON.stringify(R));
return R;
