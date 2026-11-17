'use strict';
// 裝置自動選擇（清單 N，設定 gpuAuto，預設關）：依「WebGPU 能力探測＋一個小基準」決定 cudaweb 的各條 GPU 路徑要不要自動開。
// 純決策函式（decide）可在 node 測；探測（probe）與基準（bench）要 WebGPU，沒有就回 { ok:false, reason }。
// 規則（寫死、可預期）：
//   1. 沒有 WebGPU／沒有 adapter → 全部 off（沒有 WebGPU 的機器走原本的 wasm／WebGL2／純 JS 路徑）。
//   2. 軟體 adapter（isFallbackAdapter、或名稱含 swiftshader／llvmpipe／software／lavapipe）→ 全部 off（軟體模擬比 wasm 慢，量過約 2.5～3.4 秒／詞元）。
//   3. 真 GPU：基準的 GPU 吞吐（GFLOP/s，含上傳與讀回）必須 ≥ MIN_GFLOPS 且 ≥ CPU 基準的 CPU_FACTOR 倍，才開。
//   4. 通過後每條路徑分別依功能需求（例如 q8 解碼要 storage buffer 上限）決定；目前八條路徑（qwenGpuDecode、mossGpu、midiGpu、llmGpuHead、whisperGpu、audioGpu、sdxsGpu、kokoroGpu）同一個結果，原因寫明。
const MIN_GFLOPS = 20, CPU_FACTOR = 3;
// qwenGpuDecode 不在自動清單：聊天的第一則訊息要先讀入 589 MB 的 q8 模型、舊顯卡上還可能卡死（2026-11-17 使用者的 Geforce 實測：發 hi 等很久），
// 只有使用者在「進階」手動勾選才用；其他路徑只在使用者用到那個功能時才載入
const FEATURES = ['qwenGpuQ4', 'mossGpu', 'midiGpu', 'llmGpuHead', 'whisperGpu', 'audioGpu', 'sdxsGpu', 'kokoroGpu'];
const SOFT_RE = /swiftshader|llvmpipe|software|lavapipe|softpipe|basic render/i;

// info：{ hasWebGpu, adapter:{ isFallbackAdapter, vendor, architecture, device, description } | null, gpuGflops, cpuGflops }
function decide(info) {
  const off = (reason) => ({ enabled: false, reason, features: Object.fromEntries(FEATURES.map((f) => [f, { on: false, reason }])) });
  if (!info || !info.hasWebGpu) return off('沒有 WebGPU（navigator.gpu 不存在）');
  const a = info.adapter; if (!a) return off('沒有可用的 WebGPU adapter');
  const name = [a.vendor, a.architecture, a.device, a.description].filter(Boolean).join(' ');
  if (a.isFallbackAdapter || SOFT_RE.test(name)) return off('軟體 WebGPU（' + (name || 'fallback adapter') + '）比 wasm 慢');
  // 2026-11-17 使用者：真 GPU 不用管（最爛的 Geforce 720T 也比 Core i5-2620 快 1.78 倍），而且每條路徑都有失敗退回——
  // 所以只要是真 GPU 就開，不再用基準門檻擋（基準只當資訊顯示）。
  const why = '真 GPU（' + (name || 'unknown') + '）' + (info.gpuGflops > 0 ? '，基準 ' + info.gpuGflops.toFixed(1) + ' GFLOP/s' : '') + (info.cpuGflops > 0 ? '，CPU ' + info.cpuGflops.toFixed(1) : '');
  return { enabled: true, reason: why, features: Object.fromEntries(FEATURES.map((f) => [f, { on: true, reason: why }])) };
}

// CPU 基準：n×n 單精度矩陣乘（JS），回 GFLOP/s
function cpuBench(n) {
  n = n || 96; const a = new Float32Array(n * n).fill(0.5), b = new Float32Array(n * n).fill(0.25), c = new Float32Array(n * n), t0 = Date.now();
  let reps = 0; do { for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) { const x = a[i * n + k]; for (let j = 0; j < n; j++) c[i * n + j] += x * b[k * n + j]; } reps++; } while (Date.now() - t0 < 60);
  return (2 * n * n * n * reps) / ((Date.now() - t0) / 1000) / 1e9;
}

const WGSL_BENCH = `
struct P { n: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> A: array<f32>;
@group(0) @binding(1) var<storage, read> B: array<f32>;
@group(0) @binding(2) var<storage, read_write> C: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let idx = id.x; if (idx >= p.n * p.n) { return; }
  let i = idx / p.n; let j = idx % p.n; var s = 0.0;
  for (var k = 0u; k < p.n; k = k + 1u) { s = s + A[i * p.n + k] * B[k * p.n + j]; }
  C[idx] = s;
}`;

// 在 WebGPU 上量 n×n 矩陣乘（含上傳與讀回，因為產品路徑也要付這個成本）；回 GFLOP/s。nn：nn_ops 模組（runWgsl、getDevice 由呼叫端提供 dev）
async function gpuBench(dev, nn, n) {
  n = n || 256; const A = new Float32Array(n * n).fill(0.5), B = new Float32Array(n * n).fill(0.25), u = new Uint8Array(new Uint32Array([n, 0, 0, 0]).buffer);
  const run = () => nn.runWgsl(dev, WGSL_BENCH, [{ data: A }, { data: B }, { data: new Float32Array(n * n), out: true }], u, Math.ceil(n * n / 64));
  await run(); const t0 = performance.now(); let reps = 0; do { await run(); reps++; } while (performance.now() - t0 < 150);
  return (2 * n * n * n * reps) / ((performance.now() - t0) / 1000) / 1e9;
}

// 瀏覽器端完整流程：nav＝navigator，nn＝nn_ops（getDevice 取裝置）。回 { decision, info }
async function probe(nav, nn) {
  const info = { hasWebGpu: !!(nav && nav.gpu), adapter: null, gpuGflops: 0, cpuGflops: 0 };
  try {
    if (info.hasWebGpu) {
      const ad = await nav.gpu.requestAdapter();
      if (ad) { const ai = ad.info || (ad.requestAdapterInfo ? await ad.requestAdapterInfo() : {}) || {}; info.adapter = { isFallbackAdapter: !!(ad.isFallbackAdapter || ai.isFallbackAdapter), vendor: ai.vendor || '', architecture: ai.architecture || '', device: ai.device || '', description: ai.description || '' }; }
    }
    const soft = info.adapter && (info.adapter.isFallbackAdapter || SOFT_RE.test([info.adapter.vendor, info.adapter.architecture, info.adapter.device, info.adapter.description].join(' ')));
    if (info.adapter && !soft) { // 軟體 adapter 不必量（一定關），省時間
      const g = await nn.getDevice(nav); if (g && g.dev) { info.cpuGflops = cpuBench(); info.gpuGflops = await (nn.withMeasureLock ? nn.withMeasureLock(() => gpuBench(g.dev, nn)) : gpuBench(g.dev, nn)); }
    }
  } catch (e) { info.error = String((e && e.message) || e); }
  return { decision: decide(info), info };
}
module.exports = { decide, cpuBench, gpuBench, probe, FEATURES, MIN_GFLOPS, CPU_FACTOR };
