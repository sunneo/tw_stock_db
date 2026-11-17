// 真桌面版（Electron）：GPU 設定只在 AI 助理設定 → 「GPU 相容層（numba／cupy／torch）」窗格；其他地方不再有 GPU 設定；按鈕與下拉都能用。
// 用法：node scripts/eval/mm_race_configure.run.js gpu_settings_pane（同一個執行器；不加 --disable-gpu，要真 WebGPU）。
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(100); } return null; };
const pane = (k) => document.querySelector('#ai-advanced-modal .ai-advanced-pane[data-pane="' + k + '"]') || document.querySelector('.ai-advanced-pane[data-pane="' + k + '"]');
const deskPane = pane('desktop-app'), gpuPane = pane('gpu-compat');
// ── 桌面版設定頁：沒有 GPU 區塊；原本的項目還在
const deskText = deskPane ? deskPane.textContent : '';
R.desktop = {
  exists: !!deskPane,
  gpuMatches: (deskText.match(/GPU[^\n]{0,24}|float64[^\n]{0,12}|numba|cupy|重新偵測/g) || []).slice(0, 5),
  hasTray: deskText.indexOf('系統匣') >= 0,
  hasWorkDir: deskText.indexOf('工作區資料夾') >= 0,
};
// ── GPU 相容層窗格：全部項目
const gText = gpuPane ? gpuPane.textContent : '';
const btn = (t) => !!gpuPane && [...gpuPane.querySelectorAll('button')].some((b) => b.textContent === t);
const sels = gpuPane ? [...gpuPane.querySelectorAll('select')] : [];
const offSel = sels.find((s) => [...s.options].some((o) => o.value === 'gpu') && [...s.options].some((o) => o.value === 'cpu'));
const imgSel = sels.find((s) => [...s.options].some((o) => o.value === 'webgpu'));
R.gpu = {
  exists: !!gpuPane,
  cudaCompatCheckbox: !!gpuPane && [...gpuPane.querySelectorAll('label')].some((l) => l.textContent.indexOf('開啟 GPU 相容層') >= 0),
  float64: !!gpuPane && sels.some((s) => [...s.options].some((o) => o.value === 'exact')),
  gpuAccelCheckbox: !!gpuPane && [...gpuPane.querySelectorAll('label')].some((l) => l.textContent.indexOf('GPU 加速（預設開）') >= 0),
  advancedSummary: !!gpuPane && [...gpuPane.querySelectorAll('summary')].some((s) => s.textContent.indexOf('進階：個別路徑強制開啟') >= 0),
  offlineDeviceSelect: !!offSel, imageDeviceSelect: !!imgSel,
  detectButton: btn('重新偵測'), benchButton: btn('重跑'), raceButton: btn('重跑變體競賽'),
  benchTable: gText.indexOf('矩陣乘') >= 0,
};
// 進階區塊展開後才看得到的項目：先把 details 打開，讀各路徑的核取方塊
const det = gpuPane ? gpuPane.querySelector('details') : null; if (det) det.open = true;
R.gpu.advancedCheckboxes = gpuPane ? [...gpuPane.querySelectorAll('details label')].map((l) => l.textContent.slice(0, 18)).slice(0, 14) : [];
// ── 其他地方只顯示狀態
const offPane = pane('offline-models'), whisperStatus = document.getElementById('ai-whisper-device-status'), imgStatus = document.getElementById('ai-imgcfg-device-status');
R.models = {
  offlinePaneHasDeviceSelect: !!(offPane && offPane.querySelector('select[data-om-set="device"]')),
  offlineStatusText: offPane && /偏好：/.test(offPane.textContent) ? (offPane.textContent.match(/偏好：[^（]{0,20}/) || [''])[0] : null,
  whisperStatus: whisperStatus ? whisperStatus.textContent.slice(0, 60) : null,
  imageStatus: imgStatus ? imgStatus.textContent.slice(0, 60) : null,
};
// ── 下拉能用：改成 CPU → 儲存鍵變、離線模型頁狀態跟著變；改回 GPU
const before = fa.advancedSettings.offlineDevicePreference, beforeW = fa.advancedSettings.whisperDevicePreference;
if (offSel) { offSel.value = 'cpu'; offSel.dispatchEvent(new Event('change')); }
R.offlineChangeToCpu = { stored: fa.advancedSettings.offlineDevicePreference, whisperStored: fa.advancedSettings.whisperDevicePreference };
R.offlinePaneAfterCpu = await until(() => { const p = pane('offline-models'); return p && /偏好：CPU/.test(p.textContent) ? 'CPU' : null; }, 5000);
if (offSel) { offSel.value = 'gpu'; offSel.dispatchEvent(new Event('change')); }
R.offlineRestored = fa.advancedSettings.offlineDevicePreference;
R.beforeOffline = before; R.beforeWhisper = beforeW;
// 生圖下拉
const beforeImg = (fa.advancedSettings.imageGen || {}).localDevice;
if (imgSel) { imgSel.value = 'cpu'; imgSel.dispatchEvent(new Event('change')); }
R.imageChangeToCpu = (fa.advancedSettings.imageGen || {}).localDevice;
R.imageKeepsOtherFields = !!(fa.advancedSettings.imageGen && 'model' in fa.advancedSettings.imageGen);
if (imgSel) { imgSel.value = beforeImg === 'webgpu' || beforeImg === 'cpu' ? beforeImg : 'auto'; imgSel.dispatchEvent(new Event('change')); }
// 重新偵測：窗格內文字會變
const detBtn = gpuPane ? [...gpuPane.querySelectorAll('button')].find((b) => b.textContent === '重新偵測') : null;
const leafTexts = () => (gpuPane ? [...gpuPane.querySelectorAll('div')].filter((d) => d.children.length === 0).map((d) => d.textContent) : []);
const snap = leafTexts();
if (detBtn) detBtn.click();
R.detectChanged = await until(() => { const diff = leafTexts().filter((t) => snap.indexOf(t) < 0); return diff.length ? diff.length : null; }, 30000);
return R;
