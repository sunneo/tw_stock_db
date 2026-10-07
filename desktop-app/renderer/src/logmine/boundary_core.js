/* 語法斷點發現（FaBound）：不假設「一行一個陳述」，從文字自己找出陳述到哪裡結束。
 *
 * 流程：
 *   ① 每個實體行先各自是一個單元（用 FaCfgLearn 的詞彙層切成 token；續行符號不預設）
 *   ② 交叉驗證找出「處理不了的邊界」：把行分成幾份，每一份用其他份學出的文法去解析（jackknife）；
 *      靠別的行就預測得到的是主流行，預測不到的是可疑行（可能是跨行陳述的一個片段，也可能是真的獨特的一行）
 *   ③ 用主流行學出一份穩定的文法 G*，然後兩兩合併：相鄰兩個單元，只要「其中一個結構上不完整」（引號沒關、括號沒關、
 *      以主流行從來不會用來結尾的符號結尾、或以主流行從來不會用來開頭的符號開頭）而且「串起來之後 G* 吃得掉」，就合併；
 *      合併後的單元可以再和鄰居合併（三行、四行的陳述）。行尾的續行符號（例如 \）是從資料裡發現的：拿掉它之後才吃得掉的，就學成續行符號。
 *   ④ 終結符號：某個符號幾乎只出現在單元結尾（例如 ;），而且有一大部分單元不是用它結尾 → 一個陳述就是「讀到它為止」的那一串
 *   ⑤ 留下來的單元邊界就是學出來的語法斷點；用合併後的單元重新學文法，預測涵蓋率變高才算有用
 * 不確定就說不確定（樣本太少、主流行太少），不硬給答案。純函式（UMD）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaBound = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const CL = (typeof FaCfgLearn !== 'undefined' && FaCfgLearn) || (typeof self !== 'undefined' && self.FaCfgLearn) || (typeof require === 'function' ? require('./cfglearn_core.js') : null);
    const LR = (typeof FaLR !== 'undefined' && FaLR) || (typeof self !== 'undefined' && self.FaLR) || (typeof require === 'function' ? require('./lr_core.js') : null);
    const GR = (typeof FaGram !== 'undefined' && FaGram) || (typeof self !== 'undefined' && self.FaGram) || (typeof require === 'function' ? require('./gram_core.js') : null);
    const CLASS = new Set(['STR', 'NUM', 'NAME', 'VAR', 'RAW']); const OPEN = { '(': ')', '[': ']', '{': '}' }; const CLOSE = new Set([')', ']', '}']);
    const isLit = (t) => !CLASS.has(t);

    const stripTail = (code, v) => { const s = String(code).trimEnd(); return s.endsWith(v) ? s.slice(0, s.length - v.length).trimEnd() : s; };
    // ---------- 單元 ----------
    function unitsOf(g2, text, maxLines) { return CL.streamOf(g2, text, maxLines).map((s) => ({ a: s.n, b: s.n, indent: s.indent, codes: [s.code], toks: s.toks, raw: !!s.raw })); }
    function relex(g2, codes) { return CL.lexLine(g2, codes.join(' ')); }
    // 結構上不完整：引號沒關、括號沒關
    function openState(codes, g2) { const text = codes.join(' '); const q = (g2.quotes && g2.quotes.length) ? g2.quotes : ['"', "'"]; let inq = null, depth = 0; for (let i = 0; i < text.length; i++) { const c = text[i]; if (inq) { if (c === '\\') { i++; continue; } if (c === inq) inq = null; continue; } if (q.includes(c) && !(c === "'" && i > 0 && /\w/.test(text[i - 1]))) { inq = c; continue; } if (OPEN[c]) depth++; else if (CLOSE.has(c)) depth--; } return { unterminated: !!inq, depth }; }

    // ---------- 主流行與可疑行 ----------
    // 主流行＝形狀（token 類別序列）出現 ≥2 次的行；只出現一次的是可疑行（可能是跨行陳述的片段，也可能是真的獨特的一行，由結構證據決定）
    const sigOf = (u) => u.toks.map((x) => x.t).join(' ');
    // 學到的陳述層文法展開成「字面形狀」的集合（類別 op／kw 展開成成員），用來判斷一個形狀以前見過沒有
    function knownShapes(prods) {
        const members = new Map(); for (const p of prods) if (/^(?:op|kw|cls_\d+)$/.test(p.lhs) && p.rhs.length === 1) { if (!members.has(p.lhs)) members.set(p.lhs, []); members.get(p.lhs).push(p.rhs[0]); }
        const out = new Set(); for (const p of prods) { if (p.lhs !== 'stmt') continue; let combos = [[]]; for (const s of p.rhs) { const alts = members.has(s) ? members.get(s) : [s]; const next = []; for (const c of combos) for (const a of alts) { if (next.length < 400) next.push(c.concat([a])); } combos = next; } for (const c of combos) out.add(c.join(' ')); }
        return out;
    }
    function tokenStats(units, g2) { const starts = new Set(), ends = new Set(); for (const u of units) { if (!u.toks.length) continue; starts.add(u.toks[0].t); ends.add(u.toks[u.toks.length - 1].t); } return { starts, ends }; }

    // ---------- 兩兩合併 ----------
    function tryMerge(ctx, u, v) {
        const { g2, accept, stats } = ctx; if (u.raw || v.raw || (u.b - u.a) + (v.b - v.a) > 14) return null;
        const os = openState(u.codes, g2); const lastU = u.toks[u.toks.length - 1], firstV = v.toks[0];
        const word = (x) => /^[A-Za-z_]/.test(x); const structU = os.unterminated || (os.depth > 0 && !(lastU && lastU.t === '{' && stats.ends.has('{')));
        const symEnd = !!(lastU && isLit(lastU.t) && !word(lastU.t) && !CLOSE.has(lastU.t) && !stats.ends.has(lastU.t) && !OPEN[lastU.t]); const incompleteU = structU || symEnd;
        const incompleteV = !!(firstV && isLit(firstV.t) && !word(firstV.t) && !OPEN[firstV.t] && !stats.starts.has(firstV.t));
        if (!incompleteU && !incompleteV) return null;
        const codes = u.codes.concat(v.codes);
        if (symEnd && !structU && lastU.v && u.toks.length > 1) { const lc0 = u.codes[u.codes.length - 1]; const stripped0 = stripTail(lc0, lastU.v); const alt0 = relex(g2, u.codes.slice(0, -1).concat([stripped0], v.codes)); if (alt0.length && accept(alt0)) return { codes: u.codes.slice(0, -1).concat([stripped0], v.codes), toks: alt0, evidence: '行尾的 ' + lastU.t + ' 是續行符號（拿掉它也解析得了，而且它從來不出現在陳述結尾）', dropped: lastU.t }; }
        const full = relex(g2, codes); if (accept(full)) return { codes, toks: full, evidence: os.unterminated ? '引號沒關' : (os.depth > 0 ? '括號沒關' : (incompleteV ? '下一行以不能開頭的符號開始：' + firstV.t : '以不會結尾的符號結尾：' + (lastU && lastU.t))), dropped: null };
        // 行尾的續行符號：拿掉它之後才吃得掉 → 學成續行符號
        if (lastU && isLit(lastU.t) && !CLOSE.has(lastU.t) && !OPEN[lastU.t] && u.toks.length > 1 && lastU.v) {
            const lc = u.codes[u.codes.length - 1]; const stripped = stripTail(lc, lastU.v); const alt = relex(g2, u.codes.slice(0, -1).concat([stripped], v.codes));
            if (alt.length && accept(alt)) return { codes: u.codes.slice(0, -1).concat([stripped], v.codes), toks: alt, evidence: '行尾的 ' + lastU.t + ' 是續行符號（拿掉它才解析得了）', dropped: lastU.t };
        }
        return null;
    }
    function mergePass(ctx, units) {
        const out = []; const merges = []; let changed = false;
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            // 引號或括號沒關：一路串到平衡為止（三行以上的陣列、字串），串起來吃得掉才合併
            { const os = openState(u.codes, ctx.g2); const trailingBlock = u.toks.length && u.toks[u.toks.length - 1].t === '{' && ctx.stats.ends.has('{');
              if (!u.raw && (os.unterminated || (os.depth > 0 && !trailingBlock))) { let codes = u.codes.slice(); let j = i + 1; let st = os; while (j < units.length && !units[j].raw && (st.unterminated || st.depth > 0) && j - i <= 14) { codes = codes.concat(units[j].codes); st = openState(codes, ctx.g2); j++; } if (!(st.unterminated || st.depth > 0) && j > i + 1) { const toks = relex(ctx.g2, codes); if (ctx.accept(toks)) { const ev = os.unterminated ? '引號沒關' : '括號沒關'; out.push({ a: u.a, b: units[j - 1].b, indent: u.indent, codes, toks, raw: false, merged: true, how: [ev + '（串到平衡為止）'], dropped: null }); merges.push({ lines: [u.a, units[j - 1].b], evidence: ev + '，一路串到平衡為止' }); i = j - 1; changed = true; continue; } } } }
            // 以前學過的續行符號：行尾是它就和下一個合併（拿掉符號）。放在引號／括號的串接之後，這樣符號出現在跨行字串裡面時不會被誤用
            { const lastT = u.toks[u.toks.length - 1]; const v0 = units[i + 1]; if ((ctx.hintCont || []).length && !u.raw && v0 && !v0.raw && lastT && ctx.hintCont.includes(lastT.t) && u.toks.length > 1 && !openState(u.codes, ctx.g2).unterminated) { const codes = u.codes.slice(0, -1).concat([stripTail(u.codes[u.codes.length - 1], lastT.v || lastT.t)], v0.codes); out.push({ a: u.a, b: v0.b, indent: u.indent, codes, toks: relex(ctx.g2, codes), raw: false, merged: true, how: ['以前學過的續行符號 ' + lastT.t], dropped: lastT.t }); merges.push({ lines: [u.a, v0.b], evidence: '以前學過的續行符號 ' + lastT.t, dropped: lastT.t }); i++; changed = true; continue; } }
            const v = units[i + 1]; const failU = !ctx.accept(u.toks); const failV = v ? !ctx.accept(v.toks) : false;
            if (v && (failU || failV || openState(u.codes, ctx.g2).unterminated)) { const m = tryMerge(ctx, u, v); if (m) { out.push({ a: u.a, b: v.b, indent: u.indent, codes: m.codes, toks: m.toks, raw: false, merged: true, how: (u.how || []).concat(v.how || [], [m.evidence]), dropped: m.dropped || u.dropped || v.dropped || null }); merges.push({ lines: [u.a, v.b], evidence: m.evidence, dropped: m.dropped }); i++; changed = true; continue; } }
            out.push(u);
        }
        return { units: out, merges, changed };
    }

    // ---------- 終結符號（SQL 的 ; 之類）----------
    function terminatorMerge(g2, units, hint) {
        const occ = new Map(), endOcc = new Map(); for (const u of units) { if (u.raw) continue; u.toks.forEach((k, i) => { if (!isLit(k.t) || CLOSE.has(k.t) || OPEN[k.t]) return; occ.set(k.t, (occ.get(k.t) || 0) + 1); if (i === u.toks.length - 1) endOcc.set(k.t, (endOcc.get(k.t) || 0) + 1); }); }
        const plain = units.filter((u) => !u.raw);
        let best = null; for (const [t, n] of endOcc) { const rate = n / occ.get(t); if (n < 3 || rate < 0.9) continue; const noTerm = plain.filter((u) => { const l = u.toks[u.toks.length - 1]; return !(l && l.t === t) && !(l && l.t === '{') && !(u.toks.length === 1 && CLOSE.has(u.toks[0].t)); }); if (noTerm.length / plain.length < 0.25) continue; if (!best || n > best.n) best = { t, n, rate, noTerm: noTerm.length }; }
        if (!best && hint && occ.has(hint)) best = { t: hint, n: endOcc.get(hint) || 0, rate: 1, noTerm: 0, hinted: true };
        if (!best) return null;
        const out = []; let cur = null; const merges = [];
        for (const u of units) {
            const last = u.toks[u.toks.length - 1]; const structural = u.raw || (last && last.t === '{') || (u.toks.length === 1 && CLOSE.has(u.toks[0].t));
            if (structural) { if (cur) { out.push(cur); cur = null; } out.push(u); continue; }
            cur = cur ? { a: cur.a, b: u.b, indent: cur.indent, codes: cur.codes.concat(u.codes), toks: relex(g2, cur.codes.concat(u.codes)), raw: false, merged: true, how: (cur.how || []).concat(['終結符號 ' + best.t]) } : Object.assign({}, u, { how: (u.how || []).slice() });
            if (last && last.t === best.t) { if (cur.b > cur.a) merges.push({ lines: [cur.a, cur.b], evidence: '到終結符號 ' + best.t + ' 為止是一個陳述' }); out.push(cur); cur = null; }
        }
        if (cur) out.push(cur);
        return merges.length ? { units: out, merges, terminator: best.t, rate: Math.round(best.rate * 100) / 100 } : null;
    }

    // ---------- 弱證據：固定成對出現的形狀（只當建議，不自動合併）----------
    function pairedSuggestions(g2, units) {
        const S = null; const key = (u) => u.toks.map((x) => (CLASS.has(x.t) ? x.t : x.t)).join(' '); const keys = units.map(key); const next = new Map(), prev = new Map(), cnt = new Map();
        for (let i = 0; i < units.length; i++) { cnt.set(keys[i], (cnt.get(keys[i]) || 0) + 1); if (i + 1 < units.length) { const k = keys[i] + '\u0001' + keys[i + 1]; next.set(k, (next.get(k) || 0) + 1); } }
        const out = []; for (const [k, n] of next) { const [a, b] = k.split('\u0001'); if (n >= 3 && n === cnt.get(a) && n === cnt.get(b) && a !== b) out.push({ shapes: [a, b], times: n, note: '這兩種行固定成對出現（≥3 次）；可能是一個多行陳述，也可能只是格式慣例，沒有自動合併' }); } return out.slice(0, 5);
    }

    // ---------- 對外 ----------
    function analyze(text, opts) {
        opts = opts || {}; let g = opts.g; if (!g) { const gi = GR.induce(text, { maxLines: opts.maxLines, minCoverage: 0.3 }); if (!gi.ok) return { ok: false, reason: gi.reason || '學不出詞彙層' }; g = gi.grammar; }
        const g2 = Object.assign({}, g, { continuation: false }); const units0 = unitsOf(g2, text, opts.maxLines); const hints = opts.hints || {};
        const n = units0.length;
        const base = { ok: true, lineUnits: n };
        if (n < 8) {
            // 樣本太少沒辦法自己判斷；但以前學過的續行符號／終結符號是已知的事實，照用（標明沒有驗證）
            if ((hints.continuation || []).length || hints.terminator) {
                let us = units0; const mg = []; if ((hints.continuation || []).length) { const r = mergePass({ g2, accept: () => false, stats: { starts: new Set(), ends: new Set() }, hintCont: hints.continuation }, us); us = r.units; mg.push(...r.merges.filter((m) => /以前學過/.test(m.evidence))); }
                const tm1 = hints.terminator ? terminatorMerge(g2, us, hints.terminator) : null; if (tm1) { us = tm1.units; mg.push(...tm1.merges); }
                if (mg.length) return Object.assign(base, { uncertain: false, partial: '樣本太少（' + n + ' 個單元），只套用以前學過的斷點，沒有重新驗證', units: us.map(pub), merges: mg, boundaries: us.map((u) => u.b), unitCount: us.length, mergedUnits: us.filter((u) => u.merged).length, continuationTokens: hints.continuation || [], terminator: tm1 ? { token: tm1.terminator, endRate: tm1.rate } : null, suspects: 0, mainstream: 0, unexplained: [], suggestions: [], rounds: 0, compare: { lineBased: { productions: 0, predictedRatio: 0, lines: n, repairs: 0 }, discovered: { productions: 0, predictedRatio: 0, units: us.length, repairs: 0 } }, stmts: us.map((u) => ({ n: u.a, indent: u.indent, toks: u.toks, code: u.codes.join(' ') })), g: g2 });
            }
            return Object.assign(base, { uncertain: true, reason: '樣本太少（' + n + ' 個單元，至少要 8 個）：沒辦法判斷陳述到哪裡結束，維持一行一個陳述', units: units0.map(pub), merges: [], boundaries: units0.map((u) => u.b) });
        }
        const cnt = new Map(); for (const u of units0) cnt.set(sigOf(u), (cnt.get(sigOf(u)) || 0) + 1); const main = units0.filter((u) => u.raw || cnt.get(sigOf(u)) >= 2); const suspects = units0.filter((u) => !u.raw && cnt.get(sigOf(u)) < 2);
        const stable = main.length >= Math.max(4, n * 0.3);
        if (!stable) { // 重複的形狀太少，兩兩合併沒有可靠的依據；但「終結符號」不需要這個（它看的是符號出現在哪裡）
            const tm0 = terminatorMerge(g2, units0, hints.terminator); const reason = '重複出現的形狀只涵蓋 ' + main.length + '/' + n + ' 個單元（文法不穩定），沒辦法用兩兩合併判斷斷點';
            if (!tm0) return Object.assign(base, { uncertain: true, reason, units: units0.map(pub), merges: [], boundaries: units0.map((u) => u.b), suspects: suspects.length });
            const toStmt0 = (u) => ({ n: u.a, indent: u.indent, toks: u.toks, code: u.codes.join(' ') }); const b0 = CL.learnStmts(g2, units0.map(toStmt0), { noFile: true }), a0 = CL.learnStmts(g2, tm0.units.map(toStmt0), { noFile: true });
            return Object.assign(base, { uncertain: false, partial: reason, units: tm0.units.map(pub), merges: tm0.merges, boundaries: tm0.units.map((u) => u.b), unitCount: tm0.units.length, mergedUnits: tm0.units.filter((u) => u.merged).length, continuationTokens: [], terminator: { token: tm0.terminator, endRate: tm0.rate }, suspects: suspects.length, mainstream: main.length, unexplained: [], suggestions: [], rounds: 0, compare: { lineBased: { productions: b0.lineProductions.length, predictedRatio: b0.stats.predictedRatio, lines: b0.stats.lines, repairs: b0.trace.length }, discovered: { productions: a0.lineProductions.length, predictedRatio: a0.stats.predictedRatio, units: a0.stats.lines, repairs: a0.trace.length } }, stmts: tm0.units.map(toStmt0), g: g2 });
        }
        const gstar = CL.learnStmts(g2, main.map((u) => ({ n: u.a, indent: u.indent, toks: u.toks })), { noFile: true }); const stats = tokenStats(main, g2);
        const known = knownShapes(gstar.lineProductions); const accept = (toks) => !!((gstar.lineTable && LR.accepts(gstar.lineTable, toks)) || known.has(CL.shapeRhs(g2, toks).join(' '))); const ctx = { g2, accept, stats, hintCont: hints.continuation || [] };
        let units = units0; const merges = []; let rounds = 0; for (; rounds < 30; rounds++) { const r = mergePass(ctx, units); units = r.units; merges.push(...r.merges); if (!r.changed) break; }
        let terminator = null; const tm = terminatorMerge(g2, units, hints.terminator); if (tm) { units = tm.units; merges.push(...tm.merges); terminator = { token: tm.terminator, endRate: tm.rate }; }
        const dropped = Array.from(new Set(units.filter((u) => u.dropped).map((u) => u.dropped)));
        const unexplained = units.filter((u) => { if (u.raw) return false; const os = openState(u.codes, g2); const last = u.toks[u.toks.length - 1]; return os.unterminated || (os.depth > 0 && !(last && last.t === '{')); }).map((u) => ({ line: u.a, text: u.codes[0].slice(0, 80), why: '引號或括號到這個單位結束都沒有關' }));
        // 用合併後的單元重新學文法，跟一行一個陳述比較
        const toStmt = (u) => ({ n: u.a, indent: u.indent, toks: u.toks, code: u.codes.join(' ') });
        const before = CL.learnStmts(g2, units0.map(toStmt), { noFile: true }); const after = CL.learnStmts(g2, units.map(toStmt), { noFile: true });
        const res = Object.assign(base, { uncertain: false, units: units.map(pub), merges, boundaries: units.map((u) => u.b), unitCount: units.length, mergedUnits: units.filter((u) => u.merged).length, continuationTokens: dropped, terminator, suspects: suspects.length, mainstream: main.length, unexplained: unexplained.slice(0, 10), suggestions: pairedSuggestions(g2, units), rounds: rounds + 1,
            compare: { lineBased: { productions: before.lineProductions.length, predictedRatio: before.stats.predictedRatio, lines: before.stats.lines, repairs: before.trace.length }, discovered: { productions: after.lineProductions.length, predictedRatio: after.stats.predictedRatio, units: after.stats.lines, repairs: after.trace.length } }, stmts: units.map(toStmt), g: g2 });
        return res;
    }
    function pub(u) { return { from: u.a, to: u.b, lines: u.b - u.a + 1, text: u.codes.join(' ').slice(0, 120), merged: !!u.merged, how: u.how || [] }; }
    // 用發現的斷點重新學完整的遞迴文法（含整份檔案的 LALR 表）
    function learnWithBoundaries(text, opts) { const a = analyze(text, opts); if (!a.ok || a.uncertain) return { analysis: a, cfg: null }; const cfg = CL.learnStmts(a.g, a.stmts, {}); return { analysis: a, cfg }; }
    function describe(a) {
        const L = []; if (!a.ok) return [a.reason || '無法分析'];
        if (a.uncertain) { L.push('語法斷點：不確定——' + a.reason); return L; }
        L.push('語法斷點：' + a.lineUnits + ' 個實體行 → ' + a.unitCount + ' 個陳述單位（' + a.mergedUnits + ' 個是多行合併的）；主流行 ' + a.mainstream + '、可疑行 ' + a.suspects + '，合併 ' + a.rounds + ' 輪');
        if (a.continuationTokens.length) L.push('續行符號（從資料發現）：' + a.continuationTokens.join('、')); if (a.terminator) L.push('終結符號（從資料發現）：' + a.terminator.token + '（出現的地方 ' + Math.round(a.terminator.endRate * 100) + '% 在單元結尾）');
        for (const m of a.merges.slice(0, 6)) L.push('合併第 ' + m.lines[0] + '～' + m.lines[1] + ' 行：' + m.evidence);
        if (a.merges.length > 6) L.push('…還有 ' + (a.merges.length - 6) + ' 處合併');
        L.push('用斷點重新學文法：產生式 ' + a.compare.lineBased.productions + '（一行一個陳述）→ ' + a.compare.discovered.productions + '；學習時的修補 ' + a.compare.lineBased.repairs + ' → ' + a.compare.discovered.repairs + ' 次');
        if (a.unexplained.length) L.push('合併後仍然解析不了：' + a.unexplained.slice(0, 4).map((u) => 'L' + u.line + ' ' + u.text.slice(0, 40)).join('；')); if (a.suggestions.length) L.push('弱證據（沒有合併）：' + a.suggestions.map((s) => s.shapes.join(' ⏎ ') + '（' + s.times + ' 次）').join('；'));
        return L;
    }
    // 用發現的斷點把跨行的陳述接成一行的文字（縮排保留）；給「一行一個陳述」的下游（FaGram）用
    function mergedText(a) { return (a.units || []).map((u) => ' '.repeat(Math.max(0, (a.stmts && a.stmts[(a.units || []).indexOf(u)] ? a.stmts[(a.units || []).indexOf(u)].indent : 0))) + (a.stmts && a.stmts[(a.units || []).indexOf(u)] ? a.stmts[(a.units || []).indexOf(u)].code : (u.text || ''))).join('\n'); }
    return { analyze, learnWithBoundaries, describe, relex, openState, mergedText };
});
