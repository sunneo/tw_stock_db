/* Java「出」：核心 IR（已過 FaIrPrep.prepare）→ 原始碼（單一檔案、類別 Main、靜態方法）。純函式 UMD，Java 專屬。
 *   emit(ir, {asciiComments}) → { code, diags, helpers }
 * 型別對照：int→long、float→double、bool→boolean、str→String、list<T>→List<包裝型別>、dict<K,V>→Map<K,V>（LinkedHashMap，保留插入順序）。
 * 型別未知（unknown）＝動態語言沒標註又推不出，靜態語言必須要型別 → 報 error 請使用者標註，不亂猜。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./ir_core.js'), require('./ir_ops_core.js')); else root.FaIrOutJava = factory(root.FaIr, root.FaIrOps); })(typeof self !== 'undefined' ? self : this, function (IR, OPS) {
    'use strict';
    const RESERVED = new Set(['abstract', 'assert', 'boolean', 'byte', 'case', 'catch', 'char', 'class', 'const', 'default', 'do', 'double', 'enum', 'extends', 'final', 'finally', 'float', 'goto', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'null', 'true', 'false', 'String', 'List', 'Map', 'Math', 'System', 'Long', 'Object', 'Main']);
    const safe = (n) => (RESERVED.has(n) ? n + '_' : n);
    const PREC = { cond: 3, or: 4, and: 5, '|': 6, '^': 7, '&': 8, eq: 9, rel: 10, shift: 11, '+': 12, '-': 12, '*': 13, '/': 13, '%': 13, un: 15, atom: 20 };
    const BOX = { long: 'Long', double: 'Double', boolean: 'Boolean' };
    const javaStr = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/[^\x20-\x7e]/g, (c) => { const x = c.charCodeAt(0).toString(16); return '\\u' + '0000'.slice(x.length) + x; }) + '"';

    function emit(ir, opts) {
        opts = opts || {}; const diags = [], used = []; let fn = null;
        // javac 預設用平台編碼讀原始檔（Windows 繁中是 Big5），註解裡的非 ASCII 字元要逸出成 \uXXXX 才在任何環境都能編譯；產品端若固定傳 -encoding UTF-8，可關掉 asciiComments
        const cm = (s) => (opts.asciiComments === false ? String(s) : String(s).replace(/\\u/g, '\\u005cu').replace(/[^\x20-\x7e]/g, (c) => { const x = c.charCodeAt(0).toString(16); return '\\u' + '0000'.slice(x.length) + x; }));
        const diag = (level, msg, n) => diags.push({ level, msg, pos: n && n.pos });
        const useH = (hs) => hs.forEach((h) => { if (used.indexOf(h) < 0) used.push(h); });
        const wrap = (x, min) => (x.p < min ? '(' + x.s + ')' : x.s);
        const atom = (s) => (OPS.atomic(s) ? s : '(' + s + ')');
        function ty(t, boxed, n) {
            if (!t) { diag('error', '型別缺失', n); return 'Object'; }
            switch (t.t) {
                case 'int': return boxed ? 'Long' : 'long'; case 'float': return boxed ? 'Double' : 'double'; case 'bool': return boxed ? 'Boolean' : 'boolean'; case 'str': return 'String'; case 'void': return 'void';
                case 'list': return 'List<' + ty(t.a[0], true, n) + '>'; case 'dict': return 'Map<' + ty(t.a[0], true, n) + ', ' + ty(t.a[1], true, n) + '>'; case 'set': return 'Set<' + ty(t.a[0], true, n) + '>';
                case 'any': return 'Object';
                default: diag('error', 'Java 需要明確型別，但這裡是 ' + IR.tyStr(t) + '（動態語言沒標註又推不出）——請在來源加型別標註', n); return 'Object';
            }
        }
        const defaultOf = (t) => (t.t === 'int' ? '0L' : t.t === 'float' ? '0.0' : t.t === 'bool' ? 'false' : t.t === 'str' ? '""' : t.t === 'list' ? 'new ArrayList<>()' : t.t === 'dict' ? 'new LinkedHashMap<>()' : t.t === 'set' ? 'new HashSet<>()' : 'null');
        const unbox = (x, t) => (t && (t.t === 'int' || t.t === 'float' || t.t === 'bool') ? { s: '((' + (t.t === 'int' ? 'long' : t.t === 'float' ? 'double' : 'boolean') + ') ' + atom(x.s) + ')', p: PREC.atom } : x);

        function opCall(op, args, tys, n) {
            const r = OPS.render(op, 'java', args.map((a) => ({ raw: a.s, atom: a.p >= PREC.atom ? a.s : atom(a.s) })), tys);
            if (r.code == null) { diag('error', r.missing, n); return { s: '/* 無法翻譯 ' + op + ' */ null', p: PREC.atom }; }
            useH(r.helpers); return { s: r.code, p: OPS.atomic(r.code) ? PREC.atom : PREC.cond };
        }
        function ex(e) {
            switch (e.k) {
                case 'lit':
                    if (e.t === 'int') return { s: e.v + 'L', p: PREC.atom }; if (e.t === 'float') return { s: e.v, p: PREC.atom }; if (e.t === 'str') return { s: javaStr(e.v), p: PREC.atom }; if (e.t === 'bool') return { s: e.v, p: PREC.atom }; return { s: 'null', p: PREC.atom };
                case 'name': return { s: safe(e.v), p: PREC.atom };
                case 'bin': { const p = e.op === '<<' || e.op === '>>' ? PREC.shift : PREC[e.op]; const l = ex(e.l), r = ex(e.r); return { s: wrap(l, p) + ' ' + e.op + ' ' + wrap(r, p + 1), p }; }
                case 'un': { const x = ex(e.e); return { s: e.op + wrap(x, PREC.un), p: PREC.un }; }
                case 'not': { const x = ex(e.e); return { s: '!' + wrap(x, PREC.un), p: PREC.un }; }
                case 'logic': { const p = e.op === 'and' ? PREC.and : PREC.or; const l = ex(e.l), r = ex(e.r); return { s: wrap(l, p) + (e.op === 'and' ? ' && ' : ' || ') + wrap(r, p + 1), p }; }
                case 'cmp': {
                    const l = ex(e.l), r = ex(e.r); const lt = e.l.ty && e.l.ty.t, rt = e.r.ty && e.r.ty.t;
                    if (e.op === 'is' || e.op === 'is not' || (e.r.k === 'lit' && e.r.t === 'none')) return { s: wrap(l, PREC.eq + 1) + (e.op === '!=' || e.op === 'is not' ? ' != ' : ' == ') + 'null', p: PREC.eq };
                    if (['==', '!='].indexOf(e.op) >= 0 && (lt === 'str' || lt === 'list' || lt === 'dict' || lt === 'set')) { const eq = atom(l.s) + '.equals(' + r.s + ')'; return { s: e.op === '==' ? eq : '!' + eq, p: e.op === '==' ? PREC.atom : PREC.un }; }
                    if (['<', '<=', '>', '>='].indexOf(e.op) >= 0 && lt === 'str') return { s: atom(l.s) + '.compareTo(' + r.s + ') ' + e.op + ' 0', p: PREC.rel };
                    const p = e.op === '==' || e.op === '!=' ? PREC.eq : PREC.rel; return { s: wrap(l, p) + ' ' + e.op + ' ' + wrap(r, p + 1), p };
                }
                case 'cond': { const c = ex(e.c), a = ex(e.a), b = ex(e.b); return { s: wrap(c, PREC.cond + 1) + ' ? ' + wrap(a, PREC.cond) + ' : ' + wrap(b, PREC.cond), p: PREC.cond }; }
                case 'list': {
                    if (!e.items.length) return { s: 'new ArrayList<>()', p: PREC.atom };
                    return { s: 'new ArrayList<>(Arrays.asList(' + e.items.map((x) => ex(x).s).join(', ') + '))', p: PREC.atom };
                }
                case 'dict': if (!e.items.length) return { s: 'new LinkedHashMap<>()', p: PREC.atom }; diag('error', '非空字典字面值尚未支援（Java 沒有保持順序的字面值）', e); return { s: 'null', p: PREC.atom };
                case 'index': {
                    const o = ex(e.o), i = ex(e.i); const t = e.o.ty && e.o.ty.t;
                    const op = t === 'dict' ? 'dict.get' : t === 'str' ? 'str.char_at' : 'list.get'; if (!t || t === 'unknown') diag('warn', '索引的對象型別未知，當成串列', e);
                    const r = opCall(op, [o, i], [e.o.ty, e.i.ty], e); return t === 'str' ? r : unbox(r, e.ty);
                }
                case 'call': {
                    const args = (e.args || []).map(ex);
                    if (e.fn) return { s: safe(e.fn) + '(' + args.map((a) => a.s).join(', ') + ')', p: PREC.atom };
                    const r = opCall(e.op, args, (e.args || []).map((a) => a.ty), e);
                    return /^(list\.pop|dict\.get_default|list\.min|list\.max)$/.test(e.op) ? unbox(r, e.ty) : r;
                }
                case 'native': diag('error', '原生區塊（' + e.lang + '）無法翻成 Java：' + e.src.split('\n')[0], e); return { s: 'null /* NATIVE ' + e.lang + ' */', p: PREC.atom };
            }
            diag('error', '不認得的運算式 ' + e.k, e); return { s: 'null', p: PREC.atom };
        }

        const out = []; const ind = (d) => '    '.repeat(d);
        function pre(s, d) { if (s.c && s.c.sp) out.push(''); ((s.c && s.c.b) || []).forEach((t) => out.push(ind(d) + '// ' + cm(t))); }
        const post = (s) => (s.c && s.c.a ? ' // ' + cm(s.c.a) : '');
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
                case 'comment': out.push(I + '// ' + cm(s.s)); return;
                case 'pass': case 'import': if (s.c && s.c.a) out.push(I + '// ' + cm(s.c.a)); return;
                case 'declare': out.push(I + ty(s.ty, false, s) + ' ' + safe(s.name) + ' = ' + defaultOf(s.ty) + ';'); return;
                case 'assign': {
                    let line;
                    if (s.to.k === 'index') { const t = s.to.o.ty && s.to.o.ty.t; line = opCall(t === 'dict' ? 'dict.put' : 'list.set', [ex(s.to.o), ex(s.to.i), ex(s.val)], [s.to.o.ty, s.to.i.ty, s.val.ty], s).s; }
                    else { let v = ex(s.val); if (s.val.k === 'list' && !s.val.items.length || (s.val.k === 'dict' && !s.val.items.length)) v = { s: defaultOf(s.ty || s.val.ty), p: 0 }; line = (s.decl ? ty(s.ty, false, s) + ' ' : '') + safe(s.to.v) + ' = ' + v.s; }
                    out.push(I + line + ';' + post(s)); return;
                }
                case 'aug': {
                    const t = ex(s.to), v = ex(s.val);
                    if (s.to.k === 'index') { const tt = s.to.o.ty && s.to.o.ty.t; const cur = ex(s.to); const nv = cur.s + ' ' + s.op + ' ' + wrap(v, PREC[s.op] + 1); out.push(I + opCall(tt === 'dict' ? 'dict.put' : 'list.set', [ex(s.to.o), ex(s.to.i), { s: nv, p: PREC[s.op] }], [s.to.o.ty, s.to.i.ty, s.val.ty], s).s + ';' + post(s)); return; }
                    out.push(I + t.s + ' ' + s.op + '= ' + v.s + ';' + post(s)); return;
                }
                case 'expr': out.push(I + ex(s.e).s + ';' + post(s)); return;
                case 'ret': out.push(I + 'return' + (s.val ? ' ' + ex(s.val).s : '') + ';' + post(s)); return;
                case 'brk': out.push(I + 'break;' + post(s)); return; case 'cont': out.push(I + 'continue;' + post(s)); return;
                case 'raise': out.push(I + 'throw new RuntimeException(' + (s.val ? ex(s.val).s : '"error"') + ');' + post(s)); return;
                case 'if': {
                    out.push(I + 'if (' + ex(s.cond).s + ') {' + post(s)); block(s.then, d + 1); let cur = s;
                    while (cur.else && cur.else.length === 1 && cur.else[0].k === 'if' && !(cur.else[0].c && (cur.else[0].c.b || cur.else[0].c.sp))) { cur = cur.else[0]; out.push(I + '} else if (' + ex(cur.cond).s + ') {' + post(cur)); block(cur.then, d + 1); }
                    if (cur.else && cur.else.length) { out.push(I + '} else {'); block(cur.else, d + 1); }
                    out.push(I + '}'); return;
                }
                case 'while': out.push(I + 'while (' + ex(s.cond).s + ') {' + post(s)); block(s.body, d + 1); out.push(I + '}'); return;
                case 'forrange': {
                    const v = safe(s.var); const stepLit = s.step ? (s.step.k === 'lit' ? +s.step.v : -s.step.e.v) : 1; const neg = stepLit < 0;
                    let to = ex(s.to); if (!stable(s.to, s.body)) { const t = '__to' + (++uid); out.push(I + 'final long ' + t + ' = ' + to.s + ';'); to = { s: t, p: PREC.atom }; }
                    out.push(I + 'for (long ' + v + ' = ' + ex(s.from).s + '; ' + v + (neg ? ' > ' : ' < ') + wrap(to, PREC.rel + 1) + '; ' + v + (stepLit === 1 ? '++' : stepLit === -1 ? '--' : ' += ' + stepLit + 'L') + ') {' + post(s));
                    block(s.body, d + 1); out.push(I + '}'); return;
                }
                case 'foreach': {
                    const it = ex(s.iter); const t = s.iter.ty; let et = (fn && fn.locals && fn.locals[s.var]) || (t && t.a && t.a[0]);
                    const dict = t && t.t === 'dict'; out.push(I + 'for (' + ty(et, false, s) + ' ' + safe(s.var) + ' : ' + (dict ? atom(it.s) + '.keySet()' : it.s) + ') {' + post(s)); block(s.body, d + 1); out.push(I + '}'); return;
                }
                case 'native': diag('error', '原生區塊（' + s.lang + '）無法翻成 Java：' + s.src.split('\n')[0], s); out.push(I + '/* NATIVE(' + s.lang + '):'); s.src.split('\n').forEach((l) => out.push(I + ' * ' + l.replace(/\*\//g, '* /'))); out.push(I + ' */'); out.push(I + 'throw new RuntimeException("untranslated native block");'); return;
                case 'func': {
                    const prev = fn; fn = s;
                    if (s.doc) { out.push(I + '/**'); s.doc.split('\n').forEach((l) => out.push(I + ' * ' + cm(l.replace(/\*\//g, '* /')))); out.push(I + ' */'); }
                    out.push(I + 'static ' + ty(s.ret || IR.T.void, false, s) + ' ' + safe(s.name) + '(' + s.params.map((p) => ty(p.ty, false, s) + ' ' + safe(p.name)).join(', ') + ') {' + post(s)); block(s.body, d + 1); out.push(I + '}'); fn = prev; return;
                }
            }
            diag('error', '不認得的敘述 ' + s.k, s);
        }
        let first = true;
        ir.body.forEach((s) => {
            if (s.k === 'func') { if (!first && !(s.c && s.c.sp)) out.push(''); first = false; stmt(s, 1); return; }
            if (s.k === 'comment' || s.k === 'pass' || s.k === 'import') { stmt(s, 1); return; }
            if (s.k === 'assign' && s.to.k === 'name') { pre(s, 1); out.push('    static ' + ty(s.ty || s.val.ty, false, s) + ' ' + safe(s.to.v) + ' = ' + ex(s.val).s + ';' + post(s)); return; }
            diag('error', '模組層的 ' + s.k + ' 敘述尚未支援', s);
        });
        const hs = OPS.helperSource('java', used);
        const lines = ['import java.io.*;', 'import java.util.*;', '', 'public class Main {'];
        hs.forEach((h) => h.split('\n').forEach((l) => lines.push('    ' + l.replace(/^    /, ''))));
        if (hs.length) lines.push('');
        out.forEach((l) => lines.push(l));
        if (ir.entry) { lines.push(''); lines.push('    public static void main(String[] args) {'); lines.push('        ' + safe(ir.entry) + '();'); lines.push('    }'); }
        lines.push('}'); return { code: lines.join('\n') + '\n', diags, helpers: used };
    }
    return { emit };
});
