// node renderer/src/gpu/variant_table_test.js — 變體競賽表的純函式測試（G5，不需要 GPU）
'use strict';
const assert = require('assert');
const VT = require('./variant_table.js');

let pass = 0;
function t(name, fn) { try { fn(); pass++; console.log('ok  ' + name); } catch (e) { console.log('FAIL ' + name + '：' + ((e && e.stack) || e)); process.exitCode = 1; } }

const V = [{ id: 'mm_simple_f32' }, { id: 'mm_tiled_f32' }, { id: 'mm_vec4_f32' }];

t('parseShape：合法與不合法', () => {
  assert.deepStrictEqual(VT.parseShape('64x1024x1024'), { M: 64, K: 1024, N: 1024 });
  assert.strictEqual(VT.parseShape('0x1x1'), null);
  assert.strictEqual(VT.parseShape('abc'), null);
  assert.strictEqual(VT.parseShape(null), null);
});

t('gflopsOf：2MKN ÷ 時間，無效回 null', () => {
  // 64×1024×1024 → 2·64·1024·1024 = 134217728 FLOP；10 ms → 13.4217728 GFLOP/s
  const g = VT.gflopsOf({ M: 64, K: 1024, N: 1024 }, 10);
  assert.ok(Math.abs(g - 13.4217728) < 1e-6, String(g));
  assert.strictEqual(VT.gflopsOf({ M: 1, K: 1, N: 1 }, 0), null);
  assert.strictEqual(VT.gflopsOf({ M: 1, K: 1, N: 1 }, NaN), null);
});

t('median：奇數、偶數、空陣列', () => {
  assert.strictEqual(VT.median([3, 1, 2]), 2);
  assert.strictEqual(VT.median([4, 1, 3, 2]), 2.5);
  assert.strictEqual(VT.median([]), null);
});

t('rowsFor：本機實測列有 GFLOP/s、勝者標示、驗證狀態', () => {
  const rows = VT.rowsFor({
    shape: '64x1024x1024', variants: V,
    timings: { mm_simple_f32: [20, 22, 21], mm_tiled_f32: [10, 12, 11] },
    bad: [{ id: 'mm_vec4_f32', reason: '相對誤差 0.3' }],
    winnerId: 'mm_tiled_f32', priorsRank: [], priorsSource: null, peak: null,
  });
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].source, '本機實測');
  assert.strictEqual(rows[0].medianMs, 21);
  assert.strictEqual(rows[1].winner, true);
  assert.strictEqual(rows[0].winner, false);
  assert.strictEqual(rows[2].correct, false);
  assert.strictEqual(rows[2].source, '未量測');
  assert.strictEqual(rows[2].gflops, null);
  assert.strictEqual(rows[0].compileMs, null);
  assert.strictEqual(rows[0].pctPeak, null, '沒有峰值時不算百分比');
});

t('rowsFor：有峰值才算占峰值百分比', () => {
  const peak = VT.peakFor('wg16384-inv256-f160-sg0');
  assert.ok(peak && peak.gflops > 0);
  const rows = VT.rowsFor({ shape: '512x1024x1024', variants: [{ id: 'a' }], timings: { a: [10] }, winnerId: 'a', peak: peak });
  const g = VT.gflopsOf({ M: 512, K: 1024, N: 1024 }, 10);
  assert.ok(Math.abs(rows[0].pctPeak - (g / 127.5) * 100) < 1e-9);
});

t('rowsFor：只有預先剖析、沒有本機量測 → 標示推估或實測來源，不算 GFLOP/s', () => {
  const rows = VT.rowsFor({ shape: '64x1024x1024', variants: V, timings: {}, bad: [], winnerId: null, priorsRank: ['mm_tiled_f32'], priorsSource: 'heuristic' });
  assert.strictEqual(rows[1].source, '預先剖析（推估）');
  assert.strictEqual(rows[1].gflops, null);
  assert.strictEqual(rows[1].correct, null);
  assert.strictEqual(rows[0].source, '未量測');
});

t('summaryOf：沒有勝者說未量測；有勝者說快多少', () => {
  assert.strictEqual(VT.summaryOf([{ winner: false }]), '未量測（沒有勝者）');
  const rows = VT.rowsFor({ shape: '64x1024x1024', variants: V, timings: { mm_simple_f32: [20], mm_tiled_f32: [10] }, winnerId: 'mm_tiled_f32' });
  const s = VT.summaryOf(rows);
  assert.ok(s.indexOf('勝者 mm_tiled_f32') === 0, s);
  assert.ok(s.indexOf('快 100%') >= 0, s);
});

console.log('variant_table_test：' + pass + ' 項通過');
