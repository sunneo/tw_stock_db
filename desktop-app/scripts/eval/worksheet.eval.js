// 教育文書（學習單）網域（真實 Electron）：worksheet_make（程式讀請求→排版→PDF／PNG／HTML 三個下載卡片）、參考圖片（視覺模型回 JSON，程式檢查）、
// worksheet_adjust（封閉的編輯動作）、CoLU 食譜（離線橋接：程式讀請求，不靠模型）、依任務補工具。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/worksheet.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {};
const b64 = async (blob) => { const buf = new Uint8Array(await blob.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return btoa(bin); };
const pngId = await (async () => { const c = document.createElement('canvas'); c.width = 40; c.height = 40; c.getContext('2d').fillRect(0, 0, 40, 40); return await fa.fileCache.put('ref.png', 'image/png', await new Promise((r) => c.toBlob(r)), 'uploaded'); })();
const REQ = '幫我設計一樣的，做成一個pdf，要有圈圈圖式跟顏色，右邊填上相對的樹字\n顏色跟他一樣\n一串10又1, 10又2的概念';

// 1) 沒有參考圖片：程式讀請求
fa.messages = [];
const t0 = Date.now(); const r1 = await fa._worksheetMake({ request: REQ }); R.make = { ok: r1.ok, ms: Date.now() - t0, files: Object.keys(r1.files || {}), summary: r1.summary, notes: r1.notes, questions: (r1.questions || []).map((q) => q.q + '→' + q.default), problems: r1.problems };
R.cards = (fa.messages || []).filter((m) => m._downloadFile).map((m) => m._downloadFile.filename + ' ' + m._downloadFile.mimeType + ' ' + m._downloadFile.sizeBytes);
const pdfRec = await fa.fileCache.get(r1.files.pdf.file_id); const head = new Uint8Array(await pdfRec.blob.slice(0, 8).arrayBuffer()); R.pdf_header = String.fromCharCode.apply(null, head).slice(0, 5); R.pdf_bytes = pdfRec.blob.size;
R.pdf_b64 = await b64(pdfRec.blob); R.png_b64 = await b64((await fa.fileCache.get(r1.files.png.file_id)).blob); R.html_ok = (await (await fa.fileCache.get(r1.files.html.file_id)).blob.text()).includes('<svg');

// 2) 參考圖片：視覺模型回一小段 JSON（這裡用假的回覆，照照片的 9 串顏色）
const realVlm = fa._interpretImageWithVisionModel; let vlmPrompt = '';
fa._interpretImageWithVisionModel = async (dataUrl, q) => { vlmPrompt = String(q); return { description: '```json\n' + JSON.stringify({ title: '彩色串珠｜10又幾（一）', base_color: '#E9B22E', base: 10, rows: [{ count: 1, color: '#C8174F' }, { count: 2, color: '#8CC63F' }, { count: 3, color: '#F2D4CF' }, { count: 4, color: '#F5E51E' }, { count: 5, color: '#3F87D4' }, { count: 6, color: '#5E2C79' }, { count: 7, color: '#FFFFFF' }, { count: 8, color: '#E0457B' }, { count: 9, color: '#274B8F' }] }) + '\n```' }; };
const r2 = await fa._worksheetMake({ request: REQ, reference_file_id: pngId }); R.ref = { ok: r2.ok, summary: r2.summary, notes: r2.notes, asked: (r2.questions || []).length, promptIsJsonOnly: /只回一段 JSON/.test(vlmPrompt) };
// 3) 視覺模型壞掉：不丟例外、用預設、說明
fa._interpretImageWithVisionModel = async () => { throw new Error('vision down'); }; const r3 = await fa._worksheetMake({ request: REQ, reference_file_id: pngId }); R.ref_down = { ok: r3.ok, noteHasReason: (r3.notes || []).some((n) => /讀不到參考圖片/.test(n)), rows: /8 筆/.test(r3.summary.join('')) };
fa._interpretImageWithVisionModel = async () => ({ description: '我看到一些彩色的珠子' }); const r3b = await fa._worksheetMake({ request: REQ, reference_file_id: pngId }); R.ref_garbage = { ok: r3b.ok, note: (r3b.notes || []).some((n) => /讀不成資料/.test(n)) };
fa._interpretImageWithVisionModel = realVlm;

// 4) 調整：封閉的編輯動作
const r4 = await fa._worksheetAdjust({ edits: [{ op: 'set_title', text: '彩色串珠（二）' }, { op: 'set_color', count: 3, color: '粉紅色' }, { op: 'set_answer', show: true }, { op: 'fly' }] }); R.adjust = { ok: r4.ok, applied: r4.applied, rejected: (r4.rejected || []).map((x) => x.op), files: Object.keys(r4.files || {}) };
R.adjust_bad = await fa._worksheetAdjust({ edits: [{ op: 'fly' }] }); R.adjust_empty = (await fa._worksheetAdjust({})).ok === false; R.adjust_nofile = (await fa._worksheetAdjust({ worksheet_id: 'ws_nope', edits: [{ op: 'set_title', text: 'x' }] })).ok === false; // 指定的找不到就明說，不偷偷改別份
R.adjust_teacher_pdf_b64 = await b64((await fa.fileCache.get(r4.files.pdf.file_id)).blob);

// 5) 弄壞的輸入不丟例外
R.garbage = [await fa._worksheetMake({}), await fa._worksheetMake({ request: '今天天氣很好' }), await fa._worksheetMake({ spec: 'not json', request: '串珠10又幾' }), await fa._worksheetMake({ spec: { blocks: [{ type: 'nonsense' }] } })].map((x) => ({ ok: x.ok, error: x.error && x.error.slice(0, 40) }));

// 6) CoLU 食譜：離線橋接，程式讀請求；最後交給呼叫端的是 worksheet_make
const log = []; const rc = await fa._skillRecipeRun(REQ + '\n[附件：範例.png（file_id=' + pngId + '）]', ['worksheet_make'], (x) => log.push(x));
R.recipe = rc && { recipe: rc.recipe, tool: rc.planned && rc.planned.tool, args: rc.planned && Object.keys(rc.planned.args), refId: rc.planned && rc.planned.args.reference_file_id === pngId, log: log.slice(0, 3), error: rc.error };
const rc2 = await fa._skillRecipeRun('今天天氣很好，聊聊天', ['worksheet_make'], () => {}); R.recipe_unrelated = !rc2 || rc2.recipe !== 'worksheet_from_request';
// 7) 依任務補工具／領域
R.hints = [REQ, '幫我做一份10又幾的學習單', '怎麼做學習單比較好', '把這張圖轉成pdf'].map((t) => _faTaskToolHints(t).map((h) => h.id).join());
R.domain = !!(fa.domains && fa.domains.worksheet && fa.domains.worksheet.enabled); R.domain_tools = fa.domains && fa.domains.worksheet && fa.domains.worksheet.toolNames;
return R;
