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

  console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
  if (fail) process.exit(1);
})();
