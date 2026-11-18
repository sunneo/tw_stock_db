// 真桌面版評估：GPU 相容層窗格的簡易／專業檢視（讀 DOM）。
// 用法：FA_DEBUG_EVAL_FILE=<本檔絕對路徑> FA_DISABLE_MAIN_OVERLAY=1 FA_BROWSER_CONTROL_PORT=<非 17923> electron <desktop-app> --no-sandbox --disable-gpu --user-data-dir=<全新資料夾>
// 啟動前先在資料夾寫入 main-ext-rev.txt（內容為 main-ext.js 的 REV 字串），免得跳更新對話框。
const fa = window.fa; const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
R.loaded = Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s));
R.hasApply = typeof fa._gpuCompatApplyView;
const pane = document.querySelector('.ai-advanced-pane[data-pane="gpu-compat"]');
R.paneFound = !!pane;
const vis = (el) => !!el && el.style.display !== 'none' && !el.closest('[data-gpu-block][style*="display: none"]');
const snap = () => {
  const blocks = {}; pane.querySelectorAll(':scope [data-gpu-block]').forEach((el) => { const id = el.getAttribute('data-gpu-block'); blocks[id] = (blocks[id] || false) || vis(el); });
  const bar = pane.querySelector('#ai-gpu-compat-viewbar');
  const visibleText = Array.from(pane.querySelectorAll('[data-gpu-block]')).filter(vis).map((e) => e.textContent).join('\n');
  return { view: pane.firstElementChild && pane.dataset.gpuView || (pane.firstElementChild || {}).dataset && pane.firstElementChild.dataset.gpuView, blocks, viewBarShown: !!bar && bar.style.display !== 'none',
    summary: (pane.querySelector('#ai-gpu-compat-summary') || {}).textContent,
    hasVariantTable: /變體競賽|套用最佳|匯出剖析/.test(visibleText), hasBenchTable: /median ms/.test(visibleText), hasFloat64: /float64/.test(visibleText), hasCpuShare: /分擔矩陣乘/.test(visibleText), hasKernelTune: /運算變體（自動調校/.test(visibleText),
    hasMainSwitch: /開啟 GPU 相容層/.test(visibleText), hasDevice: /用什麼算/.test(visibleText), hasQuickBtn: Array.from(pane.querySelectorAll('button')).some((b) => b.textContent === '跑基準' && vis(b.closest('[data-gpu-block]'))) };
};
fa.advancedSettings.engineeringMode = false; fa.advancedSettings.gpuCompatView = 'pro'; fa._renderAdvancedSettings(); await wait(300);
R.engOff_prefPro = snap();
fa.advancedSettings.engineeringMode = true; fa.advancedSettings.gpuCompatView = 'simple'; fa._renderAdvancedSettings(); await wait(300);
R.engOn_simple = snap();
Array.from(pane.querySelectorAll('#ai-gpu-compat-viewbar button')).find((b) => b.dataset.view === 'pro').click(); await wait(300);
R.engOn_clickPro = snap(); R.savedPref = fa.advancedSettings.gpuCompatView;
fa.advancedSettings.engineeringMode = false; fa._renderAdvancedSettings(); await wait(300);
R.engOff_again = snap();
return R;
