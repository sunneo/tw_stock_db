'use strict';
// hetero_split 測試（node，假裝置＋假 CPU 工作者）：分攤決策公式與退回、列切分、依位置合併、
// 同時執行兩段、GPU 失敗補算、CPU 失敗傳回、取消、無裝置。
const assert = require('assert');
const H = require('./hetero_split.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const COLS = 4;
// 參考結果：第 r 列第 c 欄 = r*10 + c（能看出順序與位置是否正確）
const cell = (r, c) => r * 10 + c;
const rowsData = (start, count) => {
  const out = new Float32Array(count * COLS);
  for (let i = 0; i < count; i++) for (let c = 0; c < COLS; c++) out[i * COLS + c] = cell(start + i, c);
  return out;
};
const refData = (total) => rowsData(0, total);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

(async () => {
  // 1. 決策公式：速率已知、省得夠多 → split；比例在 [0, 0.5]
  {
    const d = H.decideSplit({ work: 100, gpuAvailable: true, cpuAvailable: true, gpuRate: 1, cpuRate: 0.5, gpuOverheadMs: 0, cpuOverheadMs: 0 });
    assert.strictEqual(d.mode, 'split', '省 33% → 切分');
    assert.ok(Math.abs(d.fraction - 1 / 3) < 1e-9, '平衡點應為 1/3，實際 ' + d.fraction);
    assert.ok(d.predictedMs < d.gpuOnlyMs * 0.85, '預測時間應比只給 GPU 快 15% 以上');
    console.log('ok 1 決策公式：平衡點與切分');
  }

  // 2. 省不到 15%（CPU 很慢）→ 全給 GPU
  {
    const d = H.decideSplit({ work: 100, gpuAvailable: true, cpuAvailable: true, gpuRate: 1, cpuRate: 0.01, gpuOverheadMs: 0, cpuOverheadMs: 0 });
    assert.strictEqual(d.mode, 'gpu', 'CPU 太慢，省不到 15% 應全給 GPU');
    assert.strictEqual(d.fraction, 0);
    console.log('ok 2 省不到 margin → 全給 GPU');
  }

  // 3. 比例上限：CPU 很快時 f 被限制在 0.5
  {
    const d = H.decideSplit({ work: 100, gpuAvailable: true, cpuAvailable: true, gpuRate: 1, cpuRate: 100, gpuOverheadMs: 0, cpuOverheadMs: 0 });
    assert.strictEqual(d.mode, 'split');
    assert.ok(Math.abs(d.fraction - 0.5) < 1e-9, '上限 0.5，實際 ' + d.fraction);
    console.log('ok 3 比例上限 0.5');
  }

  // 4. 退回：沒有 WebGPU → 全給 CPU；沒有 CPU 池 → 全給 GPU；都沒有 → none
  {
    assert.deepStrictEqual([H.decideSplit({ work: 10, gpuAvailable: false, cpuAvailable: true, cpuRate: 1 }).mode], ['cpu']);
    assert.deepStrictEqual([H.decideSplit({ work: 10, gpuAvailable: true, cpuAvailable: false, gpuRate: 1 }).mode], ['gpu']);
    assert.deepStrictEqual([H.decideSplit({ work: 10, gpuAvailable: false, cpuAvailable: false }).mode], ['none']);
    console.log('ok 4 無 GPU 退回純 CPU、無 CPU 池全給 GPU');
  }

  // 5. 速率未量測 → 保守地全給 GPU（不切分）
  {
    assert.strictEqual(H.decideSplit({ work: 100, gpuAvailable: true, cpuAvailable: true, gpuRate: 0, cpuRate: 1 }).mode, 'gpu');
    assert.strictEqual(H.decideSplit({ work: 100, gpuAvailable: true, cpuAvailable: true, gpuRate: 1, cpuRate: 0 }).mode, 'gpu');
    assert.strictEqual(H.decideSplit({ work: 100, gpuAvailable: true, cpuAvailable: true, gpuRate: NaN, cpuRate: 1 }).mode, 'gpu', '速率不合理（NaN）當作未量測');
    console.log('ok 5 未量測與速率不合理 → 保守全給 GPU');
  }

  // 6. 固定成本太大 → 不切分
  {
    const d = H.decideSplit({ work: 10, gpuAvailable: true, cpuAvailable: true, gpuRate: 1, cpuRate: 1, gpuOverheadMs: 0, cpuOverheadMs: 50 });
    assert.strictEqual(d.mode, 'gpu', 'CPU 固定成本大於收益，應全給 GPU');
    console.log('ok 6 固定成本使切分不划算');
  }

  // 7. 列切分：覆蓋整個範圍、不重不漏、GPU 在前、CPU 在後，且至少給 GPU 一列
  {
    for (const [total, f] of [[10, 0], [10, 0.3], [10, 0.5], [7, 0.5], [1, 0.5], [0, 0.5]]) {
      const r = H.splitRows(total, f);
      assert.strictEqual(r.gpuStart, 0);
      assert.strictEqual(r.gpuCount + r.cpuCount, total, total + '/' + f + ' 應覆蓋全部列');
      assert.strictEqual(r.cpuStart, r.gpuCount, 'CPU 段接在 GPU 段之後');
      if (total > 0) assert.ok(r.gpuCount >= 1, '至少給 GPU 一列');
    }
    assert.deepStrictEqual(H.splitRows(10, 0.3), { gpuStart: 0, gpuCount: 7, cpuStart: 7, cpuCount: 3 });
    console.log('ok 7 列切分覆蓋與順序');
  }

  // 8. 合併：依位置排好；缺口或重疊會丟錯
  {
    const parts = [{ start: 3, count: 2, data: rowsData(3, 2) }, { start: 0, count: 3, data: rowsData(0, 3) }];
    assert.ok(same(H.mergeParts(5, COLS, parts), refData(5)), '亂序的段應依位置合併');
    assert.throws(() => H.mergeParts(5, COLS, [{ start: 0, count: 2, data: rowsData(0, 2) }, { start: 3, count: 2, data: rowsData(3, 2) }]), /缺口或重疊/, '缺口要丟錯');
    assert.throws(() => H.mergeParts(4, COLS, [{ start: 0, count: 3, data: rowsData(0, 3) }, { start: 2, count: 2, data: rowsData(2, 2) }]), /缺口或重疊/, '重疊要丟錯');
    assert.throws(() => H.mergeParts(3, COLS, [{ start: 0, count: 2, data: rowsData(0, 2) }]), /只覆蓋到/, '覆蓋不足要丟錯');
    assert.throws(() => H.mergeParts(2, COLS, [{ start: 0, count: 2, data: new Float32Array(3) }]), /長度不符/, '長度不符要丟錯');
    console.log('ok 8 合併順序與錯誤檢查');
  }

  // 9. split 執行：兩段同時跑，合併結果等於參考結果
  {
    let running = 0, maxRunning = 0;
    const gpuPart = async (s, n) => { running++; maxRunning = Math.max(maxRunning, running); await delay(5); running--; return rowsData(s, n); };
    const cpuPart = async (s, n) => { running++; maxRunning = Math.max(maxRunning, running); await delay(5); running--; return rowsData(s, n); };
    const d = H.decideSplit({ work: 100, gpuAvailable: true, cpuAvailable: true, gpuRate: 1, cpuRate: 0.5 });
    const r = await H.runSplit({ total: 12, cols: COLS, decision: d, gpuPart, cpuPart });
    assert.ok(same(r.data, refData(12)), '切分結果應等於參考結果');
    assert.strictEqual(r.info.mode, 'split');
    assert.ok(maxRunning >= 2, '兩段應同時執行');
    console.log('ok 9 切分執行與合併（兩段同時跑）');
  }

  // 10. GPU 段失敗：由 CPU 補算那些列，結果仍正確，並記錄退回原因
  {
    const gpuPart = async () => { await delay(2); throw new Error('GPU 掉了'); };
    const cpuPart = async (s, n) => { await delay(2); return rowsData(s, n); };
    const decision = { mode: 'split', fraction: 0.5, reason: 'test' };
    const r = await H.runSplit({ total: 6, cols: COLS, decision, gpuPart, cpuPart });
    assert.ok(same(r.data, refData(6)), 'GPU 失敗後結果仍應正確');
    assert.strictEqual(r.info.fallback, 'gpu-error');
    assert.match(r.info.fallbackReason, /GPU 掉了/);
    // 整份給 GPU 失敗也一樣
    const r2 = await H.runSplit({ total: 4, cols: COLS, decision: { mode: 'gpu' }, gpuPart, cpuPart });
    assert.ok(same(r2.data, refData(4)));
    assert.strictEqual(r2.info.fallback, 'gpu-error');
    console.log('ok 10 GPU 失敗由 CPU 補算、記錄原因');
  }

  // 11. CPU 段失敗：整個運算丟錯（回傳第一個錯誤），而且 GPU 段在丟錯前已經結束
  {
    let gpuFinished = false;
    const gpuPart = async (s, n) => { await delay(8); gpuFinished = true; return rowsData(s, n); };
    const cpuPart = async () => { await delay(1); throw new Error('CPU 壞了'); };
    await assert.rejects(H.runSplit({ total: 8, cols: COLS, decision: { mode: 'split', fraction: 0.5 }, gpuPart, cpuPart }), /CPU 壞了/);
    assert.strictEqual(gpuFinished, true, '丟錯前 GPU 段應已結束');
    console.log('ok 11 CPU 段失敗傳回、等另一段結束');
  }

  // 12. 取消：開始前已取消 → 不呼叫任何段；執行中取消 → 等兩段結束後丟 AbortError
  {
    const ac = new AbortController(); ac.abort();
    let calls = 0;
    const f = async (s, n) => { calls++; return rowsData(s, n); };
    await assert.rejects(H.runSplit({ total: 4, cols: COLS, decision: { mode: 'split', fraction: 0.5 }, gpuPart: f, cpuPart: f, signal: ac.signal }), (e) => e.name === 'AbortError');
    assert.strictEqual(calls, 0, '已取消時不應呼叫任何段');
    const ac2 = new AbortController();
    const slow = async (s, n) => { await delay(5); return rowsData(s, n); };
    const p = H.runSplit({ total: 4, cols: COLS, decision: { mode: 'split', fraction: 0.5 }, gpuPart: slow, cpuPart: slow, signal: ac2.signal });
    ac2.abort();
    await assert.rejects(p, (e) => e.name === 'AbortError');
    console.log('ok 12 取消（開始前與執行中）');
  }

  // 13. 無裝置 → 丟錯；cpu 模式的錯誤照實丟出
  {
    await assert.rejects(H.runSplit({ total: 2, cols: COLS, decision: { mode: 'none', reason: 'x' }, gpuPart: async () => null, cpuPart: async () => null }), /沒有可用的裝置/);
    await assert.rejects(H.runSplit({ total: 2, cols: COLS, decision: { mode: 'cpu' }, gpuPart: async () => null, cpuPart: async () => { throw new Error('CPU 單獨壞'); } }), /CPU 單獨壞/);
    console.log('ok 13 無裝置與 cpu 模式錯誤');
  }

  // 14. 保守閘：總收益 20%（扣掉 15% margin 後淨 5%，低於 10%）→ 全給 GPU；總收益 33%（淨 18%）→ 切分
  {
    const low = H.decideSplit({ work: 100, gpuAvailable: true, cpuAvailable: true, gpuRate: 1, cpuRate: 0.25, gpuOverheadMs: 0, cpuOverheadMs: 0 });
    assert.strictEqual(low.mode, 'gpu', '淨收益 5% 應全給 GPU（實際 ' + low.mode + '，saving=' + low.saving + '）');
    assert.match(low.reason, /低於 10%/);
    const high = H.decideSplit({ work: 100, gpuAvailable: true, cpuAvailable: true, gpuRate: 1, cpuRate: 0.5, gpuOverheadMs: 0, cpuOverheadMs: 0 });
    assert.strictEqual(high.mode, 'split', '淨收益 18% 應切分');
    assert.ok(high.net >= H.NET_MIN - 1e-9);
    console.log('ok 14 保守閘（淨收益低於 10% 全給 GPU）');
  }

  // 15. 實測段耗時回饋：CPU 段比 GPU 段慢 → 比例往下修；CPU 快 → 往上修；資料不足或超出上限時的行為
  {
    const down = H.feedbackFraction(0.08, 17.8, 21.5);
    assert.ok(down < 0.08, 'CPU 段慢，比例應下修（實際 ' + down + '）');
    // 兩段實測相等時，比例應該不變（平衡點）
    const same = H.feedbackFraction(0.2, 10, 10);  // 兩段耗時相等時，平衡點就是原比例 0.2（kc·f = kg·(1−f)）
    assert.ok(Math.abs(same - 0.2) < 1e-9, '平衡時比例不變（實際 ' + same + '）');
    const up = H.feedbackFraction(0.1, 5, 1);
    assert.ok(up > 0.1, 'CPU 很快，比例應上修（實際 ' + up + '）');
    assert.ok(H.feedbackFraction(0.4, 1, 0.0001) <= H.MAX_CPU_FRAC + 1e-9, '不超過上限');
    assert.strictEqual(H.feedbackFraction(0.05, 0.001, 100), 0, 'CPU 段極慢（GPU 段極快），算出來不到 2% 就取 0');
    assert.strictEqual(H.feedbackFraction(0.3, 0, 5), 0.3, '段耗時為 0 時資料不足，保留原比例');
    assert.strictEqual(H.feedbackFraction(0, 5, 5), 0, '原比例為 0 時保持 0');
    console.log('ok 15 段耗時回饋');
  }

  console.log('hetero_split：全部通過');
})().catch((e) => { console.error('失敗：', (e && e.stack) || e); process.exit(1); });
