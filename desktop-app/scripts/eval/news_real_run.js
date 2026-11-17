// node scripts/eval/news_real_run.js [outfile]
// 真模型＋假網頁的新聞摘要實跑：模型是 qwen3-0.6b（q8 ONNX，純 JS CPU 參考引擎 qwen_decode.js，貪婪解碼），
// 網頁是固定的假頁面（列表頁＋內文），流程用 floating-assistant.js 裡真的 _newsDigestAnswer／_planLocalSummarize（抽出方法本體執行）。
// 三種說法：看今天有哪些黃仁勳新聞／去 yahoo 看黃仁勳的新聞／看 yahoo 新聞有沒有颱風。結果寫成 JSON（每一步的 trace 與最終回答）。
const fs = require('fs'); const path = require('path'); const vm = require('vm'); const os = require('os');
const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer/src/floating-assistant.js'), 'utf8');
const Q = require(path.join(ROOT, 'renderer/src/gpu/qwen_decode.js'));
const FaRecipe = require(path.join(ROOT, 'renderer/src/recipe/recipe_core.js'));
const FaNewsDigest = require(path.join(ROOT, 'renderer/src/recipe/news_digest_core.js'));
const MODEL_DIR = path.join(os.homedir(), '.config', 'floating-assistant-desktop', 'native-models', 'qwen3-0.6b-q8');
const OUT = process.argv[2] || path.join(os.tmpdir(), 'news_real_run.json');

// ---- Qwen 的 byte-level BPE（tokenizer.json）----
function makeTokenizer(json) {
    const vocab = json.model.vocab; const inv = []; for (const k of Object.keys(vocab)) inv[vocab[k]] = k;
    const ranks = new Map(); json.model.merges.forEach((m, i) => ranks.set(Array.isArray(m) ? m.join(' ') : m, i));
    const added = (json.added_tokens || []).map((t) => ({ content: t.content, id: t.id }));
    const b2u = (() => { const bs = []; for (let i = 33; i < 127; i++) bs.push(i); for (let i = 161; i < 173; i++) bs.push(i); for (let i = 174; i < 256; i++) bs.push(i);
        const cs = bs.slice(); let n = 0; for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
        const m = {}; bs.forEach((b, i) => { m[b] = String.fromCharCode(cs[i]); }); return m; })();
    const u2b = {}; for (const b of Object.keys(b2u)) u2b[b2u[b]] = Number(b);
    const PRE = /(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
    function bpe(word) {
        let parts = [...word];
        for (;;) {
            let best = -1, bi = -1;
            for (let i = 0; i < parts.length - 1; i++) { const r = ranks.get(parts[i] + ' ' + parts[i + 1]); if (r !== undefined && (best < 0 || r < best)) { best = r; bi = i; } }
            if (bi < 0) break;
            parts.splice(bi, 2, parts[bi] + parts[bi + 1]);
        }
        return parts;
    }
    function encodeChunk(text) {
        const ids = [];
        for (const piece of text.match(PRE) || []) {
            const s = Array.from(Buffer.from(piece, 'utf8'), (b) => b2u[b]).join('');
            for (const t of bpe(s)) { if (vocab[t] === undefined) throw new Error('詞元不在詞表：' + t); ids.push(vocab[t]); }
        }
        return ids;
    }
    function encode(text) {
        const out = []; let rest = String(text); // 先切出特殊詞元（<|im_start|> 等）
        while (rest.length) {
            let hit = null; for (const a of added) { const i = rest.indexOf(a.content); if (i >= 0 && (!hit || i < hit.i || (i === hit.i && a.content.length > hit.a.content.length))) hit = { i, a }; }
            if (!hit) { out.push(...encodeChunk(rest)); break; }
            if (hit.i > 0) out.push(...encodeChunk(rest.slice(0, hit.i)));
            out.push(hit.a.id); rest = rest.slice(hit.i + hit.a.content.length);
        }
        return out;
    }
    function decode(ids) {
        const s = ids.map((i) => inv[i] || '').join('');
        const bytes = Buffer.from(Array.from(s, (c) => (u2b[c] !== undefined ? u2b[c] : 63)));
        return bytes.toString('utf8');
    }
    // 特殊詞元（<|im_end|> 等）在 added_tokens 裡，不在 model.vocab
    const special = (c) => { const t = added.find((x) => x.content === c); if (!t) throw new Error('找不到特殊詞元 ' + c); return t.id; };
    return { encode, decode, vocab, special };
}

(async () => {
    const t0 = Date.now(); const log = (m) => console.log('[' + ((Date.now() - t0) / 1000).toFixed(1) + 's] ' + m);
    const tok = makeTokenizer(JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'tokenizer.json'), 'utf8')));
    const bin = fs.readFileSync(path.join(MODEL_DIR, 'onnx', 'model_quantized.onnx'));
    const W = Q.loadWeights(new Uint8Array(bin.buffer, bin.byteOffset, bin.length));
    const engine = Q.createCpuEngine(W, { maxT: 1024 });
    log('模型載入完成');
    const IM_END = tok.special('<|im_end|>');
    // Qwen3 不思考的對話格式
    const chat = (messages) => messages.map((m) => '<|im_start|>' + m.role + '\n' + m.content + '<|im_end|>\n').join('') + '<|im_start|>assistant\n<think>\n\n</think>\n\n';
    const M = {
        model: { id: 'qwen3-0.6b' },
        ensure: async () => null,
        gen: async (a) => {
            engine.reset();
            const ids = tok.encode(chat(a.messages));
            const out = await Q.greedy(engine, ids, Math.min(a.maxTokens || 200, 200), [IM_END]);
            return tok.decode(out).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        },
    };

    // ---- 假網頁（固定內容；列表頁含文章網址，內文是真的句子）----
    const YAHOO = 'https://tw.news.yahoo.com/', CNA = 'https://www.cna.com.tw/';
    const A1 = 'https://tw.news.yahoo.com/a/1001', A2 = 'https://tw.news.yahoo.com/a/1002', A3 = 'https://tw.news.yahoo.com/a/1003';
    const PAGES = {
        [YAHOO]: ['首頁', '登入', '黃仁勳宣布新一代 AI 晶片 Blackwell 量產 ' + A1, '今天天氣晴朗，午後偶有陣雨 ' + A3, '輝達股價盤中創高 黃仁勳：AI 需求仍強 ' + A2].join('\n'),
        [CNA]: '中央社導覽\n頭條新聞標題沒有連結也沒有網址\n更多',
        [A1]: '黃仁勳在 GTC 大會宣布 Blackwell 晶片進入量產，首批出貨給雲端業者，預計下半年供應量明顯增加。',
        [A2]: '輝達股價盤中創歷史新高，黃仁勳表示 AI 需求仍然強勁，資料中心訂單能見度已延伸到明年。',
        [A3]: '今天天氣晴朗，午後偶有陣雨，氣溫約二十八度，東部地區請注意降雨。',
    };
    const fetchCalls = [];
    const tools = { fetch_web_page: { callback: async (args) => { const a = JSON.parse(args); fetchCalls.push(a.url); return JSON.stringify(PAGES[a.url] != null ? { ok: true, url: a.url, text: PAGES[a.url] } : { ok: false, error: '404' }); } } };

    // ---- 把 floating-assistant.js 裡的真方法抽出來執行 ----
    function methodSource(name) {
        const re = new RegExp('\\n    (async )?' + name + '\\(');
        const m = re.exec(SRC); if (!m) throw new Error('找不到方法 ' + name);
        let i = SRC.indexOf('{', m.index + m[0].length); let depth = 0; const start = m.index + 1;
        for (; i < SRC.length; i++) {
            const c = SRC[i];
            if (c === '/' && SRC[i + 1] === '/') { i = SRC.indexOf('\n', i); continue; }
            if (c === "'" || c === '"' || c === '`') { const q = c; i++; while (i < SRC.length && SRC[i] !== q) { if (SRC[i] === '\\') i++; i++; } continue; }
            if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
        }
        throw new Error('方法 ' + name + ' 大括號不成對');
    }
    const names = ['_newsDigestAnswer', '_newsFetchText', '_isNewsAsk', '_planLocalSummarize'];
    const ctx = { console, Promise, JSON, FaRecipe, FaNewsDigest, FaVlm: { textBudget: () => ({ prompt: 700 }) } }; vm.createContext(ctx);
    const C = vm.runInContext('({' + names.map(methodSource).join(',\n') + '})', ctx);

    if (process.env.NEWS_RAW_PROBE) { // 探針：只跑一次短摘要，印出模型原始輸出與檢查結果（用來查為什麼被退回）
        const body = PAGES[A1]; const msgs = FaRecipe.phraseMessages('這篇跟「黃仁勳」有關的重點，繁體中文 1～2 句。', body, '請用繁體中文列出 2～4 個重點。');
        const g = await M.gen({ messages: msgs, maxTokens: Number(process.env.NEWS_RAW_PROBE) || 60 });
        console.log('RAW:', JSON.stringify(g)); console.log('CHECK:', JSON.stringify(FaRecipe.checkExtractive(g, [body], { cjkMin: 0.5, maxChars: 600 })));
        return;
    }
    const cases = ['看今天有哪些黃仁勳新聞', '去 yahoo 看黃仁勳的新聞', '看 yahoo 新聞有沒有颱風'];
    const results = [];
    for (const q of cases) {
        const trace = []; fetchCalls.length = 0;
        const self = Object.assign({ tools, fileCache: { get: async () => null }, _planModel: async () => M, _createProgressWidget: () => ({ log: (l) => { trace.push(l); log('  ' + l); }, finish: () => {}, fail: () => {} }) },
            { _isNewsAsk: C._isNewsAsk, _newsFetchText: C._newsFetchText, _planLocalSummarize: C._planLocalSummarize, _newsDigestAnswer: C._newsDigestAnswer });
        log('問：' + q);
        const r = await self._newsDigestAnswer(q, {});
        log('答：\n' + r.text);
        results.push({ question: q, header: r.header, ok: r.ok, text: r.text, trace, fetchCalls: fetchCalls.slice() });
    }
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    log('結果寫入 ' + OUT);
})().catch((e) => { console.error(e); process.exit(1); });
