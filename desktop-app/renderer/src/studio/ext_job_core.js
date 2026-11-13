/* 外部訓練作業（ext job）的純函式核心（UMD，node 可測）。
 * 六種型別的訓練核心都是命令列腳本：music_train.py、sr_train.py、speech_train.py、a2n_train.py、vlm/train_vlm_lora.py、image_sdxs_lora.py。
 * 這裡負責，與程序本身無關：
 *   1) SPECS：每個型別的腳本、需要的 Python 模組、路徑欄位（資料夾或檔案，要有哪些檔）、參數範圍與預設、輸出檔、判定規則。
 *   2) checkPaths／planFor：檢查路徑與參數，組出「步驟清單」（每步 cmd／args／cwd，以及核對規則）。
 *   3) runJob：依序執行步驟（注入 spawn、readJson，測試用假的）；串流進度；可停止；結束後核對輸出檔與規則。
 * 判定規則（check）是陣列：{op:'eq',a,b}（相等）、{op:'true',key}、{op:'gt0',key}、{op:'lt',a,b}；可指定 checkFile 讀 JSON 檔（而不是 stdout 的最後一行）。
 * wired＝true 的型別才會被工作室接成可按開始；其餘保持 wired:false 並寫明原因。
 * 測試：renderer/src/studio/ext_job_core.test.js */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else (root.FaExtJob = factory()); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function num(v, d) { var n = Number(v); return Number.isFinite(n) ? n : d; }
  function clampCheck(p, name, lo, hi, errors) { var v = Number(p[name]); if (!Number.isFinite(v) || v < lo || v > hi) errors.push(name + ' 必須在 ' + lo + ' 到 ' + hi + ' 之間（目前 ' + p[name] + '）'); }

  // 進度行：JSON（有 step 與 loss，或 loss_mean_recent）→ step 事件；「step N pair P loss X」（SDXS）→ step 事件；其他非空白行當作一般紀錄（截到 300 字）
  function parseLine(line) {
    var s = String(line || '').trim(); if (!s) return null;
    if (s.charAt(0) === '{') {
      try {
        var o = JSON.parse(s);
        if (o && typeof o === 'object') {
          var lv = o.loss !== undefined ? o.loss : o.loss_mean_recent;
          if (o.step !== undefined && lv !== undefined) return { type: 'step', step: Number(o.step), loss: Number(lv) };
          return { type: 'json', data: o };
        }
      } catch (e) { /* 不是 JSON：當文字 */ }
    }
    var m = /^step (\d+) pair \d+ loss ([-\d.eE+]+)/.exec(s);
    if (m) return { type: 'step', step: Number(m[1]) + 1, loss: Number(m[2]) };
    return { type: 'log', text: s.slice(0, 300) };
  }

  // 失敗原因翻譯（stderr 尾端）。只認常見的、能直接指引使用者的錯誤；認不得回 null
  function explainCommon(stderr) {
    var s = String(stderr || '');
    var m = /ModuleNotFoundError: No module named '([^']+)'/.exec(s);
    if (m) return '缺少 Python 套件「' + m[1] + '」。請在訓練環境安裝它後再試。';
    if (/Could not import module 'BloomPreTrainedModel'|torchvision::nms does not exist/.test(s)) return 'Python 環境的 transformers 與 torchvision 版本不合（import 失敗）。請重建訓練環境。';
    if (/CUDA out of memory|OutOfMemoryError|std::bad_alloc|MemoryError/.test(s)) return '記憶體不足。請把批次（batch）或解析度調小後再試。';
    if (/FileNotFoundError|No such file or directory/.test(s)) { var f = /No such file or directory: '([^']+)'/.exec(s); return '找不到檔案或資料夾' + (f ? '（' + f[1] + '）' : '') + '。請確認路徑。'; }
    return null;
  }

  // 語音辨識資料：每行一筆 JSON，要有 audio（相對路徑）、text（參考文字）、split（train 或 eval）。lines 是前幾行（字串陣列）
  function srJsonlError(lines) {
    if (!lines || !lines.length) return '檔案是空的';
    for (var i = 0; i < lines.length; i++) {
      var r; try { r = JSON.parse(lines[i]); } catch (e) { return '第 ' + (i + 1) + ' 行不是合法的 JSON'; }
      if (typeof r.audio !== 'string' || typeof r.text !== 'string') return '第 ' + (i + 1) + ' 行缺 audio（錄音相對路徑）或 text（參考文字）';
      if (r.split !== 'train' && r.split !== 'eval') return '第 ' + (i + 1) + ' 行的 split 必須是 train 或 eval';
    }
    return '';
  }

  var SPECS = {
    music: {
      id: 'music', name: '音樂作曲', wired: true, script: 'music_train.py', python: ['torch'], needsNode: true,
      summary: '從零開始的小型作曲模型（約 46 萬參數），用程式作曲的旋律訓練。不是預訓練模型的微調。',
      paths: [],
      limits: { perStyle: [9, 500], heldout: [1, 50], seedStart: [0, 1e9], steps: [10, 20000], batch: [1, 64], lr: [1e-5, 0.1], seed: [0, 1e9], sampleSeed: [0, 1e9] },
      defaults: { perStyle: 90, heldout: 10, seedStart: 1, steps: 1500, batch: 16, lr: 0.001, seed: 0, sampleSeed: 123 },
      estimate: '處理器（CPU）約 1 分鐘（1500 步，實測 55 秒）。',
      outputs: ['model.pt', 'config.json', 'vocab.json', 'train_meta.json', 'samples_after.jsonl', 'log.jsonl'],
      checks: [{ op: 'eq', a: 'reloaded_songs_identical_to_training_run', b: 'of' }],
      explain: explainCommon,
      limitsNote: '只在程式作曲的資料上驗證（留出 90 首：損失 4.756→1.150；語法合格 2/36→27/36）。沒有和真實作曲比較過音樂品質。'
    },
    speech_recognition: {
      id: 'speech_recognition', name: '語音辨識', wired: true, script: 'sr_train.py', python: ['torch', 'transformers', 'peft'], needsNode: false,
      summary: '把錄音聽寫成文字。小型語音辨識基底（39M 參數）只在 q／v 投影掛 LoRA。',
      paths: [
        { key: 'base', kind: 'dir', label: '基底模型資料夾（小型語音辨識基底）', must: ['config.json'] },
        { key: 'data', kind: 'file', label: '語音資料檔（data.jsonl）', format: 'sr' }
      ],
      limits: { steps: [1, 5000], batch: [1, 32], lr: [1e-5, 0.1], rank: [1, 64], alpha: [1, 256], seed: [0, 1e9] },
      defaults: { steps: 40, batch: 4, lr: 0.001, rank: 8, alpha: 16, seed: 0 },
      estimate: '處理器（CPU）40 步約 30 秒（實測 29 秒）；步數多時大致成比例增加。',
      outputs: ['adapter/adapter_model.safetensors', 'adapter/adapter_config.json', 'log.jsonl', 'train_meta.json'],
      checks: [{ op: 'eq', a: 'reloaded_matches_training_run', b: 'of' }],
      explain: explainCommon,
      limitsNote: '驗證集的字錯率沒有下降（實測 15.81%→15.81%；120 步反而變差到 17.28%）。損失下降不代表辨識變好。'
    },
    speech: {
      id: 'speech', name: '語音合成', wired: true, script: 'speech/speech_train.py', python: ['torch', 'kokoro', 'soundfile'], needsNode: false,
      summary: '把文字念成聲音。只訓練基底語音包的風格偏移（256 維），其餘權重凍結；結果是一個與語音包同格式的 .bin。',
      paths: [
        { key: 'model', kind: 'dir', label: 'Kokoro-82M 模型資料夾（config.json、kokoro-v1_0.pth）', must: ['config.json', 'kokoro-v1_0.pth'] },
        { key: 'voice', kind: 'file', label: '基底語音包（.pt 或 .bin）' },
        { key: 'data', kind: 'dir', label: '配對資料夾（train.jsonl、heldout.jsonl 與錄音）', must: ['train.jsonl', 'heldout.jsonl'] }
      ],
      limits: { steps: [1, 2000], lr: [1e-5, 0.1], seed: [0, 1e9], evalEvery: [1, 2000] },
      defaults: { steps: 30, lr: 0.005, seed: 0, evalEvery: 10 },
      estimate: '處理器（CPU）約 2 秒／步（實測 30 步 51 秒；以你的電腦為準）。',
      outputs: ['voice_trained.bin', 'summary.json', 'log.jsonl', 'delta.pt', 'check.wav'],
      checks: [{ op: 'gt0', key: 'samples' }],
      explain: explainCommon,
      limitsNote: '只訓練語音包的風格偏移，不是整個模型的微調。留出句的損失會降（實測 30 步：2.103→1.308），但沒有主觀聆聽評分；訓練資料是基底模型自己合成的教師音訊。'
    },
    audio_to_notes: {
      id: 'audio_to_notes', name: '音訊轉音符', wired: true, script: 'a2n_train.py', python: ['torch', 'onnxruntime'], needsNode: true,
      summary: '把錄音轉成音符。以 Basic Pitch 的轉譜模型（nmp.onnx）為底，全參數微調（凍結 CQT 前端），匯出 ONNX。',
      paths: [{ key: 'base', kind: 'file', label: '基底轉譜模型（nmp.onnx）' }],
      limits: { trainCount: [8, 5000], evalCount: [4, 2000], seedTrain: [0, 1e9], seedEval: [0, 1e9], steps: [1, 20000], batch: [1, 32], lr: [1e-6, 0.1], seed: [0, 1e9] },
      defaults: { trainCount: 200, evalCount: 40, seedTrain: 1, seedEval: 2, steps: 300, batch: 4, lr: 0.0001, seed: 0 },
      estimate: '處理器（CPU）300 步約 25 秒（實測 24 秒；以你的電腦為準）。',
      outputs: ['model.onnx', 'log.jsonl'],
      checks: [{ op: 'true', key: 'ort_loads' }],
      explain: explainCommon,
      limitsNote: '只用合成資料（已知音符的鋼琴式音色）訓練與驗證。實測（訓練腳本的音符幀 F1，留出 40 段合成資料）：0.927→0.957；先前紀錄的應用程式解碼器（100 段）：0.735→0.941。沒有真實錄音的驗證；應用程式仍用原版模型，這個新模型還沒有接進轉譜流程。'
    },
    vision: {
      id: 'vision', name: '看圖說文字', wired: true, script: 'vlm/train_vlm_lora.py', python: ['torch', 'transformers', 'peft', 'PIL'], needsNode: false,
      summary: '看圖回答或描述圖片。以小型看圖模型（SmolVLM 格式）為底，只掛 LoRA 小檔。資料由程式合成（顏色與形狀的圖）。',
      paths: [{ key: 'base', kind: 'dir', label: '基底看圖模型資料夾（SmolVLM 格式）', must: ['config.json'] }],
      limits: { steps: [1, 5000], accum: [1, 64], lr: [1e-6, 0.1], r: [1, 64], alpha: [1, 256], seed: [0, 1e9] },
      defaults: { steps: 300, accum: 4, lr: 0.0002, r: 8, alpha: 16, seed: 1234 },
      estimate: '處理器（CPU）約 1 秒／步（實測 300 步 264 秒；以你的電腦為準）。',
      outputs: ['adapter/adapter_model.safetensors', 'adapter/adapter_config.json', 'train_result.json', 'eval.json'],
      checks: [{ op: 'gt0', key: 'n' }],
      explain: explainCommon,
      limitsNote: '只用合成的顏色與形狀圖訓練與評量（留出的顏色與形狀組合不進訓練）。評量只看顏色與形狀是否說對，沒有人工評量。'
    },
    image: {
      id: 'image', name: '圖像生成', wired: true, script: 'image_sdxs_lora.py', python: ['torch', 'diffusers', 'safetensors', 'PIL'], needsNode: false,
      summary: '在 SDXS 快速模型上訓練 LoRA 小檔（只掛在注意力層）。資料由程式合成的圖文配對。',
      paths: [{ key: 'base', kind: 'dir', label: 'SDXS 基底模型資料夾（unet、vae、text_encoder、tokenizer）', must: ['model_index.json', 'unet', 'vae', 'text_encoder', 'tokenizer'] }],
      limits: { steps: [1, 2000], rank: [1, 64], alpha: [1, 256], lr: [1e-6, 0.1], seed: [0, 1e9] },
      defaults: { steps: 40, rank: 8, alpha: 8, lr: 0.0005, seed: 1234, prompt: 'a red circle on a white background' },
      estimate: '處理器（CPU）約 1 秒／步（512 解析度，實測 40 步訓練 35 秒）；核對生圖另加約 10 秒。',
      outputs: ['lora.safetensors', 'lora.train.json', 'verify_verify.json', 'verify_before.png', 'verify_after.png'],
      checkFile: 'verify_verify.json',
      checks: [{ op: 'true', key: 'repeat_identical_before' }, { op: 'true', key: 'fresh_process_identical_to_in_process' }],
      explain: explainCommon,
      limitsNote: '只用合成的圖文配對訓練，輸出只有 LoRA（沒有完整模型）。LoRA 還沒有接進網頁或桌面的 ONNX 生圖執行環境（未驗證）。'
    }
  };

  // 外部登錄的型別（自帶步驟規劃）：registerSpec(spec, planSteps(params, env) → { ok, errors[], steps[] })
  var PLANNERS = {};
  function registerSpec(spec, planSteps) { SPECS[spec.id] = spec; if (planSteps) PLANNERS[spec.id] = planSteps; return spec; }

  function specOf(type) { return SPECS[type] || null; }

  // 參數檢查：回傳 { ok, errors[], params }（params 已補上預設值）
  function normalizeParams(type, raw) {
    var s = specOf(type); if (!s) return { ok: false, errors: ['不認得的型別：' + type], params: {} };
    var p = Object.assign({}, s.defaults, raw || {}), errors = [];
    Object.keys(s.limits || {}).forEach(function (k) {
      if (p[k] === undefined) return;
      if (!Number.isFinite(Number(p[k])) || p[k] === '' || p[k] === null || typeof p[k] === 'boolean') { errors.push(k + ' 必須是數字（目前 ' + JSON.stringify(p[k]) + '）'); return; }
      p[k] = Number(p[k]); clampCheck(p, k, s.limits[k][0], s.limits[k][1], errors);
    });
    return { ok: errors.length === 0, errors: errors, params: p };
  }

  // 路徑檢查（fsx：{ exists(p), isDir(p), readLines(p, n) }，由主行程注入；測試用假的）
  function checkPaths(type, paths, fsx) {
    var s = specOf(type), errors = []; paths = paths || {};
    if (!s) return ['不認得的型別：' + type];
    (s.paths || []).forEach(function (spec) {
      var v = paths[spec.key];
      if (!v) { errors.push('缺' + spec.label); return; }
      if (spec.kind === 'dir') {
        if (!fsx.isDir(v)) { errors.push(spec.label + '不存在或不是資料夾：' + v); return; }
        (spec.must || []).forEach(function (m) { if (!fsx.exists(v + '/' + m)) errors.push(spec.label + '裡缺 ' + m); });
      } else if (!fsx.exists(v)) { errors.push(spec.label + '不存在：' + v); return; }
      if (spec.format === 'sr' && fsx.exists(v)) { var e = srJsonlError(fsx.readLines(v, 50)); if (e) errors.push('語音資料格式不對：' + e); }
    });
    return errors;
  }

  // 組步驟。env：{ python, nodeExec（預設 process.execPath）, scriptsDir（腳本所在資料夾）, outDir, paths: {…} }
  // 回傳 { ok, errors[], steps[{id,label,cmd,args,cwd,env?,check?,checkFile?}], outputs[], spec, params, outDir }。路徑存在與否由呼叫端（checkPaths）檢查。
  function planFor(type, raw, env) {
    var s = specOf(type); env = env || {};
    var fail = function (msg) { return { ok: false, errors: [msg], steps: [], outputs: [] }; };
    if (!s) return fail('不認得的型別：' + type);
    if (!s.wired) return fail(s.name + '：' + (s.reason || '還沒接線'));
    var n = normalizeParams(type, raw); if (!n.ok) return { ok: false, errors: n.errors, steps: [], outputs: [] };
    var p = n.params, out = env.outDir, sd = env.scriptsDir, py = env.python, paths = env.paths || {}, steps = [];
    if (!out) return fail('缺輸出資料夾');
    if (!py) return fail('找不到訓練用的 Python（請在工作室的「運算後端」設定，或指定訓練環境的 Python 路徑）');
    var script = sd + '/' + s.script, node = env.nodeExec || process.execPath, nodeEnv = { ELECTRON_RUN_AS_NODE: '1' };
    var st = function (id, label, cmd, args, extra) { var o = { id: id, label: label, cmd: cmd, args: args, cwd: sd }; return Object.assign(o, extra || {}); };
    if (type === 'music') {
      var corpus = out + '/corpus';
      steps.push(st('gen', '產生作曲資料', node, [sd + '/music_train_core.js', 'gen', corpus, String(p.perStyle), String(p.seedStart), String(p.heldout)], { env: nodeEnv }));
      steps.push(st('train', '訓練作曲模型', py, [script, 'train', '--corpus', corpus, '--out', out, '--steps', String(p.steps), '--batch', String(p.batch), '--lr', String(p.lr), '--seed', String(p.seed), '--sample_seed', String(p.sampleSeed)]));
      steps.push(st('check', '從磁碟重新載入並核對', py, [script, 'check', '--out', out, '--corpus', corpus, '--sample_seed', String(p.sampleSeed)], { check: s.checks }));
    } else if (type === 'speech_recognition') {
      if (!paths.base) return fail('缺基底模型資料夾（小型語音辨識基底）');
      if (!paths.data) return fail('缺語音資料檔（data.jsonl）');
      steps.push(st('train', '訓練語音辨識 LoRA', py, [script, 'train', '--base', paths.base, '--data', paths.data, '--out', out, '--steps', String(p.steps), '--batch', String(p.batch), '--lr', String(p.lr), '--rank', String(p.rank), '--alpha', String(p.alpha), '--seed', String(p.seed)]));
      steps.push(st('check', '從磁碟重新載入並核對', py, [script, 'check', '--base', paths.base, '--adapter', out + '/adapter', '--data', paths.data, '--hyp', out + '/hyp_after.json'], { check: s.checks }));
    } else if (type === 'speech') {
      if (!paths.model || !paths.voice || !paths.data) return fail('缺 Kokoro 模型資料夾、基底語音包或配對資料夾');
      var cfgArgs = ['--config', paths.model + '/config.json', '--weights', paths.model + '/kokoro-v1_0.pth'];
      steps.push(st('train', '訓練風格偏移（語音包）', py, [script].concat(cfgArgs, ['train', '--data', paths.data, '--base-voice', paths.voice, '--out', out, '--steps', String(p.steps), '--lr', String(p.lr), '--seed', String(p.seed), '--eval-every', String(p.evalEvery)])));
      steps.push(st('check', '合成一句，核對可以載入', py, [script].concat(cfgArgs, ['synth', '--voice', out + '/voice_trained.bin', '--text', 'This is a loading check.', '--out', out + '/check.wav']), { check: s.checks }));
    } else if (type === 'audio_to_notes') {
      if (!paths.base) return fail('缺基底轉譜模型（nmp.onnx）');
      var tr = out + '/train_data', ev = out + '/eval_data';
      steps.push(st('gen_train', '產生訓練用合成資料', node, [sd + '/a2n_train_core.js', 'gen', tr, String(p.trainCount), String(p.seedTrain)], { env: nodeEnv }));
      steps.push(st('gen_eval', '產生留出用合成資料', node, [sd + '/a2n_train_core.js', 'gen', ev, String(p.evalCount), String(p.seedEval)], { env: nodeEnv }));
      steps.push(st('train', '微調轉譜模型', py, [script, 'train', '--onnx', paths.base, '--train', tr, '--eval', ev, '--out', out, '--steps', String(p.steps), '--batch', String(p.batch), '--lr', String(p.lr), '--seed', String(p.seed)]));
      steps.push(st('check', '用 ONNX 執行器重新載入核對', py, [script, 'check', '--onnx', out + '/model.onnx', '--base', paths.base, '--eval', ev, '--out', out], { check: s.checks }));
    } else if (type === 'vision') {
      if (!paths.base) return fail('缺基底看圖模型資料夾');
      var vdata = out + '/data';
      steps.push(st('train', '訓練看圖 LoRA（含合成資料）', py, [script, '--model', paths.base, '--data', vdata, '--out', out, '--steps', String(p.steps), '--accum', String(p.accum), '--lr', String(p.lr), '--r', String(p.r), '--alpha', String(p.alpha), '--seed', String(p.seed)]));
      steps.push(st('check', '載入 LoRA 重跑留出題', py, [sd + '/vlm/eval_vlm.py', '--model', paths.base, '--data', vdata, '--out', out + '/eval.json', '--adapter', out + '/adapter', '--max-new', '24'], { check: s.checks }));
    } else if (type === 'image') {
      if (!paths.base) return fail('缺 SDXS 基底模型資料夾');
      var idata = out + '/data', lora = out + '/lora.safetensors';
      steps.push(st('data', '產生合成圖文配對', py, [script, 'make-data', '--out', idata]));
      steps.push(st('train', '訓練圖像 LoRA', py, [script, 'train', '--model', paths.base, '--data', idata, '--out', lora, '--steps', String(p.steps), '--rank', String(p.rank), '--alpha', String(p.alpha), '--lr', String(p.lr), '--seed', String(p.seed), '--resolution', '512']));
      steps.push(st('check', '同一提示同一種子重生，核對載入', py, [script, 'verify', '--model', paths.base, '--lora', lora, '--prompt', String(p.prompt), '--seed', String(p.seed), '--out-prefix', out + '/verify'], { checkFile: s.checkFile, check: s.checks }));
    } else if (PLANNERS[type]) {
      var ext = PLANNERS[type](p, env);
      if (!ext.ok) return { ok: false, errors: ext.errors, steps: [], outputs: [] };
      steps = ext.steps;
    } else {
      return fail(s.name + '：這個型別的步驟還沒有寫');
    }
    return { ok: true, errors: [], steps: steps, outputs: s.outputs.slice(), spec: s, params: p, outDir: out };
  }

  // 執行一組步驟。opts：{ spawn(cmd,args,{cwd,env}) → 子行程（需 stdout/stderr 的 on('data')、on('close')/on('error')）；
  //   kill(child)；exists(path)；readJson(path) → 物件（checkFile 用）；join(a,b)；onEvent(ev)；onStep(state) }
  // 回傳 job：{ state: running|finished|failed|stopped, steps[], events[], step, loss, message, stop(), done: Promise<job> }
  function runJob(plan, opts) {
    opts = opts || {};
    var spec = plan.spec, job = { state: 'running', message: '', steps: plan.steps.map(function (s) { return { id: s.id, label: s.label, state: 'pending' }; }), events: [], step: 0, loss: null, stderrTail: '', child: null, stopReq: false, outDir: plan.outDir, outputs: [] };
    var resolveDone; job.done = new Promise(function (r) { resolveDone = r; });
    function pushEv(ev) { job.events.push(ev); if (job.events.length > 400) job.events.shift(); if (ev.type === 'step') { job.step = ev.step; job.loss = ev.loss; } if (opts.onEvent) { try { opts.onEvent(ev); } catch (e) { /* 紀錄回呼不影響訓練 */ } } }
    function finish(state, msg) {
      if (job.state !== 'running') return;
      job.state = state; job.message = msg || job.message; job.child = null;
      if (state === 'finished') {
        var miss = plan.outputs.filter(function (f) { return !opts.exists || !opts.exists(opts.join(plan.outDir, f)); });
        if (miss.length) { job.state = 'failed'; job.message = '步驟都跑完了，但輸出檔沒有產生：' + miss.join('、'); } else job.outputs = plan.outputs.slice();
      }
      resolveDone(job);
    }
    function runStep(i) {
      if (job.stopReq) return finish('stopped', '使用者停止');
      if (i >= plan.steps.length) return finish('finished', '');
      var st = plan.steps[i]; job.steps[i].state = 'running'; if (opts.onStep) opts.onStep({ index: i, id: st.id, state: 'running' });
      var stdoutBuf = '', stderr = '', lastObj = null, ch;
      try { ch = opts.spawn(st.cmd, st.args, { cwd: st.cwd, env: st.env }); } catch (e) { job.steps[i].state = 'failed'; return finish('failed', '步驟「' + st.label + '」無法啟動：' + String((e && e.message) || e)); }
      job.child = ch;
      function eat(line) {
        var ev = parseLine(line); if (!ev) return;
        if (ev.type === 'json') lastObj = ev.data;
        if (ev.type === 'json' || ev.type === 'step' || ev.type === 'log') pushEv(Object.assign({ stepId: st.id }, ev));
      }
      ch.stdout.on('data', function (b) { stdoutBuf += String(b); var parts = stdoutBuf.split(/\r?\n/); stdoutBuf = parts.pop(); parts.forEach(eat); });
      ch.stderr.on('data', function (b) { stderr = (stderr + String(b)).slice(-8000); });
      ch.on('error', function (e) { job.stderrTail = stderr.slice(-2000); job.steps[i].state = 'failed'; finish('failed', '步驟「' + st.label + '」執行失敗：' + String((e && e.message) || e)); });
      ch.on('close', function (code) {
        job.child = null; if (stdoutBuf) eat(stdoutBuf); stdoutBuf = '';
        if (job.stopReq) { job.steps[i].state = 'stopped'; return finish('stopped', '使用者停止（停在「' + st.label + '」）'); }
        if (code !== 0) { job.stderrTail = stderr.slice(-2000); job.steps[i].state = 'failed'; var why = (spec && spec.explain && spec.explain(stderr)) || ('代碼 ' + code); return finish('failed', '步驟「' + st.label + '」失敗：' + why); }
        if (st.check) {
          var obj = lastObj;
          if (st.checkFile) { try { obj = opts.readJson(opts.join(plan.outDir, st.checkFile)); } catch (e) { obj = null; } }
          var bad = checkResult(st.check, obj);
          if (bad) { job.steps[i].state = 'failed'; return finish('failed', '步驟「' + st.label + '」核對不過：' + bad); }
        }
        job.steps[i].state = 'done'; if (opts.onStep) opts.onStep({ index: i, id: st.id, state: 'done' });
        runStep(i + 1);
      });
    }
    job.stop = function () { if (job.state !== 'running') return { ok: true, already: true }; job.stopReq = true; if (job.child && opts.kill) { try { opts.kill(job.child); } catch (e) { /* 已結束 */ } } return { ok: true }; };
    if (typeof setImmediate === 'function') setImmediate(function () { runStep(0); }); else setTimeout(function () { runStep(0); }, 0);
    return job;
  }

  // 判定規則：回傳 null 代表全部通過，否則回傳人看得懂的原因
  function checkResult(rules, obj) {
    if (!Array.isArray(rules)) return null;
    if (!obj || typeof obj !== 'object') return '核對步驟沒有輸出可判讀的結果';
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.op === 'eq') {
        if (obj[r.a] === undefined) return '核對結果缺少「' + r.a + '」';
        if (Number(obj[r.a]) !== Number(obj[r.b])) return r.a + '＝' + obj[r.a] + '，應該等於 ' + obj[r.b] + '（從磁碟重新載入的結果與訓練時不同）';
      } else if (r.op === 'true') {
        if (obj[r.key] !== true) return '核對結果的「' + r.key + '」應該是 true（目前 ' + JSON.stringify(obj[r.key]) + '）';
      } else if (r.op === 'gt0') {
        if (!(Number(obj[r.key]) > 0)) return '核對結果的「' + r.key + '」應該大於 0（目前 ' + JSON.stringify(obj[r.key]) + '）';
      } else if (r.op === 'lt') {
        if (obj[r.a] === undefined || obj[r.b] === undefined) return '核對結果缺少「' + r.a + '」或「' + r.b + '」';
        if (!(Number(obj[r.a]) < Number(obj[r.b]))) return r.a + '（' + obj[r.a] + '）應該小於 ' + r.b + '（' + obj[r.b] + '）';
      } else return '不認得的核對規則：' + r.op;
    }
    return null;
  }

  // 工作室用的摘要（不含 child、不含 done）：給 status 輪詢
  function publicJob(job) {
    if (!job) return null;
    return { state: job.state, message: job.message, steps: job.steps.slice(), step: job.step, loss: job.loss, events: job.events.slice(-50), outDir: job.outDir, outputs: job.outputs.slice(), stderrTail: job.state === 'failed' ? job.stderrTail : '' };
  }

  // 建立 LLM（從零開始）：自帶規格與步驟規劃（llm_scratch_core.js）。只在 node 載入；檔案不存在（部分內嵌）才略過，其他錯誤照丟
  if (typeof module === 'object' && module.exports && typeof require === 'function') {
    try { var LS = require('./llm_scratch_core.js'); registerSpec(LS.SPEC, LS.planSteps); } catch (e) { if (!(e && e.code === 'MODULE_NOT_FOUND')) throw e; }
  }

  return { SPECS: SPECS, registerSpec: registerSpec, specOf: specOf, normalizeParams: normalizeParams, checkPaths: checkPaths, planFor: planFor, runJob: runJob, parseLine: parseLine, checkResult: checkResult, publicJob: publicJob, explainCommon: explainCommon, srJsonlError: srJsonlError };
});
