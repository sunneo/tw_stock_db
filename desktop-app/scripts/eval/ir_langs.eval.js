// 多語言中間層在真 Electron 的產品入口：convert_code（來源 nodejs／java／c／cpp／csharp／ruby／perl、目標八種、to_uml、types 補型別）與 behavior_card（各語言第二層）。
// 用法：node scripts/eval/real_electron.run.js ir_langs 17991
// 文法：Python 內建；其他語言的 tree-sitter 文法平常第一次用時會連網下載。這裡「不下載」：把本機已存的文法檔（C:\Users\sunneo\.cache\fa-ts，管理者先前經使用者同意放進去的）預先放進文法快取，
//   並攔下所有 http／https 請求（記錄次數、一律拒絕），所以驗到的是宿主程式碼的載入與轉換流程，不含「從網路下載文法」這一步。
const fa = window.fa; const R = {}; const ok = (k, v) => { R[k] = v; };
const net = []; const realFetch = window.fetch.bind(window); window.fetch = (u, o) => { const s = String(u && u.url || u); if (/^https?:/i.test(s)) { net.push(s.slice(0, 120)); return Promise.reject(new Error('eval 攔下網路請求')); } return realFetch(u, o); };
ok('scripts', [].slice.call(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)));
ok('bundle', { modules: Object.keys(FaIrBundle).filter((k) => /^FaIrIn/.test(k)) });
const api = window.desktopAPI; const execApi = api.exec || api.execApi || null; if (execApi && execApi.setSettings) await execApi.setSettings({ execEnabled: true, execConfirmRequired: false });
const SRC = 'file:///C:/Users/sunneo/.cache/fa-ts/'; const seeded = {};
for (const g of ['javascript', 'java', 'c', 'cpp', 'c_sharp', 'ruby']) { try { const r = await realFetch(SRC + 'tree-sitter-' + g + '.wasm'); const buf = await r.arrayBuffer(); await fa.repoWikiCache.put('ts-lang-' + g + '.wasm', 'application/wasm', new Blob([buf]), 'repo_wiki', FaTsAssets.cacheKey(g)); seeded[g] = buf.byteLength; } catch (e) { seeded[g] = 'ERR ' + String(e && e.message || e).slice(0, 60); } }
ok('seeded', seeded);
const avail = {}; for (const l of ['nodejs', 'python', 'java', 'c', 'cpp', 'csharp', 'perl', 'ruby']) { try { avail[l] = await api.judge.available(l); } catch (e) { avail[l] = 'ERR'; } } ok('judge_available', avail);
const call = async (args) => JSON.parse(await fa.tools.convert_code.callback.call(fa, JSON.stringify(args)));
const card = async (args) => JSON.parse(await fa.tools.behavior_card.callback.call(fa, JSON.stringify(args)));
const PYT = '# 計算陣列總和\nfrom typing import List\n\n\ndef total(a: List[int]) -> int:\n    # accumulator\n    s = 0\n    for x in a:  # walk the list\n        s += x\n    return s\n\n\ndef main():\n    n = int(input())\n    a = list(map(int, input().split()))\n    print(total(a))\n\n\nif __name__ == "__main__":\n    main()\n';
const tests = [{ in: '3\n1 2 3\n', out: '6\n' }, { in: '4\n-5 10 -3 7\n', out: '9\n' }];
// ① Python → 各目標（新增的 cpp／csharp／perl／ruby 輸出器；有判題器的語言實際跑）
const tg = {}; for (const t of ['nodejs', 'cpp', 'csharp', 'perl', 'ruby']) { const r = await call({ source: PYT, target: t, tests: avail[t] && avail[t].ok ? tests : undefined }); tg[t] = { ok: r.ok, verified: r.verified, verdict: r.verdict, note: r.verifyNote, err: r.error, hasComment: /walk the list/.test(r.code || ''), diag: (r.diags || []).slice(0, 2).map((d) => d.msg) }; } ok('python_to_targets', tg);
// ② 各語言當來源：先由 Python 產生該語言的程式，再 來源 → python（用 python 判題器實跑）→ 與 to_uml、behavior_card
const langs = ['nodejs', 'java', 'c', 'cpp', 'csharp', 'ruby', 'perl']; const per = {};
for (const l of langs) {
    const gen = await call({ source: PYT, target: l }); const o = { gen_ok: gen.ok }; if (!gen.ok) { per[l] = o; continue; }
    const back = await call({ source: gen.code, from: l, target: 'python', tests }); o.to_python = { ok: back.ok, verified: back.verified, verdict: back.verdict, note: back.verifyNote, err: back.error, keepComment: /walk the list/.test(back.code || '') };
    const uml = await call({ source: gen.code, from: l, action: 'to_uml' }); o.to_uml = { ok: uml.ok, ops: uml.model && uml.model.classes[0].ops.map((x) => x.name), usecase: uml.model && uml.model.usecases.map((u) => u.steps.map((s) => s.msg)), mermaid: !!(uml.mermaid && /classDiagram/.test(uml.mermaid.class)), err: uml.error };
    const bc = await card({ source: gen.code, language: l === 'nodejs' ? 'nodejs' : l }); o.behavior_card = { ok: bc.ok, level: bc.level, names: (bc.cards || []).map((c) => c.name), mainCalls: (bc.cards || []).find((c) => c.name === 'main') && bc.cards.find((c) => c.name === 'main').calls, err: bc.error, note: bc.note };
    per[l] = o;
}
ok('sources', per);
// ③ 沒標型別的 JavaScript → java：needTypes → 補 types → 成功
const JS = 'function sum(a) {\n  let s = 0;\n  for (const x of a) { s += x; }\n  return s;\n}\n';
const r1 = await call({ source: JS, from: 'nodejs', target: 'java' }); const r2 = await call({ source: JS, from: 'nodejs', target: 'java', types: { 'sum.a': 'list<int>', 'sum.return': 'int' } });
ok('needTypes', { first_ok: r1.ok, need: (r1.needTypes || []).map((x) => x.key), error: r1.error, second_ok: r2.ok, applied: r2.typeApply && r2.typeApply.applied });
ok('python_to_uml', await (async () => { const u = await call({ source: PYT, action: 'to_uml' }); return { ok: u.ok, dslHead: String(u.uml || '').split('\n').slice(0, 6), mermaidSeq: !!(u.mermaid && u.mermaid.sequence) }; })());
ok('network_requests_blocked', net);
return R;
