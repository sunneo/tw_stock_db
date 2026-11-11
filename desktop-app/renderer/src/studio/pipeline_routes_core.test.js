// node renderer/src/studio/pipeline_routes_core.test.js
const R = require('./pipeline_routes_core.js'), PL = require('./pipeline_core.js'), LV = require('./pipeline_live_core.js'), AD = require('./train_advice_core.js'), BP = require('./backend_cpu_py.js');
const LM = require('./lora_manage_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };
const enc = (s) => new TextEncoder().encode(s);

// ---- 假儲存層：形狀與 storage_core 的 loadManifest／loadAsset 一致 ----
const manifest = { kind: 'lora', name: 'demo', counts: { train: 8, holdout: 2 }, sha256: { 'weights/lora.bin': 'aaaa', 'manifest.json': 'x' }, eval: { ok: true } };
const evalJson = { groups: { 'group/blockly-parity': { n: 8, base: 5, tuned: 3 }, 'group/uml-class': { n: 12, base: 6, tuned: 11 } }, rows: [
    { key: 'matrix/lin', tuned_ok: false, note: 'format: x' }, { key: 'matrix/lin', tuned_ok: false, note: 'format: y' }, { key: 'matrix/lin', tuned_ok: false, note: 'format: z' }, { key: 'matrix/lin', tuned_ok: true, note: '' }] };
const trainJsonl = ['{"domain":"matrix/lin","split":"train"}', '{"domain":"matrix/lin","split":"train"}', '{"domain":"matrix/lin","split":"holdout"}', '{"domain":"uml/class","split":"train"}'].join('\n');
const storage = {
    async loadManifest(kind, name) { return kind === 'lora' && name === 'demo' ? manifest : null; },
    async loadAsset(kind, name) { if (kind === 'lora' && name === 'demo-card') return { manifest, asset: { files: { 'model_card.json': JSON.stringify({ format: 'fa-lora-card', version: 1, id: 'lora/demo-card', name: '卡片示範', intro: 'x', base: { name: 'Qwen3-0.6B' }, created: '2026-11-10T00:00:00Z', capabilities: [], known_limits: ['無'], eval: { split_legal_rate: { base: 0.5, tuned: 0.6, n: 40 } } }) } } }; if (kind === 'lora' && name === 'demo-bad') return { manifest, asset: { files: { 'model_card.json': '{not json' } } }; return kind === 'lora' && name === 'demo' ? { manifest, asset: { files: { 'eval.json': JSON.stringify(evalJson), 'data/train.jsonl': enc(trainJsonl) } } } : null; }
};
// 真實格式的訓練紀錄（train_lora.py 的輸出行）
const LOG_RUNNING = [ "{'loss': '2.1034', 'grad_norm': '0.81', 'learning_rate': '0.0002', 'epoch': '0.1'}", '  10/100 [00:08<01:12,  0.80s/it]', "{'loss': '1.5012', 'grad_norm': '0.52', 'learning_rate': '0.0002', 'epoch': '0.5'}", ' 40/100 [00:32<00:48,  0.82s/it]' ].join('\n');
let logText = LOG_RUNNING, rssBytes = 1000 * 1024 * 1024;
const readRunLog = async (dir) => (dir === 'RUN_NONE' ? null : { ok: true, log: logText, events: logText.split('\n').map((l) => BP.parseProgressLine(l)).filter(Boolean), rssBytes, rssReason: rssBytes === null ? '子行程已結束' : '', hostRssBytes: 123 });
const api = R.createPipelineApi({ storage, readRunLog, now: () => 1000, Pipeline: PL, Live: LV, Advice: AD, LoraManage: LM, parseLine: BP.parseProgressLine, exportCaps: () => ({ onnxExport: false, ggufExport: false }) });
const U = (p) => new URL('http://x' + p);

(async () => {
    // ---- 路由形狀 ----
    check('不是這裡的路由回 null', (await api.route('GET', U('/api/other'), {})) === null && (await api.route('POST', U('/api/pipeline'), {})) === null);
    const bad1 = await api.route('GET', U('/api/pipeline?kind=nope'), {});
    check('未知 kind：400 並列出可用種類', bad1.s === 400 && bad1.j.ok === false && /colu/.test(bad1.j.error), bad1);

    // ---- 訓練中：階段圖、即時、記憶體 ----
    const r1 = await api.route('GET', U('/api/pipeline?kind=lora&name=demo&run=RUN1&env=desktop'), {});
    const st = (id) => r1.j.stages.find((s) => s.id === id);
    check('lora 有 7 個階段：前三段完成（資產存在）；訓練進行中，後面依序待做', r1.j.stages.length === 7 && ['ingest', 'generate', 'split'].every((id) => st(id).state === '完成') && st('train').state === '進行中' && ['eval', 'pack', 'mount'].every((id) => st(id).state === '待做'), r1.j.stages.map((s) => s.state));
    check('訓練中（日誌沒有 [done]）：訓練是進行中，附即時進度', st('train').state === '進行中' && st('train').progress.step === 40 && st('train').progress.total === 100, st('train'));
    check('即時：每步秒數取 tqdm、預估剩餘 60 步×0.82 秒', r1.j.live.secPerStep === 0.82 && r1.j.live.etaSec === 49, r1.j.live);
    check('記憶體來自主行程取樣（子行程 RSS 1000 MB）', r1.j.memory && r1.j.memory.lastBytes === 1000 * 1024 * 1024, r1.j.memory);
    check('記錄來源標示：資產與 train.log 都讀到', r1.j.source.manifest === true && r1.j.source.log === true && r1.j.source.runDir === 'RUN1');
    // 第二次取樣，峰值要更新
    rssBytes = 1500 * 1024 * 1024; const r2 = await api.route('GET', U('/api/pipeline?kind=lora&name=demo&run=RUN1'), {});
    check('記憶體取樣累積：峰值取到最高值', r2.j.memory.peakBytes === 1500 * 1024 * 1024 && r2.j.memory.samples === 2, r2.j.memory);
    rssBytes = null;

    // ---- 訓練完成：日誌 [done] 且資產存在 → 完成；只有日誌 [done] 沒有資產 → 不算完成 ----
    logText = LOG_RUNNING + '\n[done] adapter saved to /out/demo';
    const r3 = await api.route('GET', U('/api/pipeline?kind=lora&name=demo&run=RUN1'), {});
    check('日誌 [done]＋資產存在 → 訓練完成', r3.j.stages.find((s) => s.id === 'train').state === '完成');
    const r4 = await api.route('GET', U('/api/pipeline?kind=lora&run=RUN1'), {});
    check('日誌 [done] 但沒有前置產物與資產：訓練仍待做（前一階段沒完成），不因日誌宣稱完成', r4.j.stages.find((s) => s.id === 'train').state === '待做' && r4.j.stages.find((s) => s.id === 'train').reason === '前一個階段還沒完成' && r4.j.live.logState === '完成', r4.j.stages.find((s) => s.id === 'train'));
    logText = LOG_RUNNING;

    // ---- 沒有紀錄、沒有資料夾 ----
    const r5 = await api.route('GET', U('/api/pipeline?kind=lora&name=demo'), {});
    check('沒有 run：即時為空、記憶體說明沒有指定資料夾', r5.j.live === null && /沒有指定訓練資料夾/.test(r5.j.memoryReason), r5.j);
    const r6 = await api.route('GET', U('/api/pipeline?kind=lora&name=demo&run=RUN_NONE'), {});
    check('讀不到 train.log：說明讀不到，不宣稱進度', r6.j.live === null && /讀不到訓練紀錄/.test(r6.j.memoryReason) && r6.j.source.log === false, r6.j);

    // ---- 符號式：按需載入是略過；LLM：匯出與載入都標示未實作 ----
    const sym = await api.route('GET', U('/api/pipeline?kind=colu&name=demo'), {});
    check('符號式：按需載入略過（不需要載入）', sym.j.stages.find((s) => s.id === 'mount').state === '略過');
    const llm = await api.route('GET', U('/api/pipeline?kind=llm&name=demo&env=web'), {});
    check('LLM：匯出階段標示未實作並寫明阻礙', llm.j.stages.find((s) => s.id === 'export').unimplemented === true && /optimum|llama/.test(llm.j.stages.find((s) => s.id === 'export').reason));
    check('LLM 匯出格式：沒有工具時預設為空，原因寫明', llm.j.export.default === null && /尚未實作/.test(llm.j.export.reason) && llm.j.env === 'web', llm.j.export);
    const apiOnnx = R.createPipelineApi({ storage, readRunLog, now: () => 1, Pipeline: PL, Live: LV, Advice: AD, exportCaps: () => ({ onnxExport: true, ggufExport: false }) });
    const llm2 = await apiOnnx.route('GET', U('/api/pipeline?kind=llm&name=demo&env=desktop'), {});
    check('有 ONNX 工具時桌面預設 ONNX q8；GGUF 不提供', llm2.j.export.default === 'onnx' && llm2.j.export.quant === 'q8' && llm2.j.export.options.find((o) => o.format === 'gguf').available === false);

    // ---- 建議：讀資產的 eval.json；trainRows 從資料檔數（holdout 不計）----
    const a1 = await api.route('GET', U('/api/advice?kind=lora&name=demo'), {});
    check('建議：退步的組被列出，附來源檔與數字', a1.j.suggestions.some((s) => s.rule === 'regression' && s.name === 'group/blockly-parity' && /eval\.json/.test(s.evidence.source)), a1.j.suggestions);
    check('建議：領域列數從資料檔數出（matrix/lin 訓練 2 列，holdout 不計）', (() => { const s = a1.j.suggestions.find((x) => x.rule === 'few-rows' && x.name === 'matrix/lin'); return !!s && s.evidence.numbers.trainRows === 2; })(), a1.j.suggestions);
    check('建議：位置偏誤因 rows 沒有 gold／pred，列為無資料（不猜）', a1.j.insufficient.some((i) => i.rule === 'position-bias') && !a1.j.suggestions.some((s) => s.rule === 'position-bias'));
    const a2 = await api.route('GET', U('/api/advice?kind=lora&name=none'), {});
    check('沒有 eval.json 的資產：不給建議，說明缺哪個檔', a2.j.suggestions.length === 0 && a2.j.insufficient[0].rule === 'eval' && /eval_run\.py/.test(a2.j.insufficient[0].reason), a2.j);

    // ---- 貼上的 JSON ----
    const p1 = await api.route('POST', U('/api/advice/from-json'), { report: evalJson, trainRows: { 'matrix/lin': 50 }, source: 'my.json' });
    check('貼上的 JSON：來源寫進建議', p1.j.ok && p1.j.suggestions.some((s) => s.evidence.source.indexOf('my.json') === 0 && s.rule === 'regression'));
    const p2 = await api.route('POST', U('/api/advice/from-json'), { report: { rows: [] } });
    check('貼上的 JSON 沒有 groups：400', p2.s === 400 && /groups/.test(p2.j.error), p2);

    // ---- LoRA model card 路由（§21）----
    const c1 = await api.route('GET', U('/api/lora/card?id=lora/demo-card'), {});
    check('card：有 model_card.json 就回摘要（判定、差距）', c1.j.ok && c1.j.hasCard && c1.j.card.name === '卡片示範' && c1.j.card.metrics[0].deltaPts === 10 && c1.j.card.metrics[0].verdict === '進步', c1.j);
    const c2 = await api.route('GET', U('/api/lora/card?id=lora/demo'), {});
    check('card：沒有 model_card.json 照實說', c2.j.ok && c2.j.hasCard === false && /沒有 model_card/.test(c2.j.reason), c2.j);
    const c3 = await api.route('GET', U('/api/lora/card?id=lora/demo-bad'), {});
    check('card：壞掉的 JSON 回 400 並說明', c3.s === 400 && /不是合法的 JSON/.test(c3.j.error), c3);
    const c4 = await api.route('GET', U('/api/lora/card?id=colu/x'), {});
    check('card：參照格式不是 lora/ 回 400', c4.s === 400);
    const c5 = await api.route('GET', U('/api/lora/card?id=lora/demo-card'), {});
    check('card：summarizeCard 與 validateModelCard 接上（缺評量指標寫無資料）', c5.j.card.metrics[1].available === false, c5.j.card.metrics);

    // ---- 純函式 ----
    check('trainRowsFrom：只計 train，缺 domain 歸到 ?', (() => { const t = R.trainRowsFrom({ 'data/a.jsonl': enc('{"domain":"x","split":"train"}\n{"split":"train"}\n{"domain":"x","split":"holdout"}\nbroken\n') }); return t.x === 1 && t['?'] === 1; })());
    check('eventsFromLog 略過不認得的行', R.eventsFromLog('hello\n  1/2 [00:01<00:01,  1.00s/it]', BP.parseProgressLine).length === 1);
    check('factsFromManifest：沒有 sha256 的資產不算產物', Object.keys(R.factsFromManifest('lora', { sha256: {} }, PL).stages).length === 0);
    check('ASSET_KIND：llm 的產物是 lora 資產', R.ASSET_KIND.llm === 'lora' && R.ASSET_KIND.colu === 'colu');

    console.log(ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
