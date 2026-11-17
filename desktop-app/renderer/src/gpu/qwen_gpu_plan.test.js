// qwen_gpu.js 的記憶體估算與分層規劃（planLayers）：純函式，不需要 GPU
const G = require('./qwen_gpu.js');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL ' + n); } };
const mk = (K, N) => ({ W: { length: K * N } });
function Wf(D, H, Hkv, I, L, V) { const hd = 128; return { D, H, Hkv, hd, I, V, L, finalNorm: { byteLength: D * 4 }, emb: { W: { length: V * D } }, layers: Array.from({ length: L }, () => ({ q: mk(D, H * hd), k: mk(D, Hkv * hd), v: mk(D, Hkv * hd), o: mk(H * hd, D), g: mk(D, I), u: mk(D, I), d: mk(I, D), inNorm: { byteLength: D * 4 }, postNorm: { byteLength: D * 4 } })) }; }
const MB = 1048576;
const W06 = Wf(1024, 16, 8, 3072, 28, 151936), W17 = Wf(2048, 16, 8, 6144, 28, 151936);
const e = (W, o) => G.estimateEngineBytes(W, o).total;
// 估算：常駐層越少越小，單調；全常駐等於預設；trace 緩衝區只在 trace:true 才算
ok(e(W06, { maxT: 64, maxM: 32 }) === e(W06, { maxT: 64, maxM: 32, residentLayers: 28 }), '全常駐＝預設');
let prev = Infinity, mono = true; for (let r = 28; r >= 0; r--) { const t = e(W06, { maxT: 512, maxM: 64, residentLayers: r }); if (t > prev) mono = false; prev = t; }
ok(mono, '常駐層越少估算越小');
ok(e(W06, { maxT: 64, maxM: 32, trace: true }) - e(W06, { maxT: 64, maxM: 32 }) === 2 * 28 * 32 * 1024 * 4, 'trace 緩衝區只在 trace:true 才算');
// 一層份串流緩衝區：R=27 省一層、加一個 slot＝與全常駐幾乎相同（差在 slot 與層的 norm 對齊），R=26 才真的省約一層
const t28 = e(W06, { maxT: 64, maxM: 32, residentLayers: 28 }), t27 = e(W06, { maxT: 64, maxM: 32, residentLayers: 27 }), t26 = e(W06, { maxT: 64, maxM: 32, residentLayers: 26 });
ok(Math.abs(t27 - t28) < 64 * 1024 && t28 - t26 > 14 * MB, 'R=27≈全常駐、R=26 省約一層（' + ((t28 - t26) / MB).toFixed(1) + ' MB）');
// 規劃：上限很大＝全常駐；很小＝放不下；中間＝分層且 total ≤ 上限，且再多一層就超過
let pl = G.planLayers(W17, { maxT: 512, maxM: 64, budgetBytes: 8192 * MB }); ok(pl.ok && pl.resident === 28 && pl.streamed === 0, '上限夠大：全常駐');
pl = G.planLayers(W17, { maxT: 512, maxM: 64, budgetBytes: 50 * MB }); ok(!pl.ok && pl.minNeed && pl.minNeed.total > 50 * MB, '上限太小：放不下最小分層配置');
for (const [W, b] of [[W17, 1200], [W17, 1500], [W06, 450], [W06, 600]]) {
  pl = G.planLayers(W, { maxT: 512, maxM: 64, budgetBytes: b * MB });
  const tot = e(W, { maxT: 512, maxM: 64, residentLayers: pl.resident }), more = pl.resident < 28 ? e(W, { maxT: 512, maxM: 64, residentLayers: pl.resident + 1 }) : 0;
  ok(pl.ok && pl.resident > 0 && pl.resident < 28 && tot <= b * MB && more > b * MB && pl.need.total === tot, 'budget ' + b + ' MB：常駐 ' + pl.resident + ' 層、total ' + (tot / MB).toFixed(0) + ' MB、再多一層就超過');
}
pl = G.planLayers(W17, { maxT: 512, maxM: 64, budgetBytes: 1500 * MB, allowStream: false }); ok(!pl.ok && /不允許分層/.test(pl.why), 'allowStream:false 放不下就不分層');
// 無上限（0／未給）＝全常駐
ok(G.planLayers(W17, { maxT: 512, maxM: 64 }).resident === 28, '沒給上限＝全常駐');
console.log(pass + ' 通過 ' + fail + ' 失敗'); process.exit(fail ? 1 : 0);
