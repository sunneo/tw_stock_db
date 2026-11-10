'use strict';
// cpu-py 整合測試：真的用 Python 子行程跑 lora-train/train_lora.py 1–2 步（極小資料、離線模式，不下載任何東西）。
// 前提不成立（沒有 Python 或缺 torch／transformers／peft，或本機沒有已快取的基底模型）就略過並印出具體原因——略過不算通過，也不算失敗。
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const P = require('./backend_cpu_py.js');
const loraDir = path.join(__dirname, '..', '..', '..', 'lora-train');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };
(async () => {
  const hw = { cpuModel: os.cpus()[0].model, cores: os.cpus().length };
  const b = P.createCpuPyBackend({ detect: P.defaultDetect(cp.spawnSync), spawn: (c, a, o) => cp.spawn(c, a, o), killTree: (ch) => { try { cp.spawnSync('taskkill', ['/PID', String(ch.pid), '/T', '/F'], { windowsHide: true }); } catch (e) {} }, fs, path, loraDir, hw, env: { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
  const pr = await b.probe();
  console.log('probe：' + (pr.available ? '可用' : '不可用：' + pr.reason));
  const hub = path.join(process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface'), 'hub', 'models--Qwen--Qwen3-0.6B');
  const base = process.env.FA_TEST_BASE_MODEL || 'Qwen/Qwen3-0.6B';
  if (!pr.available || (!process.env.FA_TEST_BASE_MODEL && !fs.existsSync(hub))) {
    console.log('略過整合測試：' + (!pr.available ? pr.reason : '本機沒有已快取的基底模型 ' + hub + '（離線模式不下載；可用環境變數 FA_TEST_BASE_MODEL 指向本機模型資料夾）'));
    console.log('0 passed, 0 failed [] （整合測試略過）'); process.exit(0);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-studio-it-')), train = path.join(dir, 'train.jsonl'), out = path.join(dir, 'out');
  const rows = []; for (let i = 0; i < 12; i++) rows.push(JSON.stringify({ id: 't' + i, split: 'train', domain: 'it', messages: [{ role: 'user', content: '說 ' + i }], completion: '好 ' + i, meta: {} }));
  fs.writeFileSync(train, rows.join('\n') + '\n');
  const cfg = { base, trainFile: train, outputDir: out, maxSteps: 2, saveSteps: 1, batch: 1, accum: 1, seqLen: 64, valFraction: 0, threads: 1 }, ev = [];
  const run = await b.startRun(cfg, { onEvent: (e) => ev.push(e) }), res = await run.done;
  check('真的訓練 2 步：子行程正常結束', res.state === 'finished', res);
  check('收到 loss 事件且為有限數', ev.some((e) => e.type === 'log' && Number.isFinite(e.loss)), ev.slice(0, 5));
  check('寫出 checkpoint-N', !!b.latestCheckpoint(out));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
})();
