/* 專案模式（第一階段，純函式，UMD；模型與檢查器都是注入的）：給一份 UML 模型（FaUml 的 {classes, relations}），
 * 依「專案 → 套件 → 類別」遞迴切割，每個類別一個思考堆疊框架、各寫一次完整的 class，全部合成一個檔案後交給檢查器（編譯／語法，或呼叫端綁好的判題器）。
 * 沒過就用選擇題挑「要重寫哪個類別」，帶著編譯訊息重寫。設計見 DESIGN.fn-template.md 第八節；題目式（stdin→stdout）的版本在 code_loop_core.js。
 *
 *   solveProject({model, lang, scenario, ask, write, judge, stackMod?, opts?}) → Promise<結果>
 *     ask(messages, validate)、write(messages, {thinking, kind, fn})：同 code_loop_core。judge({lang, source}) 通常是 judge-runner 的 check（只編譯）；
 *     opts：driver（附在所有 class 之後的進入點／測試程式碼，語言自己的；有給才會真的跑出行為）、maxRethink 3、maxCalls 60、opsPerClass 6（超過只記 gap，仍一次寫完）
 *   支援語言：python、nodejs、java、csharp、cpp、ruby、perl（其他語言回 ok:false、reason:'unsupported_lang'）。
 *   結果：{ ok, verified, verdict, source, order, classes:{名:程式}, rethinks, calls, gaps, reason?, stack, trace }
 *     verified：只有判決是 AC（有 driver＋測試）才是 true；CHECKED（只編譯過）是 ok 但 verified:false，gaps 會說明。 */
(function (root, factory) { const T = (typeof FaThinkStack !== 'undefined' && FaThinkStack) || (root && root.FaThinkStack) || (typeof require === 'function' ? require('./think_stack.js') : null); const L = (typeof FaCodeLoop !== 'undefined' && FaCodeLoop) || (root && root.FaCodeLoop) || (typeof require === 'function' ? require('./code_loop_core.js') : null); if (typeof module === 'object' && module.exports) module.exports = factory(T, L); else root.FaCodeProject = factory(T, L); })(typeof self !== 'undefined' ? self : this, function (DefaultStack, Loop) {
    'use strict';
    const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; };
    const PLANGS = {
        python: { name: 'Python 3', hoist: /^(import|from)\s/, rules: '用 class 定義（含 __init__ 與每個操作）；不要寫 main、不要在檔案裡直接執行任何東西；import 寫在最前面。' },
        nodejs: { name: 'Node.js', hoist: /^(const|let|var)\s+\w+\s*=\s*require\(/, rules: '用 class 定義（constructor 與每個操作）；不要在檔案裡直接執行任何東西；require 寫在最前面。' },
        java: { name: 'Java', hoist: /^import\s/, rules: '寫成非 public 的 class（不要寫 public class）；不要 package、不要 main；成員用 public；import 寫在最前面。' },
        csharp: { name: 'C#', hoist: /^using\s/, rules: '不要 namespace、不要 Main；成員用 public；using 寫在最前面。' },
        cpp: { name: 'C++', hoist: /^(#include\b|using\s+namespace\b)/, rules: 'class 完整定義（成員函式寫在類別裡面，結尾要有分號）；不要 main；#include 與 using namespace std; 寫在最前面。' },
        ruby: { name: 'Ruby', hoist: /^require\b/, rules: '用 class ... end 定義；不要在檔案裡直接執行任何東西。' },
        perl: { name: 'Perl', hoist: /^use\s+(strict|warnings|utf8)\b/, rules: '用 package 名稱; 開頭，sub new 與每個操作用 sub 定義，最後一行 1;；use strict; use warnings; 寫在最前面。' }
    };
    const patchCodes = Loop.patchCodes;
    class Budget extends Error { }
    const DONE = { AC: 1, CHECKED: 1 };

    const typeStr = (t) => { if (t == null) return ''; if (typeof t === 'string') return t; const a = t.args && t.args.length ? '<' + t.args.map(typeStr).join(', ') + '>' : ''; return (t.base || '') + a; };
    const typeRefsOf = (t, out) => { out = out || []; if (t == null) return out; if (typeof t === 'string') { (t.match(/[A-Za-z_]\w*/g) || []).forEach((x) => out.push(x)); return out; } if (t.base) out.push(t.base); (t.args || []).forEach((a) => typeRefsOf(a, out)); return out; };
    const attrLine = (a) => (a.visibility || '+') + a.name + ': ' + typeStr(a.type);
    const opLine = (o) => (o.visibility || '+') + o.name + '(' + (o.params || []).map((p) => p.name + ': ' + typeStr(p.type)).join(', ') + ')' + (o.returns ? ': ' + typeStr(o.returns) : '');
    function classSpec(c) {
        if (c.kind === 'enum') return (c.kind) + ' ' + c.name + '：' + (c.values || []).join(', ');
        return (c.kind === 'abstract' ? 'abstract class' : c.kind) + ' ' + c.name + (c.attrs && c.attrs.length ? '\n屬性：' + c.attrs.map(attrLine).join('；') : '') + (c.ops && c.ops.length ? '\n操作：' + c.ops.map(opLine).join('；') : '');
    }
    const norm = (s) => String(s).toLowerCase().replace(/_/g, '');

    // 依賴：關係（from 依賴 to）與屬性／操作用到的型別；被依賴的排前面（有環時照模型原順序，不丟東西）
    function dependencies(model) {
        const names = new Set(model.classes.map((c) => c.name)); const deps = new Map(model.classes.map((c) => [c.name, new Set()]));
        for (const r of model.relations || []) if (names.has(r.from) && names.has(r.to) && r.from !== r.to) deps.get(r.from).add(r.to);
        for (const c of model.classes) { const refs = [].concat(...(c.attrs || []).map((a) => typeRefsOf(a.type)), ...(c.ops || []).map((o) => [].concat(typeRefsOf(o.returns), ...(o.params || []).map((p) => typeRefsOf(p.type))))); for (const x of refs) if (names.has(x) && x !== c.name) deps.get(c.name).add(x); }
        return deps;
    }
    function orderClasses(model) {
        const deps = dependencies(model); const byName = new Map(model.classes.map((c) => [c.name, c])); const out = [], state = {}; let cycle = false;
        const visit = (n) => { if (state[n] === 2) return; if (state[n] === 1) { cycle = true; return; } state[n] = 1; for (const d of deps.get(n)) visit(d); state[n] = 2; out.push(byName.get(n)); };
        for (const c of model.classes) visit(c.name);
        return { list: out, cycle, deps };
    }

    // 設計樹的語意給語法修復用：類別名稱、屬性名稱（引數個數不明＝null）、方法名稱與它的引數個數
    function modelSymbols(list) { const out = {}; for (const c of list || []) { out[c.name] = null; for (const a of c.attrs || []) out[a.name] = null; for (const o of c.ops || []) out[o.name] = (o.params || []).length; } return out; }
    function assembleProject(lang, codes, driver) {
        const P = PLANGS[lang]; const hoisted = [], seen = new Set(), bodies = [];
        for (const code of codes) {
            const keep = [];
            for (const line of String(code).split('\n')) { if (P.hoist && P.hoist.test(line)) { const k = line.trim(); if (!seen.has(k)) { seen.add(k); hoisted.push(k); } } else keep.push(line); }
            bodies.push(keep.join('\n').replace(/^\s*\n+/, '').replace(/\s+$/, ''));
        }
        return (hoisted.length ? hoisted.join('\n') + '\n\n' : '') + bodies.join('\n\n') + '\n' + (driver ? '\n' + String(driver).replace(/\s+$/, '') + '\n' : '');
    }

    function verifyClass(code, c) {
        const s = String(code || ''); if (s.trim().length < 8) return { ok: false, reason: '沒有程式碼' }; if (s.indexOf('```') >= 0) return { ok: false, reason: '程式碼裡不能有 ``` 標記' };
        if (!new RegExp('(^|[^A-Za-z0-9_])' + c.name + '([^A-Za-z0-9_]|$)').test(s)) return { ok: false, reason: '沒有定義 class「' + c.name + '」' };
        const flat = norm(s); const missing = [];
        for (const o of c.ops || []) if (flat.indexOf(norm(o.name)) < 0) missing.push(o.name);
        if (missing.length) return { ok: false, reason: '缺少操作：' + missing.slice(0, 6).join('、') };
        return { ok: true };
    }

    async function solveProject(args) {
        const model = args.model, lang = args.lang, P = PLANGS[lang]; const Stack = args.stackMod || DefaultStack;
        const o = Object.assign({ maxRethink: 3, maxCalls: Infinity, /* 開發期間不設上限，profile 後再訂 */ opsPerClass: 6, driver: '' }, args.opts || {});
        const calls = { ask: 0, write: 0, judge: 0 }, trace = [], gaps = [];
        const note = (e) => { trace.push(e); if (typeof args.onEvent === 'function') { try { args.onEvent(e); } catch (_) { /* 進度回報壞了不影響流程 */ } } };
        if (!P) return { ok: false, verified: false, verdict: 'NONE', reason: 'unsupported_lang', gaps: ['專案模式不支援 ' + lang + '（支援：' + Object.keys(PLANGS).join('、') + '）'], calls, trace, source: '', classes: {}, order: [], rethinks: 0, stack: [] };
        if (!model || !Array.isArray(model.classes) || !model.classes.length) return { ok: false, verified: false, verdict: 'NONE', reason: 'empty_model', gaps: ['UML 模型沒有任何類別'], calls, trace, source: '', classes: {}, order: [], rethinks: 0, stack: [] };
        const spend = (k) => { if (calls.ask + calls.write >= o.maxCalls) throw new Budget('呼叫次數用完（' + o.maxCalls + '）'); calls[k]++; };
        const ask = args.ask ? async (msgs, validate, opts2) => { spend('ask'); const v = await args.ask(msgs, validate, opts2); note({ t: 'ask', ok: !!v }); return v; } : null;
        const write = async (msgs, meta) => { spend('write'); const v = await args.write(msgs, meta); note({ t: 'write', fn: meta && meta.fn, thinking: !!(meta && meta.thinking), kind: meta && meta.kind }); return v; };
        const goal = clip((args.scenario || model.name || '實作這個 UML 設計'), 200);
        const stack = Stack.create(goal, { maxDecisions: 12, maxHeaderChars: 900 });
        const ord = orderClasses(model); const order = ord.list; if (ord.cycle) gaps.push('類別之間有循環依賴，照模型原順序處理（編譯順序可能有問題）');
        const codes = {}; let sum = null, source = '', rethinks = 0;
        const result = (extra) => Object.assign({ ok: !!(sum && DONE[sum.verdict]), verified: !!(sum && sum.verdict === 'AC'), verdict: sum ? sum.verdict : 'NONE', source, order: order.map((c) => c.name), classes: codes, rethinks, calls, gaps, trace, edits: fixEdits, stack: Stack.toJsonl(stack) }, extra || {});
        const listText = () => order.map((c) => '- ' + classSpec(c).replace(/\n/g, '；')).join('\n');
        const fixEdits = [];
        const assembleAll = () => { source = assembleProject(lang, order.map((c) => codes[c.name] || ''), o.driver); return source; };
        const judgeNow = async () => { calls.judge++; sum = await args.judge({ lang, source }); note({ t: 'judge', verdict: sum.verdict, detail: clip(sum.detail, 120) }); return sum; };
        const judgeAndFix = async () => {
            await judgeNow();
            if (sum.verdict === 'CE' && typeof args.repair === 'function' && o.syntaxFix !== false) {
                let r = null; try { r = await args.repair({ lang, source, ask, semantic: { symbols: modelSymbols(order), hints: order.map((c) => classSpec(c).replace(/\n/g, '；')) }, wrap: (m) => Stack.wrap(m, stack) }); } catch (e) { if (e instanceof Budget) throw e; r = null; }
                if (r && r.ok && r.source !== source) { note({ t: 'syntax_fixed', edits: (r.edits || []).length, tried: r.tried }); fixEdits.push(...(r.edits || [])); const mapped = patchCodes(codes, source, r.source); source = r.source; if (!mapped) gaps.push('語法修補只套用在組裝後的程式，沒有對應回類別（之後重寫其他類別時可能再出現）'); await judgeNow(); }
            }
            return sum;
        };
        try {
            Stack.push(stack, { path: 'project', question: '用 ' + P.name + ' 實作整個 UML 設計（' + order.length + ' 個類別）', note: '專案→套件→類別' });
            note({ t: 'plan', classes: order.map((x) => x.name) });
            for (const c of order) Stack.decide(stack, classSpec(c).replace(/\n/g, '；'));
            const writeClass = async (c, extra, thinking) => {
                Stack.push(stack, { path: 'class:' + c.name, question: (extra ? '重寫 class ' : '寫 class ') + c.name + '（' + (c.attrs || []).length + ' 個屬性、' + (c.ops || []).length + ' 個操作）' });
                let reason = extra || '', code = '', failed = false; const dep = Array.from(ord.deps.get(c.name) || []);
                for (;;) {
                    const msgs = [{ role: 'system', content: '你是' + P.name + '程式設計師，正在分步實作一個 UML 設計。只輸出一個程式碼區塊，裡面只有 class「' + c.name + '」的完整實作，不要其他 class、不要說明。' + P.rules }, { role: 'user', content: '系統目標：' + goal + '\n\n所有類別（已定，名稱與成員不要改）：\n' + listText() + '\n\n現在寫：' + c.name + '\n' + classSpec(c) + (dep.length ? '\n它會用到：' + dep.join('、') : '') + (reason ? '\n' + reason : '') }];
                    code = Loop.extractCode(await write(Stack.wrap(msgs, stack, { repeat: !!thinking }), { thinking: !!thinking, kind: extra ? 'rewrite' : 'write', fn: c.name }));
                    const r = Stack.pop(stack, { summary: '已寫好，約 ' + code.split('\n').length + ' 行', result: code, verify: (x) => verifyClass(x, c) });
                    if (r.ok) { failed = !!r.frame.failed; break; }
                    reason = '上次的問題：' + r.reason;
                }
                if (failed) gaps.push('class ' + c.name + '：產生的程式碼沒通過基本檢查（' + verifyClass(code, c).reason + '）');
                if ((c.ops || []).length > o.opsPerClass) gaps.push('class ' + c.name + ' 有 ' + c.ops.length + ' 個操作，超過 ' + o.opsPerClass + '，一次寫完可能不完整');
                codes[c.name] = code; return code;
            };
            // 套件：有 package 欄位就多一層框架；沒有就只有專案層
            const groups = new Map(); for (const c of order) { const k = c.package || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
            for (const [pkg, list] of groups) {
                if (pkg && groups.size > 1) Stack.push(stack, { path: 'pkg:' + pkg, question: '實作套件 ' + pkg + ' 的 ' + list.length + ' 個類別' });
                for (const c of list) await writeClass(c, '', false);
                if (pkg && groups.size > 1) Stack.pop(stack, { summary: list.length + ' 個類別已寫好' });
            }
            assembleAll(); await judgeAndFix();
            while (!DONE[sum.verdict] && sum.verdict !== 'UNAVAILABLE' && rethinks < o.maxRethink) {
                rethinks++; note({ t: 'rethink', n: rethinks, verdict: sum.verdict }); const log = clip(sum.compileLog || sum.detail || '', 500);
                Stack.push(stack, { path: 'rethink#' + rethinks, question: '程式判決 ' + sum.verdict + '，要修哪個類別？', note: clip(log, 100) });
                let c = order.find((x) => new RegExp('\\b' + x.name + '\\b').test(log)) || order[order.length - 1]; // 預設：編譯訊息裡點名的第一個類別，否則最後一個
                if (order.length > 1 && ask) {
                    const letters = order.map((_, i) => String.fromCharCode(65 + i));
                    const msgs = [{ role: 'system', content: '你在除錯。只輸出 JSON：{"fix":"字母"}，選一個最可能有錯的類別。' }, { role: 'user', content: '判決 ' + sum.verdict + '：' + log + '\n\n選項：\n' + order.map((x, i) => letters[i] + '. ' + x.name + (x.ops && x.ops.length ? '（' + x.ops.slice(0, 4).map((p) => p.name).join('、') + '）' : '')).join('\n') }];
                    const v = await ask(Stack.wrap(msgs, stack), (x) => (x && letters.indexOf(String(x.fix || '').toUpperCase()) >= 0 ? [] : ['「fix」必須是 ' + letters.join('、') + ' 其中一個']));
                    if (v) c = order[letters.indexOf(String(v.fix).toUpperCase())];
                }
                await writeClass(c, '判決 ' + sum.verdict + '：' + log + '\n目前的程式碼：\n' + clip(codes[c.name], 900) + '\n請修正後重新寫出完整的 class。', false);
                assembleAll(); await judgeAndFix();
                Stack.pop(stack, { summary: '重寫 ' + c.name + ' → ' + sum.verdict });
            }
            Stack.pop(stack, { summary: sum.verdict });
            if (sum.verdict === 'CHECKED') gaps.push('只通過編譯／語法檢查，沒有執行測試驗證行為（verified:false）' + (o.driver ? '' : '；沒有給 driver，所以連執行都沒有'));
            else if (sum.verdict === 'UNAVAILABLE') gaps.push('這台機器沒有 ' + lang + ' 的工具鏈，無法檢查');
            else if (!DONE[sum.verdict]) gaps.push('重寫 ' + rethinks + ' 次後仍是 ' + sum.verdict + '：' + clip(sum.compileLog || sum.detail, 160));
            return result();
        } catch (e) { if (e instanceof Budget) { gaps.push(e.message); return result({ ok: false, reason: 'budget' }); } throw e; }
    }

    return { PLANGS, solveProject, orderClasses, classSpec, assembleProject, verifyClass };
});
