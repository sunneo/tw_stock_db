/* C「出」：核心 IR（已過 FaIrPrep.prepare）→ C99 原始碼。純函式 UMD，C 專屬。
 *   emit(ir) → { code, diags, helpers }
 * 支援子集（誠實）：long long、double、bool（int）、唯讀字串（char*）、整數串列（IL 結構＋輔助函式）。
 * 不支援（報 error，不亂翻）：字典／集合、非整數串列、串列的串列、字串走訪、字串索引結果當值用（只能比較）、對「參數」做 append／pop／insert（C 以值傳結構，別名語意不同）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./ir_core.js'), require('./ir_ops_core.js')); else root.FaIrOutC = factory(root.FaIr, root.FaIrOps); })(typeof self !== 'undefined' ? self : this, function (IR, OPS) {
    'use strict';
    const RESERVED = new Set(['auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', 'main', 'abs', 'exit', 'printf', 'puts', 'sqrt', 'floor', 'ceil', 'round', 'pow', 'index', 'time', 'rand', 'free', 'malloc', 'signal', 'remove', 'rename', 'y0', 'y1', 'j0', 'j1', 'gcd', 'IL', 'bool', 'true', 'false', 'NULL', 'stdin', 'stdout', 'stderr']);
    const safe = (n) => (RESERVED.has(n) ? 'u_' + n : n);
    const PREC = { cond: 3, or: 4, and: 5, '|': 6, '^': 7, '&': 8, eq: 9, rel: 10, shift: 11, '+': 12, '-': 12, '*': 13, '/': 13, '%': 13, un: 15, atom: 20 };
    const cStr = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/\?/g, '\\?') + '"';

    function emit(ir) {
        const diags = [], used = []; let fn = null;
        const diag = (level, msg, n) => diags.push({ level, msg, pos: n && n.pos });
        const useH = (hs) => hs.forEach((h) => { if (used.indexOf(h) < 0) used.push(h); });
        const wrap = (x, min) => (x.p < min ? '(' + x.s + ')' : x.s);
        const atom = (s) => (OPS.atomic(s) ? s : '(' + s + ')');
        function ty(t, n) {
            if (!t) { diag('error', '型別缺失', n); return 'long long'; }
            switch (t.t) {
                case 'int': return 'long long'; case 'float': return 'double'; case 'bool': return 'int'; case 'str': return 'char *'; case 'void': return 'void';
                case 'list': if (t.a[0].t === 'int') { useH(['fa_list']); return 'IL'; } diag('error', 'C 只支援整數串列，這裡是 ' + IR.tyStr(t), n); return 'IL';
                case 'dict': case 'set': diag('error', 'C 沒有內建的字典／集合，需要附帶執行階段函式庫（本轉換器不支援）：' + IR.tyStr(t), n); return 'void *';
                default: diag('error', 'C 需要明確型別，但這裡是 ' + IR.tyStr(t) + '——請在來源加型別標註', n); return 'long long';
            }
        }
        const defaultOf = (t) => (t.t === 'list' ? 'fa_new()' : t.t === 'str' ? '""' : '0');
        const isChar = (e) => e.k === 'index' && e.o.ty && e.o.ty.t === 'str';
        function opCall(op, args, tys, n, argNodes) {
            // 對參數 append／pop／insert：別名語意不同
            if (/^list\.(append|pop|insert)$/.test(op) && argNodes && argNodes[0] && argNodes[0].k === 'name' && fn && fn.params.some((p) => p.name === argNodes[0].v)) diag('error', 'C：對函式參數 ' + argNodes[0].v + ' 做 ' + op + '——串列以值傳入，增減元素不會回到呼叫端（需改傳指標，本轉換器不支援）', n);
            const r = OPS.render(op, 'c', args.map((a) => ({ raw: a.s, atom: a.p >= PREC.atom ? a.s : atom(a.s) })), tys);
            if (r.code == null) { diag('error', r.missing, n); return { s: '/* 無法翻譯 ' + op + ' */ 0', p: PREC.atom }; }
            useH(r.helpers); return { s: r.code, p: OPS.atomic(r.code) ? PREC.atom : PREC.cond };
        }
        function ex(e) {
            switch (e.k) {
                case 'lit':
                    if (e.t === 'int') return { s: e.v, p: PREC.atom }; if (e.t === 'float') return { s: e.v, p: PREC.atom }; if (e.t === 'str') return { s: cStr(e.v), p: PREC.atom }; if (e.t === 'bool') return { s: e.v === 'true' ? '1' : '0', p: PREC.atom }; return { s: 'NULL', p: PREC.atom };
                case 'name': return { s: safe(e.v), p: PREC.atom };
                case 'bin': { const p = e.op === '<<' || e.op === '>>' ? PREC.shift : PREC[e.op]; const l = ex(e.l), r = ex(e.r); return { s: wrap(l, p) + ' ' + e.op + ' ' + wrap(r, p + 1), p }; }
                case 'un': { const x = ex(e.e); return { s: e.op + wrap(x, PREC.un), p: PREC.un }; }
                case 'not': { const x = ex(e.e); return { s: '!' + wrap(x, PREC.un), p: PREC.un }; }
                case 'logic': { const p = e.op === 'and' ? PREC.and : PREC.or; const l = ex(e.l), r = ex(e.r); return { s: wrap(l, p) + (e.op === 'and' ? ' && ' : ' || ') + wrap(r, p + 1), p }; }
                case 'cmp': {
                    const lt = e.l.ty && e.l.ty.t, rt = e.r.ty && e.r.ty.t;
                    if (isChar(e.l) || isChar(e.r)) {   // 字元比較：s[i] 是 char
                        const side = (x) => (isChar(x) ? ex(x).s : (x.k === 'lit' && x.t === 'str' && x.v.length === 1 ? "'" + (x.v === "'" || x.v === '\\' ? '\\' + x.v : x.v) + "'" : (diag('error', 'C：字串索引的結果只能與另一個字元或長度 1 的字串常數比較', e), '0')));
                        const op = { '==': '==', '!=': '!=', is: '==', 'is not': '!=' }[e.op] || e.op; return { s: side(e.l) + ' ' + op + ' ' + side(e.r), p: PREC.eq };
                    }
                    const l = ex(e.l), r = ex(e.r);
                    if (lt === 'str' && rt === 'str') { const c = 'strcmp(' + l.s + ', ' + r.s + ')'; const op = { is: '==', 'is not': '!=' }[e.op] || e.op; return { s: c + ' ' + op + ' 0', p: PREC.rel }; }
                    if (lt === 'list' || lt === 'dict') diag('error', 'C：串列／字典不能用 ' + e.op + ' 比較內容', e);
                    const p = e.op === '==' || e.op === '!=' ? PREC.eq : PREC.rel; const op = { is: '==', 'is not': '!=' }[e.op] || e.op; return { s: wrap(l, p) + ' ' + op + ' ' + wrap(r, p + 1), p };
                }
                case 'cond': { const c = ex(e.c), a = ex(e.a), b = ex(e.b); return { s: wrap(c, PREC.cond + 1) + ' ? ' + wrap(a, PREC.cond) + ' : ' + wrap(b, PREC.cond), p: PREC.cond }; }
                case 'list': if (!e.items.length) { useH(['fa_new']); return { s: 'fa_new()', p: PREC.atom }; } diag('error', 'C：非空串列字面值尚未支援', e); return { s: 'fa_new()', p: PREC.atom };
                case 'dict': diag('error', 'C 不支援字典', e); return { s: 'NULL', p: PREC.atom };
                case 'index': {
                    const o = ex(e.o), i = ex(e.i); const t = e.o.ty && e.o.ty.t; if (t === 'dict') { diag('error', 'C 不支援字典', e); return { s: '0', p: PREC.atom }; }
                    return opCall(t === 'str' ? 'str.char_at' : 'list.get', [o, i], [e.o.ty, e.i.ty], e);
                }
                case 'call': {
                    const args = (e.args || []).map(ex);
                    if (e.fn) return { s: safe(e.fn) + '(' + args.map((a) => a.s).join(', ') + ')', p: PREC.atom };
                    if (e.op === 'str.char_at') { diag('error', 'C：str.char_at 只能用於比較', e); }
                    return opCall(e.op, args, (e.args || []).map((a) => a.ty), e, e.args);
                }
                case 'native': diag('error', '原生區塊（' + e.lang + '）無法翻成 C：' + e.src.split('\n')[0], e); return { s: '0 /* NATIVE ' + e.lang + ' */', p: PREC.atom };
            }
            diag('error', '不認得的運算式 ' + e.k, e); return { s: '0', p: PREC.atom };
        }

        const out = []; const ind = (d) => '    '.repeat(d);
        function pre(s, d) { if (s.c && s.c.sp) out.push(''); ((s.c && s.c.b) || []).forEach((t) => out.push(ind(d) + '/* ' + t.replace(/\*\//g, '* /') + ' */')); }
        const post = (s) => (s.c && s.c.a ? ' /* ' + s.c.a.replace(/\*\//g, '* /') + ' */' : '');
        const SF = { assign: ['to', 'val'], aug: ['to', 'val'], if: ['cond'], while: ['cond'], expr: ['e'], ret: ['val'] };
        function mutated(name, body) {
            let m = false;
            IR.walkStmts(body, (s) => {
                if ((s.k === 'assign' || s.k === 'aug') && s.to.k === 'name' && s.to.v === name) m = true; if ((s.k === 'forrange' || s.k === 'foreach') && s.var === name) m = true;
                (SF[s.k] || []).forEach((f) => { if (s[f]) IR.walkExpr(s[f], (x) => { if (x.k === 'call' && x.op && /^(list\.(append|pop|insert|sort|reverse)|dict\.(put|delete)|set\.add)$/.test(x.op) && x.args[0] && x.args[0].k === 'name' && x.args[0].v === name) m = true; }); });
            });
            return m;
        }
        function stable(e, body) { if (e.k === 'lit') return true; if (e.k === 'name') return !mutated(e.v, body); if (e.k === 'call' && e.op === 'coll.len' && e.args[0].k === 'name') return !mutated(e.args[0].v, body); if (e.k === 'bin') return stable(e.l, body) && stable(e.r, body); return false; }
        let uid = 0;
        function block(body, d) { (body || []).forEach((s) => stmt(s, d)); }
        function stmt(s, d) {
            pre(s, d); const I = ind(d);
            switch (s.k) {
                case 'comment': out.push(I + '/* ' + s.s.replace(/\*\//g, '* /') + ' */'); return;
                case 'pass': if (s.c && s.c.a) out.push(I + '/* ' + s.c.a + ' */'); return;
                case 'declare': out.push(I + ty(s.ty, s) + ' ' + safe(s.name) + ' = ' + defaultOf(s.ty) + ';'); if (s.ty.t === 'list') useH(['fa_new']); return;
                case 'assign': {
                    let line;
                    if (s.to.k === 'index') { const t = s.to.o.ty && s.to.o.ty.t; if (t === 'dict') { diag('error', 'C 不支援字典', s); line = '/* dict put */'; } else line = opCall('list.set', [ex(s.to.o), ex(s.to.i), ex(s.val)], [s.to.o.ty, s.to.i.ty, s.val.ty], s).s; }
                    else {
                        const t = s.ty || s.val.ty || IR.T.unknown; if (t.t === 'list' && s.val.k === 'name') diag('warn', 'C：串列賦值 ' + s.to.v + ' = ' + s.val.v + ' 是結構複製，兩者共用同一塊記憶體，之後各自 append 會分岔（Python 是同一個物件）', s);
                        if (isChar(s.val)) diag('error', 'C：字串索引的結果不能當值使用', s);
                        line = (s.decl ? ty(t, s) + ' ' : '') + safe(s.to.v) + ' = ' + ex(s.val).s;
                    }
                    out.push(I + line + ';' + post(s)); return;
                }
                case 'aug': {
                    if (s.to.k === 'index') { const cur = ex(s.to); out.push(I + opCall('list.set', [ex(s.to.o), ex(s.to.i), { s: cur.s + ' ' + s.op + ' ' + wrap(ex(s.val), PREC[s.op] + 1), p: PREC[s.op] }], [s.to.o.ty, s.to.i.ty, s.val.ty], s).s + ';' + post(s)); return; }
                    out.push(I + ex(s.to).s + ' ' + s.op + '= ' + ex(s.val).s + ';' + post(s)); return;
                }
                case 'expr': out.push(I + ex(s.e).s + ';' + post(s)); return;
                case 'ret': out.push(I + 'return' + (s.val ? ' ' + ex(s.val).s : '') + ';' + post(s)); return;
                case 'brk': out.push(I + 'break;' + post(s)); return; case 'cont': out.push(I + 'continue;' + post(s)); return;
                case 'raise': out.push(I + 'fprintf(stderr, "error\\n"); exit(1);' + post(s)); return;
                case 'if': {
                    out.push(I + 'if (' + ex(s.cond).s + ') {' + post(s)); block(s.then, d + 1); let cur = s;
                    while (cur.else && cur.else.length === 1 && cur.else[0].k === 'if' && !(cur.else[0].c && (cur.else[0].c.b || cur.else[0].c.sp))) { cur = cur.else[0]; out.push(I + '} else if (' + ex(cur.cond).s + ') {' + post(cur)); block(cur.then, d + 1); }
                    if (cur.else && cur.else.length) { out.push(I + '} else {'); block(cur.else, d + 1); }
                    out.push(I + '}'); return;
                }
                case 'while': out.push(I + 'while (' + ex(s.cond).s + ') {' + post(s)); block(s.body, d + 1); out.push(I + '}'); return;
                case 'forrange': {
                    const v = safe(s.var); const stepLit = s.step ? (s.step.k === 'lit' ? +s.step.v : -s.step.e.v) : 1; const neg = stepLit < 0;
                    let to = ex(s.to); if (!stable(s.to, s.body)) { const t = '__to' + (++uid); out.push(I + 'const long long ' + t + ' = ' + to.s + ';'); to = { s: t, p: PREC.atom }; }
                    out.push(I + 'for (long long ' + v + ' = ' + ex(s.from).s + '; ' + v + (neg ? ' > ' : ' < ') + wrap(to, PREC.rel + 1) + '; ' + v + (stepLit === 1 ? '++' : stepLit === -1 ? '--' : ' += ' + stepLit) + ') {' + post(s));
                    block(s.body, d + 1); out.push(I + '}'); return;
                }
                case 'foreach': {
                    const t = s.iter.ty; if (!t || t.t !== 'list' || t.a[0].t !== 'int') { diag('error', 'C：只支援走訪整數串列，這裡是 ' + IR.tyStr(t), s); return; }
                    const it = ex(s.iter); const ix = '__i' + (++uid); const base = atom(it.s);
                    out.push(I + 'for (long long ' + ix + ' = 0; ' + ix + ' < ' + base + '.n; ' + ix + '++) {' + post(s)); out.push(ind(d + 1) + 'long long ' + safe(s.var) + ' = ' + base + '.d[' + ix + '];'); block(s.body, d + 1); out.push(I + '}'); return;
                }
                case 'native': diag('error', '原生區塊（' + s.lang + '）無法翻成 C：' + s.src.split('\n')[0], s); out.push(I + '/* NATIVE(' + s.lang + '): ' + s.src.split('\n')[0].replace(/\*\//g, '* /') + ' */'); return;
                case 'func': {
                    const prev = fn; fn = s;
                    if (s.doc) { out.push(I + '/* ' + s.doc.replace(/\*\//g, '* /') + ' */'); }
                    out.push(I + 'static ' + ty(s.ret || IR.T.void, s) + ' ' + safe(s.name) + '(' + (s.params.length ? s.params.map((p) => ty(p.ty, s) + ' ' + safe(p.name)).join(', ') : 'void') + ') {' + post(s)); block(s.body, d + 1); out.push(I + '}'); fn = prev; return;
                }
            }
            diag('error', '不認得的敘述 ' + s.k, s);
        }
        const protos = []; let first = true;
        IR.funcs(ir).forEach((f) => { const save = diags.length; protos.push('static ' + ty(f.ret || IR.T.void, f) + ' ' + safe(f.name) + '(' + (f.params.length ? f.params.map((p) => ty(p.ty, f) + ' ' + safe(p.name)).join(', ') : 'void') + ');'); diags.length = save; });
        ir.body.forEach((s) => {
            if (s.k === 'func') { if (!first && !(s.c && s.c.sp)) out.push(''); first = false; stmt(s, 0); return; }
            if (s.k === 'comment' || s.k === 'pass') { stmt(s, 0); return; }
            if (s.k === 'assign' && s.to.k === 'name') { pre(s, 0); out.push('static ' + ty(s.ty || s.val.ty, s) + ' ' + safe(s.to.v) + ' = ' + ex(s.val).s + ';' + post(s)); return; }
            diag('error', '模組層的 ' + s.k + ' 敘述尚未支援', s);
        });
        const hs = OPS.helperSource('c', used);
        const lines = ['#include <stdio.h>', '#include <stdlib.h>', '#include <string.h>', '#include <math.h>', ''];
        hs.forEach((h) => lines.push(h)); if (hs.length) lines.push('');
        protos.forEach((p) => lines.push(p)); if (protos.length) lines.push('');
        out.forEach((l) => lines.push(l));
        if (ir.entry) { lines.push(''); lines.push('int main(void) {'); lines.push('    ' + safe(ir.entry) + '();'); lines.push('    return 0;'); lines.push('}'); }
        return { code: lines.join('\n') + '\n', diags, helpers: used };
    }
    return { emit };
});
