// node renderer/src/studio/llm_web_route.test.js
// 網頁版模型路由：列出 llm 資產（ready／原因）、頁內生成（注入假的 onnxruntime-web，驗證路由與貪婪解碼串接）、下載檔案（交給 h.download）
// 真的 onnxruntime-web 1.22 跑 q8 的實測見 ~/fa/lora-export-work/driver/web_ort122_check.js（輸出寫在 docs/DESIGN §25）
const Asset = require('./asset_core.js'), Storage = require('./storage_core.js');
const { createServer } = require('./studio_server_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
const enc = (s) => new TextEncoder().encode(s);
// 最小 tokenizer.json：每個位元組一個 token（ASCII 原樣），再加 <|im_end|>=300
const B = []; for (let i = 33; i <= 126; i++) B.push(i);
const vocab = {}; for (const b of B) vocab[String.fromCharCode(b)] = b; vocab['à'] = 224;
const tokj = { model: { type: 'BPE', vocab, merges: [] }, added_tokens: [{ content: '<|im_end|>', id: 300 }], pre_tokenizer: { type: 'Sequence', pretokenizers: [{ type: 'Split', pattern: { Regex: '[\\s\\S]' } }] } };
const tokBytes = enc(JSON.stringify(tokj));
const onnxBytes = new Uint8Array(4096).map((_, i) => (i * 31) & 255);
// 假 ort：argmax＝(最後一個輸入 token + 1) % 300；KV 的 present 是空張量
const fakeOrt = {
    Tensor: class { constructor(t, d, dims) { this.type = t; this.data = d; this.dims = dims; } },
    InferenceSession: { create: async (bytes, o) => { fakeOrt.lastOpts = o; fakeOrt.lastBytes = bytes.length; return { run: async (feed) => { const ids = feed.input_ids.data; const q = ids.length; const V = 301; const lg = new Float32Array(q * V); for (let i = 0; i < q; i++) { lg[i * V + ((Number(ids[i]) + 1) % 300)] = 9; } const r = { logits: { data: lg, dims: [1, q, V] } }; for (let l = 0; l < 28; l++) for (const k of ['key', 'value']) r[`present.${l}.${k}`] = new fakeOrt.Tensor('float32', new Float32Array(0), [1, 8, q, 128]); return r; } }; } },
};
(async () => {
    const storage = Storage.createStorage({ memory: Storage.createMemoryStore() });
    const downloads = [];
    const h = { storage, desktop: false, now: () => 1000, prefsGet: () => ({}), prefsSet: () => {}, download: async (n, b) => { downloads.push({ n, b }); }, call: async () => ({ ok: false, error: 'no host' }), llmWeb: { loadOrt: async () => fakeOrt } };
    const srv = createServer(h); srv.setPush(() => {});
    const req = async (m, p, body) => { const r = await srv.route(m, new URL('http://mock.local' + p), body); return { s: r.s || 200, j: r.j }; };
    // 一個可用的 onnx 資產、一個 gguf（不可用）、一個缺 tokenizer 的 onnx
    const mk = (name, format, files) => { const m = Asset.createManifest({ kind: 'llm', name, files, owner: 'user', base: 'Qwen3-0.6B', compat: {}, counts: {}, eval: null }); m.llm = { format, quant: format === 'onnx' ? 'q8' : 'q8_0', recipe: 'full', excluded: [] }; return storage.saveAsset({ manifest: m, files }); };
    await mk('ok-q8', 'onnx', { 'q8/model_quantized.onnx': onnxBytes, 'tokenizer.json': tokBytes });
    await mk('ok-q8-legacy', 'onnx', { 'q8/model_quantized.onnx': onnxBytes, 'q8/tokenizer.json': tokBytes });
    await mk('gg', 'gguf', { 'gguf/model-q8_0.gguf': new Uint8Array([1, 2, 3]) });
    await mk('no-tok', 'onnx', { 'q8/model_quantized.onnx': onnxBytes });

    let r = await req('GET', '/api/llm/web/models');
    const byName = Object.fromEntries((r.j.models || []).map((m) => [m.name, m]));
    check('models：ONNX 含 q8 與 tokenizer → ready', r.j.ok && byName['ok-q8'] && byName['ok-q8'].ready === true, r.j);
    check('models：GGUF 不可用，原因指向 llama.cpp', byName.gg && byName.gg.ready === false && /llama\.cpp/.test(byName.gg.reason), byName.gg);
    check('models：缺 tokenizer 不可用，說出缺什麼', byName['no-tok'] && byName['no-tok'].ready === false && /tokenizer/.test(byName['no-tok'].reason), byName['no-tok']);
    check('models：回報 ortAvailable', r.j.ortAvailable === true);
    check('models：舊版路徑 q8/tokenizer.json 也算 ready', byName['ok-q8-legacy'] && byName['ok-q8-legacy'].ready === true, byName['ok-q8-legacy']);

    r = await req('POST', '/api/llm/web/generate', { name: 'ok-q8', prompt: 'ab', maxNew: 3 });
    check('generate：回 ok 與 tokens（貪婪：b→c→d 依假模型）', r.j.ok === true && r.j.tokens.join() === [99, 100, 101].join() && r.j.text === 'cde' && r.j.stoppedBy === 'max', r.j);
    check('generate：session 用 wasm EP 建立', fakeOrt.lastOpts && fakeOrt.lastOpts.executionProviders.join() === 'wasm', fakeOrt.lastOpts);
    r = await req('POST', '/api/llm/web/generate', { name: 'ok-q8', prompt: 'a', maxNew: 2 });
    check('generate：第二次沿用已載入的 session', r.j.ok === true && r.j.tokens.join() === '98,99');
    r = await req('POST', '/api/llm/web/generate', { name: 'ok-q8', prompt: '', maxNew: 2 });
    check('generate：空提示回 400', r.s === 400 && r.j.ok === false, r.j);
    r = await req('POST', '/api/llm/web/generate', { name: 'gg', prompt: 'a', maxNew: 2 });
    check('generate：GGUF 不在網頁版推論範圍（400）', r.s === 400 && /GGUF/.test(r.j.error), r.j);
    r = await req('POST', '/api/llm/web/generate', { name: 'nope', prompt: 'a', maxNew: 2 });
    check('generate：沒有的資產回 404', r.s === 404, r.j);
    const noOrt = createServer({ storage, desktop: true, now: () => 1, prefsGet: () => ({}), prefsSet: () => {}, download: async () => {}, call: async () => ({ ok: false }) });
    const r2 = await noOrt.route('POST', new URL('http://m/api/llm/web/generate'), { name: 'ok-q8', prompt: 'a' });
    check('generate：沒有注入 onnxruntime-web 時說出原因（不假裝）', r2.s === 400 && /onnxruntime-web/.test(r2.j.error), r2.j);

    r = await req('POST', '/api/asset/download', { kind: 'llm', name: 'gg', path: 'gguf/model-q8_0.gguf' });
    check('download：交給 h.download（檔名＝路徑最後一段，位元組相同）', r.j.ok === true && downloads.length === 1 && downloads[0].n === 'model-q8_0.gguf' && downloads[0].b.length === 3, r.j);
    r = await req('POST', '/api/asset/download', { kind: 'llm', name: 'gg', path: 'nope.bin' });
    check('download：資產裡沒有的檔案回 404', r.s === 404, r.j);

    console.log(ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('FAIL 例外 ' + (e && e.stack || e)); process.exit(1); });
