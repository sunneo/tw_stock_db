// node renderer/src/studio/model_eval_core.test.js —— 模型評測（LoRA 與基底並排）：目標判斷、留出組不外露、退步判定、格式率、延遲、把關
const E = require('./model_eval_core.js');
let ok = 0, bad = 0; const check = (n, c, d) => { if (c) ok++; else { bad++; console.log('FAIL ' + n, d === undefined ? '' : JSON.stringify(d).slice(0, 300)); } };
const B = { kind: 'lora', id: 'base' }, C = { kind: 'lora', id: 'adp' };
const run = (target, groups) => ({ target, ranAt: 1, groups });
// 基底與模型（每組 n=25 才會判斷）
const base = run({ kind: 'base', id: 'base' }, [
  { group: 'toolcall/格式', heldout: false, n: 25, pass: 10, formatN: 25, formatPass: 12, latencyMs: 800, detail: { q: '題目原文' } },
  { group: 'plan_check', heldout: true, n: 25, pass: 13, latencyMs: 1200, detail: { q: 'heldout 題目' } },
  { group: 'reading/引用', heldout: false, n: 10, pass: 4, latencyMs: 900 },
]);
const cand = run(C, [
  { group: 'toolcall/格式', heldout: false, n: 25, pass: 20, formatN: 25, formatPass: 24, latencyMs: 1000, detail: { q: 'x' } },
  { group: 'plan_check', heldout: true, n: 25, pass: 11, latencyMs: 1500, detail: { q: 'y' } },
  { group: 'reading/引用', heldout: false, n: 10, pass: 3, latencyMs: 1100 },
]);
// 目標判斷
check('LoRA 目標可評測', E.planTarget({ kind: 'lora', id: 'a' }).ok === true);
check('完整模型目前不可評測，原因寫明待 fp32 轉 ONNX', (() => { const p = E.planTarget({ kind: 'full', id: 'm' }); return !p.ok && /fp32 轉 ONNX/.test(p.reason); })());
check('沒選模型、不認得的種類都會回原因', !E.planTarget({ kind: 'lora', id: '' }).ok && !E.planTarget({ kind: 'zzz', id: 'x' }).ok);
// 留出組不外露
const pv = E.publicView(cand);
check('留出組不含題目與輸出（detail）', pv.groups.filter((g) => g.heldout).every((g) => !('detail' in g)));
check('非留出組的 detail 保留（可以顯示）', pv.groups.filter((g) => !g.heldout).every((g) => 'detail' in g));
check('publicView 不改原物件', cand.groups[1].detail && cand.groups[1].detail.q === 'y');
// 比較
const r = E.compare(base, cand);
const row = (name) => r.rows.find((x) => x.group === name);
check('進步：toolcall 格式 0.40→0.80（+0.40）', row('toolcall/格式').status === '進步' && row('toolcall/格式').delta === 0.4, row('toolcall/格式'));
check('退步：plan_check 0.52→0.44（−0.08）且 n=25 ≥ 20 → 列入退步名單', row('plan_check').regressed === true && r.regressed.some((x) => x.group === 'plan_check'), r.regressed);
check('題數不足（n=10）只報告，不算退步', row('reading/引用').judged === false && row('reading/引用').regressed === false && /只報告/.test(row('reading/引用').status));
check('把關：有退步就不通過，原因列出組名與差值', r.gate.ok === false && /plan_check/.test(r.gate.reason), r.gate);
check('格式率：基底 12／25、模型 24／25', r.format.base.pass === 12 && r.format.cand.pass === 24 && r.format.cand.n === 25);
check('答對率（不含無法評測的組）總計', r.accuracy.base.n === 60 && r.accuracy.cand.pass === 34, r.accuracy);
check('延遲：中位數', r.latency.base.medianMs === 900 && r.latency.cand.medianMs === 1100, r.latency);
// 把關通過：沒有退步、至少一組有判斷
const good = E.compare(base, run(C, [
  { group: 'toolcall/格式', heldout: false, n: 25, pass: 20, latencyMs: 1000 },
  { group: 'plan_check', heldout: true, n: 25, pass: 13, latencyMs: 1500 },
  { group: 'reading/引用', heldout: false, n: 10, pass: 2 },
]));
check('沒有退步、有判斷的組 → 把關通過', good.gate.ok === true && good.regressed.length === 0, good.gate);
// 全部題數不足 → 無法判定（不算通過）
const small = E.compare(run(B, [{ group: 'x', n: 5, pass: 3 }]), run(C, [{ group: 'x', n: 5, pass: 5 }]));
check('全部題數不足：把關不通過，寫無法判定', small.gate.ok === false && /無法判定/.test(small.gate.reason) && small.notes.length > 0);
// 沒跑成的組
const partial = E.compare(base, run(C, [{ group: 'plan_check', heldout: true, n: 25, pass: 13, unavailable: '沒有判題器' }]));
check('沒跑成的組標「沒跑」，不算退步', partial.rows.find((x) => x.group === 'toolcall/格式').status === '沒跑' && partial.regressed.length === 0 && partial.notes.some((t) => /沒跑成/.test(t)));
console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
