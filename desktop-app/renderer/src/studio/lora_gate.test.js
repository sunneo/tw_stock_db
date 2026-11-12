// node renderer/src/studio/lora_gate.test.js —— LoRA 把關（§30.3）：內建與自動選用都要有評測數字且每組不輸基底；KNOWN_EVAL（colu-r4／plan-r4）保留
const R = require('./lora_registry_core.js'), M = require('./lora_manage_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); } };
const H = (c) => c.repeat(64), MB = 1024 * 1024;
const ENV = { base: 'Qwen/Qwen3-0.6B', rank_slots: [16], prompt_format_version: 1, tool_catalog_sha256: H('a') };
const mk = (id, o) => Object.assign({ id, name: id, source: 'builtin', base: ENV.base, rank: 16, prompt_format_version: 1, tool_catalog_sha256: H('a'), domains: ['tool_routing'], location: 'fap:x/' + id, size: 40 * MB, sha256: H('b'), enabled: true, added: 1 }, o || {});
// 評測數字
const win = { groups: { g1: { adapter: 50, base: 10 }, g2: { adapter: 9, base: 7 } } };
const lose = { groups: { g1: { adapter: 50, base: 10 }, g2: { adapter: 5, base: 7 } } };
// 1. 純判斷
check('沒有評測數字 → 不通過，寫原因', (() => { const g = R.gateOf(undefined); return g.pass === false && /沒有評測數字/.test(g.reason); })());
check('全部組都贏 → 通過', R.gateOf(win).pass === true);
check('有一組輸給基底 → 不通過，列出組名', (() => { const g = R.gateOf(lose); return g.pass === false && /g2/.test(g.reason); })());
check('全部持平（沒有贏也沒有輸）→ 仍算通過（不輸基底）', R.gateOf({ groups: { g1: { adapter: 5, base: 5 } } }).pass === true);
// 2. 卡片：內建沒有數字 → 未通過把關；有數字但輸 → 未通過；齊全 → 通過
const reg = R.createRegistry({ env: ENV, budget: 256 * MB, maxActive: 4 });
reg.register(mk('bi-nodata', { source: 'builtin', eval: undefined }));
reg.register(mk('bi-lose', { source: 'builtin', eval: lose }));
reg.register(mk('bi-good', { source: 'builtin', eval: win }));
const st = reg.status(); const card = (id) => st.registered.find((x) => x.id === id);
check('內建、沒有評測 → 卡片寫未通過把關', card('bi-nodata') && card('bi-nodata').gate && card('bi-nodata').gate.pass === false);
check('內建、有組輸給基底 → 卡片寫未通過把關', card('bi-lose').gate.pass === false && /g2/.test(card('bi-lose').gate.reason));
check('內建、齊全 → 通過', card('bi-good').gate.pass === true);
// 3. 管理畫面：未通過的卡片寫「未通過把關：原因」，通過的不寫
const html1 = M.registryCardHTML ? M.registryCardHTML(M.rowsFromStatus(st)[0]) : '';
const rowsAll = M.rowsFromStatus(st);
const htmlOf = (id) => M.renderLoraManageHTML ? M.renderLoraManageHTML({ rows: rowsAll.filter((x) => x.id === id) }) : '';
check('管理畫面：未通過的卡片顯示「未通過把關」', rowsAll.filter((x) => x.id === 'bi-lose').every((x) => x.gate && x.gate.pass === false) && /未通過把關/.test(M.registryCardHTML(rowsAll.find((x) => x.id === 'bi-lose'))));
check('管理畫面：通過的卡片不顯示「未通過把關」', !/未通過把關/.test(M.registryCardHTML(rowsAll.find((x) => x.id === 'bi-good'))));
// 4. 自動選用：有數字且不輸的才會被選；沒數字或輸的跳過，原因保留原訊息
const sel = reg.select({ domain: 'tool_routing' });
check('自動選用：通過把關的會被選', sel.plan.some((e) => e.id === 'bi-good'), sel.plan.map((e) => e.id));
check('自動選用：沒有數字、輸給基底的不被選，並寫原因', !sel.plan.some((e) => e.id === 'bi-nodata' || e.id === 'bi-lose') && sel.skipped.some((x) => x.id === 'bi-nodata' && /沒有評量資料/.test(x.reason)) && sel.skipped.some((x) => x.id === 'bi-lose' && /輸給基底/.test(x.reason)), sel.skipped);
// 5. 手動指定仍可用（不被把關擋住）
const man = reg.select({ ids: ['bi-nodata'] });
check('手動指定沒有數字的 adapter 仍可選（可手動）', man.plan.some((e) => e.id === 'bi-nodata'));
// 6. KNOWN_EVAL 保留：colu-r4／plan-r4 沒有卡片數字時仍由表查到，並通過把關
const reg2 = R.createRegistry({ env: ENV, budget: 256 * MB, maxActive: 4 });
reg2.register(mk('colu-r4', { source: 'user', domains: ['colu'], eval: undefined }));
reg2.register(mk('plan-r4', { source: 'user', domains: ['plan'], eval: undefined }));
const st2 = reg2.status(); const c2 = (id) => st2.registered.find((x) => x.id === id);
check('KNOWN_EVAL：colu-r4 查得到表內評量並通過把關', c2('colu-r4').gate.pass === true && c2('colu-r4').eval && c2('colu-r4').eval.lose.length === 0);
check('KNOWN_EVAL：plan-r4 查得到表內評量並通過把關', c2('plan-r4').gate.pass === true);
check('KNOWN_EVAL：自動選用仍會選這兩顆', reg2.select({ domain: 'colu' }).plan.some((e) => e.id === 'colu-r4') && reg2.select({ domain: 'plan' }).plan.some((e) => e.id === 'plan-r4'));
console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
