#!/usr/bin/env node
// cpu-py 全參數步的速度量測（與 gen_step_bench_eval.js 的 cudaweb 量測同一組規模，來自 sizes.js）。
// 用法：node scripts/bench/bench_cpu_py_steps.js [python 路徑] [steps] [threads]
// 執行緒：預設 OMP_NUM_THREADS＝MKL_NUM_THREADS＝threads（預設 4）；實際 torch 執行緒數未回讀，摘要會標明設定值。
// 輸出 JSON：每個規模的中位數 ms（取第 6 步起）；由 llm_full_cpu.py 逐步回報的 ms。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { SIZES } = require('./sizes.js');
const LD = require('../../renderer/src/studio/llm_full_data.js');
const CK = require('../../renderer/src/studio/checkpoint_core.js');

const PY = process.argv[2] || process.env.FA_PYTHON || 'python';
const STEPS = Number(process.argv[3]) || 30, THREADS = Number(process.argv[4]) || 4, WARM = 5;
const SCRIPT = path.join(__dirname, '..', '..', 'renderer', 'src', 'studio', 'llm_full_cpu.py');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-bench-'));
const out = [];
for (const sz of SIZES) {
  const cfg = sz.cfg;
  const init = LD.makeInit(cfg, 1);
  const lst = [];
  const pushT = (n, a) => lst.push({ name: n, shape: [a.length], data: Float64Array.from(a) });
  pushT('emb', init.emb); pushT('nf', init.nf);
  init.layers.forEach((Lw, l) => ['n1', 'n2', 'Wq', 'Wk', 'Wv', 'Wo', 'qn', 'kn', 'Wg', 'Wu', 'Wd'].forEach((k) => pushT('L' + l + '.' + k, Lw[k])));
  const initPath = path.join(dir, sz.name + '_init.f32'); fs.writeFileSync(initPath, Buffer.from(CK.encodeTensors(lst)));
  const seq = Array.from({ length: cfg.T + 1 }, (_, i) => (i * 37 + 11) % cfg.V);
  const rowsPath = path.join(dir, sz.name + '_rows.json'); fs.writeFileSync(rowsPath, JSON.stringify([seq]));
  const job = Object.assign(LD.makeJob({ cfg, lr: 1e-3, wd: 0.01, clip: 1, steps: STEPS, dtype: 'float32' }), { rows_file: rowsPath, init_file: initPath, out_dir: null, resume_dir: null });
  const jobPath = path.join(dir, sz.name + '_job.json'); fs.writeFileSync(jobPath, JSON.stringify(job));
  const env = Object.assign({}, process.env, { OMP_NUM_THREADS: String(THREADS), MKL_NUM_THREADS: String(THREADS) });
  const r = spawnSync(PY, [SCRIPT, '--job', jobPath], { encoding: 'utf8', env, timeout: 1800000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) { out.push({ size: sz.name, cfg, error: (r.stderr || r.error && r.error.message || '').slice(-600) }); continue; }
  const ms = r.stdout.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((x) => x.event === undefined && x.step !== undefined).map((x) => x.ms);
  const steady = ms.slice(WARM).slice().sort((a, b) => a - b);
  out.push({ size: sz.name, cfg, steps: ms.length, warmup: WARM, threadsConfigured: THREADS, msFirst: Math.round(ms[0] * 100) / 100, msMedian: Math.round(steady[Math.floor(steady.length / 2)] * 100) / 100, msMin: Math.round(steady[0] * 100) / 100, msMax: Math.round(steady[steady.length - 1] * 100) / 100 });
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ backend: 'cpu-py', python: PY, host: { cpuModel: os.cpus()[0] && os.cpus()[0].model, logicalCpus: os.cpus().length, totalMemGB: Math.round(os.totalmem() / 1e9 * 10) / 10 }, sizes: out }, null, 1));
