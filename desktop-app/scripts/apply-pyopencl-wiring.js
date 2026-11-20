// node scripts/apply-pyopencl-wiring.js [floating-assistant.js 的路徑]
// 把「標準 pyopencl 接線」（DESIGN.pyopencl.md §10.3）套進 renderer/src/floating-assistant.js 的三個手寫位置。可重複執行（已套用就略過）。
// 為什麼是腳本：floating-assistant.js 是共用的大檔、只有主帳號（hungfu.lee）有寫入權限；這支腳本讓有權限的人一次套用，之後照平常流程：
//   node scripts/embed-code-ui.js   （把 cl_icd／clc_js／cl_host_ops／cl_host_page 嵌進 FA_KIR_SRC，把 pybridge 的 Python 檔嵌進 FA_PYBRIDGE_FILES）
//   node build-assistant.js、node --check renderer/src/floating-assistant.js、發布走原本的流程（publish-live-update-patch）
// 三個位置：(1) 新增 _openclPrepareRun 方法；(2) _runPyodideScriptAsync 在 runPythonAsync 前呼叫它（頁面的 Pyodide，含終端機的 python）；
//          (3) _terminalRunPythonWorker 的 init 訊息：程式用到 pyopencl 時帶上 clSrc（Worker 自己建立載入器；py_worker.js 已改好）。
const fs = require('fs'), path = require('path');
const file = path.resolve(process.argv[2] || path.join(__dirname, '..', 'renderer', 'src', 'floating-assistant.js'));
let s = fs.readFileSync(file, 'utf8'); const orig = s; let applied = 0;
function rep(name, anchor, replacement, marker) {
    if (s.includes(marker)) { console.log('略過（已套用）：' + name); return; }
    const n = s.split(anchor).length - 1; if (n !== 1) { console.error('找不到唯一的錨點：' + name + '（出現 ' + n + ' 次）——檔案可能已被改動，請手動套用'); process.exit(1); }
    s = s.replace(anchor, () => replacement); applied++; console.log('已套用：' + name);
}
rep('(1) _openclPrepareRun 方法', '    async _gpuPrepareRun(pyodide, text, installErr) {', `    // 標準 pyopencl（DESIGN.pyopencl.md §10）：腳本 import pyopencl 時才做事——註冊 _fa_opencl（OpenCL 載入器與 GPU 驅動，WebGPU→WebGL2→CPU）、
    // 從 PyPI 取得真的 pyopencl 並放上我們的 _cl.py。沒有 import 就什麼都不做；失敗不擋腳本（回傳提示行，之後 import 的錯誤訊息照舊）。
    async _openclPrepareRun(pyodide, text) {
        try {
            const M = this._kirLoad();
            if (!M || !M.FaClHostPage || !M.FaClHostPage.wantsPyopencl(text)) return [];
            const lines = [];
            const jspi = typeof WebAssembly !== 'undefined' && typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';
            const makeCanvas = () => { const c = document.createElement('canvas'); c.width = 4; c.height = 4; return c; };
            await M.FaClHostPage.prepare(pyodide, { mods: M, nav: navigator, makeCanvas, jspi, files: FA_PYBRIDGE_FILES, onProgress: (t) => lines.push('[pyopencl] ' + t) });
            return lines;
        } catch (e) { return ['[pyopencl] 準備失敗：' + String((e && e.message) || e).slice(0, 300)]; }
    }
    async _gpuPrepareRun(pyodide, text, installErr) {`, '_openclPrepareRun(pyodide, text) {');
rep('(2) _runPyodideScriptAsync 呼叫', '            await pyodide.runPythonAsync(scriptText, options);\n        } catch (err) {\n            stderrChunks.push(String(err && err.message || err));', '            for (const l of await this._openclPrepareRun(pyodide, scriptText)) stderrChunks.push(l);   // 標準 pyopencl（只在腳本 import pyopencl 時才做事）\n            await pyodide.runPythonAsync(scriptText, options);\n        } catch (err) {\n            stderrChunks.push(String(err && err.message || err));', 'await this._openclPrepareRun(pyodide, scriptText)');
rep('(3) Worker init 帶 clSrc', "            worker.postMessage(Object.assign({ type: 'init', files, prelude: PW.PRELUDE_PY, runner: PW.RUNNER_PY }, job));", "            // 標準 pyopencl：程式用到時才把 OpenCL 模組的原始碼送進 Worker（Worker 自己建立載入器與 GPU 驅動）\n            const clSrc = (typeof FA_KIR_SRC === 'string' && /pyopencl/.test(String((job && job.src) || ''))) ? { clSrc: FA_KIR_SRC } : {};\n            worker.postMessage(Object.assign({ type: 'init', files, prelude: PW.PRELUDE_PY, runner: PW.RUNNER_PY }, job, clSrc));", 'const clSrc = (typeof FA_KIR_SRC');
if (applied) { try { fs.writeFileSync(file, s); } catch (e) { console.error('寫入失敗（沒有權限？）：' + e.message); process.exit(2); } }
console.log(applied ? '完成：套用了 ' + applied + ' 處' : '沒有需要套用的');
