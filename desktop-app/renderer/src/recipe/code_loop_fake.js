/* 可腳本化的假模型（測試與基準共用；不是真模型，只證明迴圈的流程與組裝正確，不能當作「小模型能不能寫對」的證據）。
 *   makeScriptedModel({plan, codes, fix}) → {ask, write, log}
 *     plan：切割要回的 {functions:[…]}，或 null（模擬問不出來）
 *     codes：{函式名: [第 1 次寫的程式, 第 2 次…]}（寫第 n 次回第 n 個，超過就一直回最後一個）
 *     subplans：{函式名: {functions:[…]}}，函式被標 complex 時，再切那個函式要回的清單
 *     names：除錯選擇題的選項名稱（專案模式用，不給就用 plan 的函式名）
 *     fix：除錯選擇題要選的函式名／類別名（預設最後一個）
 *   log：每次呼叫的 {kind, messages, meta}，測試用它檢查「提示裡有什麼、沒有什麼」。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaCodeLoopFake = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function makeScriptedModel(script) {
        script = script || {}; const log = [], counts = {};
        const sys = (m) => (m.find((x) => x.role === 'system') || {}).content || '';
        const fnOf = (m) => { const u = m.filter((x) => x.role === 'user').pop(); const r = /現在寫：(\w+)/.exec(u ? u.content : ''); return r ? r[1] : ''; };
        async function ask(messages, validate) {
            const s = sys(messages); let v = null, kind = 'other';
            if (s.indexOf('切成幾個小函式') >= 0) { const u = messages.filter((x) => x.role === 'user').pop().content; const sub = /現在要切的函式：(\w+)/.exec(u); if (sub) { kind = 'subsplit'; v = (script.subplans && script.subplans[sub[1]]) || null; } else { kind = 'split'; v = script.plan || null; } }
            else if (s.indexOf('你在除錯') >= 0) {
                kind = 'fix'; const names = script.names || (script.plan && script.plan.functions || []).map((f) => f.name); const want = script.fix || names[names.length - 1];
                const u = messages.filter((x) => x.role === 'user').pop().content; const opts = {}; u.split('\n').forEach((l) => { const m = /^([A-Z])\. (\w+)/.exec(l); if (m) opts[m[2]] = m[1]; });
                v = { fix: opts[want] || 'A' };
            }
            else if (s.indexOf('規劃深入解題') >= 0) { kind = 'planChecks'; v = { checks: [] }; }
            else if (s.indexOf('核對剛做完') >= 0) { kind = 'review'; v = { results: [] }; }
            else if (s.indexOf('自我檢查') >= 0) { kind = 'selfValidate'; v = { ok: true, missing: '' }; }
            log.push({ kind, messages, meta: null });
            if (v && validate) { const errs = validate(v); if (errs && errs.length) return null; }
            return v;
        }
        async function write(messages, meta) {
            const fn = (meta && meta.fn) || fnOf(messages); counts[fn] = (counts[fn] || 0) + 1;
            const versions = (script.codes && script.codes[fn]) || ['']; const code = versions[Math.min(counts[fn], versions.length) - 1];
            log.push({ kind: 'write', messages, meta: Object.assign({}, meta, { fn, n: counts[fn] }) });
            return '```\n' + code + '\n```';
        }
        return { ask, write, log };
    }
        // ---- 神諭選擇器：知道目標函式的 token 序列，但只能從文法給出的合法選項裡挑出對應的那個（測試文法引導寫作的機械那一半；不是模型能力的證據）----
    const F = (typeof FaSyntaxFix !== 'undefined' && FaSyntaxFix) || (typeof require === 'function' ? require('./syntax_fix_core.js') : null); const G = (typeof FaGrammar !== 'undefined' && FaGrammar) || (typeof require === 'function' ? require('./grammar_core.js') : null);
    // 目標 token 序列（本體；標頭由簽名給）。python 以行為單位：[{level, tokens}]
    function targetBrace(lang, src) { const toks = F.lex(lang, src).map((x) => ({ t: x.t, v: x.v })); const open = toks.findIndex((x) => x.v === '{'); return toks.slice(open + 1); }
    function targetPython(src) { const toks = F.lex('python', src); const lines = []; let cur = null; toks.forEach((x) => { if (x.t === 'nl') { cur = null; return; } if (!cur) { const first = x; cur = { level: 0, tokens: [], col: first.col }; lines.push(cur); } cur.tokens.push({ t: x.t, v: x.v }); }); const base = lines[0].col; const cols = Array.from(new Set(lines.map((l) => l.col))).sort((a, b) => a - b); lines.forEach((l) => { l.level = cols.indexOf(l.col); }); return lines.slice(1).map((l) => ({ level: l.level, tokens: l.tokens })); }
    // 神諭：看選項的種類與文字，挑出對應「下一個目標 token」的那個；兩層選擇題（類別→項目）、換行選縮排、新名稱／數字／字串都處理
    function makeOracle(lang, src) {
      const py = lang === 'python'; const tgt = py ? targetPython(src) : targetBrace(lang, src); let li = 0, ti = 0; const flat = py ? null : tgt; const stats = { choose: 0, free: 0, misses: [] };
      const cur = () => (py ? (tgt[li] ? tgt[li].tokens[ti] : null) : flat[ti]);
      const kindOf = (tk) => (tk.t === 'num' ? 'num' : tk.t === 'str' ? 'str' : tk.t === 'id' ? 'idlike' : 'op');
      const want = () => { // 目前這一步想要的：{type:'tok', tok} | {type:'pseudo', kind, to}
        if (!py) return { type: 'tok', tok: cur() };
        if (ti >= tgt[li].tokens.length) { const nx = tgt[li + 1]; if (!nx) return { type: 'pseudo', kind: 'end' }; const lv = tgt[li].level; if (nx.level > lv) return { type: 'pseudo', kind: 'nl-in' }; if (nx.level === lv) return { type: 'pseudo', kind: 'nl-same' }; return { type: 'pseudo', kind: 'nl-to', to: nx.level }; }
        return { type: 'tok', tok: cur() };
      };
      const advance = (w) => { if (w.type === 'pseudo') { if (w.kind !== 'end') { li++; ti = 0; } } else { ti++; } };
      const choose = async (messages, options) => {
        stats.choose++; const w = want();
        const isGroup = options.every((o) => o.kind === 'group' || o.kind === 'more');
        let idx = -1;
        if (isGroup) { const label = w.type === 'pseudo' ? '換行' : (() => { const tk = w.tok; if (!tk) return null; if (tk.t === 'num' || tk.t === 'str') return '字面值'; if (tk.t === 'id') return options.some((o) => /^關鍵字/.test(o.text)) && isKeyword(lang, tk.v) ? '關鍵字' : '名稱'; return '符號'; })(); idx = options.findIndex((o) => o.text.startsWith(label)); }
        else if (w.type === 'pseudo') idx = options.findIndex((o) => o.kind === w.kind && (w.kind !== 'nl-to' || /第 (\d+) 層/.exec(o.text) && +/第 (\d+) 層/.exec(o.text)[1] === w.to));
        else { const tk = w.tok; if (tk.t === 'num') idx = options.findIndex((o) => o.kind === 'num'); else if (tk.t === 'str') idx = options.findIndex((o) => o.kind === 'str'); else { idx = options.findIndex((o) => (o.kind === 'kw' || o.kind === 'punct') && o.text === '`' + tk.v + '`'); if (idx < 0) idx = options.findIndex((o) => o.kind === 'name' && (o.text === tk.v || o.text.startsWith(tk.v + '（'))); if (idx < 0 && tk.t === 'id') idx = options.findIndex((o) => o.kind === 'new'); } }
        if (idx < 0) { const more = options.findIndex((o) => o.kind === 'more'); if (more >= 0) return more; stats.misses.push({ want: w.type === 'pseudo' ? w.kind : w.tok && w.tok.v, options: options.map((o) => o.text).slice(0, 12) }); return null; }
        if (!isGroup && options[idx].kind !== 'more' && !['new', 'num', 'str'].includes(options[idx].kind)) advance(w); return idx; // 新名稱／數字／字串由 free 前進
      };
      const free = async (messages, kind) => { stats.free++; const w = want(); const tk = w.tok; if (!tk) return null; advance(w); return kind === 'str' ? tk.v.slice(1, -1) : tk.v; };
      // 機械自動補的 token（只有一個合法選項）不經過模型，神諭也要跟著前進
      const onEvent = (e) => { if (e.t !== 'auto') return; const w = want(); if (w.type === 'tok' && w.tok && e.token === w.tok.v) advance(w); else if (w.type === 'pseudo' && /^[⏎⇤■]/.test(String(e.token))) advance(w); };
      return { choose, free, onEvent, stats, done: () => (py ? li >= tgt.length - 0 : ti >= flat.length) };
    }
    const isKeyword = (lang, v) => { const g = G.grammarOf(lang); return g.keywords.has(v); };
    // ---- 假的語言模型游標（測 rank 策略的機制：候選怎麼來、間距、換行與縮排、提交進 KV 的簿記）----
    // 它知道「目標助手回答」的全文；對候選字串打分＝候選和目標剩餘文字的最長共同前綴長度（完全吻合的最高）。不是模型能力的證據。
    function makeFakeLm(expectedAssistant) {
        const stats = { opens: 0, ranks: 0, commits: 0 };
        return { stats, open: async (msgs, prefix) => { stats.opens++; if (!expectedAssistant.startsWith(prefix)) throw new Error('助手前綴與目標不符：' + JSON.stringify(prefix.slice(-40))); let consumed = prefix;
            return {
                async rank(texts, o2) { stats.ranks++; const rem = expectedAssistant.slice(consumed.length + ((o2 && o2.base) || '').length); return texts.map((x) => { let k = 0; while (k < x.length && k < rem.length && x[k] === rem[k]) k++; return { text: x, logprob: k === x.length ? 100 + k : k - 50, first: 0 }; }); },
                async commit(s) { stats.commits++; if (expectedAssistant.slice(consumed.length, consumed.length + s.length) !== s) throw new Error('提交的文字與目標不符：' + JSON.stringify(s)); consumed += s; },
                async greedy(n, o2) { return expectedAssistant.slice(consumed.length + ((o2 && o2.base) || '').length).slice(0, (n || 8) * 3); }
            }; } };
    }
    return { makeScriptedModel, makeOracle, makeFakeLm };
});
