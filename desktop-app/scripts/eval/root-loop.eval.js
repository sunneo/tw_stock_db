// 根對話：圖片轉 PDF 的真實流程（假 LLM、真實 Electron）。記下模型每一輪實際看到的工具清單與工具結果，檢查會不會一直重複呼叫。
const SCENARIO = (window.__FA_EVAL_SCENARIO || 'repeat'); const fa = window.fa; const R = {};
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; } // 離線橋接層啟動時存了一份原始 fetch；設成 null 它就改用目前的 window.fetch（這裡的假 LLM）
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' }); fa._shouldUseNativeToolCalls = () => true; fa._ensureNativeToolSupportProbed = async () => true;
const mkPng = async (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').fillRect(0, 0, w, h); return await new Promise((r) => c.toBlob(r)); };
const ids = []; for (let i = 1; i <= 3; i++) ids.push(await fa.fileCache.put(`S_${i}.jpg`, 'image/png', await mkPng(1320, 940), 'uploaded'));
const realFetch = window.fetch.bind(window); const seen = [];
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body); const msgs = body.messages; const toolMsgs = msgs.filter((m) => m.role === 'tool');
  const raw = (fa.messages || []).slice(-5).map((m) => m.role + (m.tool_calls ? '[calls:' + m.tool_calls.map((c) => c.id).join(',') + ']' : '') + (m.tool_call_id ? '[id:' + m.tool_call_id + ']' : '') + (m._humanOnly ? '[humanOnly]' : '') + ':' + String(m.content).slice(0, 40).replace(/\n/g, ' '));
  seen.push({ raw, n: seen.length + 1, nTools: (body.tools || []).length, tools: (body.tools || []).map((t) => t.function.name).slice(0, 12), toolMsgChars: toolMsgs.map((m) => String(m.content).length), lastTool: toolMsgs.length ? String(toolMsgs[toolMsgs.length - 1].content).slice(0, 700) : null, toolChoice: body.tool_choice || null, tail: msgs.slice(-3).map((m) => m.role + ':' + (m.tool_calls ? 'CALLS ' + JSON.stringify(m.tool_calls).slice(0, 80) : String(m.content).slice(0, 200).replace(/\n/g, ' '))) });
  const mk = (msg) => new Response(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant', content: '' }, msg), finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (seen.length > 8) return mk({ content: '[eval stop]' });
  const k = toolMsgs.length; const call = (args) => mk({ tool_calls: [{ id: 'c' + (k + 1), type: 'function', function: { name: 'images_to_pdf', arguments: JSON.stringify(args) } }] });
  if (SCENARIO === 'once') return k === 0 ? call({ files: ids, orientation: 'landscape', fit: 'contain', page_size: 'A4' }) : mk({ content: '已合併完成' });
  // 'repeat'：模擬真實對話——同樣的設定換個寫法連續呼叫（多寫 margin／filename、少寫），最後才改成直式
  if (k === 0) return call({ margin: 0, filename: 'merged_images.pdf', files: ids, fit: 'contain', orientation: 'landscape', page_size: 'A4' });
  if (k === 1) return call({ files: ids, orientation: 'landscape', fit: 'contain', page_size: 'A4' });
  if (k === 2) return call({ filename: 'x.pdf', orientation: 'landscape', files: ids, fit: 'contain', page_size: 'a4' });
  if (k === 3) return call({ files: ids, orientation: 'portrait', fit: 'contain', page_size: 'A4' });
  return mk({ content: '已合併完成' });
};
fa._checkTopicTransition = async () => {}; fa.messages = [];
try { await Promise.race([fa.executeChat('把圖片縮放到a4大小，用橫的，合併成pdf\n[附件：S_1.jpg（file_id=' + ids[0] + '）、S_2.jpg（file_id=' + ids[1] + '）、S_3.jpg（file_id=' + ids[2] + '）]'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 60000))]); } catch (e) { R.err = String(e.message || e); }
window.fetch = realFetch; R.cards = (fa.messages || []).filter((m) => m._downloadFile).map((m) => m._downloadFile.filename); R.progress = (fa.messages || []).filter((m) => m._progressWidget).map((m) => m._progressWidget.title); R.pdfCalls = seen.filter((x) => x.toolMsgChars.length).length; R.blocked = (seen.map((x) => x.lastTool || '').filter((t) => /duplicate_call_blocked/.test(t))).length; R.rounds = seen.length; R.seen = seen; R.mode = fa.advancedSettings.multiSubAgentMode || fa.multiSubAgentMode; R.final = (fa.messages[fa.messages.length - 1] || {}).content; return R;
