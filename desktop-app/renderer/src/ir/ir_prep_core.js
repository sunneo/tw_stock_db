/* IR 共用的三道處理（語言中立，輸出給任何目標語言之前都要跑）：
 *   infer  型別推斷：標註優先、其次由字面值／操作回傳型別／賦值合流推出；推不出的標 unknown（靜態語言的輸出器遇到 unknown 會要求標註）
 *   lower  降低：把「依型別才有意義的運算子」換成標準操作（// % / ** 字串相加 in 等），真值判斷展開成明確的布林，字面負索引改成 len-k
 *          ——這一步讓每個有語意差異的地方都落在標準操作目錄裡，輸出器不必各自猜
 *   scope  宣告：第一次賦值標 decl（靜態語言需要宣告），在分支裡第一次賦值但分支外也用到的變數提升到函式開頭
 * 全部是純函式；prepare(ir) 回傳 {ir(新的樹), diags}，不改傳入的樹。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./ir_core.js'), require('./ir_ops_core.js')); else root.FaIrPrep = factory(root.FaIr, root.FaIrOps); })(typeof self !== 'undefined' ? self : this, function (IR, OPS) {
    'use strict';
    const T = IR.T;

    const retInferred = new WeakSet(); // 回傳型別是推出來的函式（不是來源標註的）：參數型別補上後要重算；不寫進 IR，免得影響 IR 相等比較
    function infer(ir) {
        const funcs = {}; IR.funcs(ir).forEach((f) => { funcs[f.name] = f; });
        const ret = (f) => (f.ret && f.ret.t !== 'unknown' && !retInferred.has(f) ? f.ret : (f._ret || T.unknown)); // retInf＝回傳型別是推出來的（不是來源標註的）：參數型別補上後要重算
        function ex(e, env, fx) {
            if (!e) return T.unknown; let ty = T.unknown;
            switch (e.k) {
                case 'lit': ty = e.t === 'int' ? T.int : e.t === 'float' ? T.float : e.t === 'str' ? T.str : e.t === 'bool' ? T.bool : T.any; break;
                case 'name': ty = env[e.v] || T.unknown; break;
                case 'bin': {
                    const a = ex(e.l, env, fx), b = ex(e.r, env, fx);
                    if (e.op === '/') ty = T.float; else if (['&', '|', '^', '<<', '>>'].indexOf(e.op) >= 0) ty = T.int;
                    else if (e.op === '+' && a.t === 'str' && b.t === 'str') ty = T.str;
                    else if (e.op === '+' && a.t === 'list') ty = a;
                    else if (e.op === '*' && a.t === 'list') ty = a; else if (e.op === '*' && b.t === 'list') ty = b;
                    else if (e.op === '*' && (a.t === 'str' || b.t === 'str')) ty = T.str;
                    else if (e.op === '**') ty = a.t === 'int' && b.t === 'int' ? T.int : T.float;
                    else ty = IR.tyJoin(a, b); break;
                }
                case 'un': ty = ex(e.e, env, fx); break;
                case 'not': ex(e.e, env, fx); ty = T.bool; break;
                case 'cmp': ex(e.l, env, fx); ex(e.r, env, fx); ty = T.bool; break;
                case 'logic': { const a = ex(e.l, env, fx), b = ex(e.r, env, fx); ty = a.t === 'bool' && b.t === 'bool' ? T.bool : IR.tyJoin(a, b); break; }
                case 'index': { const o = ex(e.o, env, fx); ex(e.i, env, fx); ty = o.t === 'list' ? o.a[0] : o.t === 'str' ? T.str : o.t === 'dict' ? o.a[1] : T.unknown; break; }
                case 'list': { let el = T.unknown; (e.items || []).forEach((x, i) => { const t = ex(x, env, fx); el = i === 0 ? t : IR.tyJoin(el, t); }); ty = IR.list(el); break; }
                case 'dict': { let kt = T.unknown, vt = T.unknown; (e.items || []).forEach((p, i) => { const a = ex(p[0], env, fx), b = ex(p[1], env, fx); kt = i === 0 ? a : IR.tyJoin(kt, a); vt = i === 0 ? b : IR.tyJoin(vt, b); }); ty = IR.dict(kt, vt); break; }
                case 'cond': ex(e.c, env, fx); ty = IR.tyJoin(ex(e.a, env, fx), ex(e.b, env, fx)); break;
                case 'call': {
                    const at = (e.args || []).map((a) => ex(a, env, fx));
                    if (e.op) {
                        ty = OPS.retType(e.op, at);
                        // 就地加入元素：回頭補齊變數的元素型別
                        const r0 = e.args[0];
                        if (r0 && r0.k === 'name' && at[0].t === 'list' && at[0].a[0].t === 'unknown') {
                            if (e.op === 'list.append' && at[1]) env[r0.v] = IR.list(at[1]); else if (e.op === 'list.insert' && at[2]) env[r0.v] = IR.list(at[2]);
                        }
                        if (e.op === 'dict.put' && r0 && r0.k === 'name' && at[0].t === 'dict' && (at[0].a[0].t === 'unknown' || at[0].a[1].t === 'unknown')) env[r0.v] = IR.dict(at[0].a[0].t === 'unknown' ? at[1] : at[0].a[0], at[0].a[1].t === 'unknown' ? at[2] : at[0].a[1]);
                    } else { const f = funcs[e.fn]; ty = f ? ret(f) : T.unknown; }
                    break;
                }
                case 'native': ty = e.ty || T.unknown; break;
            }
            e.ty = ty; return ty;
        }
        function block(body, env, fx) {
            (body || []).forEach((s) => {
                switch (s.k) {
                    case 'assign': {
                        const vt = ex(s.val, env, fx);
                        if (s.to.k === 'name') { const t = s.ty || vt; env[s.to.v] = env[s.to.v] ? (s.ty ? s.ty : IR.tyJoin(env[s.to.v], t)) : t; s.to.ty = env[s.to.v]; }
                        else if (s.to.k === 'index') { const o = ex(s.to.o, env, fx); ex(s.to.i, env, fx); if (s.to.o.k === 'name' && o.t === 'dict') env[s.to.o.v] = IR.dict(o.a[0].t === 'unknown' ? s.to.i.ty : o.a[0], o.a[1].t === 'unknown' ? vt : o.a[1]); s.to.ty = vt; }
                        break;
                    }
                    case 'aug': ex(s.to, env, fx); ex(s.val, env, fx); break;
                    case 'if': ex(s.cond, env, fx); block(s.then, env, fx); block(s.else, env, fx); break;
                    case 'while': ex(s.cond, env, fx); block(s.body, env, fx); break;
                    case 'forrange': ex(s.from, env, fx); ex(s.to, env, fx); if (s.step) ex(s.step, env, fx); env[s.var] = T.int; block(s.body, env, fx); break;
                    case 'foreach': { const it = ex(s.iter, env, fx); env[s.var] = it.t === 'list' ? it.a[0] : it.t === 'str' ? T.str : it.t === 'dict' ? it.a[0] : T.unknown; block(s.body, env, fx); break; }
                    case 'ret': { const t = s.val ? ex(s.val, env, fx) : T.void; fx.rets.push(t); break; }
                    case 'expr': ex(s.e, env, fx); break;
                    case 'raise': if (s.val) ex(s.val, env, fx); break;
                }
            });
        }
        for (let pass = 0; pass < 3; pass++) {
            IR.funcs(ir).forEach((f) => {
                const env = {}; (f.params || []).forEach((p) => { env[p.name] = p.ty || T.unknown; }); const fx = { rets: [] };
                block(f.body, env, fx); f.locals = env;
                if (!f.ret || f.ret.t === 'unknown' || retInferred.has(f)) { f._ret = fx.rets.length ? fx.rets.reduce((a, b) => IR.tyJoin(a, b)) : T.void; }
            });
        }
        // 模組層敘述（非函式）
        const menv = {}; const fx0 = { rets: [] }; block(ir.body.filter((s) => s.k !== 'func'), menv, fx0); ir.locals = menv;
        IR.funcs(ir).forEach((f) => { if ((!f.ret || f.ret.t === 'unknown' || retInferred.has(f)) && f._ret) { f.ret = f._ret; retInferred.add(f); } delete f._ret; });
        return ir;
    }

    function lower(ir, diags) {
        const d = (m, n) => diags.push({ level: 'warn', msg: m, pos: n && n.pos });
        const callOp = (op, args, node) => { const c = { k: 'call', op, args }; if (node && node.pos) c.pos = node.pos; c.ty = OPS.retType(op, args.map((a) => a.ty || T.unknown)); return c; };
        const mk = (e, ty) => { e.ty = ty; return e; };
        const isLitNeg = (e) => e && e.k === 'un' && e.op === '-' && e.e.k === 'lit' && e.e.t === 'int';
        // 真值：把任意型別在布林情境下變成明確的布林
        function truthy(e) {
            e = lx(e); const t = e.ty || T.unknown;
            if (t.t === 'bool') return e;
            if (t.t === 'int') return mk({ k: 'cmp', op: '!=', l: e, r: mk({ k: 'lit', t: 'int', v: '0' }, T.int) }, T.bool);
            if (t.t === 'float') return mk({ k: 'cmp', op: '!=', l: e, r: mk({ k: 'lit', t: 'float', v: '0.0' }, T.float) }, T.bool);
            if (t.t === 'str' || t.t === 'list' || t.t === 'dict' || t.t === 'set') return mk({ k: 'cmp', op: '>', l: callOp('coll.len', [e], e), r: mk({ k: 'lit', t: 'int', v: '0' }, T.int) }, T.bool);
            d('真值判斷的型別未知（' + IR.tyStr(t) + '），保留原樣', e); return e;
        }
        function boolCtx(e) {
            if (e.k === 'logic') return mk({ k: 'logic', op: e.op, l: boolCtx(e.l), r: boolCtx(e.r), pos: e.pos }, T.bool);
            if (e.k === 'not') return mk({ k: 'not', e: boolCtx(e.e), pos: e.pos }, T.bool);
            return truthy(e);
        }
        function lx(e) {
            if (!e || typeof e !== 'object') return e;
            switch (e.k) {
                case 'bin': {
                    const l = lx(e.l), r = lx(e.r), a = l.ty || T.unknown, b = r.ty || T.unknown; let out = null;
                    if (e.op === '//') { if (a.t === 'int' && b.t === 'int') out = callOp('int.floordiv', [l, r], e); else d('// 只支援整數（運算元型別 ' + IR.tyStr(a) + '、' + IR.tyStr(b) + '）', e); }
                    else if (e.op === '%') { if (a.t === 'int' && b.t === 'int') out = callOp('int.mod', [l, r], e); else d('% 只支援整數', e); }
                    else if (e.op === '/') out = callOp('num.div', [l, r], e);
                    else if (e.op === '**') { if (a.t === 'int' && b.t === 'int') out = callOp('int.pow', [l, r], e); else d('** 只支援整數', e); }
                    else if (e.op === '+' && a.t === 'str' && b.t === 'str') out = callOp('str.concat', [l, r], e);
                    else if (e.op === '*' && a.t === 'str' && b.t === 'int') out = callOp('str.repeat', [l, r], e);
                    else if (e.op === '*' && a.t === 'list' && l.k === 'list' && l.items.length === 1 && b.t === 'int') out = callOp('list.filled', [l.items[0], r], e);
                    else if (e.op === '*' && b.t === 'list' && r.k === 'list' && r.items.length === 1 && a.t === 'int') out = callOp('list.filled', [r.items[0], l], e);
                    else if (e.op === '+' && (a.t === 'list' || b.t === 'list')) d('串列相加尚未支援', e);
                    if (out) { out.ty = out.op === 'int.floordiv' || out.op === 'int.mod' ? T.int : (e.ty || out.ty); if (e.pos) out.pos = e.pos; if (e.op === '/') out.ty = T.float; return out; }
                    return Object.assign({}, e, { l, r });
                }
                case 'cmp': {
                    const l = lx(e.l), r = lx(e.r);
                    if (e.op === 'in' || e.op === 'not in') { const c = callOp('coll.contains', [r, l], e); c.ty = T.bool; return e.op === 'in' ? c : mk({ k: 'not', e: c, pos: e.pos }, T.bool); }
                    if (e.op === 'is' || e.op === 'is not') { d('is 比較只支援與 None，其他語言以 == null 表示（目前保留）', e); }
                    return Object.assign({}, e, { l, r });
                }
                case 'logic': return Object.assign({}, e, { l: lx(e.l), r: lx(e.r) });
                case 'not': return Object.assign({}, e, { e: boolCtx(e.e) });
                case 'un': return Object.assign({}, e, { e: lx(e.e) });
                case 'cond': return Object.assign({}, e, { c: boolCtx(e.c), a: lx(e.a), b: lx(e.b) });
                case 'index': {
                    const o = lx(e.o); let i = lx(e.i);
                    if (isLitNeg(e.i) || (i.k === 'lit' && i.t === 'int' && /^-/.test(i.v))) {
                        const k = isLitNeg(e.i) ? e.i.e : mk({ k: 'lit', t: 'int', v: i.v.replace(/^-/, '') }, T.int);
                        if (o.k === 'name') i = mk({ k: 'bin', op: '-', l: callOp('coll.len', [o], e), r: k }, T.int); else d('負索引的接收者不是單純變數，無法改寫為 len-k', e);
                    }
                    return Object.assign({}, e, { o, i });
                }
                case 'call': {
                    const args = (e.args || []).map(lx); const out = Object.assign({}, e, { args });
                    if (e.op === 'list.slice' && args[0] && args[0].ty && args[0].ty.t === 'str') { out.op = 'str.slice'; out.ty = T.str; }
                    if (e.op === 'list.slice' && args[0] && args[0].ty && args[0].ty.t === 'list') out.ty = args[0].ty;
                    if (e.op === 'list.sorted' &&args[0] && args[0].ty && args[0].ty.t === 'dict') { out.op = 'dict.sorted_keys'; out.ty = OPS.retType(out.op, [args[0].ty]); }
                    return out;
                }
                case 'list': return Object.assign({}, e, { items: e.items.map(lx) });
                case 'dict': return Object.assign({}, e, { items: e.items.map((p) => [lx(p[0]), lx(p[1])]) });
                default: return e;
            }
        }
        function ls(body) {
            return (body || []).map((s) => {
                const o = Object.assign({}, s);
                switch (s.k) {
                    case 'assign': o.val = lx(s.val); o.to = s.to.k === 'index' ? Object.assign({}, s.to, { o: lx(s.to.o), i: lx(s.to.i) }) : s.to; break;
                    case 'aug': {
                        o.val = lx(s.val); o.to = s.to.k === 'index' ? Object.assign({}, s.to, { o: lx(s.to.o), i: lx(s.to.i) }) : s.to;
                        // 需要依型別換成標準操作的複合賦值（//= %= /= **= 字串 +=）展開成一般賦值
                        const probe = lx({ k: 'bin', op: s.op, l: o.to, r: s.val, pos: s.pos, ty: undefined });
                        if (probe.k === 'call') { delete o.op; o.k = 'assign'; o.val = probe; }
                        break;
                    }
                    case 'if': o.cond = boolCtx(s.cond); o.then = ls(s.then); o.else = s.else ? ls(s.else) : s.else; break;
                    case 'while': o.cond = boolCtx(s.cond); o.body = ls(s.body); break;
                    case 'forrange': o.from = lx(s.from); o.to = lx(s.to); if (s.step) o.step = lx(s.step); o.body = ls(s.body); break;
                    case 'foreach': o.iter = lx(s.iter); o.body = ls(s.body); break;
                    case 'ret': if (s.val) o.val = lx(s.val); break;
                    case 'expr': o.e = lx(s.e); break;
                    case 'func': o.body = ls(s.body); break;
                    case 'raise': if (s.val) o.val = lx(s.val); break;
                }
                return o;
            });
        }
        return Object.assign({}, ir, { body: ls(ir.body) });
    }

    // 宣告：第一次賦值 decl:true；分支內第一次賦值但分支外也用到 → 提升到函式開頭（declare）
    function scope(ir) {
        function fn(f) {
            const declared = {}; (f.params || []).forEach((p) => { declared[p.name] = true; });
            const first = {}; const refs = {}; let bid = 0;
            const refE = (e, stack) => IR.walkExpr(e, (n) => { if (n.k === 'name') (refs[n.v] = refs[n.v] || []).push(stack); });
            function walk(body, stack) {
                (body || []).forEach((s) => {
                    const myStack = stack;
                    switch (s.k) {
                        case 'assign': refE(s.val, myStack); if (s.to.k === 'name') { if (!declared[s.to.v] && !first[s.to.v]) first[s.to.v] = { stmt: s, stack: myStack }; (refs[s.to.v] = refs[s.to.v] || []).push(myStack); } else refE(s.to, myStack); break;
                        case 'aug': refE(s.to, myStack); refE(s.val, myStack); break;
                        case 'if': refE(s.cond, myStack); walk(s.then, myStack.concat(++bid)); walk(s.else, myStack.concat(++bid)); break;
                        case 'while': refE(s.cond, myStack); walk(s.body, myStack.concat(++bid)); break;
                        case 'forrange': refE(s.from, myStack); refE(s.to, myStack); if (s.step) refE(s.step, myStack); declared[s.var] = true; walk(s.body, myStack.concat(++bid)); break;
                        case 'foreach': refE(s.iter, myStack); declared[s.var] = true; walk(s.body, myStack.concat(++bid)); break;
                        case 'ret': case 'expr': case 'raise': refE(s.val || s.e, myStack); break;
                    }
                });
            }
            walk(f.body, []);
            const hoist = [];
            Object.keys(first).forEach((v) => {
                const fi = first[v], s = fi.stmt; const ty = (f.locals && f.locals[v]) || s.ty || (s.val && s.val.ty) || T.unknown;
                s.decl = true; s.ty = ty;
                if (fi.stack.length) { const id = fi.stack[fi.stack.length - 1]; if ((refs[v] || []).some((st) => st.indexOf(id) < 0)) { s.decl = false; hoist.push({ k: 'declare', name: v, ty }); } }
            });
            if (hoist.length) f.body = hoist.concat(f.body);
        }
        IR.funcs(ir).forEach(fn); return ir;
    }

    // 參數型別沒標註時，由呼叫端引數的型別推（JavaScript／Ruby 這類沒有型別標註的來源要轉成靜態語言時需要）；只補 unknown 的參數，多處呼叫型別不同就取合流，最多跑三輪
    function inferParams(ir) {
        const fns = {}; IR.funcs(ir).forEach((f) => { fns[f.name] = f; }); let changed = false;
        IR.eachExpr(ir.body, (e) => {
            if (e.k !== 'call' || !e.fn || !fns[e.fn]) return; const f = fns[e.fn];
            (e.args || []).forEach((a, i) => { const p = f.params[i]; if (!p || !a.ty || a.ty.t === 'unknown') return; if (!p.ty || p.ty.t === 'unknown') { p.ty = a.ty; changed = true; } });
        });
        return changed;
    }
    // 由「用法」推還沒有型別的參數（呼叫端沒給型別時的第二道）：只認一定成立的用法——
    //   整數運算（int.floordiv／int.mod／int.pow／math.gcd 的運算元、forrange 的起訖與步長、索引的下標）→ int；字串操作（str.* 的接收者、coll.len 之外）→ str；list.* 的接收者 → list<unknown>（元素型別仍要使用者補）。
    // 推出來的用診斷記下（warn），使用者可以覆蓋（applyTypes）。回傳新增的診斷。
    function inferUsage(ir) {
        const diags = []; let changed = false;
        const setP = (f, name, ty, why) => { const p = (f.params || []).find((x) => x.name === name); if (!p || (p.ty && p.ty.t !== 'unknown')) return; p.ty = ty; changed = true; diags.push({ level: 'warn', msg: '參數 ' + f.name + '.' + name + ' 沒有型別，由用法推為 ' + IR.tyStr(ty) + '（' + why + '，請確認）', pos: f.pos }); };
        IR.funcs(ir).forEach((f) => {
            const nm = (e) => (e && e.k === 'name' ? e.v : null);
            const visit = (e) => IR.walkExpr(e, (x) => {
                if (x.k === 'call' && x.op) {
                    if (/^(int\.(floordiv|mod|pow)|math\.gcd)$/.test(x.op)) (x.args || []).forEach((a) => { if (nm(a)) setP(f, nm(a), T.int, x.op + ' 的運算元'); });
                    else if (/^str\./.test(x.op) && x.args && x.args[0] && nm(x.args[0]) && !/^str\.(from_code)$/.test(x.op)) setP(f, nm(x.args[0]), T.str, x.op + ' 的接收者');
                    else if (/^list\./.test(x.op) && x.args && x.args[0] && nm(x.args[0])) setP(f, nm(x.args[0]), IR.list(T.unknown), x.op + ' 的接收者');
                    if (x.op === 'list.get' && x.args[1] && nm(x.args[1])) setP(f, nm(x.args[1]), T.int, '串列下標');
                }
                if (x.k === 'index' && nm(x.i)) setP(f, nm(x.i), T.int, '索引下標');
            });
            IR.walkStmts(f.body, (s) => {
                if (s.k === 'forrange') [s.from, s.to, s.step].forEach((e) => { if (e && nm(e)) setP(f, nm(e), T.int, 'for 的範圍'); });
                ['to', 'val', 'e', 'cond', 'iter', 'from'].forEach((k) => { if (s[k]) visit(s[k]); });
                if (s.k === 'foreach' && s.iter && nm(s.iter)) setP(f, nm(s.iter), IR.list(T.unknown), 'foreach 的走訪對象');
            });
        });
        return { changed, diags };
    }
    const hasUnknown = (t) => !t || t.t === 'unknown' || (t.a || []).some(hasUnknown);
    // 仍然推不出型別的地方，列給使用者補：參數、回傳值、區域變數。key 的格式 "函式.名稱"（回傳值用 "函式.return"）。
    function missingTypes(ir) {
        const out = [];
        IR.funcs(ir).forEach((f) => {
            (f.params || []).forEach((p) => { if (hasUnknown(p.ty)) out.push({ key: f.name + '.' + p.name, kind: 'param', func: f.name, name: p.name, now: IR.tyStr(p.ty || T.unknown), line: f.pos && f.pos[0] }); });
            if (f.ret && f.ret.t !== 'void' && hasUnknown(f.ret)) out.push({ key: f.name + '.return', kind: 'return', func: f.name, name: 'return', now: IR.tyStr(f.ret), line: f.pos && f.pos[0] });
            Object.keys(f.locals || {}).forEach((v) => { if (!(f.params || []).some((p) => p.name === v) && hasUnknown(f.locals[v])) out.push({ key: f.name + '.' + v, kind: 'local', func: f.name, name: v, now: IR.tyStr(f.locals[v]), line: f.pos && f.pos[0] }); });
        });
        // 參數或回傳值還缺時，區域變數多半是它們的連帶結果（補了參數就會推出來），先不列，免得一次問太多
        return out.some((x) => x.kind !== 'local') ? out.filter((x) => x.kind !== 'local') : out;
    }
    // 套用使用者補的型別：types＝{ "函式.參數": "list<int>", "函式.return": "int", "函式.區域變數": "str" }（型別字串用 IR.tyParse 的寫法：int float str bool list<T> dict<K,V> set<T>）。
    // 區域變數的型別寫在它第一次賦值的敘述上（assign.ty）。回傳 { applied:[key], bad:[{key, why}] }。必須在 prepare 之前套用。
    function applyTypes(ir, types) {
        const applied = [], bad = []; const fns = {}; IR.funcs(ir).forEach((f) => { fns[f.name] = f; });
        Object.keys(types || {}).forEach((key) => {
            const i = key.lastIndexOf('.'); const fname = i > 0 ? key.slice(0, i) : null, nm = i > 0 ? key.slice(i + 1) : key; let ty;
            try { ty = IR.tyParse(String(types[key])); } catch (e) { ty = T.unknown; } if (!ty || (ty.t === 'unknown' && !/^unknown$/.test(String(types[key]).trim()))) { bad.push({ key, why: '型別寫法看不懂：' + types[key] + '（可用 int float str bool list<T> dict<K,V> set<T>）' }); return; }
            const fs = fname ? [fns[fname]].filter(Boolean) : IR.funcs(ir); if (!fs.length) { bad.push({ key, why: '找不到函式 ' + fname }); return; }
            let ok = false;
            fs.forEach((f) => {
                if (nm === 'return') { f.ret = ty; ok = true; return; }
                const p = (f.params || []).find((x) => x.name === nm); if (p) { p.ty = ty; ok = true; return; }
                IR.walkStmts(f.body, (s) => { if (!ok && s.k === 'assign' && s.to.k === 'name' && s.to.v === nm) { s.ty = ty; ok = true; } });
            });
            if (ok) applied.push(key); else bad.push({ key, why: '找不到參數或變數 ' + key });
        });
        return { applied, bad };
    }
    function prepare(ir0, opts) {
        const diags = []; let ir = IR.clone(ir0); infer(ir); for (let i = 0; i < 3 && inferParams(ir); i++) infer(ir);
        for (let i = 0; i < 3; i++) { const u = inferUsage(ir); if (!u.changed) break; u.diags.forEach((d) => diags.push(d)); infer(ir); for (let j = 0; j < 3 && inferParams(ir); j++) infer(ir); }
        ir = lower(ir, diags); infer(ir); scope(ir); return { ir, diags };
    }
    return { infer, lower, scope, prepare, inferUsage, missingTypes, applyTypes, hasUnknown };
});
