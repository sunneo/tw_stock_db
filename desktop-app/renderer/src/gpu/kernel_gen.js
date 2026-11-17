/* kernel_gen.js — 矩陣乘核心產生器（G1，docs/TARGET.cudaweb-cublas.md「變體階梯與預先剖析」）。
 * 用參數（BM、BN、BK、TM、TN、向量寬度）代入字串，產出一整族 WGSL；不同大小的核心都從這裡產生，不另寫一份。
 * 純函式：node 可直接 require 測試；UMD，之後可嵌入瀏覽器（window.FaKernelGen）。
 *
 * 幾何（scalar-tile 家族）：工作群組 WG×WG 個執行緒（WG 預設 16），輸出塊 BM×BN，
 *   BM = WG·TM、BN = WG·TN；每個執行緒在暫存器裡累加 TM×TN；每次搬 BK 層 k 進共用記憶體。
 * 向量寬度 vec=4：A 與 B 的全域讀取與共用記憶體搬入用 vec4（需要 K%4 == 0 與 N%4 == 0；BK 須為 4 的倍數）。
 * 內層 k 用 for 迴圈（BK 次），只把 TM×TN 的 fma 展開（索引皆為常數），著色器較短，編譯較快。
 * 條件（呼叫端）：不轉置、K % BK == 0（BK 要整除 K；否則用 generate 的 guard 版本，目前只產生整除版）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FaKernelGen = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var POW2 = { BM: [16, 32, 64, 128], BN: [16, 32, 64, 128], TM: [1, 2, 4, 8], TN: [1, 2, 4, 8], BK: [4, 8, 16, 32] };

  // 一個變體的正規化與驗證：回傳 { ok, reason, v }；v 含推導出的 WG、執行緒數、共用記憶體位元組、暫存器估計
  function describe(spec) {
    var WG = spec.WG || 16;
    var TM = spec.TM, TN = spec.TN, BK = spec.BK, vec = spec.vec || 1;
    var BM = WG * TM, BN = WG * TN;
    var threads = WG * WG;
    var sharedBytes = (BM * BK + BK * BN) * 4;
    // 暫存器估計：TM·TN 個累加器 + TM 個 A 值 + TN 個 B 值 + 位址與迴圈（粗估 12）
    var regs = TM * TN + TM + TN + 12;
    var v = { WG: WG, TM: TM, TN: TN, BM: BM, BN: BN, BK: BK, vec: vec, threads: threads, sharedBytes: sharedBytes, regsEstimate: regs };
    if (POW2.TM.indexOf(TM) < 0 || POW2.TN.indexOf(TN) < 0 || POW2.BK.indexOf(BK) < 0) return { ok: false, reason: 'TM/TN/BK 不在 2 的冪次表中', v: v };
    if (vec !== 1 && vec !== 4) return { ok: false, reason: 'vec 只能是 1 或 4', v: v };
    if (vec === 4 && (BK % 4 !== 0 || TN % 4 !== 0 || BN % 4 !== 0)) return { ok: false, reason: 'vec4 需要 BK、TN、BN 為 4 的倍數', v: v };
    if (WG * WG > 256 && WG * WG !== threads) return { ok: false, reason: '執行緒數異常', v: v };
    return { ok: true, reason: '', v: v };
  }

  // 依能力表過濾合法組合。caps：{ maxWgStorage, maxInvocations, regBudget }（regBudget 預設 64）
  function enumerate(caps) {
    caps = caps || {};
    var maxStorage = caps.maxWgStorage || 16384, maxInv = caps.maxInvocations || 256, regBudget = caps.regBudget || 64;
    var out = [];
    POW2.TM.forEach(function (TM) { POW2.TN.forEach(function (TN) { POW2.BK.forEach(function (BK) { [1, 4].forEach(function (vec) {
      var d = describe({ WG: 16, TM: TM, TN: TN, BK: BK, vec: vec });
      if (!d.ok) return;
      if (d.v.sharedBytes > maxStorage) return;
      if (d.v.threads > maxInv) return;
      if (d.v.regsEstimate > regBudget) return;
      out.push(d.v);
    }); }); }); });
    return out;
  }

  // 產生 WGSL。spec 同 describe。opts.marker：@kernel 名稱。
  function generate(spec, opts) {
    opts = opts || {};
    var d = describe(spec);
    if (!d.ok) throw new Error('kernel_gen：' + d.reason);
    var v = d.v, WG = v.WG, TM = v.TM, TN = v.TN, BM = v.BM, BN = v.BN, BK = v.BK, vec = v.vec;
    var marker = opts.marker || ('matmul_g_' + BM + 'x' + BN + 'x' + BK + '_t' + TM + 'x' + TN + (vec === 4 ? '_v4' : ''));
    var TNV = TN / 4;
    var BNV = BN / 4, BKV = BK / 4;
    var threads = WG * WG;
    var L = [];
    L.push('struct P { B: u32, M: u32, K: u32, N: u32, Bb: u32, azp: i32, bzp: i32, p0: u32 }');
    if (vec === 4) {
      L.push('@group(0) @binding(0) var<storage, read> a4: array<vec4<f32>>;');
      L.push('@group(0) @binding(1) var<storage, read> b4: array<vec4<f32>>;');
    } else {
      L.push('@group(0) @binding(0) var<storage, read> a: array<f32>;');
      L.push('@group(0) @binding(1) var<storage, read> b: array<f32>;');
    }
    L.push('@group(0) @binding(2) var<storage, read_write> y: array<f32>;');
    L.push('@group(0) @binding(3) var<uniform> p: P;');
    // 共用記憶體：As 為 BM 列 × BK 個 k（列主序）；Bs 為 BK 列 × BN 欄（列主序）
    L.push('var<workgroup> As: array<f32, ' + (BM * BK) + '>;');
    L.push('var<workgroup> Bs: array<f32, ' + (BK * BN) + '>;');
    L.push('@compute @workgroup_size(' + WG + ', ' + WG + ', 1)');
    L.push('fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {');
    L.push('  let n = wid.z;');
    L.push('  let row0 = wid.y * ' + BM + 'u;');
    L.push('  let col0 = wid.x * ' + BN + 'u;');
    L.push('  let ao = n * p.M * p.K;');
    L.push('  var bo = 0u;');
    L.push('  if (p.Bb != 1u) { bo = n * p.K * p.N; }');
    L.push('  let tx = lid.x;');
    L.push('  let ty = lid.y;');
    L.push('  let tid = ty * ' + WG + 'u + tx;');
    L.push('  var acc: array<f32, ' + (TM * TN) + '>;');
    L.push('  for (var t: u32 = 0u; t < p.K / ' + BK + 'u; t = t + 1u) {');
    L.push('    let k0 = t * ' + BK + 'u;');
    // 協作搬入：A 共 BM·BK 個元素，B 共 BK·BN 個元素，分給 threads 個執行緒
    if (vec === 4) {
      var NA4 = BM * BKV, NB4 = BK * BNV;
      L.push('    for (var q: u32 = tid; q < ' + NA4 + 'u; q = q + ' + threads + 'u) {');
      L.push('      let ar = q / ' + BKV + 'u;');
      L.push('      let ak = (q % ' + BKV + 'u) * 4u;');
      L.push('      let gr = row0 + ar;');
      L.push('      var av: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 0.0);');
      L.push('      if (gr < p.M) { av = a4[(ao + gr * p.K + k0 + ak) / 4u]; }');
      L.push('      As[ar * ' + BK + 'u + ak] = av.x; As[ar * ' + BK + 'u + ak + 1u] = av.y;');
      L.push('      As[ar * ' + BK + 'u + ak + 2u] = av.z; As[ar * ' + BK + 'u + ak + 3u] = av.w;');
      L.push('    }');
      L.push('    for (var q2: u32 = tid; q2 < ' + NB4 + 'u; q2 = q2 + ' + threads + 'u) {');
      L.push('      let br = q2 / ' + BNV + 'u;');
      L.push('      let bc = (q2 % ' + BNV + 'u) * 4u;');
      L.push('      let gc = col0 + bc;');
      L.push('      var bv: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 0.0);');
      L.push('      if (gc < p.N) { bv = b4[(bo + (k0 + br) * p.N + gc) / 4u]; }');
      L.push('      Bs[br * ' + BN + 'u + bc] = bv.x; Bs[br * ' + BN + 'u + bc + 1u] = bv.y;');
      L.push('      Bs[br * ' + BN + 'u + bc + 2u] = bv.z; Bs[br * ' + BN + 'u + bc + 3u] = bv.w;');
      L.push('    }');
    } else {
      var NA = BM * BK, NB = BK * BN;
      L.push('    for (var q: u32 = tid; q < ' + NA + 'u; q = q + ' + threads + 'u) {');
      L.push('      let ar = q / ' + BK + 'u;');
      L.push('      let ak = q % ' + BK + 'u;');
      L.push('      let gr = row0 + ar;');
      L.push('      var av: f32 = 0.0;');
      L.push('      if (gr < p.M) { av = a[ao + gr * p.K + k0 + ak]; }');
      L.push('      As[q] = av;');
      L.push('    }');
      L.push('    for (var q2: u32 = tid; q2 < ' + NB + 'u; q2 = q2 + ' + threads + 'u) {');
      L.push('      let br = q2 / ' + BN + 'u;');
      L.push('      let bc = q2 % ' + BN + 'u;');
      L.push('      let gc = col0 + bc;');
      L.push('      var bv: f32 = 0.0;');
      L.push('      if (gc < p.N) { bv = b[bo + (k0 + br) * p.N + gc]; }');
      L.push('      Bs[q2] = bv;');
      L.push('    }');
    }
    L.push('    workgroupBarrier();');
    // 計算：k 用 for 迴圈（BK 次）；每次只展開 TM×TN 的 fma，索引皆為常數
    L.push('    for (var kk: u32 = 0u; kk < ' + BK + 'u; kk = kk + 1u) {');
    for (var j = 0; j < TN; j++) L.push('      let b' + j + ' = Bs[kk * ' + BN + 'u + tx * ' + TN + 'u + ' + j + 'u];');
    for (var i = 0; i < TM; i++) L.push('      let a' + i + ' = As[(ty * ' + TM + 'u + ' + i + 'u) * ' + BK + 'u + kk];');
    for (var i2 = 0; i2 < TM; i2++) for (var j2 = 0; j2 < TN; j2++) {
      L.push('      acc[' + (i2 * TN + j2) + '] = fma(a' + i2 + ', b' + j2 + ', acc[' + (i2 * TN + j2) + ']);');
    }
    L.push('    }');
    L.push('    workgroupBarrier();');
    L.push('  }');
    // 寫回：列與欄逐元素檢查
    for (var i3 = 0; i3 < TM; i3++) {
      L.push('  {');
      L.push('    let gr = row0 + ty * ' + TM + 'u + ' + i3 + 'u;');
      L.push('    if (gr < p.M) {');
      for (var j3 = 0; j3 < TN; j3++) {
        L.push('      { let gc = col0 + tx * ' + TN + 'u + ' + j3 + 'u; if (gc < p.N) { y[(n * p.M + gr) * p.N + gc] = acc[' + (i3 * TN + j3) + ']; } }');
      }
      L.push('    }');
      L.push('  }');
    }
    L.push('}');
    return '// @kernel ' + marker + '\n' + L.join('\n');
  }

  // 分派數：[ceil(N/BN), ceil(M/BM), B]
  function dispatchFor(spec, M, N, B) {
    var d = describe(spec).v;
    return [Math.ceil(N / d.BN), Math.ceil(M / d.BM), B || 1];
  }

  // G2 階梯：代表性的 scalar-tile 變體（WG 16），依輸出塊由小到大；vec4 與純量各一份（BK 8 與 16）。
  // split-K 尚未由產生器支援（標為待做）。名稱供快取鍵與設定頁顯示用。
  function ladder() {
    var rungs = [[2, 2], [4, 4], [4, 8], [8, 4], [8, 8]];   // (TM, TN) → 輸出塊 32×32、64×64、64×128、128×64、128×128
    var out = [];
    rungs.forEach(function (r) { [8, 16].forEach(function (BK) { [1, 4].forEach(function (vec) {
      var spec = { WG: 16, TM: r[0], TN: r[1], BK: BK, vec: vec };
      var d = describe(spec);
      if (!d.ok) return;
      out.push({ name: 'g_' + d.v.BM + 'x' + d.v.BN + '_k' + BK + '_t' + r[0] + 'x' + r[1] + (vec === 4 ? '_v4' : '_s'), spec: spec, v: d.v });
    }); }); });
    return out;
  }

  return { describe: describe, enumerate: enumerate, generate: generate, dispatchFor: dispatchFor, ladder: ladder, POW2: POW2 };
}));
