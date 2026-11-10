/* 靜態型別大括號語言「進」：C++ 與 C# 的 tree-sitter 語法樹 → 核心 IR。純函式 UMD。設計見 DESIGN.core-ir.md 第 14 節。
 * 做法同 ir_in_brace_core.js（nodejs／java／c）：目錄（ir_ops_core.js）裡該語言的每個輸出樣板剖成樣式，`$N`／`@N` 換成佔位識別字，
 * 「進」時用結構比對認出標準操作（所以進與出共用同一份目錄）。敘述層為 C++（function_definition／declaration／for_range_loop）與
 * C#（method_declaration／local_declaration_statement／for_each_statement）各一套轉接。
 *   buildPatterns(lang, parse) → 樣式表；fromTree(root, {lang:'cpp'|'cs', source, patterns}) → { ir, coverage, diags }
 * 不認得的敘述／運算式收成 native（原文＋語言），不丟；輸出器自己加的前置（#include、fa_* 輔助函式、template 輔助、main 包裝）略過。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./ir_core.js'), require('./ir_ops_core.js'), require('./ir_in_brace_core.js')); else root.FaIrInTyped = factory(root.FaIr, root.FaIrOps, root.FaIrInBrace); })(typeof self !== 'undefined' ? self : this, function (IR, OPS, BRACE) {
    'use strict';
    const T = IR.T; const PH = /^__a(\d)$/;
    function unwrap(n) { while (n && (n.type === 'parenthesized_expression' || n.type === 'condition' || n.type === 'condition_clause')) { const k = n.namedChildren.filter((c) => !/comment/.test(c.type)); if (k.length !== 1) break; n = k[0]; } return n; }
    const kids = (n) => n.children.filter((c) => !/comment/.test(c.type));
    const size = (n) => 1 + kids(n).reduce((s, c) => s + size(c), 0);
    const isPurePlaceholderBin = (p) => { const x = unwrap(p); return x && x.type === 'binary_expression' && x.namedChildren.every((c) => PH.test(unwrap(c).text)); };
    function wrapTpl(lang, tpl) { return lang === 'cpp' ? 'void __f() { auto __o = ' + tpl + '; }' : 'class X { void f() { var o = ' + tpl + '; } }'; }
    function patRoot(lang, root) {
        if (root.hasError()) return null;
        const find = (n) => { if (lang === 'cpp' && n.type === 'init_declarator') return n.childForFieldName('value'); if (lang === 'cs' && n.type === 'variable_declarator') { const e = n.namedChildren.find((c) => c.type === 'equals_value_clause'); return e ? e.namedChildren[0] : null; } for (const c of n.namedChildren) { const r = find(c); if (r) return r; } return null; };
        return find(root);
    }
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
    const match = BRACE.match;
    // ---------- 型別 ----------
    function splitTop(t) { const r = []; let d = 0, cur = ''; for (const ch of t) { if (ch === '<') d++; if (ch === '>') d--; if (ch === ',' && d === 0) { r.push(cur); cur = ''; } else cur += ch; } r.push(cur); return r; }
    function tyOf(lang, s) {
        s = String(s || '').replace(/\b(const|static|signed|unsigned|struct)\b/g, '').replace(/[&*]/g, '').replace(/\s+/g, ''); if (!s) return T.unknown;
        const m = /^([A-Za-z_][A-Za-z_0-9:.]*)(?:<(.*)>)?$/.exec(s); if (!m) return T.unknown; const n = m[1].replace(/^std::/, ''), inner = m[2];
        if (/^(longlong|long|int|short|size_t|Int64|Int32)$/.test(n)) return T.int; if (n === 'double' || n === 'float') return T.float; if (n === 'string' || n === 'String') return T.str; if (n === 'bool') return T.bool; if (n === 'void') return T.void;
        if (inner != null) { const a = splitTop(inner).map((x) => tyOf(lang, x)); if (n === 'vector' || n === 'List') return IR.list(a[0]); if (n === 'map' || n === 'Dictionary') return IR.dict(a[0], a[1]); if (n === 'set' || n === 'HashSet') return IR.set(a[0]); }
        return T.unknown;
    }
    function unescape(s) { const M = { n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\', "'": "'", '"': '"', b: '\b', f: '\f', v: '\v' }; return s.replace(/\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(.))/g, (m, u, x, c) => (u ? String.fromCharCode(parseInt(u, 16)) : x ? String.fromCharCode(parseInt(x, 16)) : M[c] != null ? M[c] : c)); }

    function fromTree(rootNode, opts) {
        opts = opts || {}; const lang = opts.lang === 'cs' ? 'cs' : 'cpp'; const CS = lang === 'cs'; const src = String(opts.source || ''); const patterns = opts.patterns || [];
        const cov = { stmts: 0, natives: 0, comments: 0, comments_kept: 0 }; const diags = [];
        const txt = (n) => (n.text != null ? n.text : src.slice(n.startIndex, n.endIndex));
        const f = (n, name) => n.childForFieldName(name);
        const isCmt = (c) => c.type === 'comment';
        const named = (n) => n.namedChildren.filter((c) => !isCmt(c));
        const pos = (n) => [n.startPosition.row + 1, n.startPosition.column, n.endPosition.row + 1, n.endPosition.column];
        const at = (o, n) => { o.pos = pos(n); return o; };
        const diag = (m, n) => diags.push({ level: 'warn', msg: m, pos: n ? pos(n) : undefined });
        const nativeE = (n, why) => { cov.natives++; diag('運算式收成原生區塊：' + (why || n.type), n); return at({ k: 'native', lang, src: txt(n), why: why || n.type }, n); };
        const nativeS = (n, why) => { cov.natives++; diag('敘述收成原生區塊：' + (why || n.type), n); return at({ k: 'native', lang, src: txt(n), why: why || n.type }, n); };
        const L = (t, v) => ({ k: 'lit', t, v });
        const isHelperName = (s) => /^(fa_|__fa|__br|__kv|__to)/.test(s);
        const fixName = (s) => (s === 'main_' ? 'main' : s.replace(/_$/, (m) => m)); // C++／C# 輸出器把使用者的 main 改叫 main_；其餘被關鍵字撞名的名稱也加 _，這裡只還原 main
        const CMP = { '==': '==', '!=': '!=', '<': '<', '>': '>', '<=': '<=', '>=': '>=' };
        const lastTy = (n) => { const tn = f(n, 'type'); return tn ? tyOf(lang, txt(tn)) : T.unknown; };

        function tryOps(n) {
            for (const p of patterns) { const b = []; if (match(p.pat, n, b)) { let ok = true; const args = []; for (let i = 0; i < p.nargs; i++) { if (!b[i]) { ok = false; break; } args.push(b[i]); } if (!ok) continue; const cargs = args.map(ex); let op = p.op;
                if (op === 'str.join' && CS && !(cargs[1] && cargs[1].k === 'call' && /^str\.split/.test(cargs[1].op || ''))) op = 'str.join_num';
                return at({ k: 'call', op, args: cargs }, n); } }
            return null;
        }
        const LEAF = new Set(['identifier', 'number_literal', 'integer_literal', 'real_literal', 'string_literal', 'boolean_literal', 'true', 'false', 'null_literal', 'nullptr', 'character_literal', 'raw_string_literal']);
        const strVal = (n) => { const t = txt(n); return unescape(t.replace(/^[uUL]?R?"/, '').replace(/"$/, '')); };
        function initItems(n) { return named(n).filter((c) => c.type !== 'initializer_list' || true); }
        function ex(n) {
            if (!n) return null; n = unwrap(n);
            if (!LEAF.has(n.type) && patterns.length) { const r = tryOps(n); if (r) return r; }
            switch (n.type) {
                case 'identifier': return at({ k: 'name', v: fixName(txt(n)) }, n);
                case 'number_literal': case 'integer_literal': case 'real_literal': { const t = txt(n).replace(/_/g, '').replace(/(ll|LL|[lLuUfFdDmM])+$/, ''); return at(L(/[.eE]/.test(t) && !/^0x/i.test(t) ? 'float' : 'int', t), n); }
                case 'true': return at(L('bool', 'true'), n); case 'false': return at(L('bool', 'false'), n);
                case 'boolean_literal': return at(L('bool', txt(n)), n);
                case 'null': case 'null_literal': case 'nullptr': return at(L('none', 'None'), n);
                case 'string_literal': return at(L('str', strVal(n)), n);
                case 'binary_expression': {
                    const op = txt(f(n, 'operator')); const l = f(n, 'left'), r = f(n, 'right');
                    if (CS && CMP[op] && l.type === 'invocation_expression' && /^string\.CompareOrdinal\(/.test(txt(l)) && txt(r) === '0') { const a = named(f(l, 'arguments')).map((x) => x.namedChildren[0]); if (a.length === 2) return at({ k: 'cmp', op, l: ex(a[0]), r: ex(a[1]) }, n); }
                    if (CMP[op]) return at({ k: 'cmp', op: CMP[op], l: ex(l), r: ex(r) }, n);
                    if (op === '&&' || op === '||') return at({ k: 'logic', op: op === '&&' ? 'and' : 'or', l: ex(l), r: ex(r) }, n);
                    if (IR.BINOPS.indexOf(op) < 0) return nativeE(n, '運算子 ' + op);
                    return at({ k: 'bin', op, l: ex(l), r: ex(r) }, n);
                }
                case 'unary_expression': case 'prefix_unary_expression': { const op = txt(n.children[0]); const a = f(n, 'argument') || f(n, 'operand') || named(n)[0]; if (op === '!') return at({ k: 'not', e: ex(a) }, n); if (['-', '+', '~'].indexOf(op) >= 0) return at({ k: 'un', op, e: ex(a) }, n); return nativeE(n); }
                case 'conditional_expression': return at({ k: 'cond', a: ex(f(n, 'condition')), c: ex(f(n, 'consequence')), b: ex(f(n, 'alternative')) }, n);
                case 'subscript_expression': { const idx = named(n).find((c) => c.type === 'subscript_argument_list'); return at({ k: 'index', o: ex(f(n, 'argument')), i: ex(idx ? named(idx)[0] : null) }, n); }
                case 'element_access_expression': { const sub = f(n, 'subscript'); const a = sub ? named(sub)[0] : null; return at({ k: 'index', o: ex(f(n, 'expression')), i: ex(a && a.type === 'argument' ? a.namedChildren[0] : a) }, n); }
                case 'cast_expression': return ex(f(n, 'value'));
                case 'call_expression': case 'invocation_expression': {
                    const fn = f(n, 'function'); const a = f(n, 'arguments'); const args = a ? named(a).map((x) => (x.type === 'argument' ? x.namedChildren[0] : x)) : [];
                    if (fn.type === 'identifier') return at({ k: 'call', fn: fixName(txt(fn)), args: args.map(ex) }, n);
                    const ft = txt(fn).replace(/\s+/g, '');
                    if (!CS) {
                        if (ft === 'std::string' && args.length <= 1) return args.length ? ex(args[0]) : at(L('str', ''), n);
                        const m = /^std::(vector|map|set)</.exec(ft); if (m && !args.length) return at(m[1] === 'vector' ? { k: 'list', items: [], ty: tyOf(lang, ft) } : m[1] === 'map' ? { k: 'dict', items: [], ty: tyOf(lang, ft) } : { k: 'native', lang, src: txt(n), why: 'set 字面值' }, n);
                    }
                    return nativeE(n, '呼叫的目標不在標準操作目錄');
                }
                case 'compound_literal_expression': { // C++：std::vector<long long>{1LL, 2LL}／std::map<K, V>{{k, v}}
                    const ty = tyOf(lang, txt(f(n, 'type'))); const body = f(n, 'value'); const items = body ? named(body) : [];
                    if (ty.t === 'list') return at({ k: 'list', items: items.map(ex), ty }, n);
                    if (ty.t === 'dict') return at({ k: 'dict', items: items.map((p) => named(p).map(ex)), ty }, n);
                    return nativeE(n, '初始化列表型別'); }
                case 'object_creation_expression': { // C#：new List<long>() ／ new List<long> { 1L, 2L } ／ new Dictionary<K,V> { {k, v} }
                    const ty = tyOf(lang, txt(f(n, 'type'))); const ini = named(n).find((c) => c.type === 'initializer_expression'); const items = ini ? named(ini) : [];
                    if (ty.t === 'list') return at({ k: 'list', items: items.map(ex), ty }, n);
                    if (ty.t === 'dict') return at({ k: 'dict', items: items.map((p) => named(p).map(ex)), ty }, n);
                    return nativeE(n, 'new ' + txt(f(n, 'type'))); }
                default: return nativeE(n);
            }
        }

        // ---- 敘述 ----
        const commentText = (c) => { let t = txt(c); if (t.startsWith('//')) return t.replace(/^\/\/\s?/, ''); t = t.replace(/^\/\*+\s?/, '').replace(/\s?\*+\/$/, ''); return t.split('\n').map((l) => l.replace(/^\s*\*\s?/, '')).join('\n').trim(); };
        const isDoc = (c) => /^\/\*\*/.test(txt(c));
        function targetOf(x) { const e = ex(x); return e.k === 'call' && (e.op === 'list.get' || e.op === 'dict.get') && e.args.length === 2 ? { k: 'index', o: e.args[0], i: e.args[1], pos: e.pos } : e; }
        // 宣告：回傳 [{name, ty, value}]；C++ 的 declaration、C# 的 variable_declaration
        function declarators(dn) {
            if (CS) { const ty = tyOf(lang, txt(f(dn, 'type'))); return named(dn).filter((c) => c.type === 'variable_declarator').map((d) => { const eq = d.namedChildren.find((c) => c.type === 'equals_value_clause'); return { name: txt(d.namedChildren[0]), ty, value: eq ? eq.namedChildren[0] : null, node: d }; }); }
            const ty = tyOf(lang, txt(f(dn, 'type'))); const out = [];
            for (const d of named(dn).filter((c) => c.type === 'init_declarator' || c.type === 'identifier' || c.type === 'reference_declarator')) { let nm = d, v = null; if (d.type === 'init_declarator') { nm = f(d, 'declarator'); v = f(d, 'value'); } if (!nm || nm.type !== 'identifier') return null; out.push({ name: txt(nm), ty, value: v, node: d }); }
            return out;
        }
        function declStmts(n, dn) {
            const ds = declarators(dn); if (!ds) return [nativeS(n, '宣告的形式')]; const out = [];
            for (const d of ds) { if (!d.value) out.push(at({ k: 'declare', name: d.name, ty: d.ty }, n)); else { const o = at({ k: 'assign', to: { k: 'name', v: fixName(d.name) }, val: ex(d.value) }, n); if (d.ty.t !== 'unknown') o.ty = d.ty; out.push(o); } }
            return out;
        }
        function assignOf(x, n) {
            const left = f(x, 'left'), right = f(x, 'right'); const opn = x.children.find((c) => !c.isNamed() || c.type === 'assignment_operator'); const op = txt(CS ? x.namedChildren.find((c) => c.type === 'assignment_operator') : f(x, 'operator'));
            void opn; if (op !== '=') { const b = op.replace(/=$/, ''); if (IR.BINOPS.indexOf(b) < 0) return [nativeS(n, '複合賦值 ' + op)]; return [at({ k: 'aug', to: targetOf(left), op: b, val: ex(right) }, n)]; }
            if (left.type !== 'identifier' && left.type !== 'subscript_expression' && left.type !== 'element_access_expression') return [nativeS(n, '賦值目標 ' + left.type)];
            return [at({ k: 'assign', to: targetOf(left), val: ex(right) }, n)];
        }
        function stmt(n) {
            cov.stmts++;
            switch (n.type) {
                case 'expression_statement': {
                    const x = unwrap(named(n)[0]); if (!x) return [];
                    if (x.type === 'assignment_expression') return assignOf(x, n);
                    if (x.type === 'update_expression' || x.type === 'postfix_unary_expression' || x.type === 'prefix_unary_expression') { const a = f(x, 'argument') || named(x)[0]; const up = txt(x).indexOf('++') >= 0; if (!up && txt(x).indexOf('--') < 0) return [nativeS(n)]; return [at({ k: 'aug', to: ex(a), op: up ? '+' : '-', val: L('int', '1') }, n)]; }
                    const e = ex(x); if (e.k === 'native') return [nativeS(n)]; return [at({ k: 'expr', e }, n)];
                }
                case 'declaration': return declStmts(n, n);
                case 'local_declaration_statement': { const vd = named(n).find((c) => c.type === 'variable_declaration'); return vd ? declStmts(n, vd) : [nativeS(n)]; }
                case 'field_declaration': { const vd = named(n).find((c) => c.type === 'variable_declaration'); return vd ? declStmts(n, vd) : [nativeS(n)]; }
                case 'function_definition': case 'method_declaration': return [func(n)];
                case 'compound_statement': case 'block': return block(n, undefined);
                case 'if_statement': return [ifS(n)];
                case 'while_statement': { const nn = named(n); const w = at({ k: 'while', cond: ex(f(n, 'condition') || nn[0]), body: blk(f(n, 'body') || nn[nn.length - 1], n) }, n); return [attach(w, n, w.body)]; }
                case 'for_statement': return forS(n);
                case 'for_range_loop': case 'for_each_statement': {
                    const v = CS ? f(n, 'left') : f(n, 'declarator'), it = f(n, 'right'); if (!v || v.type !== 'identifier') return [nativeS(n, '迴圈變數')];
                    const body = f(n, 'body'); const vn = txt(v);
                    if (!CS && /^__kv_/.test(vn)) { // 字典走訪：for (const auto &__kv_k : d) { const K k = __kv_k.first; … }
                        const bd = blk(body, n); const first = bd[0]; const m = /^__kv_(\w+)$/.exec(vn); if (first && first.k === 'assign' && first.to && first.to.v === m[1]) bd.shift(); const o = at({ k: 'foreach', var: m[1], iter: ex(it), body: bd }, n); return [attach(o, n, bd)];
                    }
                    const itx = ex(it); if (itx.k === 'native') return [nativeS(n, '走訪的對象')];
                    // C# 走訪字典：foreach (K k in d.Keys.ToList()) → 走訪字典
                    let iter = itx; const tt = txt(it).replace(/\s+/g, ''); if (CS) { const m = /^(.*)\.Keys\.ToList\(\)$/.exec(tt); if (m) iter = { k: 'name', v: m[1] }; }
                    const o = at({ k: 'foreach', var: vn, iter, body: blk(body, n) }, n); return [attach(o, n, o.body)];
                }
                case 'return_statement': { const e = named(n)[0]; return [at({ k: 'ret', val: e ? ex(e) : undefined }, n)]; }
                case 'break_statement': return [at({ k: 'brk' }, n)]; case 'continue_statement': return [at({ k: 'cont' }, n)];
                case 'throw_statement': { const e = named(n)[0]; let msg; if (e) { const a = f(e, 'arguments'); const as = a ? named(a).map((x) => (x.type === 'argument' ? x.namedChildren[0] : x)) : []; if (as[0]) msg = ex(as[0]); } return [at({ k: 'raise', val: msg }, n)]; }
                case 'empty_statement': return [];
                default: return [nativeS(n)];
            }
        }
        function forS(n) {
            const init = f(n, 'initializer'), cond = f(n, 'condition'), upd = f(n, 'update') || f(n, 'increment'), body = f(n, 'body');
            const fall = (why) => [nativeS(n, why)];
            if (!init || !cond || !upd) return fall('for 標頭不是標準形');
            let v, from; const i0 = init;
            if (i0.type === 'declaration' || i0.type === 'variable_declaration') { const ds = declarators(i0); if (!ds || ds.length !== 1 || !ds[0].value) return fall('for 初始化'); v = ds[0].name; from = ex(ds[0].value); }
            else return fall('for 初始化');
            const c0 = unwrap(cond); if (c0.type !== 'binary_expression' || txt(f(c0, 'left')) !== v) return fall('for 條件'); const cop = txt(f(c0, 'operator')); if (cop !== '<' && cop !== '>') return fall('for 條件運算子 ' + cop);
            const to = ex(f(c0, 'right')); let step = null; const u0 = unwrap(upd);
            if (u0.type === 'update_expression' || u0.type === 'postfix_unary_expression') { const up = txt(u0).indexOf('++') >= 0; if (txt(f(u0, 'argument') || named(u0)[0]) !== v) return fall('for 增量'); if ((cop === '<') !== up) return fall('for 方向'); if (!up) step = { k: 'un', op: '-', e: L('int', '1') }; }
            else if (u0.type === 'assignment_expression' && txt(f(u0, 'left')) === v) { const op = txt(CS ? u0.namedChildren.find((c) => c.type === 'assignment_operator') : f(u0, 'operator')); const r = ex(f(u0, 'right')); const sg = op === '+=' ? 1 : op === '-=' ? -1 : 0; if (!sg || r.k !== 'lit' || r.t !== 'int') return fall('for 增量'); if ((cop === '<') !== (sg > 0)) return fall('for 方向'); step = sg > 0 ? (r.v === '1' ? null : r) : { k: 'un', op: '-', e: r }; }
            else return fall('for 增量');
            const o = at({ k: 'forrange', var: v, from, to, step, body: blk(body, n) }, n); if (!step) delete o.step; return [attach(o, n, o.body)];
        }
        function ifS(n) {
            const o = at({ k: 'if', cond: ex(f(n, 'condition')), then: blk(f(n, 'consequence'), n) }, n); attach(o, n, o.then);
            let alt = f(n, 'alternative'); if (alt && alt.type === 'else_clause') alt = named(alt)[0];
            if (alt) { if (alt.type === 'if_statement') o.else = [ifS(alt)]; else o.else = blk(alt, alt); }
            return o;
        }
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
                if (docPending && ss[0].k === 'func' && c.startPosition.row - docPending.row <= (docPending.t.split('\n').length + 1)) { ss[0].doc = docPending.t; cov.comments_kept++; } else if (docPending) { pending.push(docPending); }
                docPending = null;
                const lastRowBefore = pending.length ? pending[pending.length - 1].row : prevEnd; const gap = prevEnd >= 0 || pending.length ? c.startPosition.row - lastRowBefore - 1 : 0; const first = ss[0];
                if (pending.length) { first.c = first.c || {}; first.c.b = pending.map((p) => p.t).concat(first.c.b || []); cov.comments_kept += pending.length; const g0 = pending[0].row - (prevEnd >= 0 ? prevEnd : pending[0].row) - 1; if (g0 > 0 && prevEnd >= 0) first.c.sp = 1; pending = []; }
                else if (gap > 0 && prevEnd >= 0) { first.c = first.c || {}; first.c.sp = 1; }
                ss.forEach((s) => out.push(s)); prev = ss[ss.length - 1]; prevEnd = c.endPosition.row;
            }
            if (pending.length) pending.forEach((p) => { out.push({ k: 'comment', s: p.t }); cov.comments_kept++; });
            return out;
        }
        const blk = (bn, parent) => (bn && (bn.type === 'compound_statement' || bn.type === 'block') ? block(bn, parent.startPosition.row) : bn ? stmt(bn) : []);
        function attach(o, n, arr) { const h = (arr && arr.hdr) || []; if (h.length) { o.c = o.c || {}; o.c.a = h.join(' '); } return o; }
        function cppFuncInfo(n) { let d = f(n, 'declarator'); while (d && (d.type === 'pointer_declarator' || d.type === 'reference_declarator')) d = d.namedChildren[0]; if (!d || d.type !== 'function_declarator') return null; return { name: txt(f(d, 'declarator')), params: f(d, 'parameters') }; }
        function skipTop(c) { // 輸出器加的前置輔助
            if (c.type === 'preproc_include' || c.type === 'using_directive' || c.type === 'using_declaration' || c.type === 'template_declaration' || c.type === 'namespace_definition') return true;
            if (!CS && c.type === 'function_definition') { const fi = cppFuncInfo(c); if (fi && (isHelperName(fi.name) || fi.name === 'main')) return true; }
            if (!CS && c.type === 'declaration') { const ds = declarators(c); if (ds && ds.some((d) => isHelperName(d.name))) return true; }
            if (CS && c.type === 'method_declaration') { const nm = txt(f(c, 'name')); if (isHelperName(nm)) return true; if (nm === (opts.entryName || 'Main') || nm === 'Main' || nm === 'Run') { const b = f(c, 'body'); if (b && named(b).length <= 1 && !named(b).some((x) => isCmt(x))) return true; } }
            return false;
        }
        function func(n) {
            let name, ps, params, ret;
            if (CS) { name = txt(f(n, 'name')); ps = f(n, 'parameters'); params = ps ? named(ps).filter((p) => p.type === 'parameter').map((p) => ({ name: txt(f(p, 'name')), ty: tyOf(lang, txt(f(p, 'type'))) })) : []; ret = tyOf(lang, txt(f(n, 'type'))); }
            else { const fi = cppFuncInfo(n); if (!fi) return nativeS(n, '函式宣告的形式'); name = fi.name; params = named(fi.params).filter((p) => p.type === 'parameter_declaration').map((p) => { let dd = f(p, 'declarator'); while (dd && dd.type !== 'identifier' && dd.namedChildren.length) dd = dd.namedChildren[0]; return dd ? { name: txt(dd), ty: tyOf(lang, txt(f(p, 'type'))) } : null; }).filter(Boolean); ret = tyOf(lang, txt(f(n, 'type'))); }
            const o = at({ k: 'func', name: fixName(name), params: params.map((p) => ({ name: fixName(p.name), ty: p.ty })), ret, body: [] }, n);
            o.body = block(f(n, 'body'), n.startPosition.row); attach(o, n, o.body); return o;
        }
        // ---- 模組層 ----
        const ir = IR.mod({ src: { lang, file: opts.file }, name: opts.name || 'Module' });
        let topNode = rootNode;
        if (CS) { const cls = rootNode.namedChildren.find((c) => c.type === 'class_declaration'); if (cls) topNode = f(cls, 'body'); }
        const top = block(topNode, undefined);
        ir.body = top.filter((s) => !(s.k === 'pass' && !s.c));
        if (IR.funcs(ir).some((x) => x.name === 'main')) ir.entry = 'main'; void initItems;
        return { ir, coverage: cov, diags };
    }
    return { buildPatterns, fromTree, tyOf };
});
