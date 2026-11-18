// Profile（簡易檢視核心）的純函式測試：faProfileFit（固定成本＋速率擬合）、faProfilePlan（合作組合與白話結論）。不碰 GPU、DOM。
'use strict';
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8').split('\r\n').join('\n');
const HS = require('../renderer/src/gpu/hetero_split.js');
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 400))); } };
const vs = src.indexOf('/* GPUVIEW-BEGIN */'), ve = src.indexOf('/* GPUVIEW-END */');
const L = new Function(src.slice(vs, ve) + '\nreturn { faProfileFit, faProfilePlan };')();
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.abs(b);

const W = (m, k, n) => 2 * m * k * n;
const shapes = [['16x256x256', W(16, 256, 256)], ['64x1024x1024', W(64, 1024, 1024)], ['128x1024x1024', W(128, 1024, 1024)]].map(([label, w]) => ({ label, W: w }));
const pts = (ov, rate) => shapes.map((s) => ({ W: s.W, ms: ov + s.W / rate }));

// 擬合
const f1 = L.faProfileFit(pts(3, 4e8));
ok(f1 && near(f1.overheadMs, 3, 0.01) && near(f1.rate, 4e8, 0.01), '擬合：還原固定成本 3 毫秒與速率', f1);
ok(L.faProfileFit([{ W: 1e8, ms: 10 }]).overheadMs === 0 && L.faProfileFit([{ W: 1e8, ms: 10 }]).rate === 1e7, '擬合：一個點，固定成本 0');
ok(L.faProfileFit([]) === null && L.faProfileFit(null) === null && L.faProfileFit([{ W: 0, ms: 5 }, { W: 5, ms: NaN }]) === null, '擬合：沒有有效點回傳 null');
const noisy = L.faProfileFit([{ W: 1e6, ms: 1 }, { W: 1e8, ms: 5 }, { W: 2e8, ms: 8 }]);   // 斜率正、截距為正
ok(noisy.overheadMs >= 0 && noisy.rate > 0, '擬合：雜訊資料的固定成本不為負', noisy);
const neg = L.faProfileFit([{ W: 1e6, ms: 0.1 }, { W: 1e8, ms: 20 }, { W: 2e8, ms: 40 }]);
ok(neg.overheadMs === 0 && neg.rate > 0, '擬合：截距為負改過原點', neg);

// 一般機器：GPU 400 GFLOP/s、固定 3 毫秒；CPU 30 GFLOP/s、固定 0.5 毫秒
const P = L.faProfilePlan({ gpuPts: pts(3, 4e8), cpuPts: pts(0.5, 3e7), gpuVariant: 'mm_vec4_f32', cpuCores: 4, decideSplit: HS.decideSplit, shapes });
ok(near(P.ratio, 400 / 30, 0.02), '比值＝兩邊實測速率相除（約 13.3 倍）', P.ratio);
ok(/GPU 比 CPU 快約 13 倍/.test(P.lines[0]) && /mm_vec4_f32/.test(P.lines[0]), '白話結論第一句有倍數與最快核心', P.lines[0]);
const expectCross = (3 - 0.5) / (1 / 3e7 - 1 / 4e8);
ok(near(P.crossoverFlops, expectCross, 0.02), '卸載交界點＝固定成本差 ÷ 每單位工作時間差', [P.crossoverFlops, expectCross]);
ok(P.lines.some((l) => /小於約 .* 百萬次運算.*改用 CPU/.test(l)), '結論寫出「小於 N 改用 CPU」', P.lines);
ok(P.perShape[0].mode === 'cpu' && P.perShape[2].mode !== 'cpu', '小形狀走 CPU、大形狀不走 CPU', P.perShape.map((x) => x.mode));
ok(P.lines.some((l) => /一起算沒有收益|一起算有收益/.test(l)), '結論一定交代分攤有沒有收益');

// 兩邊差不多快：分攤有收益
const Q = L.faProfilePlan({ gpuPts: pts(0.2, 1e8), cpuPts: pts(0.2, 8e7), cpuCores: 8, decideSplit: HS.decideSplit, shapes });
ok(Q.splitUseful === true && Q.lines.some((l) => /有收益：.*CPU 分擔 \d+%.*省約 \d+%/.test(l)), '速率接近：分攤有收益，寫出比例與省的時間', Q.lines);
ok(/差不多/.test(Q.lines[0]) || /快約 1\.\d 倍/.test(Q.lines[0]), '速率接近：不誇大倍數', Q.lines[0]);

// GPU 比 CPU 慢
const S = L.faProfilePlan({ gpuPts: pts(0.1, 1e7), cpuPts: pts(0.1, 1e8), cpuCores: 4, decideSplit: HS.decideSplit, shapes });
ok(/GPU 比 CPU 慢/.test(S.lines[0]) && S.perShape.every((x) => x.mode === 'cpu' || x.mode === 'split'), 'GPU 較慢：明說，且不把運算交給 GPU 當主力', S.perShape.map((x) => x.mode));

// 沒有 GPU／沒有 CPU／都沒有
const N = L.faProfilePlan({ gpuPts: [], cpuPts: pts(0.5, 3e7), cpuCores: 4, decideSplit: HS.decideSplit, shapes });
ok(/沒有可用的 WebGPU，只用 CPU（4 個執行緒，實測約 30 GFLOP\/s）/.test(N.lines[0]) && N.ratio === null, '沒有 WebGPU：只用 CPU 並照樣報 CPU 實測', N.lines);
const C = L.faProfilePlan({ gpuPts: pts(3, 4e8), cpuPts: [], decideSplit: HS.decideSplit, shapes });
ok(/CPU 沒有量到/.test(C.lines[0]) && /400/.test(C.lines[0]), '沒量到 CPU：不編造，維持全給 GPU');
ok(/沒有量到任何速率/.test(L.faProfilePlan({ gpuPts: [], cpuPts: [], shapes }).lines[0]), '都沒量到：直說');
ok(typeof L.faProfilePlan({ gpuPts: pts(3, 4e8), cpuPts: pts(0.5, 3e7), shapes }).lines[0] === 'string', '沒給決策函式也不當機');

console.log('通過 ' + pass + '，失敗 ' + fail); process.exit(fail ? 1 : 0);
