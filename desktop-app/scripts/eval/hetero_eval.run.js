#!/usr/bin/env node
// 異質訓練的真 Electron 量測與對拍（cudaweb 配接器＋cpu-py 經本機代理）。用法：
//   node scripts/eval/hetero_eval.run.js [--python=python] [--port=18941] [--minutes=20] [--out=E:/Temp/hetero-eval]
//
// 做的事：
//   1. 用 hetero_ref.py 產生 PyTorch 參考（fixture 的 fp64 與 f32 梯度；fixture 的 20 步整批 AdamW，fp64）。
//   2. 啟動本機 HTTP 代理（127.0.0.1）：cpu-py 工作者跑在 Node 端（Python 行程），Electron 端用 fetch 呼叫。
//   3. 生成真 Electron 評估檔（內嵌 gpu/nn_ops.js、gpu/full_param_step_device.js、studio/hetero_*.js），啟動真 Electron（乾淨 userData、換埠、不加 --disable-gpu）。
//   4. 評估檔做：(1a) cudaweb 梯度 vs PyTorch fp64／f32；(1b) cudaweb＋cpu-py 合作 20 步 vs PyTorch 整批 20 步（fp64）；
//      (2) S／M／L 每規模：單 cudaweb、單 cpu-py、合作，A／B 交錯，暖機 2 步、取其後 10 步中位數；記錄份額收斂。
//   5. 評估檔把結果 POST 回代理，代理寫到 --out\result.json，然後關閉 Electron。
// 會開視窗、搶焦點：每次執行前先 node --check；同一輪量測最多跑兩次（見 feedback_eval_rerun_limit）。
// 產物（評估檔、參考 JSON、結果）都放在 --out，不放在 scripts 底下。
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execSync } = require('child_process');
// 全域量測鎖：取得後才開始任何量測（含 cpu-py 參考）；量前 10 秒的處理器使用率寫進結果
const MEASURE = require('./measure_lock.js').acquireSync('hetero_eval.run（cudaweb-hetero 合作量測）');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const APP = path.join(__dirname, '..', '..');
const STUDIO = path.join(APP, 'renderer', 'src', 'studio');
const PY = arg('python', 'python');
const PORT = +arg('port', '18941');
const MINUTES = +arg('minutes', '20');
const OUT = path.resolve(arg('out', 'E:/Temp/hetero-eval'));
const STEPS = 12, WARM = 2, K = 4;
const TORCH_THREADS = arg('torch-threads', '');
if (TORCH_THREADS) process.env.FA_TORCH_THREADS = TORCH_THREADS;   // cpu 工作者的 torch 執行緒數（與 Electron 同機時減少互相搶核心）
const { SIZES, roofline } = require(path.join(APP, 'scripts', 'bench', 'sizes.js'));
const CPU = require(path.join(STUDIO, 'hetero_cpu_py.js'));

fs.mkdirSync(OUT, { recursive: true });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);
const commit = execSync('git rev-parse --short HEAD', { cwd: APP }).toString().trim();
const fx = JSON.parse(fs.readFileSync(path.join(STUDIO, 'fixtures', 'full_param_parity_gqa_qkn_f64.json'), 'utf8'));
const batchFor = (s, k) => { const out = []; for (let j = 0; j < k; j++) out.push(fx.batches[(s * k + j) % fx.batches.length]); return out; };
const KEYS_JS = ['n1', 'n2', 'Wq', 'Wk', 'Wv', 'Wo', 'qn', 'kn', 'Wg', 'Wu', 'Wd'];
const flatInit = { emb: fx.init.emb, nf: fx.init.nf };
fx.init.layers.forEach((Lw, l) => KEYS_JS.forEach((k) => { if (Lw[k]) flatInit['L' + l + '.' + k] = Lw[k]; }));

// ---- 1. PyTorch 參考 ----
function refJob(name, job) {
  const jf = path.join(OUT, name + '.job.json'), of = path.join(OUT, name + '.out.json');
  fs.writeFileSync(jf, JSON.stringify(Object.assign({ cfg: fx.cfg, init: flatInit, out: of }, job)));
  const r = spawnSync(PY, [path.join(STUDIO, 'hetero_ref.py'), jf], { encoding: 'utf8', windowsHide: true, timeout: 600000 });
  if (r.status !== 0) throw new Error('hetero_ref.py（' + name + '）失敗：' + (r.stderr || '').slice(-800));
  return JSON.parse(fs.readFileSync(of, 'utf8'));
}
const steps20 = []; for (let s = 0; s < 20; s++) steps20.push(batchFor(s, 2));
const REF = {
  g64: refJob('ref_g64', { mode: 'grad', dtype: 'float64', seqs: [fx.batches[0], fx.batches[1]] }),
  g32: refJob('ref_g32', { mode: 'grad', dtype: 'float32', seqs: [fx.batches[0], fx.batches[1]] }),
  train64: refJob('ref_train64', { mode: 'train', dtype: 'float64', steps: steps20, lr: fx.lr, wd: fx.wd, clip: fx.clip }),
};
console.log('[hetero-run] 參考完成（PyTorch fp64／f32 梯度、fp64 20 步整批）');

// ---- 2. 本機代理：cpu-py 工作者 ----
const workers = new Map();
function getWorker(id) {
  if (!workers.has(id)) {
    const cfg = id === 'par' ? { cfg: fx.cfg, dtype: 'float64' } : { cfg: SIZES.find((z) => z.name === id).cfg, dtype: 'float32' };
    workers.set(id, CPU.createCpuPyResource(Object.assign({ id, python: PY }, cfg)).then((r) => Object.assign(r, { dtypeName: id === 'par' ? 'f64' : 'f32' })));
  }
  return workers.get(id);
}
let finish = null;
const done = new Promise((res) => { finish = res; });
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Loss,X-N,X-Worker-Ms,X-Phases');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, 'http://127.0.0.1');
  const id = u.searchParams.get('w');
  try {
    if (req.method === 'GET' && u.pathname === '/ref') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(REF)); }
    if (req.method === 'GET' && u.pathname === '/layout') {
      const w = await getWorker(id);
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ names: w.layout, wire: w.dtypeName }));
    }
    if (req.method === 'POST' && u.pathname === '/grad') {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const sl = body.readUInt32LE(0);
      const seqs = JSON.parse(body.slice(4, 4 + sl).toString('utf8'));
      const w = await getWorker(id);
      const pbuf = body.slice(4 + sl);
      const WA = w.dtypeName === 'f32' ? Float32Array : Float64Array;
      const pall = new WA(pbuf.buffer.slice(pbuf.byteOffset, pbuf.byteOffset + pbuf.length));
      const params = {}; let off = 0;
      for (const [name, len] of w.layout) { params[name] = Float64Array.from(pall.subarray(off, off + len)); off += len; }
      const r = await w.impl.gradient({ params, seqs });
      const gall = new WA(off); off = 0;
      for (const [name, len] of w.layout) { gall.set(r.grads[name], off); off += len; }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Loss', String(r.loss)); res.setHeader('X-N', String(r.n)); res.setHeader('X-Worker-Ms', String(r.workerMs));
      res.setHeader('X-Phases', Buffer.from(JSON.stringify(r.phases || {})).toString('base64'));
      return res.end(Buffer.from(gall.buffer));
    }
    if (req.method === 'POST' && u.pathname === '/result') {
      const chunks = []; for await (const c of req) chunks.push(c);
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
      res.setHeader('Content-Type', 'text/plain'); res.end('ok');
      return finish(result);
    }
    res.writeHead(404); res.end('no');
  } catch (e) {
    res.writeHead(500); res.end(String((e && e.message) || e));
  }
});
server.listen(PORT, '127.0.0.1');

// ---- 3. 評估檔（會在 Electron 渲染行程裡執行） ----
// 模組鍵＝相對於 renderer/src 的路徑（studio/…、gpu/…），與評估檔裡的 __load 一致；依 require 掃描收集依賴。
const SRC_ROOT = path.join(APP, 'renderer', 'src');
const keyOf = (abs) => path.relative(SRC_ROOT, abs).split(path.sep).join('/');
const allMods = new Map();
{
  const queue = ['studio/hetero_resources.js', 'studio/hetero_step.js', 'studio/hetero_cudaweb.js', 'studio/llm_full_data.js', 'gpu/nn_ops.js', 'gpu/full_param_step_device.js'];
  while (queue.length) {
    const key = queue.shift();
    if (allMods.has(key)) continue;
    const abs = path.join(SRC_ROOT, key);
    if (!fs.existsSync(abs)) throw new Error('找不到模組：' + key);
    const s = fs.readFileSync(abs, 'utf8');
    allMods.set(key, s);
    const re = /require\((['"])(\.[^'"]+)\1\)/g; let m;
    while ((m = re.exec(s))) queue.push(keyOf(path.resolve(path.dirname(abs), m[2])));
  }
}
const modBlock = [...allMods.entries()].map(([r, s]) => JSON.stringify(r) + ': function (module, exports, require) {\n' + s + '\n}').join(',\n');
const body = `return (async () => {
const __mods = {
${modBlock}
};
const __cache = Object.create(null);
function __norm(base, spec) {
  const parts = base.split('/'); parts.pop();
  for (const seg of spec.split('/')) { if (seg === '.' || seg === '') continue; if (seg === '..') parts.pop(); else parts.push(seg); }
  return parts.join('/');
}
function __load(name) {
  if (__cache[name]) return __cache[name].exports;
  const fn = __mods[name]; if (!fn) throw new Error('未內嵌的模組：' + name);
  const mod = { exports: {} }; __cache[name] = mod;
  fn.call(mod.exports, mod, mod.exports, (spec) => { if (spec[0] !== '.') throw new Error('不提供 Node 模組：' + spec); return __load(__norm(name, spec)); });
  return mod.exports;
}
const BASE = 'http://127.0.0.1:${PORT}';
const COMMIT = ${JSON.stringify(commit)};
const TORCHT = ${JSON.stringify(TORCH_THREADS || 'default')};
const MEASURE = ${JSON.stringify(MEASURE)};
const SHAS = ${JSON.stringify({ 'gpu/nn_ops.js': sha(path.join(APP, 'renderer', 'src', 'gpu', 'nn_ops.js')), 'gpu/full_param_step_device.js': sha(path.join(APP, 'renderer', 'src', 'gpu', 'full_param_step_device.js')) })};
const ROOF = ${JSON.stringify(Object.fromEntries(SIZES.map((z) => [z.name, roofline(z.cfg, { tflops: 0.3, gbs: 14 })])))};
const FX = ${JSON.stringify(fx)};
const SIZE_RUN = ${JSON.stringify(SIZES.filter((z) => z.name !== 'XL').map((z) => ({ name: z.name, cfg: z.cfg })))};
const STEPS = ${STEPS}, WARM = ${WARM}, K = ${K};
const NN = __load('gpu/nn_ops.js');
const FS = __load('gpu/full_param_step_device.js');
const LD = __load('studio/llm_full_data.js');
const RS = __load('studio/hetero_resources.js');
const HS = __load('studio/hetero_step.js');
const CW = __load('studio/hetero_cudaweb.js');
const KEYS = ['n1', 'n2', 'Wq', 'Wk', 'Wv', 'Wo', 'qn', 'kn', 'Wg', 'Wu', 'Wd'];
const flatten = (init) => { const p = { emb: Float64Array.from(init.emb), nf: Float64Array.from(init.nf) }; init.layers.forEach((Lw, l) => KEYS.forEach((k) => { if (Lw[k]) p['L' + l + '.' + k] = Float64Array.from(Lw[k]); })); return p; };
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const r3 = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x);
const worstRel = (got, ref) => { const per = {}; let worst = 0, wn = null; for (const k of Object.keys(ref)) { let m = 0, s = 0; for (let i = 0; i < ref[k].length; i++) { s = Math.max(s, Math.abs(ref[k][i])); m = Math.max(m, Math.abs(got[k][i] - ref[k][i])); } const e = s > 0 ? m / s : m; per[k] = e; if (e > worst) { worst = e; wn = k; } } return { worst, name: wn, per }; };
const batchFor = (s, k) => { const out = []; for (let j = 0; j < k; j++) out.push(FX.batches[(s * k + j) % FX.batches.length]); return out; };
const log = (tag, obj) => console.log('[hetero-eval] ' + tag + ' ' + JSON.stringify(obj));
const ms = (t) => performance.now() - t;
function res0Phases(res) { return res.headers.get('X-Phases') || btoa('{}'); }
function cpuProxy(id, layout, wire) {
  return { gradient: async ({ params, seqs }) => {
    const t0 = performance.now();
    const sj = new TextEncoder().encode(JSON.stringify(seqs));
    const total = layout.reduce((a, x) => a + x[1], 0);
    const WA = wire === 'f32' ? Float32Array : Float64Array;
    const pall = new WA(total); let off = 0;
    for (const [name, len] of layout) { pall.set(params[name], off); off += len; }
    const body = new Uint8Array(4 + sj.length + total * WA.BYTES_PER_ELEMENT);
    new DataView(body.buffer).setUint32(0, sj.length, true);
    body.set(sj, 4); body.set(new Uint8Array(pall.buffer), 4 + sj.length);
    const res = await fetch(BASE + '/grad?w=' + id, { method: 'POST', body: body, headers: { 'Content-Type': 'application/octet-stream' } });
    if (!res.ok) throw new Error('cpu 代理失敗 ' + res.status);
    if (!res.ok) throw new Error('cpu 代理失敗 ' + res.status + ' ' + (await res.text()));
    const loss = +res.headers.get('X-Loss'), workerMs = +res.headers.get('X-Worker-Ms');
    const ph = JSON.parse(atob(res0Phases(res)));
    const gall = new WA(await res.arrayBuffer());
    const grads = {}; off = 0;
    for (const [name, len] of layout) { grads[name] = Float64Array.from(gall.subarray(off, off + len)); off += len; }
    return { loss, n: seqs.length, grads, ms: ms(t0), workerMs, phases: ph };
  } };
}
const REF = await (await fetch(BASE + '/ref')).json();
const g = await NN.getDevice(navigator);
if (!g.dev) { log('no-device', { reason: g.reason || null }); await fetch(BASE + '/result', { method: 'POST', body: JSON.stringify({ error: 'no WebGPU device', reason: g.reason || null }) }); return; }
let adapter = null; try { const ad = await navigator.gpu.requestAdapter(); adapter = ad ? { isFallbackAdapter: ad.isFallbackAdapter, info: ad.info ? { vendor: ad.info.vendor, architecture: ad.info.architecture, device: ad.info.device, description: ad.info.description } : null } : null; } catch (e) { adapter = { error: String(e) }; }
const R = { commit: COMMIT, sha: SHAS, torchThreads: TORCHT, measure: { lockHeld: MEASURE.held, lockDir: MEASURE.dir, cpuBeforeSample: MEASURE.cpuBefore }, adapter, parity: {}, timing: {}, errors: [] };

// (1a) cudaweb 單一梯度 vs PyTorch fp64／f32（fixture，2 序列）
const S0 = FS.makeResidentState(g.dev, FX.cfg, FX.init);
const gpuFx = CW.createCudawebResource({ id: 'gpu', nn: NN, device: g.dev, state: S0, clip: FX.clip, fullParamStepDevice: FS.fullParamStepDevice, loadResident: FS.loadResident });
const rg = await gpuFx.impl.gradient({ params: flatten(FX.init), seqs: batchFor(0, 2) });
const e64 = worstRel(rg.grads, REF.g64.grads), e32 = worstRel(rg.grads, REF.g32.grads);
R.parity.gradCudaweb = { vsTorchFp64: { worst: e64.worst, name: e64.name }, vsTorchF32: { worst: e32.worst, name: e32.name }, computeMs: rg.computeMs, wallMs: r3(rg.ms) };
log('1a', R.parity.gradCudaweb);

// (1b) 合作 20 步（cudaweb＋cpu-py fp64 經代理，每步 2 序列）vs PyTorch 整批 AdamW 20 步（fp64）
{
  const lj = await (await fetch(BASE + '/layout?w=par')).json();
  const cpu = cpuProxy('par', lj.names, lj.wire);
  const set = RS.createResourceSet();
  set.add({ id: 'gpu', kind: 'cudaweb', rate: null, impl: gpuFx.impl });
  set.add({ id: 'cpu', kind: 'cpu-py', rate: null, impl: cpu });
  const coord = HS.createCoordinator({ resources: set, params: flatten(FX.init), lr: FX.lr, wd: FX.wd, clip: FX.clip, eps: 1e-8 });
  const trace = [];
  let fails = 0;
  for (let s = 0; s < 20; s++) {
    const r = await coord.step(batchFor(s, 2));
    fails += r.failures.length;
    trace.push({ step: s + 1, loss: r.loss, shares: r.shares, timing: r.timing.map((t) => ({ id: t.id, n: t.n, ms: r3(t.ms) })) });
  }
  const ec = worstRel(coord.getParams(), REF.train64.params);
  R.parity.coop20 = { vsTorchFp64: { worst: ec.worst, name: ec.name }, failures: fails, trace };
  log('1b', { worst: ec.worst, name: ec.name, failures: fails });
}

// (2) S／M／L 三規模：單 cudaweb、單 cpu-py、合作；A／B 交錯；暖機 WARM 步，取其後 STEPS-WARM 步中位數
for (const sz of SIZE_RUN) {
  try {
    const cfg = sz.cfg;
    const init = LD.makeInit(cfg, 1);
    const P = flatten(init);
    const lj = await (await fetch(BASE + '/layout?w=' + sz.name)).json();
    const cpu = cpuProxy(sz.name, lj.names, lj.wire);
    const St = FS.makeResidentState(g.dev, cfg, init);
    const gres = CW.createCudawebResource({ id: 'gpu', nn: NN, device: g.dev, state: St, clip: 1, fullParamStepDevice: FS.fullParamStepDevice, loadResident: FS.loadResident });
    const set = RS.createResourceSet();
    set.add({ id: 'gpu', kind: 'cudaweb', rate: null, impl: gres.impl });
    set.add({ id: 'cpu', kind: 'cpu-py', rate: null, impl: cpu });
    const coord = HS.createCoordinator({ resources: set, params: flatten(init), lr: 1e-3, wd: 0.01, clip: 1, eps: 1e-8 });
    const seqs = Array.from({ length: K }, (_, j) => Array.from({ length: cfg.T + 1 }, (_, i) => (i * 37 + 11 + j * 101) % cfg.V));
    const rows = [];
    for (let i = 0; i < STEPS; i++) {
      const order = i % 2 === 0 ? ['G', 'C', 'K'] : ['K', 'C', 'G'];
      const row = { i };
      for (const o of order) {
        if (o === 'G') { const r = await gres.impl.gradient({ params: P, seqs }); row.gWall = r.ms; row.gCompute = r.computeMs; }
        if (o === 'C') { const r = await cpu.gradient({ params: P, seqs }); row.cWall = r.ms; row.cWorker = r.workerMs; row.cPhases = r.phases; }
        if (o === 'K') {
          const t0 = performance.now(); const r = await coord.step(seqs); const wall = ms(t0);
          const mx = Math.max(0, ...r.timing.map((t) => t.ms));
          row.kWall = wall; row.kOwn = wall - mx; row.shares = r.shares; row.kTiming = r.timing.map((t) => ({ id: t.id, n: t.n, ms: r3(t.ms) })); row.kPhases = r.phases; row.kCounts = r.timing.map((t) => [t.id, t.n]);
        }
      }
      rows.push(row);
    }
    const st = rows.slice(WARM);
    const pick = (k) => med(st.map((x) => x[k]).filter((x) => typeof x === 'number'));
    const gM = pick('gWall'), cM = pick('cWall'), kM = pick('kWall');
    const entry = {
      cfg, steps: STEPS, warmup: WARM, measuredSteps: st.length, K,
      medianMs: { cudawebWall: r3(gM), cudawebCompute: r3(pick('gCompute')), cpuPyWall: r3(cM), cpuPyWorker: r3(pick('cWorker')), coopWall: r3(kM), coopOwnOverhead: r3(pick('kOwn')) },
      idealSplitMs: r3(1 / (1 / gM + 1 / cM)),
      roofMs: r3(ROOF[sz.name].msRoof), roof: ROOF[sz.name],
      coopOverCpuRatio: r3(kM / cM), coopVsCudawebRatio: r3(kM / gM),
      shareTrace: rows.map((x) => (x.shares ? { i: x.i, gpu: r3(x.shares.gpu), cpu: r3(x.shares.cpu) } : null)).filter(Boolean),
      rows,
    };
    R.timing[sz.name] = entry;
    log('2', { size: sz.name, medianMs: entry.medianMs, idealSplitMs: entry.idealSplitMs, roofMs: entry.roofMs });
  } catch (e) {
    R.errors.push({ size: sz.name, error: String((e && e.stack) || e).slice(0, 800) });
    log('2-error', { size: sz.name, error: String(e && e.message || e) });
  }
}
const pass = R.errors.length === 0 && R.parity.gradCudaweb.vsTorchF32.worst <= 1e-5 && R.parity.coop20.vsTorchFp64.worst <= 1e-5;
R.pass = pass;
log('done', { pass });
await fetch(BASE + '/result', { method: 'POST', body: JSON.stringify(R) });
})().catch(async (e) => { console.log('[hetero-eval] fatal ' + String((e && e.stack) || e).slice(0, 1500)); try { await fetch(BASE + '/result', { method: 'POST', body: JSON.stringify({ fatal: String((e && e.stack) || e).slice(0, 1500) }) }); } catch (_) { /* 代理已關 */ } });
`;
const evalFile = path.join(OUT, 'hetero_eval.js');
fs.writeFileSync(evalFile, body, 'utf8');
console.log('[hetero-run] 評估檔', evalFile, '提交', commit);
if (process.argv.includes('--gen-only')) { const c = spawnSync(process.execPath, ['--check', evalFile], { encoding: 'utf8' }); console.log('[hetero-run] 評估檔語法檢查：' + (c.status === 0 ? '通過' : c.stderr)); server.close(); process.exit(c.status); }

// ---- 4. 啟動真 Electron ----
const exe = path.join(APP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
if (!fs.existsSync(exe)) { console.log('找不到 Electron：' + exe); process.exit(1); }
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-hetero-ud-'));
fs.writeFileSync(path.join(ud, 'desktop-settings.json'), '{"execEnabled":true,"execConfirmRequired":false}');
const env = Object.assign({}, process.env, { FA_DEBUG_EVAL_FILE: evalFile, FA_DISABLE_MAIN_OVERLAY: '1', FA_BROWSER_CONTROL_PORT: String(PORT + 1), FA_UPDATE_BASE: 'http://127.0.0.1:9/' });
const p = spawn(exe, [APP, '--no-sandbox', '--user-data-dir=' + ud], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let logBuf = '';
const feed = (d) => { logBuf += d; const lines = d.toString().split('\n').filter((l) => /\[hetero-/.test(l)); for (const l of lines) console.log(l.slice(0, 600)); };
p.stdout.on('data', feed); p.stderr.on('data', feed);
const killer = setTimeout(() => { console.log('[hetero-run] 逾時，結束'); finish({ timeout: true }); }, MINUTES * 60000);
done.then(async (res) => {
  clearTimeout(killer);
  try { p.kill(); } catch (_) { /* 已結束 */ }
  for (const [, w] of workers) { try { (await w).impl.close(); } catch (_) { /* 已關 */ } }
  server.close();
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) { /* 清理失敗不影響結果 */ }
  if (!res || res.timeout) fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ timeout: true, log: logBuf.slice(-4000) }, null, 2));
  console.log('[hetero-run] 結果寫到', path.join(OUT, 'result.json'));
  process.exit(0);
});
