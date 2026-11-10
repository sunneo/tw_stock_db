/* Perl 的「進」：自己寫的小剖析器（專案裡沒有 tree-sitter-perl 文法，也不下載）→ 核心 IR。純函式 UMD。設計見 DESIGN.core-ir.md 第 14 節。
 * 範圍：我們的 Perl 輸出器產生的那一類寫法（sub／my／if-elsif-else／while／for（C 式與 foreach）／return／last／next／die、
 * 純量變數與 `$a->[i]`、`$d->{k}`、`@{…}`、`%{…}`、`scalar(@{…})`、`map/sort/grep { … } 清單`、`do { … }`、`s///r`、`<STDIN>`）。
 * 手寫 Perl 的其他語法（修飾語句 `… if …;`、local、字串插值、heredoc、format、類別）剖不了或不認得時，整句收成 native（原文＋語言），不丟。
 * 做法同其他「進」：目錄（ir_ops_core.js）裡 pl 的輸出樣板用同一個剖析器剖成樣式（`$N` 換成佔位識別字），「進」時結構比對認出標準操作。
 *   buildPatterns() → 樣式表；fromSource(source, {patterns, name}) → { ir, coverage, diags } */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./ir_core.js'), require('./ir_ops_core.js')); else root.FaIrInPerl = factory(root.FaIr, root.FaIrOps); })(typeof self !== 'undefined' ? self : this, function (IR, OPS) {
    'use strict';
    const PH = /^__a(\d)$/;
    // ---------- 詞彙 ----------
    const OPS_LIST = ['<=>', '**=', '||=', '&&=', '//=', '**', '++', '--', '->', '=>', '==', '!=', '<=', '>=', '&&', '||', '//', '..', '+=', '-=', '*=', '/=', '.=', '%=', '=~', '!~', '<<', '>>'];
    const WORD_OPS = new Set(['eq', 'ne', 'lt', 'gt', 'le', 'ge', 'x', 'and', 'or', 'not', 'xor', 'cmp', 'if', 'unless', 'while', 'until', 'return', 'foreach', 'for']);
    function lex(src) {
        const toks = []; let i = 0, row = 0; const n = src.length;
        const operandEnd = () => { const p = toks[toks.length - 1]; if (!p) return false; if (p.t === 'num' || p.t === 'str' || p.t === 'var' || p.t === 'rl') return true; if (p.t === 'op') return p.v === ')' || p.v === ']' || p.v === '}'; if (p.t === 'ident') return false; return false; };
        const push = (t, v, s, e, extra) => { const o = Object.assign({ t, v, s, e, row }, extra || {}); toks.push(o); return o; };
        while (i < n) {
            const c = src[i];
            if (c === '\n') { row++; i++; continue; } if (/\s/.test(c)) { i++; continue; }
            if (c === '#') { const s = i; while (i < n && src[i] !== '\n') i++; push('cmt', src.slice(s + 1, i).replace(/^\s/, ''), s, i); continue; }
            if (c === '"' || c === "'") { // 字串
                const s = i; i++; let raw = ''; let interp = false;
                while (i < n && src[i] !== c) { if (src[i] === '\\' && i + 1 < n) { raw += src[i] + src[i + 1]; i += 2; continue; } if (c === '"' && (src[i] === '$' || src[i] === '@') && /[A-Za-z_{]/.test(src[i + 1] || '')) interp = true; if (src[i] === '\n') row++; raw += src[i++]; }
                i++; push('str', raw, s, i, { q: c, interp }); continue;
            }
            if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || '') && !operandEnd())) { const m = /^(?:0[xX][0-9a-fA-F_]+|[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?|\.[0-9]+)/.exec(src.slice(i)); const s = i; i += m[0].length; push('num', m[0].replace(/_/g, ''), s, i); continue; }
            if (c === '$') {
                const s = i; const m = /^\$(?:#?[A-Za-z_][A-Za-z_0-9]*(?:::[A-Za-z_][A-Za-z_0-9]*)*|[0-9]+)/.exec(src.slice(i));
                if (m) { i += m[0].length; push('var', m[0], s, i, { sig: '$', name: m[0].slice(1) }); continue; }
                if (src[i + 1] === '{') { i += 2; push('op', '${', s, i); continue; }
                if (src[i + 1] === '$') { i += 1; push('op', '$', s, i); continue; }
                i += 2; push('var', src.slice(s, i), s, i, { sig: '$', name: src[s + 1] }); continue;
            }
            if (c === '@' || (c === '%' && !operandEnd())) {
                const s = i; const m = /^[@%][A-Za-z_][A-Za-z_0-9]*(?:::[A-Za-z_][A-Za-z_0-9]*)*/.exec(src.slice(i));
                if (m) { i += m[0].length; push('var', m[0], s, i, { sig: c, name: m[0].slice(1) }); continue; }
                if (src[i + 1] === '{') { i += 2; push('op', c + '{', s, i); continue; }
                if (c === '@' && src[i + 1] === '_') { i += 2; push('var', '@_', s, i, { sig: '@', name: '_' }); continue; }
            }
            if (/[A-Za-z_]/.test(c)) {
                const s = i; const m = /^[A-Za-z_][A-Za-z_0-9]*(?:::[A-Za-z_][A-Za-z_0-9]*)*/.exec(src.slice(i)); const w = m[0]; i += w.length;
                if (/^(?:s|m|qr|tr|y)$/.test(w) && /^[\/{!|#]/.test(src[i] || '') && !(toks.length && toks[toks.length - 1].v === '->')) { // 正規表示式 s/…/…/flags、m/…/、qr/…/
                    const d = src[i]; const close = d === '{' ? '}' : d; let j = i + 1, parts = 0; const need = (w === 's' || w === 'tr' || w === 'y') ? 2 : 1;
                    while (j < n && parts < need) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === close) parts++; j++; }
                    while (j < n && /[a-z]/.test(src[j])) j++; i = j; push('rl', src.slice(s, i), s, i); continue;
                }
                push('ident', w, s, i); continue;
            }
            if (c === '/' && !operandEnd()) { const s = i; let j = i + 1; while (j < n && src[j] !== '/') { if (src[j] === '\\') j++; j++; } j++; while (j < n && /[a-z]/.test(src[j])) j++; i = j; push('rl', src.slice(s, i), s, i); continue; }
            if (c === '<' && !operandEnd()) { const m = /^<(?:STDIN|\$[A-Za-z_]\w*)>/.exec(src.slice(i)); if (m) { const s = i; i += m[0].length; push('rd', m[0], s, i); continue; } }
            let op = null; for (const o of OPS_LIST) if (src.startsWith(o, i)) { op = o; break; }
            if (!op) op = c; const s = i; i += op.length; push('op', op, s, i);
        }
        return toks;
    }
    // ---------- 剖析（AST 節點：{ y:類型, v:值, k:[子節點], s,e:原文範圍, row }）----------
    const N = (y, v, k, a, b) => ({ y, v, k: k || [], s: a ? a.s : 0, e: b ? b.e : (a ? a.e : 0), row: a ? a.row : 0 });
    const NAMED_UNARY = new Set(['exists', 'delete', 'pop', 'shift', 'chomp', 'keys', 'values', 'scalar', 'defined', 'reverse', 'uc', 'lc', 'int', 'abs', 'ref', 'length', 'chr', 'ord', 'sqrt', 'quotemeta', 'lcfirst', 'ucfirst', 'undef']);
    const LIST_OPS = new Set(['push', 'unshift', 'join', 'print', 'die', 'splice', 'printf', 'sprintf', 'substr', 'index', 'split', 'sort', 'map', 'grep', 'open', 'close', 'warn', 'return']);
    const BIN = { 'or': 1, 'xor': 1, 'and': 2, '=': 5, '+=': 5, '-=': 5, '*=': 5, '/=': 5, '.=': 5, '%=': 5, '**=': 5, '||=': 5, '&&=': 5, '//=': 5, '?': 6, '..': 7, '||': 8, '//': 8, '&&': 9, '|': 10, '^': 10, '&': 11, '==': 12, '!=': 12, '<=>': 12, 'eq': 12, 'ne': 12, 'cmp': 12, '<': 13, '>': 13, '<=': 13, '>=': 13, 'lt': 13, 'gt': 13, 'le': 13, 'ge': 13, '<<': 15, '>>': 15, '+': 16, '-': 16, '.': 16, '*': 17, '/': 17, '%': 17, 'x': 17, '=~': 18, '!~': 18, '**': 20 };
    function parser(toks) {
        let p = 0; const sig = () => { while (p < toks.length && toks[p].t === 'cmt') p++; return toks[p]; };
        const peek = () => sig(); const next = () => { const t = sig(); p++; return t; };
        const isOp = (v) => { const t = peek(); return t && t.t === 'op' && t.v === v; };
        const isId = (v) => { const t = peek(); return t && t.t === 'ident' && t.v === v; };
        const fail = (m) => { const t = toks[p]; throw new Error('Perl 剖析：' + m + (t ? '（在「' + t.v + '」附近）' : '（檔尾）')); };
        const expect = (v) => { if (!isOp(v)) fail('缺少 ' + v); return next(); };
        function parseList(endV) { // 逗號分隔的運算式，到 endV（不吃掉）
            const items = []; while (peek() && !isOp(endV)) { items.push(parseExpr(5)); if (isOp(',') || isOp('=>')) { next(); continue; } break; } return items;
        }
        function listNoParen() { const items = []; for (;;) { const t = peek(); if (!t || (t.t === 'op' && /^[;)}\]:]$/.test(t.v)) || (t.t === 'ident' && /^(if|unless|while|until|for|foreach|or|and)$/.test(t.v))) break; items.push(parseExpr(5)); if (isOp(',') || isOp('=>')) { next(); continue; } break; } return items; }
        function recover(start, err) { // 剖不了的敘述：跳到本層的 ;（吃掉）或本層的 }（不吃），整段收成 badstmt
            p = start; const first = toks[start]; let depth = 0, last = first;
            while (p < toks.length) { const tk = toks[p]; if (tk.t === 'op') { if (/^[@%$]?\{$/.test(tk.v)) depth++; else if (tk.v === '}') { if (depth === 0) break; depth--; if (depth === 0 && !(toks[p + 1] && toks[p + 1].t === 'ident' && /^(else|elsif)$/.test(toks[p + 1].v))) { last = tk; p++; break; } } else if (tk.v === ';' && depth === 0) { last = tk; p++; break; } } last = tk; p++; }
            if (p === start) p++;
            return { y: 'badstmt', v: String(err.message), row: first.row, s: first.s, e: last.e, k: [] };
        }
        function parseBlock() { // { 敘述… }，回傳 {y:'block', k:[項目]}，項目可以是註解 {y:'cmt'} 或敘述節點
            const o = expect('{'); const items = []; for (;;) { const t = toks[p]; if (!t) fail('區塊沒有結束'); if (t.t === 'cmt') { p++; items.push({ y: 'cmt', v: t.v, row: t.row, s: t.s, e: t.e, k: [] }); continue; } if (t.t === 'op' && t.v === '}') break; const st0 = p; try { items.push(parseStmt()); } catch (err) { items.push(recover(st0, err)); } }
            const c = next(); const b = N('block', '', items, o, c); b.hdrRow = o.row; return b;
        }
        function term() {
            const t = next(); if (!t) fail('運算式不完整');
            let r;
            if (t.t === 'num') r = N('num', t.v, [], t, t);
            else if (t.t === 'str') r = N(t.interp ? 'interp' : 'str', t.q === "'" ? t.v.replace(/\\(['\\])/g, '$1') : t.v, [], t, t);
            else if (t.t === 'var') r = N('var', t.v, [], t, t);
            else if (t.t === 'rd') r = N('rd', t.v, [], t, t);
            else if (t.t === 'rl') r = N('rl', t.v, [], t, t);
            else if (t.t === 'op') {
                if (t.v === '(') { const items = parseList(')'); const c = expect(')'); r = items.length === 1 ? N('paren', '', items, t, c) : N('list', '', items, t, c); }
                else if (t.v === '[') { const items = parseList(']'); const c = expect(']'); r = N('anonarr', '', items, t, c); }
                else if (t.v === '{') { const items = parseList('}'); const c = expect('}'); r = N('anonhash', '', items, t, c); }
                else if (t.v === '@{' || t.v === '%{' || t.v === '${') { const e = parseExpr(5); const c = expect('}'); r = N('deref', t.v[0], [e], t, c); }
                else if (t.v === '$') { const e = term(); r = N('deref', '$', [e], t, e); }
                else if (t.v === '!') { const e = parseExpr(19); r = N('un', '!', [e], t, e); }
                else if (t.v === '-' || t.v === '+') { const e = parseExpr(19); r = N('un', t.v, [e], t, e); }
                else if (t.v === '\\') { const e = parseExpr(19); r = N('un', '\\', [e], t, e); }
                else if (t.v === '&') { const id = next(); if (!id || id.t !== 'ident') fail('& 後面要接名稱'); let args = []; let e = id; if (isOp('(')) { next(); args = parseList(')'); e = expect(')'); } r = N('ucall', id.v, args, t, e); }
                else fail('不認得的符號 ' + t.v);
            } else if (t.t === 'ident') {
                const w = t.v;
                if (w === 'my' || w === 'our' || w === 'local') {
                    if (w === 'local') fail('local'); if (isOp('(')) { next(); const vs = []; while (!isOp(')')) { const v = next(); if (!v || v.t !== 'var') fail('my 清單'); vs.push(N('var', v.v, [], v, v)); if (isOp(',')) next(); } const c = expect(')'); r = N('mylist', '', vs, t, c); }
                    else { const v = next(); if (!v || v.t !== 'var') fail('my 後面要接變數'); r = N('my', v.v, [], t, v); }
                } else if (w === 'do' && isOp('{')) { const b = parseBlock(); r = N('doblock', '', [b], t, b); }
                else if ((w === 'map' || w === 'grep' || w === 'sort') && isOp('{')) { const b = parseBlock(); if (isOp(',')) next(); const args = listNoParen(); r = N('call', w, [b].concat(args), t, args.length ? args[args.length - 1] : b); }
                else if (isOp('(')) { next(); const args = parseList(')'); const c = expect(')'); r = N('call', w, args, t, c); }
                else if (PH.test(w)) r = N('ph', w, [], t, t);
                else if (NAMED_UNARY.has(w)) { const nx = peek(); if (!nx || (nx.t === 'op' && /^[;)}\]:,?]$/.test(nx.v)) || (nx.t === 'ident' && WORD_OPS.has(nx.v))) r = N('call', w, [], t, t); else { const e = parseExpr(14); r = N('call', w, [e], t, e); } }
                else if (LIST_OPS.has(w)) { const args = listNoParen(); r = N('call', w, args, t, args.length ? args[args.length - 1] : t); }
                else r = N('bare', w, [], t, t);
            } else fail('不認得的記號 ' + t.v);
            return postfix(r);
        }
        function postfix(r) {
            for (;;) {
                if (isOp('->')) { const a = next(); if (isOp('[')) { next(); const i = parseExpr(5); const c = expect(']'); r = N('idx', '', [r, i], a, c); r.s = r.k[0].s; continue; } if (isOp('{')) { next(); let key; const t = peek(); if (t && t.t === 'ident' && !PH.test(t.v) && toks[p + 1] && toks[p + 1].t === 'op' && toks[p + 1].v === '}') { next(); key = N('str', t.v, [], t, t); } else key = parseExpr(5); const c = expect('}'); r = N('hkey', '', [r, key], a, c); r.s = r.k[0].s; continue; } fail('-> 後面的形式'); }
                if ((r.y === 'idx' || r.y === 'hkey') && (isOp('[') || isOp('{'))) { const br = next(); const i = parseExpr(5); const c = expect(br.v === '[' ? ']' : '}'); r = N(br.v === '[' ? 'idx' : 'hkey', '', [r, i], br, c); r.s = r.k[0].s; continue; }
                if (isOp('++') || isOp('--')) { const o = next(); r = N('post', o.v, [r], r, o); continue; }
                break;
            }
            return r;
        }
        function parseExpr(minPrec) {
            let left;
            if (isId('not')) { const t = next(); const e = parseExpr(3); left = N('un', '!', [e], t, e); } else left = term();
            for (;;) {
                const t = peek(); if (!t) break; const op = t.t === 'op' || t.t === 'ident' ? t.v : null; const pr = op != null ? BIN[op] : undefined; if (pr === undefined || pr < minPrec || (t.t === 'ident' && !WORD_OPS.has(op))) break;
                next();
                if (op === '?') { const a = parseExpr(5); expect(':'); const b = parseExpr(6); left = N('cond', '', [left, a, b], left, b); continue; }
                const right = parseExpr(pr >= 5 && pr <= 5 || op === '**' ? pr : pr + 1);
                left = N(pr === 5 ? 'assign' : 'bin', op, [left, right], left, right);
            }
            return left;
        }
        function parseStmt() {
            const t = peek(); if (!t) fail('檔尾');
            const startTok = p; const done = (n) => { n.s = toks[startTok] ? toks[startTok].s : n.s; return n; };
            if (t.t === 'op' && t.v === ';') { next(); return N('empty', '', [], t, t); }
            if (t.t === 'op' && t.v === '{') { const b = parseBlock(); return N('bareblock', '', [b], t, b); }
            if (t.t === 'ident') {
                const w = t.v;
                if (w === 'sub') { next(); const nm = next(); if (!nm || nm.t !== 'ident') fail('sub 要有名稱'); const b = parseBlock(); return N('sub', nm.v, [b], t, b); }
                if (w === 'use' || w === 'no' || w === 'package') { while (peek() && !isOp(';')) next(); const c = next(); return N('use', w, [], t, c || t); }
                if (w === 'if' || w === 'unless') { next(); if (w === 'unless') fail('unless'); expect('('); const c = parseExpr(1); expect(')'); const th = parseBlock(); const o = N('if', '', [c, th], t, th); let cur = o;
                    for (;;) { if (isId('elsif')) { const et = next(); expect('('); const c2 = parseExpr(1); expect(')'); const b2 = parseBlock(); const e2 = N('if', '', [c2, b2], et, b2); cur.k[2] = e2; cur = e2; continue; } if (isId('else')) { next(); const b3 = parseBlock(); cur.k[2] = b3; } break; }
                    o.e = (toks[p - 1] || t).e; return o; }
                if (w === 'while') { next(); expect('('); const c = parseExpr(1); expect(')'); const b = parseBlock(); return N('while', '', [c, b], t, b); }
                if (w === 'for' || w === 'foreach') {
                    next();
                    if (isId('my')) { next(); const v = next(); if (!v || v.t !== 'var') fail('for my 變數'); expect('('); const items = parseList(')'); const c = expect(')'); const b = parseBlock(); const lst = items.length === 1 ? items[0] : N('list', '', items, t, c); return N('foreach', v.v, [lst, b], t, b); }
                    expect('('); const init = isOp(';') ? null : parseExpr(1); expect(';'); const cond = isOp(';') ? null : parseExpr(1); expect(';'); const upd = isOp(')') ? null : parseExpr(1); expect(')'); const b = parseBlock(); return N('cfor', '', [init, cond, upd, b], t, b);
                }
                if (w === 'return') { next(); const nx = peek(); let e = null; if (nx && !(nx.t === 'op' && (nx.v === ';' || nx.v === '}'))) { if (nx.t === 'ident' && /^(if|unless)$/.test(nx.v)) fail('修飾語句'); e = parseExpr(1); } if (isId('if') || isId('unless')) fail('修飾語句'); if (isOp(';')) next(); return N('return', '', e ? [e] : [], t, e || t); }
                if (w === 'last' || w === 'next') { next(); if (isId('if') || isId('unless')) fail('修飾語句'); if (isOp(';')) next(); return N(w, '', [], t, t); }
            }
            const e = parseExpr(1);
            if (peek() && peek().t === 'ident' && /^(if|unless|while|until|for|foreach)$/.test(peek().v)) fail('修飾語句');
            if (isOp(';')) next(); else if (!isOp('}') && peek()) fail('敘述沒有以 ; 結束');
            return done(N('expr', '', [e], t, e));
        }
        return { toks, parseExpr, parseStmt, peek, atEnd: () => !peek(), pos: () => p, setPos: (x) => { p = x; }, restSkip: () => p };
    }
    // ---------- 樣式 ----------
    const unwrap = (n) => { while (n && n.y === 'paren') n = n.k[0]; return n; };
    const size = (n) => 1 + n.k.reduce((s, c) => s + (c ? size(c) : 0), 0);
    function match(pt, nd, b) {
        pt = unwrap(pt); nd = unwrap(nd); if (!pt || !nd) return false;
        if (pt.y === 'ph') { const i = +PH.exec(pt.v)[1]; if (b[i]) return same(b[i], nd); b[i] = nd; return true; }
        if (pt.y !== nd.y || pt.v !== nd.v || pt.k.length !== nd.k.length) return false;
        if (!pt.k.length) return true;
        for (let i = 0; i < pt.k.length; i++) { if (!pt.k[i] && !nd.k[i]) continue; if (!match(pt.k[i], nd.k[i], b)) return false; }
        return true;
    }
    function same(a, b) { a = unwrap(a); b = unwrap(b); if (!a || !b) return a === b; if (a.y !== b.y || a.v !== b.v || a.k.length !== b.k.length) return false; return a.k.every((c, i) => same(c, b.k[i])); }
    const isPurePlaceholderBin = (p) => { const x = unwrap(p); return x && x.y === 'bin' && x.k.every((c) => unwrap(c).y === 'ph'); };
    function buildPatterns() {
        const out = [];
        for (const id of OPS.ids()) {
            const o = OPS.get(id); const cell = o.cells.pl; if (cell == null) continue;
            const tpls = typeof cell === 'string' ? [cell] : Object.values(cell).filter((x) => x != null);
            for (const t of tpls) {
                if (/\$\*/.test(t)) continue; const text = t.replace(/[$@](\d)(?![\d\w])/g, '__a$1').replace(/\$\{(\d)\}/g, '__a$1');
                let ast; try { const P = parser(lex(text)); ast = P.parseExpr(1); if (!P.atEnd()) continue; } catch (e) { continue; }
                if (ast.y === 'ph') continue; if (isPurePlaceholderBin(ast)) continue;
                const nargs = Math.max(0, ...[...text.matchAll(/__a(\d)/g)].map((m) => +m[1] + 1)); out.push({ op: id, pat: ast, size: size(ast), nargs, stmt: !!o.stmt });
            }
        }
        out.sort((a, b) => b.size - a.size); return out;
    }
    // ---------- 轉成 IR ----------
    function unq(raw) { const M = { n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\', '"': '"', '$': '$', '@': '@', e: '\x1b', a: '\x07' }; return raw.replace(/\\(?:x([0-9a-fA-F]{1,2})|x\{([0-9a-fA-F]+)\}|(.))/g, (m, x, xb, c) => (x ? String.fromCharCode(parseInt(x, 16)) : xb ? String.fromCodePoint(parseInt(xb, 16)) : M[c] != null ? M[c] : c)); }
    function fromSource(source, opts) {
        opts = opts || {}; const src = String(source || ''); const patterns = opts.patterns || [];
        const cov = { stmts: 0, natives: 0, comments: 0, comments_kept: 0 }; const diags = [];
        const rowsToPos = (n) => [n.row + 1, 0, n.row + 1, 0];
        const diag = (m, n) => diags.push({ level: 'warn', msg: m, pos: n ? rowsToPos(n) : undefined });
        const native = (n, why, stmtLevel) => { cov.natives++; diag((stmtLevel ? '敘述' : '運算式') + '收成原生區塊：' + why, n); return { k: 'native', lang: 'perl', src: src.slice(n.s, n.e), why, pos: rowsToPos(n) }; };
        const L = (t, v) => ({ k: 'lit', t, v });
        const fixName = (s) => (s === 'main_' ? 'main' : s);
        const toks = lex(src); const P = parser(toks);
        // 先掃出定義的 sub 名（用 token，不需完整剖析）
        const defined = new Set(); for (let i = 0; i < toks.length - 1; i++) if (toks[i].t === 'ident' && toks[i].v === 'sub' && toks[i + 1].t === 'ident') defined.add(toks[i + 1].v);
        const varName = (v) => v.slice(1);
        const CMPW = { eq: '==', ne: '!=', lt: '<', gt: '>', le: '<=', ge: '>=', '==': '==', '!=': '!=', '<': '<', '>': '>', '<=': '<=', '>=': '>=' };
        function tryOps(n) {
            for (const p of patterns) { const b = []; if (match(p.pat, n, b)) { let ok = true; const args = []; for (let i = 0; i < p.nargs; i++) { if (!b[i]) { ok = false; break; } args.push(b[i]); } if (!ok) continue; const cargs = args.map(ex); let op = p.op;
                if (op === 'str.join' && !(cargs[1] && cargs[1].k === 'call' && /^str\.split/.test(cargs[1].op || ''))) op = 'str.join_num';
                if (op === 'list.get' && cargs.length === 2) return { k: 'index', o: cargs[0], i: cargs[1], pos: rowsToPos(n) };
                return { k: 'call', op, args: cargs, pos: rowsToPos(n) }; } }
            return null;
        }
        const LEAF = new Set(['num', 'str', 'var']);
        function ex(n) {
            if (!n) return null; n = unwrap(n);
            if (!LEAF.has(n.y) && patterns.length) { const r = tryOps(n); if (r) return r; }
            const pos = rowsToPos(n);
            switch (n.y) {
                case 'num': return { k: 'lit', t: /[.eE]/.test(n.v) && !/^0x/i.test(n.v) ? 'float' : 'int', v: n.v, pos };
                case 'str': return { k: 'lit', t: 'str', v: unq(n.v), pos };
                case 'var': if (n.v[0] !== '$') return native(n, '非純量變數 ' + n.v); return { k: 'name', v: varName(n.v), pos };
                case 'deref': if (n.v === '$') return native(n, '純量解參考'); return ex(n.k[0]);
                case 'idx': return { k: 'index', o: ex(n.k[0]), i: ex(n.k[1]), pos };
                case 'hkey': return { k: 'index', o: ex(n.k[0]), i: ex(n.k[1]), pos };
                case 'anonarr': return { k: 'list', items: n.k.map(ex), pos };
                case 'anonhash': { const it = []; for (let i = 0; i + 1 < n.k.length; i += 2) it.push([ex(n.k[i]), ex(n.k[i + 1])]); return { k: 'dict', items: it, pos }; }
                case 'cond': return { k: 'cond', a: ex(n.k[0]), c: ex(n.k[1]), b: ex(n.k[2]), pos };
                case 'un': { if (n.v === '!') { const x = unwrap(n.k[0]); if (x.y === 'call' && x.v === 'defined' && x.k.length === 1) return { k: 'cmp', op: '==', l: ex(x.k[0]), r: L('none', 'None'), pos }; return { k: 'not', e: ex(n.k[0]), pos }; } if (n.v === '-' || n.v === '+') return { k: 'un', op: n.v, e: ex(n.k[0]), pos }; return native(n, '一元運算子 ' + n.v); }
                case 'bin': {
                    const op = n.v; if (CMPW[op]) return { k: 'cmp', op: CMPW[op], l: ex(n.k[0]), r: ex(n.k[1]), pos };
                    if (op === '&&' || op === 'and') return { k: 'logic', op: 'and', l: ex(n.k[0]), r: ex(n.k[1]), pos }; if (op === '||' || op === 'or') return { k: 'logic', op: 'or', l: ex(n.k[0]), r: ex(n.k[1]), pos };
                    if (op === '.') return { k: 'bin', op: '+', l: ex(n.k[0]), r: ex(n.k[1]), pos };
                    if (['+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>'].indexOf(op) >= 0) return { k: 'bin', op, l: ex(n.k[0]), r: ex(n.k[1]), pos };
                    return native(n, '運算子 ' + op);
                }
                case 'call': {
                    if (n.v === 'defined' && n.k.length === 1) return { k: 'cmp', op: '!=', l: ex(n.k[0]), r: L('none', 'None'), pos };
                    if (n.v === 'undef' && !n.k.length) return L('none', 'None');
                    if (defined.has(n.v) && n.v.indexOf('fa_') !== 0) return { k: 'call', fn: fixName(n.v), args: n.k.map(ex), pos };
                    return native(n, '呼叫 ' + n.v + ' 不在標準操作目錄');
                }
                case 'ucall': return { k: 'call', fn: fixName(n.v), args: n.k.map(ex), pos };
                case 'bare': if (defined.has(n.v)) return { k: 'call', fn: fixName(n.v), args: [], pos }; return native(n, '裸字 ' + n.v);
                case 'ph': return native(n, '佔位');
                default: return native(n, n.y);
            }
        }
        // ---- 敘述 ----
        const targetOf = (n) => { const t = unwrap(n); if (t.y === 'var' && t.v[0] === '$') return { k: 'name', v: varName(t.v), pos: rowsToPos(t) }; if (t.y === 'idx' || t.y === 'hkey') return { k: 'index', o: ex(t.k[0]), i: ex(t.k[1]), pos: rowsToPos(t) }; return null; };
        function exprStmt(n, stmtNode) {
            const e = unwrap(stmtNode.k[0]);
            if (e.y === 'assign') {
                const l = unwrap(e.k[0]), r = e.k[1]; const op = e.v;
                if (l.y === 'my') { if (op !== '=') return native(stmtNode, '宣告加複合賦值', true); return { k: 'assign', to: { k: 'name', v: varName(l.v), pos: rowsToPos(l) }, val: ex(r), decl: true, pos: rowsToPos(stmtNode) }; }
                const tg = targetOf(l);
                if (tg) { if (op === '=') return { k: 'assign', to: tg, val: ex(r), pos: rowsToPos(stmtNode) }; const bop = op === '.=' ? '+' : op.replace(/=$/, ''); if (['+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>'].indexOf(bop) < 0) return native(stmtNode, '複合賦值 ' + op, true); return { k: 'aug', to: tg, op: bop, val: ex(r), pos: rowsToPos(stmtNode) }; }
            }
            if (e.y === 'post') { const tg = targetOf(e.k[0]); if (tg) return { k: 'aug', to: tg, op: e.v === '++' ? '+' : '-', val: L('int', '1'), pos: rowsToPos(stmtNode) }; }
            if (e.y === 'call' && e.v === 'die') return { k: 'raise', val: e.k[0] ? ex(e.k[0]) : undefined, pos: rowsToPos(stmtNode) };
            const x = ex(e); if (x.k === 'native') { cov.natives--; return native(stmtNode, x.why, true); }
            return { k: 'expr', e: x, pos: rowsToPos(stmtNode) };
        }
        function conv(n) { // 單一敘述節點 → [IR 敘述]
            cov.stmts++;
            switch (n.y) {
                case 'expr': return [exprStmt(n.k[0] && n, n)];
                case 'return': return [{ k: 'ret', val: n.k[0] ? ex(n.k[0]) : undefined, pos: rowsToPos(n) }];
                case 'last': return [{ k: 'brk', pos: rowsToPos(n) }]; case 'next': return [{ k: 'cont', pos: rowsToPos(n) }];
                case 'sub': return [func(n)];
                case 'if': return [ifS(n)];
                case 'while': { const o = { k: 'while', cond: ex(n.k[0]), body: [], pos: rowsToPos(n) }; o.body = body(n.k[1]); return [attachHdr(o, n.k[1])]; }
                case 'foreach': { const lst = unwrap(n.k[0]); let iter, dictKeys = false; if (lst.y === 'call' && lst.v === 'keys' && lst.k.length === 1) { iter = ex(lst.k[0]); dictKeys = true; } else iter = ex(lst); if (iter.k === 'native') return [native(n, '走訪的對象', true)]; void dictKeys; const o = { k: 'foreach', var: varName(n.v), iter, body: [], pos: rowsToPos(n) }; o.body = body(n.k[1]); return [attachHdr(o, n.k[1])]; }
                case 'cfor': return cfor(n);
                case 'use': case 'empty': return [];
                default: return [native(n, n.y, true)];
            }
        }
        function cfor(n) {
            const [init, cond, upd, bl] = n.k; const fall = (w) => [native(n, w, true)];
            if (!init || !cond || !upd) return fall('for 標頭不是標準形');
            const i0 = unwrap(init); if (i0.y !== 'assign' || i0.v !== '=' || unwrap(i0.k[0]).y !== 'my') return fall('for 初始化'); const v = varName(unwrap(i0.k[0]).v); const from = ex(i0.k[1]);
            const c0 = unwrap(cond); if (c0.y !== 'bin' || (c0.v !== '<' && c0.v !== '>') || !(unwrap(c0.k[0]).y === 'var' && varName(unwrap(c0.k[0]).v) === v)) return fall('for 條件'); const to = ex(c0.k[1]); const lt = c0.v === '<';
            const u0 = unwrap(upd); let step = null;
            if (u0.y === 'post' && unwrap(u0.k[0]).v === '$' + v) { if ((u0.v === '++') !== lt) return fall('for 方向'); if (u0.v === '--') step = { k: 'un', op: '-', e: L('int', '1') }; }
            else if (u0.y === 'assign' && (u0.v === '+=' || u0.v === '-=') && unwrap(u0.k[0]).v === '$' + v) { const r = ex(u0.k[1]); if (r.k !== 'lit' || r.t !== 'int') return fall('for 增量'); const pos = u0.v === '+='; if (pos !== lt) return fall('for 方向'); step = pos ? (r.v === '1' ? null : r) : { k: 'un', op: '-', e: r }; }
            else return fall('for 增量');
            const o = { k: 'forrange', var: v, from, to, body: body(bl), pos: rowsToPos(n) }; if (step) o.step = step; return [attachHdr(o, bl)];
        }
        function ifS(n) {
            const o = { k: 'if', cond: ex(n.k[0]), then: body(n.k[1]), pos: rowsToPos(n) }; attachHdr(o, n.k[1]);
            const alt = n.k[2]; if (alt) { if (alt.y === 'if') o.else = [ifS(alt)]; else o.else = body(alt); }
            return o;
        }
        function attachHdr(o, bl) { const arr = o.body || o.then || []; const h = arr.hdr || []; if (h.length) { o.c = o.c || {}; o.c.a = h.join(' '); } return o; }
        // 區塊的內容（含註解）→ IR 敘述陣列；註解掛法同其他「進」
        function body(bl, skipFn) { return build(bl.k, bl.hdrRow, skipFn); }
        function build(items, headerRow, skipFn) {
            const out = []; let pending = []; let prev = null, prevEnd = -1; const hdr = []; out.hdr = hdr;
            for (const it of items) {
                if (it.y === 'cmt') {
                    cov.comments++; const row = it.row;
                    if (headerRow != null && row === headerRow && !prev) { hdr.push(it.v); cov.comments_kept++; continue; }
                    if (prev && row === prevEnd) { prev.c = prev.c || {}; prev.c.a = prev.c.a ? prev.c.a + ' ' + it.v : it.v; cov.comments_kept++; continue; }
                    pending.push({ t: it.v, row }); continue;
                }
                if (skipFn && skipFn(it)) continue;
                const ss = conv(it); if (!ss.length) continue;
                const endRow = endRowOf(it); const lastRowBefore = pending.length ? pending[pending.length - 1].row : prevEnd; const gap = prevEnd >= 0 || pending.length ? it.row - lastRowBefore - 1 : 0; const first = ss[0];
                if (pending.length) { first.c = first.c || {}; first.c.b = pending.map((p) => p.t).concat(first.c.b || []); cov.comments_kept += pending.length; const g0 = pending[0].row - (prevEnd >= 0 ? prevEnd : pending[0].row) - 1; if (g0 > 0 && prevEnd >= 0) first.c.sp = 1; pending = []; }
                else if (gap > 0 && prevEnd >= 0) { first.c = first.c || {}; first.c.sp = 1; }
                ss.forEach((s) => out.push(s)); prev = ss[ss.length - 1]; prevEnd = endRow;
            }
            if (pending.length) pending.forEach((p) => { out.push({ k: 'comment', s: p.t }); cov.comments_kept++; });
            return out;
        }
        const endRowOf = (n) => { let r = n.row; const walk = (x) => { if (!x) return; if (x.row > r) r = x.row; (x.k || []).forEach(walk); }; walk(n); return endRowByPos(n.e) > r ? endRowByPos(n.e) : r; };
        const rowStarts = (() => { const a = [0]; for (let i = 0; i < src.length; i++) if (src[i] === '\n') a.push(i + 1); return a; })();
        function endRowByPos(pos) { let lo = 0, hi = rowStarts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (rowStarts[m] <= Math.max(0, pos - 1)) lo = m; else hi = m - 1; } return lo; }
        function func(n) {
            const bl = n.k[0]; let params = []; const isParamLine = (it) => { if (it.y !== 'expr') return false; const e = unwrap(it.k[0]); return e.y === 'assign' && e.v === '=' && unwrap(e.k[0]).y === 'mylist' && unwrap(e.k[1]).v === '@_'; };
            const firstStmt = bl.k.find((x) => x.y !== 'cmt'); if (firstStmt && isParamLine(firstStmt)) params = unwrap(firstStmt.k[0]).k[0].k.map((x) => ({ name: varName(x.v) }));
            const o = { k: 'func', name: fixName(n.v), params, body: [], pos: rowsToPos(n) };
            o.body = body(bl, (it) => it === firstStmt && params.length > 0); const h = o.body.hdr || []; if (h.length) { o.c = o.c || {}; o.c.a = h.join(' '); } return o;
        }
        // ---- 模組層：逐句剖析，剖不了的整句收成 native 再往下 ----
        const ir = IR.mod({ src: { lang: 'perl', file: opts.file }, name: opts.name || 'Module' }); const items = [];
        while (P.pos() < toks.length) {
            const t0 = toks[P.pos()]; if (t0 && t0.t === 'cmt') { P.setPos(P.pos() + 1); items.push({ y: 'cmt', v: t0.v, row: t0.row, s: t0.s, e: t0.e, k: [] }); continue; }
            const start = P.pos();
            if (t0 && t0.t === 'ident' && t0.v === 'sub' && toks[start + 1] && /^fa_/.test(toks[start + 1].v)) { // 輸出器自己加的輔助函式：用配對的大括號整段略過
                let depth = 0, q = start; for (; q < toks.length; q++) { const tk = toks[q]; if (tk.t !== 'op') continue; if (/^[@%$]?\{$/.test(tk.v)) depth++; else if (tk.v === '}') { depth--; if (depth === 0) { q++; break; } } }
                P.setPos(q); continue;
            }
            try {
                const st = P.parseStmt(); items.push(st);
                if (st.y === 'sub' && /^fa_/.test(st.v)) items[items.length - 1] = { y: 'helper', v: st.v, row: st.row, s: st.s, e: st.e, k: [] };
            } catch (err) { // 剖不了：跳到下一個頂層 ; 或配對的 }，整段收成原生區塊
                const first = toks[start]; let depth = 0, q = start; for (; q < toks.length; q++) { const tk = toks[q]; if (tk.t !== 'op') continue; if (tk.v === '{' || tk.v === '@{' || tk.v === '%{' || tk.v === '${') depth++; else if (tk.v === '}') { depth--; if (depth <= 0) { q++; break; } } else if (tk.v === ';' && depth === 0) { q++; break; } }
                P.setPos(Math.max(q, start + 1)); const last = toks[Math.min(q, toks.length) - 1] || first; items.push({ y: 'badstmt', v: String(err.message), row: first.row, s: first.s, e: last.e, k: [] });
            }
        }
        const top = build(items.filter((x) => x.y !== 'helper' && x.y !== 'use'), undefined);
        // badstmt 在 build 內走 conv 的 default → native；這裡補上原因
        const body_ = []; for (const s of top) { if (s.k === 'expr' && s.e && s.e.k === 'call' && s.e.fn === 'main' && !(s.e.args || []).length) continue; body_.push(s); }
        ir.body = body_.filter((s) => !(s.k === 'pass' && !s.c));
        if (IR.funcs(ir).some((x) => x.name === 'main')) ir.entry = 'main';
        return { ir, coverage: cov, diags };
    }
    return { buildPatterns, fromSource, lex };
});
