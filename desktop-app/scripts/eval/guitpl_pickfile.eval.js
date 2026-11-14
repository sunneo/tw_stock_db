// 用法：FA_DEBUG_EVAL_FILE=<本檔絕對路徑> FA_DISABLE_MAIN_OVERLAY=1 FA_BROWSER_CONTROL_PORT=17937 electron.exe <desktop-app路徑> --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
// 選檔案對話框（gui.pick_file）在真 Electron 模擬器實跑：
//   1. 頁面層：不給 hook 時浮出面板（選擇檔案、取消）；取消回 null；用真的 File 物件觸發 change，回傳名稱、大小、base64 內容；超過上限回 error。
//      （作業系統原生的檔案選擇器本身沒辦法被自動化點選，所以用 File 物件填進 input 代替使用者選好檔案。）
//   2. Python 層：影像處理與證件照的「開啟圖片／開啟照片」按鈕 → ctx.pick_file → Window.image → 畫布真的畫出圖（用 hook 回一張真的小 PNG）。
const fa = window.fa;
const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { /* 還沒好 */ } await wait(120); } return null; };
const termText = (session) => { const b = session.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); } return out.join('\n'); };

// 1. 面板
let p = fa._guiPickFile({ title: '測試選檔', accept: 'image/*', max_bytes: 2048 });
const panel = await until(() => document.querySelector('.gui-pickfile'), 3000);
R.panel_shown = !!panel;
R.panel_buttons = panel ? Array.from(panel.querySelectorAll('button')).map((b) => b.textContent) : [];
panel.querySelector('.gui-pickfile-cancel').click();
R.cancel_result = await p;
R.panel_removed = !document.querySelector('.gui-pickfile');
p = fa._guiPickFile({ title: '測試選檔', accept: '', max_bytes: 2048 });
await until(() => document.querySelector('.gui-pickfile'), 3000);
let inp = document.querySelector('.gui-pickfile-input');
let dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'hello.bin', { type: 'application/octet-stream' }));
inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
const got = await p;
R.picked = got && { name: got.name, size: got.size, mime: got.mime, data: got.data };
p = fa._guiPickFile({ title: 't', max_bytes: 1024 });
await until(() => document.querySelector('.gui-pickfile'), 3000);
inp = document.querySelector('.gui-pickfile-input');
dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(5000)], 'big.bin'));
inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
const big = await p;
R.too_big = big && big.error;

// 2. Python：影像處理與證件照
const PNG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
fa._guiPickFileHook = async () => ({ name: 'red.png', size: 70, mime: 'image/png', data: RED_PNG, path: '' });
const t = await fa._createTerminalForAI({ name: 'pickfile-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
const put = (name, text) => fa._writeBytesToTerminalFs(fsStore, '/work/' + name, new TextEncoder().encode(text));
const cnt = (re) => (termText(session).match(re) || []).length;
for (const [id, btnText] of [['image/main', '開啟圖片'], ['idphoto/main', '開啟照片']]) {
  const r = {};
  R[id] = r;
  const e0 = cnt(/PF-END/g), tb0 = cnt(/Traceback/g);
  put('pf.py', 'import gui\nimport guitpl\nguitpl.run(' + JSON.stringify(id) + ')\nprint("PF-END")\n');
  let done = false;
  fa._runTerminalCommand(session, 'python3 pf.py').then(() => { done = true; }, () => { done = true; });
  await until(() => document.querySelector('.gui-window[data-window] .gui-button'), 25000);
  await wait(1500);
  const btn = Array.from(document.querySelectorAll('.gui-window[data-window] .gui-button')).find((b) => b.textContent.trim() === btnText);
  r.button_found = !!btn;
  const cv0 = document.querySelector('.gui-window[data-window] canvas');
  const snap = () => { const c = document.querySelector('.gui-window[data-window] canvas'); const x = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let red = 0; for (let i = 0; i < x.length; i += 4) { if (x[i] > 200 && x[i + 1] < 60 && x[i + 2] < 60) red++; } return red; };
  r.red_before = snap();
  if (btn) btn.click();
  await until(() => snap() > r.red_before + 100, 8000);
  r.red_after = snap();
  document.querySelectorAll('.gui-window[data-window] .gui-close').forEach((c) => c.click());
  await until(() => done, 15000);
  await until(() => cnt(/PF-END/g) > e0, 6000);
  r.ended = cnt(/PF-END/g) > e0;
  r.traceback = cnt(/Traceback/g) - tb0;
  r.ok = r.button_found && r.red_after > r.red_before + 100 && r.ended && !r.traceback;
}
fa._guiPickFileHook = null;
R.all_ok = !!(R.panel_shown && R.panel_buttons.length === 2 && R.cancel_result === null && R.panel_removed && R.picked && R.picked.name === 'hello.bin' && R.picked.size === 4 && R.picked.data === 'AQIDBA=='
  && /太大/.test(R.too_big || '') && R['image/main'].ok && R['idphoto/main'].ok);
return R;
