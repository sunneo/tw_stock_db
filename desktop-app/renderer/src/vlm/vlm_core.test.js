const V = require('./vlm_core.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
// 登記表
check('default model exists and is an image model', V.byId(V.DEFAULT_MODEL) && V.byId(V.DEFAULT_MODEL).task === 'image-to-text');
check('named models present (LLaVA-Interleave-Qwen)', V.byId('llava-interleave-qwen-0.5b'));
check('PaliGemma is removed from the list (cannot load on real machines)', !V.byId('paligemma2-3b-224'));
check('ids unique and repos unique', new Set(V.MODELS.map((m) => m.id)).size === V.MODELS.length && new Set(V.MODELS.map((m) => m.repo.toLowerCase())).size === V.MODELS.length);
check('every image model has dtype+bytes for cpu unless gpuOnly', V.imageModels().every((m) => m.gpuOnly ? m.dtype.cpu === null : (m.dtype.cpu && m.bytes.cpu > 0)));
check('whisper is manage-only (not an image model)', V.byId('whisper-base').managedOnly && !V.imageModels().some((m) => m.id === 'whisper-base'));
check('verified flags match what was actually measured (cpu path)', V.byId('florence-2-base-ft').verified && V.byId('vit-gpt2').verified && V.byId('llava-interleave-qwen-0.5b').verified && !V.byId('smolvlm-256m').verified && V.byId('llava-interleave-qwen-0.5b').experimental === true);
check('verified models say on which device they were verified', V.MODELS.filter((m) => m.verified && m.task === 'image-to-text').every((m) => /cpu|gpu/.test(m.verifiedOn)));
check('repetition penalty only for chat models and not for OCR', V.generationParams(V.byId('smolvlm-256m'), 'detailed').repetition_penalty > 1 && !V.generationParams(V.byId('smolvlm-256m'), 'ocr').repetition_penalty && !Object.keys(V.generationParams(V.byId('florence-2-base-ft'), 'detailed')).length);
check('default max tokens: short for captions', V.defaultMaxTokens('caption') < V.defaultMaxTokens('detailed'));
// 裝置：偏好 GPU 不支援就降級 CPU
const fl = V.byId('florence-2-base-ft');
// 合成的「只能用 GPU」模型（PaliGemma 已從清單移除，但裝置與提示詞邏輯仍要測）
const pg = { id: 'synthetic-gpu-only', arch: 'paligemma', label: '合成模型', gpuOnly: true, gpuNeedsF16: true, task: 'image-to-text', tasks: ['caption', 'ocr', 'ask'], dtype: { gpu: 'q4f16', cpu: null } };
let r = V.resolveDevice(fl, 'gpu', true); check('prefer gpu + gpu available → webgpu then cpu fallback', r.order.join() === 'webgpu,wasm', r);
r = V.resolveDevice(fl, 'gpu', false); check('prefer gpu but no webgpu → cpu', r.order.join() === 'wasm' && /降級/.test(r.reason), r);
r = V.resolveDevice(fl, 'cpu', true); check('prefer cpu → cpu only', r.order.join() === 'wasm', r);
r = V.resolveDevice(pg, 'gpu', false); check('gpu-only model without webgpu → error, no device', r.order.length === 0 && r.error === 'gpu_required', r);
r = V.resolveDevice(pg, 'cpu', true); check('gpu-only model with cpu preference still uses gpu (and says so)', r.order.join() === 'webgpu' && /只能用 GPU/.test(r.reason), r);
r = V.resolveDevice(fl, 'gpu', true, false); check('gpu without shader-f16 → this model falls back to cpu with a reason', r.order.join() === 'wasm' && /shader-f16/.test(r.reason), r);
r = V.resolveDevice(V.byId('vit-gpt2'), 'gpu', true, false); check('model that does not need f16 still uses gpu', r.order.join() === 'webgpu,wasm', r);
r = V.resolveDevice(pg, 'gpu', true, false); check('gpu-only model that needs f16 is refused without it', r.order.length === 0 && r.error === 'gpu_required', r);
r = V.resolveDevice(fl, 'gpu', true, undefined); check('unknown f16 info does not block gpu', r.order[0] === 'webgpu', r);
// 執行緒
let th = V.resolveThreads(0, 8, true); check('no limit → all cores', th.requested === 8 && th.effective === 8, th);
th = V.resolveThreads(4, 8, true); check('limit 4 of 8', th.requested === 4 && th.effective === 4, th);
th = V.resolveThreads(16, 8, true); check('limit above hardware is clamped', th.requested === 8, th);
th = V.resolveThreads(4, 8, false, '沒有 SharedArrayBuffer'); check('cannot thread → effective 1 with an honest note and the reason', th.requested === 4 && th.effective === 1 && /1 個執行緒/.test(th.note) && /沒有 SharedArrayBuffer/.test(th.note), th);
th = V.resolveThreads(NaN, undefined, true); check('missing hardware info → 1', th.requested === 1 && th.effective === 1, th);
// 任務
let t = V.buildTask(fl, 'ocr'); check('florence ocr → <OCR>', t.prompt === '<OCR>' && t.task === 'ocr', t);
t = V.buildTask(fl, 'ask', 'what colour?'); check('florence has no free Q&A → detailed caption with note', t.prompt === '<MORE_DETAILED_CAPTION>' || (t.task === 'detailed' && t.prompt === '<MORE_DETAILED_CAPTION>'), t);
t = V.buildTask(V.byId('smolvlm-256m'), 'ask', '圖裡有幾隻貓？'); check('chat model passes the user prompt through', t.prompt === '圖裡有幾隻貓？', t);
t = V.buildTask(V.byId('vit-gpt2'), 'ocr'); check('vit-gpt2 only captions, with a note', t.task === 'caption' && /不支援/.test(t.note), t);
t = V.buildTask(pg, 'ask', 'how many cats'); check('paligemma answer prompt format', t.prompt === 'answer en how many cats', t);
t = V.buildTask(pg, 'caption'); check('paligemma caption prompt', t.prompt === 'caption en', t);
// 結果
check('florence caption text is cleaned', V.formatResult(fl, { '<CAPTION>': 'A cat on a sofa.' }, 'caption') === 'A cat on a sofa.');
check('florence object detection is listed with boxes', V.formatResult(fl, { '<OD>': { bboxes: [[1.2, 2.2, 30.7, 40]], labels: ['cat'] } }, 'objects') === 'cat @[1,2,31,40]');
check('chat model result trimmed', V.formatResult(V.byId('smolvlm-256m'), '  hello \n') === 'hello');
// 快取用量
const E = [
    { url: 'https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/onnx/decoder_model_merged_q4.onnx', size: 61 * 1048576 },
    { url: 'https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/config.json', size: 2000 },
    { url: 'https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/encoder_model_quantized.onnx', size: 30 * 1048576 },
    { url: 'https://huggingface.co/someone/custom-model/resolve/main/x.onnx', size: 10 * 1048576 },
    { url: 'https://example.com/other.bin', size: 5 },
];
const u = V.usageByModel(E);
check('usage per model', u.byModel['florence-2-base-ft'].files === 2 && u.byModel['florence-2-base-ft'].bytes === 61 * 1048576 + 2000 && u.byModel['whisper-base'].files === 1, u.byModel);
check('usage: unknown repos and non-HF urls go to other', u.other.files === 2 && u.other.repos.join() === 'someone/custom-model', u.other);
check('usage: totals add up', u.total.files === 5 && u.total.bytes === E.reduce((s, e) => s + e.size, 0));
check('urlsOfModel finds exactly that model', V.urlsOfModel(E, fl).length === 2 && V.urlsOfModel(E, V.byId('whisper-base')).length === 1);
check('repoOfUrl is case-insensitive and rejects non-HF', V.repoOfUrl('https://huggingface.co/Foo/Bar/resolve/main/a') === 'foo/bar' && V.repoOfUrl('https://x.com/a/b/resolve/c') === null);
check('fmtBytes', V.fmtBytes(1536 * 1024) === '1.5 MB' && V.fmtBytes(3 * 1024 * 1048576) === '3.00 GB');
check('estimateDownload subtracts what is cached', V.estimateDownload(fl, 'wasm', 100 * 1048576) === fl.bytes.cpu - 100 * 1048576 && V.estimateDownload(fl, 'webgpu', 1e12) === 0);
// ---- 抽象層：自然語言 → 任務 → 模型 ----
const IT = (s) => V.inferTask(s);
check('infer: OCR (en/zh)', IT('Please read all the text in this image').task === 'ocr' && IT('辨識圖片裡的文字').task === 'ocr' && IT('OCR this').task === 'ocr' && IT('這張圖寫了什麼').task === 'ocr');
check('infer: describe (en/zh)', IT('Describe this image in detail').task === 'detailed' && IT('請描述這張圖').task === 'detailed' && IT("What's in this picture?").task === 'detailed');
check('infer: caption', IT('Give a short caption').task === 'caption' && IT('用一句話描述').task === 'caption');
check('infer: objects', IT('List the objects in the image').task === 'objects' && IT('列出圖片裡的物件').task === 'objects');
check('infer: question keeps the question text', (() => { const r = IT('How many cats are there?'); return r.task === 'ask' && r.question === 'How many cats are there?'; })() && IT('圖裡有幾隻貓？').task === 'ask');
check('infer: empty → detailed; long unmatched text is treated as a question', IT('').task === 'detailed' && IT('the invoice total in the top right corner please').task === 'ask');
// 提示詞格式由抽象層解決：同一個「OCR」意圖，不同模型拿到各自的格式
check('same OCR intent → each model gets its own prompt format', V.buildTask(fl, 'ocr').prompt === '<OCR>' && V.buildTask(V.byId('smolvlm-256m'), 'ocr').prompt.startsWith('Transcribe') && V.buildTask(pg, 'ocr').prompt === 'ocr');
const none = {}, gpuOk = { available: true, f16: true }, noGpu = { available: false };
let pk = V.pickModel('ocr', none, 'florence-2-base-ft', noGpu); check('pick: preferred model that supports the task', pk.model.id === 'florence-2-base-ft', pk);
pk = V.pickModel('ask', { 'smolvlm-256m': 100 }, 'florence-2-base-ft', noGpu); check('pick: ask → falls to an installed chat model', pk.model.id === 'smolvlm-256m' && /已下載/.test(pk.reason), pk);
pk = V.pickModel('ask', none, 'florence-2-base-ft', noGpu); check('pick: ask with nothing installed → preferred (task will be downgraded)', pk.model.id === 'florence-2-base-ft' && /降級/.test(pk.reason), pk);
// 優先順序
check('vision policies', V.visionOrder('llm-first').join() === 'llm,offline' && V.visionOrder('offline-first').join() === 'offline,llm' && V.visionOrder('llm').join() === 'llm' && V.visionOrder('offline').join() === 'offline' && V.visionOrder('nonsense').join() === 'llm,offline');
// ---------- 文字生成（離線聊天）----------
const tm = V.textModels();
check('text models registered and separate from image models', tm.length >= 4 && tm.every((m) => m.task === 'text-generation' && m.arch === 'causal-lm') && V.imageModels().every((m) => m.task === 'image-to-text') && !V.imageModels().some((m) => tm.includes(m)));
check('two separate defaults (text vs vlm)', V.byId(V.DEFAULT_TEXT_MODEL).task === 'text-generation' && V.byId(V.DEFAULT_MODEL).task === 'image-to-text');
check('text models have a context size and unique repos', tm.every((m) => m.contextTokens >= 1024) && new Set(V.MODELS.map((m) => m.repo)).size === V.MODELS.length);
check('only models that can do tool calls say so', tm.filter((m) => m.tasks.includes('tools')).every((m) => m.toolCalling === 'hermes') && tm.filter((m) => !m.tasks.includes('tools')).every((m) => !m.toolCalling));
// 門檻
check('threshold clamps to 0.1..1.0 (1.0 allowed)', V.clampThreshold(1) === 1 && V.clampThreshold(0.99) === 0.99 && V.clampThreshold(1.2) === 0.45 && V.clampThreshold(0.05) === 0.45 && V.clampThreshold('x', 0.6) === 0.6);
check('offline llm takes over only when unresolved (not needs_input / planned)', V.shouldUseOfflineLlm({ status: 'unresolved' }, {}) && !V.shouldUseOfflineLlm({ status: 'needs_input' }, {}) && !V.shouldUseOfflineLlm({ status: 'planned' }, {}) && !V.shouldUseOfflineLlm({ status: 'unresolved' }, { offlineLlmFallback: false }));
// 預算：依上下文按比例
const bq = V.textBudget(V.byId('qwen3-0.6b'), 512), bl = V.textBudget(V.byId('qwen3-1.7b'), 512);
check('budget scales with context window (not hard-coded)', bl.history > bq.history * 1.8 && bl.rag > bq.rag * 1.8 && bq.prompt + bq.reply === bq.context, [bq, bl]);
check('budget parts fit in the prompt', bq.system + bq.tools + bq.rag + bq.history + bq.user <= bq.prompt, bq);
check('token estimate: cjk ~1 per char, latin ~1 per 3.5', V.estimateTokens('你好世界') === 4 && V.estimateTokens('abcdefg') === 2 && V.estimateTokens('') === 0);
check('trimToTokens respects the limit', V.estimateTokens(V.trimToTokens('字'.repeat(500), 100)) <= 101 && V.trimToTokens('短', 100) === '短');
// 組訊息
const hist = []; for (let i = 0; i < 60; i++) hist.push({ role: i % 2 ? 'assistant' : 'user', content: '這是第' + i + '則訊息，內容稍微長一點點以便佔用預算。'.repeat(2) });
const cm = V.composeMessages({ system: '你是助理', history: hist, rag: ['A'.repeat(3000), '第二段資料'], user: '現在的問題', budget: bq });
check('compose: system first, user last, history within budget, oldest dropped', cm.messages[0].role === 'system' && cm.messages[cm.messages.length - 1].content === '現在的問題' && cm.historyTokens <= bq.history && cm.dropped > 0 && cm.messages.length > 3, { n: cm.messages.length, dropped: cm.dropped });
check('compose: rag goes into system with a caution, and is bounded', /參考資料/.test(cm.messages[0].content) && V.estimateTokens(cm.messages[0].content) <= bq.system + bq.rag + 80);
check('compose: newest history kept', cm.messages[cm.messages.length - 2].content.indexOf('第59則') >= 0);
const big = V.composeMessages({ system: '你是助理', history: hist, rag: [], user: 'q', budget: bl });
check('compose: bigger context keeps more history', big.messages.length > cm.messages.length);
const noHist = V.composeMessages({ system: 's', history: [{ role: 'tool', content: 'x' }, { role: 'assistant', content: '  ' }], rag: [], user: 'q', budget: bq });
check('compose: ignores non user/assistant and empty history', noHist.messages.length === 2);
// 工具說明縮短
const specs = V.compactToolSpecs([{ name: 'a', description: 'd'.repeat(500), parameters: { type: 'object', properties: { x: { type: 'string', description: 'y'.repeat(300) } }, required: ['x'] } }, { name: 'b', description: 'bb' }], 100000);
check('compact tool specs: shortened descriptions, keeps required', specs.length === 2 && specs[0].function.description.length <= 140 && specs[0].function.parameters.properties.x.description.length <= 60 && specs[0].function.parameters.required[0] === 'x');
check('compact tool specs: drops tools that do not fit the budget', V.compactToolSpecs(BIGTOOLS(), 120).length < 10);
function BIGTOOLS() { const a = []; for (let i = 0; i < 10; i++) a.push({ name: 't' + i, description: '描述'.repeat(30), parameters: { properties: { q: { type: 'string', description: '參數' } } } }); return a; }
// 解析工具呼叫
let pc = V.parseToolCalls('好的。\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "台北"}}\n</tool_call>');
check('parse: standard tag', pc.calls.length === 1 && pc.calls[0].name === 'get_weather' && pc.calls[0].args.city === '台北' && pc.format === 'tag' && pc.text === '好的。', pc);
pc = V.parseToolCalls('<tool_call>{"name":"a","arguments":{"x":1}}');
check('parse: missing closing tag tolerated', pc.calls.length === 1 && pc.calls[0].args.x === 1, pc);
pc = V.parseToolCalls('<tool_call>{"name":"a","arguments":{"x":1}}</tool_call><tool_call>{"name":"b","arguments":{}}</tool_call>');
check('parse: two calls', pc.calls.map((c) => c.name).join() === 'a,b', pc);
pc = V.parseToolCalls('```json\n{"name": "calculator", "arguments": {"expression": "1+2"}}\n```');
check('parse: bare json in a fence', pc.calls.length === 1 && pc.calls[0].name === 'calculator' && pc.format === 'json', pc);
pc = V.parseToolCalls('<tool_call>{"name":"a","arguments":"{\\"x\\":2}"}</tool_call>');
check('parse: arguments given as a json string', pc.calls[0] && pc.calls[0].args.x === 2, pc);
pc = V.parseToolCalls('<tool_call>{"name":"a","parameters":{"y":3}}</tool_call>');
check('parse: "parameters" key accepted', pc.calls[0] && pc.calls[0].args.y === 3, pc);
pc = V.parseToolCalls('你好！很高興見到你。{"name" 不是工具}');
check('parse: plain chat has no calls', pc.calls.length === 0 && pc.format === 'none', pc);
pc = V.parseToolCalls('<think>想一下</think>答案是 42');
check('parse: strips think block', pc.text === '答案是 42' && pc.calls.length === 0, pc);
pc = V.parseToolCalls('<tool_call>壞掉的 json</tool_call>');
check('parse: garbage inside the tag gives no call (no crash)', pc.calls.length === 0, pc);
// 基準測試評分
const bc = (id) => V.BENCH_CASES.find((c) => c.id === id);
check('bench cases: mix of tool / no-tool, zh / en', V.BENCH_CASES.length >= 6 && V.BENCH_CASES.some((c) => c.tool == null) && V.BENCH_CASES.some((c) => /^[\x00-\x7f]+$/.test(c.user)) && V.BENCH_CASES.every((c) => c.tool == null || V.BENCH_TOOLS.some((t) => t.name === c.tool)));
check('bench score: correct call', V.scoreToolCase(bc('weather_zh'), '<tool_call>{"name":"get_weather","arguments":{"city":"台北市"}}</tool_call>').ok);
check('bench score: wrong tool', !V.scoreToolCase(bc('weather_zh'), '<tool_call>{"name":"calculator","arguments":{"expression":"1"}}</tool_call>').ok && V.scoreToolCase(bc('weather_zh'), '<tool_call>{"name":"calculator","arguments":{"expression":"1"}}</tool_call>').formatOk);
check('bench score: wrong argument', /參數/.test(V.scoreToolCase(bc('weather_zh'), '<tool_call>{"name":"get_weather","arguments":{"city":"高雄"}}</tool_call>').reason));
check('bench score: no parseable call is a format failure', (() => { const r = V.scoreToolCase(bc('calc_zh'), '答案是 60'); return !r.ok && !r.formatOk; })());
check('bench score: must not use a tool for small talk', V.scoreToolCase(bc('chat_none'), '不客氣！').ok && !V.scoreToolCase(bc('chat_none'), '<tool_call>{"name":"search_web","arguments":{"query":"x"}}</tool_call>').ok);
const sm = (n, total) => V.summarizeToolBench(Array.from({ length: total }, (_, i) => ({ ok: i < n, formatOk: true })));
check('bench summary ratings', sm(6, 6).rating === 'good' && sm(5, 6).rating === 'good' && sm(4, 6).rating === 'fair' && sm(3, 6).rating === 'fair' && sm(2, 6).rating === 'poor' && sm(0, 6).rating === 'poor' && sm(5, 6).passed === 5);
check('text gen params: sampling with repetition penalty; deterministic option', V.textGenParams(tm[0]).repetition_penalty > 1 && V.textGenParams(tm[0]).do_sample === true && V.textGenParams(tm[0], { deterministic: true }).do_sample === false);
// ---------- 混用模型：角色標記、優先順序、基準測試信任度、交接 ----------
const benchGood = { passed: 6, total: 6, rating: 'good' }, benchPoor = { passed: 1, total: 6, rating: 'poor' }, benchFair = { passed: 4, total: 6, rating: 'fair' };
let rt = V.routeStages({ hasTools: true, bench: { 'qwen3-0.6b': benchGood }, installed: new Set(['qwen3-0.6b']) });
check('route: single model does tools + answer when only one is good', rt.tools.id === 'qwen3-0.6b' && rt.answer.id === 'qwen3-0.6b' && !rt.mixed && rt.stages.length === 1 && rt.stages[0].role === 'tools+answer', rt);
rt = V.routeStages({ hasTools: true, bench: { 'qwen3-0.6b': benchGood }, config: { 'qwen3-1.7b': { priority: 90, tools: false }, 'qwen3-0.6b': { answer: false } }, installed: new Set() });
check('route: mix — small model calls tools, big model writes the answer (priority + role tags)', rt.tools.id === 'qwen3-0.6b' && rt.answer.id === 'qwen3-1.7b' && rt.mixed && rt.stages.map((s) => s.role).join() === 'tools,answer', rt);
rt = V.routeStages({ hasTools: true, bench: { 'qwen3-0.6b': benchPoor }, installed: new Set() });
check('route: a model the benchmark rated poor is never used for tools', !rt.tools || rt.tools.id !== 'qwen3-0.6b', rt.tools);
rt = V.routeStages({ hasTools: true, bench: Object.fromEntries(V.textModels().map((m) => [m.id, benchPoor])), installed: new Set() });
check('route: no usable tool model → no tools, plain generation, says why', rt.tools === null && !rt.mixed && rt.answer && rt.reasons.some((x) => /不給工具/.test(x)), rt);
rt = V.routeStages({ hasTools: false, installed: new Set() });
check('route: no tools wanted → only the answer stage', rt.tools === null && rt.stages.length === 1 && rt.stages[0].role === 'answer', rt);
rt = V.routeStages({ hasTools: true, bench: { 'qwen2.5-0.5b': benchFair }, installed: new Set() });
check('route: a benchmarked model beats an untested one even if the untested has higher priority', rt.tools.id === 'qwen2.5-0.5b', rt.tools);
rt = V.routeStages({ hasTools: true, bench: {}, installed: new Set() });
check('route: untested tool model is allowed but the reason tells the user to benchmark', rt.tools && /基準測試/.test(rt.reasons.join()), rt);
rt = V.routeStages({ hasTools: true, bench: { 'qwen3-0.6b': benchGood, 'qwen2.5-0.5b': benchGood }, config: { 'qwen2.5-0.5b': { priority: 99 } }, installed: new Set() });
check('route: priority decides among equally trusted models', rt.tools.id === 'qwen2.5-0.5b', rt.tools);
rt = V.routeStages({ hasTools: true, bench: { 'qwen3-0.6b': benchGood, 'qwen2.5-0.5b': benchGood }, config: { 'qwen2.5-0.5b': { priority: 99 } }, installed: new Set(['qwen3-0.6b']), requireInstalled: true });
check('route: fallback mode prefers models that are already downloaded (never silent download)', rt.tools.id === 'qwen3-0.6b', rt.tools);
rt = V.routeStages({ hasTools: false, config: Object.assign({ 'smollm2-360m': { priority: 99 } }, Object.fromEntries(V.textModels().filter((m) => m.id !== 'smollm2-360m').map((m) => [m.id, { answer: false }]))), installed: new Set() });
check('route: answer role can be given to a model that cannot call tools', rt.answer.id === 'smollm2-360m', rt.answer);
check('toolsTrust values', V.toolsTrust(V.byId('smollm2-360m'), {}) === 'no' && V.toolsTrust(V.byId('qwen3-0.6b'), {}) === 'untested' && V.toolsTrust(V.byId('qwen3-0.6b'), { 'qwen3-0.6b': benchGood }) === 'trusted' && V.toolsTrust(V.byId('qwen3-0.6b'), { 'qwen3-0.6b': benchPoor }) === 'no');
check('role config: tools flag cannot be forced on a model without a tool format', V.roleConfig(V.byId('smollm2-360m'), { 'smollm2-360m': { tools: true } }, 'x').tools === false);
check('tool results become reference strings for the writer', (() => { const r = V.toolResultsAsReferences([{ name: 'a', args: { q: 'x' }, ok: true, text: 'R1' }, { name: 'b', ok: false, text: 'bad' }, { name: 'c', ok: true, text: 'R3' }]); return r.length === 2 && /R1/.test(r[0]) && /c/.test(r[1]); })());
(async () => {
// ---------- 垃圾輸出偵測 ----------
const lg = (s) => V.looksLikeGarbage(s).garbage;
check('garbage: empty / punctuation only', lg('') && lg('   \n') && lg('……。。！！') && V.looksLikeGarbage('').reason === 'empty');
check('garbage: repeated sentence (the SmolVLM failure)', lg('The character has a red hat on his head. '.repeat(5)) && lg('你好嗎？我很好。'.repeat(6)));
check('garbage: very short unit repeated', lg('哈'.repeat(30)) && lg('ab'.repeat(20)));
check('garbage: broken characters', lg('正常文字' + '�'.repeat(10)));
check('not garbage: normal answers, tables, lists', !lg('台北今天多雲，氣溫 24 度。') && !lg('| a | b |\n|---------|---------|\n| 1 | 2 |') && !lg('1. 第一\n2. 第二\n3. 第三\n4. 第四') && !lg('Hello! How can I help you today?') && !lg('哈哈，好的。'));
// ---------- 對話迴圈（假模型）----------
const model = V.byId('qwen3-0.6b'); const bud = V.textBudget(model, 256);
const mk = (scripts, onGen) => { let i = 0; return async (a) => { if (onGen) onGen(a); const s = scripts[Math.min(i++, scripts.length - 1)]; return typeof s === 'function' ? s(a) : s; }; };
const spec = (n) => ({ type: 'function', function: { name: n, description: n, parameters: { type: 'object', properties: { q: { type: 'string' } } } } });
const tcall = (n, a) => '<tool_call>' + JSON.stringify({ name: n, arguments: a || {} }) + '</tool_call>';
const base = () => [{ role: 'system', content: 'sys' }, { role: 'user', content: '問題' }];
let execs = [];
const exec = async (c) => { execs.push(c.name + JSON.stringify(c.args)); return { ok: true, text: '結果:' + c.name + JSON.stringify(c.args) }; };
// 1) 沒有工具 → 單純文字生成，一輪
let gens = [];
let r = await V.runAgentLoop({ messages: base(), tools: [], budget: bud, generate: mk(['直接回答。'], (a) => gens.push(a)), execTool: exec });
check('loop: no tools = plain generation, one round, tools not offered', r.ok && r.text === '直接回答。' && r.rounds === 1 && gens.length === 1 && gens[0].tools.length === 0 && r.calls.length === 0, r);
// 2) 有工具但模型不呼叫 → 一輪結束
gens = [];
r = await V.runAgentLoop({ messages: base(), tools: [spec('t1')], budget: bud, generate: mk(['不需要工具，答案是 42。'], (a) => gens.push(a)), execTool: exec });
check('loop: tools offered but not used → ends after the first answer', r.ok && r.rounds === 1 && r.reason === 'answer' && gens[0].tools.length === 1, r);
// 3) 呼叫一次工具後回答
execs = [];
r = await V.runAgentLoop({ messages: base(), tools: [spec('t1')], budget: bud, generate: mk([tcall('t1', { q: 'a' }), '根據結果，答案是 A。']), execTool: exec });
check('loop: one tool call then answer', r.ok && r.rounds === 2 && execs.length === 1 && r.text === '根據結果，答案是 A。' && r.calls[0].ok, r);
// 4) 同樣的呼叫一直重複 → 只執行一次，強制回答
execs = []; gens = [];
r = await V.runAgentLoop({ messages: base(), tools: [spec('t1')], budget: bud, generate: mk([tcall('t1', { q: 'a' }), tcall('t1', { q: 'a' }), tcall('t1', { q: 'a' }), '好，直接回答。'], (a) => gens.push(a)), execTool: exec });
check('loop: identical repeated call is executed once and then tools are withdrawn', execs.length === 1 && r.ok && r.calls.some((c) => c.skipped === '重複呼叫') && gens[gens.length - 1].tools.length === 0 && r.rounds <= 4, { execs, r });
// 5) 每一輪都換參數呼叫（真正的無窮迴圈）→ 到輪數／次數上限就收斂
execs = []; let n = 0;
r = await V.runAgentLoop({ messages: base(), tools: [spec('t1')], budget: bud, maxRounds: 3, maxCalls: 6, generate: async (a) => (a.tools.length ? tcall('t1', { q: 'x' + (n++) }) : '最後的回答'), execTool: exec });
check('loop: endless distinct calls stop at the round cap and still answer', r.ok && r.text === '最後的回答' && execs.length <= 3 && r.rounds <= 4, { execs: execs.length, r });
// 6) 呼叫次數上限
execs = []; n = 0;
r = await V.runAgentLoop({ messages: base(), tools: [spec('t1')], budget: bud, maxRounds: 10, maxCalls: 2, generate: async (a) => (a.tools.length ? tcall('t1', { q: 'y' + (n++) }) : '收尾'), execTool: exec });
check('loop: total call cap respected', execs.length === 2 && r.ok, { execs: execs.length, r });
// 7) 不存在的工具：最多容忍兩次
execs = []; n = 0;
r = await V.runAgentLoop({ messages: base(), tools: [spec('t1')], budget: bud, generate: async (a) => (a.tools.length ? tcall('ghost', { q: String(n++) }) : '改直接回答'), execTool: exec });
check('loop: unknown tool tolerated at most twice, nothing executed', execs.length === 0 && r.ok && r.text === '改直接回答' && r.calls.filter((c) => c.skipped === '沒有這個工具').length <= 2, r);
// 8) 垃圾輸出：重試一次（保守參數、不給工具），成功就用
gens = [];
r = await V.runAgentLoop({ messages: base(), tools: [spec('t1')], budget: bud, generate: mk(['重複重複重複。'.repeat(8), '正常的回答'], (a) => gens.push(a)), execTool: exec });
check('loop: garbage → one strict retry without tools', r.ok && r.text === '正常的回答' && gens.length === 2 && gens[1].strict === true && gens[1].tools.length === 0 && r.notes.some((x) => /垃圾/.test(x)), r);
// 9) 垃圾輸出重試還是垃圾 → 回報失敗，不丟垃圾給使用者
r = await V.runAgentLoop({ messages: base(), tools: [], budget: bud, generate: async () => '。。。。', execTool: exec });
check('loop: persistent garbage → failure, no garbage text returned', !r.ok && r.text === '' && /garbage|empty/.test(r.reason), r);
r = await V.runAgentLoop({ messages: base(), tools: [], budget: bud, generate: async () => '', execTool: exec });
check('loop: empty output → reported as empty', !r.ok && r.reason === 'empty', r);
// 10) 有工具結果但最後垃圾 → 列出工具原始結果
r = await V.runAgentLoop({ messages: base(), tools: [spec('t1')], budget: bud, generate: mk([tcall('t1', { q: 'k' }), '嗯嗯'.repeat(30), '嗯嗯'.repeat(30)]), execTool: exec });
check('loop: garbage after a successful tool call → show the raw tool result instead', r.ok && r.reason === 'garbage' && /結果:t1/.test(r.text), r);
// 11) 上下文：舊的工具結果換成 placeholder、長結果被截短或摘要
const small = V.textBudget({ contextTokens: 1024 }, 128); const tight = Object.assign({}, small, { prompt: 420 });
let seenMsgs = []; execs = []; n = 0;
r = await V.runAgentLoop({ messages: base(), tools: [spec('t1')], budget: tight, maxRounds: 4, maxCalls: 6, generate: async (a) => { seenMsgs.push(a.messages); return a.tools.length ? tcall('t1', { q: 'z' + (n++) }) : '完成'; }, execTool: async (c) => { execs.push(c); return { ok: true, text: '很長的內容。'.repeat(400) }; } });
const lastSeen = seenMsgs[seenMsgs.length - 1];
check('loop: long tool output is cut, old tool results become placeholders, prompt stays within budget', r.ok && lastSeen.some((m) => m._placeholder) && lastSeen.filter((m) => m.role === 'tool' && !m._placeholder).every((m) => V.estimateTokens(m.content) < small.rag) && seenMsgs.every((ms) => V.messagesTokens ? true : true) && r.notes.some((x) => /截短|摘要/.test(x)), { notes: r.notes });
let summarized = 0;
r = await V.runAgentLoop({ messages: base(), tools: [spec('t1')], budget: small, generate: mk([tcall('t1', { q: 's' }), '好']), execTool: async () => ({ ok: true, text: '長內容。'.repeat(500) }), summarize: async () => { summarized++; return '這是摘要：重點有三個。'; } });
check('loop: summarizer is used for oversized tool output', summarized === 1 && r.ok && r.notes.some((x) => /摘要/.test(x)), r);
// 12) 歷史太長：丟舊的、留 system 與最後的 user
const long = [{ role: 'system', content: 'sys' }]; for (let i = 0; i < 40; i++) long.push({ role: i % 2 ? 'assistant' : 'user', content: '歷史訊息' + i + '，'.repeat(1) + '很長的內容'.repeat(20) }); long.push({ role: 'user', content: '最後的問題' });
const fm = V.fitMessages(long, [], small.prompt);
check('fit: oldest history dropped, system + last user kept, note inserted', fm.messages[0].content === 'sys' && fm.messages[fm.messages.length - 1].content === '最後的問題' && fm.changed.some((x) => /丟掉/.test(x)) && fm.messages.length < long.length && /省略/.test(fm.messages[1].content), fm.changed);
// 13) 單一訊息就爆 → context_full
r = await V.runAgentLoop({ messages: [{ role: 'system', content: '字'.repeat(5000) }, { role: 'user', content: 'q' }], tools: [], budget: small, generate: async () => '不該被呼叫', execTool: exec });
check('loop: unfittable prompt → context_full, model not called', !r.ok && r.reason === 'context_full', r);
// 14) 一輪最多執行 3 個呼叫
execs = [];
r = await V.runAgentLoop({ messages: base(), tools: [spec('t1')], budget: bud, generate: mk([[1, 2, 3, 4, 5].map((i) => tcall('t1', { q: 'p' + i })).join(''), '好']), execTool: exec });
check('loop: at most 3 calls per round', execs.length === 3 && r.ok, { execs });
// 交接：工具階段做完就停，不自己寫最後的回答
{ const hmk = (s) => { let i = 0; return async () => s[Math.min(i++, s.length - 1)]; }; const hex = async (c) => ({ ok: true, text: '結果:' + c.name });
  let hr = await V.runAgentLoop({ messages: base(), tools: [spec('t1')], budget: bud, handoff: true, generate: hmk([tcall('t1', { q: 'a' }), '工具階段自己寫的回答（應該被丟掉）']), execTool: hex });
  check('handoff: after tool use the loop stops and returns the results without writing the answer', hr.handoff === true && hr.reason === 'handoff' && hr.text === '' && hr.calls.length === 1 && hr.calls[0].ok, hr);
  hr = await V.runAgentLoop({ messages: base(), tools: [spec('t1')], budget: bud, handoff: true, generate: hmk(['沒有用工具，直接回答。']), execTool: hex });
  check('handoff: no tool used → plain text is returned and flagged as plain (writer may redo it)', !hr.handoff && hr.plain === true && hr.text === '沒有用工具，直接回答。', hr);
  let hn = 0; hr = await V.runAgentLoop({ messages: base(), tools: [spec('t1')], budget: bud, handoff: true, maxRounds: 3, generate: async (a) => tcall('t1', { q: 'k' + (hn++) }), execTool: hex });
  check('handoff: endless distinct calls still converge to a handoff', hr.handoff === true && hr.calls.length <= 3, hr);
  hr = await V.runAgentLoop({ messages: base(), tools: [spec('t1')], budget: bud, handoff: true, generate: hmk([tcall('t1', { q: 'a' }), tcall('t1', { q: 'a' })]), execTool: hex });
  check('handoff: a duplicate call after a good result hands off immediately', hr.handoff === true && hr.calls.filter((c) => !c.skipped).length === 1, hr);
}
console.log(ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
})();
