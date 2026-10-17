/* 達成路線（FaRoute）：找不到工具時，不猜、不放棄——把「做不到」變成一條可以走的路線。設計見 DESIGN.unit-catalog.md 第三十七節。
 *
 *   classify：程式讀需求，判斷這是哪一類缺口——external_action（寄信、發文、付款…有副作用，需要外部世界）、model（翻譯、語音、辨識…用 Hugging Face／離線模型）、
 *             program（計算、轉換、解析…寫程式）、design（一整個系統／應用…先用 UML design 拆）。
 *   plan：依環境（桌面版／網頁版、有沒有瀏覽器控制）排出路線與步驟。程式的語言依環境選：桌面 Python／JavaScript／bash；網頁版 Python（Pyodide，純 Python 套件）／JavaScript（iframe、Worker）／bash（busybox 模擬）。
 *         外部動作：問使用者要不要提供 API、或用瀏覽器控制操作網頁版、或給信件範本讓使用者自己寄——三條都不行才說做不到。
 *   gate：手動模式＝先把計畫送出、問使用者要不要；自動模式＝直接做。有副作用的步驟（寄出、發佈、付款、刪除）兩種模式都一定先問。
 *   umlIssue：把缺口對應成 UML 編修的「缺能力」問題（見 uml_edit_core.candidates），反思的結論因此能改 UML 再重建。
 * 純函式（UMD）；選路線的歧義題由注入的 generate 回答（封閉選擇題），沒有模型就用程式的第一名。
 */
(function (root, factory) {
    const R = (typeof FaRecipe !== 'undefined' && FaRecipe) || (root && root.FaRecipe) || (typeof require === 'function' ? require('../recipe/recipe_core.js') : null);
    if (typeof module === 'object' && module.exports) module.exports = factory(R);
    else root.FaRoute = factory(R);
})(typeof self !== 'undefined' ? self : this, function (R) {
    'use strict';

    const KINDS = ['external_action', 'model', 'program', 'design'];
    // 關鍵字表：每個命中算一分；external_action 的詞更具體，命中就加權
    const RULES = {
        external_action: { w: 3, re: [/寄(?:出|送)?(?:一?封)?(?:信|郵件|電子郵件|mail)/i, /(?:發|傳|送)(?:一?封)?(?:信|郵件|email|e-mail)/i, /\bemail\b|e-mail|\bsmtp\b/i, /發(?:送)?(?:訊息|簡訊|通知)|傳(?:訊息|line|簡訊)|\bline\b|\bslack\b|\bdiscord\b|telegram/i, /發(?:文|佈|布|推|貼)|貼文|推文|\btweet\b|\bpost to\b|發表/i, /付款|轉帳|匯款|刷卡|下訂|訂購|購買|結帳|預約|訂位|報名/, /刪除(?:帳號|帳戶|資料庫|全部)|註冊帳號|提交表單|送出表單/] },
        model: { w: 2, re: [/翻譯|translate/i, /語音|朗讀|唸出來|念出來|\btts\b|text.?to.?speech|speech/i, /辨識|\bocr\b|文字辨識|圖片.*(?:文字|內容)|影像分類|物件偵測/i, /轉錄|逐字稿|字幕|transcrib|whisper/i, /摘要|summari[sz]e|情感分析|分類|語意|embedding|向量/i, /hugging ?face|離線模型|\bhf\b/i] },
        program: { w: 1.5, re: [/計算|統計|排序|轉換|轉成|格式化|解析|parse|批次|重新命名|壓縮|解壓|合併|拆分|過濾|萃取|擷取|爬|產生.*(?:檔|圖|報表)|畫.*圖|圖表|繪製/i, /\bpython\b|javascript|\bjs\b|\bbash\b|腳本|script|程式/i, /csv|json|excel|xlsx|pdf|docx|markdown|正規/i] },
        design: { w: 1.2, re: [/系統|平台|應用程式|\bapp\b|網站|後台|管理(?:系統|介面)|資料庫|架構|服務|多個.*(?:功能|模組)|完整/i, /使用者.*(?:登入|註冊)|購物車|訂單|會員|庫存|預約系統/] }
    };

    function score(need) {
        const t = String(need || ''); const out = {}; const why = {};
        for (const k of KINDS) { let s = 0; const hit = []; for (const re of RULES[k].re) { const m = re.exec(t); if (m) { s += RULES[k].w; hit.push(m[0]); } } out[k] = s; why[k] = hit; }
        return { score: out, why };
    }
    // 回傳 { kind, ranked:[{kind,score,why}], ambiguous }；沒有任何命中就是 program（寫程式是最通用的路線）
    function classify(need) {
        const { score: sc, why } = score(need);
        const ranked = KINDS.map((k) => ({ kind: k, score: sc[k], why: why[k] })).sort((a, b) => b.score - a.score);
        // 有副作用的一旦命中，就一定當外部動作處理（寧可多問，不要誤做）
        if (sc.external_action > 0) return { kind: 'external_action', ranked, ambiguous: false };
        if (!ranked[0].score) return { kind: 'program', ranked, ambiguous: false, fallback: true };
        const ambiguous = ranked[1].score > 0 && ranked[0].score - ranked[1].score < 1;
        return { kind: ranked[0].kind, ranked, ambiguous };
    }
    async function classifyWithModel(need, opts) {
        const c = classify(need); if (!c.ambiguous || !opts || !opts.generate) return Object.assign({ by: 'program' }, c);
        const cands = c.ranked.filter((r) => r.score > 0).slice(0, 3); const label = { model: '用現成的模型（翻譯、語音、辨識…）', program: '寫一小段程式', design: '先設計（UML）再做一整個系統', external_action: '要對外部世界做事' };
        const L = (i) => String.fromCharCode(65 + i);
        const pick = (v) => { let x = v && typeof v === 'object' ? v.choice : v; if (typeof x === 'string') { x = x.trim().replace(/["'.。、）)]/g, ''); if (/^[A-Za-z]$/.test(x)) x = x.toUpperCase().charCodeAt(0) - 64; else if (/^\d+$/.test(x)) x = Number(x); } return Number.isInteger(x) && x >= 1 && x <= cands.length ? x - 1 : -1; };
        const msgs = [{ role: 'system', content: '你替一個需求挑最合適的做法。只輸出一個 JSON 物件，格式：{"choice": "字母"}，字母只能是選單裡有的（A、B、C…）。' }, { role: 'user', content: '需求：' + String(need).slice(0, 300) + '\n選單：\n' + cands.map((x, i) => L(i) + '. ' + label[x.kind]).join('\n') }];
        const r = await R.jsonStep({ generate: opts.generate, messages: msgs, maxTokens: 40, maxTries: 2, prefill: '{"choice":', validate: (o) => (pick(o) >= 0 ? [] : ['「choice」必須是選單裡的字母 A～' + L(cands.length - 1)]) });
        if (!r.ok) return Object.assign({ by: 'program' }, c);
        return Object.assign({}, c, { kind: cands[pick(r.value)].kind, by: 'model', ambiguous: false });
    }

    // 程式語言：依環境與需求挑（回傳排好序的候選與理由）
    function pickLanguages(need, env) {
        const t = String(need || ''); const web = env && env.environment === 'web';
        const wantJs = /網頁|前端|dom|瀏覽器|按鈕|頁面|canvas|\bjs\b|javascript/i.test(t), wantBash = /檔案|資料夾|目錄|指令|批次.*(?:檔|名)|\bbash\b|\bshell\b|終端/i.test(t), wantPy = /\bpython\b|資料(?!夾)|統計|csv|excel|xlsx|pdf|圖表|分析|爬/i.test(t);
        const langs = [];
        const add = (id, label, how) => { if (!langs.some((l) => l.id === id)) langs.push({ id, label, how }); };
        const py = web ? ['python', 'Python（網頁版用 Pyodide，純 Python 套件可用 micropip 安裝；沒有原生編譯的套件）', 'python_execute'] : ['python', 'Python', 'python_execute 或 bash_execute'];
        const js = web ? ['javascript', 'JavaScript（在隔離的 iframe 或 Worker 裡跑）', 'sandbox_html／sandbox_worker'] : ['javascript', 'JavaScript', 'sandbox_html／sandbox_worker 或 node'];
        const sh = web ? ['bash', 'bash（網頁版是 busybox 模擬，檔案與簡單指令流程適合）', 'run-terminal'] : ['bash', 'bash', 'bash_execute'];
        const order = wantJs ? [js, py, sh] : (wantBash && !wantPy ? [sh, py, js] : [py, js, sh]);
        for (const [id, label, how] of order) add(id, label, how);
        return langs;
    }

    function mailDraft(need) {
        const t = String(need || ''); const to = (/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(t) || [])[0] || '';
        const subj = (/(?:主旨|標題|subject)[:：]\s*([^\n，。]+)/i.exec(t) || [])[1] || '';
        return { to, subject: subj, body: '（內容由使用者確認後填入）\n\n需求原文：' + t.slice(0, 300) };
    }

    // 缺口 → UML 的「缺能力」問題（接 uml_edit_core.candidates）
    const CAPS = [
        [/寄|mail|email|信/i, 'Mailer', 'send(to:str,subject:str,body:str):bool', '寄信'],
        [/翻譯|translate/i, 'Translator', 'translate(text:str,to:str):str', '翻譯'],
        [/語音|朗讀|tts|speech/i, 'Speech', 'speak(text:str):bytes', '語音合成'],
        [/ocr|辨識|圖片.*文字/i, 'Ocr', 'read(image:bytes):str', '文字辨識'],
        [/轉錄|逐字稿|字幕|whisper/i, 'Transcriber', 'transcribe(audio:bytes):str', '語音轉文字'],
        [/付款|轉帳|結帳/, 'Payment', 'pay(amount:decimal):bool', '付款'],
        [/發文|貼文|推文|post/i, 'Publisher', 'publish(text:str):bool', '發佈']
    ];
    function umlIssue(need, usecase) {
        for (const [re, cls, op, label] of CAPS) if (re.test(need)) return { kind: 'missing_capability', need: label, cls, op, usecase };
        return { kind: 'missing_capability', need: String(need).slice(0, 20), cls: 'Capability', op: 'run(input:any):any', usecase };
    }

    // 排計畫。env：{ environment:'desktop'|'web', browserControl:bool, apiProvided:bool }；回傳 { need, kind, routes, steps, sideEffect, summary }
    function plan(need, env, cls) {
        env = env || {}; const c = cls || classify(need); const kind = c.kind; let n = 0; const id = () => 's' + (++n);
        const steps = []; const routes = [];
        const st = (kindS, text, extra) => { const s = Object.assign({ id: id(), kind: kindS, text, sideEffect: false }, extra || {}); steps.push(s); return s; };
        if (kind === 'external_action') {
            const draft = mailDraft(need);
            routes.push({ id: 'api', label: '你提供對應的 API（網址與金鑰），我用程式呼叫', available: true, needs: '使用者提供 API', default: !!env.apiProvided });
            routes.push({ id: 'browser_control', label: '用瀏覽器控制操作網頁版（例如網頁信箱），每個動作先規劃、再核對、再執行', available: !!env.browserControl, reason: env.browserControl ? '' : '瀏覽器控制還沒啟用', default: !env.apiProvided && !!env.browserControl });
            routes.push({ id: 'template', label: '我寫好範本，由你自己送出', available: true, default: !env.apiProvided && !env.browserControl });
            st('ask', '問使用者選哪一條路線（API／瀏覽器控制／範本），需要的資料（收件者、內容）一併確認', { tool: 'ask_user_card' });
            st('draft', '寫好內容範本' + (draft.to ? '（收件者 ' + draft.to + '）' : '') + '，給使用者確認', { draft });
            st('send', '實際送出（寄出／發佈／付款）——有副作用，一定要使用者當下同意', { sideEffect: true, tool: 'depends_on_route' });
        } else if (kind === 'model') {
            routes.push({ id: 'hf_model', label: '用 Hugging Face／離線模型（程式檢查輸出，不合格就退回重來）', available: true, default: true });
            routes.push({ id: 'program', label: '寫一小段程式處理（模型做不到的部分）', available: true });
            st('reflect', '搜尋現有工具與別名，確認真的沒有', { tool: 'catalog_discover' });
            st('model', '選模型（版本釘死、下載前先問使用者），程式檢查輸出', { tool: 'depends_on_model' });
            st('verify', '用範例輸入試跑，檢查輸出格式與內容', {});
            st('deliver', '把結果交給使用者', {});
        } else if (kind === 'design') {
            routes.push({ id: 'uml_design', label: '先用 UML design 拆成使用案例、類別、呼叫順序，再逐步寫程式', available: true, default: true });
            st('design', '把需求拆成 UML（參與者、使用案例、類別、成員、關係、呼叫順序）', { tool: 'uml_design' });
            st('edit', '依檢查出的問題補或刪 UML，重建專案骨架', { tool: 'uml_edit' });
            st('code', '照 UML 逐個檔案寫程式', {});
            st('run', '在隔離的沙盒裡跑測試', {});
            st('deliver', '交付專案與設計檢視器', {});
        } else {
            const langs = pickLanguages(need, env);
            routes.push({ id: 'program', label: '寫程式：' + langs.map((l) => l.label).join('；'), available: true, default: true, languages: langs });
            if (String(need).length > 40) st('design', '需求較長：先用 UML design 拆成小步驟', { tool: 'uml_design' });
            st('code', '用 ' + langs[0].label + ' 寫出來', { tool: langs[0].how, language: langs[0].id });
            st('run', '在沙盒裡試跑，檢查輸出', {});
            st('deliver', '把結果（或程式）交給使用者', {});
        }
        const sideEffect = steps.some((s) => s.sideEffect);
        return { need: String(need), kind, ambiguous: !!c.ambiguous, environment: env.environment || 'desktop', routes, steps, sideEffect, summary: summarize({ kind, routes, steps }) };
    }
    function summarize(p) {
        const label = { external_action: '需要對外部世界做事', model: '用現成模型', program: '寫程式', design: '先設計再做' }[p.kind];
        return label + '：' + p.steps.map((s, i) => (i + 1) + '. ' + s.text).join('；');
    }

    // 閘門：手動模式＝先送計畫問使用者；自動模式＝直接做；有副作用的步驟永遠先問
    function gate(p, mode) {
        const manual = mode !== 'auto';
        const steps = p.steps.map((s) => Object.assign({}, s, { confirm: manual || !!s.sideEffect || s.kind === 'ask' }));
        return { mode: manual ? 'manual' : 'auto', askPlanFirst: manual, steps, alwaysAsk: steps.filter((s) => s.sideEffect).map((s) => s.id) };
    }
    // 下一個動作能不能直接做
    function mayRun(step, mode) { return !step.sideEffect && step.kind !== 'ask' && mode === 'auto'; }

    function planMessage(p, g) {
        const L = ['我找不到現成的工具，但這件事可以這樣做（' + { external_action: '需要對外部世界做事', model: '用現成模型', program: '寫程式', design: '先設計再做' }[p.kind] + '）：'];
        if (p.routes.length > 1) { L.push('可選的路線：'); p.routes.forEach((r, i) => L.push('  ' + String.fromCharCode(65 + i) + '. ' + r.label + (r.available ? '' : '（目前不能用：' + r.reason + '）') + (r.default ? '　← 建議' : ''))); }
        else L.push('路線：' + p.routes[0].label);
        L.push('步驟：'); g.steps.forEach((s, i) => L.push('  ' + (i + 1) + '. ' + s.text + (s.sideEffect ? '　【有副作用，執行前一定會再問你】' : '')));
        L.push(g.askPlanFirst ? '要照這個計畫做嗎？（手動模式：你同意我才動手）' : '（自動模式：我直接開始；有副作用的步驟會先問你）');
        return L.join('\n');
    }

    return { KINDS, classify, classifyWithModel, pickLanguages, mailDraft, umlIssue, plan, summarize, gate, mayRun, planMessage };
});
