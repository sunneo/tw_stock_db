/* 對話動作判斷（FaDialogueAct）：使用者用一般對話反駁或引導「上一步」時，辨認那是什麼動作。
 * 三層：(a) 程式預檢：只有短句、有上一步、又出現保守特徵詞才啟動（沒觸發就完全不影響現行路由）；
 *       (b) 封閉選擇題（小模型或使用者答）：1 新請求、2 否定糾正、3 換做法、4 指定第N個、5 補充參數；
 *       (c) 程式驗證：第N個要落在上一步的候選清單內；換做法要對應到備選且排除上一個首選；驗證失敗改問使用者。
 * 純函式（UMD），不連網、不呼叫模型、不碰 DOM。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaDialogueAct = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // 長度門檻是輔助：句首有標記時長度放寬到 MAX_LEAD_LEN（實測「不是，我說的是前面的review error不影響bitbake build」約 30 字，原本 25 字門檻會漏掉）。
    const MAX_LEN = 25;
    const MAX_LEAD_LEN = 60;
    const URL_RE = /https?:\/\/|www\.|\.(?:com|tw|org|net|io)\b/i;
    const ATTACH_RE = /\[附件：/;
    // 句首標記：一句話一開頭就是反駁或糾正，後面出現的動詞（review、build、search…）只是在談論內容，不是新指令。
    const LEAD_RE = /^\s*(?:不是|不對|不，|不要|不用|錯了|我是說|我說的是|我指的是|我要的是|應該是|no[,，. ]|actually|i meant|i mean|not that)/i;
    // 保守特徵：只當「要不要去問」的觸發，不直接決定動作。
    const TRIGGER_RE = /不是|不對|錯了|錯誤|不行|換|重來|再試|另一個|我是說|我指的是|第\s*[0-9一二三四五六七八九十兩]+\s*(?:則|條|篇|個|項)|上一個|前面那個|no[,. ]|that'?s wrong|wrong|try another|i meant|instead/i;
    // 常被誤當成指令的動詞（英文夾雜）：只是提到，沒有網址或對象時不可直接執行。
    const COMMAND_WORD_RE = /\b(?:review|build|search|scan|deploy|test|summari[sz]e|translate)\b|搜尋|審查|編譯|部署/i;
    const PICK_RE = /第\s*([0-9一二三四五六七八九十兩]+)\s*(?:則|條|篇|個|項)/;
    const CN_NUM = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

    // 選項（整數）：1 新請求、2 否定糾正、3 換做法、4 指定第N個、5 補充參數。不放「都不是」（小模型實測會過度選它）。
    const CHOICES = [
        { n: 1, id: 'independent', label: '一個新的獨立請求，跟上一步無關' },
        { n: 2, id: 'correct', label: '否定或糾正上一步的結果' },
        { n: 3, id: 'alternative', label: '要換另一種做法再試一次' },
        { n: 4, id: 'pick', label: '指定上一步列出的其中第N個' },
        { n: 5, id: 'supplement', label: '補充上一步缺的參數或條件' }
    ];

    function memKey(s) { return String(s || '').replace(/[\s，。,.!！?？「」『』"']/g, '').toLowerCase(); }

    // (a) 程式預檢。lastAction：{ tool, kind, candidates?: [], alternatives?: [], primary? }。
    function precheck(text, lastAction) {
        const t = String(text || '').trim();
        if (!lastAction) return { triggered: false, reason: '沒有上一步動作' };
        if (!t) return { triggered: false, reason: '空白句' };
        if (URL_RE.test(t)) return { triggered: false, reason: '句子含網址' };
        if (ATTACH_RE.test(t)) return { triggered: false, reason: '句子含附件' };
        if (LEAD_RE.test(t) && t.length <= MAX_LEAD_LEN) return { triggered: true, reason: '句首有反駁或糾正標記', by: 'lead' };
        if (t.length > MAX_LEN) return { triggered: false, reason: '句子超過 ' + MAX_LEN + ' 字且句首沒有標記' };
        if (!TRIGGER_RE.test(t)) return { triggered: false, reason: '沒有反駁或引導的特徵詞' };
        return { triggered: true, reason: '短句且有上一步，含反駁或引導特徵', by: 'keyword' };
    }

    // 守門：句中有指令詞（review、build…）但上一步不是那個動作、又沒有網址或附件時，不准直接執行（不可要求使用者輸入網址），先走對話判斷。
    function guardCommandWord(text, lastAction) {
        const t = String(text || '').trim();
        if (!lastAction || !t) return { hold: false, reason: '沒有上一步或空白' };
        if (URL_RE.test(t) || ATTACH_RE.test(t)) return { hold: false, reason: '有網址或附件，照現行路由' };
        const m = COMMAND_WORD_RE.exec(t);
        if (!m) return { hold: false, reason: '沒有指令詞' };
        const word = m[0].toLowerCase();
        const same = String(lastAction.tool || '').toLowerCase().indexOf(word) >= 0 || String(lastAction.kind || '').toLowerCase().indexOf(word) >= 0;
        if (same) return { hold: false, reason: '上一步本來就是這個動作' };
        return { hold: true, reason: '句中只提到「' + m[0] + '」，沒有網址或對象，先判斷是否為反駁' };
    }

    // 上一步摘要：約 120 字內，只留工具、種類、候選標題。
    function summarizeAction(lastAction) {
        if (!lastAction) return '（無）';
        const parts = ['動作：' + (lastAction.tool || lastAction.kind || '未知')];
        if (lastAction.kind) parts.push('種類：' + lastAction.kind);
        const cands = (lastAction.candidates || []).slice(0, 5);
        if (cands.length) parts.push('候選：' + cands.map((c, i) => (i + 1) + '. ' + String(c).slice(0, 30)).join('；'));
        return parts.join('，').slice(0, 120);
    }

    // (b) 封閉選擇題訊息（給小模型）；prefill 由呼叫端加 {"choice":
    function buildChoiceMessages(input) {
        const i = input || {};
        const lines = CHOICES.map((c) => c.n + '. ' + c.label).join('\n');
        return [
            { role: 'system', content: '你判斷使用者這一句話跟上一步的關係。只輸出一個 JSON 物件，格式：{"choice": 編號}。編號只能是選單裡有的數字。' },
            { role: 'user', content: '上一句使用者的話：' + String(i.prevUser || '').slice(0, 120) + '\n上一步助理做的事：' + summarizeAction(i.lastAction) + '\n\n選單：\n' + lines + '\n\n使用者這一句：' + String(i.text || '').slice(0, 60) }
        ];
    }

    function validateChoice(o) {
        const c = o && o.choice;
        if (!Number.isInteger(c)) return ['「choice」必須是整數'];
        if (c < 1 || c > CHOICES.length) return ['「choice」必須是 1～' + CHOICES.length + ' 之間的整數'];
        return [];
    }
    function choiceId(n) { const c = CHOICES.find((x) => x.n === n); return c ? c.id : null; }

    // 解析「第N個」：阿拉伯或中文數字（一～九、十、十一～十九、二十），回傳從 1 起算的整數；沒有則 null。
    function parsePick(text) {
        const m = PICK_RE.exec(String(text || ''));
        if (!m) return null;
        const raw = m[1];
        if (/^\d+$/.test(raw)) return Number(raw);
        if (raw === '十') return 10;
        if (raw.length === 1 && CN_NUM[raw]) return CN_NUM[raw];
        if (raw[0] === '十' && raw.length === 2 && CN_NUM[raw[1]]) return 10 + CN_NUM[raw[1]];
        if (raw.length === 2 && CN_NUM[raw[0]] && raw[1] === '十') return CN_NUM[raw[0]] * 10;
        return null;
    }

    // (c) 程式驗證：第N個要在候選清單內。
    function validatePick(n, candidates) {
        const list = candidates || [];
        if (!Number.isInteger(n)) return { ok: false, reason: '沒有讀出第幾個' };
        if (!list.length) return { ok: false, reason: '上一步沒有候選清單' };
        if (n < 1 || n > list.length) return { ok: false, reason: '第' + n + '個超出候選範圍（1～' + list.length + '）' };
        return { ok: true, item: list[n - 1], index: n - 1 };
    }

    // 換做法：只能從備選挑，且排除上一個首選。
    function pickAlternative(lastAction) {
        const la = lastAction || {};
        const alts = (la.alternatives || []).filter((a) => a && a !== la.primary && a !== la.tool);
        if (!alts.length) return { ok: false, reason: '沒有可換的備選做法' };
        return { ok: true, alternative: alts[0] };
    }

    // 驗證失敗時問使用者的封閉題（requestUserForm 用）。
    function askOptions(n) {
        return [
            { n: 1, label: '換別的做法' },
            { n: 2, label: n ? '選第' + n + '個' : '選上一步列出的其中一個' },
            { n: 3, label: '新的問題' }
        ];
    }

    // 合併決策：回傳 { mode, ... }；mode 為 pass（照現行路由）、retry_alt、pick、supplement、ask。
    function decide(choiceN, text, lastAction) {
        const id = choiceId(choiceN);
        if (id === 'independent') return { mode: 'pass', why: '使用者要新的請求' };
        if (id === 'supplement') return { mode: 'supplement', why: '補充上一步參數，帶上一句一起重跑' };
        if (id === 'correct' || id === 'alternative') {
            const alt = pickAlternative(lastAction);
            if (alt.ok) return { mode: 'retry_alt', alternative: alt.alternative, why: id === 'correct' ? '否定上一步，改用備選做法' : '換另一種做法' };
            return { mode: 'ask', why: alt.reason, options: askOptions() };
        }
        if (id === 'pick') {
            const n = parsePick(text);
            const v = validatePick(n, lastAction && lastAction.candidates);
            if (v.ok) return { mode: 'pick', index: v.index, item: v.item, why: '取上一步第' + n + '個' };
            return { mode: 'ask', why: v.reason, options: askOptions(n) };
        }
        return { mode: 'ask', why: '選項無效', options: askOptions() };
    }

    // 使用者在 askOptions 上的回答 → 決策（1 換做法、2 指定候選需再問第幾個、3 新問題）。
    function decideFromAsk(n, lastAction) {
        if (n === 1) return decide(3, '', lastAction);
        if (n === 2) return { mode: 'pick_ask', why: '使用者要指定候選，請再問第幾個' };
        if (n === 3) return { mode: 'pass', why: '使用者說是新問題' };
        return { mode: 'ask', why: '回答無效', options: askOptions() };
    }

    // 記憶（同 _otGateRemember 的 key 慣例：memKey(句子)＋上一步種類），命中就少問。
    function memKeyFor(text, lastAction) { return 'd:' + memKey(text) + '|' + ((lastAction && (lastAction.kind || lastAction.tool)) || ''); }
    const REMEMBER_MODES = { retry_alt: 1, pick: 1, supplement: 1, pass: 1 };
    function remember(memory, text, lastAction, decision) {
        if (!memory || !decision || !REMEMBER_MODES[decision.mode]) return memory;
        memory[memKeyFor(text, lastAction)] = { mode: decision.mode, index: decision.index, alternative: decision.alternative || null };
        return memory;
    }
    function recall(memory, text, lastAction) {
        if (!memory) return null;
        return memory[memKeyFor(text, lastAction)] || null;
    }

    // 程式驗證成功的紀錄，給訓練資料用（呼叫端自行存）
    function learnRecord(text, lastAction, decision) {
        return { text: String(text || '').slice(0, 60), kind: (lastAction && lastAction.kind) || null, mode: decision.mode, verified: true };
    }

    return { MAX_LEN, MAX_LEAD_LEN, LEAD_RE, TRIGGER_RE, PICK_RE, CHOICES, precheck, guardCommandWord, summarizeAction, buildChoiceMessages, validateChoice, choiceId, parsePick, validatePick, pickAlternative, decide, askOptions, decideFromAsk, memKeyFor, remember, recall, learnRecord };
});
