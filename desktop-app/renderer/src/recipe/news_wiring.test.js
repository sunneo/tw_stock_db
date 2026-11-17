// node renderer/src/recipe/news_wiring.test.js
// 接線測試：從 floating-assistant.js 抽出真正的 _newsDigestAnswer／_newsFetchText／_isNewsAsk／_planLocalSummarize，
// 用假的 this：假的 fetch_web_page 工具（假網頁）、假的模型（只回內容中的原文片段，經得起 checkExtractive）、假的進度卡片。
// 純函式（FaNewsDigest、FaRecipe）用真的模組。斷言：取回內容一定送進模型、最終回答含模型摘要、非新聞問題不接手。
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const FaRecipe = require('./recipe_core.js');
const FaNewsDigest = require('./news_digest_core.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 300))); } };

function methodSource(name) {
    const re = new RegExp('\\n    (async )?' + name + '\\(');
    const m = re.exec(SRC); if (!m) throw new Error('找不到方法 ' + name);
    let i = SRC.indexOf('{', m.index + m[0].length); let depth = 0; const start = m.index + 1;
    for (; i < SRC.length; i++) {
        const c = SRC[i];
        if (c === '/' && SRC[i + 1] === '/') { i = SRC.indexOf('\n', i); continue; }
        if (c === "'" || c === '"' || c === '`') { const q = c; i++; while (i < SRC.length && SRC[i] !== q) { if (SRC[i] === '\\') i++; i++; } continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
    }
    throw new Error('方法 ' + name + ' 大括號不成對');
}
// 方法本體是「類別裡的一般方法」：包成物件後用 call 綁假的 this
function loadMethods(names, globals) {
    const ctx = Object.assign({ console, Promise, JSON }, globals || {}); vm.createContext(ctx);
    return vm.runInContext('({' + names.map(methodSource).join(',\n') + '})', ctx);
}

const YAHOO = 'https://tw.news.yahoo.com/';
const CNA = 'https://www.cna.com.tw/';
const A1 = 'https://tw.news.yahoo.com/a/1001', A2 = 'https://tw.news.yahoo.com/a/1002', A3 = 'https://tw.news.yahoo.com/a/1003';
const PAGES = {
    [YAHOO]: ['首頁', '登入', '黃仁勳宣布新一代 AI 晶片 Blackwell 量產 ' + A1, '今天天氣晴朗，午後偶有陣雨 ' + A3, '輝達股價盤中創高 黃仁勳：AI 需求仍強 ' + A2].join('\n'),
    [CNA]: '中央社導覽\n頭條新聞標題沒有連結也沒有網址\n更多',
    [A1]: '黃仁勳在 GTC 宣布 Blackwell 晶片進入量產，首批出貨給雲端業者。',
    [A2]: '輝達股價盤中創歷史新高，黃仁勳表示 AI 需求仍然強勁。',
    [A3]: '今天天氣晴朗，午後偶有陣雨，氣溫約 28 度。',
};

(async () => {
    const fetchCalls = []; const modelCalls = []; const progLines = []; const progDone = [];
    // 假的 fetch_web_page：callback 收 JSON 字串、回 JSON 字串（與真工具同形：{ok, url, text}）
    const tools = { fetch_web_page: { callback: async (args) => { const a = JSON.parse(args); fetchCalls.push(a.url); return JSON.stringify(PAGES[a.url] != null ? { ok: true, url: a.url, text: PAGES[a.url] } : { ok: false, error: '404' }); } } };
    // 假模型：從送進來的內容裡挑出前 14 字（原文片段），所以會通過 checkExtractive
    const M = {
        model: { id: 'qwen3-0.6b' },
        ensure: async () => null,
        gen: async (a) => { modelCalls.push(a); const body = String(a.messages[a.messages.length - 1].content || ''); const line = body.split('\n').find((l) => /[。，]/.test(l) && !/使用者的問題|工具結果|請用|你根據/.test(l)); return '- ' + (line ? line.slice(0, 14) : '（無）'); },
    };
    const globals = { FaRecipe, FaNewsDigest, FaVlm: { textBudget: () => ({ prompt: 4000 }) }, FaPlan: null };
    const C = loadMethods(['_newsDigestAnswer', '_newsFetchText', '_isNewsAsk', '_planLocalSummarize', '_planReadText'], globals);
    const self = {
        tools, fileCache: { get: async () => null },
        _planModel: async () => M,
        _createProgressWidget: () => ({ log: (l) => progLines.push(l), update: () => {}, finish: (s) => progDone.push(s), fail: () => {} }),
        _gpuDecodeCapOn: () => false, // 這個測試的模型是假的，沒有開 GPU 解碼，切段大小不受 GPU 上限影響
        _gpuChunkCap: () => 1024,
        _isNewsAsk: C._isNewsAsk, _newsFetchText: C._newsFetchText, _planLocalSummarize: C._planLocalSummarize, _planReadText: C._planReadText,
    };
    self._newsDigestAnswer = C._newsDigestAnswer;

    // A. 「看今天有哪些黃仁勳新聞」
    const r1 = await self._newsDigestAnswer('看今天有哪些黃仁勳新聞', {});
    check('A 接手（handled）', r1 && r1.handled === true && r1.ok === true, r1);
    check('A 標頭帶輪數', r1.header.startsWith('📰 新聞摘要｜') && /\d+ 輪/.test(r1.header), r1.header);
    check('A 合併為「N 則」', r1.text.startsWith('今天有哪些黃仁勳新聞：2 則'), r1.text);
    check('A 只讀相關的兩篇（天氣不讀）', fetchCalls.includes(A1) && fetchCalls.includes(A2) && !fetchCalls.includes(A3), fetchCalls);
    check('A 取回內容一定送進模型（每篇一次）', modelCalls.length >= 2 && modelCalls.every((c) => /黃仁勳|輝達/.test(String(c.messages[c.messages.length - 1].content))), modelCalls.length);
    check('A 最終回答含模型摘要', r1.text.includes('黃仁勳在 GTC 宣布') && !r1.text.includes('程式摘錄'), r1.text);
    check('A 不標示「沒有經過 AI」', !r1.text.includes('沒有經過 AI'), r1.text);
    check('A 進度卡片每步一行（含輪次）', progLines.some((l) => /^第 1 輪｜選來源｜程式｜/.test(l)) && progLines.some((l) => /逐篇摘要｜模型/.test(l)) && progLines.some((l) => /^第 \d+ 輪｜合併｜/.test(l)), progLines);
    check('A 逐篇摘要列出問與答與耗時（可觀測）', progLines.some((l) => /逐篇摘要｜模型｜完成，/.test(l) && /問「.+」，答「.+」/.test(l) && / ms，/.test(l)), progLines);
    check('A 進度卡片結束', progDone[0] === '完成', progDone);

    // B. 非新聞問題不接手
    fetchCalls.length = 0;
    const r2 = await self._newsDigestAnswer('今天天氣如何', {});
    check('B 非新聞：不接手', r2.handled === false && fetchCalls.length === 0, r2);

    // C. 沒有模型：每篇都是程式摘錄，誠實標示
    const noModel = Object.assign({}, M, { ensure: async () => '模型還沒下載', gen: async () => { throw new Error('不應該呼叫'); } });
    const self2 = Object.assign({}, self, { _planModel: async () => noModel });
    const r3 = await self2._newsDigestAnswer('看今天有哪些黃仁勳新聞', {});
    check('C 沒有模型：誠實標示', r3.text.includes('⚠️ 這次沒有經過 AI（程式摘錄）'), r3.text);

    console.log(ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
