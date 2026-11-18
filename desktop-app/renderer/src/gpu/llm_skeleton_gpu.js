/* llm_skeleton_gpu.js — 通用解碼骨架的 GPU 版（O12b）。結構與 llm_skeleton.js 的 step 相同，只有投影（matvec，y = W·x）改成非同步、
 * 由呼叫端注入（真桌面版用既有的 gemv 核心；node 測試用 CPU 替身）。RMSNorm、RoPE、注意力留在 CPU（逐元素、很小），與參考實作共用同一份程式。
 * 驗證：node 測試以 CPU 替身的 matvec 對拍 llm_skeleton.run，必須逐位相同；真 GPU 的對拍在桌面版評估做。
 * UMD：node 用 module.exports；瀏覽器掛在 self.FaLlmSkeletonGpu。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./llm_skeleton.js')); }
  else { root.FaLlmSkeletonGpu = factory(root.FaLlmSkeleton); }
}(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';

  // mv(W, rows, cols, x) → Promise<Float32Array>（y = W·x，W 為 [rows][cols] row-major）
  async function stepGpu(state, token, mv) {
    const a = state.arch, w = state.w, hd = state.hd, H = a.hidden, nh = a.heads, nkv = a.kvHeads;
    // GPU 版還沒有偏置的路徑；有偏置就直接丟錯，不能悄悄少加偏置算出錯的結果
    if (a.bias) throw new Error('llm_skeleton_gpu：偏置（bias）尚未在 GPU 版實作');
    if (!(token >= 0 && token < a.vocab) || token !== Math.floor(token)) throw new Error('llm_skeleton_gpu：詞元超出詞表（' + token + '）');
    const pos = state.pos;
    let x = Float32Array.from(w.embed.subarray(token * H, token * H + H));
    for (let li = 0; li < a.layers; li++) {
      const L = w.layers[li];
      const h = S.rmsnorm(x, L.attnNorm, a.eps);
      let q = await mv(L.wq, nh * hd, H, h);
      let k = await mv(L.wk, nkv * hd, H, h);
      const v = await mv(L.wv, nkv * hd, H, h);
      if (a.qkNorm) {
        const perHead = (vec, n, wn) => { const o = new Float32Array(vec.length); for (let hh = 0; hh < n; hh++) o.set(S.rmsnorm(vec.subarray(hh * hd, hh * hd + hd), wn, a.eps), hh * hd); return o; };
        q = perHead(q, nh, L.qNorm); k = perHead(k, nkv, L.kNorm);
      }
      q = S.rope(q, nh, hd, pos, a.rope.base, a.rope.scaling);
      k = S.rope(k, nkv, hd, pos, a.rope.base, a.rope.scaling);
      state.cacheK[li].push(k); state.cacheV[li].push(v);
      const T = state.cacheK[li].length;
      const attnOut = new Float32Array(nh * hd);
      const scale = 1 / Math.sqrt(hd);
      for (let qh = 0; qh < nh; qh++) {
        const kh = S.kvHeadOf(qh, nh, nkv);
        const qv = q.subarray(qh * hd, qh * hd + hd);
        const scores = [];
        for (let t = 0; t < T; t++) {
          const kt = state.cacheK[li][t].subarray(kh * hd, kh * hd + hd);
          let s = 0; for (let i = 0; i < hd; i++) s += qv[i] * kt[i];
          scores.push(s * scale);
        }
        const p = S.softmax(scores);
        for (let t = 0; t < T; t++) {
          const vt = state.cacheV[li][t].subarray(kh * hd, kh * hd + hd);
          for (let i = 0; i < hd; i++) attnOut[qh * hd + i] += p[t] * vt[i];
        }
      }
      const o = await mv(L.wo, H, nh * hd, attnOut);
      for (let i = 0; i < H; i++) x[i] += o[i];
      const h2 = S.rmsnorm(x, L.ffnNorm, a.eps);
      const g = await mv(L.wGate, a.ffn, H, h2), u = await mv(L.wUp, a.ffn, H, h2);
      const act = new Float32Array(a.ffn);
      for (let i = 0; i < a.ffn; i++) act[i] = S.silu(g[i]) * u[i];
      const d = await mv(L.wDown, H, a.ffn, act);
      for (let i = 0; i < H; i++) x[i] += d[i];
    }
    const n = S.rmsnorm(x, w.finalNorm, a.eps);
    const head = a.tiedEmbeddings ? w.embed : w.lmHead;
    if (!head) throw new Error('llm_skeleton_gpu：沒有 lm_head');
    const logits = await mv(head, a.vocab, H, n);
    state.pos = pos + 1;
    return logits;
  }

  // 整段 prefix；狀態與權重檢查沿用 llm_skeleton（createState 會驗證描述表與權重長度）。useOverrides:false：GPU 版不吃 CPU 的覆寫槽。
  async function runGpu(arch, weights, tokens, mv) {
    if (arch.bias) throw new Error('llm_skeleton_gpu：偏置（bias）尚未在 GPU 版實作');
    const st = S.createState(arch, weights, { useOverrides: false });
    let logits = null;
    for (const t of tokens) logits = await stepGpu(st, t, mv);
    let best = 0; for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
    return { logits: logits, argmax: best, state: st };
  }

  // ---------- 完整 GPU 解碼（O12b）：整個解碼步驟在 GPU 上，一個 command encoder、一次 submit ----------
  // 運算順序與 llm_skeleton.stepVec 相同：RMSNorm → 投影（f32 矩陣乘，權重 [out][in] row-major）→ [qk-norm] → RoPE（llama3 縮放的表由 S.invFreq 算）
  // → KV 寫入 → 注意力（GQA）→ 輸出投影 → 殘差 → RMSNorm → gate／up → SiLU×up → down → 殘差 → 最後 RMSNorm → lm_head → logits。
  // 參考實作的權重是 f32，沒有動態量化，所以這裡也不量化（O12b 清單中的「動態量化」只適用 q8 權重，見 qwen_gpu）。
  // 精度：GPU 的加總是 f32、順序與 CPU（f64 累加）不同，所以對拍是「界內」而非逐位相同。
  const SK_UNI = 'struct P { a: u32, b: u32, c: u32, d: u32, e: f32, f: u32, g: u32, h: u32 }\n';
  const SK_WGSL = {};
  // y[outOff + r] = Σ_c W[r·cols + c]·x[c]；一個執行緒一列
  SK_WGSL.mv = SK_UNI + `
@group(0) @binding(0) var<storage, read> W: array<f32>;
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;
  if (r >= p.a) { return; }
  var s: f32 = 0.0;
  let o = r * p.b;
  for (var c: u32 = 0u; c < p.b; c = c + 1u) { s = s + W[o + c] * x[c]; }
  y[p.c + r] = s;
}`;
  // 每列 RMSNorm：a＝列數，b＝維度，e＝eps；一個執行緒一列（也用於 qk-norm 的每頭正規化）
  SK_WGSL.rms = SK_UNI + `
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> g: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;
  if (r >= p.a) { return; }
  let base = r * p.b;
  var ss: f32 = 0.0;
  for (var i: u32 = 0u; i < p.b; i = i + 1u) { let v = x[base + i]; ss = ss + v * v; }
  let inv = 1.0 / sqrt(ss / f32(p.b) + p.e);
  for (var i: u32 = 0u; i < p.b; i = i + 1u) { y[base + i] = x[base + i] * inv * g[i]; }
}`;
  // RoPE（half 風格）：a＝頭數，b＝hd，c＝位置（取 cos／sin 表的列），d＝輸出偏移（元素數）。一個執行緒一組 (頭, i)。
  SK_WGSL.rope = SK_UNI + `
@group(0) @binding(0) var<storage, read> vin: array<f32>;
@group(0) @binding(1) var<storage, read> cs: array<f32>;
@group(0) @binding(2) var<storage, read> sn: array<f32>;
@group(0) @binding(3) var<storage, read_write> out: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let half = p.b / 2u;
  let idx = gid.x;
  if (idx >= p.a * half) { return; }
  let h = idx / half; let i = idx % half;
  let base = h * p.b;
  let a = vin[base + i]; let b = vin[base + i + half];
  let c = cs[p.c * half + i]; let s = sn[p.c * half + i];
  out[p.d + base + i] = a * c - b * s;
  out[p.d + base + i + half] = b * c + a * s;
}`;
  // 注意力（GQA，因果）：a＝Q 頭數，b＝KV 頭數，c＝hd，d＝有效長度 T（=位置+1），e＝scale，f＝maxT。一個執行緒一個 Q 頭。
  SK_WGSL.attn = SK_UNI + `
@group(0) @binding(0) var<storage, read> q: array<f32>;
@group(0) @binding(1) var<storage, read> kc: array<f32>;
@group(0) @binding(2) var<storage, read> vc: array<f32>;
@group(0) @binding(3) var<storage, read_write> sc: array<f32>;
@group(0) @binding(4) var<storage, read_write> out: array<f32>;
@group(0) @binding(5) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let qh = gid.x;
  if (qh >= p.a) { return; }
  let hd = p.c; let Nk = p.b * hd; let kvh = qh / (p.a / p.b);
  let T = p.d; let maxT = p.f;
  let qo = qh * hd; let ko = kvh * hd; let sb = qh * maxT;
  var mx: f32 = -3.0e38;
  for (var t: u32 = 0u; t < T; t = t + 1u) {
    var dot: f32 = 0.0;
    for (var d: u32 = 0u; d < hd; d = d + 1u) { dot = dot + q[qo + d] * kc[t * Nk + ko + d]; }
    let w = dot * p.e; sc[sb + t] = w; mx = max(mx, w);
  }
  var sum: f32 = 0.0;
  for (var t: u32 = 0u; t < T; t = t + 1u) { let e = exp(sc[sb + t] - mx); sc[sb + t] = e; sum = sum + e; }
  for (var d: u32 = 0u; d < hd; d = d + 1u) { out[qo + d] = 0.0; }
  for (var t: u32 = 0u; t < T; t = t + 1u) {
    let pj = sc[sb + t] / sum;
    for (var d: u32 = 0u; d < hd; d = d + 1u) { out[qo + d] = out[qo + d] + pj * vc[t * Nk + ko + d]; }
  }
}`;
  // x[i] += y[i]（就地；每個執行緒只碰自己的 i）：a＝n
  SK_WGSL.addk = SK_UNI + `
@group(0) @binding(0) var<storage, read_write> x: array<f32>;
@group(0) @binding(1) var<storage, read> y: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= p.a) { return; }
  x[i] = x[i] + y[i];
}`;
  // act[i] = silu(g[i])·u[i]：a＝n
  SK_WGSL.silu = SK_UNI + `
@group(0) @binding(0) var<storage, read> g: array<f32>;
@group(0) @binding(1) var<storage, read> u: array<f32>;
@group(0) @binding(2) var<storage, read_write> act: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= p.a) { return; }
  let v = g[i];
  act[i] = (v / (1.0 + exp(-v))) * u[i];
}`;

  // dev：GPUDevice；arch／weights：與 llm_skeleton 相同；opts.maxT（預設 64）。回傳 { step(token) → Promise<Float32Array logits>, reset(), pos(), destroy() }。
  function createGpuDecoder(dev, arch, weights, opts) {
    const o = opts || {};
    if (arch.bias) throw new Error('llm_skeleton_gpu：偏置（bias）尚未在 GPU 版實作');
    const st0 = S.createState(arch, weights, { useOverrides: false });   // 驗證描述表與權重長度（與 CPU 參考共用）
    const hd = st0.hd, H = arch.hidden, nh = arch.heads, nkv = arch.kvHeads, F = arch.ffn, V = arch.vocab, L = arch.layers;
    const half = hd / 2, Nq = nh * hd, Nk = nkv * hd, maxT = o.maxT || 64, eps = arch.eps;
    const ST = 0x80 | 0x08 | 0x04, UNI = 0x40 | 0x08;   // STORAGE｜COPY_DST｜COPY_SRC；UNIFORM｜COPY_DST
    const bufs = [];
    const mkBuf = (n, usage) => { const b = dev.createBuffer({ size: Math.max(16, (n + 3) & ~3), usage: usage }); bufs.push(b); return b; };
    const f32buf = (arr) => { const b = mkBuf(arr.length * 4, ST); dev.queue.writeBuffer(b, 0, arr); return b; };
    const pipes = {};
    for (const k of Object.keys(SK_WGSL)) {
      const mod = dev.createShaderModule({ code: SK_WGSL[k] });
      pipes[k] = dev.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
    }
    const ops = [];   // { pipe, bg, uni, groups, fill }：fill(dv, pos) 寫 pos 相關的 uniform
    const op = (kind, list, uniFields, groups, fill) => {
      const uni = mkBuf(32, UNI);
      const dv = new DataView(new ArrayBuffer(32));
      const put = (f) => { f(dv); dev.queue.writeBuffer(uni, 0, new Uint8Array(dv.buffer)); };
      if (!fill) put(() => uniFields(dv));
      const pipe = pipes[kind];
      const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: list.concat([uni]).map((b, i) => ({ binding: i, resource: { buffer: b } })) });
      ops.push({ pipe: pipe, bg: bg, uni: uni, groups: groups, fill: fill ? (pos) => { fill(dv, pos); dev.queue.writeBuffer(uni, 0, new Uint8Array(dv.buffer)); } : null });
    };
    const u = (a, b, c, d, e, f) => (dv) => { dv.setUint32(0, a, true); dv.setUint32(4, b, true); dv.setUint32(8, c, true); dv.setUint32(12, d, true); dv.setFloat32(16, e || 0, true); dv.setUint32(20, f || 0, true); };
    const g1 = (n) => [Math.ceil(n / 64), 1, 1];
    // 權重與常數緩衝區
    const cosT = new Float32Array(maxT * half), sinT = new Float32Array(maxT * half);
    const fr = S.invFreq(hd, arch.rope.base, arch.rope.scaling);
    for (let p = 0; p < maxT; p++) for (let i = 0; i < half; i++) { const th = p * fr[i]; cosT[p * half + i] = Math.cos(th); sinT[p * half + i] = Math.sin(th); }
    const cosB = f32buf(cosT), sinB = f32buf(sinT);
    const xA = mkBuf(H * 4, ST), h1 = mkBuf(H * 4, ST), qb = mkBuf(Nq * 4, ST), kb = mkBuf(Nk * 4, ST), qn = mkBuf(Nq * 4, ST), kn = mkBuf(Nk * 4, ST);
    const qr = mkBuf(Nq * 4, ST), at = mkBuf(Nq * 4, ST), ob = mkBuf(H * 4, ST), gB = mkBuf(F * 4, ST), uB = mkBuf(F * 4, ST), aB = mkBuf(F * 4, ST), dB = mkBuf(H * 4, ST);
    const scB = mkBuf(nh * maxT * 4, ST), logits = mkBuf(V * 4, ST);
    const rb = dev.createBuffer({ size: V * 4, usage: 0x0001 | 0x08 });   // MAP_READ｜COPY_DST
    const kc = [], vc = [];
    const lw = [];
    for (let li = 0; li < L; li++) {
      const Lw = weights.layers[li];
      kc.push(mkBuf(maxT * Nk * 4, ST)); vc.push(mkBuf(maxT * Nk * 4, ST));
      lw.push({ attnNorm: f32buf(Lw.attnNorm), wq: f32buf(Lw.wq), wk: f32buf(Lw.wk), wv: f32buf(Lw.wv), wo: f32buf(Lw.wo),
        ffnNorm: f32buf(Lw.ffnNorm), wGate: f32buf(Lw.wGate), wUp: f32buf(Lw.wUp), wDown: f32buf(Lw.wDown),
        qNorm: arch.qkNorm ? f32buf(Lw.qNorm) : null, kNorm: arch.qkNorm ? f32buf(Lw.kNorm) : null });
    }
    const finalB = f32buf(weights.finalNorm), headB = f32buf(arch.tiedEmbeddings ? weights.embed : weights.lmHead);
    // 建立每步的運算序列（一次建好；pos 相關的 uniform 由 fill 每步寫入）
    for (let li = 0; li < L; li++) {
      const W = lw[li];
      op('rms', [xA, W.attnNorm, h1], u(H, H, 0, 0, eps), [Math.ceil(1 / 64), 1, 1]);   // 一列
      op('mv', [W.wq, h1, qb], u(Nq, H, 0, 0), g1(Nq));
      op('mv', [W.wk, h1, kb], u(Nk, H, 0, 0), g1(Nk));
      op('mv', [W.wv, h1, vc[li]], null, g1(Nk), (dv, pos) => { dv.setUint32(0, Nk, true); dv.setUint32(4, H, true); dv.setUint32(8, pos * Nk, true); });
      let qSrc = qb, kSrc = kb;
      if (arch.qkNorm) {
        op('rms', [qb, W.qNorm, qn], u(nh, hd, 0, 0, eps), g1(nh)); qSrc = qn;
        op('rms', [kb, W.kNorm, kn], u(nkv, hd, 0, 0, eps), g1(nkv)); kSrc = kn;
      }
      op('rope', [qSrc, cosB, sinB, qr], null, g1(nh * half), (dv, pos) => { dv.setUint32(0, nh, true); dv.setUint32(4, hd, true); dv.setUint32(8, pos, true); dv.setUint32(12, 0, true); });
      op('rope', [kSrc, cosB, sinB, kc[li]], null, g1(nkv * half), (dv, pos) => { dv.setUint32(0, nkv, true); dv.setUint32(4, hd, true); dv.setUint32(8, pos, true); dv.setUint32(12, pos * Nk, true); });
      op('attn', [qr, kc[li], vc[li], scB, at], null, g1(nh), (dv, pos) => { dv.setUint32(0, nh, true); dv.setUint32(4, nkv, true); dv.setUint32(8, hd, true); dv.setUint32(12, pos + 1, true); dv.setFloat32(16, 1 / Math.sqrt(hd), true); dv.setUint32(20, maxT, true); });
      op('mv', [W.wo, at, ob], u(H, Nq, 0, 0), g1(H));
      op('addk', [xA, ob], u(H, 0, 0, 0), g1(H));
      op('rms', [xA, W.ffnNorm, h1], u(H, H, 0, 0, eps), [1, 1, 1]);
      op('mv', [W.wGate, h1, gB], u(F, H, 0, 0), g1(F));
      op('mv', [W.wUp, h1, uB], u(F, H, 0, 0), g1(F));
      op('silu', [gB, uB, aB], u(F, 0, 0, 0), g1(F));
      op('mv', [W.wDown, aB, dB], u(H, F, 0, 0), g1(H));
      op('addk', [xA, dB], u(H, 0, 0, 0), g1(H));
    }
    op('rms', [xA, finalB, h1], u(H, H, 0, 0, eps), [1, 1, 1]);
    op('mv', [headB, h1, logits], u(V, H, 0, 0), g1(V));
    let pos = 0, dead = null, chain = Promise.resolve();
    const run = async (token) => {
      if (dead) throw new Error('llm_skeleton_gpu：解碼器已失效：' + dead);
      if (!(token >= 0 && token < V) || token !== Math.floor(token)) throw new Error('llm_skeleton_gpu：詞元超出詞表（' + token + '）');
      if (pos >= maxT) throw new Error('llm_skeleton_gpu：序列超過 maxT（' + maxT + '）');
      try {
        dev.queue.writeBuffer(xA, 0, weights.embed.subarray(token * H, token * H + H));
        for (const d of ops) if (d.fill) d.fill(pos);
        const enc = dev.createCommandEncoder();
        for (const d of ops) { const pass = enc.beginComputePass(); pass.setPipeline(d.pipe); pass.setBindGroup(0, d.bg); pass.dispatchWorkgroups(d.groups[0], d.groups[1], d.groups[2]); pass.end(); }
        enc.copyBufferToBuffer(logits, 0, rb, 0, V * 4);
        dev.queue.submit([enc.finish()]);
        await rb.mapAsync(1);
        const out = new Float32Array(rb.getMappedRange().slice(0, V * 4));
        rb.unmap();
        pos++;
        return out;
      } catch (e) { dead = String((e && e.message) || e); throw e; }
    };
    return {
      // 串行化：每次 step 等上一次完成（mapAsync 不能重疊）
      step(token) { const p = chain.then(() => run(token)); chain = p.catch(() => {}); return p; },
      reset() { pos = 0; },
      pos() { return pos; },
      get dead() { return dead; },
      destroy() { for (const b of bufs) { try { b.destroy(); } catch (e) { /* 已釋放 */ } } },
    };
  }

  return { stepGpu: stepGpu, runGpu: runGpu, createGpuDecoder: createGpuDecoder, SK_WGSL: SK_WGSL };
}));
