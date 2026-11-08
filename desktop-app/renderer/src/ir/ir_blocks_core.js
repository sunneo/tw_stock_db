'use strict';
/* 區塊 ↔ 中間語言 ↔ 目標語言 的橋（純模組；依賴由呼叫端注入，不碰 floating-assistant.js）。
 * 區塊的範本庫（py_blocks_core）是 Python 專屬，所以走的路是：
 *   區塊（或受控自然語言）→ 區塊的程式碼產生（Python）→ 中間語言 → 目標語言（nodejs／java／c／python）
 *   程式碼（Python）→ 區塊／受控自然語言（反推）
 *   區塊／程式碼 → 函式行為卡（ir_behavior 的第二層），供 code edit 把程式抽回設計
 * 區塊樹裡「通用的程式區塊」（stmt）本來就能表達任何 Python，所以橋本身不會因為區塊種類而失敗；
 * 失敗只會出現在 Python → 中間語言（不支援的語法會變成原生區塊）→ 目標語言（輸出器拒絕）這兩關，診斷如實帶回。
 *
 *   make({ parseTree, C2U, B, IN, PREP, OUT, BD, DES, IR }) → bridge
 *   bridge.program(funcs)            funcs: [{name, params:[名稱], blocks | cnl}] → { python, funcs }
 *   bridge.fromPython(src)           → { funcs:[{name, params, blocks, cnl, stats}], coverage }
 *   bridge.toIr(python, name)        → { ir, diags, coverage }
 *   bridge.emit(python, lang)        → { ok, code, diags }   （lang：nodejs／java／c／python）
 *   bridge.toIrFrom(src, lang, name, parser)    非 Python 來源（nodejs／java／c）→ 中間語言；parser＝該語言的 tree-sitter Parser（呼叫端載入文法）
 *   bridge.emitFrom(src, lang, target, name, parser) → { ok, code, diags }   來源語言 → 中間語言 → 目標語言
 *   bridge.cardsFrom(src, lang, name, parser) → 行為卡（第二層）
 *   bridge.blocksToTarget(funcs, lang)
 *   bridge.cards(python)             → 函式行為卡陣列（level 2，含每個函式用到的區塊範本）
 *   bridge.cardText(card)            → 白話卡片
 *   bridge.styleCheck(python)        → 函式名／變數名的命名風格一致性（缺口 F）
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaIrBlocks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    function make(env) {
        const { parseTree, C2U, B, IN, PREP, OUT, BD, DES, INB } = env;
        const anyT = { base: 'any', args: [] };
        const mkOp = (name, params, body) => ({ name, params: (params || []).map((x) => ({ name: x, type: anyT })), returns: anyT, visibility: '+', static: true, body });
        const blocksOf = (f) => {
            if (f.blocks) return { ok: true, blocks: f.blocks, errors: [] };
            const pr = B.parseCNL(f.cnl || ''); return { ok: pr.ok, blocks: pr.blocks, errors: pr.errors || [] };
        };
        // 區塊 → Python（所有函式；有名為 main 的函式就在最後呼叫它）
        // 行內註解（trivia）旁路：區塊樹沒有註解節點，所以從原始碼收集註解，記下它掛的「那一行程式」（行尾註解＝同一行；獨立註解＝下一行程式），
        // 區塊產生 Python 後再掛回。掛回的規則（依序，前一關掛上就不再往下；每個目標行同一種註解只能被掛一次）：
        //   ① 同一函式內，去空白／括號／引號統一後完全相同的行（搬動、重排、沒改的行都在這關；同樣的行依出現順序一一對應）
        //   ② 同一函式內，字詞重疊率（Jaccard）≥ 0.5 的最像的行（改寫過的行；同分取離原位置最近的）
        //   ③ 函式內程式行數沒變時，原位置的那一行（整行被改得面目全非但位置沒動）
        //   ④ 都對不上＝那行被刪了：獨立註解保留，掛到原位置（超出就最後一行）之前，因為它多半在說明一整段；
        //      行尾註解只描述那一行，所以不留在程式裡，計入 orphans（可用 keepOrphans 改成當獨立註解留在函式尾）
        //   函式本身被刪／改名時，在整份程式的所有行裡找（①②），仍對不上就同 ④（找不到位置的獨立註解附在檔尾）
        const NL = String.fromCharCode(10), SPC = String.fromCharCode(32), TAB = String.fromCharCode(9);
        const normLine = (t) => String(t).trim().split(" ").join("").split("(").join("").split(")").join("").split(String.fromCharCode(34)).join(String.fromCharCode(39));
        const isBlank = (l) => !String(l).trim();
        const isCommentLine = (l) => String(l).trim().charAt(0) === "#";
        const indentOf = (l) => l.length - l.trimStart().length;
        // 把程式行分成函式範圍：[{name, start, end(含)}]；模組層（縮排 0 的非 def 行）name 為空字串
        function funcRanges(lines) {
            const out = []; let cur = null;
            lines.forEach((l, i) => {
                if (isBlank(l)) return; const top = l.charAt(0) !== SPC && l.charAt(0) !== TAB;
                const m = top && /^(?:async +)?def +([A-Za-z_][A-Za-z0-9_]*)/.exec(l);
                if (m) { cur = { name: m[1], start: i, end: i }; out.push(cur); return; }
                if (top && !isCommentLine(l)) { cur = { name: "", start: i, end: i }; out.push(cur); return; }
                if (cur) cur.end = i;
            });
            return out;
        }
        const codeLinesIn = (lines, r) => { const a = []; for (let i = r.start; i <= r.end; i++) if (!isBlank(lines[i]) && !isCommentLine(lines[i])) a.push(i); return a; };
        const toks = (t) => { const s = {}; (String(t).match(/[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[^ A-Za-z0-9_]/g) || []).forEach((x) => { s[x] = 1; }); return s; };
        const jaccard = (a, b) => { const A = toks(a), B2 = toks(b); let i = 0, u = 0; Object.keys(A).forEach((k) => { if (B2[k]) i++; }); u = Object.keys(A).length + Object.keys(B2).length - i; return u ? i / u : 0; };
        function collectComments(src, rootNode) {
            const lines = String(src).split(NL), raw = [], ranges = funcRanges(lines);
            (function walk(n) { if (n.type === "comment") { raw.push({ row: n.startPosition.row, col: n.startPosition.column, text: n.text }); return; } for (let i = 0; i < n.childCount; i++) walk(n.child(i)); })(rootNode);
            return raw.map((c) => {
                const code = (lines[c.row] || "").slice(0, c.col), trail = code.trim().length > 0; let arow = trail ? c.row : -1;
                if (!trail) { for (let r = c.row + 1; r < lines.length; r++) { const t = lines[r].trim(); if (t && t[0] !== "#") { arow = r; break; } } }
                const anchorRaw = arow >= 0 ? (trail ? code : lines[arow]).trim() : ""; const rg = ranges.find((r) => arow >= r.start && arow <= r.end) || null;
                const cl = rg ? codeLinesIn(lines, rg) : [];
                return { text: c.text, trail, anchor: normLine(anchorRaw), anchorRaw, fn: rg ? rg.name : null, ord: rg ? cl.indexOf(arow) : -1, fnLines: cl.length };
            });
        }
        function attachComments(python, comments, opts) {
            opts = opts || {}; const lines = String(python).split(NL), ranges = funcRanges(lines), used = {}, placeAt = new Array((comments || []).length), how = new Array((comments || []).length);
            const rangeOf = (c) => ranges.filter((r) => r.name === c.fn);
            const candidates = (c, wide) => { const rs = wide ? [{ start: 0, end: lines.length - 1 }] : rangeOf(c); const a = []; rs.forEach((r) => { for (let i = r.start; i <= r.end; i++) if (!isBlank(lines[i]) && !isCommentLine(lines[i])) a.push(i); }); return a; };
            const key = (c, i) => (c.trail ? "t" : "o") + i;
            // ① 完全相同（先在同函式，再全檔）
            (comments || []).forEach((c, ci) => { if (!c.anchor) return; for (const wide of [false, true]) { const hit = candidates(c, wide).find((i) => !used[key(c, i)] && normLine(lines[i]) === c.anchor); if (hit != null) { used[key(c, hit)] = 1; placeAt[ci] = hit; how[ci] = "exact"; return; } } });
            // ② 最像的（改寫過）
            (comments || []).forEach((c, ci) => { if (placeAt[ci] != null || !c.anchorRaw) return; for (const wide of [false, true]) {
                let best = -1, bs = 0; const cl = candidates(c, wide); cl.forEach((i, k) => { if (used[key(c, i)]) return; const s = jaccard(c.anchorRaw, lines[i]) - Math.abs(k - c.ord) * 1e-4; if (jaccard(c.anchorRaw, lines[i]) >= 0.5 && s > bs) { bs = s; best = i; } });
                if (best >= 0) { used[key(c, best)] = 1; placeAt[ci] = best; how[ci] = "similar"; return; } } });
            // ③ 行數沒變：原位置
            (comments || []).forEach((c, ci) => { if (placeAt[ci] != null || c.ord < 0) return; const cl = candidates(c, false); if (cl.length === c.fnLines && cl[c.ord] != null && !used[key(c, cl[c.ord])]) { used[key(c, cl[c.ord])] = 1; placeAt[ci] = cl[c.ord]; how[ci] = "position"; } });
            // ④ 被刪
            const orphans = [], tail = [], before = {}, fnTail = {}; let placed = 0;
            (comments || []).forEach((c, ci) => {
                if (placeAt[ci] != null) { const i = placeAt[ci]; placed++; if (c.trail) lines[i] = lines[i] + "  " + c.text; else (before[i] = before[i] || []).push(c.text); return; }
                if (c.trail) { if (opts.keepOrphans) { const r = rangeOf(c)[0]; if (r) { (fnTail[r.end] = fnTail[r.end] || []).push(c.text); placed++; return; } tail.push(c.text); return; } orphans.push({ text: c.text, fn: c.fn, was: c.anchorRaw }); return; }
                const cl = candidates(c, false); if (cl.length && c.ord >= 0) { const i = cl[Math.min(c.ord, cl.length - 1)]; (before[i] = before[i] || []).push(c.text); placed++; how[ci] = "clamped"; return; }
                tail.push(c.text);
            });
            const out = []; lines.forEach((l, i) => {
                if (before[i]) { const ind = l.slice(0, indentOf(l)); before[i].forEach((t) => out.push(ind + t)); } out.push(l);
                if (fnTail[i]) { const ind = SPC.repeat(4); fnTail[i].forEach((t) => out.push(ind + t)); }
            });
            tail.forEach((t) => out.push(t));
            const cnt = (k) => how.filter((x) => x === k).length;
            return { python: out.join(NL), placed, unplaced: tail.length, orphans, by: { exact: cnt("exact"), similar: cnt("similar"), position: cnt("position"), clamped: cnt("clamped") } };
        }

        function program(funcs, opts) {
            const ctx = opts && opts.ctx; const errors = [], bodies = {};
            for (const f of funcs) { const r = blocksOf(f); if (!r.ok) { errors.push({ func: f.name, errors: r.errors }); continue; } bodies[f.name] = { body: B.toIR(r.blocks), params: f.params }; }
            if (errors.length) return { ok: false, errors, python: '' };
            // 有原模型（fromPython 的 ctx）就沿用它的 import、型別標註、模組層敘述；只換函式本體。沒有就從頭組一個最小模型
            // 注意：不能複製 ctx——model.order 裡的項目指向同一批 op 物件，複製（JSON）會讓 order 帶著舊本體，換掉的函式本體就不會輸出。
            // 所以直接換 op.body，產生完再還原。
            const m = ctx || { name: 'M', actors: [], relations: [], usecases: [], prelude: [], order: [], classes: [{ name: 'M', kind: 'class', attrs: [], values: [], ops: [] }] };
            const saved = [], seen = {}, extra = [];
            m.classes.forEach((c) => c.ops.forEach((op) => { if (bodies[op.name]) { saved.push([op, op.body]); op.body = bodies[op.name].body; seen[op.name] = 1; } }));
            Object.keys(bodies).forEach((n) => { if (!seen[n]) { const op = mkOp(n, bodies[n].params, bodies[n].body); m.classes[0].ops.push(op); extra.push(op); if (m.order && m.order.length) m.order.push({ t: 'f', o: op }); } });
            let python; try { python = C2U.toPython(m); } finally { saved.forEach((x) => { x[0].body = x[1]; }); extra.forEach((op) => { const i = m.classes[0].ops.indexOf(op); if (i >= 0) m.classes[0].ops.splice(i, 1); if (m.order) { const j = m.order.findIndex((it) => it.o === op); if (j >= 0) m.order.splice(j, 1); } }); }
            let commentStats = { placed: 0, unplaced: 0 };
            const trivia = (opts && opts.comments) || (ctx && ctx.trivia); if (trivia && trivia.length) { const a = attachComments(python, trivia, opts); python = a.python; commentStats = { placed: a.placed, unplaced: a.unplaced, orphans: a.orphans, by: a.by }; } if (!ctx && bodies.main) python += '\nmain()\n';
            return { ok: true, errors: [], python, comments: commentStats };
        }
        function fromPython(src) {
            const tree = parseTree(src); const u = C2U.fromTree(tree.rootNode, { source: src });
            const funcs = [];
            u.model.classes.forEach((c) => c.ops.forEach((op) => {
                const blocks = B.fromIR(op.body); funcs.push({ name: op.name, params: op.params.map((p) => p.name), sig: { params: op.params, ret: op.ret }, blocks, cnl: B.toCNL(blocks), stats: B.stats(blocks) });
            }));
            const comments = collectComments(src, tree.rootNode); u.model.trivia = comments;
            return { funcs, coverage: u.coverage, ctx: u.model, comments };
        }
        function toIr(python, name) {
            const tree = parseTree(python); const r = IN.fromTree(tree.rootNode, { source: python, name: name || 'blocks' });
            const prep = PREP.prepare(r.ir); return { ir: prep.ir, diags: (r.diags || []).concat(prep.diags || []), coverage: r.coverage };
        }
        function emit(python, lang, name) {
            if (!OUT[lang]) return { ok: false, code: '', diags: [{ level: 'error', msg: '不支援的目標語言：' + lang }] };
            const r = toIr(python, name); const em = OUT[lang].emit(r.ir);
            const diags = r.diags.concat(em.diags || []);
            return { ok: !diags.some((d) => d.level === 'error'), code: em.code, diags };
        }
        function blocksToTarget(funcs, lang, name) {
            const p = program(funcs); if (!p.ok) return { ok: false, code: '', diags: p.errors.map((e) => ({ level: 'error', msg: '區塊解析失敗：' + e.func + ' ' + JSON.stringify(e.errors.slice(0, 2)) })), python: '' };
            const e = emit(p.python, lang, name); e.python = p.python; return e;
        }
        // ---- 非 Python 來源（DESIGN.core-ir.md 第 11、13 節）----
        const FROM = { nodejs: 1, java: 1, c: 1 }, patCache = {};
        const fromLangs = () => (INB ? Object.keys(FROM) : []);
        function toIrFrom(src, lang, name, parser) {
            if (lang === 'python') return toIr(src, name);
            if (!INB || !FROM[lang]) throw new Error('還沒有 ' + lang + ' 的「進」（目前支援 python、' + fromLangs().join('、') + '）');
            if (!parser) throw new Error('缺少 ' + lang + ' 的語法樹剖析器');
            const patterns = patCache[lang] || (patCache[lang] = INB.buildPatterns(lang, (s) => parser.parse(s).rootNode));
            const r = INB.fromTree(parser.parse(src).rootNode, { lang, source: src, patterns, name: name || 'input' });
            const prep = PREP.prepare(r.ir); return { ir: prep.ir, diags: (r.diags || []).concat(prep.diags || []), coverage: r.coverage };
        }
        function emitFrom(src, lang, target, name, parser) {
            if (lang === 'python') return emit(src, target, name);
            if (!OUT[target]) return { ok: false, code: '', diags: [{ level: 'error', msg: '不支援的目標語言：' + target }] };
            const r = toIrFrom(src, lang, name, parser); const em = OUT[target].emit(r.ir); const diags = r.diags.concat(em.diags || []);
            return { ok: !diags.some((d) => d.level === 'error'), code: em.code, diags, coverage: r.coverage };
        }
        function cardsFrom(src, lang, name, parser) { if (lang === 'python') return cards(src, name); return BD.fromIr(toIrFrom(src, lang, name, parser).ir); }
        // 行為卡：中間語言（第二層）＋ 該函式的區塊範本使用統計
        function cards(python, name) {
            const ir = toIr(python, name).ir; const cs = BD.fromIr(ir); let fp = null;
            try { fp = fromPython(python); } catch (e) { fp = null; }
            return cs.map((c) => { const f = fp && fp.funcs.find((x) => x.name === c.name); return Object.assign({}, c, { blocks: f ? { total: f.stats.blocks, generic: f.stats.generic, byTemplate: f.stats.byTemplate } : null }); });
        }
        const cardText = (c) => BD.card(c) + (c.blocks ? '\n- 區塊：共 ' + c.blocks.total + ' 個（通用程式區塊 ' + c.blocks.generic + ' 個）' : '');

        // 命名風格一致性（思考堆疊缺口 F 的離線版，純程式）：函式名、變數名各自算「主流風格」占比；單字（無大小寫與底線之分）不算
        const styleOf = (n) => (/^[A-Z][A-Z0-9_]+$/.test(n) && /_/.test(n) ? 'upper' : /_/.test(n) ? 'snake' : /^[a-z]+[A-Z]/.test(n) ? 'camel' : /^[A-Z][a-z]/.test(n) && /[a-z][A-Z]/.test(n) ? 'pascal' : null);
        function styleCheck(python) {
            const fn = [], vars = [];
            const ID = '[A-Za-z_][A-Za-z0-9_]*', IDS = ID + '(?: *, *' + ID + ')*';
            const reDef = new RegExp('^ *def +(' + ID + ')'), reAsg = new RegExp('^ *(' + IDS + ') *(?:[-+*/%]|//|[*][*])?=(?!=)'), reFor = new RegExp('^ *for +(' + IDS + ') +in ');
            String(python).split(String.fromCharCode(10)).forEach((l) => {
                let m = reDef.exec(l); if (m) fn.push(m[1]);
                m = reAsg.exec(l); if (m) m[1].split(',').forEach((x) => vars.push(x.trim()));
                m = reFor.exec(l); if (m) m[1].split(',').forEach((x) => vars.push(x.trim()));
            });
            const share = (names) => { const st = names.map(styleOf).filter(Boolean); if (st.length < 2) return { score: 1, dominant: st[0] || null, mixed: [] }; const cnt = {}; st.forEach((x) => { cnt[x] = (cnt[x] || 0) + 1; }); const dom = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0]; return { score: cnt[dom] / st.length, dominant: dom, mixed: names.filter((n) => { const k = styleOf(n); return k && k !== dom; }) }; };
            const f = share(fn), v = share(vars.filter((x, i, a) => a.indexOf(x) === i)); return { functions: f, variables: v, score: Math.min(f.score, v.score), ok: f.score === 1 && v.score === 1 };
        }
        return { collectComments, attachComments, styleCheck, program, fromPython, toIr, emit, toIrFrom, emitFrom, cardsFrom, fromLangs, blocksToTarget, cards, cardText };
    }
    return { make };
});
