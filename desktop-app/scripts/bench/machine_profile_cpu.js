#!/usr/bin/env node
'use strict';
// 機器剖析：CPU 部分（P1c-1）。量三件事，全部是實測，不靠型號猜：
//   1) 矩陣乘 GFLOPS：1、2、4 個工作者（持久池，與 cpu_share 同一個列區塊核心），取 1024³ 的最佳三次
//   2) 記憶體頻寬：64 MB 的 Float32Array 複製，每次讀 1 寫 1
//   3) 主機資訊：核心數、CPU 型號、總記憶體
// 用法：node scripts/bench/machine_profile_cpu.js [--sz 1024] [--out <json 路徑>]
// 輸出（stdout 最後一行）：[machine-cpu] <JSON>；加 --out 時同時寫檔。
// 結果交給 scripts/bench/machine_profile.js 組成能力檔（不在這裡組，避免兩份格式）。
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SZ = Number(argVal('--sz', 1024));
const OUT = argVal('--out', null);

const GPU_DIR = path.join(__dirname, '..', '..', 'renderer', 'src', 'gpu');
const G = require(path.join(GPU_DIR, 'cpu_gemm.js'));
const { createRowPool } = require(path.join(GPU_DIR, 'cpu_gemm_rows.js'));

const fill = (len, s) => { const x = new Float32Array(len); for (let i = 0; i < len; i++) x[i] = (((i * 1103515245 + s * 12345) >>> 0) % 2001) / 1000 - 1; return x; };

async function matmulGflops(workers) {
  const pool = createRowPool(workers);
  try {
    const A = fill(SZ * SZ, 1), B = fill(SZ * SZ, 2);
    await pool.run(A, B, SZ, SZ, SZ, {});               // 暖機（不計時）
    let best = Infinity;
    for (let r = 0; r < 3; r++) {
      const t0 = process.hrtime.bigint();
      await pool.run(A, B, SZ, SZ, SZ, {});
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (ms < best) best = ms;
    }
    return { n: workers, ms: Math.round(best * 1000) / 1000, gflops: Math.round((2 * SZ ** 3) / (best * 1e-3) / 1e9 * 1000) / 1000 };
  } finally { pool.close(); }
}

function memBandwidthGBs() {
  const N = 16 * 1024 * 1024;                              // 16M 個 f32 ＝ 64 MB
  const src = fill(N, 3), dst = new Float32Array(N);
  dst.set(src);                                            // 暖機
  let best = Infinity;
  for (let r = 0; r < 5; r++) {
    const t0 = process.hrtime.bigint();
    dst.set(src);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < best) best = ms;
  }
  const bytes = N * 4 * 2;                                 // 讀 1、寫 1
  return Math.round(bytes / (best * 1e-3) / 1e9 * 1000) / 1000;
}

(async () => {
  const cores = os.cpus().length;
  const counts = [1, 2, 4].filter((n) => n <= Math.max(1, cores));
  const threads = [];
  for (const n of counts) threads.push(await matmulGflops(n));
  const result = {
    host: { cpuModel: os.cpus()[0] && os.cpus()[0].model, logicalCpus: cores, totalMemGB: Math.round(os.totalmem() / 1e9 * 10) / 10, platform: os.platform() },
    cpu: { cores, threads, memGBs: memBandwidthGBs(), sz: SZ, simd: G.simdSupported ? !!G.simdSupported() : null },
  };
  const line = '[machine-cpu] ' + JSON.stringify(result);
  console.log(line);
  if (OUT) { fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 1), 'utf8'); console.log('wrote ' + OUT); }
})().catch((e) => { console.error(e); process.exit(1); });
