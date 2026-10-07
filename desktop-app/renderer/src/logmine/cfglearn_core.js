/* 從文字學出「遞迴的產生式」並建 LALR(1) 分析表（FaCfgLearn）：像 bison／yacc 的文法，但是從輸入自己長出來。
 *
 * 流程（一行一行讀）：
 *   ① 詞彙：沿用 FaGram 找出的詞彙層（運算子、關鍵字、引號、註解…）把每一行切成終端符號（NAME／NUM／STR／VAR 與各種字面符號）
 *   ② 先用目前的 LALR 表解析這一行；吃得掉就不用學（這是「預測涵蓋率」：靠之前讀過的行就預測得到）
 *   ③ 吃不掉：取出「解析不了的地方」，依序嘗試
 *        A. 換成別的規則：把出錯位置的符號換成「這裡本來可以接受的」其他符號，整行就能解析 → 兩個符號其實是同一類，合併成一個類別（op、kw、cls_n）
 *        B. 沿用前綴：失敗之前已經歸約好的符號（堆疊）＋ 剩下部分的一般化形狀 → 一條由既有符號組合出來的新規則
 *        C. 當成新規則：整行的一般化形狀
 *      每一種做完都重建分析表、重新解析驗證，通不過就退回，換下一種。
 *   ④ 一般化形狀：括號配對 → 遞迴的群組（grp → '[' items ']'，items → list，list → list ',' elem，elem → val，val → grp…）；
 *      運算子後面的部分 → 自由的值序列（value → value atom | atom）；重複的單元 → 左遞迴列表（rep → rep unit | unit）；清單記號 → stmt → '-' stmt（遞迴）
 *   ⑤ 區塊：縮排（INDENT／DEDENT）與大括號（open … close）在讀完之後長成遞迴的 items，再用整份 token 串驗證
 * 產出：文法（產生式）、LALR 分析表、衝突清單、bison 風格文字、學習曲線（預測涵蓋率、各種修補的次數）。純函式（UMD），不呼叫模型。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaCfgLearn = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const LR = (typeof FaLR !== 'undefined' && FaLR) || (typeof self !== 'undefined' && self.FaLR) || (typeof require === 'function' ? require('./lr_core.js') : null);
    const GR = (typeof FaGram !== 'undefined' && FaGram) || (typeof self !== 'undefined' && self.FaGram) || (typeof require === 'function' ? require('./gram_core.js') : null);
    const CLASS = new Set(['STR', 'NUM', 'NAME', 'VAR', 'RAW']); const STRUCT = new Set(['NL', 'INDENT', 'DEDENT']);
    const BR = { '(': ['paren', ')'], '[': ['brack', ']'], '{': ['brace', '}'] };

    // ---------- ① 詞彙 ----------
    function lexLine(g, text) {
        const toks = []; const quotes = (g.quotes && g.quotes.length) ? g.quotes : ['"', "'"]; const ops = (g.ops || []).slice().sort((a, b) => b.length - a.length); const sig = (g.refSigils && g.refSigils.length) ? g.refSigils : ['$']; const n = text.length; let i = 0;
        while (i < n) {
            const c = text[i]; if (/\s/.test(c)) { i++; continue; }
            if (quotes.includes(c)) { let j = i + 1; while (j < n && text[j] !== c) { if (text[j] === '\\') j++; j++; } const e = Math.min(j + 1, n); toks.push({ t: 'STR', v: text.slice(i, e) }); i = e; continue; }
            if (sig.includes(c) && /[{(]/.test(text[i + 1] || '')) { const open = text[i + 1], close = open === '{' ? '}' : ')'; let j = i + 2, d = 1; while (j < n && d) { if (text[j] === open) d++; else if (text[j] === close) d--; j++; } toks.push({ t: 'VAR', v: text.slice(i, j) }); i = j; continue; }
            let op = null; for (const o of ops) if (text.startsWith(o, i)) { if (o === ':' && !(i + 1 >= n || /\s/.test(text[i + 1]))) continue; op = o; break; }
            if (op) { toks.push({ t: op, v: op }); i += op.length; continue; }
            const m = /^[A-Za-z_\d][\w.\-@]*/.exec(text.slice(i)); if (m) { toks.push({ t: /^\d+(?:\.\d+)?$/.test(m[0]) ? 'NUM' : 'NAME', v: m[0] }); i += m[0].length; continue; }
            toks.push({ t: c, v: c }); i++;
        }
        // 行首關鍵字、指令記號變成字面符號（關鍵字是從文字學出來的，不是事先列好）
        let k = 0; if (toks[0] && g.listMarker && toks[0].t === g.listMarker) k = 1; const w = toks[k];
        if (w && (g.sigils || []).includes(w.t) && toks[k + 1] && toks[k + 1].t === 'NAME') { toks.splice(k, 2, { t: w.t + toks[k + 1].v, v: w.t + toks[k + 1].v }); }
        else if (w && w.t === 'NAME' && (g.keywords || []).includes(w.v)) w.t = w.v;
        return toks;
    }
    // 整份文字 → 陳述串（行號、縮排、token）；函式本體的行是 RAW；註解與空白行略過
    function streamOf(g, text, maxLines) {
        const raw = String(text).split(/\r?\n/).slice(0, maxLines || 20000); const stmts = []; let opaque = false; const leaders = (g.comment && g.comment.leaders) || [];
        for (const s of GR.logical(raw, g)) {
            if (!s.text) continue; if (leaders.some((ld) => s.text.startsWith(ld) && !(ld === '--' && !/^--\s/.test(s.text)))) continue;
            const code = GR.stripTrailingComment(s.text, g).code; if (!code) continue;
            if (opaque) { if (/^\}\s*$/.test(code)) { opaque = false; stmts.push({ n: s.n, indent: s.indent, toks: [{ t: '}', v: '}' }], code }); } else stmts.push({ n: s.n, indent: s.indent, toks: [{ t: 'RAW', v: s.raw.trim() }], code, raw: true }); continue; }
            if (g.funcBodies && /^(?:(?:\w[\w-]*)\s+)?[A-Za-z_][\w:.${}-]*\s*\(\s*\)\s*\{\s*$/.test(code)) opaque = true;
            stmts.push({ n: s.n, indent: s.indent, toks: lexLine(g, code), code });
        }
        return stmts;
    }

    // ---------- 文法狀態 ----------
    function newState(g, seed) { const S = { g, prods: [], keys: new Set(), table: null, dirty: true, nCls: 0, trace: [] }; for (const p of seed || []) addProd(S, p.lhs, p.rhs, p.label); return S; }
    const pkey = (lhs, rhs) => lhs + '→' + rhs.join('\u0001');
    function addProd(S, lhs, rhs, label) { const k = pkey(lhs, rhs); if (S.keys.has(k)) return false; S.keys.add(k); S.prods.push({ lhs, rhs: rhs.slice(), label }); S.dirty = true; return true; }
    function removeProdAt(S, i) { const p = S.prods[i]; S.keys.delete(pkey(p.lhs, p.rhs)); S.prods.splice(i, 1); S.dirty = true; }
    function ensureTable(S) {
        if (!S.dirty && S.table !== undefined) return S.table; S.dirty = false; if (!S.prods.some((p) => p.lhs === 'stmt')) { S.table = null; return null; }
        try { S.table = LR.build({ start: 'stmt', productions: S.prods }); } catch (e) { S.table = null; } return S.table;
    }
    function parseToks(S, toks) { const t = ensureTable(S); if (!t) return { ok: false, error: { at: 0, token: toks[0] ? toks[0].t : '$end', expected: [], stack: [] } }; return LR.parse(t, toks.map((x, i) => ({ t: x.t, v: x.v, n: x.n, i, sub: x.sub, orig: x.orig }))); }

    // ---------- ④ 一般化形狀 ----------
    const isAtom = (s) => CLASS.has(s) || /^grp_/.test(s);
    function ensureVal(S) { for (const a of ['STR', 'NUM', 'NAME', 'VAR']) addProd(S, 'val', [a]); }
    function makeGroup(S, open, innerToks) {
        const [kind] = BR[open]; const close = BR[open][1]; const name = 'grp_' + kind; ensureVal(S);
        const inner = groupify(S, innerToks); // 內層先處理（遞迴）
        addProd(S, name, [open, 'items_' + kind, close]); addProd(S, 'val', [name]); addProd(S, 'items_' + kind, []); addProd(S, 'items_' + kind, ['list_' + kind]);
        const sep = inner.some((x) => x.t === ',') ? ',' : (inner.some((x) => x.t === ';') ? ';' : null);
        const elems = []; let cur = []; for (const x of inner) { if (sep && x.t === sep) { elems.push(cur); cur = []; } else cur.push(x); } if (cur.length) elems.push(cur);
        if (elems.length) { addProd(S, 'list_' + kind, ['elem_' + kind]); addProd(S, 'list_' + kind, sep ? ['list_' + kind, sep, 'elem_' + kind] : ['list_' + kind, 'elem_' + kind]); }
        else { const k = pkey('items_' + kind, ['list_' + kind]); const ix = S.prods.findIndex((q) => pkey(q.lhs, q.rhs) === k); if (ix >= 0 && !S.prods.some((q) => q.lhs === 'list_' + kind)) removeProdAt(S, ix); }
        for (const el of elems) {
            const syms = el.map((x) => x.t);
            if (syms.length === 1 && (CLASS.has(syms[0]) || /^grp_/.test(syms[0]))) addProd(S, 'elem_' + kind, ['val']);
            else if (syms.length >= 3 && (S.g.ops || []).includes(syms[1])) addProd(S, 'elem_' + kind, [syms[0], syms[1], 'val']);
            else if (syms.length && syms.every((s) => isAtom(s) || /^[^\w\s]$/.test(s))) { valueNT(S, syms); addProd(S, 'elem_' + kind, ['value']); }
            else if (syms.length) addProd(S, 'elem_' + kind, compress(S, syms));
        }
        return { t: name, v: '', group: true };
    }
    // 把一行 token 中配對的括號收成群組符號（群組的內容語言另外長成遞迴的產生式）；沒配對的括號（例如行尾的 {）留著
    function groupify(S, toks) {
        const out = []; for (let i = 0; i < toks.length; i++) {
            const t = toks[i]; if (BR[t.t]) { let d = 0, j = i; for (; j < toks.length; j++) { if (toks[j].t === t.t) d++; else if (toks[j].t === BR[t.t][1]) { d--; if (d === 0) break; } } if (j < toks.length && d === 0) { out.push(makeGroup(S, t.t, toks.slice(i + 1, j))); i = j; continue; } }
            out.push(t);
        }
        return out;
    }
    function valueNT(S, atoms) { ensureVal(S); addProd(S, 'value', ['value', 'vatom']); addProd(S, 'value', ['vatom']); for (const a of atoms) { const s = typeof a === 'string' ? a : a.t; addProd(S, 'vatom', [s]); } return 'value'; }
    // 重複的單元（週期 1～3，連續 ≥2 次）→ 左遞迴列表 rep_k → rep_k unit | unit
    function compress(S, seq) {
        let out = seq.slice(); for (let period = 3; period >= 1; period--) { for (let i = 0; i + 2 * period <= out.length; i++) { let reps = 1; while (i + (reps + 1) * period <= out.length && out.slice(i, i + period).every((s, k) => s === out[i + reps * period + k])) reps++; if (reps >= 2) { const unit = out.slice(i, i + period); const name = 'rep_' + unit.map((u) => u.replace(/[^A-Za-z0-9]/g, (c) => 'x' + c.charCodeAt(0).toString(16))).join('_'); addProd(S, name, [name].concat(unit)); addProd(S, name, unit); out.splice(i, reps * period, name); } } }
        return out;
    }
    // 鍵名的一般化：NAME（':' NAME）* 再加零到多個群組（旗標 [x]、函式括號 ()）→ lhs（遞迴：lhs → lhs ':' NAME）
    function lhsGeneralize(S, part) {
        const qual = (s) => s === 'NAME' || s === 'VAR'; if (!part.length || !qual(part[0])) return null; let i = 1; while (i + 1 < part.length && part[i] === ':' && qual(part[i + 1])) i += 2; while (i < part.length && /^grp_/.test(part[i])) i++; if (i !== part.length) return null;
        addProd(S, 'lhs', [part[0]]); let k = 1; while (k + 1 < part.length && part[k] === ':' && qual(part[k + 1])) { addProd(S, 'lhs', ['lhs', ':', part[k + 1]]); k += 2; } for (; k < part.length; k++) addProd(S, 'lhs', ['lhs', part[k]]); return ['lhs'];
    }
    function shapeOf(S, toks) {
        const g = S.g; const g2 = groupify(S, toks); const syms = g2.map((x) => x.t); if (!syms.length) return { rhs: [], after: [] };
        const after = [];
        if (g.listMarker && syms[0] === g.listMarker && syms.length > 1) { after.push(toks.slice(1)); return { rhs: [syms[0], 'stmt'], after }; } // 清單項目：stmt → '-' stmt（遞迴），內層另外學
        const oi = syms.findIndex((s, i) => i > 0 && (g.ops || []).includes(s));
        if (oi > 0) { const lhs = lhsGeneralize(S, syms.slice(0, oi)) || compress(S, syms.slice(0, oi)); const rest = syms.slice(oi + 1); return { rhs: lhs.concat([syms[oi]], rest.length ? [valueNT(S, rest)] : []), after }; }
        if (syms[syms.length - 1] === '{' && syms.length > 1) { const head = syms.slice(0, -1); const lg = lhsGeneralize(S, head); if (lg) return { rhs: lg.concat(['{']), after }; if (head.every((s) => isAtom(s) || /^[^\w\s]$/.test(s))) return { rhs: [valueNT(S, head), '{'], after }; }
        const first = syms[0]; if (!CLASS.has(first) && !/^grp_/.test(first) && syms.length > 1 && syms.slice(1).every((s) => isAtom(s) || /^[^\w\s]$/.test(s))) return { rhs: [first, valueNT(S, syms.slice(1))], after };
        if ((g.listMarker || g.indentBlocks || g.section) && syms.every((s) => isAtom(s) || /^[^\w\s]$/.test(s)) && syms.every((s) => !(g.ops || []).includes(s))) return { rhs: [valueNT(S, syms)], after };
        return { rhs: compress(S, syms), after };
    }

    // ---------- ③ 修補 ----------
    function sub(S, toks) {
        let cur = toks.map((x) => Object.assign({}, x)); for (let round = 0; round < 3; round++) {
            const r = parseToks(S, cur); if (r.ok) return { ok: true, tree: r.tree, toks: cur }; const e = r.error; if (!e || e.at >= cur.length) return { ok: false };
            const tk = cur[e.at]; if (CLASS.has(tk.t) || STRUCT.has(tk.t) || BR[tk.t] || /^[)\]}]$/.test(tk.t)) return { ok: false }; let found = false; const kindOf = (x) => (/^[A-Za-z_!]/.test(x) ? 'word' : 'sym');
            for (const x of (e.expected || []).slice().sort()) { if (x === LR.EOF || CLASS.has(x) || STRUCT.has(x) || x === tk.t || BR[x] || /^[)\]}]$/.test(x) || kindOf(x) !== kindOf(tk.t)) continue; const trial = cur.slice(); trial[e.at] = Object.assign({}, tk, { t: x, orig: tk.t, sub: true }); const r2 = parseToks(S, trial); if (r2.ok || (r2.error && r2.error.at > e.at)) { cur = trial; found = true; break; } }
            if (!found) return { ok: false };
        }
        return { ok: false };
    }
    function classOf(S, x) { const g = S.g; return (g.ops || []).includes(x) ? 'op' : ((g.keywords || []).includes(x) ? 'kw' : null); }
    function introduceClass(S, tree) {
        const uses = []; (function walk(n) { if (!n || n.leaf) return; n.children.forEach((c, ci) => { if (c.leaf && c.tok && c.tok.sub) uses.push({ prod: n.prod - 1, idx: ci, x: c.sym, orig: c.tok.orig }); else walk(c); }); })(tree);
        const done = []; for (const u of uses) {
            const p = S.prods[u.prod]; if (!p) continue; const cur = p.rhs[u.idx];
            if (/^(?:op|kw|cls_\d+)$/.test(p.lhs) && p.rhs.length === 1) { addProd(S, p.lhs, [u.orig]); done.push(p.lhs + ' += ' + u.orig); continue; }
            const base = classOf(S, cur) || classOf(S, u.orig); let name = base && !S.prods.some((q) => q.lhs === base && q.rhs[0] !== cur && q.rhs.length === 1 && !(S.g.ops || []).concat(S.g.keywords || []).includes(q.rhs[0])) ? base : ('cls_' + (++S.nCls));
            if (!S.prods.some((q) => q.lhs === name)) { /* 新類別 */ } else if (S.prods.some((q) => q.lhs === name && q.rhs.length === 1 && q.rhs[0] === cur)) { /* 已經有：直接加成員 */ }
            const keyOld = pkey(p.lhs, p.rhs); S.keys.delete(keyOld); p.rhs[u.idx] = name; S.keys.add(pkey(p.lhs, p.rhs)); addProd(S, name, [cur]); addProd(S, name, [u.orig]); S.dirty = true; done.push(name + ' ← ' + cur + ' | ' + u.orig);
        }
        dedupSubsumed(S); return done;
    }
    // 類別（op、kw、cls_n）建好之後，只差在「用字面符號還是用類別」的重複產生式拿掉（類別的產生式已經涵蓋它），避免 shift/reduce 衝突
    function dedupSubsumed(S) {
        const members = new Map(); for (const p of S.prods) if (/^(?:op|kw|cls_\d+)$/.test(p.lhs) && p.rhs.length === 1) { if (!members.has(p.lhs)) members.set(p.lhs, new Set()); members.get(p.lhs).add(p.rhs[0]); }
        for (let i = S.prods.length - 1; i >= 0; i--) { const q = S.prods[i]; if (/^(?:op|kw|cls_\d+)$/.test(q.lhs)) continue; const dup = S.prods.some((p, j) => j !== i && p.lhs === q.lhs && p.rhs.length === q.rhs.length && p.rhs.some((s, k) => members.has(s) && members.get(s).has(q.rhs[k]) && p.rhs.every((s2, k2) => k2 === k || s2 === q.rhs[k2]))); if (dup) removeProdAt(S, i); }
    }
    // 把一個形狀（和它裡面的內層形狀，例如清單項目的內容）加進文法，不做解析檢查（檢查由呼叫端做）
    function addShape(S, toks, label, depth) { const sh = shapeOf(S, toks); addProd(S, 'stmt', sh.rhs, label); if ((depth || 0) < 6) for (const inner of sh.after) addShape(S, inner, label, (depth || 0) + 1); return sh; }
    function learnStmt(S, toks, stats) {
        const r0 = parseToks(S, toks); if (r0.ok) { stats.parsed++; return { how: 'parsed' }; }
        // A. 換成別的規則（同位置的其他符號能讓整行解析 → 同一類）
        const snap = S.prods.map((p) => ({ lhs: p.lhs, rhs: p.rhs.slice(), label: p.label })); const restore = () => { S.prods = snap.map((p) => Object.assign({}, p, { rhs: p.rhs.slice() })); S.keys = new Set(S.prods.map((p) => pkey(p.lhs, p.rhs))); S.dirty = true; };
        const a = sub(S, toks); if (a.ok) { const done = introduceClass(S, a.tree); if (parseToks(S, toks).ok) { stats.substituted++; S.trace.push({ how: 'substitute', detail: done.join('；') }); return { how: 'substitute', detail: done }; } restore(); }
        // B. 沿用前綴（失敗前已歸約好的符號 ＋ 剩下部分的一般化形狀）　C. 整行當成新規則（整行的一般化形狀）
        // 兩個都先在沙盒試，通過重新解析的才算；挑比較短的（較短＝一般化得比較好），一樣長就用沿用前綴的（重複使用已有的符號）
        const e = r0.error; const cands = [];
        if (e && e.stack && e.stack.length >= 1 && e.at < toks.length) { const sh = shapeOf(S, toks.slice(e.at)); cands.push({ how: 'compose', rhs: e.stack.concat(sh.rhs), after: sh.after, label: '組合：既有前綴＋新尾巴', detail: e.stack.join(' ') + ' + ' + sh.rhs.join(' ') }); }
        { const sh = shapeOf(S, toks); if (sh.rhs.length || !toks.length) cands.push({ how: 'new', rhs: sh.rhs, after: sh.after, label: '新規則', detail: sh.rhs.join(' ') }); }
        const valid = []; for (const c of cands) { const keep = S.prods.map((p) => ({ lhs: p.lhs, rhs: p.rhs.slice(), label: p.label })); addProd(S, 'stmt', c.rhs, c.label); for (const inner of c.after) addShape(S, inner, c.label); const okc = parseToks(S, toks).ok; S.prods = keep.map((p) => Object.assign({}, p)); S.keys = new Set(S.prods.map((p) => pkey(p.lhs, p.rhs))); S.dirty = true; if (okc) valid.push(c); }
        if (valid.length) { valid.sort((x, y) => x.rhs.length - y.rhs.length || (x.how === 'new' ? -1 : 1)); const c = valid[0]; addProd(S, 'stmt', c.rhs, c.label); if (c.how === 'compose') shapeOf(S, toks.slice(e.at)); else shapeOf(S, toks); for (const inner of c.after) addShape(S, inner, c.label); if (parseToks(S, toks).ok) { if (c.how === 'compose') stats.composed++; else stats.newRule++; S.trace.push({ how: c.how, detail: c.detail }); return { how: c.how }; } restore(); }
        // D. 一般化後的規則被 LALR 衝突的預設處理擋住：退回完全照字面的規則（保證吃得掉自己）
        addProd(S, 'stmt', toks.map((x) => x.t), '字面'); stats.literal++; S.trace.push({ how: 'literal', detail: toks.map((x) => x.t).join(' ') }); return { how: 'literal' };
    }

    // 讀完之後整理：只差一個字面符號的產生式（lhs '=' value、lhs '+=' value、lhs ':=' value…）合併成類別（stmt → lhs op value，op → '=' | '+=' | …）；
    // 用到類別的位置，其他產生式裡「左邊鄰居相同」的成員字面符號也換成類別。每一步都用全部已讀的行重新驗證，吃得掉的行變少就退回。
    function consolidate(S, allToks) {
        const accepted = () => { const t = ensureTable(S); return t ? allToks.filter((x) => LR.accepts(t, x)).length : 0; }; const before = accepted(); const log = [];
        const snap = () => S.prods.map((p) => ({ lhs: p.lhs, rhs: p.rhs.slice(), label: p.label })); const put = (s) => { S.prods = s.map((p) => Object.assign({}, p, { rhs: p.rhs.slice() })); S.keys = new Set(S.prods.map((p) => pkey(p.lhs, p.rhs))); S.dirty = true; };
        const nts = () => new Set(S.prods.map((p) => p.lhs)); const isClassName = (s) => /^(?:op|kw|cls_\d+)$/.test(s); const kindOf = (x) => (/^[A-Za-z_!]/.test(x) ? 'word' : 'sym');
        const original = snap();
        // 1) 合併只差一個字面符號的產生式
        const N = nts(); const groups = new Map();
        S.prods.forEach((p, i) => { if (p.lhs !== 'stmt' && p.lhs !== 'open') return; p.rhs.forEach((s, k) => { const lit = !N.has(s) && !CLASS.has(s) && !STRUCT.has(s) && !BR[s] && !/^[)\]}]$/.test(s); const cls = isClassName(s); if (!lit && !cls) return; const key = p.lhs + '|' + k + '|' + p.rhs.slice(0, k).concat(['*'], p.rhs.slice(k + 1)).join(''); if (!groups.has(key)) groups.set(key, []); groups.get(key).push({ i, k, s, cls }); }); });
        const drop = new Set(); const edits = [];
        for (const [, g] of groups) { const lits = g.filter((x) => !x.cls); const cls = g.filter((x) => x.cls); if (lits.length + cls.length < 2 || !lits.length) continue; if (new Set(lits.map((x) => kindOf(x.s))).size > 1) continue; edits.push({ g, lits, cls }); }
        for (const e of edits) {
            const keep = e.g[0]; const className = e.cls.length ? e.cls[0].s : ((e.lits.every((x) => (S.g.ops || []).includes(x.s)) && !S.prods.some((p) => p.lhs === 'op' && !e.lits.some((x) => x.s === p.rhs[0]))) ? 'op' : (e.lits.every((x) => (S.g.keywords || []).includes(x.s)) ? 'kw' : 'cls_' + (++S.nCls)));
            for (const x of e.lits) addProd(S, className, [x.s]); const target = S.prods[e.cls.length ? e.cls[0].i : e.lits[0].i]; if (target) { if (!e.cls.length) target.rhs[e.lits[0].k] = className; for (const x of e.g) if (x.i !== (e.cls.length ? e.cls[0].i : e.lits[0].i)) drop.add(x.i); log.push(className + ' ← ' + e.lits.map((x) => x.s).concat(e.cls.length ? ['（既有）'] : []).join(' | ')); }
        }
        if (drop.size) { S.prods = S.prods.filter((p, i) => !drop.has(i)); S.keys = new Set(S.prods.map((p) => pkey(p.lhs, p.rhs))); S.dirty = true; }
        // 2) 類別成員的字面符號，在「左邊鄰居相同」的其他產生式裡也換成類別
        const members = new Map(); for (const p of S.prods) if (isClassName(p.lhs) && p.rhs.length === 1) { if (!members.has(p.lhs)) members.set(p.lhs, new Set()); members.get(p.lhs).add(p.rhs[0]); }
        for (const q of S.prods) { if (isClassName(q.lhs)) continue; q.rhs.forEach((s, k) => { for (const [c, m] of members) { if (!m.has(s) || k === 0) continue; if (S.prods.some((p) => p.lhs === q.lhs && p !== q && p.rhs[k] === c && p.rhs[k - 1] === q.rhs[k - 1])) { q.rhs[k] = c; log.push(c + ' 取代 ' + s); } } }); }
        S.keys = new Set(S.prods.map((p) => pkey(p.lhs, p.rhs))); S.dirty = true; dedupSubsumed(S);
        if (accepted() < before) { put(original); return []; } return log;
    }
    // ---------- ⑤ 區塊：讀完之後長成遞迴的 items，再用整份 token 串驗證 ----------
    function fileGrammar(S, stmts, flat) {
        const prods = S.prods.map((p) => ({ lhs: p.lhs, rhs: p.rhs.slice(), label: p.label })); const indent = !!S.g.indentBlocks && !flat; const brace = !!S.g.braceBlocks && !flat;
        let open = [], close = null;
        if (brace) { for (let i = prods.length - 1; i >= 0; i--) { const p = prods[i]; if (p.lhs !== 'stmt') continue; if (p.rhs.length === 1 && p.rhs[0] === '}') { close = true; prods.splice(i, 1); } else if (p.rhs.length >= 1 && p.rhs[p.rhs.length - 1] === '{') { open.push(p); prods.splice(i, 1); } } for (const p of open) prods.push({ lhs: 'open', rhs: p.rhs.slice(), label: '區塊開頭' }); if (close) prods.push({ lhs: 'close', rhs: ['}'], label: '區塊結尾' }); }
        prods.push({ lhs: 'file', rhs: ['items'] }, { lhs: 'items', rhs: ['items', 'item'] }, { lhs: 'items', rhs: ['item'] }, { lhs: 'item', rhs: ['NL'] }, { lhs: 'item', rhs: ['stmt', 'NL'] });
        if (indent) prods.push({ lhs: 'item', rhs: ['stmt', 'NL', 'INDENT', 'items', 'DEDENT'] });
        if (brace && open.length && close) prods.push({ lhs: 'item', rhs: ['open', 'NL', 'items', 'close', 'NL'] }, { lhs: 'item', rhs: ['open', 'NL', 'close', 'NL'] });
        return { start: 'file', productions: prods, flat: !!flat, indent, brace: brace && open.length > 0 && !!close };
    }
    function fileTokens(S, stmts) {
        const out = []; const stack = [0]; const useIndent = !!S.g.indentBlocks;
        for (const s of stmts) { if (useIndent) { if (s.indent > stack[stack.length - 1]) { stack.push(s.indent); out.push({ t: 'INDENT', v: '', n: s.n }); } else while (s.indent < stack[stack.length - 1] && stack.length > 1) { stack.pop(); out.push({ t: 'DEDENT', v: '', n: s.n }); } } for (const k of s.toks) out.push({ t: k.t, v: k.v, n: s.n }); out.push({ t: 'NL', v: '', n: s.n }); }
        while (stack.length > 1) { stack.pop(); out.push({ t: 'DEDENT', v: '', n: stmts.length ? stmts[stmts.length - 1].n : 0 }); }
        return out;
    }

    // ---------- 對外 ----------
    // learn(text, { g, seed, maxLines })：g＝FaGram 學出的詞彙層（沒給就先學一份）；seed＝以前學過的產生式（沿用）
    function learn(text, opts) {
        opts = opts || {}; let g = opts.g; if (!g) { const gi = GR.induce(text, { maxLines: opts.maxLines }); if (!gi.ok) return { ok: false, reason: gi.reason || '學不出詞彙層' }; g = gi.grammar; }
        const stmts = streamOf(g, text, opts.maxLines); if (stmts.length < 3) return { ok: false, reason: '陳述太少' };
        return learnStmts(g, stmts, opts);
    }
    // 陳述可以是任意切法（一行、多行合併後的單位…）：{ n, indent, toks }；opts.noFile＝只學陳述層（不建整份檔案的表），給邊界探索用
    function learnStmts(g, stmts, opts) {
        opts = opts || {};
        const S = newState(g, opts.seed); const stats = { parsed: 0, substituted: 0, composed: 0, newRule: 0, literal: 0 }; const curve = []; let seen = 0;
        for (const s of stmts) { learnStmt(S, s.toks, stats); seen++; if (seen % Math.max(1, Math.ceil(stmts.length / 10)) === 0 || seen === stmts.length) curve.push({ lines: seen, predicted: Math.round(stats.parsed / seen * 1000) / 1000 }); }
        const merged = consolidate(S, stmts.map((s) => s.toks)); if (merged.length) S.trace.push({ how: 'consolidate', detail: merged.slice(0, 6).join('；') });
        const table = ensureTable(S);
        if (opts.noFile) { const lo = table ? stmts.filter((s) => LR.accepts(table, s.toks)).length : 0; return { ok: true, lineProductions: S.prods, lineTable: table, stats: { lines: stmts.length, predicted: stats.parsed, predictedRatio: Math.round(stats.parsed / stmts.length * 1000) / 1000, lineAccepted: lo }, trace: S.trace }; }
        const toks = fileTokens(S, stmts);
        let fg = fileGrammar(S, stmts, false), ft = LR.build(fg), fr = LR.parse(ft, toks);
        if (!fr.ok && (fg.brace || fg.indent)) { const fg2 = fileGrammar(S, stmts, true), ft2 = LR.build(fg2), fr2 = LR.parse(ft2, toks); if (fr2.ok) { fg = fg2; ft = ft2; fr = fr2; } }
        const lineOk = stmts.filter((s) => LR.accepts(table, s.toks)).length;
        const cfg = { start: 'file', productions: fg.productions, lineProductions: S.prods, prec: undefined }; const lineGrammar = { start: 'stmt', productions: S.prods };
        const res = { ok: lineOk / stmts.length >= 0.95 && fr.ok, cfg, lineGrammar, table: ft, lineTable: table, stats: { lines: stmts.length, predicted: stats.parsed, predictedRatio: Math.round(stats.parsed / stmts.length * 1000) / 1000, substituted: stats.substituted, composed: stats.composed, newRule: stats.newRule, literal: stats.literal, lineAccepted: lineOk, productions: fg.productions.length, states: ft.stats.states, conflicts: ft.stats.conflicts, unresolved: ft.stats.unresolved, blocks: { indent: fg.indent, brace: fg.brace, flat: fg.flat } }, file: { ok: fr.ok, error: fr.ok ? null : { line: fr.error && fr.error.n, token: fr.error && fr.error.token, expected: fr.error && (fr.error.expected || []).slice(0, 8) } }, curve, trace: S.trace.slice(0, 80), bison: LR.toBison(fg, { title: '從文字自己學出的文法' }), tableDump: LR.dumpTable(ft, { maxStates: 40 }), conflicts: ft.conflicts.slice(0, 20).map((c) => LR.describeConflict(ft, c)) };
        return res;
    }
    // 拿存起來的產生式直接解析一份新文字（不學）：回傳每一行有沒有被吃掉
    function check(prods, g, text, opts) { const S = newState(g, prods); const stmts = streamOf(g, text, opts && opts.maxLines); const t = ensureTable(S); if (!t) return { lines: stmts.length, accepted: 0, ratio: 0, failed: stmts.slice(0, 5).map((s) => s.n) }; const bad = stmts.filter((s) => !LR.accepts(t, s.toks)); return { lines: stmts.length, accepted: stmts.length - bad.length, ratio: stmts.length ? (stmts.length - bad.length) / stmts.length : 0, failed: bad.slice(0, 8).map((s) => ({ line: s.n, text: s.code.slice(0, 80) })) }; }
    // 摘要（給人看）
    function describe(res) {
        const s = res.stats; const L = []; L.push('遞迴文法：' + s.productions + ' 條產生式、LALR 分析表 ' + s.states + ' 個狀態、衝突 ' + s.conflicts + '（未解決 ' + s.unresolved + '）；整份檔案' + (res.file.ok ? '用分析表解析成功' : '解析失敗（第 ' + (res.file.error && res.file.error.line) + ' 行）') + (s.blocks.indent ? '；縮排區塊遞迴' : '') + (s.blocks.brace ? '；大括號區塊遞迴' : ''));
        L.push('學習過程（一行一行讀）：' + s.lines + ' 行中 ' + s.predicted + ' 行（' + Math.round(s.predictedRatio * 100) + '%）靠之前讀過的規則就解析得了；其餘：換成同類 ' + s.substituted + '、沿用前綴組合 ' + s.composed + '、整行新規則 ' + s.newRule + (s.literal ? '、逐字 ' + s.literal : ''));
        const tr = res.trace.filter((x) => x.how !== 'literal').slice(0, 6); if (tr.length) L.push('修補範例：' + tr.map((x) => ({ substitute: '換成同類', compose: '組合', new: '新規則', consolidate: '讀完後整理（只差一個符號的規則合併成類別）' }[x.how] + '（' + String(x.detail).slice(0, 60) + '）')).join('；'));
        if (res.conflicts.length) L.push('衝突（照 bison 預設處理）：' + res.conflicts.slice(0, 3).join('；')); return L;
    }
    function toSlim(res) { return { v: 1, start: res.cfg.start, productions: res.cfg.productions, lineProductions: res.cfg.lineProductions, stats: res.stats, curve: res.curve }; }
    // 一行文字能不能被學到的分析表接受；不能就說卡在哪個 token、這裡本來可以接受什麼
    function checkLine(res, g, line) { const S = newState(g, res.lineProductions || (res.cfg && res.cfg.lineProductions) || []); const toks = lexLine(g, line); const r = parseToks(S, toks); return r.ok ? { accepted: true, tokens: toks.map((x) => x.t) } : { accepted: false, tokens: toks.map((x) => x.t), error: { at: r.error.at, token: r.error.token, expected: (r.error.expected || []).slice(0, 10) } }; }
    function fromSlim(slim) { const fg = { start: slim.start, productions: slim.productions }; const table = LR.build(fg); return { cfg: fg, lineProductions: slim.lineProductions || [], table, stats: slim.stats, bison: LR.toBison(fg, { title: '從文字自己學出的文法' }), tableDump: LR.dumpTable(table, { maxStates: 40 }), conflicts: table.conflicts.slice(0, 20).map((c) => LR.describeConflict(table, c)), curve: slim.curve || [] }; }
    // 一串 token 的一般化形狀（不碰任何已存的文法）：['lhs', '+=', 'value'] 這種；給邊界探索判斷「這個形狀以前見過沒有」
    function shapeRhs(g, toks) { const S = newState(g, []); return shapeOf(S, toks).rhs; }
    return { lexLine, streamOf, learn, learnStmts, shapeRhs, check, checkLine, describe, toSlim, fromSlim, shapeOf };
});
