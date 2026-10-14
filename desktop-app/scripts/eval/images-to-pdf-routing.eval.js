// 「圖片轉PDF」的專用工具會不會被找到：根層級（使用者訊息命中→直接拿到 images_to_pdf＋做法提醒）與委派（不管根模型挑哪個領域）。假 LLM、真實 Electron。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/images-to-pdf-routing.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {};
const saved = fa.messages; const U = (t) => [{ role: 'user', content: t }];
fa.messages = U('C:\\Users\\hungfu.lee\\Pictures\\topdf\\in-1\n每個圖片檔案前面有編號prefix (1_ , 2_, ...12_)\n先把圖片變成等比例縮放，置中，每張圖都縮放到A4大小\n然後再合併成一個pdf');
R.root_hit = { tools: fa._getRootToolNames().filter((n) => /images_to_pdf|list_uploaded/.test(n)), note: /images_to_pdf/.test(fa._getFinalSystemPrompt()) };
fa.messages = U('幫我看一下今天的股價'); R.root_miss = { has: fa._getRootToolNames().includes('images_to_pdf'), note: /這個需求有專用工具/.test(fa._getFinalSystemPrompt()) };
fa.messages = U('把 pdf 轉成圖片'); R.root_reverse = fa._getRootToolNames().includes('images_to_pdf');
fa.messages = saved;
// 委派：根模型挑了沒有這個工具的領域（desktop_ops 以前沒有、research 沒有）——這次執行也要拿到
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' }); fa._shouldUseNativeToolCalls = () => true;
const realFetch = window.fetch.bind(window); const seen = [];
window.fetch = async (url, init) => { if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init); const body = JSON.parse(init.body); seen.push({ tools: (body.tools || []).map((t) => t.function && t.function.name), sys: String((body.messages[0] || {}).content || '') }); return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
for (const dom of ['research', 'desktop_ops', 'code_execution', 'file_analysis']) { seen.length = 0; await fa._delegateToSubagentDomain(dom, '處理圖片轉 PDF 任務：資料夾 C:\\pics，使用 img2pdf 將處理後的圖片合併為單一 PDF'); const r = seen[0] || {}; R['delegate_' + dom] = { has_tool: (r.tools || []).includes('images_to_pdf'), note: /這個需求有專用工具：images_to_pdf/.test(r.sys || '') }; }
seen.length = 0; await fa._delegateToSubagentDomain('research', '抽出 PDF 裡的圖片'); R.delegate_reverse = (seen[0] && seen[0].tools || []).includes('images_to_pdf');
window.fetch = realFetch; return R;
