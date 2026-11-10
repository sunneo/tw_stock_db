'use strict';
// cpu-js 後端：純 JS 處理器計算（DESIGN.TODO.offline-training-studio.md §5.2、§5.3）。
// 符號式五類（trainer／colu／uml／blockly／matrix）本來就是純 JS，只宣告這個後端；真正的訓練引擎由呼叫端用 engineFactory 注入。
// 內建的「迷你訓練器」是真的 AdamW＋PCG32＋資料游標＋規範化檢查點計算（float32），但它是縮小版的 LoRA 形狀（pred = (x·A)·B），
// 不是 Qwen3 的訓練：用途是 (1) 基準測試與一致性檢查的參考引擎、(2) 暫停／續訓與檢查點往返的模擬驗證。
const C = require('./checkpoint_core.js');
const B = require('./backend_core.js');
const BC = require('./bench_core.js');
const f = Math.fround;

const DEFAULTS = { dim: 8, rank: 2, nSamples: 16, batch: 1, lr: 0.01, betas: [0.9, 0.999], eps: 1e-8, wd: 0.01, warmup: 3, total: 200, dropout: 0.1, seed: 1234, dataSeed: 99, orderSeed: 7, seqLen: 256, evalBatch: [0, 1, 2, 3] };

function makeData(cfg) {
  const g = new C.PCG32(cfg.dataSeed, 3), w = []; for (let i = 0; i < cfg.dim; i++) w.push(g.nextNormal());
  const X = [], Y = [];
  for (let n = 0; n < cfg.nSamples; n++) { const x = []; let y = 0; for (let i = 0; i < cfg.dim; i++) { const v = f(g.nextNormal()); x.push(v); y += w[i] * v; } X.push(x); Y.push(f(y + 0.05 * g.nextNormal())); }
  const sha = C.sha256(Buffer.from(JSON.stringify({ X, Y }))); return { X, Y, sha };
}
const lrAt = (cfg, t) => cfg.warmup > 0 && t < cfg.warmup ? cfg.lr * (t + 1) / cfg.warmup : cfg.lr * Math.max(0.1, 1 - (t - cfg.warmup) / Math.max(1, cfg.total - cfg.warmup));

function createTinyEngine(userCfg) {
  const cfg = Object.assign({}, DEFAULTS, userCfg || {}), data = makeData(cfg), D = cfg.dim, R = cfg.rank;
  const rng = new C.PCG32(cfg.seed, 11);
  const A = new Float32Array(D * R).map(() => f(0.3 * rng.nextNormal())), Bm = new Float32Array(R);   // B 為零（LoRA 慣例）
  const z = (n) => new Float32Array(n);
  const st = { cfg, data, A, B: Bm, m: { A: z(D * R), B: z(R) }, v: { A: z(D * R), B: z(R) }, step: 0, cursor: C.createCursor(cfg.orderSeed), rng, lossTail: [], disposed: false };
  return st;
}
function forward(st, xs, drop) {         // 回傳 pred 與中間量
  const D = st.cfg.dim, R = st.cfg.rank, h = new Float32Array(R);
  for (let j = 0; j < R; j++) { let s = 0; for (let i = 0; i < D; i++) if (i !== drop) s = f(s + f(xs[i] * st.A[i * R + j])); h[j] = s; }
  let p = 0; for (let j = 0; j < R; j++) p = f(p + f(h[j] * st.B[j])); return { p, h };
}
function lossOver(st, idx) { let s = 0; idx.forEach((k) => { const e = forward(st, st.data.X[k], -1).p - st.data.Y[k]; s += e * e; }); return f(s / idx.length); }
function tinyStep(st, batch) {
  const cfg = st.cfg, D = cfg.dim, R = cfg.rank; let idx = batch && batch.indices;
  if (!idx) { const r = C.nextIndices(st.cursor, cfg.nSamples, cfg.batch); idx = r.indices; st.cursor = r.cursor; }
  st.cursor.consumed_tokens += cfg.seqLen * idx.length;
  const drop = st.rng.nextFloat() < cfg.dropout ? st.rng.nextBelow(D) : -1;      // 亂數狀態會影響結果：續訓若沒還原就會偏掉
  const gA = new Float32Array(D * R), gB = new Float32Array(R); let loss = 0;
  idx.forEach((k) => {
    const xs = st.data.X[k], fw = forward(st, xs, drop), e = f(fw.p - st.data.Y[k]); loss += e * e;
    for (let j = 0; j < R; j++) { gB[j] = f(gB[j] + f(2 * e * fw.h[j] / idx.length)); for (let i = 0; i < D; i++) if (i !== drop) gA[i * R + j] = f(gA[i * R + j] + f(2 * e * st.B[j] * xs[i] / idx.length)); }
  });
  loss = f(loss / idx.length);
  const t = st.step + 1, lr = lrAt(cfg, st.step), b1 = cfg.betas[0], b2 = cfg.betas[1];
  const upd = (P, G, M, V) => { for (let i = 0; i < P.length; i++) { M[i] = f(b1 * M[i] + (1 - b1) * G[i]); V[i] = f(b2 * V[i] + (1 - b2) * G[i] * G[i]); const mh = M[i] / (1 - Math.pow(b1, t)), vh = V[i] / (1 - Math.pow(b2, t)); P[i] = f(P[i] - lr * cfg.wd * P[i] - lr * mh / (Math.sqrt(vh) + cfg.eps)); } };
  let gn = 0; gA.forEach((x) => { gn += x * x; }); gB.forEach((x) => { gn += x * x; }); gn = f(Math.sqrt(gn));
  upd(st.A, gA, st.m.A, st.v.A); upd(st.B, gB, st.m.B, st.v.B);
  st.step = t; st.lossTail.push(loss); if (st.lossTail.length > 50) st.lossTail.shift();
  return { loss, gradNorm: gn };
}
function tinySave(st, produced) {
  const cfg = st.cfg, T = (name, shape, d) => [{ name, shape, data: d }];
  const evalLoss = lossOver(st, cfg.evalBatch);
  return C.makeCheckpoint({
    step: st.step, epoch: st.cursor.epoch, cursor: Object.assign({}, st.cursor), rng: st.rng.snapshot(),
    optimizer: { kind: 'adamw', lr: cfg.lr, betas: cfg.betas, eps: cfg.eps, wd: cfg.wd, step_count: st.step, schedule: { type: 'linear', warmup: cfg.warmup, total: cfg.total } },
    data_sha256: st.data.sha, compat: compatOf(cfg), loss_tail: st.lossTail.slice(), eval_check: { batch: cfg.evalBatch, loss: evalLoss },
    produced_by: Object.assign({ backend: 'cpu-js', device_fingerprint: 'js', engine_version: 'tiny-1', precision: 'float32' }, produced || {}),
    tensors: { 'lora_A.f32': T('A', [cfg.dim, cfg.rank], st.A), 'lora_B.f32': T('B', [cfg.rank, 1], st.B), 'opt_m.f32': T('A', [cfg.dim, cfg.rank], st.m.A).concat(T('B', [cfg.rank, 1], st.m.B)), 'opt_v.f32': T('A', [cfg.dim, cfg.rank], st.v.A).concat(T('B', [cfg.rank, 1], st.v.B)) },
  });
}
function compatOf(cfg) { return { base: 'tiny-lora', base_sha256: 'tiny', rank: cfg.rank, alpha: cfg.rank * 2, target_modules: ['A', 'B'], prompt_format_version: 1, tool_catalog_sha256: 'none' }; }
function tinyLoad(st, cp) {
  const v = C.verifyChecksums(cp); if (!v.ok) throw new Error('檢查點驗證失敗：' + v.bad.join('、'));
  const cc = C.checkCompat(cp.ckpt, { compat: compatOf(st.cfg), data_sha256: st.data.sha, optimizer: { kind: 'adamw' } });
  if (!cc.ok) { const e = new Error(cc.message); e.compat = cc; throw e; }
  const d = (file) => C.decodeTensors(cp.files[file]), by = (l, n) => l.find((x) => x.name === n).data;
  const a = d('lora_A.f32'), b = d('lora_B.f32'), m = d('opt_m.f32'), vv = d('opt_v.f32');
  st.A.set(by(a, 'A')); st.B.set(by(b, 'B')); st.m.A.set(by(m, 'A')); st.m.B.set(by(m, 'B')); st.v.A.set(by(vv, 'A')); st.v.B.set(by(vv, 'B'));
  st.step = cp.ckpt.step; st.cursor = Object.assign({}, cp.ckpt.cursor); st.rng = C.PCG32.fromSnapshot(cp.ckpt.rng); st.lossTail = (cp.ckpt.loss_tail || []).slice();
}

// engineFactory：符號式五類的真引擎由此注入，需提供 { step(batch), evalLoss(batch), save(), load(cp), dispose() }；預設為迷你訓練器
function createCpuJsBackend(o) {
  o = o || {};
  const b = {
    id: 'cpu-js', capabilities: { perStep: true, run: false, fp16: false }, kinds: B.KIND_BACKENDS,
    async probe(ctx) {
      const hw = (ctx && ctx.hw) || {};
      return B.probeResult(true, '', { name: 'JavaScript 處理器計算', vendor: 'js', fp16: false }, { backend: 'cpu-js', cpu: hw.cpuModel || null, cores: hw.cores || null, engine_version: o.engineFactory ? 'injected' : 'tiny-1' });
    },
    async benchmark(cfg, opts) {
      const c = Object.assign({}, cfg, { makeBatch: (i) => ({ indices: [i % ((cfg && cfg.nSamples) || DEFAULTS.nSamples)] }) });
      return BC.stepBenchmark(b, c, Object.assign({}, opts, { isReference: !(opts && opts.reference) && !(opts && opts.fp16), tokensPerStep: (cfg && cfg.seqLen) || DEFAULTS.seqLen }));
    },
    async init(assetState, cfg) {
      const st = o.engineFactory ? o.engineFactory(cfg) : createTinyEngine(cfg);
      if (assetState && assetState.ckpt) { if (o.engineFactory) await st.load(assetState); else tinyLoad(st, assetState); }
      return st;
    },
    async step(h, batch) { if (h.disposed) throw new Error('handle 已釋放'); return o.engineFactory ? h.step(batch) : tinyStep(h, batch); },
    async evalLoss(h, batch) { if (o.engineFactory) return h.evalLoss(batch); return { loss: lossOver(h, (batch && batch.indices) || h.cfg.evalBatch) }; },
    async saveCheckpoint(h) { return o.engineFactory ? h.save() : tinySave(h, o.produced); },
    async loadCheckpoint(h, cp) { if (o.engineFactory) return h.load(cp); tinyLoad(h, cp); },
    async dispose(h) { h.disposed = true; if (o.engineFactory && h.dispose) await h.dispose(); },
    peakMemBytes() { return process.memoryUsage ? process.memoryUsage().rss : 0; },
  };
  return b;
}

module.exports = { createCpuJsBackend, createTinyEngine, tinyStep, tinySave, tinyLoad, lossOver, DEFAULTS, compatOf };
