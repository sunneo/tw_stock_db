'use strict';
// 矩陣乘幾何參數化核心（P1 矩陣乘調校用）。
// 與 gpu_core.js 的 mmTileWgsl 同一組介面：bindings 0=a、1=b、2=y、3=uniform P（8 個 u32：B,M,K,N,Bb,azp,bzp,p0）；
// 分派 [ceil(N/BN), ceil(M/BM), B]；p0 bit0＝A 以 K×M 儲存（Aᵀ），bit1＝B 以 N×K 儲存（Bᵀ）。
// 幾何：工作群組 TX×TY 執行緒；每個執行緒算 RM×RN 的暫存器區塊；一塊輸出 BM×BN＝(TY·RM)×(TX·RN)；每輪搬 BK 層。
// 邊界逐元素檢查（與 mmTileWgsl 相同語意）。只用於調校與對拍；正式路徑仍是 gpu_core.js 的核心，直到調校結果寫進 PLAN。
function mmGeomDims(o) {
  const BM = o.TY * o.RM, BN = o.TX * o.RN, TH = o.TX * o.TY;
  if ((BM * o.BK) % TH !== 0 || (o.BK * BN) % TH !== 0) throw new Error('mm_geom：載入步數不是整數（BM·BK、BK·BN 要能被執行緒數整除）');
  return { BM: BM, BN: BN, TH: TH, loadA: (BM * o.BK) / TH, loadB: (o.BK * BN) / TH };
}
function mmGeomWgsl(o) {
  const d = mmGeomDims(o);
  const marker = o.marker || 'matmul_geom';
  const RM = o.RM, RN = o.RN, BK = o.BK, TX = o.TX, TY = o.TY, BM = d.BM, BN = d.BN, TH = d.TH;
  return '// @kernel ' + marker + '\n' + [
    'struct P { B: u32, M: u32, K: u32, N: u32, Bb: u32, azp: i32, bzp: i32, p0: u32 }',
    '@group(0) @binding(0) var<storage, read> a: array<f32>;',
    '@group(0) @binding(1) var<storage, read> b: array<f32>;',
    '@group(0) @binding(2) var<storage, read_write> y: array<f32>;',
    '@group(0) @binding(3) var<uniform> p: P;',
    'var<workgroup> As: array<f32, ' + (BM * BK) + '>;',
    'var<workgroup> Bs: array<f32, ' + (BK * BN) + '>;',
    '@compute @workgroup_size(' + TX + ', ' + TY + ', 1)',
    'fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {',
    '  let n = wid.z;',
    '  let row0 = wid.y * ' + BM + 'u;',
    '  let col0 = wid.x * ' + BN + 'u;',
    '  let ao = n * p.M * p.K;',
    '  var bo = 0u;',
    '  if (p.Bb != 1u) { bo = n * p.K * p.N; }',
    '  let tA = (p.p0 & 1u) != 0u;',
    '  let tB = (p.p0 & 2u) != 0u;',
    '  let tid = lid.y * ' + TX + 'u + lid.x;',
    '  var acc: array<f32, ' + (RM * RN) + '>;',
    '  for (var i: u32 = 0u; i < ' + (RM * RN) + 'u; i = i + 1u) { acc[i] = 0.0; }',
    '  let tiles = (p.K + ' + (BK - 1) + 'u) / ' + BK + 'u;',
    '  for (var t: u32 = 0u; t < tiles; t = t + 1u) {',
    '    let k0 = t * ' + BK + 'u;',
    '    for (var s: u32 = 0u; s < ' + d.loadA + 'u; s = s + 1u) {',
    '      let idx = tid + s * ' + TH + 'u;',
    '      let ar = idx / ' + BK + 'u;',
    '      let ak = idx % ' + BK + 'u;',
    '      let gr = row0 + ar;',
    '      let gk = k0 + ak;',
    '      var av: f32 = 0.0;',
    '      if (gr < p.M && gk < p.K) {',
    '        if (tA) { av = a[ao + gk * p.M + gr]; } else { av = a[ao + gr * p.K + gk]; }',
    '      }',
    '      As[idx] = av;',
    '    }',
    '    for (var s: u32 = 0u; s < ' + d.loadB + 'u; s = s + 1u) {',
    '      let idx = tid + s * ' + TH + 'u;',
    '      let bk = idx / ' + BN + 'u;',
    '      let bc = idx % ' + BN + 'u;',
    '      let gk2 = k0 + bk;',
    '      let gc = col0 + bc;',
    '      var bv: f32 = 0.0;',
    '      if (gk2 < p.K && gc < p.N) {',
    '        if (tB) { bv = b[bo + gc * p.K + gk2]; } else { bv = b[bo + gk2 * p.N + gc]; }',
    '      }',
    '      Bs[idx] = bv;',
    '    }',
    '    workgroupBarrier();',
    '    for (var kk: u32 = 0u; kk < ' + BK + 'u; kk = kk + 1u) {',
    '      var ra: array<f32, ' + RM + '>;',
    '      var rb: array<f32, ' + RN + '>;',
    '      for (var i: u32 = 0u; i < ' + RM + 'u; i = i + 1u) { ra[i] = As[(lid.y * ' + RM + 'u + i) * ' + BK + 'u + kk]; }',
    '      for (var j: u32 = 0u; j < ' + RN + 'u; j = j + 1u) { rb[j] = Bs[kk * ' + BN + 'u + lid.x * ' + RN + 'u + j]; }',
    '      for (var i: u32 = 0u; i < ' + RM + 'u; i = i + 1u) {',
    '        for (var j: u32 = 0u; j < ' + RN + 'u; j = j + 1u) { acc[i * ' + RN + 'u + j] = acc[i * ' + RN + 'u + j] + ra[i] * rb[j]; }',
    '      }',
    '    }',
    '    workgroupBarrier();',
    '  }',
    '  for (var i: u32 = 0u; i < ' + RM + 'u; i = i + 1u) {',
    '    let gr = row0 + lid.y * ' + RM + 'u + i;',
    '    if (gr >= p.M) { continue; }',
    '    for (var j: u32 = 0u; j < ' + RN + 'u; j = j + 1u) {',
    '      let gc = col0 + lid.x * ' + RN + 'u + j;',
    '      if (gc < p.N) { y[(n * p.M + gr) * p.N + gc] = acc[i * ' + RN + 'u + j]; }',
    '    }',
    '  }',
    '}'
  ].join('\n');
}
module.exports = { mmGeomWgsl: mmGeomWgsl, mmGeomDims: mmGeomDims };
