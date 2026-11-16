// attn_gpu_test.js — 注意力 GPU 版在 node（沒有 WebGPU）的退路測試。真 GPU 數值另由 scripts/eval/cudaweb_attn_browser.js 在 Chrome 驗證。
// 用法：node renderer/src/gpu/attn_gpu_test.js
'use strict';
const A = require('./attn_ops.js');
const G = require('./attn_gpu.js');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('ok  ' + m); } else { fail++; console.log('FAIL ' + m); } };
let seed = 42; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
const H = 4, Hkv = 2, hd = 8, scale = 1 / Math.sqrt(hd);
(async () => {
  const S = 3, past = 2, T = past + S;
  const cache = A.createKvCache(Hkv, hd, T);
  A.kvAppend(cache, Float64Array.from({ length: T * Hkv * hd }, rnd), Float64Array.from({ length: T * Hkv * hd }, rnd), T);
  const q = Float64Array.from({ length: S * H * hd }, rnd);
  const ref = A.attnCore(q, S, past, cache, H, scale);
  const g = await G.attnCoreGpu(q, S, past, cache, H, scale, { navigator: undefined });
  ok(g.info.layer === 'cpu-js', '沒有 WebGPU：退到 cpu-js（實際層 ' + g.info.layer + '）');
  ok(typeof g.info.reason === 'string' && g.info.reason.length > 0, '退路寫出原因：' + (g.info.reason || '').slice(0, 60));
  let d = 0; for (let i = 0; i < ref.length; i++) d = Math.max(d, Math.abs(ref[i] - g.result[i]));
  ok(d < 1e-12, '退路結果與參考版逐位元一致（偏差 ' + d + '）');
  let threw = 0;
  try { await G.attnCoreGpu(q, S, past + 5, cache, H, scale, { navigator: undefined }); } catch (_) { threw++; }
  ok(threw === 1, '快取不足時丟錯');
  console.log('\n' + pass + ' 項通過，' + fail + ' 項失敗');
  process.exitCode = fail ? 1 : 0;
})();
