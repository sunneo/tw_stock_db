// node scripts/main-tests/tray_dialog.test.js -- 系統匣縮小時遇到對話框：假的 Electron，不開真視窗。
// 重現的問題：開「匯入技能」的資料夾選擇視窗（parent＝主視窗的 modal）後關主視窗縮到系統匣，再從系統匣「顯示視窗」只剩失控的子視窗。
const EventEmitter = require('events'); const fsp = require('fs/promises'); const path = require('path');
let ok = 0; const bad = [];
function check(n, c, x) { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); }

class FakeWin extends EventEmitter {
  constructor(parent) { super(); this.parent = parent || null; this.visible = true; this.minimized = false; this.destroyed = false; this.focused = false; this.skip = false; this.children = []; if (parent) parent.children.push(this); this.webContents = { setBackgroundThrottling() {} }; }
  isDestroyed() { return this.destroyed; } isVisible() { return this.visible && !(this.parent && !this.parent.visible); } isMinimized() { return this.minimized; }
  restore() { this.minimized = false; } minimize() { this.minimized = true; } show() { this.visible = true; } hide() { this.visible = false; } focus() { this.focused = true; } setSkipTaskbar(v) { this.skip = v; }
  getChildWindows() { return this.children.filter((c) => !c.destroyed); }
  close() { let prevented = false; this.emit('close', { preventDefault() { prevented = true; } }); if (!prevented) { this.destroyed = true; this.emit('closed'); } }
  destroy() { this.destroyed = true; this.emit('closed'); }
}
function setup() {
  const app = new EventEmitter(); app.commandLine = { appendSwitch() {}, getSwitchValue() { return ''; } }; app.whenReady = () => Promise.resolve(); app.getAppPath = () => __dirname; app.getPath = () => require('os').tmpdir(); app.quit = () => {};
  let trayMenu = null;
  class Tray extends EventEmitter { setToolTip() {} setContextMenu(m) { trayMenu = m; } destroy() {} }
  const nativePending = []; const dialog = { showOpenDialog: () => new Promise((r) => nativePending.push(r)), showMessageBox: async () => ({ response: 0 }), showSaveDialog: async () => ({}) };
  const main = new FakeWin(); const wins = [main];
  const electron = { app, Tray, Menu: { buildFromTemplate: (t) => t }, nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) }, BrowserWindow: { getAllWindows: () => wins }, dialog };
  const handlers = new Map();
  require('../../main-ext.js').register({ handle: (c, f) => handlers.set(c, f) }, { fs: fsp, path, electron, getMainWindow: () => main, getDesktopSettings: async () => ({ trayIcon: true, closeToTray: true }), patchDesktopSettings: async () => ({}) });
  app.emit('browser-window-created', {}, main);
  return { app, main, dialog, nativePending, showItem: () => trayMenu[0].click, wins };
}
(async () => {
  // 1. 子視窗（匯入技能的資料夾選擇）開著 → 關主視窗 → 子視窗被當成取消關掉、主視窗縮到系統匣 → 顯示視窗：主視窗回來且沒有孤兒子視窗
  {
    const t = setup(); await new Promise((r) => setTimeout(r, 20));
    const dlg = new FakeWin(t.main); let resolved = 'pending'; dlg.on('closed', () => { resolved = null; });   // 對應 showFolderBrowserWindow：closed ＝ 取消
    t.main.close();
    check('子視窗被當成取消關掉（resolve null）', dlg.destroyed && resolved === null);
    check('主視窗縮到系統匣（隱藏、不在工作列）', !t.main.destroyed && !t.main.visible && t.main.skip === true);
    t.showItem()();
    check('顯示視窗：主視窗回到前景可操作，沒有留下失控的子視窗', t.main.visible && t.main.focused && t.main.skip === false && t.main.getChildWindows().length === 0);
  }
  // 2. 子視窗關不掉（close 被擋）→ 強制銷毀
  {
    const t = setup(); await new Promise((r) => setTimeout(r, 20));
    const dlg = new FakeWin(t.main); dlg.close = () => { throw new Error('stuck'); };
    t.main.close();
    check('子視窗關不掉時強制銷毀', dlg.destroyed && !t.main.visible);
  }
  // 3. 原生對話框還沒回應 → 不縮到系統匣，視窗帶到前面
  {
    const t = setup(); await new Promise((r) => setTimeout(r, 20));
    const p = t.dialog.showOpenDialog(t.main, {}); t.main.visible = true; t.main.focused = false;
    t.main.close();
    check('原生對話框未回應：不隱藏、視窗被帶到前面', t.main.visible && t.main.focused && !t.main.destroyed);
    t.nativePending[0]({ canceled: true }); await p; await new Promise((r) => setTimeout(r, 5));
    t.main.close();
    check('對話框回應後再關，才縮到系統匣', !t.main.visible && !t.main.destroyed);
  }
  // 4. 已經被藏起來、子視窗還在（舊行為留下的）→ 顯示視窗要把子視窗一起帶回
  {
    const t = setup(); await new Promise((r) => setTimeout(r, 20));
    t.main.hide(); const dlg = new FakeWin(t.main); dlg.visible = false;
    t.showItem()();
    check('顯示視窗：主視窗與還活著的子視窗一起顯示並取得焦點', t.main.visible && dlg.visible && dlg.focused);
  }
  console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'tray_dialog.test: ' + ok + ' checks passed'); process.exit(bad.length ? 1 : 0);
})();
