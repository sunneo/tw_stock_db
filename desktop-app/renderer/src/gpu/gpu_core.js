/* gpu_core.js — 第一階段 WebGPU 核心（DESIGN.webgpu-cuda.md §4、§7）。
 * 內容：能力偵測、CPU 參考版、WGSL 核心（向量加、矩陣乘、歸約）、執行期（降級與回報）。
 * 純 UMD：node 可直接 require 測試；嵌入 floating-assistant.js 後在主執行緒用 new Function 載入。
 * 降級層（本階段只用 T1、T4；T2、T3 留待第二階段與後續）：
 *   T1 wgsl-native：WebGPU 裝置可用，執行 WGSL 核心。
 *   T4 cpu-fallback：沒有 WebGPU、沒有介面卡、要求裝置失敗、超過儲存緩衝上限、裝置遺失、核心執行失敗 → 改跑 CPU 參考版，並寫明原因。
 * 數值：f32 累加；WGSL 版與 CPU 版的累加順序不同，結果不宣稱位元相同（DESIGN.webgpu-cuda.md §13）。
 * 容差是暫定值（c·√k·2⁻²³），尚未實測，見 tolerance()。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FaGpuCore = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var WG = 256;            // 向量與歸約的 workgroup 大小
  var TILE = 16;           // 矩陣乘的平鋪邊長（workgroup 16×16）
  var DEFAULT_STORAGE_MAX = 134217728; // WebGPU 規格預設 maxStorageBufferBindingSize（128 MiB，【查證】w3cub 整理）
  var EPS32 = Math.pow(2, -23);
  // GPUBufferUsage 數值（以字面數字寫，不依賴全域常數，方便 node 與假裝置測試）
  var USAGE = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 };

  function msg(e) { return String((e && e.message) || e); }

  // ---------- 能力偵測 ----------
  // 不丟例外：回傳 { probe: {...}, adapter }。probe.reason 在不可用時必填（給使用者看的具體原因）。
  async function probeAdapter(nav) {
    var probe = { hasWebGPU: false, hasAdapter: false, reason: '', features: [], limits: {} };
    if (!nav || !nav.gpu || typeof nav.gpu.requestAdapter !== 'function') {
      probe.reason = '此環境沒有 WebGPU（navigator.gpu 不存在）';
      return { probe: probe, adapter: null };
    }
    probe.hasWebGPU = true;
    var adapter = null;
    try { adapter = await nav.gpu.requestAdapter(); }
    catch (e) { probe.reason = '請求顯示卡介面卡失敗：' + msg(e); return { probe: probe, adapter: null }; }
    if (!adapter) { probe.reason = '沒有可用的顯示卡介面卡（requestAdapter 回傳空值）'; return { probe: probe, adapter: null }; }
    probe.hasAdapter = true;
    try { probe.features = Array.from(adapter.features || []).sort(); } catch (_) { probe.features = []; }
    var L = adapter.limits || {};
    probe.limits = {
      maxStorageBufferBindingSize: L.maxStorageBufferBindingSize || null,
      maxComputeWorkgroupStorageSize: L.maxComputeWorkgroupStorageSize || null,
      maxComputeInvocationsPerWorkgroup: L.maxComputeInvocationsPerWorkgroup || null
    };
    return { probe: probe, adapter: adapter };
  }

  // ---------- 容差（暫定，未實測） ----------
  // 內積長度 k 的相對誤差上限：c·√k·ε。c 由實測決定；此處先取 c = 8。
  function tolerance(k) { return 8 * Math.sqrt(Math.max(1, k)) * EPS32; }

  // ---------- CPU 參考版（累加順序與 WGSL 版對齊到能對齊的程度：矩陣乘 k 序列、歸約為順序加總） ----------
  function vectorAddRef(a, b) {
    var out = new Float32Array(a.length);
    for (var i = 0; i < a.length; i++) out[i] = Math.fround(a[i] + b[i]);
    return out;
  }
  function matmulRef(A, B, m, k, n) {
    var C = new Float32Array(m * n);
    for (var r = 0; r < m; r++) for (var c = 0; c < n; c++) {
      var acc = 0;
      for (var t = 0; t < k; t++) acc = Math.fround(acc + Math.fround(A[r * k + t] * B[t * n + c]));
      C[r * n + c] = acc;
    }
    return C;
  }
  function sumRef(a) {
    var acc = 0;
    for (var i = 0; i < a.length; i++) acc = Math.fround(acc + a[i]);
    return acc;
  }
  // 比較用的高精度參考（f64），量誤差用，不作為結果。
  function sumExact(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }

  // ---------- WGSL 核心 ----------
  // 每段第一行的 @kernel 標記給假裝置測試辨識用；真裝置不影響執行。
  var WGSL_VECTOR_ADD = [
    '// @kernel vector_add',
    'struct Params { n: u32, p1: u32, p2: u32, p3: u32 }',
    '@group(0) @binding(0) var<storage, read> a: array<f32>;',
    '@group(0) @binding(1) var<storage, read> b: array<f32>;',
    '@group(0) @binding(2) var<storage, read_write> c: array<f32>;',
    '@group(0) @binding(3) var<uniform> p: Params;',
    '@compute @workgroup_size(' + WG + ')',
    'fn main(@builtin(global_invocation_id) gid: vec3<u32>) {',
    '  let i = gid.x;',
    '  if (i < p.n) { c[i] = a[i] + b[i]; }',
    '}'
  ].join('\n');

  var WGSL_MATMUL = [
    '// @kernel matmul',
    'struct Params { m: u32, k: u32, n: u32, p1: u32 }',
    '@group(0) @binding(0) var<storage, read> A: array<f32>;',
    '@group(0) @binding(1) var<storage, read> B: array<f32>;',
    '@group(0) @binding(2) var<storage, read_write> C: array<f32>;',
    '@group(0) @binding(3) var<uniform> p: Params;',
    'var<workgroup> ta: array<f32, ' + (TILE * TILE) + '>;',
    'var<workgroup> tb: array<f32, ' + (TILE * TILE) + '>;',
    '@compute @workgroup_size(' + TILE + ', ' + TILE + ', 1)',
    'fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {',
    '  let row = gid.y;',
    '  let col = gid.x;',
    '  var acc: f32 = 0.0;',
    '  let tiles = (p.k + ' + (TILE - 1) + 'u) / ' + TILE + 'u;',
    '  for (var t: u32 = 0u; t < tiles; t = t + 1u) {',
    '    let ac = t * ' + TILE + 'u + lid.x;',
    '    let br = t * ' + TILE + 'u + lid.y;',
    '    var av: f32 = 0.0;',
    '    if (row < p.m && ac < p.k) { av = A[row * p.k + ac]; }',
    '    var bv: f32 = 0.0;',
    '    if (br < p.k && col < p.n) { bv = B[br * p.n + col]; }',
    '    ta[lid.y * ' + TILE + 'u + lid.x] = av;',
    '    tb[lid.y * ' + TILE + 'u + lid.x] = bv;',
    '    workgroupBarrier();',
    '    for (var kk: u32 = 0u; kk < ' + TILE + 'u; kk = kk + 1u) {',
    '      acc = acc + ta[lid.y * ' + TILE + 'u + kk] * tb[kk * ' + TILE + 'u + lid.x];',
    '    }',
    '    workgroupBarrier();',
    '  }',
    '  if (row < p.m && col < p.n) { C[row * p.n + col] = acc; }',
    '}'
  ].join('\n');

  // 歸約：每個 workgroup 以步進迴圈取數、再做樹狀歸約，寫出一個部分和；多輪直到剩一個值。
  var WGSL_SUM = [
    '// @kernel sum',
    'struct Params { n: u32, p1: u32, p2: u32, p3: u32 }',
    '@group(0) @binding(0) var<storage, read> inp: array<f32>;',
    '@group(0) @binding(1) var<storage, read_write> outp: array<f32>;',
    '@group(0) @binding(2) var<uniform> p: Params;',
    'var<workgroup> sh: array<f32, ' + WG + '>;',
    '@compute @workgroup_size(' + WG + ')',
    'fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>,',
    '        @builtin(workgroup_id) wid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {',
    '  var acc: f32 = 0.0;',
    '  var i: u32 = gid.x;',
    '  let stride: u32 = ' + WG + 'u * nwg.x;',
    '  loop {',
    '    if (i >= p.n) { break; }',
    '    acc = acc + inp[i];',
    '    i = i + stride;',
    '  }',
    '  sh[lid.x] = acc;',
    '  workgroupBarrier();',
    '  var s: u32 = ' + (WG / 2) + 'u;',
    '  loop {',
    '    if (s == 0u) { break; }',
    '    if (lid.x < s) { sh[lid.x] = sh[lid.x] + sh[lid.x + s]; }',
    '    workgroupBarrier();',
    '    s = s / 2u;',
    '  }',
    '  if (lid.x == 0u) { outp[wid.x] = sh[0]; }',
    '}'
  ].join('\n');

  // ---------- 執行期 ----------
  // opts.navigator：注入的 navigator（測試用假物件；網頁與桌面版傳 window.navigator）。
  function createRuntime(opts) {
    opts = opts || {};
    var nav = opts.navigator;
    var st = { ready: null, device: null, probe: null, lost: null, pipes: {}, last: null, log: [], calls: 0 };

    function ensure() {
      if (!st.ready) {
        st.ready = (async function () {
          var pa = await probeAdapter(nav);
          st.probe = pa.probe;
          if (!pa.adapter) return null;
          try {
            st.device = await pa.adapter.requestDevice();
          } catch (e) {
            st.probe.reason = '要求 WebGPU 裝置失敗：' + msg(e);
            return null;
          }
          var dev = st.device;
          if (dev.lost && typeof dev.lost.then === 'function') {
            dev.lost.then(function (info) {
              st.lost = '裝置遺失（' + ((info && (info.message || info.reason)) || '未知原因') + '），之後的呼叫改用 CPU';
              st.device = null; st.pipes = {};
            });
          }
          return dev;
        })();
      }
      return st.ready;
    }

    function maxBytes() {
      var d = st.device;
      var lim = d && d.limits && d.limits.maxStorageBufferBindingSize;
      return lim || DEFAULT_STORAGE_MAX;
    }

    function makeBuf(dev, data, usage) {
      var buf = dev.createBuffer({ size: Math.max(4, data.byteLength), usage: usage });
      dev.queue.writeBuffer(buf, 0, data);
      return buf;
    }
    function uniform(dev, u32s) { return makeBuf(dev, new Uint32Array(u32s), USAGE.UNIFORM | USAGE.COPY_DST); }

    function pipeline(dev, key, code, entry) {
      if (!st.pipes[key]) {
        var mod = dev.createShaderModule({ code: code });
        st.pipes[key] = dev.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: entry } });
      }
      return st.pipes[key];
    }

    function dispatch(dev, pipe, bufs, gx, gy) {
      var bg = dev.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: bufs.map(function (b, i) { return { binding: i, resource: { buffer: b } }; })
      });
      var enc = dev.createCommandEncoder();
      var pass = enc.beginComputePass();
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(gx, gy || 1, 1);
      pass.end();
      dev.queue.submit([enc.finish()]);
    }

    async function readBack(dev, buf, count) {
      var bytes = count * 4;
      var rb = dev.createBuffer({ size: bytes, usage: USAGE.MAP_READ | USAGE.COPY_DST });
      var enc = dev.createCommandEncoder();
      enc.copyBufferToBuffer(buf, 0, rb, 0, bytes);
      dev.queue.submit([enc.finish()]);
      await rb.mapAsync(USAGE.MAP_READ);
      var out = new Float32Array(rb.getMappedRange().slice(0));
      rb.unmap();
      rb.destroy();
      return out;
    }

    // 有驗證錯誤範圍包住 GPU 工作：驗證錯誤（著色器編譯等）會變成例外，走降級。
    async function withScope(dev, fn) {
      dev.pushErrorScope('validation');
      var out;
      try { out = await fn(); }
      finally {
        var err = await dev.popErrorScope();
        if (err) throw new Error('WGSL 驗證錯誤：' + msg(err.message || err));
      }
      return out;
    }

    function gpuVectorAdd(dev, a, b) {
      return withScope(dev, async function () {
        var n = a.length;
        var ba = makeBuf(dev, a, USAGE.STORAGE | USAGE.COPY_DST);
        var bb = makeBuf(dev, b, USAGE.STORAGE | USAGE.COPY_DST);
        var bc = dev.createBuffer({ size: Math.max(4, n * 4), usage: USAGE.STORAGE | USAGE.COPY_SRC });
        var bp = uniform(dev, [n, 0, 0, 0]);
        dispatch(dev, pipeline(dev, 'vector_add', WGSL_VECTOR_ADD, 'main'), [ba, bb, bc, bp], Math.ceil(n / WG));
        return readBack(dev, bc, n);
      });
    }

    function gpuMatmul(dev, A, B, m, k, n) {
      return withScope(dev, async function () {
        var ba = makeBuf(dev, A, USAGE.STORAGE | USAGE.COPY_DST);
        var bb = makeBuf(dev, B, USAGE.STORAGE | USAGE.COPY_DST);
        var bc = dev.createBuffer({ size: Math.max(4, m * n * 4), usage: USAGE.STORAGE | USAGE.COPY_SRC });
        var bp = uniform(dev, [m, k, n, 0]);
        dispatch(dev, pipeline(dev, 'matmul', WGSL_MATMUL, 'main'), [ba, bb, bc, bp], Math.ceil(n / TILE), Math.ceil(m / TILE));
        return readBack(dev, bc, m * n);
      });
    }

    function gpuSum(dev, a) {
      return withScope(dev, async function () {
        var len = a.length;
        var cur = makeBuf(dev, a, USAGE.STORAGE | USAGE.COPY_DST);
        var pipe = pipeline(dev, 'sum', WGSL_SUM, 'main');
        while (len > 1) {
          var g = Math.min(WG, Math.ceil(len / WG));
          var out = dev.createBuffer({ size: g * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC });
          var bp = uniform(dev, [len, 0, 0, 0]);
          dispatch(dev, pipe, [cur, out, bp], g);
          cur = out; len = g;
        }
        var r = await readBack(dev, cur, 1);
        return r[0];
      });
    }

    // 統一入口：先試 T1，任何原因退到 T4，並寫進 log 與 last。
    async function run(op, cpuFn, gpuFn, bytes) {
      st.calls++;
      var dev = await ensure();
      var reason = null;
      if (st.lost) reason = st.lost;
      else if (!dev) reason = (st.probe && st.probe.reason) || '沒有 WebGPU 裝置';
      else if (bytes > maxBytes()) reason = '輸入超過裝置的儲存緩衝上限（需要 ' + bytes + ' 位元組，上限 ' + maxBytes() + '）';
      if (!reason) {
        try {
          var v = await gpuFn(dev);
          return record(op, { result: v, layer: 'T1', via: 'wgsl-native', reason: '' });
        } catch (e) {
          reason = 'WGSL 核心執行失敗，改用 CPU 參考版（' + msg(e) + '）';
        }
      }
      var cv = cpuFn();
      return record(op, { result: cv, layer: 'T4', via: 'cpu-fallback', reason: reason });
    }

    function record(op, r) {
      var info = {
        lib: 'cudaweb', op: op, layer: r.layer, via: r.via, reason: r.reason,
        accumulate: 'f32', reductionOrder: op === 'sum' ? 'tree-wg256' : (op === 'matmul' ? 'k-sequential' : 'elementwise')
      };
      st.last = info;
      if (r.reason) st.log.push({ op: op, layer: r.layer, reason: r.reason });
      return { result: r.result, info: info };
    }

    function toF32(arr, name) {
      if (!Array.isArray(arr) && !(arr instanceof Float32Array) && !(arr && typeof arr.length === 'number')) throw new Error('cudaweb：' + name + ' 必須是數字陣列');
      var out = new Float32Array(arr.length);
      for (var i = 0; i < arr.length; i++) {
        var x = Number(arr[i]);
        if (!isFinite(x)) throw new Error('cudaweb：' + name + '[' + i + '] 不是有限數字（' + arr[i] + '）');
        out[i] = x;
      }
      return out;
    }

    return {
      // 向量加：a、b 等長，回傳 c = a + b（f32）
      vectorAdd: async function (a, b) {
        var A = toF32(a, 'a'), B = toF32(b, 'b');
        if (A.length !== B.length) throw new Error('cudaweb.vector_add：兩個向量長度不同（' + A.length + ' 與 ' + B.length + '）');
        return run('vector_add', function () { return Array.from(vectorAddRef(A, B)); },
          function (dev) { return gpuVectorAdd(dev, A, B).then(Array.from); }, A.length * 4 * 3);
      },
      // 矩陣乘：A 為 m×k、B 為 k×n（列主序扁平陣列），回傳 m×n 扁平陣列
      matmul: async function (A, B, m, k, n) {
        var MA = toF32(A, 'A'), MB = toF32(B, 'B');
        if (MA.length !== m * k) throw new Error('cudaweb.matmul：A 的元素數 ' + MA.length + ' 與 m×k=' + (m * k) + ' 不符');
        if (MB.length !== k * n) throw new Error('cudaweb.matmul：B 的元素數 ' + MB.length + ' 與 k×n=' + (k * n) + ' 不符');
        return run('matmul', function () { return Array.from(matmulRef(MA, MB, m, k, n)); },
          function (dev) { return gpuMatmul(dev, MA, MB, m, k, n).then(Array.from); }, (MA.length + MB.length + m * n) * 4);
      },
      // 歸約：總和（f32，樹狀順序）
      sum: async function (a) {
        var A = toF32(a, 'a');
        return run('sum', function () { return sumRef(A); },
          function (dev) { return gpuSum(dev, A); }, A.length * 4 * 2);
      },
      // 目前狀態：能力偵測結果、最後一次呼叫、降級紀錄（最近 50 筆）
      backendInfo: async function () {
        await ensure();
        return {
          hasWebGPU: !!(st.probe && st.probe.hasWebGPU),
          hasAdapter: !!(st.probe && st.probe.hasAdapter),
          probeReason: st.probe ? st.probe.reason : '',
          features: st.probe ? st.probe.features : [],
          limits: st.probe ? st.probe.limits : {},
          deviceReady: !!st.device,
          last: st.last,
          calls: st.calls,
          degradeLog: st.log.slice(-50)
        };
      }
    };
  }

  return {
    probeAdapter: probeAdapter,
    tolerance: tolerance,
    vectorAddRef: vectorAddRef,
    matmulRef: matmulRef,
    sumRef: sumRef,
    sumExact: sumExact,
    kernels: { vector_add: WGSL_VECTOR_ADD, matmul: WGSL_MATMUL, sum: WGSL_SUM },
    createRuntime: createRuntime,
    WG: WG,
    TILE: TILE
  };
}));
