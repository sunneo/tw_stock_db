'use strict';
// Profile 卸載交界點回歸測試（純函式，不碰 GPU、DOM）。實測點取自真機（只用 GPU 的 GPU 端到端耗時；卸載給 CPU 的 CPU 耗時）：
// N=32/128/256/512 → GPU 12.1／12.8／13.7／20.8 ms；CPU 0.2／1.0／4.9／27.9 ms。
// 要求：交界點落在 1e8 到 2e8 flops；256 在交界點以下（卸載）；512 在交界點以上（不卸載）；不再是 1.18e7。
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8').split('\r\n').join('\n');
const HS = require('../renderer/src/gpu/hetero_split.js');
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 300))); } };
const vs = src.indexOf('/* GPUVIEW-BEGIN */'), ve = src.indexOf('/* GPUVIEW-END */');
const L = new Function(src.slice(vs, ve) + '\nreturn { faCrossoverFromPoints, faProfilePlan };')();

const W = (N) => 2 * N * N * N;
const gpuMs = { 32: 12.1, 128: 12.8, 256: 13.7, 512: 20.8 }, cpuMs = { 32: 0.2, 128: 1.0, 256: 4.9, 512: 27.9 };
const Ns = [32, 128, 256, 512];
const gpuPts = Ns.map((N) => ({ W: W(N), ms: gpuMs[N] })), cpuPts = Ns.map((N) => ({ W: W(N), ms: cpuMs[N] }));

// 1. 交界點由實測點內插
const x = L.faCrossoverFromPoints(gpuPts, cpuPts);
ok(x > 1e8 && x < 2e8, '交界點落在 1e8 到 2e8 flops（實得 ' + x + '，約 N=' + Math.round(Math.cbrt(x / 2)) + '）', x);
ok(Math.abs(x - 1.6e8) < 0.1e8, '內插值約 1.6e8（256 與 512 之間，差距為零的位置）', x);

// 2. 256 卸載、512 不卸載（以交界點判斷）
ok(W(256) < x, '256（' + W(256) + '）在交界點以下 → 卸載給 CPU');
ok(W(512) > x, '512（' + W(512) + '）在交界點以上 → 不卸載');

// 3. 整個 Profile 計畫使用實測交界點（不再是 1.18e7）
const P = L.faProfilePlan({ gpuPts, cpuPts, gpuVariant: 'mm_vec4_f32', cpuCores: 4, decideSplit: HS.decideSplit, shapes: Ns.map((N) => ({ label: N + '×' + N + '×' + N, W: W(N) })) });
ok(P.crossoverFlops > 1e8 && P.crossoverFlops < 2e8, 'faProfilePlan 的 crossoverFlops 來自實測點', P.crossoverFlops);
ok(P.crossoverFlops !== 11807616 && Math.abs(P.crossoverFlops - x) < 1, 'Profile 不再用舊的線性擬合（1.18e7）', P.crossoverFlops);

// 4. 邊界情形
ok(L.faCrossoverFromPoints([{ W: 1e6, ms: 1 }, { W: 1e8, ms: 5 }], [{ W: 1e6, ms: 9 }, { W: 1e8, ms: 9 }]) === 0, 'GPU 在最小點就較快 → 0（永不卸載）');
ok(L.faCrossoverFromPoints([{ W: 1e6, ms: 9 }, { W: 1e8, ms: 9 }], [{ W: 1e6, ms: 1 }, { W: 1e8, ms: 1 }]) === Infinity, 'CPU 在量測範圍內都較快 → Infinity');
ok(L.faCrossoverFromPoints([{ W: 1e6, ms: 9 }], [{ W: 1e6, ms: 1 }]) === null, '點不足 → null（退回擬合）');
ok(L.faCrossoverFromPoints(gpuPts, []) === null, '沒有 CPU 點 → null');

console.log('\n通過 ' + pass + '，失敗 ' + fail);
if (fail) process.exit(1);
