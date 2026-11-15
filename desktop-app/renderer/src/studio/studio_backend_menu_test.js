// node renderer/src/studio/studio_backend_menu_test.js
// 後端選單（studio-viewer.template.html 的 build()）的靜態檢查：
// cudaweb 有顯示名稱；cudaweb 可用時仍會列出它的 reason（實際層與降級原因）。
// 注意：這是讀取模板原始碼的靜態檢查，不是真的在頁面裡渲染；頁面渲染尚未驗證。
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const T = fs.readFileSync(path.join(__dirname, 'studio-viewer.template.html'), 'utf8');
let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name); } }

check('選單名稱表含 cudaweb', /'cudaweb':'cudaweb（GPU 運算核心）'/.test(T));
check('可用的 cudaweb 仍列出 reason（filter 條件）', /b\.id==='cudaweb'&&b\.reason/.test(T));
check('不可用後端仍列出 reason（原條件保留）', /filter\(function\(b\)\{return !b\.available\|\|/.test(T));
check('列出時 reason 缺值不會印出 undefined', /\(b\.reason\|\|''\)/.test(T));

// 用假資料跑同一段過濾邏輯（與模板相同的條件），確認兩種情況的輸出
const backends = [
    { id: 'cpu-py', available: false, reason: '缺套件' },
    { id: 'cudaweb', available: true, reason: '可用（WebGPU（T1）；能力檔 A）' },
    { id: 'wasm-web', available: true },
];
const why = backends.filter(function (b) { return !b.available || (b.id === 'cudaweb' && b.reason); });
assert.deepStrictEqual(why.map((b) => b.id), ['cpu-py', 'cudaweb']);
check('假資料：cudaweb 可用時列出、wasm-web 可用且無 reason 時不列出', true);

console.log('\n' + pass + ' 通過，' + fail + ' 失敗（靜態檢查，未在頁面實際渲染）');
if (fail) process.exit(1);
