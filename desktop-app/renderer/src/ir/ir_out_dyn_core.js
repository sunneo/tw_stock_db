/* 動態語言（Perl、Ruby）的「出」共用引擎：核心 IR（已過 FaIrPrep.prepare）→ 原始碼。純函式 UMD。
 *   FaIrOutDyn.make('perl' | 'ruby') → { emit(ir, opts) → { code, diags, helpers } }
 * Perl：所有變數都是純量（串列／字典用參考 [] 與 {}，取值 $a->[i]、$d->{k}）；比較依型別選 == 或 eq；使用者函式名與內建函式同名時加底線。
 * Ruby：用 for…in 走訪（不開新作用域，迴圈變數離開後仍在，和 Python 一致）；步長用 step。
 * 標準操作的樣板與輔助函式來自 ir_ops_core.js（語言鍵 pl／rb）。Perl 由 ir_out_more.test.js 用真的 perl 實跑；Ruby 這台沒有直譯器，
 * 測試只用 tree-sitter 的 ruby 文法檢查語法（沒有 ERROR 節點），不算實跑。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./ir_core.js'), require('./ir_ops_core.js')); else root.FaIrOutDyn = factory(root.FaIr, root.FaIrOps); })(typeof self !== 'undefined' ? self : this, function (IR, OPS) {
    'use strict';
    const PREC = { cond: 3, or: 4, and: 5, '|': 6, '^': 7, '&': 8, eq: 9, rel: 10, shift: 11, '+': 12, '-': 12, '*': 13, '/': 13, '%': 13, un: 15, atom: 20 };
    const PL_RES = 'abs and atan2 binmode bless caller chomp chop chr close cmp cos defined delete die do each else elsif eof eq eval exec exists exit exp for foreach ge getc glob grep gt hex if index int join keys last lc lcfirst le length local log lt m map my ne next no not oct open or ord our pop pos print printf push q qq qw qr rand redo ref require return reverse rindex s say scalar shift sin sleep sort splice split sprintf sqrt srand sub substr tr uc ucfirst undef unless unshift until use values wait wantarray warn while x xor y main'.split(' ');
    const RB_RES = 'BEGIN END alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield puts print p gets format open sleep rand exit fail loop lambda proc select test system require load raise main'.split(' ');
    const dq = (s, perl) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(perl ? /[$@]/g : /#(?=[{$@])/g, (c) => '\\' + c).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (c) => '\\x' + ('0' + c.charCodeAt(0).toString(16)).slice(-2)) + '"';

    function make(lang) {
        const PL = lang === 'perl'; const key = PL ? 'perl' : 'ruby'; const RES = new Set(PL ? PL_RES : RB_RES);
        const safe = (n) => (RES.has(n) ? n + '_' : n);
        const v = (n) => (PL ? '$' + safe(n) : safe(n));         // 變數名
        function emit(ir) {
            const diags = [], used = []; let fn = null; let uid = 0;
            const diag = (level, msg, n) => diags.push({ level, msg, pos: n && n.pos });
            const useH = (hs) => hs.forEach((h) => { if (used.indexOf(h) < 0) used.push(h); });
            const wrap = (x, min) => (x.p < min ? '(' + x.s + ')' : x.s);
            const atom = (s) => (OPS.atomic(s) ? s : '(' + s + ')');
            const defaultOf = (t) => (!t ? 'nil' : t.t === 'int' ? '0' : t.t === 'float' ? '0.0' : t.t === 'bool' ? 'false' : t.t === 'str' ? '""' : t.t === 'list' ? '[]' : t.t === 'dict' ? '{}' : t.t === 'set' ? (PL ? '{}' : 'Set.new') : (PL ? 'undef' : 'nil'));
            function opCall(op, args, tys, n) {
                const r = OPS.render(op, key === 'perl' ? 'perl' : 'ruby', args.map((a) => ({ raw: a.s, atom: a.p >= PREC.atom ? a.s : atom(a.s) })), tys);
                if (r.code == null) { diag('error', r.missing, n); return { s: '(undef) /* 無法翻譯 ' + op + ' */', p: PREC.atom }; }
                useH(r.helpers); return { s: r.code, p: OPS.atomic(r.code) ? PREC.atom : PREC.cond };
            }
            const isStr = (e) => e.ty && e.ty.t === 'str';
            function ex(e) {
                switch (e.k) {
                    case 'lit': if (e.t === 'int' || e.t === 'float') return { s: e.v, p: PREC.atom }; if (e.t === 'str') return { s: dq(e.v, PL), p: PREC.atom }; if (e.t === 'bool') return { s: PL ? (e.v === 'true' ? '1' : '0') : e.v, p: PREC.atom }; return { s: PL ? 'undef' : 'nil', p: PREC.atom };
                    case 'name': return { s: v(e.v), p: PREC.atom };
                    case 'bin': { const p = e.op === '<<' || e.op === '>>' ? PREC.shift : PREC[e.op]; const l = ex(e.l), r = ex(e.r); const op = PL && e.op === '+' && (isStr(e.l) || isStr(e.r)) ? '.' : e.op; return { s: wrap(l, p) + ' ' + op + ' ' + wrap(r, p + 1), p }; }
                    case 'un': { const x = ex(e.e); return { s: e.op + wrap(x, PREC.un), p: PREC.un }; }
                    case 'not': { const x = ex(e.e); return { s: '!' + wrap(x, PREC.un), p: PREC.un }; }
                    case 'logic': { const p = e.op === 'and' ? PREC.and : PREC.or; const l = ex(e.l), r = ex(e.r); return { s: wrap(l, p) + (e.op === 'and' ? ' && ' : ' || ') + wrap(r, p + 1), p }; }
                    case 'cmp': {
                        const l = ex(e.l), r = ex(e.r); let op = e.op;
                        if (e.op === 'is' || e.op === 'is not' || (e.r.k === 'lit' && e.r.t === 'none')) return { s: PL ? (e.op === '!=' || e.op === 'is not' ? 'defined(' + l.s + ')' : '!defined(' + l.s + ')') : wrap(l, PREC.eq + 1) + (e.op === '!=' || e.op === 'is not' ? ' != ' : ' == ') + 'nil', p: PREC.atom };
                        if (PL && (isStr(e.l) || isStr(e.r))) op = { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' }[op] || op;
                        const p = e.op === '==' || e.op === '!=' ? PREC.eq : PREC.rel; return { s: wrap(l, p) + ' ' + op + ' ' + wrap(r, p + 1), p };
                    }
                    case 'cond': { const c = ex(e.c), a = ex(e.a), b = ex(e.b); return { s: wrap(c, PREC.cond + 1) + ' ? ' + wrap(a, PREC.cond) + ' : ' + wrap(b, PREC.cond), p: PREC.cond }; }
                    case 'list': return { s: '[' + e.items.map((x) => ex(x).s).join(', ') + ']', p: PREC.atom };
                    case 'dict': return { s: '{' + e.items.map((p) => ex(p[0]).s + (PL ? ' => ' : ' => ') + ex(p[1]).s).join(', ') + '}', p: PREC.atom };
                    case 'index': { const o = ex(e.o), i = ex(e.i); const t = e.o.ty && e.o.ty.t; const op = t === 'dict' ? 'dict.get' : t === 'str' ? 'str.char_at' : 'list.get'; if (!t || t === 'unknown') diag('warn', '索引的對象型別未知，當成串列', e); return opCall(op, [o, i], [e.o.ty, e.i.ty], e); }
                    case 'call': { const args = (e.args || []).map(ex); if (e.fn) return { s: PL ? '&' + safe(e.fn) + '(' + args.map((a) => a.s).join(', ') + ')' : safe(e.fn) + '(' + args.map((a) => a.s).join(', ') + ')', p: PREC.atom }; return opCall(e.op, args, (e.args || []).map((a) => a.ty), e); }
                    case 'native': diag('error', '原生區塊（' + e.lang + '）無法翻成 ' + (PL ? 'Perl' : 'Ruby') + '：' + e.src.split('\n')[0], e); return { s: (PL ? 'undef' : 'nil') + ' # NATIVE ' + e.lang, p: PREC.atom };
                }
                diag('error', '不認得的運算式 ' + e.k, e); return { s: PL ? 'undef' : 'nil', p: PREC.atom };
            }
            const out = []; const ind = (d) => '    '.repeat(d);
            function pre(s, d) { if (s.c && s.c.sp) out.push(''); ((s.c && s.c.b) || []).forEach((t) => out.push(ind(d) + '# ' + t)); }
            const post = (s) => (s.c && s.c.a ? ' # ' + s.c.a : '');
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
            const block = (body, d) => (body || []).forEach((s) => stmt(s, d));
            const open = (I, head, s) => out.push(I + head + (PL ? ' {' : '') + post(s));
            const close = (I) => out.push(I + (PL ? '}' : 'end'));
            function stmt(s, d) {
                pre(s, d); const I = ind(d); const semi = PL ? ';' : '';
                switch (s.k) {
                    case 'comment': out.push(I + '# ' + s.s); return;
                    case 'pass': case 'import': if (s.c && s.c.a) out.push(I + '# ' + s.c.a); return;
                    case 'declare': out.push(I + (PL ? 'my ' : '') + v(s.name) + ' = ' + defaultOf(s.ty) + semi); return;
                    case 'assign': {
                        let line;
                        if (s.to.k === 'index') { const t = s.to.o.ty && s.to.o.ty.t; line = opCall(t === 'dict' ? 'dict.put' : 'list.set', [ex(s.to.o), ex(s.to.i), ex(s.val)], [s.to.o.ty, s.to.i.ty, s.val.ty], s).s; }
                        else line = (PL && s.decl ? 'my ' : '') + v(s.to.v) + ' = ' + ex(s.val).s;
                        out.push(I + line + semi + post(s)); return;
                    }
                    case 'aug': { const t = ex(s.to), x = ex(s.val); const op = PL && s.op === '+' && isStr(s.to) ? '.' : s.op; out.push(I + t.s + ' ' + op + '= ' + x.s + semi + post(s)); return; }
                    case 'expr': out.push(I + ex(s.e).s + semi + post(s)); return;
                    case 'ret': out.push(I + 'return' + (s.val ? ' ' + ex(s.val).s : '') + semi + post(s)); return;
                    case 'brk': out.push(I + (PL ? 'last;' : 'break') + post(s)); return; case 'cont': out.push(I + (PL ? 'next;' : 'next') + post(s)); return;
                    case 'raise': out.push(I + (PL ? 'die(' : 'raise ') + (s.val ? ex(s.val).s : '"error"') + (PL ? ');' : '') + post(s)); return;
                    case 'if': {
                        open(I, 'if ' + (PL ? '(' + ex(s.cond).s + ')' : ex(s.cond).s), s); block(s.then, d + 1); let cur = s;
                        while (cur.else && cur.else.length === 1 && cur.else[0].k === 'if' && !(cur.else[0].c && (cur.else[0].c.b || cur.else[0].c.sp))) { cur = cur.else[0]; out.push(I + (PL ? '} elsif (' + ex(cur.cond).s + ') {' : 'elsif ' + ex(cur.cond).s) + post(cur)); block(cur.then, d + 1); }
                        if (cur.else && cur.else.length) { out.push(I + (PL ? '} else {' : 'else')); block(cur.else, d + 1); }
                        close(I); return;
                    }
                    case 'while': open(I, 'while ' + (PL ? '(' + ex(s.cond).s + ')' : ex(s.cond).s), s); block(s.body, d + 1); close(I); return;
                    case 'forrange': {
                        const name = v(s.var); const stepLit = s.step ? (s.step.k === 'lit' ? +s.step.v : -s.step.e.v) : 1; const neg = stepLit < 0;
                        let to = ex(s.to); if (!stable(s.to, s.body)) { const t = (PL ? '$' : '') + '__to' + (++uid); out.push(I + (PL ? 'my ' : '') + t + ' = ' + to.s + semi); to = { s: t, p: PREC.atom }; }
                        if (PL) out.push(I + 'for (my ' + name + ' = ' + ex(s.from).s + '; ' + name + (neg ? ' > ' : ' < ') + wrap(to, PREC.rel + 1) + '; ' + name + (stepLit === 1 ? '++' : stepLit === -1 ? '--' : ' += ' + stepLit) + ') {' + post(s));
                        else { const f = ex(s.from).s; const rng = neg ? f + '.step(' + wrap(to, PREC.un) + ' + 1, ' + stepLit + ')' : stepLit === 1 ? '(' + f + '...' + to.s + ')' : '(' + f + '...' + to.s + ').step(' + stepLit + ')'; out.push(I + 'for ' + name + ' in ' + rng + post(s)); }
                        block(s.body, d + 1); close(I); return;
                    }
                    case 'foreach': {
                        const it = ex(s.iter); const dict = s.iter.ty && s.iter.ty.t === 'dict';
                        if (PL) { out.push(I + 'for my ' + v(s.var) + ' (' + (dict ? 'keys %{' + it.s + '}' : '@{' + it.s + '}') + ') {' + post(s)); if (dict) diag('warn', 'Perl 的雜湊沒有固定順序，Python 的 dict 依插入順序', s); }
                        else out.push(I + 'for ' + v(s.var) + ' in ' + (dict ? atom(it.s) + '.keys' : it.s) + post(s));
                        block(s.body, d + 1); close(I); return;
                    }
                    case 'native': diag('error', '原生區塊（' + s.lang + '）無法翻成 ' + (PL ? 'Perl' : 'Ruby') + '：' + s.src.split('\n')[0], s); s.src.split('\n').forEach((l) => out.push(I + '# NATIVE(' + s.lang + '): ' + l)); out.push(I + (PL ? 'die("untranslated native block");' : 'raise "untranslated native block"')); return;
                    case 'func': {
                        const prev = fn; fn = s; (s.doc ? s.doc.split('\n') : []).forEach((l) => out.push(I + '# ' + l));
                        if (PL) { out.push(I + 'sub ' + safe(s.name) + ' {' + post(s)); if (s.params.length) out.push(ind(d + 1) + 'my (' + s.params.map((p) => v(p.name)).join(', ') + ') = @_;'); }
                        else out.push(I + 'def ' + safe(s.name) + (s.params.length ? '(' + s.params.map((p) => safe(p.name)).join(', ') + ')' : '') + post(s));
                        block(s.body, d + 1); close(I); fn = prev; return;
                    }
                }
                diag('error', '不認得的敘述 ' + s.k, s);
            }
            let first = true;
            ir.body.forEach((s) => { if (s.k === 'func' && !first && !(s.c && s.c.sp)) out.push(''); first = false; stmt(s, 0); });
            if (ir.entry) { out.push(''); out.push(PL ? '&' + safe(ir.entry) + '();' : safe(ir.entry)); }
            const hs = OPS.helperSource(key, used); const head = PL ? ['use strict;', 'use warnings;', 'use POSIX ();', 'use List::Util ();', ''] : [];
            return { code: head.concat(hs, hs.length ? [''] : [], out).join('\n') + '\n', diags, helpers: used };
        }
        return { emit };
    }
    return { make };
});
