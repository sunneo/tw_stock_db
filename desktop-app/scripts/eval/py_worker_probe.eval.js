// 用法：同 gui_bridge.eval.js（FA_DEBUG_EVAL_FILE、獨立 --user-data-dir、換埠、FA_DISABLE_MAIN_OVERLAY=1）。
// 實測：Pyodide 能不能在 Blob worker 裡用 importScripts 載入並執行 Python；worker 內用的網址與頁面相同（FA_ASSET_URLS.pyodideJsBase）。
const base = FA_ASSET_URLS.pyodideJsBase;
const R = { base, sab: typeof SharedArrayBuffer, crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : null };
const workerSrc = `
  self.onmessage = async () => {
    try {
      const { loadPyodide } = await import(${JSON.stringify(base)} + 'pyodide.mjs');
      const py = await loadPyodide({ indexURL: ${JSON.stringify(base)} });
      const v = py.runPython('1 + 1');
      // JSPI 實測：同步的 Python 呼叫非同步的 JS（等 Promise）是否可行
      const jspi = typeof WebAssembly.Suspending === 'function';
      self.slow_js = async (x) => { await new Promise((r) => setTimeout(r, 300)); return x * 2; };
      let syncAsync;
      try {
        py.runPython('from pyodide.ffi import run_sync\\nfrom js import slow_js\\ndef go():\\n    return str(run_sync(slow_js(21)))');
        const go = py.globals.get('go');
        syncAsync = String(await go.callPromising());
        go.destroy();
      } catch (e) { syncAsync = 'ERR: ' + String((e && e.message) || e); }
      postMessage({ ok: true, value: String(v), jspi, syncAsync });
    } catch (e) { postMessage({ ok: false, error: String((e && e.message) || e) }); }
  };
`;
const url = URL.createObjectURL(new Blob([workerSrc], { type: 'application/javascript' }));
const w = new Worker(url, { type: 'module' });
const result = await new Promise((resolve) => {
  const t = setTimeout(() => resolve({ ok: false, error: 'timeout 90s' }), 90000);
  w.onmessage = (ev) => { clearTimeout(t); resolve(ev.data); };
  w.onerror = (ev) => { clearTimeout(t); resolve({ ok: false, error: 'worker onerror: ' + (ev.message || 'unknown') }); };
  w.postMessage('go');
});
R.worker = result;
w.terminate();
return R;
