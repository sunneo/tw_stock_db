/* 意圖解析（FaUserIntent）：從使用者／ITS（議題追蹤）的文字描述，穩定地讀出「做了什麼行為、看到什麼、期待什麼」，再變成 UML 與測試案例。
 * 給離線小模型與會退化的線上模型用（intent-to-bugfix、intent-to-testcase 的設計指引見 DESIGN.intent.md）。
 *
 * 管線（每一段都是程式；只有歧義才問模型一個封閉的選擇題）：
 *   ① segment   文字切割：章節標題（重現步驟／預期結果／實際結果／環境…）、編號步驟、列點、句子（。！？；. ! ?）、程式碼與 log 區塊
 *   ② classify  語意切割：每一段是什麼角色——前置條件／動作／觀察到的（實際）／期待的／驗證／原因／修正建議／環境／雜訊。明確的（章節標題、提示詞）與隱含的（句型）分開記
 *   ③ behavior  語意意象 → 行為：{ actor, verb（正規化）, object, state, polarity（+1 正常／-1 壞掉／否定） }，用雙語的動詞與狀態詞表
 *   ④ implied   隱含關係：觀察到的壞狀態（「無法開機」「crash」「沒有顯示」）反過來就是隱含的期待（「應該能開機」）；有「修正後」「之後」的句子是期待；
 *               沒有明確驗證步驟時，補一個隱含的驗證（照重現步驟再做一次，確認期待的狀態）。每個隱含的東西都標 implicit:true 與依據（basis）
 *   ⑤ gaps／questions  缺什麼就用封閉的小問題問（怎麼重現？正常應該是什麼？在哪個環境？），不猜
 *   ⑥ toUml／toTestCase  行為 → UML（使用案例的呼叫順序＋期待的狀態）；行為 → 測試案例（前置、步驟、預期、隱含標記、負向變化）
 * 純函式（UMD）、沒有相依；模型是注入的（pick：封閉選擇題，回傳選項索引；沒有就用程式的第一名）。可以整支搬到別的宿主（例如 Redmine 的 ToolWire）。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaUserIntent = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ---------- 詞表（資料，可擴充：lex 參數可以疊加）----------
    const SECTIONS = [
        { role: 'environment', re: /^(?:環境|版本|測試環境|系統環境|environment|env|version|platform|setup info|build)(?![A-Za-z0-9_])\s*[:：]?\s*$/i },
        { role: 'precondition', re: /^(?:前置條件|前提|先決條件|前置|precondition|prerequisites?|given)(?![A-Za-z0-9_])\s*[:：]?\s*$/i },
        { role: 'action', re: /^(?:重現步驟|重現方式|複現步驟|操作步驟|步驟|steps? to reproduce|steps?|repro(?:duction)? steps?|how to reproduce|when)(?![A-Za-z0-9_])\s*[:：]?\s*$/i },
        { role: 'observation', re: /^(?:實際結果|實際狀況|實際情況|現象|問題描述|問題|症狀|actual(?: result| behaviou?r)?|observed|current behaviou?r|symptoms?|problem|issue)(?![A-Za-z0-9_])\s*[:：]?\s*$/i },
        { role: 'expectation', re: /^(?:預期結果|預期行為|期望結果|期待結果|預期|正常情況|應該|expected(?: result| behaviou?r)?|expectation|should|then)(?![A-Za-z0-9_])\s*[:：]?\s*$/i },
        { role: 'verification', re: /^(?:驗證|驗證方式|驗證步驟|確認方式|測試方式|verification|verify|validation|acceptance(?: criteria)?)(?![A-Za-z0-9_])\s*[:：]?\s*$/i },
        { role: 'cause', re: /^(?:原因|根因|可能原因|分析|root cause|cause|analysis)(?![A-Za-z0-9_])\s*[:：]?\s*$/i },
        { role: 'fix', re: /^(?:修正|修正方式|解法|建議|解決方式|fix|solution|proposal|suggestion|workaround)(?![A-Za-z0-9_])\s*[:：]?\s*$/i },
        { role: 'noise', re: /^(?:備註|附註|附件|參考|note|notes|attachments?|see also|references?)(?![A-Za-z0-9_])\s*[:：]?\s*$/i },
    ];
    // 句型提示詞（隱含的角色線索）：[角色, 正規表示式, 分數]
    const CUES = [
        ['expectation', /應該|應當|理應|預期|期望|期待|正常(?:情況|狀況)?(?:下|應|會|是)|修正後|修復後|改善後|之後(?:應|會|要)|希望|must\b|should\b|expected?\b|ought to|supposed to|is expected|after (?:the )?fix|once fixed/i, 3],
        ['observation', /實際|結果(?:卻|是|變成)?|卻|竟然|發現|看到|出現|顯示(?:了)?(?:錯誤|異常)|現象|問題是|症狀|但是|可是|actual(?:ly)?\b|instead\b|but\b|however\b|observed?\b|got\b|results? in\b|ends? up/i, 2],
        ['action', /^(?:先|然後|接著|再|之後|最後|按下|點擊|點選|按|選擇|選取|開啟|打開|關閉|執行|輸入|切換|進入|重開機|重新啟動|重啟|升級|更新|刷新|連線|登入|登出|上傳|下載|儲存|刪除|新增|安裝|解除安裝|插入|拔除|then\b|next\b|first\b|click|press|tap|select|open|close|run|execute|type|enter|input|switch|go to|navigate|reboot|restart|upgrade|update|flash|connect|login|log in|logout|upload|download|save|delete|add|install|uninstall|plug|unplug|boot|launch|start|stop|set|configure)/i, 2],
        ['precondition', /^(?:在|當|若|如果|假設|已經|已|事先|預先|使用|搭配|given\b|when\b|if\b|assuming\b|with\b|on a\b|using\b)/i, 1],
        ['verification', /(?:確認|驗證|檢查|比對|測試是否|是否(?:正常|成功|能|可以|有)|verify\b|validate\b|confirm\b|check (?:that|whether|if)|make sure|ensure\b|assert\b)/i, 3],
        ['cause', /(?:原因|導致|造成|由於|因為|根因|因此會|root cause|caused by|due to|because\b|leads? to)/i, 2],
        ['fix', /(?:修正|修復|修改|改成|改為|改用|建議|解法|補上|加上|避免|fix(?:ed)?\b|patch\b|change .* to|should be changed|propose|workaround)/i, 1],
        ['environment', /(?:版本|韌體|BIOS|BMC|作業系統|Windows|Linux|Ubuntu|平台|機型|型號|硬體|build\b|firmware|version\b|v\d+(?:\.\d+)+|platform|model\b|OS\b)/i, 1],
    ];
    const NEG = /(?:無法|不能|不會|不可|沒有|沒辦法|未能|未|失敗|錯誤|異常|當機|當掉|卡住|卡死|閃退|崩潰|凍結|無反應|沒反應|不正常|不顯示|不出現|找不到|逾時|超時|cannot\b|can't\b|can not\b|unable\b|fail(?:s|ed|ure)?\b|error\b|crash(?:es|ed)?\b|hang(?:s)?\b|freez(?:e|es|ing)\b|stuck\b|timeout\b|time out\b|not (?:work|respond|show|display|boot|start|found|appear)|doesn'?t\b|does not\b|won'?t\b|no response|missing\b|blank\b|black screen|exception\b|panic\b|abort)/i;
    const POS = /(?:成功|正常|可以|能夠|能|順利|通過|完成|顯示|出現|開機|啟動|回應|work(?:s|ed)?\b|succeed(?:s|ed)?\b|pass(?:es|ed)?\b|normal(?:ly)?\b|boots?\b|starts?\b|shows?\b|displays?\b|responds?\b)/i;
    // 動詞表：[正規化的動詞, 正規表示式]（雙語；順序＝優先）
    const VERBS = [
        ['reboot', /重開機|重新開機|重新啟動|重啟|reboot|restart|power cycle|cold boot|warm boot/i], ['boot', /開機|啟動系統|boot(?:s|ing)?\b/i],
        ['flash', /刷(?:寫)?(?:韌體|BIOS)|燒錄|flash(?:ing)?\b|firmware (?:update|upgrade)/i], ['upgrade', /升級|更新|upgrade|update/i],
        ['click', /點擊|點選|按下|按一下|按|click|press|tap/i], ['select', /選擇|選取|選|select|choose|pick/i],
        ['open', /開啟|打開|進入|開|open|enter|go to|navigate/i], ['close', /關閉|關掉|退出|離開|close|exit|quit/i],
        ['input', /輸入|填寫|填入|type|enter (?:the )?(?:text|value)|input|fill/i], ['run', /執行|運行|跑|run|execute|invoke|launch/i],
        ['connect', /連線|連接|連上|connect|attach|plug/i], ['disconnect', /斷線|拔除|拔掉|中斷|disconnect|unplug|detach/i],
        ['login', /登入|log ?in|sign ?in/i], ['logout', /登出|log ?out|sign ?out/i],
        ['upload', /上傳|upload/i], ['download', /下載|download/i], ['save', /儲存|存檔|save|apply|commit/i],
        ['delete', /刪除|移除|delete|remove|clear/i], ['add', /新增|加入|建立|add|create|insert/i],
        ['install', /安裝|install/i], ['uninstall', /解除安裝|uninstall/i], ['set', /設定|設置|配置|改成|改為|改用|修改|更改|變更|set|configure|change|modify/i],
        ['read', /讀取|讀|查看|檢視|read|view|show|display|list/i], ['write', /寫入|寫|write/i], ['switch', /切換|switch|toggle/i], ['wait', /等待|等候|wait/i],
    ];
    const STATE = [
        ['crash', /當機|當掉|閃退|崩潰|凍結|卡死|crash|freez|hang|panic|abort|segfault|exception/i], ['stuck', /卡住|無反應|沒反應|no response|stuck|not responding/i],
        ['error', /錯誤|失敗|異常|error|fail|exception/i], ['timeout', /逾時|超時|timeout|time out/i], ['missing', /找不到|不顯示|不出現|沒有顯示|missing|not found|not show|blank|black screen|無畫面/i],
        ['wrong', /不正確|錯誤的|不對|不一致|wrong|incorrect|mismatch/i], ['ok', /成功|正常|順利|通過|succe|pass|normal|ok\b/i],
    ];
    const ACTORS = [['Tester', /測試人員|測試者|QA|tester/i], ['Developer', /開發者|工程師|developer|engineer/i], ['Admin', /管理員|系統管理|admin/i], ['User', /使用者|用戶|客戶|user|customer|operator/i], ['System', /系統|裝置|設備|機器|主機|韌體|程式|軟體|system|device|firmware|app|software|service|server/i]];
    const KIND_CUES = { bugfix: /bug|issue|defect|crash|fail|error|cannot\b|can't\b|unable\b|doesn'?t\b|won'?t\b|not (?:work|respond|boot)|問題|錯誤|異常|當機|失敗|無法|不能|不會|修正|修復|重現|regression|回歸|缺陷/i, testcase: /測試案例|測項|測試計畫|測試項目|test ?case|test plan|test design|test scenario|驗證項目|acceptance|test spec|撰寫測試|設計測試/i, feature: /新增功能|需求|功能需求|希望能|想要|feature|requirement|user story|enhancement|as a\b/i };

    const clean = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
    const stripBullet = (x) => String(x).replace(/^\s*(?:[-*•·●○▪]|\d{1,2}[.)、:]|[（(]\d{1,2}[)）]|[①-⑳]|Step\s*\d+\s*[:：.)]?|步驟\s*\d+\s*[:：.)]?)\s*/i, '');

    // ---------- ① 文字切割 ----------
    function segment(text) {
        const lines = String(text == null ? '' : text).replace(/\r/g, '').split('\n'); const out = []; let section = ''; let fence = false; let n = 0;
        const push = (t, kind, extra) => { t = clean(t); if (t) out.push(Object.assign({ i: n++, text: t, kind, section }, extra || {})); };
        for (const raw of lines) {
            const ln = raw.trim(); if (/^```/.test(ln)) { fence = !fence; continue; }
            if (fence) { push(ln, 'code'); continue; } if (!ln) continue;
            const head = SECTIONS.find((s) => s.re.test(ln.replace(/^#{1,4}\s*/, '').replace(/^[*_【\[(（]+|[*_】\])）]+$/g, '')));
            if (head) { section = head.role; continue; }
            const inline = /^(?:#{1,4}\s*)?[*_【\[(（]*([^:：]{1,24})[*_】\])）]*\s*[:：]\s*(\S.*)$/.exec(ln); // 「預期結果：……」同一行
            if (inline) { const h = SECTIONS.find((s) => s.re.test(inline[1].trim() + ':')); if (h) { section = h.role; push(inline[2], 'sentence', { sectionInline: true }); continue; } }
            const isStep = /^\s*(?:\d{1,2}[.)、:]|[（(]\d{1,2}[)）]|[①-⑳]|Step\s*\d+|步驟\s*\d+)/i.test(ln), isBullet = /^\s*[-*•·●○▪]\s+/.test(ln);
            if (/^\s*(?:\d{4}-\d{2}-\d{2}[ T])?\d{2}:\d{2}:\d{2}|^\s*\[(?:INFO|WARN|ERROR|DEBUG)\]|^\s*(?:ERROR|WARN|FATAL)\b|^\s*at\s+[\w.$]+\(|^\s*0x[0-9a-f]{4,}/i.test(ln)) { push(ln, 'log'); continue; }
            const body = stripBullet(ln);
            if (isStep || isBullet) { push(body, isStep ? 'step' : 'bullet'); continue; }
            // 句子：中英標點切開；保留引號與小數點
            for (const s of body.split(/(?<=[。！？!?；;])\s*|(?<=[a-z0-9\)])\.\s+(?=[A-Z])/)) push(s, 'sentence');
        }
        return out;
    }

    // ---------- ② 語意切割（角色）----------
    function scoreRoles(seg, lex) {
        const t = seg.text; const sc = {}; const add = (r, v, why) => { sc[r] = (sc[r] || 0) + v; (sc._why = sc._why || {})[r] = (sc._why[r] || []).concat(why); };
        if (seg.section) add(seg.section, 6, '章節標題');
        if (seg.kind === 'step') add('action', 3, '編號步驟');
        if (seg.kind === 'log') add('observation', 3, 'log／錯誤輸出');
        if (seg.kind === 'code') add('noise', 1, '程式碼區塊');
        for (const [role, re, w] of CUES.concat((lex && lex.cues) || [])) if (re.test(t)) add(role, w, '句型提示');
        const neg = NEG.test(t); if (neg && !sc.expectation) add('observation', 2, '壞掉的狀態');
        if (neg && /(?:不應|不該|不得|不會再|不再|不要|should not|shouldn'?t|must not|no longer|never)/i.test(t)) add('expectation', 4, '「不應該…」');
        return sc;
    }
    function classify(seg, lex) {
        const sc = scoreRoles(seg, lex); const why = sc._why || {}; delete sc._why; const ranked = Object.entries(sc).sort((a, b) => b[1] - a[1]);
        if (!ranked.length) return { role: seg.kind === 'log' ? 'observation' : 'noise', score: 0, explicit: false, ambiguous: false, options: [], why: [] };
        const [role, score] = ranked[0]; const second = ranked[1];
        const explicit = !!(seg.section && seg.section === role) || (role === 'expectation' && /應該|should|expected|預期|期望/i.test(seg.text));
        return { role, score, explicit, ambiguous: !!second && score - second[1] <= 1 && score <= 4, options: ranked.slice(0, 3).map((x) => x[0]), why: why[role] || [] };
    }

    // ---------- ③ 語意意象 → 行為 ----------
    const CJKRE = /[\u3400-\u9fff]/;
    function verbsIn(t) {
        const cjk = CJKRE.test(t); const all = []; for (const [v, re] of VERBS) { const g = new RegExp(re.source, 'ig'); let m; while ((m = g.exec(t))) { all.push({ v, at: m.index, len: m[0].length, ascii: /^[A-Za-z]/.test(m[0]) }); if (m[0].length === 0) g.lastIndex++; } }
        // 中文句子裡的英文字多半是名稱（Boot Mode、Setup、Update 頁面）：有中文動詞就只用中文的，沒有才退回英文的
        const pick = cjk && all.some((x) => !x.ascii) ? all.filter((x) => !x.ascii) : all; pick.sort((a, b) => a.at - b.at || b.len - a.len);
        const out = []; let end = -1; for (const x of pick) { if (x.at >= end) { out.push(x); end = x.at + x.len; } } return out;
    }
    function objectAfter(t, v) {
        const after = t.slice(v.at + v.len).replace(/^[\s,，、:：「『"'“]+/, ''); if (/^(?:之後|然後|接著|後|時|再|並)/.test(after)) return '';
        const m = /^([A-Za-z][\w.\-/]*(?: [A-Z][\w.\-/]*){0,2}|[\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9_\-]{0,14})(?=\s|[，,。.、」』"'”）)]|$|的|後|時|以|到|並|再|然後|進入|離開)/.exec(after); return m ? clean(m[1]) : '';
    }
    function behaviorOf(text) {
        const t = clean(text); const vs = verbsIn(t); const st = STATE.find(([, re]) => re.test(t)); const neg = NEG.test(t); const pos = !neg && POS.test(t);
        const actor = (ACTORS.find(([, re]) => re.test(t)) || [])[0] || ''; const acts = vs.slice(0, 4).map((v) => ({ verb: v.v, object: objectAfter(t, v) }));
        // 「把 X 改成／設為 Y」：物件是 X，值是 Y
        const bm = /把\s*(.+?)\s*(?:改成|改為|改用|設為|設定為|換成)\s*(.+?)(?:[，,。；;]|$)/.exec(t); if (bm) { const a0 = acts.find((x) => x.verb === 'set') || { verb: 'set', object: '' }; a0.object = clean(bm[1]); a0.value = clean(bm[2]); if (!acts.includes(a0)) acts.unshift(a0); }
        const main = acts.find((x) => x.object) || acts[0] || null;
        return { verb: main ? main.verb : '', verbs: acts.map((x) => x.verb), object: main ? main.object : '', acts, state: st ? st[0] : '', polarity: neg ? -1 : (pos ? 1 : 0), actor, text: t };
    }
    const ident = (s, fb) => { const w = String(s || '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean); return w.length ? w.map((x, i) => (i ? x[0].toUpperCase() + x.slice(1) : x[0].toLowerCase() + x.slice(1))).join('').slice(0, 30) : fb; };

    // ---------- ④ 隱含關係 ----------
    // 壞掉的觀察 → 隱含的期待（反過來）。文字上的反轉：先找「無法/不能/不會/沒有 X」→「能 X」；找得到的狀態詞（crash/error/stuck…）→「不應該 <state>」
    function invert(text, beh) {
        const t = clean(text); let m = /(?:無法|不能|沒辦法|未能|不會|沒有|不可以?|不)(?:正常)?([^，,。.；;]{1,24})/.exec(t);
        if (m && /^(?:無法|不能|沒辦法|未能|不會|沒有|不可以?)/.test(m[0])) return '應該能' + clean(m[1]);
        m = /(?:cannot|can't|can not|unable to|fails? to|doesn'?t|does not|won'?t|not)\s+(?:be\s+)?(\w[\w\s-]{0,30})/i.exec(t); if (m) return 'should ' + clean(m[1]).replace(/\s+(?:when|after|on|in|with)\b.*$/i, '');
        if (beh && beh.state && beh.state !== 'ok') { const lab = { crash: '當機／崩潰', stuck: '卡住／無反應', error: '出現錯誤', timeout: '逾時', missing: '消失／不顯示', wrong: '結果不正確' }[beh.state] || beh.state; return '不應該' + lab; }
        return '';
    }

    // ---------- 整體解析 ----------
    function detectKind(text, hint) {
        if (hint && KIND_CUES[hint]) return hint; const s = { bugfix: 0, testcase: 0, feature: 0 };
        for (const k of Object.keys(KIND_CUES)) { const m = String(text).match(new RegExp(KIND_CUES[k].source, 'ig')); s[k] = m ? m.length : 0; }
        const top = Object.entries(s).sort((a, b) => b[1] - a[1]); return top[0][1] ? top[0][0] : 'unknown';
    }
    // pick（可選）：async (question, options[]) → 索引（封閉選擇題）。只在「歧義」的段落問；沒有 pick 或挑不出來就用程式的第一名
    async function parseAsync(text, opts) {
        opts = opts || {}; const segs = segment(text); const items = [];
        for (const sg of segs) {
            const c = classify(sg, opts.lex); let role = c.role; let by = 'program';
            if (c.ambiguous && typeof opts.pick === 'function' && c.options.length > 1) {
                try { const i = await opts.pick('這一句是什麼角色？「' + sg.text.slice(0, 80) + '」', c.options.slice(0, 4)); if (Number.isInteger(i) && i >= 0 && i < Math.min(4, c.options.length)) { role = c.options[i]; by = 'model'; } } catch (_) { /* 用程式的第一名 */ }
            }
            items.push(Object.assign({}, sg, { role, explicit: c.explicit, by, why: c.why, options: c.options, behavior: behaviorOf(sg.text) }));
        }
        return build(text, await readWithTranslate(items, opts), opts);
    }
    function parse(text, opts) {
        opts = opts || {}; const items = segment(text).map((sg) => { const c = classify(sg, opts.lex); return Object.assign({}, sg, { role: c.role, explicit: c.explicit, by: 'program', why: c.why, options: c.options, behavior: behaviorOf(sg.text) }); });
        return build(text, items, opts);
    }
    function build(text, items, opts) {
        const first = items[0]; const explicitSec = (r) => items.some((x) => x.section === r && x !== first);
        const by = (r) => items.filter((x) => x.role === r && !(x === first && !x.section && (r === 'action' || r === 'observation') && explicitSec(r))); const kind = detectKind(text, opts.kind);
        const intent = { kind, title: '', environment: by('environment').map((x) => x.text), preconditions: by('precondition').map((x) => x.text),
            steps: by('action').map((x, n) => ({ n: n + 1, text: x.text, behavior: x.behavior, explicit: x.explicit || x.kind === 'step' })),
            observations: by('observation').map((x) => ({ text: x.text, behavior: x.behavior, explicit: x.explicit })),
            expectations: by('expectation').map((x) => ({ text: x.text, explicit: true, implicit: false, behavior: x.behavior })),
            verifications: by('verification').map((x) => ({ text: x.text, explicit: true, implicit: false })), causes: by('cause').map((x) => x.text), fixes: by('fix').map((x) => x.text), segments: items };
        const firstLine = clean(String(text).split('\n').find((l) => clean(l)) || ''); intent.title = firstLine.replace(/^#+\s*|^\[[^\]]+\]\s*/g, '').slice(0, 80);
        // 隱含的期待：每個壞掉的觀察反過來
        for (const ob of intent.observations) {
            if (ob.behavior.polarity < 0 || NEG.test(ob.text)) { const inv = invert(ob.text, ob.behavior); if (inv && !intent.expectations.some((e) => clean(e.text) === inv)) intent.expectations.push({ text: inv, explicit: false, implicit: true, basis: '觀察「' + ob.text.slice(0, 60) + '」的反面', behavior: behaviorOf(inv) }); }
        }
        // 沒有明確的觀察、但步驟或標題本身是「壞掉」的描述（常見：標題寫「按下儲存後當機」）
        if (!intent.observations.length && intent.kind === 'bugfix') { const t = items.find((x) => x.behavior.polarity < 0 && x.role !== 'expectation'); if (t) { intent.observations.push({ text: t.text, behavior: t.behavior, explicit: false, implicit: true, basis: '句子描述了壞掉的狀態' }); const inv = invert(t.text, t.behavior); if (inv && !intent.expectations.length) intent.expectations.push({ text: inv, explicit: false, implicit: true, basis: '句子「' + t.text.slice(0, 60) + '」的反面', behavior: behaviorOf(inv) }); } }
        // 隱含的驗證：沒有明確的驗證步驟，就是「照重現步驟再做一次，確認期待的狀態」
        if (!intent.verifications.length && (intent.steps.length || intent.expectations.length)) intent.verifications.push({ text: '照重現步驟再做一次，確認' + (intent.expectations[0] ? '「' + intent.expectations[0].text.slice(0, 60) + '」' : '結果正常'), explicit: false, implicit: true, basis: '沒有明確的驗證方式，預設是重做一次重現步驟' });
        intent.gaps = gapsOf(intent); intent.questions = questionsOf(intent);
        intent.confidence = Math.max(0, Math.min(1, (intent.steps.length ? 0.35 : 0) + (intent.expectations.length ? 0.3 : 0) + (intent.observations.length ? 0.2 : 0) + (intent.environment.length ? 0.1 : 0) + (intent.expectations.some((e) => e.explicit) ? 0.05 : 0)));
        return intent;
    }
    function gapsOf(it) {
        const g = []; if (it.kind === 'bugfix' || it.kind === 'testcase') { if (!it.steps.length) g.push('steps'); if (!it.expectations.length) g.push('expectation'); if (it.kind === 'bugfix' && !it.observations.length) g.push('observation'); if (!it.environment.length) g.push('environment'); }
        if (it.kind === 'unknown') g.push('kind'); return g;
    }
    // 缺什麼就問封閉的小問題（選項有「照預設／不知道」）；不猜
    function questionsOf(it) {
        const Q = { steps: { id: 'steps', q: '怎麼重現？文字裡沒有找到操作步驟。', options: ['我補上步驟', '沒有固定步驟（偶發）', '照描述裡的動作推測（不確定）'] },
            expectation: { id: 'expectation', q: '正常的時候應該是什麼狀態？文字裡沒有說，也推不出來。', options: ['我補上預期結果', '就是沒有錯誤／不當機', '不知道（先不驗證）'] },
            observation: { id: 'observation', q: '實際看到了什麼？文字裡沒有描述現象。', options: ['我補上現象', '照標題的描述', '不知道'] },
            environment: { id: 'environment', q: '在哪個環境？（機型、版本、作業系統）文字裡沒有提到。', options: ['我補上環境', '不限環境', '用預設的測試環境'] },
            kind: { id: 'kind', q: '這是要修的問題、要寫的測試案例，還是新功能？', options: ['修問題（bugfix）', '寫測試案例（testcase）', '新功能（feature）'] } };
        return it.gaps.map((g) => Q[g]).filter(Boolean);
    }

    // ---------- ⑥ UML ----------
    // 行為 → 一個 SUT 類別（System under test）＋使用案例：Reproduce（重現步驟）與 VerifyFix／VerifyExpected（驗證與期待的狀態）。輸出 FaUml 的文字 DSL。
    function opName(b, fb) { const o = ident(b.object, ''); return (b.verb ? b.verb : fb) + (o ? o[0].toUpperCase() + o.slice(1) : ''); }
    function toUml(it, opts) {
        opts = opts || {}; const actor = (it.steps.map((s) => s.behavior.actor).find((a) => a && a !== 'System') || (it.kind === 'testcase' ? 'Tester' : 'User')); const sut = opts.sut || 'SystemUnderTest';
        const ops = []; const seen = new Set(); const addOp = (name, ret) => { if (!seen.has(name)) { seen.add(name); ops.push('+' + name + '():' + (ret || 'void')); } return name; };
        const repro = []; it.steps.forEach((s, i) => { const acts = (s.behavior.acts && s.behavior.acts.length ? s.behavior.acts : [{ verb: s.behavior.verb, object: s.behavior.object }]).slice(0, 3); acts.forEach((a) => { const nm = addOp(opName({ verb: a.verb, object: a.object }, 'step' + (i + 1))); if (repro[repro.length - 1] !== nm) repro.push(nm); }); }); const obs = it.observations.slice(0, 3).map((o, i) => addOp('observe' + (o.behavior.state ? o.behavior.state[0].toUpperCase() + o.behavior.state.slice(1) : 'Result' + (i + 1)), 'bool'));
        const exp = it.expectations.slice(0, 4).map((e, i) => addOp('expect' + ident(e.behavior.verb ? opName(e.behavior, '') : e.text.slice(0, 20), 'Ok' + (i + 1)).replace(/^./, (c) => c.toUpperCase()), 'bool'));
        const L = []; L.push('model: ' + (it.title || 'intent').replace(/[\r\n:]/g, ' ').slice(0, 60)); L.push('actor: ' + actor + ', System'); L.push('class ' + sut + ' { ' + (ops.join('; ') || '+run():void') + ' }');
        const chain = (a, ops2) => a + ' -> ' + ops2.filter((o, i) => ops2[i - 1] !== o).map((o) => sut + '.' + o + '()').join(' -> ');
        if (repro.length) L.push('usecase Reproduce: ' + chain(actor, repro.concat(obs)));
        const verify = repro.concat(exp.length ? exp : []); if (verify.length) L.push('usecase ' + (it.kind === 'bugfix' ? 'VerifyFix' : 'VerifyExpected') + ': ' + chain(actor, verify));
        if (!repro.length && !verify.length) L.push('usecase Run: ' + actor + ' -> ' + sut + '.run()');
        return L.join('\n');
    }

    // ---------- ⑥ 測試案例 ----------
    // 每個測試案例：前置、步驟（每一步可帶預期）、整體預期（明確／隱含分開標）、負向變化（從「壞掉的觀察」來）。給 intent-to-testcase 用，對應的測試工具由宿主接。
    function toTestCase(it) {
        const exp = it.expectations; const cases = [];
        cases.push({ id: 'TC-1', title: (it.title || '正常流程') + '：預期的行為', type: 'positive', preconditions: it.preconditions.concat(it.environment.map((e) => '環境：' + e)), steps: it.steps.map((s) => ({ n: s.n, action: s.text, verb: s.behavior.verb, object: s.behavior.object })), expected: exp.map((e) => ({ text: e.text, implicit: e.implicit, basis: e.basis })), verification: it.verifications.map((v) => ({ text: v.text, implicit: v.implicit })) });
        for (const ob of it.observations.filter((o) => o.behavior.polarity < 0 || NEG.test(o.text)).slice(0, 3)) cases.push({ id: 'TC-' + (cases.length + 1), title: '迴歸：' + ob.text.slice(0, 50) + ' 不再發生', type: 'regression', preconditions: it.preconditions, steps: it.steps.map((s) => ({ n: s.n, action: s.text })), expected: [{ text: '不應該' + (ob.behavior.state || '出現這個現象') + '（' + ob.text.slice(0, 40) + '）', implicit: true, basis: '原本的問題現象' }], verification: it.verifications.map((v) => ({ text: v.text, implicit: v.implicit })) });
        return { ok: cases[0].steps.length > 0 || cases[0].expected.length > 0, cases, gaps: it.gaps, questions: it.questions };
    }

    // ---------- 中英翻譯輔助（translate 是注入的：async (text, to:'en'|'zh') → 譯文或 null；宿主接離線的中英互譯）----------
    // 詞表是雙語的，但使用者寫的方式千百種：程式認不得的段落（雜訊、動作沒有認得的動詞）先翻成另一種語言，再用同一批規則讀一次。
    // 翻譯只用來「讀」，不改原文；用了翻譯的段落標 via:'translate'，並附譯文。
    const HAS_CJK = /[\u3400-\u9fff]/;
    async function readWithTranslate(items, opts) {
        const tr = opts.translate; if (typeof tr !== 'function') return items; const out = [];
        for (const it of items) {
            const weak = it.role === 'noise' || (it.role === 'action' && !it.behavior.verb) || (!it.behavior.verb && !it.behavior.state && it.role !== 'expectation' && it.role !== 'environment');
            if (!weak || it.kind === 'code' || it.kind === 'log' || it.text.length < 4) { out.push(it); continue; }
            let en = null; try { en = await tr(it.text, HAS_CJK.test(it.text) ? 'en' : 'zh'); } catch (_) { en = null; }
            if (!en || typeof en !== 'string' || clean(en) === it.text) { out.push(it); continue; }
            const seg = Object.assign({}, it, { text: clean(en) }); const c = classify(seg, opts.lex); const b = behaviorOf(en);
            const better = (it.role === 'noise' && c.role !== 'noise') || (!it.behavior.verb && b.verb) || (!it.behavior.state && b.state);
            out.push(better ? Object.assign({}, it, { role: it.role === 'noise' ? c.role : it.role, behavior: Object.assign({}, b, { text: it.text }), via: 'translate', translated: clean(en), by: it.by }) : Object.assign({}, it, { translated: clean(en) }));
        }
        return out;
    }
    const WORD = /[A-Za-z][A-Za-z0-9_]{2,}|\d+(?:\.\d+)+|0x[0-9a-f]+/g;
    // 媒合用的詞：英文單字（小寫，去掉太常見的）與中日韓的相鄰二字詞
    const COMMON = new Set('the and for with that this from into when then are was were has have not but you your can may will all any its via per'.split(' '));
    function tokensOf(text) {
        const t = String(text || ''); const out = new Set(); (t.toLowerCase().match(WORD) || []).forEach((w) => { if (!COMMON.has(w)) out.add(w.length > 4 && /[^s]s$/.test(w) ? w.slice(0, -1) : w); });
        const cj = t.match(/[\u3400-\u9fff]+/g) || []; for (const run of cj) { for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2)); if (run.length === 1) out.add(run); }
        return out;
    }
    // 意象：一份意圖的雙語詞集合——原文的詞、行為的動詞（正規化的英文）、狀態詞、有翻譯的話譯文的詞。拿去跟目錄／工具的描述媒合。
    async function imagery(intent, translate) {
        const parts = []; const add = (text, kind) => { if (text) parts.push({ text: clean(text), kind }); };
        add(intent.title, 'title'); intent.steps.forEach((x) => add(x.text, 'step')); intent.observations.forEach((x) => add(x.text, 'observation')); intent.expectations.forEach((x) => add(x.text, 'expectation'));
        const tokens = new Set(); const verbs = new Set(); const states = new Set();
        for (const p of parts) {
            tokensOf(p.text).forEach((x) => tokens.add(x)); const b = behaviorOf(p.text); b.verbs.forEach((v) => { verbs.add(v); tokens.add(v); }); if (b.state) { states.add(b.state); tokens.add(b.state); }
            if (typeof translate === 'function') { let en = null; try { en = await translate(p.text, HAS_CJK.test(p.text) ? 'en' : 'zh'); } catch (_) { en = null; } if (en && typeof en === 'string') { p.translated = clean(en); tokensOf(en).forEach((x) => tokens.add(x)); const b2 = behaviorOf(en); b2.verbs.forEach((v) => { verbs.add(v); tokens.add(v); }); if (b2.state) { states.add(b2.state); tokens.add(b2.state); } } }
        }
        return { tokens, verbs: Array.from(verbs), states: Array.from(states), parts };
    }
    // 媒合：候選 [{ name, text }]（目錄單元、工具、技能…）；分數＝候選的詞被意象涵蓋的比例（加權：名稱的詞 ×2）。回傳前 k 名（分數 > 0）
    function match(img, candidates, k) {
        const set = img.tokens instanceof Set ? img.tokens : new Set(img.tokens || []); const out = [];
        for (const c of candidates || []) {
            const nameT = tokensOf(String(c.name || '').replace(/[_\-]+/g, ' ')); const textT = tokensOf(c.text || ''); let hit = 0, total = 0;
            nameT.forEach((w) => { total += 2; if (set.has(w)) hit += 2; }); textT.forEach((w) => { total += 1; if (set.has(w)) hit += 1; });
            if (hit > 0 && total) out.push({ name: c.name, score: Math.round((hit / Math.sqrt(total)) * 100) / 100, hit });
        }
        return out.sort((a, b) => b.score - a.score).slice(0, k || 5);
    }

    return { segment, classify, behaviorOf, invert, detectKind, parse, parseAsync, toUml, toTestCase, gapsOf, questionsOf, tokensOf, imagery, match, SECTIONS, CUES, VERBS, STATE, NEG };
});
