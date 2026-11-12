/* 訓練工作室：受限運算式語言（Python 運算式的子集）的解析器與解譯器（UMD，純函式）。設計 §16.2。
 * 為什麼有它：使用者資產（領域規格）不能放任意 JS 直接執行。矩陣層的「操作」需要一個能在擬合時快速、安全試算的表示：
 * 運算式只能由整數／字串／清單／布林的字面值、運算子、白名單函式與方法組成；沒有屬性存取、沒有 import、沒有賦值、沒有 lambda、沒有 dunder。
 * 同一份運算式文字可以原封不動放進 Python 程式（語法是 Python 的子集），所以「擬合時的結果」與「產出的程式」是同一個東西。
 *
 *   parse(src) → { ok, ast, vars:[自由變數名稱], error? }       檢查語法與白名單；不執行
 *   evaluate(src|ast, env, opts) → { ok, value, error? }         env: {名稱: 值}（整數用 BigInt 或可轉成整數的 number）；opts.maxSteps（預設 200000）
 *   toPy(value) → 字串                                           把結果轉成 print 的樣子（布林 True/False、清單用空白連接見 format）
 *   format(value, type, o) → 字串                                type: 'int'|'str'|'ints'|'bool'；bool 用 o.yes／o.no
 * 語意與 Python 對齊：整數是任意精度、// 與 % 向負無窮取整、比較可鏈（a < b < c）、and/or 回傳運算元（短路）。
 * 不支援（明講，不假裝）：浮點數（小數字面值會被拒絕）、字串格式化、切片步長以外的 Python 特技、遞迴、使用者函式。
 * 資源上限：解譯步數、range／乘冪／字串重複的大小，超過就回錯誤（不會卡住）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioExpr = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const FUNCS = new Set(['len', 'sum', 'min', 'max', 'abs', 'sorted', 'reversed', 'str', 'int', 'range', 'list', 'set', 'bool', 'any', 'all', 'ord', 'chr', 'pow']);
    const METHODS = new Set(['count', 'upper', 'lower', 'strip', 'join', 'startswith', 'endswith', 'find', 'index', 'isdigit', 'isalpha', 'split', 'replace']);
    const KW = new Set(['and', 'or', 'not', 'if', 'else', 'for', 'in', 'True', 'False', 'None']);
    const BAN = /^__|__$/;
    const MAX_RANGE = 200000, MAX_STR = 1000000, MAX_POW_BITS = 20000;

    // ---- 詞法 ----
    function lex(src) {
        const t = []; let i = 0; const s = String(src);
        while (i < s.length) {
            const c = s[i];
            if (/\s/.test(c)) { i++; continue; }
            if (/[0-9]/.test(c)) { let j = i; while (j < s.length && /[0-9_]/.test(s[j])) j++; if (s[j] === '.' && /[0-9]/.test(s[j + 1] || '')) throw new Error('不支援小數：' + s.slice(i, j + 2)); if (/[eE]/.test(s[j] || '') && /[-+0-9]/.test(s[j + 1] || '')) throw new Error('不支援科學記號'); if (/[A-Za-z_]/.test(s[j] || '')) throw new Error('數字後面不能接字母：' + s.slice(i, j + 1)); t.push({ k: 'num', v: BigInt(s.slice(i, j).replace(/_/g, '')) }); i = j; continue; }
            if (/[A-Za-z_]/.test(c)) { let j = i; while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++; t.push({ k: 'id', v: s.slice(i, j) }); i = j; continue; }
            if (c === '"' || c === "'") { let j = i + 1, out = ''; while (j < s.length && s[j] !== c) { if (s[j] === '\\') { const n = s[j + 1]; out += n === 'n' ? '\n' : n === 't' ? '\t' : n; j += 2; } else out += s[j++]; } if (j >= s.length) throw new Error('字串沒有結尾'); t.push({ k: 'str', v: out }); i = j + 1; continue; }
            const three = s.slice(i, i + 3), two = s.slice(i, i + 2);
            if (three === '//=' || three === '**=') throw new Error('不支援賦值運算');
            if (['//', '**', '==', '!=', '<=', '>=', '<<', '>>'].includes(two)) { t.push({ k: 'op', v: two }); i += 2; continue; }
            if ('+-*/%<>()[],:|&^~.'.includes(c)) { if (c === '/') throw new Error('不支援 /（真除法會產生小數）；整數除法請用 //'); if (c === '~') throw new Error('不支援 ~'); t.push({ k: 'op', v: c }); i++; continue; }
            if (c === '=' || c === '!' || c === ';' || c === '{' || c === '}' || c === '@' || c === '$' || c === '`' || c === '\\') throw new Error('不支援的符號：' + c);
            throw new Error('不認得的字元：' + c);
        }
        t.push({ k: 'end' }); return t;
    }

    // ---- 語法 ----
    function parseTokens(t) {
        let p = 0; const vars = new Set(); const bound = [];
        const peek = () => t[p], next = () => t[p++];
        const isOp = (v) => t[p].k === 'op' && t[p].v === v, isId = (v) => t[p].k === 'id' && t[p].v === v;
        const eatOp = (v) => { if (!isOp(v)) throw new Error('這裡應該是「' + v + '」'); p++; };
        function ternary() { const a = orx(); if (isId('if')) { p++; const c = orx(); if (!isId('else')) throw new Error('if 後面要有 else'); p++; const b = ternary(); return { t: 'if', c, a, b }; } return a; }
        function orx() { let a = andx(); while (isId('or')) { p++; a = { t: 'or', a, b: andx() }; } return a; }
        function andx() { let a = notx(); while (isId('and')) { p++; a = { t: 'and', a, b: notx() }; } return a; }
        function notx() { if (isId('not')) { p++; return { t: 'not', a: notx() }; } return cmp(); }
        function cmp() {
            const first = bor(); const ops = [], rest = [];
            for (;;) {
                let o = null; if (t[p].k === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t[p].v)) o = next().v; else if (isId('in')) { p++; o = 'in'; } else if (isId('not') && t[p + 1].k === 'id' && t[p + 1].v === 'in') { p += 2; o = 'not in'; } else break;
                ops.push(o); rest.push(bor());
            }
            return ops.length ? { t: 'cmp', first, ops, rest } : first;
        }
        const bin = (sub, set) => () => { let a = sub(); while (t[p].k === 'op' && set.includes(t[p].v)) { const o = next().v; a = { t: 'bin', o, a, b: sub() }; } return a; };
        function unary() { if (isOp('-')) { p++; return { t: 'neg', a: unary() }; } if (isOp('+')) { p++; return unary(); } return power(); }
        function power() { const a = postfix(); if (isOp('**')) { p++; return { t: 'bin', o: '**', a, b: unary() }; } return a; }
        const mul = bin(unary, ['*', '//', '%']), add = bin(mul, ['+', '-']), shift = bin(add, ['<<', '>>']), band = bin(shift, ['&']), bxor = bin(band, ['^']), bor = bin(bxor, ['|']);
        function args() { const a = []; if (!isOp(')')) { for (;;) { a.push(ternary()); if (isOp(',')) { p++; if (isOp(')')) break; continue; } break; } } eatOp(')'); return a; }
        function postfix() {
            let a = atom();
            for (;;) {
                if (isOp('(')) { if (a.t !== 'name') throw new Error('只能呼叫白名單函式'); if (!FUNCS.has(a.n)) throw new Error('不允許的函式：' + a.n); p++; a = { t: 'call', f: a.n, args: args() }; vars.delete(a.f); }
                else if (isOp('[')) { p++; let lo = null, hi = null, sl = false; if (!isOp(':')) lo = ternary(); if (isOp(':')) { p++; sl = true; if (!isOp(']')) hi = ternary(); if (isOp(':')) throw new Error('不支援切片步長（反轉請用 reversed 或 sorted）'); } eatOp(']'); a = sl ? { t: 'slice', a, lo, hi } : { t: 'idx', a, i: lo }; }
                else if (isOp('.')) { p++; const m = next(); if (m.k !== 'id') throw new Error('點後面要是方法名稱'); if (BAN.test(m.v) || !METHODS.has(m.v)) throw new Error('不允許的方法：' + m.v); eatOp('('); a = { t: 'meth', o: a, m: m.v, args: args() }; }
                else break;
            }
            return a;
        }
        function atom() {
            const k = next();
            if (k.k === 'num') return { t: 'lit', v: k.v };
            if (k.k === 'str') return { t: 'lit', v: k.v };
            if (k.k === 'op' && k.v === '(') { const e = ternary(); if (isOp(',')) throw new Error('不支援元組'); eatOp(')'); return e; }
            if (k.k === 'op' && k.v === '[') {
                if (isOp(']')) { p++; return { t: 'list', items: [] }; }
                const before = new Set(vars); const first = ternary();
                if (isId('for')) { p++; const v = next(); if (v.k !== 'id' || KW.has(v.v) || BAN.test(v.v)) throw new Error('for 後面要是變數名稱'); if (!isId('in')) throw new Error('for 後面要有 in'); p++; bound.push(v.v); const it = orx(); let cond = null; if (isId('if')) { p++; cond = orx(); } bound.pop(); eatOp(']'); if (!before.has(v.v)) vars.delete(v.v); return { t: 'comp', e: first, v: v.v, it, cond }; }
                const items = [first]; while (isOp(',')) { p++; if (isOp(']')) break; items.push(ternary()); } eatOp(']'); return { t: 'list', items };
            }
            if (k.k === 'id') {
                if (k.v === 'True') return { t: 'lit', v: true }; if (k.v === 'False') return { t: 'lit', v: false };
                if (k.v === 'None') throw new Error('不支援 None'); if (KW.has(k.v)) throw new Error('關鍵字用錯位置：' + k.v); if (BAN.test(k.v)) throw new Error('不允許的名稱：' + k.v);
                if (t[p].k === 'op' && t[p].v === '(') return { t: 'name', n: k.v }; // 函式名稱，由 postfix 檢查白名單
                if (!bound.includes(k.v)) vars.add(k.v); return { t: 'name', n: k.v };
            }
            throw new Error(k.k === 'end' ? '運算式不完整' : '這個位置不能放「' + (k.v === undefined ? k.k : k.v) + '」');
        }
        const ast = ternary(); if (t[p].k !== 'end') throw new Error('運算式後面多了東西：' + (t[p].v === undefined ? '' : t[p].v));
        return { ast, vars: [...vars] };
    }
    function parse(src) {
        try { if (typeof src !== 'string' || !src.trim()) throw new Error('運算式是空的'); if (src.length > 600) throw new Error('運算式太長（上限 600 字）'); const r = parseTokens(lex(src)); return { ok: true, ast: r.ast, vars: r.vars }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }

    // ---- 解譯 ----
    const isInt = (v) => typeof v === 'bigint', isStr = (v) => typeof v === 'string', isList = (v) => Array.isArray(v), isBool = (v) => typeof v === 'boolean';
    const kindOf = (v) => (isBool(v) ? 'bool' : isInt(v) ? 'int' : isStr(v) ? 'str' : isList(v) ? 'list' : typeof v);
    const num = (v) => (isBool(v) ? (v ? 1n : 0n) : v);
    const truthy = (v) => (isInt(v) ? v !== 0n : isStr(v) || isList(v) ? v.length > 0 : !!v);
    function cmpv(a, b) { // -1/0/1；型別不同丟錯（Python 也不能比）
        if ((isInt(a) || isBool(a)) && (isInt(b) || isBool(b))) { const x = num(a), y = num(b); return x < y ? -1 : x > y ? 1 : 0; }
        if (isStr(a) && isStr(b)) return a < b ? -1 : a > b ? 1 : 0;
        if (isList(a) && isList(b)) { for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmpv(a[i], b[i]); if (c) return c; } return a.length < b.length ? -1 : a.length > b.length ? 1 : 0; }
        throw new Error('不能比較 ' + kindOf(a) + ' 與 ' + kindOf(b));
    }
    const eqv = (a, b) => { if (isList(a) && isList(b)) return a.length === b.length && a.every((x, i) => eqv(x, b[i])); if ((isInt(a) || isBool(a)) && (isInt(b) || isBool(b))) return num(a) === num(b); return a === b; };
    const fdiv = (a, b) => { if (b === 0n) throw new Error('除以零'); let q = a / b; if ((a % b !== 0n) && ((a < 0n) !== (b < 0n))) q -= 1n; return q; };
    const fmod = (a, b) => { if (b === 0n) throw new Error('除以零'); return a - fdiv(a, b) * b; };
    function toInt(v) { if (isBool(v)) return v ? 1n : 0n; if (isInt(v)) return v; if (isStr(v)) { if (!/^\s*[-+]?\d+\s*$/.test(v)) throw new Error('int() 讀不出整數：' + JSON.stringify(v)); return BigInt(v.trim()); } throw new Error('int() 不能用在 ' + kindOf(v)); }
    function toStr(v) { if (isBool(v)) return v ? 'True' : 'False'; if (isInt(v)) return v.toString(); if (isStr(v)) return v; if (isList(v)) return '[' + v.map(repr).join(', ') + ']'; return String(v); }
    function repr(v) { return isStr(v) ? "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'" : toStr(v); }
    function sortList(a) { return a.slice().sort((x, y) => cmpv(x, y)); }
    function iterOf(v) { if (isList(v)) return v; if (isStr(v)) return Array.from(v); throw new Error('不能迭代 ' + kindOf(v)); }
    function normEnv(env) { const o = {}; for (const k of Object.keys(env || {})) { let v = env[k]; if (typeof v === 'number') { if (!Number.isInteger(v)) throw new Error('變數 ' + k + ' 不是整數（不支援浮點數）'); v = BigInt(v); } o[k] = v; } return o; }
    function run(ast, env, maxSteps) {
        let steps = 0; const tick = () => { if (++steps > maxSteps) throw new Error('運算步數超過上限（' + maxSteps + '）'); };
        const lim = (n) => { if (n > MAX_RANGE) throw new Error('範圍太大（上限 ' + MAX_RANGE + '）'); };
        function ev(n, sc) {
            tick();
            switch (n.t) {
                case 'lit': return n.v;
                case 'name': if (sc && Object.prototype.hasOwnProperty.call(sc, n.n)) return sc[n.n]; if (Object.prototype.hasOwnProperty.call(env, n.n)) return env[n.n]; throw new Error('沒有這個變數：' + n.n);
                case 'list': return n.items.map((x) => ev(x, sc));
                case 'if': return truthy(ev(n.c, sc)) ? ev(n.a, sc) : ev(n.b, sc);
                case 'or': { const a = ev(n.a, sc); return truthy(a) ? a : ev(n.b, sc); }
                case 'and': { const a = ev(n.a, sc); return truthy(a) ? ev(n.b, sc) : a; }
                case 'not': return !truthy(ev(n.a, sc));
                case 'neg': { const a = ev(n.a, sc); if (!isInt(a) && !isBool(a)) throw new Error('負號只能用在整數'); return -num(a); }
                case 'cmp': { let l = ev(n.first, sc); for (let i = 0; i < n.ops.length; i++) { const r = ev(n.rest[i], sc); const o = n.ops[i]; let ok;
                    if (o === 'in' || o === 'not in') { const has = isStr(r) ? (isStr(l) ? r.includes(l) : (() => { throw new Error('字串裡只能找字串'); })()) : isList(r) ? r.some((x) => eqv(x, l)) : (() => { throw new Error('in 的右邊要是字串或清單'); })(); ok = o === 'in' ? has : !has; }
                    else if (o === '==') ok = eqv(l, r); else if (o === '!=') ok = !eqv(l, r); else { const c = cmpv(l, r); ok = o === '<' ? c < 0 : o === '<=' ? c <= 0 : o === '>' ? c > 0 : c >= 0; }
                    if (!ok) return false; l = r; } return true; }
                case 'bin': return binop(n.o, ev(n.a, sc), ev(n.b, sc));
                case 'idx': { const a = ev(n.a, sc), i = ev(n.i, sc); if (!isStr(a) && !isList(a)) throw new Error('只有字串與清單能取索引'); if (!isInt(i) && !isBool(i)) throw new Error('索引要是整數'); let k = Number(num(i)); if (k < 0) k += a.length; if (k < 0 || k >= a.length) throw new Error('索引超出範圍'); return isStr(a) ? a[k] : a[k]; }
                case 'slice': { const a = ev(n.a, sc); if (!isStr(a) && !isList(a)) throw new Error('只有字串與清單能切片'); const g = (x, d) => { if (!x) return d; const v = ev(x, sc); let k = Number(toInt(v)); if (k < 0) k = Math.max(0, a.length + k); return Math.min(k, a.length); }; return a.slice(g(n.lo, 0), g(n.hi, a.length)); }
                case 'comp': { const it = iterOf(ev(n.it, sc)); const out = []; for (const x of it) { const s2 = Object.assign({}, sc || {}, { [n.v]: x }); if (n.cond && !truthy(ev(n.cond, s2))) continue; out.push(ev(n.e, s2)); lim(out.length); } return out; }
                case 'call': return call(n.f, n.args.map((x) => ev(x, sc)));
                case 'meth': return meth(ev(n.o, sc), n.m, n.args.map((x) => ev(x, sc)));
                default: throw new Error('內部錯誤：' + n.t);
            }
        }
        function binop(o, a, b) {
            if (o === '+') { if (isStr(a) && isStr(b)) return a + b; if (isList(a) && isList(b)) return a.concat(b); }
            if (o === '*') { if ((isStr(a) || isList(a)) && (isInt(b) || isBool(b))) { const k = Number(num(b)); if (k > 0 && a.length * k > MAX_STR) throw new Error('重複後太大'); if (isStr(a)) return k > 0 ? a.repeat(k) : ''; const r = []; for (let i = 0; i < k; i++) r.push(...a); return r; } if ((isStr(b) || isList(b)) && (isInt(a) || isBool(a))) return binop('*', b, a); }
            if (o === '%' && isStr(a)) throw new Error('不支援字串格式化');
            if (!(isInt(a) || isBool(a)) || !(isInt(b) || isBool(b))) throw new Error('運算元型別不對：' + kindOf(a) + ' ' + o + ' ' + kindOf(b));
            const x = num(a), y = num(b);
            switch (o) {
                case '+': return x + y; case '-': return x - y; case '*': return x * y; case '//': return fdiv(x, y); case '%': return fmod(x, y);
                case '**': { if (y < 0n) throw new Error('不支援負指數（會產生小數）'); if (y > 0n && (x > 1n || x < -1n) && BigInt(x.toString(2).length) * y > BigInt(MAX_POW_BITS)) throw new Error('乘冪太大'); return x ** y; }
                case '<<': { if (y < 0n || y > 4096n) throw new Error('位移量不合理'); return x << y; } case '>>': { if (y < 0n || y > 100000n) throw new Error('位移量不合理'); return x >> y; }
                case '&': return x & y; case '|': return x | y; case '^': return x ^ y;
            }
            throw new Error('未知運算 ' + o);
        }
        function call(f, a) {
            const need = (n) => { if (a.length !== n) throw new Error(f + ' 需要 ' + n + ' 個參數'); };
            switch (f) {
                case 'len': need(1); if (!isStr(a[0]) && !isList(a[0])) throw new Error('len 只能用在字串與清單'); return BigInt(a[0].length);
                case 'abs': need(1); return (num(a[0]) < 0n) ? -num(a[0]) : num(a[0]);
                case 'str': need(1); return toStr(a[0]);
                case 'int': need(1); return toInt(a[0]);
                case 'bool': need(1); return truthy(a[0]);
                case 'ord': need(1); if (!isStr(a[0]) || Array.from(a[0]).length !== 1) throw new Error('ord 要一個字元'); return BigInt(a[0].codePointAt(0));
                case 'chr': need(1); return String.fromCodePoint(Number(toInt(a[0])));
                case 'pow': if (a.length === 2) return binop('**', a[0], a[1]); if (a.length === 3) { let b = toInt(a[0]), e = toInt(a[1]); const m = toInt(a[2]); if (e < 0n || m === 0n) throw new Error('pow 的參數不合法'); let r = 1n; b = fmod(b, m); while (e > 0n) { tick(); if (e & 1n) r = fmod(r * b, m); b = fmod(b * b, m); e >>= 1n; } return fmod(r, m); } throw new Error('pow 需要 2 或 3 個參數');
                case 'range': { const v = a.map((x) => toInt(x)); let lo = 0n, hi, st = 1n; if (v.length === 1) hi = v[0]; else if (v.length === 2) { lo = v[0]; hi = v[1]; } else if (v.length === 3) { lo = v[0]; hi = v[1]; st = v[2]; } else throw new Error('range 需要 1～3 個參數'); if (st === 0n) throw new Error('range 步長不能是 0'); const out = []; for (let i = lo; st > 0n ? i < hi : i > hi; i += st) { out.push(i); lim(out.length); } return out; }
                case 'list': need(1); return iterOf(a[0]).slice();
                case 'set': need(1); { const out = []; for (const x of iterOf(a[0])) if (!out.some((y) => eqv(x, y))) out.push(x); return sortList(out); } // 以排序後的清單代表集合（與 sorted(set(..)) 一致；直接輸出集合在 Python 沒有固定順序，所以不鼓勵）
                case 'sorted': need(1); return sortList(iterOf(a[0]));
                case 'reversed': need(1); return iterOf(a[0]).slice().reverse();
                case 'sum': { need(1); let s = 0n; for (const x of iterOf(a[0])) { tick(); if (!isInt(x) && !isBool(x)) throw new Error('sum 只能加整數'); s += num(x); } return s; }
                case 'min': case 'max': { const xs = a.length === 1 ? iterOf(a[0]) : a; if (!xs.length) throw new Error(f + ' 的參數是空的'); let best = xs[0]; for (const x of xs) { const c = cmpv(x, best); if (f === 'min' ? c < 0 : c > 0) best = x; } return best; }
                case 'any': need(1); return iterOf(a[0]).some(truthy);
                case 'all': need(1); return iterOf(a[0]).every(truthy);
            }
            throw new Error('不允許的函式：' + f);
        }
        function meth(o, m, a) {
            const needS = () => { if (!isStr(o)) throw new Error(m + ' 只能用在字串'); };
            switch (m) {
                case 'count': if (isStr(o)) { if (!isStr(a[0]) || a[0] === '') throw new Error('count 要非空字串'); let c = 0, i = 0; while ((i = o.indexOf(a[0], i)) >= 0) { c++; i += a[0].length; } return BigInt(c); } if (isList(o)) return BigInt(o.filter((x) => eqv(x, a[0])).length); throw new Error('count 用在字串或清單');
                case 'upper': needS(); return o.toUpperCase(); case 'lower': needS(); return o.toLowerCase(); case 'strip': needS(); return o.trim();
                case 'join': needS(); return iterOf(a[0]).map((x) => { if (!isStr(x)) throw new Error('join 只能接字串'); return x; }).join(o);
                case 'startswith': needS(); return o.startsWith(a[0]); case 'endswith': needS(); return o.endsWith(a[0]);
                case 'find': needS(); return BigInt(o.indexOf(a[0])); case 'index': { const i = isStr(o) ? o.indexOf(a[0]) : o.findIndex((x) => eqv(x, a[0])); if (i < 0) throw new Error('index：找不到'); return BigInt(i); }
                case 'isdigit': needS(); return o.length > 0 && /^[0-9]+$/.test(o); case 'isalpha': needS(); return o.length > 0 && /^\p{L}+$/u.test(o);
                case 'split': needS(); return a.length ? o.split(a[0]) : o.split(/\s+/).filter(Boolean);
                case 'replace': needS(); return o.split(a[0]).join(a[1]);
            }
            throw new Error('不允許的方法：' + m);
        }
        return ev(ast, null);
    }
    function evaluate(src, env, opts) {
        try {
            const pr = typeof src === 'string' ? parse(src) : { ok: true, ast: src }; if (!pr.ok) return { ok: false, error: pr.error };
            return { ok: true, value: run(pr.ast, normEnv(env), (opts && opts.maxSteps) || 200000) };
        } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }
    // 輸出：與矩陣層慣例一致（清單用空白連接；布林用 yes／no 字樣；整數十進位）
    function format(v, type, o) {
        o = o || {};
        if (type === 'bool') { if (!isBool(v) && !isInt(v)) throw new Error('輸出型別是 bool，但算出 ' + kindOf(v)); return truthy(v) ? String(o.yes != null ? o.yes : 'yes') : String(o.no != null ? o.no : 'no'); }
        if (type === 'int') { if (!isInt(v) && !isBool(v)) throw new Error('輸出型別是 int，但算出 ' + kindOf(v)); return num(v).toString(); }
        if (type === 'str') { if (!isStr(v)) throw new Error('輸出型別是 str，但算出 ' + kindOf(v)); return v; }
        if (type === 'ints') { if (!isList(v) || v.some((x) => !isInt(x) && !isBool(x))) throw new Error('輸出型別是 ints，但算出的不是整數清單'); return v.map((x) => num(x).toString()).join(' '); }
        throw new Error('未知輸出型別：' + type);
    }
    const toPy = (v) => (isList(v) ? '[' + v.map(toPy).join(', ') + ']' : isBool(v) ? (v ? 'True' : 'False') : isInt(v) ? v.toString() : isStr(v) ? repr(v) : String(v));
    return { parse, evaluate, format, toPy, FUNCS: [...FUNCS], METHODS: [...METHODS] };
});
