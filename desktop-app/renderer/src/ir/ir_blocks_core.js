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
 *   bridge.blocksToTarget(funcs, lang)
 *   bridge.cards(python)             → 函式行為卡陣列（level 2，含每個函式用到的區塊範本）
 *   bridge.cardText(card)            → 白話卡片
 *   bridge.styleCheck(python)        → 函式名／變數名的命名風格一致性（缺口 F）
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaIrBlocks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    function make(env) {
        const { parseTree, C2U, B, IN, PREP, OUT, BD, DES } = env;
        const anyT = { base: 'any', args: [] };
        const mkOp = (name, params, body) => ({ name, params: (params || []).map((x) => ({ name: x, type: anyT })), returns: anyT, visibility: '+', static: true, body });
        const blocksOf = (f) => {
            if (f.blocks) return { ok: true, blocks: f.blocks, errors: [] };
            const pr = B.parseCNL(f.cnl || ''); return { ok: pr.ok, blocks: pr.blocks, errors: pr.errors || [] };
        };
        // 區塊 → Python（所有函式；有名為 main 的函式就在最後呼叫它）
        function program(funcs, opts) {
            const ctx = opts && opts.ctx; const errors = [], bodies = {};
            for (const f of funcs) { const r = blocksOf(f); if (!r.ok) { errors.push({ func: f.name, errors: r.errors }); continue; } bodies[f.name] = { body: B.toIR(r.blocks), params: f.params }; }
            if (errors.length) return { ok: false, errors, python: '' };
            // 有原模型（fromPython 的 ctx）就沿用它的 import、型別標註、模組層敘述；只換函式本體。沒有就從頭組一個最小模型
            const m = ctx ? JSON.parse(JSON.stringify(ctx)) : { name: 'M', actors: [], relations: [], usecases: [], prelude: [], order: [], classes: [{ name: 'M', kind: 'class', attrs: [], values: [], ops: [] }] };
            const seen = {}; m.classes.forEach((c) => c.ops.forEach((op) => { if (bodies[op.name]) { op.body = bodies[op.name].body; seen[op.name] = 1; } }));
            let added = 0; Object.keys(bodies).forEach((n) => { if (!seen[n]) { m.classes[0].ops.push(mkOp(n, bodies[n].params, bodies[n].body)); added++; } });
            let python = C2U.toPython(m); if (!ctx && bodies.main) python += '\nmain()\n';
            return { ok: true, errors: [], python };
        }
        function fromPython(src) {
            const tree = parseTree(src); const u = C2U.fromTree(tree.rootNode, { source: src });
            const funcs = [];
            u.model.classes.forEach((c) => c.ops.forEach((op) => {
                const blocks = B.fromIR(op.body); funcs.push({ name: op.name, params: op.params.map((p) => p.name), sig: { params: op.params, ret: op.ret }, blocks, cnl: B.toCNL(blocks), stats: B.stats(blocks) });
            }));
            return { funcs, coverage: u.coverage, ctx: u.model };
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
        return { styleCheck, program, fromPython, toIr, emit, blocksToTarget, cards, cardText };
    }
    return { make };
});
