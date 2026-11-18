'use strict';
// 變體競賽的真實計時（node，單執行緒）：1024³，每個變體取兩次最小值；勝者寫入記憶體後端（node 沒有 IndexedDB）。
// 用法：node cpu_gemm_race_run.js
const G = require('./cpu_gemm.js');
const RACE = require('./cpu_gemm_race.js');
const os = require('os');

const N = 1024;
const fill = (len, s) => { const x = new Float32Array(len); for (let i = 0; i < len; i++) x[i] = (((i * 1103515245 + s * 12345) >>> 0) % 2001) / 1000 - 1; return x; };
const A = fill(N * N, 1), B = fill(N * N, 2);

function runVariant(v) {
  const opts = { MC: v.MC, KC: v.KC, NC: v.NC };
  return v.kernel === 'simd' ? G.gemmPackedSimd(A, B, N, N, N, opts) : G.gemmPacked(A, B, N, N, N, opts);
}
const timeFn = (v) => {
  runVariant(v);                                   // 預熱
  const t0 = process.hrtime.bigint();
  runVariant(v);
  return Number(process.hrtime.bigint() - t0) / 1e6;
};

(async () => {
  const variants = RACE.candidateVariants();
  const flops = 2 * N * N * N;
  const result = RACE.raceVariants(variants, timeFn, flops, 2);
  const store = (() => { const m = new Map(); return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); } }; })();
  const key = RACE.raceKey(os.cpus().length, 'node/' + process.version);
  const saved = await RACE.saveWinner(store, key, result);
  const picked = await RACE.chooseVariant(store, key, variants);
  console.log(`規模 ${N}³，鍵 ${key}，保存 ${saved ? '成功' : '失敗'}，之後選用 ${picked.id}`);
  for (const r of result.rows) console.log(`${r.id}：${r.ms.toFixed(1)} ms，${r.gflops.toFixed(2)} GFLOP/s，${r.verdict}`);
  console.log(`勝者：${result.winnerId}（${result.reason}）`);
})().catch((e) => { console.error('失敗：', (e && e.stack) || e); process.exit(1); });
