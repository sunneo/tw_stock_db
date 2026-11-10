/* Ruby 的「進」：tree-sitter-ruby 語法樹 → 核心 IR。純函式 UMD。設計見 DESIGN.core-ir.md 第 14 節。
 * 做法同 ir_in_brace_core.js：目錄（ir_ops_core.js）裡 rb 的每個輸出樣板剖成樣式（`$N`／`@N` 換成佔位識別字），「進」時結構比對認出標準操作。
 * Ruby 沒有型別標註，參數與變數都是 unknown（由 ir_prep_core.js 的推論補；轉靜態語言時推不出來就如實拒絕）。
 *   buildPatterns(parse) → 樣式表；fromTree(root, {source, patterns}) → { ir, coverage, diags }
 * 不認得的敘述／運算式收成 native（原文＋語言），不丟；字串插值、區塊（do…end／{ }）、類別、begin/rescue 都是 native。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./ir_core.js'), require('./ir_ops_core.js')); else root.FaIrInRuby = factory(root.FaIr, root.FaIrOps); })(typeof self !== 'undefined' ? self : this, function (IR, OPS) {
    'use strict';
    const T = IR.T; const PH = /^__a(\d)$/;
    const isCmtT = (c) => c.type === 'comment';
    function unwrap(n) { while (n && (n.type === 'parenthesized_statements' || n.type === 'parenthesized_expression')) { const k = n.namedChildren.filter((c) => !isCmtT(c)); if (k.length !== 1) break; n = k[0]; } return n; }
    const kids = (n) => n.children.filter((c) => !isCmtT(c));
    const size = (n) => 1 + kids(n).reduce((s, c) => s + size(c), 0);
    const isPurePlaceholderBin = (p) => { const x = unwrap(p); return x && x.type === 'binary' && x.namedChildren.every((c) => PH.test(unwrap(c).text)); };
    function match(p, n, b) {
        p = unwrap(p); n = unwrap(n); if (!p || !n) return false;
        const ph = p.type === 'identifier' && PH.exec(p.text);
        if (ph) { const i = +ph[1]; if (b[i]) return b[i].text === n.text; b[i] = n; return true; }
        if (p.type !== n.type) return false;
        const pk = kids(p), nk = kids(n);
        if (!pk.length && !nk.length) return p.text === n.text;
        if (pk.length !== nk.length) return false;
        for (let i = 0; i < pk.length; i++) if (!match(pk[i], nk[i], b)) return false;
        return true;
    }
    function buildPatterns(parse) {
        const out = [];
        for (const id of OPS.ids()) {
            const o = OPS.get(id); const cell = o.cells.rb; if (cell == null) continue;
            const tpls = typeof cell === 'string' ? [cell] : Object.values(cell).filter((x) => x != null);
            for (const t of tpls) {
                if (/\$\*/.test(t)) continue; const text = t.replace(/[$@](\d)/g, '__a$1');
                let root; try { root = parse('__x = ' + text + '\n'); } catch (e) { continue; } if (root.hasError()) continue;
                const as = root.namedChildren[0]; const pr = as && as.type === 'assignment' ? as.childForFieldName('right') : null; if (!pr) continue;
                if (PH.test(unwrap(pr).text)) continue; if (isPurePlaceholderBin(pr)) continue;
                const nargs = Math.max(0, ...[...text.matchAll(/__a(\d)/g)].map((m) => +m[1] + 1)); out.push({ op: id, pat: pr, size: size(pr), nargs, stmt: !!o.stmt });
            }
        }
        out.sort((a, b) => b.size - a.size); return out;
    }
    function unescape(s) { const M = { n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\', "'": "'", '"': '"', e: '\x1b', a: '\x07', b: '\b', f: '\f', v: '\v', s: ' ', '#': '#' }; return s.replace(/\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{1,2})|(.))/g, (m, u, x, c) => (u ? String.fromCharCode(parseInt(u, 16)) : x ? String.fromCharCode(parseInt(x, 16)) : M[c] != null ? M[c] : c)); }

    function fromTree(rootNode, opts) {
        opts = opts || {}; const src = String(opts.source || ''); const patterns = opts.patterns || [];
        const cov = { stmts: 0, natives: 0, comments: 0, comments_kept: 0 }; const diags = [];
        const txt = (n) => (n.text != null ? n.text : src.slice(n.startIndex, n.endIndex));
        const f = (n, name) => n.childForFieldName(name);
        const named = (n) => n.namedChildren.filter((c) => !isCmtT(c));
        const pos = (n) => [n.startPosition.row + 1, n.startPosition.column, n.endPosition.row + 1, n.endPosition.column];
        const at = (o, n) => { o.pos = pos(n); return o; };
        const diag = (m, n) => diags.push({ level: 'warn', msg: m, pos: n ? pos(n) : undefined });
        const nativeE = (n, why) => { cov.natives++; diag('運算式收成原生區塊：' + (why || n.type), n); return at({ k: 'native', lang: 'ruby', src: txt(n), why: why || n.type }, n); };
        const nativeS = (n, why) => { cov.natives++; diag('敘述收成原生區塊：' + (why || n.type), n); return at({ k: 'native', lang: 'ruby', src: txt(n), why: why || n.type }, n); };
        const L = (t, v) => ({ k: 'lit', t, v });
        const fixName = (s) => (s === 'main_' ? 'main' : s);
        const CMP = { '==': '==', '!=': '!=', '<': '<', '>': '>', '<=': '<=', '>=': '>=' };
        // 先掃出檔案裡定義的方法名：單獨一個識別字若是方法名就是呼叫（Ruby 的無括號呼叫）
        const defined = new Set(); (function scan(n) { if (n.type === 'method') defined.add(txt(f(n, 'name'))); for (const c of n.namedChildren) scan(c); })(rootNode);
        const argsOf = (n) => { const a = f(n, 'arguments'); return a ? named(a) : []; };

        function tryOps(n) {
            for (const p of patterns) { const b = []; if (match(p.pat, n, b)) { let ok = true; const args = []; for (let i = 0; i < p.nargs; i++) { if (!b[i]) { ok = false; break; } args.push(b[i]); } if (!ok) continue; const cargs = args.map(ex); let op = p.op;
                // Ruby 的 join 不分字串串列與整數串列：除非引數明顯是 split 的結果，選數字版
                if (op === 'str.join' && !(cargs[1] && cargs[1].k === 'call' && /^str\.split/.test(cargs[1].op || ''))) op = 'str.join_num';
                // Ruby 的 s[i] 對字串與串列寫法相同：改成 index 節點，由型別推論決定是字元還是元素（目錄裡 list.get 和 str.char_at 在 Ruby 是同一個樣板）
                if (op === 'list.get' && cargs.length === 2) return at({ k: 'index', o: cargs[0], i: cargs[1] }, n);
                return at({ k: 'call', op, args: cargs }, n); } }
            return null;
        }
        const LEAF = new Set(['identifier', 'integer', 'float', 'string', 'true', 'false', 'nil', 'constant']);
        function ex(n) {
            if (!n) return null; n = unwrap(n);
            if (!LEAF.has(n.type) && patterns.length) { const r = tryOps(n); if (r) return r; }
            switch (n.type) {
                case 'identifier': return defined.has(txt(n)) ? at({ k: 'call', fn: fixName(txt(n)), args: [] }, n) : at({ k: 'name', v: txt(n) }, n);
                case 'integer': return at(L('int', txt(n).replace(/_/g, '')), n);
                case 'float': return at(L('float', txt(n).replace(/_/g, '')), n);
                case 'true': return at(L('bool', 'true'), n); case 'false': return at(L('bool', 'false'), n); case 'nil': return at(L('none', 'None'), n);
                case 'string': { if (n.namedChildren.some((c) => c.type === 'interpolation')) return nativeE(n, '字串插值'); const t = txt(n); return at(L('str', t[0] === "'" ? t.slice(1, -1).replace(/\\(['\\])/g, '$1') : unescape(t.slice(1, -1))), n); }
                case 'binary': {
                    const op = txt(f(n, 'operator')); const l = f(n, 'left'), r = f(n, 'right');
                    if (CMP[op]) return at({ k: 'cmp', op: CMP[op], l: ex(l), r: ex(r) }, n);
                    if (op === '&&' || op === 'and') return at({ k: 'logic', op: 'and', l: ex(l), r: ex(r) }, n); if (op === '||' || op === 'or') return at({ k: 'logic', op: 'or', l: ex(l), r: ex(r) }, n);
                    if (IR.BINOPS.indexOf(op) < 0) return nativeE(n, '運算子 ' + op);
                    return at({ k: 'bin', op, l: ex(l), r: ex(r) }, n);
                }
                case 'unary': { const op = txt(n.children[0]); const a = named(n)[0]; if (op === '!' || op === 'not') return at({ k: 'not', e: ex(a) }, n); if (['-', '+', '~'].indexOf(op) >= 0) return at({ k: 'un', op, e: ex(a) }, n); return nativeE(n); }
                case 'conditional': return at({ k: 'cond', a: ex(f(n, 'condition')), c: ex(f(n, 'consequence')), b: ex(f(n, 'alternative')) }, n);
                case 'array': return at({ k: 'list', items: named(n).map(ex) }, n);
                case 'hash': return at({ k: 'dict', items: named(n).map((p) => [ex(f(p, 'key')), ex(f(p, 'value'))]) }, n);
                case 'element_reference': { const a = named(n); return at({ k: 'index', o: ex(f(n, 'object') || a[0]), i: ex(a[1]) }, n); }
                case 'call': {
                    const recv = f(n, 'receiver'), m = txt(f(n, 'method')); const args = argsOf(n);
                    if (!recv && m !== 'raise') return at({ k: 'call', fn: fixName(m), args: args.map(ex) }, n);
                    return nativeE(n, '方法 ' + m + ' 不在標準操作目錄');
                }
                default: return nativeE(n);
            }
        }
        // ---- 敘述 ----
        const commentText = (c) => txt(c).replace(/^#\s?/, '');
        function targetOf(x) { const e = ex(x); return e.k === 'call' && (e.op === 'list.get' || e.op === 'dict.get') && e.args.length === 2 ? { k: 'index', o: e.args[0], i: e.args[1], pos: e.pos } : e; }
        function stmt(n) {
            cov.stmts++;
            switch (n.type) {
                case 'assignment': {
                    const left = f(n, 'left'), right = f(n, 'right');
                    if (left.type !== 'identifier' && left.type !== 'element_reference') return [nativeS(n, '賦值目標 ' + left.type)];
                    return [at({ k: 'assign', to: left.type === 'identifier' ? at({ k: 'name', v: txt(left) }, left) : targetOf(left), val: ex(right) }, n)];
                }
                case 'operator_assignment': {
                    const op = txt(f(n, 'operator')).replace(/=$/, ''); if (IR.BINOPS.indexOf(op) < 0) return [nativeS(n, '複合賦值 ' + op)];
                    const left = f(n, 'left'); return [at({ k: 'aug', to: left.type === 'identifier' ? at({ k: 'name', v: txt(left) }, left) : targetOf(left), op, val: ex(f(n, 'right')) }, n)];
                }
                case 'method': return [func(n)];
                case 'if': return [ifS(n)];
                case 'while': { const w = at({ k: 'while', cond: ex(f(n, 'condition')), body: [] }, n); w.body = blockOf(f(n, 'body'), n); return [attach(w, n)]; }
                case 'for': return forS(n);
                case 'return': { const a = n.namedChildren.find((c) => c.type === 'argument_list'); const e = a ? named(a)[0] : null; return [at({ k: 'ret', val: e ? ex(e) : undefined }, n)]; }
                case 'break': return [at({ k: 'brk' }, n)]; case 'next': return [at({ k: 'cont' }, n)];
                case 'call': {
                    if (!f(n, 'receiver') && txt(f(n, 'method')) === 'raise') { const a = argsOf(n); return [at({ k: 'raise', val: a[0] ? ex(a[0]) : undefined }, n)]; }
                    const e = ex(n); if (e.k === 'native') return [nativeS(n)]; return [at({ k: 'expr', e }, n)];
                }
                case 'identifier': { const e = ex(n); return [at({ k: 'expr', e }, n)]; }
                case 'integer': case 'float': case 'string': case 'binary': case 'unary': return [at({ k: 'expr', e: ex(n) }, n)];
                default: return [nativeS(n)];
            }
        }
        function forS(n) {
            const v = f(n, 'pattern'), val = f(n, 'value'), body = f(n, 'body'); if (!v || v.type !== 'identifier' || !val) return [nativeS(n, '迴圈變數')];
            const it = unwrap(named(val)[0]); const vn = txt(v);
            const mk = (o) => { o.body = blockOf(body, n); return [attach(o, n)]; };
            if (it.type === 'range' && txt(it.children.find((c) => !c.isNamed())).indexOf('...') >= 0) { const [a, b] = named(it); return mk(at({ k: 'forrange', var: vn, from: ex(a), to: ex(b) }, n)); }
            if (it.type === 'call' && f(it, 'receiver') && txt(f(it, 'method')) === 'step') {
                const recv = unwrap(f(it, 'receiver')), as = argsOf(it);
                if (recv.type === 'range' && as.length === 1) { const [a, b] = named(recv); const sv = ex(as[0]); if (sv.k === 'lit' && sv.t === 'int') return mk(at({ k: 'forrange', var: vn, from: ex(a), to: ex(b), step: sv }, n)); if (sv.k === 'un' && sv.e.k === 'lit') return mk(at({ k: 'forrange', var: vn, from: ex(a), to: ex(b), step: sv }, n)); }
                if (recv.type !== 'range' && as.length === 2) { const hi = ex(as[0]), sv = ex(as[1]); if (hi.k === 'bin' && hi.op === '+' && hi.r.k === 'lit' && hi.r.v === '1' && sv.k === 'un' && sv.e.k === 'lit') return mk(at({ k: 'forrange', var: vn, from: ex(recv), to: hi.l, step: sv }, n)); }
            }
            const itx = ex(it); if (itx.k === 'native') return [nativeS(n, '走訪的對象')];
            let iter = itx; if (it.type === 'call' && f(it, 'receiver') && txt(f(it, 'method')) === 'keys' && !argsOf(it).length) iter = ex(f(it, 'receiver'));
            return mk(at({ k: 'foreach', var: vn, iter }, n));
        }
        function ifS(n) {
            const o = at({ k: 'if', cond: ex(f(n, 'condition')), then: [] }, n); o.then = blockOf(f(n, 'consequence'), n); attach(o, n);
            const alt = f(n, 'alternative');
            if (alt) { if (alt.type === 'elsif') o.else = [ifS(alt)]; else o.else = blockOf(alt, alt); }
            return o;
        }
        // 把一個容器節點（then／do／else／method）的子節點轉成敘述，註解依位置掛成 前置／行尾／獨立／標頭行尾（同 ir_in_brace_core.js 的規則）
        function blockOf(bn, parent) { if (!bn) return []; const arr = block(bn.children.filter((c) => c.isNamed()), parent ? parent.startPosition.row : undefined); return arr; }
        function block(list, headerRow) {
            const out = []; let pending = []; let prev = null, prevEnd = -1; const hdr = []; out.hdr = hdr;
            for (const c of list) {
                if (isCmtT(c)) {
                    cov.comments++; const row = c.startPosition.row, t = commentText(c);
                    if (headerRow != null && row === headerRow && !prev) { hdr.push(t); cov.comments_kept++; continue; }
                    if (prev && row === prevEnd) { prev.c = prev.c || {}; prev.c.a = prev.c.a ? prev.c.a + ' ' + t : t; cov.comments_kept++; continue; }
                    pending.push({ t, row }); continue;
                }
                const ss = stmt(c); if (!ss.length) continue;
                const lastRowBefore = pending.length ? pending[pending.length - 1].row : prevEnd; const gap = prevEnd >= 0 || pending.length ? c.startPosition.row - lastRowBefore - 1 : 0; const first = ss[0];
                if (pending.length) { first.c = first.c || {}; first.c.b = pending.map((p) => p.t).concat(first.c.b || []); cov.comments_kept += pending.length; const g0 = pending[0].row - (prevEnd >= 0 ? prevEnd : pending[0].row) - 1; if (g0 > 0 && prevEnd >= 0) first.c.sp = 1; pending = []; }
                else if (gap > 0 && prevEnd >= 0) { first.c = first.c || {}; first.c.sp = 1; }
                ss.forEach((s) => out.push(s)); prev = ss[ss.length - 1]; prevEnd = c.endPosition.row;
            }
            if (pending.length) pending.forEach((p) => { out.push({ k: 'comment', s: p.t }); cov.comments_kept++; });
            return out;
        }
        // 標頭行尾註解：for／while／if 的註解有時掛在父節點（for 的直接子節點），有時在 then／do 的第一個子節點（已由 block 處理成 hdr）
        function attach(o, n) {
            const arr = o.body || o.then || []; const h = (arr.hdr || []).slice();
            for (const c of n.children) if (isCmtT(c) && c.startPosition.row === n.startPosition.row) { h.push(commentText(c)); cov.comments++; cov.comments_kept++; }
            if (h.length) { o.c = o.c || {}; o.c.a = h.join(' '); } return o;
        }
        function func(n) {
            const name = txt(f(n, 'name')), ps = f(n, 'parameters'); const params = ps ? named(ps).map((p) => { if (p.type === 'identifier') return { name: txt(p) }; diag('不支援的參數形式 ' + p.type, p); return { name: txt(p) }; }) : [];
            const o = at({ k: 'func', name: fixName(name), params, body: [] }, n);
            const skip = new Set([f(n, 'name').startIndex, ps ? ps.startIndex : -1]); const list = n.children.filter((c) => c.isNamed() && !skip.has(c.startIndex));
            o.body = block(list, n.startPosition.row); const h = o.body.hdr || []; if (h.length) { o.c = o.c || {}; o.c.a = h.join(' '); } return o;
        }
        // ---- 模組層 ----
        const ir = IR.mod({ src: { lang: 'ruby', file: opts.file }, name: opts.name || 'Module' });
        const top = block(rootNode.children.filter((c) => c.isNamed()), undefined); const body = [];
        for (const s of top) { if (s.k === 'expr' && s.e && s.e.k === 'call' && s.e.fn === 'main' && !(s.e.args || []).length) continue; body.push(s); }
        ir.body = body.filter((s) => !(s.k === 'pass' && !s.c));
        if (IR.funcs(ir).some((x) => x.name === 'main')) ir.entry = 'main';
        return { ir, coverage: cov, diags };
    }
    return { buildPatterns, fromTree };
});
