/* Python「出」：核心 IR → Python 原始碼。純函式 UMD，Python 專屬。
 * 用途：①證明 IR 沒有丟資訊（Python → IR → Python 後輸出一致）；②編修迴圈的最後一步（改過的 IR 產生回 Python，再交給 diff patcher 合併進原檔）。
 *   emit(ir, {annotate:true}) → { code, diags } */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./ir_core.js'), require('./ir_ops_core.js')); else root.FaIrOutPython = factory(root.FaIr, root.FaIrOps); })(typeof self !== 'undefined' ? self : this, function (IR, OPS) {
    'use strict';
    const PREC = { cond: 1, or: 2, and: 3, not: 4, cmp: 5, '|': 6, '^': 7, '&': 8, shift: 9, '+': 10, '-': 10, '*': 11, '/': 11, '//': 11, '%': 11, un: 12, '**': 13, atom: 20 };
    const pyStr = (s) => { let q = '"'; return q + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + q; };
    function emit(ir, opts) {
        opts = opts || {}; const diags = [], needMods = []; let typing = {};
        const diag = (level, msg, n) => diags.push({ level, msg, pos: n && n.pos });
        const wrap = (x, min) => (x.p < min ? '(' + x.s + ')' : x.s);
        const atom = (s) => (OPS.atomic(s) ? s : '(' + s + ')');
        function ty(t) {
            if (!t) return null;
            switch (t.t) {
                case 'int': return 'int'; case 'float': return 'float'; case 'bool': return 'bool'; case 'str': return 'str'; case 'void': return 'None'; case 'any': typing.Any = 1; return 'Any';
                case 'list': { const a = ty(t.a[0]); if (!a) return null; typing.List = 1; return 'List[' + a + ']'; }
                case 'dict': { const a = ty(t.a[0]), b = ty(t.a[1]); if (!a || !b) return null; typing.Dict = 1; return 'Dict[' + a + ', ' + b + ']'; }
                case 'set': { const a = ty(t.a[0]); if (!a) return null; typing.Set = 1; return 'Set[' + a + ']'; }
                default: return null;
            }
        }
        function opCall(op, args, tys, n) {
            const r = OPS.render(op, 'python', args.map((a) => ({ raw: a.s, atom: a.p >= PREC.atom ? a.s : atom(a.s) })), tys);
            if (r.code == null) { diag('error', r.missing, n); return { s: 'None', p: PREC.atom }; }
            r.needs.forEach((m) => { if (needMods.indexOf(m) < 0) needMods.push(m); }); return { s: r.code, p: OPS.atomic(r.code) ? PREC.atom : PREC.cond };
        }
        function ex(e) {
            switch (e.k) {
                case 'lit': if (e.t === 'bool') return { s: e.v === 'true' ? 'True' : 'False', p: PREC.atom }; if (e.t === 'none') return { s: 'None', p: PREC.atom }; if (e.t === 'str') return { s: pyStr(e.v), p: PREC.atom }; return { s: e.v, p: PREC.atom };
                case 'name': return { s: e.v, p: PREC.atom };
                case 'bin': { const p = e.op === '<<' || e.op === '>>' ? PREC.shift : PREC[e.op]; const l = ex(e.l), r = ex(e.r); const right = e.op === '**'; return { s: wrap(l, right ? p + 1 : p) + ' ' + e.op + ' ' + wrap(r, right ? p : p + 1), p }; }
                case 'un': { const x = ex(e.e); return { s: e.op + wrap(x, PREC.un), p: PREC.un }; }
                case 'not': { const x = ex(e.e); return { s: 'not ' + wrap(x, PREC.not), p: PREC.not }; }
                case 'logic': { const p = e.op === 'and' ? PREC.and : PREC.or; const l = ex(e.l), r = ex(e.r); return { s: wrap(l, p) + ' ' + e.op + ' ' + wrap(r, p + 1), p }; }
                case 'cmp': { const l = ex(e.l), r = ex(e.r); return { s: wrap(l, PREC.cmp + 1) + ' ' + e.op + ' ' + wrap(r, PREC.cmp + 1), p: PREC.cmp }; }
                case 'cond': { const c = ex(e.c), a = ex(e.a), b = ex(e.b); return { s: wrap(a, PREC.cond + 1) + ' if ' + wrap(c, PREC.cond + 1) + ' else ' + wrap(b, PREC.cond), p: PREC.cond }; }
                case 'list': return { s: '[' + e.items.map((x) => ex(x).s).join(', ') + ']', p: PREC.atom };
                case 'dict': return { s: '{' + e.items.map((p) => ex(p[0]).s + ': ' + ex(p[1]).s).join(', ') + '}', p: PREC.atom };
                case 'index': return { s: atom(ex(e.o).s) + '[' + ex(e.i).s + ']', p: PREC.atom };
                case 'call': {
                    const args = (e.args || []).map(ex); if (e.fn) return { s: e.fn + '(' + args.map((a) => a.s).join(', ') + ')', p: PREC.atom };
                    if (e.op === 'fmt.fixed' && e.args[1].k === 'lit') return { s: '"{:.' + e.args[1].v + 'f}".format(' + args[0].s + ')', p: PREC.atom };   // 位數是常數時用 str.format，與常見寫法（及 Python 進模組的辨識）一致
                    return opCall(e.op, args, (e.args || []).map((a) => a.ty), e);
                }
                case 'native': if (e.lang === 'python') return { s: e.src, p: 0 }; diag('error', '原生區塊（' + e.lang + '）不是 Python', e); return { s: 'None', p: PREC.atom };
            }
            return { s: 'None', p: PREC.atom };
        }
        const out = []; const ind = (d) => '    '.repeat(d);
        function pre(s, d) { if (s.c && s.c.sp) out.push(''); ((s.c && s.c.b) || []).forEach((t) => out.push(ind(d) + '# ' + t)); }
        const post = (s) => (s.c && s.c.a ? '  # ' + s.c.a : '');
        function block(body, d, force) { const n0 = out.length; (body || []).forEach((s) => stmt(s, d)); if (out.length === n0 && force !== false) out.push(ind(d) + 'pass'); }
        function stmt(s, d) {
            pre(s, d); const I = ind(d);
            switch (s.k) {
                case 'comment': out.push(I + '# ' + s.s); return;
                case 'pass': if (s.c && s.c.a) out.push(I + '# ' + s.c.a); return;
                case 'import': out.push(I + s.src + post(s)); return;
                case 'declare': return;
                case 'assign': {
                    let line;
                    if (s.to.k === 'index') { line = atom(ex(s.to.o).s) + '[' + ex(s.to.i).s + '] = ' + ex(s.val).s; }
                    else { const t = s.decl && s.ty && s.val.k === 'list' && !s.val.items.length ? ty(s.ty) : null; line = s.to.v + (t ? ': ' + t : '') + ' = ' + ex(s.val).s; }
                    out.push(I + line + post(s)); return;
                }
                case 'aug': out.push(I + ex(s.to).s + ' ' + s.op + '= ' + ex(s.val).s + post(s)); return;
                case 'expr': out.push(I + ex(s.e).s + post(s)); return;
                case 'ret': out.push(I + 'return' + (s.val ? ' ' + ex(s.val).s : '') + post(s)); return;
                case 'brk': out.push(I + 'break' + post(s)); return; case 'cont': out.push(I + 'continue' + post(s)); return;
                case 'raise': out.push(I + 'raise Exception(' + (s.val ? ex(s.val).s : '') + ')' + post(s)); return;
                case 'if': {
                    out.push(I + 'if ' + ex(s.cond).s + ':' + post(s)); block(s.then, d + 1); let cur = s;
                    while (cur.else && cur.else.length === 1 && cur.else[0].k === 'if' && !(cur.else[0].c && (cur.else[0].c.b || cur.else[0].c.sp))) { cur = cur.else[0]; out.push(I + 'elif ' + ex(cur.cond).s + ':' + post(cur)); block(cur.then, d + 1); }
                    if (cur.else && cur.else.length) { out.push(I + 'else:'); block(cur.else, d + 1); } return;
                }
                case 'while': out.push(I + 'while ' + ex(s.cond).s + ':' + post(s)); block(s.body, d + 1); return;
                case 'forrange': {
                    const a = ex(s.from).s, b = ex(s.to).s; const st = s.step ? ', ' + ex(s.step).s : ''; const args = (a === '0' && !st) ? b : a + ', ' + b + st;
                    out.push(I + 'for ' + s.var + ' in range(' + args + '):' + post(s)); block(s.body, d + 1); return;
                }
                case 'foreach': out.push(I + 'for ' + s.var + ' in ' + ex(s.iter).s + ':' + post(s)); block(s.body, d + 1); return;
                case 'native': if (s.lang === 'python') { s.src.split('\n').forEach((l) => out.push(I + l)); return; } diag('error', '原生區塊（' + s.lang + '）不是 Python', s); out.push(I + 'pass  # NATIVE ' + s.lang); return;
                case 'func': {
                    const ps = s.params.map((p) => { const t = opts.annotate !== false ? ty(p.ty) : null; return p.name + (t ? ': ' + t : '') + (p.def ? (t ? ' = ' : '=') + ex(p.def).s : ''); }).join(', ');
                    const rt = opts.annotate !== false && s.ret ? ty(s.ret) : null;
                    out.push(I + 'def ' + s.name + '(' + ps + ')' + (rt ? ' -> ' + rt : '') + ':' + post(s));
                    if (s.doc) out.push(ind(d + 1) + '"""' + s.doc + '"""'); block(s.body, d + 1, !s.doc); return;
                }
            }
            diag('error', '不認得的敘述 ' + s.k, s);
        }
        let prevFunc = false;
        ir.body.forEach((s, i) => {
            if (s.k === 'func' && out.length) { const need = (s.c && s.c.sp) ? 0 : 2; for (let k = 0; k < need; k++) out.push(''); } else if (prevFunc && s.k !== 'func') { out.push(''); out.push(''); }
            stmt(s, 0); prevFunc = s.k === 'func';
        });
        if (ir.entry) { out.push(''); out.push(''); out.push('if __name__ == "__main__":'); out.push('    ' + ir.entry + '()'); }
        const have = ir.body.filter((s) => s.k === 'import').map((s) => s.src).join('\n'); const head = []; needMods.forEach((m) => { if (!new RegExp('\\bimport\\s+' + m + '\\b').test(have)) head.push('import ' + m); }); const tn = Object.keys(typing).sort(); if (tn.length && !/from\s+typing\s+import/.test(have)) head.push('from typing import ' + tn.join(', '));
        return { code: (head.length ? head.join('\n') + '\n\n\n' : '') + out.join('\n') + '\n', diags };
    }
    return { emit };
});
