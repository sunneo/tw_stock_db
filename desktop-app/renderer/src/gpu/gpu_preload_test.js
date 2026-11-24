// node renderer/src/gpu/gpu_preload_test.js
// GPU 相容層的執行前準備（gpu_preload.js）：假 Pyodide 沒有 numpy 時，只寫 `from numba import cuda` 的腳本會載入 numpy 並成功；
// 載入失敗與安裝失敗都要有可見訊息。另外檢查嵌入的 FA_GPU_PRELOAD_SRC 與原始檔一致。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('./gpu_preload.js');

let pass = 0, fail = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('ok   ' + name); },
    (e) => { fail++; console.log('FAIL ' + name + ': ' + (e && e.message)); }
  );
}

// 假 Pyodide：預設沒有 numpy；loadPackage('numpy') 會把它標成已載入（模擬 Pyodide 發行版套件）
function fakePyodide(opts) {
  opts = opts || {};
  const py = {
    loaded: new Set(),
    calls: [],
    async loadPackage(name) {
      py.calls.push(name);
      if (opts.failLoad && name === 'numpy') throw new Error('假的網路錯誤');
      py.loaded.add(name);
    }
  };
  return py;
}

(async function () {
  await check('只寫 from numba import cuda：自動載入 numpy，成功且沒有訊息', async () => {
    const py = fakePyodide();
    const r = await P.prepareRun(py, 'from numba import cuda\n@cuda.jit\ndef k(x): pass\n', '');
    assert.deepStrictEqual(py.calls, ['numpy']);
    assert.ok(py.loaded.has('numpy'));
    assert.deepStrictEqual(r.lines, []);
    assert.deepStrictEqual(r.numpy, { needed: true, loaded: true });
  });

  await check('import cupy／import torch／from pycuda 都會觸發（含 import a, numba 的寫法）', async () => {
    for (const s of ['import cupy as cp\n', 'import torch\n', 'from pycuda import autoinit\n', 'import os, numba\n', 'from numba.cuda import jit\n']) {
      assert.strictEqual(P.scriptNeedsNumpy(s), true, s);
    }
  });

  await check('一般腳本（numpy、json、playwright）不觸發，不多載入', async () => {
    for (const s of ['import numpy as np\n', 'import json\nprint(1)\n', 'from playwright.sync_api import sync_playwright\n', '# import numba 只是註解\nprint(2)\n']) {
      const py = fakePyodide();
      const r = await P.prepareRun(py, s, '');
      assert.strictEqual(r.numpy.needed, false, s);
      assert.deepStrictEqual(py.calls, [], s);
    }
  });

  await check('numpy 載入失敗：有可見的一行訊息，不丟例外', async () => {
    const py = fakePyodide({ failLoad: true });
    const r = await P.prepareRun(py, 'from numba import cuda\n', '');
    assert.strictEqual(r.lines.length, 1, JSON.stringify(r.lines));
    assert.ok(r.lines[0].indexOf('[fa-bridge] CUDA 相容層：無法自動載入 numpy（假的網路錯誤）') === 0, r.lines[0]);
    assert.deepStrictEqual(r.numpy, { needed: true, loaded: false });
  });

  await check('安裝失敗：可見訊息的文字固定（使用者看得到）', async () => {
    const py = fakePyodide();
    const r = await P.prepareRun(py, 'print(1)\n', '找不到 fa_gpu 模組');
    assert.deepStrictEqual(r.lines, ['[fa-bridge] CUDA 相容層安裝失敗：找不到 fa_gpu 模組']);
  });

  await check('安裝失敗且腳本需要 numpy：兩行都有', async () => {
    const py = fakePyodide();
    const r = await P.prepareRun(py, 'import torch\n', '安裝錯誤');
    assert.strictEqual(r.lines[0], '[fa-bridge] CUDA 相容層安裝失敗：安裝錯誤');
    assert.deepStrictEqual(py.calls, ['numpy']);
  });

  await check('嵌入的 FA_GPU_PRELOAD_SRC 與原始檔一致（之後改了原始檔要重新嵌入）', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');
    const m =/\/\* GPUPRE-BEGIN \*\/\nconst FA_GPU_PRELOAD_SRC = ("(?:[^"\\]|\\.)*");\n/.exec(src);
    assert.ok(m, '找不到嵌入的 FA_GPU_PRELOAD_SRC');
    const embedded = JSON.parse(m[1]);
    const disk = fs.readFileSync(path.join(__dirname, 'gpu_preload.js'), 'utf8').replace(/\r\n/g, '\n');
    assert.strictEqual(embedded.replace(/\r\n/g, '\n'), disk);
  });

  await check('主機端接線：腳本執行前有準備步驟、安裝錯誤寫進 stderr', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
    assert.ok(src.indexOf("_gpuPrepareRun(pyodide, scriptText, '')") > 0, '執行前準備沒有接上');
    assert.ok(src.indexOf("stderrChunks.push('[fa-bridge] CUDA 相容層安裝失敗：' + instErr)") > 0, '安裝錯誤沒有寫進 stderr');
    assert.ok(src.indexOf('const instErr = this._pyBridgeInstallForRun(pyodide);') > 0, '安裝沒有改用 _pyBridgeInstallForRun');
    // 腳本原始碼要在執行前登記給墊片（網頁版字串執行才取得得到 @cuda.jit 核心的來源）
    const reg = src.split('this._gpuRegisterScript(pyodide, scriptText);').length - 1;
    assert.ok(reg >= 2, '執行前沒有登記腳本原始碼（_gpuRegisterScript）：出現 ' + reg + ' 次，應該在同步與非同步兩條路徑都有');
    assert.ok(src.indexOf("fa_gpu.register_script(__fa_script_src__)") > 0, '_gpuRegisterScript 沒有呼叫 fa_gpu.register_script');
  });

  await check('終端機／bash 的同步 python（python -c）：解析 Python 環境後先載入 numpy（三個呼叫點）', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
    const n = src.split('await this._gpuPreloadForShell(').length - 1;
    assert.strictEqual(n, 3, '終端機、bash_execute、檔案夾執行三個呼叫點都要接上：' + n);
    assert.ok(src.indexOf('this._gpuNumpyWanted = true') > 0, '腳本在檔案裡掃不到時，失敗要記下來讓之後先載入');
  });

  await check('音訊 GPU 路徑：等自動探測做完再決定（不是開機第一次就走 CPU）；單次推論有看門狗；太慢要記住不再每首重等；沒用 GPU 要寫原因', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
    assert.ok(src.indexOf('let audioOn = this._audioGpuOn();') > 0 && src.indexOf('await this._gpuAutoProbe();') > 0, '沒有等探測');
    assert.ok(src.indexOf("GPU 路徑太慢") > 0 && src.indexOf("'audioGpuSlow:' + id") > 0, '沒有看門狗或沒有記住太慢');
    assert.ok(src.indexOf('_audioGpuWhyNot()') > 0, '沒用 GPU 沒有寫原因');
  });

  await check('run_command 接線：GPU-only 模式、cwd_abs 傳入、選項順序、只接受 gpu.* 操作、結果帶 gpu 欄位', async () => {
    const fa = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');
    const boot = fs.readFileSync(path.join(__dirname, '..', '..', 'bootstrap.js'), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(fa.indexOf("async _pyBridgeWrap(command, args, cwdAbs)") > 0, '_pyBridgeWrap 沒有 cwdAbs 參數');
    assert.ok(fa.indexOf("const gpuOnly = !skill;") > 0, '沒有 GPU-only 模式（非技能包時只轉 GPU）');
    assert.ok(fa.indexOf("'--cuda-f64', cudaF64") > 0, 'float64 模式沒有傳給 fa_run');
    assert.ok(fa.indexOf("this._gpuPreloadApi().scriptNeedsShim(text)") > 0, 'GPU-only 沒有用同一條規則判斷腳本');
    assert.ok(fa.indexOf("此執行只提供 GPU 相容層") > 0, 'GPU-only 模式沒有擋住其他操作');
    assert.ok(fa.indexOf("_gpuRecord(op.slice(4)") > 0, 'gpu.* 操作沒有記錄 layer／reason／calls');
    assert.ok(boot.indexOf("parsed.cwd_abs || null) : null") > 0, 'bootstrap 沒有把 cwd_abs 傳給 _pyBridgeWrap');
    assert.ok(boot.indexOf("_pyBridgeServe(wrapped.rpc, { gpuOnly: !!wrapped.gpuOnly })") > 0, 'bootstrap 沒有傳 gpuOnly 給 serve');
    assert.ok(boot.indexOf("gpu: info.gpu") > 0, 'python_api_bridge 結果沒有 gpu 欄位');
  });

  await check('python_api_bridge.gpu 回報：網頁版每次執行歸零、_fa_gpu 呼叫會記錄、python_execute 結果帶 python_api_bridge.gpu', async () => {
    const fa = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(fa.indexOf("this._gpuStat = { layer: null, reason: '', calls: 0 }; // 每次執行歸零") > 0, '網頁版執行沒有歸零 GPU 記錄');
    assert.ok(fa.indexOf("this._gpuRecord(String(op), await this._pyBridgeGpu(") > 0, '_fa_gpu 的呼叫沒有記錄');
    assert.ok(fa.indexOf("gpu: { layer: g.layer, reason: g.reason, calls: g.calls }") >= 0, '_runPyodideScriptAsync 沒有回傳 gpu');
    assert.ok(fa.indexOf("python_api_bridge: { gpu }") > 0, 'python_execute 結果沒有 python_api_bridge.gpu');
  });

  await check('GPU 設定只在 gpu-compat 窗格：運算裝置兩個下拉在窗格內；離線模型、Whisper、生圖頁不再有裝置下拉；儲存鍵不改名', async () => {
    const fa = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');
    const boot = fs.readFileSync(path.join(__dirname, '..', '..', 'bootstrap.js'), 'utf8').replace(/\r\n/g, '\n');
    // 窗格（_gpuCompatControls）內兩個運算裝置下拉
    const start = fa.indexOf('_gpuCompatControls() {'), end = fa.indexOf('_gpuCompatRegisterPane() {');
    assert.ok(start > 0 && end > start, '找不到 _gpuCompatControls 區段');
    const pane = fa.slice(start, end);
    assert.ok(pane.indexOf('離線模型與 Whisper 用什麼算') > 0, '窗格缺「離線模型與 Whisper 用什麼算」');
    assert.ok(pane.indexOf('本機小模型（生圖）用什麼算') > 0, '窗格缺「本機小模型（生圖）用什麼算」');
    assert.ok(pane.indexOf("this.advancedSettings.offlineDevicePreference = cpu ? 'cpu' : 'gpu'") > 0, '運算裝置沒寫 offlineDevicePreference');
    assert.ok(pane.indexOf("this.advancedSettings.whisperDevicePreference = cpu ? 'cpu' : 'auto'") > 0, '窗格沒同步 whisperDevicePreference（舊行為）');
    assert.ok(pane.indexOf("localDevice: v") > 0, '生圖裝置沒寫 imageGen.localDevice');
    // 其他地方不再有裝置下拉
    assert.strictEqual(fa.indexOf('<select data-om-set="device"'), -1, '離線模型頁還有裝置下拉');
    assert.strictEqual(fa.indexOf('<select id="ai-whisper-device"'), -1, 'Whisper 頁還有裝置下拉');
    assert.strictEqual(fa.indexOf('<select id="ai-imgcfg-device"'), -1, '生圖頁還有裝置下拉');
    assert.strictEqual(fa.indexOf("$('ai-imgcfg-device')"), -1, '生圖頁還在讀寫裝置下拉');
    assert.strictEqual(fa.indexOf("k === 'device'"), -1, '離線模型頁還有 device 寫入分支');
    assert.strictEqual(boot.indexOf('gpuStack'), -1, '桌面版設定頁還有 GPU 區塊');
    // 模型頁只顯示狀態
    assert.ok(fa.indexOf('ai-whisper-device-status') > 0 && fa.indexOf('ai-imgcfg-device-status') > 0, '模型頁沒有狀態文字');
  });
  await check('GPU 相容層只在 ai 分組的 gpu-compat 窗格出現：桌面版設定頁不掛載；窗格內含開關、float64、偵測、基準、變體競賽各一份', async () => {
    const fa = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');
    const boot = fs.readFileSync(path.join(__dirname, '..', '..', 'bootstrap.js'), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(fa.indexOf("this._gpuCompatRegisterPane()") > 0, 'AI 設定沒有註冊 GPU 相容層分頁');
    assert.ok(fa.indexOf("registerAdvancedSettingsTab('ai', 'gpu-compat'") > 0, 'GPU 相容層不在 ai 分組');
    // 桌面版設定頁不得再掛這個窗格（使用者要的是一個功能只出現在一處）
    assert.strictEqual(boot.indexOf("fa._gpuCompatControls()"), -1, '桌面版設定頁還掛著 GPU 相容層（應只在 ai 分組的 gpu-compat 窗格）');
    assert.strictEqual(boot.indexOf("_gpuBenchPanel"), -1, '桌面版設定頁不應掛基準表');
    assert.strictEqual(boot.indexOf("_gpuVariantPanel"), -1, '桌面版設定頁不應掛變體競賽表');
    // 窗格內容：基準與變體競賽表各只建一次，都在 _gpuCompatControls 裡（窗格的根）
    assert.strictEqual(fa.split('this._gpuBenchPanel()').length - 1, 1, '基準表應只建一次');
    assert.strictEqual(fa.split('this._gpuVariantPanel()').length - 1, 1, '變體競賽表應只建一次');
    assert.ok(fa.indexOf("root.appendChild(this._gpuCompatControls());") > 0, 'gpu-compat 窗格沒有包含 GPU 相容層控制區');
    assert.ok(fa.indexOf("chk.checked = (this.advancedSettings.cudaCompat !== 'off')") > 0, '開關沒有依設定顯示（預設開）');
    for (const v of ["['auto', 'auto（預設）']", "['f32', 'f32']", "['exact', 'exact']"]) assert.ok(fa.indexOf(v) > 0, '缺少模式選項 ' + v);
    assert.ok(fa.indexOf("this.advancedSettings.cudaCompatFloat64 = sel.value") > 0, 'float64 模式沒有寫回設定');
    assert.ok(fa.indexOf("status.textContent = '按「重新偵測」查看目前偵測到的 GPU 層。';") > 0, '開啟設定時不應自動偵測');
    assert.ok(fa.indexOf("this._cudawebCall('backend_info', {})") > 0, '偵測沒有呼叫 backend_info');
  });

  await check('桌面版 run_command 的判斷（scriptNeedsShim）與網頁版同一條規則', async () => {
    assert.strictEqual(typeof P.scriptNeedsShim, 'function');
    for (const s of ['from numba import cuda\n', 'import torch\n']) assert.strictEqual(P.scriptNeedsShim(s), true, s);
    for (const s of ['import numpy\nprint(1)\n', '# import numba\n']) assert.strictEqual(P.scriptNeedsShim(s), false, s);
  });

  console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
  if (fail) process.exit(1);
})();
