// 用法：FA_DEBUG_EVAL_FILE=<本檔絕對路徑> FA_DISABLE_MAIN_OVERLAY=1 FA_BROWSER_CONTROL_PORT=17936 electron.exe <desktop-app路徑> --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
// 全面實機驗證（真 Electron 模擬器，Worker 路徑）：
//   A. 所有 standalone 範本（十三個領域的 main、各配色變體、demo）：開窗 → 對每個輸入框、多行文字框、編輯器送文字 → 對畫布送滑鼠、按鍵、滾輪 →
//      按下每個已登記的快捷鍵 → 點每個按鈕 → 關窗；記錄文字有沒有因此改變、有沒有 [guitpl] 錯誤或 Traceback。
//   B. 所有子元件（非 standalone）：用一個臨時外殼把它掛在 slot 裡，只驗證能開窗、能掛載、沒有錯誤。
// 結果在 [eval-file] result:。
const fa = window.fa;
const R = { full: {}, parts: {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { /* 還沒好 */ } await wait(120); } return null; };
const termText = (session) => { const b = session.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); } return out.join('\n'); };
const t = await fa._createTerminalForAI({ name: 'verify-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
const put = (name, text) => fa._writeBytesToTerminalFs(fsStore, '/work/' + name, new TextEncoder().encode(text));
const cnt = (re) => (termText(session).match(re) || []).length;
const KEYNAMES = { Enter: 'Enter', Esc: 'Escape', Space: ' ', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Delete: 'Delete', Backspace: 'Backspace', Tab: 'Tab' };
const firstWin = () => document.querySelector('.gui-window[data-window]');
const winText = (w) => (w ? w.textContent : '') + '|' + Array.from(w ? w.querySelectorAll('input,textarea') : []).map((x) => x.value).join('~') + '|' + Array.from(w ? w.querySelectorAll('canvas') : []).length;

put('catalog.py', 'import gui\nimport guitpl\nfor e in guitpl.catalog():\n    print(("ENTRY=" if e["standalone"] else "PART=") + e["id"])\nprint("CAT-END")\n');
await fa._runTerminalCommand(session, 'python3 catalog.py');
await until(() => cnt(/CAT-END/g) > 0, 20000);
const txt = termText(session);
const entries = (txt.match(/ENTRY=\S+/g) || []).map((s) => s.slice(6));
const parts = (txt.match(/PART=\S+/g) || []).map((s) => s.slice(5));
R.entries = entries.length; R.parts_count = parts.length;

async function openAndWait(pyCode, endMark) {
  const e0 = cnt(new RegExp(endMark, 'g'));
  const tb0 = cnt(/Traceback/g), ge0 = cnt(/\[guitpl\]/g);
  put('v_run.py', pyCode);
  let done = false;
  fa._runTerminalCommand(session, 'python3 v_run.py').then(() => { done = true; }, () => { done = true; });
  const el = await until(() => document.querySelector('.gui-window[data-window] .gui-button, .gui-window[data-window] .gui-label, .gui-window[data-window] canvas'), 25000);
  // 節點數穩定
  let last = -1, since = Date.now();
  while (Date.now() - since < 700 && Date.now() < since + 12000) { const c = document.querySelectorAll('.gui-window[data-window] [data-node]').length; if (c !== last) { last = c; since = Date.now(); } await wait(120); }
  return { el, done: () => done, finish: async () => {
    const cl = document.querySelector('.gui-window[data-window] .gui-close');
    // 彈出的對話框等其他視窗一併關掉
    document.querySelectorAll('.gui-window[data-window] .gui-close').forEach((c) => c.click());
    await until(() => done, 15000);
    await until(() => cnt(new RegExp(endMark, 'g')) > e0, 6000);
    return { ended: cnt(new RegExp(endMark, 'g')) > e0, traceback: cnt(/Traceback/g) - tb0, guitpl_errors: cnt(/\[guitpl\]/g) - ge0, nodes: last };
  } };
}

for (const id of entries) {
  const r = { };
  R.full[id] = r;
  const h = await openAndWait('import gui\nimport guitpl\nguitpl.run(' + JSON.stringify(id) + ')\nprint("V-END")\n', 'V-END');
  r.window_rendered = !!h.el;
  if (!h.el) { r.ok = false; await h.finish(); continue; }
  const w = () => firstWin();
  const before = winText(w());
  // 輸入框文字
  let typed = 0;
  for (const inp of Array.from(w().querySelectorAll('input.gui-entry, textarea'))) {
    if (!document.body.contains(inp)) continue;
    inp.value = '測試文字 abc'; inp.dispatchEvent(new Event('input', { bubbles: true })); typed++;
    await wait(80);
  }
  r.typed = typed;
  // 畫布事件
  let canvasEv = 0;
  for (const cv of Array.from(w().querySelectorAll('canvas'))) {
    if (!document.body.contains(cv)) continue;
    const b = cv.getBoundingClientRect();
    const at = { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2, button: 0, bubbles: true };
    cv.dispatchEvent(new MouseEvent('mousedown', at)); cv.dispatchEvent(new MouseEvent('mousemove', at)); cv.dispatchEvent(new MouseEvent('mouseup', at));
    cv.dispatchEvent(new WheelEvent('wheel', Object.assign({ deltaY: 40 }, at)));
    cv.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); cv.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
    canvasEv++;
    await wait(150);
  }
  r.canvases = canvasEv;
  // 快捷鍵（從橋接記下的登記表取）
  const host = fa._terminalGuiHost(session);
  const wins = Object.keys(host.session.windows);
  const combos = wins.length ? Object.keys(host.session.windows[wins[0]].shortcuts || {}) : [];
  r.shortcuts = combos.length;
  for (const combo of combos) {
    const parts2 = combo.split('+'); const key = parts2.pop();
    const ev = { key: KEYNAMES[key] || (key.length === 1 ? key.toLowerCase() : key), ctrlKey: parts2.indexOf('Ctrl') >= 0, shiftKey: parts2.indexOf('Shift') >= 0, altKey: parts2.indexOf('Alt') >= 0, bubbles: true, cancelable: true };
    const target = w().querySelector('.gui-label, .gui-button') || w();
    target.dispatchEvent(new KeyboardEvent('keydown', ev));
    await wait(120);
  }
  // 按鈕
  let clicked = 0;
  for (const b of Array.from(w() ? w().querySelectorAll('.gui-button') : [])) { if (document.body.contains(b)) { b.click(); clicked++; await wait(150); } }
  r.clicked = clicked;
  await wait(300);
  r.changed = winText(firstWin()) !== before;
  const f = await h.finish();
  Object.assign(r, f);
  r.ok = r.window_rendered && r.ended && !r.traceback && !r.guitpl_errors;
}

// B. 子元件：臨時外殼把它掛在 slot 裡
for (const id of parts) {
  const r = {};
  R.parts[id] = r;
  const wrap = 'wrap_' + id.replace(/[^a-z0-9]/g, '_');
  const code = ['import gui', 'import guitpl', 'import os', 'import json', 'd = "/work/wrap"', 'os.makedirs(d, exist_ok=True)',
    'rec = [{"kind":"meta","id":"' + wrap + '","title":"外殼","standalone":True},{"kind":"require","module":"gui","source":"builtin"},{"kind":"layout","window":{"title":"外殼 ' + id + '","width":420},"tree":[{"kind":"column","children":[{"slot":"s"}]}]},{"kind":"slot","name":"s","use":"' + id + '","params":{}}]',
    'f = open(d + "/' + wrap + '.jsonl", "w", encoding="utf-8")', 'f.write("\\n".join(json.dumps(x, ensure_ascii=False) for x in rec))', 'f.close()',
    'f = open(d + "/' + wrap + '.py", "w", encoding="utf-8")', 'f.write("def build(win, spec, slots):\\n    return {\\"handlers\\": {}}\\n")', 'f.close()',
    'guitpl.run("' + wrap + '", roots=[d] + guitpl.default_roots())', 'print("P-END")', ''].join('\n');
  const h = await openAndWait(code, 'P-END');
  r.window_rendered = !!h.el;
  r.nodes_ = document.querySelectorAll('.gui-window[data-window] [data-node]').length;
  const f = await h.finish();
  Object.assign(r, f);
  r.ok = r.window_rendered && r.ended && !r.traceback;
}
R.full_failed = Object.keys(R.full).filter((k) => !R.full[k].ok);
R.parts_failed = Object.keys(R.parts).filter((k) => !R.parts[k].ok);
R.all_ok = R.full_failed.length === 0 && R.parts_failed.length === 0;
return R;
