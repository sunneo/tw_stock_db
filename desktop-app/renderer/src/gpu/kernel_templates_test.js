// kernel_templates_test.js — cudaweb 自訂核心樣板的 node 測試（O14c）。
// 驗證：能力選參數、WGSL 產生內容（標記、工作群組大小、共用記憶體大小）、CPU 參考與 JS 索引模擬逐項一致。
// 注意：這裡不跑 WGSL；模擬只驗主機端的索引與階段邏輯。真 GPU 上的 WGSL 結果未驗證。
'use strict';
const assert = require('assert');
const T = require('./kernel_templates.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '：' + (e && e.message)); }
}
function seeded(n, seed) {
  let s = seed >>> 0 || 1; const out = new Array(n);
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out[i] = (s / 4294967296) * 2 - 1; }
  return out;
}
function maxAbsDiff(a, b) { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; }

check('pickParams：低階（256 執行緒、16 KiB）選 wg=256、分塊 16', () => {
  const p = T.pickParams({ maxInvocations: 256, maxWgStorage: 16384 });
  assert.deepStrictEqual(p, { wg: 256, tile: 16, stepsScan: 8 });
});
check('pickParams：高階（1024 執行緒、48 KiB）仍用 wg=256 上限、分塊 16', () => {
  const p = T.pickParams({ maxInvocations: 1024, maxWgStorage: 49152 });
  assert.strictEqual(p.wg, 256); assert.strictEqual(p.tile, 16);
});
check('pickParams：共用記憶體 512 位元組時分塊縮小為 8（16 需要 1088 位元組，8 需要 288）', () => {
  const p = T.pickParams({ maxInvocations: 256, maxWgStorage: 512 });
  assert.strictEqual(p.tile, 8);
});
check('pickParams：軟體 adapter（1 執行緒）退到 wg=1、分塊 1', () => {
  const p = T.pickParams({ maxInvocations: 1, maxWgStorage: 4 });
  assert.deepStrictEqual(p, { wg: 1, tile: 1, stepsScan: 0 });
});
check('pickParams：非法能力值直接丟錯並寫明收到的值', () => {
  assert.throws(() => T.pickParams({ maxInvocations: 0, maxWgStorage: 16384 }), /maxInvocations.*收到 0/);
  assert.throws(() => T.pickParams(null), /caps 必須是物件/);
});

check('reduce：CPU 模擬與參考一致（sum、max、min；大小含 0 以外的邊界與跨多層）', () => {
  for (const wg of [1, 2, 64, 256]) {
    for (const n of [1, 2, 63, 255, 256, 257, 1000, 70000]) {
      const a = seeded(n, 11 + n + wg);
      const sum = T.simReduce('sum', a, wg), sumRef = T.reduceRef('sum', a);
      // f32 逐步累加與雙精度參考的差：容差隨 n 放寬（實測量級約 1e-6×√n）
      assert.ok(Math.abs(sum - sumRef) <= 1e-5 * Math.max(1, Math.sqrt(n)), 'sum wg=' + wg + ' n=' + n + ' 差 ' + Math.abs(sum - sumRef));
      assert.strictEqual(T.simReduce('max', a, wg), T.reduceRef('max', a), 'max wg=' + wg + ' n=' + n);
      assert.strictEqual(T.simReduce('min', a, wg), T.reduceRef('min', a), 'min wg=' + wg + ' n=' + n);
    }
  }
});
check('reduce：空陣列回傳單位元（sum 0、max 最小有限值、min 最大有限值）', () => {
  assert.strictEqual(T.simReduce('sum', [], 256), 0);
  assert.strictEqual(T.simReduce('max', [], 256), -3.4028234663852886e38);
  assert.strictEqual(T.simReduce('min', [], 256), 3.4028234663852886e38);
});
check('reduce：分層的每層工作群組數（70000 元素、wg=256 → 256 組 → 1 組；257 → 2 組 → 1 組）', () => {
  assert.strictEqual(T.reduceGroups(70000, 256), 256);
  assert.strictEqual(T.reduceGroups(256 * 256, 256), 256);
  assert.strictEqual(T.reduceGroups(257, 256), 2);
  assert.strictEqual(T.reduceGroups(2, 256), 1);
});
check('reduce：WGSL 是分層（每執行緒跨步＋共用記憶體樹狀歸約），不是單執行緒', () => {
  const src = T.reduceWgsl('sum', 256);
  assert.ok(src.includes('// @kernel reduce_sum'));
  assert.ok(src.includes('@compute @workgroup_size(256)'));
  assert.ok(src.includes('array<f32, 256>'));
  assert.ok(src.includes('let stride: u32 = 256u * nwg.x;'), '缺跨步累加');
  assert.ok(src.includes('workgroupBarrier()'), '缺屏障');
  assert.ok(src.includes('s = s / 2u;'), '缺樹狀歸約');
});
check('reduce：max、min 的 WGSL 用 max／min 合併，單位元正確', () => {
  assert.ok(T.reduceWgsl('max', 64).includes('max(a, b)'));
  assert.ok(T.reduceWgsl('min', 64).includes('min(a, b)'));
  assert.ok(T.reduceWgsl('max', 64).includes('-3.4028234663852886e38'));
});
check('reduce：非法參數丟錯（非 2 的冪次工作群組、未知運算）', () => {
  assert.throws(() => T.reduceWgsl('sum', 100), /2 的冪次，收到 100/);
  assert.throws(() => T.reduceWgsl('prod', 64), /不支援的運算 prod/);
  assert.throws(() => T.simReduce('sum', [1], 3), /2 的冪次，收到 3/);
});

check('transpose：CPU 模擬與參考逐元素相同（跨多個分塊邊界、非整除形狀、各分塊大小）', () => {
  for (const tile of [16, 8, 4, 1]) {
    for (const [m, n] of [[1, 1], [5, 7], [33, 17], [16, 16], [17, 31], [50, 3]]) {
      const A = seeded(m * n, 70 + m * 3 + n);
      assert.deepStrictEqual(T.simTranspose(A, m, n, tile), T.transposeRef(A, m, n), 'tile=' + tile + ' ' + m + '×' + n);
    }
  }
});
check('transpose：WGSL 的分塊與共用記憶體大小（16：272 個元素，列寬 17）', () => {
  const src = T.transposeWgsl(16);
  assert.ok(src.includes('// @kernel transpose_tile'));
  assert.ok(src.includes('@compute @workgroup_size(16, 16)'));
  assert.ok(src.includes('var<workgroup> tile: array<f32, 272>;'));
  assert.ok(src.includes('tile[lid.y * 17u + lid.x]'));
  assert.ok(src.includes('workgroupBarrier()'));
  assert.strictEqual(16 * 17 * 4, 1088, '共用記憶體位元組數');
});
check('transpose：非法參數丟錯，長度不符丟錯', () => {
  assert.throws(() => T.transposeWgsl(0), /≥1 的整數/);
  assert.throws(() => T.transposeRef([1, 2, 3], 2, 2), /元素數 3 與 m×n=4 不符/);
});

check('scan：CPU 模擬與參考一致（n 含 0、1、單區塊、多區塊、需要遞迴的 70000；wg=256、64、2）', () => {
  for (const wg of [256, 64, 2]) {
    for (const n of [0, 1, 5, 255, 256, 257, 300, 70000]) {
      const a = seeded(n, 90 + n + wg);
      const got = T.simScan(a, wg), ref = T.scanRef(a);
      assert.strictEqual(got.length, n);
      // 同 gpu_core.test.js 的容差：n=70000 的 f32 區塊前綴和實測誤差約 1e-4 量級
      if (n) assert.ok(maxAbsDiff(got, ref) <= 5e-4, 'scan wg=' + wg + ' n=' + n + ' 最大差 ' + maxAbsDiff(got, ref));
    }
  }
});
check('scan：WGSL 的 Hillis–Steele 步數等於 log2(wg)，並寫出區塊總和', () => {
  const src = T.scanWgsl(256);
  assert.ok(src.includes('// @kernel scan_block_256'));
  assert.ok(src.includes('k < 8u'));
  assert.ok(src.includes('BSUM[wid.x] = s[255]'));
  assert.ok(T.scanWgsl(64).includes('k < 6u'));
  assert.throws(() => T.scanWgsl(96), /2 的冪次/);
  assert.throws(() => T.scanWgsl(1), /≥2 的 2 的冪次，收到 1/);
  assert.throws(() => T.simScan([1, 2], 1), /≥2/);
});

console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
if (fail) process.exitCode = 1;
