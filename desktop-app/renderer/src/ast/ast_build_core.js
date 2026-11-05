/* AST 建樹（純函式，UMD）。使用者的定義：AST 就是 Abstract Syntax Tree——程式是一棵節點樹；
 * 每個空位有型別，機械演算法列出這個空位合法的節點種類，模型只在裡面選（或寫一個名稱／數字／字串），最後把樹反解（unparse）成原始碼。
 * 資料來源是 tree-sitter 文法本身（grammar.json）：每條規則是依序的清單（固定的字、有名字的欄位空位、可有可無、可重複）。建樹就是照清單走。
 *   load(grammarJson, opts)            → schema     opts.deny：不提供給選單的節點種類
 *   build(schema, decider, opts)       → Promise<root>   從 module 開始；每個決定都交給 decider
 *   unparse(root)                      → { text, tree }   text＝原始碼；tree＝正規化的具名節點樹（含自動補的括號），給「建的樹 vs tree-sitter 解析的樹」比對用
 *   decider = {
 *     choice({kind, hole, options:[{label}], path}) → Promise<index>   kind：'node'（這個空位放哪一種節點）｜'option'（可有可無）｜'repeat'（再加一個嗎）｜'branch'（規則裡的分支）
 *     leaf({type, hole}) → Promise<string>                              type：identifier｜integer｜float｜string
 *   }
 * 目前只處理 Python（縮排與換行用 tree-sitter 的外部符號 _indent／_dedent／_newline）；別的語言用同一套做法、換各自的 grammar.json。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaAstBuild = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const hidden = (n) => n[0] === '_';
    const SINGLETON = new Set(['tuple', 'tuple_pattern', 'expression_list', 'pattern_list']); // 只有一個元素時一定要有逗號
    const SPLAT = new Set(['list_splat', 'list_splat_pattern', 'dictionary_splat', 'dictionary_splat_pattern']); // tree-sitter 把 *x.a 讀成 (*x).a：展開符號的子節點一律先加括號
    const LOW = { named_expression: -3, list_splat: -5, dictionary_splat: -5, yield: -4 }; // 文法沒有給優先順序數字、但語意上最低的節點
    const ALGO_DENY = ['await', 'yield', 'ellipsis', 'named_expression', 'as_pattern', 'keyword_identifier', 'list_splat', 'dictionary_splat', 'list_splat_pattern', 'dictionary_splat_pattern', 'concatenated_string', 'format_expression', 'with_statement', 'global_statement', 'nonlocal_statement', 'delete_statement', 'exec_statement', 'print_statement', 'future_import_statement', 'type_alias_statement', 'match_statement', 'class_definition', 'decorated_definition', 'import_future_statement']; // 寫演算法題用：拿掉很少會用到的節點，選單短很多
    const DEFAULT_DENY = ['print_statement', 'exec_statement', 'future_import_statement', 'type_alias_statement', 'keyword_identifier', 'as_pattern', 'match_statement', 'decorated_definition', 'class_definition'];

    function load(g, opts) {
        const S = { rules: g.rules, supertypes: new Set(g.supertypes || []), ext: new Set((g.externals || []).map((e) => e.name).filter(Boolean)), deny: new Set((opts && opts.deny) || DEFAULT_DENY), keywords: new Set(), only: Object.assign({ list_splat_pattern: ['identifier'], dictionary_splat_pattern: ['identifier'] }, (opts && opts.only) || {}) }; // only：某種節點的子空位只准這些節點（展開符號樣式的內容限識別名稱，避開 *x.a 的歧義）
        const scan = (n) => { if (!n) return; if (n.type === 'STRING' && /^[A-Za-z_]+$/.test(n.value) && n.value !== 'print' && n.value !== 'exec') S.keywords.add(n.value); if (n.content) scan(n.content); if (n.members) n.members.forEach(scan); };
        Object.values(S.rules).forEach(scan); return S;
    }
    const isLeafRule = (r) => r && (r.type === 'PATTERN' || r.type === 'TOKEN' || r.type === 'IMMEDIATE_TOKEN');
    const isNodeSym = (S, name) => !hidden(name) && !S.supertypes.has(name) && !S.ext.has(name) && !!S.rules[name];

    // 一個項目的「第一個具名節點或固定的字」：選項標籤；穿過隱藏規則與 supertype，並記下路徑（要強制的 CHOICE 與分支編號），選了之後不用再問。
    function options(S, item) {
        const out = [];
        const add = (label, path, extra) => { if (!out.some((x) => x.label === label)) out.push(Object.assign({ label, path: path.slice() }, extra || {})); };
        const walk = (n, path, d) => {
            if (!n || d > 16) return; const t = n.type;
            if (t.startsWith('PREC') || t === 'FIELD') return walk(n.content, path, d + 1);
            if (t === 'BLANK') return;
            if (t === 'CHOICE') { n.members.forEach((m, i) => walk(m, path.concat([[n, i]]), d + 1)); return; }
            if (t === 'ALIAS') { if (n.named) return add(n.value, path, { node: n.value, alias: true }); return add(n.value, path, { token: n.value }); }
            if (t === 'SYMBOL') {
                const name = n.name; if (S.ext.has(name)) { if (name === '_indent') return add('⇥ 縮排區塊', path, { token: '_indent' }); return; }
                if (hidden(name) || S.supertypes.has(name)) { if (S.rules[name]) walk(S.rules[name], path, d + 1); return; }
                if (S.deny.has(name)) return; return add(name, path, { node: name });
            }
            if (t === 'STRING') return add(n.value, path, { token: n.value });
            if (t === 'SEQ') { if (n.members.length) walk(n.members[0], path, d + 1); return; }
            if (t === 'REPEAT' || t === 'REPEAT1') return walk(n.content, path, d + 1);
            if (isLeafRule(n)) return add('(葉節點)', path, { leaf: true });
        };
        walk(item, [], 0); return out;
    }

    // 分支的「草圖」：這個分支依序必須有的項目（每項是該位置第一個合法標籤的集合；可有可無或可重複的不算）。標籤相同的分支靠它區分。
    function sketch(S, n) {
        if (!n) return []; const t = n.type;
        if (t.startsWith('PREC') || t === 'FIELD') return sketch(S, n.content);
        if (t === 'BLANK') return [];
        if (t === 'SEQ') return n.members.flatMap((m) => sketch(S, m));
        if (t === 'CHOICE') { if (n.members.some((m) => m.type === 'BLANK')) return []; const o = options(S, n); return o.length ? [o.map((x) => x.label)] : []; }
        if (t === 'REPEAT') return [];
        if (t === 'REPEAT1') return sketch(S, n.content);
        if (t === 'SYMBOL' && S.ext.has(n.name)) return [];
        const o = options(S, n); return o.length ? [o.map((x) => x.label)] : [];
    }

    // 左因子提取：所有分支都以同一個項目開頭（例如二元運算的左運算元）時，那個項目只問一次，再從剩下的部分選分支。
    const lfCache = new WeakMap();
    function leftFactor(item) {
        if (lfCache.has(item)) return lfCache.get(item); let out = null; const mem = item.members;
        if (mem.length > 1 && !mem.some((m) => m.type === 'BLANK')) {
            const un = (m) => { let pre = null; while (m.type.startsWith('PREC')) { pre = pre || { type: m.type, value: m.value }; m = m.content; } return { pre, m }; };
            const parts = mem.map(un);
            if (!parts.some((x) => x.m.type !== 'SEQ' || x.m.members.length < 2)) { const k = JSON.stringify(parts[0].m.members[0]); if (parts.every((x) => JSON.stringify(x.m.members[0]) === k)) out = { first: parts[0].m.members[0], tails: parts.map((x) => { const rest = { type: 'SEQ', members: x.m.members.slice(1) }; return x.pre ? { type: x.pre.type, value: x.pre.value, content: rest } : rest; }) }; }
        }
        lfCache.set(item, out); return out;
    }

    async function build(S, D, bopts) {
        const maxDepth = (bopts && bopts.maxDepth) || 60;
        const leafVal = async (type, hole) => { const v = await D.leaf({ type, hole }); return String(v); };
        // 建一個具名節點
        async function node(type, hole, depth, prec) {
            if (depth > maxDepth) throw new Error('樹太深（' + type + '）');
            const rule = S.rules[type]; const nd = { type, parts: [], prec: undefined, assoc: undefined }; const leafy = type === 'string' || isLeafRule(rule);
            if (depth === 0 && D.setRoot) D.setRoot(nd);
            if (!leafy && D.enter) await D.enter(type, hole);
            if (type === 'string') { const v = await leafVal('string', hole); nd.parts.push({ tok: JSON.stringify(v), leaf: 'string' }); return nd; }
            if (isLeafRule(rule)) { const v = await leafVal(type, hole); nd.parts.push({ tok: v, leaf: type }); return nd; }
            const forced = new Map(); await expand(rule, nd, hole || type, depth + 1, forced, { type }); if (D.exit) await D.exit(type);
            if (SINGLETON.has(type) && !nd.parts.some((p) => p.tok === ',')) { const ns = nd.parts.filter((p) => p.node); if (ns.length === 1) nd.parts.splice(nd.parts.indexOf(ns[0]) + 1, 0, { tok: ',' }); }
            return nd;
        }
        // 展開一塊規則到 nd.parts
        async function expand(item, nd, hole, depth, forced, ctx) {
            const t = item.type;
            if (t === 'PREC' || t === 'PREC_LEFT' || t === 'PREC_RIGHT' || t === 'PREC_DYNAMIC') {
                if (t !== 'PREC_DYNAMIC' && nd.prec === undefined) { nd.prec = item.value; nd.assoc = t === 'PREC_LEFT' ? 'left' : t === 'PREC_RIGHT' ? 'right' : undefined; }
                return expand(item.content, nd, hole, depth, forced, ctx);
            }
            if (t === 'FIELD') { return expand(item.content, nd, hole, depth, forced, Object.assign({}, ctx, { field: item.name })); }
            if (t === 'BLANK') return;
            if (t === 'STRING') { nd.parts.push({ tok: item.value }); if (D.token) await D.token(item.value); return; }
            if (t === 'SEQ') { for (const m of item.members) await expand(m, nd, hole, depth, forced, ctx); return; }
            if (t === 'CHOICE') {
                let idx = forced.get(item); if (idx !== undefined) forced.delete(item);
                if (idx === undefined) { const f = leftFactor(item); if (f) { await expand(f.first, nd, hole, depth, forced, ctx); return expand({ type: 'CHOICE', members: f.tails }, nd, hole, depth, forced, ctx); } }
                if (idx === undefined) {
                    const opts = options(S, item); const allBlank = item.members.some((m) => m.type === 'BLANK');
                    // 分支可能含「空白」：可有可無，用 option；其餘是分支
                    const real = item.members.map((m, i) => ({ m, i, o: options(S, m) })).filter((x) => x.m.type !== 'BLANK');
                    if (allBlank && real.length === 1) { const pick = await D.choice({ kind: 'option', hole, options: [{ label: '加上：' + (options(S, real[0].m)[0] || { label: '…' }).label }, { label: '不加' }], firstSet: options(S, real[0].m).map((o) => o.label), path: ctx.type }); idx = pick === 0 ? real[0].i : item.members.findIndex((m) => m.type === 'BLANK'); }
                    else {
                        const flat = []; real.forEach((x) => { const sk = sketch(S, x.m); options(S, x.m).forEach((o) => { if (!flat.some((f) => f.label === o.label && f.member === x.i)) flat.push(Object.assign({}, o, { member: x.i, sketch: sk, path: [[item, x.i]].concat(o.path) })); }); });
                        const cnt = {}; flat.forEach((f) => { cnt[f.label] = (cnt[f.label] || 0) + 1; }); flat.forEach((f) => { if (cnt[f.label] > 1) f.label = f.label + (f.sketch.length > 1 ? '（後接 ' + f.sketch.slice(1).map((e) => e[0]).join(' ') + '）' : '（到此為止）'); });
                        const onlyL = S.only[ctx.type]; const flat2 = onlyL && flat.some((o) => onlyL.includes(o.node)) ? flat.filter((o) => onlyL.includes(o.node)) : flat; const menuOpts = flat2.length ? flat2 : real.map((x) => ({ label: '分支 ' + x.i, path: [[item, x.i]] }));
                        const withBlank = allBlank ? menuOpts.concat([{ label: '（都不加）', blank: true }]) : menuOpts;
                        const pick = await D.choice({ kind: ctx.kindHint || (menuOpts.some((o) => o.node) ? 'node' : 'branch'), hole, options: withBlank.map((o) => ({ label: o.label, node: o.node, token: o.token, sketch: o.sketch })), path: ctx.type }); const o = withBlank[pick];
                        if (!o || o.blank) idx = item.members.findIndex((m) => m.type === 'BLANK');
                        else { for (const [cn, ci] of o.path) forced.set(cn, ci); forced.delete(item); idx = o.path[0][1]; }
                    }
                }
                return expand(item.members[idx], nd, hole, depth, forced, ctx);
            }
            if (t === 'REPEAT' || t === 'REPEAT1') {
                let n = 0; const min = (t === 'REPEAT1' || (item.content.type === 'SYMBOL' && item.content.name === '_statement' && ctx.type === 'block')) ? 1 : 0;
                for (;;) {
                    if (n >= min) { const pick = await D.choice({ kind: 'repeat', hole, options: [{ label: '再加一個' }, { label: '結束' }], firstSet: options(S, item.content).map((o) => o.label), path: ctx.type, count: n }); if (pick !== 0) break; }
                    await expand(item.content, nd, hole, depth, new Map(), ctx); n++; if (n > 200) break;
                }
                return;
            }
            if (t === 'ALIAS' && !item.named) { nd.parts.push({ tok: item.value }); if (D.token) await D.token(item.value); return; }
            if (t === 'ALIAS') { if (item.named && item.content.type === 'SYMBOL' && isNodeSym(S, item.content.name)) { const child = await node(item.content.name, ctx.field || item.content.name, depth); child.type = item.value; nd.parts.push({ node: child, field: ctx.field }); return; } if (item.named) { const sub = { type: item.value, parts: [], prec: undefined, assoc: undefined }; if (D.enter) await D.enter(item.value, hole); await expand(item.content, sub, hole, depth + 1, new Map(), { type: item.value }); if (D.exit) await D.exit(item.value); nd.parts.push({ node: sub, field: ctx.field }); return; } return expand(item.content, nd, hole, depth, forced, ctx); }
            if (t === 'SYMBOL') {
                const name = item.name;
                if (S.ext.has(name)) { nd.parts.push({ ext: name }); return; }
                if (hidden(name) || S.supertypes.has(name)) {
                    // 隱藏規則／supertype：這個位置就是一個「空位」，列出展開後的具名節點選單（有多於一個選項才問）
                    const rule = S.rules[name]; if (!rule) return;
                    if (rule.type === 'CHOICE' && !forced.has(rule)) { const opts = options(S, rule); if (opts.length > 1 || rule.members.some((m) => m.type === 'BLANK')) return expand(rule, nd, ctx.field ? ctx.field : name, depth, forced, Object.assign({}, ctx, { kindHint: 'node' })); }
                    return expand(rule, nd, ctx.field ? ctx.field : name, depth, forced, ctx);
                }
                const child = await node(name, ctx.field || name, depth); nd.parts.push({ node: child, field: ctx.field }); return;
            }
            if (isLeafRule(item)) { const v = await leafVal('identifier', hole); nd.parts.push({ tok: v, leaf: 'identifier' }); return; }
        }
        // 當節點是 supertype 且被選中（forced 路徑到某個具名節點）時，展開會在 SYMBOL 分支建立子節點，所以直接從 module 開始
        const rootNode = await node('module', 'module', 0); return rootNode;
    }

    // ---------- 反解：樹 → 原始碼；順便算出「正規化的具名節點樹」（自動補括號也算一個 parenthesized_expression 節點）----------
    const OPENERS = new Set(['(', '[', '{']), CLOSERS = new Set([')', ']', '}']);
    function unparse(rootNode, S) {
        const lines = []; let cur = null; let level = 0; let prev = null;
        const word = (s) => /^[A-Za-z0-9_\u0080-￿]/.test(s) || /^["']/.test(s);
        const space = (a, b) => {
            if (a == null) return false; if ((/^[0-9]+$/.test(a) || a === '...') && b === '.') return true;
            if (OPENERS.has(a) || a === '.' || a === '~') return false;
            if (CLOSERS.has(b) || b === ',' || b === ':' || b === '.' || b === ';') return false;
            if (b === '(' ) return !(word(a) && !(S && S.keywords.has(a))) && !CLOSERS.has(a) ? true : false;
            if (b === '[') return !((word(a) && !(S && S.keywords.has(a))) || CLOSERS.has(a));
            return true;
        };
        let glue = false; const emit = (text) => { if (!cur) { cur = { level, toks: [] }; lines.push(cur); prev = null; } cur.toks.push((!glue && space(prev, text) ? ' ' : '') + text); prev = text; glue = false; };
        function walk(nd, parent, depthInfo) {
            const kids = []; let depth = 0; let sawTok = false; const parentTree = { type: nd.type, kids };
            for (const p of nd.parts) {
                if (p.tok !== undefined) { emit(p.tok); if (nd.type === 'unary_operator' && !sawTok) glue = true; sawTok = true; if (OPENERS.has(p.tok)) depth++; else if (CLOSERS.has(p.tok)) depth--; continue; }
                if (p.ext) { if (p.ext === '_newline') { cur = null; } else if (p.ext === '_indent') { cur = null; level++; } else if (p.ext === '_dedent') { level--; cur = null; } continue; }
                if (p.node) {
                    const c = p.node; let paren = false;
                    const pprec = nd.prec !== undefined ? nd.prec : (SPLAT.has(nd.type) ? 99 : undefined); const cprec = c.prec !== undefined ? c.prec : LOW[c.type]; if (depth === 0 && cprec !== undefined && pprec !== undefined) {
                        const isLeftOperand = !sawTok;
                        if (cprec < pprec) paren = true;
                        else if (cprec === pprec) paren = nd.type === 'comparison_operator' || nd.assoc === undefined || (nd.assoc === 'left' && !isLeftOperand) || (nd.assoc === 'right' && isLeftOperand);
                    }
                    if (paren) { emit('('); const sub = walk(c, nd); emit(')'); kids.push({ type: 'parenthesized_expression', kids: [sub] }); }
                    else kids.push(walk(c, nd));
                }
            }
            return parentTree;
        }
        const tree = walk(rootNode, null);
        const text = lines.map((l) => '    '.repeat(l.level) + l.toks.join('')).join('\n') + '\n';
        return { text, tree };
    }
    return { load, build, unparse, options, DEFAULT_DENY, ALGO_DENY };
});
