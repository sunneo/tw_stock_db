// merge diff patcher（真實 Electron：renderer 的 FaCodePatch → preload → IPC → main 的 judge-runner 當語法檢查與判題）。
// 語言用 nodejs：這台 Windows 的 judge-runner 找不到 python3（只有 Store 的假檔）。
// 用法：node scripts/eval/code_patch.run.js（它會：獨立暫存 --user-data-dir、main-ext-rev.txt、換埠、FA_DISABLE_MAIN_OVERLAY=1，印出 [eval-file] 結果）。
const fa = window.fa; const R = {}; const ok = (k, v) => { R[k] = v; };
const J = window.desktopAPI && window.desktopAPI.judge; ok('judge_api', !!(J && J.run && J.check));
const api = window.desktopAPI; const execApi = api.exec || api.execApi || null; if (execApi && execApi.setSettings) await execApi.setSettings({ execEnabled: true, execConfirmRequired: false });
ok('scripts', [].slice.call(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)));
ok('node_available', await J.available('nodejs'));
ok('tool_registered', !!fa.tools && !!fa.tools.merge_patch); ok('module', typeof FaCodePatch === 'object');
const ORIG = ['const t = require("fs").readFileSync(0, "utf8").trim().split(" ");', 'function add(a, b) {', '    return a + b;', '}', '', 'function mul(a, b) {', '    return a * b;', '}', '', 'function main() {', '    const x = +t[0], y = +t[1];', '    console.log(add(x, y));', '    console.log(mul(x, y));', '}', '', 'main();', ''].join('\n');
const tests = [{ in: '2 3\n', out: '5\n6\n' }, { in: '4 5\n', out: '9\n20\n' }];
// 修補（在「原版」上產生）：mul 多加 0
const FIXED = ORIG.replace('return a * b;', 'return a * b + 0;'); const diff = FaCodePatch.makeDiff(ORIG, FIXED, { oldName: 'a/m.js', newName: 'b/m.js' });
// 使用者在合併前改過：上面加了註解與一個函式、main 的行加了註解（行號全位移、脈絡被動過）
const USER = '// 使用者加的註解\n// 第二行\nfunction sub(a, b) {\n    return a - b;\n}\n\n' + ORIG.replace('function main() {', 'function main() {  // 入口').replace('console.log(add(x, y));', 'console.log(add(x, y));  // 加法');
const run = async (src, d, extra) => { const r = await fa._codePatch(Object.assign({ source: src, diff: d, language: 'nodejs', tests }, extra)); return { ok: r.ok, status: r.status, verified: r.verified, hunks: (r.hunks || []).map((h) => h.status + '@' + h.line + '+' + h.offset), rolledBack: !!r.rolledBack, sourceUnchanged: r.source === src, reason: (r.reason || '').slice(0, 200), src: r.source }; };
const a = await run(USER, diff); ok('user_edited_merge', { ok: a.ok, status: a.status, verified: a.verified, hunks: a.hunks, reason: a.reason, keepsUserEdits: /使用者加的註解/.test(a.src) && /function sub/.test(a.src) && /\/\/ 入口/.test(a.src) && /\/\/ 加法/.test(a.src), hasFix: /a \* b \+ 0/.test(a.src) });
const bad = FaCodePatch.makeDiff(ORIG, ORIG.replace('return a * b;', 'return a * (b;'), {}); const b = await run(USER, bad); ok('syntax_break_rollback', { ok: b.ok, status: b.status, rolledBack: b.rolledBack, unchanged: b.sourceUnchanged, reason: b.reason });
const wrong = FaCodePatch.makeDiff(ORIG, ORIG.replace('return a * b;', 'return a - b;'), {}); const c = await run(USER, wrong); ok('wrong_answer_rollback', { ok: c.ok, status: c.status, rolledBack: c.rolledBack, unchanged: c.sourceUnchanged, reason: c.reason });
const conflictUser = ORIG.replace('return a * b;', 'return a * b * 1;'); const d = await run(conflictUser, diff); ok('conflict_rollback', { ok: d.ok, status: d.status, rolledBack: d.rolledBack, unchanged: d.sourceUnchanged, reason: d.reason });
const e = await run(a.src, diff); ok('idempotent', { ok: e.ok, status: e.status, unchanged: e.sourceUnchanged });
const tool = JSON.parse(await fa.tools.merge_patch.callback.call(fa, JSON.stringify({ source: USER, diff, language: 'nodejs', tests }))); ok('tool_entry', { ok: tool.ok, status: tool.status });
return R;
