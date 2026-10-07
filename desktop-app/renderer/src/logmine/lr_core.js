/* LALR(1) 語法分析表產生器與驅動程式（FaLR）：像 bison／yacc 那樣，給一份文脈無關文法（產生式，可以遞迴），產生 LALR(1) 分析表（action／goto），
 * 並用這張表解析 token 串。文法可以是人寫的，也可以是 FaGram 從文字自己學出來的。
 *
 *   grammar = { start: 'file', productions: [{ lhs: 'expr', rhs: ['expr', '+', 'term'] }, …], prec?: { '+': { level: 1, assoc: 'left' } } }
 *   符號：出現在某個產生式左邊的是非終端符號，其他都是終端符號；空的 rhs（[]）是 ε。
 *
 * 建表：LR(0) 項目集 → 以「自發產生＋傳播」決定 LALR 前瞻（教科書算法）→ action／goto；衝突（shift/reduce、reduce/reduce）照 bison 的規則處理並全部記下：
 *   shift/reduce 有優先序就依優先序，沒有就 shift；reduce/reduce 取編號小的產生式。
 * 全部是純函式（UMD）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaLR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const EOF = '$end', AUG = '$accept', DUMMY = '#';

    function analyze(grammar) {
        const prods = [{ lhs: AUG, rhs: [grammar.start, EOF], id: 0, aug: true }];
        grammar.productions.forEach((p, i) => prods.push({ lhs: p.lhs, rhs: p.rhs.slice(), id: i + 1, prec: p.prec, label: p.label }));
        const nts = new Set(prods.map((p) => p.lhs)); const terms = new Set([EOF]);
        for (const p of prods) for (const s of p.rhs) if (!nts.has(s)) terms.add(s);
        const byLhs = new Map(); for (const p of prods) { if (!byLhs.has(p.lhs)) byLhs.set(p.lhs, []); byLhs.get(p.lhs).push(p); }
        // nullable、FIRST
        const nullable = new Set(); let ch = true; while (ch) { ch = false; for (const p of prods) if (!nullable.has(p.lhs) && p.rhs.every((s) => nullable.has(s))) { nullable.add(p.lhs); ch = true; } }
        const first = new Map(); for (const t of terms) first.set(t, new Set([t])); for (const n of nts) first.set(n, new Set());
        ch = true; while (ch) { ch = false; for (const p of prods) { const f = first.get(p.lhs); for (const s of p.rhs) { for (const x of first.get(s) || []) if (!f.has(x)) { f.add(x); ch = true; } if (!nullable.has(s)) break; } } }
        const firstSeq = (seq, la) => { const out = new Set(); for (const s of seq) { for (const x of first.get(s) || [s]) out.add(x); if (!nullable.has(s)) return out; } if (la !== undefined) out.add(la); return out; };
        return { prods, nts, terms, byLhs, nullable, first, firstSeq };
    }
    const itemKey = (p, d) => p + '.' + d;

    function build(grammar, opts) {
        opts = opts || {}; const A = analyze(grammar); const { prods, nts, terms, byLhs, firstSeq } = A; const prec = grammar.prec || {};
        // LR(0) 項目集
        const closure0 = (kernel) => { const set = new Map(kernel.map((k) => [itemKey(k.p, k.d), k])); const stack = kernel.slice(); while (stack.length) { const it = stack.pop(); const rhs = prods[it.p].rhs; if (it.d < rhs.length && nts.has(rhs[it.d])) for (const q of byLhs.get(rhs[it.d])) { const k = itemKey(q.id, 0); if (!set.has(k)) { const ni = { p: q.id, d: 0 }; set.set(k, ni); stack.push(ni); } } } return Array.from(set.values()); };
        const states = []; const index = new Map(); const sk = (kernel) => kernel.map((k) => itemKey(k.p, k.d)).sort().join('|');
        const addState = (kernel) => { const key = sk(kernel); if (index.has(key)) return index.get(key); const id = states.length; index.set(key, id); states.push({ id, kernel: kernel.slice().sort((a, b) => a.p - b.p || a.d - b.d), trans: new Map() }); return id; };
        addState([{ p: 0, d: 0 }]);
        for (let i = 0; i < states.length; i++) {
            const st = states[i]; const cl = closure0(st.kernel); const bySym = new Map();
            for (const it of cl) { const rhs = prods[it.p].rhs; if (it.d < rhs.length) { const s = rhs[it.d]; if (!bySym.has(s)) bySym.set(s, []); bySym.get(s).push({ p: it.p, d: it.d + 1 }); } }
            for (const [s, kernel] of bySym) st.trans.set(s, addState(kernel));
        }
        // LALR 前瞻：自發產生＋傳播
        const la = states.map((st) => new Map(st.kernel.map((k) => [itemKey(k.p, k.d), new Set()]))); la[0].get(itemKey(0, 0)).add(EOF); const prop = [];
        const closure1 = (items) => { const out = new Map(); const work = items.map((x) => ({ p: x.p, d: x.d, a: x.a })); const seen = new Set(); while (work.length) { const it = work.pop(); const k = itemKey(it.p, it.d) + '/' + it.a; if (seen.has(k)) continue; seen.add(k); out.set(k, it); const rhs = prods[it.p].rhs; if (it.d < rhs.length && nts.has(rhs[it.d])) { const f = firstSeq(rhs.slice(it.d + 1), it.a); for (const q of byLhs.get(rhs[it.d])) for (const b of f) work.push({ p: q.id, d: 0, a: b }); } } return Array.from(out.values()); };
        for (const st of states) for (const kern of st.kernel) {
            const cl = closure1([{ p: kern.p, d: kern.d, a: DUMMY }]);
            for (const it of cl) { const rhs = prods[it.p].rhs; if (it.d >= rhs.length) continue; const target = st.trans.get(rhs[it.d]); const tk = itemKey(it.p, it.d + 1);
                if (it.a === DUMMY) prop.push({ from: { s: st.id, k: itemKey(kern.p, kern.d) }, to: { s: target, k: tk } }); else la[target].get(tk).add(it.a); }
        }
        let changed = true; while (changed) { changed = false; for (const e of prop) { const src = la[e.from.s].get(e.from.k), dst = la[e.to.s].get(e.to.k); for (const a of src) if (!dst.has(a)) { dst.add(a); changed = true; } } }
        // action／goto
        const action = states.map(() => new Map()); const gotoT = states.map(() => new Map()); const conflicts = [];
        const precOf = (p) => { if (p.prec) return prec[p.prec] || null; for (let i = p.rhs.length - 1; i >= 0; i--) if (terms.has(p.rhs[i]) && prec[p.rhs[i]]) return prec[p.rhs[i]]; return null; };
        const setAct = (s, t, act) => {
            const cur = action[s].get(t); if (!cur) { action[s].set(t, act); return; } if (cur.type === act.type && cur.n === act.n) return;
            let win = cur, lose = act, how = '';
            if ((cur.type === 'shift' && act.type === 'reduce') || (cur.type === 'reduce' && act.type === 'shift')) {
                const sh = cur.type === 'shift' ? cur : act, rd = cur.type === 'reduce' ? cur : act; const pp = precOf(prods[rd.n]), tp = prec[t];
                if (pp && tp) { if (pp.level > tp.level) { win = rd; lose = sh; how = '優先序：reduce'; } else if (pp.level < tp.level) { win = sh; lose = rd; how = '優先序：shift'; } else if (tp.assoc === 'left') { win = rd; lose = sh; how = '結合性：reduce'; } else if (tp.assoc === 'right') { win = sh; lose = rd; how = '結合性：shift'; } else { win = null; lose = null; how = '不可結合：錯誤'; } }
                else { win = sh; lose = rd; how = '預設：shift'; }
                conflicts.push({ state: s, token: t, kind: 'shift/reduce', shift: sh.n, reduce: rd.n, resolved: how, byPrec: how.indexOf('優先序') === 0 || how.indexOf('結合性') === 0 });
                if (win === null) { action[s].set(t, { type: 'error' }); return; }
            } else if (cur.type === 'reduce' && act.type === 'reduce') { win = cur.n < act.n ? cur : act; lose = cur.n < act.n ? act : cur; conflicts.push({ state: s, token: t, kind: 'reduce/reduce', reduce: [cur.n, act.n], resolved: '取編號小的產生式 ' + win.n }); }
            action[s].set(t, win);
        };
        for (const st of states) {
            const cl = closure1(st.kernel.map((k) => ({ p: k.p, d: k.d, a: DUMMY })).flatMap((x) => Array.from(la[st.id].get(itemKey(x.p, x.d))).map((a) => ({ p: x.p, d: x.d, a }))));
            // 沒有前瞻的核心項目（例如沒有任何東西會用到它）也要保留：用空集合就不會產生 reduce，不影響正確性
            for (const it of cl) { const p = prods[it.p]; if (it.d < p.rhs.length) continue; if (p.aug) continue; setAct(st.id, it.a, { type: 'reduce', n: it.p }); }
            for (const [sym, to] of st.trans) { if (sym === EOF) { setAct(st.id, EOF, { type: 'accept' }); } else if (nts.has(sym)) gotoT[st.id].set(sym, to); else setAct(st.id, sym, { type: 'shift', n: to }); }
        }
        return { grammar, prods, nts, terms, states, action, goto: gotoT, conflicts, start: grammar.start, stats: { states: states.length, productions: prods.length - 1, terminals: terms.size - 1, nonterminals: nts.size - 1, conflicts: conflicts.length, unresolved: conflicts.filter((c) => !c.byPrec).length } };
    }

    // ---------- 驅動程式 ----------
    // tokens：[{ t: 終端符號名, v: 值, n: 位置（行號）}]；回傳 { ok, tree, error:{at, token, expected[]}, steps }
    function parse(table, tokens, opts) {
        opts = opts || {}; const { prods, action, goto: gotoT } = table; const stack = [{ s: 0, node: null }]; let i = 0; let steps = 0; const max = opts.maxSteps || 2000000;
        const toks = tokens.concat([{ t: EOF, v: null, n: tokens.length ? tokens[tokens.length - 1].n : 0 }]);
        while (steps++ < max) {
            const st = stack[stack.length - 1].s; const tk = toks[i]; const act = action[st].get(tk.t);
            if (!act || act.type === 'error') return { ok: false, error: { at: i, token: tk.t, value: tk.v, n: tk.n, expected: Array.from(action[st].keys()).filter((k) => action[st].get(k).type !== 'error'), stack: stack.slice(1).map((x) => x.node.sym) }, steps };
            if (act.type === 'shift') { stack.push({ s: act.n, node: { sym: tk.t, value: tk.v, n: tk.n, leaf: true, tok: tk } }); i++; }
            else if (act.type === 'reduce') {
                const p = prods[act.n]; const kids = []; for (let k = 0; k < p.rhs.length; k++) kids.unshift(stack.pop().node); const node = { sym: p.lhs, prod: act.n, children: kids, n: kids.length ? kids[0].n : tk.n }; const g = gotoT[stack[stack.length - 1].s].get(p.lhs); if (g === undefined) return { ok: false, error: { at: i, token: tk.t, n: tk.n, expected: [], internal: 'goto 缺少 ' + p.lhs }, steps }; stack.push({ s: g, node });
            } else if (act.type === 'accept') return { ok: true, tree: stack[stack.length - 1].node, steps, consumed: i };
        }
        return { ok: false, error: { at: i, internal: '超過最大步數' }, steps };
    }
    // 判斷一個 token 串能不能被接受（只要結果，不建樹；給「這行已經被現有文法吃掉了嗎」用）
    const accepts = (table, tokens) => parse(table, tokens).ok;

    // ---------- 輸出 ----------
    const symName = (s) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'");
    function toBison(grammar, opts) {
        opts = opts || {}; const nts = new Set(grammar.productions.map((p) => p.lhs)); const terms = []; const seen = new Set(); for (const p of grammar.productions) for (const s of p.rhs) if (!nts.has(s) && !seen.has(s)) { seen.add(s); terms.push(s); }
        const out = []; out.push('/* ' + (opts.title || '自動學出的文法') + ' */'); const named = terms.filter((t) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t)); if (named.length) out.push('%token ' + named.join(' '));
        const pr = grammar.prec || {}; const levels = {}; for (const [t, v] of Object.entries(pr)) (levels[v.level] = levels[v.level] || { assoc: v.assoc, toks: [] }).toks.push(symName(t)); for (const l of Object.keys(levels).sort((a, b) => a - b)) out.push('%' + (levels[l].assoc || 'left') + ' ' + levels[l].toks.join(' '));
        out.push('%start ' + grammar.start, '', '%%', '');
        const order = []; const by = new Map(); for (const p of grammar.productions) { if (!by.has(p.lhs)) { by.set(p.lhs, []); order.push(p.lhs); } by.get(p.lhs).push(p); }
        for (const l of order) { const alts = by.get(l).map((p) => (p.rhs.length ? p.rhs.map(symName).join(' ') : '/* empty */') + (p.label ? '    /* ' + p.label + ' */' : '')); out.push(l + '\n    : ' + alts.join('\n    | ') + '\n    ;', ''); }
        out.push('%%'); return out.join('\n');
    }
    function dumpTable(table, opts) {
        opts = opts || {}; const L = []; const terms = Array.from(table.terms).sort(); const nts = Array.from(table.nts).filter((n) => n !== AUG).sort(); const maxS = opts.maxStates || 60;
        L.push('狀態 ' + table.stats.states + '、產生式 ' + table.stats.productions + '、終端 ' + table.stats.terminals + '、非終端 ' + table.stats.nonterminals + '、衝突 ' + table.stats.conflicts + '（未用優先序解決 ' + table.stats.unresolved + '）');
        for (const st of table.states.slice(0, maxS)) { const acts = Array.from(table.action[st.id].entries()).map(([t, a]) => symName(t) + (a.type === 'shift' ? ' s' + a.n : a.type === 'reduce' ? ' r' + a.n : a.type === 'accept' ? ' acc' : ' err')); const gts = Array.from(table.goto[st.id].entries()).map(([n, s]) => n + ' g' + s); L.push('state ' + st.id + '：' + acts.join('，') + (gts.length ? '｜' + gts.join('，') : '')); }
        if (table.states.length > maxS) L.push('…還有 ' + (table.states.length - maxS) + ' 個狀態'); return L;
    }
    const describeProd = (table, n) => { const p = table.prods[n]; return p.lhs + ' → ' + (p.rhs.length ? p.rhs.map(symName).join(' ') : 'ε'); };
    const describeConflict = (table, c) => (c.kind === 'shift/reduce' ? '狀態 ' + c.state + ' 遇到 ' + symName(c.token) + '：shift／reduce（' + describeProd(table, c.reduce) + '）→ ' + c.resolved : '狀態 ' + c.state + ' 遇到 ' + symName(c.token) + '：reduce／reduce（' + c.reduce.map((n) => describeProd(table, n)).join('；') + '）→ ' + c.resolved);

    return { build, parse, accepts, toBison, dumpTable, describeProd, describeConflict, EOF };
});
