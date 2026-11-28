(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaHeteroStep = factory(); })(typeof self !== 'undefined' ? self : this, function () {
'use strict';
// 異質訓練的一步（資料並行，協調端）。純核心：資源的實作由呼叫端注入（impl.gradient）。
//
// 一步的流程：
//   1. 依目前份額把 N 個序列切給各在線資源；全部同時提交（重疊：各資源各算各的，不互等）。
//   2. 各資源回傳「自己那份的平均梯度」（只算梯度，不更新）。協調端依序列數加權平均 → 等同整批的平均梯度。
//   3. 全域梯度範數裁剪（與 torch.nn.utils.clip_grad_norm_ 相同：coef = min(1, clip/(norm+1e-6))）。
//   4. 協調端統一做 AdamW（decoupled wd；與 torch.optim.AdamW 相同的順序與偏差修正）。
//   5. 下一步把更新後的參數分發給各資源（每次呼叫都帶上 params，各資源必須用它覆寫自己的權重）。
//   6. 資源失敗：標記離線，它的那份序列重新切給其餘在線資源重算（已算的樣本不丟、不重複計入）。
//   7. 比例自適應：每個資源的實測速率（序列數／毫秒，EMA）→ 目標份額 ∝ 速率 → 平滑、限步長、上下限。
//
//   createCoordinator({ resources, params, lr, wd, clip, betas, eps, adapt })
//     resources：hetero_resources.createResourceSet() 的結果
//     params：{ 名稱: Float64Array }（JS 佈局；初始權重）
//     adapt：{ alpha, maxStep, minShare, maxShare, beta }（缺省用 DEFAULT_ADAPT）
//   coord.step(seqs) → Promise<{ loss, gradNorm, t, n, shares, timing, failures }>
//   coord.getParams() → 目前參數（拷貝）；coord.shares() → 目前份額
//
//   adaptShares(prevShares, rates, opts) → 新份額（純函式，給測試用）

const HR = (typeof module === 'object' && module.exports) ? require('./hetero_resources.js') : (typeof self !== 'undefined' ? self : globalThis).FaHeteroResources;

const DEFAULT_ADAPT = { alpha: 0.3, maxStep: 0.1, minShare: 0.1, maxShare: 0.9, beta: 0.5 };

// 比例自適應（純函式）：目標份額 ∝ 速率；每步只走 alpha 的比例，單步位移不超過 maxStep，份額夾在 [minShare, maxShare]。
function adaptShares(prevShares, rates, opts) {
  const o = Object.assign({}, DEFAULT_ADAPT, opts || {});
  const ids = prevShares.map((s) => s.id);
  const rateSum = ids.reduce((a, id) => a + (rates[id] > 0 ? rates[id] : 0), 0);
  if (!(rateSum > 0)) return prevShares.map((s) => ({ id: s.id, share: s.share }));
  let next = prevShares.map((s) => {
    const target = rates[s.id] > 0 ? rates[s.id] / rateSum : s.share;
    let d = o.alpha * (target - s.share);
    if (d > o.maxStep) d = o.maxStep; else if (d < -o.maxStep) d = -o.maxStep;
    return { id: s.id, share: s.share + d };
  });
  // 夾上下限後重新正規化（幾輪即收斂；上下限與份額數不相容時以正規化為準）
  for (let round = 0; round < 6; round++) {
    next = next.map((s) => ({ id: s.id, share: Math.min(o.maxShare, Math.max(o.minShare, s.share)) }));
    const tot = next.reduce((a, s) => a + s.share, 0);
    next = next.map((s) => ({ id: s.id, share: s.share / tot }));
  }
  return next;
}

function createCoordinator(opts) {
  const o = Object.assign({ lr: 1e-3, wd: 0, clip: 1.0, betas: [0.9, 0.999], eps: 1e-8, adapt: null }, opts || {});
  const adapt = Object.assign({}, DEFAULT_ADAPT, o.adapt || {});
  const resources = o.resources;
  const names = Object.keys(o.params);
  const P = {}, M = {}, V = {};
  names.forEach((k) => { P[k] = Float64Array.from(o.params[k]); M[k] = new Float64Array(P[k].length); V[k] = new Float64Array(P[k].length); });
  let t = 0;
  const rates = {};           // 速率 EMA（序列數／毫秒）
  let shareMap = null;       // 目前份額（{id: share}）

  function initShares(live) {
    if (shareMap) {
      const cur = live.map((e) => ({ id: e.id, share: shareMap[e.id] > 0 ? shareMap[e.id] : 0 }));
      if (cur.some((s) => s.share > 0)) return HR.normalizeShares(cur);
    }
    const fromRates = HR.sharesFromRates(live.map((e) => ({ id: e.id, rate: e.rate })));
    return fromRates || HR.normalizeShares(live.map((e) => ({ id: e.id, share: 1 })));
  }

  function snapshotParams() { const out = {}; names.forEach((k) => { out[k] = P[k]; }); return out; }

  function validateGrads(g) {
    if (!g || typeof g !== 'object') return '缺少梯度';
    for (const k of names) {
      const v = g[k];
      if (!v || typeof v.length !== 'number') return '缺少梯度 ' + k;
      if (v.length !== P[k].length) return '梯度 ' + k + ' 長度 ' + v.length + ' 與參數 ' + P[k].length + ' 不符';
    }
    return null;
  }

  async function step(seqs) {
    if (!Array.isArray(seqs) || seqs.length === 0) throw new Error('一步至少要有 1 個序列');
    const N = seqs.length;
    const acc = {}; names.forEach((k) => { acc[k] = new Float64Array(P[k].length); });
    let lossAcc = 0, counted = 0;
    const timing = [], failures = [];
    let pending = seqs.slice();
    let rounds = 0;
    const maxRounds = resources.snapshot().length + 3;
    while (pending.length > 0) {
      if (++rounds > maxRounds) throw new Error('重新分派超過上限（資源反覆失敗）');
      const live = resources.alive();
      if (live.length === 0) throw new Error('沒有在線的訓練資源；這一步未完成（序列未丟失，可稍後重試）');
      const cur = initShares(live);
      shareMap = {}; cur.forEach((s) => { shareMap[s.id] = s.share; });
      const assign = HR.splitCounts(pending.length, cur);
      const jobs = []; let cursor = 0;
      for (const a of assign) {
        if (a.count <= 0) continue;
        jobs.push({ id: a.id, seqs: pending.slice(cursor, cursor + a.count) });
        cursor += a.count;
      }
      pending = [];
      const results = await Promise.all(jobs.map((j) => {
        const e = resources.get(j.id);
        const t0 = Date.now();
        return Promise.resolve().then(() => e.impl.gradient({ params: snapshotParams(), seqs: j.seqs }))
          .then((r) => ({ ok: true, j, r, wall: Date.now() - t0 }), (err) => ({ ok: false, j, err, wall: Date.now() - t0 }));
      }));
      for (const x of results) {
        if (x.ok) {
          // 回報的序列數必須等於實際送出的數量，否則加權會錯；梯度形狀也要對
          const bad = x.r.n !== x.j.seqs.length ? '回報序列數 ' + x.r.n + ' 與送出的 ' + x.j.seqs.length + ' 不符' : validateGrads(x.r.grads);
          if (bad) {
            failures.push({ id: x.j.id, error: bad });
            resources.markOffline(x.j.id, bad);
            pending.push(...x.j.seqs);
            continue;
          }
          const n = x.j.seqs.length;
          for (const k of names) { const g = x.r.grads[k], a = acc[k]; for (let i = 0; i < a.length; i++) a[i] += n * g[i]; }
          lossAcc += n * x.r.loss; counted += n;
          timing.push({ id: x.j.id, n, ms: typeof x.r.ms === 'number' ? x.r.ms : x.wall });
        } else {
          const msg = String(x.err && x.err.message ? x.err.message : x.err);
          failures.push({ id: x.j.id, error: msg });
          resources.markOffline(x.j.id, msg);
          pending.push(...x.j.seqs);
        }
      }
    }
    if (counted !== N) throw new Error('內部錯誤：計入序列 ' + counted + ' 與總數 ' + N + ' 不符');

    // 加權平均梯度（依序列數；每個序列權重相同）→ 裁剪 → AdamW
    let sq = 0;
    for (const k of names) { const a = acc[k]; for (let i = 0; i < a.length; i++) { a[i] /= N; sq += a[i] * a[i]; } }
    const gradNorm = Math.sqrt(sq);
    const coef = (o.clip > 0 && gradNorm > 0) ? Math.min(1, o.clip / (gradNorm + 1e-6)) : 1;
    t += 1;
    const [b1, b2] = o.betas;
    const bc1 = 1 - Math.pow(b1, t), bc2 = 1 - Math.pow(b2, t);
    for (const k of names) {
      const p = P[k], m = M[k], v = V[k], g = acc[k];
      for (let i = 0; i < p.length; i++) {
        const gi = g[i] * coef;
        p[i] *= (1 - o.lr * o.wd);
        m[i] = b1 * m[i] + (1 - b1) * gi;
        v[i] = b2 * v[i] + (1 - b2) * gi * gi;
        const denom = Math.sqrt(v[i]) / Math.sqrt(bc2) + o.eps;
        p[i] -= (o.lr / bc1) * m[i] / denom;
      }
    }

    // 速率與份額自適應（只用這一步實際有量到的資源）
    for (const tm of timing) {
      if (!(tm.ms > 0)) continue;
      const r = tm.n / tm.ms;
      rates[tm.id] = rates[tm.id] > 0 ? adapt.beta * rates[tm.id] + (1 - adapt.beta) * r : r;
    }
    if (timing.length > 0) {
      const measured = timing.filter((tm) => tm.ms > 0).map((tm) => tm.id);
      const prev = Object.keys(shareMap).map((id) => ({ id, share: shareMap[id] }));
      const ratesNow = {}; measured.forEach((id) => { ratesNow[id] = rates[id]; });
      const next = adaptShares(prev, ratesNow, adapt);
      shareMap = {}; next.forEach((s) => { shareMap[s.id] = s.share; });
    }

    return {
      loss: lossAcc / N,
      gradNorm,
      grads: acc,            // 平均後、裁剪前的梯度（供對拍；acc 在這一步之後不再被改動）
      t,
      n: N,
      shares: Object.assign({}, shareMap),
      timing,
      failures,
    };
  }

  return {
    step,
    getParams() { const out = {}; names.forEach((k) => { out[k] = Float64Array.from(P[k]); }); return out; },
    shares() { return Object.assign({}, shareMap || {}); },
    rates() { return Object.assign({}, rates); },
    steps() { return t; },
  };
}

return { createCoordinator, adaptShares, DEFAULT_ADAPT };
});
