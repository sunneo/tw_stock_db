/* 外部訓練作業（ext job）的純函式核心（UMD，node 可測）。
 * 六種型別的訓練核心都是命令列腳本（music_train.py、sr_train.py、a2n_train.py、image_sdxs_lora.py、vlm/train_vlm_lora.py、speech_train.py）。
 * 這裡負責三件事，與程序本身無關：
 *   1) SPECS：每個型別的參數範圍、預設值、命令列組裝、輸出檔清單、進度行解析、失敗原因翻譯、驗證步驟（check 的 JSON 判定）。
 *   2) planFor(type, params, env)：把使用者參數變成「步驟清單」（每步一個 cmd／args／cwd），並做參數檢查（範圍、必要檔案）。
 *   3) runJob(plan, opts)：依序執行步驟（注入 spawn，測試時用假的）；串流進度；可停止；結束後核對輸出檔；失敗給人看得懂的繁體中文原因。
 * wired＝true 的型別才會被工作室接成可按開始；其餘保持 wired:false 並寫明原因（見 model_types_core.js 的 reason）。
 * 測試：renderer/src/studio/ext_job_core.test.js */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else (root.FaExtJob = factory()); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function num(v, d) { var n = Number(v); return Number.isFinite(n) ? n : d; }
  function ival(p, k, d) { return Math.round(num(p[k], d)); }
  function clampCheck(p, name, lo, hi, errors) { var v = Number(p[name]); if (!Number.isFinite(v) || v < lo || v > hi) errors.push(name + ' 必須在 ' + lo + ' 到 ' + hi + ' 之間（目前 ' + p[name] + '）'); }

  // 進度行：腳本印的 JSON（有 step/loss）轉成 step 事件；其他非空白行當作一般紀錄（截到 300 字）
  function parseLine(line) {
    var s = String(line || '').trim(); if (!s) return null;
    if (s.charAt(0) === '{') {
      try { var o = JSON.parse(s); if (o && typeof o === 'object') { if (o.step !== undefined && o.loss !== undefined) return { type: 'step', step: Number(o.step), loss: Number(o.loss) }; return { type: 'json', data: o }; } } catch (e) { /* 不是 JSON：當文字 */ }
    }
    return { type: 'log', text: s.slice(0, 300) };
  }

  // 失敗原因翻譯（stderr 尾端）。只認常見的、可以直接指引使用者的錯誤；認不得就回 null（由呼叫端給通用說明）
  function explainCommon(stderr) {
    var s = String(stderr || '');
    var m = /ModuleNotFoundError: No module named '([^']+)'/.exec(s);
    if (m) return '缺少 Python 套件「' + m[1] + '」。請在訓練環境安裝它後再試。';
    if (/Could not import module 'BloomPreTrainedModel'|torchvision::nms does not exist/.test(s)) return 'Python 環境的 transformers 與 torchvision 版本不合（import 失敗）。請重建訓練環境。';
    if (/CUDA out of memory|OutOfMemoryError|std::bad_alloc|MemoryError/.test(s)) return '記憶體不足。請把批次（batch）或解析度調小後再試。';
    if (/FileNotFoundError|No such file or directory/.test(s)) return '找不到檔案或資料夾（' + (/No such file or directory: '([^']+)'/.exec(s) || [])[1] + '）。請確認路徑。';
    return null;
  }

  var SPECS = {
    music: {
      id: 'music', name: '音樂作曲', wired: true, script: 'music_train.py', python: ['torch'], needsNode: true,
      summary: '從零開始的小型作曲模型（約 46 萬參數），用程式作曲的旋律訓練。不是預訓練模型的微調。',
      limits: { perStyle: [9, 500], heldout: [1, 50], seedStart: [0, 1e9], steps: [10, 20000], batch: [1, 64], lr: [1e-5, 0.1], seed: [0, 1e9], sampleSeed: [0, 1e9] },
      defaults: { perStyle: 90, heldout: 10, seedStart: 1, steps: 1500, batch: 16, lr: 0.001, seed: 0, sampleSeed: 123 },
      estimate: '處理器（CPU）約 45 秒／1500 步（本機 i5-2320 實測量級；以你的電腦為準）。',
      outputs: ['model.pt', 'config.json', 'vocab.json', 'train_meta.json', 'samples_after.jsonl', 'log.jsonl'],
      checkKeys: { ok: 'reloaded_songs_identical_to_training_run', of: 'of' },
      explain: explainCommon,
      limitsNote: '只在程式作曲的資料上驗證（留出 90 首：損失 4.756→1.150；語法合格 2/36→27/36）。沒有和真實作曲比較過音樂品質。'
    },
    speech_recognition: {
      id: 'speech_recognition', name: '語音辨識', wired: true, script: 'sr_train.py', python: ['torch', 'transformers', 'peft'], needsNode: false,
      summary: '把錄音聽寫成文字。小型語音辨識基底（whisper-tiny）只在 q／v 投影掛 LoRA。',
      limits: { steps: [1, 5000], batch: [1, 32], lr: [1e-5, 0.1], rank: [1, 64], alpha: [1, 256], seed: [0, 1e9] },
      defaults: { steps: 40, batch: 4, lr: 0.001, rank: 8, alpha: 16, seed: 0 },
      estimate: '處理器（CPU）40 步約 30 秒（實測 29 秒）；步數多時大致成比例增加。',
      outputs: ['adapter/adapter_model.safetensors', 'adapter/adapter_config.json', 'log.jsonl', 'train_meta.json'],
      checkKeys: { ok: 'reloaded_matches_training_run', of: 'of' },
      explain: explainCommon,
      limitsNote: '驗證集的字錯率沒有下降（實測 15.81%→15.81%；120 步反而變差到 17.28%）。損失會降，但不代表辨識變好。'
    },
    audio_to_notes: { id: 'audio_to_notes', name: '音訊轉音符', wired: false, script: 'a2n_train.py', python: ['torch', 'onnx2torch'], needsNode: false, reason: '還沒接線：資料準備（合成資料產生器）與 ONNX 載入的主行程路徑未接入工作室，且沒有真實錄音驗證。' },
    image: { id: 'image', name: '圖像生成', wired: false, script: 'image_sdxs_lora.py', python: ['torch', 'diffusers'], needsNode: false, reason: '還沒接線：工作室的圖文配對匯入與產物進資產未做；命令列的訓練核心已實測（見設計文件）。' },
    vision: { id: 'vision', name: '看圖說文字', wired: false, script: 'vlm/train_vlm_lora.py', python: ['torch', 'transformers', 'peft'], needsNode: false, reason: '還沒接線：工作室的看圖資料匯入與產物進資產未做；命令列的訓練核心已實測。' },
    speech: { id: 'speech', name: '語音合成', wired: false, script: 'speech/speech_train.py', python: ['torch'], needsNode: false, reason: '還沒接線：需要基底模型與語音包路徑的 UI 與產物匯出未做。' }
  };

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

  // 組步驟。env：{ python（字串，訓練用 Python）, nodeExec（node 可執行檔，預設 process.execPath）, scriptsDir（腳本所在資料夾）, outDir, paths: {base, data} }
  // 回傳 { ok, errors[], steps[{id,label,cmd,args,cwd,env?,check?}], outputs[], spec }。不做檔案存在檢查（由 planFor 的呼叫端在主行程做）。
  function planFor(type, raw, env) {
    var s = specOf(type); env = env || {};
    if (!s) return { ok: false, errors: ['不認得的型別：' + type], steps: [], outputs: [] };
    if (!s.wired) return { ok: false, errors: [s.name + '：' + (s.reason || '還沒接線')], steps: [], outputs: [] };
    var n = normalizeParams(type, raw); if (!n.ok) return { ok: false, errors: n.errors, steps: [], outputs: [] };
    var p = n.params, out = env.outDir, sd = env.scriptsDir, py = env.python, steps = [], outputs = s.outputs.map(function (f) { return f; });
    if (!out) return { ok: false, errors: ['缺輸出資料夾'], steps: [], outputs: [] };
    if (!py) return { ok: false, errors: ['找不到訓練用的 Python（請先在「運算後端」設定或安裝訓練環境）'], steps: [], outputs: [] };
    var script = sd + '/' + s.script;
    if (type === 'music') {
      var corpus = out + '/corpus';
      steps.push({ id: 'gen', label: '產生作曲資料', cmd: env.nodeExec || process.execPath, args: [sd + '/music_train_core.js', 'gen', corpus, String(p.perStyle), String(p.seedStart), String(p.heldout)], cwd: sd, env: { ELECTRON_RUN_AS_NODE: '1' } });
      steps.push({ id: 'train', label: '訓練作曲模型', cmd: py, args: [script, 'train', '--corpus', corpus, '--out', out, '--steps', String(p.steps), '--batch', String(p.batch), '--lr', String(p.lr), '--seed', String(p.seed), '--sample_seed', String(p.sampleSeed)], cwd: sd });
      steps.push({ id: 'check', label: '從磁碟重新載入並核對', cmd: py, args: [script, 'check', '--out', out, '--corpus', corpus, '--sample_seed', String(p.sampleSeed)], cwd: sd, check: s.checkKeys });
    } else if (type === 'speech_recognition') {
      if (!env.paths || !env.paths.base) return { ok: false, errors: ['缺基底模型資料夾（whisper-tiny）'], steps: [], outputs: [] };
      if (!env.paths.data) return { ok: false, errors: ['缺語音資料檔（data.jsonl）'], steps: [], outputs: [] };
      var adapter = out + '/adapter';
      steps.push({ id: 'train', label: '訓練語音辨識 LoRA', cmd: py, args: [script, 'train', '--base', env.paths.base, '--data', env.paths.data, '--out', out, '--steps', String(p.steps), '--batch', String(p.batch), '--lr', String(p.lr), '--rank', String(p.rank), '--alpha', String(p.alpha), '--seed', String(p.seed)], cwd: sd });
      steps.push({ id: 'check', label: '從磁碟重新載入並核對', cmd: py, args: [script, 'check', '--base', env.paths.base, '--adapter', adapter, '--data', env.paths.data, '--hyp', out + '/hyp_after.json'], cwd: sd, check: s.checkKeys });
    }
    return { ok: true, errors: [], steps: steps, outputs: outputs, spec: s, params: p, outDir: out };
  }

  // 執行一組步驟。opts：{ spawn(cmd,args,{cwd,env}) → 子行程（需有 stdout/stderr 的 on('data') 與 on('close')/on('error')）；
  //   kill(child) 停止子行程；exists(path) → bool（核對輸出）；join(a,b)；onEvent(ev)；onStep(state) }
  // 回傳 job 物件：{ state: running|finished|failed|stopped, steps[], events[], step, loss, message, stop(), done: Promise<job> }
  function runJob(plan, opts) {
    opts = opts || {};
    var spec = plan.spec, job = { state: 'running', message: '', steps: plan.steps.map(function (s) { return { id: s.id, label: s.label, state: 'pending' }; }), events: [], step: 0, loss: null, stderrTail: '', child: null, stopReq: false, outDir: plan.outDir, outputs: [] };
    var resolveDone; job.done = new Promise(function (r) { resolveDone = r; });
    function pushEv(ev) { job.events.push(ev); if (job.events.length > 400) job.events.shift(); if (ev.type === 'step') { job.step = ev.step; job.loss = ev.loss; } if (opts.onEvent) { try { opts.onEvent(ev); } catch (e) { /* 紀錄回呼不影響訓練 */ } } }
    function finish(state, msg) {
      if (job.state !== 'running') return;
      job.state = state; job.message = msg || job.message; job.child = null;
      if (state === 'finished') { var miss = plan.outputs.filter(function (f) { return !opts.exists || !opts.exists(opts.join(plan.outDir, f)); }); if (miss.length) { job.state = 'failed'; job.message = '步驟都跑完了，但輸出檔沒有產生：' + miss.join('、'); } else job.outputs = plan.outputs.slice(); }
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
        if (st.check) { var bad = checkResult(st.check, lastObj); if (bad) { job.steps[i].state = 'failed'; return finish('failed', '步驟「' + st.label + '」核對不過：' + bad); } }
        job.steps[i].state = 'done'; if (opts.onStep) opts.onStep({ index: i, id: st.id, state: 'done' });
        runStep(i + 1);
      });
    }
    job.stop = function () { if (job.state !== 'running') return { ok: true, already: true }; job.stopReq = true; if (job.child && opts.kill) { try { opts.kill(job.child); } catch (e) { /* 已結束 */ } } return { ok: true }; };
    if (typeof setImmediate === 'function') setImmediate(function () { runStep(0); }); else setTimeout(function () { runStep(0); }, 0);
    return job;
  }

  // 核對步驟的 JSON 結果：ok 欄位必須等於 of 欄位（例如 reloaded_songs_identical_to_training_run === of）
  function checkResult(keys, obj) {
    if (!obj || typeof obj !== 'object') return '核對步驟沒有輸出可判讀的結果';
    if (obj[keys.ok] === undefined) return '核對結果缺少「' + keys.ok + '」';
    if (Number(obj[keys.ok]) !== Number(obj[keys.of])) return keys.ok + '＝' + obj[keys.ok] + '，應該等於 ' + obj[keys.of] + '（從磁碟重新載入的結果與訓練時不同）';
    return null;
  }

  // 工作室用的摘要（不含 child、不含 done）：給 status 輪詢
  function publicJob(job) {
    if (!job) return null;
    return { state: job.state, message: job.message, steps: job.steps.slice(), step: job.step, loss: job.loss, events: job.events.slice(-50), outDir: job.outDir, outputs: job.outputs.slice(), stderrTail: job.state === 'failed' ? job.stderrTail : '' };
  }

  return { SPECS: SPECS, specOf: specOf, normalizeParams: normalizeParams, planFor: planFor, runJob: runJob, parseLine: parseLine, checkResult: checkResult, publicJob: publicJob, explainCommon: explainCommon };
});
