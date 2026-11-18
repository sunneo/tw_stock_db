'use strict';
// cudaweb 異質排程器的純邏輯（設計見 docs/DESIGN.cudaweb-hetero.md 第 2、7 節）：
// 分攤決策（公式）、列切分、依位置合併、執行（同時跑 GPU 段與 CPU 段，含退回與取消）。
// 不碰 WebGPU、Worker、IndexedDB；裝置由呼叫端以 gpuPart／cpuPart 注入。

const MAX_CPU_FRAC = 0.5;   // CPU 最多分擔一半（與 cpu_share 的 MAX_CPU_RATIO 一致）
const MARGIN = 0.15;        // 切分至少要比只給 GPU 快 15%，否則全給 GPU（保守）
const NET_MIN = 0.10;       // 保守閘：扣掉 margin 後的淨收益要至少 10%（也就是切分總共要省 25%）

// 實測段耗時回饋：上一次的比例 f、GPU 段與 CPU 段實測毫秒（GPU 段 = (1−f) 的列，CPU 段 = f 的列），
// 假設各段時間與各自的列數成正比，算出讓兩段耗時相等的新比例。CPU 段慢 → 比例往下修；快 → 往上修。
// 結果限制在 [0, maxF]；小於 2% 直接取 0（不值得分攤）。資料不足（段耗時非正）時回傳原比例。
function feedbackFraction(f, gpuSegMs, cpuSegMs, maxF) {
  const cap = maxF == null ? MAX_CPU_FRAC : Number(maxF);
  const x = Number(f) || 0;
  const tg = Number(gpuSegMs), tc = Number(cpuSegMs);
  if (!(x > 0 && x < 1) || !(tg > 0) || !(tc > 0)) return x;
  const kc = tc / x;            // CPU 每單位比例的耗時
  const kg = tg / (1 - x);      // GPU 每單位比例的耗時
  let nf = kg / (kc + kg);      // 讓 kc·f = kg·(1−f) 的 f
  nf = Math.min(cap, Math.max(0, nf));
  return nf < 0.02 ? 0 : nf;
}

// 分攤決策。
// o: { work, gpuAvailable, cpuAvailable, gpuRate, cpuRate, gpuOverheadMs, cpuOverheadMs, margin?, maxCpuFrac?, minCpuMs? }
//   work：運算量（單位要和速率一致，例如 flops 或元素數）
//   gpuRate／cpuRate：單位／毫秒；0 或沒有＝尚未量測
// 回傳 { mode: 'none'|'gpu'|'cpu'|'split', fraction, predictedMs?, gpuOnlyMs?, reason }
function decideSplit(o) {
  o = o || {};
  const W = Number(o.work) || 0;
  const gA = !!o.gpuAvailable, cA = !!o.cpuAvailable;
  const g = Number(o.gpuRate) || 0, c = Number(o.cpuRate) || 0;
  const go = Math.max(0, Number(o.gpuOverheadMs) || 0);
  const co = Math.max(0, Number(o.cpuOverheadMs) || 0);
  const margin = o.margin == null ? MARGIN : Number(o.margin);
  const maxF = o.maxCpuFrac == null ? MAX_CPU_FRAC : Number(o.maxCpuFrac);
  if (W <= 0) return { mode: 'none', fraction: 0, reason: '沒有運算量' };
  if (!gA && !cA) return { mode: 'none', fraction: 0, reason: '沒有可用的裝置（沒有 WebGPU，也沒有 CPU 池）' };
  if (!gA) return { mode: 'cpu', fraction: 1, reason: '沒有 WebGPU，全部給 CPU' };
  if (!cA) return { mode: 'gpu', fraction: 0, reason: '沒有 CPU 池，全部給 GPU' };
  if (!(g > 0)) return { mode: 'gpu', fraction: 0, reason: 'GPU 速率尚未量測，保守地全給 GPU' };
  if (!(c > 0)) return { mode: 'gpu', fraction: 0, reason: 'CPU 速率尚未量測，保守地全給 GPU' };
  const G = W / g, C = W / c;            // 整份運算在 GPU、CPU 上各自的純計算時間（毫秒）
  const gpuOnlyMs = go + G;
  // 平衡點：(1−f)G + go = fC + co
  let f = (G + go - co) / (G + C);
  if (!(f > 0)) return { mode: 'gpu', fraction: 0, gpuOnlyMs, reason: '固定成本使 CPU 分到的部分不划算，全給 GPU' };
  f = Math.min(f, maxF);
  const minCpuMs = o.minCpuMs == null ? 2 * co : Number(o.minCpuMs);
  const cpuSegMs = f * C + co;
  if (f * C < minCpuMs) return { mode: 'gpu', fraction: 0, gpuOnlyMs, reason: 'CPU 段太小，固定成本划不來，全給 GPU' };
  const predictedMs = Math.max((1 - f) * G + go, cpuSegMs);
  // 保守閘：預估收益（已扣固定成本）減去 margin 後，要至少 NET_MIN；否則全給 GPU
  const saving = (gpuOnlyMs - predictedMs) / gpuOnlyMs;
  const net = saving - margin;
  if (net < NET_MIN) return { mode: 'gpu', fraction: 0, gpuOnlyMs, predictedMs, saving, net, reason: '扣掉 margin 後淨收益 ' + Math.round(net * 100) + '%，低於 ' + Math.round(NET_MIN * 100) + '%，全給 GPU' };
  return { mode: 'split', fraction: f, predictedMs, gpuOnlyMs, saving, net, reason: '切分預測省 ' + Math.round(saving * 100) + '%（淨 ' + Math.round(net * 100) + '%）' };
}

// 依列切分：GPU 拿前面的列，CPU 拿後面的列（與 cpu_share 相同的順序）。至少給 GPU 一列。
function splitRows(total, fraction) {
  const t = Math.max(0, Math.floor(Number(total) || 0));
  let cpuRows = Math.floor(t * Math.max(0, Math.min(1, Number(fraction) || 0)));
  if (cpuRows >= t) cpuRows = Math.max(0, t - 1);
  if (cpuRows < 1) cpuRows = 0;
  const gpuRows = t - cpuRows;
  return { gpuStart: 0, gpuCount: gpuRows, cpuStart: gpuRows, cpuCount: cpuRows };
}

// 合併：parts = [{ start, count, data }]（data 長度 = count·cols）。必須正好覆蓋 [0, total)，不重不漏，否則丟錯。
function mergeParts(total, cols, parts) {
  const T = Math.floor(total), C = Math.floor(cols);
  const sorted = Array.from(parts || []).slice().sort((a, b) => a.start - b.start);
  const out = new Float32Array(T * C);
  let pos = 0;
  for (const p of sorted) {
    if (p.start !== pos) throw new Error('合併失敗：第 ' + pos + ' 列之後的段從 ' + p.start + ' 開始（有缺口或重疊）');
    if (p.data.length !== p.count * C) throw new Error('合併失敗：段 ' + p.start + ' 的長度不符');
    out.set(p.data, p.start * C);
    pos += p.count;
  }
  if (pos !== T) throw new Error('合併失敗：段只覆蓋到第 ' + pos + ' 列，共 ' + T + ' 列');
  return out;
}

function settle(p) {
  return Promise.resolve(p).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
}

function abortError() { const e = new Error('已取消'); e.name = 'AbortError'; return e; }

// 執行一次分攤運算。
// o: { total, cols, decision, gpuPart(start, count) → Promise<Float32Array>, cpuPart(start, count) → Promise<Float32Array>, signal? }
// 回傳 { data: Float32Array, info: { mode, fraction, gpuRows, cpuRows, fallback?, fallbackReason? } }
// - mode 'gpu'：整份給 GPU；GPU 失敗就整份改由 CPU 算（fallback: 'gpu-error'）。
// - mode 'cpu'：整份給 CPU；失敗就丟錯。
// - mode 'split'：兩段同時跑；GPU 段失敗就由 CPU 補算那些列；CPU 段失敗就丟錯（兩段都結束後才丟，第一個錯誤）。
// - 取消：開始前已取消就丟 AbortError；執行中取消則等兩段結束後丟 AbortError（在飛中的段不會被強制中止）。
async function runSplit(o) {
  const total = Math.floor(o.total), cols = Math.floor(o.cols);
  const d = o.decision || {};
  const signal = o.signal;
  if (signal && signal.aborted) throw abortError();
  if (d.mode === 'none') throw new Error('沒有可用的裝置：' + (d.reason || ''));
  const gpuPart = o.gpuPart, cpuPart = o.cpuPart;
  if (total <= 0) return { data: new Float32Array(0), info: { mode: d.mode, fraction: 0, gpuRows: 0, cpuRows: 0 } };
  const finish = (data, info) => {
    if (signal && signal.aborted) throw abortError();
    return { data, info };
  };
  if (d.mode === 'cpu') {
    const data = await cpuPart(0, total);
    return finish(data, { mode: 'cpu', fraction: 1, gpuRows: 0, cpuRows: total });
  }
  if (d.mode === 'gpu') {
    const r = await settle(gpuPart(0, total));
    if (r.ok) return finish(r.value, { mode: 'gpu', fraction: 0, gpuRows: total, cpuRows: 0 });
    const data = await cpuPart(0, total);
    return finish(data, { mode: 'gpu', fraction: 0, gpuRows: 0, cpuRows: total, fallback: 'gpu-error', fallbackReason: String((r.error && r.error.message) || r.error) });
  }
  // split
  const rows = splitRows(total, d.fraction);
  const gP = rows.gpuCount > 0 ? settle(gpuPart(rows.gpuStart, rows.gpuCount)) : Promise.resolve({ ok: true, value: new Float32Array(0) });
  const cP = rows.cpuCount > 0 ? settle(cpuPart(rows.cpuStart, rows.cpuCount)) : Promise.resolve({ ok: true, value: new Float32Array(0) });
  const [gr, cr] = await Promise.all([gP, cP]);
  if (!cr.ok) throw cr.error;   // CPU 段失敗：整個運算失敗（GPU 段已經結束）
  let gpuData, info = { mode: 'split', fraction: d.fraction, gpuRows: rows.gpuCount, cpuRows: rows.cpuCount };
  if (gr.ok) gpuData = gr.value;
  else {
    // GPU 段失敗：由 CPU 補算那些列
    gpuData = await cpuPart(rows.gpuStart, rows.gpuCount);
    info = Object.assign(info, { fallback: 'gpu-error', fallbackReason: String((gr.error && gr.error.message) || gr.error) });
  }
  const merged = mergeParts(total, cols, [
    { start: rows.gpuStart, count: rows.gpuCount, data: gpuData },
    { start: rows.cpuStart, count: rows.cpuCount, data: cr.value },
  ]);
  return finish(merged, info);
}

module.exports = { decideSplit, splitRows, mergeParts, runSplit, feedbackFraction, MAX_CPU_FRAC, MARGIN, NET_MIN };
