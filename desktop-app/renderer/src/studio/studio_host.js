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
    const fresh = probeSt.val && now() - probeSt.at < PROBE_TTL;
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
  async function startLlmExport(p) {
    const format = String(p.format || '');
    if (!LlmExport.FORMATS.includes(format)) return { ok: false, error: '格式必須是 ' + LlmExport.FORMATS.join(' 或 ') };
    if (activeExport && activeExport.state === 'running') return { ok: false, error: '已有匯出在執行中（' + activeExport.id + '）' };
    const baseDir = String(p.baseDir || ''), adapterDir = String(p.adapterDir || '');
    if (!baseDir || !exists(baseDir)) return { ok: false, error: '基底模型資料夾不存在：' + baseDir };
    if (!adapterDir && !p.fullDir) return { ok: false, error: '請給 LoRA adapter 資料夾（adapterDir）' };
    const pr = await probeLlmTools();
    const av = LlmExport.exportAvailability(pr.tools)[format];
    if (!av.available) return { ok: false, error: av.reason, tools: pr.tools };
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const workDir = String(p.workDir || P.join(pr.paths.lora, 'out', 'llm-export', stamp));
    if (exists(workDir) && fs.readdirSync(workDir).length) return { ok: false, error: '工作資料夾不是空的：' + workDir };
    const outDir = P.join(workDir, format);
    const cmds = LlmExport.buildStepCommands(format, { pyTrain: pr.paths.trainPy, pyExport: pr.paths.exportPy, scriptsDir: pr.paths.lora, baseDir, adapterDir, workDir, outDir, llamaDir: pr.paths.llamaBin, llamaSrc: pr.paths.llamaSrc, recipe: String(p.recipe || 'full') });
    if (!cmds.ok) return { ok: false, error: cmds.error };
    const job = { id: newId('llmexp'), format, state: 'running', events: [], result: null, workDir, outDir, startedAt: now(), endedAt: 0 };
    exportJobs.set(job.id, job); activeExport = job;
    const runner = (argv) => new Promise((res) => {
        let out = '', err = '', settled = false; const done = (r) => { if (!settled) { settled = true; res(r); } };
        let ch; try { ch = cp.spawn(argv[0], argv.slice(1), { cwd: pr.paths.lora, windowsHide: true }); } catch (e) { return done({ code: -1, stdout: '', stderr: String((e && e.message) || e) }); }
        ch.stdout.on('data', (b) => { out += String(b); if (out.length > 4e6) out = out.slice(-2e6); });
        ch.stderr.on('data', (b) => { err += String(b); if (err.length > 4e6) err = err.slice(-2e6); });
        ch.on('error', (e) => done({ code: -1, stdout: out, stderr: err + String((e && e.message) || e) }));
        ch.on('close', (code) => done({ code, stdout: out, stderr: err }));
    });
    job.done = LlmExport.runExportSteps(cmds, runner, { onEvent: (e) => { job.events.push(e); if (job.events.length > 400) job.events.shift(); } })
        .then((r) => {
            job.result = r; job.state = r.ok ? 'finished' : 'failed'; job.endedAt = now();
            writeJson(P.join(workDir, 'export_job.json'), { format, recipe: String(p.recipe || 'full'), ok: r.ok, failedAt: r.failedAt, steps: r.steps, startedAt: job.startedAt, endedAt: job.endedAt, baseDir, adapterDir });
        })
        .catch((e) => { job.state = 'failed'; job.result = { ok: false, failedAt: null, steps: [], error: String((e && e.message) || e) }; job.endedAt = now(); });
    return { ok: true, jobId: job.id, workDir, outDir, steps: cmds.steps.map((s) => ({ id: s.id, label: s.label })) };
  }

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
      const cfg = p.cfg || {}; if (!cfg.trainFile || !cfg.outputDir) return { ok: false, error: '缺少 trainFile／outputDir' };
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
    async studio_dispose() { try { if (activeBench) { activeBench.ac.aborted = true; activeBench.ac.listeners.forEach((f) => f()); } if (activeTrain && activeTrain.run && activeTrain.run.state === 'running') await activeTrain.run.stop(); } catch (e) {} return { ok: true }; },
  };
  return { ops, registry, handle: async (op, payload) => { const f = ops[op]; if (!f) return { ok: false, code: 'bad_op', message: '未知的 Studio 操作：' + op }; try { return await f(payload || {}); } catch (e) { return { ok: false, code: 'internal', message: String((e && e.message) || e) }; } } };
}

// tasklist /FO CSV 的記憶體欄（例如 "1,234,567 K"）→ 位元組；查不到回 null。純函式，測試用
function parseTasklistMemory(text) {
  const m = /"([\d,]+)\s*K"\s*$/m.exec(String(text || '')); if (!m) return null;
  const kb = Number(m[1].replace(/,/g, '')); return Number.isFinite(kb) ? kb * 1024 : null;
}
module.exports = { createStudioHost, parseTasklistMemory };
