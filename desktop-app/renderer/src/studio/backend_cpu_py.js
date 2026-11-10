'use strict';
// cpu-py 後端：桌面版以 Python 子行程呼叫 lora-train/train_lora.py（train.py 的 sft 階段呼叫的同一支訓練腳本；
// train.py 本身是七階段管線、沒有步數／檢查點控制，所以 Studio 直接呼叫 train_lora.py）。
// 純核心、依賴注入：偵測 Python、啟動子行程、檔案系統、時鐘都由呼叫端給，測試時全用假的。子行程一律 windowsHide:true。
const B = require('./backend_core.js');
const BC = require('./bench_core.js');
const C = require('./checkpoint_core.js');
const SC = require('./studio_config_core.js');

// 預設的 Python 探測（桌面版真的用；測試不用）：不丟例外，回 { found, path, version, packages }
function defaultDetect(spawnSync) {
  return function detect() {
    const code = "import sys,json\nr={'version':sys.version.split()[0],'packages':{}}\nfor m in ('torch','transformers','peft'):\n    try:\n        mod=__import__(m); r['packages'][m]=getattr(mod,'__version__','?')\n    except Exception:\n        r['packages'][m]=None\nprint(json.dumps(r))";
    for (const cmd of ['python', 'python3', 'py']) {
      try {
        const r = spawnSync(cmd, ['-I', '-c', code], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
        if (r && !r.error && r.status === 0) { const j = JSON.parse(String(r.stdout).trim().split('\n').pop()); return { found: true, path: cmd, version: j.version, packages: j.packages }; }
      } catch (e) {}
    }
    return { found: false };
  };
}

// 解析 train_lora.py（HF Trainer）印出的一行：log 字典、評估、tqdm 進度、[done]、[paused]
function parseProgressLine(line) {
  const s = String(line).trim(); if (!s) return null;
  let m;
  if ((m = s.match(/^\{.*\}$/))) {
    const o = {}; const re = /'([A-Za-z_]+)':\s*(-?[0-9.]+(?:e[-+]?[0-9]+)?|nan|inf)/gi; let k;
    while ((k = re.exec(s))) o[k[1]] = /nan|inf/i.test(k[2]) ? NaN : parseFloat(k[2]);
    if (o.eval_loss !== undefined) return { type: 'eval', evalLoss: o.eval_loss, epoch: o.epoch };
    if (o.loss !== undefined || o.train_loss !== undefined) return { type: 'log', loss: o.loss !== undefined ? o.loss : o.train_loss, gradNorm: o.grad_norm, lr: o.learning_rate, epoch: o.epoch };
    return null;
  }
  if ((m = s.match(/(\d+)\/(\d+)\s*\[[^\]]*?(?:,\s*([\d.]+)(s\/it|it\/s))?\]/))) return { type: 'progress', step: +m[1], total: +m[2], secPerIt: m[3] ? (m[4] === 'it/s' ? 1 / parseFloat(m[3]) : parseFloat(m[3])) : null };
  if ((m = s.match(/^\[paused\]\s*step=(\d+)/))) return { type: 'paused', step: +m[1] };
  if ((m = s.match(/^\[done\]\s*adapter saved to\s*(.+)$/))) return { type: 'done', dir: m[1] };
  if (/^(Traceback|[A-Za-z]*Error:|torch\.cuda|RuntimeError)/.test(s)) return { type: 'error', text: s };
  return null;
}

// ---- safetensors（JS 可讀，用來把 HF 檢查點的 LoRA 權重轉成規範化 float32）----
function f16(h) { const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff; if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024); if (e === 31) return f ? NaN : (s ? -Infinity : Infinity); return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024); }
function readSafetensors(buf) {
  const hl = Number(buf.readBigUInt64LE(0)), head = JSON.parse(buf.subarray(8, 8 + hl).toString('utf8')), base = 8 + hl, out = [];
  Object.keys(head).forEach((name) => {
    if (name === '__metadata__') return; const t = head[name], [a, b] = t.data_offsets, n = t.shape.reduce((x, y) => x * y, 1), d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (t.dtype === 'F32') d[i] = buf.readFloatLE(base + a + i * 4);
      else if (t.dtype === 'F16') d[i] = f16(buf.readUInt16LE(base + a + i * 2));
      else if (t.dtype === 'BF16') { const x = Buffer.alloc(4); x.writeUInt16LE(buf.readUInt16LE(base + a + i * 2), 2); d[i] = x.readFloatLE(0); }
      else throw new Error('不支援的 safetensors dtype ' + t.dtype);
    }
    out.push({ name, shape: t.shape, data: d, srcDtype: t.dtype });
  });
  return out;
}
function loraTensors(list) {   // 依名稱分成 A／B，名稱保留層名（規範化檔內依名稱排序）
  const A = [], Bt = []; list.forEach((t) => { if (/lora_A/.test(t.name)) A.push(t); else if (/lora_B/.test(t.name)) Bt.push(t); });
  return { 'lora_A.f32': A, 'lora_B.f32': Bt };
}

const NO_STEP = 'cpu-py 是整段訓練的子行程，不支援逐步呼叫；請用 startRun（暫停＝寫檢查點後結束子行程，續訓＝--resume_from_checkpoint）';

// o: { detect, spawn, killTree, fs(existsSync/readdirSync/writeFileSync/readFileSync/unlinkSync/mkdirSync), path, loraDir, now, sleep, hw:{cpuModel,cores} }
function createCpuPyBackend(o) {
  const P = o.path || require('path'), now = o.now || (() => Date.now()), sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const script = () => P.join(o.loraDir, 'train_lora.py');
  const b = {
    id: 'cpu-py', capabilities: { perStep: false, run: true, fp16: false },
    async probe() {
      let d; try { d = await o.detect(); } catch (e) { d = { found: false, error: String(e && e.message || e) }; }
      const hw = o.hw || {};
      const fp = { backend: 'cpu-py', cpu: hw.cpuModel || null, cores: hw.cores || null, python_version: d.version || null, torch_version: d.packages && d.packages.torch || null, engine_version: 'train_lora.py' };
      const dev = { name: hw.cpuModel || 'CPU', vendor: 'cpu', fp16: false };
      if (!d || !d.found) return B.probeResult(false, '找不到 Python（請安裝 Python 3.10 以上並裝 lora-train/requirements.txt，或改匯出訓練包到別台訓練）', dev, fp);
      const missing = ['torch', 'transformers', 'peft'].filter((k) => !(d.packages && d.packages[k]));
      if (missing.length) return B.probeResult(false, '已找到 Python ' + d.version + '，但缺少套件：' + missing.join('、') + '（見 lora-train/requirements.txt）', dev, fp);
      if (!o.fs.existsSync(script())) return B.probeResult(false, '找不到訓練腳本 ' + script(), dev, fp);
      return B.probeResult(true, '', dev, fp);
    },
    buildArgs(cfg) {
      const a = [script(), '--model_name_or_path', cfg.base || 'Qwen/Qwen3-0.6B', '--train_file', cfg.trainFile, '--output_dir', cfg.outputDir];
      const add = (k, v) => { if (v !== undefined && v !== null && v !== '') a.push(k, String(v)); };
      add('--num_train_epochs', cfg.epochs); add('--learning_rate', cfg.lr); add('--lora_r', cfg.rank); add('--lora_alpha', cfg.alpha);
      add('--per_device_train_batch_size', cfg.batch); add('--gradient_accumulation_steps', cfg.accum); add('--max_steps', cfg.maxSteps);
      add('--save_steps', cfg.saveSteps); add('--logging_steps', cfg.loggingSteps === undefined ? 1 : cfg.loggingSteps); add('--seed', cfg.seed); add('--max_seq_len', cfg.seqLen);
      add('--val_fraction', cfg.valFraction); add('--stop_file', cfg.stopFile); add('--resume_from_checkpoint', cfg.resumeFrom);
      return a;
    },
    // 電腦要保持可用：留一個核心、不彈視窗
    // 核心數：cfg.threads（明確指定）＞ Studio 設定（o.config，見 studio_config_core.js）＞ 預設 N−1
    buildEnv(cfg) { const cores = (o.hw && o.hw.cores) || 2; return { LORA_THREADS: String(cfg.threads || SC.resolveThreads(o.config, cores, cfg.purpose)), PYTHONUNBUFFERED: '1' }; },
    latestCheckpoint(dir) {
      if (!o.fs.existsSync(dir)) return null; let best = null;
      o.fs.readdirSync(dir).forEach((n) => { const m = /^checkpoint-(\d+)$/.exec(n); if (m && (!best || +m[1] > best.step)) best = { step: +m[1], dir: P.join(dir, n) }; });
      return best;
    },
    // 啟動一次訓練（或續訓）。回傳 run：{ pause(), stop(), done:Promise, events }
    async startRun(cfg, hooks) {
      hooks = hooks || {}; const stopFile = cfg.stopFile || P.join(cfg.outputDir, 'PAUSE');
      try { if (o.fs.existsSync(stopFile)) o.fs.unlinkSync(stopFile); } catch (e) {}
      const c = Object.assign({}, cfg, { stopFile });
      const py = (await o.detect()).path || 'python';
      const child = o.spawn(py, b.buildArgs(c), { cwd: o.loraDir, env: Object.assign({}, o.env || {}, b.buildEnv(c)), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const run = { child, state: 'running', lastStep: 0, lastLoss: null, errors: [], events: 0, startedAt: now(), exitCode: null, pausedAtStep: null };
      let buf = ''; const feed = (chunk) => { buf += String(chunk).replace(/\r/g, '\n'); const parts = buf.split('\n'); buf = parts.pop(); parts.forEach((l) => { const e = parseProgressLine(l); if (!e) return; run.events++; e.t = now(); if (e.type === 'progress') run.lastStep = e.step; if (e.type === 'log') { run.lastLoss = e.loss; } if (e.type === 'paused') run.pausedAtStep = e.step; if (e.type === 'error') run.errors.push(e.text); if (hooks.onEvent) hooks.onEvent(e); }); };
      child.stdout && child.stdout.on('data', feed); child.stderr && child.stderr.on('data', feed);
      run.done = new Promise((res) => { child.on('exit', (code, sig) => { if (buf) feed('\n'); run.exitCode = code; run.state = run.state === 'pausing' ? 'paused' : run.state === 'stopping' ? 'stopped' : (code === 0 ? 'finished' : 'failed'); res({ state: run.state, exitCode: code, signal: sig, errors: run.errors }); }); child.on('error', (e) => { run.errors.push(String(e && e.message || e)); run.state = 'failed'; res({ state: 'failed', exitCode: null, errors: run.errors }); }); });
      const kill = () => { try { (o.killTree || ((c2) => c2.kill()))(child); } catch (e) {} };
      // 暫停：建立 stop_file，訓練腳本在下一個優化步後存檢查點並結束；逾時就強制結束子行程並回報檢查點可能不是最新
      run.pause = async (timeoutMs) => {
        run.state = 'pausing'; try { o.fs.mkdirSync(cfg.outputDir, { recursive: true }); } catch (e) {} o.fs.writeFileSync(stopFile, 'pause');
        const t0 = now(); let forced = false;
        const limit = timeoutMs === undefined ? 120000 : timeoutMs;
        while (run.exitCode === null && run.state === 'pausing' && now() - t0 < limit) { const r = await Promise.race([run.done, sleep(200).then(() => null)]); if (r) break; }
        if (run.exitCode === null && run.state === 'pausing') { forced = true; kill(); await run.done; run.state = 'paused'; }
        try { o.fs.unlinkSync(stopFile); } catch (e) {}
        const ck = b.latestCheckpoint(cfg.outputDir);
        return { ok: !!ck, forced, checkpoint: ck, step: ck ? ck.step : null, reason: ck ? (forced ? '逾時強制結束，檢查點可能不是最新（最近一個在 step ' + ck.step + '）' : '') : '沒有找到檢查點（checkpoint-N）：還沒到 save_steps 就暫停，無法續訓，只能重來' };
      };
      run.stop = async () => { run.state = 'stopping'; kill(); return run.done; };
      return run;
    },
    // 續訓：從輸出資料夾最新的 checkpoint-N 繼續（Trainer 會還原優化器、排程、亂數與資料位置）
    async resumeRun(cfg, hooks) {
      const ck = b.latestCheckpoint(cfg.outputDir); if (!ck) throw new Error('找不到 checkpoint-N，無法續訓：' + cfg.outputDir);
      return b.startRun(Object.assign({}, cfg, { resumeFrom: ck.dir }), hooks);
    },
    // 基準測試：小資料、max_steps = 暖機 + 30，從 log 事件的時間差算步時間；中斷／超時就結束子行程
    async benchmark(cfg, opts) {
      opts = opts || {}; const signal = opts.signal, warm = BC.BENCH.warmup, steps = BC.BENCH.steps, deadline = opts.deadlineMs === undefined ? BC.BENCH.deadlineMs : opts.deadlineMs, t0 = now();
      const stamps = [], losses = []; let nonFinite = false, run = null, aborted = false, tooSlow = false, abortedAt = null;
      try {
        run = await b.startRun(Object.assign({}, cfg, { maxSteps: warm + steps, saveSteps: 100000, loggingSteps: 1, batch: BC.BENCH.batch, seqLen: BC.BENCH.seqLen, valFraction: 0, purpose: 'benchmark' }), { onEvent: (e) => { if (e.type === 'log') { stamps.push(e.t); losses.push(e.loss); if (!Number.isFinite(e.loss) || (e.gradNorm !== undefined && !Number.isFinite(e.gradNorm))) nonFinite = true; } } });
        const onAbort = () => { if (abortedAt === null) { abortedAt = now(); aborted = true; run.stop(); } };
        if (signal) { if (signal.aborted) onAbort(); else if (signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true }); }
        while (run.state === 'running') { const r = await Promise.race([run.done, sleep(100).then(() => null)]); if (r) break; if (now() - t0 > deadline) { tooSlow = true; await run.stop(); break; } }
        await run.done;
      } catch (e) { return { ok: false, error: String(e && e.message || e), reason: '基準測試失敗：' + (e && e.message || e), elapsedMs: now() - t0 }; }
      if (aborted) return { ok: false, aborted: true, stoppedAfterMs: now() - abortedAt, elapsedMs: now() - t0, reason: '使用者中斷' };
      if (tooSlow) return { ok: false, tooSlow: true, reason: '太慢：超過 ' + Math.round(deadline / 1000) + ' 秒仍未跑完 ' + (warm + steps) + ' 步', elapsedMs: now() - t0 };
      if (run.state !== 'finished' || stamps.length < warm + 2) return { ok: false, error: run.errors.join(' | '), reason: '訓練子行程' + (run.state === 'finished' ? '輸出的 log 太少' : '失敗') + (run.errors.length ? '：' + run.errors[0] : ''), elapsedMs: now() - t0 };
      const times = []; for (let i = warm + 1; i < stamps.length; i++) times.push(stamps[i] - stamps[i - 1]);
      const sorted = times.slice().sort((x, y) => x - y), med = BC.percentile(sorted, 0.5), tokens = BC.BENCH.seqLen * BC.BENCH.batch;
      const peak = o.peakMem ? await o.peakMem(run) : null;
      // cpu-py 就是數值參考：只檢查全程無 NaN／Inf
      return { ok: true, tokPerSec: med > 0 ? tokens / (med / 1000) : 0, peakMemBytes: peak, stepMsP50: med, stepMsP95: BC.percentile(sorted, 0.95), samples: times.length, elapsedMs: now() - t0, threads: Number(b.buildEnv(Object.assign({}, cfg, { purpose: 'benchmark' })).LORA_THREADS), trace: { loss1: losses[0], gradNorm1: null, loss30: losses[losses.length - 1], hasNonFinite: nonFinite }, numericCheck: { pass: !nonFinite, maxRelErr: 0, lossDelta: 0, reference: true, items: [], failed: nonFinite ? ['全程無NaN或Inf'] : [] } };
    },
    async init() { throw new Error(NO_STEP); },
    async step() { throw new Error(NO_STEP); },
    async evalLoss() { throw new Error(NO_STEP); },
    async dispose(h) { if (h && h.run && h.run.state === 'running') await h.run.stop(); },
    // 把 HF 檢查點的 LoRA 權重轉成規範化 float32。優化器張量在 torch 專有的 optimizer.pt（JS 讀不了），所以 opt_m／opt_v 標為缺少
    async saveCheckpoint(h) {
      const ck = b.latestCheckpoint(h.outputDir); if (!ck) throw new Error('沒有 checkpoint-N 可轉換');
      const st = o.fs.readFileSync(P.join(ck.dir, 'adapter_model.safetensors')), tensors = loraTensors(readSafetensors(st));
      let state = {}; try { state = JSON.parse(o.fs.readFileSync(P.join(ck.dir, 'trainer_state.json'), 'utf8')); } catch (e) {}
      const hist = (state.log_history || []).filter((x) => x.loss !== undefined).map((x) => x.loss);
      const cp = C.makeCheckpoint({ step: ck.step, epoch: state.epoch || 0, cursor: Object.assign(C.createCursor(h.cfg && h.cfg.seed || 0), { consumed_tokens: 0 }), rng: new C.PCG32(h.cfg && h.cfg.seed || 0, 11).snapshot(),
        optimizer: Object.assign({ kind: 'adamw', lr: h.cfg && h.cfg.lr, step_count: ck.step }, { state: 'native-only' }), data_sha256: h.dataSha256 || '', compat: h.compat || {}, loss_tail: hist,
        produced_by: { backend: 'cpu-py', device_fingerprint: (o.hw && o.hw.cpuModel) || '', engine_version: 'train_lora.py', precision: 'float32', native_dir: ck.dir }, tensors });
      cp.ckpt.notes = ['優化器張量（optimizer.pt）為 torch 格式，JS 讀不了：換到別的後端續訓時優化器動量會重置；同為 cpu-py 時用 native_dir 的原生檢查點續訓（resumeRun）'];
      return cp;
    },
    async loadCheckpoint() { throw new Error('無法由規範化檢查點在 cpu-py 重建 Trainer 狀態：優化器為 torch 專有格式，且 train_lora.py 還沒有 --init_adapter；同後端續訓請用 resumeRun（原生 checkpoint-N）'); },
  };
  return b;
}

module.exports = { createCpuPyBackend, defaultDetect, parseProgressLine, readSafetensors, loraTensors, NO_STEP };
