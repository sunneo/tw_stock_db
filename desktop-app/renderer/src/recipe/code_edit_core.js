/* 從「任意拿到的程式碼」接續修改（純函式，UMD；模型、檢查器、判題器都是注入的）。不需要知道這份碼是誰寫的、怎麼來的。
 *   splitUnits(lang, source) → [{name, kind, startOff, endOff, startLine, endLine, indent, text}]   把程式切成函式（方法）單元；範圍用 offset，拼回去時只換這一段
 *   spliceUnit(source, unit, newText) → string
 *   editCode({source, lang, problem?, check, judge?, ask?, write?, repair?, stackMod?, opts?, onEvent?}) → Promise<結果>
 *     1) 先修語法：check 說 CE → syntax_fix_core.repairSyntax（有測試時用測試在「都能過語法」的候選裡挑）。沒修好且有 write → 讓模型重寫出錯所在的單元（帶編譯訊息）
 *     2) 有測試（problem.tests）且有 judge：判題 → 沒過就用選擇題挑單元、帶回饋重寫那個單元、拼回去、再修語法、再判題（最多 maxRethink 次）
 *     只動必要的那一段，其餘位元組不變；結果有 diff 與結構化 edits。沒有測試就誠實標 verified:false。
 *   opts：maxRethink 3、maxCalls 20、unitMaxLines 80（單元超過就不當作可重寫的單位，只能靠語法修）
 *   結果：{ ok, verified, verdict, source, diff, edits[], units[], rethinks, calls:{ask,write,judge,check}, gaps[], reason?, trace[] } */
(function (root, factory) {
    const T = (typeof FaThinkStack !== 'undefined' && FaThinkStack) || (root && root.FaThinkStack) || (typeof require === 'function' ? require('./think_stack.js') : null);
    const S = (typeof FaSyntaxFix !== 'undefined' && FaSyntaxFix) || (root && root.FaSyntaxFix) || (typeof require === 'function' ? require('./syntax_fix_core.js') : null);
    const L = (typeof FaCodeLoop !== 'undefined' && FaCodeLoop) || (root && root.FaCodeLoop) || (typeof require === 'function' ? require('./code_loop_core.js') : null);
    if (typeof module === 'object' && module.exports) module.exports = factory(T, S, L); else root.FaCodeEdit = factory(T, S, L);
})(typeof self !== 'undefined' ? self : this, function (DefaultStack, Fix, Loop) {
    'use strict';
    const clip = (s, n) => { s = String(s == null ? '' : s).replace(/[ \t]+$/gm, '').trim(); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; };
    const lineOf = (src, off) => { let l = 1; for (let i = 0; i < off && i < src.length; i++) if (src[i] === '\n') l++; return l; };
    const lineStartOf = (src, off) => src.lastIndexOf('\n', off - 1) + 1;
    const mk = (src, name, kind, a, b, indent) => ({ name, kind, startOff: a, endOff: b, startLine: lineOf(src, a), endLine: lineOf(src, Math.max(a, b - 1)), indent: indent || '', text: src.slice(a, b) });

    // ---------- 單元切分 ----------
    function splitUnits(lang, src) {
        src = String(src == null ? '' : src); const units = [];
        const fam = Fix.FAMILY[lang]; if (!fam) return units;
        if (lang === 'python') return pyUnits(src);
        if (lang === 'ruby') return rubyUnits(src);
        if (lang === 'bash') return braceUnits(src, lang, /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*(?:\(\s*\))?\s*\{/m);
        if (lang === 'perl') return braceUnits(src, lang, /^\s*sub\s+([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*\{/m);
        return clikeUnits(lang, src, units);
    }
    function pyUnits(src) {
        const lines = src.split('\n'); const offs = []; let o = 0; for (const l of lines) { offs.push(o); o += l.length + 1; }
        const units = []; const ind = (l) => /^[ \t]*/.exec(l)[0].length;
        for (let i = 0; i < lines.length; i++) {
            const m = /^([ \t]*)(?:async[ \t]+)?def[ \t]+(\w+)/.exec(lines[i]); if (!m) continue;
            let start = i; while (start > 0 && /^[ \t]*@/.test(lines[start - 1])) start--; // 裝飾器算在單元裡
            const base = ind(lines[i]); let j = i + 1, last = i;
            // 標頭可能跨行（括號沒收）：先找到以 ':' 結尾的那一行
            let hdr = i; while (hdr < lines.length && hdr < i + 8 && !/:\s*(#.*)?$/.test(lines[hdr])) hdr++; if (hdr >= lines.length || !/:\s*(#.*)?$/.test(lines[hdr])) hdr = i; /* 標頭缺冒號（任意拿到的壞程式很常見）：就當標頭只有這一行 */ last = hdr; j = hdr + 1;
            for (; j < lines.length; j++) { if (!lines[j].trim()) continue; if (ind(lines[j]) <= base) break; last = j; }
            units.push(mk(src, m[2], 'function', offs[start], Math.min(src.length, offs[last] + lines[last].length), m[1]));
        }
        return units.filter((u) => !units.some((v) => v !== u && v.startOff <= u.startOff && v.endOff >= u.endOff && v.indent.length < u.indent.length && false));
    }
    function rubyUnits(src) {
        const lines = src.split('\n'); const offs = []; let o = 0; for (const l of lines) { offs.push(o); o += l.length + 1; }
        const units = []; const open = /^\s*(def|class|module|if|unless|while|until|case|begin|for)\b/; const doEnd = /\bdo(\s*\|[^|]*\|)?\s*$/;
        for (let i = 0; i < lines.length; i++) {
            const m = /^([ \t]*)def[ \t]+(?:self\.)?([\w?!=]+)/.exec(lines[i]); if (!m) continue; let depth = 0, end = -1;
            for (let j = i; j < lines.length; j++) { const l = lines[j].replace(/#.*$/, ''); if (open.test(l) || doEnd.test(l)) depth++; if (/^\s*end\b/.test(l)) depth--; if (depth === 0) { end = j; break; } }
            if (end >= 0) units.push(mk(src, m[2], 'function', offs[i], offs[end] + lines[end].length, m[1]));
        }
        return units;
    }
    function braceUnits(src, lang, headRe) {
        const toks = Fix.lex(lang, src); const units = []; const re = new RegExp(headRe.source, 'gm'); let m;
        while ((m = re.exec(src))) {
            const bracePos = src.indexOf('{', m.index + m[0].length - 1); if (bracePos < 0) continue; const ti = toks.findIndex((t) => t.off === bracePos && t.v === '{'); if (ti < 0) continue;
            let d = 0, end = -1; for (let k = ti; k < toks.length; k++) { if (toks[k].t === 'op' && toks[k].v === '{') d++; else if (toks[k].t === 'op' && toks[k].v === '}') { d--; if (d === 0) { end = toks[k].end; break; } } }
            if (end < 0) continue; const ls = lineStartOf(src, m.index + (/^\s*/.exec(m[0])[0].length)); units.push(mk(src, m[1], 'function', ls, end, /^[ \t]*/.exec(src.slice(ls))[0]));
        }
        return units;
    }
    // c／c++／java／c#／nodejs：以 { 前面是 ) 當函式（方法）的標誌；c、c++、nodejs 只看最外層，java／c# 看類別裡面（深度 ≤ 2）
    function clikeUnits(lang, src, units) {
        const toks = Fix.lex(lang, src); const maxDepth = (lang === 'java' || lang === 'csharp') ? 1 : 0; let depth = 0;
        const KW = new Set(['if', 'for', 'while', 'switch', 'catch', 'else', 'do', 'try', 'return', 'sizeof', 'new', 'synchronized', 'foreach', 'using', 'lock']);
        for (let i = 0; i < toks.length; i++) {
            const t = toks[i]; if (t.t !== 'op') continue;
            if (t.v === '{') {
                // 往前跳過 const／throws／noexcept／=>／:（建構子初始化）等，找到 )
                let p = i - 1; while (p >= 0 && toks[p].t === 'id' && /^(const|noexcept|override|final|throws|where)$/.test(toks[p].v) || (p >= 0 && toks[p].t === 'id' && p - 1 >= 0 && toks[p - 1].v === 'throws')) p--;
                if (depth <= maxDepth && p >= 0 && toks[p].t === 'op' && toks[p].v === ')') {
                    let d = 0, q = p; for (; q >= 0; q--) { if (toks[q].v === ')') d++; else if (toks[q].v === '(') { d--; if (d === 0) break; } }
                    const nameTok = q > 0 ? toks[q - 1] : null; let end = -1, dd = 0; for (let k = i; k < toks.length; k++) { if (toks[k].v === '{' && toks[k].t === 'op') dd++; else if (toks[k].v === '}' && toks[k].t === 'op') { dd--; if (dd === 0) { end = toks[k].end; break; } } }
                    if (nameTok && nameTok.t === 'id' && !KW.has(nameTok.v) && end > 0) {
                        // 單元從「這個宣告的第一個 token」開始：往前找上一個 ; { } 或前處理行
                        let s = q - 1; while (s > 0 && !(toks[s - 1].t === 'pp') && !(toks[s - 1].t === 'op' && /^[;{}]$/.test(toks[s - 1].v))) s--; const startTok = toks[Math.max(0, s)]; const a = lineStartOf(src, startTok.off); units.push(mk(src, nameTok.v, 'function', a, end, /^[ \t]*/.exec(src.slice(a))[0]));
                    }
                }
                depth++;
            } else if (t.v === '}') depth = Math.max(0, depth - 1);
        }
        // 去掉被別的單元完整包含的（巢狀函式／lambda）
        return units.filter((u) => !units.some((v) => v !== u && v.startOff <= u.startOff && v.endOff >= u.endOff && (v.endOff - v.startOff) > (u.endOff - u.startOff)));
    }
    const spliceUnit = (src, u, text) => src.slice(0, u.startOff) + text + src.slice(u.endOff);
    // 模型寫的單元要放回原本的縮排（python／ruby 縮排有意義；其他語言只是好看）
    function reindent(text, indent) {
        const lines = String(text).replace(/\s+$/, '').split('\n'); let min = Infinity; for (const l of lines) if (l.trim()) min = Math.min(min, /^[ \t]*/.exec(l)[0].length); if (!isFinite(min)) min = 0;
        return lines.map((l) => (l.trim() ? indent + l.slice(min) : l)).join('\n');
    }

    // ---------- 接續修改 ----------
    class Budget extends Error { }
    async function editCode(a) {
        const lang = a.lang; const o = Object.assign({ maxRethink: 3, maxCalls: 20, unitMaxLines: 80 }, a.opts || {}); const Stack = a.stackMod || DefaultStack; const orig = String(a.source == null ? '' : a.source);
        const calls = { ask: 0, write: 0, judge: 0, check: 0 }, trace = [], gaps = [], edits = []; let cur = orig, sum = null, rethinks = 0, patchInfo = null;
        const note = (e) => { trace.push(e); if (typeof a.onEvent === 'function') { try { a.onEvent(e); } catch (_) { /* 進度回報壞了不影響流程 */ } } };
        const out = (extra) => { const ok = !!(sum && (sum.verdict === 'AC' || sum.verdict === 'CHECKED')); return Object.assign({ ok, verified: !!(sum && sum.verdict === 'AC'), verdict: sum ? sum.verdict : 'NONE', source: cur, diff: Fix.unifiedDiff(orig, cur, 'code'), edits, units: splitUnits(lang, cur).map((u) => ({ name: u.name, startLine: u.startLine, endLine: u.endLine })), rethinks, calls, gaps, trace, patch: patchInfo || undefined }, extra || {}); };
        if (!Fix.FAMILY[lang]) return out({ ok: false, reason: 'unsupported_lang', gaps: ['不支援的語言：' + lang + '（支援：' + Object.keys(Fix.FAMILY).join('、') + '）'] });
        if (typeof a.check !== 'function' && typeof a.judge !== 'function') return out({ ok: false, reason: 'no_checker', gaps: ['沒有檢查器也沒有判題器，無法驗證任何東西'] });
        const spend = (k) => { if (calls.ask + calls.write >= o.maxCalls) throw new Budget('呼叫次數用完（' + o.maxCalls + '）'); calls[k]++; };
        const ask = a.ask ? async (m, v, opts2) => { spend('ask'); const r = await a.ask(m, v, opts2); note({ t: 'ask', ok: !!r }); return r; } : null;
        const check = async (x) => { calls.check++; return a.check ? a.check(x) : a.judge(Object.assign({ problem: Object.assign({}, a.problem, { tests: [], hidden: [] }) }, x)); };
        const hasTests = !!(a.problem && a.problem.tests && a.problem.tests.length && a.judge);
        const judgeNow = async () => { if (!hasTests) { sum = await check({ lang, source: cur }); note({ t: 'check', verdict: sum.verdict }); return sum; } calls.judge++; sum = await a.judge({ lang, source: cur, problem: a.problem }); note({ t: 'judge', verdict: sum.verdict, detail: clip(sum.detail, 120) }); return sum; };
        const verifyFn = hasTests ? async ({ source }) => (await a.judge({ lang, source, problem: a.problem })).verdict === 'AC' : null;
        const stack = Stack ? Stack.create(clip(a.goal || (a.problem && a.problem.statement) || '修好這份程式', 200), { maxDecisions: 10, maxHeaderChars: 800 }) : null;
        // 語法：先程式修；不行再讓模型重寫出錯的那個單元
        const fixSyntax = async (why) => {
            const r0 = await check({ lang, source: cur }); if (r0.verdict !== 'CE') return r0;
            note({ t: 'syntax', why });
            const rep = a.repair ? await a.repair({ lang, source: cur, ask, verify: verifyFn, wrap: stack ? (m) => Stack.wrap(m, stack) : undefined }) : await Fix.repairSyntax({ lang, source: cur, check: (x) => check(x), ask, verify: verifyFn, wrap: stack ? (m) => Stack.wrap(m, stack) : undefined });
            if (rep && rep.ok) { cur = rep.source; for (const e of rep.edits || []) edits.push(Object.assign({ by: 'syntax' }, e)); note({ t: 'syntax_fixed', edits: (rep.edits || []).length, tried: rep.tried }); return check({ lang, source: cur }); }
            gaps.push('語法自動修正沒成功（' + (rep && rep.reason) + '）');
            return r0;
        };
        try {
            if (stack) Stack.push(stack, { path: 'edit', question: '修好這份 ' + lang + ' 程式（語法→行為）', note: '從現有程式碼接續' });
            if (a.patch) await patchCandidate();
            let r = await fixSyntax('開頭'); let guard = 0;
            // 語法仍然壞、而且有 write：讓模型重寫出錯所在的單元（帶編譯訊息）
            while (r.verdict === 'CE' && a.write && guard++ < 2) {
                const errs = Fix.parseErrors(lang, (r.compileLog || '') + '\n' + (r.detail || ''), cur); const units = splitUnits(lang, cur); const line = errs.length ? errs[0].line : 0;
                const u = units.find((x) => x.startLine <= line && line <= x.endLine); if (!u) { gaps.push('語法錯誤的位置不在任何函式裡，模型重寫無從下手'); break; }
                if (!(await rewriteUnit(u, '編譯失敗：' + clip(r.compileLog || r.detail, 400)))) break;
                r = await fixSyntax('重寫之後');
            }
            if (r.verdict === 'CE') { sum = r; gaps.push('仍然有語法錯誤：' + clip(r.detail, 160)); if (stack) Stack.pop(stack, { ok: false, summary: '語法沒修好' }); return out({ ok: false }); }
            await judgeNow();
            if (!hasTests) gaps.push(sum.verdict === 'CHECKED' ? '沒有測試，只確認能編譯／語法正確，沒有驗證行為（verified:false）' : '沒有測試，無法驗證行為');
            while (hasTests && sum.verdict !== 'AC' && sum.verdict !== 'UNAVAILABLE' && rethinks < o.maxRethink && a.write) {
                rethinks++; note({ t: 'rethink', n: rethinks, verdict: sum.verdict });
                const units = splitUnits(lang, cur).filter((u) => u.text.split('\n').length <= o.unitMaxLines); if (!units.length) { gaps.push('找不到可以重寫的函式單元（太長或不是函式），只能靠語法修正'); break; }
                const fb = Loop.feedback(sum, a.problem); let u = units[units.length - 1];
                if (units.length > 1 && ask) {
                    const letters = units.map((_, i) => String.fromCharCode(65 + i));
                    const msgs = [{ role: 'system', content: '你在除錯。只輸出 JSON：{"fix":"字母"}，選一個最可能有錯的函式。' }, { role: 'user', content: fb + '\n\n選項：\n' + units.map((x, i) => letters[i] + '. ' + x.name + '（第 ' + x.startLine + '–' + x.endLine + ' 行）').join('\n') }];
                    const v = await ask(stack ? Stack.wrap(msgs, stack) : msgs, (x) => (x && letters.indexOf(String(x.fix || '').toUpperCase()) >= 0 ? [] : ['「fix」必須是 ' + letters.join('、') + ' 其中一個'])); if (v) u = units[letters.indexOf(String(v.fix).toUpperCase())];
                }
                if (!(await rewriteUnit(u, fb, true))) break;
                await fixSyntax('重寫之後'); await judgeNow();
            }
            if (sum.verdict === 'UNAVAILABLE') gaps.push('這台機器沒有 ' + lang + ' 的工具鏈，無法驗證');
            else if (hasTests && sum.verdict !== 'AC') gaps.push('重寫 ' + rethinks + ' 次後仍是 ' + sum.verdict + '：' + clip(Loop.feedback(sum, a.problem).split('\n')[0], 160));
            if (stack) Stack.pop(stack, { ok: true, summary: sum.verdict });
            return out();
        } catch (e) { if (e instanceof Budget) { gaps.push(e.message); return out({ ok: false, reason: 'budget' }); } throw e; }

        // 修補（unified diff）也是一種候選編輯：交給 merge diff patcher 合併進「目前」的程式，合併後一定過語法檢查與判題；沒過就回滾，改走原本的流程。
        // 成功時 edits 用和語法修正、單元重寫相同的格式（by／startLine／endLine／desc／removed），diff 欄位共用。
        async function patchCandidate() {
            const Pm = (typeof FaCodePatch !== 'undefined' && FaCodePatch) || (typeof globalThis !== 'undefined' && globalThis.FaCodePatch) || (typeof require === 'function' ? (function () { try { return require('./code_patch_core.js'); } catch (_) { return null; } })() : null);
            if (!Pm) { gaps.push('修補：這個環境沒有 merge diff patcher，略過'); return; }
            const r = await Pm.applyPatch({ source: cur, diff: a.patch, lang, fileName: a.patchFile, parser: a.parser, ask: ask || undefined,
                check: async (x) => { const s2 = await check({ lang, source: x }); return { ok: s2.verdict !== 'CE', verdict: s2.verdict, detail: s2.detail, compileLog: s2.compileLog }; },
                judge: hasTests ? async (x) => { calls.judge++; return a.judge({ lang, source: x, problem: a.problem }); } : undefined, opts: Object.assign({}, o.patchOpts) });
            const report = Pm.report(r); patchInfo = { ok: !!r.ok, status: r.status, rolledBack: !!r.rolledBack, reason: r.reason, report, hunks: (r.hunks || []).map((h) => ({ index: h.index, status: h.status, line: h.line, offset: h.offset })), verified: r.verified };
            if (!r.ok) { gaps.push('修補沒有合併（' + r.status + '）：' + clip(r.reason, 160)); note({ t: 'patch', ok: false, status: r.status }); return; }
            if (r.noop) { gaps.push('修補早就套用過，沒有需要改的'); note({ t: 'patch', ok: true, noop: true }); return; }
            const pd = Pm.parseDiff(a.patch); const file = pd.ok && (pd.files.find((f) => a.patchFile && (f.newName === a.patchFile || f.oldName === a.patchFile)) || pd.files[0]);
            for (const h of r.hunks) { const src = file && file.hunks[h.index - 1]; const oldT = src ? src.ops.filter((x) => x.t === '-').map((x) => x.s).join('\n') : ''; const newN = src ? src.ops.filter((x) => x.t !== '-').length : 1; edits.push({ by: 'patch', startLine: h.line || 0, endLine: (h.line || 0) + Math.max(0, newN - 1), desc: '修補第 ' + h.index + ' 段（' + h.status + (h.offset ? '，位移 ' + h.offset : '') + '）', removed: clip(oldT, 200) }); }
            cur = r.source; note({ t: 'patch', ok: true, hunks: r.hunks.length });
        }

        async function rewriteUnit(u, feedback, isSemantic) {
            if (!a.write) return false; spend('write');
            if (stack) Stack.push(stack, { path: 'unit:' + u.name, question: '重寫函式 ' + u.name + '（第 ' + u.startLine + '–' + u.endLine + ' 行）' });
            const rules = (Loop.LANGS[lang] && Loop.LANGS[lang].rules) || '';
            const msgs = [{ role: 'system', content: '你是 ' + ((Loop.LANGS[lang] && Loop.LANGS[lang].name) || lang) + ' 程式設計師，正在修一份既有的程式。只輸出一個程式碼區塊，裡面只有函式「' + u.name + '」修正後的完整定義，不要其他函式、不要說明；保持它的名稱、參數與縮排風格。' + rules }, { role: 'user', content: (a.problem && a.problem.statement ? '題目：' + clip(a.problem.statement, 600) + '\n\n' : '') + (a.goal ? '目標：' + clip(a.goal, 300) + '\n\n' : '') + '現在要修：' + u.name + '\n目前的程式碼：\n' + clip(u.text, 1400) + '\n\n' + feedback + '\n請修正後重新寫出完整函式。' }];
            const raw = await a.write(stack ? Stack.wrap(msgs, stack, { repeat: !!isSemantic }) : msgs, { thinking: false, kind: 'rewrite', fn: u.name });
            note({ t: 'write', fn: u.name, thinking: !!isSemantic, kind: 'rewrite' });
            const code = Loop.extractCode(raw); const okName = new RegExp('(^|[^A-Za-z0-9_])' + u.name + '([^A-Za-z0-9_]|$)').test(code);
            if (stack) Stack.pop(stack, { ok: okName, summary: okName ? '已重寫' : '沒有定義 ' + u.name });
            if (!okName || code.trim().length < 5) { gaps.push('函式 ' + u.name + '：模型沒有交出可用的程式碼'); return false; }
            const text = (lang === 'python' || lang === 'ruby') ? reindent(code, u.indent) : (u.indent && !/^[ \t]/.test(code) ? reindent(code, u.indent) : code.replace(/\s+$/, ''));
            const before = cur; cur = spliceUnit(cur, u, text); edits.push({ by: 'rewrite', fn: u.name, startLine: u.startLine, endLine: u.endLine, desc: '重寫函式 ' + u.name, removed: clip(before.slice(u.startOff, u.endOff), 200) });
            return true;
        }
    }

    return { splitUnits, spliceUnit, reindent, editCode };
});
