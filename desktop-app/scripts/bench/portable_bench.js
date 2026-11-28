#!/usr/bin/env node
'use strict';
// 可攜量測工具（P1 的最後交付）：在使用者的機器上一次跑完 cudaweb（真 Electron、WebGPU）與 cpu-py（llm_full_cpu.py），
// 輸出一份可直接貼回的摘要（轉接器資訊、各規模 ms/步、tokens/s、屋頂線預測與實測比、交叉點）。
//
// 用法（在 desktop-app 資料夾內，需要已安裝的 node_modules 與 Python 含 torch）：
//   node scripts/bench/portable_bench.js --python "C:\Python312\python.exe" [--sizes S,M,L,XL] [--steps 30] [--threads 4]
//                                        [--peak-tflops 0.3] [--bw-gbs 14] [--port 17931] [--out bench-out] [--skip-gpu] [--skip-cpu]
// 輸出：<out>/summary.md（貼這個）、<out>/result.json（原始資料）。
// 注意：
//   · 一次只開一個 Electron；結束後會確認沒有殘留（Win32 的 electron 行程）。
//   · 規模大時單次提交可能超過 GPU 看門狗時限（Windows 會重置裝置，DXGI_ERROR_DEVICE_HUNG）。每個規模完成就會列印，
//     若裝置遺失，已完成的規模仍會保留，遺失的規模記為錯誤；不會重試。
//   · 屋頂線峰值用 --peak-tflops、--bw-gbs 指定；預設 0.3 TFLOPS、14 GB/s 只是 GT 720 級的假設。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { summarize, toMarkdown } = require('./summarize.js');

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const flag = (name) => argv.indexOf(name) >= 0;
const APP = path.join(__dirname, '..', '..');
const PY = opt('--python', process.env.FA_PYTHON || 'python');
const SIZES = opt('--sizes', 'S,M,L,XL');
const STEPS = Number(opt('--steps', 30)), THREADS = Number(opt('--threads', 4));
const PEAK = { tflops: Number(opt('--peak-tflops', 0.3)), gbs: Number(opt('--bw-gbs', 14)) };
const PORT = opt('--port', '17931');
const OUT = path.resolve(opt('--out', path.join(APP, 'bench-out')));
fs.mkdirSync(OUT, { recursive: true });

function log(msg) { process.stdout.write(msg + '\n'); }

// 結束整棵 Electron 行程樹（Windows 用 taskkill /T，其他平台用 kill）
function killTree(p) {
  try {
    if (process.platform === 'win32' && p.pid) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
    else p.kill('SIGKILL');
  } catch (_) { /* 已結束 */ }
}

// 殘留檢查：找出命令列含本次 --user-data-dir 的 electron 行程（只限我們自己啟動的那一個，不碰使用者的 Electron）
function residuePids(ud) {
  if (process.platform !== 'win32') return [];
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*" + ud.replace(/'/g, "''") + "*' } | ForEach-Object { $_.ProcessId }";
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').split(/\r?\n/).map((x) => Number(x.trim())).filter((n) => n > 0);
}

// 1) cudaweb：產生評估檔，在真的 Electron 裡跑，逐規模收集 [bench-size] 行
function runGpu() {
  return new Promise((resolve) => {
    const evalFile = path.join(OUT, 'step_bench.eval.js');
    const gen = spawnSync(process.execPath, [path.join(__dirname, '..', 'eval', 'gen_step_bench_eval.js'), path.join(APP, 'renderer', 'src'), evalFile, String(STEPS), SIZES], { encoding: 'utf8' });
    if (gen.status !== 0) return resolve({ error: '產生評估檔失敗：' + (gen.stderr || '').slice(-400) });
    const exe = path.join(APP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
    if (!fs.existsSync(exe)) return resolve({ error: '找不到 Electron（' + exe + '）。請先在 desktop-app 執行 npm install。' });
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-bench-ud-'));
    const rev = /const REV = "([^"]+)"/.exec(fs.readFileSync(path.join(APP, 'main-ext.js'), 'utf8'));
    if (rev) fs.writeFileSync(path.join(ud, 'main-ext-rev.txt'), rev[1]);
    fs.writeFileSync(path.join(ud, 'desktop-settings.json'), '{"execEnabled":true,"execConfirmRequired":false}');
    const env = Object.assign({}, process.env, { FA_DEBUG_EVAL_FILE: evalFile, FA_DISABLE_MAIN_OVERLAY: '1', FA_BROWSER_CONTROL_PORT: PORT });
    const p = spawn(exe, [APP, '--no-sandbox', '--user-data-dir=' + ud], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const sizes = [], adapterLines = []; let result = null, buf = '';
    let resultTimer = null, lostTimer = null;
    const onData = (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const ln = buf.slice(0, i); buf = buf.slice(i + 1);
        let m;
        if ((m = /\[bench-size\] (\{.*\})/.exec(ln))) { try { const e = JSON.parse(m[1]); sizes.push(e); log('  ' + e.size + ': ' + (e.error ? '錯誤 ' + e.error.slice(0, 80) : e.msMedian + ' ms/步')); } catch (_) { /* */ } }
        else if ((m = /\[bench-adapter\] (\{.*\}|null)/.exec(ln))) { try { adapterLines.push(JSON.parse(m[1])); } catch (_) { /* */ } }
        else if ((m = /\[eval-file\] result: (\{.*\})\s*$/.exec(ln))) {
          try { result = JSON.parse(m[1]); } catch (_) { /* */ }
          // 評估已給出結果：2 秒後結束 Electron（不等待視窗自行關閉）
          if (result && !resultTimer) resultTimer = setTimeout(() => { log('  （評估已完成，結束 Electron）'); killTree(p); }, 2000);
        }
        else if (/裝置遺失/.test(ln)) {
          log('  （GPU 裝置遺失：' + ln.slice(0, 120) + '）');
          // 裝置遺失後若 60 秒仍沒結束，視為卡住並強制結束
          if (!lostTimer) lostTimer = setTimeout(() => { log('  （裝置遺失後 60 秒仍未結束，強制結束 Electron）'); killTree(p); }, 60 * 1000);
        }
      }
    };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    const timer = setTimeout(() => { log('  （逾時：超過 45 分鐘，結束 Electron）'); killTree(p); }, 45 * 60 * 1000);
    p.on('exit', () => {
      clearTimeout(timer); clearTimeout(resultTimer); clearTimeout(lostTimer);
      // 殘留檢查：確認沒有本次啟動的 electron 還在跑，有就強制結束（只限本次的 user-data-dir）
      const left = residuePids(ud);
      if (left.length) { log('  （殘留 ' + left.length + ' 個 electron 行程，強制結束）'); for (const pid of left) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); }
      try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) { /* */ }
      const adapter = result && result.adapter || adapterLines[0] || null;
      // 結果以逐規模行為準（裝置遺失時 eval 不會回傳 result）
      resolve({ backend: 'cudaweb', adapter, sizes: result && result.sizes ? result.sizes : sizes, partial: !result });
    });
  });
}

// 2) cpu-py：呼叫 bench_cpu_py_steps.js
function runCpu() {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'bench_cpu_py_steps.js'), PY, String(STEPS), String(THREADS)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 3 * 60 * 60 * 1000 });
  if (r.status !== 0) return { error: (r.stderr || r.error && r.error.message || '').slice(-600), sizes: [] };
  return JSON.parse(r.stdout);
}

(async () => {
  log('可攜量測：規模 ' + SIZES + '，每規模 ' + STEPS + ' 步，cpu-py 執行緒 ' + THREADS + '，屋頂線 ' + PEAK.tflops + ' TFLOPS、' + PEAK.gbs + ' GB/s');
  let gpu = { backend: 'cudaweb', adapter: null, sizes: [] };
  if (!flag('--skip-gpu')) { log('[1/3] cudaweb（真 Electron，一次一個）'); gpu = await runGpu(); }
  let cpu = { backend: 'cpu-py', sizes: [] };
  if (!flag('--skip-cpu')) { log('[2/3] cpu-py（llm_full_cpu.py）'); cpu = runCpu(); if (cpu.error) log('  cpu-py 錯誤：' + cpu.error.slice(0, 200)); }
  log('[3/3] 摘要');
  const s = summarize(gpu, cpu, PEAK);
  const md = toMarkdown(gpu, cpu, PEAK, s);
  fs.writeFileSync(path.join(OUT, 'summary.md'), md, 'utf8');
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ gpu, cpu, peak: PEAK }, null, 1), 'utf8');
  log('已寫入 ' + path.join(OUT, 'summary.md') + ' 與 result.json');
  process.stdout.write('\n' + md);
})();
