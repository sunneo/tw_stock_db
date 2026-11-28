#!/usr/bin/env node
// cpu-py 全參數步的速度量測（與 gen_step_bench_eval.js 的 cudaweb 量測同設定：三個規模、批次 1 條序列、30 步、前 5 步暖機）。
// 用法：node scripts/eval/bench_cpu_py_steps.js [python 路徑]
// 執行緒：以 OMP_NUM_THREADS＝MKL_NUM_THREADS＝4 設定（與先前的 111 ms 量測相同）。結果是 llm_full_cpu.py 每步回報的 ms。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const LD = require('../../renderer/src/studio/llm_full_data.js');
const CK = require('../../renderer/src/studio/checkpoint_core.js');

const PY = process.argv[2] || process.env.FA_PYTHON || 'python';
const SCRIPT = path.join(__dirname, '..', '..', 'renderer', 'src', 'studio', 'llm_full_cpu.py');
const SIZES = [
  { name: 'S', cfg: { V: 258, d: 32, L: 2, H: 4, kvH: 2, F: 64, T: 12, qkNorm: true } },
  { name: 'M', cfg: { V: 512, d: 128, L: 4, H: 8, kvH: 4, F: 256, T: 64, qkNorm: true } },
  { name: 'L', cfg: { V: 2048, d: 256, L: 4, H: 8, kvH: 4, F: 512, T: 128, qkNorm: true } },
];
const STEPS = 30, WARM = 5;
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
  const env = Object.assign({}, process.env, { OMP_NUM_THREADS: '4', MKL_NUM_THREADS: '4' });
  const r = spawnSync(PY, [SCRIPT, '--job', jobPath], { encoding: 'utf8', env, timeout: 900000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) { out.push({ size: sz.name, error: (r.stderr || '').slice(-600) }); continue; }
  const ms = r.stdout.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((x) => x.event === undefined && x.step !== undefined).map((x) => x.ms);
  const steady = ms.slice(WARM).slice().sort((a, b) => a - b);
  out.push({ size: sz.name, cfg, steps: ms.length, warmup: WARM, threadsConfigured: 4, msFirst: Math.round(ms[0] * 100) / 100, msMedian: Math.round(steady[Math.floor(steady.length / 2)] * 100) / 100, msMin: Math.round(steady[0] * 100) / 100, msMax: Math.round(steady[steady.length - 1] * 100) / 100 });
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ backend: 'cpu-py', sizes: out }, null, 1));
