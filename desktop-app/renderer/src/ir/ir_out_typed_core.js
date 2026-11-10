/* 靜態型別大括號語言的「出」共用引擎：C++ 與 C#（核心 IR 已過 FaIrPrep.prepare → 原始碼）。純函式 UMD。
 *   FaIrOutTyped.make('cpp' | 'cs') → { emit(ir, opts) → { code, diags, helpers } }
 * 型別對照：cpp＝long long／double／bool／std::string／std::vector／std::map／std::set；cs＝long／double／bool／string／List／Dictionary／HashSet。
 * 型別未知（unknown）＝動態語言沒標註又推不出，靜態語言必須要型別 → 報 error 請使用者標註，不亂猜（同 Java 輸出器）。
 * 標準操作的樣板與輔助函式來自 ir_ops_core.js（語言鍵 cpp／cs）。輸出器沒有「看起來能編」的假設：由 ir_out_more.test.js 用真的 g++／dotnet 編譯執行驗證。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./ir_core.js'), require('./ir_ops_core.js')); else root.FaIrOutTyped = factory(root.FaIr, root.FaIrOps); })(typeof self !== 'undefined' ? self : this, function (IR, OPS) {
    'use strict';
    const PREC = { cond: 3, or: 4, and: 5, '|': 6, '^': 7, '&': 8, eq: 9, rel: 10, shift: 11, '+': 12, '-': 12, '*': 13, '/': 13, '%': 13, un: 15, atom: 20 };
    const CPP_KW = 'alignas alignof and asm auto bitand bitor bool break case catch char class compl const constexpr continue decltype default delete do double else enum explicit export extern false float for friend goto if inline int long main mutable namespace new noexcept not nullptr operator or private protected public register return short signed sizeof static struct switch template this throw true try typedef typeid typename union unsigned using virtual void volatile while xor stdin stdout stderr EOF NULL'.split(' ');
    const CS_KW = 'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while Main'.split(' ');
    const strLit = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (c) => '\\x' + ('0' + c.charCodeAt(0).toString(16)).slice(-2) + '""') + '"';

    function make(lang) {
        const CPP = lang === 'cpp'; const RES = new Set(CPP ? CPP_KW : CS_KW);
        const safe = (n) => (n === 'main' ? 'main_' : RES.has(n) ? n + '_' : n);
        function emit(ir, opts) {
            opts = opts || {}; const diags = [], used = []; let fn = null; let uid = 0;
            const diag = (level, msg, n) => diags.push({ level, msg, pos: n && n.pos });
            const useH = (hs) => hs.forEach((h) => { if (used.indexOf(h) < 0) used.push(h); });
            const wrap = (x, min) => (x.p < min ? '(' + x.s + ')' : x.s);
            const atom = (s) => (OPS.atomic(s) ? s : '(' + s + ')');
            function ty(t, n) {
                if (!t) { diag('error', '型別缺失', n); return 'auto'; }
                switch (t.t) {
                    case 'int': return CPP ? 'long long' : 'long'; case 'float': return 'double'; case 'bool': return 'bool'; case 'str': return CPP ? 'std::string' : 'string'; case 'void': return 'void';
                    case 'list': return (CPP ? 'std::vector<' : 'List<') + ty(t.a[0], n) + '>'; case 'dict': return (CPP ? 'std::map<' : 'Dictionary<') + ty(t.a[0], n) + ', ' + ty(t.a[1], n) + '>'; case 'set': return (CPP ? 'std::set<' : 'HashSet<') + ty(t.a[0], n) + '>';
                    case 'any': if (CPP) return 'JV'; diag('error', 'C# 沒有對應 any 的型別（任意型別）——請在來源標註', n); return 'auto'; // C++：json.loads 的結果用通用 JSON 值 JV
                    default: diag('error', (CPP ? 'C++' : 'C#') + ' 需要明確型別，但這裡是 ' + IR.tyStr(t) + '（動態語言沒標註又推不出）——請在來源加型別標註', n); return 'auto';
                }
            }
            const defaultOf = (t, n) => (t.t === 'int' ? (CPP ? '0' : '0L') : t.t === 'float' ? '0.0' : t.t === 'bool' ? 'false' : t.t === 'str' ? (CPP ? 'std::string()' : '""') : (t.t === 'list' || t.t === 'dict' || t.t === 'set') ? (CPP ? ty(t, n) + '()' : 'new ' + ty(t, n) + '()') : (CPP ? 'nullptr' : 'null'));
            function opCall(op, args, tys, n) {
                const r = OPS.render(op, lang, args.map((a) => ({ raw: a.s, atom: a.p >= PREC.atom ? a.s : atom(a.s) })), tys);
                if (r.code == null) { diag('error', r.missing, n); return { s: '/* 無法翻譯 ' + op + ' */ 0', p: PREC.atom }; }
                useH(r.helpers); if (CPP && op === 'conv.str' && tys && tys[0] && tys[0].t === 'any') useH(['fa_jv']); return { s: r.code, p: OPS.atomic(r.code) ? PREC.atom : PREC.cond };
            }
            function ex(e) {
                switch (e.k) {
                    case 'lit': if (e.t === 'int') return { s: e.v + (CPP ? 'LL' : 'L'), p: PREC.atom }; if (e.t === 'float') return { s: e.v, p: PREC.atom }; if (e.t === 'str') return { s: CPP ? 'std::string(' + strLit(e.v) + ')' : strLit(e.v), p: PREC.atom }; if (e.t === 'bool') return { s: e.v, p: PREC.atom }; return { s: CPP ? 'nullptr' : 'null', p: PREC.atom };
                    case 'name': return { s: safe(e.v), p: PREC.atom };
                    case 'bin': { if (CPP && ((e.l.ty && e.l.ty.t === 'any') || (e.r.ty && e.r.ty.t === 'any'))) diag('error', 'C++ 的通用 JSON 值（JV）不能直接運算，請先用 int()／float()／str() 取出具體型別', e); const p = e.op === '<<' || e.op === '>>' ? PREC.shift : PREC[e.op]; const l = ex(e.l), r = ex(e.r); return { s: wrap(l, p) + ' ' + e.op + ' ' + wrap(r, p + 1), p }; }
                    case 'un': { const x = ex(e.e); return { s: e.op + wrap(x, PREC.un), p: PREC.un }; }
                    case 'not': { const x = ex(e.e); return { s: '!' + wrap(x, PREC.un), p: PREC.un }; }
                    case 'logic': { const p = e.op === 'and' ? PREC.and : PREC.or; const l = ex(e.l), r = ex(e.r); return { s: wrap(l, p) + (e.op === 'and' ? ' && ' : ' || ') + wrap(r, p + 1), p }; }
                    case 'cmp': {
                        const l = ex(e.l), r = ex(e.r); const lt = e.l.ty && e.l.ty.t; if (CPP && !(e.r.k === 'lit' && e.r.t === 'none') && ((e.l.ty && e.l.ty.t === 'any') || (e.r.ty && e.r.ty.t === 'any'))) diag('error', 'C++ 的通用 JSON 值（JV）不能直接比較，請先用 int()／float()／str() 取出具體型別', e);
                        if (e.op === 'is' || e.op === 'is not' || (e.r.k === 'lit' && e.r.t === 'none')) return { s: wrap(l, PREC.eq + 1) + (e.op === '!=' || e.op === 'is not' ? ' != ' : ' == ') + (CPP ? 'nullptr' : 'null'), p: PREC.eq };
                        if (!CPP && ['<', '<=', '>', '>='].indexOf(e.op) >= 0 && lt === 'str') return { s: 'string.CompareOrdinal(' + l.s + ', ' + r.s + ') ' + e.op + ' 0', p: PREC.rel };
                        const p = e.op === '==' || e.op === '!=' ? PREC.eq : PREC.rel; return { s: wrap(l, p) + ' ' + e.op + ' ' + wrap(r, p + 1), p };
                    }
                    case 'cond': { const c = ex(e.c), a = ex(e.a), b = ex(e.b); return { s: wrap(c, PREC.cond + 1) + ' ? ' + wrap(a, PREC.cond) + ' : ' + wrap(b, PREC.cond), p: PREC.cond }; }
                    case 'list': { if (!e.items.length) return { s: defaultOf(e.ty || IR.list(IR.T.unknown), e), p: PREC.atom }; const t = ty(e.ty, e); return { s: (CPP ? t + '{' : 'new ' + t + ' { ') + e.items.map((x) => ex(x).s).join(', ') + (CPP ? '}' : ' }'), p: PREC.atom }; }
                    case 'dict': { if (!e.items.length) return { s: defaultOf(e.ty || IR.dict(IR.T.unknown, IR.T.unknown), e), p: PREC.atom }; const t = ty(e.ty, e); return { s: (CPP ? t + '{' : 'new ' + t + ' { ') + e.items.map((p) => '{' + ex(p[0]).s + ', ' + ex(p[1]).s + '}').join(', ') + (CPP ? '}' : ' }'), p: PREC.atom }; }
                    case 'index': {
                        const o = ex(e.o), i = ex(e.i); const t = e.o.ty && e.o.ty.t; const op = t === 'dict' ? 'dict.get' : t === 'str' ? 'str.char_at' : 'list.get'; if (!t || t === 'unknown') diag('warn', '索引的對象型別未知，當成串列', e);
                        return opCall(op, [o, i], [e.o.ty, e.i.ty], e);
                    }
                    case 'call': { const args = (e.args || []).map(ex); if (e.fn) return { s: safe(e.fn) + '(' + args.map((a) => a.s).join(', ') + ')', p: PREC.atom }; return opCall(e.op, args, (e.args || []).map((a) => a.ty), e); }
                    case 'native': diag('error', '原生區塊（' + e.lang + '）無法翻成 ' + (CPP ? 'C++' : 'C#') + '：' + e.src.split('\n')[0], e); return { s: '0 /* NATIVE ' + e.lang + ' */', p: PREC.atom };
                }
                diag('error', '不認得的運算式 ' + e.k, e); return { s: '0', p: PREC.atom };
            }
            const out = []; const ind = (d) => '    '.repeat(d);
            function pre(s, d) { if (s.c && s.c.sp) out.push(''); ((s.c && s.c.b) || []).forEach((t) => out.push(ind(d) + '// ' + t)); }
            const post = (s) => (s.c && s.c.a ? ' // ' + s.c.a : '');
            const SF = { assign: ['to', 'val'], aug: ['to', 'val'], if: ['cond'], while: ['cond'], expr: ['e'], ret: ['val'] };
            function mutated(name, body) {
                let m = false;
                IR.walkStmts(body, (s) => {
                    if ((s.k === 'assign' || s.k === 'aug') && ((s.to.k === 'name' && s.to.v === name) || (s.to.k === 'index' && s.to.o.k === 'name' && s.to.o.v === name))) m = true; if ((s.k === 'forrange' || s.k === 'foreach') && s.var === name) m = true;
                    (SF[s.k] || []).forEach((f) => { if (s[f]) IR.walkExpr(s[f], (x) => { if (x.k === 'call' && x.op && /^(list\.(append|pop|insert|sort|reverse)|dict\.(put|delete)|set\.add)$/.test(x.op) && x.args[0] && x.args[0].k === 'name' && x.args[0].v === name) m = true; }); });
                });
                return m;
            }
            function stable(e, body) { if (e.k === 'lit') return true; if (e.k === 'name') return !mutated(e.v, body); if (e.k === 'call' && e.op === 'coll.len' && e.args[0].k === 'name') return !mutated(e.args[0].v, body); if (e.k === 'bin') return stable(e.l, body) && stable(e.r, body); return false; }
            const block = (body, d) => (body || []).forEach((s) => stmt(s, d));
            function stmt(s, d) {
                pre(s, d); const I = ind(d);
                switch (s.k) {
                    case 'comment': out.push(I + '// ' + s.s); return;
                    case 'pass': case 'import': if (s.c && s.c.a) out.push(I + '// ' + s.c.a); return;
                    case 'declare': out.push(I + ty(s.ty, s) + ' ' + safe(s.name) + ' = ' + defaultOf(s.ty, s) + ';'); return;
                    case 'assign': {
                        let line;
                        if (s.to.k === 'index') { const t = s.to.o.ty && s.to.o.ty.t; line = opCall(t === 'dict' ? 'dict.put' : 'list.set', [ex(s.to.o), ex(s.to.i), ex(s.val)], [s.to.o.ty, s.to.i.ty, s.val.ty], s).s; }
                        else { const emptyLit = (s.val.k === 'list' || s.val.k === 'dict') && !s.val.items.length && (s.ty || s.val.ty); const v = emptyLit ? { s: defaultOf(s.ty || s.val.ty, s), p: 0 } : ex(s.val); line = (s.decl ? ty(s.ty || s.val.ty, s) + ' ' : '') + safe(s.to.v) + ' = ' + v.s; }
                        out.push(I + line + ';' + post(s)); return;
                    }
                    case 'aug': { const t = ex(s.to), v = ex(s.val); out.push(I + t.s + ' ' + s.op + '= ' + v.s + ';' + post(s)); return; }
                    case 'expr': out.push(I + ex(s.e).s + ';' + post(s)); return;
                    case 'ret': out.push(I + 'return' + (s.val ? ' ' + ex(s.val).s : '') + ';' + post(s)); return;
                    case 'brk': out.push(I + 'break;' + post(s)); return; case 'cont': out.push(I + 'continue;' + post(s)); return;
                    case 'raise': out.push(I + (CPP ? 'throw std::runtime_error(' : 'throw new Exception(') + (s.val ? ex(s.val).s : '"error"') + ');' + post(s)); return;
                    case 'if': {
                        out.push(I + 'if (' + ex(s.cond).s + ') {' + post(s)); block(s.then, d + 1); let cur = s;
                        while (cur.else && cur.else.length === 1 && cur.else[0].k === 'if' && !(cur.else[0].c && (cur.else[0].c.b || cur.else[0].c.sp))) { cur = cur.else[0]; out.push(I + '} else if (' + ex(cur.cond).s + ') {' + post(cur)); block(cur.then, d + 1); }
                        if (cur.else && cur.else.length) { out.push(I + '} else {'); block(cur.else, d + 1); }
                        out.push(I + '}'); return;
                    }
                    case 'while': out.push(I + 'while (' + ex(s.cond).s + ') {' + post(s)); block(s.body, d + 1); out.push(I + '}'); return;
                    case 'forrange': {
                        const v = safe(s.var); const stepLit = s.step ? (s.step.k === 'lit' ? +s.step.v : -s.step.e.v) : 1; const neg = stepLit < 0; const T = CPP ? 'long long' : 'long';
                        let to = ex(s.to); if (!stable(s.to, s.body)) { const t = '__to' + (++uid); out.push(I + (CPP ? 'const ' : '') + T + ' ' + t + ' = ' + to.s + ';'); to = { s: t, p: PREC.atom }; }
                        out.push(I + 'for (' + T + ' ' + v + ' = ' + ex(s.from).s + '; ' + v + (neg ? ' > ' : ' < ') + wrap(to, PREC.rel + 1) + '; ' + v + (stepLit === 1 ? '++' : stepLit === -1 ? '--' : ' += ' + stepLit + (CPP ? 'LL' : 'L')) + ') {' + post(s));
                        block(s.body, d + 1); out.push(I + '}'); return;
                    }
                    case 'foreach': {
                        const it = ex(s.iter); const t = s.iter.ty; const dict = t && t.t === 'dict'; const et = dict ? t.a[0] : ((fn && fn.locals && fn.locals[s.var]) || (t && t.a && t.a[0]));
                        if (dict && CPP) { out.push(I + 'for (const auto &__kv_' + safe(s.var) + ' : ' + it.s + ') {' + post(s)); out.push(ind(d + 1) + 'const ' + ty(et, s) + ' ' + safe(s.var) + ' = __kv_' + safe(s.var) + '.first;'); diag('warn', 'C++ 的 std::map 依鍵排序走訪，Python 的 dict 依插入順序', s); }
                        else if (dict) { out.push(I + 'foreach (' + ty(et, s) + ' ' + safe(s.var) + ' in ' + atom(it.s) + '.Keys.ToList()) {' + post(s)); }
                        else out.push(I + (CPP ? 'for (' + ty(et, s) + ' ' + safe(s.var) + ' : ' + it.s + ') {' : 'foreach (' + ty(et, s) + ' ' + safe(s.var) + ' in ' + it.s + ') {') + post(s));
                        block(s.body, d + 1); out.push(I + '}'); return;
                    }
                    case 'native': diag('error', '原生區塊（' + s.lang + '）無法翻成 ' + (CPP ? 'C++' : 'C#') + '：' + s.src.split('\n')[0], s); out.push(I + '/* NATIVE(' + s.lang + '):'); s.src.split('\n').forEach((l) => out.push(I + ' * ' + l.replace(/\*\//g, '* /'))); out.push(I + ' */'); out.push(I + (CPP ? 'throw std::runtime_error("untranslated native block");' : 'throw new Exception("untranslated native block");')); return;
                    case 'func': {
                        const prev = fn; fn = s;
                        if (s.doc) { out.push(I + '/**'); s.doc.split('\n').forEach((l) => out.push(I + ' * ' + l.replace(/\*\//g, '* /'))); out.push(I + ' */'); }
                        const ps = s.params.map((p) => { const t = ty(p.ty, s); const big = p.ty && ['list', 'dict', 'set', 'str'].indexOf(p.ty.t) >= 0; const pt = CPP && big ? (mutated(p.name, s.body) ? t + ' &' : 'const ' + t + ' &') : t + ' '; return (CPP && big ? pt : pt) + safe(p.name); });
                        out.push(I + 'static ' + ty(s.ret || IR.T.void, s) + ' ' + safe(s.name) + '(' + ps.join(', ') + ') {' + post(s)); block(s.body, d + 1); out.push(I + '}'); fn = prev; return;
                    }
                }
                diag('error', '不認得的敘述 ' + s.k, s);
            }
            let first = true; const d0 = CPP ? 0 : 1;
            ir.body.forEach((s) => {
                if (s.k === 'func') { if (!first && !(s.c && s.c.sp)) out.push(''); first = false; stmt(s, d0); return; }
                if (s.k === 'comment' || s.k === 'pass' || s.k === 'import') { stmt(s, d0); return; }
                if (s.k === 'assign' && s.to.k === 'name') { pre(s, d0); out.push(ind(d0) + 'static ' + ty(s.ty || s.val.ty, s) + ' ' + safe(s.to.v) + ' = ' + ex(s.val).s + ';' + post(s)); return; }
                diag('error', '模組層的 ' + s.k + ' 敘述尚未支援', s);
            });
            const hs = OPS.helperSource(lang, used); const lines = [];
            if (CPP) {
                lines.push('#include <iostream>', '#include <string>', '#include <vector>', '#include <map>', '#include <set>', '#include <algorithm>', '#include <numeric>', '#include <cmath>', '#include <cstdlib>', '#include <cstdio>', '#include <cctype>', '#include <sstream>', '#include <stdexcept>', '#include <iterator>', '#include <random>', '#include <chrono>', '#include <fstream>', '');
                hs.forEach((h) => lines.push(h)); if (hs.length) lines.push(''); out.forEach((l) => lines.push(l));
                if (ir.entry) { lines.push(''); lines.push('int main() {'); lines.push('    std::ios::sync_with_stdio(false);'); lines.push('    ' + safe(ir.entry) + '();'); lines.push('    return 0;'); lines.push('}'); }
            } else {
                lines.push('using System;', 'using System.Collections.Generic;', 'using System.Linq;', 'using System.Text;', '', 'public class ' + (opts.className || 'Program'), '{');
                hs.forEach((h) => lines.push('    ' + h)); if (hs.length) lines.push(''); out.forEach((l) => lines.push(l));
                if (ir.entry) { lines.push(''); lines.push('    public static void ' + (opts.entryName || 'Main') + '()'); lines.push('    {'); lines.push('        ' + safe(ir.entry) + '();'); lines.push('    }'); }
                lines.push('}');
            }
            return { code: lines.join('\n') + '\n', diags, helpers: used };
        }
        return { emit };
    }
    return { make };
});
