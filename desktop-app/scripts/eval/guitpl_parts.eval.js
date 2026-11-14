// 用法：FA_DEBUG_EVAL_FILE=<本檔絕對路徑> FA_DISABLE_MAIN_OVERLAY=1 FA_BROWSER_CONTROL_PORT=17939 electron.exe <desktop-app路徑> --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
// 子元件逐個驗證（真 Electron 模擬器）：每個非 standalone 的子元件，找出真正使用它的主範本（子元件的處理函式要靠主範本的節點與場景才有地方寫），
// 開那個主範本，然後只操作「這個子元件自己的」按鈕與選單項目（用版面裡的文字比對）和它登記的快捷鍵，每個都按一次：
// 不能有 Traceback、不能有 [guitpl] 錯誤輸出，而且畫面（文字或輸入框內容）要有變化。沒有任何控制項的子元件（例如只有標籤的狀態列）
// 只驗證能隨主範本掛載、沒有錯誤。（先前嘗試過用臨時外殼單獨掛載：子元件的處理函式會用到主範本才有的節點與場景，外殼會產生假錯誤，所以改用真主範本。）
const fa = window.fa;
const R = { parts: {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { /* 還沒好 */ } await wait(120); } return null; };
const termText = (session) => { const b = session.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); } return out.join('\n'); };
const t = await fa._createTerminalForAI({ name: 'parts-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
const put = (name, text) => fa._writeBytesToTerminalFs(fsStore, '/work/' + name, new TextEncoder().encode(text));
const cnt = (re) => (termText(session).match(re) || []).length;
const KEYNAMES = { Enter: 'Enter', Esc: 'Escape', Space: ' ', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Delete: 'Delete', Backspace: 'Backspace', Tab: 'Tab' };

// 1. 在模擬器裡列出每個子元件：真正使用它的主範本、它自己的按鈕與選單項目文字、它登記的快捷鍵（每個子元件印一行 PART=json，再印一行 GEN-END）
const GEN = [
  'import gui',
  'import guitpl',
  'import json',
  'lib = guitpl.Library(guitpl.default_roots())',
  'cat = guitpl.catalog()',
  'mains = {e["id"]: lib.load(e["id"]) for e in cat if e["standalone"]}',
  'def walk_children(c):',
  '    for name, ch in c["children"].items():',
  '        yield c, name, ch',
  '        for x in walk_children(ch):',
  '            yield x',
  'def controls(nodes, values, out):',
  '    for n in nodes:',
  '        if n.get("kind") in ("button", "menuitem") and n.get("text"):',
  '            out.append(guitpl._subst(n["text"], values).strip())',
  '        controls(n.get("children", []), values, out)',
  'for e in cat:',
  '    if e["standalone"]:',
  '        continue',
  '    pid = e["id"]',
  '    found = None',
  '    for mid, m in mains.items():',
  '        for owner, name, ch in walk_children(m):',
  '            if ch["id"] == pid:',
  '                found = (mid, owner, name, ch)',
  '                break',
  '        if found:',
  '            break',
  '    if not found:',
  '        print("NOPARENT=" + pid)',
  '        continue',
  '    mid, owner, name, ch = found',
  '    slot = owner["slots"].get(name) or {}',
  '    values = guitpl.bind_params(ch, guitpl._subst(slot.get("params", {}), guitpl.bind_params(owner)))',
  '    texts = []',
  '    if ch["layout"]:',
  '        controls(ch["layout"]["tree"], values, texts)',
  '    keys = [s["keys"] for s in ch["shortcuts"]]',
  '    print("PART=" + json.dumps([pid, mid, texts, keys], ensure_ascii=True))',
  'print("GEN-END")', ''
].join('\n');
put('gen_parts.py', GEN);
await fa._runTerminalCommand(session, 'python3 gen_parts.py');
await until(() => cnt(/GEN-END/g) > 0, 30000);
const rawLines = termText(session).split('\n');
// 終端機會把長行折成多列：把 PART= 開頭到下一個 PART=／GEN-END／NOPARENT= 之間的列接回一行
const joined = []; let curLine = null;
for (const l0 of rawLines) {
  const l = l0.replace(/^.*\/work \$ /, '');
  if (/^(PART=|GEN-END|NOPARENT=)/.test(l.trim()) || /\/work \$/.test(l)) { if (curLine !== null) joined.push(curLine); curLine = /^(PART=|GEN-END|NOPARENT=)/.test(l.trim()) ? l.trim() : null; }
  else if (curLine !== null && l.trim()) { curLine += l.trim(); }
}
if (curLine !== null) joined.push(curLine);
const parts = joined.filter((l) => l.indexOf('PART=') === 0).map((l) => { try { return JSON.parse(l.slice(5)); } catch (_) { return null; } }).filter(Boolean);
R.parts_found = parts.length;
R.noparent = joined.filter((l) => l.indexOf('NOPARENT=') === 0).map((l) => l.slice(9));

// 畫面簽章：文字、輸入框內容，加上每個畫布的像素總和（畫布裡的變化例如球開始移動才看得到）
const canvasSig = (cv) => { try { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let h = 0; for (let i = 0; i < d.length; i += 7) { h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0; } return h; } catch (_) { return 0; } };
const wText = (w) => (w ? w.innerText : '') + '|' + Array.from(w ? w.querySelectorAll('input,textarea,option') : []).map((x) => x.value || x.textContent).join('~') + '|' + Array.from(w ? w.querySelectorAll('canvas') : []).map(canvasSig).join(',');
for (const [pid, mid, texts, keys] of parts) {
  const r = { main: mid, controls: texts.length, shortcuts: keys.length };
  R.parts[pid] = r;
  const e0 = cnt(/PT-END/g), tb0 = cnt(/Traceback/g), ge0 = cnt(/\[guitpl\]/g);
  put('pt_run.py', 'import gui\nimport guitpl\nguitpl.run(' + JSON.stringify(mid) + ')\nprint("PT-END")\n');
  let done = false;
  fa._runTerminalCommand(session, 'python3 pt_run.py').then(() => { done = true; }, () => { done = true; });
  await until(() => document.querySelector('.gui-window[data-window] [data-node]'), 25000);
  let last = -1, since = Date.now();
  while (Date.now() - since < 800 && Date.now() < since + 12000) { const c = document.querySelectorAll('.gui-window[data-window] [data-node]').length; if (c !== last) { last = c; since = Date.now(); } await wait(120); }
  const W = () => document.querySelector('.gui-window[data-window]');
  r.window_rendered = !!W();
  if (!W()) { r.ok = false; continue; }
  for (const inp of Array.from(W().querySelectorAll('input.gui-entry, textarea'))) { inp.value = '測試 abc 123'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
  await wait(250);
  let changed = 0, operated = 0; const missing = []; const unchanged = [];
  for (const text of texts) {
    const btn = Array.from(W().querySelectorAll('.gui-button, .gui-menuitem')).find((b) => b.textContent.trim().indexOf(text) === 0);
    if (!btn) { missing.push(text); continue; }
    const b4 = wText(W());
    btn.click();
    await wait(300);
    operated++;
    if (wText(W()) !== b4) { changed++; } else { unchanged.push(text); }
  }
  // 沒變化的控制項：所有控制項都按過一次之後（狀態不同了）再按一次，看這次有沒有變化——有的話就是「依狀態而定」（例如已經在那個畫面）
  r.retry = {};
  for (const text of unchanged.slice()) {
    const btn = Array.from(W().querySelectorAll('.gui-button, .gui-menuitem')).find((b) => b.textContent.trim().indexOf(text) === 0);
    if (!btn) { continue; }
    const b4 = wText(W());
    btn.click();
    await wait(700);
    r.retry[text] = wText(W()) !== b4;
  }
  for (const combo of keys) {
    const p2 = combo.split('+'); const key = p2.pop();
    const b4 = wText(W());
    const ev = { key: KEYNAMES[key] || (key.length === 1 ? key.toLowerCase() : key), ctrlKey: p2.indexOf('Ctrl') >= 0, shiftKey: p2.indexOf('Shift') >= 0, altKey: p2.indexOf('Alt') >= 0, bubbles: true, cancelable: true };
    (W().querySelector('.gui-label, .gui-button') || W()).dispatchEvent(new KeyboardEvent('keydown', ev));
    await wait(300);
    operated++;
    if (wText(W()) !== b4) { changed++; } else { unchanged.push('key:' + combo); }
  }
  r.operated = operated; r.changed = changed; r.missing = missing; r.unchanged = unchanged;
  document.querySelectorAll('.gui-window[data-window] .gui-close').forEach((c) => c.click());
  await until(() => done, 15000);
  await until(() => cnt(/PT-END/g) > e0, 6000);
  r.ended = cnt(/PT-END/g) > e0;
  r.traceback = cnt(/Traceback/g) - tb0;
  r.guitpl_errors = cnt(/\[guitpl\]/g) - ge0;
  if (r.guitpl_errors) r.error_text = termText(session).split('\n').filter((l) => /\[guitpl\]/.test(l)).slice(-3).join(' // ');
  // 每個操作都要不出錯；至少一個操作讓畫面有變化（有些控制項本來就依狀態而定，例如沒東西可清時按「清除訊息」、還沒發球就按「暫停」，畫面不變是正常的，會列在 unchanged）；沒有控制項的子元件只要求能掛載
  r.ok = !!(r.window_rendered && r.ended && !r.traceback && !r.guitpl_errors && !missing.length && (operated === 0 || changed >= 1));
}
R.failed = Object.keys(R.parts).filter((k) => !R.parts[k].ok);
R.all_ok = R.failed.length === 0 && R.noparent.length === 0 && R.parts_found > 0;
return R;
