/* snes_spc（wasm）渲染器的轉接層（UMD，純邏輯）。目前沒有編出的 wasm，這裡只定義「接上之後」的介面，並明確回報缺少什麼。
 *   createWasmCore(wasmModule, spc) → 與 musiclib_spc_core.js 的 createCore 同樣的介面（renderStereo／snapshot／restore／peek…）。
 *   wasmModule 由呼叫端注入，需提供：load(bytes) → handle、render(handle, outI16Ptr, frames) → 寫入的立體聲樣本數、
 *   snapshot(handle) → Uint8Array、restore(handle, bytes)。缺任何一個就丟錯並說明。
 *   available()：目前有沒有可用的 wasm 模組（沒有就回傳 false 與原因）。
 * 之所以要這層：晶片播放後端（musiclib_chip_spc.js）只認 createCore 介面，之後把 wasm 接上，同一個 'spc' 後端 id 之下就能換渲染器。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMusicLibSpcWasm = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var REQUIRED = ['load', 'render', 'snapshot', 'restore'];

  function missing(mod) {
    if (!mod) return '沒有 snes_spc wasm 模組（工具鏈未就位：本機沒有 emscripten 或 clang，尚未編出 .wasm）';
    for (var i = 0; i < REQUIRED.length; i++) if (typeof mod[REQUIRED[i]] !== 'function') return 'wasm 模組缺少 ' + REQUIRED[i] + '()';
    return null;
  }
  function available(mod) { return missing(mod) === null; }

  function createWasmCore(mod, spc) {
    var why = missing(mod);
    if (why) throw new Error(why);
    var h = mod.load(spc && spc.bytes);
    return {
      renderStereo: function (L, R, off, n) {
        // 介面與 JS 核心相同：wasm 端輸出交錯的 int16 立體聲，這裡轉成 Float32
        var buf = mod.render(h, n);
        off = off || 0;
        for (var i = 0; i < n; i++) { L[off + i] = buf[2 * i] / 32768; R[off + i] = buf[2 * i + 1] / 32768; }
        return n;
      },
      snapshot: function () { return { wasm: mod.snapshot(h) }; },
      restore: function (s) { mod.restore(h, s.wasm); }
    };
  }

  return { createWasmCore: createWasmCore, available: available, missingReason: missing };
}));
