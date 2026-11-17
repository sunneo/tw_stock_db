/* gpu_core.js — GPU 運算核心（DESIGN.webgpu-cuda.md §2、§3、§5、§8）。
 * 內容：能力偵測（WebGPU、WebGL2）、能力檔歸類、CPU 參考版、WGSL 核心、WebGL2 片段著色器核心、
 *       執行期（降級與回報）、GPU 緩衝區預算、運算排程（互斥加優先級、餓死防護）。
 * 純 UMD：node 可直接 require 測試；嵌入 floating-assistant.js 後在主執行緒用 new Function 載入（window.FaGpuCore）。
 * 降級層（DESIGN.webgpu-cuda.md §2.1）：T1 WGSL 原生、T3 WebGL2 GPGPU、T5 純 JS。T2（WGSL 替代實作）與 T4（WASM）尚未實作。
 * 數值：f32 累加；各層累加順序不同，結果不宣稱位元相同（§5.4）。容差為暫定值（c·√k·2⁻²³），尚未實測。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FaGpuCore = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var WG = 256;            // 一維 workgroup 大小
  var TILE = 16;           // 矩陣乘平鋪邊長
  var DEFAULT_STORAGE_MAX = 134217728;  // WebGPU 規格預設 maxStorageBufferBindingSize（128 MiB）
  var DEFAULT_WG_STORAGE = 16384;       // 規格預設 maxComputeWorkgroupStorageSize（16 KiB）
  var DEFAULT_BUDGET = 268435456;       // GPU 緩衝區預算預設 256 MiB（§8.1）
  var EPS32 = Math.pow(2, -23);

  // ===== 共用平鋪矩陣乘核心（gpu_core.js 的 WGSL.matmul 與 mm_ops.js 的平鋪版都用這一份）=====
  // 幾何：工作群組 16×16 執行緒，算一塊 64×64 輸出；每個執行緒在暫存器累加 4×4；A、B 各以 16 層一塊搬進共用記憶體。
  // 共用記憶體 2×64×16×4 B = 8 KiB（低階卡上限 16 KiB 以內）。批次在 workgroup_id.z；邊界逐元素檢查。
  // 參數 uniform（8 個 u32）：{ B, M, K, N, Bb, azp, bzp, p0 }；p0 bit0 = A 以 K×M 儲存（Aᵀ），bit1 = B 以 N×K 儲存（Bᵀ）。
  // 轉置只改搬入共用記憶體時的索引，計算迴圈不變。Bb = 1 表示所有批次共用同一份 B。
  // 分派：[ceil(N/64), ceil(M/64), B]。f16 版（dtype 'f16'）輸入為 f16、累加 f32，需要 shader-f16；本機 Kepler 無此功能，標「待驗證」。
  var MMT_OUT = 64, MMT_K = 16, MMT_WG = 16, MMT_REG = 4;
  function mmTileSharedBytes() { return 2 * MMT_OUT * MMT_K * 4; }
  function mmTileDispatch(M, N, B) { return [Math.ceil(N / MMT_OUT), Math.ceil(M / MMT_OUT), B || 1]; }
  function mmTileFlags(o) { o = o || {}; return (o.transA ? 1 : 0) | (o.transB ? 2 : 0); }
  function mmTileWords(M, K, N, flags, B) { return [B || 1, M, K, N, 1, 0, 0, flags || 0]; }
  function mmTileWgsl(opts) {
    opts = opts || {};
    var marker = opts.marker || 'matmul_tiled';
    var f16 = opts.dtype === 'f16';
    var T = f16 ? 'f16' : 'f32';
    var enable = f16 ? 'enable f16;\n' : '';
    return enable + '// @kernel ' + marker + '\n' + [
      'struct P { B: u32, M: u32, K: u32, N: u32, Bb: u32, azp: i32, bzp: i32, p0: u32 }',
      '@group(0) @binding(0) var<storage, read> a: array<' + T + '>;',
      '@group(0) @binding(1) var<storage, read> b: array<' + T + '>;',
      '@group(0) @binding(2) var<storage, read_write> y: array<f32>;',
      '@group(0) @binding(3) var<uniform> p: P;',
      'var<workgroup> As: array<f32, ' + (MMT_OUT * MMT_K) + '>;',
      'var<workgroup> Bs: array<f32, ' + (MMT_K * MMT_OUT) + '>;',
      '@compute @workgroup_size(' + MMT_WG + ', ' + MMT_WG + ', 1)',
      'fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {',
      '  let n = wid.z;',
      '  let row0 = wid.y * ' + MMT_OUT + 'u;',
      '  let col0 = wid.x * ' + MMT_OUT + 'u;',
      '  let ao = n * p.M * p.K;',
      '  var bo = 0u;',
      '  if (p.Bb != 1u) { bo = n * p.K * p.N; }',
      '  let tA = (p.p0 & 1u) != 0u;',
      '  let tB = (p.p0 & 2u) != 0u;',
      '  let tid = lid.y * ' + MMT_WG + 'u + lid.x;',
      '  var acc: array<f32, ' + (MMT_REG * MMT_REG) + '>;',
      '  for (var i: u32 = 0u; i < ' + (MMT_REG * MMT_REG) + 'u; i = i + 1u) { acc[i] = 0.0; }',
      '  let tiles = (p.K + ' + (MMT_K - 1) + 'u) / ' + MMT_K + 'u;',
      '  for (var t: u32 = 0u; t < tiles; t = t + 1u) {',
      '    let k0 = t * ' + MMT_K + 'u;',
      '    for (var s: u32 = 0u; s < ' + (MMT_OUT * MMT_K / (MMT_WG * MMT_WG)) + 'u; s = s + 1u) {',
      '      let idx = tid + s * ' + (MMT_WG * MMT_WG) + 'u;',
      '      let ar = idx / ' + MMT_K + 'u;',
      '      let ak = idx % ' + MMT_K + 'u;',
      '      let gr = row0 + ar;',
      '      let gk = k0 + ak;',
      '      var av: f32 = 0.0;',
      '      if (gr < p.M && gk < p.K) {',
      '        if (tA) { av = f32(a[ao + gk * p.M + gr]); } else { av = f32(a[ao + gr * p.K + gk]); }',
      '      }',
      '      As[idx] = av;',
      '      let bk = idx / ' + MMT_OUT + 'u;',
      '      let bc = idx % ' + MMT_OUT + 'u;',
      '      let gk2 = k0 + bk;',
      '      let gc = col0 + bc;',
      '      var bv: f32 = 0.0;',
      '      if (gk2 < p.K && gc < p.N) {',
      '        if (tB) { bv = f32(b[bo + gc * p.K + gk2]); } else { bv = f32(b[bo + gk2 * p.N + gc]); }',
      '      }',
      '      Bs[idx] = bv;',
      '    }',
      '    workgroupBarrier();',
      '    for (var kk: u32 = 0u; kk < ' + MMT_K + 'u; kk = kk + 1u) {',
      '      var ra: array<f32, ' + MMT_REG + '>;',
      '      var rb: array<f32, ' + MMT_REG + '>;',
      '      for (var i: u32 = 0u; i < ' + MMT_REG + 'u; i = i + 1u) {',
      '        ra[i] = As[(lid.y * ' + MMT_REG + 'u + i) * ' + MMT_K + 'u + kk];',
      '        rb[i] = Bs[kk * ' + MMT_OUT + 'u + lid.x * ' + MMT_REG + 'u + i];',
      '      }',
      '      for (var i: u32 = 0u; i < ' + MMT_REG + 'u; i = i + 1u) {',
      '        for (var j: u32 = 0u; j < ' + MMT_REG + 'u; j = j + 1u) { acc[i * ' + MMT_REG + 'u + j] = acc[i * ' + MMT_REG + 'u + j] + ra[i] * rb[j]; }',
      '      }',
      '    }',
      '    workgroupBarrier();',
      '  }',
      '  for (var i: u32 = 0u; i < ' + MMT_REG + 'u; i = i + 1u) {',
      '    let gr = row0 + lid.y * ' + MMT_REG + 'u + i;',
      '    if (gr >= p.M) { continue; }',
      '    for (var j: u32 = 0u; j < ' + MMT_REG + 'u; j = j + 1u) {',
      '      let gc = col0 + lid.x * ' + MMT_REG + 'u + j;',
      '      if (gc < p.N) { y[(n * p.M + gr) * p.N + gc] = acc[i * ' + MMT_REG + 'u + j]; }',
      '    }',
      '  }',
      '}'
    ].join('\n');
  }
  // vec4 載入版（O5 的 vec4 變體）：與 mmTileWgsl 相同的幾何與計算迴圈，只把全域記憶體讀取改成 vec4（一次 4 個元素）。
  // 條件：不轉置（flags = 0）、K 是 4 的倍數、N 是 4 的倍數（呼叫端用 mmTileVec4Ok 檢查）。A 的 k 方向與 B 的 n 方向都是連續的，
  // 所以 vec4 的位址對齊由 K%4、N%4 保證；批次偏移 n*M*K、n*K*N 也都是 4 的倍數。
  // 共用記憶體仍是 8 KiB；每個執行緒搬入 1 個 vec4 給 A、1 個給 B（256 個執行緒剛好）。
  function mmTileVec4Ok(M, K, N, flags) { return !flags && K % 4 === 0 && N % 4 === 0 && M > 0 && N > 0; }
  // kernel_gen（G1）：node 用 require；瀏覽器嵌入時 kernel_gen 的原始碼先於本檔執行（scripts/embed-code-ui.js），掛在 self.FaKernelGen。
  function kg() {
    if (typeof module === 'object' && module.exports && typeof require === 'function') return require('./kernel_gen.js');
    return (typeof self !== 'undefined' ? self : this).FaKernelGen;
  }
  // vec4 載入版（O5 的 vec4 變體）：手寫版保留（G1 實測：kernel_gen 的同幾何實例 WG16 TM4 TN4 BK16 vec4 在 Kepler 上慢約 5 倍，見 scripts/eval/g1_gen_check.html）。
  function mmTileWgslVec4(opts) {
    opts = opts || {};
    var marker = opts.marker || 'matmul_vec4';
    return '// @kernel ' + marker + '\n' + [
      'struct P { B: u32, M: u32, K: u32, N: u32, Bb: u32, azp: i32, bzp: i32, p0: u32 }',
      '@group(0) @binding(0) var<storage, read> a4: array<vec4<f32>>;',
      '@group(0) @binding(1) var<storage, read> b4: array<vec4<f32>>;',
      '@group(0) @binding(2) var<storage, read_write> y: array<f32>;',
      '@group(0) @binding(3) var<uniform> p: P;',
      'var<workgroup> As: array<f32, ' + (MMT_OUT * MMT_K) + '>;',
      'var<workgroup> Bs: array<f32, ' + (MMT_K * MMT_OUT) + '>;',
      '@compute @workgroup_size(' + MMT_WG + ', ' + MMT_WG + ', 1)',
      'fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {',
      '  let n = wid.z;',
      '  let row0 = wid.y * ' + MMT_OUT + 'u;',
      '  let col0 = wid.x * ' + MMT_OUT + 'u;',
      '  let ao4 = (n * p.M * p.K) / 4u;',
      '  var bo4 = 0u;',
      '  if (p.Bb != 1u) { bo4 = (n * p.K * p.N) / 4u; }',
      '  let tid = lid.y * ' + MMT_WG + 'u + lid.x;',
      '  var acc: array<f32, ' + (MMT_REG * MMT_REG) + '>;',
      '  for (var i: u32 = 0u; i < ' + (MMT_REG * MMT_REG) + 'u; i = i + 1u) { acc[i] = 0.0; }',
      '  let tiles = (p.K + ' + (MMT_K - 1) + 'u) / ' + MMT_K + 'u;',
      '  for (var t: u32 = 0u; t < tiles; t = t + 1u) {',
      '    let k0 = t * ' + MMT_K + 'u;',
      // A：256 個 vec4 = 64 列 × 4 段（每段 4 個 k）。tid 負責列 tid/4、段 tid%4。
      '    let ar = tid / 4u;',
      '    let ak = (tid % 4u) * 4u;',
      '    let gr = row0 + ar;',
      '    let gk = k0 + ak;',
      '    var av: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 0.0);',
      '    if (gr < p.M && gk < p.K) { av = a4[ao4 + (gr * p.K + gk) / 4u]; }',
      '    As[ar * ' + MMT_K + 'u + ak] = av.x;',
      '    As[ar * ' + MMT_K + 'u + ak + 1u] = av.y;',
      '    As[ar * ' + MMT_K + 'u + ak + 2u] = av.z;',
      '    As[ar * ' + MMT_K + 'u + ak + 3u] = av.w;',
      // B：256 個 vec4 = 16 列（k）× 16 段（每段 4 個 n）。tid 負責列 tid/16、段 tid%16。
      '    let bk = tid / 16u;',
      '    let bc = (tid % 16u) * 4u;',
      '    let gk2 = k0 + bk;',
      '    let gc = col0 + bc;',
      '    var bv: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 0.0);',
      '    if (gk2 < p.K && gc < p.N) { bv = b4[bo4 + (gk2 * p.N + gc) / 4u]; }',
      '    Bs[bk * ' + MMT_OUT + 'u + bc] = bv.x;',
      '    Bs[bk * ' + MMT_OUT + 'u + bc + 1u] = bv.y;',
      '    Bs[bk * ' + MMT_OUT + 'u + bc + 2u] = bv.z;',
      '    Bs[bk * ' + MMT_OUT + 'u + bc + 3u] = bv.w;',
      '    workgroupBarrier();',
      '    for (var kk: u32 = 0u; kk < ' + MMT_K + 'u; kk = kk + 1u) {',
      '      var ra: array<f32, ' + MMT_REG + '>;',
      '      var rb: array<f32, ' + MMT_REG + '>;',
      '      for (var i: u32 = 0u; i < ' + MMT_REG + 'u; i = i + 1u) {',
      '        ra[i] = As[(lid.y * ' + MMT_REG + 'u + i) * ' + MMT_K + 'u + kk];',
      '        rb[i] = Bs[kk * ' + MMT_OUT + 'u + lid.x * ' + MMT_REG + 'u + i];',
      '      }',
      '      for (var i: u32 = 0u; i < ' + MMT_REG + 'u; i = i + 1u) {',
      '        for (var j: u32 = 0u; j < ' + MMT_REG + 'u; j = j + 1u) { acc[i * ' + MMT_REG + 'u + j] = acc[i * ' + MMT_REG + 'u + j] + ra[i] * rb[j]; }',
      '      }',
      '    }',
      '    workgroupBarrier();',
      '  }',
      '  for (var i: u32 = 0u; i < ' + MMT_REG + 'u; i = i + 1u) {',
      '    let gr = row0 + lid.y * ' + MMT_REG + 'u + i;',
      '    if (gr >= p.M) { continue; }',
      '    for (var j: u32 = 0u; j < ' + MMT_REG + 'u; j = j + 1u) {',
      '      let gc = col0 + lid.x * ' + MMT_REG + 'u + j;',
      '      if (gc < p.N) { y[(n * p.M + gr) * p.N + gc] = acc[i * ' + MMT_REG + 'u + j]; }',
      '    }',
      '  }',
      '}'
    ].join('\n');
  }
  // 暫存器分塊版（R8）：工作群組 16×16 個執行緒；每個執行緒算 TM×TN 個輸出（預設 8×8），輸出塊 BM×BN = 16·TM × 16·TN。
  // 累加器 array<f32, TM·TN>（索引在展開後都是常數）。K 方向每次搬 8 層：A 的塊（BM 列 × 8 k）以 vec4 讀進共用記憶體，
  // B 的塊（8 列 × BN 欄）以 vec4 讀進共用記憶體。內層 k 用 for 迴圈（8 次），只把 TM×TN 的 fma 展開。
  // 條件（呼叫端用 mmR8Ok 檢查）：不轉置、K 是 8 的倍數、N 是 4 的倍數；M 任意（列邊界逐元素檢查）。
  // 順序：每個輸出元素的 k 仍由小到大累加（與 CPU 參考相同的順序，只差 fma 的單次捨入）。
  function mmR8Ok(M, K, N, flags) { return !flags && K % 8 === 0 && N % 4 === 0 && M > 0 && N > 0; }
  function mmR8Dispatch(M, N, B, tm, tn) { tm = tm || 8; tn = tn || 8; return [Math.ceil(N / (16 * tn)), Math.ceil(M / (16 * tm)), B || 1]; }
  // 暫存器分塊版（R8）：G1 起由 kernel_gen 產生（WG 16、TM 8、TN 8、BK 8、vec 4）；128×128 輸出塊、8 KiB 共用記憶體。
  function mmR8Wgsl(opts) {
    opts = opts || {};
    return kg().generate({ WG: 16, TM: opts.tm || 8, TN: opts.tn || 8, BK: 8, vec: 4 }, { marker: opts.marker || 'matmul_r8' });
  }
  // CPU 參考（單一批次）：與 matmulRef 相同，每一步 f32 捨入（k 由小到大）。A 是 M×K（transA 時為 K×M），B 是 K×N（transB 時為 N×K）。
  function matmulTRef(A, B, M, K, N, flags) {
    var tA = !!(flags & 1), tB = !!(flags & 2), y = new Float32Array(M * N);
    for (var i = 0; i < M; i++) for (var j = 0; j < N; j++) {
      var acc = 0;
      for (var k = 0; k < K; k++) acc = Math.fround(acc + Math.fround((tA ? A[k * M + i] : A[i * K + k]) * (tB ? B[j * K + k] : B[k * N + j])));
      y[i * N + j] = acc;
    }
    return y;
  }
  var USAGE = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 };
  var GL = { TEXTURE_2D: 0x0DE1, RGBA32F: 0x8814, RGBA: 0x1908, FLOAT: 0x1406, NEAREST: 0x2600, CLAMP: 0x812F,
    TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
    FRAMEBUFFER: 0x8D40, COLOR_ATTACHMENT0: 0x8CE0, FRAMEBUFFER_COMPLETE: 0x8CD5, TRIANGLES: 0x0004,
    VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30, COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82,
    MAX_TEXTURE_SIZE: 0x0D33, TEXTURE0: 0x84C0 };

  function msg(e) { return String((e && e.message) || e); }

  // ---------- 能力偵測：WebGPU ----------
  // 不丟例外：回傳 { probe, adapter }。probe.reason 在不可用時必填。
  async function probeAdapter(nav) {
    var probe = { hasWebGPU: false, hasAdapter: false, isFallbackAdapter: false, reason: '', features: [], limits: {} };
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
    probe.isFallbackAdapter = !!adapter.isFallbackAdapter;
    try { probe.features = Array.from(adapter.features || []).sort(); } catch (_) { probe.features = []; }
    var L = adapter.limits || {};
    probe.limits = {
      maxStorageBufferBindingSize: L.maxStorageBufferBindingSize || null,
      maxComputeWorkgroupStorageSize: L.maxComputeWorkgroupStorageSize || null,
      maxComputeInvocationsPerWorkgroup: L.maxComputeInvocationsPerWorkgroup || null
    };
    return { probe: probe, adapter: adapter };
  }

  // ---------- 能力偵測：WebGL2 ----------
  // gl 為 WebGL2 上下文（或 null）。不丟例外。
  function probeWebgl2(gl) {
    var out = { available: false, reason: '', maxTextureSize: 0, colorBufferFloat: false };
    if (!gl) { out.reason = '此環境沒有 WebGL2 上下文'; return out; }
    try {
      var ext = gl.getExtension('EXT_color_buffer_float');
      out.colorBufferFloat = !!ext;
      out.maxTextureSize = gl.getParameter(GL.MAX_TEXTURE_SIZE) || 0;
    } catch (e) { out.reason = 'WebGL2 能力查詢失敗：' + msg(e); return out; }
    if (!out.colorBufferFloat) { out.reason = '缺 EXT_color_buffer_float，無法渲染到 f32 紋理（RGBA8 打包退路尚未實作）'; return out; }
    out.available = true;
    return out;
  }

  // ---------- 能力檔（§2.2）：由 WebGPU 與 WebGL2 的探測結果歸類 ----------
  // 回傳 { profile: 'A'|'B'|'C'|null, reason }。
  function profileOf(probe, webgl2) {
    var p = probe || {};
    if (p.hasAdapter) {
      var lim = p.limits || {};
      if (p.isFallbackAdapter) return { profile: 'A', reason: '軟體介面卡（isFallbackAdapter），歸為檔 A' };
      if (lim.maxComputeWorkgroupStorageSize && lim.maxComputeWorkgroupStorageSize < DEFAULT_WG_STORAGE) {
        return { profile: 'A', reason: '共享記憶體上限 ' + lim.maxComputeWorkgroupStorageSize + ' 位元組，小於 16384，歸為檔 A' };
      }
      var f = p.features || [];
      if (f.indexOf('shader-f16') >= 0 && f.indexOf('subgroups') >= 0) return { profile: 'C', reason: '有 shader-f16 與 subgroups，歸為檔 C' };
      return { profile: 'B', reason: '有整數原子與足夠共享記憶體，沒有 shader-f16 與 subgroups，歸為檔 B' };
    }
    if (webgl2 && webgl2.available) return { profile: 'A', reason: '只有 WebGL2，沒有 WebGPU 計算，歸為檔 A' };
    return { profile: null, reason: '沒有 WebGPU 介面卡，也沒有可用的 WebGL2' };
  }

  // ---------- 容差（暫定，未實測） ----------
  function tolerance(k) { return 8 * Math.sqrt(Math.max(1, k)) * EPS32; }

  // ---------- CPU 參考版（T5） ----------
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
  function sumRef(a) { var acc = 0; for (var i = 0; i < a.length; i++) acc = Math.fround(acc + a[i]); return acc; }
  function sumExact(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }
  function axpyRef(alpha, x, y) { var out = new Float32Array(x.length); for (var i = 0; i < x.length; i++) out[i] = Math.fround(Math.fround(alpha * x[i]) + y[i]); return out; }
  function scalRef(alpha, x) { var out = new Float32Array(x.length); for (var i = 0; i < x.length; i++) out[i] = Math.fround(alpha * x[i]); return out; }
  function mulRef(x, y) { var out = new Float32Array(x.length); for (var i = 0; i < x.length; i++) out[i] = Math.fround(x[i] * y[i]); return out; }
  function dotRef(x, y) { var acc = 0; for (var i = 0; i < x.length; i++) acc = Math.fround(acc + Math.fround(x[i] * y[i])); return acc; }
  function nrm2Ref(x) { var s = 0; for (var i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.fround(Math.sqrt(s)); }
  function gemvRef(A, x, m, n) { return matmulRef(A, x, m, n, 1); }

  // ---------- T2 替代實作的參考版（演算法與 WGSL 版相同，全部在 f32 精度下舍入） ----------
  function f32(x) { return Math.fround(x); }
  function twoSumF(a, b) { var s = f32(a + b), bb = f32(s - a); return [s, f32(f32(a - f32(s - bb)) + f32(b - bb))]; }
  function quickTwoSumF(a, b) { var s = f32(a + b); return [s, f32(b - f32(s - a))]; }
  // double-float 加法（ieee add）：(ah, al) + (bh, bl)，結果是非重疊的 hi + lo
  function ddAdd(ah, al, bh, bl) {
    var s = twoSumF(ah, bh), t = twoSumF(al, bl);
    var s1 = s[0], s2 = f32(s[1] + t[0]);
    var q = quickTwoSumF(s1, s2); s1 = q[0]; s2 = f32(q[1] + t[1]);
    q = quickTwoSumF(s1, s2);
    return [q[0], q[1]];
  }
  // 雙 f32 歸約：回傳 hi + lo（以 JS 數字表示，精度約 48 位元尾數，預估）
  function sumDdRef(a) {
    var h = 0, l = 0;
    for (var i = 0; i < a.length; i++) { var r = ddAdd(h, l, f32(a[i]), 0); h = r[0]; l = r[1]; }
    return h + l;
  }
  // 64 位元整數以兩個 u32（hi、lo）表示的加法，結果模 2^64。進位用比較判斷。
  function add64(a, b) {
    var lo = (a[1] + b[1]) >>> 0;
    var carry = lo < a[1] ? 1 : 0;
    var hi = (a[0] + b[0] + carry) >>> 0;
    return [hi, lo];
  }
  // f32 原子加的 CAS 迴圈參考版：out[idx[i]] ← f32(out[idx[i]] + vals[i])，依序執行（GPU 上順序不固定，結果不位元相同）
  function scatterAddRef(idx, vals, outLen) {
    var out = new Float32Array(outLen);
    for (var i = 0; i < idx.length; i++) out[idx[i]] = f32(out[idx[i]] + vals[i]);
    return out;
  }

  // ---------- WGSL 核心 ----------
  // 每段第一行的 @kernel 標記給假裝置測試辨識用。
  var WGSL = {};
  WGSL.vector_add = [
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
  // 矩陣乘：共用的平鋪核心（見上方 mmTileWgsl）。參數 8 個 u32（B, M, K, N, Bb, azp, bzp, p0），分派 mmTileDispatch(M, N, B)。
  WGSL.matmul = mmTileWgsl({ marker: 'matmul', dtype: 'f32' });
  // gemv 專用核心（O14b）：每個工作群組算一列 y[row] = Σ A[row,j]·x[j]；256 個執行緒各跨步累加，再用共用記憶體樹狀歸約。
  // 取代原本把 x 當成 N=1 的平鋪矩陣乘（那條路徑對向量浪費了整個平鋪）。m > 65535 時退回舊路徑。
  WGSL.gemv_row = `
struct P { n: u32, m: u32, a: u32, b: u32 }
@group(0) @binding(0) var<storage, read> A: array<f32>;
@group(0) @binding(1) var<storage, read> X: array<f32>;
@group(0) @binding(2) var<storage, read_write> Y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
var<workgroup> sh: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  // @kernel gemv_row
  let row = wid.x;
  let t = lid.x;
  var acc: f32 = 0.0;
  if (row < p.m) {
    for (var j: u32 = t; j < p.n; j = j + 256u) { acc = acc + A[row * p.n + j] * X[j]; }
  }
  sh[t] = acc;
  workgroupBarrier();
  for (var s: u32 = 128u; s > 0u; s = s >> 1u) {
    if (t < s) { sh[t] = sh[t] + sh[t + s]; }
    workgroupBarrier();
  }
  if (t == 0u && row < p.m) { Y[row] = sh[0]; }
}`;
  // 包含式前綴和（O14c）：每個工作群組（256 個元素）用 Hillis–Steele 掃描做區塊前綴和，並寫出區塊總和；
  // 區塊總和再遞迴掃描；最後 add_offsets 把前一區塊的掃描結果加到每個元素上。
  WGSL.scan_block = `
struct P { n: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> IN: array<f32>;
@group(0) @binding(1) var<storage, read_write> OUT: array<f32>;
@group(0) @binding(2) var<storage, read_write> BSUM: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
var<workgroup> s: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  // @kernel scan_block
  let t = lid.x;
  let i = wid.x * 256u + t;
  var v: f32 = 0.0;
  if (i < p.n) { v = IN[i]; }
  s[t] = v;
  workgroupBarrier();
  for (var k: u32 = 0u; k < 8u; k = k + 1u) {
    let off = 1u << k;
    var add: f32 = 0.0;
    if (t >= off) { add = s[t - off]; }
    workgroupBarrier();
    s[t] = s[t] + add;
    workgroupBarrier();
  }
  if (i < p.n) { OUT[i] = s[t]; }
  if (t == 255u) { BSUM[wid.x] = s[255]; }
}`;
  WGSL.add_offsets = `
struct P { n: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read_write> OUT: array<f32>;
@group(0) @binding(1) var<storage, read> SCAN: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  // @kernel add_offsets
  let i = wid.x * 256u + lid.x;
  if (wid.x == 0u) { return; }
  if (i < p.n) { OUT[i] = OUT[i] + SCAN[wid.x - 1u]; }
}`;
  // 轉置樣板（O14c）：A 為 m×n（列主序），輸出 n×m。16×16 的共用記憶體分塊，列寬加 1 避開記憶體組衝突。
  WGSL.transpose = `
struct P { m: u32, n: u32, a: u32, b: u32 }
@group(0) @binding(0) var<storage, read> A: array<f32>;
@group(0) @binding(1) var<storage, read_write> O: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
var<workgroup> tile: array<f32, 272>;
@compute @workgroup_size(16, 16)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  // @kernel transpose
  let x = wid.x * 16u + lid.x;
  let y = wid.y * 16u + lid.y;
  if (x < p.n && y < p.m) { tile[lid.y * 17u + lid.x] = A[y * p.n + x]; }
  workgroupBarrier();
  let ox = wid.y * 16u + lid.x;
  let oy = wid.x * 16u + lid.y;
  if (ox < p.m && oy < p.n) { O[oy * p.m + ox] = tile[lid.x * 17u + lid.y]; }
}`;
  // vec4 載入版：K、N 是 4 的倍數且不轉置時 wgMatmul 改用它（同一幾何，全域讀取一次 4 個元素；大形狀快 20–30%，見 mm_tile_check.html）
  WGSL.matmul_vec4 = mmTileWgslVec4({ marker: 'matmul_vec4' });
  WGSL.sum = [
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
  // 第二階段：逐元素 axpy（y = α·x + y）、scal（x = α·x）、mul（z = x·y）；參數 alpha 為 f32，以位元與 n 一起放進 uniform
  WGSL.axpy = [
    '// @kernel axpy',
    'struct Params { n: u32, alpha: f32, p2: u32, p3: u32 }',
    '@group(0) @binding(0) var<storage, read> x: array<f32>;',
    '@group(0) @binding(1) var<storage, read_write> y: array<f32>;',
    '@group(0) @binding(2) var<uniform> p: Params;',
    '@compute @workgroup_size(' + WG + ')',
    'fn main(@builtin(global_invocation_id) gid: vec3<u32>) {',
    '  let i = gid.x;',
    '  if (i < p.n) { y[i] = p.alpha * x[i] + y[i]; }',
    '}'
  ].join('\n');
  WGSL.scal = [
    '// @kernel scal',
    'struct Params { n: u32, alpha: f32, p2: u32, p3: u32 }',
    '@group(0) @binding(0) var<storage, read_write> x: array<f32>;',
    '@group(0) @binding(1) var<uniform> p: Params;',
    '@compute @workgroup_size(' + WG + ')',
    'fn main(@builtin(global_invocation_id) gid: vec3<u32>) {',
    '  let i = gid.x;',
    '  if (i < p.n) { x[i] = p.alpha * x[i]; }',
    '}'
  ].join('\n');
  WGSL.mul = [
    '// @kernel mul',
    'struct Params { n: u32, p1: u32, p2: u32, p3: u32 }',
    '@group(0) @binding(0) var<storage, read> x: array<f32>;',
    '@group(0) @binding(1) var<storage, read> y: array<f32>;',
    '@group(0) @binding(2) var<storage, read_write> z: array<f32>;',
    '@group(0) @binding(3) var<uniform> p: Params;',
    '@compute @workgroup_size(' + WG + ')',
    'fn main(@builtin(global_invocation_id) gid: vec3<u32>) {',
    '  let i = gid.x;',
    '  if (i < p.n) { z[i] = x[i] * y[i]; }',
    '}'
  ].join('\n');

  // T2 替代：雙 f32 歸約（與 ddAdd 相同的演算法）。輸入為 hi、lo 兩組陣列，每一級輸出兩組部分和。
  WGSL.sum_dd = [
    '// @kernel sum_dd',
    'struct Params { n: u32, p1: u32, p2: u32, p3: u32 }',
    '@group(0) @binding(0) var<storage, read> inHi: array<f32>;',
    '@group(0) @binding(1) var<storage, read> inLo: array<f32>;',
    '@group(0) @binding(2) var<storage, read_write> outHi: array<f32>;',
    '@group(0) @binding(3) var<storage, read_write> outLo: array<f32>;',
    '@group(0) @binding(4) var<uniform> p: Params;',
    'var<workgroup> shHi: array<f32, ' + WG + '>;',
    'var<workgroup> shLo: array<f32, ' + WG + '>;',
    'fn two_sum(a: f32, b: f32) -> vec2<f32> {',
    '  let s = a + b; let bb = s - a;',
    '  return vec2<f32>(s, (a - (s - bb)) + (b - bb));',
    '}',
    'fn quick_two_sum(a: f32, b: f32) -> vec2<f32> {',
    '  let s = a + b;',
    '  return vec2<f32>(s, b - (s - a));',
    '}',
    'fn dd_add(ah: f32, al: f32, bh: f32, bl: f32) -> vec2<f32> {',
    '  let s = two_sum(ah, bh);',
    '  let t = two_sum(al, bl);',
    '  var s1 = s.x; var s2 = s.y + t.x;',
    '  let q1 = quick_two_sum(s1, s2); s1 = q1.x; s2 = q1.y + t.y;',
    '  return quick_two_sum(s1, s2);',
    '}',
    '@compute @workgroup_size(' + WG + ')',
    'fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>,',
    '        @builtin(workgroup_id) wid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {',
    '  var h: f32 = 0.0; var l: f32 = 0.0;',
    '  var i: u32 = gid.x;',
    '  let stride: u32 = ' + WG + 'u * nwg.x;',
    '  loop {',
    '    if (i >= p.n) { break; }',
    '    let r = dd_add(h, l, inHi[i], inLo[i]); h = r.x; l = r.y;',
    '    i = i + stride;',
    '  }',
    '  shHi[lid.x] = h; shLo[lid.x] = l;',
    '  workgroupBarrier();',
    '  var s: u32 = ' + (WG / 2) + 'u;',
    '  loop {',
    '    if (s == 0u) { break; }',
    '    if (lid.x < s) {',
    '      let r = dd_add(shHi[lid.x], shLo[lid.x], shHi[lid.x + s], shLo[lid.x + s]);',
    '      shHi[lid.x] = r.x; shLo[lid.x] = r.y;',
    '    }',
    '    workgroupBarrier();',
    '    s = s / 2u;',
    '  }',
    '  if (lid.x == 0u) { outHi[wid.x] = shHi[0]; outLo[wid.x] = shLo[0]; }',
    '}'
  ].join('\n');
  // T2 替代：f32 原子加。輸出以 atomic<u32> 存位元，用 compare-exchange 迴圈做浮點加法。
  WGSL.scatter_add = [
    '// @kernel scatter_add',
    'struct Params { n: u32, outLen: u32, p2: u32, p3: u32 }',
    '@group(0) @binding(0) var<storage, read> idx: array<u32>;',
    '@group(0) @binding(1) var<storage, read> vals: array<f32>;',
    '@group(0) @binding(2) var<storage, read_write> outBits: array<atomic<u32>>;',
    '@group(0) @binding(3) var<uniform> p: Params;',
    '@compute @workgroup_size(' + WG + ')',
    'fn main(@builtin(global_invocation_id) gid: vec3<u32>) {',
    '  let i = gid.x;',
    '  if (i >= p.n) { return; }',
    '  let j = idx[i];',
    '  let v = vals[i];',
    '  var old = atomicLoad(&outBits[j]);',
    '  loop {',
    '    let nw = bitcast<u32>(bitcast<f32>(old) + v);',
    '    let r = atomicCompareExchangeWeak(&outBits[j], old, nw);',
    '    if (r.exchanged) { break; }',
    '    old = r.old_value;',
    '  }',
    '}'
  ].join('\n');

  // ---------- WebGL2 片段著色器（T3）：資料流為 RGBA32F 紋理，只用 .r 通道 ----------
  var GLSL_VS = [
    '#version 300 es',
    'void main() {',
    '  float x = float((gl_VertexID << 1) & 2) * 2.0 - 1.0;',
    '  float y = float(gl_VertexID & 2) * 2.0 - 1.0;',
    '  gl_Position = vec4(x, y, 0.0, 1.0);',
    '}'
  ].join('\n');
  var GLSL = {};
  GLSL.vector_add = [
    '#version 300 es',
    '// @kernel vector_add',
    'precision highp float; precision highp int; precision highp sampler2D;',
    'uniform sampler2D uA; uniform sampler2D uB; uniform int uW; uniform int uN;',
    'out vec4 outColor;',
    'void main() {',
    '  int x = int(gl_FragCoord.x); int y = int(gl_FragCoord.y);',
    '  int e = y * uW + x;',
    '  if (e >= uN) { outColor = vec4(0.0); return; }',
    '  float s = texelFetch(uA, ivec2(x, y), 0).r + texelFetch(uB, ivec2(x, y), 0).r;',
    '  outColor = vec4(s, 0.0, 0.0, 0.0);',
    '}'
  ].join('\n');
  GLSL.matmul = [
    '#version 300 es',
    '// @kernel matmul',
    'precision highp float; precision highp int; precision highp sampler2D;',
    'uniform sampler2D uA; uniform sampler2D uB; uniform int uK;',
    'out vec4 outColor;',
    'void main() {',
    '  int col = int(gl_FragCoord.x); int row = int(gl_FragCoord.y);',
    '  float acc = 0.0;',
    '  for (int t = 0; t < uK; t++) {',
    '    acc += texelFetch(uA, ivec2(t, row), 0).r * texelFetch(uB, ivec2(col, t), 0).r;',
    '  }',
    '  outColor = vec4(acc, 0.0, 0.0, 0.0);',
    '}'
  ].join('\n');
  // 多趟歸約：輸出第 j 個元素 = 輸入第 4j..4j+3 個元素的和（線性索引，輸入寬 uW、長 uN）
  GLSL.sum = [
    '#version 300 es',
    '// @kernel sum',
    'precision highp float; precision highp int; precision highp sampler2D;',
    'uniform sampler2D uA; uniform int uW; uniform int uN; uniform int uOW;',
    'out vec4 outColor;',
    'void main() {',
    '  int j = int(gl_FragCoord.y) * uOW + int(gl_FragCoord.x);',
    '  if (j * 4 >= uN) { outColor = vec4(0.0); return; }',
    '  float s = 0.0;',
    '  for (int q = 0; q < 4; q++) {',
    '    int e = j * 4 + q;',
    '    if (e < uN) { s += texelFetch(uA, ivec2(e % uW, e / uW), 0).r; }',
    '  }',
    '  outColor = vec4(s, 0.0, 0.0, 0.0);',
    '}'
  ].join('\n');

  // ---------- 排程：互斥加優先級，連續高優先級超過門檻時讓出一次給低優先級（§8.3） ----------
  var PRI = { infer: 2, sim: 1 };
  function createScheduler(opts) {
    opts = opts || {};
    var starveAfter = opts.starveAfter || 4;
    var busy = false, q = [], streak = 0, granted = { infer: 0, sim: 0 }, starvedGrants = 0;
    function grant() {
      if (busy || q.length === 0) return;
      var hi = -1, lo = -1;
      for (var i = 0; i < q.length; i++) { if (q[i].pri >= PRI.infer && hi < 0) hi = i; if (q[i].pri < PRI.infer && lo < 0) lo = i; }
      var idx;
      if (hi >= 0 && (lo < 0 || streak < starveAfter)) { idx = hi; streak++; }
      else if (lo >= 0) { idx = lo; streak = 0; starvedGrants++; }
      else idx = hi;
      var w = q.splice(idx, 1)[0];
      busy = true;
      granted[w.name]++;
      w.resolve(release);
    }
    function release() { busy = false; grant(); }
    function acquire(name) {
      var pri = PRI[name] || PRI.sim;
      return new Promise(function (resolve) { q.push({ name: name in PRI ? name : 'sim', pri: pri, resolve: resolve }); grant(); });
    }
    return {
      acquire: acquire,
      stats: function () { return { busy: busy, waiting: q.length, streak: streak, granted: granted, starvedGrants: starvedGrants }; }
    };
  }

  // ---------- 執行期 ----------
  // opts.navigator：WebGPU 來源（網頁與桌面版傳 window.navigator；測試傳假物件）。
  // opts.webgl2：WebGL2 上下文，或回傳上下文的函式（延後取得），或 null。預設：瀏覽器有 document 時自動建立畫布。
  // opts.budgetBytes：GPU 緩衝區預算（預設 256 MiB）。opts.scheduler：可注入排程器。
  function createRuntime(opts) {
    opts = opts || {};
    var nav = opts.navigator;
    var st = {
      ready: null, device: null, probe: null, lost: null, pipes: {}, last: null, log: [], calls: 0,
      gl: undefined, glProbe: null, glProgs: {}, opLast: {}, used: 0,
      budget: opts.budgetBytes || DEFAULT_BUDGET, sched: opts.scheduler || createScheduler({})
    };

    // ----- WebGPU -----
    function ensure() {
      if (!st.ready) {
        st.ready = (async function () {
          var pa = await probeAdapter(nav);
          st.probe = pa.probe;
          if (!pa.adapter) return null;
          try { st.device = await pa.adapter.requestDevice(); try { st.device.lost.then(function (i) { console.warn('[gpu] 裝置遺失（' + i.reason + '）：' + String(i.message).slice(0, 200) + '；最近的 GPU 工作：' + (globalThis.__faGpuLast || '未知')); }); } catch (_) { /* 診斷用 */ } }
          catch (e) { st.probe.reason = '要求 WebGPU 裝置失敗：' + msg(e); return null; }
          var dev = st.device;
          if (dev.lost && typeof dev.lost.then === 'function') {
            dev.lost.then(function (info) {
              st.lost = '裝置遺失（' + ((info && (info.message || info.reason)) || '未知原因') + '）';
              st.device = null; st.pipes = {};
            });
          }
          return dev;
        })();
      }
      return st.ready;
    }
    function maxBytes() { var d = st.device; return (d && d.limits && d.limits.maxStorageBufferBindingSize) || DEFAULT_STORAGE_MAX; }
    function makeBuf(dev, data, usage) {
      var buf = dev.createBuffer({ size: Math.max(4, data.byteLength), usage: usage });
      dev.queue.writeBuffer(buf, 0, data);
      return buf;
    }
    function uniformU32(dev, u32s) { return makeBuf(dev, new Uint32Array(u32s), USAGE.UNIFORM | USAGE.COPY_DST); }
    // 混合參數：第一個欄位是 u32 的 n，第二個是 f32 的 alpha
    function uniformNAlpha(dev, n, alpha) {
      var buf = new ArrayBuffer(16); new Uint32Array(buf, 0, 1)[0] = n; new Float32Array(buf, 4, 1)[0] = alpha;
      return makeBuf(dev, new Uint8Array(buf), USAGE.UNIFORM | USAGE.COPY_DST);
    }
    function pipeline(dev, key, code) {
      if (!st.pipes[key]) {
        var mod = dev.createShaderModule({ code: code });
        st.pipes[key] = dev.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
      }
      return st.pipes[key];
    }
    function dispatch(dev, pipe, bufs, gx, gy) {
      var bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: bufs.map(function (b, i) { return { binding: i, resource: { buffer: b } }; }) });
      var enc = dev.createCommandEncoder();
      var pass = enc.beginComputePass();
      pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(gx, gy || 1, 1); pass.end();
      dev.queue.submit([enc.finish()]);
    }
    async function readBack(dev, buf, count) {
      var bytes = count * 4;
      var rb = dev.createBuffer({ size: bytes, usage: USAGE.MAP_READ | USAGE.COPY_DST });
      var enc = dev.createCommandEncoder(); enc.copyBufferToBuffer(buf, 0, rb, 0, bytes); dev.queue.submit([enc.finish()]);
      await rb.mapAsync(USAGE.MAP_READ);
      var out = new Float32Array(rb.getMappedRange().slice(0));
      rb.unmap(); rb.destroy();
      return out;
    }
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
    function wgVectorAdd(dev, a, b) {
      return withScope(dev, async function () {
        var n = a.length;
        var ba = makeBuf(dev, a, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC), bb = makeBuf(dev, b, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC);
        var bc = dev.createBuffer({ size: Math.max(4, n * 4), usage: USAGE.STORAGE | USAGE.COPY_SRC });
        dispatch(dev, pipeline(dev, 'vector_add', WGSL.vector_add), [ba, bb, bc, uniformU32(dev, [n, 0, 0, 0])], Math.ceil(n / WG));
        return readBack(dev, bc, n);
      });
    }
    // flags：{ transA, transB }（可省）；A 以 K×M 儲存（transA）或 B 以 N×K 儲存（transB）時，索引在核心裡換掉，不另寫核心
    function wgMatmul(dev, A, B, m, k, n, flags) {
      return withScope(dev, async function () {
        var ba = makeBuf(dev, A, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC), bb = makeBuf(dev, B, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC);
        var bc = dev.createBuffer({ size: Math.max(4, m * n * 4), usage: USAGE.STORAGE | USAGE.COPY_SRC });
        var d = mmTileDispatch(m, n, 1), fl = mmTileFlags(flags);
        var v4 = mmTileVec4Ok(m, k, n, fl);   // K、N 為 4 的倍數、不轉置：用 vec4 版
        // 可選的選核注入點（預設 null＝維持原本行為）。回傳 'matmul_vec4' 或 'matmul'；vec4 不合條件時仍退回平鋪版。
        var pick = matmulKernelChooser ? matmulKernelChooser(m, k, n, fl) : null;
        if (pick === 'matmul_vec4') v4 = mmTileVec4Ok(m, k, n, fl);
        else if (pick === 'matmul') v4 = false;
        dispatch(dev, v4 ? pipeline(dev, 'matmul_vec4', WGSL.matmul_vec4) : pipeline(dev, 'matmul', WGSL.matmul), [ba, bb, bc, uniformU32(dev, mmTileWords(m, k, n, fl, 1))], d[0], d[1]);
        return readBack(dev, bc, m * n);
      });
    }
    // 批次矩陣乘（matmulMany）：每組一個核心分派，全部記在同一個 command encoder、一次 submit、一次讀回。
    // jobs：[{MA, MB, m, k, n, fl}]，MA/MB 已是 Float32Array，fl 為轉置旗標位元；呼叫端已確認每組都在儲存上限內（這裡不分塊）。
    // 回傳每組結果的陣列（一般陣列）。選核規則與 wgMatmul 相同。
    function wgMatmulMany(dev, jobs) {
      return withScope(dev, async function () {
        var enc = dev.createCommandEncoder();
        var temps = [], outs = [], offs = [], total = 0;
        jobs.forEach(function (j) {
          var ba = makeBuf(dev, j.MA, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC), bb = makeBuf(dev, j.MB, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC);
          var bc = dev.createBuffer({ size: Math.max(4, j.m * j.n * 4), usage: USAGE.STORAGE | USAGE.COPY_SRC });
          var uni = uniformU32(dev, mmTileWords(j.m, j.k, j.n, j.fl, 1));
          var v4 = mmTileVec4Ok(j.m, j.k, j.n, j.fl);
          var pick = matmulKernelChooser ? matmulKernelChooser(j.m, j.k, j.n, j.fl) : null;
          if (pick === 'matmul_vec4') v4 = mmTileVec4Ok(j.m, j.k, j.n, j.fl);
          else if (pick === 'matmul') v4 = false;
          var pipe = v4 ? pipeline(dev, 'matmul_vec4', WGSL.matmul_vec4) : pipeline(dev, 'matmul', WGSL.matmul);
          var bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
            { binding: 0, resource: { buffer: ba } }, { binding: 1, resource: { buffer: bb } },
            { binding: 2, resource: { buffer: bc } }, { binding: 3, resource: { buffer: uni } }] });
          var d = mmTileDispatch(j.m, j.n, 1);
          var pass = enc.beginComputePass(); pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(d[0], d[1], 1); pass.end();
          temps.push(ba, bb, uni); outs.push(bc); offs.push(total); total += j.m * j.n;
        });
        var rb = dev.createBuffer({ size: Math.max(4, total * 4), usage: USAGE.MAP_READ | USAGE.COPY_DST });
        jobs.forEach(function (j, i) { enc.copyBufferToBuffer(outs[i], 0, rb, offs[i] * 4, j.m * j.n * 4); });
        dev.queue.submit([enc.finish()]);
        await rb.mapAsync(USAGE.MAP_READ);
        var all = new Float32Array(rb.getMappedRange().slice(0));
        rb.unmap(); rb.destroy();
        temps.concat(outs).forEach(function (b) { b.destroy(); });
        return jobs.map(function (j, i) { return Array.from(all.subarray(offs[i], offs[i] + j.m * j.n)); });
      });
    }
    // 歸約的核心部分：從一個已在裝置上的 buffer 開始，回傳最後的 buffer 與長度
    function reduceBuffers(dev, cur, len) {
      var pipe = pipeline(dev, 'sum', WGSL.sum);
      while (len > 1) {
        var g = Math.min(WG, Math.ceil(len / WG));
        var out = dev.createBuffer({ size: g * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC });
        dispatch(dev, pipe, [cur, out, uniformU32(dev, [len, 0, 0, 0])], g);
        cur = out; len = g;
      }
      return cur;
    }
    function wgSum(dev, a) {
      return withScope(dev, async function () {
        var cur = makeBuf(dev, a, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC);
        var r = await readBack(dev, reduceBuffers(dev, cur, a.length), 1);
        return r[0];
      });
    }
    function wgAxpy(dev, alpha, x, y) {
      return withScope(dev, async function () {
        var n = x.length;
        var bx = makeBuf(dev, x, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC), by = makeBuf(dev, y, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC);
        dispatch(dev, pipeline(dev, 'axpy', WGSL.axpy), [bx, by, uniformNAlpha(dev, n, alpha)], Math.ceil(n / WG));
        return readBack(dev, by, n);
      });
    }
    function wgScal(dev, alpha, x) {
      return withScope(dev, async function () {
        var n = x.length;
        var bx = makeBuf(dev, x, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC);
        dispatch(dev, pipeline(dev, 'scal', WGSL.scal), [bx, uniformNAlpha(dev, n, alpha)], Math.ceil(n / WG));
        return readBack(dev, bx, n);
      });
    }
    function wgDot(dev, x, y) {
      return withScope(dev, async function () {
        var n = x.length;
        var bx = makeBuf(dev, x, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC), by = makeBuf(dev, y, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC);
        var bz = dev.createBuffer({ size: Math.max(4, n * 4), usage: USAGE.STORAGE | USAGE.COPY_SRC });
        dispatch(dev, pipeline(dev, 'mul', WGSL.mul), [bx, by, bz, uniformU32(dev, [n, 0, 0, 0])], Math.ceil(n / WG));
        var r = await readBack(dev, reduceBuffers(dev, bz, n), 1);
        return r[0];
      });
    }
    // 前綴和：區塊掃描 → 區塊總和遞迴掃描 → 加上前區塊的偏移。全部留在裝置上。
    function scanBuf(dev, inBuf, n) {
      var nb = Math.ceil(n / 256);
      var out = dev.createBuffer({ size: Math.max(4, n * 4), usage: USAGE.STORAGE | USAGE.COPY_SRC | USAGE.COPY_DST });
      var bsum = dev.createBuffer({ size: Math.max(4, nb * 4), usage: USAGE.STORAGE | USAGE.COPY_SRC | USAGE.COPY_DST });
      dispatch(dev, pipeline(dev, 'scan_block', WGSL.scan_block), [inBuf, out, bsum, uniformU32(dev, [n, 0, 0, 0])], nb, 1);
      if (nb > 1) {
        var scanned = scanBuf(dev, bsum, nb);
        dispatch(dev, pipeline(dev, 'add_offsets', WGSL.add_offsets), [out, scanned, uniformU32(dev, [n, 0, 0, 0])], nb, 1);
      }
      return out;
    }
    function wgScan(dev, a) {
      return withScope(dev, async function () {
        var n = a.length;
        if (n === 0) return [];
        var inb = makeBuf(dev, a, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC);
        return readBack(dev, scanBuf(dev, inb, n), n);
      });
    }
    function wgTranspose(dev, A, m, n) {
      return withScope(dev, async function () {
        var ba = makeBuf(dev, A, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC);
        var bo = dev.createBuffer({ size: Math.max(4, m * n * 4), usage: USAGE.STORAGE | USAGE.COPY_SRC });
        dispatch(dev, pipeline(dev, 'transpose', WGSL.transpose), [ba, bo, uniformU32(dev, [m, n, 0, 0])], Math.ceil(n / 16), Math.ceil(m / 16));
        return readBack(dev, bo, m * n);
      });
    }
    function wgGemv(dev, A, x, m, n) {
      if (m > 65535) return wgMatmul(dev, A, x, m, n, 1);   // 超過單維工作群組上限：退回舊路徑
      return withScope(dev, async function () {
        var ba = makeBuf(dev, A, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC), bx = makeBuf(dev, x, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC);
        var by = dev.createBuffer({ size: Math.max(4, m * 4), usage: USAGE.STORAGE | USAGE.COPY_SRC });
        dispatch(dev, pipeline(dev, 'gemv_row', WGSL.gemv_row), [ba, bx, by, uniformU32(dev, [n, m, 0, 0])], m, 1);
        return readBack(dev, by, m);
      });
    }
    // T2：雙 f32 歸約，每一級兩組部分和（hi、lo）
    function wgSumDd(dev, a) {
      return withScope(dev, async function () {
        var len = a.length;
        var h = makeBuf(dev, a, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC);
        var l = makeBuf(dev, new Float32Array(len), USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC);
        var pipe = pipeline(dev, 'sum_dd', WGSL.sum_dd);
        while (len > 1) {
          var g = Math.min(WG, Math.ceil(len / WG));
          var oh = dev.createBuffer({ size: g * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC });
          var ol = dev.createBuffer({ size: g * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC });
          dispatch(dev, pipe, [h, l, oh, ol, uniformU32(dev, [len, 0, 0, 0])], g);
          h = oh; l = ol; len = g;
        }
        var rh = await readBack(dev, h, 1), rl = await readBack(dev, l, 1);
        return rh[0] + rl[0];
      });
    }
    // T2：f32 原子加（CAS 迴圈）。輸出緩衝區由 WebGPU 初始化為零。
    function wgScatterAdd(dev, idx, vals, outLen) {
      return withScope(dev, async function () {
        var n = vals.length;
        var bi = makeBuf(dev, idx, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC);
        var bv = makeBuf(dev, vals, USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC);
        var bo = dev.createBuffer({ size: Math.max(4, outLen * 4), usage: USAGE.STORAGE | USAGE.COPY_SRC });
        dispatch(dev, pipeline(dev, 'scatter_add', WGSL.scatter_add), [bi, bv, bo, uniformU32(dev, [n, outLen, 0, 0])], Math.ceil(n / WG));
        return readBack(dev, bo, outLen);
      });
    }

    // ----- WebGL2 -----
    function getGl() {
      if (st.gl !== undefined) return st.gl;
      var g = null;
      try {
        var src = opts.webgl2;
        if (typeof src === 'function') g = src();
        else if (src) g = src;
        else if (typeof document !== 'undefined' && document.createElement) {
          var cv = document.createElement('canvas');
          g = cv.getContext('webgl2', { antialias: false, premultipliedAlpha: false, alpha: true });
        }
      } catch (e) { g = null; }
      st.gl = g || null;
      st.glProbe = probeWebgl2(st.gl);
      return st.gl;
    }
    function glProgram(gl, name, fsSrc) {
      if (st.glProgs[name] && st.glProgs[name].gl === gl) return st.glProgs[name].prog;
      function compile(type, src) {
        var sh = gl.createShader(type);
        gl.shaderSource(sh, src); gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, GL.COMPILE_STATUS)) throw new Error('著色器編譯失敗：' + (gl.getShaderInfoLog(sh) || '無紀錄'));
        return sh;
      }
      var prog = gl.createProgram();
      gl.attachShader(prog, compile(GL.VERTEX_SHADER, GLSL_VS));
      gl.attachShader(prog, compile(GL.FRAGMENT_SHADER, fsSrc));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, GL.LINK_STATUS)) throw new Error('程式連結失敗：' + (gl.getProgramInfoLog(prog) || '無紀錄'));
      st.glProgs[name] = { gl: gl, prog: prog };
      return prog;
    }
    // 上傳一個 f32 陣列成 RGBA32F 紋理，寬 w、高 h，元素依列主序放在 .r
    function glUpload(gl, data, w, h) {
      var px = new Float32Array(w * h * 4);
      for (var i = 0; i < data.length; i++) px[i * 4] = data[i];
      var tex = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, tex);
      gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
      gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST);
      gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP);
      gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_T, GL.CLAMP);
      gl.texStorage2D(GL.TEXTURE_2D, 1, GL.RGBA32F, w, h);
      gl.texSubImage2D(GL.TEXTURE_2D, 0, 0, 0, w, h, GL.RGBA, GL.FLOAT, px);
      return tex;
    }
    // 一趟繪製：輸入紋理（依名稱綁到單元）、整數統一變數、輸出寬高；讀回 outW×outH 個 .r 值（列主序）
    function glPass(gl, prog, inputs, ints, outW, outH) {
      var fbo = gl.createFramebuffer();
      var outTex = gl.createTexture();
      gl.bindTexture(GL.TEXTURE_2D, outTex);
      gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
      gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST);
      gl.texStorage2D(GL.TEXTURE_2D, 1, GL.RGBA32F, outW, outH);
      gl.bindFramebuffer(GL.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, outTex, 0);
      if (gl.checkFramebufferStatus(GL.FRAMEBUFFER) !== GL.FRAMEBUFFER_COMPLETE) throw new Error('幀緩衝區不完整（輸出 ' + outW + '×' + outH + '）');
      gl.useProgram(prog);
      var units = 0;
      inputs.forEach(function (inp, i) {
        gl.activeTexture(GL.TEXTURE0 + i);
        gl.bindTexture(GL.TEXTURE_2D, inp.tex);
        gl.uniform1i(gl.getUniformLocation(prog, inp.name), i);
        units = i + 1;
      });
      Object.keys(ints).forEach(function (k) { gl.uniform1i(gl.getUniformLocation(prog, k), ints[k]); });
      gl.viewport(0, 0, outW, outH);
      gl.drawArrays(GL.TRIANGLES, 0, 3);
      var px = new Float32Array(outW * outH * 4);
      gl.readPixels(0, 0, outW, outH, GL.RGBA, GL.FLOAT, px);
      gl.bindFramebuffer(GL.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo); gl.deleteTexture(outTex);
      inputs.forEach(function (inp) { gl.deleteTexture(inp.tex); });
      var out = new Float32Array(outW * outH);
      for (var i = 0; i < out.length; i++) out[i] = px[i * 4];
      return out;
    }
    function glShape(n, maxTex) { var w = Math.max(1, Math.min(n, maxTex)); return { w: w, h: Math.max(1, Math.ceil(n / w)) }; }
    function checkTex(gl, w, h) {
      var mt = (st.glProbe && st.glProbe.maxTextureSize) || 0;
      if (w > mt || h > mt) throw new Error('紋理尺寸 ' + w + '×' + h + ' 超過 MAX_TEXTURE_SIZE（' + mt + '）');
    }
    function glVectorAdd(gl, a, b) {
      var n = a.length, s = glShape(n, st.glProbe.maxTextureSize);
      checkTex(gl, s.w, s.h);
      var prog = glProgram(gl, 'vector_add', GLSL.vector_add);
      var ta = glUpload(gl, a, s.w, s.h), tb = glUpload(gl, b, s.w, s.h);
      return glPass(gl, prog, [{ name: 'uA', tex: ta }, { name: 'uB', tex: tb }], { uW: s.w, uN: n }, s.w, s.h).subarray(0, n);
    }
    function glMatmul(gl, A, B, m, k, n) {
      var mt = st.glProbe.maxTextureSize;
      checkTex(gl, k, m); checkTex(gl, n, k); checkTex(gl, n, m);
      var prog = glProgram(gl, 'matmul', GLSL.matmul);
      var ta = glUpload(gl, A, k, m), tb = glUpload(gl, B, n, k);
      return glPass(gl, prog, [{ name: 'uA', tex: ta }, { name: 'uB', tex: tb }], { uK: k }, n, m);
    }
    function glSum(gl, a) {
      var len = a.length, mt = st.glProbe.maxTextureSize;
      var s = glShape(len, mt); checkTex(gl, s.w, s.h);
      var prog = glProgram(gl, 'sum', GLSL.sum);
      var tex = glUpload(gl, a, s.w, s.h), W = s.w;
      while (len > 1) {
        var outLen = Math.ceil(len / 4), os = glShape(outLen, mt);
        var out = glPass(gl, prog, [{ name: 'uA', tex: tex }], { uW: W, uN: len, uOW: os.w }, os.w, os.h).subarray(0, outLen);
        len = outLen;
        if (len > 1) { s = glShape(len, mt); tex = glUpload(gl, out, s.w, s.h); W = s.w; }
        else return out[0];
      }
      return a.length === 1 ? a[0] : 0;
    }

    // ----- 任意核心（numba 轉譯來的 WGSL，見 renderer/src/pybridge/numba/wgsl.py）-----
    // 只在 WebGPU（T1）執行。WebGL2 沒有任意核心的執行路徑，CPU 也沒有核心解譯器；
    // 不能執行時回傳 ran:false 與原因，由上層在本機 Python 模擬並把原因印給使用者。
    function readBackBytes(dev, buf, bytes) {
      var rb = dev.createBuffer({ size: bytes, usage: USAGE.MAP_READ | USAGE.COPY_DST });
      var enc = dev.createCommandEncoder(); enc.copyBufferToBuffer(buf, 0, rb, 0, bytes); dev.queue.submit([enc.finish()]);
      return rb.mapAsync(USAGE.MAP_READ).then(function () {
        var out = new Uint8Array(rb.getMappedRange().slice(0));
        rb.unmap(); rb.destroy();
        return out;
      });
    }
    // spec: { wgsl, groups:[gx,gy], bindings:[{ name, dtype:'f32'|'i32', n, write, data:TypedArray|null }] }
    function wgKernel(dev, spec) {
      return withScope(dev, async function () {
        var usage = USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC;
        var bufs = spec.bindings.map(function (b) {
          if (b.data) return makeBuf(dev, b.data, usage);
          return dev.createBuffer({ size: Math.max(4, b.n * 4), usage: usage });
        });
        var pipe = pipeline(dev, 'kernel:' + spec.wgsl, spec.wgsl);
        dispatch(dev, pipe, bufs, spec.groups[0], spec.groups[1]);
        var outs = {};
        for (var i = 0; i < spec.bindings.length; i++) {
          var b = spec.bindings[i];
          if (b.write) outs[b.name] = await readBackBytes(dev, bufs[i], b.n * 4);
        }
        return outs;
      });
    }
    async function runKernel(spec) {
      var dev = await ensure();
      if (st.lost) return { ran: false, layer: 'CPU', reason: st.lost + '，WebGPU 不再使用' };
      if (!dev) return { ran: false, layer: 'CPU', reason: ((st.probe && st.probe.reason) || '沒有 WebGPU 裝置') + '；WebGL2 沒有任意核心的執行路徑' };
      try {
        var outs = await wgKernel(dev, spec);
        var info = { lib: 'cudaweb', op: 'kernel', layer: 'T1', via: 'wgsl-kernel', reason: '' };
        st.last = info; st.opLast.kernel = info;
        return { ran: true, layer: 'T1', outputs: outs, reason: '' };
      } catch (e) {
        return { ran: false, layer: 'CPU', reason: 'WGSL 核心執行失敗（' + msg(e) + '）' };
      }
    }

    // ----- 統一執行：預算、排程、層選擇與降級回報 -----
    function reasonOf(e) { return msg(e); }
    var RANK = { T1: 1, T3: 2, T5: 3 };
    // 分塊時取最差的層（T5 比 T3 差，T3 比 T1 差）
    function worseInfo(a, b) { if (!a) return b; return RANK[b.layer] > RANK[a.layer] ? b : a; }
    async function run(op, spec) {
      st.calls++;
      var release = await st.sched.acquire(spec.priority || 'sim');
      var skipped = [];
      try {
        if (st.used + spec.bytes > st.budget) {
          skipped.push('GPU 緩衝區預算不足（需要 ' + spec.bytes + ' 位元組，已用 ' + st.used + '，上限 ' + st.budget + '）');
        } else {
          st.used += spec.bytes;
          try {
            // T1：WebGPU
            if (spec.wg) {
              var dev = await ensure();
              var prof0 = profileOf(st.probe, st.glProbe).profile;
              if (spec.needAtomics && dev && prof0 === 'A') skipped.push('檔 A 沒有原子操作，這個替代需要檔 B 以上（檔 A 的排序替代尚未實作）');
              else if (st.lost) skipped.push(st.lost + '，WebGPU 不再使用');
              else if (!dev) skipped.push((st.probe && st.probe.reason) || '沒有 WebGPU 裝置');
              else if (spec.bytes > 0 && spec.maxStorage && spec.maxStorage > maxBytes()) skipped.push('輸入超過裝置的儲存緩衝上限（需要 ' + spec.maxStorage + ' 位元組，上限 ' + maxBytes() + '）');
              else {
                try {
                  var v1 = await spec.wg(dev);
                  return record(op, { result: v1, layer: 'T1', via: spec.subst ? 'wgsl-substitute' : 'wgsl-native', skipped: skipped });
                } catch (e) { skipped.push('WGSL 核心執行失敗（' + reasonOf(e) + '）'); }
              }
            } else skipped.push('WGSL 版尚未實作');
            // T3：WebGL2
            if (spec.gl) {
              var gl = getGl();
              if (!gl) skipped.push(st.glProbe.reason);
              else if (!st.glProbe.available) skipped.push(st.glProbe.reason);
              else {
                try {
                  var v3 = spec.gl(gl);
                  return record(op, { result: v3, layer: 'T3', via: 'webgl2', skipped: skipped });
                } catch (e) { skipped.push('WebGL2 核心執行失敗（' + reasonOf(e) + '）'); }
              }
            } else skipped.push('WebGL2 版尚未實作');
          } finally { st.used -= spec.bytes; }
        }
        var cv = spec.cpu();
        return record(op, { result: cv, layer: 'T5', via: 'cpu-js', skipped: skipped });
      } finally { release(); }
    }
    function record(op, r) {
      var reason = r.skipped.length ? (r.layer === 'T5' ? '降到純 JS：' : '') + r.skipped.join('；') : '';
      var info = {
        lib: 'cudaweb', op: op, layer: r.layer, via: r.via, reason: reason,
        accumulate: 'f32', reductionOrder: op === 'sum' || op === 'dot' || op === 'nrm2' ? 'tree-wg256' : (op === 'matmul' || op === 'gemv' ? 'k-sequential' : 'elementwise')
      };
      st.last = info; st.opLast[op] = info;
      if (reason) st.log.push({ op: op, layer: r.layer, reason: reason });
      return { result: r.result, info: info };
    }
    function toF32(arr, name) {
      if (!arr || typeof arr.length !== 'number') throw new Error('cudaweb：' + name + ' 必須是數字陣列');
      var out = new Float32Array(arr.length);
      for (var i = 0; i < arr.length; i++) {
        var x = Number(arr[i]);
        if (!isFinite(x)) throw new Error('cudaweb：' + name + '[' + i + '] 不是有限數字（' + arr[i] + '）');
        out[i] = x;
      }
      return out;
    }
    function scalarArg(x, name) { var v = Number(x); if (!isFinite(v)) throw new Error('cudaweb：' + name + ' 必須是有限數字'); return v; }

    var OPS_SUPPORT = {
      vector_add: { t1: true, t3: true }, matmul: { t1: true, t3: true }, sum: { t1: true, t3: true },
      axpy: { t1: true, t3: false }, scal: { t1: true, t3: false }, dot: { t1: true, t3: false },
      nrm2: { t1: true, t3: false }, gemv: { t1: true, t3: true },
      sum_dd: { t1: true, t3: false }, scatter_add: { t1: true, t3: false }
    };
    // 替代實作清單（DESIGN.webgpu-cuda.md §3）：原生沒有的原語，用這些做法補上
    var SUBST = {
      sum_dd: { kind: 'double-float', replaces: 'f64 歸約', precisionBits: '約 48（預估，未實測）', profileNeed: 'A 以上' },
      scatter_add: { kind: 'cas-f32-atomic', replaces: 'f32 原子加', profileNeed: 'B 以上（需要整數原子）', note: '檔 A 的排序替代尚未實作' },
      matmul: { kind: 'chunked', replaces: '超過儲存緩衝上限的矩陣乘', note: '依 maxStorageBufferBindingSize 分塊' },
      add64: { kind: 'two-u32', replaces: '64 位元整數', note: '只有 CPU 參考版（add64），沒有 GPU 核心' },
      warp_shuffle: { kind: 'shared-memory-barrier', replaces: 'warp shuffle／vote（無 subgroups 時）', note: '歸約已用共享記憶體與屏障，任意 shuffle 尚未實作' }
    };

    // 選核注入點（O14b）：宿主可設定 fn(m, k, n, flags) → 'matmul_vec4' | 'matmul' | null。預設 null，行為與原本相同。
    var matmulKernelChooser = null;
    function setMatmulKernelChooser(fn) { matmulKernelChooser = typeof fn === 'function' ? fn : null; }
    var api = {
      runKernel: runKernel,
      setMatmulKernelChooser: setMatmulKernelChooser,
      vectorAdd: async function (a, b) {
        var A = toF32(a, 'a'), B = toF32(b, 'b');
        if (A.length !== B.length) throw new Error('cudaweb.vector_add：兩個向量長度不同（' + A.length + ' 與 ' + B.length + '）');
        return run('vector_add', { bytes: A.length * 4 * 3, maxStorage: A.length * 4,
          wg: function (dev) { return wgVectorAdd(dev, A, B).then(Array.from); },
          gl: function (gl) { return Array.from(glVectorAdd(gl, A, B)); },
          cpu: function () { return Array.from(vectorAddRef(A, B)); } });
      },
      // flags：{ transA, transB }（可省）。轉置旗標送進同一份 WGSL 核心（索引換掉），不在宿主端轉置。
      // 轉置時 GL 退路不支援（那條路沒有轉置版），所以只給 WGSL 與 CPU 參考兩條路。
      matmulOne: async function (A0, B0, m, k, n, flags) {
        var MA = toF32(A0, 'A'), MB = toF32(B0, 'B');
        if (MA.length !== m * k) throw new Error('cudaweb.matmul：A 的元素數 ' + MA.length + ' 與 m×k=' + (m * k) + ' 不符');
        if (MB.length !== k * n) throw new Error('cudaweb.matmul：B 的元素數 ' + MB.length + ' 與 k×n=' + (k * n) + ' 不符');
        var fl = mmTileFlags(flags);
        return run('matmul', { bytes: (MA.length + MB.length + m * n) * 4, maxStorage: MA.length * 4,
          wg: function (dev) { return wgMatmul(dev, MA, MB, m, k, n, fl ? flags : undefined).then(Array.from); },
          gl: fl ? undefined : function (gl) { return Array.from(glMatmul(gl, MA, MB, m, k, n)); },
          cpu: function () { return Array.from(fl ? matmulTRef(MA, MB, m, k, n, fl) : matmulRef(MA, MB, m, k, n)); } });
      },
      sum: async function (a0) {
        var A = toF32(a0, 'a');
        return run('sum', { bytes: A.length * 4 * 2, maxStorage: A.length * 4,
          wg: function (dev) { return wgSum(dev, A); },
          gl: function (gl) { return glSum(gl, A); },
          cpu: function () { return sumRef(A); } });
      },
      // 矩陣乘（自動分塊）：A 的每一塊 m'×k、B 的每一塊 k×n'、C 的每一塊 m'×n' 都不超過儲存緩衝上限。
      // 沒有超過時直接執行一次；超過時切塊各自執行（每塊都經過預算與層選擇），再拼回 m×n。
      matmul: async function (A0, B0, m, k, n, flags) {
        var MA = toF32(A0, 'A'), MB = toF32(B0, 'B');
        if (MA.length !== m * k) throw new Error('cudaweb.matmul：A 的元素數 ' + MA.length + ' 與 m×k=' + (m * k) + ' 不符');
        if (MB.length !== k * n) throw new Error('cudaweb.matmul：B 的元素數 ' + MB.length + ' 與 k×n=' + (k * n) + ' 不符');
        await ensure();
        var lim = (st.device && maxBytes()) || DEFAULT_STORAGE_MAX;
        if (m * k * 4 <= lim && k * n * 4 <= lim && m * n * 4 <= lim) return api.matmulOne(MA, MB, m, k, n, flags);
        // 轉置版不分塊（分塊是依列切，轉置後的列不同）：超過上限就如實報錯，不算錯
        if (mmTileFlags(flags)) throw new Error('cudaweb.matmul：轉置版超過單一儲存緩衝上限（' + lim + ' 位元組），目前不分塊');
        var t = Math.floor(lim / (4 * Math.max(1, k)));
        if (t < 1) throw new Error('cudaweb.matmul：單一列 k=' + k + ' 已超過儲存緩衝上限 ' + lim + ' 位元組，無法分塊');
        var mc = Math.min(m, t);
        var nc = Math.min(n, t, Math.floor(lim / (4 * mc)));
        if (nc < 1) throw new Error('cudaweb.matmul：分塊後的欄寬為 0（上限 ' + lim + ' 位元組）');
        var out = new Array(m * n), chunks = 0, worst = null, reasons = [];
        for (var r0 = 0; r0 < m; r0 += mc) {
          var rr = Math.min(mc, m - r0);
          for (var c0 = 0; c0 < n; c0 += nc) {
            var cc = Math.min(nc, n - c0);
            var As = MA.subarray(r0 * k, (r0 + rr) * k);
            var Bs = new Float32Array(k * cc);
            for (var q = 0; q < k; q++) for (var c = 0; c < cc; c++) Bs[q * cc + c] = MB[q * n + c0 + c];
            var res = await api.matmulOne(As, Bs, rr, k, cc);
            for (var r = 0; r < rr; r++) for (c = 0; c < cc; c++) out[(r0 + r) * n + c0 + c] = res.result[r * cc + c];
            worst = worseInfo(worst, res.info);
            if (res.info.reason && reasons.indexOf(res.info.reason) < 0) reasons.push(res.info.reason);
            chunks++;
          }
        }
        var info = Object.assign({}, worst, { chunks: chunks, reason: reasons.join('；') });
        st.last = info; st.opLast.matmul = info;
        return { result: out, info: info };
      },
      // 批次矩陣乘（O14）：items 每組是 [A, B, m, k, n]（可再加第 6 個元素為 flags）或 {A, B, m, k, n, flags}。
      // 全部在儲存上限內：走 wgMatmulMany（一次 submit、一次讀回）；有組超過上限：逐組走 matmul（含分塊）。
      // 回傳 { results: [每組的陣列], info }；info.batched 只有真的走 WebGPU 批次才是 true。
      matmulMany: async function (items) {
        if (!Array.isArray(items)) throw new Error('cudaweb.matmul_many：items 必須是陣列');
        var jobs = items.map(function (it, i) {
          var o = Array.isArray(it) ? { A: it[0], B: it[1], m: it[2], k: it[3], n: it[4], flags: it[5] } : (it || {});
          var m = Number(o.m), k = Number(o.k), n = Number(o.n);
          if (!(m >= 1 && k >= 1 && n >= 1) || m % 1 || k % 1 || n % 1) throw new Error('cudaweb.matmul_many：第 ' + i + ' 組的 m、k、n 必須是正整數');
          var MA = toF32(o.A, 'items[' + i + '].A'), MB = toF32(o.B, 'items[' + i + '].B');
          if (MA.length !== m * k) throw new Error('cudaweb.matmul_many：第 ' + i + ' 組 A 的元素數 ' + MA.length + ' 與 m×k=' + (m * k) + ' 不符');
          if (MB.length !== k * n) throw new Error('cudaweb.matmul_many：第 ' + i + ' 組 B 的元素數 ' + MB.length + ' 與 k×n=' + (k * n) + ' 不符');
          return { MA: MA, MB: MB, m: m, k: k, n: n, flags: o.flags, fl: mmTileFlags(o.flags) };
        });
        if (!jobs.length) return { results: [], info: { lib: 'cudaweb', op: 'matmul_many', layer: null, via: 'empty', reason: '', items: 0, batched: false } };
        await ensure();
        var lim = (st.device && maxBytes()) || DEFAULT_STORAGE_MAX;
        var fits = jobs.every(function (j) { return j.m * j.k * 4 <= lim && j.k * j.n * 4 <= lim && j.m * j.n * 4 <= lim; });
        if (!fits) {
          var outs = [], worst = null, reasons = [];
          for (var q = 0; q < jobs.length; q++) {
            var r = await api.matmul(jobs[q].MA, jobs[q].MB, jobs[q].m, jobs[q].k, jobs[q].n, jobs[q].flags);
            outs.push(r.result); worst = worseInfo(worst, r.info);
            if (r.info.reason && reasons.indexOf(r.info.reason) < 0) reasons.push(r.info.reason);
          }
          var pinfo = Object.assign({}, worst, { op: 'matmul_many', via: 'per-item', items: jobs.length, batched: false,
            reason: '有組超過單一儲存緩衝上限，逐組執行' + (reasons.length ? '；' + reasons.join('；') : '') });
          st.last = pinfo; st.opLast.matmul_many = pinfo;
          return { results: outs, info: pinfo };
        }
        var bytes = 0, maxStore = 0;
        jobs.forEach(function (j) { bytes += (j.MA.length + j.MB.length + j.m * j.n) * 4; maxStore = Math.max(maxStore, j.MA.length * 4, j.MB.length * 4, j.m * j.n * 4); });
        var anyFl = jobs.some(function (j) { return j.fl; });
        var res = await run('matmul_many', { bytes: bytes, maxStorage: maxStore,
          wg: function (dev) { return wgMatmulMany(dev, jobs); },
          gl: anyFl ? undefined : function (gl) { return jobs.map(function (j) { return Array.from(glMatmul(gl, j.MA, j.MB, j.m, j.k, j.n)); }); },
          cpu: function () { return jobs.map(function (j) { return Array.from(j.fl ? matmulTRef(j.MA, j.MB, j.m, j.k, j.n, j.fl) : matmulRef(j.MA, j.MB, j.m, j.k, j.n)); }); } });
        return { results: res.result, info: Object.assign({}, res.info, { items: jobs.length, batched: res.info.layer === 'T1' }) };
      },
      // T2：雙 f32 歸約（f64 精度的替代）
      sumDd: async function (a0) {
        var A = toF32(a0, 'a');
        return run('sum_dd', { bytes: A.length * 4 * 3, maxStorage: A.length * 4, subst: true,
          wg: function (dev) { return wgSumDd(dev, A); },
          cpu: function () { return sumDdRef(A); } });
      },
      // T2：f32 原子加（CAS 迴圈）。idx 必須是 0..outLen-1 的整數。
      scatterAdd: async function (idx0, vals0, outLen) {
        var I = Array.from(idx0 || []), V = toF32(vals0, 'vals');
        if (I.length !== V.length) throw new Error('cudaweb.scatter_add：索引與數值長度不同（' + I.length + ' 與 ' + V.length + '）');
        var ol = Math.floor(Number(outLen));
        if (!(ol > 0)) throw new Error('cudaweb.scatter_add：outLen 必須是正整數');
        var IU = new Uint32Array(I.length);
        for (var i = 0; i < I.length; i++) {
          var v = Number(I[i]);
          if (!Number.isInteger(v) || v < 0 || v >= ol) throw new Error('cudaweb.scatter_add：索引 ' + I[i] + ' 超出 0..' + (ol - 1));
          IU[i] = v;
        }
        return run('scatter_add', { bytes: I.length * 8 + ol * 4, maxStorage: Math.max(I.length * 4, ol * 4), needAtomics: true, subst: true,
          wg: function (dev) { return wgScatterAdd(dev, IU, V, ol).then(Array.from); },
          cpu: function () { return Array.from(scatterAddRef(IU, V, ol)); } });
      },
      // 第二階段（cuBLAS 常用子集）：saxpy、sscal、sdot、snrm2、sgemv
      axpy: async function (alpha, x0, y0) {
        var al = scalarArg(alpha, 'alpha'), X = toF32(x0, 'x'), Y = toF32(y0, 'y');
        if (X.length !== Y.length) throw new Error('cudaweb.axpy：x 與 y 長度不同（' + X.length + ' 與 ' + Y.length + '）');
        return run('axpy', { bytes: X.length * 4 * 2,
          wg: function (dev) { return wgAxpy(dev, al, X, Y).then(Array.from); },
          cpu: function () { return Array.from(axpyRef(al, X, Y)); } });
      },
      scal: async function (alpha, x0) {
        var al = scalarArg(alpha, 'alpha'), X = toF32(x0, 'x');
        return run('scal', { bytes: X.length * 4,
          wg: function (dev) { return wgScal(dev, al, X).then(Array.from); },
          cpu: function () { return Array.from(scalRef(al, X)); } });
      },
      dot: async function (x0, y0) {
        var X = toF32(x0, 'x'), Y = toF32(y0, 'y');
        if (X.length !== Y.length) throw new Error('cudaweb.sdot：x 與 y 長度不同（' + X.length + ' 與 ' + Y.length + '）');
        return run('dot', { bytes: X.length * 4 * 3,
          wg: function (dev) { return wgDot(dev, X, Y); },
          cpu: function () { return dotRef(X, Y); } });
      },
      nrm2: async function (x0) {
        var X = toF32(x0, 'x');
        return run('nrm2', { bytes: X.length * 4 * 3,
          wg: async function (dev) { var s = await wgDot(dev, X, X); return Math.fround(Math.sqrt(s)); },
          cpu: function () { return nrm2Ref(X); } });
      },
      // 包含式前綴和（O14c 樣板）：out[i] = Σ_{j≤i} a[j]。CPU 參考是逐步 f32 累加（與 GPU 的樹狀順序不同，比對用容差）。
      scan: async function (a0) {
        var A = toF32(a0, 'a');
        return run('scan', { bytes: A.length * 4 * 2, maxStorage: A.length * 4,
          wg: function (dev) { return wgScan(dev, A); },
          cpu: function () { var o = new Array(A.length), acc = 0; for (var i = 0; i < A.length; i++) { acc = Math.fround(acc + A[i]); o[i] = acc; } return o; } });
      },
      // 轉置（O14c 樣板）：A 為 m×n（列主序）→ 回傳 n×m（列主序）。
      transpose: async function (A0, m, n) {
        var MA = toF32(A0, 'A');
        if (MA.length !== m * n) throw new Error('cudaweb.transpose：A 的元素數 ' + MA.length + ' 與 m×n=' + (m * n) + ' 不符');
        return run('transpose', { bytes: MA.length * 4 * 2, maxStorage: MA.length * 4,
          wg: function (dev) { return wgTranspose(dev, MA, m, n).then(Array.from); },
          cpu: function () { var o = new Array(m * n); for (var i = 0; i < m; i++) for (var j = 0; j < n; j++) o[j * m + i] = MA[i * n + j]; return o; } });
      },
      gemv: async function (A0, x0, m, n) {
        var MA = toF32(A0, 'A'), X = toF32(x0, 'x');
        if (MA.length !== m * n) throw new Error('cudaweb.gemv：A 的元素數 ' + MA.length + ' 與 m×n=' + (m * n) + ' 不符');
        if (X.length !== n) throw new Error('cudaweb.gemv：x 的長度 ' + X.length + ' 與 n=' + n + ' 不符');
        return run('gemv', { bytes: (MA.length + X.length + m) * 4, maxStorage: MA.length * 4,
          wg: function (dev) { return wgGemv(dev, MA, X, m, n).then(Array.from); },
          gl: function (gl) { return Array.from(glMatmul(gl, MA, X, m, n, 1)); },
          cpu: function () { return Array.from(gemvRef(MA, X, m, n)); } });
      },
      // 目前狀態：能力偵測、能力檔、各操作的層與原因、預算與排程
      backendInfo: async function () {
        var pa = await ensure();
        var gl = getGl();
        var prof = profileOf(st.probe, st.glProbe);
        var ops = {};
        Object.keys(OPS_SUPPORT).forEach(function (op) {
          var last = st.opLast[op] || null;
          ops[op] = {
            layer: last ? last.layer : null,
            webgpu: OPS_SUPPORT[op].t1 ? 'native' : 'missing',
            webgl2: OPS_SUPPORT[op].t3 ? 'native' : 'missing',
            reason: last ? last.reason : ''
          };
        });
        var P = st.probe || { hasWebGPU: false, hasAdapter: false };
        return {
          hasWebGPU: !!P.hasWebGPU,
          hasAdapter: !!P.hasAdapter,
          isFallbackAdapter: !!P.isFallbackAdapter,
          probeReason: P.reason || '',
          features: P.features || [],
          limits: P.limits || {},
          deviceReady: !!st.device && !st.lost,
          webgl2: st.glProbe ? { available: st.glProbe.available, reason: st.glProbe.reason, maxTextureSize: st.glProbe.maxTextureSize, colorBufferFloat: st.glProbe.colorBufferFloat } : { available: false, reason: '尚未探測（第一次呼叫時才探測）' },
          profile: prof.profile, profileReason: prof.reason,
          substitutes: SUBST,
          ops: ops,
          last: st.last,
          calls: st.calls,
          degradeLog: st.log.slice(-50),
          budget: { limitBytes: st.budget, usedBytes: st.used },
          scheduler: st.sched.stats()
        };
      }
    };
    return api;
  }

  return {
    probeAdapter: probeAdapter,
    probeWebgl2: probeWebgl2,
    profileOf: profileOf,
    tolerance: tolerance,
    vectorAddRef: vectorAddRef,
    matmulRef: matmulRef,
    mmTileWgsl: mmTileWgsl, mmTileDispatch: mmTileDispatch, mmTileWords: mmTileWords, mmTileFlags: mmTileFlags,
    mmTileSharedBytes: mmTileSharedBytes, matmulTRef: matmulTRef,
    mmTileWgslVec4: mmTileWgslVec4, mmTileVec4Ok: mmTileVec4Ok,
    mmR8Wgsl: mmR8Wgsl, mmR8Ok: mmR8Ok, mmR8Dispatch: mmR8Dispatch,
    sumRef: sumRef,
    sumExact: sumExact,
    axpyRef: axpyRef,
    scalRef: scalRef,
    mulRef: mulRef,
    dotRef: dotRef,
    nrm2Ref: nrm2Ref,
    gemvRef: gemvRef,
    ddAdd: ddAdd,
    sumDdRef: sumDdRef,
    add64: add64,
    scatterAddRef: scatterAddRef,
    kernels: WGSL,
    glKernels: GLSL,
    createRuntime: createRuntime,
    createScheduler: createScheduler,
    WG: WG,
    TILE: TILE,
    DEFAULT_BUDGET: DEFAULT_BUDGET
  };
}));
