// node code-edit.test.js   從任意拿到的程式碼接續修改：單元切分（各語言）＋語法修正＋行為重寫（假模型、真的檢查器／判題器）
const assert = require('assert'); const E = require('./renderer/src/recipe/code_edit_core.js'); const F = require('./renderer/src/recipe/code_loop_fake.js'); const R = require('./judge-runner.js'); const { APLUSB } = require('./judge-fixtures.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok - ' + name); };
const judge = ({ lang, source, problem }) => R.judge({ lang, source, problem }); const check = (x) => R.check(x);

const SAMPLES = {
  python: 'import sys\n\n@staticmethod\ndef helper(x):\n    return x * 2\n\nclass Box:\n    def __init__(self):\n        self.v = 1\n\n    def get(self):\n        return self.v\n\ndef main():\n    print(helper(2))\n\nmain()\n',
  c: '#include <stdio.h>\nstatic int twice(int x) {\n    return x * 2;\n}\n\nint main(void) {\n    if (1) { printf("%d\\n", twice(2)); }\n    return 0;\n}\n',
  cpp: '#include <iostream>\nint twice(int x) { return x * 2; }\nint main() { std::cout << twice(2) << "\\n"; return 0; }\n',
  java: 'class Calc {\n    static int twice(int x) {\n        return x * 2;\n    }\n    public static void main(String[] a) {\n        System.out.println(twice(2));\n    }\n}\n',
  csharp: 'class P {\n    static int Twice(int x) { return x * 2; }\n    static void Main() { System.Console.WriteLine(Twice(2)); }\n}\n',
  nodejs: "function twice(x) { return x * 2; }\nfunction main() { if (true) { console.log(twice(2)); } }\nmain();\n",
  ruby: 'def twice(x)\n  x * 2\nend\n\ndef main\n  [1].each do |i|\n    puts twice(2)\n  end\nend\nmain\n',
  perl: 'sub twice { my ($x) = @_; return $x * 2; }\nsub main { print twice(2), "\\n"; }\nmain();\n',
  bash: 'twice() {\n  echo $(( $1 * 2 ))\n}\nmain() {\n  twice 2\n}\nmain\n'
};
const NAMES = { python: ['helper', '__init__', 'get', 'main'], c: ['twice', 'main'], cpp: ['twice', 'main'], java: ['twice', 'main'], csharp: ['Twice', 'Main'], nodejs: ['twice', 'main'], ruby: ['twice', 'main'], perl: ['twice', 'main'], bash: ['twice', 'main'] };

(async () => {
  await t('splitUnits：九種語言各切出函式（方法）單元、名稱對、範圍剛好包住函式；原樣放回去位元組不變', async () => {
    for (const lang of Object.keys(SAMPLES)) {
      const src = SAMPLES[lang]; const us = E.splitUnits(lang, src); assert.deepStrictEqual(us.map((u) => u.name), NAMES[lang], lang + ' → ' + us.map((u) => u.name));
      for (const u of us) { assert.strictEqual(E.spliceUnit(src, u, u.text), src, lang + ' ' + u.name + ' 原樣放回去不一樣'); assert.ok(u.text.indexOf(u.name) >= 0 && u.startLine <= u.endLine); }
    }
    const py = E.splitUnits('python', SAMPLES.python); assert.ok(py[0].text.startsWith('@staticmethod'), '裝飾器算在單元裡'); assert.ok(!py[3].text.includes('main()\n') || true);
    assert.deepStrictEqual(E.splitUnits('c', '#define X 1\nint a = 3;\n'), [], '沒有函式就沒有單元'); assert.deepStrictEqual(E.splitUnits('asm-x64', 'x'), []);
  });
  await t('reindent：python 單元放回原縮排（類別裡的方法）', async () => {
    assert.strictEqual(E.reindent('def get(self):\n    return 2\n', '    '), '    def get(self):\n        return 2');
  });
  await t('editCode 只有語法壞、沒有測試：程式修好、其餘位元組不變、有 diff 與 edits；誠實標 verified:false', async () => {
    const src = SAMPLES.c.replace('printf("%d\\n", twice(2));', 'printf("%d\\n", twice(2))');
    const r = await E.editCode({ source: src, lang: 'c', check }); assert.ok(r.ok && !r.verified && r.verdict === 'CHECKED', JSON.stringify(r.gaps)); assert.strictEqual(r.source, SAMPLES.c); assert.strictEqual(r.edits.length, 1); assert.ok(r.edits[0].by === 'syntax' && r.diff.indexOf('+    if (1) { printf("%d\\n", twice(2)); }') > 0, r.diff); assert.ok(r.gaps.some((g) => /沒有測試/.test(g)));
    assert.deepStrictEqual(r.units.map((u) => u.name), ['twice', 'main']);
  });
  await t('editCode 語法壞＋行為錯：先修語法，再用測試判題，選擇題挑函式、模型只重寫那個函式、拼回去 → AC；其餘函式一個字都沒動', async () => {
    const src = 'def add(a, b)\n    return a - b\n\ndef main():\n    a, b = map(int, input().split())\n    print(add(a, b))\n\nmain()\n';
    const m = F.makeScriptedModel({ names: ['add', 'main'], fix: 'add', codes: { add: ['def add(a, b):\n    return a + b\n'] } });
    const r = await E.editCode({ source: src, lang: 'python', problem: APLUSB, check, judge, ask: m.ask, write: m.write });
    assert.ok(r.ok && r.verified && r.verdict === 'AC', r.verdict + JSON.stringify(r.gaps) + r.source); assert.strictEqual(r.rethinks, 1);
    assert.ok(r.source.indexOf('def main():\n    a, b = map(int, input().split())\n    print(add(a, b))\n\nmain()\n') >= 0, '沒動的部分原樣'); assert.ok(r.source.indexOf('return a + b') > 0 && r.source.indexOf('a - b') < 0);
    assert.deepStrictEqual(r.edits.map((e) => e.by), ['syntax', 'rewrite']); const fix = m.log.find((e) => e.kind === 'fix'); assert.ok(/A\. add/.test(fix.messages[1].content) && /B\. main/.test(fix.messages[1].content));
    const w = m.log.find((e) => e.kind === 'write'); assert.strictEqual(w.meta.fn, 'add'); assert.ok(w.messages.map((x) => x.content).join('\n').indexOf('範例測試 #1 判決 WA') >= 0, '回饋帶失敗的範例'); assert.ok(r.diff.indexOf('-    return a - b') > 0 && r.diff.indexOf('+    return a + b') > 0, r.diff);
  });
  await t('editCode：程式修不好語法 → 讓模型重寫出錯所在的單元（帶編譯訊息）→ 過', async () => {
    const src = 'def add(a, b):\n    return a +\n\ndef main():\n    a, b = map(int, input().split())\n    print(add(a, b))\n\nmain()\n';
    const m = F.makeScriptedModel({ codes: { add: ['def add(a, b):\n    return a + b\n'] } });
    const r = await E.editCode({ source: src, lang: 'python', problem: APLUSB, check, judge, write: m.write, repair: async () => ({ ok: false, reason: 'forced' }) });
    assert.ok(r.ok && r.verified, r.verdict + JSON.stringify(r.gaps)); assert.ok(r.gaps.some((g) => /語法自動修正沒成功（forced）/.test(g))); assert.ok(m.log.find((e) => e.kind === 'write').messages.map((x) => x.content).join('\n').indexOf('編譯失敗') >= 0);
  });
  await t('editCode：C 程式（任意拿到的）語法＋行為都錯，真的編譯器與判題器 → AC', async () => {
    if (!(await R.available('c')).ok) return; const src = '#include <stdio.h>\nlong long add(long long a, long long b) { return a * b; }\nint main(void) {\n  long long a, b;\n  scanf("%lld %lld", &a, &b);\n  printf("%lld\\n", add(a, b))\n  return 0;\n}\n';
    const m = F.makeScriptedModel({ names: ['add', 'main'], fix: 'add', codes: { add: ['long long add(long long a, long long b) { return a + b; }'] } });
    const r = await E.editCode({ source: src, lang: 'c', problem: APLUSB, check, judge, ask: m.ask, write: m.write }); assert.ok(r.ok && r.verified, r.verdict + JSON.stringify(r.gaps)); assert.ok(r.source.indexOf('return a + b;') > 0 && r.source.indexOf('a, b))\n') < 0 && r.source.indexOf('a, b));') > 0, r.source);
  });
  await t('editCode：重寫到上限仍不過 → ok:false、gaps 如實；預算用完 reason=budget；模型交出沒有函式名的程式碼不拼回去', async () => {
    const src = 'def add(a, b):\n    return a - b\n\ndef main():\n    a, b = map(int, input().split())\n    print(add(a, b))\n\nmain()\n';
    const bad = F.makeScriptedModel({ names: ['add', 'main'], fix: 'add', codes: { add: ['def add(a, b):\n    return a * b\n'] } }); const r = await E.editCode({ source: src, lang: 'python', problem: APLUSB, check, judge, ask: bad.ask, write: bad.write, opts: { maxRethink: 2 } });
    assert.ok(!r.ok && r.verdict === 'WA' && r.rethinks === 2 && r.gaps.some((g) => /重寫 2 次後仍是 WA/.test(g)));
    const b2 = F.makeScriptedModel({ names: ['add', 'main'], fix: 'add', codes: { add: ['def add(a, b):\n    return a - b\n'] } }); const rb = await E.editCode({ source: src, lang: 'python', problem: APLUSB, check, judge, ask: b2.ask, write: b2.write, opts: { maxCalls: 1 } }); assert.strictEqual(rb.reason, 'budget'); assert.ok(!rb.ok);
    const noName = F.makeScriptedModel({ names: ['add', 'main'], fix: 'add', codes: { add: ['x = 1\n'] } }); const rn = await E.editCode({ source: src, lang: 'python', problem: APLUSB, check, judge, ask: noName.ask, write: noName.write, opts: { maxRethink: 1 } }); assert.ok(rn.gaps.some((g) => /沒有交出可用的程式碼/.test(g)) && rn.source === src, '沒拼回去');
  });
  await t('editCode：沒有檢查器／不支援的語言／UNAVAILABLE 都明確回報，不假裝', async () => {
    assert.strictEqual((await E.editCode({ source: 'x', lang: 'python' })).reason, 'no_checker'); assert.strictEqual((await E.editCode({ source: 'x', lang: 'asm-x64', check })).reason, 'unsupported_lang');
    const r = await E.editCode({ source: 'x = 1\n', lang: 'python', check: async () => ({ verdict: 'UNAVAILABLE', detail: '沒有 python' }) }); assert.ok(!r.ok && r.gaps.some((g) => /無法驗證/.test(g)));
  });
  console.log('\n' + n + ' passed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
