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
    tiny: { label: '實驗用（4 層，約 2 百萬到 4 百萬參數）', hidden: 96, intermediate: 512, layers: 4 },
  };
  var ARCHS = {
    dense: { label: '密集（標準）', what: '每個詞元都經過整個前饋層。' },
    moe: { label: '專家混合（MoE）', what: '每層有多個專家，路由器為每個詞元挑前幾名並加權；訓練時加負載平衡輔助損失，避免只用少數專家。總參數比密集多，但每個詞元用到的參數與同寬度的密集模型相同。匯出給原生執行環境時，圖裡會把所有專家都算一遍（數值相同，但沒有省算力）。' },
    reasoning: { label: '推理（思考＋答案）', what: '預訓練後先用「思考＋答案」格式做指令微調，再用可以程式核對答案的算術題做強化學習（GRPO，答對才給分）。架構與密集模型相同，差別在訓練方式。' },
  };
  // 預訓練每 1000 個 token 的秒數：mini 在負載平均約 65 的忙碌 24 核機器上實測（1992 秒／77 千 token）；tiny 實測 2.4（600 步×1024 token＝1453 秒，同樣忙碌）；
  // small 沒有實測，依參數量比例（約 1.5 倍）估計。電腦閒置時預期較快，但沒有量測。專家混合（MoE）實測 tiny 為 1.09 倍（1586／1453 秒），其他大小沿用這個比例（未實測）。
  var SEC_PER_KTOK = { mini: 26, small: 39, tiny: 2.4 };
  var MOE_FACTOR = 1.1;
  // 指令微調每步（批次 4）的秒數：mini 實測約 3（150 步 444 秒，含評量；先前記成 97 是 24 個執行緒搶核造成的假象，已修正執行緒上限）；
  // tiny 的算術微調實測約 0.044 秒／筆（1200 步×16 筆 760 秒）；small 依比例估。
  var SFT_SEC_PER_STEP = { mini: 3, small: 4.5, tiny: 0.18 };
  var GRPO_SEC_PER_STEP = 12;   // 8 題 × 每題 8 個取樣（tiny，實測 150 步約 30 分鐘）；依「題數×每題取樣數」成比例
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
    { id: 'hf', label: '輸出標準 Hugging Face 格式', what: '同一顆模型另存成標準 Qwen3 的 safetensors（可直接給 LoRA 微調與加長上下文接手），並用 transformers 載入、與自己的 logits 與貪婪輸出比對。' },
    { id: 'check', label: '重新載入核對', what: '重新載入 q8 模型兩次，貪婪生成，結果須逐字相同，並與匯出時相同。' },
    { id: 'native', label: '原生執行環境載入並回答', what: '用應用程式的原生執行環境（onnxruntime-node）載入並回答一題；僅在找得到執行環境時進行。' },
    { id: 'math', label: '產生算術題', what: '可程式核對答案的加減乘題（兩位數），附逐步推導；留出題與訓練題不重複。' },
    { id: 'eval_math', label: '算術正確率評量', what: '在留出題上用貪婪解碼，分「思考」與「不思考」兩種模式算答對率。' },
    { id: 'grpo', label: '強化學習（GRPO）', what: '每題取樣一組回答，答對得 1 分、答錯 0 分；用組內相對分數更新模型。' },
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
    limits: { vocab: [512, 32000], steps: [10, 200000], batch: [1, 64], seq: [32, 1024], lr: [1e-5, 0.1], warmup: [1, 5000], seed: [0, 1e9], sftSteps: [1, 5000], sftBatch: [1, 64], sftLr: [1e-6, 0.1], threads: [1, 64], layers: [1, 28], heads: [1, 64], kvHeads: [1, 64], hidden: [16, 2048], intermediate: [16, 8192], experts: [2, 64], topK: [1, 8], moeInter: [8, 4096], auxCoef: [0, 1], mathTrain: [100, 50000], mathSteps: [1, 20000], grpoSteps: [1, 5000], grpoPrompts: [1, 64], grpoGroup: [2, 64], grpoLr: [1e-7, 0.01] },
    defaults: { arch: 'dense', corpus: '', preset: 'mini', sftData: '', vocab: 4096, steps: 300, batch: 4, seq: 128, lr: 0.002, warmup: 20, seed: 0, sftSteps: 40, sftBatch: 4, sftLr: 0.0005, threads: 6, experts: 8, topK: 2, auxCoef: 0.01, mathTrain: 2500, mathSteps: 1500, grpoSteps: 200, grpoPrompts: 8, grpoGroup: 8, grpoLr: 0.00002 },
    estimate: '處理器（CPU）上，迷你模型預訓練每 1000 個 token 約 26 秒、指令微調每步約 3 秒（實測，在負載很高的 24 核機器上；閒置時預期較快，未量測）。預設 300 步 × 4 × 128 ≈ 15 萬 token，預訓練約 1 小時，指令微調 40 步約 2 分鐘，全流程約 1 小時；要訓練得像樣需要數十倍以上的 token 與時間。專家混合約慢 1.1 倍（tiny 實測）；推理另加算術微調與強化學習（tiny：強化學習每步約 12 秒）。',
    outputs: ['data/prep_report.json', 'tok/tokenizer.json', 'tok/tokenizer_report.json', 'base/ckpt.pt', 'base/pretrain_meta.json', 'chat/ckpt.pt', 'chat/sft_meta.json', 'export/q8/model_quantized.onnx', 'export/hf/model.safetensors', 'export/hf/config.json', 'export/tokenizer.json', 'export/manifest.json', 'export/check.json'],
    checks: [{ op: 'true', key: 'reload_identical' }, { op: 'true', key: 'matches_export' }],
    explain: explain,
    limitsNote: '模型只有 1 千萬到 2 千萬參數、語料只有幾 MB 時，預訓練後的文字只會是「像中文的片段」，不是能可靠回答的助理；指令微調只教會它聊天格式與少量範例。這是完整流程的實作與驗證，不是可用的聊天品質。原生執行環境寫死 28 層／8 個 KV 頭／head_dim 128，所以只能調寬度；結束標記不在它寫死的停止清單裡，會一直生成到字數上限（輸出文字會在 <|im_end|> 處截斷）。',
  };

  // 依參數組步驟。env：{ python, nodeExec, scriptsDir, outDir, nativeRuntimeDir?, paths? }
  // p.arch：dense（預設）、moe、reasoning。參數 layers／heads／kvHeads／hidden／intermediate 不填就用大小預設。
  function nativeCompatible(p) { return (p.kvHeads == null || Number(p.kvHeads) === SHAPE.kvHeads); }
  function planSteps(p, env) {
    var errors = [];
    if (!PRESETS[p.preset]) errors.push('preset 必須是 ' + Object.keys(PRESETS).join('／') + '（目前 ' + JSON.stringify(p.preset) + '）');
    if (!ARCHS[p.arch]) errors.push('arch 必須是 ' + Object.keys(ARCHS).join('／') + '（目前 ' + JSON.stringify(p.arch) + '）');
    if (p.warmup >= p.steps) errors.push('warmup 必須小於 steps');
    var heads = p.heads != null ? Number(p.heads) : SHAPE.heads, kv = p.kvHeads != null ? Number(p.kvHeads) : SHAPE.kvHeads;
    if (heads % kv) errors.push('注意力頭數（' + heads + '）必須是鍵值頭數（' + kv + '）的倍數');
    if (p.arch === 'moe' && Number(p.topK) > Number(p.experts)) errors.push('每個詞元挑的專家數（' + p.topK + '）不能大於專家總數（' + p.experts + '）');
    if (errors.length) return { ok: false, errors: errors, steps: [] };
    var sd = env.scriptsDir, out = env.outDir, py = env.python, script = sd + '/' + SPEC.script, s = String;
    var st = function (id, label, cmd, args, extra) { return Object.assign({ id: id, label: label, cmd: cmd, args: args, cwd: sd }, extra || {}); };
    var arch = [];
    if (p.arch === 'moe') arch.push('--arch', 'moe', '--experts', s(p.experts), '--top-k', s(p.topK), '--aux-coef', s(p.auxCoef)); else arch.push('--arch', 'dense');
    if (p.moeInter != null && p.arch === 'moe') arch.push('--moe-inter', s(p.moeInter));
    [['layers', '--layers'], ['heads', '--heads'], ['kvHeads', '--kv-heads'], ['hidden', '--hidden'], ['intermediate', '--intermediate']].forEach(function (kv2) { if (p[kv2[0]] != null) arch.push(kv2[1], s(p[kv2[0]])); });
    var steps = [];
    var prep = [script, 'prep', '--out', out + '/data'];
    var corpus = p.corpus || (env.paths && env.paths.corpus) || '';
    if (corpus) prep.push('--corpus', s(corpus)); else prep.push('--builtin');
    steps.push(st('prep', STAGES[0].label, py, prep));
    steps.push(st('tokenizer', STAGES[1].label, py, [script, 'tokenizer', '--data', out + '/data', '--out', out + '/tok', '--vocab', s(p.vocab)], { check: [{ op: 'true', key: 'roundtrip_all_ok' }] }));
    steps.push(st('pretrain', STAGES[2].label, py, [script, 'pretrain', '--data', out + '/data', '--tok', out + '/tok/tokenizer.json', '--out', out + '/base', '--preset', p.preset, '--steps', s(p.steps), '--batch', s(p.batch), '--seq', s(p.seq), '--lr', s(p.lr), '--warmup', s(p.warmup), '--seed', s(p.seed), '--threads', s(p.threads), '--eval-every', s(Math.max(10, Math.floor(p.steps / 4)))].concat(arch), { check: [{ op: 'lt', a: 'heldout_loss_after', b: 'heldout_loss_before' }] }));
    var final = out + '/chat';
    if (p.arch === 'reasoning') {
      var md = out + '/math';
      steps.push(st('math', STAGES[8].label, py, [script, 'gen-math', '--out', md, '--n-train', s(p.mathTrain), '--seed', s(p.seed)]));
      steps.push(st('sft', STAGES[3].label + '（思考＋答案）', py, [script, 'sft', '--base', out + '/base', '--data', md + '/math_train_hybrid.jsonl', '--out', out + '/chat', '--steps', s(p.mathSteps), '--batch', s(p.sftBatch), '--lr', s(p.sftLr), '--seed', s(p.seed), '--heldout-frac', '0.02', '--answer-tokens', '80'], { check: [{ op: 'lt', a: 'heldout_loss_after', b: 'heldout_loss_before' }] }));
      steps.push(st('eval_sft', STAGES[9].label + '（微調後）', py, [script, 'eval-math', '--model', out + '/chat', '--data', md + '/math_heldout.jsonl', '--tag', 'sft', '--threads', s(p.threads)]));
      steps.push(st('grpo', STAGES[10].label, py, [script, 'grpo', '--base', out + '/chat', '--problems', md + '/math_train_plain.jsonl', '--out', out + '/rl', '--steps', s(p.grpoSteps), '--prompts', s(p.grpoPrompts), '--group', s(p.grpoGroup), '--lr', s(p.grpoLr), '--seed', s(p.seed), '--threads', s(p.threads)]));
      steps.push(st('eval_rl', STAGES[9].label + '（強化學習後）', py, [script, 'eval-math', '--model', out + '/rl', '--data', md + '/math_heldout.jsonl', '--tag', 'rl', '--threads', s(p.threads)]));
      final = out + '/rl';
    } else {
      var sft = [script, 'sft', '--base', out + '/base', '--out', out + '/chat', '--steps', s(p.sftSteps), '--batch', s(p.sftBatch), '--lr', s(p.sftLr), '--seed', s(p.seed)];
      if (p.sftData) sft.push('--data', s(p.sftData));
      steps.push(st('sft', STAGES[3].label, py, sft, { check: [{ op: 'lt', a: 'heldout_loss_after', b: 'heldout_loss_before' }] }));
    }
    var native = nativeCompatible(p);
    if (native) steps.push(st('export', STAGES[4].label, py, [script, 'export', '--model', final, '--out', out + '/export'], { check: [{ op: 'true', key: 'fp32_greedy_matches_torch' }] }));
    steps.push(st('hf', STAGES[5].label, py, [script, 'export-hf', '--model', final, '--out', out + '/export/hf'], { check: [{ op: 'true', key: 'transformers_loads' }, { op: 'true', key: 'greedy_identical' }] }));
    if (native) steps.push(st('check', STAGES[6].label, py, [script, 'check', '--model-dir', out + '/export'], { check: SPEC.checks }));
    if (native && env.nativeRuntimeDir) {
      steps.push(st('native', STAGES[7].label, env.nodeExec || process.execPath, [sd + '/llm_scratch_core.js', 'native-check', '--runtime', env.nativeRuntimeDir, '--model-dir', out + '/export', '--question', s(p.nativeQuestion || (p.arch === 'reasoning' ? '計算 37+48 等於多少？' : '臺灣的首都是哪裡？'))], { env: { ELECTRON_RUN_AS_NODE: '1' }, check: [{ op: 'true', key: 'native_loaded' }, { op: 'gt0', key: 'n_tokens' }, { op: 'true', key: 'native_reload_identical' }] }));
    }
    return { ok: true, errors: [], steps: steps, nativeCompatible: native };
  }

  // 估時間（分鐘）：預訓練的 token 數 × 每千 token 秒數；指令微調依步數；推理另加算術微調與強化學習；另加匯出與核對約 3 分鐘
  function estimate(p) {
    var spk = (SEC_PER_KTOK[p.preset] || SEC_PER_KTOK.mini) * (p.arch === 'moe' ? MOE_FACTOR : 1);
    var pre = p.steps * p.batch * p.seq / 1000 * spk / 60, sfp = SFT_SEC_PER_STEP[p.preset] || SFT_SEC_PER_STEP.mini, grpo = 0, sft;
    if (p.arch === 'reasoning') {
      sft = p.mathSteps * (p.sftBatch / 4) * sfp / 60;
      grpo = (p.grpoSteps || 0) * GRPO_SEC_PER_STEP * ((p.grpoPrompts || 8) * (p.grpoGroup || 8) / 64) / 60;
    } else sft = p.sftSteps * (p.sftBatch / 4) * sfp / 60;
    return { pretrainMin: Math.round(pre), sftMin: Math.max(1, Math.round(sft)), grpoMin: Math.round(grpo), exportMin: 3, totalMin: Math.round(pre + sft + grpo + 3), params: Math.round(paramCount(p.preset, p.vocab)) };
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

  return { SHAPE: SHAPE, PRESETS: PRESETS, ARCHS: ARCHS, nativeCompatible: nativeCompatible, SEC_PER_KTOK: SEC_PER_KTOK, SFT_SEC_PER_STEP: SFT_SEC_PER_STEP, GRPO_SEC_PER_STEP: GRPO_SEC_PER_STEP, MOE_FACTOR: MOE_FACTOR, STAGES: STAGES, SPEC: SPEC, paramCount: paramCount, planSteps: planSteps, estimate: estimate, nativeCheck: nativeCheck };
});

if (typeof require === 'function' && require.main === module) {
  var C = module.exports, args = process.argv.slice(2), cmd = args.shift(), o = {};
  for (var i = 0; i < args.length; i += 2) o[args[i].replace(/^--/, '')] = args[i + 1];
  if (cmd === 'native-check') {
    C.nativeCheck({ runtime: o.runtime, modelDir: o['model-dir'], question: o.question || '臺灣的首都是哪裡？', maxTokens: Number(o['max-tokens']) || 48 })
      .then(function (r) { console.log(JSON.stringify(r)); }, function (e) { console.log(JSON.stringify({ event: 'native_check', native_loaded: false, native_answered: false, error: String((e && e.message) || e) })); process.exit(2); });
  } else { console.error('用法：node llm_scratch_core.js native-check --runtime <執行包資料夾> --model-dir <export 資料夾> [--question 文字]'); process.exit(1); }
}
