/* 語法錯誤自動修正（純函式，UMD；檢查器與模型都是注入的）。可以從「任意拿到的程式碼」開始，不需要知道它怎麼來的。
 * 做法（使用者的想法：從語法錯誤找到當下的語法單元，再在錯誤位置選出最適合的 token 組合）：
 *   1. check(source) 拿到編譯器／直譯器的錯誤訊息 → parseErrors 解出第一個錯誤的位置（行、欄）
 *   2. lex 把程式切成 token（會處理字串、註解、前處理行、Python 縮排）→ unitOf 找出錯誤所在的語法單元（錯誤位置的那條敘述＋前一條，因為「缺分號」常在下一行才報錯）
 *   3. candidates 在錯誤位置附近產生「極小的 token 編輯」候選：補括號（依未配對的括號堆疊決定該補哪一種）、補 ; : end fi done、補引號、刪掉多餘的 token、= 改 ==、Python 補 pass／調縮排…
 *   4. 每個候選都交給**真的檢查器**驗證：整個通過最好；沒通過的看「第一個錯誤有沒有往後移」（有進展）。依 通過 > 進展 > 編輯成本 排序
 *   5. 並列時（編輯不同、結果同樣好）用選擇題讓模型挑（ask 沒給或問不出來就選成本最低的）；套用後重複，最多 maxRounds 輪（一次可能不只一個錯）
 * 只改必要的 token，其餘格式（縮排、換行符、註解）完全保留；回傳結構化的 edits 與統一格式的 diff，可以直接給使用者看或套用。
 *   repairSyntax({lang, source, check, ask?, maxRounds?, maxTries?, concurrency?, semantic?, wrap?, verify?}) →
 *     semantic：{symbols:{名稱:引數個數|null}, hints:[已定的設計文字]}——設計樹（計畫簽名／UML／思考堆疊決定）的語意；候選依「套用前後的語意問題集合」加減成本（識別字黏合、引數個數、printf 格式、直譯語言的未定義名稱）。wrap(messages)：把思考堆疊的焦點標頭放進選擇題。
 * Promise<{ok, source, edits[], diff, rounds, tried, choices[], reason?, errors?}>
 *     check({lang, source}) → Promise<{verdict:'CHECKED'|'AC'（通過）| 'CE'（有錯，要有 compileLog 或 detail）| 其他（UNAVAILABLE…）}>
 *   支援語言：python、nodejs、c、cpp、java、csharp、perl、ruby、bash（組語沒有候選，回 unsupported_lang）。 */
(function (root, factory) {
    const Gm = (typeof FaGrammar !== 'undefined' && FaGrammar) || (root && root.FaGrammar) || (typeof require === 'function' ? require('./grammar_core.js') : null);
    if (typeof module === 'object' && module.exports) module.exports = factory(Gm); else root.FaSyntaxFix = factory(Gm);
})(typeof self !== 'undefined' ? self : this, function (Gm) {
    'use strict';
    const FAMILY = { python: 'python', nodejs: 'clike', c: 'clike', cpp: 'clike', java: 'clike', csharp: 'clike', perl: 'clike', ruby: 'ruby', bash: 'bash' };
    // 備援詞彙：每種語言各自一份（使用者規定不共用，即使現在內容相近）。有文法的語言以文法算出的合法 token 為主，這裡只在文法分析不可用／與編譯器位置不一致時補足。
    const VOCAB = {
        c: { terminators: [';'], termCost: 1.0, separators: [','], openBrace: ' {', strayOpeners: true },
        cpp: { terminators: [';'], termCost: 1.0, separators: [','], openBrace: ' {', strayOpeners: true },
        java: { terminators: [';'], termCost: 1.0, separators: [','], openBrace: ' {', strayOpeners: true },
        csharp: { terminators: [';'], termCost: 1.0, separators: [','], openBrace: ' {', strayOpeners: true },
        nodejs: { terminators: [';'], termCost: 1.3, separators: [','], openBrace: ' {', strayOpeners: true }, // JS 的分號常可省略（ASI），所以補分號的成本較高
        perl: { terminators: [';'], termCost: 1.0, separators: [','], openBrace: ' {', strayOpeners: true }
    };
    const CLOSE = { '(': ')', '[': ']', '{': '}' }; const OPEN = { ')': '(', ']': '[', '}': '{' };
    const OPS = ['>>>=', '===', '!==', '<<=', '>>=', '>>>', '...', '**=', '//=', '<=>', '=>', '->', '::', '++', '--', '&&', '||', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**', '//', '=~', '!~', '..'];
    const OPS_NOSCOPE = OPS.filter((o) => o !== '::'); const OPS_PY = OPS_NOSCOPE.concat([':=']); // 沒有 :: 運算子的語言（c、nodejs、python）不產生 ::
    const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };

    // ---------- 詞法：只求「括號、字串、註解、換行、縮排」切對，不求完整文法 ----------
    function lex(lang, src) {
        const fam = FAMILY[lang]; const toks = []; const n = src.length; let i = 0, line = 1, ls = 0;
        const push = (t, v, off, l, c, extra) => { const k = { t, v, off, end: off + v.length, line: l, col: c }; if (extra) Object.assign(k, extra); toks.push(k); return k; };
        const hashComment = fam === 'python' || fam === 'ruby' || fam === 'bash' || lang === 'perl'; const slashComment = fam === 'clike' && lang !== 'perl';
        let lineHasTok = false;
        while (i < n) {
            const ch = src[i]; const col = i - ls + 1;
            if (ch === '\n') { if (fam !== 'clike') push('nl', '\n', i, line, col); i++; line++; ls = i; lineHasTok = false; continue; }
            if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
            if (slashComment && ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
            if (slashComment && ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const stop = e < 0 ? n : e + 2; for (let k = i; k < stop; k++) if (src[k] === '\n') { line++; ls = k + 1; } i = stop; continue; }
            if (ch === '#') {
                if ((lang === 'c' || lang === 'cpp' || lang === 'csharp') && !lineHasTok) { const st = i; while (i < n && src[i] !== '\n') { if (src[i] === '\\' && src[i + 1] === '\n') { i++; line++; ls = i + 1; } i++; } push('pp', src.slice(st, i), st, line, col); lineHasTok = true; continue; }
                if (hashComment) { while (i < n && src[i] !== '\n') i++; continue; }
            }
            lineHasTok = true;
            // 字串
            if (ch === '"' || ch === "'" || (ch === '`' && (lang === 'nodejs' || lang === 'bash'))) {
                const st = i, l0 = line, c0 = col; const q = ch;
                if (fam === 'python' && (src.startsWith(q + q + q, i))) { const e = src.indexOf(q + q + q, i + 3); const stop = e < 0 ? n : e + 3; for (let k = i; k < stop; k++) if (src[k] === '\n') { line++; ls = k + 1; } push('str', src.slice(st, stop), st, l0, c0, e < 0 ? { bad: true, quote: q + q + q } : null); i = stop; continue; }
                i++; let bad = false; const multi = q === '`';
                for (;;) { if (i >= n) { bad = true; break; } const c = src[i]; if (c === '\\') { i += 2; continue; } if (c === q) { i++; break; } if (c === '\n' && !multi) { bad = true; break; } if (c === '\n') { line++; ls = i + 1; } i++; }
                push('str', src.slice(st, i), st, l0, c0, bad ? { bad: true, quote: q } : null); continue;
            }
            const rest = src.slice(i, i + 64);
            let m = /^[0-9][A-Za-z0-9_.]*/.exec(rest); if (m) { push('num', m[0], i, line, col); i += m[0].length; continue; }
            m = (lang === 'perl' || lang === 'bash' ? /^[$@%&]?[A-Za-z_][A-Za-z0-9_]*/ : /^[A-Za-z_$][A-Za-z0-9_$]*/).exec(rest); if (m) { push('id', m[0], i, line, col); i += m[0].length; continue; }
            // JS 的正則字面值：出現在「需要運算元」的位置（開頭、運算子或 ( [ { , ; 之後、return／typeof 等關鍵字之後）的 / 才是正則
            if (lang === 'nodejs' && ch === '/') {
                const pv = toks[toks.length - 1]; const operandNext = !pv || (pv.t === 'op' && !/^[)\]}]$/.test(pv.v)) || (pv.t === 'id' && /^(return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/.test(pv.v));
                if (operandNext) { let k = i + 1, cls = false, ok = false; while (k < n && src[k] !== '\n') { const c = src[k]; if (c === '\\') { k += 2; continue; } if (c === '[') cls = true; else if (c === ']') cls = false; else if (c === '/' && !cls) { ok = true; break; } k++; } if (ok) { k++; while (k < n && /[a-z]/.test(src[k])) k++; push('str', src.slice(i, k), i, line, col, { regex: true }); i = k; continue; } }
            }
            let op = null; for (const o of (lang === 'python' ? OPS_PY : (lang === 'c' || lang === 'nodejs' ? OPS_NOSCOPE : OPS))) if (src.startsWith(o, i)) { op = o; break; }
            if (!op) op = ch; push('op', op, i, line, col); i += op.length;
        }
        return toks;
    }

    // 括號堆疊：unmatched＝沒有收尾的開括號；mismatch＝收錯種類；strays＝多出來的收括號；depth[i]＝第 i 個 token 之前的括號深度
    function brackets(toks) {
        const stack = [], strays = [], mismatch = [], depth = [];
        toks.forEach((t, idx) => {
            depth.push(stack.length);
            if (t.t !== 'op') return;
            if (CLOSE[t.v]) stack.push({ ch: t.v, idx });
            else if (OPEN[t.v]) { if (stack.length && stack[stack.length - 1].ch === OPEN[t.v]) stack.pop(); else if (stack.length) mismatch.push({ tok: t, idx, want: CLOSE[stack[stack.length - 1].ch] }); else strays.push({ tok: t, idx }); }
        });
        return { stack, strays, mismatch, depth };
    }

    // ---------- 錯誤訊息 → 位置 ----------
    function parseErrors(lang, log, src) {
        const out = []; const s = String(log || ''); const L = s.replace(/\r/g, '').split('\n');
        const srcLines = src == null ? null : String(src).split('\n');
        const add = (line, col, msg) => { if (line > 0 && !out.some((e) => e.line === line && e.col === col)) out.push({ line, col: col || null, msg: clip(String(msg || '').trim(), 160) }); };
        if (lang === 'python') {
            for (let i = 0; i < L.length; i++) {
                const m = /File ".*", line (\d+)/.exec(L[i]); if (!m) continue; const line = +m[1]; let col = null, msg = '';
                for (let j = i + 1; j < Math.min(L.length, i + 5); j++) { if (/^\s*\^+\s*$/.test(L[j])) { const caret = L[j].indexOf('^'); const stripped = srcLines && srcLines[line - 1] != null ? srcLines[line - 1] : null; const lead = stripped != null ? (/^\s*/.exec(stripped)[0].length) : 0; col = lead + Math.max(0, caret - 4) + 1; } const e = /^(\w*(Error|Exception)\w*):\s*(.*)$/.exec(L[j]); if (e) { msg = e[1] + ': ' + e[3]; break; } }
                add(line, col, msg || 'SyntaxError');
            }
        } else if (lang === 'nodejs') {
            for (let i = 0; i < L.length; i++) { const m = /^(?:.*[\\/])?[^\s:]+\.js:(\d+)\s*$/.exec(L[i]); if (!m) continue; let col = null, msg = ''; for (let j = i + 1; j < Math.min(L.length, i + 6); j++) { if (/^\s*\^+\s*$/.test(L[j])) col = L[j].indexOf('^') + 1; if (/^\w*Error:/.test(L[j])) { msg = L[j]; break; } } add(+m[1], col, msg || 'SyntaxError'); }
        } else if (lang === 'c' || lang === 'cpp') {
            for (const l of L) { const m = /^(?:.*[\\/])?[^\s:]+:(\d+):(\d+):\s*(?:fatal )?error:\s*(.*)$/.exec(l); if (m) add(+m[1], +m[2], m[3]); }
        } else if (lang === 'java') {
            for (let i = 0; i < L.length; i++) { const m = /^(?:.*[\\/])?[^\s:]+\.java:(\d+):\s*error:\s*(.*)$/.exec(L[i]); if (!m) continue; let col = null; for (let j = i + 1; j < Math.min(L.length, i + 4); j++) if (/^\s*\^\s*$/.test(L[j])) { col = L[j].indexOf('^') + 1; break; } add(+m[1], col, m[2]); }
        } else if (lang === 'csharp') {
            for (const l of L) { const m = /^(?:.*[\\/])?[^\s(]+\((\d+),(\d+)\):\s*error\s*(\w+):\s*(.*)$/.exec(l); if (m) add(+m[1], +m[2], m[3] + ' ' + m[4]); }
        } else if (lang === 'ruby') {
            for (const l of L) { const m = /^(?:.*[\\/])?[^\s:]+\.rb:(\d+):\s*(.*(?:syntax error|unexpected).*)$/.exec(l); if (m) add(+m[1], null, m[2]); }
        } else if (lang === 'perl') {
            for (const l of L) { const m = /(.*) at (?:.*[\\/])?[^\s]+\.pl line (\d+)/.exec(l); if (m && !/had compilation errors|did not compile/.test(l)) add(+m[2], null, m[1]); }
        } else if (lang === 'bash') {
            for (const l of L) { const m = /(?:.*[\\/])?[^\s:]+\.sh: line (\d+): (.*)$/.exec(l); if (m) add(+m[1], null, m[2]); }
        }
        return out;
    }

    // ---------- 語法單元 ----------
    // 回傳錯誤所在的敘述＋前一條敘述（缺分號、缺冒號常在下一條才報錯）；clike 以 ; { } 切敘述（括號內的 ; 不算），其他以邏輯行切
    function unitOf(lang, toks, src, errLine) {
        const fam = FAMILY[lang]; const lo = (a, b) => ({ startOff: a, endOff: b, startLine: lineOf(src, a), endLine: lineOf(src, b), text: src.slice(a, b) });
        if (!toks.length) return lo(0, src.length);
        const br = brackets(toks);
        let ranges = [];
        if (fam === 'clike') { let st = 0; toks.forEach((t, i) => { if (t.t === 'op' && (t.v === ';' || t.v === '{' || t.v === '}') && !(t.v === ';' && br.depth[i] > 0 && inParen(toks, i))) { if (i >= st) ranges.push([st, i]); st = i + 1; } }); if (st < toks.length) ranges.push([st, toks.length - 1]); }
        else { let st = 0; toks.forEach((t, i) => { if (t.t === 'nl' && br.depth[i] === 0) { if (i > st) ranges.push([st, i - 1]); st = i + 1; } }); if (st < toks.length) ranges.push([st, toks.length - 1]); }
        if (!ranges.length) return lo(0, src.length);
        let k = ranges.findIndex((r) => toks[r[1]].line >= errLine && toks[r[0]].line <= errLine); if (k < 0) k = ranges.findIndex((r) => toks[r[0]].line >= errLine); if (k < 0) k = ranges.length - 1;
        const from = Math.max(0, k - 1); const a = toks[ranges[from][0]].off; const b = toks[ranges[k][1]].end;
        return lo(a, b);
    }
    function inParen(toks, i) { let d = 0; for (let k = i - 1; k >= 0; k--) { const t = toks[k]; if (t.t !== 'op') continue; if (t.v === ')') d++; else if (t.v === '(') { if (d === 0) return true; d--; } else if (t.v === '{' || t.v === '}' || t.v === ';') { if (d === 0 && t.v !== ';') return false; } } return false; }
    function lineOf(src, off) { let l = 1; for (let i = 0; i < off && i < src.length; i++) if (src[i] === '\n') l++; return l; }

    // ---------- 文法分析：AST／文法算出「我現在在哪個位置、這裡合法的下一步有哪些」----------
    // clike：從錯誤所在的最上層項目開頭，把錯誤 token 之前的 token 交給 Earley，得到「合法的下一個終端」集合；
    // python：以邏輯行為單位（先看前一行是不是還沒寫完——缺冒號、缺括號常在下一行才報錯，再看錯誤那一行）。
    // 文法吃不下的位置（failAt）比編譯器報的更準時，就用文法的位置。
    function logicalLines(toks) { const br = brackets(toks); const lines = []; let cur = []; toks.forEach((t, i) => { if (t.t === 'nl') { if (br.depth[i] === 0) { if (cur.length) lines.push(cur); cur = []; } } else cur.push(t); }); if (cur.length) lines.push(cur); return lines; }
    function topLevelStart(toks, k) { let depth = 0, start = 0; for (let i = 0; i < k && i < toks.length; i++) { const t = toks[i]; if (t.t === 'op' && t.v === '{') depth++; else if (t.t === 'op' && t.v === '}') { depth = Math.max(0, depth - 1); if (depth === 0) start = i + 1; } else if (t.t === 'op' && t.v === ';' && depth === 0) start = i + 1; else if (t.t === 'pp') { if (depth === 0) start = i + 1; } } return start; }
    function grammarAnalysis(lang, toks, err, k) {
        if (!Gm || !Gm.FAMILY_OF[lang]) return null; const fam = Gm.FAMILY_OF[lang];
        const clip2 = (a) => ({ keywords: a.classes.keywords.slice(0, 40), punct: a.classes.punct.slice(0, 40), names: a.classes.names, literals: a.classes.literals });
        if (fam === 'clike') {
            const start = topLevelStart(toks, k); const prefix = toks.slice(start, k); const a = Gm.expectedAt(lang, prefix);
            if (a.aborted) return { used: false, reason: '文法分析超過步數上限' };
            const failAbs = a.ok ? k : start + a.failAt;
            const consistent = a.ok ? !(toks[k] && a.expected.some((e) => (e[0] === "'" ? toks[k].v === e.slice(1, -1) : (e === 'ID' && toks[k].t === 'id') || (e === 'NUM' && toks[k].t === 'num') || (e === 'STR' && toks[k].t === 'str')))) : true;
            return { used: true, family: fam, regionFrom: start, regionTo: k, failAt: failAbs, grammarFoundFailure: !a.ok, consistent, expected: clip2(a), expectedRaw: a.expected, rest: toks.slice(failAbs, Math.min(toks.length, failAbs + 12)), prefixOk: a.ok, start };
        }
        // python：邏輯行
        const lines = logicalLines(toks); let li = lines.findIndex((l) => l[0].line <= err.line && l[l.length - 1].line >= err.line); if (li < 0) li = lines.findIndex((l) => l[0].line >= err.line); if (li < 0) li = lines.length - 1; if (li < 0) return null;
        const tryLine = (idx) => { const ln = lines[idx]; const a = Gm.expectedAt(lang, ln); return { idx, ln, a }; };
        const prev = li > 0 ? tryLine(li - 1) : null; const cur = tryLine(li);
        const lineIncomplete = (r) => r && r.a.ok && !r.a.complete; // 整行吃完了但還沒寫完（缺 : 或缺括號收尾）：問題在這行的結尾
        let pick = null, where = null;
        if (prev && (!prev.a.ok || lineIncomplete(prev))) { pick = prev; where = prev.a.ok ? 'end' : 'fail'; } else if (!cur.a.ok || lineIncomplete(cur)) { pick = cur; where = cur.a.ok ? 'end' : 'fail'; }
        if (!pick) return { used: true, family: fam, regionFrom: 0, regionTo: 0, failAt: -1, grammarFoundFailure: false, consistent: false, expected: clip2(cur.a), expectedRaw: cur.a.expected, rest: [], prefixOk: true, line: cur.ln };
        const base = pick.ln[0]; const startAbs = toks.indexOf(base); const failRel = pick.a.ok ? pick.ln.length : pick.a.failAt;
        return { used: true, family: fam, regionFrom: startAbs, regionTo: startAbs + pick.ln.length, failAt: startAbs + failRel, grammarFoundFailure: !pick.a.ok, consistent: true, expected: clip2(pick.a), expectedRaw: pick.a.expected, rest: pick.ln.slice(failRel, failRel + 12), prefixOk: pick.a.ok, line: pick.ln, atLineEnd: pick.a.ok, lineTokens: pick.ln };
    }
    // 文法候選：在文法判定的位置，把「合法的下一步」逐一試插／試換／試刪，用文法預先過濾（套用後要能往前多吃幾個 token），再交給編譯器
    const synthTok = (txt) => ({ t: /^[A-Za-z_$]/.test(txt) ? 'id' : 'op', v: txt });
    const spaceIns = (src, off, text) => { const prev = src[off - 1], next = src[off]; const word = /^[A-Za-z_$]/.test(text); let t = text; if (word) { if (prev && /[A-Za-z0-9_$]/.test(prev)) t = ' ' + t; if (next && /[A-Za-z0-9_$]/.test(next)) t = t + ' '; else if (next && next !== ' ' && next !== '\n' && next !== ')' && next !== ';' && next !== ',') t = t + ' '; else if (!next || next === '\n' || next === ';' || next === ')' || next === ',') { /* 不補 */ } } return t; };
    function grammarCandidates(lang, src, toks, err, k, ga, sym, topIdent) {
        if (!ga || !ga.used || !ga.expectedRaw) return [];
        const out = []; const j = Math.max(0, Math.min(ga.failAt, toks.length)); const region = ga.family === 'clike' ? toks.slice(ga.regionFrom) : (ga.lineTokens || []);
        const relJ = j - (ga.family === 'clike' ? ga.regionFrom : toks.indexOf(ga.lineTokens[0]));
        const baseProg = (arr) => { const r = Gm.expectedAt(lang, arr.map((t) => ({ t: t.t, v: t.v, bad: t.bad })), { maxItems: 200000 }); return r.supported ? (r.ok ? arr.length + (r.complete ? 2 : 0) : r.failAt) : -1; };
        const before = baseProg(region);
        const lookahead = Math.min(region.length, relJ + 8);
        const evalCand = (mut) => { const arr = mut(region.slice(0, lookahead)); return baseProg(arr); };
        const tokAt = (i) => toks[i];
        const insOff = (ga.atLineEnd || j >= toks.length) ? (toks[Math.min(j, toks.length) - 1] ? toks[Math.min(j, toks.length) - 1].end : src.length) : toks[j].off;
        const insLine = (ga.atLineEnd || j >= toks.length) ? (toks[j - 1] ? toks[j - 1].line : err.line) : toks[j].line;
        const add = (o) => { if (o.prog > Math.max(before, relJ) || o.prog >= (ga.family === 'python' ? (ga.lineTokens || []).length : relJ + 3)) out.push(Object.assign({ len: 0, text: '', src: 'grammar', gprog: o.prog, gbefore: relJ }, o.e)); };
        const stackTopCloser = topIdent;
        // 1) 插入合法的字面終端（關鍵字、符號）
        for (const e of ga.expectedRaw) {
            if (e[0] !== "'") continue; const lit = e.slice(1, -1); if (!lit) continue;
            const prog = evalCand((a) => a.slice(0, relJ).concat([synthTok(lit)], a.slice(relJ))); const word = /^[A-Za-z_]+$/.test(lit);
            const cost = stackTopCloser && lit === stackTopCloser ? 0.4 : (word ? 0.9 : 0.7);
            // 收尾類符號（; ) ] } , :）緊貼前一個 token 的後面（不留空白）；其他符號與字詞插在文法判定的位置
            const attach = !word && /^[;)\]},:]$/.test(lit) && j - 1 >= 0 && toks[j - 1] && toks[j - 1].t !== 'nl'; const off = attach ? toks[j - 1].end : insOff; const ln = attach ? toks[j - 1].line : insLine;
            add({ prog, e: { op: 'insert', off, text: spaceIns(src, off, lit), line: ln, cost, kind: word ? 'keyword' : 'punct', desc: '在文法判定的位置插入合法的' + (word ? '關鍵字「' + lit + '」' : '符號「' + lit + '」') } });
        }
        // 2) 名詞：這裡合法的是識別字 → 從作用域已知的名稱裡挑（設計樹／已宣告的／出現過的）
        if (ga.expectedRaw.includes('ID') && sym) {
            const names = Array.from(new Set([...(sym.declared || []), ...Object.keys((sym.extSymbols) || {})])).filter((n) => !kwOf(lang).has(n) && /^[A-Za-z_]\w*$/.test(n)).slice(0, 12);
            for (const nm of names) { const prog = evalCand((a) => a.slice(0, relJ).concat([synthTok(nm)], a.slice(relJ))); add({ prog, e: { op: 'insert', off: insOff, text: spaceIns(src, insOff, nm), line: insLine, cost: 1.3, kind: 'name', desc: '在文法判定的位置補上已知的名稱「' + nm + '」' } }); }
        }
        // 3) 取代／刪除錯誤位置的標點（只動 1～3 字元的符號）
        const bad = tokAt(j);
        if (bad && bad.t === 'op' && bad.v.length <= 3 && j < toks.length) {
            for (const e of ga.expectedRaw) { if (e[0] !== "'") continue; const lit = e.slice(1, -1); if (!lit || /^[a-z]+$/.test(lit) || lit === bad.v) continue; const prog = evalCand((a) => a.slice(0, relJ).concat([synthTok(lit)], a.slice(relJ + 1))); add({ prog, e: { op: 'replace', off: bad.off, len: bad.v.length, text: lit, line: bad.line, cost: 1.4, kind: 'replace', desc: '把「' + bad.v + '」換成文法這裡合法的「' + lit + '」' } }); }
            const progDel = evalCand((a) => a.slice(0, relJ).concat(a.slice(relJ + 1))); add({ prog: progDel, e: { op: 'delete', off: bad.off, len: bad.v.length, text: '', line: bad.line, cost: 2.0, kind: 'delete', desc: '刪掉文法不接受的「' + bad.v + '」' } });
        }
        return out;
    }
    function describeGrammar(ga) { if (!ga) return null; if (!ga.used) return { used: false, reason: ga.reason }; return { used: true, family: ga.family, grammarFoundFailure: ga.grammarFoundFailure, consistentWithCompiler: ga.consistent, failAtToken: ga.failAt, around: (ga.rest || []).slice(0, 6).map((t) => t.v).join(' '), legalNext: ga.expected }; }

    // ---------- 候選 ----------
    const HEADER = /^(def|class|if|elif|else|for|while|try|except|finally|with|async)\b/;
    function applyEdit(src, e) { return src.slice(0, e.off) + e.text + src.slice(e.off + e.len); }
    function candidates(lang, src, toks, err, hint) {
        const fam = FAMILY[lang]; const eol = src.indexOf('\r\n') >= 0 ? '\r\n' : '\n'; const br = brackets(toks); const out = []; const seen = new Set();
        const errLine = err.line;
        // 錯誤 token：第一個在 (line,col) 之後的 token；沒有欄位就用該行第一個 token；超過最後一個 → EOF
        let k = toks.findIndex((t) => (t.line > errLine) || (t.line === errLine && (err.col == null ? true : t.col >= err.col))); if (k < 0) k = toks.length;
        while (k < toks.length && toks[k].t === 'nl' && err.col == null && toks[k].line === errLine && k + 1 < toks.length && toks[k + 1].line === errLine) k++;
        const lastOfLine = {}; toks.forEach((t) => { if (t.t !== 'nl') lastOfLine[t.line] = t; });
        const lineStartOff = (l) => { let off = 0, cur = 1; while (cur < l) { const nx = src.indexOf('\n', off); if (nx < 0) return src.length; off = nx + 1; cur++; } return off; };
        const endOfLine = (l) => { const t = lastOfLine[l]; return t ? t.end : null; };
        const prevLine = (() => { for (let l = errLine - 1; l >= 1; l--) if (lastOfLine[l]) return l; return null; })();
        const nonNl = (i) => toks[i] && toks[i].t !== 'nl';
        const unit = unitOf(lang, toks, src, errLine);
        const eof = src.replace(/\s+$/, '').length;
        const posList = []; const addPos = (off, line, tag) => { if (off == null || off < 0) return; if (!posList.some((p) => p.off === off)) posList.push({ off, line, tag }); };
        // 成本相同時先試的順序＝偏好的位置：緊貼前一個 token 後面（`foo()` + `;` 這種）優先，其次才是錯誤 token 前面
        if (k - 1 >= 0 && nonNl(k - 1)) addPos(toks[k - 1].end, toks[k - 1].line, 'after-prev');
        if (prevLine) addPos(endOfLine(prevLine), prevLine, 'prev-line-end');
        if (k < toks.length) { addPos(toks[k].off, toks[k].line, 'before'); addPos(toks[k].end, toks[k].line, 'after'); }
        if (k - 1 >= 0 && nonNl(k - 1)) addPos(toks[k - 1].off, toks[k - 1].line, 'before-prev');
        addPos(endOfLine(errLine), errLine, 'err-line-end'); addPos(unit.endOff, unit.endLine, 'unit-end'); addPos(eof, lineOf(src, eof), 'eof');
        const lineDist = (l) => Math.abs((l || errLine) - errLine);
        const add = (o) => { const e = Object.assign({ len: 0, text: '' }, o); const key = e.off + '|' + e.len + '|' + e.text; if (seen.has(key)) return; seen.add(key); e.cost = (e.cost || 1) + 0.4 * lineDist(e.line); out.push(e); };
        const top = br.stack.length ? br.stack[br.stack.length - 1] : null;
        // 0) 識別字黏合（刪掉了中間的符號，前後兩個詞黏成一個）：在拆點補回 ( 或空白——只有語意分析看得出來，編譯器看到的只是一個陌生的名字
        if (!(hint && hint.semanticScoring === false)) for (const g of semanticIssues(lang, src, hint && hint.semantic).filter((x) => x.kind === 'glue')) {
            const word = g.key.slice(5); const t = toks.find((x) => x.t === 'id' && x.v === word && Math.abs(x.line - errLine) <= 2); if (!t) continue;
            const ks = new Set([...kwOf(lang), ...((BUILTINS[lang] || '').split(' '))]); for (const x of toks) if (x.t === 'id' && x.v !== word) ks.add(x.v);
            for (let k2 = 2; k2 <= word.length - 1; k2++) { const a1 = word.slice(0, k2), b1 = word.slice(k2); if (!(ks.has(a1) && ks.has(b1))) continue; for (const [ins, nm] of [['(', '「(」'], [' ', '空白']]) add({ op: 'insert', off: t.off + k2, text: ins, line: t.line, cost: 0.6, desc: '把「' + word + '」拆成「' + a1 + '」和「' + b1 + '」（補上' + nm + '）' }); }
        }
        // 1) 字串沒收尾：補引號（成本低）
        for (const t of toks) if (t.t === 'str' && t.bad && Math.abs(t.line - errLine) <= 1) add({ op: 'insert', off: t.end, text: t.quote, line: t.line, cost: 0.5, desc: '補上字串結尾的引號 ' + t.quote });
        // 2) 補收括號：依堆疊最上面那個決定（最像）；位置：各候選位置
        const closers = top ? [CLOSE[top.ch]] : [];
        for (const p of posList) for (const c of closers) add({ op: 'insert', off: p.off, text: c, line: p.line, cost: 0.8, desc: '在' + tagName(p.tag) + '補上「' + c + '」（對應第 ' + toks[top.idx].line + ' 行的「' + top.ch + '」）' });
        if (top && fam === 'python') { // 行尾有 ':' 時，收括號要放在 ':' 前面
            const ll = lastOfLine[errLine] || lastOfLine[prevLine]; if (ll && ll.v === ':') add({ op: 'insert', off: ll.off, text: CLOSE[top.ch], line: ll.line, cost: 0.7, desc: '在「:」前補上「' + CLOSE[top.ch] + '」' });
        }
        // 3) 多出來或收錯的收括號：刪掉；或補上對應的開括號
        for (const s of br.strays.concat(br.mismatch.map((m) => ({ tok: m.tok, idx: m.idx })))) if (Math.abs(s.tok.line - errLine) <= 2) { add({ op: 'delete', off: s.tok.off, len: s.tok.v.length, line: s.tok.line, cost: 1.8, desc: '刪掉多出來的「' + s.tok.v + '」' }); }
        for (const m of br.mismatch) if (Math.abs(m.tok.line - errLine) <= 2) add({ op: 'replace', off: m.tok.off, len: 1, text: m.want, line: m.tok.line, cost: 0.9, desc: '把「' + m.tok.v + '」改成「' + m.want + '」' });
        if (top && Math.abs(toks[top.idx].line - errLine) <= 2 && toks.length - top.idx < 40) add({ op: 'delete', off: toks[top.idx].off, len: 1, line: toks[top.idx].line, cost: 2.0, desc: '刪掉沒有收尾的「' + top.ch + '」' });
        // 4) 家族專屬
        const V = VOCAB[lang];
        if (V) {
            for (const tm of V.terminators) for (const p of posList) { add({ op: 'insert', off: p.off, text: tm, line: p.line, cost: V.termCost, desc: '在' + tagName(p.tag) + '補上「' + tm + '」' }); }
            for (const sp of V.separators) for (const p of posList.filter((x) => x.tag !== 'eof')) { add({ op: 'insert', off: p.off, text: sp, line: p.line, cost: 1.6, desc: '在' + tagName(p.tag) + '補上「' + sp + '」' }); }
            if (/expected '\{'|'\{' expected|expected .*\{/.test(err.msg || '')) for (const p of posList) add({ op: 'insert', off: p.off, text: V.openBrace, line: p.line, cost: 1.2, desc: '在' + tagName(p.tag) + '補上「{」' });
            const wantClose = top ? [CLOSE[top.ch]] : [];
            if (!top && V.strayOpeners) for (const s of br.strays) { const ch = OPEN[s.tok.v]; for (const t of toks.slice(Math.max(0, s.idx - 12), s.idx + 1)) if (t.line === s.tok.line) add({ op: 'insert', off: t.off, text: ch, line: t.line, cost: 1.4, desc: '在「' + clip(t.v, 12) + '」前補上「' + ch + '」' }); }
            void wantClose;
        }
        if (fam === 'python') {
            const hdr = [prevLine, errLine].map((l) => l && lastOfLine[l] && firstOfLine(toks, l)).filter(Boolean);
            for (const f of hdr) { const l = lastOfLine[f.line]; if (HEADER.test(f.v) && l.v !== ':') add({ op: 'insert', off: l.end, text: ':', line: l.line, cost: 0.9, desc: '在第 ' + l.line + ' 行行尾補上「:」' }); }
            if (/expected an indented block|IndentationError: expected/i.test(err.msg || '')) { const hl = prevLine; if (hl && lastOfLine[hl]) { const ind = /^[ \t]*/.exec(src.split('\n')[hl - 1])[0]; add({ op: 'insert', off: lastOfLine[hl].end, text: eol + ind + '    pass', line: hl, cost: 1.4, desc: '在第 ' + hl + ' 行下面補上縮排的 pass' }); } }
            if (/unexpected indent|unindent does not match|IndentationError|TabError/i.test(err.msg || '')) {
                const lines = src.split('\n'); const cur = /^[ \t]*/.exec(lines[errLine - 1] || '')[0]; const cands = new Set(); for (let l = errLine - 1; l >= 1 && cands.size < 4; l--) { if (!(lines[l - 1] || '').trim()) continue; cands.add(/^[ \t]*/.exec(lines[l - 1])[0]); const w = /^[ \t]*/.exec(lines[l - 1])[0]; cands.add(w + '    '); }
                for (const w of cands) if (w !== cur) add({ op: 'replace', off: lineStartOff(errLine), len: cur.length, text: w, line: errLine, cost: 1.2, desc: '把第 ' + errLine + ' 行的縮排改成 ' + w.length + ' 格' });
            }
        }
        if (fam === 'ruby') {
            for (const p of posList) add({ op: 'insert', off: p.off, text: eol + 'end', line: p.line, cost: p.tag === 'eof' ? 0.9 : 1.2, desc: '在' + tagName(p.tag) + '補上 end' });
            if (k < toks.length && toks[k].v === 'end') add({ op: 'delete', off: toks[k].off, len: 3, line: toks[k].line, cost: 1.1, desc: '刪掉多出來的 end' });
        }
        if (fam === 'bash') {
            for (const w of ['fi', 'done', 'esac', '}']) for (const p of posList.filter((x) => x.tag === 'eof' || x.tag === 'unit-end')) add({ op: 'insert', off: p.off, text: eol + w, line: p.line, cost: 1.0, desc: '在' + tagName(p.tag) + '補上 ' + w });
            for (let f = errLine; f >= Math.max(1, errLine - 6); f--) { if (!lastOfLine[f]) continue; const first = firstOfLine(toks, f); const l = lastOfLine[f]; const nxt = (() => { for (let g = f + 1; g <= f + 3; g++) if (lastOfLine[g]) return firstOfLine(toks, g); return null; })(); if (nxt && /^(then|do)$/.test(nxt.v)) continue; if (first && /^(if|elif)$/.test(first.v) && l.v !== 'then') add({ op: 'insert', off: l.end, text: '; then', line: f, cost: 0.9, desc: '在第 ' + f + ' 行補上 then' }); if (first && /^(while|for|until)$/.test(first.v) && l.v !== 'do') add({ op: 'insert', off: l.end, text: '; do', line: f, cost: 0.9, desc: '在第 ' + f + ' 行補上 do' }); }
        }
        // 5) 通用：刪掉錯誤位置的 token／前一個 token（亂入的符號）；= 改 ==
        // 刪除是破壞性的（拿掉作者寫過的東西，常常語法過了但語意變了）：只刪標點，不刪字串、數字、識別字
        for (const idx of [k, k - 1]) { const t = toks[idx]; if (!t || t.t !== 'op' || t.v.length > 3) continue; if (Math.abs(t.line - errLine) > 1) continue; add({ op: 'delete', off: t.off, len: t.v.length, line: t.line, cost: 2.0, desc: '刪掉「' + t.v + '」' }); }
        for (let i = Math.max(0, k - 6); i < Math.min(toks.length, k + 6); i++) { const t = toks[i]; if (t.t === 'op' && t.v === '=' && br.depth[i] > 0 && Math.abs(t.line - errLine) <= 1) add({ op: 'replace', off: t.off, len: 1, text: '==', line: t.line, cost: 1.5, desc: '把「=」改成「==」' }); }
        void hint;
        // 文法驅動的候選（優先）：文法判定的位置合法的下一步；我手寫的詞彙表只當文法有洞時的備援（成本 +0.4，並標 src）
        let ga = null, gc = [];
        if (hint && hint.grammar !== false && Gm && Gm.FAMILY_OF[lang]) {
            try {
                ga = grammarAnalysis(lang, toks, err, k); const sym = symbolsOf(lang, toks, hint.semantic); sym.extSymbols = (hint.semantic && hint.semantic.symbols) || {};
                gc = grammarCandidates(lang, src, toks, err, k, ga, sym, top ? CLOSE[top.ch] : null);
            } catch (e) { ga = { used: false, reason: '文法分析出錯：' + String((e && e.message) || e) }; gc = []; }
        }
        out.forEach((c) => { c.src = c.src || 'vocab'; if (gc.length) c.cost += 0.4; });
        const seenKeys = new Set(out.map((c) => c.off + '|' + c.len + '|' + c.text));
        for (const c of gc) { const key = c.off + '|' + c.len + '|' + c.text; if (seenKeys.has(key)) { const ex = out.find((x) => x.off + '|' + x.len + '|' + x.text === key); if (ex) { ex.src = 'grammar+vocab'; ex.cost = Math.min(ex.cost - 0.4, c.cost); ex.gprog = c.gprog; } continue; } seenKeys.add(key); c.cost += 0.4 * lineDist(c.line); out.push(c); }
        out.sort((a, b) => (a.cost - b.cost) || ((b.gprog || 0) - (a.gprog || 0)));
        out.grammar = describeGrammar(ga);
        return out;
    }
    function firstOfLine(toks, l) { return toks.find((t) => t.line === l && t.t !== 'nl'); }
    function tagName(tag) { return { before: '錯誤位置前面', after: '錯誤位置後面', 'before-prev': '前一個 token 前面', 'after-prev': '前一個 token 後面', 'prev-line-end': '上一行行尾', 'err-line-end': '出錯那行行尾', 'unit-end': '這條敘述的結尾', eof: '檔案結尾' }[tag] || tag; }

    // ---------- 語意評分 ----------
    // 「編譯器接受」不等於「作者要的」。編譯型語言的編譯器已經會做名稱與型別檢查（所以未定義的名稱在那些語言是 CE，不必重複檢查）；
    // 但它不知道意圖：`mainvoid()` 是合法的宣告、`scanf( &a, &b)` 能編譯、Python 的 `printa + b` 解析得過（執行時才 NameError）。
    // 這裡用「設計樹」已知的語意（同一份程式裡的函式簽名、外部注入的計畫簽名／UML 類別與方法、思考堆疊的已定決定）評估候選：
    // 比較套用前後的語意問題集合，新引入的問題扣分、解決掉的問題加分，併入候選的有效成本。
    // 保留字：有文法的語言（python、c、cpp、java、csharp、nodejs）取自**各自文法**的關鍵字（C 的保留字沒有 Java 的 instanceof，Python 的 int 不是關鍵字）；
    // 沒有文法的語言（ruby、perl、bash、組語）才用下面這份備援（不跨語言借用給有文法的語言）
    const KEYWORDS_FALLBACK = new Set(['if', 'else', 'elif', 'for', 'while', 'do', 'return', 'def', 'class', 'function', 'var', 'let', 'const', 'import', 'from', 'as', 'in', 'is', 'not', 'and', 'or', 'new', 'void', 'int', 'long', 'char', 'short', 'double', 'float', 'bool', 'boolean', 'string', 'static', 'public', 'private', 'protected', 'final', 'struct', 'enum', 'typedef', 'unsigned', 'signed', 'try', 'catch', 'except', 'finally', 'throw', 'raise', 'with', 'yield', 'lambda', 'pass', 'break', 'continue', 'switch', 'case', 'default', 'end', 'then', 'fi', 'done', 'esac', 'sub', 'my', 'our', 'use', 'package', 'self', 'this', 'true', 'false', 'null', 'None', 'True', 'False', 'auto', 'using', 'namespace', 'extends', 'implements', 'interface', 'abstract', 'async', 'await', 'sizeof', 'echo', 'read', 'local', 'let', 'puts', 'print']);
    const BUILTINS = { python: 'print input len range int str float list dict set tuple sum min max abs sorted reversed enumerate zip map filter open isinstance type bool any all round divmod pow ord chr bin hex format repr iter next super sys', nodejs: 'console log require parseInt parseFloat Number String Math JSON Array Object Map Set process Date Error Promise setTimeout', c: 'main printf scanf sscanf fprintf snprintf puts gets fgets getchar putchar malloc free calloc realloc memcpy memset strlen strcmp strcpy strcat atoi atol abs sqrt pow exit stdin stdout stderr NULL', cpp: 'main printf scanf cout cin cerr endl std vector string map set sort size push_back begin end max min abs sqrt pow getline', java: 'main System out in println print printf String Scanner nextInt nextLong nextLine Math Integer Long List ArrayList Map HashMap Arrays', csharp: 'Main Console WriteLine ReadLine Write Math Convert Parse List Dictionary', ruby: 'puts print gets p require each map select', perl: 'print printf shift push pop split join sort keys values scalar defined', bash: 'echo read printf test cd ls cat grep' };
    function argCount(toks, open) { // toks[open] 是 '('；回傳 {n, close}（n＝最外層的引數個數；空括號＝0）
        let d = 0, n = 0, any = false;
        for (let i = open; i < toks.length; i++) { const t = toks[i]; if (t.t === 'op' && CLOSE[t.v]) d++; else if (t.t === 'op' && OPEN[t.v]) { d--; if (d === 0) return { n: any ? n + 1 : 0, close: i }; } else if (d === 1) { if (t.t === 'op' && t.v === ',') n++; else if (t.t !== 'nl') any = true; } }
        return { n: -1, close: -1 };
    }
    function symbolsOf(lang, toks, ext) {
        const defs = new Map(); const declared = new Set(); const all = new Map();
        toks.forEach((t) => { if (t.t === 'id') all.set(t.v, (all.get(t.v) || 0) + 1); });
        const DECL = /^(def|class|function|var|let|const|int|long|char|double|float|void|bool|boolean|string|String|auto|my|struct|enum|sub|import|from)$/;
        toks.forEach((t, i) => {
            if (t.t !== 'id') return; const prev = toks[i - 1], next = toks[i + 1];
            if (prev && prev.t === 'id' && DECL.test(prev.v)) declared.add(t.v);
            if (next && next.t === 'op' && next.v === '=' && !(toks[i + 2] && toks[i + 2].v === '=') && (!prev || prev.v !== '.')) declared.add(t.v);
            if (prev && prev.t === 'id' && next && next.t === 'op' && (next.v === ',' || next.v === ')' || next.v === ';' || next.v === '=' || next.v === '[')) declared.add(t.v); // `type name` 形式的宣告／參數
            if (next && next.t === 'op' && next.v === '(' && prev && (prev.v === 'def' || prev.v === 'sub' || prev.v === 'function' || (prev.t === 'id' && !kwOf(lang).has(prev.v) || (prev.t === 'id' && /^(int|long|char|double|float|void|bool|boolean|string|String|auto|static|public)$/.test(prev.v))))) {
                const ac = argCount(toks, i + 1); if (ac.n >= 0) { let n = ac.n; if (ac.n === 1 && toks[i + 2] && toks[i + 2].v === 'void') n = 0; if (lang === 'python' && toks[i + 2] && /^(self|cls)$/.test(toks[i + 2].v)) n = Math.max(0, n - 1); if (/^[A-Za-z_]\w*$/.test(t.v)) { declared.add(t.v); if (!defs.has(t.v)) defs.set(t.v, n); } }
            }
        });
        // 各語言自己的宣告位置（沒有型別關鍵字可看的語言要看語法位置）
        if (lang === 'python') {
            for (let i = 0; i < toks.length; i++) {
                const t = toks[i];
                if (t.t === 'id' && t.v === 'def') { let k = i + 2; if (toks[k] && toks[k].v === '(') { let d = 0, expectName = true; for (; k < toks.length; k++) { const x = toks[k]; if (x.t === 'op' && (x.v === '(' || x.v === '[' || x.v === '{')) { d++; continue; } if (x.t === 'op' && (x.v === ')' || x.v === ']' || x.v === '}')) { d--; if (d === 0) break; continue; } if (d === 1) { if (x.t === 'op' && x.v === ',') expectName = true; else if (x.t === 'op' && (x.v === '*' || x.v === '**' || x.v === '/')) { /* 星號參數 */ } else if (x.t === 'id' && expectName) { declared.add(x.v); expectName = false; } else expectName = false; } } } }
                if (t.t === 'id' && t.v === 'for') { for (let k = i + 1; k < toks.length && !(toks[k].t === 'id' && toks[k].v === 'in') && toks[k].t !== 'nl'; k++) if (toks[k].t === 'id' && !(toks[k - 1] && toks[k - 1].v === '.')) declared.add(toks[k].v); }
                if (t.t === 'id' && t.v === 'as' && toks[i + 1] && toks[i + 1].t === 'id') declared.add(toks[i + 1].v);
                if (t.t === 'id' && t.v === 'import') for (let k = i + 1; k < toks.length && toks[k].t !== 'nl'; k++) if (toks[k].t === 'id' && toks[k].v !== 'as') declared.add(toks[k].v);
                if (t.t === 'op' && t.v === '=' && !(toks[i + 1] && toks[i + 1].v === '=')) { let k = i - 1, d = 0; for (; k >= 0 && toks[k].t !== 'nl'; k--) { const x = toks[k]; if (x.t === 'op' && (x.v === ')' || x.v === ']' || x.v === '}')) d++; else if (x.t === 'op' && (x.v === '(' || x.v === '[' || x.v === '{')) d--; else if (x.t === 'id' && d <= 0 && !(toks[k - 1] && toks[k - 1].v === '.') && !(toks[k + 1] && (toks[k + 1].v === '(' || toks[k + 1].v === '[' || toks[k + 1].v === '.'))) declared.add(x.v); } }
            }
        }
        if (lang === 'nodejs') {
            for (let i = 0; i < toks.length; i++) {
                const t = toks[i];
                if (t.t === 'id' && /^(const|let|var)$/.test(t.v) && toks[i + 1] && toks[i + 1].t === 'op' && (toks[i + 1].v === '[' || toks[i + 1].v === '{')) { let d = 0; for (let k = i + 1; k < toks.length; k++) { const x = toks[k]; if (x.t === 'op' && (x.v === '[' || x.v === '{')) d++; else if (x.t === 'op' && (x.v === ']' || x.v === '}')) { d--; if (d === 0) break; } else if (x.t === 'id') declared.add(x.v); } }
                if (t.t === 'op' && t.v === '=>') { const p = toks[i - 1]; if (p && p.t === 'id') declared.add(p.v); else if (p && p.v === ')') { let d = 0; for (let k = i - 1; k >= 0; k--) { const x = toks[k]; if (x.t === 'op' && x.v === ')') d++; else if (x.t === 'op' && x.v === '(') { d--; if (d === 0) break; } else if (x.t === 'id') declared.add(x.v); } } }
                if (t.t === 'id' && t.v === 'function' && toks[i + 1] && toks[i + 1].v === '(' || (t.t === 'id' && t.v === 'function' && toks[i + 2] && toks[i + 2].v === '(')) { let k = toks[i + 1].v === '(' ? i + 1 : i + 2; let d = 0; for (; k < toks.length; k++) { const x = toks[k]; if (x.t === 'op' && x.v === '(') d++; else if (x.t === 'op' && x.v === ')') { d--; if (d === 0) break; } else if (x.t === 'id') declared.add(x.v); } }
            }
        }
        const known = new Set([...declared, ...defs.keys(), ...kwOf(lang), ...((BUILTINS[lang] || '').split(' '))]);
        if (ext && ext.symbols) for (const [k, v] of Object.entries(ext.symbols)) { known.add(k); declared.add(k); if (Number.isInteger(v)) defs.set(k, v); }
        for (const [k, c] of all) if (c >= 2) known.add(k); // 出現兩次以上的識別字（使用過又出現在別處）當成已知
        return { defs, declared, known, all };
    }
    const kwOf = (lang) => (Gm && Gm.supports(lang) ? Gm.grammarOf(lang).keywords : KEYWORDS_FALLBACK);
    const INTERP = new Set(['python', 'nodejs', 'ruby', 'perl', 'bash']);
    const FORMAT_FN = { printf: 0, scanf: 0, fprintf: 1, fscanf: 1, sprintf: 1, sscanf: 1, snprintf: 2 };
    function semanticIssues(lang, text, ext) {
        const toks = lex(lang, text); const sym = symbolsOf(lang, toks, ext); const issues = []; const knownSans = (self) => { const k = new Set([...kwOf(lang), ...((BUILTINS[lang] || '').split(' '))]); for (const [w, c] of sym.all) if (w !== self && c >= 1) k.add(w); for (const d of sym.declared) if (d !== self) k.add(d); if (ext && ext.symbols) Object.keys(ext.symbols).forEach((x) => k.add(x)); return k; };
        const add = (kind, key, w, msg) => issues.push({ kind, key: kind + ':' + key, w, msg });
        const interp = INTERP.has(lang);
        for (let i = 0; i < toks.length; i++) {
            const t = toks[i]; if (t.t !== 'id') continue; const prev = toks[i - 1], next = toks[i + 1]; const isCall = next && next.t === 'op' && next.v === '(';
            // 識別字黏合：沒定義過、只出現一次、而且能拆成兩個已知的詞（printa＝print＋a、mainvoid＝main＋void）
            if (sym.all.get(t.v) === 1 && t.v.length >= 4 && !kwOf(lang).has(t.v) && !(BUILTINS[lang] || '').split(' ').includes(t.v) && !(ext && ext.symbols && t.v in ext.symbols)) { for (let k = 2; k <= t.v.length - 1; k++) { const a = t.v.slice(0, k), b = t.v.slice(k); const ks = knownSans(t.v); if (ks.has(a) && ks.has(b) && (a.length >= 2 || kwOf(lang).has(a)) && (b.length >= 1)) { add('glue', t.v, 3, '「' + t.v + '」像是「' + a + '」和「' + b + '」黏在一起（少了分隔的符號）'); break; } } }
            if (isCall && !(prev && prev.v === '.') && !(prev && prev.t === 'id' && /^(def|sub|function|new|class)$/.test(prev.v))) {
                const ac = argCount(toks, i + 1); const isDef = sym.defs.has(t.v) && prev && prev.t === 'id' && !kwOf(lang).has(prev.v);
                if (ac.n >= 0 && sym.defs.has(t.v) && !isDef && !(prev && prev.t === 'id' && /^(int|long|char|double|float|void|bool|boolean|string|String|auto|static|public)$/.test(prev.v)) && sym.defs.get(t.v) !== ac.n) add('arity', t.v + '/' + ac.n, 2.5, '呼叫「' + t.v + '」給了 ' + ac.n + ' 個引數，但它的簽名要 ' + sym.defs.get(t.v) + ' 個');
                if (interp && !sym.known.has(t.v) && sym.all.get(t.v) === 1 && !(prev && prev.v === '.')) add('unknown_call', t.v, 0.8, '呼叫了沒有定義的名稱「' + t.v + '」（直譯語言要到執行時才會發現）');
                // printf／scanf 家族：格式字串的轉換說明個數要和後面的引數個數一致
                if ((lang === 'c' || lang === 'cpp') && FORMAT_FN[t.v] != null && ac.n >= 0) {
                    const fi = FORMAT_FN[t.v]; let d = 0, argIdx = 0, fmtTok = null; for (let k = i + 1; k <= ac.close; k++) { const x = toks[k]; if (x.t === 'op' && CLOSE[x.v]) d++; else if (x.t === 'op' && OPEN[x.v]) d--; else if (d === 1 && x.t === 'op' && x.v === ',') argIdx++; else if (d === 1 && argIdx === fi && !fmtTok) fmtTok = x; }
                    if (!fmtTok || fmtTok.t !== 'str') add('format_missing', t.v + '@' + i, 2.5, '「' + t.v + '」的第 ' + (fi + 1) + ' 個引數應該是格式字串');
                    else { const specs = (fmtTok.v.match(/%(?:%|[-+ #0]*(?:\d+|\*)?(?:\.\d+)?(?:hh|h|ll|l|L|z|j|t)?[diuoxXfFeEgGaAcspn])/g) || []).filter((m) => m !== '%%' && m.indexOf('*') < 0).length; const given = ac.n - (fi + 1); if (specs !== given) add('format_count', t.v + '/' + specs + '/' + given, 2.5, '「' + t.v + '」的格式字串有 ' + specs + ' 個轉換說明，卻給了 ' + given + ' 個引數'); }
                }
            }
        }
        return issues;
    }
    // 套用前後的差：新引入的問題（扣）、被解決的問題（加）。base 是套用前的問題 key 集合
    function semanticDelta(baseIssues, candIssues) {
        const bk = new Set(baseIssues.map((x) => x.key)), ck = new Set(candIssues.map((x) => x.key));
        const introduced = candIssues.filter((x) => !bk.has(x.key)), resolved = baseIssues.filter((x) => !ck.has(x.key));
        return { delta: introduced.reduce((a, x) => a + x.w, 0) - 0.5 * resolved.reduce((a, x) => a + x.w, 0), introduced: introduced.map((x) => x.msg), resolved: resolved.map((x) => x.msg) };
    }
    // 外部語意（設計樹）：計畫的函式簽名、UML 的類別與方法、思考堆疊的已定決定 → { symbols:{名稱:引數個數|null}, hints:[文字] }
    function symbolsFromSignatures(list) { const symbols = {}; for (const sg of list || []) { const m = /([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(String(sg)); if (!m) { const n = /^\s*(?:def\s+|function\s+)?([A-Za-z_]\w*)\s*$/.exec(String(sg)); if (n) symbols[n[1]] = null; continue; } const ps = m[2].split(',').map((x) => x.trim()).filter((x) => x && !/^(self|cls|void)$/.test(x)); symbols[m[1]] = ps.length; } return symbols; }
    function symbolsFromModel(model) { const symbols = {}; for (const c of (model && model.classes) || []) { symbols[c.name] = null; for (const a of c.attrs || []) symbols[a.name] = null; for (const o of c.ops || []) symbols[o.name] = (o.params || []).length; } return symbols; }

    // ---------- diff（單一區塊，保留前後各 2 行脈絡）----------
    // 把修復過程的紀錄格式化成人看得懂的文字：編譯器說什麼 → 文法分析在哪裡判定出錯、合法的下一步有哪些 → 候選 → 選擇
    function formatTrace(trace) {
        const L = [];
        for (const r of trace || []) {
            L.push('— 第 ' + r.round + ' 輪 —'); L.push('編譯器：第 ' + r.error.line + ' 行' + (r.error.col ? ' 第 ' + r.error.col + ' 欄' : '') + '：' + r.error.msg);
            const g = r.grammar;
            if (!g) L.push('文法分析：這個語言沒有文法（只能用備援詞彙）');
            else if (!g.used) L.push('文法分析：沒有用（' + g.reason + '）');
            else { L.push('文法分析（' + g.family + '）：' + (g.grammarFoundFailure ? '在 token #' + g.failAtToken + '「' + (g.around.split(' ')[0] || '行尾') + '」判定語法不合法' : '前面都合法，但在這個位置還沒寫完／不該出現') + (g.consistentWithCompiler ? '，與編譯器的位置一致' : '，與編譯器的位置不一致（以備援詞彙補足）')); L.push('  這個位置合法的下一步：關鍵字[' + g.legalNext.keywords.slice(0, 14).join(' ') + (g.legalNext.keywords.length > 14 ? ' …' : '') + '] 符號[' + g.legalNext.punct.slice(0, 18).join(' ') + (g.legalNext.punct.length > 18 ? ' …' : '') + ']' + (g.legalNext.names ? ' 名詞(識別字)' : '') + (g.legalNext.literals.length ? ' 字面值[' + g.legalNext.literals.join(',') + ']' : '')); }
            L.push('候選（前 ' + Math.min(6, r.candidates.length) + '／共 ' + r.candidates.length + '）：'); r.candidates.slice(0, 6).forEach((c) => L.push('  [' + c.src + '] ' + c.desc + '（成本 ' + c.cost + (c.grammarProgress != null ? '，文法預檢可吃到 token ' + c.grammarProgress : '') + '）'));
            if (r.scored) { L.push('編譯器驗證後：'); r.scored.slice(0, 4).forEach((c) => L.push('  ' + (c.pass ? '✓通過' : '↗進展') + ' [' + c.src + '] ' + c.desc + '（有效成本 ' + c.effCost + (c.semantic && c.semantic.introduced.length ? '；語意：' + c.semantic.introduced.join('／') : '') + (c.semantic && c.semantic.resolved.length ? '；解決：' + c.semantic.resolved.join('／') : '') + '）')); }
            if (r.picked) L.push('選擇（' + r.picked.by + '）：' + r.picked.desc + ' → ' + (r.outcome || '')); else L.push('結果：' + (r.outcome || ''));
        }
        return L.join('\n');
    }

    function unifiedDiff(a, b, name) {
        if (a === b) return '';
        const A = a.split('\n'), B = b.split('\n'); let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
        let sa = A.length, sb = B.length; while (sa > p && sb > p && A[sa - 1] === B[sb - 1]) { sa--; sb--; }
        const c0 = Math.max(0, p - 2), c1a = Math.min(A.length, sa + 2), c1b = Math.min(B.length, sb + 2);
        const L = ['--- ' + (name || 'a'), '+++ ' + (name || 'b'), '@@ -' + (c0 + 1) + ',' + (c1a - c0) + ' +' + (c0 + 1) + ',' + (c1b - c0) + ' @@'];
        for (let i = c0; i < p; i++) L.push(' ' + A[i]); for (let i = p; i < sa; i++) L.push('-' + A[i]); for (let i = p; i < sb; i++) L.push('+' + B[i]); for (let i = sa; i < c1a; i++) L.push(' ' + A[i]);
        return L.join('\n') + '\n';
    }

    // ---------- 修正 ----------
    const passed = (r) => r && (r.verdict === 'CHECKED' || r.verdict === 'AC');
    const posKey = (e) => (e ? e.line * 10000 + (e.col || 0) : 0);
    async function repairSyntax(a) {
        const lang = a.lang; const fam = FAMILY[lang]; const check = a.check; const o = Object.assign({ maxRounds: 4, maxTries: 30, concurrency: 4 }, a);
        const base = { ok: false, source: String(a.source == null ? '' : a.source), edits: [], diff: '', rounds: 0, tried: 0, choices: [], trace: [] };
        if (!fam) return Object.assign(base, { reason: 'unsupported_lang' }); if (typeof check !== 'function') return Object.assign(base, { reason: 'no_checker' });
        let cur = base.source; let res = await check({ lang, source: cur }); const edits = []; const choices = []; let tried = 0; const sem = a.semantic || null; const useSem = a.semanticScoring !== false;
        const finish = (ok, reason, extra) => Object.assign(base, { ok, source: ok ? cur : base.source, edits: ok ? edits : edits.slice(), diff: ok ? unifiedDiff(base.source, cur) : '', rounds: choices.length || edits.length, tried, choices, reason }, extra || {});
        if (passed(res)) return finish(true, 'already_ok', { edits: [] });
        if (!res || res.verdict !== 'CE') return finish(false, 'not_a_syntax_error:' + (res && res.verdict));
        for (let round = 1; round <= o.maxRounds; round++) {
            const log = (res.compileLog || '') + '\n' + (res.detail || ''); const errs = parseErrors(lang, log, cur); if (!errs.length) return finish(false, 'no_error_location', { errors: [] });
            const e0 = errs[0]; const toks = lex(lang, cur); const cands = candidates(lang, cur, toks, e0, { semantic: sem, semanticScoring: useSem, grammar: a.grammar !== false }); const gram = cands.grammar || null; if (!cands.length) return finish(false, 'no_candidates', { errors: errs });
            const unit = unitOf(lang, toks, cur, e0.line); const scored = []; let idx = 0; const baseIssues = useSem ? semanticIssues(lang, cur, sem) : [];
            // 送去編譯前先用語意把候選排序（語意分析很便宜、不需要編譯器；編譯器驗證有次數上限，排前面的先驗）
            for (const c of cands) { c.sd = useSem ? semanticDelta(baseIssues, semanticIssues(lang, applyEdit(cur, c), sem)) : { delta: 0, introduced: [], resolved: [] }; c.eff = c.cost + c.sd.delta; }
            cands.sort((x, y) => x.eff - y.eff);
            while (idx < cands.length && tried < o.maxTries * round && scored.filter((s) => s.pass).length < 4) {
                const batch = cands.slice(idx, idx + o.concurrency); idx += batch.length;
                const rs = await Promise.all(batch.map(async (c) => { const text = applyEdit(cur, c); let r; try { r = await check({ lang, source: text }); } catch (e) { r = { verdict: 'CE', compileLog: String(e && e.message || e) }; } return { c, text, r }; }));
                for (const { c, text, r } of rs) { tried++; const sd = c.sd; const eff = c.eff; if (passed(r)) scored.push({ c, text, pass: true, pos: Infinity, r, eff, sd }); else if (r && r.verdict === 'CE') { const fe = parseErrors(lang, (r.compileLog || '') + '\n' + (r.detail || ''), text)[0]; const pos = fe ? posKey(fe) : 0; if (pos > posKey(e0)) scored.push({ c, text, pass: false, pos, r, fe, eff, sd }); } }
            }
            const roundTrace = { round, error: { line: e0.line, col: e0.col, msg: e0.msg }, unit: clip(unit.text, 200), grammar: gram, candidates: cands.slice(0, 12).map((c) => ({ desc: c.desc, src: c.src, cost: +c.cost.toFixed(2), grammarProgress: c.gprog })), tried: scored.length };
            base.trace.push(roundTrace);
            if (!scored.length) { roundTrace.outcome = '沒有候選讓檢查往前進'; return finish(false, 'no_progress', { errors: errs }); }
            scored.sort((x, y) => (y.pass - x.pass) || (y.pos - x.pos) || (x.eff - y.eff));
            let verified = null;
            // 語法通過不代表語意對：有 verify（例如跑測試）時，在通過語法的候選裡依成本找第一個 verify 為真的
            if (typeof a.verify === 'function' && scored[0].pass) { const passing = scored.filter((x) => x.pass).slice(0, 4); for (const cand of passing) { let ok = false; try { ok = !!(await a.verify({ lang, source: cand.text })); } catch (_) { ok = false; } if (ok) { verified = cand; break; } } if (verified) scored.unshift(...scored.splice(scored.indexOf(verified), 1)); }
            const best = scored[0]; let pick = best; const group = verified ? [best] : scored.filter((s) => s.pass === best.pass && s.pos === best.pos).slice(0, 6); // 機械過濾（文法合法＋編譯器驗證）後剩下的選項，全部交給模型做選擇題
            if (group.length > 1 && typeof a.ask === 'function') {
                const letters = group.map((_, i) => String.fromCharCode(65 + i)); const lineOfEdit = (g) => g.text.split('\n').slice(Math.max(0, g.c.line - 1), g.c.line + (g.c.text.indexOf('\n') >= 0 ? 2 : 0)).join('⏎').trim();
                let msgs = [{ role: 'system', content: '你在修程式的語法錯誤。只輸出 JSON：{"pick":"字母"}，選一個最像作者原本想寫的修法（要符合已定的設計：名稱、參數個數、格式字串）。' }, { role: 'user', content: '編譯器說：' + e0.msg + '（第 ' + e0.line + ' 行）\n出問題的程式片段：\n' + clip(unit.text, 300) + (sem && sem.hints && sem.hints.length ? '\n\n已定的設計：\n' + sem.hints.slice(0, 6).map((h) => '- ' + clip(h, 100)).join('\n') : '') + '\n\n選項：\n' + group.map((g, i) => letters[i] + '. ' + g.c.desc + ' → ' + clip(lineOfEdit(g), 100) + (g.sd.introduced.length ? '（注意：' + clip(g.sd.introduced.join('；'), 90) + '）' : '')).join('\n') }];
                if (typeof a.wrap === 'function') { try { msgs = a.wrap(msgs) || msgs; } catch (_) { /* 包不起來就用原本的 */ } }
                let v = null; try { v = await a.ask(msgs, (x) => (x && letters.indexOf(String(x.pick || '').toUpperCase()) >= 0 ? [] : ['「pick」必須是 ' + letters.join('、') + ' 其中一個'])); } catch (_) { v = null; }
                if (v) { pick = group[letters.indexOf(String(v.pick).toUpperCase())]; choices.push({ round, by: 'model', options: group.map((g) => g.c.desc), picked: pick.c.desc }); } else choices.push({ round, by: 'program', reason: 'ask_failed', options: group.map((g) => g.c.desc), picked: pick.c.desc });
            } else if (group.length > 1) choices.push({ round, by: 'program', reason: 'no_ask', options: group.map((g) => g.c.desc), picked: pick.c.desc });
            roundTrace.scored = scored.slice(0, 8).map((x) => ({ desc: x.c.desc, src: x.c.src, pass: !!x.pass, effCost: +x.eff.toFixed(2), semantic: x.sd ? { introduced: x.sd.introduced, resolved: x.sd.resolved } : null })); roundTrace.picked = { desc: pick.c.desc, src: pick.c.src, by: choices.length && choices[choices.length - 1].round === round ? choices[choices.length - 1].by : 'program(最低有效成本)' }; roundTrace.outcome = pick.pass ? '修好了（檢查器通過）' : '往前進了一步（第一個錯誤移到後面），繼續下一輪';
            const lineBefore = lineOf(cur, pick.c.off); edits.push({ round, op: pick.c.op, line: lineBefore, off: pick.c.off, removed: cur.slice(pick.c.off, pick.c.off + pick.c.len), text: pick.c.text, desc: pick.c.desc, error: e0.msg, verified: !!verified, semantic: { penalty: +(pick.sd ? pick.sd.delta : 0).toFixed(2), introduced: pick.sd ? pick.sd.introduced : [], resolved: pick.sd ? pick.sd.resolved : [] } });
            cur = pick.text; res = pick.r; if (pick.pass) return finish(true, 'fixed');
        }
        return finish(false, 'max_rounds');
    }

    return { FAMILY, kwOf, BUILTINS, symbolsOf, lex, brackets, parseErrors, unitOf, candidates, applyEdit, unifiedDiff, repairSyntax, formatTrace, grammarAnalysis, semanticIssues, semanticDelta, symbolsFromSignatures, symbolsFromModel };
});
