// node renderer/src/recipe/code_loop_core.test.js   （假模型＋假判題器；真的判題器見 desktop-app/code-loop.test.js）
const C = require('./code_loop_core.js'); const F = require('./code_loop_fake.js'); const S = require('./think_stack.js'); const assert = require('assert');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok - ' + name); };

const PROB = { id: 'p', title: '兩數相加', statement: '輸入兩個整數，輸出和。', tests: [{ in: '1 2\n', out: '3\n' }, { in: '-5 3\n', out: '-2\n' }], hidden: [{ in: '999 12345\n', out: '13344\n' }] };
const PLAN2 = { functions: [{ name: 'add', signature: 'def add(a, b)', purpose: '回傳兩數之和', calls: [] }, { name: 'main', signature: 'def main()', purpose: '讀輸入、印結果', calls: ['add'] }] };
const GOOD = { add: ['def add(a, b):\n    return a + b\n'], main: ['import sys\ndef main():\n    a, b = map(int, sys.stdin.readline().split())\n    print(add(a, b))\n'] };
const AC = { verdict: 'AC', passed: 3, total: 3, failedIndex: -1, detail: '' };
const fakeJudge = (queue) => { const q = queue.slice(); const seen = []; const j = async (x) => { seen.push(x.source); return q.length > 1 ? q.shift() : q[0]; }; j.seen = seen; return j; };
const text = (log) => log.map((e) => e.messages.map((m) => m.content).join('\n')).join('\n=====\n');

(async () => {
  await t('extractCode：有圍欄、沒收尾的圍欄、<think>、純文字', async () => {
    assert.strictEqual(C.extractCode('說明\n```python\nx = 1\n```\n後面'), 'x = 1\n');
    assert.strictEqual(C.extractCode('```c\nint a;\n'), 'int a;\n');
    assert.strictEqual(C.extractCode('<think>想想 ```fake``` </think>\n```\ny = 2\n```'), 'y = 2\n');
    assert.strictEqual(C.extractCode('z = 3'), 'z = 3\n'); assert.strictEqual(C.extractCode({ text: '```\nq\n```' }), 'q\n');
  });
  await t('assemble：python 搬 import 並去重、拿掉模型自己寫的入口呼叫、補一次 main()', async () => {
    const s = C.assemble('python', ['import sys\ndef add(a, b):\n    return a + b\n', 'import sys\nfrom collections import deque\ndef main():\n    print(add(1, 2))\n\nif __name__ == "__main__":\n    main()\n']);
    assert.strictEqual((s.match(/import sys/g) || []).length, 1); assert.ok(s.startsWith('import sys\nfrom collections import deque\n')); assert.strictEqual((s.match(/main\(\)/g) || []).length, 2, 'def main() 與補上的一次呼叫'); assert.ok(!/__name__/.test(s)); assert.ok(s.trim().endsWith('main()'));
  });
  await t('assemble：java／csharp 包類別、c 去重 include、bash／ruby 補入口、組語原樣', async () => {
    const j = C.assemble('java', ['import java.util.*;\npublic static long add(long a, long b) { return a + b; }\n', 'import java.util.*;\npublic static void main(String[] a) { }\n']);
    assert.ok(j.startsWith('import java.util.*;\n\npublic class Main {')); assert.strictEqual((j.match(/import java/g) || []).length, 1); assert.ok(j.trim().endsWith('}'));
    assert.ok(C.assemble('csharp', ['using System;\nstatic void Main() { }\n']).indexOf('class P {') > 0);
    assert.strictEqual((C.assemble('c', ['#include <stdio.h>\nint f(void){return 1;}\n', '#include <stdio.h>\nint main(void){return f();}\n']).match(/#include/g) || []).length, 1);
    assert.ok(C.assemble('bash', ['add() { echo 1; }\n', 'main() { add; }\nmain\n']).trim().endsWith('main')); assert.strictEqual((C.assemble('bash', ['main() { :; }\nmain\n']).match(/^main$/gm) || []).length, 1);
    assert.strictEqual(C.assemble('asm-x64', ['.globl _start\n_start:\n']), '.globl _start\n_start:\n');
  });
  await t('normalizePlan：不認得的呼叫丟掉、補入口、沒人呼叫的掛到入口、被呼叫的排前面；有環／太多／空 → null', async () => {
    const p = C.normalizePlan({ functions: [{ name: 'helper', calls: ['ghost'] }, { name: 'main', calls: [] }, { name: 'orphan' }, { name: '1bad' }, { name: 'helper' }] }, 'main', 6);
    assert.deepStrictEqual(p.map((x) => x.name), ['helper', 'orphan', 'main']); assert.deepStrictEqual(p[2].calls.sort(), ['helper', 'orphan']); assert.deepStrictEqual(p[0].calls, []);
    assert.deepStrictEqual(C.normalizePlan({ functions: [{ name: 'a' }] }, 'main', 6).map((x) => x.name), ['a', 'main'], '沒有入口就補');
    assert.strictEqual(C.normalizePlan({ functions: [{ name: 'a', calls: ['b'] }, { name: 'b', calls: ['a'] }, { name: 'main', calls: ['a'] }] }, 'main', 6), null, '有環');
    assert.strictEqual(C.normalizePlan({ functions: Array.from({ length: 8 }, (_, i) => ({ name: 'f' + i })) }, 'main', 6), null, '太多');
    assert.strictEqual(C.normalizePlan({ functions: [] }, 'main', 6), null); assert.strictEqual(C.normalizePlan(null, 'main', 6), null);
  });
  await t('solve 順利：先寫被呼叫的、再寫入口；提示帶焦點標頭與已定簽名；呼叫次數對得上', async () => {
    const m = F.makeScriptedModel({ plan: PLAN2, codes: GOOD }); const j = fakeJudge([AC]);
    const r = await C.solve({ problem: PROB, lang: 'python', ask: m.ask, write: m.write, judge: j });
    assert.ok(r.ok); assert.strictEqual(r.verdict, 'AC'); assert.deepStrictEqual(r.plan.map((x) => x.name), ['add', 'main']); assert.deepStrictEqual(r.calls, { ask: 1, write: 2, judge: 1, choose: 0, free: 0, rank: 0 }); assert.strictEqual(r.rethinks, 0);
    const writes = m.log.filter((e) => e.kind === 'write'); assert.deepStrictEqual(writes.map((e) => e.meta.fn), ['add', 'main']);
    const w2 = writes[1].messages.map((x) => x.content).join('\n'); assert.ok(w2.indexOf('【目標】兩數相加') >= 0 && w2.indexOf('fn:main') >= 0 && w2.indexOf('def add(a, b)') >= 0 && w2.indexOf('【已定，不要改】') >= 0, w2);
    assert.ok(j.seen[0].indexOf('def add') < j.seen[0].indexOf('def main') && /main\(\)\s*$/.test(j.seen[0]), '組裝順序：add 在 main 前，最後呼叫 main');
    assert.deepStrictEqual(r.gaps, []); assert.ok(S.fromJsonl(r.stack), '堆疊可還原'); assert.ok(r.stack.join('\n').indexOf('program') > 0);
  });
  await t('沒過 → 選擇題挑函式、重寫（write_code 領域不開思考）、回饋帶範例失敗的輸入；改好就 AC', async () => {
    const m = F.makeScriptedModel({ plan: PLAN2, fix: 'add', codes: { add: ['def add(a, b):\n    return a - b\n', 'def add(a, b):\n    return a + b\n'], main: GOOD.main } });
    const j = fakeJudge([{ verdict: 'WA', passed: 0, total: 3, failedIndex: 0, detail: '#1 第 1 個詞不同：-1 vs 期望 3' }, AC]);
    const r = await C.solve({ problem: PROB, lang: 'python', ask: m.ask, write: m.write, judge: j });
    assert.ok(r.ok); assert.strictEqual(r.rethinks, 1); assert.strictEqual(r.calls.judge, 2);
    const fix = m.log.find((e) => e.kind === 'fix'); assert.ok(/A\. add/.test(fix.messages[1].content) && /B\. main/.test(fix.messages[1].content));
    const rw = m.log.filter((e) => e.kind === 'write')[2]; assert.strictEqual(rw.meta.fn, 'add'); assert.strictEqual(rw.meta.thinking, false, 'write_code 領域一律不開思考'); assert.strictEqual(rw.meta.kind, 'rewrite');
    const body = rw.messages.map((x) => x.content).join('\n'); assert.ok(body.indexOf('範例測試 #1 判決 WA') >= 0 && body.indexOf('輸入：\n1 2') >= 0 && body.indexOf('return a - b') >= 0, body);
    assert.ok(j.seen[1].indexOf('return a + b') > 0 && j.seen[1].indexOf('a - b') < 0, '第二次驗收用的是新程式');
  });
  await t('hidden 測試失敗：提示裡沒有 hidden 的輸入與期望', async () => {
    const m = F.makeScriptedModel({ plan: PLAN2, codes: GOOD });
    const j = fakeJudge([{ verdict: 'WA', passed: 2, total: 3, failedIndex: 2, detail: '[hidden] #3 第 1 個詞不同：999 vs 期望 13344' }, AC]);
    const r = await C.solve({ problem: PROB, lang: 'python', ask: m.ask, write: m.write, judge: j });
    const all = text(m.log); assert.ok(r.ok); assert.ok(all.indexOf('隱藏測試') >= 0); assert.ok(all.indexOf('13344') < 0 && all.indexOf('12345') < 0 && all.indexOf('期望 13344') < 0, '不能洩漏');
  });
  await t('一直不過：重寫到上限就停、ok:false、gaps 如實列出，不假裝完成', async () => {
    const m = F.makeScriptedModel({ plan: PLAN2, codes: GOOD }); const j = fakeJudge([{ verdict: 'TLE', passed: 1, total: 3, failedIndex: 1, detail: '#2 超過 3000ms' }]);
    const r = await C.solve({ problem: PROB, lang: 'python', ask: m.ask, write: m.write, judge: j, opts: { maxRethink: 2 } });
    assert.ok(!r.ok); assert.strictEqual(r.verdict, 'TLE'); assert.strictEqual(r.rethinks, 2); assert.strictEqual(r.calls.judge, 3); assert.ok(r.gaps.some((g) => /重寫 2 次後仍是 TLE/.test(g)), r.gaps.join('|'));
  });
  await t('預算：呼叫次數用完就停，reason=budget，不丟例外', async () => {
    const m = F.makeScriptedModel({ plan: PLAN2, codes: GOOD }); const r = await C.solve({ problem: PROB, lang: 'python', ask: m.ask, write: m.write, judge: fakeJudge([AC]), opts: { maxCalls: 2 } });
    assert.ok(!r.ok); assert.strictEqual(r.reason, 'budget'); assert.ok(r.gaps.some((g) => /呼叫次數用完/.test(g))); assert.ok(r.calls.ask + r.calls.write <= 2);
  });
  await t('函式沒有定義名稱：堆疊的 verify 擋下，帶「上次的問題」重寫一次', async () => {
    const m = F.makeScriptedModel({ plan: PLAN2, codes: { add: ['x = 1\n', 'def add(a, b):\n    return a + b\n'], main: GOOD.main } });
    const r = await C.solve({ problem: PROB, lang: 'python', ask: m.ask, write: m.write, judge: fakeJudge([AC]) });
    const w = m.log.filter((e) => e.kind === 'write' && e.meta.fn === 'add'); assert.strictEqual(w.length, 2); assert.ok(w[1].messages.map((x) => x.content).join('\n').indexOf('上次的問題：沒有定義函式「add」') >= 0); assert.ok(r.ok && r.gaps.length === 0);
  });
  await t('重試後還是不合格 → 放行但記 gap（不阻擋流程）', async () => {
    const m = F.makeScriptedModel({ plan: PLAN2, codes: { add: ['x = 1\n'], main: GOOD.main } });
    const r = await C.solve({ problem: PROB, lang: 'python', ask: m.ask, write: m.write, judge: fakeJudge([AC]) }); assert.ok(r.gaps.some((g) => /函式 add/.test(g)));
  });
  await t('模型切不出來（ask 回 null）→ 退回單一入口函式並記 gap', async () => {
    const m = F.makeScriptedModel({ plan: null, codes: { main: ['def main():\n    print(3)\n'] } });
    const r = await C.solve({ problem: PROB, lang: 'python', ask: m.ask, write: m.write, judge: fakeJudge([AC]) });
    assert.deepStrictEqual(r.plan.map((x) => x.name), ['main']); assert.ok(r.gaps.some((g) => /退回單一入口函式/.test(g))); assert.ok(r.ok);
  });
  await t('沒有 ask 也能跑（單一函式）；組語不切、不問切割', async () => {
    const m = F.makeScriptedModel({ codes: { main: ['def main():\n    print(3)\n'] } });
    const r = await C.solve({ problem: PROB, lang: 'python', write: m.write, judge: fakeJudge([AC]) }); assert.ok(r.ok); assert.strictEqual(r.calls.ask, 0);
    const a = F.makeScriptedModel({ codes: { _start: ['.intel_syntax noprefix\n.globl _start\n_start:\n  ret\n'] } }); const j = fakeJudge([AC]);
    const ra = await C.solve({ problem: PROB, lang: 'asm-x64', ask: a.ask, write: a.write, judge: j });
    assert.strictEqual(ra.calls.ask, 0); assert.deepStrictEqual(ra.plan.map((x) => x.name), ['_start']); assert.ok(j.seen[0].startsWith('.intel_syntax noprefix'));
  });
  await t('stackChecks 開：列檢查、自問、回來核對各問一次；關閉時不問', async () => {
    const on = F.makeScriptedModel({ plan: PLAN2, codes: GOOD }); await C.solve({ problem: PROB, lang: 'python', ask: on.ask, write: on.write, judge: fakeJudge([AC]), opts: { stackChecks: true } });
    const kinds = on.log.map((e) => e.kind); assert.ok(kinds.includes('planChecks') && kinds.includes('selfValidate') && kinds.includes('review'), kinds.join());
    const off = F.makeScriptedModel({ plan: PLAN2, codes: GOOD }); await C.solve({ problem: PROB, lang: 'python', ask: off.ask, write: off.write, judge: fakeJudge([AC]) });
    assert.deepStrictEqual(off.log.map((e) => e.kind), ['split', 'write', 'write']);
  });
  await t('不認得的語言丟錯；判題器回 UNAVAILABLE 不重寫、記 gap', async () => {
    await assert.rejects(() => C.solve({ problem: PROB, lang: 'cobol', write: async () => '' }), /不認得/);
    const m = F.makeScriptedModel({ plan: PLAN2, codes: GOOD }); const r = await C.solve({ problem: PROB, lang: 'python', ask: m.ask, write: m.write, judge: fakeJudge([{ verdict: 'UNAVAILABLE', passed: 0, total: 0, failedIndex: -1, detail: '找不到' }]) });
    assert.ok(!r.ok); assert.strictEqual(r.rethinks, 0); assert.ok(r.gaps.some((g) => /沒有 python 的工具鏈/.test(g)));
  });
  await t('巢狀切割：complex 的函式再切一層，子函式在它前面寫、它變成組合函式；每層一個堆疊框架', async () => {
    const plan = { functions: [{ name: 'solve', signature: 'def solve(xs)', purpose: '算答案', calls: [], complex: true }, { name: 'main', signature: 'def main()', purpose: '讀輸入並輸出', calls: ['solve'] }] };
    const subplans = { solve: { functions: [{ name: 'prep', signature: 'def prep(xs)', purpose: '前處理', calls: [] }, { name: 'combine', signature: 'def combine(ys)', purpose: '合併', calls: [] }, { name: 'solve', signature: 'def solve(xs)', purpose: '串起 prep 與 combine', calls: ['prep', 'combine'] }] } };
    const codes = { prep: ['def prep(xs):\n    return xs\n'], combine: ['def combine(ys):\n    return sum(ys)\n'], solve: ['def solve(xs):\n    return combine(prep(xs))\n'], main: ['def main():\n    print(solve([1, 2]))\n'] };
    const m = F.makeScriptedModel({ plan, subplans, codes }); const r = await C.solve({ problem: PROB, lang: 'python', ask: m.ask, write: m.write, judge: fakeJudge([AC]) });
    assert.ok(r.ok); assert.deepStrictEqual(r.plan.map((x) => x.name), ['prep', 'combine', 'solve', 'main']); assert.strictEqual(r.plan[2].complex, false);
    const writes = m.log.filter((e) => e.kind === 'write'); assert.deepStrictEqual(writes.map((e) => e.meta.fn), ['prep', 'combine', 'solve', 'main']);
    const w3 = writes[2].messages.map((x) => x.content).join('\n'); assert.ok(w3.indexOf('它負責串起這些函式：prep、combine') >= 0, '組合函式要知道它串哪些'); assert.ok(m.log.some((e) => e.kind === 'subsplit'));
    assert.ok(r.stack.join('\n').indexOf('split:solve') > 0, '子切割有自己的框架');
  });
  await t('巢狀切割：名稱衝突或沒切開 → 維持單一函式並記 gap；maxDepth 0 不再切', async () => {
    const plan = { functions: [{ name: 'solve', signature: 'def solve()', purpose: '算', calls: [], complex: true }, { name: 'main', calls: ['solve'] }] };
    const clash = { solve: { functions: [{ name: 'main', purpose: '撞名' }, { name: 'solve', calls: ['main'] }] } };
    const m = F.makeScriptedModel({ plan, subplans: clash, codes: { solve: ['def solve():\n    return 1\n'], main: ['def main():\n    print(solve())\n'] } });
    const r = await C.solve({ problem: PROB, lang: 'python', ask: m.ask, write: m.write, judge: fakeJudge([AC]) });
    assert.deepStrictEqual(r.plan.map((x) => x.name), ['solve', 'main']); assert.ok(r.gaps.some((g) => /函式 solve：再切的結果不能用（名稱衝突）/.test(g)), r.gaps.join('|'));
    const m2 = F.makeScriptedModel({ plan, subplans: clash, codes: { solve: ['def solve():\n    return 1\n'], main: ['def main():\n    print(solve())\n'] } });
    const r2 = await C.solve({ problem: PROB, lang: 'python', ask: m2.ask, write: m2.write, judge: fakeJudge([AC]), opts: { maxDepth: 0 } }); assert.ok(!m2.log.some((e) => e.kind === 'subsplit'));
  });
  await t('沒有測試、只有編譯檢查（CHECKED）：ok 但 verified:false，並記一筆 gap，不重寫', async () => {
    const m = F.makeScriptedModel({ plan: PLAN2, codes: GOOD }); const r = await C.solve({ problem: { id: 'x', statement: '寫一個加法程式' }, lang: 'python', ask: m.ask, write: m.write, judge: fakeJudge([{ verdict: 'CHECKED', passed: 0, total: 0, failedIndex: -1, detail: '只通過編譯' }]) });
    assert.ok(r.ok); assert.strictEqual(r.verified, false); assert.strictEqual(r.rethinks, 0); assert.ok(r.gaps.some((g) => /沒有測試驗證行為/.test(g)));
    const ok = await C.solve({ problem: PROB, lang: 'python', ask: m.ask, write: m.write, judge: fakeJudge([AC]) }); assert.strictEqual(ok.verified, true);
  });
  await t('文法引導寫作接進迴圈：有文法的語言＋有 choose → 每個函式逐 token 做選擇題（神諭只能挑合法選項），沒有任何一次自由寫；拼起來判題', async () => {
    const targets = { add: 'def add(a, b):\n    return a + b\n', main: 'def main():\n    a, b = map(int, input().split())\n    print(add(a, b))\n' }; const oracles = {}; for (const [k, v] of Object.entries(targets)) oracles[k] = F.makeOracle('python', v);
    const which = (msgs) => { const u = msgs.filter((x) => x.role === 'user').pop().content; const mm = /正在寫：def (\w+)/.exec(u); return mm ? mm[1] : null; };
    const choose = async (msgs, opts) => oracles[which(msgs)].choose(msgs, opts); const free = async (msgs, kind) => oracles[which(msgs)].free(msgs, kind);
    const m = F.makeScriptedModel({ plan: PLAN2, codes: {} }); const j = fakeJudge([AC]); const tokens = [];
    const r = await C.solve({ problem: PROB, lang: 'python', ask: m.ask, write: m.write, judge: j, choose, free, onEvent: (e) => { if (e.t === 'token') { tokens.push(e); if (e.kind === 'auto') oracles[e.fn].onEvent({ t: 'auto', token: e.text }); } } });
    assert.ok(r.ok, JSON.stringify(r.gaps)); assert.strictEqual(r.calls.write, 0, '沒有自由寫'); assert.ok(r.calls.choose > 0 && r.calls.free >= 0); assert.ok(j.seen[0].indexOf('def add(a, b):\n    return a + b') >= 0 && j.seen[0].indexOf('print(add(a, b))') >= 0, j.seen[0]);
    assert.ok(tokens.some((x) => x.kind === 'punct') && tokens.some((x) => x.kind === 'kw') && tokens.some((x) => x.kind === 'name'), '每一步選到的 token（關鍵字、符號、名稱）都有紀錄');
    assert.ok(r.trace.some((e) => e.t === 'guided' && e.ok && e.fn === 'add') && !r.gaps.some((g) => /文法引導寫作沒完成/.test(g)));
  });
  await t('文法引導寫作選不出來（choose 回 null）→ 退回模型自由寫並記 gap；沒有 choose 的呼叫端、沒有文法的語言（ruby）一律自由寫', async () => {
    const m = F.makeScriptedModel({ plan: PLAN2, codes: GOOD }); const r = await C.solve({ problem: PROB, lang: 'python', ask: m.ask, write: m.write, judge: fakeJudge([AC]), choose: async () => null });
    assert.ok(r.ok && r.calls.write === 2); assert.ok(r.gaps.some((g) => /函式 add：文法引導寫作沒完成（choose_failed：模型沒有選出類別）/.test(g) || /函式 add：文法引導寫作沒完成/.test(g)), r.gaps.join('|'));
    const m2 = F.makeScriptedModel({ plan: PLAN2, codes: GOOD }); const r2 = await C.solve({ problem: PROB, lang: 'python', ask: m2.ask, write: m2.write, judge: fakeJudge([AC]) }); assert.strictEqual(r2.calls.choose, 0); assert.strictEqual(r2.calls.write, 2);
    const rb = F.makeScriptedModel({ plan: { functions: [{ name: 'main', signature: 'def main', purpose: 'x', calls: [] }] }, codes: { main: ['def main\n  puts 3\nend\n'] } }); let asked = 0; const r3 = await C.solve({ problem: PROB, lang: 'ruby', ask: rb.ask, write: rb.write, judge: fakeJudge([AC]), choose: async () => { asked++; return 0; } }); assert.strictEqual(asked, 0, '沒有文法的語言不走引導'); assert.strictEqual(r3.calls.write, 1);
  });
  await t('重寫時引導寫作也帶上失敗回饋（題目裡有「上一版的問題」）；每個語言用自己 CoLU 集合的規則文字', async () => {
    const seen = []; const m = F.makeScriptedModel({ plan: PLAN2, codes: GOOD }); const choose = async (msgs) => { seen.push(msgs.map((x) => x.content).join('\n')); return null; };
    await C.solve({ problem: PROB, lang: 'python', ask: m.ask, write: m.write, judge: fakeJudge([{ verdict: 'WA', passed: 0, total: 3, failedIndex: 0, detail: '#1 第 1 個詞不同：-1 vs 期望 3' }, AC]), choose, opts: { maxRethink: 1 } });
    assert.ok(seen.some((x) => x.indexOf('上一版的問題') >= 0 && x.indexOf('範例測試 #1 判決 WA') >= 0), '重寫那一輪的選擇題帶了回饋');
    const pyRules = m.log.find((e) => e.kind === 'write').messages[0].content; assert.ok(pyRules.indexOf('縮排用 4 個空白') >= 0, '規則文字取自 python 自己的 CoLU 集合');
  });
  console.log('\n' + n + ' passed');
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
