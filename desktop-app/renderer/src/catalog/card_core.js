/* 能力卡片（UMD，純函式）：從一份很長的 README／說明文字，整理出「這個專案能做什麼、用什麼語言、在哪裡跑、怎麼安裝、有哪些主要函式、需要什麼條件」。
 * 長文的做法是「地圖縮放＋多片段投票融合」，不是整份塞進模型：
 *   ① 切片（slice）：依標題分成章節樹（地圖）；程式碼區塊不拆開；太長的章節再依段落切並保留重疊；片段大小可以隨模型的上下文長度調整；
 *   ② 縮放（zoom）：先只看地圖（標題與大小），依章節標題的重要性（安裝、用法、功能、API、範例…）排優先順序，在字數預算內由大到小一塊一塊放大；
 *   ③ 每個片段各自抽事實（程式規則；可選用模型再投一票）：安裝指令、語言、執行環境、主要呼叫的函式、能力描述（動詞＋受詞）、需要的條件、停止維護的警告；
 *   ④ 投票與融合：各片段的票依章節權重加總；欄位取得票最多的並附信心（得票比例）與出處片段；能力與函式用相似度合併同義的，保留得票高的。
 * 沒有模型也能跑；模型只是多一票（opts.votes），不是必要條件。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaCatalogCard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ===== 清理 =====
    function clean(text) {
        return String(text || '').replace(/\r\n?/g, '\n').replace(/^([^\n|#`>][^\n]*)\n={3,}[ \t]*$/gm, '# $1').replace(/^([^\n|#`>-][^\n]*)\n-{3,}[ \t]*$/gm, '## $1').replace(/^(={2,6})\s*([^=\n]+?)\s*\1\s*$/gm, (m, e, ti) => '#'.repeat(Math.max(1, e.length - 1)) + ' ' + ti).replace(/<!--[\s\S]*?-->/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '').replace(/<img\b[^>]*>/gi, '').replace(/<\/?(?:p|div|span|br|a|b|i|em|strong|center|details|summary|h[1-6]|table|tr|td|th|ul|ol|li|sub|sup|kbd)\b[^>]*>/gi, (m) => (/^<h([1-6])\b/i.test(m) ? '\n' + '#'.repeat(+/^<h([1-6])/i.exec(m)[1]) + ' ' : (/^<\/h[1-6]/i.test(m) ? '\n' : (/<(?:br|p|div|li|tr)\b|<\/(?:p|div|li|tr)>/i.test(m) ? '\n' : ' ')))).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    }

    // ===== 切片 =====
    // 回傳 { outline: [{ id, title, level, path, chars, slices }], slices: [{ id, sec, path, kind, text }], chars }
    // opts.maxChars：每片最大字數（預設 1800）；opts.contextTokens：給了就用上下文長度算（約 25% 的 token × 3 字／token，最少 600）；opts.overlap：長章節切段的重疊字數
    function sliceSize(opts) { opts = opts || {}; if (opts.maxChars) return Math.max(300, opts.maxChars | 0); if (opts.contextTokens) return Math.max(600, Math.round(opts.contextTokens * 0.25 * 3)); return 1800; }
    function slice(text, opts) {
        opts = opts || {}; const max = sliceSize(opts); const overlap = opts.overlap == null ? Math.round(max * 0.1) : opts.overlap; const src = clean(text); const lines = src.split('\n');
        const secs = []; let cur = { title: '(開頭)', level: 0, lines: [], path: [] }; const stack = []; let fence = null;
        for (const line of lines) {
            const f = /^\s*(```|~~~)/.exec(line); if (f) { if (!fence) fence = f[1]; else if (f[1] === fence) fence = null; }
            const h = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
            if (h) { secs.push(cur); const level = h[1].length; while (stack.length && stack[stack.length - 1].level >= level) stack.pop(); stack.push({ level, title: h[2].trim() }); cur = { title: h[2].trim(), level, lines: [], path: stack.map((s) => s.title) }; } else cur.lines.push(line);
        }
        secs.push(cur);
        const outline = [], slices = []; let sid = 0;
        secs.forEach((s, si) => {
            const body = s.lines.join('\n').trim(); if (!body && si !== 0) { outline.push({ id: 's' + si, title: s.title, level: s.level, path: s.path, chars: 0, slices: [] }); return; } if (!body) return;
            // 依「程式碼區塊整塊」與「空行分段」切成最小單位，再裝箱到 max
            const units = []; let buf = [], inFence = false;
            for (const l of body.split('\n')) { if (/^\s*(```|~~~)/.test(l)) { if (!inFence) { if (buf.length) units.push({ t: buf.join('\n'), code: false }); buf = [l]; inFence = true; } else { buf.push(l); units.push({ t: buf.join('\n'), code: true }); buf = []; inFence = false; } continue; } if (inFence) { buf.push(l); continue; } if (!l.trim()) { if (buf.length) { units.push({ t: buf.join('\n'), code: false }); buf = []; } continue; } buf.push(l); }
            if (buf.length) units.push({ t: buf.join('\n'), code: inFence });
            const parts = []; let acc = '', hasCode = false, hasProse = false;
            const flush = () => { if (acc.trim()) parts.push({ text: acc.trim(), kind: hasCode && hasProse ? 'mixed' : (hasCode ? 'code' : 'prose') }); acc = ''; hasCode = false; hasProse = false; };
            for (let u of units) {
                while (u.t.length > max) { // 單一單位就超過：硬切（程式碼區塊在行邊界切），保留重疊
                    flush(); let cut = u.t.lastIndexOf('\n', max); if (cut < max * 0.5) cut = max; parts.push({ text: u.t.slice(0, cut).trim(), kind: u.code ? 'code' : 'prose' }); const back = Math.min(overlap, cut); u = { t: u.t.slice(cut - back).trim(), code: u.code }; if (u.t.length <= back) { u = { t: '', code: false }; break; }
                }
                if (!u.t) continue; if (acc.length + u.t.length + 2 > max) flush(); acc += (acc ? '\n\n' : '') + u.t; if (u.code) hasCode = true; else hasProse = true;
            }
            flush();
            const ids = parts.map((p) => { const id = 'p' + (sid++); slices.push({ id, sec: 's' + si, path: s.path, title: s.title, kind: p.kind, text: p.text }); return id; });
            outline.push({ id: 's' + si, title: s.title, level: s.level, path: s.path, chars: body.length, slices: ids });
        });
        return { outline, slices, chars: src.length, maxChars: max };
    }

    // ===== 縮放：章節重要性 =====
    // 章節標題 → 權重與種類。依文件種類（opts.kind：readme、qa、wiki、guide、design）有不同的規則；沒指定就用 readme 的。
    const DEV_RE = /develop|building|build from|contribut|testing|tests?\b|release|compile|maintain|roadmap|todo|貢獻|開發|編譯|測試/i;
    const META_RE = /changelog|history|credits|acknowledg|sponsor|backer|donat|license|authors?|faq|issues?|code of conduct|references|see also|external links|notes|更新紀錄|授權|參考資料/i;
    const RULES = {
        readme: [[/install|setup|set up|getting started|quick ?start|安裝|快速開始|入門|requirements|prerequisite|download/i, 2.2, 'install'], [/usage|use\b|example|demo|tutorial|how to|guide|用法|範例|使用|教學|api|reference|documentation|docs?\b|methods?|functions?|options?/i, 2, 'usage'], [/feature|capabilit|what|overview|about|introduction|why|highlights|功能|特色|簡介|概述|support/i, 1.6, 'features'], [/browser|node|platform|compat|environment|runtime|wasm|webgl|瀏覽器|相容|平台/i, 1.3, 'env'], [DEV_RE, 0.3, 'dev'], [META_RE, 0.3, 'meta']],
        qa: [[/answer|accepted|solution|解答|回答|解法/i, 2.4, 'answer'], [/question|problem|issue|問題/i, 1.8, 'question'], [/comment|related|linked|留言|相關/i, 0.4, 'meta']],
        wiki: [[/usage|application|feature|overview|description|operation|function|principle|design|architecture|概述|特色|用途|原理/i, 1.8, 'features'], [/history|etymology|references|see also|external links|notes|further reading|歷史|參考|外部連結/i, 0.3, 'meta']],
        guide: [[/overview|concept|getting started|quick ?start|tutorial|how to|task|usage|install|setup|basics|入門|概念|教學|使用/i, 2, 'usage'], [/architecture|design|principle|how it works|internals|架構|設計|原理/i, 1.7, 'features'], [/appendix|changelog|glossary|release|credits|附錄|詞彙/i, 0.4, 'meta'], [DEV_RE, 0.4, 'dev']],
    };
    RULES.design = RULES.guide;
    function secWeight(s, kind) { if (s.level === 0) return { w: 1.8, kind: 'intro' }; const rules = RULES[kind] || RULES.readme; for (const [re, w, k] of rules) if (re.test(s.title) || re.test((s.path || []).join(' '))) return { w, kind: k }; return { w: 1, kind: 'other' }; }
    // 地圖縮放：在字數預算內，依重要性（章節權重，同權重時越靠前越先）挑要放大的章節；回傳 { picked: [slice], skipped: [章節], used }
    function zoom(sliced, opts) {
        opts = opts || {}; const budget = opts.budgetChars || 12000; const secs = sliced.outline.filter((o) => o.slices.length).map((o, i) => Object.assign({ order: i }, o, secWeight(o, opts.kind)));
        const sorted = secs.slice().sort((a, b) => b.w - a.w || a.order - b.order); const bySec = new Map(); for (const sl of sliced.slices) { (bySec.get(sl.sec) || bySec.set(sl.sec, []).get(sl.sec)).push(sl); }
        const picked = [], skipped = []; let used = 0; const want = opts.wantTitle ? new RegExp(opts.wantTitle, 'i') : null;
        for (const s of (want ? sorted.slice().sort((a, b) => (want.test(b.title) ? 1 : 0) - (want.test(a.title) ? 1 : 0) || b.w - a.w || a.order - b.order) : sorted)) {
            const sl = bySec.get(s.id) || []; const need = sl.reduce((a, x) => a + x.text.length, 0);
            if (used + need <= budget) { for (const x of sl) picked.push(Object.assign({ w: s.w, secKind: s.kind }, x)); used += need; }
            else { // 放不下整章：放前幾片
                let took = 0; for (const x of sl) { if (used + x.text.length > budget) break; picked.push(Object.assign({ w: s.w * 0.8, secKind: s.kind }, x)); used += x.text.length; took++; } skipped.push({ title: s.title, chars: s.chars, took });
            }
        }
        picked.sort((a, b) => (a.id.slice(1) | 0) - (b.id.slice(1) | 0)); return { picked, skipped, used, sections: secs.length };
    }

    // ===== 單一片段的事實（程式規則）=====
    const MANAGERS = [[/\b(?:npm\s+(?:install|i)|yarn\s+add|pnpm\s+(?:add|install)|bun\s+add)\b\s*(?:-[-\w]+\s+)*([@\w./-]+)?/i, 'js', 'npm'], [/\b(?:pip3?\s+install|python3?\s+-m\s+pip\s+install|conda\s+install|poetry\s+add|uv\s+(?:pip\s+install|add))\b\s*(?:-[-\w]+\s+)*([\w.[\]-]+)?/i, 'python', 'pip'], [/\bcargo\s+(?:add|install)\b\s*(\S+)?/i, 'rust', 'cargo'], [/\bgo\s+(?:get|install)\b\s*(\S+)?/i, 'go', 'go'], [/\bgem\s+install\b\s*(\S+)?/i, 'ruby', 'gem'], [/\bcomposer\s+require\b\s*(\S+)?/i, 'php', 'composer'], [/\b(?:apt(?:-get)?|brew|choco|winget)\s+install\b\s*(\S+)?/i, 'native', 'system']];
    const VERBS = 'detect|recogni[sz]e|resize|convert|generate|render|parse|encode|decode|scan|draw|filter|compress|decompress|extract|transform|merge|split|edit|record|play|stream|track|apply|create|read|write|validate|format|manipulate|process|analy[sz]e|classify|segment|crop|rotate|blur|sharpen|enhance|smooth|beautify|retouch|embed|serialize|deserialize|query|fetch|download|upload|send|receive|connect|compute|calculate|measure|compare|search|index|sort|translate|transcribe|synthesi[sz]e|speak|capture|export|import|build|compile|bundle|minify|visuali[sz]e|plot|chart|animate|simulate|mock|test|lint|sign|encrypt|decrypt|hash|authenticate|schedule|cache|queue|log|monitor|display|show|load|save|open|print|scrape|crawl|diff|patch'.split('|');
    const VERB_RE = new RegExp('\\b(' + VERBS.join('|') + ')(?:s|es|ing|ed)?\\b', 'i');
    const NOT_CAP = /\b(issues?|wiki|pull requests?|contribut\w*|tests?|changelog|documentation|docs\b|licen[sc]e|cake|npm run|compile when|please|feel free|you(?:'ll| will| need| can)? (?:need|have to)|see (?:the )?|read the|click|star|sponsor|fork)\b/i;
    const NEEDS = [[/getUserMedia|\bwebcam\b|\bcamera\b|攝影機|相機/i, 'camera'], [/\bmicrophone\b|麥克風/i, 'microphone'], [/\bwebgl\b|\bgpu\b|\bwebgpu\b/i, 'gpu'], [/\bwebassembly\b|\bwasm\b/i, 'wasm'], [/\bapi[ _-]?key\b|\btoken\b.*\brequired\b|\bsign up\b/i, 'api_key'], [/\bffmpeg\b/i, 'ffmpeg'], [/pre-?trained|\bweights?\b|download(?:ing)? (?:the )?models?|model files?|\.onnx|\.tflite|\.pb\b/i, 'model_files'], [/\bserver\b.*\brequired\b|\bbackend\b.*\brequired\b|\bdocker\b/i, 'server'], [/\bpython ?3?\.\d+/i, 'python_version'], [/\bnode(?:\.js)? ?(?:>=?|v)?\s?\d+/i, 'node_version'], [/\bcanvas\b/i, 'canvas']];
    const API_BAD = /^(console|window|document|Math|JSON|Object|Array|Promise|String|Number|process|this|self|navigator|location|Date|Error|Buffer|require|module|exports|el|e|err|res|req|app\.use|alert|prompt|confirm|setTimeout|setInterval|fetch|then|catch|log|\$)\./;
    function factsOfSlice(sl) {
        const text = sl.text; const f = { lang: {}, runtime: {}, installs: [], apis: {}, caps: [], needs: {}, flags: {}, license: null }; const bump = (o, k, n) => { o[k] = (o[k] || 0) + (n || 1); };
        // 程式碼區塊與行內程式碼
        const codes = []; text.replace(/(```|~~~)[^\n]*\n([\s\S]*?)\1/g, (m, _f, body) => { codes.push(body); return ''; }); const inline = []; text.replace(/`([^`\n]{3,120})`/g, (m, c) => { inline.push(c); return ''; });
        const codeAll = codes.join('\n') + '\n' + inline.join('\n'); const prose = text.replace(/(```|~~~)[^\n]*\n[\s\S]*?\1/g, ' ');
        for (const [re, lang, mgr] of MANAGERS) { const m = re.exec(codeAll) || (/^\s*\$?\s*(?:npm|pip|cargo|go|gem|composer)\b/m.test(codeAll) ? re.exec(codeAll) : null); if (m) { bump(f.lang, lang, 3); f.installs.push({ manager: mgr, pkg: m[1] || null, line: (m[0] || '').trim().slice(0, 100) }); if (lang === 'js') bump(f.runtime, 'node', 1); if (lang === 'python') bump(f.runtime, 'python', 2); } }
        const scripts = codeAll.match(/<script[^>]+src=["']([^"']+)["']/gi) || []; if (scripts.length) { bump(f.lang, 'js', 3); bump(f.runtime, 'browser', 3); f.cdn = scripts.slice(0, 2).map((s) => /src=["']([^"']+)["']/i.exec(s)[1]); }
        if (/\b(?:import|export)\s+[\w{*]/.test(codeAll) && /\bfrom\s+['"]/.test(codeAll) || /\brequire\s*\(\s*['"]/.test(codeAll)) { bump(f.lang, 'js', 2); }
        if (/^\s*(?:from\s+[\w.]+\s+import\s|import\s+[\w.]+\s*(?:as\s+\w+)?\s*$)/m.test(codeAll) && /\bdef\s|\bprint\(|:\s*$/m.test(codeAll + ':')) bump(f.lang, 'python', 2);
        if (/^#include\s*[<"]/m.test(codeAll)) bump(f.lang, 'c/c++', 2); if (/\bfn\s+main\(|\buse\s+\w+::/.test(codeAll)) bump(f.lang, 'rust', 1); if (/\bpackage\s+main\b|\bfunc\s+\w+\(/.test(codeAll)) bump(f.lang, 'go', 1);
        if (/\bbrowsers?\b|client-?side|in the browser|瀏覽器|\bDOM\b|\bwebgl\b|\bcanvas\b|<canvas|getContext\(|document\.|window\./i.test(text)) bump(f.runtime, 'browser', 2); if (/\bnode(?:\.?js)?\b|\bnpm\b|require\s*\(/i.test(text)) bump(f.runtime, 'node', 1); if (/\bdeno\b/i.test(text)) bump(f.runtime, 'deno', 1); if (/\bpython\b|\bpip\b/i.test(text)) bump(f.runtime, 'python', 1); if (/\bcommand[- ]line\b|\bCLI\b/.test(text)) bump(f.runtime, 'cli', 1);
        // 主要呼叫的函式
        const fenceLangs = {}; text.replace(/(?:```|~~~)\s*([A-Za-z+#]+)/g, (m, l) => { fenceLangs[l.toLowerCase()] = 1; return ''; }); if (fenceLangs.js || fenceLangs.javascript || fenceLangs.jsx || fenceLangs.ts || fenceLangs.typescript || fenceLangs.html) bump(f.lang, 'js', 2); if (fenceLangs.python || fenceLangs.py) bump(f.lang, 'python', 2); if (fenceLangs.rust) bump(f.lang, 'rust', 2); if (fenceLangs.go) bump(f.lang, 'go', 2); if (fenceLangs.c || fenceLangs.cpp || fenceLangs['c++']) bump(f.lang, 'c/c++', 2); if (fenceLangs.java) bump(f.lang, 'java', 2);
        if (/\b(?:JavaScript|TypeScript|ECMAScript|node\.?js)\b|\b[\w-]+\.js\b|\bJS\b/i.test(prose)) bump(f.lang, 'js', 1); if (/\bPython ?[23]?\b/.test(prose) && !/javascript/i.test(prose)) bump(f.lang, 'python', 1); if (/\b(?:const|let|var)\s+\w+\s*=|=>\s*[{(]|\bawait\s/.test(codeAll)) bump(f.lang, 'js', 1);
        const callRe = /\b(new\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g; let m;
        while ((m = callRe.exec(codeAll))) { const nm = (m[1] ? 'new ' : '') + m[2]; const bare = m[2]; if (/^(if|for|while|switch|catch|function|return|typeof|def|print|len|range|str|int|float|list|dict|set|isinstance|super|async|await|import|from|class|elif|except)$/.test(bare)) continue; if (API_BAD.test(bare + '.') || API_BAD.test(bare)) continue; if (/^[a-z]$/.test(bare)) continue; if (bare.length < 3) continue; bump(f.apis, nm); }
        const pyImp = /^\s*from\s+([\w.]+)\s+import\s+([\w, *]+)/gm; while ((m = pyImp.exec(codeAll))) for (const n of m[2].split(',').map((x) => x.trim()).filter((x) => x && x !== '*')) bump(f.apis, m[1] + '.' + n, 1);
        // 能力描述：條列項與前幾句的『動詞＋受詞』
        const cand = []; for (const l of prose.split('\n')) { const b = /^\s*(?:[-*+•]|\d+[.)])\s+(.+)$/.exec(l); if (b) cand.push({ t: b[1], bullet: true }); }
        const para = prose.split(/\n\s*\n/).map((x) => x.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '').replace(/\s+/g, ' ').trim()).filter(Boolean); for (const p of para.slice(0, 6)) for (const s of p.split(/(?<=[.!?。！？])\s+/).slice(0, 4)) cand.push({ t: s, bullet: false });
        for (const c of cand) { const t = c.t.replace(/\*\*|__|`|\[([^\]]+)\]\([^)]*\)/g, '$1').trim(); const vm = VERB_RE.exec(t); if (!vm || t.length < 8 || t.length > 260) continue; if (NOT_CAP.test(t)) continue; if (!c.bullet && vm.index > 28) continue; const span = t.slice(vm.index).split(/[,;。，；(（]|(?:\s[-–—]\s)|\.\s/)[0].trim().slice(0, 70); if (span.split(/\s+/).length < 2 && !/[㐀-鿿]/.test(span)) continue; f.caps.push({ phrase: span, bullet: c.bullet }); }
        for (const [re, name] of NEEDS) if (re.test(text)) bump(f.needs, name); if (/deprecated|no longer (?:maintained|supported)|unmaintained|archived|not maintained|停止維護|已棄用/i.test(text)) f.flags.deprecated = true;
        const lic = /\b(MIT|Apache[- ]2(?:\.0)?|GPL[- ]?v?[23]?|LGPL|BSD(?:[- ]\d)?(?:[- ]Clause)?|ISC|MPL[- ]2(?:\.0)?|Unlicense|CC0)\b/i.exec(text); if (lic && (/licen[sc]e|授權/i.test(text) || sl.secKind === 'meta')) f.license = lic[1];
        return f;
    }

    // ===== 融合 =====
    const toks = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9㐀-鿿]+/g, ' ').split(' ').filter((w) => w.length > 1).map((w) => (w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w)));
    const jacc = (a, b) => { let i = 0; a.forEach((x) => { if (b.has(x)) i++; }); const u = a.size + b.size - i; return u ? i / u : 0; };
    function top(votes, minShare) { const e = Object.entries(votes).sort((a, b) => b[1] - a[1]); const sum = e.reduce((a, x) => a + x[1], 0); if (!e.length) return { value: null, confidence: 0, all: [] }; return { value: e[0][0], confidence: Math.round((e[0][1] / sum) * 100) / 100, all: e.filter((x) => x[1] >= (minShare || 0) * e[0][1]).map((x) => x[0]) }; }
    // factsList: [{ facts, w, id }]；extra：模型投的票（同格式的 facts，附 w）
    function fuse(items, opts) {
        opts = opts || {}; const lang = {}, runtime = {}, needs = {}, apis = new Map(), caps = []; const installs = []; const evidence = { lang: {}, runtime: {} }; let deprecated = false, license = null; const cdn = [];
        for (const it of items) {
            const f = it.facts, w = it.w == null ? 1 : it.w;
            for (const [k, n] of Object.entries(f.lang)) { lang[k] = (lang[k] || 0) + n * w; (evidence.lang[k] = evidence.lang[k] || []).push(it.id); } for (const [k, n] of Object.entries(f.runtime)) { runtime[k] = (runtime[k] || 0) + n * w; (evidence.runtime[k] = evidence.runtime[k] || []).push(it.id); } for (const [k, n] of Object.entries(f.needs)) needs[k] = (needs[k] || 0) + n * w;
            for (const i of f.installs) if (!installs.some((x) => x.line === i.line)) installs.push(Object.assign({ from: it.id }, i)); if (f.cdn) for (const c of f.cdn) if (!cdn.includes(c)) cdn.push(c);
            for (const [k, n] of Object.entries(f.apis)) { const key = k.replace(/^new /, ''); const e = apis.get(key) || { name: k, votes: 0, slices: new Set() }; e.votes += n * w; e.slices.add(it.id); if (/^new /.test(k)) e.name = k; apis.set(key, e); }
            for (const c of f.caps) { const t = toks(c.phrase); let hit = caps.find((x) => jacc(x.t, t) >= 0.6); const ww = w * (c.bullet ? 1.3 : 1); if (hit) { hit.votes += ww; hit.slices.add(it.id); if (c.phrase.length < hit.phrase.length && c.phrase.length > 12) hit.phrase = c.phrase; } else caps.push({ phrase: c.phrase, t, votes: ww, slices: new Set([it.id]) }); }
            if (f.flags.deprecated) deprecated = true; if (f.license && !license) license = f.license;
        }
        const L = top(lang), R = top(runtime, 0.3); let runtimeGuess = false; if (L.value === 'js' && !R.all.length) { R.all = ['browser', 'node']; R.confidence = 0.3; runtimeGuess = true; }
        const capList = caps.sort((a, b) => b.votes - a.votes).slice(0, opts.maxCaps || 12).map((c) => ({ phrase: c.phrase, votes: Math.round(c.votes * 10) / 10, slices: c.slices.size }));
        const apiList = Array.from(apis.values()).sort((a, b) => b.votes - a.votes).slice(0, opts.maxApis || 15).map((a) => ({ name: a.name, votes: Math.round(a.votes * 10) / 10, slices: a.slices.size }));
        const needList = Object.entries(needs).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([k]) => k);
        return { language: L.value, language_confidence: L.confidence, runtime: R.all, runtime_confidence: R.confidence, runtime_guess: runtimeGuess, installs: installs.slice(0, 4), cdn: cdn.slice(0, 2), capabilities: capList, api: apiList, needs: needList, license, deprecated, evidence: { language: (evidence.lang[L.value] || []).slice(0, 4), runtime: (evidence.runtime[R.value] || []).slice(0, 4) } };
    }

    // 開頭那句『X 是用來做 Y 的』：第一個像樣的散文段落的第一句（跳過標題、表格、程式碼、連結列、徽章）
    function tagline(sliced) {
        for (const sl of sliced.slices.slice(0, 4)) { if (sl.kind === 'code') continue; for (const para of sl.text.split(/\n\s*\n/)) { const p = para.replace(/\s+/g, ' ').replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim(); if (p.length < 25 || /^[|#<>\[!-]/.test(p) || /^(?:\w+\s*\|)/.test(p)) continue; const s = p.split(/(?<=[.!?。！？])\s+/)[0]; if (s.split(/\s+/).length >= 4 || /[㐀-鿿]{8,}/.test(s)) return s.slice(0, 200); } }
        return '';
    }

    // ===== 主流程 =====
    // opts: { name, maxChars | contextTokens, budgetChars, votes: [{ id, facts, w }]（模型或其他來源多投的票）, wantTitle }
    function cardFromReadme(readme, opts) {
        opts = opts || {}; const sliced = slice(readme, opts); const z = zoom(sliced, opts);
        const items = z.picked.map((s) => ({ id: s.id, w: (s.w || 1) * (s.kind === 'code' ? 1.1 : 1), facts: factsOfSlice(s) })); for (const v of opts.votes || []) items.push(v);
        const card = fuse(items, opts); card.name = opts.name || null; card.summary = opts.description ? String(opts.description).slice(0, 200) : tagline(sliced); if (!card.license) { const body = clean(readme); const lm = /(?:^|\n)#{1,6}\s*licen[sc]e[^\n]*\n+([^\n]{0,200})/i.exec(body) || /licen[sc]ed under(?: the)?\s+([^\n.]{0,60})|released under(?: the)?\s+([^\n.]{0,60})/i.exec(body); const seg = lm ? (lm[1] || lm[2] || '') : ''; const lic = /\b(MIT|Apache[- ]2(?:\.0)?|GPL[- ]?v?[23]?|LGPL|BSD(?:[- ]\d)?(?:[- ]Clause)?|ISC|MPL[- ]2(?:\.0)?|Unlicense|CC0|HPND|Zlib)\b/i.exec(seg); if (lic) card.license = lic[1]; }
        card.trace = { chars: sliced.chars, slice_chars: sliced.maxChars, sections: z.sections, slices: sliced.slices.length, read_slices: z.picked.length, read_chars: z.used, skipped_sections: z.skipped.length, coverage_pct: sliced.slices.length ? Math.round((z.used / sliced.slices.reduce((a, s) => a + s.text.length, 0)) * 100) : 100, outline: sliced.outline.slice(0, 40).map((o) => o.title) };
        { const freq = new Map(); for (const sl of z.picked) for (const w of (sl.text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [])) freq.set(w, (freq.get(w) || 0) + 1); card.terms = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 400).map((x) => x[0]); }
        card.confidence = Math.round(((card.language_confidence || 0) * 0.4 + (card.capabilities.length ? 0.3 : 0) + (card.api.length ? 0.15 : 0) + (card.installs.length || card.cdn.length ? 0.15 : 0)) * 100) / 100; return card;
    }
    // 給檢索（BM25／嵌入）用的文字
    function cardText(card) { return [card.name, card.language, (card.runtime || []).join(' '), (card.capabilities || []).map((c) => c.phrase).join('. '), (card.api || []).map((a) => a.name).join(' '), (card.needs || []).join(' ')].filter(Boolean).join('. '); }

    return { clean, slice, sliceSize, zoom, factsOfSlice, fuse, cardFromReadme, cardText, secWeight };
});
