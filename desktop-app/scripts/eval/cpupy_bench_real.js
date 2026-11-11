// 不經 Electron，直接用工作室主行程端跑 cpu-py 真實基準測試（離線，需 lora-train/.venv 與已快取的 Qwen3-0.6B）。用法：node scripts/eval/cpupy_bench_real.js
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
process.env.HF_HUB_OFFLINE = '1'; process.env.TRANSFORMERS_OFFLINE = '1';
const { createStudioHost } = require('../../renderer/src/studio/studio_host.js');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-cpupy-bench-'));
  const h = createStudioHost({ fs, path, os, cp, hostDir: dir, loraDir: path.join(__dirname, '..', '..', 'lora-train'), env: Object.assign({}, process.env) });
  await h.handle('studio_probe', { kind: 'lora' }); await h.handle('studio_probe_wait', {});
  const st = await h.handle('studio_bench_start', { kind: 'lora' }); const t0 = Date.now();
  let s; for (;;) { s = await h.handle('studio_bench_status', { jobId: st.jobId }); if (s.state !== 'running') break; await new Promise((r) => setTimeout(r, 2000)); }
  const row = s.rows.find((r) => r.id === 'cpu-py');
  console.log(JSON.stringify({ elapsedS: Math.round((Date.now() - t0) / 1000), state: row.state, result: row.result }, null, 1));
  fs.rmSync(dir, { recursive: true, force: true });
})();
