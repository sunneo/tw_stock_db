// 申請工具（request_additional_tools）沒發揮作用的檢討（2026-11-12）：模型直接叫名單外的工具（簡報領域叫 generate_image），
// 被當成最終答案、沒有糾正。修正：名單外的真工具自動追加；追加不了時退回並教它申請；簡報領域本來就有 generate_image；畫圖結果直接給 ref。
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '../..'); const fa = fs.readFileSync(path.join(root, 'renderer/src/floating-assistant.js'), 'utf8'); const dt = fs.readFileSync(path.join(root, 'renderer/src/deck/deck_tools.js'), 'utf8');
let ok = 0; const bad = []; const check = (n, c) => { if (c) ok++; else bad.push(n); };
check('簡報領域工具清單有 generate_image', /const DOMAIN_TOOLS = \['generate_image'/.test(dt));
check('子任務執行器有自動追加（autoGrantTool），跟申請共用上限', /function autoGrantTool\(fnName\)/.test(fa) && /toolEscalationCount >= SUBAGENT_MAX_TOOL_ESCALATIONS\) return false/.test(fa));
check('高風險工具不自動追加', /run_command\|bash_execute\|python_execute\|fs_write_file/.test(fa));
check('文字寫成的名單外呼叫：先試自動追加', /autoGrantTool\(dc2\.name\)/.test(fa));
check('名單外的工具描述呼叫不再被當最終答案（會退回並教申請）', /名單外但真的存在的工具/.test(fa) && /它不在你目前的工具名單裡，沒有被執行/.test(fa));
check('偵測函式不再因名單外就放過', /名單外的工具也要認得/.test(fa));
check('畫圖結果直接給 ref，不必再匯入', /_deckAnnotateResult\(toolName, result\)/.test(dt) && /result = this\._deckAnnotateResult\(fnName, result\)/.test(fa));
// 只有參數、沒有工具名的回覆（{ "topic": "format" }）：依參數結構唯一對應到工具才當成呼叫
{
    const i = fa.indexOf('    _parseDescribedToolCall(text, availableToolNames) {'); const j = fa.indexOf('\n    }\n', i);
    const fn = new Function('return function ' + fa.slice(i, j + 6).trim() + '')();
    const self = { tools: { get_presentation_topic: { parametersSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } }, find_photo: { parametersSchema: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number' } }, required: ['query'] } }, other: { parametersSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } } } };
    const names = ['get_presentation_topic', 'find_photo'];
    const r = fn.call(self, '{ "topic": "format" }', names);
    check('只有參數：唯一對應 → 當成該工具的呼叫', r && r.name === 'get_presentation_topic' && r.args.topic === 'format' && r.inferred, r);
    check('只有參數：兩個工具都符合 → 不猜', fn.call(self, '{ "topic": "format" }', ['get_presentation_topic', 'other']) === null);
    check('只有參數：欄位對不上任何工具 → 不猜', fn.call(self, '{ "zzz": 1 }', names) === null);
    check('有寫工具名的照舊', (fn.call(self, '{"tool":"find_photo","args":{"query":"x"}}', names) || {}).name === 'find_photo');
}
check('有網址的簡報：系統先讀網址與文章原圖再交給模型', /先替你讀好網址/.test(fa) && /_deckArticleImages\(um\[0\], 8, lg\)/.test(fa) && /系統已讀好這個網址/.test(fa));
check('文章原圖只留內文的圖：略過相關文章縮圖與跟標題無關的圖', /略過（不是文章內文的圖）/.test(fa) && /thumb\|_s\\\.\|small\|related/.test(fa) && /const relevant = \(alt\)/.test(fa));
check('簡報提示詞有計畫範本（步驟＋最小合法範例）', /PLAN TEMPLATE/.test(dt) && /A MINIMAL VALID DECK/.test(dt) && /STEP 5/.test(dt));
check('函式寫法的呼叫會被認出並依序執行', /_parsePseudoCalls\(text, allowedNames\)/.test(fa) && /_looseCallArgs\(content, toolName\)/.test(fa) && /已依序當成真的呼叫執行/.test(fa));
{
    const i = fa.indexOf('    _looseCallArgs(content, toolName) {'); const j = fa.indexOf('\n    }\n', i); const k = fa.indexOf('    _parsePseudoCalls(text, allowedNames) {'); const k2 = fa.indexOf('\n    }\n', k);
    const mk = (src) => new Function('return {' + src.trim().replace(/^_/, '_') + '}')();
    const L = mk(fa.slice(i, j + 6)), P = mk(fa.slice(k, k2 + 6));
    const self = { tools: { get_presentation_topic: { parametersSchema: { properties: { topic: {} }, required: ['topic'] } }, begin_presentation: { parametersSchema: { properties: { deck: {} } } }, add_chapters: { parametersSchema: { properties: { draft: {}, yaml: {} } } } }, _extractBalancedCallArgs(text, open) { let d = 0, q = null; for (let x = open; x < text.length; x++) { const c = text[x]; if (q) { if (c === '\\') { x++; continue; } if (c === q) q = null; continue; } if (c === '"') { q = c; continue; } if ('({['.includes(c)) d++; if (')}]'.includes(c)) { d--; if (d === 0 && c === ')') return { content: text.slice(open + 1, x), endIndex: x + 1 }; } } return { content: '', endIndex: null }; } };
    self._looseCallArgs = L._looseCallArgs; self._parsePseudoCalls = P._parsePseudoCalls;
    const txt = 'get_presentation_topic({"names":["format"]}) begin_presentation(deck: "title: A\\nlang: zh-TW") add_chapters(draft, "chapters:\\n - title: x") 本簡報共8張';
    const calls = self._parsePseudoCalls(txt, ['get_presentation_topic', 'begin_presentation', 'add_chapters']);
    check('函式寫法：三個呼叫依序認出', calls && calls.map((c) => c.name).join() === 'get_presentation_topic,begin_presentation,add_chapters', calls);
    check('函式寫法：key: "字串"（含 \\n）與位置參數', calls && calls[1].args.deck === 'title: A\nlang: zh-TW' && calls[2].args.draft === 'draft' && /^chapters:\n/.test(calls[2].args.yaml), calls);
    check('函式寫法：一般文字不誤判', self._parsePseudoCalls('今天天氣很好，沒有呼叫', ['begin_presentation']) === null);
}
check('輸出狀態機：runner 檢查 outputContract、簡報宣告最終產物', /options\.outputContract/.test(fa) && /function faDeckContract\(\)/.test(fa) && /outputContract: isDeck \? faDeckContract\(\)/.test(fa) && /這個請求要的最終產物是/.test(fa));
{
    const i = fa.indexOf('function faDeckContract() {'); const j = fa.indexOf('\n}\n', i); const C = new Function(fa.slice(i, j + 3) + '; return faDeckContract();')();
    check('簡報狀態機：有 visual 或 render 成功才算完成', C.done({ calls: [], visual: { x: 1 } }) && C.done({ calls: [{ name: 'render_presentation', ok: true }] }) && !C.done({ calls: [{ name: 'import_image_url', ok: true }] }));
    check('簡報狀態機：依呼叫紀錄給不同的下一步', /還沒有送出任何簡報/.test(C.describe({ calls: [] })) && /yaml_id/.test(C.describe({ calls: [{ name: 'render_presentation', ok: false }] })) && /add_chapters/.test(C.describe({ calls: [{ name: 'begin_presentation', ok: true }] })));
}
console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'tool_request_wiring: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
