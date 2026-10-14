// 叫用 RAG 之後的「能力反思」與「改寫那條 RAG」：假 LLM、真實 Electron，用使用者匯出的真實 RAG 記錄（含 15 筆「圖片轉 PDF 自己寫 python」的舊記憶）。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/rag-reflection.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)
// 需要 /tmp/rag-records.json（RAG 匯出）；沒有時改用內建的三筆代表性記錄。
const fa = window.fa; const raw = window.desktopAPI.rawfs; const R = {};
let json; try { json = (await raw.readFile('/tmp/rag-records.json')).text; } catch (_) { json = null; }
if (!json) json = JSON.stringify({ version: 1, records: [
  { id: 'pref_image_batch_a4_pdf', content: '## 圖片批次縮放與 PDF 合併 (A4 Zoom)\n依檔名數字前綴排序，使用 Pillow 縮放到 A4，img2pdf 合併。\n```python\nfrom PIL import Image\nimport img2pdf\n```', timestamp: Date.now(), lastAccessed: Date.now(), dependencies: [], preConditions: [], tags: ['python', 'pdf'] },
  { id: 'pref_weekly_report_pptx', content: '## 週報產生：用 python-pptx 複製投影片\n```python\nfrom pptx import Presentation\n```', timestamp: Date.now(), lastAccessed: Date.now(), dependencies: [], preConditions: [], tags: ['pptx'] } ] });
// 測試不載入語意向量模型：用「中文 bigram／英文詞」雜湊成 256 維向量當語意向量（內建 TF-IDF 對沒有空白的中文幾乎比不到東西）
fa.ragSystem.embeddingProvider = async (text) => { const v = new Array(256).fill(0); for (const w of fa._capTokens(String(text).slice(0, 4000))) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % 256] += 1; } const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1; return { vector: v.map((x) => x / n), modelKey: 'test-hash256' }; };
fa.advancedSettings.ragEnabled = true; fa.advancedSettings.ragSelfHeal = true;
console.log('[eval] import'); await fa.ragSystem.clearAll(); await fa.ragSystem.importAll(json, 'replace'); R.nodes = (await fa.ragSystem.getAll()).length;
// 1) 能力候選：真實請求要找到 images_to_pdf；不相干的請求不亂推薦
console.log('[eval] cands'); const Q = { pdf: 'C:\\Users\\x\\Pictures\\topdf\\in-1 每個圖片檔案前面有編號prefix 先把圖片變成等比例縮放 置中 每張圖都縮放到A4大小 然後再合併成一個pdf', merge: '把這三個docx和一個xlsx合併成一份pdf', draw: '畫一張登入流程的流程圖', stock: '幫我看一下 2330 今天的股價', weekly: '幫我產生這週的週報投影片' };
R.cands = {}; for (const [k, q] of Object.entries(Q)) R.cands[k] = fa._capabilityCandidates(q).map((c) => c.name + ':' + c.score);
R.reflection_head = fa._capabilityReflectionText(Q.pdf).slice(0, 260); console.log('[step] candidates done');
// 2) 假 LLM：根模型先呼叫 images_to_pdf（用剛放進去的圖片），再給最終回覆；記下它看到的訊息
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' }); fa._shouldUseNativeToolCalls = () => true; fa._ensureNativeToolSupportProbed = async () => true;
const mkPng = async (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').fillRect(0, 0, w, h); return await new Promise((r) => c.toBlob(r)); };
console.log('[eval] files'); const id1 = await fa.fileCache.put('1_a.png', 'image/png', await mkPng(300, 200), 'uploaded'), id2 = await fa.fileCache.put('2_a.png', 'image/png', await mkPng(200, 300), 'uploaded');
const realFetch = window.fetch.bind(window); const seen = [];
window.fetch = async (url, init) => {
  if (String(url).startsWith('http://fake.local/')) console.log('[eval] llm request #' + (seen.length + 1));
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body); const msgs = body.messages; const sysAll = msgs.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
  const hasTool = seen.length > 0; /* 第一個請求回工具呼叫，之後都回最終文字 */ seen.push({ tools: (body.tools || []).map((t) => t.function && t.function.name).filter((n) => /images_to_pdf|merge_pdfs/.test(n)), reflection: /【反思：先看現有能力/.test(sysAll), lists_tool: /images_to_pdf：/.test(sysAll), hasTool });
  const mk = (msg) => new Response(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant', content: '' }, msg), finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (!hasTool) return mk({ tool_calls: [{ id: 'c1', type: 'function', function: { name: 'images_to_pdf', arguments: JSON.stringify({ files: [id1, id2], page_size: 'a4' }) } }] });
  return mk({ content: '已合併完成' });
};
fa._checkTopicTransition = async () => {}; fa.messages = []; const before = await fa.ragSystem.getAll(); R.before_updated = before.filter((n) => /^##\s*【已更新】/.test(n.content)).length;
console.log('[step] executeChat start'); try { await Promise.race([fa.executeChat('每個圖片檔案前面有編號prefix，先把圖片變成等比例縮放，置中，縮放到A4大小，然後再合併成一個pdf'), new Promise((_, rej) => setTimeout(() => rej(new Error('executeChat 逾時 60s')), 60000))]); } catch (e) { R.exec_err = String(e && e.message || e); }
console.log('[eval] after chat'); window.fetch = realFetch;
R.requests = seen.map((x) => JSON.stringify(x));
const after = await fa.ragSystem.getAll(); const healed = after.filter((n) => /^##\s*【已更新】/.test(n.content));
R.healed = healed.map((n) => ({ id: n.id, head: n.content.slice(0, 90).replace(/\n/g, ' '), tags: (n.tags || []).filter((t) => /superseded|tool:/.test(t)), has_backup: !!n.supersededFrom }));
R.pptx_untouched = (after.find((n) => n.id === 'pref_pptx_image_compression_fix') || {}).content ? !/^##\s*【已更新】/.test(after.find((n) => n.id === 'pref_pptx_image_compression_fix').content) : null;
R.untouched_weekly = (after.find((n) => /週報|weekly/i.test(n.id)) || {}).content ? !/^##\s*【已更新】/.test(after.find((n) => /週報|weekly/i.test(n.id)).content) : null;
R.tool_ran = [...(fa._turnToolSuccess || [])];
return R;
