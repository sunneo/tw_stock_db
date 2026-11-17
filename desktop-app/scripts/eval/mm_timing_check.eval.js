// 真桌面版（Electron，真 GPU）：核心計時是否可信。
// 同一個 FMA 核心，派發 1 ／ 4 ／ 16 次，各用兩種完成判定量時間：
//   (a) onSubmittedWorkDone；(b) mapAsync 回讀一個元素（必須等 GPU 真的寫完）。
// 若時間與次數大致成正比，且 (a)(b) 一致，核心計時才可信；若 (a) 比 (b) 短很多，就是 onSubmittedWorkDone 太早回。
// 另外量完整路徑（上傳＋派發＋回讀）同一形狀的矩陣乘，給對照。
// 每次提交都很短（約 100 ms 內），避免 Windows 的 GPU 逾時。
const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
try {
  const ad = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
  R.adapter = ad && ad.info ? { vendor: ad.info.vendor, architecture: ad.info.architecture, description: ad.info.description } : null;
  if (!ad) { R.error = 'no adapter'; return R; }
  const dev = await ad.requestDevice();
  const lostP = dev.lost.then((i) => { R.lost = (i && i.message) || 'lost'; });
  const WGSL = `@group(0) @binding(0) var<storage, read_write> OUT: array<f32>;
@group(0) @binding(1) var<uniform> P: vec4<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  var a: f32 = f32(gid.x & 1023u) * 0.000001 + 0.5;
  var b: f32 = a + 0.25; var c: f32 = a + 0.125; var d: f32 = a + 0.0625;
  for (var i: u32 = 0u; i < P.x; i = i + 1u) {
    a = fma(a, 0.9999, 0.0001); b = fma(b, 0.9999, 0.0001); c = fma(c, 0.9999, 0.0001); d = fma(d, 0.9999, 0.0001);
  }
  if (a + b + c + d == -1.0) { OUT[gid.x] = a; }
}`;
  const threads = 256 * 256;
  const out = dev.createBuffer({ size: threads * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const stage = dev.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const ub = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const pipe = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: WGSL }), entryPoint: 'main' } });
  const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: out } }, { binding: 1, resource: { buffer: ub } }] });
  const runN = async (iters, n, mode) => {
    dev.queue.writeBuffer(ub, 0, new Uint32Array([iters, 0, 0, 0]));
    const t0 = now();
    const enc = dev.createCommandEncoder();
    for (let r = 0; r < n; r++) { const pass = enc.beginComputePass(); pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(256); pass.end(); }
    if (mode === 'map') enc.copyBufferToBuffer(out, 0, stage, 0, 4);
    dev.queue.submit([enc.finish()]);
    if (mode === 'done') await dev.queue.onSubmittedWorkDone();
    else { await stage.mapAsync(GPUMapMode.READ); stage.unmap(); }
    return now() - t0;
  };
  // 暖機（編譯）
  await runN(64, 1, 'done'); await runN(64, 1, 'map');
  const iters = 64;   // 每次派發很短；n 次合成一次提交
  R.scaling = [];
  for (const n of [1, 4, 16]) {
    const d = []; const m = [];
    for (let s = 0; s < 3; s++) { d.push(await runN(iters, n, 'done')); m.push(await runN(iters, n, 'map')); }
    d.sort((x, y) => x - y); m.sort((x, y) => x - y);
    const flops = threads * 8 * iters * n;
    R.scaling.push({ n: n, doneMedianMs: +d[1].toFixed(3), mapMedianMs: +m[1].toFixed(3),
      doneGflops: +(flops / (d[1] * 1e6)).toFixed(2), mapGflops: +(flops / (m[1] * 1e6)).toFixed(2) });
  }
  // 完整路徑對照：同一形狀矩陣乘（上傳＋派發＋回讀），取 mm 模組
  const MM = fa._qwenModule ? fa._qwenModule().mm : null;
  if (MM) {
    const M = 64, K = 1024, N = 1024;
    let s = 3; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296 - 0.5; };
    const a = Float32Array.from({ length: M * K }, rnd), b = Float32Array.from({ length: K * N }, rnd);
    const full = [];
    for (let i = 0; i < 3; i++) { const t0 = now(); await MM.matmul(a, [M, K], b, [K, N], { navigator: navigator, kernel: 'mm_vec4_f32' }); full.push(now() - t0); }
    full.sort((x, y) => x - y);
    R.fullPathMs = +full[1].toFixed(3);
    R.fullPathGflops = +((2 * M * K * N) / (full[1] * 1e6)).toFixed(2);
  }
  R.lostBeforeEnd = !!R.lost;
  out.destroy(); stage.destroy(); ub.destroy();
} catch (e) {
  R.error = String((e && e.message) || e).slice(0, 300);
}
return R;
