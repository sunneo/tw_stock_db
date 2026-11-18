'use strict';
// Profile 白話結論在「新速率」下的測試（純函式，不碰 GPU、DOM）。速率取自真機量測：GPU 端到端約 11.7 GFLOP/s、
// 新核心 CPU 主執行緒 12.6 GFLOP/s（兩邊量級相同）；對照：舊的 CPU 快取速率 0.70 GFLOP/s。
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8').split('\r\n').join('\n');
const HS = require('../renderer/src/gpu/hetero_split.js');
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 400))); } };
const vs = src.indexOf('/* GPUVIEW-BEGIN */'), ve = src.indexOf('/* GPUVIEW-END */');
const L = new Function(src.slice(vs, ve) + '\nreturn { faProfilePlan };')();

const W = (m, k, n) => 2 * m * k * n;
const shapes = [['16x256x256', W(16, 256, 256)], ['64x1024x1024', W(64, 1024, 1024)], ['128x1024x1024', W(128, 1024, 1024)], ['512x512x512', W(512, 512, 512)]].map(([label, w]) => ({ label, W: w }));
const pts = (ov, rate) => shapes.map((s) => ({ W: s.W, ms: ov + s.W / rate }));

// 1. 新速率：分攤有收益，比例接近各半，白話結論寫出比例與省的時間
{
  const P = L.faProfilePlan({ gpuPts: pts(1, 1.17e7), cpuPts: pts(0.5, 1.26e7), gpuVariant: 'mm_vec4_f32', cpuCores: 4, decideSplit: HS.decideSplit, shapes });
  ok(P.splitUseful === true, '新速率：分攤有收益', P.lines);
  const big = P.perShape.find((x) => x.label === '512x512x512');
  ok(big && big.fraction > 0.35 && big.fraction <= 0.5, '新速率：512³ 的 CPU 比例接近各半（上限 0.5）', big);
  ok(P.lines.some((l) => /有收益：.*CPU 分擔 \d+%.*省約 \d+%/.test(l)), '新速率：白話結論寫出比例與省的時間', P.lines);
  console.log('     白話：' + P.lines.join(' | ').slice(0, 300));
}

// 2. 對照（舊的 CPU 快取速率 0.70 GFLOP/s）：比例很小或沒有收益，說明舊結論為什麼偏低
{
  const P = L.faProfilePlan({ gpuPts: pts(1, 1.17e7), cpuPts: pts(0.5, 7.0e5), gpuVariant: 'mm_vec4_f32', cpuCores: 4, decideSplit: HS.decideSplit, shapes });
  const big = P.perShape.find((x) => x.label === '512x512x512');
  ok(!big || big.fraction < 0.15 || big.mode === 'gpu', '舊速率對照：比例很小或全給 GPU', big);
  console.log('     對照（舊速率）：' + P.lines.join(' | ').slice(0, 300));
}

console.log('\n通過 ' + pass + '，失敗 ' + fail);
if (fail) process.exit(1);
