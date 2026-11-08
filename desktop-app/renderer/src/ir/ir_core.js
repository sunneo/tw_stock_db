/* 核心中間語言（Core IR）：語言中立、保留結構化控制流／運算式／型別／註解的程式樹（JSON）。純函式 UMD，不碰 I/O。
 * 設計見 DESIGN.core-ir.md。各語言的「進」（原始碼→IR）與「出」（IR→原始碼）各自獨立成檔，只有這一層（IR 本身、標準操作目錄、型別推斷）共用。
 *
 *   IR 形狀：{ ir:'fa-core-ir', v:1, src:{lang, file?}, name, imports:[...], body:[節點], entry?:函式名 }
 *   節點共通欄位：k（種類）、pos:[起行,起欄,迄行,迄欄]（原檔位置，1 起算行、0 起算欄；選用）、c:{b:[前置註解…], a:行尾註解, sp:前面空行數}（trivia，選用）
 *   宣告／敘述：func{name,params:[{name,ty,def?}],ret,doc?,body}  assign{to,val,decl?,ty?}  aug{to,op,val}  if{cond,then,else}
 *              while{cond,body}  forrange{var,from,to,step,body}  foreach{var,iter,body}  ret{val?}  brk  cont  pass  expr{e}
 *              raise{val?}  comment{s}（獨立成行的註解）  native{lang,src,why}（原樣保留的原生區塊／運算式，不翻譯）
 *   運算式：lit{t:int|float|str|bool|none,v}  name{v}  bin{op,l,r}  un{op,e}  cmp{op,l,r}  logic{op:and|or,l,r}  not{e}
 *          index{o,i}  call{op,args}（標準操作，op 是目錄 id，接收者是 args[0]）  call{fn,args}（使用者函式）
 *          list{items}  dict{items:[[k,v]…]}  cond{c,a,b}  native{lang,src}
 *   型別 ty：{t:'int'|'float'|'str'|'bool'|'void'|'any'|'unknown'} 或 {t:'list'|'dict'|'set'|'tuple', a:[…]}；unknown＝動態語言沒標註且推不出，any＝明確的任意型別 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaIr = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const VERSION = 1;
    const STMT = ['func', 'assign', 'aug', 'if', 'while', 'forrange', 'foreach', 'ret', 'brk', 'cont', 'pass', 'expr', 'raise', 'comment', 'native', 'declare'];
    const EXPR = ['lit', 'name', 'bin', 'un', 'cmp', 'logic', 'not', 'index', 'call', 'list', 'dict', 'cond', 'native'];
    const PRIM = ['int', 'float', 'str', 'bool', 'void', 'any', 'unknown'], GEN = ['list', 'dict', 'set', 'tuple'];
    const BINOPS = ['+', '-', '*', '/', '//', '%', '**', '&', '|', '^', '<<', '>>'], CMPOPS = ['==', '!=', '<', '<=', '>', '>=', 'in', 'not in', 'is', 'is not'];

    const T = { int: { t: 'int' }, float: { t: 'float' }, str: { t: 'str' }, bool: { t: 'bool' }, void: { t: 'void' }, any: { t: 'any' }, unknown: { t: 'unknown' } };
    const list = (e) => ({ t: 'list', a: [e || T.unknown] }), dict = (k, v) => ({ t: 'dict', a: [k || T.unknown, v || T.unknown] }), set = (e) => ({ t: 'set', a: [e || T.unknown] });
    const tyEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const tyStr = (t) => !t ? '?' : (t.a ? t.t + '<' + t.a.map(tyStr).join(',') + '>' : t.t);
    // 'list<int>'、'dict<str,list<int>>' → 型別；沒寫或不認得 → unknown
    function tyParse(s) {
        s = String(s).replace(/\s+/g, ''); let i = 0;
        const one = () => { const m = /^[a-z_]+/.exec(s.slice(i)); if (!m) return T.unknown; i += m[0].length; const t = m[0]; if (s[i] === '<') { i++; const a = [one()]; while (s[i] === ',') { i++; a.push(one()); } if (s[i] === '>') i++; return { t, a }; } return PRIM.indexOf(t) >= 0 ? { t } : T.unknown; };
        return one();
    }
    // 兩個型別合流（賦值多處）：相同取原；unknown 讓位；int 與 float 取 float；其餘 any
    function tyJoin(a, b) {
        if (!a || a.t === 'unknown') return b || T.unknown; if (!b || b.t === 'unknown') return a; if (tyEq(a, b)) return a;
        if ((a.t === 'int' && b.t === 'float') || (a.t === 'float' && b.t === 'int')) return T.float;
        if (a.t === b.t && a.a && b.a && a.a.length === b.a.length) return { t: a.t, a: a.a.map((x, i) => tyJoin(x, b.a[i])) };
        return T.any;
    }

    // ---- 建構 ----
    const mod = (o) => Object.assign({ ir: 'fa-core-ir', v: VERSION, src: { lang: 'unknown' }, name: 'Module', imports: [], body: [] }, o || {});
    const lit = (t, v) => ({ k: 'lit', t, v }), nm = (v) => ({ k: 'name', v });
    const call = (op, args) => ({ k: 'call', op, args: args || [] }), ucall = (fn, args) => ({ k: 'call', fn, args: args || [] });

    // ---- 走訪 ----
    const KIDS = { func: ['body'], if: ['then', 'else'], while: ['body'], forrange: ['body'], foreach: ['body'] };
    function walkStmts(body, fn, depth) { depth = depth || 0; (body || []).forEach((s) => { fn(s, depth); (KIDS[s.k] || []).forEach((f) => { if (s[f]) walkStmts(s[f], fn, depth + 1); }); }); }
    const EKEYS = ['e', 'l', 'r', 'o', 'i', 'c', 'a', 'b', 'val', 'to', 'cond', 'from', 'step', 'iter'];
    function walkExpr(e, fn) {
        if (!e || typeof e !== 'object') return; if (Array.isArray(e)) { e.forEach((x) => walkExpr(x, fn)); return; }
        if (e.k) fn(e);
        if (e.args) e.args.forEach((x) => walkExpr(x, fn)); if (e.items) e.items.forEach((x) => walkExpr(x, fn));
        if (e.k === 'dict') (e.items || []).forEach((p) => { walkExpr(p[0], fn); walkExpr(p[1], fn); });
        if (e.k !== 'func') EKEYS.forEach((f) => { if (e[f] && typeof e[f] === 'object' && e[f].k && !STMT_ONLY[e[f].k]) walkExpr(e[f], fn); });
    }
    const STMT_ONLY = { func: 1, assign: 1, aug: 1, if: 1, while: 1, forrange: 1, foreach: 1, ret: 1, brk: 1, cont: 1, pass: 1, expr: 1, raise: 1, comment: 1, declare: 1 };
    // 每個敘述上的運算式欄位
    const SFIELDS = { assign: ['to', 'val'], aug: ['to', 'val'], if: ['cond'], while: ['cond'], forrange: ['from', 'to', 'step'], foreach: ['iter'], ret: ['val'], expr: ['e'], raise: ['val'], declare: [] };
    function eachExpr(body, fn) { walkStmts(body, (s) => { (SFIELDS[s.k] || []).forEach((f) => { if (s[f]) walkExpr(s[f], fn); }); (s.params || []).forEach((p) => { if (p.def) walkExpr(p.def, fn); }); }); }
    function funcs(ir) { return (ir.body || []).filter((s) => s.k === 'func'); }

    // ---- 驗證 ----
    function validate(ir, opts) {
        const errors = [], ops = opts && opts.ops; const err = (m, n) => errors.push(m + (n && n.pos ? '（第 ' + n.pos[0] + ' 行）' : ''));
        if (!ir || typeof ir !== 'object') return { ok: false, errors: ['不是物件'] };
        if (ir.ir !== 'fa-core-ir') err('缺 ir 標記'); if (typeof ir.v !== 'number' || ir.v > VERSION) err('版本不支援：' + ir.v);
        if (!Array.isArray(ir.body)) { err('body 要是陣列'); return { ok: false, errors }; }
        const chkTy = (t, where) => { if (t == null) return; if (typeof t !== 'object' || (PRIM.indexOf(t.t) < 0 && GEN.indexOf(t.t) < 0)) return err('型別不合法 ' + JSON.stringify(t) + ' @' + where); if (GEN.indexOf(t.t) >= 0 && (!Array.isArray(t.a) || !t.a.length)) err('型別 ' + t.t + ' 缺型別參數 @' + where); (t.a || []).forEach((x) => chkTy(x, where)); };
        const chkPos = (n) => { if (n.pos && !(Array.isArray(n.pos) && n.pos.length === 4 && n.pos.every(Number.isInteger))) err('pos 要是 4 個整數', n); };
        const chkC = (n) => { if (!n.c) return; if (n.c.b && (!Array.isArray(n.c.b) || n.c.b.some((x) => typeof x !== 'string'))) err('c.b 要是字串陣列', n); if (n.c.a != null && typeof n.c.a !== 'string') err('c.a 要是字串', n); };
        const ex = (e, where) => {
            if (!e || typeof e !== 'object') return err('運算式缺失 @' + where); if (EXPR.indexOf(e.k) < 0) return err('不認得的運算式種類 ' + e.k + ' @' + where, e); chkPos(e); chkTy(e.ty, where);
            switch (e.k) {
                case 'lit': if (['int', 'float', 'str', 'bool', 'none'].indexOf(e.t) < 0) err('lit.t 不合法 ' + e.t, e); break;
                case 'name': if (typeof e.v !== 'string' || !e.v) err('name 缺 v', e); break;
                case 'bin': if (BINOPS.indexOf(e.op) < 0) err('bin 運算子不合法 ' + e.op, e); ex(e.l, where); ex(e.r, where); break;
                case 'cmp': if (CMPOPS.indexOf(e.op) < 0) err('cmp 運算子不合法 ' + e.op, e); ex(e.l, where); ex(e.r, where); break;
                case 'logic': if (e.op !== 'and' && e.op !== 'or') err('logic 運算子要是 and／or', e); ex(e.l, where); ex(e.r, where); break;
                case 'un': if (['-', '+', '~'].indexOf(e.op) < 0) err('un 運算子不合法', e); ex(e.e, where); break;
                case 'not': ex(e.e, where); break;
                case 'index': ex(e.o, where); ex(e.i, where); break;
                case 'call': if (!e.op === !e.fn) err('call 要有 op（標準操作）或 fn（使用者函式）其中之一', e); if (e.op && ops && !ops.has(e.op)) err('標準操作不在目錄：' + e.op, e); (e.args || []).forEach((a) => ex(a, where)); break;
                case 'list': (e.items || []).forEach((a) => ex(a, where)); break;
                case 'dict': (e.items || []).forEach((p) => { if (!Array.isArray(p) || p.length !== 2) err('dict.items 要是 [k,v] 對', e); else { ex(p[0], where); ex(p[1], where); } }); break;
                case 'cond': ex(e.c, where); ex(e.a, where); ex(e.b, where); break;
                case 'native': if (!e.lang || typeof e.src !== 'string') err('native 要有 lang 與 src', e); break;
            }
        };
        const block = (body, where) => {
            if (!Array.isArray(body)) return err('區塊要是陣列 @' + where);
            body.forEach((s) => {
                if (!s || STMT.indexOf(s.k) < 0) return err('不認得的敘述種類 ' + (s && s.k) + ' @' + where, s); chkPos(s); chkC(s);
                switch (s.k) {
                    case 'func': if (!s.name) err('func 缺 name', s); (s.params || []).forEach((p) => { if (!p.name) err('參數缺 name', s); chkTy(p.ty, s.name); if (p.def) ex(p.def, s.name); }); chkTy(s.ret, s.name); block(s.body, s.name); break;
                    case 'assign': ex(s.to, where); ex(s.val, where); chkTy(s.ty, where); break;
                    case 'aug': ex(s.to, where); ex(s.val, where); if (BINOPS.indexOf(s.op) < 0) err('aug 運算子不合法', s); break;
                    case 'if': ex(s.cond, where); block(s.then, where); if (s.else) block(s.else, where); break;
                    case 'while': ex(s.cond, where); block(s.body, where); break;
                    case 'forrange': if (!s.var) err('forrange 缺 var', s); ex(s.from, where); ex(s.to, where); if (s.step) ex(s.step, where); block(s.body, where); break;
                    case 'foreach': if (!s.var) err('foreach 缺 var', s); ex(s.iter, where); block(s.body, where); break;
                    case 'ret': if (s.val) ex(s.val, where); break;
                    case 'expr': ex(s.e, where); break;
                    case 'raise': if (s.val) ex(s.val, where); break;
                    case 'comment': if (typeof s.s !== 'string') err('comment 缺 s', s); break;
                    case 'native': if (!s.lang || typeof s.src !== 'string') err('native 要有 lang 與 src', s); break;
                    case 'declare': if (!s.name) err('declare 缺 name', s); chkTy(s.ty, where); break;
                }
            });
        };
        block(ir.body, '模組'); return { ok: !errors.length, errors };
    }

    // ---- 序列化：鍵固定順序（k 最前、pos／c 最後），同一棵樹永遠得到同一段文字，方便 diff 與比對 ----
    const LAST = ['ty', 'pos', 'c'];
    function canon(x) {
        if (Array.isArray(x)) return x.map(canon); if (!x || typeof x !== 'object') return x;
        const keys = Object.keys(x).filter((k) => x[k] !== undefined && x[k] !== null).sort((a, b) => { const ra = a === 'k' ? -1 : LAST.indexOf(a) >= 0 ? 100 + LAST.indexOf(a) : 0, rb = b === 'k' ? -1 : LAST.indexOf(b) >= 0 ? 100 + LAST.indexOf(b) : 0; return ra - rb || (a < b ? -1 : a > b ? 1 : 0); });
        const o = {}; keys.forEach((k) => { o[k] = canon(x[k]); }); return o;
    }
    const stringify = (ir, indent) => JSON.stringify(canon(ir), null, indent == null ? 0 : indent);
    function parse(text, opts) { let ir; try { ir = JSON.parse(text); } catch (e) { return { ok: false, errors: ['JSON 解析失敗：' + e.message] }; } const v = validate(ir, opts); return v.ok ? { ok: true, ir } : { ok: false, errors: v.errors }; }
    const clone = (x) => JSON.parse(JSON.stringify(x));
    // 去掉 pos／c／ty（比較「語意」相同用）
    function strip(x, keepTrivia) { if (Array.isArray(x)) return x.map((y) => strip(y, keepTrivia)); if (!x || typeof x !== 'object') return x; const o = {}; Object.keys(x).forEach((k) => { if (k === 'pos' || k === 'ty' || (!keepTrivia && (k === 'c'))) return; o[k] = strip(x[k], keepTrivia); }); return o; }
    function comments(ir) { const out = []; walkStmts(ir.body, (s) => { if (s.c) { (s.c.b || []).forEach((t) => out.push(t)); if (s.c.a) out.push(s.c.a); } if (s.k === 'comment') out.push(s.s); if (s.k === 'func' && s.doc) out.push(s.doc); }); return out; }

    return { VERSION, STMT, EXPR, T, list, dict, set, tyEq, tyStr, tyParse, tyJoin, mod, lit, nm, call, ucall, walkStmts, walkExpr, eachExpr, funcs, validate, stringify, parse, clone, strip, comments, canon, BINOPS, CMPOPS };
});
