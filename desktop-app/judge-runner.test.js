// node judge-runner.test.js [語言...]   例：node judge-runner.test.js asm-x86
// 這台機器沒有的工具鏈會印 skip（UNAVAILABLE），不算失敗，也不算通過；最後會列出哪些語言真的驗證過。
const R = require('./judge-runner.js'); const assert = require('assert');

const { APLUSB, SOL } = require('./judge-fixtures.js');

let n = 0, skipped = [], verified = [];
const t = async (name, fn) => { await fn(); n++; console.log('ok - ' + name); };

(async () => {
  const only = process.argv.slice(2); const langs = R.ORDER.filter((l) => !only.length || only.includes(l));
  for (const lang of langs) {
    const av = await R.available(lang);
    if (!av.ok) { skipped.push(lang + '（' + av.reason + '）'); console.log('skip - ' + lang + '：' + av.reason); continue; }
    await t(lang + ' 的 A+B 參考解全部 AC（' + av.version + '）', async () => {
      const r = await R.judge({ lang, source: SOL[lang], problem: APLUSB });
      assert.strictEqual(r.verdict, 'AC', lang + ' → ' + r.verdict + ' ' + r.detail);
      assert.strictEqual(r.passed, 5); assert.deepStrictEqual(r.hidden, { passed: 2, total: 2 });
    });
    verified.push(lang);
  }
  if (!only.length || only.includes('python')) {
    await t('WA：答案錯（印 a-b）', async () => { const r = await R.judge({ lang: 'python', source: 'a,b=map(int,input().split())\nprint(a-b)\n', problem: APLUSB }); assert.strictEqual(r.verdict, 'WA'); assert.strictEqual(r.failedIndex, 0); assert.ok(/第 1 個詞/.test(r.detail), r.detail); });
    await t('只過範例、hidden 失敗（寫死範例答案）→ WA，visible 全過、hidden 沒過', async () => {
      const cheat = 'import sys\nd={"1 2":"3","-5 3":"-2","0 0":"0"}\nprint(d.get(sys.stdin.read().strip(),"0"))\n';
      const r = await R.judge({ lang: 'python', source: cheat, problem: APLUSB });
      assert.strictEqual(r.verdict, 'WA'); assert.deepStrictEqual(r.visible, { passed: 3, total: 3 }); assert.strictEqual(r.hidden.passed, 0); assert.ok(r.detail.indexOf('[hidden]') >= 0, r.detail);
    });
    await t('TLE：無窮迴圈會被殺掉，且沒有殘留行程', async () => { const t0 = Date.now(); const r = await R.judge({ lang: 'python', source: 'while True: pass\n', problem: APLUSB, timeoutMs: 400, stopAtFirstFail: true }); assert.strictEqual(r.verdict, 'TLE'); assert.ok(Date.now() - t0 < 4000); });
    await t('TLE：子行程睡著不退出，整個行程群組都被殺', async () => { const r = await R.judge({ lang: 'bash', source: 'sleep 30 & wait\n', problem: APLUSB, timeoutMs: 400, stopAtFirstFail: true }); assert.strictEqual(r.verdict, 'TLE'); });
    await t('RE：丟例外、非 0 結束碼', async () => { const r = await R.judge({ lang: 'python', source: 'raise SystemExit(3)\n', problem: APLUSB }); assert.strictEqual(r.verdict, 'RE'); assert.ok(/結束碼 3/.test(r.detail), r.detail); });
    await t('OLE：輸出爆量會被截止', async () => { const r = await R.judge({ lang: 'python', source: 'import sys\nwhile True: sys.stdout.write("x"*65536)\n', problem: APLUSB, timeoutMs: 5000, maxOutput: 1 << 16, stopAtFirstFail: true }); assert.strictEqual(r.verdict, 'OLE'); });
    await t('stdin 沒讀完就結束不會掛住也不會丟 EPIPE', async () => { const r = await R.judge({ lang: 'python', source: 'print(3)\n', problem: { id: 'x', tests: [{ in: '1 '.repeat(500000), out: '3' }] } }); assert.strictEqual(r.verdict, 'AC'); });
    await t('題目格式不對會丟錯；不認得的語言回 UNAVAILABLE 以外的明確訊息', async () => {
      await assert.rejects(() => R.judge({ lang: 'python', source: '', problem: { id: 'x', tests: [] } }), /題目格式不對/);
      const r = await R.judge({ lang: 'cobol', source: '', problem: APLUSB }); assert.ok(/不認得/.test(r.detail));
    });
  }
  if ((!only.length || only.includes('c')) && (await R.available('c')).ok)
    await t('CE：C 語法錯誤 → 每一筆測試都是 CE，帶編譯器訊息', async () => { const r = await R.judge({ lang: 'c', source: 'int main( { return 0 }\n', problem: APLUSB }); assert.strictEqual(r.verdict, 'CE'); assert.strictEqual(r.passed, 0); assert.ok(r.compileLog.length > 0); });
  if ((!only.length || only.includes('java')) && (await R.available('java')).ok)
    await t('Java：公開類別不叫 Main（檔名是 Main.java）→ 編譯就失敗 CE，不是 AC', async () => { const r = await R.judge({ lang: 'java', source: SOL.java.replace('class Main', 'class Other'), problem: APLUSB }); assert.strictEqual(r.verdict, 'CE'); });
  // 解釋型語言的語法錯誤是啟動時報的 → CE（帶訊息）；執行期才丟出的例外（含 eval 丟的 SyntaxError）仍是 RE
  for (const lang of langs) {
    if (!['python', 'nodejs', 'ruby', 'perl', 'bash'].includes(lang) || !(await R.available(lang)).ok) continue;
    const BADRUN = { python: 'def f(:\n  pass\n', nodejs: 'function f( {\n', ruby: 'def f(\n', perl: 'sub {\n', bash: 'if then fi (\n' };
    await t(lang + '：語法壞的程式用 judge 跑 → CE（帶訊息），不是 RE', async () => { const r = await R.judge({ lang, source: BADRUN[lang], problem: APLUSB }); assert.strictEqual(r.verdict, 'CE', lang + ' → ' + r.verdict + ' ' + r.detail); assert.ok(r.compileLog.length > 0); assert.strictEqual(r.passed, 0); });
  }
  if (!only.length || only.includes('python')) await t('執行期才丟的例外仍是 RE：ZeroDivisionError、eval 丟的 SyntaxError、非 0 結束碼', async () => {
    for (const src of ['print(1/0)\n', 'eval("1+")\n', 'import sys\nsys.exit(2)\n']) { const r = await R.judge({ lang: 'python', source: src, problem: APLUSB }); assert.strictEqual(r.verdict, 'RE', src + ' → ' + r.verdict); }
  });
  // check：只編譯／語法檢查。好的參考解 → CHECKED；各語言一份語法錯誤 → CE；不執行（無窮迴圈也立刻回來）
  const BAD = { python: 'def f(:\n  pass\n', nodejs: 'function (', c: 'int main( { return 0 }\n', cpp: 'int main( { return 0 }\n', java: 'class Main { void f( }\n', ruby: 'def f(\n', perl: 'sub { \n', bash: 'if then fi (\n', csharp: 'class P { void f( }\n', 'asm-x64': '.intel_syntax noprefix\n  bogus_op eax, ebx, ecx\n', 'asm-x86': '.intel_syntax noprefix\n  bogus_op eax, ebx, ecx\n' };
  for (const lang of langs) {
    const av = await R.available(lang); if (!av.ok) continue;
    await t(lang + ' check：參考解 CHECKED、語法錯誤 CE', async () => {
      const ok = await R.check({ lang, source: SOL[lang] }); assert.strictEqual(ok.verdict, 'CHECKED', lang + ' ' + ok.detail);
      const bad = await R.check({ lang, source: BAD[lang] }); assert.strictEqual(bad.verdict, 'CE', lang + ' 壞程式沒被擋下'); assert.ok(bad.compileLog.length > 0);
    });
  }
  if (!only.length || only.includes('python')) {
    await t('check 不會執行程式：無窮迴圈的合法程式立刻 CHECKED；不認得的語言回 UNAVAILABLE', async () => {
      const t0 = Date.now(); const r = await R.check({ lang: 'python', source: 'while True: pass\n' }); assert.strictEqual(r.verdict, 'CHECKED'); assert.ok(Date.now() - t0 < 3000);
      assert.strictEqual((await R.check({ lang: 'cobol', source: '' })).verdict, 'UNAVAILABLE');
    });
  }
  console.log('\n' + n + ' passed');
  console.log('驗證過的語言：' + (verified.join(', ') || '（無）'));
  if (skipped.length) console.log('沒驗證（工具鏈不在或跑不起來）：' + skipped.join('；'));
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
