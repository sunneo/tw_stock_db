// node renderer/src/studio/pipeline_view_core.test.js
const V = require('./pipeline_view_core.js'), PL = require('./pipeline_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };

// 格式化
check('秒數格式：3661 秒 → 1:01:01；空值回 null', V.fmtSec(3661) === '1:01:01' && V.fmtSec(49) === '00:49' && V.fmtSec(null) === null && V.fmtSec(NaN) === null);
check('位元組格式：1.5 MB；小於 1KB 用位元組', V.fmtBytes(1.5 * 1024 * 1024) === '1.5 MB' && V.fmtBytes(12) === '12 位元組' && V.fmtBytes(null) === null);

// 跳脫：外部字串（資料夾名、錯誤文字、建議文字）都不能變成標籤
check('跳脫 HTML', V.esc('<img src=x onerror="a">&\'') === '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');

// 基本階段圖
const stages = PL.deriveStageStates('lora', { stages: { ingest: { products: [{ count: 10, files: 2, sha256: 'abcdef0123456789' }], done: true }, train: { running: true, progress: { step: 40, total: 100, pct: 40, secPerStep: 0.82, secSource: '日誌 tqdm 的 s/it', etaSec: 49, loss: 1.5, lossFirst: 2.1, logState: '進行中', elapsedSec: 60, memory: { lastBytes: 1.4e9, peakBytes: 1.6e9, samples: 3 }, memoryReason: '' } } } });
const view = { ok: true, kind: 'lora', label: 'LoRA', stages: stages.stages, live: stages.stages[3].progress, memory: stages.stages[3].progress.memory, memoryReason: '', export: null, source: { manifest: true, asset: 'lora/demo', log: true, runDir: 'D:/run1' } };
const html = V.renderPipelineHTML(view, null);
check('階段狀態有對應的樣式與標籤', /st-done/.test(html) && /st-run/.test(html) && /st-todo/.test(html) && /b-run">進行中/.test(html), html.slice(0, 300));
check('產物顯示筆數、檔案數與 sha256 片段', /產物：10 筆・2 個檔案・sha256 abcdef0123456789/.test(html));
check('即時：步數、百分比、預估剩餘、loss、記憶體與峰值', /40 \/ 100（40%）/.test(html) && /00:49（估）/.test(html) && /1\.5（第一次 2\.1）/.test(html) && /1\.3 GB|1\.4 GB/.test(html) && /峰值 1\.5 GB/.test(html), html.slice(html.indexOf('即時狀態'), html.indexOf('即時狀態') + 600));
check('即時：每步秒數標明來源', /0\.82 秒／步（日誌 tqdm 的 s\/it）/.test(html));
check('沒有即時資料：寫無資料（附原因），不假裝有進度', /無資料（沒有訓練紀錄：請指定訓練資料夾/.test(V.renderPipelineHTML(Object.assign({}, view, { live: null, memory: null, memoryReason: '' }), null)));
check('記憶體沒有取樣：寫無資料與原因', /記憶體<\/span><span class="v"><span class="na">無資料（沒有子行程 pid）/.test(V.renderPipelineHTML(Object.assign({}, view, { memory: null, memoryReason: '沒有子行程 pid' }), null)));

// 未實作與阻礙
const llm = PL.deriveStageStates('llm', { stages: {} });
const lhtml = V.renderPipelineHTML({ ok: true, kind: 'llm', label: 'LLM', stages: llm.stages, live: null, memory: null, memoryReason: '', export: PL.pickExportFormat('desktop', {}), env: 'desktop', source: { manifest: false, log: false } }, null);
check('LLM 匯出：已實作，畫面有 ONNX 匯出階段，且該階段不標未實作', /ONNX/.test(lhtml) && !llm.stages.find((s) => s.id === 'export').unimplemented);
const withOnnx = V.renderPipelineHTML({ ok: true, kind: 'llm', label: 'LLM', stages: llm.stages, live: null, memory: null, memoryReason: '', export: PL.pickExportFormat('web', { onnxExport: true, ggufExport: false }), env: 'web', source: {} }, null);
check('有 ONNX：寫預設格式與環境', /預設格式：ONNX（q8，網頁）/.test(withOnnx));

// 建議：依據、按鈕、位置偏誤無資料
const adv = { ok: true, suggestions: [{ rule: 'regression', name: 'group/x', severity: 'high', action: 'reweight', actionLabel: '調比重', actionHint: '調整比重', text: 'x 退步', evidence: { source: 'eval.json groups["group/x"]', numbers: { base: 5, tuned: 3 } } }],
    insufficient: [{ rule: 'position-bias', name: '全體', missing: ['rows[].gold'], reason: '缺 gold' }, { rule: 'few-rows', name: 'z', missing: ['trainRows'], reason: '沒有列數' }] };
const ahtml = V.adviceBlock(adv);
check('建議：附依據來源與動作按鈕', /依據：eval\.json groups\[&quot;group\/x&quot;\]/.test(ahtml) && /data-action="reweight"/.test(ahtml) && />調比重</.test(ahtml), ahtml);
check('建議：位置偏誤寫無資料（附缺的欄位原因）', /全體：無資料（缺 gold）/.test(ahtml));
check('建議：沒有評量輸出：寫無資料，不給建議', /還沒有評量輸出/.test(V.adviceBlock(null)));
check('建議：沒有需要加強的項目時明說', /目前沒有需要加強的項目/.test(V.adviceBlock({ ok: true, suggestions: [], insufficient: [] })));
check('建議：來源或文字含 HTML 會被跳脫', (() => { const h = V.adviceBlock({ ok: true, suggestions: [{ rule: 'r', name: '<b>', severity: 'low', action: 'add_data', actionLabel: 'x', actionHint: '', text: '<i>t</i>', evidence: { source: '<s>', numbers: { a: 1 } } }], insufficient: [] }); return h.indexOf('<i>') < 0 && h.indexOf('&lt;i&gt;') >= 0 && h.indexOf('<s>') < 0; })());

// 錯誤與整頁
check('整頁錯誤：顯示錯誤文字（已跳脫）', /&lt;bad&gt;/.test(V.renderPipelineHTML({ ok: false, error: '<bad>' }, null)));
check('整頁：標題與資料來源', /LoRA 流程/.test(html) && /資料來源：資產 lora\/demo/.test(html));

console.log(ok + ' passed, ' + bad + ' failed');
process.exit(bad ? 1 : 0);
