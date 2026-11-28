'use strict';
// 異質訓練一步（hetero_step.js）的純邏輯測試：假資源（梯度為已知函式）。用法：node renderer/src/studio/hetero_step.test.js
// 涵蓋：加權平均＝整批平均、裁剪、AdamW 數值、參數分發、資源失敗重新分派（不丟不重算）、全部失敗丟錯、比例自適應（移動、不震盪）。
const R = require('./hetero_resources.js');
const S = require('./hetero_step.js');

let ok = 0, bad = 0;
const check = (name, c, d) => { if (c) { ok++; console.log('ok   ' + name); } else { bad++; console.log('FAIL ' + name + (d === undefined ? '' : ' ' + JSON.stringify(d).slice(0, 400))); } };
const maxRel = (a, b) => { let m = 0, s = 0; for (let i = 0; i < b.length; i++) s = Math.max(s, Math.abs(b[i])); for (let i = 0; i < b.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return s > 0 ? m / s : m; };

// 假梯度：每個序列貢獻一個與參數相關的向量；資源回傳「自己那份的平均」（與真資源相同語意）
const NAMES = ['w', 'b'];
const LEN = { w: 6, b: 3 };
function seqGrad(seq, params) {
  const g = {};
  g.w = new Float64Array(LEN.w); g.b = new Float64Array(LEN.b);
  for (let i = 0; i < LEN.w; i++) g.w[i] = Math.sin(seq[0] * 0.7 + i) * 0.3 + params.w[i] * 0.2 + seq[1] * 0.01;
  for (let i = 0; i < LEN.b; i++) g.b[i] = Math.cos(seq[1] * 0.3 + i) * 0.4 - params.b[i] * 0.1;
  return { g, loss: 1 + seq[0] * 0.05 + params.w[0] * 0.01 };
}
function meanGrad(seqs, params) {
  const acc = { w: new Float64Array(LEN.w), b: new Float64Array(LEN.b) }; let loss = 0;
  for (const s of seqs) { const r = seqGrad(s, params); for (const k of NAMES) for (let i = 0; i < LEN[k]; i++) acc[k][i] += r.g[k][i] / seqs.length; loss += r.loss / seqs.length; }
  return { grads: acc, loss, n: seqs.length };
}
// 假資源：ms = n × cost（可在測試中改 cost）；可設定在第 failAt 次呼叫時丟錯
function fakeRes(opts) {
  const o = Object.assign({ cost: 1, failAt: -1, log: [] }, opts || {});
  let calls = 0;
  return {
    o,
    impl: {
      gradient: async ({ params, seqs }) => {
        calls++;
        const copy = {}; for (const k of Object.keys(params)) copy[k] = Float64Array.from(params[k]);
        o.log.push({ params: copy, n: seqs.length });
        if (o.failAt === calls) throw new Error('模擬失敗：裝置遺失');
        const r = meanGrad(seqs, params);
        return { loss: r.loss, n: r.n, grads: r.grads, ms: seqs.length * o.cost };
      },
    },
  };
}
function initParams() { return { w: Float64Array.from([0.1, -0.2, 0.3, 0.05, -0.4, 0.25]), b: Float64Array.from([0.02, -0.01, 0.07]) }; }
function batch(n, off) { const out = []; for (let i = 0; i < n; i++) out.push([(i + off) % 11, (i * 3 + off) % 7]); return out; }
function runSingleStep(params, seqs, opt) {
  const r = meanGrad(seqs, params);
  // 與 hetero_step 相同的 AdamW（t=1）與裁剪，用於對照
  let sq = 0; for (const k of NAMES) for (let i = 0; i < LEN[k]; i++) sq += r.grads[k][i] ** 2;
  const norm = Math.sqrt(sq); const coef = Math.min(1, opt.clip / (norm + 1e-6));
  const out = {};
  for (const k of NAMES) out[k] = Float64Array.from(params[k]);
  for (const k of NAMES) for (let i = 0; i < LEN[k]; i++) {
    const g = r.grads[k][i] * coef; out[k][i] *= (1 - opt.lr * opt.wd);
    const m = (1 - 0.9) * g, v = (1 - 0.999) * g * g;
    const mh = m / (1 - 0.9), vh = v / (1 - 0.999);
    out[k][i] -= opt.lr * mh / (Math.sqrt(vh) + opt.eps);
  }
  return out;
}

// 1. 兩個資源切分一步 ＝ 單一資源整批一步（數值，fp64）
(async () => {
  const opt = { lr: 0.05, wd: 0.01, clip: 1.0, eps: 1e-8 };
  const seqs = batch(8, 3);
  const set = R.createResourceSet();
  const a = fakeRes({ cost: 1 }), b = fakeRes({ cost: 2 });
  set.add({ id: 'A', kind: 'cpu-py', rate: 1, impl: a.impl });
  set.add({ id: 'B', kind: 'cudaweb', rate: 1, impl: b.impl });
  const coord = S.createCoordinator({ resources: set, params: initParams(), lr: opt.lr, wd: opt.wd, clip: opt.clip, eps: opt.eps });
  const res = await coord.step(seqs);
  check('兩資源各分到 4 個序列（1:1）', a.o.log[0].n === 4 && b.o.log[0].n === 4, [a.o.log, b.o.log]);
  check('一步回報序列總數 8、計入 8', res.n === 8 && res.timing.reduce((s, x) => s + x.n, 0) === 8);
  const want = runSingleStep(initParams(), seqs, opt);
  const got = coord.getParams();
  const e = Math.max(maxRel(got.w, want.w), maxRel(got.b, want.b));
  check('兩資源一步後參數 ＝ 單資源整批一步（相對誤差 < 1e-12）', e < 1e-12, { e });

  // 2. 參數分發：每次呼叫帶的參數等於協調端目前參數
  const set2 = R.createResourceSet();
  const c = fakeRes(); set2.add({ id: 'C', kind: 'remote', impl: c.impl });
  const coord2 = S.createCoordinator({ resources: set2, params: initParams(), lr: 0.05, wd: 0, clip: 1, eps: 1e-8 });
  await coord2.step(batch(4, 0));
  const p1 = coord2.getParams();
  await coord2.step(batch(4, 5));
  const sent = c.o.log[1].params;
  check('第二步分發的參數 ＝ 第一步更新後的參數', maxRel(sent.w, p1.w) === 0 && maxRel(sent.b, p1.b) === 0);

  // 3. 單資源 20 步 ＝ 兩資源 20 步（同一批次序列，數值一致；容許值與依據見 DESIGN 補充節）
  const runN = async (ids) => {
    const st = R.createResourceSet();
    ids.forEach((id) => st.add({ id, kind: 'remote', rate: 1, impl: fakeRes().impl }));
    const cc = S.createCoordinator({ resources: st, params: initParams(), lr: 0.02, wd: 0.01, clip: 0.5, eps: 1e-8 });
    for (let s = 0; s < 20; s++) await cc.step(batch(6, s * 2));
    return cc.getParams();
  };
  const p1r = await runN(['only']);
  const p2r = await runN(['x', 'y']);
  check('20 步：兩資源 vs 單資源，相對誤差 < 1e-12（fake 梯度，fp64）', Math.max(maxRel(p1r.w, p2r.w), maxRel(p1r.b, p2r.b)) < 1e-12);

  // 4. 資源失敗：該資源的序列由其餘資源重算，結果與無失敗時完全相同；失敗資源被標記離線
  const set4 = R.createResourceSet();
  const f1 = fakeRes({ failAt: 2 }), f2 = fakeRes();
  set4.add({ id: 'F1', kind: 'cpu-py', rate: 1, impl: f1.impl });
  set4.add({ id: 'F2', kind: 'cudaweb', rate: 1, impl: f2.impl });
  const withFail = S.createCoordinator({ resources: set4, params: initParams(), lr: 0.02, wd: 0.01, clip: 0.5, eps: 1e-8 });
  const ref = R.createResourceSet();
  ref.add({ id: 'R1', kind: 'remote', rate: 1, impl: fakeRes().impl });
  ref.add({ id: 'R2', kind: 'remote', rate: 1, impl: fakeRes().impl });
  const noFail = S.createCoordinator({ resources: ref, params: initParams(), lr: 0.02, wd: 0.01, clip: 0.5, eps: 1e-8 });
  let failSeen = null;
  for (let s = 0; s < 3; s++) {
    const sq = batch(6, s * 2);
    const r1 = await withFail.step(sq);
    if (r1.failures.length) failSeen = r1.failures;
    await noFail.step(sq);
  }
  check('失敗的資源被記錄（F1 第 2 次呼叫丟錯）', failSeen && failSeen.length === 1 && failSeen[0].id === 'F1', failSeen);
  check('失敗後 F1 離線、其餘在線', set4.get('F1').online === false && set4.get('F2').online === true);
  const pf = withFail.getParams(), pn = noFail.getParams();
  check('有失敗的 3 步 ＝ 無失敗的 3 步（序列未丟失、未重複計入）', Math.max(maxRel(pf.w, pn.w), maxRel(pf.b, pn.b)) < 1e-12, { e: Math.max(maxRel(pf.w, pn.w), maxRel(pf.b, pn.b)) });

  // 5. 全部資源失敗 → 丟錯（不回傳半成品）
  const set5 = R.createResourceSet();
  set5.add({ id: 'Z', kind: 'remote', rate: 1, impl: fakeRes({ failAt: 1 }).impl });
  const c5 = S.createCoordinator({ resources: set5, params: initParams(), lr: 0.02, wd: 0, clip: 1, eps: 1e-8 });
  let threw = false; try { await c5.step(batch(4, 0)); } catch (e) { threw = /沒有在線/.test(e.message); }
  check('唯一資源失敗 → 丟出「沒有在線」錯誤', threw);

  // 6. 梯度形狀不符 → 視為該資源失敗並重新分派
  const set6 = R.createResourceSet();
  set6.add({ id: 'good', kind: 'remote', rate: 1, impl: fakeRes().impl });
  set6.add({ id: 'shape', kind: 'remote', rate: 1, impl: { gradient: async ({ seqs }) => ({ loss: 0, n: seqs.length, grads: { w: new Float64Array(2), b: new Float64Array(3) }, ms: 1 }) } });
  const c6 = S.createCoordinator({ resources: set6, params: initParams(), lr: 0.02, wd: 0, clip: 1, eps: 1e-8 });
  const r6 = await c6.step(batch(4, 0));
  check('梯度長度不符的資源被離線、序列由好的資源補算', r6.failures.length === 1 && r6.failures[0].id === 'shape' && r6.n === 4, r6.failures);

  // 7. 比例自適應：純函式的具體數值與位移上限
  const nx = S.adaptShares([{ id: 'a', share: 0.5 }, { id: 'b', share: 0.5 }], { a: 1, b: 3 }, {});
  check('adaptShares：速率 1:3、份額 0.5/0.5 → a 往 0.25 走 α×差 = 0.425', Math.abs(nx[0].share - 0.425) < 1e-12 && Math.abs(nx[1].share - 0.575) < 1e-12, nx);
  const big = S.adaptShares([{ id: 'a', share: 0.5 }, { id: 'b', share: 0.5 }], { a: 1, b: 1000 }, { maxStep: 0.05 });
  check('adaptShares：單步位移不超過 maxStep', Math.abs(big[0].share - 0.5) <= 0.05 + 1e-12, big);

  // 8. 比例自適應：模擬一邊變慢（B 的成本 ×3）→ 份額移動、不震盪，變回來也會回去
  const set8 = R.createResourceSet();
  const A8 = fakeRes({ cost: 1 }), B8 = fakeRes({ cost: 1 });
  set8.add({ id: 'A', kind: 'cpu-py', impl: A8.impl });
  set8.add({ id: 'B', kind: 'cudaweb', impl: B8.impl });
  const c8 = S.createCoordinator({ resources: set8, params: initParams(), lr: 0.001, wd: 0, clip: 1, eps: 1e-8 });
  const trace = [];
  for (let s = 0; s < 40; s++) { const r = await c8.step(batch(16, s)); trace.push(r.shares.B); }
  check('同速時 B 份額收斂到 0.5（±0.02）', Math.abs(trace[39] - 0.5) < 0.02, trace[39]);
  B8.o.cost = 3;
  for (let s = 40; s < 90; s++) { const r = await c8.step(batch(16, s)); trace.push(r.shares.B); }
  check('B 變慢 3 倍後，B 份額下降到 0.25 附近（±0.03）', Math.abs(trace[89] - 0.25) < 0.03, trace[89]);
  const seg = trace.slice(40);
  let flips = 0, lastSign = 0;
  for (let i = 1; i < seg.length; i++) {
    const d = seg[i] - seg[i - 1];
    if (Math.abs(d) < 1e-9) continue;
    const sg = d > 0 ? 1 : -1;
    if (lastSign !== 0 && sg !== lastSign && Math.abs(seg[i] - 0.25) > 0.02) flips++;
    lastSign = sg;
  }
  check('變慢後的移動單調（未逼近目標前的方向反轉為 0）', flips === 0, { flips, seg: seg.slice(0, 12) });
  check('單步位移不超過 maxStep（0.1）', trace.every((x, i) => i === 0 || Math.abs(x - trace[i - 1]) <= 0.1 + 1e-9));
  B8.o.cost = 1;
  for (let s = 90; s < 150; s++) { const r = await c8.step(batch(16, s)); trace.push(r.shares.B); }
  check('B 恢復後，份額回到 0.5 附近（±0.03）', Math.abs(trace[149] - 0.5) < 0.03, trace[149]);

  console.log('\n' + ok + ' passed, ' + bad + ' failed');
  if (bad) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
