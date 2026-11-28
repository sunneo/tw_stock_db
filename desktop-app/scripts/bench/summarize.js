#!/usr/bin/env node
'use strict';
// 把 cudaweb（gen_step_bench_eval 的評估結果）與 cpu-py（bench_cpu_py_steps 的輸出）合成一份可貼回的 Markdown 摘要。
// 用法：node scripts/bench/summarize.js <gpu.json> <cpu.json> [--peak-tflops 0.3] [--bw-gbs 14] [--out 摘要.md]
//   gpu.json：{ backend, adapter, sizes:[{size,cfg,msMedian,...}] }（評估的 result，去掉外層 eval-file 行）
//   cpu.json：{ backend, host, sizes:[{size,cfg,msMedian,...}] }
// 摘要內容：轉接器資訊、各規模 cudaweb／cpu-py 的 ms/步、tokens/s（批次 1 條序列，每步 T 個詞元）、屋頂線預測與實測比、
//           固定開銷（由 S 規模反推）、有效 GFLOP/s（由兩個最大規模的斜率推）與交叉點（模型大到多少 cudaweb 才贏 cpu-py）。
const fs = require('fs');
const { roofline } = require('./sizes.js');

function arg(name, dflt) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; }

// 純函式：合併與計算（測試用）
function summarize(gpu, cpu, peak) {
  const rows = [];
  for (const g of gpu.sizes) {
    const c = (cpu.sizes || []).find((x) => x.size === g.size) || {};
    const rf = roofline(g.cfg, peak);
    const flops = rf.flops;
    rows.push({
      size: g.size, T: g.cfg.T, params: rf.params, flops,
      gpuMs: g.msMedian != null ? g.msMedian : null, cpuMs: c.msMedian != null ? c.msMedian : null,
      roofMs: rf.msRoof, roofCompute: rf.msCompute, roofMemory: rf.msMemory,
      gpuOverRoof: g.msMedian != null ? g.msMedian / rf.msRoof : null,
      tokensPerSecGpu: g.msMedian ? g.cfg.T / (g.msMedian / 1000) : null,
      tokensPerSecCpu: c.msMedian ? g.cfg.T / (c.msMedian / 1000) : null,
      gpuError: g.error || null, cpuError: c.error || null,
    });
  }
  const ok = rows.filter((r) => r.gpuMs != null && r.cpuMs != null);
  // 固定開銷：最小規模的實測減去它的屋頂線（視為每步固定成本的上界）
  const s0 = ok[0];
  const fixedMs = s0 ? Math.max(0, s0.gpuMs - s0.roofMs) : null;
  // 有效速率：cudaweb 在最後兩個規模之間的斜率（ms 對 FLOPs）；cpu-py 用最大規模的平均速率
  let rGpu = null, rCpu = null, crossFlops = null, roofCrossFlops = null, why = '';
  if (ok.length >= 2) {
    const a = ok[ok.length - 2], b = ok[ok.length - 1];
    const dms = b.gpuMs - a.gpuMs, dfl = b.flops - a.flops;
    if (dms > 0) rGpu = dfl / (dms / 1000);   // FLOPs/s
  }
  const big = ok[ok.length - 1];
  if (big) rCpu = big.flops / (big.cpuMs / 1000);
  // 交叉點：cudaweb(f) = F + f/rGpu，cpu(f) = f/rCpu；若 rGpu > rCpu 則 f* = F / (1/rCpu − 1/rGpu)
  const F = fixedMs != null ? fixedMs / 1000 : null;
  if (F != null && rCpu && rGpu) {
    if (rGpu > rCpu) { crossFlops = F / (1 / rCpu - 1 / rGpu); why = '依實測斜率'; }
    else { crossFlops = Infinity; why = '實測斜率比 cpu-py 平緩：交叉點不存在（cudaweb 永遠較慢）'; }
  }
  // 屋頂線預測的交叉點：以峰值運算率當 cudaweb 的斜率、固定開銷用實測值
  if (F != null && rCpu) {
    const rRoof = peak.tflops * 1e12;
    if (rRoof > rCpu) roofCrossFlops = F / (1 / rCpu - 1 / rRoof);
    else roofCrossFlops = Infinity;
  }
  return { rows, fixedMs, rGpuGFlops: rGpu ? rGpu / 1e9 : null, rCpuGFlops: rCpu ? rCpu / 1e9 : null, crossFlops, roofCrossFlops, crossWhy: why };
}

function toMarkdown(gpu, cpu, peak, s) {
  const L = [];
  const f = (x, d = 1) => (x == null ? '—' : (typeof x === 'number' ? x.toFixed(d) : String(x)));
  L.push('# cudaweb 與 cpu-py 全參數步量測摘要');
  L.push('');
  L.push('## 環境');
  const ad = gpu.adapter || {};
  L.push('- 轉接器（cudaweb）：' + (ad.info ? [ad.info.vendor, ad.info.architecture, ad.info.device, ad.info.description].filter(Boolean).join(' / ') : '（adapter.info 不可用）'));
  L.push('- 最大儲存緩衝綁定：' + (ad.maxStorageBufferBindingSize || '—') + ' bytes');
  L.push('- CPU（cpu-py）：' + ((cpu.host && cpu.host.cpuModel) || '—') + '，邏輯核心 ' + ((cpu.host && cpu.host.logicalCpus) || '—') + '，記憶體 ' + ((cpu.host && cpu.host.totalMemGB) || '—') + ' GB');
  L.push('- 執行緒（cpu-py）：' + ((cpu.sizes && cpu.sizes[0] && cpu.sizes[0].threadsConfigured) || '—') + '（設定值；未回讀實際值）');
  L.push('- 峰值假設（屋頂線）：' + peak.tflops + ' TFLOPS、' + peak.gbs + ' GB/s（使用者指定的本機規格預設；可用 --peak-tflops、--bw-gbs 覆寫）');
  L.push('- 量測口徑：批次 1 條序列；每步 30 步，前 5 步暖機，取中位數；cudaweb 含一次提交與兩次讀回；cpu-py 為 llm_full_cpu.py 逐步牆鐘時間。');
  L.push('');
  L.push('## 各規模');
  L.push('| 規模 | T | 參數 | FLOPs／步 | 屋頂線預測 ms | cudaweb ms | cpu-py ms | cudaweb÷屋頂線 | cudaweb tokens/s | cpu-py tokens/s | cudaweb÷cpu-py |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of s.rows) {
    const ratio = r.gpuMs && r.cpuMs ? r.gpuMs / r.cpuMs : null;
    L.push('| ' + [r.size, r.T, r.params, r.flops.toExponential(2), f(r.roofMs, 3), f(r.gpuMs), f(r.cpuMs), f(r.gpuOverRoof, 0) + '×', f(r.tokensPerSecGpu, 0), f(r.tokensPerSecCpu, 0), f(ratio, 1) + '×'].join(' | ') + ' |');
    if (r.gpuError) L.push('|  | cudaweb 錯誤：' + r.gpuError + ' |||||||||');
    if (r.cpuError) L.push('|  | cpu-py 錯誤：' + r.cpuError + ' |||||||||');
  }
  L.push('');
  L.push('## 解釋（屋頂線 vs 實測）');
  L.push('- 固定開銷（由最小規模推得）：約 ' + f(s.fixedMs) + ' ms／步（上界：實測減去屋頂線）。這包含每步一次提交、兩次讀回與 JS 端的組裝。');
  L.push('- 有效 GFLOP/s：cudaweb 由最後兩個有量測的規模之間的斜率推得約 ' + f(s.rGpuGFlops, 1) + ' GFLOP/s；cpu-py 由最大規模推得約 ' + f(s.rCpuGFlops, 1) + ' GFLOP/s。');
  L.push('- 屋頂線峰值為 ' + peak.tflops + ' TFLOPS，遠高於上面兩個實測速率；差距不能只靠固定開銷解釋，還有隨規模增長的成本（JS 陣列轉換、每步派發數、頻寬使用效率）。這些成本的各自佔比尚未拆解（見 P1b）。');
  L.push('');
  L.push('## 交叉點（模型大到多少 cudaweb 才開始贏 cpu-py）');
  if (s.crossFlops == null) L.push('- 無法估計（資料不足）。');
  else if (s.crossFlops === Infinity) L.push('- 實測：' + s.crossWhy + '。');
  else L.push('- 依實測斜率：每步 FLOPs 約 ' + s.crossFlops.toExponential(2) + '（約為 L 規模的 ' + (s.crossFlops / s.rows.find((r) => r.size === 'L').flops).toFixed(1) + ' 倍）時 cudaweb 才與 cpu-py 打平。');
  if (s.roofCrossFlops != null) L.push('- 若 cudaweb 達到屋頂線（' + peak.tflops + ' TFLOPS），交叉點約每步 FLOPs ' + (s.roofCrossFlops === Infinity ? '（不存在）' : s.roofCrossFlops.toExponential(2)) + '。（以實測固定開銷推算；假設固定開銷不隨規模增長。）');
  L.push('');
  L.push('## 原始 JSON');
  L.push('```json');
  L.push(JSON.stringify({ gpu: { adapter: gpu.adapter, sizes: gpu.sizes.map((x) => ({ size: x.size, msMedian: x.msMedian, msFirst: x.msFirst, error: x.error || null })) }, cpu: { sizes: (cpu.sizes || []).map((x) => ({ size: x.size, msMedian: x.msMedian, msFirst: x.msFirst, error: x.error || null })) } }, null, 1));
  L.push('```');
  return L.join('\n') + '\n';
}

module.exports = { summarize, toMarkdown };

if (require.main === module) {
  const gpuPath = process.argv[2], cpuPath = process.argv[3];
  if (!gpuPath || !cpuPath) { console.error('用法：node scripts/bench/summarize.js <gpu.json> <cpu.json> [--peak-tflops 0.3] [--bw-gbs 14] [--out 摘要.md]'); process.exit(2); }
  const peak = { tflops: Number(arg('--peak-tflops', 0.3)), gbs: Number(arg('--bw-gbs', 14)) };
  const gpu = JSON.parse(fs.readFileSync(gpuPath, 'utf8'));
  const cpu = JSON.parse(fs.readFileSync(cpuPath, 'utf8'));
  const s = summarize(gpu, cpu, peak);
  const md = toMarkdown(gpu, cpu, peak, s);
  const o = arg('--out', null);
  if (o) fs.writeFileSync(o, md, 'utf8');
  process.stdout.write(md);
}
