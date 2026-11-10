/* /code 指令的路由（純函式 UMD，不問模型）：把「寫程式」類的一句話，由程式決定該呼叫哪一個程式設計工具、欄位怎麼填。
 *   classify(text) → { ok, sub, tool, args, why, missing:[…], usage? }
 *     sub：write／fix／optimize／merge／convert／card／design／explain／help
 *     先看開頭子指令（寫、修、優化、合併、設計、解釋、help），沒有就看整段文字的證據：
 *       有 diff 區塊（```diff 或含 @@）＋另一個程式區塊 → merge_patch；有程式區塊＋「優化／加速／變慢」→ optimize_code；
 *       有程式區塊＋「錯／修／不能跑／bug」或沒說要做什麼 → fix_code；沒有程式區塊 → write_code（預設）。
 *     欄位只由程式從文字抽（程式區塊、diff 區塊、語言名、``` 後的測資 in/out），抽不到的列在 missing，不編造。
 *   write_code 只有這一個入口：本模組只決定「叫誰、給什麼欄位」，真正寫與驗收都在工具裡（離線小模型只答工具內的封閉選擇題）。
 *   TOOLS：這個指令會用到的工具名單（測試用來核對工具真的存在、描述裡有講到何時用）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaCodeSlash = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const TOOLS = ['write_code', 'fix_code', 'optimize_code', 'merge_patch', 'convert_code', 'behavior_card', 'uml_design', 'explain_code'];
    const SUBS = [
        ['write', /^(?:write|寫|寫一個|做|產生|生成|新寫|幫我寫)(?=\s|$|[，,：:])/i, 'write_code'],
        ['fix', /^(?:fix|debug|修|修復|修正|除錯|修理)(?=\s|$|[，,：:])/i, 'fix_code'],
        ['optimize', /^(?:optimi[sz]e|優化|最佳化|加速)(?=\s|$|[，,：:])/i, 'optimize_code'],
        ['merge', /^(?:merge|patch|合併|套用修補|合併修補|套用)(?=\s|$|[，,：:])/i, 'merge_patch'],
        ['convert', /^(?:convert|translate|port|轉換|轉成|轉為|翻成|移植)(?=\s|$|[，,：:])/i, 'convert_code'],
        ['design', /^(?:design|uml|設計|畫設計)(?=\s|$|[，,：:])/i, 'uml_design'],
        ['card', /^(?:card|behavior|行為卡|抽回設計|抽設計|看行為)(?=\s|$|[，,：:])/i, 'behavior_card'],
        ['explain', /^(?:explain|extract|解釋|說明|讀懂)(?=\s|$|[，,：:])/i, 'explain_code']
    ];
    const LANG_FENCE = { py: 'python', python: 'python', js: 'nodejs', javascript: 'nodejs', node: 'nodejs', nodejs: 'nodejs', c: 'c', cpp: 'cpp', 'c++': 'cpp', java: 'java', rb: 'ruby', ruby: 'ruby', pl: 'perl', perl: 'perl', sh: 'bash', bash: 'bash', cs: 'csharp', csharp: 'csharp' };
    const USAGE = '用法：/code <一句話>。程式自己判斷做哪一種：\n' +
        '・寫：/code 寫一個函式，輸入一串整數印出總和（可加「用 C++」指定語言、附 ``` 範例測資 ```）\n' +
        '・修：/code 修 ＋ 貼一段 ``` 程式 ```（有測資會連行為一起修）\n' +
        '・優化：/code 優化 ＋ ``` 程式 ``` ＋ ``` 測資 ```（只換輸出一致的寫法）\n' +
        '・合併修補：/code 合併 ＋ ``` 目前的程式 ``` ＋ ```diff 修補 ```（合併後驗證，失敗整份回滾）\n' +
        '・轉換語言：/code 轉成 nodejs ＋ ``` 程式 ```（來源可以是 Python／nodejs／java／c／cpp／csharp／ruby／perl，可轉 nodejs／java／c／cpp／csharp／perl／ruby／python；附 ```in／```out 測資會實際執行驗證；不是寫程式，寫仍用上面「寫」）\n' +
        '・行為卡（唯讀，抽回設計看每個函式做什麼、改了會影響誰）：/code 行為卡 ＋ ``` 程式 ```\n' +
        '・設計：/code 設計 顧客可以加入購物車並結帳（先出 UML 設計）\n' +
        '・解釋／從程式看回設計：/code 解釋 ＋ ``` 程式 ```\n' +
        '也可以直接打需求，不加動詞：沒貼程式就當作「寫」，貼了程式就看你有沒有說優化或修。';

    function blocks(text) { // 抽出所有 ``` 區塊：{lang, body, isDiff}
        const out = []; const re = /```([^\n`]*)\n([\s\S]*?)```/g; let m;
        while ((m = re.exec(text))) { const tag = m[1].trim().toLowerCase(); const body = m[2].replace(/\n$/, ''); out.push({ tag, body, isDiff: tag === 'diff' || tag === 'patch' || /^@@ .* @@/m.test(body) || (/^--- /m.test(body) && /^\+\+\+ /m.test(body)) }); }
        return out;
    }
    function testsFrom(bs) { // 測資區塊：tag 為 in／out 成對，或 tag=test 內容 "in:\n…\nout:\n…"（只抽得出才給）
        const tests = []; for (let i = 0; i + 1 < bs.length; i++) if (bs[i].tag === 'in' && bs[i + 1].tag === 'out') { tests.push({ in: bs[i].body + '\n', out: bs[i + 1].body + '\n' }); i++; }
        return tests;
    }
    function langOf(text, bs) { const b = bs.find((x) => LANG_FENCE[x.tag]); if (b) return LANG_FENCE[b.tag]; return undefined; }
    // 轉換的目標語言：只認有輸出器的（nodejs／java／c／python）；提到其他語言時回 { unsupported }
    function targetOf(prose) {
        const t = String(prose || '');
        const word = (w) => (/^(?:c\+\+|cpp)$/i.test(w) ? 'cpp' : /^(?:c#|csharp)$/i.test(w) ? 'csharp' : /^ruby$/i.test(w) ? 'ruby' : /^perl$/i.test(w) ? 'perl' : null);
        const tm = /(?:轉成|轉換成|轉為|翻成|改寫成|移植到|convert (?:it )?to|translate (?:it )?to|port (?:it )?to)\s*([A-Za-z+#]+)/i.exec(t);
        if (tm && word(tm[1])) return { target: word(tm[1]) };
        if (/c\+\+|cpp/i.test(t)) return { target: 'cpp' }; if (/c#|csharp/i.test(t)) return { target: 'csharp' }; if (/ruby/i.test(t)) return { target: 'ruby' }; if (/perl/i.test(t)) return { target: 'perl' };
        if (/node(?:js)?|javascript|\bjs\b/i.test(t)) return { target: 'nodejs' };
        if (/java(?!script)/i.test(t)) return { target: 'java' };
        if (/(?:^|[^a-z+#])c(?:\s*語言|\s*language|(?![a-z+#0-9]))/i.test(t)) return { target: 'c' };
        if (/python|\bpy\b/i.test(t)) return { target: 'python' };
        return {};
    }
    function classify(text) {
        let raw = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
        if (!raw || /^(?:help|\?|說明|幫助)$/i.test(raw)) return { ok: true, sub: 'help', tool: null, args: {}, missing: [], usage: USAGE, why: '沒有內容或要說明' };
        let sub = null, tool = null, rest = raw, why = '';
        for (const [name, re, t] of SUBS) { const m = re.exec(raw); if (m) { sub = name; tool = t; rest = raw.slice(m[0].length).replace(/^[\s，,：:]+/, ''); why = '開頭子指令「' + m[0] + '」'; break; } }
        const bs = blocks(rest); const code = bs.filter((b) => !b.isDiff && b.tag !== 'in' && b.tag !== 'out'); const diff = bs.find((b) => b.isDiff);
        const prose = rest.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
        if (!sub) {
            if (diff && code.length) { sub = 'merge'; tool = 'merge_patch'; why = '有 diff 區塊和一份程式'; }
            else if (code.length && /優化|加速|變快|太慢|效能|optimi[sz]e|faster|slow/i.test(prose)) { sub = 'optimize'; tool = 'optimize_code'; why = '貼了程式並提到優化／太慢'; }
            else if (code.length && /轉成|轉換成|轉為|翻成|改寫成|移植到|convert (?:it )?to|translate (?:it )?to|port (?:it )?to/i.test(prose) && (targetOf(prose).target || targetOf(prose).unsupported)) { sub = 'convert'; tool = 'convert_code'; why = '貼了程式並要轉成別的語言'; }
            else if (code.length && /行為卡|抽回設計|函式.{0,4}(?:行為|關係)|呼叫關係|behavior card/i.test(prose) && !/修|錯|bug|fix/i.test(prose)) { sub = 'card'; tool = 'behavior_card'; why = '貼了程式並要行為卡／抽回設計'; }
            else if (code.length && /解釋|說明|在做什麼|看懂|explain|what does/i.test(prose) && !/修|錯|bug|fix/i.test(prose)) { sub = 'explain'; tool = 'explain_code'; why = '貼了程式並要解釋'; }
            else if (code.length) { sub = 'fix'; tool = 'fix_code'; why = '貼了程式（沒說要優化或解釋，當作要修）'; }
            else if (/^(?:設計|畫).{0,6}(?:uml|系統)/i.test(prose) || /(?:uml|類別圖|系統設計)/i.test(prose) && !/寫一個|函式|演算法/.test(prose)) { sub = 'design'; tool = 'uml_design'; why = '提到 UML／系統設計'; }
            else { sub = 'write'; tool = 'write_code'; why = '沒貼程式，預設是寫程式'; }
        }
        const lang = langOf(rest, bs); const tests = testsFrom(bs); const missing = []; const args = {};
        if (tool === 'write_code') { args.task = prose; if (lang) args.language = lang; if (tests.length) args.tests = tests; if (!prose) missing.push('要寫什麼（需求文字）'); }
        else if (tool === 'fix_code') { if (code[0]) args.source = code[0].body; else missing.push('要修的程式（用 ``` 包起來）'); if (prose) args.goal = prose; if (lang) args.language = lang; if (tests.length) args.tests = tests; }
        else if (tool === 'optimize_code') { if (code[0]) args.source = code[0].body; else missing.push('要優化的 Python 程式（用 ``` 包起來）'); if (tests.length) args.tests = tests; else missing.push('測資（```in 輸入``` 緊接 ```out 輸出```，優化要靠它確認輸出一致）'); }
        else if (tool === 'merge_patch') { if (code[0]) args.source = code[0].body; else missing.push('目前的程式（用 ``` 包起來）'); if (diff) args.diff = diff.body; else missing.push('要合併的 diff（```diff 區塊）'); if (lang) args.language = lang; if (tests.length) args.tests = tests; }
        else if (tool === 'convert_code') {
            if (code[0]) { args.source = code[0].body; const fl = langOf(rest, bs); if (fl && fl !== 'python') { if (['nodejs', 'java', 'c', 'cpp', 'csharp', 'ruby', 'perl'].includes(fl)) args.from = fl; else missing.push('來源目前支援 Python、nodejs、java、c、cpp、csharp、ruby、perl（你貼的是 ' + fl + '）'); } } else missing.push('要轉換的程式（用 ``` 包起來）');
            const tg = targetOf(prose); if (tg.target) args.target = tg.target; else missing.push('目標語言（nodejs、java、c、cpp、csharp、perl、ruby 或 python）');
            if (tests.length) args.tests = tests;
        }
        else if (tool === 'behavior_card') { if (code[0]) { args.source = code[0].body; if (lang) args.language = lang; } else missing.push('要看行為的程式（用 ``` 包起來）'); }
        else if (tool === 'uml_design') { args.scenario = prose; if (!prose) missing.push('情境（例如「顧客可以加入購物車並結帳」）'); }
        else if (tool === 'explain_code') { if (code[0]) { args.text = code[0].body; if (lang) args.lang = lang; } else missing.push('要解釋的程式（用 ``` 包起來）'); }
        return { ok: !missing.length, sub, tool, args, why, missing, usage: missing.length ? USAGE : undefined };
    }
    // 離線訓練器的內建規則（core_rules 領域）：沒打 /code、只說「寫一個函式…」時，程式直接選 write_code（不靠語意相似度，那條路實測會選到 list_ai_functions）。
    // 只做「寫」：修／優化需要程式碼原文，而訓練器入口會把換行壓成空白，程式縮排會毀掉，所以那兩種留給 /code 或線上模型。
    const WRITE_EXPR = '^(?![^]*(?:```|怎麼|如何|為什麼|為何|教我|教學|是什麼|曲子|樂曲|歌曲|文章|報告|故事|小說|詩|文案|網頁|網站|html|簡報|投影片|影片|附件|\.(?:py|js|ts|c|cpp|java)\b))[^]*?(?:寫|撰寫|編寫|產生|生成|實作|實現|做)[^]{0,14}?(?:函式|函數|程式|演算法|腳本|function|script|class|類別)';
    function trainerPatterns() { return [{ id: 'code_write', type: 'regex', expr: WRITE_EXPR, intent: '寫程式（函式／演算法／小程式）→ write_code（程式自己判斷怎麼切、編譯並跑測試驗收）', tool: 'write_code', args: { task: '{problem_text}' }, confidence: 0.85, risk: 'safe', source: 'builtin', enabled: true, hits: 0 }]; }
    return { classify, blocks, USAGE, TOOLS, trainerPatterns };
});
