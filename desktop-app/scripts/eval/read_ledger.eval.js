// 讀取帳本（真實 Electron、假 LLM）：分頁讀取沒讀完就回答，修前會被接受；修後被擋、提醒、讀完才放行；固執的模型三次提醒後放行並加警語。
// 用法：node scripts/eval/run_eval.js scripts/eval/read_ledger.eval.js 17941
// 假工具 test_paged_read 是三頁的檔案（offset 0、1、2），第 3 頁有「錯誤：磁碟已滿」。
// 情境：
//   A 修前（閘門換成 null，等同舊的迴圈行為）：模型讀完第一頁就回答 → 應該被接受、只呼叫一次工具。
//   B 修後，順從的模型：第一次回答被擋 → 提醒 → 再讀第 2、3 頁 → 第三頁後回答；最終回答不加警語。
//   C 修後，固執的模型：每次都直接回答 → 三次提醒後放行，最終回答前面有固定警語。
const fa = window.fa; const R = {};
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; } // 同 tool-budget.eval.js：改用目前的 window.fetch（這裡的假 LLM）
const PAGES = ['第一頁：一般紀錄，無異常。', '第二頁：警告 WARN 重試中。', '第三頁：錯誤：磁碟已滿（ERROR disk full）。'];
const TOOL = 'test_paged_read';
fa.tools[TOOL] = {
    description: '假的分頁讀檔工具（評估用）：回傳三頁的 log，每次一頁，用 offset 續讀。',
    parametersSchema: { type: 'object', properties: { offset: { type: 'integer', description: '頁碼，從 0 開始' } } },
    callback: async (rawArgs) => {
        let a = {}; try { a = JSON.parse(rawArgs || '{}'); } catch (_) { a = {}; }
        const off = Math.max(0, Math.min(2, Number(a.offset) || 0));
        const more = off < 2;
        const out = { ok: true, text: PAGES[off], offset: off, has_more: more, next_offset: more ? off + 1 : undefined, total: 3 };
        window.__lastPage = out; window.__toolOffsets.push(off);
        return JSON.stringify(out);
    }
};
// 讓根層工具清單包含這個假工具
const origRoot = fa._getRootToolNames.bind(fa);
fa._getRootToolNames = () => Array.from(new Set(origRoot().concat([TOOL])));
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
fa._shouldUseNativeToolCalls = () => true;

// 工具呼叫的假回應：mode = 'obedient'（提醒後照做）或 'stubborn'（永遠直接回答）
function scenario(mode, gateOverride) {
    return async () => {
        const realFetch = window.fetch.bind(window);
        const origGate = fa._readLedgerGate;
        if (gateOverride === 'off') fa._readLedgerGate = () => null;
        fa._readLedger = null; fa._readReminders = null; window.__toolOffsets = []; window.__lastPage = null;
        const reqs = []; const reminderSeen = [];
        window.fetch = async (url, init) => {
            if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
            const body = JSON.parse(init.body); const msgs = body.messages || [];
            const last = msgs[msgs.length - 1] || {};
            reqs.push(last.role);
            const reminders = msgs.filter((m) => m.role === 'system' && /讀取尚未完成/.test(String(m.content || ''))).length;
            reminderSeen.push(reminders);
            const mk = (msg) => new Response(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant', content: '' }, msg), finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
            const answer = () => mk({ content: '報告都正確，沒有錯誤。' });
            const callPage = (off) => mk({ tool_calls: [{ id: 'c' + reqs.length, type: 'function', function: { name: TOOL, arguments: JSON.stringify({ offset: off }) } }] });
            if (last.role === 'user') return callPage(0);
            if (last.role === 'tool') return answer(); // 模型只看了一頁就下結論（舊行為）
            if (last.role === 'system') {
                if (mode === 'obedient' && window.__lastPage && window.__lastPage.has_more) return callPage(window.__lastPage.next_offset);
                return answer(); // 固執的模型不理會提醒
            }
            return answer();
        };
        const sysMsg = { role: 'system', content: '你是測試助理。' };
        fa.messages = [sysMsg, { role: 'user', content: '查一下這份 log 裡有什麼錯誤' }];
        try {
            await fa._loopFetchNative('k', 'http://fake.local/v1', 'm', 1, null);
        } catch (e) { return { error: String((e && e.message) || e) }; }
        finally { window.fetch = realFetch; fa._readLedgerGate = origGate; }
        const asst = fa.messages.filter((m) => m.role === 'assistant').map((m) => String(m.content || ''));
        return {
            tool_offsets: window.__toolOffsets.slice(),
            request_last_roles: reqs,
            max_reminders_in_request: Math.max(0, ...reminderSeen),
            final_text: asst.length ? asst[asst.length - 1] : null,
            warned: asst.some((t) => t.indexOf('注意：以下來源只讀了一部分') >= 0)
        };
    };
}

// 證明載入的是工作目錄的實作：字串常值存在於嵌入的模組與閘門方法裡（不用壓縮後的變數名）
R.loaded = {
    gate_has_warn_literal: String(fa._readLedgerGate).indexOf('只讀了一部分') >= 0,
    module_reminder: fa._faReadLedgerMod().reminderText([{ label: 'x', toolName: 't', nextOffset: 1, total: 3, blocking: true }]).indexOf('讀取尚未完成') >= 0,
    module_has_record: typeof fa._faReadLedgerMod().record === 'function'
};
R.A_before_fix = await scenario('lazy', 'off')();
R.B_obedient = await scenario('obedient', 'on')();
R.C_stubborn = await scenario('stubborn', 'on')();
// D/E：新的使用者訊息（executeChat 入口）與中止收尾，帳本都要歸零。
// 修前模擬：把 _readLedger 換成 setter，忽略「設成 null」（等同修前的程式沒有歸零）；修後：不套用 setter，程式自己歸零。
const L = fa._faReadLedgerMod();
let ledgerStore; let ignoreNull = false;
function installLedgerSetter(ignore) {
    ignoreNull = ignore; ledgerStore = undefined; delete fa._readLedger;
    Object.defineProperty(fa, '_readLedger', { configurable: true, get() { return ledgerStore; }, set(v) { if (v === null && ignoreNull) return; ledgerStore = v; } });
}
function removeLedgerSetter() { delete fa._readLedger; fa._readLedger = null; }
function chatTurn(text, mock) {
    return async () => {
        const realFetch = window.fetch.bind(window); window.fetch = mock;
        let status = 'ok';
        try { await fa.executeChat(text); } catch (e) { status = 'threw:' + String((e && e.message) || e); } finally { window.fetch = realFetch; }
        return status;
    };
}
function fakeMk(msg) { return new Response(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant', content: '' }, msg), finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } }); }
// 第一輪：讀第一頁後中止（AbortError）
const abortMock = async (url, init) => {
    if (!String(url).startsWith('http://fake.local/')) return window.__realFetch(url, init);
    const body = JSON.parse(init.body); const msgs = body.messages || []; const last = msgs[msgs.length - 1] || {};
    if (/工具領域路由器/.test(String((msgs[0] || {}).content || ''))) return fakeMk({ content: JSON.stringify({ domains: [] }) });
    if (last.role === 'user') return fakeMk({ tool_calls: [{ id: 'a1', type: 'function', function: { name: TOOL, arguments: JSON.stringify({ offset: 0 }) } }] });
    const e = new Error('aborted'); e.name = 'AbortError'; throw e;
};
// 第二輪：問別的問題，模型直接回答；統計請求裡有幾則提醒
let reminderCounts = [];
const freshMock = async (url, init) => {
    if (!String(url).startsWith('http://fake.local/')) return window.__realFetch(url, init);
    const body = JSON.parse(init.body); const msgs = body.messages || [];
    if (/工具領域路由器/.test(String((msgs[0] || {}).content || ''))) return fakeMk({ content: JSON.stringify({ domains: [] }) });
    reminderCounts.push(msgs.filter((m) => m.role === 'system' && /讀取尚未完成/.test(String(m.content || ''))).length);
    return fakeMk({ content: '今天天氣晴朗。' });
};
window.__realFetch = window.fetch.bind(window);
async function entryCase(name, ignore, mode) {
    installLedgerSetter(ignore); fa.messages = [{ role: 'system', content: '你是測試助理。' }]; reminderCounts = [];
    fa._readReminders = null;
    let residueAfterTurn1 = null;
    if (mode === 'abort') {
        await chatTurn('查一下這份 log 裡有什麼錯誤', abortMock)();
        residueAfterTurn1 = L.pending(fa._readLedger || L.createLedger()).length;
    } else {
        // 入口案例：上一輪留下的殘留（模擬中止前已記下第一頁）
        fa._readLedger = L.record(L.createLedger(), TOOL, { offset: 0 }, { ok: true, has_more: true, next_offset: 1 });
        residueAfterTurn1 = L.pending(fa._readLedger).length;
    }
    const status = await chatTurn('今天天氣如何？', freshMock)();
    const asst = fa.messages.filter((m) => m.role === 'assistant').map((m) => String(m.content || ''));
    const out = { residue_after_prev_turn: residueAfterTurn1, status, reminders_in_request: Math.max(0, ...reminderCounts), final_text: asst.length ? asst[asst.length - 1] : null, warned: asst.some((t) => t.indexOf('注意：以下來源只讀了一部分') >= 0) };
    R[name] = out;
}
await entryCase('D_entry_before_fix', true, 'residue');
await entryCase('D_entry_after_fix', false, 'residue');
await entryCase('E_abort_before_fix', true, 'abort');
await entryCase('E_abort_after_fix', false, 'abort');
removeLedgerSetter();

// F：串流文字式路徑（[CALL:...] 的模型）。修前＝閘門換成 null；修後順從的模型讀完三頁。
function sseResp(content) {
    const chunk = (d, f) => 'data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: d, finish_reason: f }] }) + '\n\n';
    return new Response(chunk({ role: 'assistant', content }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
async function streamScenario(name, mode, gateOff) {
    const origGate = fa._readLedgerGate; const origNative = fa._shouldUseNativeToolCalls;
    if (gateOff) fa._readLedgerGate = () => null;
    fa._shouldUseNativeToolCalls = () => false;
    fa._readLedger = null; fa._readReminders = null; window.__toolOffsets = []; window.__lastPage = null;
    const realFetch = window.fetch.bind(window); const seen = [];
    window.fetch = async (url, init) => {
        if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
        const body = JSON.parse(init.body); const msgs = body.messages || []; const last = msgs[msgs.length - 1] || {};
        if (/工具領域路由器/.test(String((msgs[0] || {}).content || ''))) return sseResp(JSON.stringify({ domains: [] }));
        seen.push(last.role);
        const callPage = (off) => sseResp('[CALL:' + TOOL + '({"offset":' + off + '})]');
        if (last.role === 'user') return callPage(0);
        if (last.role === 'tool') return sseResp('報告都正確，沒有錯誤。');
        if (last.role === 'system') {
            if (mode === 'obedient' && window.__lastPage && window.__lastPage.has_more) return callPage(window.__lastPage.next_offset);
            return sseResp('報告都正確，沒有錯誤。');
        }
        return sseResp('報告都正確，沒有錯誤。');
    };
    fa.messages = [{ role: 'system', content: '你是測試助理。' }, { role: 'user', content: '查一下這份 log 裡有什麼錯誤' }];
    let status = 'ok';
    try { await fa._loopFetch('k', 'http://fake.local/v1', 'm', 1, null); } catch (e) { status = 'threw:' + String((e && e.message) || e); }
    finally { window.fetch = realFetch; fa._readLedgerGate = origGate; fa._shouldUseNativeToolCalls = origNative; }
    const asst = fa.messages.filter((m) => m.role === 'assistant').map((m) => String(m.content || ''));
    R[name] = { status, tool_offsets: window.__toolOffsets.slice(), request_last_roles: seen, final_text: asst.length ? asst[asst.length - 1] : null, warned: asst.some((t) => t.indexOf('注意：以下來源只讀了一部分') >= 0) };
}
await streamScenario('F_stream_before_fix', 'lazy', true);
await streamScenario('F_stream_after_fix', 'obedient', false);

// G：離線小模型迴圈 FaVlm.runAgentLoop。修前＝opts.readLedger=false（關閉帳本的對照）；修後順從的模型讀完三頁。
async function offlineScenario(name, mode, readLedgerOpt) {
    window.__toolOffsets = []; window.__lastPage = null;
    const reminders = [];
    const generate = async ({ messages }) => {
        const last = messages[messages.length - 1] || {};
        reminders.push(messages.filter((m) => m.role === 'system' && /讀取尚未完成/.test(String(m.content || ''))).length);
        const callPage = (off) => '<tool_call>{"name":"' + TOOL + '","arguments":{"offset":' + off + '}}</tool_call>';
        if (last.role === 'user') return callPage(0);
        if (last.role === 'tool') return '報告都正確，沒有錯誤。';
        if (last.role === 'system') { if (mode === 'obedient' && window.__lastPage && window.__lastPage.has_more) return callPage(window.__lastPage.next_offset); return '報告都正確，沒有錯誤。'; }
        return '報告都正確，沒有錯誤。';
    };
    const execTool = async ({ name: n, args }) => { const t = await fa.tools[TOOL].callback(JSON.stringify(args || {})); window.__lastRaw = t; return { ok: true, text: t }; };
    const opts = { messages: [{ role: 'system', content: '你是測試助理。' }, { role: 'user', content: '查一下這份 log 裡有什麼錯誤' }], tools: [{ type: 'function', function: { name: TOOL, description: 'x', parameters: { type: 'object' } } }], toolNames: new Set([TOOL]), budget: { prompt: 100000, reply: 1000, rag: 4000 }, maxRounds: 8, generate, execTool };
    if (readLedgerOpt !== undefined) opts.readLedger = readLedgerOpt;
    const res = await FaVlm.runAgentLoop(opts);
    R[name] = { reason: res.reason, tool_offsets: window.__toolOffsets.slice(), reminders_max: Math.max(0, ...reminders), final_text: res.text, warned: String(res.text || '').indexOf('注意：以下來源只讀了一部分') >= 0, notes: res.notes, calls: (res.calls || []).map((c) => ({ name: c.name, ok: c.ok, head: String(c.text || '').slice(0, 60) })) };
    if (name === 'G_offline_after_fix') {
        const Lm = fa._faReadLedgerMod(); const pr = JSON.parse(window.__lastRaw || '{}');
        R.G_probe = { parsed_has_more: pr.has_more, pending_after_record: Lm.pending(Lm.record(Lm.createLedger(), TOOL, { offset: 0 }, pr)).length, raw_head: String(window.__lastRaw || '').slice(0, 80) };
    }
}
await offlineScenario('G_offline_before_fix', 'lazy', false);
await offlineScenario('G_offline_after_fix', 'obedient', undefined);

delete fa.tools[TOOL];
fa._getRootToolNames = origRoot;
return R;
