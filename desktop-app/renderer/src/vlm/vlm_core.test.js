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
console.log(ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
