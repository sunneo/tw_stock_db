/* 「建立 LLM（從零開始）」的純函式核心（UMD，node 可測）。設計見 DESIGN.offline-training-studio.md「建立 LLM（從零開始）」。
 * 訓練本身在 llm_scratch.py（命令列腳本）；這裡只負責：
 *   SPEC       ext_job_core 的型別規格（腳本、需要的 Python 套件、參數範圍與預設、輸出檔、判定規則）
 *   STAGES     七個階段的說明（介面逐段顯示：清理、分詞器、預訓練、指令微調、評量、匯出、載入核對）
 *   planSteps  依參數組出步驟（cmd／args／cwd／check），格式與 ext_job_core.planFor 相同
 *   estimate   老實估時間（依 token 數與模型大小；量測值見 SEC_PER_KTOK）
 *   param 數量 paramCount(preset, vocab)
 *   CLI        node llm_scratch_core.js native-check …：用應用程式的原生執行環境（nr-engine.js）載入並回答一題
 * 與 ext_job_core 的接法：ExtJob.registerSpec(LlmScratch.SPEC)（studio_host.js 啟動時註冊）。
 * 原生執行環境寫死 28 層／8 個 KV 頭／head_dim 128，所以模型只能改寬度與詞彙表大小（見 SHAPE）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else (root.FaLlmScratch = factory()); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SHAPE = { layers: 28, heads: 8, kvHeads: 8, headDim: 128 };
  var PRESETS = {
    mini: { label: '迷你（約 1 千 3 百萬參數）', hidden: 96, intermediate: 256 },
    small: { label: '小型（約 2 千萬參數）', hidden: 128, intermediate: 384 },
  };
  // 每 1000 個訓練 token 的秒數（處理器；量測值，見設計文件；電腦忙碌時會慢數倍）。pretrain 為前向加反向。
  var SEC_PER_KTOK = { mini: 14, small: 22 };

  // 參數量（與 llm_scratch.py 的結構一致：詞嵌入與輸出頭共享）
  function paramCount(preset, vocab) {
    var p = PRESETS[preset]; if (!p) return NaN;
    var H = p.hidden, I = p.intermediate, S = SHAPE, qd = S.heads * S.headDim, kd = S.kvHeads * S.headDim;
    var perLayer = H * qd + 2 * H * kd + qd * H + 3 * H * I + 2 * H + 2 * S.headDim;
    return vocab * H + S.layers * perLayer + H;
  }

  var STAGES = [
    { id: 'prep', label: '語料清理與切分', what: '統一編碼、去掉控制字元與重複行、濾掉不是文字的行；以區塊為單位切出留出集。' },
    { id: 'tokenizer', label: '訓練分詞器（BPE）', what: '位元組級 BPE，能處理繁體中文；量測在留出文字上的壓縮率，並核對編碼後可以原樣還原。' },
    { id: 'pretrain', label: '預訓練', what: '下一詞預測。顯示訓練損失、留出損失與困惑度，並用同一批開頭文字前後對照生成。' },
    { id: 'sft', label: '指令微調', what: '套用聊天樣板（與應用程式原生執行環境同一份），只對助理的回答算損失。' },
    { id: 'export', label: '匯出 ONNX（q8）', what: '匯出 ONNX fp32，再動態量化為 q8；與 PyTorch 比對 logits 與貪婪 token。GGUF 為選配（目前未做）。' },
    { id: 'check', label: '重新載入核對', what: '重新載入 q8 模型兩次，貪婪生成，結果須逐字相同，並與匯出時相同。' },
    { id: 'native', label: '原生執行環境載入並回答', what: '用應用程式的原生執行環境（onnxruntime-node）載入並回答一題；僅在找得到執行環境時進行。' },
  ];

  function explain(stderr) {
    var s = String(stderr || '');
    var m = /ModuleNotFoundError: No module named '([^']+)'/.exec(s);
    if (m) return '缺少 Python 套件「' + m[1] + '」。請在訓練環境安裝它後再試。';
    if (/MemoryError|std::bad_alloc|out of memory/i.test(s)) return '記憶體不足。請把批次或序列長度調小後再試。';
    var e = /"error":\s*"([^"]+)"/.exec(s); if (e) return e[1];
    return null;
  }

  var SPEC = {
    id: 'llm_scratch', name: '建立 LLM（從零開始）', wired: true, script: 'llm_scratch.py',
    python: ['torch', 'tokenizers', 'onnx', 'onnxruntime', 'numpy'], needsNode: false,
    summary: '從語料開始，訓練分詞器、預訓練、指令微調，匯出可在應用程式離線載入的小模型（Qwen3 同型，約 1 千萬到 2 千萬參數）。',
    paths: [],
    limits: { vocab: [512, 32000], steps: [10, 200000], batch: [1, 64], seq: [32, 1024], lr: [1e-5, 0.1], warmup: [1, 5000], seed: [0, 1e9], sftSteps: [1, 5000], sftBatch: [1, 64], sftLr: [1e-6, 0.1], threads: [1, 64] },
    defaults: { corpus: '', preset: 'mini', sftData: '', vocab: 4096, steps: 300, batch: 4, seq: 128, lr: 0.002, warmup: 20, seed: 0, sftSteps: 60, sftBatch: 4, sftLr: 0.0005, threads: 6 },
    estimate: '處理器（CPU）上，迷你模型每 1000 個訓練 token 約 14 秒（量測；電腦忙碌時慢數倍）。預設 300 步 × 4 × 128 ≈ 15 萬 token，預訓練約 40 分鐘，全流程約 1 小時；要訓練得像樣需要幾倍到數十倍的時間與語料。',
    outputs: ['data/prep_report.json', 'tok/tokenizer.json', 'tok/tokenizer_report.json', 'base/ckpt.pt', 'base/pretrain_meta.json', 'chat/ckpt.pt', 'chat/sft_meta.json', 'export/q8/model_quantized.onnx', 'export/tokenizer.json', 'export/manifest.json', 'export/check.json'],
    checks: [{ op: 'true', key: 'reload_identical' }, { op: 'true', key: 'matches_export' }],
    explain: explain,
    limitsNote: '模型只有 1 千萬到 2 千萬參數、語料只有幾 MB 時，預訓練後的文字只會是「像中文的片段」，不是能可靠回答的助理；指令微調只教會它聊天格式與少量範例。這是完整流程的實作與驗證，不是可用的聊天品質。原生執行環境寫死 28 層／8 個 KV 頭／head_dim 128，所以只能調寬度；結束標記不在它寫死的停止清單裡，會一直生成到字數上限（輸出文字會在 <|im_end|> 處截斷）。',
  };

  // 依參數組步驟。env：{ python, nodeExec, scriptsDir, outDir, nativeRuntimeDir? }
  function planSteps(p, env) {
    var errors = [];
    if (!PRESETS[p.preset]) errors.push('preset 必須是 ' + Object.keys(PRESETS).join('／') + '（目前 ' + JSON.stringify(p.preset) + '）');
    if (p.warmup >= p.steps) errors.push('warmup 必須小於 steps');
    if (errors.length) return { ok: false, errors: errors, steps: [] };
    var sd = env.scriptsDir, out = env.outDir, py = env.python, script = sd + '/' + SPEC.script, s = String;
    var st = function (id, label, cmd, args, extra) { return Object.assign({ id: id, label: label, cmd: cmd, args: args, cwd: sd }, extra || {}); };
    var steps = [];
    var prep = [script, 'prep', '--out', out + '/data'];
    var corpus = p.corpus || (env.paths && env.paths.corpus) || '';
    if (corpus) prep.push('--corpus', s(corpus)); else prep.push('--builtin');
    steps.push(st('prep', STAGES[0].label, py, prep));
    steps.push(st('tokenizer', STAGES[1].label, py, [script, 'tokenizer', '--data', out + '/data', '--out', out + '/tok', '--vocab', s(p.vocab)], { check: [{ op: 'true', key: 'roundtrip_all_ok' }] }));
    steps.push(st('pretrain', STAGES[2].label, py, [script, 'pretrain', '--data', out + '/data', '--tok', out + '/tok/tokenizer.json', '--out', out + '/base', '--preset', p.preset, '--steps', s(p.steps), '--batch', s(p.batch), '--seq', s(p.seq), '--lr', s(p.lr), '--warmup', s(p.warmup), '--seed', s(p.seed), '--threads', s(p.threads), '--eval-every', s(Math.max(10, Math.floor(p.steps / 4)))], { check: [{ op: 'lt', a: 'heldout_loss_after', b: 'heldout_loss_before' }] }));
    var sft = [script, 'sft', '--base', out + '/base', '--out', out + '/chat', '--steps', s(p.sftSteps), '--batch', s(p.sftBatch), '--lr', s(p.sftLr), '--seed', s(p.seed)];
    if (p.sftData) sft.push('--data', s(p.sftData));
    steps.push(st('sft', STAGES[3].label, py, sft, { check: [{ op: 'lt', a: 'heldout_loss_after', b: 'heldout_loss_before' }] }));
    steps.push(st('export', STAGES[4].label, py, [script, 'export', '--model', out + '/chat', '--out', out + '/export'], { check: [{ op: 'true', key: 'fp32_greedy_matches_torch' }] }));
    steps.push(st('check', STAGES[5].label, py, [script, 'check', '--model-dir', out + '/export'], { check: SPEC.checks }));
    if (env.nativeRuntimeDir) {
      steps.push(st('native', STAGES[6].label, env.nodeExec || process.execPath, [sd + '/llm_scratch_core.js', 'native-check', '--runtime', env.nativeRuntimeDir, '--model-dir', out + '/export', '--question', s(p.nativeQuestion || '臺灣的首都是哪裡？')], { env: { ELECTRON_RUN_AS_NODE: '1' }, check: [{ op: 'true', key: 'native_answered' }, { op: 'true', key: 'native_reload_identical' }] }));
    }
    return { ok: true, errors: [], steps: steps };
  }

  // 估時間（分鐘）：預訓練與指令微調的 token 數 × 每千 token 秒數，另加匯出與核對約 3 分鐘
  function estimate(p) {
    var spk = SEC_PER_KTOK[p.preset] || SEC_PER_KTOK.mini;
    var pre = p.steps * p.batch * p.seq / 1000 * spk / 60, sft = p.sftSteps * p.sftBatch * 80 / 1000 * spk / 60;
    return { pretrainMin: Math.round(pre), sftMin: Math.max(1, Math.round(sft)), exportMin: 3, totalMin: Math.round(pre + sft + 3), params: Math.round(paramCount(p.preset, p.vocab)) };
  }

  // ---- CLI：原生執行環境載入並回答 ----
  function nativeCheck(opt) {
    var path = require('path'), fs = require('fs');
    var engine = require(path.join(opt.runtime, 'nr-engine.js'));
    var modelPath = path.join(opt.modelDir, 'q8', 'model_quantized.onnx'), tokPath = path.join(opt.modelDir, 'tokenizer.json');
    var gen = { do_sample: false };
    var run = function () { return engine.generate({ modelPath: modelPath, tokenizerPath: tokPath, messages: [{ role: 'user', content: opt.question }], gen: gen, maxTokens: opt.maxTokens || 48, threads: 4 }); };
    return run().then(function (a) {
      return run().then(function (b) {
        var rep = { event: 'native_check', native_loaded: true, native_answered: typeof a.text === 'string' && a.text.length > 0, native_reload_identical: a.text === b.text && JSON.stringify(a.ids) === JSON.stringify(b.ids), question: opt.question, answer: a.text, finish_reason: a.finish_reason, n_tokens: a.ids.length };
        fs.writeFileSync(path.join(opt.modelDir, 'native_check.json'), JSON.stringify(rep, null, 2));
        return rep;
      });
    });
  }

  return { SHAPE: SHAPE, PRESETS: PRESETS, SEC_PER_KTOK: SEC_PER_KTOK, STAGES: STAGES, SPEC: SPEC, paramCount: paramCount, planSteps: planSteps, estimate: estimate, nativeCheck: nativeCheck };
});

if (typeof require === 'function' && require.main === module) {
  var C = module.exports, args = process.argv.slice(2), cmd = args.shift(), o = {};
  for (var i = 0; i < args.length; i += 2) o[args[i].replace(/^--/, '')] = args[i + 1];
  if (cmd === 'native-check') {
    C.nativeCheck({ runtime: o.runtime, modelDir: o['model-dir'], question: o.question || '臺灣的首都是哪裡？', maxTokens: Number(o['max-tokens']) || 48 })
      .then(function (r) { console.log(JSON.stringify(r)); }, function (e) { console.log(JSON.stringify({ event: 'native_check', native_loaded: false, native_answered: false, error: String((e && e.message) || e) })); process.exit(2); });
  } else { console.error('用法：node llm_scratch_core.js native-check --runtime <執行包資料夾> --model-dir <export 資料夾> [--question 文字]'); process.exit(1); }
}
