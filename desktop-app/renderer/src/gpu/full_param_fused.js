'use strict';
// 全參數整步的融合核心（評估中，尚未接到 full_param_step_device.js 的產品步）。
// 目標：降低派發次數（每張量 2 次的優化器段），同時保持每個張量的運算順序與原核心相同（結果逐位相同）。
//
// 綁定上限（跨 GPU 的退路）：每次派發能綁的唯讀／寫入 storage 數由 device.limits.maxStorageBuffersPerShaderStage 決定（規範預設 8，這台可能更高）。
//   · 平方和批次（sumsq_multi）：K 個 g ＋ 1 個 parts，K = limit − 1。limit＝8 → K＝7；limit＝16 → K＝15。
//   · AdamW 批次（adamw_multi）：每張量 p、g、m、v 四個 storage ＋ 共用的 cf，K＝⌊(limit − 1) / 4⌋。limit＝8 → K＝1（與原核心相同，沒有減少）；limit＝16 → K＝3。
//   · 限制值小於 5 時無法放入任何 AdamW 批次，直接拋錯（規範預設不會這樣）。
// 工作群組排列：平方和每群組一個張量；AdamW 每群組 64 個元素，全部張量的群組排成一條線（前綴表 pre），由群組編號找張量。

const MAX_SLOTS = 16;   // uniform 內的陣列容量：ns、pre 各 4 個 vec4（16 個 u32）

function bindLimit(device) {
  const l = device && device.limits && device.limits.maxStorageBuffersPerShaderStage;
  return typeof l === 'number' && l > 0 ? l : 8;
}
function sumsqSlots(limit) { return Math.max(1, Math.min(MAX_SLOTS - 1, limit - 1)); }
function adamwSlots(limit) {
  if (limit < 5) throw new Error('綁定上限 ' + limit + ' 放不下任何 AdamW 批次（需要 p、g、m、v 與 cf 共 5 個）');
  return Math.min(MAX_SLOTS - 1, Math.floor((limit - 1) / 4));
}

// ---- 平方和批次 ----
// 綁定：0..K-1 為 g_j（唯讀）、K 為 parts（寫）、K+1 為 uniform。
// uniform：ns[0..K)（u32，佔 ns 陣列的前 K 格）、base（u32）、cnt（u32）。
const sumsqCode = new Map();
function wgslSumsqMulti(K) {
  if (sumsqCode.has(K)) return sumsqCode.get(K);
  let decl = '';
  for (let j = 0; j < K; j++) decl += '@group(0) @binding(' + j + ') var<storage, read> g' + j + ': array<f32>;\n';
  decl += '@group(0) @binding(' + K + ') var<storage, read_write> parts: array<f32>;\n';
  decl += '@group(0) @binding(' + (K + 1) + ') var<uniform> u: P;\n';
  let br = '';
  for (let j = 0; j < K; j++) {
    br += (j === 0 ? '  if' : '  else if') + ' (slot == ' + j + 'u) { loop { if (i >= n) { break; } let v = g' + j + '[i]; s = s + v * v; i = i + 256u; } }\n';
  }
  const code = 'struct P { ns: array<vec4<u32>, 4>, base: u32, cnt: u32, pad0: u32, pad1: u32 }\n' + decl +
    'var<workgroup> sh: array<f32, 256>;\n' +
    '// @kernel sumsq_multi\n' +
    '@compute @workgroup_size(256)\n' +
    'fn main(@builtin(workgroup_id) w: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n' +
    '  let slot = w.x;\n' +
    '  if (slot >= u.cnt) { return; }\n' +
    '  let n = u.ns[slot / 4u][slot % 4u];\n' +
    '  var s: f32 = 0.0;\n' +
    '  var i: u32 = lid.x;\n' +
    br +
    '  sh[lid.x] = s;\n' +
    '  workgroupBarrier();\n' +
    '  var st: u32 = 128u;\n' +
    '  loop { if (st == 0u) { break; } if (lid.x < st) { sh[lid.x] = sh[lid.x] + sh[lid.x + st]; } workgroupBarrier(); st = st / 2u; }\n' +
    '  if (lid.x == 0u) { parts[u.base + slot] = sh[0]; }\n' +
    '}\n';
  sumsqCode.set(K, code);
  return code;
}

// items：[{ buf, n }]（每個張量的平方和）；寫入 parts[k]（k 為 items 的索引）。回傳派發次數。
function sumsqMultiDispatch(B, items, partsBuf, limit) {
  const K = sumsqSlots(limit);
  let dispatches = 0;
  for (let c0 = 0; c0 < items.length; c0 += K) {
    const chunk = items.slice(c0, c0 + K);
    const bufs = [];
    for (let j = 0; j < K; j++) bufs.push(j < chunk.length ? chunk[j].buf : chunk[0].buf);
    bufs.push(partsBuf.buf);
    const uni = new ArrayBuffer(80); const u32 = new Uint32Array(uni);
    chunk.forEach((it, j) => { u32[j] = it.n; });
    u32[16] = c0; u32[17] = chunk.length;
    B.dispatchRaw(wgslSumsqMulti(K), bufs, uni, chunk.length);
    dispatches++;
  }
  return dispatches;
}

// ---- AdamW 批次 ----
// 綁定：4j（p_j 寫）、4j+1（g_j 讀）、4j+2（m_j 寫）、4j+3（v_j 寫），4K 為 cf（讀），4K+1 為 uniform。
// uniform：ns[0..K)、pre[0..K]（前綴群組數）、cnt（u32），以及 fl 的 10 個 f32（lr,b1,omb1,b2,omb2,eps,wd,c1,c2,scale）。
const adamwCode = new Map();
function wgslAdamwMulti(K) {
  if (adamwCode.has(K)) return adamwCode.get(K);
  let decl = '';
  for (let j = 0; j < K; j++) {
    decl += '@group(0) @binding(' + (4 * j) + ') var<storage, read_write> p' + j + ': array<f32>;\n';
    decl += '@group(0) @binding(' + (4 * j + 1) + ') var<storage, read> g' + j + ': array<f32>;\n';
    decl += '@group(0) @binding(' + (4 * j + 2) + ') var<storage, read_write> m' + j + ': array<f32>;\n';
    decl += '@group(0) @binding(' + (4 * j + 3) + ') var<storage, read_write> v' + j + ': array<f32>;\n';
  }
  decl += '@group(0) @binding(' + (4 * K) + ') var<storage, read> cf: array<f32>;\n';
  decl += '@group(0) @binding(' + (4 * K + 1) + ') var<uniform> u: P;\n';
  // 與 full_param_step_device.js 的 WGSL_ADAMW_COEF 逐運算相同（順序、括號都一樣）
  const upd = (j) => '{ var gg: f32 = 0.0; gg = gg + g' + j + '[i]; gg = gg * cf[0]; gg = gg * u.scale;\n' +
    '    let mn = u.b1 * m' + j + '[i] + u.omb1 * gg;\n' +
    '    let vn = u.b2 * v' + j + '[i] + u.omb2 * gg * gg;\n' +
    '    let pv = p' + j + '[i];\n' +
    '    m' + j + '[i] = mn; v' + j + '[i] = vn;\n' +
    '    p' + j + '[i] = pv - u.lr * u.wd * pv - u.lr * (mn / u.c1) / (sqrt(vn / u.c2) + u.eps); }';
  let br = '';
  for (let j = 0; j < K; j++) br += (j === 0 ? '  if' : '  else if') + ' (slot == ' + j + 'u) ' + upd(j) + '\n';
  const code = 'struct P { ns: array<vec4<u32>, 4>, pre: array<vec4<u32>, 4>, cnt: u32, pad0: u32, pad1: u32, pad2: u32, lr: f32, b1: f32, omb1: f32, b2: f32, omb2: f32, eps: f32, wd: f32, c1: f32, c2: f32, scale: f32 }\n' + decl +
    '// @kernel adamw_multi\n' +
    '@compute @workgroup_size(64)\n' +
    'fn main(@builtin(workgroup_id) w: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n' +
    '  let wg = w.x;\n' +
    '  if (wg >= u.pre[u.cnt / 4u][u.cnt % 4u]) { return; }\n' +
    '  var slot: u32 = 0u;\n' +
    '  for (var j: u32 = 1u; j < u.cnt; j = j + 1u) { if (wg >= u.pre[j / 4u][j % 4u]) { slot = j; } }\n' +
    '  let base = u.pre[slot / 4u][slot % 4u];\n' +
    '  let n = u.ns[slot / 4u][slot % 4u];\n' +
    '  let i = (wg - base) * 64u + lid.x;\n' +
    '  if (i >= n) { return; }\n' +
    br +
    '}\n';
  adamwCode.set(K, code);
  return code;
}

// items：[{ p, g, m, v, n }]（句柄含 .buf）；cf 為裁剪係數句柄；fl 為 10 個 f32（同 full_param_step_device 的 adamwCoef）。回傳派發次數。
function adamwMultiDispatch(B, items, cfH, fl, limit) {
  const K = adamwSlots(limit);
  let dispatches = 0;
  for (let c0 = 0; c0 < items.length; c0 += K) {
    const chunk = items.slice(c0, c0 + K);
    const bufs = [];
    for (let j = 0; j < K; j++) {
      const it = j < chunk.length ? chunk[j] : chunk[0];
      bufs.push(it.p.buf, it.g.buf, it.m.buf, it.v.buf);
    }
    bufs.push(cfH.buf);
    const uni = new ArrayBuffer(192); const u32 = new Uint32Array(uni); const f = new Float32Array(uni, 144, 10);
    let groups = 0;
    const pre = [0];
    chunk.forEach((it, j) => { u32[j] = it.n; groups += Math.ceil(it.n / 64); pre.push(groups); });
    for (let j = 0; j <= chunk.length; j++) u32[16 + j] = pre[j];
    u32[32] = chunk.length;
    f.set(fl);
    B.dispatchRaw(wgslAdamwMulti(K), bufs, uni, groups);
    dispatches++;
  }
  return dispatches;
}

module.exports = { bindLimit, sumsqSlots, adamwSlots, wgslSumsqMulti, wgslAdamwMulti, sumsqMultiDispatch, adamwMultiDispatch };
