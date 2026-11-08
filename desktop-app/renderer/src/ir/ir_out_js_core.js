/* JavaScript（Node.js）「出」：核心 IR（已過 FaIrPrep.prepare）→ 原始碼。純函式 UMD，JavaScript 專屬。
 *   emit(ir, {}) → { code, diags, helpers }   diags 的 level：error＝這段沒辦法精準翻譯（程式不可信）、warn＝已翻但有語意差異要提醒
 * 註解：前置註解、行尾註解、獨立註解、docstring（轉成 JSDoc）、空行都保留。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./ir_core.js'), require('./ir_ops_core.js')); else root.FaIrOutJs = factory(root.FaIr, root.FaIrOps); })(typeof self !== 'undefined' ? self : this, function (IR, OPS) {
    'use strict';
    const RESERVED = new Set(['arguments', 'eval', 'class', 'new', 'delete', 'var', 'let', 'const', 'function', 'this', 'typeof', 'void', 'with', 'yield', 'await', 'default', 'switch', 'case', 'export', 'import', 'null', 'undefined', 'in', 'of', 'do', 'try', 'catch', 'finally', 'throw', 'enum', 'super', 'static', 'public', 'private', 'Math', 'String', 'Number', 'Map', 'Set', 'Array', 'Object', 'JSON', 'console', 'require', 'module']);
    const safe = (n) => (RESERVED.has(n) ? n + '_' : n);
    const PREC = { cond: 3, or: 4, and: 5, '|': 6, '^': 7, '&': 8, eq: 9, rel: 10, shift: 11, '+': 12, '-': 12, '*': 13, '/': 13, '%': 13, un: 15, atom: 20 };
    const jsStr = (s) => JSON.stringify(s).split(String.fromCharCode(0x2028)).join("\u2028").split(String.fromCharCode(0x2029)).join("\u2029");

    function emit(ir) {
        const diags = [], used = []; let uid = 0; let fn = null;
        const diag = (level, msg, n) => diags.push({ level, msg, pos: n && n.pos });
        const useH = (hs) => hs.forEach((h) => { if (used.indexOf(h) < 0) used.push(h); });
        const wrap = (x, min) => (x.p < min ? '(' + x.s + ')' : x.s);
        const atom = (s) => (OPS.atomic(s) ? s : '(' + s + ')');
        const defaultOf = (t) => (!t ? 'undefined' : t.t === 'int' || t.t === 'float' ? '0' : t.t === 'str' ? '""' : t.t === 'bool' ? 'false' : t.t === 'list' ? '[]' : t.t === 'dict' ? 'new Map()' : t.t === 'set' ? 'new Set()' : 'null');

        function opCall(op, args, tys, n) {
            const r = OPS.render(op, 'nodejs', args.map((a) => ({ raw: a.s, atom: a.p >= PREC.atom ? a.s : atom(a.s) })), tys);
            if (r.code == null) { diag('error', r.missing, n); return { s: '/* 無法翻譯 ' + op + ' */ undefined', p: PREC.atom }; }
            useH(r.helpers); return { s: r.code, p: OPS.atomic(r.code) ? PREC.atom : PREC.cond };
        }
        function ex(e) {
            switch (e.k) {
                case 'lit':
                    if (e.t === 'int') { if (e.v.replace(/^0[xob]/i, '').length > 15 && !/^0[xob]/i.test(e.v)) diag('warn', '整數常數 ' + e.v + ' 可能超過 JavaScript 的安全整數範圍（2^53）', e); return { s: e.v, p: PREC.atom }; }
                    if (e.t === 'float') return { s: e.v, p: PREC.atom }; if (e.t === 'str') return { s: jsStr(e.v), p: PREC.atom }; if (e.t === 'bool') return { s: e.v, p: PREC.atom }; return { s: 'null', p: PREC.atom };
                case 'name': return { s: safe(e.v), p: PREC.atom };
                case 'bin': {
                    if (['&', '|', '^', '<<', '>>'].indexOf(e.op) >= 0) diag('warn', '位元運算在 JavaScript 是 32 位元有號整數，與 Python 的任意長度整數不同；數值超過 2^31 結果會錯', e);
                    const p = e.op === '<<' || e.op === '>>' ? PREC.shift : PREC[e.op]; const l = ex(e.l), r = ex(e.r);
                    return { s: wrap(l, p) + ' ' + e.op + ' ' + wrap(r, p + 1), p };
                }
                case 'un': { const x = ex(e.e); return { s: e.op + wrap(x, PREC.un), p: PREC.un }; }
                case 'not': { const x = ex(e.e); return { s: '!' + wrap(x, PREC.un), p: PREC.un }; }
                case 'logic': { const p = e.op === 'and' ? PREC.and : PREC.or; const l = ex(e.l), r = ex(e.r); return { s: wrap(l, p) + (e.op === 'and' ? ' && ' : ' || ') + wrap(r, p + 1), p }; }
                case 'cmp': {
                    const l = ex(e.l), r = ex(e.r); const ty = e.l.ty && e.l.ty.t; let op = e.op;
                    if (ty === 'list' || ty === 'dict' || (e.r.ty && (e.r.ty.t === 'list' || e.r.ty.t === 'dict'))) diag('warn', '串列／字典用 ' + op + ' 比較：Python 比內容，JavaScript 比參考', e);
                    op = { '==': '===', '!=': '!==', is: '===', 'is not': '!==' }[op] || op; const p = /[=]=/.test(op) ? PREC.eq : PREC.rel;
                    return { s: wrap(l, p) + ' ' + op + ' ' + wrap(r, p + 1), p };
                }
                case 'cond': { const c = ex(e.c), a = ex(e.a), b = ex(e.b); return { s: wrap(c, PREC.cond + 1) + ' ? ' + wrap(a, PREC.cond) + ' : ' + wrap(b, PREC.cond), p: PREC.cond }; }
                case 'list': return { s: '[' + e.items.map((x) => ex(x).s).join(', ') + ']', p: PREC.atom };
                case 'dict': return { s: e.items.length ? 'new Map([' + e.items.map((p) => '[' + ex(p[0]).s + ', ' + ex(p[1]).s + ']').join(', ') + '])' : 'new Map()', p: PREC.atom };
                case 'index': {
                    const o = ex(e.o), i = ex(e.i); const t = e.o.ty && e.o.ty.t;
                    const op = t === 'dict' ? 'dict.get' : t === 'str' ? 'str.char_at' : 'list.get'; if (t === 'unknown' || !t) diag('warn', '索引的對象型別未知，當成串列', e);
                    return opCall(op, [o, i], [e.o.ty, e.i.ty], e);
                }
                case 'call': {
                    const args = (e.args || []).map(ex);
                    if (e.fn) return { s: safe(e.fn) + '(' + args.map((a) => a.s).join(', ') + ')', p: PREC.atom };
                    return opCall(e.op, args, (e.args || []).map((a) => a.ty), e);
                }
                case 'native': if (e.lang === 'nodejs') return { s: e.src, p: 0 }; diag('error', '原生區塊（' + e.lang + '）無法翻成 JavaScript：' + e.src.split('\n')[0], e); return { s: 'undefined /* NATIVE ' + e.lang + ' */', p: PREC.atom };
            }
            diag('error', '不認得的運算式 ' + e.k, e); return { s: 'undefined', p: PREC.atom };
        }

        const out = []; const ind = (d) => '    '.repeat(d);
        const cmt = (s) => '// ' + s;
        function pre(s, d) {
            if (s.c && s.c.sp) out.push('');
            ((s.c && s.c.b) || []).forEach((t) => out.push(ind(d) + cmt(t)));
        }
        const post = (s) => (s.c && s.c.a ? ' // ' + s.c.a : '');
        function mutated(name, body) {
            let m = false;
            IR.walkStmts(body, (s) => {
                if ((s.k === 'assign' || s.k === 'aug') && s.to.k === 'name' && s.to.v === name) m = true; if ((s.k === 'forrange' || s.k === 'foreach') && s.var === name) m = true;
                (SF[s.k] || []).forEach((f) => { if (s[f]) IR.walkExpr(s[f], (x) => { if (x.k === 'call' && x.op && /^(list\.(append|pop|insert|sort|reverse)|dict\.(put|delete)|set\.add)$/.test(x.op) && x.args[0] && x.args[0].k === 'name' && x.args[0].v === name) m = true; }); });
            });
            return m;
        }
        const SF = { assign: ['to', 'val'], aug: ['to', 'val'], if: ['cond'], while: ['cond'], expr: ['e'], ret: ['val'] };
        function stable(e, body) { if (e.k === 'lit') return true; if (e.k === 'name') return !mutated(e.v, body); if (e.k === 'call' && e.op === 'coll.len' && e.args[0].k === 'name') return !mutated(e.args[0].v, body); if (e.k === 'bin') return stable(e.l, body) && stable(e.r, body); return false; }

        function block(body, d) { (body || []).forEach((s) => stmt(s, d)); }
        function stmt(s, d) {
            pre(s, d); const I = ind(d);
            switch (s.k) {
                case 'comment': out.push(I + cmt(s.s)); return;
                case 'pass': if (s.c && s.c.a) out.push(I + cmt(s.c.a)); return;
                case 'declare': out.push(I + 'let ' + safe(s.name) + ' = ' + defaultOf(s.ty) + ';'); return;
                case 'assign': {
                    let line;
                    if (s.to.k === 'index') { const o = ex(s.to.o), i = ex(s.to.i), v = ex(s.val); const t = s.to.o.ty && s.to.o.ty.t; const r = opCall(t === 'dict' ? 'dict.put' : 'list.set', [o, i, v], [s.to.o.ty, s.to.i.ty, s.val.ty], s); line = r.s; }
                    else line = (s.decl ? 'let ' : '') + safe(s.to.v) + ' = ' + ex(s.val).s;
                    out.push(I + line + ';' + post(s)); return;
                }
                case 'aug': { const t = ex(s.to), v = ex(s.val); out.push(I + t.s + ' ' + s.op + '= ' + v.s + ';' + post(s)); return; }
                case 'expr': out.push(I + ex(s.e).s + ';' + post(s)); return;
                case 'ret': out.push(I + 'return' + (s.val ? ' ' + ex(s.val).s : '') + ';' + post(s)); return;
                case 'brk': out.push(I + 'break;' + post(s)); return; case 'cont': out.push(I + 'continue;' + post(s)); return;
                case 'raise': out.push(I + 'throw new Error(' + (s.val ? ex(s.val).s : '"error"') + ');' + post(s)); return;
                case 'if': {
                    out.push(I + 'if (' + ex(s.cond).s + ') {' + post(s)); block(s.then, d + 1);
                    let cur = s;
                    while (cur.else && cur.else.length === 1 && cur.else[0].k === 'if' && !(cur.else[0].c && (cur.else[0].c.b || cur.else[0].c.sp))) { cur = cur.else[0]; out.push(I + '} else if (' + ex(cur.cond).s + ') {' + post(cur)); block(cur.then, d + 1); }
                    if (cur.else && cur.else.length) { out.push(I + '} else {'); block(cur.else, d + 1); }
                    out.push(I + '}'); return;
                }
                case 'while': out.push(I + 'while (' + ex(s.cond).s + ') {' + post(s)); block(s.body, d + 1); out.push(I + '}'); return;
                case 'forrange': {
                    const v = safe(s.var); const stepLit = s.step ? (s.step.k === 'lit' ? +s.step.v : -s.step.e.v) : 1; const neg = stepLit < 0;
                    let to = ex(s.to); if (!stable(s.to, s.body)) { const t = '__to' + (++uid); out.push(I + 'const ' + t + ' = ' + to.s + ';'); to = { s: t, p: PREC.atom }; }
                    out.push(I + 'for (let ' + v + ' = ' + ex(s.from).s + '; ' + v + (neg ? ' > ' : ' < ') + wrap(to, PREC.rel + 1) + '; ' + v + (stepLit === 1 ? '++' : stepLit === -1 ? '--' : ' += ' + stepLit) + ') {' + post(s));
                    block(s.body, d + 1); out.push(I + '}'); return;
                }
                case 'foreach': { const it = ex(s.iter); const dict = s.iter.ty && s.iter.ty.t === 'dict'; out.push(I + 'for (const ' + safe(s.var) + ' of ' + (dict ? atom(it.s) + '.keys()' : it.s) + ') {' + post(s)); block(s.body, d + 1); out.push(I + '}'); return; }
                case 'native': if (s.lang === 'nodejs') { s.src.split('\n').forEach((l) => out.push(I + l)); return; } diag('error', '原生區塊（' + s.lang + '）無法翻成 JavaScript：' + s.src.split('\n')[0], s); out.push(I + '/* NATIVE(' + s.lang + '):'); s.src.split('\n').forEach((l) => out.push(I + ' * ' + l.replace(/\*\//g, '* /'))); out.push(I + ' */'); out.push(I + 'throw new Error("untranslated native block");'); return;
                case 'func': {
                    if (s.doc) { out.push(I + '/**'); s.doc.split('\n').forEach((l) => out.push(I + ' * ' + l.replace(/\*\//g, '* /'))); out.push(I + ' */'); }
                    const prev = fn; fn = s; out.push(I + 'function ' + safe(s.name) + '(' + s.params.map((p) => safe(p.name) + (p.def ? ' = ' + ex(p.def).s : '')).join(', ') + ') {' + post(s)); block(s.body, d + 1); out.push(I + '}'); fn = prev; return;
                }
            }
            diag('error', '不認得的敘述 ' + s.k, s);
        }
        const body = ir.body; let first = true;
        const mainOut = [];
        body.forEach((s) => { if (s.k === 'func' && !first && !(s.c && s.c.sp)) out.push(''); first = false; stmt(s, 0); });
        if (ir.entry) { out.push(''); out.push(safe(ir.entry) + '();'); }
        const hs = OPS.helperSource('nodejs', used);
        const head = hs.length ? hs.join('\n') + '\n\n' : '';
        return { code: '"use strict";\n' + head + out.join('\n') + '\n', diags, helpers: used };
    }
    return { emit };
});
