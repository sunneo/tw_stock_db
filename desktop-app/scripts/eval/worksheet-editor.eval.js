// 學習單編輯器（對話裡的小工具，真實 Electron）：預覽點選、屬性面板、AI 對話（程式先讀；讀不懂才問模型；附圖走視覺模型）、
// 復原／重做、編輯記錄、摘要成 prompt、匯出、重新整理後接著編輯、worksheet_adjust 同步更新已開著的編輯器。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/worksheet-editor.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {}; fa.advancedSettings.offlineMode = false;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(60); } return null; };
fa.messages = [];
const REQ = '幫我做串珠 10又幾 做8串，右邊填數字';
const made = await fa._worksheetMake({ request: REQ }); R.make = { ok: made.ok, id: !!made.worksheet_id };
const id = made.worksheet_id;
// 對話裡有一則放了編輯器的訊息
const msg = fa.messages.filter((m) => /```fa-worksheet/.test(String(m.content || ''))).pop(); R.message_has_fence = !!msg && JSON.parse(/```fa-worksheet\n([\s\S]*?)\n```/.exec(msg.content)[1]).id === id;
fa._renderMessageHistory(); const ed = await until(() => document.querySelector('.fwk')); R.mounted = !!ed;
const ws = ed._ws; const spec = () => ws.getState().states[ws.getState().ptr].spec; const steps = () => ws.getState().states.length;
R.start = { steps: steps(), rows: spec().blocks[0].counts.length, undoDisabled: [...ed.querySelectorAll('button')].find((b) => /復原/.test(b.textContent)).disabled };

// 1) 預覽：點一串 → 選取＋切到屬性面板
const svg = ed.querySelector('.pv svg'); const rb = svg.getBoundingClientRect(); const L = FaWorksheet.layout(spec()); const row3 = L.rowBoxes[2];
svg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rb.left + (row3.x + 20) / L.w * rb.width, clientY: rb.top + (row3.y + row3.h / 2) / L.h * rb.height }));
await wait(100); R.click_select = { propsTab: ed.querySelector('.tabs span.on').textContent, selectedChip: !!ed.querySelector('.cc.sel'), highlight: /stroke-dasharray="2 1.2"/.test(ed.querySelector('.pv').innerHTML) };

// 2) 對話：程式讀得懂的，不問模型（fetch 計數）
const realFetch = window.fetch.bind(window); let llmCalls = 0; let llmReply = null;
if (typeof FaLlm !== 'undefined') FaLlm.realFetch = null;
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' }); fa._shouldUseNativeToolCalls = () => false;
window.fetch = async (url, init) => { if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init); llmCalls++; return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: llmReply }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
await ws.send('把第3串改成粉紅色，附上答案，改成橫式'); await until(() => steps() === 2);
R.chat_program = { llmCalls, steps: steps(), color3: spec().blocks[0].colors[3], show: spec().blocks[0].answer.show, orient: spec().page.orient, summary: ws.getState().states[1].summary, chips: ed.querySelectorAll('.msg.a .chip').length };
// 3) 復原／重做：一次說的話算一步
ws.undo(); R.undo = { ptr: ws.getState().ptr, orient: spec().orient || spec().page.orient, show: spec().blocks[0].answer.show }; ws.redo(); R.redo = { ptr: ws.getState().ptr, orient: spec().page.orient };
// 4) 讀不懂的句子：才問模型（封閉的編輯動作）；模型亂回動作會被擋下
llmReply = JSON.stringify({ say: '把標題改好了', edits: [{ op: 'set_title', text: '彩色串珠（二）' }, { op: 'format_disk' }] }); const before = llmCalls;
await ws.send('幫我把這份弄得更適合幼稚園小朋友'); await until(() => steps() === 3);
R.chat_model = { llmCalls: llmCalls - before, title: spec().title, steps: steps(), ai: [...ed.querySelectorAll('.msg.a')].pop().textContent.slice(0, 40) };
llmReply = 'not json at all'; await ws.send('做一個超級酷的版面'); await wait(600); R.chat_model_bad = { steps: steps(), msg: [...ed.querySelectorAll('.msg.a')].pop().textContent.slice(0, 40) };
// 5) 附圖：視覺模型只回 JSON，程式檢查後併進來
const realVlm = fa._interpretImageWithVisionModel; fa._interpretImageWithVisionModel = async () => ({ description: JSON.stringify({ rows: [{ count: 1, color: '#112233' }, { count: 2, color: '#445566' }, { count: 3, color: '#778899' }] }) });
const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='; const n0 = steps();
const bAtt = ed.querySelector('input[type=file]'); // 用 paste 事件路徑以外的測試入口：直接走 host.ask（UI 只是把附圖交給它）
const ans = await fa._worksheetAsk({ text: '', images: [{ name: 'ref.png', dataUrl: tiny }], spec: spec() }); R.ask_ref = { refs: ans.refs.length, rows: ans.refs[0] && ans.refs[0].rows.length };
fa._interpretImageWithVisionModel = async () => { throw new Error('vision down'); }; const ans2 = await fa._worksheetAsk({ text: '', images: [{ name: 'x.png', dataUrl: tiny }], spec: spec() }); R.ask_ref_down = { refs: ans2.refs.length, note: ans2.notes[0] };
fa._interpretImageWithVisionModel = realVlm;
// 6) 記錄與屬性面板
R.history_rows = ed.querySelectorAll('.hist div').length; [...ed.querySelectorAll('.tabs span')].find((x) => /屬性/.test(x.textContent)).click(); await wait(50);
const titleInput = ed.querySelector('.pane.on input'); titleInput.value = '我的學習單'; titleInput.dispatchEvent(new Event('change')); await wait(80); R.panel_title = { title: spec().title, summary: ws.getState().states[ws.getState().ptr].summary };
const numIn = [...ed.querySelectorAll('.pane.on input[type=number]')][0]; numIn.value = 9; numIn.dispatchEvent(new Event('change')); await wait(80); R.panel_base = spec().blocks[0].base;
// 7) 摘要成 prompt
[...ed.querySelectorAll('.bar button')].find((b) => /摘要/.test(b.textContent)).click(); await wait(60); const sumTa = ed.querySelector('.sum textarea'); R.summary = { on: ed.querySelector('.sum').className.includes('on'), text: sumTa.value.slice(0, 300), hasSteps: /編輯過程/.test(sumTa.value), hasTitle: /我的學習單/.test(sumTa.value) };
// 8) 匯出（PDF／PNG／HTML／JSON 都變成下載卡片）
const cards0 = fa.messages.filter((m) => m._downloadFile).length; const sel = ed.querySelector('.bar select'); for (const k of ['pdf', 'png', 'html', 'json']) { sel.value = k; sel.dispatchEvent(new Event('change')); await until(() => fa.messages.filter((m) => m._downloadFile).length > cards0 + ['pdf', 'png', 'html', 'json'].indexOf(k), 15000); }
R.export = fa.messages.filter((m) => m._downloadFile).slice(cards0).map((m) => m._downloadFile.filename.split('.').pop());
// 9) 重新整理後接著編輯：進度（每一步、復原位置、對話）從存好的檔讀回來
await wait(700); const saved = ws.getState(); fa._wsEditors.delete(id); fa._wsSpecs.delete(id); // 模擬重新整理：記憶體裡的都沒了，只剩存好的檔
const holder = document.createElement('div'); holder.innerHTML = '<pre><code class="language-fa-worksheet">' + JSON.stringify({ id }) + '</code></pre>'; document.body.appendChild(holder); fa._mountWorksheetEditors(holder); const ed2 = await until(() => holder.querySelector('.fwk'));
if (!ed2) return Object.assign(R, { resume: 'failed', holder: holder.textContent.slice(0, 80) });
R.resume = ed2 && { steps: ed2._ws.getState().states.length === saved.states.length, ptr: ed2._ws.getState().ptr === saved.ptr, log: ed2._ws.getState().log.length === saved.log.length, title: ed2._ws.getState().states[ed2._ws.getState().ptr].spec.title, canUndo: !ed2.querySelector('.bar button').disabled };
// 10) 從對話用 worksheet_adjust 改：同一個 id、已開著的編輯器多一步
const n1 = ed2._ws.getState().states.length; const adj = await fa._worksheetAdjust({ worksheet_id: id, edits: [{ op: 'set_subtitle', text: '由對話改的說明' }] });
R.adjust_sync = { ok: adj.ok, sameId: adj.worksheet_id === id, steps: ed2._ws.getState().states.length - n1, subtitle: ed2._ws.getState().states[ed2._ws.getState().ptr].spec.subtitle };
// 11) worksheet_open：放一個編輯器；空白的也可以
const nMsg = fa.messages.length; const op = JSON.parse(await fa.tools.worksheet_open.callback.call(fa, JSON.stringify({ blank: true }))); R.open_blank = { ok: op.ok, newMessage: fa.messages.length > nMsg };
R.open_missing = JSON.parse(await fa.tools.worksheet_open.callback.call(fa, JSON.stringify({ worksheet_id: 'ws_nope' }))).ok === false;
// 12) 畫面（截圖用）
R.same_id_cached = fa._wsEditors.get(id) === holder.firstChild; document.body.removeChild(holder); R.ready = true; window.fetch = realFetch; return R;
