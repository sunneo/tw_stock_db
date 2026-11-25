// 全螢幕 GUI 頁的 MIDI 編輯器撐滿：每拍寬與列高依容器大小算（fillMetrics 純函式）。
// 執行：node renderer/src/music/midi_editor_fill.test.js
'use strict';
const assert = require('assert');
const { fillMetrics } = require('./midi_editor_ui.js');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.log('FAIL', name, e.message); } }

t('容器夠大：整首曲子剛好塞滿寬、36 列剛好塞滿高', () => {
  const m = fillMetrics(1600, 720, 36, 100);
  assert.strictEqual(m.pxBeat, 16);          // 1600 / 100 拍
  assert.strictEqual(m.rowH, 20);            // 720 / 36 列
});

t('列高有下限 10px、每拍寬有下限 4px（太小的容器靠捲軸，不擠成看不見）', () => {
  const m = fillMetrics(10, 10, 36, 1000);
  assert.strictEqual(m.pxBeat, 4);
  assert.strictEqual(m.rowH, 10);
});

t('容器高度隨大小等比縮放（視窗縮放時重算）', () => {
  const small = fillMetrics(800, 360, 36, 50), big = fillMetrics(1600, 720, 36, 50);
  assert.strictEqual(big.rowH, small.rowH * 2);
  assert.strictEqual(big.pxBeat, small.pxBeat * 2);
});

t('曲子長度 0 也不會除以零', () => {
  const m = fillMetrics(1000, 500, 0, 0);
  assert.ok(Number.isFinite(m.pxBeat) && Number.isFinite(m.rowH));
});

console.log(`midi 編輯器撐滿測試：${pass} 通過、${fail} 失敗`);
if (fail) process.exit(1);
