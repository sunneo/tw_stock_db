// 網頁編輯器（真實 Electron）：起手式、預覽 iframe 接上模擬後端（頁面的 fetch／WebSocket 真的由後端回應）、後端編輯器（測試請求、紀錄、持久資料、匯出）、
// 對話（程式先讀；頁面用封閉動作；後端交給程式設計領域並先載入檢查）、復原重做、進度保留、跨機器開啟、斜線指令與依任務補工具。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/webedit.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fa.advancedSettings.offlineMode = false; fa.messages = [];
const until = async (f, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(80); } return null; };
const lastEditor = () => { const l = [...document.querySelectorAll('.fwe')]; return l[l.length - 1]; };
const specOf = (ed) => ed._we.getState().states[ed._we.getState().ptr].spec; const stepsOf = (ed) => ed._we.getState().states.length;

// 1) 起手式 todo：編輯器出現在對話裡；預覽的頁面真的呼叫後端
const o1 = await fa._webeditOpen({ starter: 'todo' }); R.open = { ok: o1.ok, summary: o1.summary };
const fence = fa.messages.filter((m) => /```fa-webedit/.test(String(m.content || ''))).pop(); R.fence = !!fence;
fa._renderMessageHistory(); const ed = await until(() => lastEditor()); R.mounted = !!ed; const id = o1.id;
await until(() => { const r = fa._weRuns && fa._weRuns.get(id); return r && r.hub && r.hub.calls.some((c) => c.path === '/api/todos'); }, 20000);
const run = () => fa._weRuns.get(id);
R.page_called_backend = run() && run().hub.calls.filter((c) => c.kind === 'http').map((c) => c.method + ' ' + c.path + ' ' + c.status).slice(0, 3);
R.preview_status = ed.querySelector('.pane.on .st') && ed.querySelector('.pane.on .st').textContent;
R.iframe = { sandboxed: /allow-scripts/.test(ed.querySelector('iframe').getAttribute('sandbox')) && !/allow-same-origin/.test(ed.querySelector('iframe').getAttribute('sandbox')), inlined: /data-file="app\.js"/.test(ed.querySelector('iframe').srcdoc) && /mock/i.test(ed.querySelector('iframe').srcdoc) };

// 2) 後端分頁：路由、測試請求、紀錄、持久資料
ed._we.showTab('backend'); await wait(200);
R.backend_tab = { routes: ed.querySelector('.pane.on .st').textContent.slice(0, 60), lang: ed.querySelectorAll('select')[1] && ed.querySelectorAll('select')[1].value };
const host = fa._webeditHost(id);
const post = await host.request({ method: 'POST', url: '/api/todos', headers: [['content-type', 'application/json']], body: JSON.stringify({ text: '買牛奶', done: false }) });
const list = await host.request({ method: 'GET', url: '/api/todos' }); let items = []; try { items = JSON.parse(list.body); } catch (_) { /* */ }
R.request = { post: post.status, got: items.length, text: items[0] && items[0].text }; R.db = (await host.db('list', [''])).map((e) => e.key).slice(0, 3); R.log = host.log().calls.slice(-2).map((c) => c.method + ' ' + c.path + ' ' + c.status);
const t404 = await host.request({ method: 'GET', url: '/api/nope' }); R.not_found = t404.status;
// 測試請求按鈕（UI）
const tu = [...ed.querySelectorAll('.pane.on input')].find((i) => i.placeholder === '/api/ping'); tu.value = '/api/ping'; [...ed.querySelectorAll('.pane.on button')].find((b) => b.textContent === '送出').click(); await wait(600); R.tester_ui = ed.querySelector('.pane.on pre.out').textContent.slice(0, 40);
R.export = (await host.exportBackend('node')).files.map((f) => f.name).slice(0, 4); R.export_cf = (await host.exportBackend('cloudflare')).files.length > 0;

// 3) 改後端程式（手動）：重啟、路由更新、資料還在
const ta = ed.querySelectorAll('textarea.code')[1]; const code0 = run().hub.code; ta.value = code0 + '\napp.get("/api/hello", () => ({ hi: "你好" }));\n';
[...ed.querySelectorAll('.pane.on button')].find((b) => /套用並重啟/.test(b.textContent)).click(); await wait(1500);
const hello = await host.request({ method: 'GET', url: '/api/hello' }); R.backend_edit = { steps: stepsOf(ed), hello: hello.status, dataKept: JSON.parse((await host.request({ method: 'GET', url: '/api/todos' })).body).length };
// 壞的後端程式：套用不會丟例外、顯示錯誤、前一版仍在跑
ta.value = 'const app = router(;'; [...ed.querySelectorAll('.pane.on button')].find((b) => /套用並重啟/.test(b.textContent)).click(); await wait(2500); R.bad_backend = { status: ed.querySelector('iframe') ? ed.querySelector('.pane.on') && true : false, stillRuns: (await host.request({ method: 'GET', url: '/api/hello' }).then((r) => r.status, () => 0)) };

// 4) 程式碼分頁：改檔案、新增檔案
ed._we.showTab('code'); await wait(100); const n0 = stepsOf(ed); const cta = ed.querySelector('textarea.code'); const fileBtns = [...ed.querySelectorAll('.files span')].map((s) => s.textContent); [...ed.querySelectorAll('.files span')].find((s) => s.textContent === 'style.css').click(); await wait(60);
const cta2 = ed.querySelector('textarea.code'); cta2.value = cta2.value + '\nh1{color:#d00}\n'; cta2.dispatchEvent(new Event('change')); await wait(100); R.code_edit = { files: fileBtns, steps: stepsOf(ed) - n0, hasRule: /color:#d00/.test(specOf(ed).files[1].content) };

// 5) 對話：程式先讀（改標題、刪檔）
const llm = { calls: 0, reply: '' }; if (typeof FaLlm !== 'undefined') FaLlm.realFetch = null; const realFetch = window.fetch.bind(window);
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 }); fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' }); fa._shouldUseNativeToolCalls = () => false;
window.fetch = async (url, init) => { if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init); llm.calls++; const b = JSON.parse(init.body); llm.last = JSON.stringify(b.messages).slice(0, 3000); return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: typeof llm.reply === 'function' ? llm.reply(b) : llm.reply }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
const before = stepsOf(ed); await ed._we.send('標題改成「我的待辦」，刪掉 style.css'); await until(() => stepsOf(ed) > before); R.chat_program = { llm: llm.calls, title: specOf(ed).title, files: specOf(ed).files.map((f) => f.name).join(), steps: stepsOf(ed) - before };
ed._we.undo(); R.undo = { files: specOf(ed).files.map((f) => f.name).join(), title: specOf(ed).title }; ed._we.redo();
// 6) 對話：頁面（模型回封閉動作）；壞動作被擋、不會假裝成功
llm.reply = JSON.stringify({ say: '把標題字改成藍色了', edits: [{ op: 'patch_file', name: 'index.html', find: '<h1>待辦清單</h1>', replace: '<h1 style="color:#06c">待辦清單</h1>' }, { op: 'patch_file', name: 'index.html', find: '這段不存在', replace: 'x' }] }); const b6 = stepsOf(ed);
await ed._we.send('把頁面標題的字改成藍色'); await until(() => stepsOf(ed) > b6); R.chat_front = { llm: llm.calls, steps: stepsOf(ed) - b6, blue: /color:#06c/.test(specOf(ed).files[0].content), rejected: ed.querySelectorAll('.msg.a .chip.rej').length, promptHasFiles: /=== index\.html ===/.test(llm.last) };
llm.reply = JSON.stringify({ say: '好', edits: [{ op: 'patch_file', name: 'index.html', find: '不存在', replace: 'x' }] }); const b6b = stepsOf(ed); await ed._we.send('把按鈕變成圓的'); await wait(900); R.chat_front_fail = { steps: stepsOf(ed) - b6b, msg: [...ed.querySelectorAll('.msg.a')].pop().textContent.slice(0, 14) };
// 7) 對話：後端交給程式設計領域（這裡用假的子Agent）；先載入檢查；壞程式不套用
const delegated = []; const realDelegate = fa._delegateToSubagentDomain; const GOOD = 'const app = router();\napp.crud("/api/todos", "todos");\napp.get("/api/search", async (req, env) => { const q = new URL(req.url).searchParams.get("q") || ""; const rows = await env.db.list("todos/"); return json(rows.map((r) => r.value).filter((t) => String(t.text).includes(q))); });\n';
fa._delegateToSubagentDomain = async (dom, task) => { delegated.push({ dom, task }); return { ok: true, text: '加了搜尋端點。\n```js\n' + GOOD + '```\n路由：CRUD /api/todos、GET /api/search' }; };
llm.calls = 0; const b7 = stepsOf(ed); await ed._we.send('後端加一個 /api/search?q= 的搜尋端點'); await until(() => stepsOf(ed) > b7, 30000);
R.chat_backend = { domain: delegated[0] && delegated[0].dom, taskHasCode: !!(delegated[0] && /app\.crud/.test(delegated[0].task) && /完整的新後端程式/.test(delegated[0].task) && /index\.html/.test(delegated[0].task)), steps: stepsOf(ed) - b7, routes: specOf(ed).backend && specOf(ed).backend.code.includes('/api/search'), llmForFront: llm.calls };
await wait(1200); const sr = await host.request({ method: 'GET', url: '/api/search?q=牛' }).then((r) => r.status, () => 0); R.search_runs = sr;
fa._delegateToSubagentDomain = async () => ({ ok: true, text: '```js\nconst app = router(;\n```' }); const b7b = stepsOf(ed); await ed._we.send('後端再加一個 /api/x 端點'); await wait(2500); R.chat_backend_bad = { steps: stepsOf(ed) - b7b, note: [...ed.querySelectorAll('.msg.a')].pop().textContent.slice(0, 40) };
fa._delegateToSubagentDomain = realDelegate; window.fetch = realFetch;
// 8) 離線模式：程式讀得懂的照常，其餘說明
fa.advancedSettings.offlineMode = true; const offAns = await fa._webeditAsk({ text: '把頁面弄好看一點', images: [], spec: specOf(ed) }); fa.advancedSettings.offlineMode = false; R.offline = { edits: offAns.edits.length, say: offAns.say.slice(0, 12) };
// 9) 摘要 prompt
[...ed.querySelectorAll('.bar button')].find((b) => /摘要/.test(b.textContent)).click(); await wait(80); R.summary = { has: /我的待辦|待辦/.test(ed.querySelector('.sum.on textarea').value), backend: /\/api\/search/.test(ed.querySelector('.sum.on textarea').value), steps: /編輯過程/.test(ed.querySelector('.sum.on textarea').value) };
// 10) 進度保留與跨機器開啟
await wait(700); const saved = ed._we.getState(); fa._weEditors.delete(id); fa._weSpecs.delete(id); fa._weStore; const hold = document.createElement('div'); hold.innerHTML = '<pre><code class="language-fa-webedit">' + JSON.stringify({ id }) + '</code></pre>'; document.body.appendChild(hold); fa._mountWebEditors(hold); const ed2 = await until(() => hold.querySelector('.fwe'));
R.resume = ed2 && { steps: ed2._we.getState().states.length === saved.states.length, ptr: ed2._we.getState().ptr === saved.ptr, log: ed2._we.getState().log.length === saved.log.length }; if (ed2) ed2._we.destroy(); hold.remove();
const tiny = FaWebEdit.starter('blank'); fa._weSpecs.clear(); for (const r of await fa.fileCache.getAll()) if (/^webedit_/.test(r.filename || '')) await fa.fileCache.delete(r.id); fa._weEditors = new Map();
const hold2 = document.createElement('div'); hold2.innerHTML = '<pre><code class="language-fa-webedit">' + JSON.stringify({ id: 'we_remote1', spec: tiny }) + '</code></pre>'; document.body.appendChild(hold2); fa._mountWebEditors(hold2); const ed3 = await until(() => hold2.querySelector('.fwe')); R.remote_open = { mounted: !!ed3, title: ed3 && ed3._we.getState().states[0].spec.title }; if (ed3) ed3._we.destroy(); hold2.remove();
// 11) 聊天室（WebSocket）：頁面真的連上、後端廣播
const o2 = await fa._webeditOpen({ starter: 'chat' }); fa._renderMessageHistory(); const edc = await until(() => lastEditor()); const idc = o2.id;
await until(() => { const r = fa._weRuns.get(idc); return r && r.hub && r.hub.calls.some((c) => c.kind === 'ws' && c.ev === 'open'); }, 20000);
const hc = fa._weRuns.get(idc).hub; R.chat_ws = { pageOpened: hc.calls.some((c) => c.kind === 'ws' && c.ev === 'open' && c.path === '/chat'), wsRoutes: hc.wsRoutes };
const got = []; let conn = hc.wsOpen({ onOpen() { }, onMessage: (d) => got.push(String(d)), onClose() { }, onReject() { } }, 'ws://mock.local/chat'); await wait(400); hc.wsSend(conn, 'hello'); await wait(600); R.ws_broadcast = got;
// 12) Python 後端（Pyodide）：測試請求、頁面路由讀取；WebSocket 要說明不支援
const cnt0 = document.querySelectorAll('.fwe').length; const o3 = await fa._webeditOpen({ starter: 'python_api' }); fa._renderMessageHistory(); const edp = await until(() => document.querySelectorAll('.fwe').length > cnt0 && lastEditor()); const idp = o3.id; const hp = fa._webeditHost(idp);
await until(() => { const r = fa._weRuns.get(idp); return r && r.hub; }, 180000); R.py_started = !!(fa._weRuns.get(idp) && fa._weRuns.get(idp).hub);
if (R.py_started) { const pr = await hp.request({ method: 'GET', url: '/api/hello?name=Bob' }); let pj = null; try { pj = JSON.parse(pr.body); } catch (_) { /* */ } R.py_request = { status: pr.status, msg: pj && pj.message, len: pj && pj.length }; const p404 = await hp.request({ method: 'GET', url: '/nope' }); R.py_404 = p404.status; let rej = ''; fa._weRuns.get(idp).hub.wsOpen({ onReject: (r) => { rej = r; } }, 'ws://mock.local/x'); await wait(100); R.py_ws = rej.slice(0, 20); const px = await hp.exportBackend('python'); R.py_export = { names: px.files.map((f) => f.name), prompt: /部署教學/.test((px.files.find((f) => /PROMPT\.md$/.test(f.name)) || {}).content || '') };
  const cnt = 'from flask import Flask, jsonify\napp = Flask(__name__)\nn = {"v": 0}\n@app.get("/c")\ndef c():\n    n["v"] += 1\n    return jsonify(n["v"])\n';
  const h1 = (await fa._webeditPyHub('we_cnt', cnt)).hub; const v = []; for (let i = 0; i < 3; i++) { const r = await h1.http({ method: 'GET', url: 'http://mock.local/c' }); v.push(JSON.parse(new TextDecoder().decode(r.body))); }
  h1.close(); const h2 = (await fa._webeditPyHub('we_cnt', cnt, true)).hub; const r2 = await h2.http({ method: 'GET', url: 'http://mock.local/c' }); v.push(JSON.parse(new TextDecoder().decode(r2.body))); h2.close(); R.py_session = v; }
// 13) 斜線指令與依任務補工具
fa.messages = []; const cmd = fa.slashCommands && (fa.slashCommands['/webedit'] || (fa.slashCommands.get && fa.slashCommands.get('/webedit'))); R.slash = !!cmd;
if (cmd) { const run1 = cmd.handler || cmd.run || cmd; await run1('起手式', fa); R.slash_list = /todo/.test(String((fa.messages[fa.messages.length - 1] || {}).content || '')); const n = fa.messages.length; await run1('chat', fa); R.slash_starter = fa.messages.slice(n).some((m) => /fa-webedit/.test(String(m.content || ''))); }
R.hints = ['幫我做一個記帳的小網站', '我想要 html 編輯器，除了預覽也有 mock backend 模擬 node 的假 server', '怎麼做網站比較好', '抓取網頁內容'].map((t) => _faTaskToolHints(t).map((h) => h.id).join());
R.domain = !!(fa.domains && fa.domains.webedit && fa.domains.webedit.enabled); R.tools = ['webedit_open', 'webedit_topic'].every((n) => !!fa.tools[n]);
[edp, edc, ed].forEach((e) => { try { e && e._we && e._we.destroy(); } catch (_) { /* */ } }); return R;
