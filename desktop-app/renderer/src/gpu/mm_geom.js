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
// 轉置 vec4 版（P1 調校）：與產品 vec4 核心同幾何（16×16 執行緒、4×4 暫存器、BK=16、BM=BN=64），
// 但轉置的那一邊也用 vec4 載入：Aᵀ（A 以 K×M 儲存）沿 m 方向取 4 個連續元素；Bᵀ（B 以 N×K 儲存）沿 k 方向取 4 個。
// 條件（呼叫端用 mmVec4TOk 檢查）：M、K、N 都是 4 的倍數。旗標在編譯期寫進程式碼，所以每種轉置組合各一支核心。
function mmVec4TOk(M, K, N) { return M > 0 && K > 0 && N > 0 && M % 4 === 0 && K % 4 === 0 && N % 4 === 0; }
function mmVec4TWgsl(o) {
  const TA = !!o.transA, TB = !!o.transB;
  if (!TA && !TB) throw new Error('mm_geom：mmVec4TWgsl 需要至少一個轉置旗標');
  const marker = o.marker || (TA && TB ? 'matmul_vec4_tt' : (TA ? 'matmul_vec4_ta' : 'matmul_vec4_tb'));
  const aLoad = TA ? [
    '    let kk = tid / 16u;',
    '    let ms = (tid % 16u) * 4u;',
    '    let gk = k0 + kk;',
    '    let gm = row0 + ms;',
    '    var av: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 0.0);',
    '    if (gk < p.K && gm < p.M) { av = a4[ao4 + (gk * p.M + gm) / 4u]; }',
    '    As[ms * 16u + kk] = av.x;',
    '    As[(ms + 1u) * 16u + kk] = av.y;',
    '    As[(ms + 2u) * 16u + kk] = av.z;',
    '    As[(ms + 3u) * 16u + kk] = av.w;',
  ] : [
    '    let ar = tid / 4u;',
    '    let ak = (tid % 4u) * 4u;',
    '    let gr = row0 + ar;',
    '    let gk = k0 + ak;',
    '    var av: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 0.0);',
    '    if (gr < p.M && gk < p.K) { av = a4[ao4 + (gr * p.K + gk) / 4u]; }',
    '    As[ar * 16u + ak] = av.x;',
    '    As[ar * 16u + ak + 1u] = av.y;',
    '    As[ar * 16u + ak + 2u] = av.z;',
    '    As[ar * 16u + ak + 3u] = av.w;',
  ];
  const bLoad = TB ? [
    '    let bc = tid / 4u;',
    '    let sk = (tid % 4u) * 4u;',
    '    let gc = col0 + bc;',
    '    let gk2 = k0 + sk;',
    '    var bv: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 0.0);',
    '    if (gc < p.N && gk2 < p.K) { bv = b4[bo4 + (gc * p.K + gk2) / 4u]; }',
    '    Bs[sk * 64u + bc] = bv.x;',
    '    Bs[(sk + 1u) * 64u + bc] = bv.y;',
    '    Bs[(sk + 2u) * 64u + bc] = bv.z;',
    '    Bs[(sk + 3u) * 64u + bc] = bv.w;',
  ] : [
    '    let bk = tid / 16u;',
    '    let bc = (tid % 16u) * 4u;',
    '    let gk2 = k0 + bk;',
    '    let gc = col0 + bc;',
    '    var bv: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 0.0);',
    '    if (gk2 < p.K && gc < p.N) { bv = b4[bo4 + (gk2 * p.N + gc) / 4u]; }',
    '    Bs[bk * 64u + bc] = bv.x;',
    '    Bs[bk * 64u + bc + 1u] = bv.y;',
    '    Bs[bk * 64u + bc + 2u] = bv.z;',
    '    Bs[bk * 64u + bc + 3u] = bv.w;',
  ];
  return '// @kernel ' + marker + '\n' + [
    'struct P { B: u32, M: u32, K: u32, N: u32, Bb: u32, azp: i32, bzp: i32, p0: u32 }',
    '@group(0) @binding(0) var<storage, read> a4: array<vec4<f32>>;',
    '@group(0) @binding(1) var<storage, read> b4: array<vec4<f32>>;',
    '@group(0) @binding(2) var<storage, read_write> y: array<f32>;',
    '@group(0) @binding(3) var<uniform> p: P;',
    'var<workgroup> As: array<f32, 1024>;',
    'var<workgroup> Bs: array<f32, 1024>;',
    '@compute @workgroup_size(16, 16, 1)',
    'fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {',
    '  let n = wid.z;',
    '  let row0 = wid.y * 64u;',
    '  let col0 = wid.x * 64u;',
    '  let ao4 = (n * p.M * p.K) / 4u;',
    '  var bo4 = 0u;',
    '  if (p.Bb != 1u) { bo4 = (n * p.K * p.N) / 4u; }',
    '  let tid = lid.y * 16u + lid.x;',
    '  var acc: array<f32, 16>;',
    '  for (var i: u32 = 0u; i < 16u; i = i + 1u) { acc[i] = 0.0; }',
    '  let tiles = (p.K + 15u) / 16u;',
    '  for (var t: u32 = 0u; t < tiles; t = t + 1u) {',
    '    let k0 = t * 16u;',
  ].concat(aLoad, bLoad, [
    '    workgroupBarrier();',
    '    for (var kk: u32 = 0u; kk < 16u; kk = kk + 1u) {',
    '      var ra: array<f32, 4>;',
    '      var rb: array<f32, 4>;',
    '      for (var i: u32 = 0u; i < 4u; i = i + 1u) { ra[i] = As[(lid.y * 4u + i) * 16u + kk]; }',
    '      for (var j: u32 = 0u; j < 4u; j = j + 1u) { rb[j] = Bs[kk * 64u + lid.x * 4u + j]; }',
    '      for (var i: u32 = 0u; i < 4u; i = i + 1u) {',
    '        for (var j: u32 = 0u; j < 4u; j = j + 1u) { acc[i * 4u + j] = acc[i * 4u + j] + ra[i] * rb[j]; }',
    '      }',
    '    }',
    '    workgroupBarrier();',
    '  }',
    '  for (var i: u32 = 0u; i < 4u; i = i + 1u) {',
    '    let gr = row0 + lid.y * 4u + i;',
    '    if (gr >= p.M) { continue; }',
    '    for (var j: u32 = 0u; j < 4u; j = j + 1u) {',
    '      let gc = col0 + lid.x * 4u + j;',
    '      if (gc < p.N) { y[(n * p.M + gr) * p.N + gc] = acc[i * 4u + j]; }',
    '    }',
    '  }',
    '}'
  ]).join('\n');
}
// 管線版（P1 GPU 原則 3＋4）：16×16 執行緒、4×4 暫存器、BM=BN=64、BK=8；兩個共用記憶體緩衝，
// 下一塊的全域載入先進暫存器，與目前這塊的乘加重疊，寫入另一個緩衝後只有一次屏障。
// 錯開：As 列距 9（行寬 +1，讀取時同 warp 兩組列不同銀行）；Bs 依欄位置換存成 [kk][j][lid.x]，同 warp 的 16 條執行緒落在 16 個連續銀行（原本是 8 個銀行，2 路衝突）。
// 共用記憶體：As 2×64×9、Bs 2×8×64，合計 8704 B。轉置旗標在編譯期寫入（同 mmVec4TWgsl）。
function mmPipeWgsl(o) {
  const TA = !!o.transA, TB = !!o.transB;
  const marker = o.marker || (TA && TB ? 'matmul_pipe_tt' : (TA ? 'matmul_pipe_ta' : (TB ? 'matmul_pipe_tb' : 'matmul_pipe')));
  const ldA = TA
    ? '  return a[base + gk * p.M + gr];'
    : '  return a[base + gr * p.K + gk];';
  const ldB = TB
    ? '  return b[base + gc * p.K + gk2];'
    : '  return b[base + gk2 * p.N + gc];';
  return '// @kernel ' + marker + '\n' + [
    'struct P { B: u32, M: u32, K: u32, N: u32, Bb: u32, azp: i32, bzp: i32, p0: u32 }',
    '@group(0) @binding(0) var<storage, read> a: array<f32>;',
    '@group(0) @binding(1) var<storage, read> b: array<f32>;',
    '@group(0) @binding(2) var<storage, read_write> y: array<f32>;',
    '@group(0) @binding(3) var<uniform> p: P;',
    'var<workgroup> As: array<f32, 1152>;',
    'var<workgroup> Bs: array<f32, 1024>;',
    // 第 idx 個 A 元素（列 idx/8、欄 idx%8）：全域位址
    'fn ldA(base: u32, row0: u32, kb: u32, idx: u32) -> f32 {',
    '  let gr = row0 + idx / 8u; let gk = kb + idx % 8u;',
    '  if (gr >= p.M || gk >= p.K) { return 0.0; }',
    ldA,
    '}',
    // 第 idx 個 B 元素（列 idx/64、欄 idx%64）
    'fn ldB(base: u32, col0: u32, kb: u32, idx: u32) -> f32 {',
    '  let gk2 = kb + idx / 64u; let gc = col0 + idx % 64u;',
    '  if (gk2 >= p.K || gc >= p.N) { return 0.0; }',
    ldB,
    '}',
    // Bs 的寫入位置：列 bk、欄 bc 放在 bk·64 + (bc%4)·16 + bc/4（讀取時同 warp 連續銀行）
    'fn bsPos(buf: u32, idx: u32) -> u32 {',
    '  let bk = idx / 64u; let bc = idx % 64u;',
    '  return buf * 512u + bk * 64u + (bc % 4u) * 16u + bc / 4u;',
    '}',
    '@compute @workgroup_size(16, 16, 1)',
    'fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {',
    '  let n = wid.z;',
    '  let row0 = wid.y * 64u;',
    '  let col0 = wid.x * 64u;',
    '  let ao = n * p.M * p.K;',
    '  var bo = 0u;',
    '  if (p.Bb != 1u) { bo = n * p.K * p.N; }',
    '  let tid = lid.y * 16u + lid.x;',
    '  var acc: array<f32, 16>;',
    '  for (var i: u32 = 0u; i < 16u; i = i + 1u) { acc[i] = 0.0; }',
    '  let tiles = (p.K + 7u) / 8u;',
    '  var ra: array<f32, 2>;',
    '  var rb: array<f32, 2>;',
    // 第 0 塊：直接載入到緩衝 0
    '  for (var s: u32 = 0u; s < 2u; s = s + 1u) {',
    '    let idx = tid + s * 256u;',
    '    As[(idx / 8u) * 9u + idx % 8u] = ldA(ao, row0, 0u, idx);',
    '    Bs[bsPos(0u, idx)] = ldB(bo, col0, 0u, idx);',
    '  }',
    '  workgroupBarrier();',
    '  for (var t: u32 = 0u; t < tiles; t = t + 1u) {',
    '    let cur = t & 1u;',
    '    let nxt = 1u - cur;',
    '    let hasNext = t + 1u < tiles;',
    '    if (hasNext) {',
    '      for (var s: u32 = 0u; s < 2u; s = s + 1u) {',
    '        let idx = tid + s * 256u;',
    '        ra[s] = ldA(ao, row0, (t + 1u) * 8u, idx);',
    '        rb[s] = ldB(bo, col0, (t + 1u) * 8u, idx);',
    '      }',
    '    }',
    '    for (var kk: u32 = 0u; kk < 8u; kk = kk + 1u) {',
    '      var ca: array<f32, 4>;',
    '      var cb: array<f32, 4>;',
    '      for (var i: u32 = 0u; i < 4u; i = i + 1u) { ca[i] = As[cur * 576u + (lid.y * 4u + i) * 9u + kk]; }',
    '      for (var j: u32 = 0u; j < 4u; j = j + 1u) { cb[j] = Bs[cur * 512u + kk * 64u + j * 16u + lid.x]; }',
    '      for (var i: u32 = 0u; i < 4u; i = i + 1u) {',
    '        for (var j: u32 = 0u; j < 4u; j = j + 1u) { acc[i * 4u + j] = acc[i * 4u + j] + ca[i] * cb[j]; }',
    '      }',
    '    }',
    '    if (hasNext) {',
    '      for (var s: u32 = 0u; s < 2u; s = s + 1u) {',
    '        let idx = tid + s * 256u;',
    '        As[nxt * 576u + (idx / 8u) * 9u + idx % 8u] = ra[s];',
    '        Bs[bsPos(nxt, idx)] = rb[s];',
    '      }',
    '    }',
    '    workgroupBarrier();',
    '  }',
    '  for (var i: u32 = 0u; i < 4u; i = i + 1u) {',
    '    let gr = row0 + lid.y * 4u + i;',
    '    if (gr >= p.M) { continue; }',
    '    for (var j: u32 = 0u; j < 4u; j = j + 1u) {',
    '      let gc = col0 + lid.x * 4u + j;',
    '      if (gc < p.N) { y[(n * p.M + gr) * p.N + gc] = acc[i * 4u + j]; }',
    '    }',
    '  }',
    '}'
  ].join('\n');
}
module.exports = { mmGeomWgsl: mmGeomWgsl, mmGeomDims: mmGeomDims, mmVec4TWgsl: mmVec4TWgsl, mmVec4TOk: mmVec4TOk, mmPipeWgsl: mmPipeWgsl };
