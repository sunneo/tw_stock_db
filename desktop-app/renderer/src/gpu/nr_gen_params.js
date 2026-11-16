'use strict';
// node 測試用的轉接：生成參數語意的唯一實作在桌面版根目錄的 nr-gen-params.js（原生子程序用）。
// 瀏覽器端由 scripts/embed-code-ui.js 把同一份檔案直接嵌進 FA_QWEN_SRC，不經過這個轉接。
module.exports = require('../../../nr-gen-params.js');
