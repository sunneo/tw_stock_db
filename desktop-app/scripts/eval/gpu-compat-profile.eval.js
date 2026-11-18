// 真桌面版評估：GPU 相容層簡易檢視的 Profile 按鈕實際執行一次，讀 DOM 的白話結論，並獨立再量一次 CPU 對照。
// 啟動方式同 gpu-compat-view.eval.js（獨立 --user-data-dir、換埠、FA_DISABLE_MAIN_OVERLAY=1）。
const fa = window.fa; const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pane = document.querySelector('.ai-advanced-pane[data-pane="gpu-compat"]');
R.paneFound = !!pane; R.navigatorGpu = typeof navigator.gpu;
fa.advancedSettings.engineeringMode = false; fa._renderAdvancedSettings();
const btn = Array.from(pane.querySelectorAll('button')).find((b) => b.textContent === 'Profile');
const txt = pane.querySelector('#ai-gpu-compat-summary');
R.before = txt.textContent;
const t0 = Date.now(); const seen = [];
btn.click();
for (let i = 0; i < 600; i++) { await wait(300); const v = txt.textContent; if (seen[seen.length - 1] !== v) seen.push(v.slice(0, 120)); if (!fa._gpuProfileBusy && Date.now() - t0 > 1500 && btn.disabled === false) break; }
R.seconds = Math.round((Date.now() - t0) / 100) / 10; R.progress = seen; R.finalText = txt.textContent; R.rec = fa._gpuProfileLast;
R.lockState = fa._qwenModule().nn.measureLockState();
// 對照：獨立量 CPU 64×1024×1024 的 GFLOP/s（用同一個 cpu_share，同樣核心數規則）
try {
  const QM = fa._qwenModule(); const sh = QM.cpuShare.getShared(); const hw = navigator.hardwareConcurrency || 1; const n = Math.max(1, Math.floor(hw / 2)); sh.setCores(n);
  const d = QM.bench.makeMatmulInputs(64, 1024, 1024, 7); const ts = [];
  for (let i = 0; i < 5; i++) { const a = performance.now(); await sh.runCpuOnly(d.a, d.b, 64, 1024, 1024, {}); const b = performance.now() - a; if (i > 0) ts.push(b); }
  ts.sort((x, y) => x - y); R.independentCpu = { cores: n, medianMs: ts[2], gflops: 2 * 64 * 1024 * 1024 / ts[2] / 1e6 }; sh.setCores(0);
} catch (e) { R.independentCpuError = String(e && e.message || e); }
R.loaded = Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s));
return R;
