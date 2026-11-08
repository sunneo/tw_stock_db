/* 寫程式的統一入口（第一階段，純函式，UMD；模型、判題器、檢查器都是注入的）：宿主（`write_code` 工具）、CoLU（`local_write_code`／`local_write_project`）、基準腳本都走這裡。
 *   detectLang(text, fallback)                  從使用者的話判斷語言（c++／c#／javascript 先於 c／java 判斷）
 *   makeBackend({generate, R?, askTokens?, writeTokens?}) → {ask, write, choose, free, lm?}   （write_code 領域一律不開思考）
  *       choose／free：文法引導寫作用的選擇題與「新名稱／數字／字串」（不開思考）。
 *       generate(req)→string 是宿主的小模型呼叫（req：{messages,maxTokens,prefill,enableThinking,timeoutMs}）；
 *       ask＝jsonStep 包起來（回通過 validate 的 JSON 或 null，不累積歷史）；write＝純文字（不用 JSON，小模型不必把程式碼跳脫）。thinking：{enabled,maxTokens,timeoutMs}，只在「重寫」那一輪才會用。
 *   routeOf(text, {tests}) → {route:'direct'|'uml', score, ambiguous, reasons}   使用者只丟需求，這裡（程式端）判斷要不要先設計 UML
 *   runCode({text, lang, model?, source?, problem, driver, design?, route?, generate|backend, judge, check, stackMod, opts, onEvent}) → Promise<結果>
 *       source（任意現有程式碼）→ edit 模式。否則由 routeOf 決定：偏大 → design({text,lang}) 設計 UML → 專案模式（code_project_core）；設計不了／語言不支援／判成單純 → 題目模式（code_loop_core）。
 *       呼叫端不需要（也不應該）自己區分；model（已有 UML）、route 是進階覆寫。problem 有 tests 且給 judge → 用判題器（verified:true 才算驗證過行為）；
 *       沒有測試 → 只用 check（只編譯／語法檢查，verdict:CHECKED，verified:false）。判題器與檢查器都沒給 → 回 ok:false，不假裝驗證過。
 *   formatReport(res) → 給使用者看的中文摘要（一定寫出驗證到哪裡、有哪些 gaps）
 * 設計見 DESIGN.fn-template.md 第八節。 */
(function (root, factory) {
    const R = (typeof FaRecipe !== 'undefined' && FaRecipe) || (root && root.FaRecipe) || (typeof require === 'function' ? require('./recipe_core.js') : null);
    const T = (typeof FaThinkStack !== 'undefined' && FaThinkStack) || (root && root.FaThinkStack) || (typeof require === 'function' ? require('./think_stack.js') : null);
    const Fix = (typeof FaSyntaxFix !== 'undefined' && FaSyntaxFix) || (root && root.FaSyntaxFix) || (typeof require === 'function' ? require('./syntax_fix_core.js') : null);
    const Ed = (typeof FaCodeEdit !== 'undefined' && FaCodeEdit) || (root && root.FaCodeEdit) || (typeof require === 'function' ? require('./code_edit_core.js') : null);
    const L = (typeof FaCodeLoop !== 'undefined' && FaCodeLoop) || (root && root.FaCodeLoop) || (typeof require === 'function' ? require('./code_loop_core.js') : null);
    const P = (typeof FaCodeProject !== 'undefined' && FaCodeProject) || (root && root.FaCodeProject) || (typeof require === 'function' ? require('./code_project_core.js') : null);
    if (typeof module === 'object' && module.exports) module.exports = factory(R, T, L, P, Fix, Ed);
    else root.FaCodeAgent = factory(R, T, L, P, Fix, Ed);
})(typeof self !== 'undefined' ? self : this, function (R, T, Loop, Proj, Fix, Ed) {
    'use strict';
    // 離線組合每一層的結果（buildFromUML 的 rounds：{by, ok, tried, reason}）摘成一行「卡在哪一層」：配方→課→範式（試 N 個）→矩陣→區塊
    const ROUND_NAME = { recipe: '配方', lesson: '課', paradigm: '範式', matrix: '矩陣', blocks: '區塊迴圈' };
    const roundsNote = (rounds) => (Array.isArray(rounds) ? rounds : []).filter((r) => r && r.by).map((r) => (ROUND_NAME[r.by] || r.by) + (r.ok ? '✔' : '✘') + (r.tried ? '(試 ' + r.tried + ' 個)' : '') + (!r.ok && r.reason ? '：' + String(r.reason).replace(/\s+/g, ' ').slice(0, 30) : '')).join('→');
    const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; };

    function detectLang(text, fallback) {
        const s = String(text || '');
        const rules = [['csharp', /c#|c\s*sharp|csharp|\.net\b/i], ['cpp', /c\+\+|cpp\b/i], ['nodejs', /node\.?js|javascript|\bjs\b|typescript/i], ['java', /\bjava\b(?!\s*script)/i], ['python', /python|\bpy\b|python3/i], ['ruby', /\bruby\b/i], ['perl', /\bperl\b/i], ['bash', /\bbash\b|shell\s*script|shell 腳本|\bsh\b/i], ['asm-x86', /(x86(?!-?64)|32\s*位元|32-?bit|i386)[^]{0,12}(組語|assembly|asm)|(組語|assembly|asm)[^]{0,12}(x86(?!-?64)|32\s*位元|32-?bit)/i], ['asm-x64', /組語|assembly|\basm\b|x86-?64|x64/i], ['c', /(^|[^A-Za-z+#])c\s*語言|\bc\s*language\b|(用|寫|使用|以)\s*c\s*(寫|語|程式|來|實作|$)|\bANSI C\b/i]];
        for (const [lang, re] of rules) if (re.test(s)) return lang;
        return fallback || 'python';
    }

    // 從程式碼本身猜語言（拿到任意程式碼、使用者沒說語言時用）；猜不出來回 null，不亂猜
    function detectLangFromCode(code) {
        const s = String(code || ''); const first = s.split('\n', 1)[0];
        if (/^#!.*\b(python)/.test(first)) return 'python'; if (/^#!.*\b(node)/.test(first)) return 'nodejs'; if (/^#!.*\b(ruby)/.test(first)) return 'ruby'; if (/^#!.*\bperl/.test(first)) return 'perl'; if (/^#!.*\b(ba)?sh\b/.test(first)) return 'bash';
        if (/\.intel_syntax|^\s*\.globl\s+_start|^_start:/m.test(s)) return /\b(int\s+0x80|eax|ebx)\b/.test(s) && !/\b(rax|rdi|syscall)\b/.test(s) ? 'asm-x86' : 'asm-x64';
        if (/^\s*using\s+System\b|\bConsole\.(WriteLine|ReadLine)\b|\bnamespace\s+\w+/m.test(s)) return 'csharp';
        if (/\bpublic\s+static\s+void\s+main\s*\(|^\s*import\s+java\.|\bSystem\.out\.print/m.test(s)) return 'java';
        if (/#include\s*<(iostream|vector|string|map|algorithm)>|\bstd::|using\s+namespace\s+std/.test(s)) return 'cpp';
        if (/#include\s*<\w+\.h>|^\s*int\s+main\s*\(/m.test(s)) return 'c';
        if (/^\s*def\s+\w+\s*\(.*\)\s*:|^\s*import\s+\w+\s*$|^\s*from\s+\w+\s+import\b|^\s*print\(/m.test(s)) return 'python';
        if (/\bconsole\.log\(|\brequire\(|^\s*(const|let)\s+\w+\s*=|=>\s*[{(]|^\s*function\s+\w+\s*\(/m.test(s)) return 'nodejs';
        if (/^\s*use\s+(strict|warnings)\b|^\s*sub\s+\w+\s*\{|\bmy\s+[$@%]\w+/m.test(s)) return 'perl';
        if (/^\s*def\s+\w+[^:]*$|\bputs\s|^\s*end\s*$/m.test(s)) return 'ruby';
        if (/^\s*(if|while|for)\b.*;\s*(then|do)\b|^\s*fi\s*$|\becho\s|^\s*\w+\(\)\s*\{/m.test(s)) return 'bash';
        return null;
    }

    // ---- 路由：使用者只丟需求，這裡決定「直接切成函式寫」還是「先設計 UML、再逐類別寫」 ----
    // 程式先用規模信號評分（系統／平台／多個功能句／多個領域名詞／條列 → 偏 UML；函式／演算法／輸入輸出／有測試／很短 → 偏直接）；
    // 分數落在模糊帶才讓模型做一題選擇題（沒有 ask 就選直接寫：比較便宜，也不會憑空設計出一堆類別）。
    function routeOf(text, o) {
        o = o || {}; const s = String(text || ''); const reasons = []; let u = 0, d = 0;
        const strong = (s.match(/管理系統|系統|平台|網站|後台|微服務|\bplatform\b/gi) || []).length; if (strong) { u += Math.min(strong, 2) * 2; reasons.push('提到系統／平台 ' + strong + ' 次'); }
        const weak = (s.match(/專案|架構|模組|資料庫|CRUD|物件導向|類別|使用案例|user story|應用程式|\bAPI\b|\bapp\b/gi) || []).length; if (weak) { u += Math.min(weak, 3); reasons.push('提到架構類的詞 ' + weak + ' 次'); }
        const can = (s.match(/可以|能夠|要能|需要能|支援|提供|功能|允許/g) || []).length; if (can >= 3) { u += 2; reasons.push('列了 ' + can + ' 個功能'); } else if (can >= 2) { u += 1; reasons.push('列了 ' + can + ' 個功能'); }
        const nouns = new Set(s.match(/登入|註冊|訂單|購物車|庫存|會員|報表|帳號|權限|付款|預約|借書|商品|使用者|客戶|通知|排程/g) || []); if (nouns.size >= 3) { u += 2.5; reasons.push('涉及 ' + nouns.size + ' 個領域名詞'); } else if (nouns.size >= 2) { u += 1.5; reasons.push('涉及 ' + nouns.size + ' 個領域名詞'); }
        const sentences = s.split(/[。.!?！？\n]/).map((x) => x.trim()).filter(Boolean); if (sentences.length >= 4) { u += 1.5; reasons.push(sentences.length + ' 句需求'); } if (s.length >= 200) { u += 1; reasons.push('需求很長（' + s.length + ' 字）'); }
        const bullets = (s.match(/^\s*(?:[-*•]|\d+[.)、])\s+/gm) || []).length; if (bullets >= 3) { u += 1.5; reasons.push('條列 ' + bullets + ' 項'); }
        if (/函式|函數|function|演算法|algorithm|leetcode|\bACM\b|題目|排序|二分|反轉|陣列|字串|回文|質數|最大公因數|費氏|遞迴|動態規劃|\bBFS\b|\bDFS\b|標準輸入|stdin/i.test(s)) { d += 2; reasons.push('像演算法／函式題'); }
        if (/輸入[^]{0,40}輸出|input[^]{0,40}output/i.test(s)) { d += 2; reasons.push('有輸入輸出規格'); }
        if (o.tests) { d += 2; reasons.push('附了測試'); }
        // 短與句數少只在「沒有系統／多功能信號」時才當作偏直接的證據（一句話也能描述一整個系統）
        if (u < 2) { if (s.length <= 80) { d += 1; reasons.push('需求很短'); } if (sentences.length <= 2) d += 1; }
        const score = +(u - d).toFixed(2); const route = score >= 3 ? 'uml' : 'direct'; return { route, score, ambiguous: score > 0.5 && score < 3, reasons, by: 'program' };
    }

    function makeBackend(o) {
        o = o || {}; const gen = o.generate; const Rc = o.R || R; if (typeof gen !== 'function') throw new Error('makeBackend 需要 generate');
        // write_code 領域一律不開思考（使用者決定：實測開思考每題 20～50 秒、格式反而更不穩、沒有更準）。generate 的 enableThinking 一律明說 false，不靠預設值
        return {
            // 有 KV 快取游標的後端（原生評估適配器）才有 lm：約束解碼 rank 策略用
            lm: typeof gen.openCursor === 'function' ? { open: (msgs, prefix) => gen.openCursor(msgs, prefix) } : undefined,
            // jsonStep 自己會處理 prefill、退回重問；堆疊標頭由迴圈放進 messages，這裡不再傳 stack（避免標頭放兩次）
            async ask(messages, validate) {
                const r = await Rc.jsonStep({ generate: gen, messages, validate, maxTries: 2, maxTokens: o.askTokens || 400, prefill: '{"' });
                return r && r.ok ? r.value : null;
            },
            // 選擇題：合法選項由文法算好（機械過濾），模型只挑字母（或選項內容）。不開思考。回傳選到的索引，沒答出來回 null
            async choose(messages, options) {
                const letters = options.map((x) => x.label); const pickIdx = (v) => { const p = String(v == null ? '' : v).trim(); const li = letters.indexOf(p.toUpperCase()); if (li >= 0) return li; const bare = p.replace(/[`'"]/g, '').trim(); if (!bare) return -1; for (let i = 0; i < options.length; i++) if ((options[i].aliases || []).some((al) => al === bare || al === p)) return i; return -1; }; // 字母優先；其次是「選項內容」（別名）
                const r = await Rc.jsonStep({ generate: gen, messages, validate: (x) => (pickIdx(x.pick) >= 0 ? [] : ['「pick」必須是 ' + letters.join('、') + ' 其中一個字母（或選項的內容）']), maxTries: 2, maxTokens: o.chooseTokens || 40, prefill: '{"pick":"' });
                return r && r.ok ? pickIdx(r.value.pick) : null;
            },
            // 新名稱／數字／字串內容：一小段文字（不開思考，便宜）；驗證由呼叫端（引導寫作）做
            async free(messages, kind) {
                const key = kind === 'name' ? 'name' : kind === 'num' ? 'num' : 'text';
                const r = await Rc.jsonStep({ generate: gen, messages, validate: (x) => (x && x[key] != null && String(x[key]).length <= 200 ? [] : ['「' + key + '」必須是 200 字以內的字串']), maxTries: 2, maxTokens: o.freeTokens || 60, prefill: '{"' + key + '":"' });
                return r && r.ok ? String(r.value[key]) : null;
            },
            async write(messages, meta) {
                const req = { messages, maxTokens: o.writeTokens || 800, enableThinking: false };
                const raw = await gen(req); return typeof raw === 'string' ? raw : (raw && raw.text) || '';
            }
        };
    }

    // 離線沒解出來的各層結果要留到最終結果的 gaps（後面的路線會整個換掉 gaps，所以在最外層補回去）
    async function runCode(a) {
        const kept = []; const a2 = a && typeof a.offline === 'function' ? Object.assign({}, a, { offline: async (x) => { const o = await a.offline(x); if (o && !o.ok) kept.push('離線組合沒解出來（' + clip(o.reason || '不明', 100) + '）' + (roundsNote(o.rounds) ? '；各層：' + clip(roundsNote(o.rounds), 200) : '') + (o.stuckAt ? '；卡在「' + o.stuckAt + '」' : '')); return o; } }) : a;
        const r = await runCode0(a2); if (r && kept.length) r.gaps = kept.concat((r.gaps || []).filter((g) => kept.indexOf(g) < 0 && !/^離線組合沒解出來/.test(g))); return r;
    }
    async function runCode0(a) {
        const lang = a.lang || (a.source ? (detectLangFromCode(a.source) || detectLang(a.text, 'python')) : detectLang(a.text, 'python')); const backend = a.backend || (a.generate ? makeBackend({ generate: a.generate, R, askTokens: a.askTokens, writeTokens: a.writeTokens }) : null);
        const base = { ok: false, verified: false, lang, gaps: [], calls: { ask: 0, write: 0, judge: 0 }, source: '' };
        const stackMod = a.stackMod || T; const opts = a.opts || {};
        const hasTestsFor = (p) => !!(p && p.tests && p.tests.length && a.judge);
        const makeRepair = (problem) => (a.check && Fix ? ({ lang: l, source, ask, semantic, wrap }) => Fix.repairSyntax({ lang: l, source, ask, semantic, wrap, check: a.check, verify: hasTestsFor(problem) ? async ({ source: sx }) => (await a.judge({ lang: l, source: sx, problem })).verdict === 'AC' : null }) : null);
        if (a.source != null) { // 從任意拿到的程式碼接續：先修語法、再（有測試時）修行為；模型只在要重寫函式時才用
            const problem = a.problem || null; const e = await Ed.editCode({ source: String(a.source), lang, goal: a.text, problem, check: a.check, judge: a.judge, ask: backend && backend.ask, write: backend && backend.write, repair: makeRepair(problem) || undefined, stackMod, opts, onEvent: a.onEvent });
            return Object.assign(e, { mode: 'edit', lang });
        }
        // 離線組合（Python）：uml_design → 配方／課／範式骨架 → 區塊迴圈 → 沙盒，由宿主注入 offline({text, lang, problem}) → {ok, source, verdict, ...}；要有測試與判題器才試，通過就不用模型，沒過就往下走模型路線
        const offlineGaps = []; let offlineHeader = ''; // 缺口 C：離線思考堆疊的標頭（FaOfflineStack.modelHeader），有的話取代 roundsNote 單行字串交給模型
        if (typeof a.offline === 'function' && !a.model && lang === 'python' && a.problem && a.problem.tests && a.problem.tests.length && a.judge) {
            let o = null; try { o = await a.offline({ text: a.text, lang, problem: a.problem, backend }); } catch (e) { offlineGaps.push('離線組合出錯：' + clip((e && e.message) || e, 100)); }
            if (o && o.ok && o.source && (o.verdict === 'AC')) { if (typeof a.onEvent === 'function') { try { a.onEvent({ t: 'offline', by: o.by, paradigm: o.paradigm, tried: o.tried }); } catch (_) { /* 進度回報壞了不影響流程 */ } } return Object.assign(base, { ok: true, verified: o.verified !== false, verdict: 'AC', mode: 'offline', source: o.source, offline: { rounds: Array.isArray(o.rounds) ? o.rounds : null, by: o.by, paradigm: o.paradigm || null, slots: o.slots || null, lesson: o.lesson || null, recipe: o.recipe || null, matrix: o.matrix || null, onlyExamples: !!o.onlyExamples, tried: o.tried || 0, usedModel: !!o.usedModel }, calls: Object.assign({}, base.calls, { judge: o.tried || 1 }) }); }
            if (o && !o.ok) { offlineGaps.push('離線組合沒解出來（' + clip(o.reason || '不明', 100) + '）' + (roundsNote(o.rounds) ? '；各層：' + clip(roundsNote(o.rounds), 200) : '') + (o.stuckAt ? '；卡在「' + o.stuckAt + '」' : '') + '，改用模型'); if (o.stackHeader) offlineHeader = String(o.stackHeader); }
        }
        base.gaps = base.gaps.concat(offlineGaps);
        if (!backend) return Object.assign(base, { mode: a.model ? 'project' : 'problem', verdict: 'NONE', reason: 'no_model', gaps: ['沒有可用的模型（generate 或 backend）'] });
        let model = a.model || null, route = null, designed = null; const preGaps = [];
        if (!model) {
            route = a.route ? { route: a.route === 'uml' ? 'uml' : 'direct', by: 'caller', reasons: [], score: null } : routeOf(a.text, { tests: !!(a.problem && a.problem.tests && a.problem.tests.length) });
            if (!a.route && route.ambiguous && backend && backend.ask) { // 模糊帶：讓模型挑
                const msgs = [{ role: 'system', content: '你在決定寫程式的做法。只輸出 JSON：{"pick":"A 或 B"}。' }, { role: 'user', content: '需求：' + clip(a.text, 500) + '\n\nA. 單純：直接切成幾個函式寫\nB. 有多個實體與功能：先設計 UML（類別與關係），再逐類別實作' }];
                let v = null; try { v = await backend.ask(msgs, (x) => (x && /^[AB]$/i.test(String(x.pick || '')) ? [] : ['「pick」必須是 A 或 B'])); } catch (_) { v = null; }
                if (v) route = Object.assign({}, route, { route: String(v.pick).toUpperCase() === 'B' ? 'uml' : 'direct', by: 'model' }); else preGaps.push('路線判斷：需求規模落在模糊帶、模型沒回答，選了比較便宜的「直接寫」');
            }
            if (route.route === 'uml') {
                if (!Proj || !Proj.PLANGS[lang]) { preGaps.push('這個需求偏大，但專案模式不支援 ' + lang + '，改直接切成函式寫'); route = Object.assign({}, route, { route: 'direct', fallback: 'lang' }); }
                else if (typeof a.design !== 'function') { preGaps.push('這個需求偏大，但這個環境沒有 UML 設計能力，改直接切成函式寫'); route = Object.assign({}, route, { route: 'direct', fallback: 'no_design' }); }
                else {
                    let d = null; try { d = await a.design({ text: a.text, lang }); } catch (e) { d = { ok: false, error: String((e && e.message) || e) }; }
                    if (d && d.ok !== false && d.model && d.model.classes && d.model.classes.length) { model = d.model; designed = { dsl: d.dsl || '', classes: d.model.classes.map((c) => c.name), warnings: d.warnings || [] }; if (d.warnings && d.warnings.length) preGaps.push('UML 設計有 ' + d.warnings.length + ' 個警告：' + clip(d.warnings.slice(0, 2).join('；'), 120)); if (a.problem && a.problem.tests && a.problem.tests.length) preGaps.push('有給測試，但專案模式沒有進入點程式碼，測試沒有被執行（只做了編譯檢查）'); }
                    else { preGaps.push('先設計 UML 沒成功（' + clip((d && (d.error || (d.warnings && d.warnings[0]))) || '沒有類別', 100) + '），改直接切成函式寫'); route = Object.assign({}, route, { route: 'direct', fallback: 'design_failed' }); }
                }
            }
        }
        if (route && typeof a.onEvent === 'function') { try { a.onEvent({ t: 'route', route: model ? 'uml' : 'direct', by: route.by, score: route.score, reasons: route.reasons, fallback: route.fallback }); } catch (_) { /* 進度回報壞了不影響流程 */ } }
        const withRoute = (r) => { r.route = route ? { route: model ? 'uml' : 'direct', by: route.by, score: route.score, reasons: route.reasons, fallback: route.fallback } : undefined; if (designed) r.design = designed; if (preGaps.length) r.gaps = (preGaps).concat(r.gaps || []); return r; };
        if (model) {
            const driver = a.driver || '';
            const useJudge = !!(a.problem && a.problem.tests && a.problem.tests.length && driver && a.judge);
            const verify = useJudge ? ({ lang: l, source }) => a.judge({ lang: l, source, problem: a.problem }) : (a.check ? ({ lang: l, source }) => a.check({ lang: l, source }) : null);
            if (!verify) return Object.assign(base, { mode: 'project', verdict: 'NONE', reason: 'no_checker', gaps: ['沒有檢查器（check）也沒有判題器（judge），無法驗證任何東西'] });
            const r = await Proj.solveProject({ model, lang, scenario: a.text, ask: backend.ask, write: backend.write, judge: verify, repair: makeRepair(a.problem), stackMod, opts: Object.assign({}, opts, { driver }), onEvent: a.onEvent });
            return withRoute(Object.assign(r, { mode: 'project', lang }));
        }
        const problem = a.problem && a.problem.statement ? a.problem : { id: 'user-task', title: clip(a.text, 40), statement: String(a.text || '') };
        // 缺口 D：離線各層已試過什麼，交給模型當「已試」前置，避免它重走同一條路（只加在給模型的敘述，不動測資與判題）
        const triedNote = offlineGaps.filter((g) => /^離線組合沒解出來/.test(g)).map((g) => g.replace(/，改用模型$/, '')).join('；');
        const problemForModel = triedNote ? Object.assign({}, problem, { statement: String(problem.statement || '') + '\n\n' + (offlineHeader ? offlineHeader + '\n（原因：' + triedNote.replace(/；各層：[^；]*/g, '') + '）' : '（補充：離線的程式組合已經試過但沒成功——' + triedNote + '。請用不同的做法。）') }) : problem;
        const hasTests = !!(problem.tests && problem.tests.length);
        const verify = hasTests && a.judge ? ({ lang: l, source }) => a.judge({ lang: l, source, problem }) : (a.check ? ({ lang: l, source }) => a.check({ lang: l, source }) : null);
        if (!verify) return Object.assign(base, { mode: 'problem', verdict: 'NONE', reason: 'no_checker', gaps: ['沒有檢查器（check）也沒有判題器（judge），無法驗證任何東西'] });
        const r = await Loop.solve({ problem: problemForModel, lang, ask: backend.ask, write: backend.write, judge: verify, repair: makeRepair(hasTests ? problem : null), choose: backend.choose, free: backend.free, lm: backend.lm, stackMod, opts, onEvent: a.onEvent });
        return withRoute(Object.assign(r, { mode: 'problem', lang }));
    }

    function formatReport(r) {
        if (!r) return '沒有結果';
        const how = r.verified ? '已用測試驗證（全部通過）' : (r.verdict === 'CHECKED' ? '**只通過編譯／語法檢查，沒有驗證行為是否正確**' : (r.ok ? '未驗證' : '沒有完成'));
        const L1 = [(r.mode === 'edit' ? '修改現有程式（' : '寫程式（' + (r.mode === 'offline' ? '離線組合' + (r.offline && r.offline.paradigm ? '：範式 ' + r.offline.paradigm : r.offline && r.offline.lesson ? '：課 ' + r.offline.lesson : r.offline && r.offline.recipe ? '：配方 ' + r.offline.recipe : r.offline && r.offline.matrix ? '：矩陣層 ' + r.offline.matrix.level + '／' + r.offline.matrix.kind + (r.offline.matrix.editable ? '（已整理成可編輯版：有註解、無巢狀函式，可在區塊／UML 繼續改）' : '') + (r.offline.onlyExamples ? '（只過範例，沒有獨立驗證' + (r.offline.matrix.suggest && r.offline.matrix.suggest.length ? '；補這幾筆輸入的正確輸出就能分出候選：' + r.offline.matrix.suggest.slice(0, 4).map((x) => '「' + String(x).replace(/\n/g, ' ／ ') + '」').join('、') : '') + '）' : '') : '') : r.mode === 'project' ? '依 UML 專案模式' : '題目模式') + '，') + r.lang + '）：' + (r.ok ? (r.mode === 'edit' ? '修改完成' : '產生完成') : '沒有完成') + '；' + how + '。'];
        if (r.mode === 'edit' && r.edits && r.edits.length) L1.push('改了 ' + r.edits.length + ' 處：\n' + r.edits.map((e) => '- ' + (e.by === 'rewrite' ? '重寫函式 ' + e.fn : (e.desc || '語法修正')) + (e.line ? '（第 ' + e.line + ' 行）' : '')).join('\n'));
        if (r.route && r.mode !== 'edit') L1.push('路線：' + (r.route.route === 'uml' ? '需求偏大，先設計 UML' + (r.design ? '（' + r.design.classes.length + ' 個類別）' : '') + '，再逐類別實作' : '直接切成函式寫') + (r.route.by === 'model' ? '（模型決定）' : r.route.by === 'caller' ? '（呼叫端指定）' : '') + (r.route.reasons && r.route.reasons.length ? '：' + r.route.reasons.slice(0, 3).join('、') : '') + '。');
        if (r.plan && r.plan.length) L1.push('函式：' + r.plan.map((x) => x.name).join(' → '));
        if (r.order && r.order.length) L1.push('類別：' + r.order.join(' → '));
        L1.push('模型呼叫 ' + ((r.calls && r.calls.ask || 0) + (r.calls && r.calls.write || 0)) + ' 次（問 ' + (r.calls ? r.calls.ask : 0) + '、寫 ' + (r.calls ? r.calls.write : 0) + '），驗收 ' + (r.calls ? r.calls.judge : 0) + ' 次，重寫 ' + (r.rethinks || 0) + ' 次。');
        if (r.gaps && r.gaps.length) L1.push('注意：\n' + r.gaps.map((g) => '- ' + g).join('\n'));
        if (r.mode === 'edit' && r.diff) L1.push('```diff\n' + String(r.diff).replace(/\s+$/, '') + '\n```');
        else if (r.source) L1.push('```' + (r.lang === 'nodejs' ? 'javascript' : r.lang === 'cpp' ? 'cpp' : r.lang === 'csharp' ? 'csharp' : r.lang.indexOf('asm') === 0 ? 'asm' : r.lang) + '\n' + String(r.source).replace(/\s+$/, '') + '\n```');
        return L1.join('\n');
    }

    return { detectLang, detectLangFromCode, routeOf, makeBackend, runCode, formatReport, roundsNote };
});
