// 用法：FA_DEBUG_EVAL_FILE=<本檔絕對路徑> FA_DISABLE_MAIN_OVERLAY=1 FA_BROWSER_CONTROL_PORT=17938 electron.exe <desktop-app路徑> --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
// YAML 範本在真 Electron 模擬器實跑：
//   1. 內建的 demo/todo_yaml（.yaml）直接 guitpl.run：開窗、輸入文字、點新增、清單真的多一項、Ctrl+Enter 也能新增。
//   2. 編譯成單一檔（standalone）後直接執行（內嵌 YAML 與它的解析器）。
//   3. 模型自寫的 YAML（gui_template_compose 的 yaml 欄位）→ 組合 → 執行。
const fa = window.fa;
const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { /* 還沒好 */ } await wait(120); } return null; };
const termText = (session) => { const b = session.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); } return out.join('\n'); };
const t = await fa._createTerminalForAI({ name: 'yaml-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
const put = (name, text) => fa._writeBytesToTerminalFs(fsStore, '/work/' + name, new TextEncoder().encode(text));
const cnt = (re) => (termText(session).match(re) || []).length;
const W = () => document.querySelector('.gui-window[data-window]');

async function runApp(label, code, actions) {
  const r = {};
  R[label] = r;
  const e0 = cnt(/Y-END/g), tb0 = cnt(/Traceback/g);
  put('y_run.py', 'import gui\n' + code + 'print("Y-END")\n');
  let done = false;
  fa._runTerminalCommand(session, 'python3 y_run.py').then(() => { done = true; }, () => { done = true; });
  await until(() => W() && W().querySelector('.gui-label'), 25000);
  await wait(1500);
  r.window_rendered = !!W();
  if (W()) await actions(r);
  document.querySelectorAll('.gui-window[data-window] .gui-close').forEach((c) => c.click());
  await until(() => done, 15000);
  await until(() => cnt(/Y-END/g) > e0, 6000);
  r.ended = cnt(/Y-END/g) > e0;
  r.traceback = cnt(/Traceback/g) - tb0;
  r.ok = !!(r.window_rendered && r.ended && !r.traceback && r.actions_ok !== false);
}

const todoActions = async (r) => {
  const inp = W().querySelector('input.gui-entry');
  inp.value = '買牛奶'; inp.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(200);
  Array.from(W().querySelectorAll('.gui-button')).find((b) => b.textContent.trim() === '新增').click();
  await until(() => W().textContent.indexOf('共 1 項') >= 0, 5000);
  const inp2 = W().querySelector('input.gui-entry');
  inp2.value = '寄信'; inp2.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(200);
  W().querySelector('.gui-label').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  await until(() => W().textContent.indexOf('共 2 項') >= 0, 5000);
  r.status_text = Array.from(W().querySelectorAll('.gui-label')).map((x) => x.textContent).filter((x) => /項/.test(x)).join('|');
  r.list_items = Array.from(W().querySelectorAll('.gui-list option')).map((o) => o.textContent);
  r.actions_ok = r.list_items.length === 2 && /共 2 項/.test(r.status_text);
};
// 1. 直接執行 .yaml 範本
await runApp('yaml_direct', 'import guitpl\nguitpl.run("demo/todo_yaml")\n', todoActions);
// 2. 編譯成單一檔後執行
const c = JSON.parse(await fa.tools.gui_template_compose.callback(JSON.stringify({ id: 'demo/todo_yaml', standalone: true, output: 'todo_yaml_app.py' })));
R.compose_standalone_ok = c.ok;
put('gen.py', c.code);
await fa._runTerminalCommand(session, 'python3 gen.py');
await until(() => cnt(/已寫出單一檔案程式/g) > 0, 15000);
await runApp('yaml_standalone', 'import runpy\nrunpy.run_path("/work/todo_yaml_app.py", run_name="__main__")\n', todoActions);
// 3. 模型自寫的 YAML
const yamlTpl = 'kind: meta\nid: user/yhello\ntitle: YAML 招呼\nstandalone: true\n---\nkind: param\nname: who\ndefault: 世界\nask: 跟誰打招呼？\n---\nkind: require\nmodule: gui\nsource: builtin\n---\nkind: layout\nwindow: {title: "YAML 招呼視窗", width: 300}\ntree:\n  - kind: column\n    children:\n      - {id: t, kind: label, text: "哈囉 {{who}}"}\n';
const c3 = JSON.parse(await fa.tools.gui_template_compose.callback(JSON.stringify({ name: 'user/yhello', yaml: yamlTpl, params: { who: '你' } })));
R.compose_custom_yaml_ok = c3.ok;
await runApp('yaml_custom', c3.code, async (r) => { r.label_text = W().textContent; r.actions_ok = /哈囉 你/.test(r.label_text); });
R.all_ok = !!(R.compose_standalone_ok && R.compose_custom_yaml_ok && R.yaml_direct.ok && R.yaml_standalone.ok && R.yaml_custom.ok);
return R;
