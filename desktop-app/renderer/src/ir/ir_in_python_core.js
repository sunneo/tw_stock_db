/* Python「進」：tree-sitter 語法樹 → 核心 IR。純函式 UMD，Python 專屬（每個語言各自一份「進」）。
 * 輸入節點是 tree-sitter（web-tree-sitter 或 node-tree-sitter）的節點。
 *   fromTree(rootNode, {source, name, file}) → { ir, coverage:{stmts, natives, comments, comments_kept}, diags }
 * 保留：註解（前置／行尾／獨立成行／函式標頭行尾）、docstring、空行（sp）、來源位置（pos）。
 * 認得的慣用寫法會變成標準操作（見 ir_ops_core.js 的 PY 表）；不認得的整句收成 native（原文＋語言），不丟。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./ir_core.js'), require('./ir_ops_core.js')); else root.FaIrInPython = factory(root.FaIr, root.FaIrOps); })(typeof self !== 'undefined' ? self : this, function (IR, OPS) {
    'use strict';
    const T = IR.T;
    function tyOfText(s) {
        s = String(s || '').replace(/\s+/g, ''); if (!s) return T.unknown; let i = 0;
        const one = () => {
            const m = /^[A-Za-z_][A-Za-z_0-9.]*/.exec(s.slice(i)); if (!m) return T.unknown; i += m[0].length; const n = m[0].replace(/^typing\./, '').toLowerCase(); let a = null;
            if (s[i] === '[') { i++; a = [one()]; while (s[i] === ',') { i++; a.push(one()); } if (s[i] === ']') i++; }
            if (n === 'int') return T.int; if (n === 'float') return T.float; if (n === 'str') return T.str; if (n === 'bool') return T.bool; if (n === 'none') return T.void; if (n === 'any') return T.any;
            if (n === 'list' || n === 'sequence') return IR.list(a && a[0]); if (n === 'dict') return IR.dict(a && a[0], a && a[1]); if (n === 'set') return IR.set(a && a[0]);
            return T.unknown;
        };
        return one();
    }
    function unescape(s) { return s.replace(/\\(n|t|r|0|\\|'|"|a|b|f|v)/g, (m, c) => ({ n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', v: '\v' }[c])); }

    function fromTree(rootNode, opts) {
        opts = opts || {}; const src = String(opts.source || ''); const cov = { stmts: 0, natives: 0, comments: 0, comments_kept: 0 }; const diags = [];
        const txt = (n) => (n.text != null ? n.text : src.slice(n.startIndex, n.endIndex));
        const f = (n, name) => n.childForFieldName(name);
        const named = (n) => (n.namedChildren || n.children.filter((c) => c.isNamed()));
        const pos = (n) => [n.startPosition.row + 1, n.startPosition.column, n.endPosition.row + 1, n.endPosition.column];
        const at = (o, n) => { o.pos = pos(n); return o; };
        const diag = (m, n) => diags.push({ level: 'warn', msg: m, pos: n ? pos(n) : undefined });
        const dedent = (t, col) => t.split('\n').map((l, i) => (i === 0 ? l : l.slice(Math.min(col, l.length - l.trimStart().length)))).join('\n');
        const nativeE = (n, why) => { cov.natives++; diag('運算式收成原生區塊：' + (why || n.type), n); return at({ k: 'native', lang: 'python', src: txt(n), why: why || n.type }, n); };
        const nativeS = (n, why) => { cov.natives++; diag('敘述收成原生區塊：' + (why || n.type), n); return at({ k: 'native', lang: 'python', src: dedent(txt(n), n.startPosition.column), why: why || n.type }, n); };
        const L = (t, v) => ({ k: 'lit', t, v });
        const call = (op, args, n) => { const c = { k: 'call', op, args }; if (n) c.pos = pos(n); return c; };

        function str(n) {
            const parts = []; let hasInterp = false;
            for (const c of n.children) {
                if (c.type === 'string_content') parts.push({ s: txt(c) });
                else if (c.type === 'interpolation') { hasInterp = true; parts.push({ e: c }); }
                else if (c.type === 'escape_sequence') parts.push({ s: txt(c) });
            }
            const start = n.children.find((c) => c.type === 'string_start'); const pre = start ? txt(start).replace(/["']+$/, '').toLowerCase() : '';
            if (!hasInterp) { let v = parts.map((p) => p.s).join(''); if (pre.indexOf('r') < 0) v = unescape(v); return at(L('str', v), n); }
            // f-string：{x}→str(x)，{x:.2f}→fixed(x,2)；其餘格式說明收成原生
            let acc = null; const push = (e) => { acc = acc ? call('str.concat', [acc, e], n) : e; };
            for (const p of parts) {
                if (p.s != null) { push(L('str', unescape(p.s.replace(/\{\{/g, '{').replace(/\}\}/g, '}')))); continue; }
                const ie = f(p.e, 'expression') || named(p.e)[0], spec = f(p.e, 'format_specifier') || named(p.e).find((x) => x.type === 'format_specifier'); const v = ex(ie);
                if (!spec) { push(call('conv.str', [v], p.e)); continue; }
                const m = /^\.(\d+)f$/.exec(txt(spec).replace(/^:/, '')); if (m) { push(call('fmt.fixed', [v, L('int', m[1])], p.e)); continue; }
                return nativeE(n, 'f-string 格式說明 ' + txt(spec));
            }
            return acc || L('str', '');
        }

        function argsOf(n) { const a = f(n, 'arguments'); return a ? named(a).filter((c) => c.type !== 'comment') : []; }
        function call_(n) {
            const fn = f(n, 'function'); const args = argsOf(n); const kw = args.filter((a) => a.type === 'keyword_argument' || a.type === 'list_splat' || a.type === 'dictionary_splat');
            const pa = args.filter((a) => kw.indexOf(a) < 0);
            if (kw.length) return nativeE(n, '關鍵字引數');
            if (fn.type === 'identifier') {
                const name = txt(fn);
                if (name === 'print') {
                    if (!pa.length) return call('io.print_line', [L('str', '')], n);
                    let parts = pa.map((a) => { const e = ex(a); return call('conv.str', [e], a); });
                    parts = parts.reduce((acc, p, i) => (i === 0 ? p : call('str.concat', [call('str.concat', [acc, L('str', ' ')], n), p], n)), null);
                    return call('io.print_line', [pa.length === 1 ? ex(pa[0]) : parts], n);
                }
                if (name === 'list' && pa.length === 1) {
                    const m = pa[0];
                    if (m.type === 'call' && txt(f(m, 'function')) === 'map') { const ma = argsOf(m); if (ma.length === 2 && txt(ma[0]) === 'int') { const sp = ma[1]; if (sp.type === 'call' && f(sp, 'function').type === 'attribute' && txt(f(f(sp, 'function'), 'attribute')) === 'split' && !argsOf(sp).length) return call('str.split_ints', [ex(f(f(sp, 'function'), 'object'))], n); } return nativeE(n, 'list(map(...)) 非 int(split) 慣用語'); }
                    return call('list.copy', [ex(pa[0])], n);
                }
                if (name === 'range') return nativeE(n, 'range 只支援在 for 的標頭');
                if ((name === 'min' || name === 'max') && pa.length >= 2) { return pa.map(ex).reduce((acc, e) => call(OPS.PY.func2[name], [acc, e], n)); }
                if (OPS.PY.func1[name] && pa.length === 1) return call(OPS.PY.func1[name], [ex(pa[0])], n);
                if (OPS.PY.func2[name] && pa.length === 2 && name === 'pow') return call(OPS.PY.func2[name], pa.map(ex), n);
                if (OPS.PY.func[name]) { if (name === 'input') return call('io.read_line', [], n); if (pa.length === 1) return call(OPS.PY.func[name], [ex(pa[0])], n); }
                return at({ k: 'call', fn: name, args: pa.map(ex) }, n);
            }
            if (fn.type === 'attribute') {
                const obj = f(fn, 'object'), attr = txt(f(fn, 'attribute')), dotted = txt(fn);
                if (OPS.PY.module[dotted]) { const id = OPS.PY.module[dotted]; return call(id, pa.map(ex), n); }
                if (obj.type === 'string' && attr === 'format') { const t = str(obj); const m = t.k === 'lit' && /^\{:\.(\d+)f\}$/.exec(t.v); if (m && pa.length === 1) return call('fmt.fixed', [ex(pa[0]), L('int', m[1])], n); return nativeE(n, 'str.format 非 {:.Nf} 形式'); }
                if (obj.type === 'call' && txt(f(obj, 'function')) === 'open' && ((attr === 'read' && !pa.length) || (attr === 'write' && pa.length === 1))) { // open(p[, 'r'|'w'[, encoding=…]]).read() / .write(s) → file.read_all / file.write_all
                    const oa = argsOf(obj).filter((x) => x.type !== 'keyword_argument'); const mode = oa[1] ? str(oa[1]) : null; const m = mode ? (mode.k === 'lit' ? mode.v : '?') : 'r';
                    if (oa.length >= 1 && oa.length <= 2 && ((attr === 'read' && m === 'r') || (attr === 'write' && m === 'w'))) return call(attr === 'read' ? 'file.read_all' : 'file.write_all', [ex(oa[0])].concat(attr === 'write' ? [ex(pa[0])] : []), n);
                }
                const r = ex(obj);
                if (attr === 'split') return pa.length === 0 ? call('str.split_ws', [r], n) : pa.length === 1 ? call('str.split_sep', [r, ex(pa[0])], n) : nativeE(n, 'split 引數');
                if (attr === 'join' && pa.length === 1) { const a0 = pa[0]; if (a0.type === 'call' && txt(f(a0, 'function')) === 'map' && argsOf(a0).length === 2 && txt(argsOf(a0)[0]) === 'str') return call('str.join_num', [r, ex(argsOf(a0)[1])], n); return call('str.join', [r, ex(a0)], n); }
                if (attr === 'get' && pa.length === 2) return call('dict.get_default', [r, ex(pa[0]), ex(pa[1])], n);
                if (attr === 'sort' && pa.length === 0) return call('list.sort', [r], n);
                if (attr === 'pop' && pa.length === 0) return call('list.pop', [r], n);
                if (OPS.PY.method[attr] && attr !== 'pop') { const id = OPS.PY.method[attr]; const want = OPS.get(id).p.length - 1; if (pa.length === want) return call(id, [r].concat(pa.map(ex)), n); }
                return nativeE(n, '方法 ' + attr + '（' + pa.length + ' 個引數）不在標準操作目錄');
            }
            return nativeE(n, '呼叫的目標不是名稱或方法');
        }

        function ex(n) {
            if (!n) return null;
            switch (n.type) {
                case 'identifier': return at({ k: 'name', v: txt(n) }, n);
                case 'integer': return at(L('int', txt(n).replace(/_/g, '')), n);
                case 'float': return at(L('float', txt(n).replace(/_/g, '')), n);
                case 'true': return at(L('bool', 'true'), n); case 'false': return at(L('bool', 'false'), n); case 'none': return at(L('none', 'None'), n);
                case 'string': return str(n);
                case 'concatenated_string': { const ps = named(n).map(str); return ps.reduce((a, b) => (a.k === 'lit' && b.k === 'lit' ? L('str', a.v + b.v) : call('str.concat', [a, b], n))); }
                case 'parenthesized_expression': return ex(named(n).filter((c) => c.type !== 'comment')[0]);
                case 'call': return call_(n);
                case 'binary_operator': {
                    const op = txt(f(n, 'operator')); const l = f(n, 'left'), r = f(n, 'right');
                    if (op === '%' && l.type === 'string') return nativeE(n, '字串 % 格式化');
                    if (IR.BINOPS.indexOf(op) < 0) return nativeE(n, '運算子 ' + op);
                    return at({ k: 'bin', op, l: ex(l), r: ex(r) }, n);
                }
                case 'boolean_operator': return at({ k: 'logic', op: txt(f(n, 'operator')), l: ex(f(n, 'left')), r: ex(f(n, 'right')) }, n);
                case 'not_operator': return at({ k: 'not', e: ex(f(n, 'argument')) }, n);
                case 'unary_operator': { const op = txt(f(n, 'operator')); if (['-', '+', '~'].indexOf(op) < 0) return nativeE(n); return at({ k: 'un', op, e: ex(f(n, 'argument')) }, n); }
                case 'comparison_operator': {
                    const ops = []; const operands = []; let cur = [];
                    for (const c of n.children) { if (c.isNamed() && c.type !== 'comment') { operands.push(c); if (cur.length) { ops.push(cur.join(' ')); cur = []; } } else if (!c.isNamed()) cur.push(c.type); }
                    const cmps = operands.slice(1).map((r, i) => { if (IR.CMPOPS.indexOf(ops[i]) < 0) return null; return at({ k: 'cmp', op: ops[i], l: ex(operands[i]), r: ex(r) }, n); });
                    if (cmps.some((c) => !c)) return nativeE(n, '比較運算子');
                    return cmps.reduce((a, b) => at({ k: 'logic', op: 'and', l: a, r: b }, n));
                }
                case 'conditional_expression': { const k = named(n).filter((c) => c.type !== 'comment'); return at({ k: 'cond', a: ex(k[0]), c: ex(k[1]), b: ex(k[2]) }, n); }
                case 'list': return at({ k: 'list', items: named(n).filter((c) => c.type !== 'comment').map(ex) }, n);
                case 'dictionary': return at({ k: 'dict', items: named(n).filter((c) => c.type === 'pair').map((p) => [ex(f(p, 'key')), ex(f(p, 'value'))]) }, n);
                case 'subscript': {
                    const v = f(n, 'value'), sub = n.childForFieldName('subscript'); const subs = named(n).filter((c) => c.id !== v.id && c.type !== 'comment');
                    if (subs.length === 1 && subs[0].type === 'slice') {
                        const sl = subs[0]; const parts = sl.children.filter((c) => c.type !== ':'); const hasStep = sl.children.filter((c) => c.type === ':').length > 1 && named(sl).length > 2;
                        const ns = named(sl); const colon = sl.children.findIndex((c) => c.type === ':'); let lo = null, hi = null;
                        sl.children.forEach((c, i) => { if (c.isNamed() && c.type !== 'comment') { if (i < colon) lo = c; else if (hi == null) hi = c; } });
                        if (hasStep || ns.length > 2) return nativeE(n, '切片有 step');
                        const o = ex(v); if (o.k !== 'name') return nativeE(n, '切片的接收者不是單純變數');
                        return call('list.slice', [o, lo ? ex(lo) : L('int', '0'), hi ? ex(hi) : call('coll.len', [o], n)], n);
                    }
                    if (subs.length !== 1) return nativeE(n, '多重索引');
                    return at({ k: 'index', o: ex(v), i: ex(subs[0]) }, n);
                }
                default: return nativeE(n);
            }
        }

        // ---- 敘述 ----
        function rangeOf(r) {
            if (r.type !== 'call' || txt(f(r, 'function')) !== 'range') return null; const a = argsOf(r); if (a.length < 1 || a.length > 3) return null;
            const ex_ = a.map(ex); const from = a.length === 1 ? L('int', '0') : ex_[0], to = a.length === 1 ? ex_[0] : ex_[1]; const step = a.length === 3 ? ex_[2] : null;
            if (step) { const lit = step.k === 'lit' && step.t === 'int' ? +step.v : (step.k === 'un' && step.op === '-' && step.e.k === 'lit' && step.e.t === 'int' ? -step.e.v : null); if (lit == null || lit === 0) return null; }
            return { from, to, step };
        }
        function docOf(blockNode) {
            const k = named(blockNode).filter((c) => c.type !== 'comment')[0];
            if (k && k.type === 'expression_statement') { const s = named(k)[0]; if (s && s.type === 'string' && !named(s).some((c) => c.type === 'interpolation')) return { node: k, text: str(s).v }; }
            return null;
        }
        function stmt(n) {
            cov.stmts++; let out;
            switch (n.type) {
                case 'expression_statement': {
                    const e = named(n).filter((c) => c.type !== 'comment'); const x = e[0];
                    if (!x) return [];
                    if (x.type === 'assignment') return assign(x, n);
                    if (x.type === 'augmented_assignment') {
                        const op = txt(f(x, 'operator')).replace(/=$/, ''); if (IR.BINOPS.indexOf(op) < 0) return [nativeS(n, '複合賦值 ' + op)];
                        return [at({ k: 'aug', to: ex(f(x, 'left')), op, val: ex(f(x, 'right')) }, n)];
                    }
                    out = at({ k: 'expr', e: ex(x) }, n); if (out.e.k === 'native') return [nativeS(n)]; return [out];
                }
                case 'if_statement': return [ifS(n)];
                case 'while_statement': { if (f(n, 'alternative')) return [nativeS(n, 'while-else')]; const w = at({ k: 'while', cond: ex(f(n, 'condition')), body: blk(n, 'body') }, n); return [attach(w, n, w.body)]; }
                case 'for_statement': {
                    const left = f(n, 'left'), right = f(n, 'right'); if (f(n, 'alternative')) return [nativeS(n, 'for-else')];
                    if (left.type !== 'identifier') return [nativeS(n, 'for 的迴圈變數不是單一名稱')];
                    const rg = rangeOf(right);
                    if (rg) { const o = at({ k: 'forrange', var: txt(left), from: rg.from, to: rg.to, step: rg.step, body: blk(n, 'body') }, n); return [attach(o, n, o.body)]; }
                    if (right.type === 'call' && txt(f(right, 'function')) === 'range') return [nativeS(n, 'range 的 step 不是整數常數')];
                    const it = ex(right); if (it.k === 'native') return [nativeS(n, '走訪的對象')];
                    { const o = at({ k: 'foreach', var: txt(left), iter: it, body: blk(n, 'body') }, n); return [attach(o, n, o.body)]; }
                }
                case 'return_statement': { const e = named(n).filter((c) => c.type !== 'comment')[0]; if (e && (e.type === 'expression_list' || e.type === 'tuple')) return [nativeS(n, '回傳多個值')]; return [at({ k: 'ret', val: e ? ex(e) : undefined }, n)]; }
                case 'break_statement': return [at({ k: 'brk' }, n)]; case 'continue_statement': return [at({ k: 'cont' }, n)]; case 'pass_statement': return [at({ k: 'pass' }, n)];
                case 'raise_statement': { const e = named(n).filter((c) => c.type !== 'comment')[0]; let msg; if (e && e.type === 'call') { const a = argsOf(e); if (a[0]) msg = ex(a[0]); } return [at({ k: 'raise', val: msg }, n)]; }
                case 'function_definition': return [func(n)];
                case 'import_statement': case 'import_from_statement': return [at({ k: 'import', src: txt(n) }, n)];
                default: return [nativeS(n)];
            }
        }
        let tmpN = 0;
        function assign(x, stmtNode) {
            const left = f(x, 'left'), right = f(x, 'right'), type = f(x, 'type');
            if (!right) return [nativeS(stmtNode, '只有宣告沒有值')];
            if (right.type === 'assignment') {   // 連鎖 a = b = v
                const inner = assign(right, stmtNode); const last = right.childForFieldName('left'); if (left.type === 'identifier' && last && last.type === 'identifier') return inner.concat([at({ k: 'assign', to: ex(left), val: ex(last) }, stmtNode)]); return [nativeS(stmtNode, '連鎖賦值')];
            }
            if (left.type === 'pattern_list' || left.type === 'tuple_pattern') {
                // 慣用語：a, b = map(int, input().split()) → 一個整數串列暫存＋逐一取值（所有目標語言都表達得了，不需要「字串串列」型別）
                if (right.type === 'call' && txt(f(right, 'function')) === 'map') {
                    const ma = argsOf(right);
                    if (ma.length === 2 && txt(ma[0]) === 'int' && ma[1].type === 'call' && f(ma[1], 'function').type === 'attribute' && txt(f(f(ma[1], 'function'), 'attribute')) === 'split' && !argsOf(ma[1]).length) {
                        const tmp = '__t' + (tmpN++); const lsx = named(left); const outx = [at({ k: 'assign', to: { k: 'name', v: tmp }, val: call('str.split_ints', [ex(f(f(ma[1], 'function'), 'object'))], right) }, stmtNode)];
                        lsx.forEach((l, i) => outx.push(at({ k: 'assign', to: ex(l), val: { k: 'index', o: { k: 'name', v: tmp }, i: L('int', String(i)) } }, stmtNode))); return outx;
                    }
                }
                const ls = named(left), rs = right.type === 'expression_list' || right.type === 'tuple' ? named(right) : null;
                if (rs && rs.length === ls.length) {   // 同時賦值：先全部算進暫存，再逐一寫回（交換 a[i], a[j] = a[j], a[i]）
                    const out = []; const tmps = rs.map((r) => { const t = '__t' + (tmpN++); out.push(at({ k: 'assign', to: { k: 'name', v: t }, val: ex(r) }, stmtNode)); return t; });
                    ls.forEach((l, i) => out.push(at({ k: 'assign', to: ex(l), val: { k: 'name', v: tmps[i] } }, stmtNode))); return out;
                }
                return [nativeS(stmtNode, '解構賦值')];
            }
            if (left.type !== 'identifier' && left.type !== 'subscript') return [nativeS(stmtNode, '賦值目標 ' + left.type)];
            const o = at({ k: 'assign', to: ex(left), val: ex(right) }, stmtNode); if (type) o.ty = tyOfText(txt(type)); return [o];
        }
        function ifS(n) {
            const o = at({ k: 'if', cond: ex(f(n, 'condition')), then: blk(n, 'consequence') }, n); attach(o, n, o.then);
            const alts = n.children.filter((c) => c.type === 'elif_clause' || c.type === 'else_clause'); let cur = o;
            // 夾在區塊之間的註解（# mid）：掛到下一個子句第一個敘述的前置註解
            let pendingC = [];
            for (const c of n.children) {
                if (c.type === 'comment') { if (c.startPosition.row !== n.startPosition.row) { pendingC.push(commentText(c)); cov.comments++; } continue; }
                if (c.type === 'elif_clause') {
                    const e = at({ k: 'if', cond: ex(f(c, 'condition')), then: blk(c, 'consequence') }, c); attach(e, c, e.then); cur.else = [e]; cur = e;
                    if (pendingC.length) { prependC(e, pendingC); pendingC = []; }
                } else if (c.type === 'else_clause') {
                    const eb = f(c, 'body') || named(c).filter((x) => x.type === 'block')[0]; cur.else = block(eb, c.startPosition.row);
                    if (cur.else.hdr && cur.else.hdr.length) { cur.else.unshift({ k: 'comment', s: cur.else.hdr.join(' ') }); }
                    if (pendingC.length && cur.else.length) { prependC(cur.else[0], pendingC); pendingC = []; }
                }
            }
            if (pendingC.length) { cov.comments_kept += 0; diag('if 之間的註解沒有地方掛：' + pendingC.join(' | '), n); }
            if (alts.length === 0) delete o.else; return o;
        }
        function prependC(node, list) { node.c = node.c || {}; node.c.b = list.concat(node.c.b || []); cov.comments_kept += list.length; }
        const commentText = (c) => txt(c).replace(/^#\s?/, '');

        // 區塊：把註解依位置掛成 前置／行尾／獨立
        function block(bn, headerRow) {
            if (!bn) return []; const out = []; let pending = []; let prev = null, prevEnd = -1; const hdr = []; out.hdr = hdr;
            const kids = bn.children;
            for (const c of kids) {
                if (!c.isNamed()) continue;
                if (c.type === 'comment') {
                    cov.comments++; const row = c.startPosition.row, t = commentText(c);
                    if (headerRow != null && row === headerRow && !prev) { hdr.push(t); cov.comments_kept++; continue; }
                    if (prev && row === prevEnd) { prev.c = prev.c || {}; prev.c.a = prev.c.a ? prev.c.a + ' ' + t : t; cov.comments_kept++; } else pending.push({ t, row });
                    continue;
                }
                const ss = stmt(c); if (!ss.length) continue;
                const lastRowBefore = pending.length ? pending[pending.length - 1].row : prevEnd;
                const gap = prevEnd >= 0 || pending.length ? c.startPosition.row - lastRowBefore - 1 : 0;
                const first = ss[0];
                if (pending.length) { first.c = first.c || {}; first.c.b = pending.map((p) => p.t).concat(first.c.b || []); cov.comments_kept += pending.length; const g0 = pending[0].row - (prevEnd >= 0 ? prevEnd : pending[0].row) - 1; if (g0 > 0 && prevEnd >= 0) first.c.sp = 1; pending = []; }
                else if (gap > 0 && prevEnd >= 0) { first.c = first.c || {}; first.c.sp = 1; }
                if (first.c && first.c.sp == null && 0) first.c.sp = 0;
                ss.forEach((s) => out.push(s)); prev = ss[ss.length - 1]; prevEnd = c.endPosition.row;
            }
            if (pending.length) pending.forEach((p) => { out.push({ k: 'comment', s: p.t }); cov.comments_kept++; });
            return out;
        }
        function func(n) {
            const name = txt(f(n, 'name')), ps = f(n, 'parameters'), rt = f(n, 'return_type'), body = f(n, 'body');
            const params = named(ps).filter((c) => c.type !== 'comment').map((p) => {
                if (p.type === 'identifier') return { name: txt(p) };
                if (p.type === 'typed_parameter') return { name: txt(named(p)[0]), ty: tyOfText(txt(f(p, 'type'))) };
                if (p.type === 'default_parameter') return { name: txt(f(p, 'name')), def: ex(f(p, 'value')) };
                if (p.type === 'typed_default_parameter') return { name: txt(f(p, 'name')), ty: tyOfText(txt(f(p, 'type'))), def: ex(f(p, 'value')) };
                diag('不支援的參數形式 ' + p.type, p); return { name: txt(p) };
            });
            const doc = docOf(body);
            const o = at({ k: 'func', name, params, ret: rt ? tyOfText(txt(rt)) : undefined, body: [] }, n);
            const hdrRow = n.startPosition.row;
            const kids = doc ? body.children.filter((c) => c.startIndex !== doc.node.startIndex) : body.children;
            o.body = block({ children: kids }, hdrRow);
            attach(o, n, o.body);
            if (doc) o.doc = doc.text; return o;
        }
        // 標頭行尾註解（def／if／for／while 那一行最後面的 # …）：可能長在複合敘述節點上，也可能是區塊的第一個子節點
        function attach(o, n, arr) {
            const hs = [], lead = [];
            n.children.forEach((c) => {
                if (c.type !== 'comment') return; cov.comments++; cov.comments_kept++;
                // 在 else／elif 之後的註解由 ifS 處理；這裡只收「標頭那行」與「標頭到第一個敘述之間」的註解
                if (c.startPosition.row === n.startPosition.row) hs.push(commentText(c)); else if (arr && arr.length && c.startPosition.row < n.children.filter((x) => x.type === 'block' || x.type === 'else_clause' || x.type === 'elif_clause').map((x) => x.startPosition.row).concat([1e9])[0] + 0) lead.push(commentText(c));
                else if (arr && !arr.length) lead.push(commentText(c)); else { cov.comments_kept--; cov.comments--; }
            });
            ((arr && arr.hdr) || []).forEach((t) => hs.push(t)); if (hs.length) { o.c = o.c || {}; o.c.a = hs.join(' '); }
            if (lead.length && arr) { if (arr.length) { arr[0].c = arr[0].c || {}; arr[0].c.b = lead.concat(arr[0].c.b || []); } else arr.push({ k: 'comment', s: lead.join(' ') }); }
            return o;
        }
        const blk = (n, key) => block(f(n, key), n.startPosition.row);
        // 模組層
        const ir = IR.mod({ src: { lang: 'python', file: opts.file }, name: opts.name || 'Module' });
        const top = block(rootNode, undefined); const body = [];
        for (const s of top) {
            if (s.k === 'if' && s.cond.k === 'cmp' && s.cond.l.k === 'name' && s.cond.l.v === '__name__' && s.then.length === 1 && s.then[0].k === 'expr' && s.then[0].e.k === 'call' && s.then[0].e.fn) { ir.entry = s.then[0].e.fn; if (s.c) body.push({ k: 'pass', c: s.c }); continue; }
            if (s.k === 'import') ir.imports.push(s.src);
            body.push(s);
        }
        // 移除只為了保留註解而留下的空 pass
        ir.body = body.filter((s) => !(s.k === 'pass' && !s.c));
        if (!ir.entry && IR.funcs(ir).some((x) => x.name === 'main')) {
            ir.entry = 'main'; // 模組層直接寫 main()（沒有 __name__ 守衛）：改成進入點，輸出器會自己補一次呼叫，不然會跑兩遍
            const ci = ir.body.findIndex((s) => s.k === 'expr' && s.e && s.e.k === 'call' && s.e.fn === 'main' && !(s.e.args || []).length);
            if (ci >= 0) { const cs = ir.body[ci]; if (cs.c) ir.body[ci] = { k: 'pass', c: cs.c }; else ir.body.splice(ci, 1); }
        }
        return { ir, coverage: cov, diags };
    }
    return { fromTree, tyOfText };
});
