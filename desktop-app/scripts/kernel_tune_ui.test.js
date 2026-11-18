// 運算變體調校設定頁（O9）的 node 測試：
// 1. floating-assistant.js 裡嵌入的 FA_KERNEL_TUNE_SRC 真的能跑，並回傳 FaKernelRace（createKernelRace 等）。
// 2. 用嵌入的 kernel_race 做 snapshot／force／unforce／reset，確認設定頁要的資料形狀。
// 3. 純函式 faKernelTuneRows（設定頁列的資料轉換）：變體、來源文字、強制、重跑（沒有真 GPU 裝置時不能按）。
// 不碰 GPU、不碰 DOM。
'use strict';
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8').split('\r\n').join('\n');
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 300))); } };

// 瀏覽器環境：嵌入的程式用 self 當根物件
global.self = global;

// 1. 嵌入的 FA_KERNEL_TUNE_SRC（一行 JSON 字串）
const m = /const FA_KERNEL_TUNE_SRC = ("(?:[^"\\]|\\.)*");/.exec(src);
ok(!!m, '找得到 FA_KERNEL_TUNE_SRC 常數');
let KR = null;
try { KR = new Function(JSON.parse(m[1]))(); } catch (e) { KR = null; console.log('   載入錯誤：' + (e && e.message)); }
ok(KR && typeof KR.createKernelRace === 'function', '嵌入的原始碼回傳 FaKernelRace（有 createKernelRace）', KR && Object.keys(KR));

// 2. 資料 API（用記憶體假儲存，不碰 localStorage）
const mem = () => { const d = {}; return { getItem: (k) => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); } }; };
const kr = KR.createKernelRace({ adapter: 'test-adapter', storage: mem() });
const snap0 = kr.snapshot({});
ok(Array.isArray(snap0) && snap0.length > 0, 'snapshot 回傳每個運算一列', snap0 && snap0.length);
ok(snap0.every((r) => r.op && r.choice && ['forced', 'tuned', 'rule'].indexOf(r.source) >= 0 && Array.isArray(r.eligible)), 'snapshot 列都有 op／choice／source／eligible');
const first = snap0[0];
ok(first.eligible.indexOf(first.choice) >= 0, '目前選擇的變體在可選清單裡', first);
const pick = first.eligible.find((id) => id !== first.choice) || first.eligible[0];
kr.force(first.op, pick);
const snap1 = kr.snapshot({});
const r1 = snap1.find((r) => r.op === first.op);
ok(r1.source === 'forced' && r1.choice === pick && r1.forced === pick, '強制指定後 snapshot 顯示 forced', r1);
kr.unforce(first.op);
ok(kr.snapshot({}).find((r) => r.op === first.op).forced === null, '取消強制後恢復規則');
let threw = false; try { kr.force(first.op, 'no-such-variant'); } catch (_) { threw = true; }
ok(threw, '強制不存在的變體會丟錯（設定頁要顯示原因）');
kr.force(first.op, pick);
kr.reset();
ok(kr.snapshot({}).every((r) => r.forced === null), '恢復預設清掉所有強制指定');

// 3. 純函式 faKernelTuneRows（從 floating-assistant.js 切出來）
const vs = src.indexOf('/* KTUNE-VIEW-BEGIN */'), ve = src.indexOf('/* KTUNE-VIEW-END */');
ok(vs >= 0 && ve > vs, '找得到 KTUNE-VIEW 區塊');
const faKernelTuneRows = new Function(src.slice(vs, ve) + '\nreturn faKernelTuneRows;')();
const rows = faKernelTuneRows([
    { op: 'opA', choice: 'v1', source: 'rule', reason: '規則', forced: null, cached: null, cachedMedian: null, running: false, eligible: ['v1', 'v2'] },
    { op: 'opB', choice: 'v2', source: 'forced', reason: '強制指定', forced: 'v2', cached: 'v2', cachedMedian: 1.5, running: false, eligible: ['v1', 'v2'] },
    { op: 'opC', choice: 'v1', source: 'tuned', reason: '調校', forced: null, cached: 'v1', cachedMedian: 0.25, running: true, eligible: ['v1'] },
]);
ok(rows.length === 3 && rows[0].op === 'opA', '每列一個運算，順序不變');
ok(rows[0].sourceText === '規則（預設）' && rows[1].sourceText === '強制指定' && rows[2].sourceText === '調校結果（快取）', '來源文字對應', rows.map((r) => r.sourceText));
ok(rows[1].forcedId === 'v2' && rows[0].forcedId === '', '強制欄位：有強制才有 id');
ok(rows[0].cachedText === '尚未調校' && /1\.5/.test(rows[1].cachedText) && /v2/.test(rows[1].cachedText), '快取文字：沒有快取顯示尚未調校，有就顯示變體與中位數');
ok(rows.every((r) => r.canRerun === false && /O9 B/.test(r.rerunHint)), '沒有真 GPU 裝置時重跑不能按，並說明原因（O9 B 項）', rows.map((r) => r.canRerun));
ok(rows[2].running === true && rows[0].eligibleIds.join() === 'v1,v2', '競賽中狀態與可選變體清單');
ok(Array.isArray(faKernelTuneRows(null)) && faKernelTuneRows(null).length === 0, '沒有快照時回傳空陣列（不丟錯）');

console.log('kernel_tune_ui: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
