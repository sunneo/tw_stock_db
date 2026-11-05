// 超大回應轉 JSONL＋分頁器＋讀取帳本（真實 Electron、假 LLM）。
// 用法：node scripts/eval/run_eval.js scripts/eval/jsonl-paging.eval.js 17951
// 假工具 test_big_records 回傳 4000 個物件的大 JSON（遠超過工具結果預算）。
//   A 順從的模型：看到第一頁（JSONL，第一行 _page meta）就用 big_content page 帶 next_cursor 一頁頁讀到最後，最終回答被接受，不加警語；4000 筆全部讀到。
//   B 偷懶的模型：只看第一頁就回答 → 帳本擋下並提醒（附缺口 cursor）→ 之後順從讀完 → 放行。
//   C 固執的模型：永遠直接回答 → 提醒用完後，答案前面由程式附警語（寫明讀了多少筆）。
//   D 跳頁的模型：看第一頁後直接跳到最後一頁 → 缺口仍在，被擋下。
const fa = window.fa; const R = {};
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }
const TOTAL = 4000;
const TOOL = 'test_big_records';
fa.tools[TOOL] = {
    description: '假的大回應工具（評估用）：回傳 4000 個物件。',
    parametersSchema: { type: 'object', properties: {} },
    callback: async () => JSON.stringify({ ok: true, image: 'x.png', objects: Array.from({ length: TOTAL }, (_, i) => ({ id: i + 1, label: '物件' + (i + 1), bbox: [i, i, 5, 5] })) })
};
const origRoot = fa._getRootToolNames.bind(fa);
fa._getRootToolNames = () => Array.from(new Set(origRoot().concat([TOOL, 'big_content'])));
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
fa._shouldUseNativeToolCalls = () => true;

const parsePage = (text) => { const rows = String(text || '').split('\n'); try { const m = JSON.parse(rows[0]); if (!m._page) return null; return { meta: m._page, n: rows.length - 1 }; } catch (_) { return null; } };

function scenario(mode) {
    return async () => {
        const realFetch = window.fetch.bind(window);
        fa._readLedger = null; fa._readReminders = null; if (fa._bigStore) fa._bigStore.clear();
        const seen = { records: 0, pages: 0, firstPageIsJsonl: false, reminderSeen: 0, jumped: false }; let lazyDone = false;
        const reqs = [];
        window.fetch = async (url, init) => {
            if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
            const body = JSON.parse(init.body); const msgs = body.messages || []; const last = msgs[msgs.length - 1] || {};
            reqs.push(last.role);
            if (/工具領域路由器/.test(String((msgs[0] || {}).content || ''))) return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ domains: [] }) }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            const mk = (msg) => new Response(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant', content: '' }, msg), finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            const call = (name, args) => mk({ tool_calls: [{ id: 'c' + reqs.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
            const answer = () => mk({ content: '我看完了，共 ' + seen.records + ' 個物件。' });
            const remind = msgs.filter((m) => m.role === 'system' && /讀取尚未完成/.test(String(m.content || ''))).length; seen.reminderSeen = Math.max(seen.reminderSeen, remind);
            if (last.role === 'user') return call(TOOL, {});
            const nextFromTool = () => {
                const lastTool = [...msgs].reverse().find((m) => m.role === 'tool'); const pg = lastTool ? parsePage(typeof lastTool.content === 'string' ? lastTool.content : JSON.stringify(lastTool.content)) : null;
                return pg;
            };
            const pg = nextFromTool();
            if (last.role === 'tool' && pg) {
                if (!seen.pages) seen.firstPageIsJsonl = true;
                seen.pages++; seen.records += pg.n;
                if (mode === 'lazy' && !lazyDone) { lazyDone = true; return answer(); }
                if (mode === 'stubborn') return answer();
                if (mode === 'jump' && !seen.jumped) { seen.jumped = true; const m = pg.meta; const last = 'c1:' + m.source + ':' + (TOTAL - 5) + ':0:99'; return call('big_content', { id: m.source, action: 'page', cursor: last }); }
                if (pg.meta.has_more && mode !== 'jump') return call('big_content', { id: pg.meta.source, action: 'page', cursor: pg.meta.next_cursor });
                if (mode === 'jump') return answer();
                return answer();
            }
            if (last.role === 'system') { // 提醒：順從的模型照提醒裡的 cursor 讀
                const lastSys = String(last.content || ''); const mm = /來源 (bc_\d+)[^\n]*cursor：(c1:[^）\n]+)/.exec(lastSys) || /來源 (bc_\d+)[^\n]*下一頁 cursor：(c1:[^\s；]+)/.exec(lastSys);
                if (mode === 'stubborn' || !mm) return answer();
                return call('big_content', { id: mm[1], action: 'page', cursor: mm[2] });
            }
            return answer();
        };
        fa.messages = [{ role: 'system', content: '你是測試助理。' }, { role: 'user', content: '把圖拆解出來的物件全部看一遍，告訴我有幾個' }];
        try { await fa._loopFetchNative('k', 'http://fake.local/v1', 'm', 1, null); }
        catch (e) { return { error: String((e && e.message) || e) }; }
        finally { window.fetch = realFetch; }
        const asst = fa.messages.filter((m) => m.role === 'assistant').map((m) => String(m.content || ''));
        return Object.assign(seen, { final_text: asst.length ? asst[asst.length - 1] : null, warned: asst.some((t) => t.indexOf('注意：以下來源只讀了一部分') >= 0), request_roles: reqs.length });
    };
}

R.loaded = { has_pager: typeof fa._jsonlPagerMod === 'function' && typeof fa._jsonlPagerMod().page === 'function', big_content_registered: !!fa.tools.big_content, ledger_has_describe: typeof fa._faReadLedgerMod().describe === 'function' };
R.A_obedient = await scenario('obedient')();
R.B_lazy_then_obedient = await scenario('lazy')();
R.C_stubborn = await scenario('stubborn')();
R.D_jump = await scenario('jump')();
return R;
