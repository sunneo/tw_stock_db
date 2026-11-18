// kernel_templates.js — cudaweb 自訂核心樣板（O14c）。
// 三個樣板：reduce（分層歸約：每個執行緒先跨步累加，再用共用記憶體樹狀歸約；不是單執行緒）、
// transpose（共用記憶體分塊轉置，列寬加 1 避開記憶體組衝突）、scan（區塊 Hillis–Steele 前綴和，區塊總和遞迴掃描）。
// 每個樣板提供：
//   1. WGSL 產生器（工作群組大小與分塊大小由能力表決定，超過上限丟錯）；
//   2. CPU 參考（雙精度或逐步 f32，依樣板而定）；
//   3. JS 索引模擬（逐工作群組、逐階段照 WGSL 的順序執行，屏障就是階段邊界）。
// 限制：模擬驗的是主機端的索引與階段邏輯，不驗 WGSL 本身；WGSL 在真 GPU 上沒有驗證（見 docs/CHECKLIST.cudaweb-optimize.md O14c）。
// 這個模組目前只被測試與範例使用；gpu_core.js 的既有核心（WG=256、平鋪 16）維持不變，沒有接進它的派發路徑。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FaKernelTemplates = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var F32_LOWEST = -3.4028234663852886e38;   // f32 最小有限值（max 的單位元）
  var F32_HIGHEST = 3.4028234663852886e38;   // f32 最大有限值（min 的單位元）
  var REDUCE_OPS = {
    sum: { id: 0, comb: function (a, b) { return Math.fround(a + b); }, wgsl: 'a + b' },
    max: { id: F32_LOWEST, comb: function (a, b) { return a > b ? a : b; }, wgsl: 'max(a, b)' },
    min: { id: F32_HIGHEST, comb: function (a, b) { return a < b ? a : b; }, wgsl: 'min(a, b)' }
  };

  function isPow2(v) { return v >= 1 && (v & (v - 1)) === 0; }
  function must(cond, msg) { if (!cond) throw new Error(msg); }

  // 依能力表選參數。caps：{ maxInvocations, maxWgStorage }（位元組）。
  // reduce／scan 的工作群組：不超過 256 的最大 2 的冪次，且不超過 maxInvocations。
  // transpose 的分塊 T：最大的 T（16、8、4、2、1），需 T×T ≤ maxInvocations 且 T×(T+1)×4 ≤ maxWgStorage。
  // 低階（Kepler 這類：256 執行緒、16 KiB 共用記憶體）→ wg=256、T=16。
  function pickParams(caps) {
    must(caps && typeof caps === 'object', 'pickParams：caps 必須是物件');
    var maxInv = caps.maxInvocations, maxSt = caps.maxWgStorage;
    must(Number.isFinite(maxInv) && maxInv >= 1, 'pickParams：maxInvocations 必須是 ≥1 的數字，收到 ' + maxInv);
    must(Number.isFinite(maxSt) && maxSt >= 4, 'pickParams：maxWgStorage 必須是 ≥4 的數字，收到 ' + maxSt);
    var cap = Math.min(256, maxInv), wg = 1;
    while (wg * 2 <= cap) wg *= 2;
    var tile = 1;
    var cands = [16, 8, 4, 2, 1];
    for (var i = 0; i < cands.length; i++) {
      var T = cands[i];
      if (T * T <= maxInv && T * (T + 1) * 4 <= maxSt) { tile = T; break; }
    }
    return { wg: wg, tile: tile, stepsScan: Math.round(Math.log2(wg)) };
  }

  // ---------- reduce ----------
  function reduceWgsl(op, wg) {
    must(REDUCE_OPS[op], 'reduceWgsl：不支援的運算 ' + op + '（支援 sum、max、min）');
    must(isPow2(wg), 'reduceWgsl：工作群組大小必須是 2 的冪次，收到 ' + wg);
    var o = REDUCE_OPS[op];
    return [
      'struct P { n: u32, groups: u32, a: u32, b: u32 }',
      '@group(0) @binding(0) var<storage, read> inp: array<f32>;',
      '@group(0) @binding(1) var<storage, read_write> outp: array<f32>;',
      '@group(0) @binding(2) var<uniform> p: P;',
      'var<workgroup> sh: array<f32, ' + wg + '>;',
      '@compute @workgroup_size(' + wg + ')',
      'fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>,',
      '        @builtin(num_workgroups) nwg: vec3<u32>) {',
      '  // @kernel reduce_' + op,
      '  var acc: f32 = ' + (op === 'sum' ? '0.0' : op === 'max' ? '-3.4028234663852886e38' : '3.4028234663852886e38') + ';',
      '  var i: u32 = wid.x * ' + wg + 'u + lid.x;',
      '  let stride: u32 = ' + wg + 'u * nwg.x;',
      '  loop {',
      '    if (i >= p.n) { break; }',
      '    let a = acc; let b = inp[i];',
      '    acc = ' + o.wgsl + ';',
      '    i = i + stride;',
      '  }',
      '  sh[lid.x] = acc;',
      '  workgroupBarrier();',
      '  var s: u32 = ' + (wg / 2) + 'u;',
      '  loop {',
      '    if (s == 0u) { break; }',
      '    if (lid.x < s) { let a = sh[lid.x]; let b = sh[lid.x + s]; sh[lid.x] = ' + o.wgsl + '; }',
      '    workgroupBarrier();',
      '    s = s / 2u;',
      '  }',
      '  if (lid.x == 0u) { outp[wid.x] = sh[0]; }',
      '}'
    ].join('\n');
  }
  // 主機端分層：每一層的工作群組數 g = min(wg, ceil(len/wg))，直到剩 1 個值。
  function reduceGroups(len, wg) { return Math.min(wg, Math.ceil(len / wg)); }
  function reduceRef(op, arr) {
    must(REDUCE_OPS[op], 'reduceRef：不支援的運算 ' + op);
    var acc = REDUCE_OPS[op].id, comb = REDUCE_OPS[op].comb;
    if (op === 'sum') { var d = 0; for (var i = 0; i < arr.length; i++) d += Math.fround(arr[i]); return Math.fround(d); }
    for (var j = 0; j < arr.length; j++) acc = comb(acc, Math.fround(arr[j]));
    return acc;
  }
  // 照 WGSL 的順序模擬：每一層、每個工作群組、跨步累加、樹狀歸約（每個 s 之後是一個屏障）。
  function simReduce(op, arr, wg) {
    must(REDUCE_OPS[op], 'simReduce：不支援的運算 ' + op);
    must(isPow2(wg), 'simReduce：工作群組大小必須是 2 的冪次，收到 ' + wg);
    var o = REDUCE_OPS[op];
    var cur = Array.from(arr, Math.fround), len = cur.length;
    if (len === 0) return o.id;
    while (len > 1) {
      var g = reduceGroups(len, wg), out = new Array(g);
      for (var w = 0; w < g; w++) {
        var sh = new Array(wg);
        for (var t = 0; t < wg; t++) {         // 階段 1：跨步累加
          var acc = o.id;
          for (var i = w * wg + t; i < len; i += wg * g) acc = o.comb(acc, cur[i]);
          sh[t] = acc;
        }
        for (var s = wg >> 1; s > 0; s = s >> 1) {   // 階段 2：樹狀歸約（屏障＝階段邊界）；wg=1 時不進迴圈
          for (var u = 0; u < s; u++) sh[u] = o.comb(sh[u], sh[u + s]);
        }
        out[w] = sh[0];
      }
      cur = out; len = g;
    }
    return cur[0];
  }

  // ---------- transpose ----------
  function transposeWgsl(tile) {
    must(Number.isInteger(tile) && tile >= 1, 'transposeWgsl：分塊大小必須是 ≥1 的整數，收到 ' + tile);
    var T = tile, S = T + 1;
    return [
      'struct P { m: u32, n: u32, a: u32, b: u32 }',
      '@group(0) @binding(0) var<storage, read> A: array<f32>;',
      '@group(0) @binding(1) var<storage, read_write> O: array<f32>;',
      '@group(0) @binding(2) var<uniform> p: P;',
      'var<workgroup> tile: array<f32, ' + (T * S) + '>;',
      '@compute @workgroup_size(' + T + ', ' + T + ')',
      'fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {',
      '  // @kernel transpose_tile',
      '  let x = wid.x * ' + T + 'u + lid.x;',
      '  let y = wid.y * ' + T + 'u + lid.y;',
      '  if (x < p.n && y < p.m) { tile[lid.y * ' + S + 'u + lid.x] = A[y * p.n + x]; }',
      '  workgroupBarrier();',
      '  let ox = wid.y * ' + T + 'u + lid.x;',
      '  let oy = wid.x * ' + T + 'u + lid.y;',
      '  if (ox < p.m && oy < p.n) { O[oy * p.m + ox] = tile[lid.x * ' + S + 'u + lid.y]; }',
      '}'
    ].join('\n');
  }
  function transposeRef(A, m, n) {
    must(A.length === m * n, 'transposeRef：元素數 ' + A.length + ' 與 m×n=' + (m * n) + ' 不符');
    var out = new Array(m * n);
    for (var j = 0; j < n; j++) for (var i = 0; i < m; i++) out[j * m + i] = Math.fround(A[i * n + j]);
    return out;
  }
  // 照 WGSL 模擬：每個工作群組（wx, wy）兩階段：先把分塊載入共用記憶體（列寬 T+1），屏障後再依轉置後的座標寫出。
  function simTranspose(A, m, n, tile) {
    must(A.length === m * n, 'simTranspose：元素數 ' + A.length + ' 與 m×n=' + (m * n) + ' 不符');
    var T = tile, S = T + 1, out = new Array(m * n);
    var gx = Math.ceil(n / T), gy = Math.ceil(m / T);
    for (var wy = 0; wy < gy; wy++) for (var wx = 0; wx < gx; wx++) {
      var sh = new Array(T * S).fill(0);
      for (var ly = 0; ly < T; ly++) for (var lx = 0; lx < T; lx++) {   // 階段 1
        var x = wx * T + lx, y = wy * T + ly;
        if (x < n && y < m) sh[ly * S + lx] = Math.fround(A[y * n + x]);
      }
      for (var ly2 = 0; ly2 < T; ly2++) for (var lx2 = 0; lx2 < T; lx2++) {   // 階段 2（屏障之後）
        var ox = wy * T + lx2, oy = wx * T + ly2;
        if (ox < m && oy < n) out[oy * m + ox] = sh[lx2 * S + ly2];
      }
    }
    return out;
  }

  // ---------- scan（包含式前綴和）----------
  // wg 必須 ≥2：wg=1 時區塊總和與輸入等長，遞迴不會縮短（軟體 adapter 應改走 CPU 前綴和）。
  function scanWgsl(wg) {
    must(isPow2(wg) && wg >= 2, 'scanWgsl：工作群組大小必須是 ≥2 的 2 的冪次，收到 ' + wg);
    var steps = Math.round(Math.log2(wg));
    return [
      'struct P { n: u32, a: u32, b: u32, c: u32 }',
      '@group(0) @binding(0) var<storage, read> IN: array<f32>;',
      '@group(0) @binding(1) var<storage, read_write> OUT: array<f32>;',
      '@group(0) @binding(2) var<storage, read_write> BSUM: array<f32>;',
      '@group(0) @binding(3) var<uniform> p: P;',
      'var<workgroup> s: array<f32, ' + wg + '>;',
      '@compute @workgroup_size(' + wg + ')',
      'fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {',
      '  // @kernel scan_block_' + wg,
      '  let t = lid.x;',
      '  let i = wid.x * ' + wg + 'u + t;',
      '  var v: f32 = 0.0;',
      '  if (i < p.n) { v = IN[i]; }',
      '  s[t] = v;',
      '  workgroupBarrier();',
      '  for (var k: u32 = 0u; k < ' + steps + 'u; k = k + 1u) {',
      '    let off = 1u << k;',
      '    var add: f32 = 0.0;',
      '    if (t >= off) { add = s[t - off]; }',
      '    workgroupBarrier();',
      '    s[t] = s[t] + add;',
      '    workgroupBarrier();',
      '  }',
      '  if (i < p.n) { OUT[i] = s[t]; }',
      '  if (t == ' + (wg - 1) + 'u) { BSUM[wid.x] = s[' + (wg - 1) + ']; }',
      '}'
    ].join('\n');
  }
  function scanRef(arr) {
    var out = new Array(arr.length), acc = 0;   // 雙精度累加，給 f32 結果當比對基準
    for (var i = 0; i < arr.length; i++) { acc += Math.fround(arr[i]); out[i] = acc; }
    return out;
  }
  // 照 WGSL 模擬整個遞迴流程：區塊掃描（Hillis–Steele，每一步兩個屏障）→ 區塊總和遞迴 → 加上前區塊的偏移。
  function simScan(arr, wg) {
    must(isPow2(wg) && wg >= 2, 'simScan：工作群組大小必須是 ≥2 的 2 的冪次，收到 ' + wg);
    var n = arr.length;
    if (n === 0) return [];
    var inp = Array.from(arr, Math.fround), nb = Math.ceil(n / wg);
    var out = new Array(n), bsum = new Array(nb);
    for (var b = 0; b < nb; b++) {
      var s = new Array(wg);
      for (var t = 0; t < wg; t++) { var i = b * wg + t; s[t] = i < n ? inp[i] : 0; }
      for (var off = 1; off < wg; off = off * 2) {
        var add = new Array(wg);
        for (var t2 = 0; t2 < wg; t2++) add[t2] = t2 >= off ? s[t2 - off] : 0;
        for (var t3 = 0; t3 < wg; t3++) s[t3] = Math.fround(s[t3] + add[t3]);
      }
      for (var t4 = 0; t4 < wg; t4++) { var j = b * wg + t4; if (j < n) out[j] = s[t4]; }
      bsum[b] = s[wg - 1];
    }
    if (nb > 1) {
      var scanned = simScan(bsum, wg);
      for (var c = 1; c < nb; c++) {
        for (var t5 = 0; t5 < wg; t5++) { var k = c * wg + t5; if (k < n) out[k] = Math.fround(out[k] + scanned[c - 1]); }
      }
    }
    return out;
  }

  return {
    REDUCE_OPS: Object.keys(REDUCE_OPS),
    pickParams: pickParams,
    reduceWgsl: reduceWgsl,
    reduceGroups: reduceGroups,
    reduceRef: reduceRef,
    simReduce: simReduce,
    transposeWgsl: transposeWgsl,
    transposeRef: transposeRef,
    simTranspose: simTranspose,
    scanWgsl: scanWgsl,
    scanRef: scanRef,
    simScan: simScan
  };
});
