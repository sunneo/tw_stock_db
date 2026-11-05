// 寫程式／修程式（真實 Electron；模型用假的、判題器用真的：renderer → preload → IPC → main 的 judge-runner）。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/code_agent.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
// 一定要用全新的 --user-data-dir：這支會把「允許AI執行程式」打開、關掉確認框（只在這個暫時的資料夾裡）。
const fa = window.fa; const R = {}; const ok = (name, v) => { R[name] = v; };
const J = window.desktopAPI && window.desktopAPI.judge; ok('judge_api', !!(J && J.run && J.check && J.available));
const api = window.desktopAPI; const execApi = api.exec || api.execApi || null; ok('exec_api', execApi ? Object.keys(execApi).join(',') : 'none');
if (execApi && execApi.setSettings) await execApi.setSettings({ execEnabled: true, execConfirmRequired: false });
ok('available_python', await J.available('python')); ok('available_bad', (await J.available('cobol')).ok);
const P = { id: 'ab', tests: [{ in: '1 2\n', out: '3\n' }, { in: '-5 3\n', out: '-2\n' }], hidden: [{ in: '1000000000 1000000000\n', out: '2000000000\n' }] };
const SRC = 'a, b = map(int, input().split())\nprint(a + b)\n';
const r1 = await J.run({ lang: 'python', source: SRC, problem: P }); ok('run_python', { verdict: r1.verdict, passed: r1.passed, total: r1.total, sandbox: !!r1.sandbox });
ok('run_wa', (await J.run({ lang: 'python', source: 'print(0)\n', problem: P })).verdict);
ok('run_syntax_is_CE', (await J.run({ lang: 'python', source: 'def f(:\n', problem: P })).verdict);
ok('check_ok', (await J.check({ lang: 'python', source: 'print(1)\n' })).verdict); ok('check_bad_lang', (await J.check({ lang: 'cobol', source: 'x' })).ok);
ok('run_too_big', (await J.run({ lang: 'python', source: 'x'.repeat(300 * 1024), problem: P })).ok);
ok('tools_registered', ['write_code', 'fix_code'].map((n) => !!fa.tools[n]));
ok('plan_caps', { caps: FaPlan.CAPS.filter((c) => /^local_write_code_/.test(c.tool)).map((c) => c.tool), goals: FaPlan.GOALS.filter((g) => /code_program|uml_project/.test(g.id)).map((g) => g.id), perLanguage: typeof FaLangColu !== 'undefined' && FaLangColu.languages.length, grammar: typeof FaGrammar !== 'undefined' && FaGrammar.LANGS.length, guided: typeof FaGuidedWrite !== 'undefined' });
ok('modules', ['FaSyntaxFix', 'FaCodeLoop', 'FaCodeProject', 'FaCodeEdit', 'FaCodeAgent'].map((n) => { try { return typeof eval(n) === 'object'; } catch (_) { return false; } }));
// 假模型：切成 add＋main；寫對的程式
const gen = async (req) => {
  const sys = (req.messages.find((m) => m.role === 'system') || {}).content || ''; const all = req.messages.map((m) => m.content).join('\n');
  if (sys.indexOf('切成幾個小函式') >= 0) return '{"functions":[{"name":"add","signature":"def add(a, b)","purpose":"相加","calls":[]},{"name":"main","signature":"def main()","purpose":"讀輸入並輸出","calls":["add"]}]}';
  if (sys.indexOf('你在除錯') >= 0) return '{"fix":"A"}';
  if (/現在寫：add/.test(all)) return '```python\ndef add(a, b):\n    return a + b\n```';
  if (/現在寫：main/.test(all)) return '```python\ndef main()\n    a, b = map(int, input().split())\n    print(add(a, b))\n```'; // 故意缺冒號：要由程式修，不是模型重寫
  return '';
};
const prog = []; const orig = fa._createProgressWidget; fa._createProgressWidget = (t) => { const w = orig.call(fa, t); const log = w.log; w.log = (l) => { prog.push(String(l)); return log && log.call(w, l); }; return w; };
const w = await fa._codeAgent({ task: '輸入兩個整數，輸出它們的和', language: 'python', tests: P.tests, _gen: gen });
ok('write_code', { ok: w.ok, verified: w.verified, mode: w.mode, lang: w.lang, rethinks: w.rethinks, calls: w.calls, gaps: w.gaps, report_has_verified: /已用測試驗證/.test(w.report || ''), has_sandbox_note: !!w.sandbox, progress: prog.filter((x) => /語法修正|切割|驗收/.test(x)).length });
const f = JSON.parse(await fa.tools.fix_code.callback.call(fa, JSON.stringify({ source: 'def main()\n    print(1)\n\nmain()\n', language: 'python' })));
ok('fix_code_nomodel', { ok: f.ok, verified: f.verified, verdict: f.verdict, mode: f.mode, diff: /\+def main\(\):/.test(f.diff || ''), edits: (f.edits || []).length });
ok('fix_code_missing', JSON.parse(await fa.tools.fix_code.callback.call(fa, JSON.stringify({}))).ok);
const wr = JSON.parse(await fa.tools.write_code.callback.call(fa, JSON.stringify({ task: '寫一個程式', language: 'cobol' }))); ok('write_code_bad_lang', { ok: wr.ok, error: String(wr.error || '').slice(0, 40) });
return R;
