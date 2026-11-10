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
  const loraDirOf = () => { const a = P.join(hostDir, 'lora-train'); if (fs.existsSync(P.join(a, 'train_lora.py'))) return a; return d.loraDir || a; };
  const killTree = d.killTree || ((ch) => { try { if (process.platform === 'win32' && ch.pid) cp.spawn('taskkill', ['/PID', String(ch.pid), '/T', '/F'], { windowsHide: true }); else ch.kill('SIGTERM'); } catch (e) {} });
  const spawnLow = (c, a, o) => {
    const ch = cp.spawn(c, a, Object.assign({}, o, { windowsHide: true }));
    // 以較低優先權執行（Configure 的 lowPriority）：不可用就略過，不影響訓練
    try { if (config.lowPriority && ch && ch.pid && os.setPriority) os.setPriority(ch.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) {}
    return ch;
  };
  const registry = new BackendCore.BackendRegistry();
  const cpuPy = CpuPy.createCpuPyBackend({ detect: CpuPy.defaultDetect(cp.spawnSync), spawn: spawnLow, killTree, fs, path: P, get loraDir() { return loraDirOf(); }, hw, get config() { return config; }, env: d.env || {} });
  registry.register(CpuJs.createCpuJsBackend({ engineVersion: 'tiny-1' }));
  registry.register(cpuPy);
  ['webgpu', 'directml', 'vulkan'].forEach((id) => registry.register(Planned.createPlannedBackend(id, {})));
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
  const benchCfg = (id, p) => id === 'cpu-py'
    ? { base: (p && p.base) || 'Qwen/Qwen3-0.6B', trainFile: benchDataFile(), outputDir: P.join(hostDir, 'bench-out'), threads: SC.resolveThreads(config, hw.cores, 'benchmark') }
    : { threads: SC.resolveThreads(config, hw.cores, 'benchmark') };

  const ops = {
    // 狀態：硬體、設定、各後端是否可用與原因
    async studio_probe(p) {
      const kind = (p && p.kind) || 'lora', list = await registry.listFor(kind, ctxOf(p));
      const sym = BackendCore.isSymbolicKind(kind);
      return { ok: true, kind, symbolic: sym, hw, config, backends: sym ? [{ id: 'cpu-js', available: true, reason: '', note: '只需處理器' }] : list.map((x) => ({ id: x.id, available: x.available, reason: x.reason, device: x.probe && x.probe.device, planned: !!(registry.get(x.id) || {}).planned })), loraDir: loraDirOf(), threads: SC.resolveThreads(config, hw.cores, 'train') };
    },
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
            let r; try { r = await b.benchmark(benchCfg(id, p), { signal: job.signal, deadlineMs: p && p.deadlineMs }); } catch (e) { r = { ok: false, error: String(e && e.message || e), reason: String(e && e.message || e) }; }
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
      const r = await BC.autoSelect({ kind: (p && p.kind) || 'lora', registry, cache: benchCache, ctx: ctxOf(p), pin: p && p.pin, skipBench: true });
      return Object.assign({ ok: !!r.chosen }, r);
    },
    // 訓練：目前只有 lora（cpu-py）有真的子行程訓練；符號式五類的包裝尚未接（步驟 3）
    async studio_train_start(p) {
      p = p || {}; const kind = p.kind || 'lora';
      if (kind !== 'lora') return { ok: false, error: kind + ' 的訓練包裝尚未實作（設計文件 §10 步驟 3）；目前只有 lora 能在這裡啟動訓練' };
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

module.exports = { createStudioHost };
