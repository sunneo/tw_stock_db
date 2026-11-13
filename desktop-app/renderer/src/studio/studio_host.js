'use strict';
// 離線訓練工作室的「主行程端」（Node，CommonJS）。把後端登錄表、基準測試、自動選擇、cpu-py 訓練子行程包成一組以 op 名稱分派的操作，
// 由 main-ext.js 的原生信箱（studio_* op）呼叫；renderer 把本檔與 studio 其餘核心（backend_*、bench_core、checkpoint_core、studio_config_core）
// 當字串嵌進 floating-assistant.js，執行時寫到 <userData>/studio-host/ 再由主行程載入（不需要重新安裝）。
// 純依賴注入：fs／path／os／child_process／userData 路徑都由呼叫端給，測試時全用假的。長工作（基準、訓練）一律背景執行、用 status 輪詢。
const BackendCore = require('./backend_core.js');
const BC = require('./bench_core.js');
const SC = require('./studio_config_core.js');
const CpuJs = require('./backend_cpu_js.js');
const CpuPy = require('./backend_cpu_py.js');
const Planned = require('./backend_planned.js');
const LlmExport = require('./llm_export_core.js');
const Asset = require('./asset_core.js');
const ExtJob = require('./ext_job_core.js');

// LLM 匯出工具偵測（DESIGN §25）：不再只看 PATH。來源：lora-train/.venv（訓練，有 peft）、lora-train/.venv-export（匯出，有 optimum-cli、onnxruntime、transformers）、
// 與 <userData>/studio-host/llm-export-config.json 的 { llamaBin, llamaSrc, trainPython, exportPython }（llama.cpp 不在任何 venv 裡，只能設定）。
// 工具找不到就 found:false 並寫原因；不執行模型，只跑 import 與檔案存在檢查。

function createStudioHost(d) {
  const fs = d.fs, P = d.path, os = d.os, cp = d.cp;
  const hostDir = d.hostDir, now = d.now || (() => Date.now());
  const cpus = os.cpus() || [], hw = { cpuModel: (cpus[0] && cpus[0].model) || '', cores: cpus.length || 1 };
  const jf = (name) => P.join(hostDir, name);
  const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; } };
  const writeJson = (f, o) => { try { fs.mkdirSync(P.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); return true; } catch (e) { return false; } };

  // ---- Configure 設定 ----
  const loadConfig = () => SC.normalize(readJson(jf('studio-config.json'), {}), hw.cores);
  let config = loadConfig().config;
  // ---- 後端登錄 ----
  // 訓練腳本所在：使用者資料夾 → 注入的 loraDir → 開發目錄／安裝目錄（loraDirs，由主行程給）；都沒有就回第一個（probe 會說找不到）
  const loraDirOf = () => { const a = P.join(hostDir, 'lora-train'), cands = [a, d.loraDir].concat(d.loraDirs || []).filter(Boolean); for (const c of cands) { if (fs.existsSync(P.join(c, 'train_lora.py'))) return c; } return d.loraDir || a; };
  const killTree = d.killTree || ((ch) => { try { if (process.platform === 'win32' && ch.pid) cp.spawn('taskkill', ['/PID', String(ch.pid), '/T', '/F'], { windowsHide: true }); else ch.kill('SIGTERM'); } catch (e) {} });
  const spawnLow = (c, a, o) => {
    const ch = cp.spawn(c, a, Object.assign({}, o, { windowsHide: true }));
    // 以較低優先權執行（Configure 的 lowPriority）：不可用就略過，不影響訓練
    try { if (config.lowPriority && ch && ch.pid && os.setPriority) os.setPriority(ch.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) {}
    return ch;
  };
  const registry = new BackendCore.BackendRegistry();
  // 探測用的非同步執行器（execFile）：探測期間主行程的事件迴圈不被擋住（用 spawnSync 會讓整個主行程卡住數秒）
  const runAsync = (cmd, args, o) => new Promise((res) => {
    try { cp.execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: o && o.timeout }, (err, stdout) => { if (!err) return res({ status: 0, stdout: String(stdout) }); const e = err.killed ? Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) : err; res({ error: e, status: null, stdout: String(stdout || '') }); }); } catch (e) { res({ error: e, status: null }); }
  });
  // Python 探測結果快取（存使用者資料夾；鍵含 python 路徑與修改時間，裝／卸套件後自動失效）
  const detectCache = { get(k) { const m = readJson(jf('cpu-py-detect-cache.json'), {}); return m[k] || null; }, set(k, v) { const m = readJson(jf('cpu-py-detect-cache.json'), {}); m[k] = v; writeJson(jf('cpu-py-detect-cache.json'), m); } };
  const pyDetect = CpuPy.defaultDetect(runAsync, { fs, path: P, cache: detectCache, venvDirs: () => [loraDirOf(), P.join(hostDir, 'lora-train'), d.loraDir].concat(d.loraDirs || []) });
  const cpuPy = CpuPy.createCpuPyBackend({ detect: pyDetect, spawn: spawnLow, killTree, fs, path: P, get loraDir() { return loraDirOf(); }, hw, get config() { return config; }, env: d.env || {} });
  registry.register(CpuJs.createCpuJsBackend({ engineVersion: 'tiny-1' }));
  const rawProbe = cpuPy.probe.bind(cpuPy), PROBE_TTL = 60000, probeSt = { val: null, at: 0, running: null };
  const refreshProbe = () => probeSt.running || (probeSt.running = (async () => { try { probeSt.val = await rawProbe(); probeSt.at = now(); } finally { probeSt.running = null; } })());
  cpuPy.probe = async (ctx) => {
    const fresh = probeSt.val && now() - probeSt.at < (probeSt.val.available ? PROBE_TTL : 5000);   // 不可用的結果只留 5 秒：使用者裝好環境後很快就要看到變化
    if (fresh) return probeSt.val;
    if (ctx && ctx.fast) { refreshProbe().catch(() => {}); return probeSt.val ? Object.assign({}, probeSt.val, { probing: true }) : BackendCore.probeResult(false, '探測中…', { name: hw.cpuModel || 'CPU', vendor: 'cpu', fp16: false }, { backend: 'cpu-py' }); }
    await refreshProbe(); return probeSt.val;
  };
  registry.register(cpuPy);
  ['wasm-web', 'webgpu', 'directml', 'vulkan'].forEach((id) => registry.register(Planned.createPlannedBackend(id, {})));
  const benchCache = BC.createBenchCache({ load: () => readJson(jf('bench-cache.json'), null), save: (o) => writeJson(jf('bench-cache.json'), o) }, now);
  const ctxOf = (p) => ({ hw, modelSha256: (p && p.modelSha256) || null });

  const jobs = new Map(); let seq = 0;
  const newId = (k) => k + (++seq) + '_' + now().toString(36);
  let activeBench = null, activeTrain = null;

  // ---- 基準測試資料（小：16 筆；不下載任何東西）----
  function benchDataFile() {
    const f = jf('bench-train.jsonl'); if (fs.existsSync(f)) return f;
    const rows = []; for (let i = 0; i < BC.BENCH.samples; i++) rows.push(JSON.stringify({ id: 'b' + i, split: 'train', domain: 'bench', messages: [{ role: 'user', content: '基準測試問題 ' + i }], completion: '基準測試回答 ' + i, meta: {} }));
    fs.mkdirSync(P.dirname(f), { recursive: true }); fs.writeFileSync(f, rows.join('\n') + '\n'); return f;
  }
  // 基準測試時間上限：預設 60 秒是給 GPU／頁內後端的；cpu-py 是整段 Python 訓練，慢的處理器（如這台 4 核 i5-2320，每步十幾秒）要 33 步，放寬到 20 分鐘（仍可隨時按停止，3 秒內結束）
  const BENCH_DEADLINE_CPU_PY = 20 * 60 * 1000, benchDeadline = (id) => id === 'cpu-py' ? BENCH_DEADLINE_CPU_PY : undefined;
  const benchCfg = (id, p) => id === 'cpu-py'
    ? { base: (p && p.base) || 'Qwen/Qwen3-0.6B', trainFile: benchDataFile(), accum: 1, outputDir: P.join(hostDir, 'bench-out'), threads: SC.resolveThreads(config, hw.cores, 'benchmark') }
    : { threads: SC.resolveThreads(config, hw.cores, 'benchmark') };

  // ---- LLM 匯出（DESIGN §25）----
  const exportJobs = new Map(); let activeExport = null;
  const llmCfg = () => readJson(jf('llm-export-config.json'), {});
  const venvPy = (dir, name) => P.join(dir, name, process.platform === 'win32' ? P.join('Scripts', 'python.exe') : P.join('bin', 'python'));
  const exists = (f) => { try { return !!f && fs.existsSync(f); } catch (e) { return false; } };
  async function probeLlmTools() {
    const cfg = llmCfg(), dir = loraDirOf(), tools = {}, paths = {};
    const trainPy = cfg.trainPython || (await pyDetect().catch(() => ({}))).path || null;
    const exportPy = cfg.exportPython || (exists(venvPy(dir, '.venv-export')) ? venvPy(dir, '.venv-export') : null);
    paths.trainPy = trainPy; paths.exportPy = exportPy;
    const pyCheck = async (py, code, label, want) => {
        if (!py) return { found: false, reason: '找不到' + label + '的 Python' };
        const r = await runAsync(py, ['-c', code], { timeout: 30000 });
        if (r.error || r.status !== 0) return { found: false, reason: label + '（' + py + '）import 失敗' };
        return { found: true, version: String(r.stdout || '').trim().split(/\r?\n/).pop() || null, path: py };
    };
    tools.peft = await pyCheck(trainPy, 'import peft, transformers; print(peft.__version__)', '訓練環境', 'peft');
    const exOk = await pyCheck(exportPy, 'import onnxruntime, transformers; print(onnxruntime.__version__)', '匯出環境', 'onnxruntime');
    tools.onnxruntime = exOk;
    const oc = exportPy ? P.join(P.dirname(exportPy), process.platform === 'win32' ? 'optimum-cli.exe' : 'optimum-cli') : null;
    tools.optimum = exists(oc) ? { found: true, path: oc, version: null } : { found: false, reason: '匯出環境裡沒有 optimum-cli' };
    const bin = cfg.llamaBin || null, src = cfg.llamaSrc || null;
    const hasLlama = bin && exists(P.join(bin, 'llama-quantize' + (process.platform === 'win32' ? '.exe' : ''))) && exists(P.join(bin, 'llama-server' + (process.platform === 'win32' ? '.exe' : '')));
    const hasConv = src && exists(P.join(src, 'convert_hf_to_gguf.py'));
    tools.llamaCpp = hasLlama && hasConv ? { found: true, path: bin } : { found: false, reason: !bin ? '沒有設定 llama.cpp（llm-export-config.json 的 llamaBin）' : (!hasLlama ? 'llamaBin 裡沒有 llama-quantize／llama-server' : 'llamaSrc 裡沒有 convert_hf_to_gguf.py') };
    paths.llamaBin = bin; paths.llamaSrc = src; paths.lora = dir;
    return { tools, paths };
  }
  // 續跑用：每一步的輸出（續跑前若這一步沒完成，先刪掉它可能殘留的半成品，免得匯出腳本誤判「已存在」）
  const STEP_OUT = {
      onnx: { merge: (w) => [P.join(w, 'merged')], convert: (o) => [P.join(o, 'fp32')], quantize: (o) => [P.join(o, 'q8')], verify: (o) => [P.join(o, 'check.json')], pack: (o) => [P.join(o, 'manifest.json')] },
      gguf: { merge: (w) => [P.join(w, 'merged')], convert: (o) => [P.join(o, 'model-f16.gguf'), P.join(o, 'hf-input')], quantize: (o) => [P.join(o, 'model-q8_0.gguf')], verify: (o) => [P.join(o, 'check_gguf.json')], pack: (o) => [P.join(o, 'manifest_gguf.json')] }
  };
  const rmOut = (f) => { try { fs.rmSync ? fs.rmSync(f, { recursive: true, force: true }) : null; } catch (e) { /* 刪不掉就讓步驟自己報錯 */ } };
  const stateFile = (w) => P.join(w, 'export_state.json');
  // 啟動（新工作或續跑）。續跑＝同一個 workDir，從 export_state.json 讀已完成的步驟，跳過它們
  async function launchLlmJob(format, workDir, p, pr) {
    const outDir = P.join(workDir, format);
    const cmds = LlmExport.buildStepCommands(format, { pyTrain: pr.paths.trainPy, pyExport: pr.paths.exportPy, scriptsDir: pr.paths.lora, baseDir: p.baseDir, adapterDir: p.adapterDir, workDir, outDir, llamaDir: pr.paths.llamaBin, llamaSrc: pr.paths.llamaSrc, recipe: String(p.recipe || 'full') });
    if (!cmds.ok) return { ok: false, error: cmds.error };
    const prev = readJson(stateFile(workDir), null);
    const doneSet = new Set(prev && prev.format === format ? (prev.done || []) : []);
    // 已完成的步驟要確認輸出還在；不在就當沒做過
    for (const id of Array.from(doneSet)) { const outs = (STEP_OUT[format][id] || (() => []))(id === 'merge' ? workDir : outDir); if (!outs.every((f) => exists(f))) doneSet.delete(id); }
    for (const st of cmds.steps) if (!doneSet.has(st.id)) for (const f of (STEP_OUT[format][st.id] || (() => []))(st.id === 'merge' ? workDir : outDir)) rmOut(f);
    const job = { id: newId('llmexp'), format, state: 'running', events: [], result: null, workDir, outDir, startedAt: now(), endedAt: 0, child: null, stopReq: null, done: Array.from(doneSet), baseDir: p.baseDir, adapterDir: p.adapterDir, recipe: String(p.recipe || 'full') };
    exportJobs.set(job.id, job); activeExport = job;
    const runner = (argv) => new Promise((res) => {
        let out = '', err = '', settled = false; const done = (r) => { if (!settled) { settled = true; job.child = null; res(r); } };
        // 匯出用低優先權（訓練也是 nice 19）；Linux 用 nice 前綴，其他系統直接執行
        const useNice = process.platform === 'linux' && exists('/usr/bin/nice');
        const cmd = useNice ? '/usr/bin/nice' : argv[0], args = useNice ? ['-n', '19'].concat(argv) : argv.slice(1);
        let ch; try { ch = cp.spawn(cmd, args, { cwd: pr.paths.lora, windowsHide: true, detached: process.platform !== 'win32' }); } catch (e) { return done({ code: -1, stdout: '', stderr: String((e && e.message) || e) }); }
        job.child = ch;
        ch.stdout.on('data', (b) => { out += String(b); if (out.length > 4e6) out = out.slice(-2e6); });
        ch.stderr.on('data', (b) => { err += String(b); if (err.length > 4e6) err = err.slice(-2e6); });
        ch.on('error', (e) => done({ code: -1, stdout: out, stderr: err + String((e && e.message) || e) }));
        ch.on('close', (code) => done({ code, stdout: out, stderr: err }));
    });
    job.done_promise = LlmExport.runExportSteps(cmds, runner, {
        skip: doneSet,
        isStopRequested: () => !!job.stopReq,
        onEvent: (e) => { job.events.push(e); if (job.events.length > 400) job.events.shift(); if (e.type === 'step-end' && e.state === '完成') { if (job.done.indexOf(e.id) < 0) job.done.push(e.id); writeJson(stateFile(workDir), { format, done: job.done, recipe: job.recipe, baseDir: p.baseDir, adapterDir: p.adapterDir }); } }
    })
        .then((r) => {
            job.result = r; job.endedAt = now();
            job.state = r.ok ? 'finished' : (job.stopReq ? job.stopReq : 'failed');
            writeJson(stateFile(workDir), { format, done: r.done, recipe: job.recipe, baseDir: p.baseDir, adapterDir: p.adapterDir, state: job.state });
            writeJson(P.join(workDir, 'export_job.json'), { format, recipe: job.recipe, state: job.state, ok: r.ok, failedAt: r.failedAt, steps: r.steps, startedAt: job.startedAt, endedAt: job.endedAt, baseDir: p.baseDir, adapterDir: p.adapterDir });
        })
        .catch((e) => { job.state = 'failed'; job.result = { ok: false, failedAt: null, steps: [], error: String((e && e.message) || e) }; job.endedAt = now(); });
    return { ok: true, jobId: job.id, workDir, outDir, format, steps: cmds.steps.map((s) => ({ id: s.id, label: s.label })), skipped: Array.from(doneSet) };
  }
  // 匯出結果打包成資產內容（給工作室登錄成 kind:'llm' 資產）：小檔案放進資產（base64），權重在外部（位置、大小、sha256）
  function llmBundle(p) {
    const j = exportJobs.get(p && p.jobId) || activeExport;
    if (!j) return { ok: false, error: '找不到匯出工作' };
    if (j.state !== 'finished') return { ok: false, error: '匯出尚未完成（目前：' + j.state + '）' };
    const man = readJson(P.join(j.outDir, 'manifest.json'), null) || readJson(P.join(j.outDir, 'manifest_gguf.json'), null);
    if (!man || !Array.isArray(man.files)) return { ok: false, error: '找不到匯出的 manifest（pack 步驟沒有完成？）' };
    // 要進資產的：部署用的權重（ONNX 的 q8 或 GGUF 的 Q8_0）與小檔（分詞器、設定、核對報告）。fp32 的 ONNX（約 3 GB）是中間產物，不進資產。
    const DEPLOY = { onnx: ['q8/model_quantized.onnx'], gguf: ['model-q8_0.gguf'] };
    const want = DEPLOY[man.format] || [];
    const files = [], excluded = [];
    for (const f of man.files) {
      const abs = P.join(j.outDir, f.path);
      if (!exists(abs)) return { ok: false, error: '缺檔：' + f.path };
      const st = fs.statSync(abs);
      if (st.size !== f.bytes) return { ok: false, error: '大小與 manifest 不符：' + f.path };
      if (/\.onnx(_data)?$|\.gguf$/.test(f.path) && want.indexOf(f.path) < 0) { excluded.push(f.path); continue; }
      files.push({ rel: f.path, path: abs, bytes: f.bytes, sha256: f.sha256 });
    }
    return { ok: true, format: man.format, quant: man.format === 'onnx' ? 'q8' : 'q8_0', recipe: man.recipe || j.recipe || null, files, excluded,
      source: { baseDir: j.baseDir || null, adapterDir: j.adapterDir || null }, outDir: j.outDir };
  }
  // 登錄（桌面版，主行程端）：把匯出的部署檔直接從磁碟讀進 <userData>/studio-assets/llm/<名稱>/（與 rawfs 儲存層同一個版面），manifest 最後寫。
  // 不經過渲染程序的 base64 IPC：756 MB 的 q8 在字串上限（約 512 MB）以上，渲染端讀不了（實測的錯誤見 DESIGN §25.13）。
  function llmRegister(p) {
    const b = llmBundle(p);
    if (!b.ok) return b;
    const name = String(p.name || ('llm-' + b.format + '-' + new Date().toISOString().replace(/[:.]/g, '-')));
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return { ok: false, error: '名稱不合法（只能用英數、點、底線、連字號，最長 64 字）：' + name };
    const root = P.join(P.dirname(hostDir), 'studio-assets'), dir = P.join(root, 'llm', name);
    if (exists(P.join(dir, 'manifest.json'))) return { ok: false, error: '「' + name + '」已存在（換一個名稱）' };
    const files = {};
    for (const f of b.files) {
      const u = fs.readFileSync(f.path);
      if (u.length !== f.bytes) return { ok: false, error: '大小與 manifest 不符：' + f.rel };
      files[f.rel] = new Uint8Array(u.buffer, u.byteOffset, u.length);
    }
    const base = (b.source.baseDir || '').split(/[\\/]/).pop() || null, adapter = (b.source.adapterDir || '').split(/[\\/]/).pop() || null;
    const m = Asset.createManifest({ kind: 'llm', name, files, owner: 'user', base, compat: { base, adapter }, counts: {}, eval: null });
    m.llm = { format: b.format, quant: b.quant, recipe: b.recipe, excluded: b.excluded };
    m.counts = { files: Object.keys(files).length, bytes: Object.keys(files).reduce((x, k) => x + files[k].length, 0) };
    const v = Asset.validateManifest(m); if (!v.ok) return { ok: false, error: '資產 manifest 不合法：' + v.errors.join('；') };
    // 先寫檔（暫存名再改名），每個檔寫完讀回雜湊核對
    const written = [];
    try {
      for (const rel of Object.keys(files)) {
        const dst = P.join(dir, rel), tmp = dst + '.tmp-' + process.pid; fs.mkdirSync(P.dirname(dst), { recursive: true });
        fs.writeFileSync(tmp, files[rel]); fs.renameSync(tmp, dst); written.push(dst);
        const back = fs.readFileSync(dst); if (Asset.sha256Hex(new Uint8Array(back.buffer, back.byteOffset, back.length)) !== m.sha256[rel]) throw new Error('寫入後核對失敗：' + rel);
      }
      fs.writeFileSync(P.join(dir, 'manifest.json'), JSON.stringify(m, null, 1)); // manifest 最後寫：沒有它的資料夾視為未完成
    } catch (e) { for (const f of written) { try { fs.unlinkSync(f); } catch (_) { /* */ } } return { ok: false, error: String((e && e.message) || e) }; }
    return { ok: true, kind: 'llm', name, files: Object.keys(files), bytes: m.counts.bytes, excluded: b.excluded, dataMayBeLost: false, warning: '', root: dir };
  }
  // 模型選單（桌面版）：把工作室的 llm 資產設為離線模型。主行程的 main-ext.js 讀 <hostDir>/llm-model-choice.json（沒有就照舊用標準版）
  // 桌面版：資產的權重落在儲存層（rawfs：<userData>/studio-assets/llm/<名稱>/…），模型路徑由名稱決定
  function llmUse(p) {
    const name = String(p.name || ''); if (!/^[^\/\\.][^\/\\]*$/.test(name)) return { ok: false, error: '名稱不合法' };
    const root = P.join(P.dirname(hostDir), 'studio-assets', 'llm', name);
    const modelPath = P.join(root, 'q8', 'model_quantized.onnx'), tokenizerPath = P.join(root, 'tokenizer.json');
    if (!exists(modelPath)) return { ok: false, error: '資產 llm/' + name + ' 裡沒有 q8/model_quantized.onnx（或還沒寫到儲存層）' };
    if (!exists(tokenizerPath)) return { ok: false, error: '資產 llm/' + name + ' 裡沒有 tokenizer.json' };
    writeJson(jf('llm-model-choice.json'), { name, modelPath, tokenizerPath, chosenAt: now() });
    return { ok: true, name, modelPath, tokenizerPath };
  }
  function llmUseClear() { try { fs.unlinkSync(jf('llm-model-choice.json')); } catch (e) { /* 本來就沒有 */ } return { ok: true }; }
  function llmUseCurrent() { const c = readJson(jf('llm-model-choice.json'), null); return { ok: true, choice: c && exists(c.modelPath) ? c : null }; }
  async function startLlmExport(p) {
    const format = String(p.format || '');
    if (!LlmExport.FORMATS.includes(format)) return { ok: false, error: '格式必須是 ' + LlmExport.FORMATS.join(' 或 ') };
    if (activeExport && activeExport.state === 'running') return { ok: false, error: '已有匯出在執行中（' + activeExport.id + '）' };
    const baseDir = String(p.baseDir || ''), adapterDir = String(p.adapterDir || '');
    if (!baseDir || !exists(baseDir)) return { ok: false, error: '基底模型資料夾不存在：' + baseDir };
    if (!adapterDir) return { ok: false, error: '請給 LoRA adapter 資料夾（adapterDir）' };
    const pr = await probeLlmTools();
    const av = LlmExport.exportAvailability(pr.tools)[format];
    if (!av.available) return { ok: false, error: av.reason, tools: pr.tools };
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const workDir = String(p.workDir || P.join(pr.paths.lora, 'out', 'llm-export', stamp));
    if (exists(workDir) && fs.readdirSync(workDir).length) return { ok: false, error: '工作資料夾不是空的（要續跑請用 resume）：' + workDir };
    return launchLlmJob(format, workDir, p, pr);
  }
  // 續跑：同一個工作資料夾（需要它的 export_state.json）；不會重做已完成的步驟
  async function resumeLlmExport(p) {
    if (activeExport && activeExport.state === 'running') return { ok: false, error: '已有匯出在執行中' };
    const prev = exportJobs.get(p && p.jobId) || null;
    const workDir = String((p && p.workDir) || (prev && prev.workDir) || '');
    if (!workDir || !exists(workDir)) return { ok: false, error: '找不到工作資料夾' };
    const st = readJson(stateFile(workDir), null);
    if (!st || !st.format) return { ok: false, error: '工作資料夾沒有 export_state.json，不能續跑' };
    const baseDir = String(p && p.baseDir || st.baseDir || ''), adapterDir = String(p && p.adapterDir || st.adapterDir || '');
    if (!baseDir || !exists(baseDir)) return { ok: false, error: '基底模型資料夾不存在：' + baseDir };
    const pr = await probeLlmTools();
    const av = LlmExport.exportAvailability(pr.tools)[st.format];
    if (!av.available) return { ok: false, error: av.reason, tools: pr.tools };
    return launchLlmJob(st.format, workDir, { baseDir, adapterDir, recipe: String(p && p.recipe || st.recipe || 'full') }, pr);
  }
  // 暫停／取消：要求停止，並結束目前的子行程（整個行程群組）。暫停與取消都保留已完成步驟；差別只在狀態名稱
  function stopLlmExport(p, kind) {
    const j = exportJobs.get(p && p.jobId) || activeExport;
    if (!j || j.state !== 'running') return { ok: false, error: '沒有執行中的匯出' };
    j.stopReq = kind; // 'paused' 或 'cancelled'
    try { if (j.child && j.child.pid) { if (process.platform !== 'win32') process.kill(-j.child.pid, 'SIGTERM'); else j.child.kill('SIGTERM'); } } catch (e) { try { j.child.kill('SIGTERM'); } catch (_) { /* 已結束 */ } }
    return { ok: true, jobId: j.id, state: kind };
  }

  // ---- 外部訓練作業（六種型別的命令列核心；ext_job_core.js）----
  // 輸出放 <userData>/studio-ext/<型別>/<名稱>/；每次只跑一個；同名輸出夾已有內容就拒絕（不覆寫）。
  const extJobsMap = new Map(); let activeExt = null;
  const extRoot = P.join(P.dirname(hostDir), 'studio-ext');
  const extKill = (ch) => { try { if (process.platform !== 'win32' && ch.pid) process.kill(-ch.pid, 'SIGTERM'); else ch.kill('SIGTERM'); } catch (e) { try { ch.kill('SIGTERM'); } catch (_) { /* 已結束 */ } } };
  // 腳本位置：主行程注入的候選資料夾（開發樹的 renderer/src/studio），第一個含該腳本的為準
  const extScriptsDir = (spec) => { for (const dd of (d.extScriptDirs || [])) { if (dd && exists(P.join(dd, spec.script))) return dd; } return null; };
  // 訓練用 Python：參數指定 → llm-export-config.json 的 trainPython → 既有的 cpu-py 探測
  // 訓練用 Python（每個型別可以不同）：參數指定 → llm-export-config.json 的 extPythons[型別] → trainPython → 既有的 cpu-py 探測
  async function extPython(p, type) { if (p && p.python) return String(p.python); const cfg = llmCfg(); const per = cfg.extPythons && cfg.extPythons[type]; if (per) return String(per); if (cfg.trainPython) return cfg.trainPython; const pr = await pyDetect().catch(() => null); return (pr && pr.path) || null; }
  // 路徑：p.paths（新）；舊的 p.base／p.data 也接受
  function extPaths(p) { const out = Object.assign({}, (p && p.paths) || {}); if (p && p.base && !out.base) out.base = p.base; if (p && p.data && !out.data) out.data = p.data; return out; }
  const extFsx = { exists: (f) => exists(f), isDir: (f) => { try { return fs.statSync(f).isDirectory(); } catch (e) { return false; } }, readLines: (f, n) => { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(0, n); } catch (e) { return []; } } };
  // 逐個模組檢查 import（回傳缺的套件與原因；不跑訓練）
  async function extModules(py, mods) {
    const missing = [];
    for (const m of mods) { const r = await runAsync(py, ['-c', 'import ' + m], { timeout: 60000 }); if (r.error || r.status !== 0) missing.push(m); }
    return missing;
  }
  async function extCheck(p) {
    const type = String((p && p.type) || ''), spec = ExtJob.specOf(type);
    if (!spec) return { ok: false, error: '不認得的型別：' + type };
    if (!spec.wired) return { ok: false, wired: false, error: spec.name + '：' + spec.reason };
    const n = ExtJob.normalizeParams(type, (p && p.params) || {});
    const paths = extPaths(p), py = await extPython(p, type), scripts = extScriptsDir(spec);
    const out = { ok: false, wired: true, type, params: n.params, errors: n.errors.slice(), python: py, scriptsDir: scripts, estimate: spec.estimate, limitsNote: spec.limitsNote || '', paths };
    if (!py) out.errors.push('找不到訓練用的 Python（請在「運算後端」設定，或指定這個型別的 Python 路徑）');
    if (!scripts) out.errors.push('找不到訓練腳本 ' + spec.script + '（主行程沒有接上腳本資料夾）');
    out.errors = out.errors.concat(ExtJob.checkPaths(type, paths, extFsx));
    if (py && scripts) { out.missing = await extModules(py, spec.python); if (out.missing.length) out.errors.push('訓練環境缺套件：' + out.missing.join('、')); }
    out.ok = out.errors.length === 0;
    return out;
  }
  async function extStart(p) {
    if (activeExt && activeExt.job.state === 'running') return { ok: false, error: '已有外部訓練在執行（' + activeExt.id + '）' };
    if (activeTrain && activeTrain.state === 'running') return { ok: false, error: '內建訓練進行中，請先等它結束或停止' };
    const type = String((p && p.type) || ''), name = String((p && p.name) || '');
    if (!/^[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9._\-\u4e00-\u9fff]{0,63}$/.test(name)) return { ok: false, error: '名稱不合法（英數、中文、點、底線、連字號，最長 64 字）' };
    const chk = await extCheck(p); if (!chk.ok) return { ok: false, error: (chk.errors || [chk.error || '檢查沒有通過']).join('；'), check: chk };
    const spec = ExtJob.specOf(type), outDir = P.join(extRoot, type, name);
    if (exists(outDir) && fs.readdirSync(outDir).length) return { ok: false, error: '輸出資料夾已有內容（換一個名稱，不覆寫）：' + outDir };
    const plan = ExtJob.planFor(type, p.params || {}, { outDir, scriptsDir: chk.scriptsDir, python: chk.python, nodeExec: process.execPath, paths: chk.paths });
    if (!plan.ok) return { ok: false, error: plan.errors.join('；') };
    fs.mkdirSync(outDir, { recursive: true });
    writeJson(P.join(outDir, 'ext_request.json'), { type, name, params: plan.params, python: chk.python, paths: chk.paths, startedAt: now() });
    const id = newId('ext');
    const job = ExtJob.runJob(plan, {
      spawn: (c, a, o) => cp.spawn(c, a, { cwd: o.cwd, env: Object.assign({}, process.env, o.env || {}), windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }),
      kill: extKill, exists: (f) => exists(f), join: (a, b) => P.join(a, b), readJson: (f) => JSON.parse(fs.readFileSync(f, 'utf8')),
    });
    const rec = { id, type, name, job, startedAt: now(), endedAt: 0, outDir };
    extJobsMap.set(id, rec); activeExt = rec;
    job.done.then((j) => { rec.endedAt = now(); writeJson(P.join(outDir, 'ext_job.json'), Object.assign({ type, name, startedAt: rec.startedAt, endedAt: rec.endedAt }, ExtJob.publicJob(j))); });
    return { ok: true, jobId: id, outDir, steps: plan.steps.map((s) => ({ id: s.id, label: s.label })), estimate: spec.estimate, limitsNote: spec.limitsNote || '' };
  }
  function extStatus(p) {
    const rec = extJobsMap.get(p && p.jobId) || activeExt; if (!rec) return { ok: true, state: 'idle' };
    return Object.assign({ ok: true, jobId: rec.id, type: rec.type, name: rec.name, outDir: rec.outDir, elapsedMs: (rec.endedAt || now()) - rec.startedAt }, ExtJob.publicJob(rec.job));
  }
  function extStop(p) { const rec = extJobsMap.get(p && p.jobId) || activeExt; if (!rec || rec.job.state !== 'running') return { ok: true, already: true }; return rec.job.stop(); }

  const ops = {
    // 狀態：硬體、設定、各後端是否可用與原因
    async studio_probe(p) {
      const kind = (p && p.kind) || 'lora', list = await registry.listFor(kind, Object.assign(ctxOf(p), { fast: true }));   // 畫面用：不等慢的探測
      const sym = BackendCore.isSymbolicKind(kind);
      return { ok: true, kind, symbolic: sym, hw, config, backends: sym ? [{ id: 'cpu-js', available: true, reason: '', note: '只需處理器' }] : list.map((x) => ({ id: x.id, available: x.available, reason: x.reason, probing: x.reason === '探測中…' || !!(x.probe && x.probe.probing), device: x.probe && x.probe.device, planned: !!(registry.get(x.id) || {}).planned })), loraDir: loraDirOf(), threads: SC.resolveThreads(config, hw.cores, 'train') };
    },
    async studio_probe_wait() { try { await (probeSt.running || Promise.resolve()); } catch (e) {} return { ok: true, done: !probeSt.running }; },
    async studio_config_get() { return { ok: true, config, schema: SC.SCHEMA, hw }; },
    async studio_config_set(p) {
      const r = SC.normalize(Object.assign({}, config, (p && p.patch) || {}), hw.cores);
      config = r.config; writeJson(jf('studio-config.json'), config);
      return { ok: true, config, errors: r.errors, warnings: r.warnings };
    },
    // 基準測試：對所有可用後端依序跑，一次一個；回 jobId，用 studio_bench_status 輪詢，studio_bench_stop 中斷
    async studio_bench_start(p) {
      if (activeBench && activeBench.state === 'running') return { ok: false, error: '基準測試正在執行（job ' + activeBench.id + '）' };
      if (activeTrain && activeTrain.state === 'running') return { ok: false, error: '訓練進行中：為了讓電腦保持可用，訓練結束或暫停後才能跑基準測試' };
      const kind = (p && p.kind) || 'lora', ids = registry.supportedFor(kind);
      const job = { id: newId('bench'), kind, state: 'running', rows: [], log: [], startedAt: now(), ac: { aborted: false, listeners: [], addEventListener(t, f) { this.listeners.push(f); }, removeEventListener() {} } };
      job.signal = job.ac; activeBench = job; jobs.set(job.id, job);
      (async () => {
        try {
          for (const id of ids) {
            if (job.ac.aborted) break;
            const b = registry.get(id), pr = await BackendCore.safeProbe(b, ctxOf(p));
            const fp = Object.assign({}, pr.fingerprint, { model_sha256: (p && p.modelSha256) || null, backend: id });
            const row = { id, available: pr.available, reason: pr.reason || '', state: 'pending', fingerprint: fp };
            job.rows.push(row);
            if (!pr.available) { row.state = 'skipped'; continue; }
            row.state = 'running';
            let r; try { r = await b.benchmark(benchCfg(id, p), { signal: job.signal, deadlineMs: (p && p.deadlineMs) || benchDeadline(id) }); } catch (e) { r = { ok: false, error: String(e && e.message || e), reason: String(e && e.message || e) }; }
            if (r && r.aborted) { row.state = 'aborted'; row.reason = '使用者中斷'; break; }
            row.result = { ok: !!r.ok, tokPerSec: r.tokPerSec, peakMemBytes: r.peakMemBytes, stepMsP50: r.stepMsP50, stepMsP95: r.stepMsP95, numericCheck: r.numericCheck, reason: r.reason, elapsedMs: r.elapsedMs };
            row.passed = BC.benchPassed(r); row.state = row.passed ? 'passed' : 'failed'; row.at = now();
            if (r && r.ok) await benchCache.store(id, fp, r);
          }
          job.state = job.ac.aborted ? 'aborted' : 'done';
        } catch (e) { job.state = 'error'; job.error = String(e && e.message || e); }
        job.endedAt = now();
      })();
      return { ok: true, jobId: job.id };
    },
    async studio_bench_status(p) { const j = jobs.get(p && p.jobId) || activeBench; if (!j) return { ok: false, error: '沒有這個基準測試工作' }; return { ok: true, jobId: j.id, state: j.state, rows: j.rows, error: j.error || null, elapsedMs: (j.endedAt || now()) - j.startedAt }; },
    async studio_bench_stop(p) {
      const j = jobs.get(p && p.jobId) || activeBench; if (!j || j.state !== 'running') return { ok: true, already: true };
      j.ac.aborted = true; j.ac.listeners.forEach((f) => { try { f(); } catch (e) {} }); return { ok: true };
    },
    // 自動選擇：只用快取（不跑基準，避免意外吃資源）；沒有快取結果就回 needsRebench
    async studio_select(p) {
      const r = await BC.autoSelect({ kind: (p && p.kind) || 'lora', registry, cache: benchCache, ctx: Object.assign(ctxOf(p), { fast: true }), pin: p && p.pin, skipBench: true });
      return Object.assign({ ok: !!r.chosen }, r);
    },
    // 訓練：目前只有 lora（cpu-py）有真的子行程訓練；符號式五類由主程式端的 sym_train_core 執行（設計 §15.3）
    async studio_train_start(p) {
      p = p || {}; const kind = p.kind || 'lora';
      if (kind !== 'lora') return { ok: false, error: kind + ' 是符號式訓練，由主程式的 studio_server（sym_train_core）執行，不經主行程子行程；這裡只處理 lora' };
      if (p.backend && p.backend !== 'cpu-py') return { ok: false, error: '後端 ' + p.backend + ' 目前只有 cpu-py 能實際訓練' };
      if (activeTrain && (activeTrain.state === 'running' || activeTrain.state === 'pausing')) return { ok: false, error: '已有訓練在執行（' + activeTrain.id + '）' };
      if (activeBench && activeBench.state === 'running') return { ok: false, error: '基準測試進行中，請先等它結束或按停止' };
      const cfg = p.cfg || {};
      // 從資產挑的資料集：伺服器把檔案內容放在 cfg.trainText，這裡寫成輸出資料夾下的 train.jsonl 再當訓練檔（使用者不必自己找路徑）
      if (cfg.trainText && cfg.outputDir) { try { fs.mkdirSync(cfg.outputDir, { recursive: true }); cfg.trainFile = P.join(cfg.outputDir, 'train.jsonl'); fs.writeFileSync(cfg.trainFile, String(cfg.trainText)); delete cfg.trainText; } catch (e) { return { ok: false, error: '寫入訓練資料失敗：' + String(e && e.message || e) }; } }
      if (!cfg.trainFile || !cfg.outputDir) return { ok: false, error: '缺少 trainFile／outputDir' };
      const pr = await BackendCore.safeProbe(cpuPy, ctxOf(p)); if (!pr.available) return { ok: false, error: 'cpu-py 不可用：' + pr.reason };
      const job = { id: newId('train'), kind, state: 'running', events: [], lastStep: 0, lastLoss: null, startedAt: now(), cfg };
      const hooks = { onEvent: (e) => { job.events.push(e); if (job.events.length > 400) job.events.shift(); if (e.step) job.lastStep = e.step; if (e.type === 'log') job.lastLoss = e.loss; } };
      try { job.run = p.resume ? await cpuPy.resumeRun(cfg, hooks) : await cpuPy.startRun(cfg, hooks); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      activeTrain = job; jobs.set(job.id, job);
      job.run.done.then((r) => { job.state = (job.run && job.run.state) || 'finished'; job.result = r && { state: r.state }; job.endedAt = now(); });
      return { ok: true, jobId: job.id };
    },
    // 流程總覽讀真實紀錄（DESIGN §19）：<runDir>/train.log 尾端 2MB；run.pid 對應的子行程 VmRSS（Linux 才有 /proc；其他系統說明未取樣）；主行程 RSS 另附
    async studio_run_info(p) {
      const dir = String((p && p.runDir) || ''); if (!dir) return { ok: false, error: '缺 runDir' };
      let log = null; try { const t = fs.readFileSync(P.join(dir, 'train.log'), 'utf8'); log = t.length > 2000000 ? t.slice(t.length - 2000000) : t; } catch (e) { log = null; }
      let pid = null; try { pid = parseInt(fs.readFileSync(P.join(dir, 'run.pid'), 'utf8'), 10) || null; } catch (e) { pid = null; }
      let rssBytes = null, rssReason = '';
      if (!pid) rssReason = '沒有 run.pid（子行程 pid 未記錄）';
      else if (process.platform === 'win32') {
        try { const r = cp.spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }); const bytes = parseTasklistMemory(r.stdout || ''); if (bytes !== null) rssBytes = bytes; else rssReason = 'tasklist 查不到子行程 ' + pid + '（可能已結束）'; }
        catch (e) { rssReason = 'tasklist 執行失敗：' + String((e && e.message) || e); }
      }
      else if (process.platform !== 'linux') rssReason = '這個系統（' + process.platform + '）還沒有子行程記憶體取樣（尚未實作）';
      else { try { const st = fs.readFileSync('/proc/' + pid + '/status', 'utf8'); const m = /VmRSS:\s+(\d+)\s+kB/.exec(st); if (m) rssBytes = +m[1] * 1024; else rssReason = '/proc 沒有 VmRSS 欄位'; } catch (e) { rssReason = '子行程已結束，或讀不到 /proc/' + pid + '/status'; } }
      let hostRssBytes = null; try { hostRssBytes = process.memoryUsage().rss; } catch (e) { hostRssBytes = null; }
      const events = log ? log.split(/\r?\n/).map((l) => CpuPy.parseProgressLine(l)).filter(Boolean).slice(-5000) : [];
      return { ok: true, runDir: dir, log, events, pid, rssBytes, rssReason: rssBytes === null ? rssReason : '', hostRssBytes };
    },
    // LLM 匯出工具偵測（DESIGN §20.3 第 2 項）：只在 PATH 上找可執行檔；onnxruntime 要查 python 模組，這版還沒做，照實回報
    async studio_export_tools() {
        const pr = await probeLlmTools();
        return { ok: true, tools: LlmExport.probeExportTools((n) => pr.tools[n]), paths: pr.paths, checkedAt: now() };
    },
    // LLM 匯出（DESIGN §25）：背景執行；每一步的 JSON 結果由 llm_export_core.runExportSteps 整理
    async studio_llm_export(p) { return startLlmExport(p || {}); },
    async studio_llm_export_pause(p) { return stopLlmExport(p || {}, 'paused'); },
    async studio_llm_export_bundle(p) { return llmBundle(p || {}); },
    async studio_llm_register(p) { return llmRegister(p || {}); },
    async studio_llm_use(p) { return llmUse(p || {}); },
    async studio_llm_use_clear() { return llmUseClear(); },
    async studio_llm_use_current() { return llmUseCurrent(); },
    async studio_llm_export_cancel(p) { return stopLlmExport(p || {}, 'cancelled'); },
    async studio_llm_export_resume(p) { return resumeLlmExport(p || {}); },
    async studio_llm_export_status(p) {
        const j = exportJobs.get(p && p.jobId) || activeExport; if (!j) return { ok: true, state: 'idle' };
        return { ok: true, jobId: j.id, format: j.format, state: j.state, events: j.events.slice(-100), steps: j.result ? j.result.steps : null, failedAt: j.result ? j.result.failedAt : null, workDir: j.workDir, outDir: j.outDir, elapsedMs: (j.endedAt || now()) - j.startedAt };
    },
    async studio_run_current() { const j = activeTrain || Array.from(jobs.values()).pop(); return { ok: true, runDir: j && j.cfg && j.cfg.outputDir ? j.cfg.outputDir : null }; },
    async studio_train_status(p) {
      const j = jobs.get(p && p.jobId) || activeTrain; if (!j || j.kind === undefined || !j.run) return { ok: true, running: false, state: 'idle' };
      const r = j.run; return { ok: true, jobId: j.id, running: r.state === 'running' || r.state === 'pausing', state: r.state, step: r.lastStep, loss: r.lastLoss, errors: r.errors.slice(-5), events: j.events.slice(-(Number(p && p.tail) || 50)), exitCode: r.exitCode, elapsedMs: (j.endedAt || now()) - j.startedAt };
    },
    async studio_train_pause(p) { const j = jobs.get(p && p.jobId) || activeTrain; if (!j || !j.run || j.run.state !== 'running') return { ok: false, error: '沒有執行中的訓練可暫停' }; const r = await j.run.pause(p && p.timeoutMs); return Object.assign({ ok: r.ok }, r); },
    async studio_train_stop(p) { const j = jobs.get(p && p.jobId) || activeTrain; if (!j || !j.run || !(j.run.state === 'running' || j.run.state === 'pausing')) return { ok: true, already: true }; await j.run.stop(); return { ok: true }; },
    async studio_ext_check(p) { return extCheck(p || {}); },
    async studio_ext_start(p) { return extStart(p || {}); },
    async studio_ext_status(p) { return extStatus(p || {}); },
    async studio_ext_stop(p) { return extStop(p || {}); },
    async studio_dispose() { try { if (activeExt && activeExt.job.state === 'running') activeExt.job.stop(); } catch (e) {} try { if (activeBench) { activeBench.ac.aborted = true; activeBench.ac.listeners.forEach((f) => f()); } if (activeTrain && activeTrain.run && activeTrain.run.state === 'running') await activeTrain.run.stop(); } catch (e) {} return { ok: true }; },
  };
  return { ops, registry, handle: async (op, payload) => { const f = ops[op]; if (!f) return { ok: false, code: 'bad_op', message: '未知的 Studio 操作：' + op }; try { return await f(payload || {}); } catch (e) { return { ok: false, code: 'internal', message: String((e && e.message) || e) }; } } };
}

// tasklist /FO CSV 的記憶體欄（例如 "1,234,567 K"）→ 位元組；查不到回 null。純函式，測試用
function parseTasklistMemory(text) {
  const m = /"([\d,]+)\s*K"\s*$/m.exec(String(text || '')); if (!m) return null;
  const kb = Number(m[1].replace(/,/g, '')); return Number.isFinite(kb) ? kb * 1024 : null;
}
module.exports = { createStudioHost, parseTasklistMemory };
