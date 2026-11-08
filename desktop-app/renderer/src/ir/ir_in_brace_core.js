/* 大括號語言「進」：JavaScript（nodejs）與 Java 的 tree-sitter 語法樹 → 核心 IR。純函式 UMD。設計見 DESIGN.core-ir.md 第 11 節。
 *   buildPatterns(lang, parse) → 樣式表：把目錄（ir_ops_core.js）裡該語言的每個輸出樣板，用同一個語言的剖析器剖成語法樹，
 *       `$N`／`@N` 換成佔位識別字 __aN；「進」時拿程式裡的運算式節點去和這些樣式做結構比對（括號不算、佔位符可綁任何運算式），
 *       比對成功就是那個標準操作（所以「進」和「出」用的是同一份目錄，不會兩邊各寫一套）。
 *   fromTree(rootNode, {lang:'nodejs'|'java', source, patterns, name}) → { ir, coverage:{stmts, natives, comments, comments_kept}, diags }
 * 保留：註解（前置／行尾／獨立成行／函式標頭行尾）、JSDoc／Javadoc（變成 func.doc）、空行（sp）、來源位置（pos）；不認得的敘述／運算式收成 native（原文＋語言），不丟。
 * 輸出器自己加的前置輔助函式（fa_*、__fa_*、Java 的 main(String[] args) 包裝）會被略過。
 * 註解的掛回規則沿用 ir_in_python_core.js／ir_blocks_core.js（前置、行尾、獨立、標頭行尾）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./ir_core.js'), require('./ir_ops_core.js')); else root.FaIrInBrace = factory(root.FaIr, root.FaIrOps); })(typeof self !== 'undefined' ? self : this, function (IR, OPS) {
    'use strict';
    const T = IR.T;
    const PH = /^__a(\d)$/;
    // ---------- 樣式 ----------
    function unwrap(n) { while (n && (n.type === 'parenthesized_expression' || n.type === 'condition')) { const k = n.namedChildren.filter((c) => !/comment/.test(c.type)); if (k.length !== 1) break; n = k[0]; } return n; }
    function wrapTpl(lang, tpl) { return lang === 'java' ? 'class X { void f() { Object o = ' + tpl + '; } }' : '(' + tpl + ');'; }
    function patRoot(lang, root) {
        if (root.hasError()) return null;
        if (lang === 'java') { const find = (n) => { if (n.type === 'variable_declarator') return n.childForFieldName('value'); for (const c of n.namedChildren) { const r = find(c); if (r) return r; } return null; }; return find(root); }
        const st = root.namedChildren[0]; return st && st.type === 'expression_statement' ? st.namedChildren[0] : null;
    }
    const kids = (n) => n.children.filter((c) => !/comment/.test(c.type));
    function size(n) { return 1 + kids(n).reduce((s, c) => s + size(c), 0); }
    const isPurePlaceholderBin = (p) => { const x = unwrap(p); return x && (x.type === 'binary_expression') && x.namedChildren.every((c) => PH.test(unwrap(c).text)); };
    function buildPatterns(lang, parse) {
        const key = OPS.LANG_OF[lang] || lang; const out = [];
        for (const id of OPS.ids()) {
            const o = OPS.get(id); const cell = o.cells[key]; if (cell == null) continue;
            const tpls = typeof cell === 'string' ? [cell] : Object.values(cell).filter((x) => x != null);
            for (const t of tpls) {
                if (/\$\*/.test(t)) continue; const text = t.replace(/[$@](\d)/g, '__a$1');
                let root; try { root = parse(wrapTpl(lang, text)); } catch (e) { continue; } const pr = patRoot(lang, root); if (!pr) continue;
                if (PH.test(unwrap(pr).text)) continue; if (isPurePlaceholderBin(pr)) continue;
                const nargs = Math.max(0, ...[...text.matchAll(/__a(\d)/g)].map((m) => +m[1] + 1)); out.push({ op: id, pat: pr, size: size(pr), nargs, stmt: !!o.stmt });
            }
        }
        out.sort((a, b) => b.size - a.size); return out;
    }
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
    // ---------- 型別 ----------
    function tyJava(s) {
        s = String(s || '').replace(/\s+/g, ''); if (!s) return T.unknown;
        const m = /^([A-Za-z_][A-Za-z_0-9.]*)(?:<(.*)>)?$/.exec(s); if (!m) return T.unknown; const n = m[1], inner = m[2];
        if (n === 'long' || n === 'int' || n === 'Long' || n === 'Integer' || n === 'short' || n === 'byte') return T.int; if (n === 'double' || n === 'float' || n === 'Double') return T.float;
        if (n === 'String') return T.str; if (n === 'boolean' || n === 'Boolean') return T.bool; if (n === 'void') return T.void; if (n === 'Object') return T.any;
        const split = (t) => { const r = []; let d = 0, cur = ''; for (const ch of t) { if (ch === '<') d++; if (ch === '>') d--; if (ch === ',' && d === 0) { r.push(cur); cur = ''; } else cur += ch; } r.push(cur); return r; };
        if (inner != null) { const a = split(inner).map(tyJava); if (n === 'List' || n === 'ArrayList' || n === 'LinkedList') return IR.list(a[0]); if (n === 'Map' || n === 'HashMap' || n === 'LinkedHashMap' || n === 'TreeMap') return IR.dict(a[0], a[1]); if (n === 'Set' || n === 'HashSet' || n === 'TreeSet') return IR.set(a[0]); }
        return T.unknown;
    }
    function unescape(s) { return s.replace(/\\(?:u([0-9a-fA-F]{4})|(.))/g, (m, u, c) => (u ? String.fromCharCode(parseInt(u, 16)) : ({ n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\', "'": "'", '"': '"', b: '\b', f: '\f', v: '\v' }[c] != null ? { n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\', "'": "'", '"': '"', b: '\b', f: '\f', v: '\v' }[c] : c))); }

    function fromTree(rootNode, opts) {
        opts = opts || {}; const lang = opts.lang === 'java' ? 'java' : 'nodejs'; const src = String(opts.source || ''); const patterns = opts.patterns || [];
        const cov = { stmts: 0, natives: 0, comments: 0, comments_kept: 0 }; const diags = []; const JAVA = lang === 'java';
        const txt = (n) => (n.text != null ? n.text : src.slice(n.startIndex, n.endIndex));
        const f = (n, name) => n.childForFieldName(name);
        const isCmt = (c) => c.type === 'comment' || c.type === 'line_comment' || c.type === 'block_comment';
        const named = (n) => n.namedChildren.filter((c) => !isCmt(c));
        const pos = (n) => [n.startPosition.row + 1, n.startPosition.column, n.endPosition.row + 1, n.endPosition.column];
        const at = (o, n) => { o.pos = pos(n); return o; };
        const diag = (m, n) => diags.push({ level: 'warn', msg: m, pos: n ? pos(n) : undefined });
        const nativeE = (n, why) => { cov.natives++; diag('運算式收成原生區塊：' + (why || n.type), n); return at({ k: 'native', lang: JAVA ? 'java' : 'nodejs', src: txt(n), why: why || n.type }, n); };
        const nativeS = (n, why) => { cov.natives++; diag('敘述收成原生區塊：' + (why || n.type), n); return at({ k: 'native', lang: JAVA ? 'java' : 'nodejs', src: txt(n), why: why || n.type }, n); };
        const L = (t, v) => ({ k: 'lit', t, v });
        const isHelperName = (s) => /^(fa_|__fa|__br)/.test(s);

        const CMP = { '===': '==', '!==': '!=', '==': '==', '!=': '!=', '<': '<', '>': '>', '<=': '<=', '>=': '>=' };
        function tryOps(n) {
            for (const p of patterns) { const b = []; if (match(p.pat, n, b)) { let ok = true; const args = []; for (let i = 0; i < p.nargs; i++) { if (!b[i]) { ok = false; break; } args.push(b[i]); } if (!ok) continue; const cargs = args.map(ex); let op = p.op;
                // JavaScript／Java 的 join 不分字串串列與整數串列，兩個操作的樣板一樣：除非引數明顯是字串串列（split 的結果），選數字版——在 Python 裡 map(str, …) 對字串也無害，是比較安全的一邊
                if (op === 'str.join' && !(cargs[1] && cargs[1].k === 'call' && /^str\.split/.test(cargs[1].op || ''))) op = 'str.join_num';
                return at({ k: 'call', op, args: cargs }, n); } }
            return null;
        }
        const PATTERN_TYPES = new Set(['call_expression', 'member_expression', 'new_expression', 'binary_expression', 'ternary_expression', 'method_invocation', 'object_creation_expression', 'cast_expression', 'field_access', 'unary_expression', 'array_creation_expression']);
        function ex(n) {
            if (!n) return null; n = unwrap(n);
            if (PATTERN_TYPES.has(n.type) && patterns.length) { const r = tryOps(n); if (r) return r; }
            switch (n.type) {
                case 'identifier': return at({ k: 'name', v: txt(n) }, n);
                case 'number': case 'decimal_integer_literal': case 'hex_integer_literal': case 'decimal_floating_point_literal': { const t = txt(n).replace(/_/g, '').replace(/[lL]$/, ''); return at(L(/[.eE]/.test(t) && !/^0x/i.test(t) ? 'float' : 'int', t), n); }
                case 'true': return at(L('bool', 'true'), n); case 'false': return at(L('bool', 'false'), n); case 'null': case 'null_literal': return at(L('none', 'None'), n);
                case 'string': case 'string_literal': { const t = txt(n); return at(L('str', unescape(t.slice(1, -1))), n); }
                case 'binary_expression': {
                    const op = txt(f(n, 'operator')); const l = f(n, 'left'), r = f(n, 'right');
                    if (CMP[op]) return at({ k: 'cmp', op: CMP[op], l: ex(l), r: ex(r) }, n);
                    if (op === '&&' || op === '||') return at({ k: 'logic', op: op === '&&' ? 'and' : 'or', l: ex(l), r: ex(r) }, n);
                    if (IR.BINOPS.indexOf(op) < 0) return nativeE(n, '運算子 ' + op);
                    return at({ k: 'bin', op, l: ex(l), r: ex(r) }, n);
                }
                case 'unary_expression': { const op = txt(f(n, 'operator')); const a = f(n, 'argument') || f(n, 'operand'); if (op === '!') return at({ k: 'not', e: ex(a) }, n); if (['-', '+', '~'].indexOf(op) >= 0) return at({ k: 'un', op, e: ex(a) }, n); return nativeE(n); }
                case 'ternary_expression': return at({ k: 'cond', a: ex(f(n, 'condition')), c: ex(f(n, 'consequence')), b: ex(f(n, 'alternative')) }, n);
                case 'subscript_expression': return at({ k: 'index', o: ex(f(n, 'object')), i: ex(f(n, 'index')) }, n);
                case 'array_access': return at({ k: 'index', o: ex(f(n, 'array')), i: ex(f(n, 'index')) }, n);
                case 'array': return at({ k: 'list', items: named(n).map(ex) }, n);
                case 'cast_expression': return ex(f(n, 'value'));
                case 'call_expression': {
                    const fn = f(n, 'function'); const a = f(n, 'arguments'); const args = a ? named(a) : [];
                    if (fn.type === 'identifier') return at({ k: 'call', fn: txt(fn), args: args.map(ex) }, n);
                    return nativeE(n, '呼叫的目標不在標準操作目錄');
                }
                case 'method_invocation': {
                    const obj = f(n, 'object'), name = txt(f(n, 'name')), a = f(n, 'arguments'); const args = a ? named(a) : [];
                    if (!obj) return at({ k: 'call', fn: name, args: args.map(ex) }, n);
                    if (name === 'equals' && args.length === 1) return at({ k: 'cmp', op: '==', l: ex(obj), r: ex(args[0]) }, n);
                    if (name === 'get' && args.length === 1) { const i = unwrap(args[0]); const idx = i.type === 'cast_expression' ? f(i, 'value') : i; return at({ k: 'index', o: ex(obj), i: ex(idx) }, n); }
                    return nativeE(n, '方法 ' + name + ' 不在標準操作目錄');
                }
                default: return nativeE(n);
            }
        }

        // ---- 敘述 ----
        const commentText = (c) => { let t = txt(c); if (t.startsWith('//')) return t.replace(/^\/\/\s?/, ''); t = t.replace(/^\/\*+\s?/, '').replace(/\s?\*+\/$/, ''); return t.split('\n').map((l) => l.replace(/^\s*\*\s?/, '')).join('\n').trim(); };
        const isDoc = (c) => c.type !== 'line_comment' && /^\/\*\*/.test(txt(c));
        function targetOf(x) { return ex(x); }
        function stmt(n) {
            cov.stmts++;
            switch (n.type) {
                case 'expression_statement': {
                    const x = unwrap(named(n)[0]); if (!x) return [];
                    if (x.type === 'assignment_expression') {
                        const left = f(x, 'left'), right = f(x, 'right'), op = txt(f(x, 'operator') || { text: '=' });
                        if (op !== '=') { const b = op.replace(/=$/, ''); if (IR.BINOPS.indexOf(b) < 0) return [nativeS(n, '複合賦值 ' + op)]; return [at({ k: 'aug', to: ex(left), op: b, val: ex(right) }, n)]; }
                        if (left.type !== 'identifier' && left.type !== 'subscript_expression' && left.type !== 'array_access') return [nativeS(n, '賦值目標 ' + left.type)];
                        return [at({ k: 'assign', to: ex(left), val: ex(right) }, n)];
                    }
                    if (x.type === 'augmented_assignment_expression') { const op = txt(f(x, 'operator')).replace(/=$/, ''); if (IR.BINOPS.indexOf(op) < 0) return [nativeS(n, '複合賦值 ' + op)]; return [at({ k: 'aug', to: ex(f(x, 'left')), op, val: ex(f(x, 'right')) }, n)]; }
                    if (x.type === 'update_expression') { const a = f(x, 'argument') || named(x)[0]; const op = txt(x).indexOf('++') >= 0 ? '+' : '-'; return [at({ k: 'aug', to: ex(a), op, val: L('int', '1') }, n)]; }
                    if (JAVA && x.type === 'method_invocation' && f(x, 'object') && txt(f(x, 'name')) === 'set') { const a = named(f(x, 'arguments')); if (a.length === 2) { const i = unwrap(a[0]); const idx = i.type === 'cast_expression' ? f(i, 'value') : i; return [at({ k: 'assign', to: { k: 'index', o: ex(f(x, 'object')), i: ex(idx) }, val: ex(a[1]) }, n)]; } }
                    const e = ex(x); if (e.k === 'native') return [nativeS(n)]; return [at({ k: 'expr', e }, n)];
                }
                case 'lexical_declaration': case 'variable_declaration': {
                    const ds = named(n).filter((c) => c.type === 'variable_declarator'); const out = [];
                    for (const d of ds) { const nm = f(d, 'name'), v = f(d, 'value'); if (nm.type !== 'identifier') return [nativeS(n, '解構宣告')]; if (!v) out.push(at({ k: 'declare', name: txt(nm), ty: T.unknown }, n)); else out.push(at({ k: 'assign', to: ex(nm), val: ex(v) }, n)); }
                    return out;
                }
                case 'local_variable_declaration': {
                    const ty = tyJava(txt(f(n, 'type'))); const ds = named(n).filter((c) => c.type === 'variable_declarator'); const out = [];
                    for (const d of ds) { const nm = f(d, 'name'), v = f(d, 'value'); if (!v) out.push(at({ k: 'declare', name: txt(nm), ty }, n)); else { const o = at({ k: 'assign', to: ex(nm), val: ex(v) }, n); if (ty.t !== 'unknown') o.ty = ty; out.push(o); } }
                    return out;
                }
                case 'if_statement': return [ifS(n)];
                case 'while_statement': { const w = at({ k: 'while', cond: ex(f(n, 'condition')), body: blk(f(n, 'body'), n) }, n); return [attach(w, n, w.body)]; }
                case 'for_statement': return forS(n);
                case 'for_in_statement': case 'enhanced_for_statement': {
                    const v = f(n, 'left') || f(n, 'name'), it = f(n, 'right') || f(n, 'value'); const kind = n.children.filter((c) => !c.isNamed()).map((c) => c.type);
                    if (!JAVA && kind.indexOf('of') < 0) return [nativeS(n, 'for-in')]; if (!v || (v.type !== 'identifier')) return [nativeS(n, '迴圈變數')];
                    const itx = ex(it); if (itx.k === 'native') return [nativeS(n, '走訪的對象')];
                    const o = at({ k: 'foreach', var: txt(v), iter: itx, body: blk(f(n, 'body'), n) }, n); return [attach(o, n, o.body)];
                }
                case 'return_statement': { const e = named(n)[0]; return [at({ k: 'ret', val: e ? ex(e) : undefined }, n)]; }
                case 'break_statement': return [at({ k: 'brk' }, n)]; case 'continue_statement': return [at({ k: 'cont' }, n)];
                case 'throw_statement': { const e = named(n)[0]; let msg; if (e && (e.type === 'new_expression' || e.type === 'object_creation_expression')) { const a = f(e, 'arguments'); const as = a ? named(a) : []; if (as[0]) msg = ex(as[0]); } return [at({ k: 'raise', val: msg }, n)]; }
                case 'function_declaration': case 'method_declaration': return [func(n)];
                case 'empty_statement': return [];
                case 'statement_block': case 'block': return block(n, undefined);
                default: return [nativeS(n)];
            }
        }
        function forS(n) {
            const init = f(n, 'initializer') || f(n, 'init'), cond = f(n, 'condition'), upd = f(n, 'increment') || f(n, 'update'), body = f(n, 'body');
            const fall = (why) => [nativeS(n, why)];
            if (!init || !cond || !upd) return fall('for 標頭不是標準形');
            let v, from; const i0 = init.type === 'expression_statement' ? named(init)[0] : init;
            if (i0.type === 'lexical_declaration' || i0.type === 'local_variable_declaration' || i0.type === 'variable_declaration') { const d = named(i0).filter((c) => c.type === 'variable_declarator'); if (d.length !== 1 || !f(d[0], 'value')) return fall('for 初始化'); v = txt(f(d[0], 'name')); from = ex(f(d[0], 'value')); }
            else if (i0.type === 'assignment_expression' && f(i0, 'left').type === 'identifier') { v = txt(f(i0, 'left')); from = ex(f(i0, 'right')); } else return fall('for 初始化');
            const c0 = unwrap(cond.type === 'expression_statement' ? named(cond)[0] : cond); if (c0.type !== 'binary_expression' || txt(f(c0, 'left')) !== v) return fall('for 條件'); const cop = txt(f(c0, 'operator')); if (cop !== '<' && cop !== '>') return fall('for 條件運算子 ' + cop);
            const to = ex(f(c0, 'right')); let step = null; const u0 = unwrap(upd);
            if (u0.type === 'update_expression') { const up = txt(u0).indexOf('++') >= 0; if (txt(f(u0, 'argument') || named(u0)[0]) !== v) return fall('for 增量'); if ((cop === '<') !== up) return fall('for 方向'); if (!up) step = { k: 'un', op: '-', e: L('int', '1') }; }
            else if (u0.type === 'augmented_assignment_expression' && txt(f(u0, 'left')) === v) { const op = txt(f(u0, 'operator')); const r = ex(f(u0, 'right')); const sg = op === '+=' ? 1 : op === '-=' ? -1 : 0; if (!sg || r.k !== 'lit' || r.t !== 'int') return fall('for 增量'); if ((cop === '<') !== (sg > 0)) return fall('for 方向'); step = sg > 0 ? (r.v === '1' ? null : r) : { k: 'un', op: '-', e: r }; }
            else return fall('for 增量');
            const o = at({ k: 'forrange', var: v, from, to, step, body: blk(body, n) }, n); if (!step) delete o.step; return [attach(o, n, o.body)];
        }
        function ifS(n) {
            const o = at({ k: 'if', cond: ex(f(n, 'condition')), then: blk(f(n, 'consequence'), n) }, n); attach(o, n, o.then);
            let alt = f(n, 'alternative'); if (alt && alt.type === 'else_clause') alt = named(alt)[0];
            if (alt) { if (alt.type === 'if_statement') o.else = [ifS(alt)]; else o.else = blk(alt, alt); }
            return o;
        }
        // 區塊：把註解依位置掛成 前置／行尾／獨立（和 ir_in_python_core.js 同一套規則）
        function block(bn, headerRow) {
            if (!bn) return []; const out = []; let pending = []; let prev = null, prevEnd = -1; const hdr = []; out.hdr = hdr; let docPending = null;
            for (const c of bn.children) {
                if (!c.isNamed()) continue;
                if (isCmt(c)) {
                    cov.comments++; const row = c.startPosition.row, t = commentText(c);
                    if (headerRow != null && row === headerRow && !prev) { hdr.push(t); cov.comments_kept++; continue; }
                    if (prev && row === prevEnd) { prev.c = prev.c || {}; prev.c.a = prev.c.a ? prev.c.a + ' ' + t : t; cov.comments_kept++; continue; }
                    if (isDoc(c)) { docPending = { t, row }; continue; }
                    pending.push({ t, row }); continue;
                }
                if (skipTop(c)) { docPending = null; continue; }
                const ss = stmt(c); if (!ss.length) { continue; }
                if (docPending && ss[0].k === 'func' && c.startPosition.row - docPending.row <= (docPending.t.split('\n').length)) { ss[0].doc = docPending.t; cov.comments_kept++; } else if (docPending) { pending.push(docPending); }
                docPending = null;
                const lastRowBefore = pending.length ? pending[pending.length - 1].row : prevEnd; const gap = prevEnd >= 0 || pending.length ? c.startPosition.row - lastRowBefore - 1 : 0; const first = ss[0];
                if (pending.length) { first.c = first.c || {}; first.c.b = pending.map((p) => p.t).concat(first.c.b || []); cov.comments_kept += pending.length; const g0 = pending[0].row - (prevEnd >= 0 ? prevEnd : pending[0].row) - 1; if (g0 > 0 && prevEnd >= 0) first.c.sp = 1; pending = []; }
                else if (gap > 0 && prevEnd >= 0) { first.c = first.c || {}; first.c.sp = 1; }
                ss.forEach((s) => out.push(s)); prev = ss[ss.length - 1]; prevEnd = c.endPosition.row;
            }
            if (pending.length) pending.forEach((p) => { out.push({ k: 'comment', s: p.t }); cov.comments_kept++; });
            return out;
        }
        const blk = (bn, parent) => (bn && (bn.type === 'statement_block' || bn.type === 'block') ? block(bn, parent.startPosition.row) : bn ? (() => { const ss = stmt(bn); return ss; })() : []);
        function attach(o, n, arr) { const h = (arr && arr.hdr) || []; if (h.length) { o.c = o.c || {}; o.c.a = h.join(' '); } return o; }
        function skipTop(c) { // 輸出器加的前置輔助
            if (c.type === 'import_declaration' || c.type === 'package_declaration') return true;
            if (c.type === 'expression_statement') { const x = named(c)[0]; if (x && x.type === 'string' && /use strict/.test(txt(x))) return true; }
            if (c.type === 'lexical_declaration' || c.type === 'variable_declaration') { const d = named(c).filter((k) => k.type === 'variable_declarator')[0]; if (d && isHelperName(txt(f(d, 'name')))) return true; }
            if (c.type === 'field_declaration') { const d = named(c).filter((k) => k.type === 'variable_declarator')[0]; if (d && isHelperName(txt(f(d, 'name')))) return true; }
            if (c.type === 'function_declaration' || c.type === 'method_declaration') { const nm = txt(f(c, 'name')); if (isHelperName(nm)) return true; if (JAVA && nm === 'main') { const ps = f(c, 'parameters'); if (ps && named(ps).length) return true; } }
            return false;
        }
        function func(n) {
            const name = txt(f(n, 'name')), ps = f(n, 'parameters'), body = f(n, 'body');
            const params = ps ? named(ps).map((p) => { if (p.type === 'identifier') return { name: txt(p) }; if (p.type === 'formal_parameter') return { name: txt(f(p, 'name')), ty: tyJava(txt(f(p, 'type'))) }; diag('不支援的參數形式 ' + p.type, p); return { name: txt(p) }; }) : [];
            const o = at({ k: 'func', name, params, body: [] }, n); if (JAVA) { const rt = f(n, 'type'); if (rt) o.ret = tyJava(txt(rt)); }
            o.body = block(body, n.startPosition.row); attach(o, n, o.body); return o;
        }
        // ---- 模組層 ----
        const ir = IR.mod({ src: { lang: JAVA ? 'java' : 'nodejs', file: opts.file }, name: opts.name || 'Module' });
        let topNode = rootNode; let mainCall = false;
        if (JAVA) { const cls = rootNode.namedChildren.find((c) => c.type === 'class_declaration'); if (cls) topNode = f(cls, 'body'); }
        const top = block(topNode, undefined); const body = [];
        for (const s of top) {
            if (s.k === 'expr' && s.e && s.e.k === 'call' && s.e.fn === 'main' && !(s.e.args || []).length) { mainCall = true; continue; }
            body.push(s);
        }
        ir.body = body.filter((s) => !(s.k === 'pass' && !s.c));
        if (IR.funcs(ir).some((x) => x.name === 'main')) ir.entry = 'main'; void mainCall;
        return { ir, coverage: cov, diags };
    }
    return { buildPatterns, fromTree, tyJava, match };
});
