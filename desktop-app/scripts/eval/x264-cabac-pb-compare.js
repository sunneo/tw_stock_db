#!/usr/bin/env node
// 外部核對：把 renderer/src/uml/domain_h264pb_core.js 的 P／B 初始化表（ctxIdx 11 至 59、cabac_init_idc 0 至 2）
// 與 x264 的 common/tables.c 中 x264_cabac_context_init_PB[3][1024][2] 逐格比對。
// 用法：node scripts/eval/x264-cabac-pb-compare.js <x264 的 common/tables.c 路徑>
// 注意：x264 是 GPL，它的原始檔不進專案樹；本腳本只讀取路徑參數指定的檔案，不含任何 x264 內容。
// 來源（2026-11-12 取得）：https://raw.githubusercontent.com/mirror/x264/master/common/tables.c，115507 位元組，sha256 6f22f14992e4a6833518d7d2a56c75e0c9df2f25884ec52755cd25a573c0de3f
const fs = require('fs');
const path = require('path');
const src = process.argv[2];
if (!src) { console.error('用法：node scripts/eval/x264-cabac-pb-compare.js <tables.c 路徑>'); process.exit(2); }
const C = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'uml', 'domain_h264pb_core.js'));
const txt = fs.readFileSync(src, 'utf8');
const start = txt.indexOf('x264_cabac_context_init_PB[3][1024][2] =');
if (start < 0) { console.error('找不到 x264_cabac_context_init_PB 表'); process.exit(2); }
// 去掉 C 註解後再抽數字，避免 "/* 11 - 23 */" 之類的註解混入
const body = txt.slice(start, txt.indexOf('};', start) + 1).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const nums = [...body.slice(body.indexOf('=') + 1).matchAll(/-?\d+/g)].map((m) => +m[0]);
if (nums.length !== 3 * 1024 * 2) { console.error('數字個數不是 6144：' + nums.length); process.exit(2); }
let bad = 0, n = 0;
for (let idc = 0; idc < 3; idc++) for (let ctx = 11; ctx <= 59; ctx++) {
    const k = (idc * 1024 + ctx) * 2; const ours = C.PB_T[idc][ctx]; n++;
    if (nums[k] !== ours[0] || nums[k + 1] !== ours[1]) { bad++; console.log('不符 idc ' + idc + ' ctxIdx ' + ctx + '：本 repo ' + JSON.stringify(ours) + '，x264 [' + nums[k] + ', ' + nums[k + 1] + ']'); }
}
console.log('比對組數 ' + n + '，不符 ' + bad);
process.exit(bad ? 1 : 0);
