// 找「最新已安裝的原生執行包」資料夾：與主程式用同一個函式（main-ext.js 的 findNativeRuntime：新版優先、舊版退路、全檔核對 md5），
// 評估腳本不再寫死版本資料夾（1.22.0-1、1.22.0-2…）。
//   程式：const { findInstalledRuntime } = require('./find_installed_runtime.js'); const r = findInstalledRuntime(userDataDir?); r.dir / r.version
//   命令列：node scripts/eval/find_installed_runtime.js [--user-data <資料夾>]   → 只印出執行包資料夾（找不到時印原因到標準錯誤並以 1 結束）
// userData 預設＝桌面版的使用者資料夾（Windows：%APPDATA%\floating-assistant-desktop；其他：~/.config 或 ~/Library/Application Support）。
'use strict';
const path = require('path');
const os = require('os');

function defaultUserData() {
    if (process.env.FA_USER_DATA) return process.env.FA_USER_DATA;
    if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'floating-assistant-desktop');
    if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'floating-assistant-desktop');
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'floating-assistant-desktop');
}

// 回 { ok, dir, version, features, legacy, reason }；沒有任何可用版本時 ok:false（reason 說明）
function findInstalledRuntime(userData) {
    const ext = require(path.join(__dirname, '..', '..', 'main-ext.js'));
    const r = ext._findNativeRuntime(userData || defaultUserData());
    return r || { ok: false, reason: '沒有找到任何已安裝的原生執行包' };
}

// 取得資料夾字串；找不到就丟出帶原因的錯誤（不退回寫死的舊路徑）
function requireInstalledRuntimeDir(userData) {
    const r = findInstalledRuntime(userData);
    if (!r.ok || !r.dir) throw new Error('找不到可用的原生執行包（' + (r.reason || '未知') + '；userData=' + (userData || defaultUserData()) + '）');
    return r.dir;
}

module.exports = { findInstalledRuntime, requireInstalledRuntimeDir, defaultUserData };

if (require.main === module) {
    const a = process.argv.slice(2), i = a.indexOf('--user-data');
    try { console.log(requireInstalledRuntimeDir(i >= 0 ? a[i + 1] : undefined)); }
    catch (e) { console.error(e.message); process.exit(1); }
}
