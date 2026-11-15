// 內建 LoRA 在訓練工作室「LoRA 登錄」分頁看得到（回歸測試）。
// 目的：鎖住三件事 —（1）檢視器範本的內嵌腳本可以解析（先前記過的「符號式擬合區段語法錯誤」已不在）；
// （2）嵌入到 floating-assistant.js 的檢視器與範本逐字相同（忽略 CRLF）；（3）用跟 lora-adapters 分支 builtin.json 同形狀的 6 顆清單，
// 走真的 /api/builtin 路由與 builtinCardsHTML，6 張卡都出得來，plan-r4 的把關提示也在。
// 沒測到：真 Electron 的 IPC、真網路抓清單、分頁的實際點擊（那要真桌面版驗證）。
'use strict';
const fs = require('fs'), path = require('path');
const { createServer } = require('./studio_server_core.js');
const Storage = require('./storage_core.js');
const LM = require('./lora_manage_core.js');

let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };

// 1. 範本的內嵌腳本可解析（new Function 只編譯不執行）
const tplPath = path.join(__dirname, 'studio-viewer.template.html');
const tpl = fs.readFileSync(tplPath, 'utf8').replace(/\r\n/g, '\n');
const scriptRe = /<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/g;
let m, nScripts = 0, parseErr = null;
while ((m = scriptRe.exec(tpl))) { nScripts++; try { new Function(m[1]); } catch (e) { parseErr = parseErr || e; } }
check('viewer template: inline scripts found', nScripts >= 1, nScripts);
check('viewer template: inline scripts parse', !parseErr, parseErr && String(parseErr.message));

// 2. 嵌入到 floating-assistant.js 的 FA_STUDIO_VIEWER_HTML 與範本逐字相同（忽略 CRLF）
const faSrc = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
const line = faSrc.split('\n').find((l) => l.indexOf('const FA_STUDIO_VIEWER_HTML = ') === 0);
let embedded = null;
try { embedded = (0, eval)('(' + line.replace(/^const FA_STUDIO_VIEWER_HTML = /, '').replace(/;\s*$/, '') + ')'); } catch (e) { embedded = null; }
check('embedded viewer: constant found and evaluates', typeof embedded === 'string', line && line.slice(0, 80));
if (typeof embedded === 'string') check('embedded viewer == template (ignore CRLF)', embedded.replace(/\r\n/g, '\n') === tpl, { emb: embedded.length, tpl: tpl.length });

// 3. 6 顆內建 LoRA（形狀同 lora-adapters/builtin.json：id、name、size、parts、domains、gate、defaultOn）
const IDS = [['decompose-r4-v2', 'decompose', true], ['toolcall-r4', 'toolcall', true], ['plan-r4', 'plan', false], ['colu-r4', 'colu', true], ['codewrite-r4', 'codewrite', true], ['reading-r4', 'reading', true]];
const manifest = { format: 'fa-lora-builtin', version: 1, base_url: 'https://example.invalid/', entries: IDS.map(([id, dom, pass]) => ({
    id, name: id, version: '1.0.0', size: 40375000, sha256: '0'.repeat(64), dir: id,
    parts: [{ file: id + '.fatrain.part00', size: 40375000, sha256: '0'.repeat(64) }],
    domains: [dom], defaultOn: true,
    gate: pass ? { pass: true, reason: '評測數字齊全' } : { pass: false, reason: 'self_validate 單邊退化' },
    limits: [] })) };
const builtinCall = async (op) => {
    if (op === 'builtin_manifest') return { ok: true, source: 'network', note: '', manifest };
    if (op === 'builtin_status') return { ok: true, downloaded: {}, progress: {} };
    return { ok: false, message: '測試未實作：' + op };
};
let prefs = {};
const storage = Storage.createStorage({ memory: Storage.createMemoryStore() });
const h = { storage, desktop: true, now: () => 1000, prefsGet: () => prefs, prefsSet: (p) => { prefs = p; }, download: async () => {}, pickFile: async () => null, pickFiles: async () => null, builtinCall, readBytes: async () => new Uint8Array() };
const srv = createServer(h);

(async () => {
    const r = await srv.route('GET', new URL('http://x/api/builtin'), undefined);
    const v = r.j;
    check('route: ok and available on desktop', v.ok === true && v.available === true, v);
    check('route: six entries', Array.isArray(v.entries) && v.entries.length === 6, v.entries && v.entries.length);
    const html = LM.builtinCardsHTML(v);
    check('cards: six card blocks rendered', (html.match(/class="card"/g) || []).length === 6, (html.match(/class="card"/g) || []).length);
    check('cards: every id appears', IDS.every(([id]) => html.indexOf('>' + id + '<') >= 0), null);
    check('cards: plan-r4 gate warning shown', html.indexOf('被把關擋下') >= 0 && html.indexOf('self_validate 單邊退化') >= 0, null);
    check('cards: group heading shown', html.indexOf('內建 LoRA（預設使用）') >= 0, null);
    console.log('lora_builtin_visible: ' + ok + ' 通過，' + bad.length + ' 失敗');
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('FAIL 例外', e && e.stack); process.exit(1); });
