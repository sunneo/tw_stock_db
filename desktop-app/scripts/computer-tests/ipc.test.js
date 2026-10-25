// node scripts/computer-tests/ipc.test.js -- computer-use-ipc.js：用假 Electron 與假後端測 IPC、原生核准視窗、權限提升、機密、全域中止鍵
const fs = require('fs');
const os = require('os');
const path = require('path');
const { register, ABORT_HOTKEY, SELF_DENY } = require('../../computer-use-ipc.js');
const { suite } = require('./_t.js');
const t = suite('computer-use-ipc');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ipc-')); const secretsPath = path.join(tmp, 'secrets.json'); fs.writeFileSync(secretsPath, JSON.stringify({ NVAPI_KEY: 'keep-me' }));
  const handlers = new Map(), once = new Map(); const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), once: (ch, fn) => once.set(ch, fn) };
  let windowsOpened = []; let script = []; // script：依序給核准視窗的回覆
  class FakeWin { constructor(o) { this.opts = o; windowsOpened.push(this); this.h = {}; } setMenuBarVisibility() {} loadURL(u) { this.html = decodeURIComponent(u.split(',').slice(1).join(',')); const ch = JSON.parse(/const ch = (".*?");/.exec(this.html)[1]); const reply = script.shift(); setTimeout(() => { const f = once.get(ch); if (f) f(null, reply); }, 5); } on(ev, fn) { this.h[ev] = fn; } isDestroyed() { return !!this.closed; } close() { this.closed = true; if (this.h.closed) this.h.closed(); } }
  const sent = []; const mainWindow = { isDestroyed: () => false, webContents: { send: (ch, m) => sent.push([ch, m]) } };
  const shortcuts = new Map(); const globalShortcut = { register: (k, fn) => { shortcuts.set(k, fn); return true; }, unregister: (k) => shortcuts.delete(k) };
  let settings = {}; const patched = [];
  // 假後端：一個範圍內視窗、一個「自己」的視窗；記錄每個動作
  const calls = []; const wins = [{ id: '0x1', title: '記事本', process: 'gedit', class: 'Gedit', pid: 5001, rect: { x: 100, y: 100, w: 600, h: 400 }, frame: { x: 95, y: 70, w: 610, h: 435 }, z: 1, focused: true, minimized: false, type: 'normal' }, { id: '0x2', title: 'AI 要求操作電腦', process: 'electron', class: 'electron', pid: process.pid, rect: { x: 800, y: 100, w: 400, h: 300 }, frame: { x: 800, y: 100, w: 400, h: 300 }, z: 2, type: 'normal' }, { id: '0x3', title: 'Authentication Required', process: 'polkit', class: 'p', pid: 5003, rect: { x: 300, y: 300, w: 200, h: 100 }, frame: { x: 300, y: 300, w: 200, h: 100 }, z: 3, type: 'normal' }];
  const backend = { kind: 'fake', env: {}, capabilities: async () => ({ features: { a11y: { ok: false }, windows: { backend: 'x11' } }, summary: 'fake' }), listWindows: async () => ({ ok: true, windows: JSON.parse(JSON.stringify(wins)), activeId: '0x1', backend: 'fake' }), monitors: async () => ({ ok: true, monitors: [{ rect: { x: 0, y: 0, w: 1280, h: 800 } }] }), releaseAll: async () => { calls.push('releaseAll'); return { ok: true }; }, click: async (x, y, o) => { calls.push(['click', x, y, o]); return { ok: true }; }, pointerMove: async (x, y) => { calls.push(['move', x, y]); return { ok: true }; }, typeText: async (s) => { calls.push(['type', s]); return { ok: true }; }, key: async (k) => { calls.push(['key', k]); return { ok: true }; }, waitForWindow: async () => ({ ok: false, error: 'x' }) };
  const reg = register(ipcMain, { electron: { globalShortcut, app: { getPath: () => tmp, on: () => {} } }, BrowserWindow: FakeWin, getMainWindow: () => mainWindow, userDataDir: () => tmp, secretsFile: () => secretsPath, getDesktopSettings: async () => settings, patchDesktopSettings: async (p) => { patched.push(p); settings = Object.assign({}, settings, p); return settings; }, cuOptions: { platform: 'linux', backend, atspi: null } });
  const call = (name, args) => handlers.get('fa:computer:' + name)({ sender: {} }, args || {});

  let st = await call('status'); t.check('預設關閉：status.enabled=false、沒有範圍、有中止快捷鍵', st.ok && st.enabled === false && st.scope.mode === 'none' && st.abortHotkey === ABORT_HOTKEY && /Escape/.test(ABORT_HOTKEY));
  let r = await call('run', { steps: [{ op: 'click', x: 150, y: 150 }] }); t.check('關閉狀態下 run 被拒絕', !r.ok && /沒有啟用/.test(r.error + JSON.stringify(r.refused || '')) , r);
  // 啟用：使用者取消
  script = [{ approved: false }]; r = await call('setEnabled', { on: true }); t.check('啟用：使用者按取消 → 仍然關閉、沒有寫設定', !r.ok && r.refused && (await call('status')).enabled === false && patched.length === 0);
  t.check('啟用的核准視窗是原生視窗、說明清楚、預設焦點在「取消」、Esc 取消', /要讓 AI 助理使用「電腦操作」功能嗎/.test(windowsOpened[0].html) && /getElementById\("deny"\)\.focus\(\)/.test(windowsOpened[0].html) && /key === "Escape"/.test(windowsOpened[0].html) && windowsOpened[0].opts.webPreferences.nodeIntegration === true);
  script = [{ approved: true }]; r = await call('setEnabled', { on: true }); st = await call('status'); t.check('啟用：使用者按啟用 → enabled、寫入 computerUseEnabled', r.ok && st.enabled && patched.length === 1 && patched[0].computerUseEnabled === true && sent.some((s) => s[1].type === 'state'));
  // 範圍
  script = [{ approved: false }]; r = await call('setScope', { windowIds: ['0x1'] }); t.check('setScope（renderer 指定）要使用者在原生視窗確認；拒絕就沒有範圍', !r.ok && r.refused && (await call('status')).scope.mode === 'none');
  t.check('範圍確認視窗列出視窗標題與行程', /記事本/.test(windowsOpened[windowsOpened.length - 1].html) && /gedit/.test(windowsOpened[windowsOpened.length - 1].html));
  script = [{ mode: 'windows', windowIds: ['0x1'] }]; r = await call('pickScope'); t.check('pickScope：使用者在視窗勾選 → 範圍設定成功', r.ok && r.scope.windows.length === 1 && r.scope.windows[0].title === '記事本');
  const pickHtml = windowsOpened[windowsOpened.length - 1].html; t.check('範圍選擇視窗：受保護的視窗與助理自己的視窗是灰的（disabled）、標題被遮蔽', /disabled/.test(pickHtml) && !/Authentication Required/.test(pickHtml) && (pickHtml.match(/disabled/g) || []).length >= 2 && /助理自己的視窗/.test(pickHtml) && /受保護的視窗/.test(pickHtml));
  script = [{ mode: 'windows', windowIds: ['0x3'] }]; r = await call('pickScope'); t.check('即使使用者（或被竄改的畫面）送出被保護視窗的 id，主行程也拒絕放進範圍', !r.ok && /拒絕清單/.test(r.error));
  script = [{ mode: 'windows', windowIds: ['0x2'] }]; r = await call('pickScope'); t.check('助理自己的視窗不能放進範圍', !r.ok && /助理自己的視窗/.test(r.error));
  script = [{ mode: 'windows', windowIds: ['0x1'] }]; await call('pickScope');
  // 動作：核准流程
  script = [{ approved: false }]; calls.length = 0; r = await call('run', { steps: [{ op: 'click', x: 150, y: 150 }] }); t.check('run：使用者在原生視窗按取消 → 沒有任何動作被執行', !r.ok && r.code === 'user_denied' && calls.filter((c) => c[0] === 'click').length === 0);
  t.check('核准視窗內容是動作預覽（座標與視窗），且有「自動」按鈕選項', /點擊 \(150, 150\)/.test(windowsOpened[windowsOpened.length - 1].html) && /id="auto"/.test(windowsOpened[windowsOpened.length - 1].html));
  script = [{ approved: true }]; calls.length = 0; r = await call('run', { steps: [{ op: 'click', x: 150, y: 150 }] }); t.check('run：核准 → 執行；執行期間註冊全域中止鍵、結束後取消註冊', r.ok && calls.some((c) => c[0] === 'click') && sent.filter((s) => s[1].type === 'run-start').length >= 1 && sent.filter((s) => s[1].type === 'run-end').length >= 1 && shortcuts.size === 0);
  // 執行期間按下中止鍵
  const slowBackend = backend.click; backend.click = async (x, y, o) => { calls.push(['click', x, y]); if (shortcuts.has(ABORT_HOTKEY)) shortcuts.get(ABORT_HOTKEY)(); await sleep(20); return { ok: true }; };
  script = [{ approved: true }]; calls.length = 0; r = await call('run', { steps: [{ op: 'click', x: 150, y: 150 }, { op: 'click', x: 160, y: 160 }, { op: 'click', x: 170, y: 170 }] });
  t.check('全域中止鍵：第一個動作之後觸發 → 整批停止（stopped.code=aborted）、放開輸入（releaseAll）、通知畫面', !r.ok && r.stopped && r.stopped.code === 'aborted' && calls.filter((c) => c[0] === 'click').length === 1 && calls.includes('releaseAll') && sent.some((s) => s[1].type === 'abort' && s[1].by === 'hotkey'));
  backend.click = slowBackend;
  r = await call('run', { steps: [{ op: 'click', x: 150, y: 150 }] }); t.check('中止之後一律拒絕', !r.ok && /中止/.test(JSON.stringify(r.refused || r.error)));
  r = await call('resume'); t.check('resume 之後恢復', r.ok);
  // 自動核准要原生確認
  script = [{ approved: false }]; r = await call('setAuto', { on: true }); t.check('setAuto：要原生視窗確認，取消 → 仍然非自動', !r.ok && (await call('status')).auto === false);
  script = [{ approved: true }]; r = await call('setAuto', { on: true }); t.check('setAuto：確認 → 自動', r.ok && r.auto === true);
  script = []; calls.length = 0; const nw = windowsOpened.length; r = await call('run', { steps: [{ op: 'click', x: 150, y: 150 }] }); t.check('自動模式：已驗證的點擊不開核准視窗', r.ok && windowsOpened.length === nw);
  script = [{ approved: true }]; r = await call('run', { steps: [{ op: 'type', text: 'hi' }] }); t.check('自動模式：看不出焦點的打字仍然開核准視窗（且沒有「自動」按鈕）', windowsOpened.length > nw && !/id="auto"/.test(windowsOpened[windowsOpened.length - 1].html), r);
  script = []; const nw2 = windowsOpened.length; r = await call('run', { steps: [{ op: 'key', keys: 'ctrl+alt+Delete' }] }); t.check('危險按鍵：直接拒絕、不開視窗', !r.ok && windowsOpened.length === nw2);
  // 機密
  r = await call('setRemoteSecret', { name: 'my vnc!', password: 'p@ss w0rd' }); const saved = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  t.check('setRemoteSecret：名稱消毒、存進 secrets.json 的專屬欄位、不動別的金鑰、檔案權限 600', r.ok && r.name === 'my_vnc_' && saved.COMPUTER_REMOTE_SECRETS.my_vnc_.password === 'p@ss w0rd' && saved.NVAPI_KEY === 'keep-me' && (fs.statSync(secretsPath).mode & 0o077) === 0);
  r = await call('listRemoteSecrets'); t.check('listRemoteSecrets 只回名稱、不回密碼', r.ok && JSON.stringify(r).includes('my_vnc_') && !JSON.stringify(r).includes('p@ss'));
  t.check('機密 getter：設定的密碼可取、環境變數 FA_VNC_PASSWORD_<NAME> 優先、不存在回 null', (() => { process.env.FA_VNC_PASSWORD_ENVONE = 'from-env'; const ok = reg.secrets.get('my_vnc_') === 'p@ss w0rd' && reg.secrets.get('envone') === 'from-env' && reg.secrets.get('nope') === null; delete process.env.FA_VNC_PASSWORD_ENVONE; return ok; })());
  r = await call('deleteRemoteSecret', { name: 'my_vnc_' }); t.check('deleteRemoteSecret', r.ok && !JSON.parse(fs.readFileSync(secretsPath, 'utf8')).COMPUTER_REMOTE_SECRETS.my_vnc_);
  // 其他
  t.check('自己視窗的標題規則（雙保險）擋 AI 要求操作電腦／FloatingAssistantApp', SELF_DENY[0].test('AI 要求操作電腦') && SELF_DENY[0].test('FloatingAssistantApp') && !SELF_DENY[0].test('Terminal'));
  r = await call('addDeny', { pattern: '記事' }); t.check('addDeny：使用者追加拒絕規則（只會更嚴格）並寫進設定', r.ok && settings.computerUseExtraDeny.includes('記事'));
  r = await call('addDeny', { pattern: '(' }); t.check('addDeny：壞的正規表示式拒絕', !r.ok);
  r = await call('setEnabled', { on: false }); st = await call('status'); t.check('停用：不需要確認、立刻生效、寫設定、清掉範圍與自動', r.ok && !st.enabled && st.scope.mode === 'none' && !st.auto && settings.computerUseEnabled === false);
  // 重啟後的狀態：設定檔 true ＋保存的範圍 → 啟用，範圍對回現有視窗
  const savedNow = (patched.filter((x) => x.computerUseScope).slice(-1)[0] || {}).computerUseScope; settings = { computerUseEnabled: true, computerUseScope: savedNow }; handlers.clear(); const reg2 = register(ipcMain, { electron: { globalShortcut, app: { getPath: () => tmp, on: () => {} } }, BrowserWindow: FakeWin, getMainWindow: () => mainWindow, userDataDir: () => tmp, secretsFile: () => secretsPath, getDesktopSettings: async () => settings, patchDesktopSettings: async () => settings, cuOptions: { platform: 'linux', backend, atspi: null } });
  st = await call('status'); t.check('重新啟動：設定檔 computerUseEnabled=true → 啟用，範圍從保存的「標題＋行程」對回現有視窗（自動核准不會保留）', st.enabled === true && st.scope.mode === 'windows' && st.scope.windows.length === 1 && st.scope.windows[0].title === '記事本' && st.auto === false, st.scope);
  t.check('保存的範圍只有標題／行程／類別，沒有視窗代號與行程號碼', savedNow && savedNow.mode === 'windows' && Object.keys(savedNow.windows[0]).sort().join() === 'class,process,title', savedNow);
  // 範圍視窗還沒開（開機後才開）：先沒有範圍，視窗出現後下一次呼叫自動對回去
  const keep = wins.slice(); wins.length = 0; settings = { computerUseEnabled: true, computerUseScope: savedNow }; handlers.clear(); register(ipcMain, { electron: { globalShortcut, app: { getPath: () => tmp, on: () => {} } }, BrowserWindow: FakeWin, getMainWindow: () => mainWindow, userDataDir: () => tmp, secretsFile: () => secretsPath, getDesktopSettings: async () => settings, patchDesktopSettings: async (p) => { patched.push(p); settings = Object.assign({}, settings, p); return settings; }, cuOptions: { platform: 'linux', backend, atspi: null } });
  st = await call('status'); t.check('重新啟動時範圍視窗還沒開：啟用、暫時沒有範圍', st.enabled && st.scope.mode === 'none', st.scope);
  wins.push(...keep); await sleep(4100); st = await call('status'); t.check('視窗開了之後（隔幾秒的下一次呼叫）範圍自動回來', st.scope.mode === 'windows' && st.scope.windows[0].title === '記事本', st.scope);
  // 停用會清掉保存的範圍
  patched.length = 0; await call('setEnabled', { on: false }); t.check('/computer disable：保存的範圍一併清掉', patched.some((x) => x.computerUseEnabled === false) && patched.some((x) => 'computerUseScope' in x && x.computerUseScope === null), patched);
  const IPC = require('../../computer-use-ipc.js');
  t.check('matchSavedWindows：標題相同優先；同行程同類別只有一個時退而求其次；受保護與自己的不選', JSON.stringify(IPC.matchSavedWindows([{ title: 'a.txt', process: 'gedit', class: 'G' }, { title: '改過的標題', process: 'gedit2', class: 'H' }, { title: 'x', process: 'polkit', class: 'p' }], [{ id: '1', title: 'a.txt', process: 'gedit', class: 'G' }, { id: '2', title: 'b.txt', process: 'gedit', class: 'G' }, { id: '3', title: '別的', process: 'gedit2', class: 'H' }, { id: '4', title: 'x', process: 'polkit', class: 'p', denied: { label: 'p' } }])) === JSON.stringify(['1', '3']));
  t.check('sanitizeSavedScope：壞資料變成 null、欄位被截短', IPC.sanitizeSavedScope('x') === null && IPC.sanitizeSavedScope({ mode: 'windows', windows: [] }) === null && IPC.sanitizeSavedScope({ mode: 'screen', junk: 1 }).mode === 'screen' && IPC.sanitizeSavedScope({ mode: 'windows', windows: [{ title: 't'.repeat(500) }] }).windows[0].title.length === 200);
  // 舊版入口檔沒有傳 getDesktopSettings／patchDesktopSettings（Linux 版回報：啟用重開就沒了）：自己讀寫 userData/desktop-settings.json
  { const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ipc2-')); fs.writeFileSync(path.join(tmp2, 'desktop-settings.json'), JSON.stringify({ execEnabled: true, keep: 'me' }));
    const mk = () => { handlers.clear(); register(ipcMain, { electron: { globalShortcut, app: { getPath: () => tmp2, on: () => {} } }, BrowserWindow: FakeWin, getMainWindow: () => mainWindow, userDataDir: () => tmp2, secretsFile: () => path.join(tmp2, 'secrets.json'), cuOptions: { platform: 'linux', backend, atspi: null } }); };
    mk(); script = [{ approved: true }]; await call('setEnabled', { on: true }); script = [{ mode: 'windows', windowIds: ['0x1'] }]; await call('pickScope');
    const file = JSON.parse(fs.readFileSync(path.join(tmp2, 'desktop-settings.json'), 'utf8')); t.check('沒有 patchDesktopSettings 也能存：啟用旗標與範圍寫進 desktop-settings.json，別的欄位不被洗掉', file.computerUseEnabled === true && file.computerUseScope && file.computerUseScope.mode === 'windows' && file.keep === 'me' && file.execEnabled === true, file);
    mk(); const st2 = await call('status'); t.check('重開（舊版入口檔）：仍然啟用，範圍也回來', st2.enabled === true && st2.scope.mode === 'windows', st2.scope);
    await call('setEnabled', { on: false }); const f2 = JSON.parse(fs.readFileSync(path.join(tmp2, 'desktop-settings.json'), 'utf8')); t.check('停用：旗標與範圍一併清掉', f2.computerUseEnabled === false && f2.computerUseScope === null, f2);
    fs.rmSync(tmp2, { recursive: true, force: true }); }
  fs.rmSync(tmp, { recursive: true, force: true });
  t.done();
})();
