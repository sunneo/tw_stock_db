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
    // 4. iframe 作用域：檢視器 iframe 只有 __LAYOUT__ 與本次注入的模組，LM（FaStudioLoraManage）與 FaStudioPipelineView 必須在裡面
    //    （先前缺這兩個全域，T.lora 在按鈕之後丟 ReferenceError，畫面只剩幾行字）。用 vm 另開一個全域，模擬 iframe 內沒有父視窗的全域。
    const vm = require('vm');
    const getConst = (name) => { const l = faSrc.split('\n').find((x) => x.indexOf('const ' + name + ' = ') === 0); return l ? JSON.parse(l.replace(/^const [A-Z_]+ = /, '').replace(/;\s*$/, '')) : null; };
    const layoutSrc = getConst('FA_STUDIO_LAYOUT_SRC'), lmSrc = getConst('FA_STUDIO_LORA_MANAGE_SRC'), pvSrc = getConst('FA_STUDIO_PIPELINE_VIEW_SRC');
    check('iframe sources: embedded constants present', typeof layoutSrc === 'string' && typeof lmSrc === 'string' && typeof pvSrc === 'string', null);
    const frame = { setTimeout, clearTimeout }; frame.self = frame; vm.createContext(frame); // iframe 裡有計時器（與瀏覽器一樣）
    let frameErr = null;
    try { vm.runInContext(layoutSrc, frame); vm.runInContext(lmSrc, frame); vm.runInContext(pvSrc, frame); } catch (e) { frameErr = e; }
    check('iframe sources: run without error', !frameErr, frameErr && String(frameErr.message));
    check('iframe: FaStudioLoraManage is defined', frame.FaStudioLoraManage && typeof frame.FaStudioLoraManage.renderLoraManageHTML === 'function', Object.keys(frame));
    check('iframe: FaStudioPipelineView is defined', frame.FaStudioPipelineView && typeof frame.FaStudioPipelineView.renderPipelineHTML === 'function', Object.keys(frame));
    check('template: placeholders for LoRA and pipeline present', tpl.indexOf('__LORA_MANAGE__') >= 0 && tpl.indexOf('__PIPELINE_VIEW__') >= 0, null);
    check('assembly: floating-assistant replaces both placeholders', faSrc.indexOf(".replace('__LORA_MANAGE__'") >= 0 && faSrc.indexOf(".replace('__PIPELINE_VIEW__'") >= 0, null);

    // 5. 空登錄（status 沒有任何 LoRA，native 沒有 last）：列表要出「無資料」字樣，不能丟例外
    const LM2 = frame.FaStudioLoraManage;
    const emptyStatus = { ok: true, replacing: null, slotCapacity: 16, usedRank: 0, freeRank: 16, maxActive: 1, budget: 268435456, usedBytes: 0, slots: [], registered: [], native: { ok: false, available: false, error: '這個環境沒有原生推論的套用狀態（不是桌面版）' } };
    let emptyHtml = null, emptyErr = null;
    try { emptyHtml = LM2.renderLoraManageHTML({ rows: LM2.rowsFromStatus(emptyStatus), budget: LM2.budgetOf(emptyStatus), busy: LM2.busyText(emptyStatus) }); } catch (e) { emptyErr = e; }
    check('status without LoRA: renders without error', !emptyErr && typeof emptyHtml === 'string', emptyErr && String(emptyErr.message));
    check('status without LoRA: shows empty-registry text', emptyHtml && emptyHtml.indexOf('無資料（還沒有註冊的 LoRA）') >= 0, emptyHtml);

    // 6. 內建清單逾時與丟例外：畫面要顯示「哪一步、錯誤、耗時」，不能空白
    const hangSrv = createServer(Object.assign({}, h, { builtinCall: () => new Promise(() => {}) }));
    const tb = Date.now(); let hangErr = null;
    try { await LM2.withTimeout(hangSrv.route('GET', new URL('http://x/api/builtin'), undefined), 50, '讀取內建 LoRA 清單'); } catch (e) { hangErr = e; }
    const hangMsg = LM2.errorText('讀取內建 LoRA 清單', hangErr, Date.now() - tb);
    check('builtin hang: withTimeout rejects with timeout text', !!hangErr && /逾時/.test(hangErr.message), hangErr && hangErr.message);
    check('builtin hang: error text has step, message and elapsed ms', /讀取內建 LoRA 清單失敗/.test(hangMsg) && /耗時 \d+ 毫秒/.test(hangMsg), hangMsg);
    const hangCards = LM2.builtinCardsHTML({ ok: false, available: true, master: false, entries: [], message: hangMsg });
    check('builtin hang: card block shows the error (not blank)', hangCards.indexOf('讀取內建 LoRA 清單失敗') >= 0 && hangCards.indexOf('重新抓清單') >= 0, hangCards);

    const throwSrv = createServer(Object.assign({}, h, { builtinCall: async () => { throw new Error('IPC 斷線（測試）'); } }));
    const tv = await throwSrv.route('GET', new URL('http://x/api/builtin'), undefined).then((x) => x.j).catch((e) => ({ ok: false, message: String(e) }));
    const throwCards = LM2.builtinCardsHTML(tv);
    check('builtin throws: card block not blank, shows reason', throwCards.indexOf('內建 LoRA') >= 0 && throwCards.indexOf('IPC 斷線（測試）') >= 0 || throwCards.indexOf('抓不到內建清單') >= 0, throwCards);
    console.log('lora_builtin_visible: ' + ok + ' 通過，' + bad.length + ' 失敗');
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('FAIL 例外', e && e.stack); process.exit(1); });
