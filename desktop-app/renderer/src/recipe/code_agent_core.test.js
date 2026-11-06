// node renderer/src/recipe/code_agent_core.test.js   用「文字進、文字出」的假 generate，連 jsonStep 與提示一起走一遍（不是真模型）
const A = require('./code_agent_core.js'); const assert = require('assert');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok - ' + name); };

// 假 generate：看 system 內容決定回什麼；記錄每次 req
function fakeGen(script) {
  const reqs = []; const counts = {};
  const gen = async (req) => {
    reqs.push(req); const sys = (req.messages.find((m) => m.role === 'system') || {}).content || ''; const user = req.messages.filter((m) => m.role === 'user').pop().content;
    if (sys.indexOf('切成幾個小函式') >= 0) return (req.prefill || '') + (script.plan || '{"functions":[]}').slice((req.prefill || '').length ? 0 : 0).replace(/^\{"/, req.prefill ? '' : '{"');
    if (sys.indexOf('你在除錯') >= 0) return '{"fix":"' + (script.fixLetter || 'A') + '"}'.replace(/^/, req.prefill ? '' : '');
    const m = /現在寫：(\w+)/.exec(user) || /現在寫：(\w+)/.exec(req.messages.map((x) => x.content).join('\n')); const fn = m ? m[1] : ''; counts[fn] = (counts[fn] || 0) + 1;
    const versions = script.codes[fn] || ['']; return '<think>想一想</think>\n```\n' + versions[Math.min(counts[fn], versions.length) - 1] + '\n```';
  };
  gen.reqs = reqs; return gen;
}
const PLAN = '{"functions":[{"name":"add","signature":"def add(a, b)","purpose":"相加","calls":[]},{"name":"main","signature":"def main()","purpose":"讀輸入","calls":["add"]}]}';
const CODES = { add: ['def add(a, b):\n    return a + b\n'], main: ['def main():\n    a, b = map(int, input().split())\n    print(add(a, b))\n'] };
const judgeAC = async () => ({ verdict: 'AC', passed: 1, total: 1, failedIndex: -1, detail: '' });
const checkOK = async () => ({ verdict: 'CHECKED', passed: 0, total: 0, failedIndex: -1, detail: '只通過編譯' });

(async () => {
  await t('detectLang：c++／c#／javascript 先於 c／java；沒說就 python', async () => {
    const d = A.detectLang;
    assert.strictEqual(d('用 C++ 寫一個排序'), 'cpp'); assert.strictEqual(d('用 C# 寫'), 'csharp'); assert.strictEqual(d('寫一個 JavaScript 函式'), 'nodejs'); assert.strictEqual(d('用 Node.js 做'), 'nodejs');
    assert.strictEqual(d('用 java 寫'), 'java'); assert.strictEqual(d('用 python 寫'), 'python'); assert.strictEqual(d('用 Ruby'), 'ruby'); assert.strictEqual(d('perl 腳本'), 'perl'); assert.strictEqual(d('寫一個 bash script'), 'bash');
    assert.strictEqual(d('用 x86 32 位元組語寫'), 'asm-x86'); assert.strictEqual(d('用 x64 組語寫'), 'asm-x64'); assert.strictEqual(d('用 C 語言寫一個 hash table'), 'c'); assert.strictEqual(d('寫一個函式'), 'python'); assert.strictEqual(d('寫一個函式', 'java'), 'java');
  });
  await t('makeBackend：ask 走 jsonStep（帶 prefill、去掉 <think>）；write 回純文字；write_code 領域一律不開思考（enableThinking 明說 false，不靠預設值）', async () => {
    const reqs = []; const b = A.makeBackend({ generate: async (req) => { reqs.push(req); const sys = req.messages[0].content; return sys.indexOf('JSON') >= 0 ? '{"fix":"B"}' : '```\ncode\n```'; }, thinking: { enabled: true, maxTokens: 1800, timeoutMs: 9000 } });
    const v = await b.ask([{ role: 'system', content: '只輸出 JSON' }, { role: 'user', content: 'q' }], (x) => (x.fix ? [] : ['沒有 fix'])); assert.deepStrictEqual(v, { fix: 'B' });
    assert.ok(await b.ask([{ role: 'system', content: '只輸出 JSON' }, { role: 'user', content: 'q' }], () => ['永遠不合格']) === null, '不合格回 null，不丟例外');
    await b.write([{ role: 'user', content: 'w' }], { thinking: true }); const w = reqs.filter((r) => r.messages[0].role === 'user').pop(); assert.strictEqual(w.enableThinking, false, '就算呼叫端要求，write_code 領域也不開思考'); assert.ok(!reqs.some((r) => r.enableThinking === true), '沒有任何一次呼叫開思考');
    assert.throws(() => A.makeBackend({}), /需要 generate/);
  });
  await t('runCode 題目模式：文字模型 → 切割→逐函式寫→判題 AC（連 jsonStep 與 <think> 一起走）', async () => {
    const gen = fakeGen({ plan: PLAN, codes: CODES }); const events = [];
    const r = await A.runCode({ text: '寫一個 python 程式讀兩個整數印出和', problem: { statement: '輸入兩個整數，輸出和', tests: [{ in: '1 2\n', out: '3\n' }] }, opts: { writeMode: 'free' }, generate: gen, judge: judgeAC, check: checkOK, onEvent: (e) => events.push(e) });
    assert.ok(r.ok && r.verified, JSON.stringify(r.gaps)); assert.strictEqual(r.mode, 'problem'); assert.strictEqual(r.lang, 'python'); assert.deepStrictEqual(r.plan.map((x) => x.name), ['add', 'main']);
    assert.deepStrictEqual(events.map((e) => e.t).filter((x) => x !== 'ask'), ['route', 'plan', 'write', 'write', 'judge'], '進度事件依序（先 route）');
    const rep = A.formatReport(r); assert.ok(rep.indexOf('已用測試驗證') >= 0 && rep.indexOf('add → main') >= 0 && rep.indexOf('```python') >= 0, rep);
  });
  await t('runCode 沒有測試 → 只用 check，結果 CHECKED、verified:false，報告明講「沒有驗證行為」', async () => {
    const r = await A.runCode({ text: '用 python 寫一個加法程式', opts: { writeMode: 'free' }, generate: fakeGen({ plan: PLAN, codes: CODES }), judge: judgeAC, check: checkOK });
    assert.ok(r.ok); assert.strictEqual(r.verified, false); assert.strictEqual(r.verdict, 'CHECKED'); const rep = A.formatReport(r); assert.ok(rep.indexOf('沒有驗證行為是否正確') >= 0 && rep.indexOf('只通過編譯／語法檢查') >= 0, rep);
  });
  await t('判題器與檢查器都沒給、或沒有模型 → ok:false 並說明，不假裝驗證過', async () => {
    const r = await A.runCode({ text: '寫程式', opts: { writeMode: 'free' }, generate: fakeGen({ plan: PLAN, codes: CODES }) }); assert.ok(!r.ok && r.reason === 'no_checker' && !r.verified);
    const r2 = await A.runCode({ text: '寫程式', check: checkOK }); assert.ok(!r2.ok && r2.reason === 'no_model');
  });
  await t('runCode 專案模式：給 UML 模型 → 逐類別寫 → check；有 driver＋tests＋judge 才 verified', async () => {
    const model = { classes: [{ name: 'Item', kind: 'class', attrs: [{ name: 'price', type: 'int' }], ops: [] }, { name: 'Cart', kind: 'class', attrs: [], ops: [{ name: 'total', params: [], returns: 'int' }] }], relations: [{ from: 'Cart', to: 'Item', kind: 'compose' }] };
    const codes = { Item: ['class Item:\n    def __init__(self, price):\n        self.price = price\n'], Cart: ['class Cart:\n    def total(self):\n        return 0\n'] };
    const r = await A.runCode({ text: '購物車', model, lang: 'python', opts: { writeMode: 'free' }, generate: fakeGen({ codes }), check: checkOK, judge: judgeAC });
    assert.ok(r.ok); assert.strictEqual(r.mode, 'project'); assert.strictEqual(r.verified, false); assert.deepStrictEqual(r.order, ['Item', 'Cart']);
    const r2 = await A.runCode({ text: '購物車', model, lang: 'python', opts: { writeMode: 'free' }, generate: fakeGen({ codes }), check: checkOK, judge: judgeAC, driver: 'print(Cart().total())', problem: { statement: 'x', tests: [{ in: '', out: '0\n' }] } }); assert.ok(r2.ok && r2.verified);
    const rep = A.formatReport(r); assert.ok(rep.indexOf('依 UML 專案模式') >= 0 && rep.indexOf('Item → Cart') >= 0, rep);
  });
  await t('formatReport：失敗時列出 gaps；沒有結果', async () => {
    const rep = A.formatReport({ ok: false, verified: false, verdict: 'WA', lang: 'c', mode: 'problem', gaps: ['重寫 3 次後仍是 WA'], calls: { ask: 1, write: 4, judge: 4 }, rethinks: 3, source: 'int main(){}' });
    assert.ok(rep.indexOf('沒有完成') >= 0 && rep.indexOf('- 重寫 3 次後仍是 WA') >= 0 && rep.indexOf('```c') >= 0, rep); assert.strictEqual(A.formatReport(null), '沒有結果');
  });
  // 假的 python 檢查器：缺「def main():」的冒號就回 CE（格式跟真的 py_compile 一樣，syntax_fix 才解得出位置）
  const pyCheck = async ({ source }) => (/def main\(\)\n/.test(source) ? { verdict: 'CE', passed: 0, total: 0, failedIndex: -1, detail: "SyntaxError: expected ':'", compileLog: 'File "main.py", line ' + (source.split('\n').findIndex((l) => /^def main\(\)$/.test(l)) + 1) + '\n    def main()\n              ^\nSyntaxError: expected \':\'\n' } : { verdict: 'CHECKED', passed: 0, total: 0, failedIndex: -1, detail: '只通過編譯' });
  await t('detectLangFromCode：各語言的典型程式碼；猜不出來回 null', async () => {
    const d = A.detectLangFromCode;
    assert.strictEqual(d('#!/usr/bin/env python3\nprint(1)'), 'python'); assert.strictEqual(d('import sys\ndef main():\n    pass\n'), 'python'); assert.strictEqual(d('#include <stdio.h>\nint main(void) { return 0; }'), 'c'); assert.strictEqual(d('#include <iostream>\nint main() { std::cout << 1; }'), 'cpp');
    assert.strictEqual(d('public class Main { public static void main(String[] a) { System.out.println(1); } }'), 'java'); assert.strictEqual(d('using System;\nclass P { static void Main() { Console.WriteLine(1); } }'), 'csharp'); assert.strictEqual(d("const fs = require('fs');\nconsole.log(1);"), 'nodejs');
    assert.strictEqual(d('def main\n  puts 1\nend\n'), 'ruby'); assert.strictEqual(d('use strict;\nmy $x = 1;\n'), 'perl'); assert.strictEqual(d('#!/bin/bash\necho hi\n'), 'bash'); assert.strictEqual(d('.intel_syntax noprefix\n.globl _start\n_start:\n  syscall\n'), 'asm-x64'); assert.strictEqual(d('這不是程式'), null);
  });
  await t('runCode edit 模式：任意程式碼進來 → 程式修語法（不用模型）→ 回 diff 與 edits；語言從程式碼猜；報告有 diff', async () => {
    const src = 'import sys\n\ndef main()\n    print(1)\n\nmain()\n'; const r = await A.runCode({ source: src, check: pyCheck });
    assert.strictEqual(r.mode, 'edit'); assert.strictEqual(r.lang, 'python'); assert.ok(r.ok && !r.verified, JSON.stringify(r.gaps)); assert.strictEqual(r.source, src.replace('def main()', 'def main():')); assert.strictEqual(r.calls.write, 0, '沒有叫模型');
    const rep = A.formatReport(r); assert.ok(rep.indexOf('修改現有程式（python）') >= 0 && rep.indexOf('```diff') >= 0 && rep.indexOf('+def main():') >= 0 && rep.indexOf('沒有驗證行為是否正確') >= 0, rep);
    const none = await A.runCode({ source: src }); assert.ok(!none.ok && none.reason === 'no_checker');
  });
  await t('runCode 寫程式時語法壞掉：先交給語法修復（repair），沒花模型重寫；修補有對應回函式', async () => {
    const codes = { add: ['def add(a, b):\n    return a + b\n'], main: ['def main()\n    a, b = map(int, input().split())\n    print(add(a, b))\n'] }; const gen = fakeGen({ plan: PLAN, codes }); let judged = 0;
    const check = async ({ source }) => pyCheck({ source }); const judge = async ({ source }) => { judged++; return /def main\(\)\n/.test(source) ? await pyCheck({ source }) : { verdict: 'AC', passed: 1, total: 1, failedIndex: -1, detail: '' }; };
    const r = await A.runCode({ text: '寫一個 python 程式讀兩個整數印出和', problem: { statement: '輸入兩個整數，輸出和', tests: [{ in: '1 2\n', out: '3\n' }] }, opts: { writeMode: 'free' }, generate: gen, judge, check });
    assert.ok(r.ok && r.verified, r.verdict + JSON.stringify(r.gaps)); assert.strictEqual(r.rethinks, 0, '語法由程式修，沒走重寫'); assert.strictEqual(r.edits.length, 1); assert.ok(r.codes.main.indexOf('def main():') >= 0, '修補對應回函式程式碼'); assert.strictEqual(judged, 3, 'CE 一次、修復器用測試驗證候選一次、修完 AC 一次');
  });
  await t('routeOf：函式／演算法／有輸入輸出→direct；系統／多功能／多領域名詞／條列→uml；一句話的系統落在模糊帶；有附測試偏 direct', async () => {
    const r = A.routeOf; assert.strictEqual(r('寫一個函式，輸入兩個整數，輸出它們的和').route, 'direct'); assert.strictEqual(r('用 python 寫二分搜尋').route, 'direct'); assert.strictEqual(r('寫一個 LRU cache 類別').route, 'direct');
    const big = r('做一個線上書店系統：會員可以註冊登入、搜尋書、加入購物車、下訂單付款；管理員可以管理庫存與報表。'); assert.strictEqual(big.route, 'uml'); assert.ok(big.reasons.length >= 2 && !big.ambiguous);
    assert.strictEqual(r('- 使用者登入\n- 商品管理\n- 訂單查詢\n- 報表匯出').route, 'uml'); const amb = r('寫一個停車場管理系統'); assert.ok(amb.ambiguous && amb.route === 'direct', JSON.stringify(amb));
    assert.ok(r('做一個待辦事項 app，使用者可以新增、完成、刪除待辦，並提供提醒通知', { tests: true }).score < r('做一個待辦事項 app，使用者可以新增、完成、刪除待辦，並提供提醒通知').score);
  });
  const BIGTEXT = '做一個線上書店系統：會員可以註冊登入、搜尋書、加入購物車、下訂單付款；管理員可以管理庫存與報表。';
  const MODEL = { classes: [{ name: 'Item', kind: 'class', attrs: [{ name: 'price', type: 'int' }], ops: [] }, { name: 'Cart', kind: 'class', attrs: [], ops: [{ name: 'total', params: [], returns: 'int' }] }], relations: [{ from: 'Cart', to: 'Item', kind: 'compose' }] };
  const PYCODES = { Item: ['class Item:\n    def __init__(self, price):\n        self.price = price\n'], Cart: ['class Cart:\n    def total(self):\n        return 0\n'] };
  await t('runCode 只給需求：判成偏大 → 自動設計 UML（design 注入）→ 專案模式；結果有 route 與 design；報告寫明路線', async () => {
    let designed = 0; const r = await A.runCode({ text: BIGTEXT, lang: 'python', opts: { writeMode: 'free' }, generate: fakeGen({ codes: PYCODES }), check: checkOK, design: async ({ text, lang }) => { designed++; assert.ok(text.indexOf('書店') >= 0 && lang === 'python'); return { ok: true, model: MODEL, dsl: 'class Item {}', warnings: [] }; } });
    assert.strictEqual(designed, 1); assert.ok(r.ok && r.mode === 'project', JSON.stringify(r.gaps)); assert.strictEqual(r.route.route, 'uml'); assert.strictEqual(r.route.by, 'program'); assert.deepStrictEqual(r.design.classes, ['Item', 'Cart']);
    const rep = A.formatReport(r); assert.ok(rep.indexOf('路線：需求偏大，先設計 UML（2 個類別），再逐類別實作') >= 0, rep);
  });
  await t('runCode 簡單需求：不設計 UML（design 不會被呼叫）、走題目模式；報告寫「直接切成函式寫」', async () => {
    let designed = 0; const r = await A.runCode({ text: '寫一個 python 函式，輸入兩個整數，輸出它們的和', lang: 'python', opts: { writeMode: 'free' }, generate: fakeGen({ plan: PLAN, codes: CODES }), check: checkOK, design: async () => { designed++; return { ok: true, model: MODEL }; } });
    assert.strictEqual(designed, 0); assert.strictEqual(r.mode, 'problem'); assert.strictEqual(r.route.route, 'direct'); assert.ok(A.formatReport(r).indexOf('路線：直接切成函式寫') >= 0);
  });
  await t('偏大但設計失敗／沒有 design 能力／語言不支援專案模式：都退回直接寫並記 gap，不丟例外', async () => {
    const mk = (extra) => A.runCode(Object.assign({ text: BIGTEXT, lang: 'python', opts: { writeMode: 'free' }, generate: fakeGen({ plan: PLAN, codes: CODES }), check: checkOK }, extra));
    const r1 = await mk({ design: async () => ({ ok: false, error: '找不到參與者' }) }); assert.strictEqual(r1.mode, 'problem'); assert.ok(r1.gaps.some((g) => /先設計 UML 沒成功（找不到參與者）/.test(g)) && r1.route.fallback === 'design_failed');
    const r2 = await mk({}); assert.strictEqual(r2.mode, 'problem'); assert.ok(r2.gaps.some((g) => /沒有 UML 設計能力/.test(g)));
    const r3 = await mk({ lang: 'c', design: async () => ({ ok: true, model: MODEL }) }); assert.strictEqual(r3.mode, 'problem'); assert.ok(r3.gaps.some((g) => /專案模式不支援 c/.test(g)));
    const r4 = await mk({ design: async () => { throw new Error('模型逾時'); } }); assert.strictEqual(r4.mode, 'problem'); assert.ok(r4.gaps.some((g) => /模型逾時/.test(g)));
  });
  await t('模糊帶：有 ask 就讓模型選 A／B；沒回答選便宜的直接寫並記 gap；route 參數可由呼叫端強制', async () => {
    const amb = '寫一個停車場管理系統'; const design = async () => ({ ok: true, model: MODEL, dsl: '', warnings: [] });
    const ask = (letter) => async (m, v) => (v({ pick: letter }).length ? null : { pick: letter }); const mkBackend = (letter) => ({ ask: ask(letter), write: async (m, meta) => { const fn = (/現在寫：(\w+)/.exec(m.map((x) => x.content).join('\n')) || [])[1]; return '```\n' + ((PYCODES[fn] || CODES[fn] || [''])[0]) + '\n```'; } });
    const rB = await A.runCode({ text: amb, lang: 'python', backend: mkBackend('B'), check: checkOK, design }); assert.strictEqual(rB.mode, 'project'); assert.strictEqual(rB.route.by, 'model');
    const rA = await A.runCode({ text: amb, lang: 'python', backend: { ask: async () => ({ pick: 'A' }), write: mkBackend('A').write }, check: checkOK, design }); assert.strictEqual(rA.route.route, 'direct'); assert.strictEqual(rA.route.by, 'model');
    const rN = await A.runCode({ text: amb, lang: 'python', backend: { ask: async () => null, write: mkBackend('A').write }, check: checkOK, design }); assert.strictEqual(rN.route.route, 'direct'); assert.ok(rN.gaps.some((g) => /模糊帶、模型沒回答/.test(g)));
    const rF = await A.runCode({ text: '寫一個函式把字串反轉', lang: 'python', route: 'uml', opts: { writeMode: 'free' }, generate: fakeGen({ codes: PYCODES }), check: checkOK, design }); assert.strictEqual(rF.mode, 'project'); assert.strictEqual(rF.route.by, 'caller');
  });
  await t('makeBackend.choose／free：選擇題只回合法字母的索引（不合法重問、仍不行回 null）、不開思考；free 回一小段文字', async () => {
    const reqs = []; const gen = async (req) => { reqs.push(req); const u = req.messages.filter((m) => m.role === 'user').pop().content; if (/新名稱/.test(u)) return '{"name":"total"}'; if (/字串內容/.test(u)) return '{"text":"hi"}'; return reqs.length === 1 ? '{"pick":"Q"}' : '{"pick":"C"}'; };
    const b = A.makeBackend({ generate: gen }); const opts = [{ label: 'A', text: 'x' }, { label: 'B', text: 'y' }, { label: 'C', text: 'z' }];
    const idx = await b.choose([{ role: 'system', content: '選' }, { role: 'user', content: '選一個' }], opts); assert.strictEqual(idx, 2, '第一次回了不合法的 Q，退回重問後選到 C'); assert.ok(reqs.every((r) => r.enableThinking !== true) && reqs.some((r) => typeof r.prefill === 'string' && r.prefill.indexOf('pick') > 0), '不開思考，所以 prefill 有效（格式穩）');
    assert.strictEqual(await b.free([{ role: 'user', content: '請寫新名稱' }], 'name'), 'total'); assert.strictEqual(await b.free([{ role: 'user', content: '字串內容' }], 'str'), 'hi');
    const nope = A.makeBackend({ generate: async () => '{"pick":"Z"}' }); assert.strictEqual(await nope.choose([{ role: 'user', content: 'q' }], opts), null, '一直不合法就是 null，不亂挑');
  });
  await t('小模型常回「選項的內容」不是字母：內容等於某個合法選項就算選了它（字母優先；都不是才無效）——真模型實測 {"pick":"+"} 的情況', async () => {
    const opts = [{ label: 'A', text: '名稱：a、b', aliases: ['a', 'b', 'total'] }, { label: 'B', text: '符號：+、-', aliases: ['+', '-', '('] }, { label: 'C', text: '更多', aliases: [] }];
    const mk = (reply) => A.makeBackend({ generate: async () => reply });
    assert.strictEqual(await mk('{"pick":"+"}').choose([{ role: 'user', content: 'q' }], opts), 1, '回內容 + → 符號那一項'); assert.strictEqual(await mk('{"pick":"`total`"}').choose([{ role: 'user', content: 'q' }], opts), 0, '帶反引號也行');
    assert.strictEqual(await mk('{"pick":"b"}').choose([{ role: 'user', content: 'q' }], opts), 1, '字母優先（b＝B），不會被當成名稱 b'); assert.strictEqual(await mk('{"pick":"split"}').choose([{ role: 'user', content: 'q' }], opts), null, '不是字母、也不是任何合法選項的內容 → null，不亂挑');
    const W = require('./guided_write_core.js'); let seen = null; await W.guidedWriteFunction({ lang: 'python', node: { name: 'f', signature: 'def f(a)', purpose: '' }, choose: async (m, o) => { seen = o; return null; } });
    assert.ok(seen && seen.some((o) => o.kind === 'group' && Array.isArray(o.aliases) && o.aliases.length), '引導寫作給的選項帶別名（類別選項的別名是它底下所有項目的內容）');
  });
  await t('離線失敗時各層結果（配方→課→範式→矩陣→區塊）摘進 gap，成功時 offline.rounds 帶回', async () => {
    const rounds = [{ by: 'recipe', ok: false, reason: '沒有配方' }, { by: 'paradigm', ok: false, tried: 3 }, { by: 'matrix', ok: false, reason: null }];
    assert.strictEqual(A.roundsNote(rounds), '配方✘：沒有配方→範式✘(試 3 個)→矩陣✘'); assert.strictEqual(A.roundsNote(null), '');
    const bad = await A.runCode({ text: '寫一個 python 程式讀兩個整數印出和', problem: { statement: 's', tests: [{ in: '1 2\n', out: '3\n' }] }, opts: { writeMode: 'free' }, offline: async () => ({ ok: false, reason: '沒解出', rounds }), generate: fakeGen({ plan: PLAN, codes: CODES }), judge: judgeAC, check: checkOK });
    assert.ok(bad.gaps.some((g) => g.indexOf('各層：配方✘') >= 0 && g.indexOf('範式✘(試 3 個)') >= 0), JSON.stringify(bad.gaps));
    const good = await A.runCode({ text: '寫一個 python 程式讀兩個整數印出和', problem: { statement: 's', tests: [{ in: '1 2\n', out: '3\n' }] }, opts: { writeMode: 'free' }, offline: async () => ({ ok: true, source: 'print(3)', verdict: 'AC', by: 'paradigm', rounds: [{ by: 'paradigm', ok: true, tried: 1 }] }), generate: fakeGen({ plan: PLAN, codes: CODES }), judge: judgeAC, check: checkOK });
    assert.ok(good.offline && good.offline.rounds && good.offline.rounds[0].by === 'paradigm');
  });
  console.log('\n' + n + ' passed');
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
