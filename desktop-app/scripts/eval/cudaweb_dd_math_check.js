'use strict';
// 雙 float32（dd）除法、sqrt、exp、log、sin、cos、tan、tanh、powi、floor 的 WGSL 驗證（清單 O）：把 wgsl.py 的 DD_LIB 放進真 Chrome WebGPU（無 GPU 時 SwiftShader）執行，與 JS float64 比對。
// 用法：node scripts/eval/cudaweb_dd_math_check.js [埠=18782]；先用 python3 把 DD_LIB 寫到 $TMP/dd_lib.wgsl（見 DESIGN §7.17）。結果 POST /result，寫 $TMP/cudaweb_dd_math_check.result.json；完成後呼叫 /quit。
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const PORT = Number(process.argv[2]) || 18782, LIB = process.env.DD_LIB || path.join(os.tmpdir(), 'dd_lib.wgsl');
const lib = fs.readFileSync(LIB, 'utf8');
const KERNEL = lib + `
@group(0) @binding(0) var<storage, read> xs: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read> ys: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> out: array<vec2<f32>>;
@compute @workgroup_size(32)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x; if (i >= arrayLength(&xs)) { return; }
  let x = xs[i]; let y = ys[i]; let b = i * 13u;
  out[b + 0u] = dd_div(x, y); out[b + 1u] = dd_sqrt(dd_abs(x)); out[b + 2u] = dd_exp(x); out[b + 3u] = dd_log(dd_add(dd_abs(x), y));
  out[b + 4u] = dd_sin(x); out[b + 5u] = dd_cos(x); out[b + 6u] = dd_tan(x); out[b + 7u] = dd_tanh(x);
  out[b + 8u] = dd_powi(x, 3); out[b + 9u] = dd_floor(x); out[b + 10u] = dd_powi(x, -2); out[b + 11u] = dd_add(x, y); out[b + 12u] = dd_mul(x, y);
}`;
const PAGE = `<!doctype html><meta charset=utf-8><title>dd math</title><pre id=o>running</pre><script>
(async () => {
  const R = { tests: [] }; const o = document.getElementById('o');
  try {
    const kernel = ${JSON.stringify(KERNEL)};
    const ad = await navigator.gpu.requestAdapter(); const dev = await ad.requestDevice(); R.adapter = (ad.info && (ad.info.description || ad.info.vendor)) || '?';
    const mod = dev.createShaderModule({ code: kernel }); const ci = await mod.getCompilationInfo(); R.compile = ci.messages.map((m) => m.type + ' ' + m.lineNum + ': ' + m.message);
    if (ci.messages.some((m) => m.type === 'error')) throw new Error('WGSL 編譯失敗');
    const xs = [], ys = []; let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 400; i++) { xs.push((rnd() - 0.5) * (i < 200 ? 6 : 60)); ys.push(0.3 + rnd() * 5); }
    for (const v of [0.1, 1, 2, 10.5, -0.5, 3.0, -3.0, 1e-3, 100.25, -100.25]) { xs.push(v); ys.push(1.7); }
    const N = xs.length, split = (a) => { const f = new Float32Array(2 * a.length); a.forEach((v, i) => { const hi = Math.fround(v); f[2 * i] = hi; f[2 * i + 1] = Math.fround(v - hi); }); return f; };
    const mk = (data, usage) => { const b = dev.createBuffer({ size: data.byteLength, usage }); dev.queue.writeBuffer(b, 0, data); return b; };
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, bx = mk(split(xs), S), by = mk(split(ys), S);
    const outBytes = N * 13 * 8, bo = dev.createBuffer({ size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }), rb = dev.createBuffer({ size: outBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const pipe = await dev.createComputePipelineAsync({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
    const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [bx, by, bo].map((b, i) => ({ binding: i, resource: { buffer: b } })) });
    const enc = dev.createCommandEncoder(), p = enc.beginComputePass(); p.setPipeline(pipe); p.setBindGroup(0, bg); p.dispatchWorkgroups(Math.ceil(N / 32)); p.end(); enc.copyBufferToBuffer(bo, 0, rb, 0, outBytes); dev.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ); const f = new Float32Array(rb.getMappedRange().slice(0)); rb.unmap();
    const val = (i, k) => f[(i * 13 + k) * 2] + f[(i * 13 + k) * 2 + 1];
    const refs = [(x, y) => x / y, (x) => Math.sqrt(Math.abs(x)), (x) => Math.exp(x), (x, y) => Math.log(Math.abs(x) + y), Math.sin, Math.cos, Math.tan, Math.tanh, (x) => x * x * x, Math.floor, (x) => 1 / (x * x), (x, y) => x + y, (x, y) => x * y];
    const names = ['div', 'sqrt', 'exp', 'log', 'sin', 'cos', 'tan', 'tanh', 'powi3', 'floor', 'powi-2', 'add', 'mul'];
    for (let k = 0; k < 13; k++) {
      let worst = 0, worstAt = 0, n = 0, bad = 0, worstGot = 0, worstWant = 0;
      for (let i = 0; i < N; i++) {
        // 輸入在 dd 裡有 48 位元，參考也用 dd 還原後的 x（避免把輸入量化誤差算成核心誤差）
        const x = f32pair(xs[i]), y = f32pair(ys[i]); const want = refs[k](x, y), got = val(i, k);
        if (!isFinite(want) || Math.abs(want) > 1e30) continue; if (k === 6 && Math.abs(Math.cos(x)) < 1e-3) continue;
        const scale = (k === 3 || k === 4 || k === 5 || k === 7) ? 1 : Math.max(Math.abs(want), 1e-30); // sin/cos/tanh 用絕對誤差（接近 0 的相對誤差無意義）
        const rel = Math.abs(got - want) / scale; n++; if (rel > 1e-11) bad++; if (rel > worst) { worst = rel; worstAt = xs[i]; worstGot = got; worstWant = want; }
      }
      R.tests.push({ op: names[k], n, worstRel: worst, bad, at: worstAt, got: worstGot, want: worstWant });
    }
    function f32pair(v) { const hi = Math.fround(v); return hi + Math.fround(v - hi); }
    R.pass = R.tests.every((t) => t.worstRel < 1e-11); R.done = true;
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 1500); }
  o.textContent = JSON.stringify(R, null, 1);
  try { await fetch('/result', { method: 'POST', body: JSON.stringify(R) }); } catch (_) {}
  document.title = '驗證完成';
})();
</script>`;
const RESULT = path.join(os.tmpdir(), 'cudaweb_dd_math_check.result.json');
const srv = http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  if (req.url === '/' || req.url.startsWith('/?')) return send(200, 'text/html', PAGE);
  if (req.url === '/result' && req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { fs.writeFileSync(RESULT, b); console.log('結果已寫入 ' + RESULT); send(200, 'text/plain', 'ok'); }); return; }
  if (req.url === '/quit') { send(200, 'text/plain', 'bye'); setTimeout(() => { srv.close(); process.exit(0); }, 100); return; }
  send(404, 'text/plain', 'nf');
});
srv.listen(PORT, '127.0.0.1', () => console.log('http://127.0.0.1:' + PORT + '/'));
