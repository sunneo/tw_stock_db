// GPU 相容層窗格「簡易檢視／專業檢視」規則的 node 測試（純函式，不碰 DOM、不碰 GPU）。
'use strict';
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8').split('\r\n').join('\n');
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 300))); } };

const vs = src.indexOf('/* GPUVIEW-BEGIN */'), ve = src.indexOf('/* GPUVIEW-END */');
ok(vs > 0 && ve > vs, '找得到 GPUVIEW 區段');
const L = new Function(src.slice(vs, ve) + '\nreturn { faGpuCompatView, faGpuCompatSummary, SIMPLE: FA_GPU_VIEW_SIMPLE, PRO: FA_GPU_VIEW_PRO };')();

// 檢視選擇
ok(L.faGpuCompatView(false, 'pro').view === 'simple', '工程模式關閉：偏好是專業也一律簡易');
ok(L.faGpuCompatView(false, 'pro').canSwitch === false, '工程模式關閉：不顯示切換');
ok(L.faGpuCompatView(true, 'pro').view === 'pro', '工程模式開啟：偏好專業就是專業');
ok(L.faGpuCompatView(true, 'simple').view === 'simple', '工程模式開啟：偏好簡易就是簡易');
ok(L.faGpuCompatView(true, 'pro').canSwitch === true, '工程模式開啟：可以切換');
ok(['pro-ish', undefined, null, 5, {}, ''].every((p) => L.faGpuCompatView(true, p).view === 'simple'), '偏好壞值或讀取失敗（undefined／null）：退回簡易');
ok(L.faGpuCompatView(undefined, 'pro').view === 'simple' && L.faGpuCompatView('true', 'pro').view === 'simple', '工程模式不是嚴格 true：當作沒開');
const a = L.faGpuCompatView(true, 'pro').blocks; a.push('x');
ok(L.faGpuCompatView(true, 'pro').blocks.indexOf('x') < 0, '回傳的是複本，改它不會污染常數');

// 區塊清單
const S = L.SIMPLE, P = L.PRO;
ok(new Set(S).size === S.length && new Set(P).size === P.length, '兩個清單各自沒有重複');
ok(S.every((b) => P.indexOf(b) >= 0), '簡易的區塊都在專業裡（專業＝全部內容）');
ok(P.filter((b) => S.indexOf(b) < 0).sort().join() === 'advanced,cpuShare,float64,kernelTune,matmulKernel', '只有專業才有的區塊：float64、矩陣乘核心、CPU 分擔、進階、運算變體');

// 原始碼裡實際標的區塊編號，必須和清單一致（不重複、不遺漏）
const cs = src.indexOf('_gpuCompatControls() {'), ce = src.indexOf('_kernelTuneLib() {');
const reg = src.indexOf('_gpuCompatRegisterPane() {'), regEnd = src.indexOf('registerAdvancedSettingsTab(\'ai\', \'gpu-compat\'');
const used = new Set();
for (const seg of [src.slice(cs, ce), src.slice(reg, regEnd)]) { let m; const re = /(?:tag\('|data-gpu-block', ')([A-Za-z0-9]+)'/g; while ((m = re.exec(seg))) used.add(m[1]); }
ok([...used].sort().join() === P.slice().sort().join(), '原始碼標的區塊 ＝ 專業清單（沒有多標、沒有漏標）', [...used]);

// 白話結論
const row = (shape, id, median, errors) => ({ shape, id, stats: { median }, errors: errors || 0 });
const rows = [row('a', 'cudaweb', 10), row('a', 'ort-webgpu', 20), row('a', 'ort-wasm', 80)];
ok(/約為 CPU 的 8 倍快/.test(L.faGpuCompatSummary({ deviceReady: true }, rows)), '結論：GPU 取較快者，8 倍');
ok(/GPU 可用，矩陣乘速度跟 CPU 差不多/.test(L.faGpuCompatSummary({ deviceReady: true }, [row('a', 'cudaweb', 10), row('a', 'ort-wasm', 10)])), '結論：差不多');
ok(/比 CPU 慢/.test(L.faGpuCompatSummary({ deviceReady: true }, [row('a', 'cudaweb', 40), row('a', 'ort-wasm', 10)])), '結論：比 CPU 慢要明說');
ok(/不能用.*原因X.*CPU/.test(L.faGpuCompatSummary({ deviceReady: false, probeReason: '原因X' }, rows)), '結論：GPU 不可用寫原因與退路，即使有舊結果');
ok(/按「Profile」/.test(L.faGpuCompatSummary({ deviceReady: true }, [])), '結論：可用但還沒量測，引導按跑基準');
ok(/不知道/.test(L.faGpuCompatSummary(null, null)), '結論：完全沒資料，不亂講可用');
ok(/按「Profile」/.test(L.faGpuCompatSummary({ deviceReady: true }, [row('a', 'cudaweb', 10, 2), row('a', 'ort-wasm', 80)])), '結論：有錯誤的量測不採用');
ok(/約為 CPU 的 \d+ 倍/.test(L.faGpuCompatSummary(null, rows)), '結論：沒偵測資訊但有量測，也能給倍數');

console.log('通過 ' + pass + '，失敗 ' + fail); process.exit(fail ? 1 : 0);
