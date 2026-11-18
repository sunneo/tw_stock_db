// node renderer/src/gpu/o9_race_check_loader_test.js — O9 真 Chrome 驗收頁（scripts/eval/o9_race_check.html）用的載入方式，在 node 驗證：
// 頁面用同一套「解析 ./ require → 同步 CJS 載入」讀 mm_ops 的依賴圖，並呼叫 startMatmulRace／raceMatmul／pickMatmulKernel。
// 只驗證載入與介面存在；競賽本身在假裝置上不能跑（假裝置不認得校正核心），真競賽要在真 Chrome 跑 o9_race_check.html。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function fetchModules(entry) {
  const src = {}, queue = [entry];
  while (queue.length) {
    const n = queue.shift();
    if (src[n] !== undefined) continue;
    src[n] = fs.readFileSync(path.join(__dirname, n + '.js'), 'utf8');
    for (const m of src[n].matchAll(/require\(\s*['"]\.\/([\w.]+?)(?:\.js)?['"]\s*\)/g)) queue.push(m[1]);
  }
  return src;
}
function makeRequire(src) {
  const cache = {};
  const req = (p) => {
    const n = String(p).replace(/^\.\//, '').replace(/\.js$/, '');
    if (cache[n]) return cache[n].exports;
    if (src[n] === undefined) throw new Error('沒有模組 ' + p);
    const m = { exports: {} };
    cache[n] = m;
    new Function('module', 'exports', 'require', src[n])(m, m.exports, req);
    return m.exports;
  };
  return req;
}

let ok = 0;
try {
  const src = fetchModules('mm_ops');
  assert.ok(src.mm_ops && src.kernel_select && src.variant_race, '依賴圖要含 mm_ops、kernel_select、variant_race');
  const req = makeRequire(src);
  const mm = req('mm_ops');
  for (const f of ['startMatmulRace', 'raceMatmul', 'pickMatmulKernel', 'setMatmulCaps']) assert.strictEqual(typeof mm[f], 'function', f);
  const KS = req('kernel_select');
  assert.strictEqual(typeof KS.probeCaps, 'function');
  assert.strictEqual(mm.pickMatmulKernel(64, 64, 64, {}).source, 'rule', '沒有勝者時第一次使用走規則');
  ok++; console.log('ok   o9 頁面的模組載入與介面');
} catch (e) { console.log('FAIL o9 頁面的模組載入：' + ((e && e.stack) || e)); process.exitCode = 1; }
console.log(ok + ' 項通過（o9_race_check_loader）');
