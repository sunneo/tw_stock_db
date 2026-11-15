/* gpu_preload.js — GPU 相容層在 Pyodide 裡的執行前準備（DESIGN.python-api-bridge.md「GPU 相容層」）。
 * 墊片（numba／cupy／torch／pycuda）需要 numpy。使用者的腳本常常只寫 `from numba import cuda`，Pyodide 的
 * loadPackagesFromImports 不會因此載入 numpy，墊片第一次 import 就會失敗。這裡在執行腳本前：
 *   1. 掃描腳本文字，有墊片的 import 才先 loadPackage('numpy')；
 *   2. 把安裝失敗（或 numpy 載入失敗）寫成一行可見的訊息，讓使用者知道相容層沒有生效。
 * 純函式（不碰 DOM），UMD：瀏覽器用 new Function 載入（window.FaGpuPreload），node 用 require。
 */
(function (root) {
  'use strict';
  // 腳本的 import 行含 numba／cupy／torch／pycuda，或 from 這些套件開頭
  var SHIM_RE = /\bimport\s+[^\n#;]*\b(?:numba|cupy|torch|pycuda)\b|\bfrom\s+(?:numba|cupy|torch|pycuda)\b/;

  function scriptNeedsNumpy(text) {
    // 先去掉 # 註解（只用來偵測，寧可漏掉也不要誤判成需要）
    var code = String(text || '').replace(/#[^\n]*/g, '');
    return SHIM_RE.test(code);
  }

  function errText(e) {
    return String((e && e.message) || e);
  }

  // 準備一次執行：installError 是本次安裝的錯誤（沒有就傳空字串）。
  // 回傳 { lines: [要寫進 stderr 的訊息], numpy: { needed, loaded } }。永不丟例外。
  async function prepareRun(pyodide, text, installError) {
    var lines = [];
    if (installError) lines.push('[fa-bridge] CUDA 相容層安裝失敗：' + installError);
    var numpy = { needed: false, loaded: false };
    if (scriptNeedsNumpy(text)) {
      numpy.needed = true;
      try {
        await pyodide.loadPackage('numpy', { messageCallback: function () {}, errorCallback: function () {} });
        numpy.loaded = true;
      } catch (e) {
        lines.push('[fa-bridge] CUDA 相容層：無法自動載入 numpy（' + errText(e) + '），numba／cupy／torch／pycuda 將不能使用');
      }
    }
    return { lines: lines, numpy: numpy };
  }

  // 桌面版 run_command 也用同一條規則判斷要不要裝 GPU 相容層（腳本 import 墊片套件才需要）
  var api = { scriptNeedsNumpy: scriptNeedsNumpy, scriptNeedsShim: scriptNeedsNumpy, prepareRun: prepareRun };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FaGpuPreload = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
