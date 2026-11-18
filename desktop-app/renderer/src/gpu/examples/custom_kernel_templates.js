// 範例：使用 cudaweb 的自訂核心樣板（reduce、transpose、scan）。
// 用法（node）：node renderer/src/gpu/examples/custom_kernel_templates.js
// 這個範例只在 node 上跑：先依能力表選參數，產生 WGSL 文字，再用 CPU 參考與索引模擬比對。
// 它不會派發到真 GPU；WGSL 在真 GPU 上未驗證（見 docs/CHECKLIST.cudaweb-optimize.md O14c）。
'use strict';
const T = require('../kernel_templates.js');

// 低階卡（像這台 Kepler 14 W）的能力表：256 執行緒、16 KiB 共用記憶體。換成別張卡時改用 adapter.limits 的真值。
const caps = { maxInvocations: 256, maxWgStorage: 16384 };
const p = T.pickParams(caps);
console.log('參數：工作群組 ' + p.wg + '、轉置分塊 ' + p.tile + '、掃描步數 ' + p.stepsScan);

// 1. reduce：產生分層歸約的 WGSL，並對 CPU 參考比對（模擬的是同一套索引與屏障階段）。
const data = [];
for (let i = 1; i <= 1000; i++) data.push(i);
console.log('--- reduce ---');
console.log('WGSL 行數：' + T.reduceWgsl('sum', p.wg).split('\n').length);
console.log('sum(1..1000) 模擬 = ' + T.simReduce('sum', data, p.wg) + '，參考 = ' + T.reduceRef('sum', data));
console.log('max = ' + T.simReduce('max', data, p.wg) + '，min = ' + T.simReduce('min', data, p.wg));

// 2. transpose：共用記憶體分塊；3×5 的矩陣跨過分塊邊界也要正確。
console.log('--- transpose ---');
const A = [];
for (let i = 0; i < 15; i++) A.push(i);
const got = T.simTranspose(A, 3, 5, p.tile);
console.log('輸入 3×5，輸出 5×3 前 6 個 = ' + got.slice(0, 6).join(', ') + '，與參考相同：' + (JSON.stringify(got) === JSON.stringify(T.transposeRef(A, 3, 5))));

// 3. scan：包含式前綴和；70000 個元素需要遞迴的區塊總和掃描。
console.log('--- scan ---');
const small = [1, 2, 3, 4];
console.log('前綴和 [1,2,3,4] = ' + T.simScan(small, p.wg).join(', '));
const big = new Array(70000).fill(1);
const scanned = T.simScan(big, p.wg);
console.log('70000 個 1 的前綴和最後一個 = ' + scanned[scanned.length - 1] + '（應為 70000）');

// 4. 效能：未量測。這個範例只驗證主機端流程，優化前後的時間要在真 GPU 上量（標硬體）。
console.log('效能：未在 GPU 上量測（本範例只跑 CPU 模擬）。');
