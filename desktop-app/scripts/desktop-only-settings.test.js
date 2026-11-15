// 桌面專屬設定（fa-local://）在網頁版要忽略：匯入時丟掉並列出鍵名、讀取既有設定時只在使用處忽略（不改原始資料）、
// proxy失敗要真的退回直連（資源取得與Pyodide四個候選來源）。用真的函式原始碼（從 renderer/src/floating-assistant.js 切出來），
// 網路與loadPyodide是假的。2026-11-15。
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8').split('\r\n').join('\n');
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x))); } };

// 1. 頂層區塊（桌面專屬設定的判斷與匯入剝除）
const blk = src.slice(src.indexOf('/* DESKTOP-ONLY-BEGIN */'), src.indexOf('/* DESKTOP-ONLY-END */'));
const D = new Function(blk + '\nreturn { FA_DESKTOP_ONLY_SETTING_KEYS, faInDesktopEnv, faIsDesktopOnlyValue, faStripDesktopOnlySettings };')();
const pyodideBase = /pyodideJsBase: '([^']+)'/.exec(src)[1], pyodideBackup = /pyodideBackupBase: '([^']+)'/.exec(src)[1];
const FA_ASSET_URLS = { pyodideJsBase: pyodideBase, pyodideBackupBase: pyodideBackup };
const SHIM = '#shim', URLLIB = '#urllib';

// 2. 類別方法（代理取用層、_fetchViaProxyThenDirect、_ensurePyodideLoaded）
const mA = src.indexOf('    _resolveAssetProxyUrl() {'), mB = src.indexOf('    // 單純二進位資源（例如busybox.wasm）');
const pA = src.indexOf('    async _ensurePyodideLoaded() {'), pB = src.indexOf('    // tw_stock_db客製: 2026-09-25——yt-dlp的HTTP網路橋接');
const Cls = new Function('faIsDesktopOnlyValue', 'faInDesktopEnv', 'FA_ASSET_URLS', 'PYODIDE_SUBPROCESS_SHIM_SRC', 'PYODIDE_URLLIB_SHIM_SRC',
    'return (class {\n' + src.slice(mA, mB) + '\n' + src.slice(pA, pB) + '\n});')(D.faIsDesktopOnlyValue, D.faInDesktopEnv, FA_ASSET_URLS, SHIM, URLLIB);
const mk = (adv) => {
    const o = new Cls();
    o.advancedSettings = adv || {};
    o._sandboxDirectOnly = 0;
    o._ytDlpHttpBridge = () => ({});
    o._mpBridge = () => ({});
    o._mpInstallShim = () => { };
    o._log = () => { };
    return o;
};
const setEnv = (desktop) => { globalThis.window = desktop ? { desktopAPI: {} } : {}; };
const fakeInstance = () => ({ registerJsModule() { }, runPython() { } });

(async () => {
    // ---- 判斷
    ok(D.faIsDesktopOnlyValue('fa-local://app') === true, 'fa-local:// 視為桌面專屬');
    ok(D.faIsDesktopOnlyValue('  FA-LOCAL://app') === true, '大小寫與前導空白也認得');
    ok(D.faIsDesktopOnlyValue('https://cdn.example/x') === false && D.faIsDesktopOnlyValue('') === false, '一般網址不是桌面專屬');
    ok(D.FA_DESKTOP_ONLY_SETTING_KEYS.join(',') === 'assetBackupProxyUrl,browserSearchProxyUrl,gitCorsProxyUrl,ttsApiProxyUrl', '四個代理設定鍵都在清單內');

    // ---- 匯入：網頁版剝除並回報鍵名
    setEnv(false);
    let cfg = { apiUrl: 'fa-local://app/nvidia', advancedSettings: { assetBackupProxyUrl: 'fa-local://app', browserSearchProxyUrl: 'fa-local://app', gitCorsProxyUrl: 'fa-local://app', ttsApiProxyUrl: '', llmModelRows: [{ apiUrl: 'https://ok.example/v1' }, { apiUrl: 'fa-local://app/nvidia' }] } };
    let skipped = D.faStripDesktopOnlySettings(cfg);
    ok(JSON.stringify(skipped) === JSON.stringify(['apiUrl', 'assetBackupProxyUrl', 'browserSearchProxyUrl', 'gitCorsProxyUrl', 'llmModelRows[1].apiUrl']), '網頁版匯入：列出被略過的鍵名', skipped);
    ok(!('apiUrl' in cfg) && cfg.advancedSettings.assetBackupProxyUrl === '' && cfg.advancedSettings.gitCorsProxyUrl === '', '網頁版匯入：桌面專屬值被清成空字串／移除');
    ok(cfg.advancedSettings.llmModelRows[0].apiUrl === 'https://ok.example/v1', '一般的row不受影響');

    cfg = { advancedSettings: { assetBackupProxyUrl: 'https://proxy.example/' } };
    ok(D.faStripDesktopOnlySettings(cfg).length === 0 && cfg.advancedSettings.assetBackupProxyUrl === 'https://proxy.example/', '網頁版：一般網址的proxy設定不被略過');

    setEnv(true);
    cfg = { apiUrl: 'fa-local://app/nvidia', advancedSettings: { assetBackupProxyUrl: 'fa-local://app' } };
    skipped = D.faStripDesktopOnlySettings(cfg);
    ok(skipped.length === 0 && cfg.advancedSettings.assetBackupProxyUrl === 'fa-local://app', '桌面版匯入：照用，不剝除');

    // ---- 讀取既有設定：只在使用處忽略，原始資料不動
    setEnv(false);
    let o = mk({ assetBackupProxyUrl: 'fa-local://app', gitCorsProxyUrl: 'fa-local://app' });
    ok(o._advUrlSetting('assetBackupProxyUrl') === '' && o._advUrlSetting('gitCorsProxyUrl') === '', '網頁版讀取：fa-local 值當成空');
    ok(o._viaAssetProxy('https://cdn.example/a.js') === 'https://cdn.example/a.js', '網頁版：不經過proxy（直接用原網址）');
    ok(o.advancedSettings.assetBackupProxyUrl === 'fa-local://app' && o.advancedSettings.gitCorsProxyUrl === 'fa-local://app', '網頁版讀取：原始設定沒有被改寫（回到桌面版還在）');
    setEnv(true);
    ok(o._advUrlSetting('assetBackupProxyUrl') === 'fa-local://app', '桌面版讀取：照用');
    ok(o._viaAssetProxy('https://cdn.example/a.js') === 'fa-local://app/proxy/https://cdn.example/a.js', '桌面版：經過本地proxy');

    // ---- 資源取得：proxy失敗退回直連
    setEnv(false);
    o = mk({ assetBackupProxyUrl: 'https://proxy.example' });
    let calls = [];
    globalThis.fetch = async (u) => { calls.push(u); if (u.startsWith('https://proxy.example/')) throw new TypeError('Failed to fetch'); return { ok: true, status: 200, json: async () => ({}) }; };
    let r = await o._fetchViaProxyThenDirect('https://cdn.example/a.wasm', {});
    ok(r.ok && calls.join(' ') === 'https://proxy.example/proxy/https://cdn.example/a.wasm https://cdn.example/a.wasm', 'proxy失敗（Failed to fetch）→ 退回直連', calls);

    calls = [];
    globalThis.fetch = async (u) => { calls.push(u); if (u.startsWith('https://proxy.example/')) return { ok: false, status: 502 }; throw new TypeError('Failed to fetch'); };
    let msg = '';
    try { await o._fetchViaProxyThenDirect('https://cdn.example/b.wasm', {}); } catch (e) { msg = e.message; }
    ok(calls.length === 2 && /HTTP 502/.test(msg) && /Failed to fetch/.test(msg) && /ms）/.test(msg) && msg.includes('https://cdn.example/b.wasm'), '全部失敗：錯誤訊息含每個來源的HTTP狀態／錯誤與耗時', msg);

    // ---- Pyodide：候選來源依序退回
    const P = FA_ASSET_URLS.pyodideJsBase, PB = FA_ASSET_URLS.pyodideBackupBase;
    globalThis.loadPyodide = async ({ indexURL }) => { globalThis.__lp.push(indexURL); return fakeInstance(); };
    setEnv(false);
    globalThis.__lp = [];
    o = mk({ assetBackupProxyUrl: 'fa-local://app' });
    let inst = await o._ensurePyodideLoaded();
    ok(!!inst && globalThis.__lp.join(' ') === P, '網頁版（proxy是fa-local，忽略）：直接用主要來源，不碰proxy', globalThis.__lp);

    setEnv(true);
    globalThis.__lp = [];
    globalThis.loadPyodide = async ({ indexURL }) => { globalThis.__lp.push(indexURL); if (indexURL.startsWith('https://proxy.example/')) throw new TypeError('Failed to fetch'); return fakeInstance(); };
    o = mk({ assetBackupProxyUrl: 'https://proxy.example' });
    inst = await o._ensurePyodideLoaded();
    ok(!!inst && o._pyodideIndexURL === P && globalThis.__lp.join(' ') === 'https://proxy.example/proxy/' + P + ' ' + P, 'proxy掛掉：Pyodide主要來源退回直連', globalThis.__lp);

    globalThis.__lp = [];
    globalThis.loadPyodide = async ({ indexURL }) => { globalThis.__lp.push(indexURL); if (indexURL.startsWith('https://proxy.example/') || indexURL === P) throw new TypeError('Failed to fetch'); return fakeInstance(); };
    o = mk({ assetBackupProxyUrl: 'https://proxy.example' });
    inst = await o._ensurePyodideLoaded();
    ok(!!inst && o._pyodideIndexURL === PB, '主要來源（經proxy與直連）都失敗：退到備份分支直連', { lp: globalThis.__lp, used: o._pyodideIndexURL });

    globalThis.__lp = [];
    globalThis.loadPyodide = async ({ indexURL }) => { globalThis.__lp.push(indexURL); throw new TypeError('Failed to fetch'); };
    o = mk({ assetBackupProxyUrl: 'https://proxy.example' });
    msg = '';
    try { await o._ensurePyodideLoaded(); } catch (e) { msg = e.message; }
    ok(/試了 4 個來源/.test(msg) && [P, PB, 'https://proxy.example/proxy/' + P, 'https://proxy.example/proxy/' + PB].every((u) => msg.includes(u)) && /Failed to fetch/.test(msg), '四個來源全失敗：訊息列出每個來源', msg.slice(0, 300));

    console.log(`desktop-only-settings: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
