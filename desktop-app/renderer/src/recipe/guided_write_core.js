/* 文法引導的逐 token 寫程式（純函式，UMD；模型是注入的）。使用者的想法：
 *   「合法的語法節點可以用機械化演算法工具做到、過濾出合法的 token；qwen0.6b 開 thinking 做選擇題可以很精準」
 * 所以分工是：機械演算法（Earley 文法）算出「當下位置合法的下一個 token」並過濾；模型只在過濾後的選項裡做選擇題（開思考）；
 * 只有一個合法選項就自動補（不問模型）；名詞（變數、函式名）從作用域與設計樹選，真的要新名稱／數字／字串字面值才讓模型寫一小段。
 *   guidedWriteFunction({lang, spec, node, plan?, symbols?, choose, free?, stack?, stackMod?, opts?, onEvent?}) → Promise<{ok, code, tokens, steps, calls, trace, reason?}>
 *     node：{name, signature, purpose}（簽名是標頭，程式直接放進去，語法合法性由文法驗證）
 *     choose(messages, options) → Promise<index|null>   選擇題：options 是 [{label, kind, text}]；回 null＝模型沒答出來
 *     free(messages, kind)      → Promise<string|null>  新名稱（kind:'name'）、數字（'num'）、字串內容（'str'）：一小段文字
 *     lm：{open(messages, assistantPrefix)→游標}（選用）：給了就走 rank 策略（約束解碼）——對每個合法選項用模型的下一個 token 機率打分、取最高，不需要回字母；opts.strategy:'choose' 可強制用選擇題。rules／langLabel：給 rank 的提示用
 *     feedback：上一版的失敗訊息（重寫時給；放進每一題的題目裡）
 *     opts：maxSteps、maxChoices——都是**每個函式**的上限，開發期間預設 Infinity（做完再 profile 後訂）；pageSize 8、flatMax 14（合法選項總數不超過它就給一層扁平選單，否則先分類別）、allowInlineAsm（只有 c／cpp；預設不給 asm 選項）
 *   支援語言：python（以邏輯行為單位，縮排由「同層／退一層／函式結束」的選擇題決定）、c、cpp、java、csharp、nodejs（各自獨立的文法與各自的先驗／過濾表；大括號區塊只是排版方式）。
 *   不支援的語言回 {ok:false, reason:'unsupported_lang'}。
 * 誠實的範圍：文法是語句級子集；選項太多時分類別兩層（語句關鍵字／名稱／字面值／符號）；標準函式庫的 #include／import 由程式依用到的名稱補（importsFor），不是模型選的。 */
(function (root, factory) {
    const G = (typeof FaGrammar !== 'undefined' && FaGrammar) || (root && root.FaGrammar) || (typeof require === 'function' ? require('./grammar_core.js') : null);
    const S = (typeof FaSyntaxFix !== 'undefined' && FaSyntaxFix) || (root && root.FaSyntaxFix) || (typeof require === 'function' ? require('./syntax_fix_core.js') : null);
    const T = (typeof FaThinkStack !== 'undefined' && FaThinkStack) || (root && root.FaThinkStack) || (typeof require === 'function' ? require('./think_stack.js') : null);
    if (typeof module === 'object' && module.exports) module.exports = factory(G, S, T); else root.FaGuidedWrite = factory(G, S, T);
})(typeof self !== 'undefined' ? self : this, function (G, S, DefaultStack) {
    'use strict';
    const clip = (s, n) => { s = String(s == null ? '' : s).replace(/[ \t]+$/gm, '').trim(); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; };
    const WORD = /^[A-Za-z_$][\w$]*$/;
    // 以下每一張表都是「每種語言各自一份」（使用者規定：不同語言不能共用；python 與 c++ 更不能共用）。
    // 函式本體裡不會出現的宣告類關鍵字（機械過濾：寫函式本體時這些不是合理選項，不用浪費模型的注意力）。asm 類只有 C／C++ 有，而且預設也丟掉，任務明說要內聯組語時才開（opts.allowInlineAsm）
    const DROP = {
        python: new Set(['global', 'nonlocal', 'del', 'match', 'case', 'async', 'await', 'yield', 'class', 'def', 'import', 'from', 'with', 'assert', 'as']), // 只丟宣告類；else／elif／try／except／in／is 是流程與運算要用的
        c: new Set(['typedef', 'extern', 'register', 'inline', 'volatile', 'union', 'enum', 'asm', '__asm__', '__asm', '__volatile__', 'goto']),
        cpp: new Set(['typedef', 'using', 'namespace', 'extern', 'register', 'volatile', 'inline', 'union', 'explicit', 'virtual', 'constexpr', 'override', 'final', 'asm', '__asm__', '__asm', '__volatile__', 'goto']),
        java: new Set(['import', 'package', 'class', 'interface', 'enum', 'abstract', 'synchronized', 'instanceof', 'extends', 'implements', 'throws']),
        csharp: new Set(['using', 'namespace', 'class', 'struct', 'interface', 'enum', 'abstract', 'virtual', 'override', 'sealed', 'partial', 'async', 'await', 'unsafe', 'internal', 'readonly', 'is', 'as']),
        nodejs: new Set(['import', 'class', 'function', 'typeof', 'await', 'async', 'void', 'delete', 'extends', 'from', 'as'])
    };
    // 先後順序（先驗）：寫函式本體時最常用的先列；不在表裡的排後面。每種語言各自一份
    const PRIOR = {
        python: ['ID', 'if', 'for', 'while', 'return', 'print', 'NUM', 'STR', '(', ')', '[', ']', ',', ':', '=', '==', '!=', '<', '>', '<=', '>=', '+', '-', '*', '/', '//', '%', '.', 'and', 'or', 'not', 'in', 'else', 'elif', 'break', 'continue', 'pass', 'True', 'False', 'None'],
        c: ['ID', 'int', 'long', 'double', 'char', 'float', 'unsigned', 'if', 'for', 'while', 'return', '}', '(', 'else', 'break', 'continue', 'NUM', 'STR', '*', '&', '+', '-', '/', '%', '=', '==', '!=', '<', '>', '<=', '>=', '&&', '||', ')', ',', ';', ']', '[', '.', '->', '++', '--', '+=', '-=', '{', 'sizeof', 'struct'],
        cpp: ['ID', 'int', 'long', 'double', 'char', 'auto', 'bool', 'if', 'for', 'while', 'return', '}', '(', 'else', 'break', 'continue', 'NUM', 'STR', '+', '-', '*', '/', '%', '=', '==', '!=', '<', '>', '<=', '>=', '&&', '||', '<<', '>>', ')', ',', ';', ']', '[', '.', '::', '++', '--', '+=', '-=', '{', 'new', 'true', 'false'],
        java: ['ID', 'int', 'long', 'double', 'char', 'boolean', 'if', 'for', 'while', 'return', '}', '(', 'else', 'break', 'continue', 'new', 'NUM', 'STR', '+', '-', '*', '/', '%', '=', '==', '!=', '<', '>', '<=', '>=', '&&', '||', ')', ',', ';', ']', '[', '.', '++', '--', '+=', '-=', '{', 'true', 'false', 'null'],
        csharp: ['ID', 'var', 'int', 'long', 'double', 'char', 'bool', 'if', 'for', 'foreach', 'while', 'return', '}', '(', 'else', 'break', 'continue', 'new', 'NUM', 'STR', '+', '-', '*', '/', '%', '=', '==', '!=', '<', '>', '<=', '>=', '&&', '||', ')', ',', ';', ']', '[', '.', '++', '--', '+=', '-=', '{', 'true', 'false', 'null', 'in'],
        nodejs: ['ID', 'let', 'const', 'var', 'if', 'for', 'while', 'return', '}', '(', 'else', 'break', 'continue', 'NUM', 'STR', 'new', '+', '-', '*', '/', '%', '=', '===', '!==', '==', '!=', '<', '>', '<=', '>=', '&&', '||', ')', ',', ';', ']', '[', '.', '++', '--', '+=', '-=', '{', 'true', 'false', 'null', 'of', 'in', '=>']
    };
    // 常見成員名（接在 . 後面時，型別不明所以給一份常用的；真正的名稱讓模型寫）。每種語言各自一份；C 沒有成員函式所以是空的
    const MEMBERS = {
        python: ['append', 'split', 'strip', 'join', 'items', 'keys', 'values', 'get', 'sort', 'pop', 'add', 'lower', 'upper', 'extend', 'count', 'index', 'reverse', 'startswith', 'endswith', 'replace', 'format', 'popleft', 'appendleft', 'readline', 'read', 'write'],
        c: [],
        cpp: ['size', 'push_back', 'pop_back', 'begin', 'end', 'empty', 'front', 'back', 'insert', 'erase', 'find', 'first', 'second', 'length', 'substr', 'clear', 'count', 'at', 'push', 'pop', 'top'],
        java: ['length', 'size', 'add', 'get', 'put', 'charAt', 'nextInt', 'nextLong', 'next', 'nextLine', 'equals', 'contains', 'containsKey', 'substring', 'toString', 'append', 'sort', 'push', 'pop', 'peek', 'poll', 'offer', 'isEmpty', 'intValue', 'println', 'print'],
        csharp: ['Length', 'Count', 'Add', 'ToString', 'Parse', 'Split', 'Join', 'Contains', 'ContainsKey', 'Substring', 'Sort', 'Reverse', 'Push', 'Pop', 'Peek', 'Dequeue', 'Enqueue', 'ReadLine', 'WriteLine', 'Write', 'Trim', 'ToArray'],
        nodejs: ['push', 'pop', 'shift', 'length', 'split', 'join', 'map', 'filter', 'reduce', 'slice', 'sort', 'indexOf', 'includes', 'trim', 'log', 'keys', 'values', 'entries', 'get', 'set', 'has', 'toString', 'parseInt', 'readFileSync']
    };
    // 用到的標準函式庫名稱 → 需要的 include／import（機械補，不問模型）
    function importsFor(lang, idents) {
        const has = (re) => idents.some((x) => re.test(x)); const out = [];
        if (lang === 'c') { if (has(/^(printf|scanf|puts|gets|fgets|getchar|putchar|sscanf|fprintf|sprintf|snprintf|stdin|stdout|stderr)$/)) out.push('#include <stdio.h>'); if (has(/^(malloc|free|calloc|realloc|qsort|atoi|atol|abs|exit|rand|srand)$/)) out.push('#include <stdlib.h>'); if (has(/^(strlen|strcmp|strcpy|strcat|memcpy|memset|strncmp|strchr)$/)) out.push('#include <string.h>'); if (has(/^(sqrt|pow|floor|ceil|fabs|log|exp|sin|cos)$/)) out.push('#include <math.h>'); }
        if (lang === 'cpp') { out.push('#include <bits/stdc++.h>'); out.push('using namespace std;'); }
        if (lang === 'java') { if (has(/^(Scanner|List|ArrayList|Map|HashMap|Set|HashSet|Arrays|Collections|Deque|ArrayDeque|Queue|LinkedList|PriorityQueue|TreeMap|Stack)$/)) out.push('import java.util.*;'); }
        if (lang === 'csharp') { out.push('using System;'); if (has(/^(List|Dictionary|HashSet|Queue|Stack)$/)) out.push('using System.Collections.Generic;'); }
        if (lang === 'nodejs') { if (has(/^fs$/)) out.push("const fs = require('fs');"); }
        if (lang === 'python') { if (has(/^sys$/)) out.push('import sys'); if (has(/^(deque)$/)) out.push('from collections import deque'); if (has(/^(defaultdict)$/)) out.push('from collections import defaultdict'); if (has(/^(Counter)$/)) out.push('from collections import Counter'); if (has(/^(heapq)$/)) out.push('import heapq'); if (has(/^(math)$/)) out.push('import math'); if (has(/^(bisect)$/)) out.push('import bisect'); }
        return out;
    }

    // ---------- 渲染 ----------
    const NOSP_BEFORE = new Set([')', ']', ',', ';', '.', '->', '::', '++', '--', ':']); const NOSP_AFTER = new Set(['(', '[', '.', '->', '::', '!', '~']);
    const KW_SPACE = new Set(['if', 'for', 'while', 'switch', 'return', 'else', 'do', 'case', 'new', 'in', 'not', 'and', 'or', 'is', 'elif', 'throw', 'sizeof']);
    function joinTokens(tokens, lang) {
        let out = ''; let prev = null; let prevPrev = null;
        const unaryCtx = (p, pp) => !p || (p.t === 'op' && !/^[)\]]$/.test(p.v) && !(p.v === '++' || p.v === '--')) || (p.t === 'id' && KW_SPACE.has(p.v) && p.v !== 'in');
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i]; let sp = ' ';
            if (!prev) sp = '';
            else if (NOSP_BEFORE.has(t.v) && !(t.v === ':' && lang !== 'python' && false)) sp = '';
            else if (NOSP_AFTER.has(prev.v)) sp = '';
            else if (t.v === '(' && prev && prev.t === 'id' && !KW_SPACE.has(prev.v)) sp = '';
            else if (t.v === '[' && prev && (prev.t === 'id' || prev.v === ')' || prev.v === ']' || prev.t === 'str')) sp = '';
            else if ((prev.v === '-' || prev.v === '+' || prev.v === '*' || prev.v === '&' || prev.v === '++' || prev.v === '--') && unaryCtx(prevPrev, null) && prev.v !== '++' && prev.v !== '--') sp = '';
            else if (prev.v === '++' || prev.v === '--') sp = unaryCtx(prevPrev) ? '' : ' ';
            out += sp + t.v; prevPrev = prev; prev = t;
        }
        return out;
    }
    function renderBraces(tokens) {
        const lines = []; let cur = []; let depth = 0; let paren = 0;
        const flush = () => { if (cur.length) lines.push('    '.repeat(Math.max(0, depth)) + joinTokens(cur, 'brace')); cur = []; };
        for (const t of tokens) {
            if (t.t === 'op' && t.v === '(') paren++; if (t.t === 'op' && t.v === ')') paren = Math.max(0, paren - 1);
            if (t.t === 'op' && t.v === '}') { flush(); depth = Math.max(0, depth - 1); lines.push('    '.repeat(depth) + '}'); continue; }
            cur.push(t);
            if (t.t === 'op' && t.v === '{') { flush(); depth++; } else if (t.t === 'op' && t.v === ';' && paren === 0) flush();
        }
        flush(); return lines.join('\n').replace(/\n(\s*)\{$/gm, ' {') + '\n';
    }
    function renderPython(lines) { return lines.map((l) => '    '.repeat(l.level) + joinTokens(l.tokens, 'python')).join('\n') + '\n'; }

    // ---------- 選項 ----------
    function scopeNames(lang, toks, plan, ext, own) {
        const names = []; const seen = new Set(); const add = (n, kind, w) => { if (!n || seen.has(n) || !WORD.test(n) || (S.kwOf(lang).has(n) && kind !== 'builtin')) return; seen.add(n); names.push({ name: n, kind, w }); };
        const sym = S.symbolsOf(lang, toks.map((t, i) => Object.assign({ off: 0, end: 0, line: 1, col: i + 1 }, t)), null);
        const declared = Array.from(sym.declared).reverse(); declared.forEach((n, i) => { if (n !== own) add(n, 'local', i); });
        for (const n of plan || []) if (n.name !== own) add(n.name, 'function', 200);
        for (const n of Object.keys(ext || {})) add(n, 'symbol', 300);
        for (const n of (S.BUILTINS ? (S.BUILTINS[lang] || '').split(' ') : [])) add(n, 'builtin', 400);
        return names;
    }
    function buildOptions(lang, E, toks, ctx) {
        // E：文法算出的合法終端。回傳 {groups:{關鍵字:[],名稱:[],字面值:[],符號:[]}, forced:token|null, total}
        const drop = new Set(DROP[lang]); if (ctx.allowInlineAsm && (lang === 'c' || lang === 'cpp')) for (const w of ['asm', '__asm__', '__asm', '__volatile__', 'volatile']) drop.delete(w); const prior = PRIOR[lang]; const rank = (v) => { const i = prior.indexOf(v); return i < 0 ? 1000 + v.length : i; };
        const kw = [], punct = [], names = [], lits = [];
        const lastTok = toks[toks.length - 1]; const afterDot = lastTok && lastTok.t === 'op' && (lastTok.v === '.' || lastTok.v === '->' || lastTok.v === '::');
        for (const e of E) {
            if (e[0] === "'") { const v = e.slice(1, -1); if (/^[A-Za-z_]+$/.test(v)) { if (!drop.has(v)) kw.push(v); } else punct.push(v); }
            else if (e === 'ID') {
                if (afterDot) { for (const m of MEMBERS[lang] || []) names.push({ name: m, kind: 'member', w: 100 }); }
                else for (const n of scopeNames(ctx.lang, toks, ctx.plan, ctx.ext, ctx.own)) names.push(n);
                names.push({ name: null, kind: 'new', w: 150 }); // 「新名稱」緊跟在局部變數後面（常常需要），不要排到幾十個內建名稱的後面
            }
            else if (e === 'NUM') lits.push({ kind: 'num' }); else if (e === 'STR') lits.push({ kind: 'str' });
        }
        names.sort((x, y) => (x.w == null ? 0 : x.w) - (y.w == null ? 0 : y.w));
        kw.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)); punct.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
        return { kw, punct, names, lits };
    }

    // ---------- 家族適配 ----------
    function makeBrace(lang, node) {
        const head = S.lex(lang, node.signature); const toks = head.map((t) => ({ t: t.t, v: t.v }));
        return {
            fam: 'brace', toks, depth: 0, started: false,
            expected() { return G.expectedAt(lang, this.toks); },
            push(t) { this.toks.push(t); if (t.t === 'op' && t.v === '{') { this.depth++; this.started = true; } if (t.t === 'op' && t.v === '}') this.depth--; },
            done() { return this.started && this.depth === 0; },
            render() { return renderBraces(this.toks); }, flat() { return this.toks; },
            raw() { return renderBraces(this.toks).replace(/\n$/, ''); }, previewTok(t) { return renderBraces(this.toks.concat([t])).replace(/\n$/, ''); }, previewPseudo() { return null; },
            pseudo() { return []; }, applyPseudo() { return null; },
            cursorText() { return renderBraces(this.toks).replace(/\n$/, '') + '▮'; }
        };
    }
    function makePython(lang, node) {
        const head = S.lex(lang, node.signature).filter((t) => t.t !== 'nl').map((t) => ({ t: t.t, v: t.v }));
        const st = {
            fam: 'python', lines: [{ level: 0, tokens: head }], levels: [0], fin: false, pendingNewLine: false,
            cur() { return this.lines[this.lines.length - 1]; },
            expected() { return G.expectedAt(lang, this.cur().tokens); },
            push(t) { this.cur().tokens.push(t); },
            done() { return this.fin; }, render() { return renderPython(this.lines); },
            raw() { return renderPython(this.lines).replace(/\n$/, ''); },
            previewTok(t) { const ls = this.lines.map((l, i) => (i === this.lines.length - 1 ? { level: l.level, tokens: l.tokens.concat([t]) } : l)); return renderPython(ls).replace(/\n$/, ''); },
            // 函式寫完＝模型自己的結束符 <|im_end|>（不用程式碼圍欄）
            previewPseudo(o) { const cur = this.cur(); if (o.kind === 'end') return this.raw() + '<|im_end|>'; const lv = o.kind === 'nl-in' ? cur.level + 1 : o.kind === 'nl-same' ? cur.level : o.to; return renderPython(this.lines.concat([{ level: lv, tokens: [] }])).replace(/\n$/, ''); },
            flat() { return [].concat(...this.lines.map((l) => l.tokens)); },
            cursorText() { return renderPython(this.lines).replace(/\n$/, '') + '▮'; },
            // 一行寫完（文法判定 complete）之後的偽選項：換行並選縮排、或結束函式
            pseudo(E) {
                const cur = this.cur(); const opts = []; const endsColon = cur.tokens.length && cur.tokens[cur.tokens.length - 1].v === ':';
                if (!E.complete) return opts;
                if (this.lines.length === 1 && !endsColon) return opts; // 標頭還沒有冒號
                if (endsColon) { opts.push({ kind: 'nl-in', label: '⏎ 換行，進入下一層縮排（這個區塊的第一條）' }); return opts; }
                opts.push({ kind: 'nl-same', label: '⏎ 換行，同一層接著寫下一條' });
                const lv = cur.level; for (let k = lv - 1; k >= 1; k--) opts.push({ kind: 'nl-to', to: k, label: '⇤ 換行，退回第 ' + k + ' 層縮排（結束內層的區塊）' });
                opts.push({ kind: 'end', label: '■ 這個函式寫完了' }); return opts;
            },
            applyPseudo(o) {
                const cur = this.cur();
                if (o.kind === 'nl-in') this.lines.push({ level: cur.level + 1, tokens: [] });
                else if (o.kind === 'nl-same') this.lines.push({ level: cur.level, tokens: [] });
                else if (o.kind === 'nl-to') this.lines.push({ level: o.to, tokens: [] });
                else if (o.kind === 'end') this.fin = true;
                return o.kind;
            }
        };
        return st;
    }

    // ---------- 主流程 ----------
    async function guidedWriteFunction(a) {
        const lang = a.lang; const fam = G && G.supports(lang) ? (lang === 'python' ? 'python' : 'brace') : null; const node = a.node; // 上限以「一個函式」為單位（使用者：例如 300 步、900 步）。開發期間先設無限大（使用者要求），做完再 profile 後決定實際上限
        const o = Object.assign({ maxSteps: Infinity, maxChoices: Infinity, pageSize: 8, flatMax: 14, deadlineMs: Infinity }, a.opts || {}); // deadlineMs：按時間的安全閥（預設無限；基準腳本才設），避免退化成重複循環時永遠不結束；不是步數上限
        const tStart = Date.now();
        const Stack = a.stackMod || DefaultStack; const trace = []; const calls = { choose: 0, free: 0, rank: 0 }; let steps = 0;
        if (!fam) return { ok: false, reason: 'unsupported_lang', code: '', tokens: [], steps: 0, calls, trace };
        const emit = (e) => { trace.push(e); if (typeof a.onEvent === 'function') { try { a.onEvent(e); } catch (_) { /* 進度回報壞了不影響流程 */ } } };
        const st = fam === 'brace' ? makeBrace(lang, node) : makePython(lang, node);
        const ctx = { lang, plan: a.plan, ext: a.symbols, own: node.name, allowInlineAsm: !!(a.opts && a.opts.allowInlineAsm) };
        const wrap = (msgs) => (Stack && a.stack ? Stack.wrap(msgs, a.stack, { repeat: !!(a.opts && a.opts.thinking) }) : msgs);
        const head = (extra) => (a.spec ? '題目：' + clip(a.spec, 700) + '\n' : '') + (a.feedback ? '上一版的問題（這次要避免）：' + clip(a.feedback, 400) + '\n' : '') + (a.plan && a.plan.length ? '函式清單（已定）：\n' + a.plan.map((n) => '- ' + n.signature + (n.purpose ? '：' + n.purpose : '')).join('\n') + '\n' : '') + '正在寫：' + node.signature + (node.purpose ? '（' + node.purpose + '）' : '') + '\n' + (extra || '');
        // 標頭之後一定要有本體：clike 自動補 '{'；python 自動補 ':'
        const ensureBody = () => {
            if (fam === 'brace') { const ex = st.expected(); if (!ex.ok) return { ok: false, reason: '簽名「' + node.signature + '」在文法上不合法（第 ' + ex.failAt + ' 個 token）' }; if (ex.expected.includes("'{'")) st.push({ t: 'op', v: '{' }); else return { ok: false, reason: '簽名後面不能接函式本體' }; }
            else { const ex = st.expected(); if (!ex.ok) return { ok: false, reason: '簽名「' + node.signature + '」在文法上不合法' }; const last = st.cur().tokens[st.cur().tokens.length - 1]; if (!(last && last.v === ':')) { if (ex.expected.includes("':'")) st.push({ t: 'op', v: ':' }); else return { ok: false, reason: '簽名後面不能接冒號' }; } st.lines.push({ level: 1, tokens: [] }); }
            return { ok: true };
        };
        const be = ensureBody(); if (!be.ok) return { ok: false, reason: 'bad_signature', detail: be.reason, code: '', tokens: [], steps: 0, calls, trace };
        const finish = (ok, reason, extra) => { const toks = st.flat(); const idents = toks.filter((t) => t.t === 'id').map((t) => t.v); const imports = importsFor(lang, idents); return Object.assign({ ok, reason, code: st.render(), body: st.render(), imports, tokens: toks.length, steps, calls, trace }, extra || {}); };
        // ---- rank 策略（約束解碼）：機械算出合法 token 集合，模型對每個合法選項用「下一個 token 的機率」打分，取最高。
        // 對模型來說這和它平常自由寫程式時的預測一樣，只是不合法的 token 沒有機會被選到；不需要它回字母。需要呼叫端給 lm（有 KV 快取的游標）。
        const useRank = !!(a.lm && typeof a.lm.open === 'function' && (o.strategy || 'rank') === 'rank');
        let cursor = null, committedLen = 0;
        const openCursor = async () => {
            const full = st.raw(); committedLen = full.lastIndexOf('\n') + 1;
            const msgs = wrap([{ role: 'system', content: '你是' + (a.langLabel || lang) + '程式設計師。只輸出一個程式碼區塊，裡面只有函式「' + node.name + '」的完整定義，不要其他函式、不要說明。不要把題目範例的數字或答案直接寫進程式，程式要從標準輸入讀資料。' + (a.rules || '') }, { role: 'user', content: head() + '現在寫：' + node.name + (node.purpose ? '（' + node.purpose + '）' : '') + '。' }]);
            cursor = await a.lm.open(msgs, full.slice(0, committedLen)); // 助手的前綴就是「函式已寫的行」：不加程式碼圍欄（實測加圍欄會把 0.6B 推進另一種「貼程式」的模式，傾向抄範例數字；自由寫時它本來就不加圍欄）
        };
        const rankStep = async (opts, pseudo) => {
            if (!cursor) await openCursor();
            const full = st.raw(); const nlEnd = full.lastIndexOf('\n') + 1;
            if (nlEnd > committedLen) { await cursor.commit(full.slice(committedLen, nlEnd)); committedLen = nlEnd; } // 已完成的行放進 KV 快取
            const partial = full.slice(committedLen); const base = partial.replace(/\s+$/, ''); const trail = partial.slice(base.length);
            const cands = []; const seenKey = new Set();
            const addTok = (t, label, kind) => { const key = t.t + ':' + t.v; if (seenKey.has(key)) return; seenKey.add(key); const after = st.previewTok(t); if (!after.startsWith(full)) return; cands.push({ text: trail + after.slice(full.length), apply: () => st.push(t), label, kind }); };
            for (const v of opts.kw) addTok({ t: 'id', v }, v, 'kw'); for (const v of opts.punct) addTok({ t: 'op', v }, v, 'punct');
            for (const nm of opts.names) if (nm.name) addTok({ t: 'id', v: nm.name }, nm.name, 'name');
            for (const p of pseudo) { const after = st.previewPseudo(p); if (!after || !after.startsWith(full)) continue; cands.push({ text: trail + after.slice(full.length), apply: () => st.applyPseudo(p), label: p.label, kind: 'pseudo' }); }
            // 新名稱／數字／字串：用模型自己的貪婪續寫取一個字面（驗證過才當候選），讓它也能「想出」文法無法列舉的詞
            const needNew = opts.names.some((x) => x.kind === 'new'), needNum = opts.lits.some((x) => x.kind === 'num'), needStr = opts.lits.some((x) => x.kind === 'str');
            if (needNew || needNum || needStr) {
                let rest = String(await cursor.greedy(12, { base })); if (trail && rest.startsWith(trail)) rest = rest.slice(trail.length); rest = rest.replace(/^[ \t]+/, ''); let mm;
                if (needStr && (mm = /^("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/.exec(rest))) addTok({ t: 'str', v: mm[1] }, mm[1], 'str');
                else if (needNum && (mm = /^-?\d+(\.\d+)?/.exec(rest))) addTok({ t: 'num', v: mm[0] }, mm[0], 'num');
                else if (needNew && (mm = /^[A-Za-z_][\w$]*/.exec(rest)) && !S.kwOf(lang).has(mm[0])) addTok({ t: 'id', v: mm[0] }, mm[0], 'name');
            }
            if (!cands.length) return false;
            calls.rank++; const scored = await cursor.rank(cands.map((c) => c.text), { base, topK: 8 });
            let bi = 0; scored.forEach((x, i) => { if (x.logprob > scored[bi].logprob) bi = i; });
            const top = scored.map((x, i) => ({ t: cands[i].label, lp: +x.logprob.toFixed(2) })).sort((x, y) => y.lp - x.lp).slice(0, 3);
            const best = cands[bi]; best.apply(); emit({ t: 'pick', kind: best.kind, text: best.label, via: 'rank', lp: top[0].lp, top }); return true;
        };
        let consecutiveFree = 0;
        while (!st.done()) {
            if (++steps > o.maxSteps) return finish(false, 'max_steps');
            if (Date.now() - tStart > o.deadlineMs) return finish(false, 'deadline', { detail: '超過每個函式的時間安全閥（' + Math.round(o.deadlineMs / 1000) + ' 秒）' });
            const E = st.expected(); if (E.aborted) return finish(false, 'grammar_aborted');
            if (!E.ok) return finish(false, 'grammar_stuck', { detail: '文法吃不下已寫的部分（第 ' + E.failAt + ' 個 token）' });
            let opts = buildOptions(lang, E.expected, st.flat(), ctx); const pseudo = st.pseudo(E);
            // 機械可決定的：只有一個合法選項（且不是名稱／字面值）→ 自動補，不問模型
            const total = opts.kw.length + opts.punct.length + opts.names.length + opts.lits.length + pseudo.length;
            if (total === 0) return finish(false, 'no_legal_option', { detail: '文法在這個位置沒有任何合法的下一步' });
            if (total === 1 && !opts.names.length && !opts.lits.length && !pseudo.length) { const v = opts.kw[0] || opts.punct[0]; st.push({ t: /^[A-Za-z_]/.test(v) ? 'id' : 'op', v }); emit({ t: 'auto', token: v }); continue; }
            if (total === 1 && pseudo.length === 1) { st.applyPseudo(pseudo[0]); emit({ t: 'auto', token: pseudo[0].label }); continue; }
            if (useRank) { let okRank = false; try { okRank = await rankStep(opts, pseudo); } catch (e) { if (e && e.budget) throw e; return finish(false, 'rank_failed', { detail: String((e && e.message) || e).slice(0, 120) }); } if (!okRank) return finish(false, 'no_legal_option', { detail: '沒有可以打分的合法選項' }); continue; }
            if (calls.choose >= o.maxChoices) return finish(false, 'max_choices');
            // 分類別兩層（選項多時）：先選「關鍵字／名稱／字面值／符號／換行」，再選項目
            const groups = []; if (pseudo.length) groups.push({ key: 'pseudo', label: '換行／結束', items: pseudo.map((p) => ({ kind: p.kind, text: p.label, pseudo: p })) });
            if (opts.names.length) groups.push({ key: 'names', label: '名稱（變數、函式、成員）', items: opts.names.map((n) => ({ kind: n.kind === 'new' ? 'new' : 'name', text: n.name == null ? '✍ 新名稱（我自己寫）' : n.name + (n.kind === 'function' ? '（函式）' : n.kind === 'builtin' ? '（內建）' : n.kind === 'member' ? '（常見成員）' : ''), name: n.name })) });
            if (opts.lits.length) groups.push({ key: 'lits', label: '字面值（數字／字串）', items: opts.lits.map((l) => ({ kind: l.kind, text: l.kind === 'num' ? '✍ 數字（我自己寫）' : '✍ 字串（我自己寫）' })) });
            if (opts.kw.length) groups.push({ key: 'kw', label: '關鍵字', items: opts.kw.map((v) => ({ kind: 'kw', text: '`' + v + '`', tok: v })) });
            if (opts.punct.length) groups.push({ key: 'punct', label: '符號', items: opts.punct.map((v) => ({ kind: 'punct', text: '`' + v + '`', tok: v })) });
            const ask = async (title, items, extra) => {
                const page = items.slice(0, o.pageSize); const more = items.length > o.pageSize; const letters = page.map((_, i) => String.fromCharCode(65 + i)); if (more) letters.push('Z');
                const msgs = [{ role: 'system', content: '你在一個 token 一個 token 地寫程式。合法的下一步已經由文法算好了，你只要從選項裡挑一個最符合需求的。只輸出 JSON：{"pick":"字母"}。' }, { role: 'user', content: head() + '目前寫到（▮ 是游標）：\n```\n' + st.cursorText() + '\n```\n' + (extra ? extra + '\n' : '') + title + '\n' + page.map((it, i) => letters[i] + '. ' + it.text).join('\n') + (more ? '\nZ. …更多選項（還有 ' + (items.length - o.pageSize) + ' 個）' : '') }];
                calls.choose++; let idx = null; // aliases：小模型常常回「選項的內容」（例如 +、total）而不是字母；內容等於某個合法選項就算選了它（字母優先）
                const aliasesOf = (it) => (it.kind === 'group' ? it.g.items.filter((x) => x.kind !== 'new').map((x) => String(x.tok || x.name || '').trim()).filter(Boolean) : [String(it.tok || it.name || '').trim()].filter(Boolean));
                try { idx = await a.choose(wrap(msgs), page.map((it, i) => ({ label: letters[i], kind: it.kind, text: it.text, aliases: aliasesOf(it) })).concat(more ? [{ label: 'Z', kind: 'more', text: '更多', aliases: [] }] : [])); } catch (e) { if (e && e.budget) throw e; idx = null; }
                if (idx == null || idx < 0 || idx >= page.length + (more ? 1 : 0)) return { none: true };
                if (more && idx === page.length) return { more: true, rest: items.slice(o.pageSize) };
                return { item: page[idx] };
            };
            let chosen = null; let pool = null;
            const flatTotal = groups.reduce((x, g) => x + g.items.length, 0);
            if (groups.length === 1) pool = groups[0].items;
            else if (flatTotal <= o.flatMax) pool = [].concat(...groups.map((g) => g.items)); // 選項不多：一層扁平選單就好，省一次呼叫
            else {
                // 類別選項帶樣本（讓小模型看得出語意，而不是只看到「名稱（42 個選項）」這種抽象標籤）
                const sample = (g) => { const xs = g.items.filter((it) => it.kind !== 'new').slice(0, g.key === 'punct' ? 10 : 6).map((it) => String(it.tok || it.name || it.text).replace(/（.*$/, '').replace(/`/g, '')); return xs.length ? '：' + xs.join('、') + (g.items.length > xs.length ? '…' : '') : ''; };
                const gi = await ask('現在要寫哪一類？', groups.map((g) => ({ kind: 'group', text: g.label.replace(/（.*$/, '') + sample(g) + '（共 ' + g.items.length + ' 個選項）', g })), ''); if (gi.none) return finish(false, 'choose_failed', { detail: '模型沒有選出類別' }); if (gi.more) return finish(false, 'choose_failed'); pool = gi.item.g.items; }
            let round = 0; for (;;) { const r = await ask('這個位置合法的下一步：', pool, ''); if (r.none) return finish(false, 'choose_failed', { detail: '模型沒有選出項目' }); if (r.more) { pool = r.rest; if (++round > 4) return finish(false, 'choose_failed'); continue; } chosen = r.item; break; }
            // 套用
            if (chosen.pseudo) { st.applyPseudo(chosen.pseudo); emit({ t: 'pick', kind: 'pseudo', text: chosen.text }); consecutiveFree = 0; continue; }
            if (chosen.kind === 'kw' || chosen.kind === 'punct') { const v = chosen.tok; st.push({ t: chosen.kind === 'kw' ? 'id' : 'op', v }); emit({ t: 'pick', kind: chosen.kind, text: v }); consecutiveFree = 0; continue; }
            if (chosen.kind === 'name') { st.push({ t: 'id', v: chosen.name }); emit({ t: 'pick', kind: 'name', text: chosen.name }); consecutiveFree = 0; continue; }
            // 新名稱／數字／字串：讓模型寫一小段，並驗證
            const kind = chosen.kind === 'new' ? 'name' : chosen.kind; calls.free++;
            const fmsgs = [{ role: 'system', content: kind === 'name' ? '你要為程式取一個新名稱。只輸出 JSON：{"name":"識別字"}，只能用英文字母、數字、底線，不能是關鍵字。' : kind === 'num' ? '你要寫一個數字。只輸出 JSON：{"num":"數字"}（整數或小數，可帶負號）。' : '你要寫一個字串的內容（不含外面的引號；換行請寫成兩個字元 \\n）。只輸出 JSON：{"text":"內容"}。' }, { role: 'user', content: head() + '目前寫到（▮ 是游標）：\n```\n' + st.cursorText() + '\n```\n請寫這個位置要的' + (kind === 'name' ? '新名稱' : kind === 'num' ? '數字' : '字串內容') + '。' }];
            let raw = null; try { raw = a.free ? await a.free(wrap(fmsgs), kind) : null; } catch (e) { if (e && e.budget) throw e; raw = null; }
            let tok = null;
            if (raw != null) { const s = kind === 'str' ? String(raw) : String(raw).trim(); /* 字串內容的空白是有意義的（例如 " "），不能 trim */ if (kind === 'name' && WORD.test(s) && !S.kwOf(lang).has(s)) tok = { t: 'id', v: s }; else if (kind === 'num' && /^-?\d+(\.\d+)?$/.test(s)) tok = { t: 'num', v: s }; else if (kind === 'str') tok = { t: 'str', v: '"' + s.replace(/\r?\n/g, '\\n').replace(/(^|[^\\])"/g, '$1\\"') + '"' }; }
            if (!tok) { if (++consecutiveFree >= 3) return finish(false, 'free_failed', { detail: '模型連續寫不出合法的' + kind }); emit({ t: 'free_failed', kind }); continue; }
            st.push(tok); emit({ t: 'pick', kind, text: tok.v }); consecutiveFree = 0;
        }
        return finish(true, 'done');
    }

    return { guidedWriteFunction, importsFor, buildOptions, joinTokens, renderBraces, renderPython, DROP, PRIOR, MEMBERS };
});
