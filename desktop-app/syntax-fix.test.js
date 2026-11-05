// node syntax-fix.test.js [語言...]   語法自動修正：單元測試＋用真的編譯器做「刪掉一個結構性 token → 修回來」的系統性評估
// 評估數字是用 A+B 這種很小的程式量的，只代表「單一 token 缺失」這類最簡單的錯誤；不代表任意語法錯誤都修得好。
const assert = require('assert'); const F = require('./renderer/src/recipe/syntax_fix_core.js'); const R = require('./judge-runner.js'); const { APLUSB, SOL } = require('./judge-fixtures.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok - ' + name); };
const check = (x) => R.check(x);
const STRUCT = new Set([';', ')', '(', ']', '[', '}', '{', ':', ',', 'end', 'fi', 'done', 'then', 'do']);

(async () => {
  await t('lex：字串、註解、前處理行、Python 縮排與三引號、未結束的字串', async () => {
    const c = F.lex('c', '#include <stdio.h>\nint main() { // 註解 ;\n  char *s = "a;\\"b"; /* ) */ return 0; }\n'); assert.ok(c[0].t === 'pp'); assert.ok(!c.some((x) => x.v === ')' && x.line === 3 && x.t === 'op' && x.col > 20), '註解裡的括號不算');
    const s = c.find((x) => x.t === 'str'); assert.strictEqual(s.v, '"a;\\"b"'); assert.ok(!s.bad);
    const bad = F.lex('c', 'char *s = "abc;\nint x;\n').find((x) => x.t === 'str'); assert.ok(bad.bad && bad.quote === '"');
    const py = F.lex('python', 'x = """a\nb"""\ny = 1 # c\n'); assert.strictEqual(py.find((x) => x.t === 'str').v, '"""a\nb"""'); assert.ok(py.some((x) => x.v === 'y' && x.line === 3));
    assert.ok(F.lex('python', 'x = """oops\n').find((x) => x.t === 'str').bad);
    const br = F.brackets(F.lex('c', 'f(a[1], {2)')); assert.strictEqual(br.stack.length, 2); assert.strictEqual(br.mismatch.length, 1); assert.strictEqual(F.brackets(F.lex('c', 'a)')).strays.length, 1);
  });
  await t('parseErrors：各編譯器的訊息格式（用真的編譯器產生）', async () => {
    const cases = { python: 'def f(:\n  pass\n', nodejs: 'function f( {\n}\n', c: 'int main( { return 0 }\n', cpp: 'int main( { return 0 }\n', java: 'class Main { void f( }\n', csharp: 'class P { void f( }\n', ruby: 'def f(\n', perl: 'sub {\n', bash: 'if then fi (\n' };
    for (const lang of Object.keys(cases)) { if (!(await R.available(lang)).ok) continue; const r = await R.check({ lang, source: cases[lang] }); const e = F.parseErrors(lang, r.compileLog, cases[lang]); assert.ok(e.length && e[0].line >= 1, lang + ' 解不出位置：' + r.compileLog); if (['c', 'cpp', 'java', 'csharp', 'python'].includes(lang)) assert.ok(e[0].col > 0, lang + ' 沒有欄位'); }
  });
  await t('unitOf：缺分號時單元包含上一條敘述；括號內的 ; 不切', async () => {
    const src = 'int main(void) {\n  int a = 1\n  int b = 2;\n  for (int i = 0; i < 3; i++) { }\n}\n'; const u = F.unitOf('c', F.lex('c', src), src, 3); assert.ok(u.text.indexOf('int a = 1') >= 0 && u.text.indexOf('int b = 2') >= 0, u.text);
    const f = F.unitOf('c', F.lex('c', src), src, 4); assert.ok(f.text.indexOf('for (int i = 0; i < 3; i++)') >= 0, '括號裡的分號不切：' + f.text);
  });
  await t('diff：只列有變的區塊與兩行脈絡；沒變回空字串', async () => {
    const d = F.unifiedDiff('a\nb\nc\nd\ne\nf\n', 'a\nb\nc!\nd\ne\nf\n', 'x.py'); assert.ok(d.indexOf('-c\n+c!') > 0 && d.startsWith('--- x.py'), d); assert.strictEqual(F.unifiedDiff('x', 'x'), '');
  });
  await t('repairSyntax：已經正確 → already_ok；不是語法錯誤（檢查器說 UNAVAILABLE）→ 不動；沒有檢查器／不支援的語言 → 明確原因', async () => {
    const ok = await F.repairSyntax({ lang: 'python', source: 'print(1)\n', check }); assert.ok(ok.ok && ok.reason === 'already_ok' && ok.edits.length === 0 && ok.diff === '');
    const un = await F.repairSyntax({ lang: 'python', source: 'x(', check: async () => ({ verdict: 'UNAVAILABLE', detail: 'x' }) }); assert.ok(!un.ok && /not_a_syntax_error/.test(un.reason) && un.source === 'x(');
    assert.strictEqual((await F.repairSyntax({ lang: 'python', source: 'x(' })).reason, 'no_checker'); assert.strictEqual((await F.repairSyntax({ lang: 'asm-x64', source: 'x', check })).reason, 'unsupported_lang');
  });
  await t('repairSyntax：只改必要的 token，其餘格式（CRLF、縮排、註解）完全保留；回 edits 與 diff', async () => {
    if (!(await R.available('c')).ok) return; const src = '#include <stdio.h>\r\n/* 保留 */\r\nint main(void) {\r\n\tprintf("hi\\n")\r\n\treturn 0;\r\n}\r\n';
    const r = await F.repairSyntax({ lang: 'c', source: src, check }); assert.ok(r.ok, r.reason); assert.strictEqual(r.source, src.replace('"hi\\n")', '"hi\\n");')); assert.strictEqual(r.edits.length, 1); assert.ok(r.edits[0].text === ';' && r.diff.indexOf('+\tprintf("hi\\n");') > 0, r.diff);
  });
  await t('repairSyntax：多個錯誤分輪修；選擇題由模型挑（假模型），挑不出來用成本最低的', async () => {
    if (!(await R.available('python')).ok) return; const src = 'def f(x)\n    return (x + 1\nprint(f(2))\n';
    const r = await F.repairSyntax({ lang: 'python', source: src, check }); assert.ok(r.ok, r.reason + r.tried); assert.ok(r.edits.length >= 2); const run = await R.judge({ lang: 'python', source: r.source, problem: { id: 'x', tests: [{ in: '', out: '3\n' }] } }); assert.strictEqual(run.verdict, 'AC', r.source);
    // 選擇題：C 缺 ; 時「前一行行尾」與「錯誤 token 前」是同樣好的候選 → 會問
    if (!(await R.available('c')).ok) return; const asked = []; const c = await F.repairSyntax({ lang: 'c', source: '#include <stdio.h>\nint main(void) {\n  int a = 1\n  printf("%d\\n", a);\n  return 0;\n}\n', check, ask: async (m, v) => { asked.push(m); return { pick: 'A' }; } });
    assert.ok(c.ok); assert.ok(asked.length === 0 || /選項：/.test(asked[0][1].content), '有並列才會問');
  });

  await t('語意分析：識別字黏合、引數個數、printf／scanf 格式、直譯語言才查未定義的呼叫（編譯型語言交給編譯器）', async () => {
    const kinds = (l, src, ext) => F.semanticIssues(l, src, ext).map((x) => x.kind).sort().join(',');
    assert.strictEqual(kinds('python', 'a, b = 1, 2\nprintb + a)\n'), 'glue'); assert.strictEqual(kinds('c', 'int mainvoid) { return 0; }\n'), 'glue'); assert.strictEqual(kinds('c', 'int main(void) { return 0; }\n'), '', '正常的程式沒有問題');
    assert.strictEqual(kinds('python', 'def add(a, b):\n    return a + b\nprint(add(1))\n'), 'arity', '同一份程式裡的函式簽名'); assert.strictEqual(kinds('python', 'print(add(1, 2, 3))\n', { symbols: { add: 2 } }), 'arity', '外部（計畫）給的簽名');
    assert.strictEqual(kinds('python', 'class A:\n    def get(self):\n        return 1\nA().get()\n'), '', 'self 不算引數個數');
    assert.strictEqual(kinds('c', 'int main(void) { long long a, b; scanf("%lld %lld", &a, &b); return 0; }\n'), ''); assert.strictEqual(kinds('c', 'int main(void) { long long a; scanf("%lld %lld", &a); return 0; }\n'), 'format_count'); assert.strictEqual(kinds('c', 'int main(void) { long long a, b; scanf( &a, &b); return 0; }\n'), 'format_missing');
    assert.strictEqual(kinds('c', 'int main(void) { printf("%d%%\\n", 1); return 0; }\n'), '', '%% 不算轉換說明');
    assert.strictEqual(kinds('python', 'x = foo(3)\nprint(x)\n'), 'unknown_call', '直譯語言執行時才會發現'); assert.strictEqual(kinds('c', 'int main(void) { foo(3); return 0; }\n'), '', '編譯型語言的編譯器會報，不重複');
    assert.strictEqual(kinds('python', 'def f():\n    pass\nf()\n'), '', '有定義的呼叫不算未定義');
    const d = F.semanticDelta(F.semanticIssues('python', 'a, b = 1, 2\nprintb + a)\n'), F.semanticIssues('python', 'a, b = 1, 2\nprint(b + a)\n')); assert.ok(d.delta < 0 && d.resolved.length === 1 && d.introduced.length === 0, JSON.stringify(d));
    assert.deepStrictEqual(F.symbolsFromSignatures(['def add(a, b)', 'int main(void)', 'def get(self)', 'helper']), { add: 2, main: 0, get: 0, helper: null });
    assert.deepStrictEqual(F.symbolsFromModel({ classes: [{ name: 'Cart', attrs: [{ name: 'items' }], ops: [{ name: 'add', params: [{ name: 'i' }] }, { name: 'total', params: [] }] }] }), { Cart: null, items: null, add: 1, total: 0 });
  });
  await t('語意讓修法對：識別字黏合 → 拆開補回 (（python print(a + b)、C int main(void)）；scanf 少逗號 → 補逗號、不刪字串', async () => {
    if ((await R.available('python')).ok) { const r = await F.repairSyntax({ lang: 'python', source: 'a, b = map(int, input().split())\nprinta + b)\n', check }); assert.ok(r.ok && r.source.endsWith('print(a + b)\n'), r.source); assert.ok(/拆成「print」和「a」/.test(r.edits[0].desc)); assert.ok(r.edits[0].semantic.resolved.length === 1, '修法解決了一個語意問題'); }
    if ((await R.available('c')).ok) {
      const c = await F.repairSyntax({ lang: 'c', source: SOL.c.replace('int main(void)', 'int mainvoid)'), check }); assert.ok(c.ok && c.source === SOL.c, c.source + c.reason);
      const sc = await F.repairSyntax({ lang: 'c', source: SOL.c.replace('"%lld %lld", &a', '"%lld %lld" &a'), check }); assert.ok(sc.ok && sc.source === SOL.c, sc.source + sc.reason); assert.ok(sc.source.indexOf('"%lld %lld"') > 0, '字串還在');
    }
  });
  await t('並列時選擇題：提示帶「已定的設計」（外部語意 hints）與思考堆疊標頭（wrap）；選項附語意注意事項', async () => {
    const orig = 'int main(void) {\n  int a = 1\n  int b = 2;\n  return a + b;\n}\n'; let calls = 0;
    const fake = async ({ source }) => { calls++; return source === orig ? { verdict: 'CE', compileLog: "main.c:2:12: error: expected ';' before 'int'\n", detail: 'x' } : { verdict: 'CHECKED' }; }; // 任何改動都算通過 → 必然並列
    let prompt = null; const ask = async (m) => { prompt = m; return { pick: 'A' }; };
    const r = await F.repairSyntax({ lang: 'c', source: orig, check: fake, ask, semantic: { symbols: { main: 0 }, hints: ['函式 int main(void)：入口', 'Cart 有 add(item)'] }, wrap: (m) => m.map((x, i) => (i === m.length - 1 ? Object.assign({}, x, { content: '【目標】測試\n\n' + x.content }) : x)) });
    assert.ok(r.ok && prompt, '有並列所以問了'); const u = prompt[1].content; assert.ok(u.indexOf('已定的設計：') >= 0 && u.indexOf('Cart 有 add(item)') >= 0 && u.startsWith('【目標】測試'), u); assert.ok(/選項：\nA\. /.test(u)); assert.strictEqual(r.choices[0].by, 'model');
  });
  // ---- 系統性評估：對每種語言的 A+B 參考解，一次刪掉一個結構性 token，看修得回多少
  const only = process.argv.slice(2); const table = [];
  for (const lang of Object.keys(F.FAMILY)) {
    if (only.length && !only.includes(lang)) continue; if (!(await R.available(lang)).ok) { console.log('skip - ' + lang); continue; }
    const src = SOL[lang]; const toks = F.lex(lang, src).filter((x) => STRUCT.has(x.v) && x.t !== 'str'); let broken = 0, fixed = 0, ac = 0, acV = 0, tried = 0; const fails = [];
    for (const tk of toks) {
      const bad = src.slice(0, tk.off) + src.slice(tk.end); const c0 = await R.check({ lang, source: bad }); if (c0.verdict !== 'CE') continue; broken++;
      const r = await F.repairSyntax({ lang, source: bad, check }); tried += r.tried;
      const rv = await F.repairSyntax({ lang, source: bad, check, verify: async ({ source }) => (await R.judge({ lang, source, problem: APLUSB })).verdict === 'AC' }); if (rv.ok) { const jv = await R.judge({ lang, source: rv.source, problem: APLUSB }); if (jv.verdict === 'AC') acV++; }
      if (r.ok) { fixed++; const j = await R.judge({ lang, source: r.source, problem: APLUSB }); if (j.verdict === 'AC') ac++; else fails.push(lang + ' 刪「' + tk.v + '」@' + tk.line + ':' + tk.col + ' 修成 ' + j.verdict); } else fails.push(lang + ' 刪「' + tk.v + '」@' + tk.line + ':' + tk.col + ' ' + r.reason);
    }
    table.push({ lang, broken, fixed, ac, acV, avgTried: broken ? +(tried / broken).toFixed(1) : 0, fails });
  }
  console.log('\n語言        壞掉的變體  修到能編譯  純語法修→AC  用測試挑→AC  平均檢查次數');
  for (const r of table) console.log(r.lang.padEnd(10) + String(r.broken).padStart(10) + String(r.fixed).padStart(12) + String(r.ac).padStart(13) + String(r.acV).padStart(13) + String(r.avgTried).padStart(12));
  for (const r of table) for (const f of r.fails.slice(0, 6)) console.log('  ✗ ' + f);
  // 門檻：只擋「明顯退步」；實際數字看上面的表，不要把門檻當成能力宣稱
  for (const r of table) { if (r.broken >= 4) assert.ok(r.fixed / r.broken >= 0.5, r.lang + ' 修復率 ' + r.fixed + '/' + r.broken + ' 低於門檻 50%'); assert.ok(r.acV >= r.ac, r.lang + ' 用測試挑反而比純語法差'); }
  console.log('\n' + n + ' passed'); 
  process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
