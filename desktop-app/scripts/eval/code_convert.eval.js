// convert_code（區塊／程式 → 中間語言 → nodejs／java／c）在真 Electron 的產品入口。用法：node scripts/eval/real_electron.run.js code_convert
const fa = window.fa; const R = {}; const ok = (k, v) => { R[k] = v; };
const api = window.desktopAPI; const execApi = api.exec || api.execApi || null; if (execApi && execApi.setSettings) await execApi.setSettings({ execEnabled: true, execConfirmRequired: false });
ok('scripts', [].slice.call(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)));
ok('bundle', typeof FaIrBundle === 'object' && !!FaIrBundle.FaIrBlocks); ok('tool', !!fa.tools.convert_code);
ok('node_available', await api.judge.available('nodejs'));
const PY = '# 計算陣列總和\ndef total(a):\n    # accumulator\n    s = 0\n    for x in a:  # walk the list\n        s += x\n    return s\n\n\ndef main():\n    n = int(input())\n    a = list(map(int, input().split()))\n    print(total(a))\n\n\nmain()\n';
const PYT = '# 計算陣列總和\nfrom typing import List\n\n\ndef total(a: List[int]) -> int:\n    s = 0\n    for x in a:  # walk the list\n        s += x\n    return s\n\n\ndef main():\n    n = int(input())\n    a = list(map(int, input().split()))\n    print(total(a))\n\n\nif __name__ == "__main__":\n    main()\n';
const tests = [{ in: '3\n1 2 3\n', out: '6\n' }, { in: '4\n-5 10 -3 7\n', out: '9\n' }];
const call = async (args) => JSON.parse(await fa.tools.convert_code.callback.call(fa, JSON.stringify(args)));
const js = await call({ source: PY, target: 'nodejs', tests }); ok('python_to_nodejs_module_level_main', { count_main_calls: (js.code.match(/^main\(\);/gm) || []).length });
ok('python_to_nodejs', { ok: js.ok, verified: js.verified, verdict: js.verdict, hasComment: /walk the list/.test(js.code || ''), report: js.report });
const via = await call({ source: PY, target: 'nodejs', keep_blocks: true, tests }); ok('via_blocks_nodejs', { ok: via.ok, verified: via.verified, comments: via.comments });
const tb = await call({ source: PY, action: 'to_blocks' }); ok('to_blocks', { ok: tb.ok, funcs: (tb.funcs || []).map((f) => f.name), cnl_total: (tb.funcs || []).find((f) => f.name === 'total') && tb.funcs.find((f) => f.name === 'total').cnl });
const fromBlocks = await call({ blocks: tb.funcs.map((f) => ({ name: f.name, params: f.params, cnl: f.cnl })), target: 'nodejs', tests }); ok('blocks_to_nodejs', { ok: fromBlocks.ok, verified: fromBlocks.verified });
// java／c 只產生不實跑：這台機器 javac 很慢（單次超過 100 秒）、C 編譯器缺系統標頭；實跑由 ir_blocks.test.js 驗 java
const jv = await call({ source: PYT, target: 'java' }); ok('python_to_java', { ok: jv.ok, verified: jv.verified, verdict: jv.verdict, note: jv.verifyNote, diag: (jv.diags || []).slice(0, 2) });
const c = await call({ source: PYT, target: 'c' }); ok('python_to_c', { ok: c.ok, verified: c.verified, verdict: c.verdict, note: c.verifyNote, diag: (c.diags || []).slice(0, 2) });
const untyped = await call({ source: PY, target: 'java' }); ok('java_untyped_inferred_from_callsite', { ok: untyped.ok, why: (untyped.diags || []).map((d) => d.msg).slice(0, 2) });
const rej = await call({ source: 'def f(d):\n    return {k: v for k, v in d.items()}\n\nprint(f({1: 2}))\n', target: 'c' }); ok('c_rejects_dict', { ok: rej.ok, error: rej.error, diags: (rej.diags || []).length });
const bad = await call({ target: 'nodejs' }); ok('missing_args', bad.ok === false);
const unsupported = await call({ source: PY, target: 'rust' }); ok('unsupported_target', { ok: unsupported.ok, error: unsupported.error });
// /code 路由
const slash = fa.slashCommands.get('/code'); ok('slash_registered', !!slash);
return R;
