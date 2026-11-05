// node renderer/src/recipe/plan_code.test.js   CoLU：寫程式的目標分類、每種語言各自的計畫／失敗規則、本機函式執行
const P = require('./plan_core.js'); const LC = require('./lang_colu_core.js'); const T = require('./think_stack.js'); const assert = require('assert');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok - ' + name); };
const facts = (text, lang) => P.factsFrom({ text, lang });
const ids = (text) => P.matchGoals(text, facts(text)).map((g) => g.id);
const goal = () => P.GOALS.find((x) => x.id === 'code_program');

(async () => {
  await t('目標分類：寫程式／函式／演算法／系統 → 一律是 code_program（要不要先設計 UML 由 write_code 自己判斷）；骨架仍是 uml_code', async () => {
    assert.deepStrictEqual(ids('幫我寫一個 python 程式讀兩個整數印出和'), ['code_program']); assert.deepStrictEqual(ids('用 C++ 實作一個排序函式'), ['code_program']); assert.deepStrictEqual(ids('write a function that reverses a string'), ['code_program']);
    assert.deepStrictEqual(ids('設計一個購物車系統並實作成完整程式'), ['code_program']); assert.ok(!P.GOALS.some((g) => g.id === 'uml_project'));
    assert.ok(ids('設計情境→UML→程式碼骨架').includes('uml_code') && !ids('產生一個購物車的程式骨架').includes('code_program')); assert.deepStrictEqual(ids('今天天氣很好'), []);
  });
  await t('每種語言各有自己的 CoLU 集合：能力名稱、標籤、寫作方式都不同；沒有共用同一條能力', async () => {
    const langs = LC.languages; assert.ok(['python', 'c', 'cpp', 'java', 'csharp', 'nodejs', 'ruby', 'perl', 'bash', 'asm-x64', 'asm-x86'].every((l) => langs.includes(l)));
    const tools = new Set(); for (const l of langs) { const caps = LC.capsFor(l); assert.strictEqual(caps.length, 1); assert.deepStrictEqual(caps[0].langs, [l]); assert.ok(!tools.has(caps[0].tool), '工具名重複'); tools.add(caps[0].tool); assert.ok(P.capOf(caps[0].tool), l + ' 的能力有進 CAPS'); }
    assert.strictEqual(tools.size, langs.length); assert.strictEqual(LC.get('python').writer.mode, 'guided'); assert.strictEqual(LC.get('ruby').writer.mode, 'free'); assert.strictEqual(LC.get('asm-x64').grammar, false);
    assert.notStrictEqual(LC.capsFor('python')[0].label, LC.capsFor('cpp')[0].label); assert.notDeepStrictEqual(LC.get('python').failureRules, LC.get('cpp').failureRules);
  });
  await t('同一個目標，不同語言得到不同的計畫（不同工具）；沒有指定語言就沒有計畫，不亂猜', async () => {
    const text = '寫一個程式';
    const py = P.buildPlan(goal(), facts(text, 'python')); const cpp = P.buildPlan(goal(), facts(text, 'cpp')); const rb = P.buildPlan(goal(), facts(text, 'ruby'));
    assert.ok(py.ok && cpp.ok && rb.ok); assert.deepStrictEqual(py.steps.map((s) => s.tool), ['local_write_code_python']); assert.deepStrictEqual(cpp.steps.map((s) => s.tool), ['local_write_code_cpp']); assert.deepStrictEqual(rb.steps.map((s) => s.tool), ['local_write_code_ruby']);
    assert.notStrictEqual(py.steps[0].label, cpp.steps[0].label); assert.ok(/文法算出合法 token/.test(py.steps[0].label) && /沒有文法/.test(rb.steps[0].label));
    const none = P.buildPlan(goal(), facts(text, null)); assert.ok(!none.ok, '沒有語言就不選任何語言專屬的能力'); const bad = P.buildPlan(goal(), facts(text, 'cobol')); assert.ok(!bad.ok);
    assert.ok(!P.buildPlan(goal(), facts(text, 'python'), { lang: 'cpp' }).steps.some((s) => /python/.test(s.tool)), 'opts.lang 優先於 facts.lang');
  });
  await t('失敗規則也是各語言自己的：python 的縮排錯誤→retry，C++ 看不到這條；C／C++ 段錯誤→abort（需要除錯步驟，尚未實作）；別的語言的訊息不會觸發', async () => {
    const mk = (lang) => { const f = facts('寫一個程式', lang); const run = P.createRun(goal(), f, P.buildPlan(goal(), f), '寫一個程式'); return { run, step: run.steps[0] }; };
    const py = mk('python'), cpp = mk('cpp'), c = mk('c'), jv = mk('java');
    const d1 = P.decideFailure(py.run, py.step, 'IndentationError: unexpected indent'); assert.strictEqual(d1.action, 'retry'); assert.strictEqual(d1.rule, 'python:py_indent');
    const d2 = P.decideFailure(cpp.run, cpp.step, 'IndentationError: unexpected indent'); assert.notStrictEqual(d2.rule, 'python:py_indent'); assert.ok(!/^python:/.test(d2.rule), 'C++ 看不到 python 的規則');
    const d3 = P.decideFailure(c.run, c.step, "main.c:3: error: implicit declaration of function 'foo'"); assert.deepStrictEqual([d3.action, d3.rule], ['retry', 'c:c_decl']);
    const d4 = P.decideFailure(cpp.run, cpp.step, 'Segmentation fault (core dumped)'); assert.deepStrictEqual([d4.action, d4.rule], ['abort', 'cpp:cpp_segv']); assert.ok(/gdb|valgrind/.test(d4.why) && /尚未實作/.test(d4.why));
    const d5 = P.decideFailure(jv.run, jv.step, 'error: cannot find symbol'); assert.strictEqual(d5.rule, 'java:java_symbol'); const d6 = P.decideFailure(py.run, py.step, 'error: cannot find symbol'); assert.ok(!/^java:/.test(d6.rule), 'python 看不到 java 的規則');
    py.step.attempts = 2; assert.ok(!/^python:/.test(P.decideFailure(py.run, py.step, 'IndentationError').rule), '重試過一次就不再套同一條，交給通用規則');
  });
  await t('內嵌組語只屬於 C／C++ 的 CoLU：其他語言的集合沒有 inlineAsm；asm 組語本身（asm-x64／asm-x86）是獨立的語言不是內嵌', async () => {
    assert.ok(LC.get('c').inlineAsm && LC.get('cpp').inlineAsm && LC.get('c').inlineAsm.coluOnly); assert.ok(LC.get('c').inlineAsm.keywords.includes('__asm__'));
    for (const l of ['python', 'java', 'csharp', 'nodejs', 'ruby', 'perl', 'bash', 'asm-x64', 'asm-x86']) assert.strictEqual(LC.get(l).inlineAsm, null, l + ' 沒有內嵌組語');
    assert.ok(LC.get('asm-x64').grammar === false && /不是內嵌/.test(LC.get('asm-x64').toolchain.note));
  });
  await t('執行：本機函式（該語言專屬的工具名）拿到使用者的話；成品登記成 program；每一步有思考堆疊框架', async () => {
    const text = '寫一個 python 程式讀兩個整數印出和'; const f = facts(text, 'python'); const run = P.createRun(goal(), f, P.buildPlan(goal(), f), text); let got = null;
    const env = { tool: async () => ({ ok: false, text: '不該呼叫 AI 工具' }), fns: { local_write_code_python: async (args) => { got = args; return { ok: true, text: 'print(1)', json: { gaps: [] } }; }, local_write_code_cpp: async () => { throw new Error('不該呼叫 cpp 的'); } }, stackMod: T, stack: T.create(text) };
    await P.advance(run, env); assert.strictEqual(run.state, 'done'); assert.ok(got && JSON.stringify(got).indexOf('python') >= 0); assert.ok(run.artifacts.some((a) => a.kind === 'program' && a.value === 'print(1)')); assert.ok(env.stack.done.some((x) => /local_write_code_python/.test(x.path)));
  });
  await t('失敗：python 縮排錯誤 → 決策樹 retry（同一步再試一次）；C++ 段錯誤 → abort 並保留原因；不假裝完成', async () => {
    const text = '寫一個程式'; let calls = 0; const f = facts(text, 'python'); const run = P.createRun(goal(), f, P.buildPlan(goal(), f), text);
    await P.advance(run, { tool: async () => ({ ok: false }), fns: { local_write_code_python: async () => { calls++; return calls === 1 ? { ok: false, text: 'IndentationError: expected an indented block' } : { ok: true, text: 'x = 1', json: {} }; } } }); assert.strictEqual(calls, 2, 'retry 了一次'); assert.strictEqual(run.state, 'done');
    const f2 = facts(text, 'cpp'); const run2 = P.createRun(goal(), f2, P.buildPlan(goal(), f2), text); await P.advance(run2, { tool: async () => ({ ok: false }), fns: { local_write_code_cpp: async () => ({ ok: false, text: 'Segmentation fault (core dumped)' }) } });
    assert.strictEqual(run2.state, 'failed'); assert.ok(/Segmentation fault/.test(run2.error)); assert.notStrictEqual(run2.state, 'done');
  });
  console.log('\n' + n + ' passed');
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
