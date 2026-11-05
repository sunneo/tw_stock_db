/* 思考寫程式迴圈（第一階段，純函式，UMD，不碰 I/O；模型與判題器都由呼叫端注入）。設計見 DESIGN.fn-template.md 第八節。
 * 需求 →（UML design 風格的切割）函式清單 → 依呼叫關係由葉往上逐一寫函式 → 組成完整程式 → 判題器驗收 →
 * 沒過就帶著（不洩漏 hidden 的）判決回饋，讓模型用選擇題挑「要修哪個函式」再重寫。每一步都在思考堆疊的框架裡，提示帶焦點標頭。
 *
 *   solve({problem, lang, ask, write, judge, stackMod?, opts?}) → Promise<結果>
 *     ask(messages, validate)  → Promise<通過 validate（回錯誤字串陣列，空＝通過）的 JSON 物件 | null>   切割、挑要修的函式、思考堆疊的檢查／自問
 *     write(messages, {thinking, kind, fn}) → Promise<string | {text}>                                    寫程式：純文字＋程式碼區塊（不要求小模型把程式碼跳脫進 JSON）
 *     judge({lang, source})    → Promise<judge_core.summarize 的結果（CE 帶 compileLog）>                  呼叫端把 problem 綁進去
 *     onEvent(e)：進度回報（{t:'plan'|'ask'|'write'|'judge'|'rethink', …}）；壞掉不影響流程
     *     opts：maxFunctions 6、maxRethink 3、maxCalls 40（ask＋write 總次數）、stackChecks false（開了才用 planChecks／reviewReturn／selfValidate）
 *   結果：{ ok, verdict, source, plan:[{name,signature,purpose,calls}], codes, rethinks, calls:{ask,write,judge}, gaps:[…], reason?, stack:[jsonl…], trace:[…] }
 *   不誠實的事不做：沒過就 ok:false 並列 gaps；預算用完回 reason:'budget'；hidden 測試的輸入與期望不會出現在給模型的任何提示裡。
 * 其他：LANGS、extractCode、assemble、normalizePlan、buildSpec、feedback（單獨匯出，方便測試）。 */
(function (root, factory) { const T = (typeof FaThinkStack !== 'undefined' && FaThinkStack) || (root && root.FaThinkStack) || (typeof require === 'function' ? require('./think_stack.js') : null); const Gd = (typeof FaGuidedWrite !== 'undefined' && FaGuidedWrite) || (root && root.FaGuidedWrite) || (typeof require === 'function' ? require('./guided_write_core.js') : null); const LC = (typeof FaLangColu !== 'undefined' && FaLangColu) || (root && root.FaLangColu) || (typeof require === 'function' ? require('./lang_colu_core.js') : null); if (typeof module === 'object' && module.exports) module.exports = factory(T, Gd, LC); else root.FaCodeLoop = factory(T, Gd, LC); })(typeof self !== 'undefined' ? self : this, function (DefaultStack, Guided, LC) {
    'use strict';
    const clip = (s, n) => { s = String(s == null ? '' : s).replace(/[ \t]+$/gm, '').trim(); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; };
    const IDENT = /^[A-Za-z_]\w*$/;

    // 每種語言：name（給模型看）、entry（入口函式名）、hoist（要搬到檔案最上面並去重的行，只看第 0 欄）、call（組裝時補在最後的入口呼叫）、wrap（把函式包進類別）、rules（寫函式時的語言規則）、stripCall（模型自己寫的入口呼叫要拿掉，我們統一補）、noSplit（不切函式，整個檔案一個節點）
    const LANGS = {
        python: { name: 'Python 3', entry: 'main', hoist: /^(import|from)\s/, call: 'main()', stripCall: /^(main\(\)\s*;?|if\s+__name__\s*==\s*['"]__main__['"]\s*:\s*\n(?:[ \t]+.*\n?)*)\s*$/gm, rules: '用 def 定義；從標準輸入讀（input() 或 sys.stdin），用 print 輸出；import 寫在最前面。' },
        nodejs: { name: 'Node.js', entry: 'main', hoist: /^(const|let|var)\s+\w+\s*=\s*require\(/, call: 'main();', stripCall: /^main\(\)\s*;?\s*$/gm, rules: '用 function 宣告；用 require("fs").readFileSync(0, "utf8") 讀標準輸入、console.log 輸出；require 寫在最前面。' },
        c: { name: 'C', entry: 'main', hoist: /^#include\b/, rules: '標準 C11；入口是 int main(void)；函式要定義在被呼叫之前；整數用 long long；#include 寫在最前面。' },
        cpp: { name: 'C++', entry: 'main', hoist: /^(#include\b|using\s+namespace\b)/, rules: '標準 C++17；入口是 int main()；函式要定義在被呼叫之前；整數用 long long；#include 與 using namespace std; 寫在最前面。' },
        java: { name: 'Java', entry: 'main', hoist: /^import\s/, wrap: (b) => 'public class Main {\n' + b + '\n}\n', rules: '不要寫 class；每個函式都是 public static；入口是 public static void main(String[] args)；import 寫在最前面（例如 java.util.*）。' },
        ruby: { name: 'Ruby', entry: 'main', hoist: /^require\b/, call: 'main', stripCall: /^main\s*$/gm, rules: '用 def 定義；用 gets 讀標準輸入、puts 輸出。' },
        perl: { name: 'Perl', entry: 'main', hoist: /^use\s/, call: 'main();', stripCall: /^main\(\)\s*;?\s*$/gm, rules: '用 sub 定義；用 <STDIN> 讀標準輸入、print 輸出；變數用 my。' },
        bash: { name: 'Bash', entry: 'main', call: 'main', stripCall: /^main(\s+.*)?$/gm, rules: '用 name() { ... } 定義；用 read 讀標準輸入、echo 輸出；整數運算用 $(( ))。' },
        csharp: { name: 'C#', entry: 'Main', hoist: /^using\s/, wrap: (b) => 'class P {\n' + b + '\n}\n', rules: '不要寫 class；每個函式都是 static；入口是 static void Main()；用 Console.ReadLine 讀、Console.WriteLine 輸出；using 寫在最前面。' },
        'asm-x64': { name: 'x86-64 組語（GNU as）', entry: '_start', noSplit: true, rules: '第一行 .intel_syntax noprefix；進入點 _start（.globl _start）；不連 libc，直接用 Linux 系統呼叫（read=0、write=1、exit=60，用 syscall）；結束前一定要 exit。' },
        'asm-x86': { name: 'x86 32 位元組語（GNU as）', entry: '_start', noSplit: true, rules: '第一行 .intel_syntax noprefix；進入點 _start（.globl _start）；不連 libc，用 int 0x80（read=3、write=4、exit=1）；結束前一定要 exit。' }
    };

    function extractCode(text) {
        let s = String(text == null ? '' : (text && text.text != null ? text.text : text)).replace(/<think>[\s\S]*?<\/think>/g, '');
        let m = /```[\w+#.-]*[ \t]*\r?\n([\s\S]*?)```/.exec(s) || /```[\w+#.-]*[ \t]*\r?\n([\s\S]*)$/.exec(s);
        return (m ? m[1] : s).replace(/\s+$/, '') + '\n';
    }

    // 組裝：hoist 的行（去重）放最上面，函式本體依序接上，必要時包進類別、補入口呼叫
    function assemble(lang, codes) {
        const L = LANGS[lang]; const parts = codes.map((c) => String(c));
        if (L.noSplit) return parts.join('\n');
        const hoisted = []; const seen = new Set(); const bodies = [];
        for (let code of parts) {
            if (L.stripCall) code = code.replace(L.stripCall, '');
            const keep = [];
            for (const line of code.split('\n')) { if (L.hoist && L.hoist.test(line)) { const k = line.trim(); if (!seen.has(k)) { seen.add(k); hoisted.push(k); } } else keep.push(line); }
            bodies.push(keep.join('\n').replace(/^\s*\n+/, '').replace(/\s+$/, ''));
        }
        let body = bodies.join('\n\n');
        if (L.wrap) body = L.wrap(body);
        return (hoisted.length ? hoisted.join('\n') + '\n\n' : '') + body + '\n' + (L.call ? '\n' + L.call + '\n' : '');
    }

    // 切割結果整理：名稱合法且不重複、calls 只留存在的、入口函式一定在（沒有就補）、沒人呼叫的函式掛到入口底下、有環或太多就回 null（呼叫端退回單一函式）
    function normalizePlan(obj, entry, maxFunctions) {
        const list = obj && Array.isArray(obj.functions) ? obj.functions : null; if (!list || !list.length) return null;
        const byName = new Map();
        for (const f of list) { if (!f || !IDENT.test(String(f.name || ''))) continue; if (byName.has(f.name)) continue; byName.set(f.name, { name: f.name, signature: clip(f.signature || f.name, 80), purpose: clip(f.purpose || '', 100), calls: Array.isArray(f.calls) ? f.calls.filter((c) => typeof c === 'string') : [], complex: f.complex === true }); }
        if (!byName.size) return null;
        if (!byName.has(entry)) byName.set(entry, { name: entry, signature: entry, purpose: '讀入全部輸入、呼叫其他函式、輸出答案', calls: [], complex: false });
        if (byName.size > maxFunctions) return null;
        for (const n of byName.values()) n.calls = Array.from(new Set(n.calls.filter((c) => byName.has(c) && c !== n.name)));
        const called = new Set(); for (const n of byName.values()) n.calls.forEach((c) => called.add(c));
        const ent = byName.get(entry); for (const n of byName.values()) if (n.name !== entry && !called.has(n.name) && ent.calls.indexOf(n.name) < 0) ent.calls.push(n.name);
        const order = [], state = {}; let cyc = false;
        const visit = (name) => { if (state[name] === 2) return; if (state[name] === 1) { cyc = true; return; } state[name] = 1; for (const c of byName.get(name).calls) visit(c); state[name] = 2; order.push(name); };
        visit(entry); if (cyc) return null;
        return order.map((n) => byName.get(n)); // 被呼叫的在前、入口最後
    }

    function buildSpec(problem) {
        let s = clip(problem.statement, 700);
        const ex = (problem.tests || []).slice(0, 2).map((t) => '輸入：\n' + clip(t.in, 150) + '\n輸出：\n' + clip(t.out, 150)).join('\n');
        return s + (ex ? '\n範例：\n' + ex : '');
    }

    // 給模型的回饋：不洩漏 hidden 的輸入與期望（summarize 的 detail 以 [hidden] 開頭，reason 裡有期望值）
    function feedback(sum, problem) {
        if (!sum || sum.verdict === 'AC') return '';
        if (sum.verdict === 'CE') return '編譯失敗：' + clip(sum.compileLog || sum.detail, 400);
        if (sum.verdict === 'UNAVAILABLE') return '';
        const hiddenFail = /^\[hidden\]/.test(sum.detail || '') || sum.failedIndex >= ((problem.tests || []).length);
        if (hiddenFail) return '範例都過了，但有隱藏測試沒過（判決 ' + sum.verdict + '；內容不公開）。常見原因：邊界情況、整數溢位、效能太慢、輸入格式的特殊情況。';
        const t = (problem.tests || [])[sum.failedIndex];
        return '範例測試 #' + (sum.failedIndex + 1) + ' 判決 ' + sum.verdict + '：' + clip(String(sum.detail || '').replace(/^#\d+\s*/, ''), 200) + (t ? '\n輸入：\n' + clip(t.in, 150) + '\n期望輸出：\n' + clip(t.out, 150) : '');
    }

    function verifyFn(code, node, lang) {
        const c = String(code || '');
        if (c.trim().length < 5) return { ok: false, reason: '沒有程式碼' };
        if (c.indexOf('```') >= 0) return { ok: false, reason: '程式碼裡不能有 ``` 標記' };
        if (!new RegExp('(^|[^A-Za-z0-9_])' + node.name.replace(/[$]/g, '\\$') + '([^A-Za-z0-9_]|$)').test(c)) return { ok: false, reason: '沒有定義函式「' + node.name + '」' };
        return { ok: true };
    }

    // 設計樹的語意給語法修復用：計畫的函式簽名（名稱與引數個數）與已定的設計說明
    function symbolsOfPlan(plan) { const out = {}; for (const n of plan || []) { const m = /\(([^)]*)\)/.exec(String(n.signature || '')); if (m) { const ps = m[1].split(',').map((x) => x.trim()).filter((x) => x && !/^(self|cls|void)$/.test(x)); out[n.name] = ps.length; } else out[n.name] = null; } return out; }
    // 語法修補是對「組裝後的整份程式」做的；對應回各函式的程式碼，之後重新組裝才不會把修補弄丟。純插入新行（沒有舊行可定位）或舊行出現在多個函式裡就對應不回去，回 false
    function patchCodes(codes, oldSrc, newSrc) {
        const A = String(oldSrc).split('\n'), B = String(newSrc).split('\n'); let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
        let sa = A.length, sb = B.length; while (sa > p && sb > p && A[sa - 1] === B[sb - 1]) { sa--; sb--; }
        const oldMid = A.slice(p, sa).join('\n'), newMid = B.slice(p, sb).join('\n'); if (!oldMid.trim()) return false;
        const names = Object.keys(codes).filter((k) => String(codes[k]).indexOf(oldMid) >= 0); if (names.length !== 1) return false;
        codes[names[0]] = codes[names[0]].replace(oldMid, () => newMid); return true;
    }

    class Budget extends Error { }
    const DONE = { AC: 1, CHECKED: 1 }; // AC＝測試全過；CHECKED＝沒有測試可跑、只通過編譯／語法檢查（ok 但 verified:false）

    async function solve(args) {
        const problem = args.problem, lang = args.lang, L = LANGS[lang]; if (!L) throw new Error('不認得的語言：' + lang);
        const Stack = args.stackMod || DefaultStack; const o = Object.assign({ maxFunctions: 6, maxRethink: 3, maxCalls: Infinity, maxDepth: 2, /* 開發期間不設上限（使用者要求），profile 後再訂 */ stackChecks: false, }, args.opts || {});
        const calls = { ask: 0, write: 0, judge: 0, choose: 0, free: 0, rank: 0 }, trace = [], gaps = [];
        const note = (e) => { trace.push(e); if (typeof args.onEvent === 'function') { try { args.onEvent(e); } catch (_) { /* 進度回報壞了不影響流程 */ } } };
        const spend = (k) => { if (calls.ask + calls.write >= o.maxCalls) throw new Budget('呼叫次數用完（' + o.maxCalls + '）'); calls[k]++; };
        const ask = args.ask ? async (msgs, validate, opts2) => { spend('ask'); const v = await args.ask(msgs, validate, opts2); note({ t: 'ask', ok: !!v }); return v; } : null;
        const write = async (msgs, meta) => { spend('write'); const v = await args.write(msgs, meta); note({ t: 'write', fn: meta && meta.fn, thinking: !!(meta && meta.thinking), kind: meta && meta.kind }); return v; };
        const stack = Stack.create(clip(problem.title ? problem.title + '：' + problem.statement : problem.statement, 200), { maxDecisions: 12, maxHeaderChars: 900 });
        const spec = buildSpec(problem);
        let plan = [], codes = {}, rethinks = 0, sum = null, source = '', reviews = null;
        const result = (extra) => Object.assign({ ok: !!(sum && DONE[sum.verdict]), verified: !!(sum && sum.verdict === 'AC'), verdict: sum ? sum.verdict : 'NONE', source, plan, codes, rethinks, calls, gaps, trace, edits: fixEdits, stack: Stack.toJsonl(stack) }, extra || {});
        const fixEdits = [];
        const assembleAll = () => { source = assemble(lang, plan.map((n) => codes[n.name] || '')); return source; };
        const judgeNow = async () => { calls.judge++; sum = await args.judge({ lang, source }); note({ t: 'judge', verdict: sum.verdict, detail: clip(sum.detail, 120) }); return sum; };
        // 判題；編譯失敗（CE）時先讓程式修語法（不花模型呼叫；有 args.repair 才做），修好再判一次，並把修補對應回函式的程式碼
        const judgeAndFix = async () => {
            await judgeNow();
            if (sum.verdict === 'CE' && typeof args.repair === 'function' && o.syntaxFix !== false) {
                let r = null; try { r = await args.repair({ lang, source, ask, semantic: { symbols: symbolsOfPlan(plan), hints: plan.map((x) => '函式 ' + x.signature + (x.purpose ? '：' + x.purpose : '')) }, wrap: (m) => Stack.wrap(m, stack) }); } catch (e) { if (e instanceof Budget) throw e; r = null; }
                if (r && r.ok && r.source !== source) {
                    note({ t: 'syntax_fixed', edits: (r.edits || []).length, tried: r.tried }); fixEdits.push(...(r.edits || [])); const mapped = patchCodes(codes, source, r.source); source = r.source;
                    if (!mapped) gaps.push('語法修補只套用在組裝後的程式，沒有對應回函式（之後重寫其他函式時可能再出現）');
                    await judgeNow();
                }
            }
            return sum;
        };
        try {
            Stack.push(stack, { path: 'program', question: '用 ' + L.name + ' 寫出符合題目的完整程式', note: '切割→逐函式→驗收' });

            // 1. 切割（UML design 風格）。組語等不切；問不出來或結果不合用就退回單一入口函式
            const splitMsgs = (entryName, root, subOf) => [{ role: 'system', content: '你是軟體設計者。把題目切成幾個小函式，只輸出 JSON：{"functions":[{"name":"函式名","signature":"簽名","purpose":"一句話","calls":["它會呼叫的函式名"],"complex":false}]}。必須有函式「' + entryName + '」，負責' + (root ? '讀入全部輸入並輸出答案' : '把其他小函式串起來完成它的工作') + '。簡單的題目只要一個函式就好，不要切得太碎；某個函式還是很複雜才把它的 complex 填 true。' }, { role: 'user', content: spec + (subOf ? '\n\n現在要切的函式：' + subOf.name + (subOf.purpose ? '：' + subOf.purpose : '') + '（只切這一個）' : '') }];
            const SPLIT_OK = (x) => (x && Array.isArray(x.functions) && x.functions.length ? [] : ['「functions」必須是非空陣列']);
            // 巢狀：標了 complex 的函式再問一次切法（最多 o.maxDepth 層、名稱不可和別的函式衝突、有環或太多就保持原樣）
            const expand = async (list, depth) => {
                if (!ask || depth >= o.maxDepth) return list;
                const known = new Set(plan.concat(list).map((x) => x.name)); const out = [];
                for (const node of list) {
                    if (!node.complex || node.name === L.entry) { out.push(node); continue; }
                    Stack.push(stack, { path: 'split:' + node.name, question: '把函式 ' + node.name + ' 再切小（最多 ' + o.maxFunctions + ' 個）', note: '第 ' + (depth + 1) + ' 層' });
                    const v = await ask(Stack.wrap(splitMsgs(node.name, false, node), stack), SPLIT_OK); const sub = v ? normalizePlan(v, node.name, o.maxFunctions) : null;
                    const clash = sub && sub.some((x) => x.name !== node.name && known.has(x.name));
                    if (sub && sub.length > 1 && !clash) { sub.forEach((x) => known.add(x.name)); const comp = sub[sub.length - 1]; comp.complex = false; comp.depth = depth + 1; const kids = await expand(sub.slice(0, -1).map((x) => Object.assign(x, { depth: depth + 1 })), depth + 1); Stack.pop(stack, { summary: '切成 ' + sub.length + ' 個' }); out.push(...kids, comp); }
                    else { Stack.pop(stack, { summary: '不再切' }); node.complex = false; out.push(node); if (v && (clash || (sub && sub.length <= 1))) gaps.push('函式 ' + node.name + '：再切的結果不能用（' + (clash ? '名稱衝突' : '沒有切開') + '），維持單一函式'); }
                }
                return out;
            };
            if (L.noSplit) plan = [{ name: L.entry, signature: L.entry, purpose: '整個程式', calls: [], complex: false }];
            else {
                let norm = null;
                if (ask) {
                    Stack.push(stack, { path: 'split', question: '把題目切成幾個小函式（最多 ' + o.maxFunctions + ' 個）' });
                    const v = await ask(Stack.wrap(splitMsgs(L.entry, true), stack), SPLIT_OK);
                    norm = v ? normalizePlan(v, L.entry, o.maxFunctions) : null;
                    if (norm) { plan = norm; norm = await expand(norm, 0); }
                    Stack.pop(stack, { summary: norm ? norm.length + ' 個函式' : '用單一函式' });
                }
                plan = norm || [{ name: L.entry, signature: L.entry, purpose: '讀入全部輸入並輸出答案', calls: [], complex: false }];
                if (!norm) gaps.push('切割：沒有取得可用的函式清單，退回單一入口函式');
            }
            note({ t: 'plan', functions: plan.map((x) => x.name) });
            for (const n of plan) Stack.decide(stack, '函式 ' + n.signature + (n.purpose ? '：' + n.purpose : ''));

            if (o.stackChecks && ask && plan.length > 1) await Stack.planChecks(stack, { ask, next: '逐一寫出每個函式', defaults: [{ check: '每個被呼叫的函式都有寫出來', standard: '函式清單裡每一項都有定義' }, { check: '簽名與清單一致', standard: '名稱與參數個數相同' }] });

            // 2. 由葉往上逐函式寫
            const listText = () => plan.map((n) => '- ' + n.signature + (n.purpose ? '：' + n.purpose : '')).join('\n');
            // 這個語言的 CoLU 集合決定怎麼寫：有文法且給了 choose（選擇題）→ 文法算出合法 token、模型（開思考）做選擇題；否則模型自由寫（只給沒有文法的語言，或沒有 choose 的呼叫端）
            const colu = LC ? LC.get(lang) : null; const writerMode = o.writeMode || (colu ? colu.writer.mode : 'free');
            const guidedOn = writerMode === 'guided' && !!(Guided && colu && colu.grammar && (typeof args.choose === 'function' || (args.lm && typeof args.lm.open === 'function')));
            const RULES_TEXT = (colu && colu.rules) || L.rules; // 規則文字取自這個語言自己的 CoLU 集合
            const countedChoose = typeof args.choose === 'function' ? async (m, opts2) => { calls.choose++; return args.choose(m, opts2); } : undefined;
            const countedFree = args.free ? async (m, kind) => { calls.free++; return args.free(m, kind); } : undefined;
            const guidedWrite = async (node, extra, thinking) => {
                const r = await Guided.guidedWriteFunction({ lang, spec, node, plan, symbols: symbolsOfPlan(plan), choose: countedChoose, free: countedFree, lm: args.lm, rules: RULES_TEXT, langLabel: (colu && colu.label) || L.name, stack, stackMod: Stack, feedback: extra || '', opts: Object.assign({ allowInlineAsm: !!o.allowInlineAsm, strategy: o.guidedStrategy }, o.guided || {}), onEvent: (e) => { if (e.t === 'pick' || e.t === 'auto') note({ t: 'token', fn: node.name, kind: e.kind || 'auto', text: e.text || e.token }); } });
                note({ t: 'guided', fn: node.name, ok: r.ok, reason: r.reason, choose: r.calls && r.calls.choose, free: r.calls && r.calls.free, rank: r.calls && r.calls.rank, tokens: r.tokens });
                if (!r.ok) { gaps.push('函式 ' + node.name + '：文法引導寫作沒完成（' + r.reason + (r.detail ? '：' + r.detail : '') + '），改成模型自由寫'); return null; }
                return (r.imports && r.imports.length ? r.imports.join('\n') + '\n' : '') + r.code;
            };
            const writeFn = async (node, extra, thinking) => {
                Stack.push(stack, { path: 'fn:' + node.name, question: (extra ? '重寫函式 ' : '寫函式 ') + node.name + (node.purpose ? '：' + node.purpose : '') });
                let reason = extra || '', selfTried = false, code = '', failed = false, triedGuided = false;
                for (;;) {
                    const entryNote = node.calls && node.calls.length ? '它負責串起這些函式：' + node.calls.join('、') + (node.name === L.entry ? '，並讀入全部輸入、輸出答案。' : '。') : '';
                    const msgs = [{ role: 'system', content: '你是' + L.name + '程式設計師，正在分步寫一個程式。只輸出一個程式碼區塊，裡面只有函式「' + node.name + '」的完整定義，不要其他函式、不要說明。' + RULES_TEXT }, { role: 'user', content: spec + (plan.length > 1 ? '\n\n函式清單（已定，簽名不要改）：\n' + listText() : '') + '\n\n現在寫：' + node.name + (node.purpose ? '（' + node.purpose + '）' : '') + '。' + entryNote + (reason ? '\n' + reason : '') }];
                    let g = null; if (guidedOn && !triedGuided) { triedGuided = true; g = await guidedWrite(node, reason, thinking); } // 每次寫（含重寫）各試一次引導；重寫帶著失敗回饋，題目的上下文已經不同
                    code = g != null ? g : extractCode(await write(Stack.wrap(msgs, stack, { repeat: !!thinking }), { thinking: !!thinking, kind: extra ? 'rewrite' : 'write', fn: node.name }));
                    if (o.stackChecks && ask && !selfTried) { selfTried = true; const sv = await Stack.selfValidate(stack, { ask, result: code }); if (sv && sv.ok === false && !sv.unsure) { reason = '自問發現缺：' + sv.missing; continue; } }
                    const r = Stack.pop(stack, { summary: '已寫好，約 ' + code.split('\n').length + ' 行', result: code, verify: (c) => verifyFn(c, node, lang) });
                    if (r.ok) { failed = !!r.frame.failed; break; }
                    reason = '上次的問題：' + r.reason;
                }
                if (failed) gaps.push('函式 ' + node.name + '：產生的程式碼沒通過基本檢查');
                codes[node.name] = code; return code;
            };
            for (const n of plan) await writeFn(n, '', false);

            if (o.stackChecks && ask && plan.length > 1) { reviews = await Stack.reviewReturn(stack, { ask, returned: '全部 ' + plan.length + ' 個函式' }); if (reviews && reviews.problems && reviews.problems.length) gaps.push('回來核對：' + reviews.problems.map((p) => p.check + '→' + p.fix).join('；')); }

            // 3. 驗收；沒過就選擇題挑要修的函式、重寫（這一輪才開 thinking）
            assembleAll(); await judgeAndFix();
            while (!DONE[sum.verdict] && sum.verdict !== 'UNAVAILABLE' && rethinks < o.maxRethink) {
                rethinks++; note({ t: 'rethink', n: rethinks, verdict: sum.verdict });
                const fb = feedback(sum, problem);
                Stack.push(stack, { path: 'rethink#' + rethinks, question: '程式判決 ' + sum.verdict + '，要修哪個函式？', note: clip(fb.split('\n')[0], 100) });
                let node = plan[plan.length - 1];
                if (plan.length > 1 && ask) {
                    const letters = plan.map((_, i) => String.fromCharCode(65 + i));
                    const msgs = [{ role: 'system', content: '你在除錯。只輸出 JSON：{"fix":"字母"}，選一個最可能有錯的函式。' }, { role: 'user', content: fb + '\n\n選項：\n' + plan.map((n, i) => letters[i] + '. ' + n.name + (n.signature && n.signature !== n.name ? '　' + n.signature : '') + (n.purpose ? '：' + n.purpose : '')).join('\n') }];
                    const v = await ask(Stack.wrap(msgs, stack), (x) => (x && letters.indexOf(String(x.fix || '').toUpperCase()) >= 0 ? [] : ['「fix」必須是 ' + letters.join('、') + ' 其中一個']));
                    if (v) node = plan[letters.indexOf(String(v.fix).toUpperCase())];
                }
                const extra = fb + '\n目前的函式程式碼：\n' + clip(codes[node.name], 800) + '\n請修正後重新寫出完整函式。';
                await writeFn(node, extra, false);
                assembleAll(); await judgeAndFix();
                Stack.pop(stack, { summary: '重寫 ' + node.name + ' → ' + sum.verdict });
            }
            Stack.pop(stack, { summary: sum.verdict });
            if (sum.verdict === 'CHECKED') gaps.push('只通過編譯／語法檢查，沒有測試驗證行為（verified:false）');
            else if (!DONE[sum.verdict]) gaps.push(sum.verdict === 'UNAVAILABLE' ? '這台機器沒有 ' + lang + ' 的工具鏈，無法驗收' : '重寫 ' + rethinks + ' 次後仍是 ' + sum.verdict + '：' + clip(feedback(sum, problem).split('\n')[0], 160));
            return result(reviews ? { reviews } : null);
        } catch (e) {
            if (e instanceof Budget) { gaps.push(e.message); return result({ ok: false, reason: 'budget' }); }
            throw e;
        }
    }

    return { LANGS, solve, patchCodes, symbolsOfPlan, assemble, extractCode, normalizePlan, buildSpec, feedback, verifyFn };
});
