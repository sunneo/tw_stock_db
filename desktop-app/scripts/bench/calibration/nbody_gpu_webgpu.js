// 校準：N-body 全對全（與 nbody3d.py 的 pairwise_gpu 同一個算式）的 WebGPU 版本，真 Electron。
// 核心：一個執行緒一個物體，256 物體一塊搬進共用記憶體（每個工作群組共讀同一塊位置），相鄰執行緒讀相鄰位址（合併）。
// 量：(a) 每幀核心時間（同一 encoder 內 K 次派發，斜率 (t(K=25)−t(K=5))/20）；(b) 每幀含讀回（與 python 版一樣把四個陣列讀回 CPU）的牆鐘時間。
const adapter = await navigator.gpu.requestAdapter();
const dev = await adapter.requestDevice();
const now = () => performance.now();
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const r3 = (x) => Math.round(x * 1000) / 1000;
const USAGE = { STORAGE: 0x80, UNIFORM: 0x40, COPY_DST: 0x8, COPY_SRC: 0x4, MAP_READ: 0x1 };

const WGSL = (n) => `
struct P { n: u32, soft2: f32, g: f32, pad: f32 }
@group(0) @binding(0) var<storage, read> px: array<f32>;
@group(0) @binding(1) var<storage, read> py: array<f32>;
@group(0) @binding(2) var<storage, read> pz: array<f32>;
@group(0) @binding(3) var<storage, read> pm: array<f32>;
@group(0) @binding(4) var<storage, read_write> outv: array<f32>;
@group(0) @binding(5) var<uniform> p: P;
var<workgroup> tx: array<f32, 256>;
var<workgroup> ty: array<f32, 256>;
var<workgroup> tz: array<f32, 256>;
var<workgroup> tm: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let i = gid.x; let t = l.x;
  let ii = min(i, p.n - 1u);
  let xi = px[ii]; let yi = py[ii]; let zi = pz[ii];
  var ax: f32 = 0.0; var ay: f32 = 0.0; var az: f32 = 0.0; var pot: f32 = 0.0;
  let tiles = (p.n + 255u) / 256u;
  for (var tile: u32 = 0u; tile < tiles; tile = tile + 1u) {
    let j = tile * 256u + t;
    if (j < p.n) { tx[t] = px[j]; ty[t] = py[j]; tz[t] = pz[j]; tm[t] = pm[j]; }
    else { tx[t] = 0.0; ty[t] = 0.0; tz[t] = 0.0; tm[t] = 0.0; }
    workgroupBarrier();
    for (var k: u32 = 0u; k < 256u; k = k + 1u) {
      let dx = tx[k] - xi; let dy = ty[k] - yi; let dz = tz[k] - zi;
      let inv = inverseSqrt(dx * dx + dy * dy + dz * dz + p.soft2);
      let s = p.g * tm[k] * inv * inv * inv;
      ax = ax + s * dx; ay = ay + s * dy; az = az + s * dz;
      pot = pot + tm[k] * inv;
    }
    workgroupBarrier();
  }
  if (i < p.n) {
    outv[i] = ax; outv[p.n + i] = ay; outv[2u * p.n + i] = az;
    outv[3u * p.n + i] = pot - pm[i] * inverseSqrt(p.soft2);   // 去掉自己那一項（與 numpy 版相同）
  }
}`;

function mkBuf(n, usage) { return dev.createBuffer({ size: Math.max(16, n * 4), usage }); }

async function runN(n) {
  const rnd = (s) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = (((i * 2654435761 + s) >>> 0) % 1000) / 10; return a; };
  const X = rnd(1), Y = rnd(2), Z = rnd(3);
  const M = new Float32Array(n); for (let i = 0; i < n; i++) M[i] = 200 + (i % 100);
  const bx = mkBuf(n, USAGE.STORAGE | USAGE.COPY_DST), by = mkBuf(n, USAGE.STORAGE | USAGE.COPY_DST), bz = mkBuf(n, USAGE.STORAGE | USAGE.COPY_DST), bm = mkBuf(n, USAGE.STORAGE | USAGE.COPY_DST);
  dev.queue.writeBuffer(bx, 0, X); dev.queue.writeBuffer(by, 0, Y); dev.queue.writeBuffer(bz, 0, Z); dev.queue.writeBuffer(bm, 0, M);
  const bo = mkBuf(4 * n, USAGE.STORAGE | USAGE.COPY_SRC);
  const uni = dev.createBuffer({ size: 16, usage: USAGE.UNIFORM | USAGE.COPY_DST });
  const ub = new ArrayBuffer(16); new Uint32Array(ub, 0, 1)[0] = n; new Float32Array(ub, 4, 1)[0] = 0.25; new Float32Array(ub, 8, 1)[0] = 1.0;
  dev.queue.writeBuffer(uni, 0, ub);
  const module = dev.createShaderModule({ code: WGSL(n) });
  const pipe = await dev.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: bx } }, { binding: 1, resource: { buffer: by } }, { binding: 2, resource: { buffer: bz } },
    { binding: 3, resource: { buffer: bm } }, { binding: 4, resource: { buffer: bo } }, { binding: 5, resource: { buffer: uni } }] });
  const groups = Math.ceil(n / 256);
  const kernelK = async (K) => {
    const enc = dev.createCommandEncoder();
    for (let k = 0; k < K; k++) { const p = enc.beginComputePass(); p.setPipeline(pipe); p.setBindGroup(0, bg); p.dispatchWorkgroups(groups); p.end(); }
    const t0 = now(); dev.queue.submit([enc.finish()]); await dev.queue.onSubmittedWorkDone(); return now() - t0;
  };
  for (let i = 0; i < 2; i++) { await kernelK(3); await kernelK(15); }
  const a = [], b = [];
  for (let i = 0; i < 5; i++) { a.push(await kernelK(5)); b.push(await kernelK(25)); }
  const perKernelMs = Math.max(1e-6, (med(b) - med(a)) / 20);
  // 每幀含讀回：派發一次＋複製到暫存＋映射（與 python 版每幀把 sx,sy,sz,pot 取回 CPU 一致）
  const frameWithRead = async () => {
    const st = dev.createBuffer({ size: 4 * n * 4, usage: USAGE.MAP_READ | USAGE.COPY_DST });
    const enc = dev.createCommandEncoder();
    const p = enc.beginComputePass(); p.setPipeline(pipe); p.setBindGroup(0, bg); p.dispatchWorkgroups(groups); p.end();
    enc.copyBufferToBuffer(bo, 0, st, 0, 4 * n * 4);
    const t0 = now(); dev.queue.submit([enc.finish()]);
    await st.mapAsync(1); const v = new Float32Array(st.getMappedRange().slice(0)); st.unmap(); st.destroy();
    return { ms: now() - t0, v };
  };
  await frameWithRead();
  const wr = [];
  for (let i = 0; i < 7; i++) wr.push((await frameWithRead()).ms);
  const flops = 20 * n * n;
  return { N: n, kernelMsPerFrame: r3(perKernelMs), kernelGflops: r3(flops / (perKernelMs * 1e-3) / 1e9), frameWithReadMsMedian: r3(med(wr)), frameGflopsWithRead: r3(flops / (med(wr) * 1e-3) / 1e9), groups };
}

const out = { adapter: { info: (adapter.info && (adapter.info.description || adapter.info.device)) || null }, results: [] };
for (const n of [1024, 3072, 4096]) {
  out.results.push(await runN(n));
  console.log('[nbody-gpu] ' + JSON.stringify(out.results[out.results.length - 1]));
}
console.log('[nbody-gpu-result] ' + JSON.stringify(out));
return out;
