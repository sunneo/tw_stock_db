const fa = window.fa; const R = {}; fa.advancedSettings.offlineMode = false; fa.messages = [];
const call = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args)));
const realFetch = window.fetch; const seen = [];
const cv = document.createElement('canvas'); cv.width = cv.height = 96; const cx = cv.getContext('2d'); for (let i = 0; i < 96; i += 8) { cx.fillStyle = 'hsl(' + (i * 3) + ',70%,50%)'; cx.fillRect(i, 0, 8, 96); } const PNG = cv.toDataURL('image/png').split(',')[1];
window.fetch = async (url, opts) => {
  if (!/ai\.api\.nvidia\.com/.test(String(url))) return realFetch(url, opts);
  seen.push({ url: String(url), auth: opts.headers.Authorization, body: JSON.parse(opts.body) });
  const mode = window.__imgMode || 'ok';
  if (mode === 'ok') return new Response(JSON.stringify({ artifacts: [{ base64: PNG, finishReason: 'SUCCESS', seed: 42 }] }), { status: 200 });
  if (mode === '401') return new Response('{"detail":"bad key"}', { status: 401 });
  if (mode === 'filtered') return new Response(JSON.stringify({ artifacts: [{ base64: '', finishReason: 'CONTENT_FILTERED' }] }), { status: 200 });
  if (mode === 'net') throw new TypeError('Failed to fetch');
};
R.registered = { tool: !!fa.tools.generate_image, slash: !!(fa.slashCommands && (fa.slashCommands['/image'] || (fa.slashCommands.get && fa.slashCommands.get('/image')))) };
// 1) 沒有金鑰
fa.advancedSettings.imageGen = { apiKey: '', model: 'black-forest-labs/flux.1-schnell', customModel: '' };
const llm = fa._getApiConfig(); R.llm_is_nvidia = /nvidia\.com/i.test(String(llm.apiUrl || ''));
const noKey = await call('generate_image', { prompt: 'a frog' }); R.no_key = R.llm_is_nvidia ? 'uses llm key (' + (noKey.ok) + ')' : (noKey.error || '').slice(0, 40);
// 2) 有金鑰：成功
fa.advancedSettings.imageGen = { apiKey: 'nvapi-TEST', model: 'black-forest-labs/flux.1-schnell', customModel: '' };
const n0 = fa.messages.length; const ok = await call('generate_image', { prompt: 'a macro photo of a frog', width: 1000, steps: 50 });
R.ok = { ok: ok.ok, model: ok.model, size: ok.size, steps: ok.steps, adjusted: ok.adjusted, url: ok.client_file_url && ok.client_file_url.slice(0, 12), mime: ok.images && ok.images[0].mime };
R.request = seen[seen.length - 1] && { url: seen[seen.length - 1].url, auth: seen[seen.length - 1].auth, body: seen[seen.length - 1].body };
const shown = fa.messages.slice(n0).find((m) => m._displayDataUrl); R.shown_in_chat = !!shown && /^data:image\/png;base64,/.test(shown._displayDataUrl) && !/base64/.test(shown.content);
const rec = ok.file_id && await fa.fileCache.get(ok.file_id); R.stored = !!rec && rec.blob.size > 50 && rec.blob.type === 'image/png';
// 3) 自己填的模型路徑與壞路徑
fa.advancedSettings.imageGen.customModel = 'black-forest-labs/flux.2-klein-4b'; const c1 = await call('generate_image', { prompt: 'x' }); R.custom_url = seen[seen.length - 1].url.split('/genai/')[1];
const badPath = await call('generate_image', { prompt: 'x', model: '../../evil' }); R.bad_path = (badPath.error || '').slice(0, 30);
// 4) 錯誤白話
window.__imgMode = '401'; R.e401 = (await call('generate_image', { prompt: 'x' })).error.slice(0, 30);
window.__imgMode = 'filtered'; const f = await call('generate_image', { prompt: 'x' }); R.filtered = { ok: f.ok, filtered: f.filtered };
window.__imgMode = 'net'; R.net = (await call('generate_image', { prompt: 'x' })).error.slice(0, 40);
window.__imgMode = 'ok';
// 5) 斜線指令
const cmdObj = fa.slashCommands && (fa.slashCommands['/image'] || (fa.slashCommands.get && fa.slashCommands.get('/image'))); const run = cmdObj && (cmdObj.handler || cmdObj.run || cmdObj);
const m0 = fa.messages.length; await run('', fa); R.slash_list = /flux\.1-schnell/.test(String((fa.messages[fa.messages.length - 1] || {}).content || ''));
await run('model=black-forest-labs/flux.1-dev steps=30 size=1344x768 a quiet harbor', fa);
const last = seen[seen.length - 1]; R.slash_req = { url: last.url.split('/genai/')[1], steps: last.body.steps, w: last.body.width, h: last.body.height, prompt: last.body.prompt };
R.slash_done = /畫好了/.test(fa.messages.slice(m0).map((m) => m.content).join('\n'));
// 6) 依任務補工具
R.hints = ['幫我畫一張貓的圖片', '產生一張海報', '畫一個流程圖', '把圖片轉成pdf'].map((t) => _faTaskToolHints(t).map((h) => h.id).join());
window.fetch = realFetch; return R;
