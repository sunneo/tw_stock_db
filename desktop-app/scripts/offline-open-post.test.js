// 統一迴圈補齊（DESIGN.offline-intent-pipeline.md 第 17 節）：①tool 路徑開啟後接著做剩餘目標（摘要等），做不到的明寫「沒做到」，有風險的先確認
// ②各路徑共用 _faOtTrailText 組步驟記錄 ③狀態機步驟併進同一份 trail，卡片只有一份「做了這些步驟」。函式是從原始碼切出來的真函式，工具是假的。
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8').split('\r\n').join('\n');
const G = require('../renderer/src/offline/intent_gate.js');
let pass = 0, fail = 0; const ok = (c, n) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const a = src.indexOf('/* OT-WEB-BEGIN */'), b = src.indexOf('/* OT-WEB-END */');
const sumFn = (sents, n) => sents.slice(0, n);
const lib = new Function('_faSemSentences', '_faSummarize', src.slice(a, b) + '\nreturn { _faOtWebGoal, _faOtWebFilter, _faOtGoodLines, _faOtFindSearchBox, _faOtFollowAll, _faOtTrailText, _faOtAdjustSteps };')((t) => t.split(/[\n。]/).map((x) => x.trim()).filter(Boolean), sumFn);
const RISKY = new Function('return ' + /const FA_OT_RISKY_TOOL = (\/.*\/i);/.exec(src)[1])();
const sl = (from, to) => { const i = src.indexOf(from), j = src.indexOf(to, i); if (i < 0 || j < 0) throw new Error('slice ' + from); return src.slice(i, j); };
const body = [sl('    async _otExecute(plan, opts) {', '    // ---- 階段4'), sl('    async _otCallAssistantTool(name, args, opts, trail) {', '    async _otExecFsm('), sl('    async _otExecFsm(', '    // 離線時「做不到」的請求記下來'), sl('    // 使用者自訂的同義詞組', '    async _otBumpHit(plan) {')].join('\n');
const fsmStub = async (d, entry, scope, io) => { const r = await io.callTool('fetch_web_page', { url: 'https://x' }); scope.last_tool_result = r.result || r; return { status: 'solved', trace: [{ state: 'fetch', tool: 'fetch_web_page', ok: true }, { state: 'done' }], context: {} }; };
const Cls = new Function('L', 'FaIntentGate', 'FA_SEM_LEX', '_faSemSentences', '_faSummarize', 'FA_OT_RISKY_TOOL', '_faOtFsmRun', '_faOtSlots', 'const { _faOtWebGoal, _faOtWebFilter, _faOtGoodLines, _faOtFindSearchBox, _faOtFollowAll, _faOtTrailText, _faOtAdjustSteps } = L;\nconst _faOtWantsVisible = () => false;\nreturn (class {\n' + body + '\n});')(lib, G, { cjk: [], word: {} }, (t) => t.split(/[\n。]/).map((x) => x.trim()).filter(Boolean), sumFn, RISKY, fsmStub, () => ({}));
const methods = {}; Object.getOwnPropertyNames(Cls.prototype).filter((n) => n !== 'constructor').forEach((n) => { methods[n] = Cls.prototype[n]; });
const mkFa = (tools, extra) => Object.assign({ tools, _ot: { synonyms: {}, domains: new Map([['d', { states: { states: { s: {} } } }]]) }, _otLoad: async function () { return this._ot; }, _otFindJsTool: () => null, _otPretty: (raw) => String(raw).slice(0, 60), _otShowImage() { }, _otSynGroups: () => [], _otSearchWaitMs: 0 }, methods, extra || {});
const mkTool = (log, name, fn) => ({ callback: async (s) => { const args = JSON.parse(s); log.push([name, args]); return JSON.stringify(fn(args)); } });
const planOf = (text, tool, risk) => { const gate = G.gate(text); return { text, slots: {}, gate, decision: { status: 'planned', chosen: { kind: 'tool', tool: tool || gate.openTool, args: gate.openArgs || {}, risk: risk || 'safe', domain: 'intent_gate', pattern: 'gate_open_' + gate.kind, score: 0.9, via: '理解閘' } } }; };
const DOC = ['本合約由甲乙雙方於民國一百一十三年簽訂。', '甲方負責提供全部開發資料並於三十日內完成驗收。', '乙方應於驗收通過後十五日內支付尾款新台幣五十萬元。', '任何一方違約需賠償對方實際損失並負擔訴訟費用。'];

(async () => {
    ok(lib._faOtTrailText(['a', 'b']) === '📋 做了這些步驟：\n- a\n- b\n\n' && lib._faOtTrailText([], '') === '' && lib._faOtTrailText(['a'], '') === '📋 做了這些步驟：\n- a', '共用函式：步驟記錄的格式只在一處定義（與原本各路徑的輸出逐字相同）');

    // ① tool 路徑：打開 x.docx 並摘要
    let log = [], pages = 0;
    const q1 = '打開 合約.docx 並摘要 [附件：合約.docx（file_id=f1）]';
    let fa = mkFa({ edit_docx_open: mkTool(log, 'open', () => ({ ok: true, id: 'w1' })), parse_uploaded_file: { callback: async (s) => { const a2 = JSON.parse(s); log.push(['parse', a2]); pages++; return JSON.stringify(pages === 1 ? { ok: true, content: DOC.slice(0, 2).join('。'), has_more: true, next_offset: 50, total_chars: 100 } : { ok: true, content: DOC.slice(2).join('。'), has_more: false, total_chars: 100 }); } } });
    let r = await fa._otExecute(planOf(q1), {});
    ok(r.ok && log[0][0] === 'open' && log.filter((x) => x[0] === 'parse').length === 2, 'tool：先開啟，再用 parse_uploaded_file 把檔案內容讀完（續讀 2 次）');
    ok(/做了這些步驟/.test(r.text) && /機械摘要/.test(r.text) && /尾款|驗收/.test(r.text), 'tool：開啟後做了摘要，卡片列步驟並附摘要');
    ok(!/沒做到/.test(r.text), 'tool：做到的不寫「沒做到」');

    // 沒附檔案：摘要做不到 → 明寫
    log = []; fa = mkFa({ edit_docx_open: mkTool(log, 'open', () => ({ ok: true })) });
    const p2 = planOf('打開Word文件編輯器並摘要'); r = await fa._otExecute(p2, {});
    ok(r.ok && /沒做到：摘要（沒有可讀的檔案內容/.test(r.text), 'tool：沒有可讀的檔案內容時，卡片明寫「沒做到：摘要」');

    // 截圖：沒有瀏覽器分頁，做不到
    log = []; pages = 0;
    fa = mkFa({ edit_docx_open: mkTool(log, 'open', () => ({ ok: true })), parse_uploaded_file: { callback: async () => JSON.stringify({ ok: true, content: DOC.join('。'), has_more: false }) } });
    r = await fa._otExecute(planOf('打開 合約.docx 並截圖 [附件：合約.docx（file_id=f1）]'), {});
    ok(r.ok && /沒做到：截圖/.test(r.text), 'tool：截圖需要瀏覽器分頁，做不到時明寫');

    // 剩餘目標沒處理
    log = []; fa = mkFa({ edit_xlsx_open: mkTool(log, 'open', () => ({ ok: true })) });
    const p4 = planOf('打開那個試算表然後告訴我哪個月最高 [附件：a.xlsx（file_id=f2）]'); r = await fa._otExecute(p4, {});
    ok(r.ok && /只做了動作，沒處理：告訴我哪個月最高/.test(r.text), 'tool：沒處理的剩餘目標明寫「只做了動作，沒處理」');

    // 開啟失敗：不做後置步驟、不報成功
    log = []; fa = mkFa({ edit_docx_open: mkTool(log, 'open', () => ({ ok: false, error: 'boom' })), parse_uploaded_file: mkTool(log, 'parse', () => ({ ok: true, content: 'x' })) });
    r = await fa._otExecute(planOf(q1), {});
    ok(r.ok === false && !log.some((x) => x[0] === 'parse'), 'tool：開啟失敗就不接後置步驟、不報成功');

    // 有風險的先確認，取消就什麼都不做
    log = []; let asked = 0;
    fa = mkFa({ edit_docx_open: mkTool(log, 'open', () => ({ ok: true })), parse_uploaded_file: mkTool(log, 'parse', () => ({ ok: true, content: DOC.join('。') })) }, { requestUserForm: async () => { asked++; return { confirmed: false }; } });
    r = await fa._otExecute(planOf(q1, null, 'confirm'), {});
    ok(asked === 1 && r.cancelled && log.length === 0, 'tool：risk:confirm 先確認，取消後開啟與後置步驟都不執行');

    // ③ fsm：狀態機步驟併進同一份 trail
    log = []; let n = 0;
    fa = mkFa({ fetch_web_page: { callback: async (s) => { log.push(JSON.parse(s)); n++; return JSON.stringify(n === 1 ? { ok: true, title: 't', url: 'u', text: 'A', has_more: true, next_offset: 1, total_chars: 2 } : { ok: true, text: 'B', has_more: false, total_chars: 2 }); } } });
    r = await fa._otExecFsm({ text: '讀', decision: {} }, { domain: 'd', state: 's' }, {});
    ok(r.ok && /🧩 狀態機步驟：fetch → fetch_web_page/.test(r.text) && (r.text.match(/📋/g) || []).length === 1, 'fsm：狀態機步驟列在同一份「做了這些步驟」裡（卡片只有 1 份步驟記錄）');
    ok(/讀取網頁內容|還沒讀完|已讀完/.test(r.text) && log.length === 2, 'fsm：狀態機裡讀網頁的續讀也記進同一份 trail（呼叫 ' + log.length + ' 次）');

    console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
