// 真桌面版（Electron）：GPU 相容層只在 AI 設定的 gpu-compat 窗格出現；桌面版設定頁沒有它；窗格內的按鈕都能用。
// 用法：node scripts/eval/mm_race_configure.run.js gpu_compat_pane（同一個執行器；不加 --disable-gpu，要真 WebGPU）。
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(100); } return null; };
const gpuPane = document.querySelector('#ai-advanced-modal .ai-advanced-pane[data-pane="gpu-compat"]');
const deskPane = document.querySelector('#ai-advanced-modal .ai-advanced-pane[data-pane="desktop-app"]') || document.querySelector('.ai-advanced-pane[data-pane="desktop-app"]');
R.gpuPaneExists = !!gpuPane;
R.desktopPaneExists = !!deskPane;
// 桌面版設定頁不得有 GPU 相容層的任何控制
R.desktopHasCompatText = !!deskPane && /GPU 相容層|開啟 GPU 相容層|float64 處理/.test(deskPane.textContent);
R.desktopHasCompatCheckbox = !!deskPane && !!deskPane.querySelector('select') && /float64/.test(deskPane.textContent);
R.desktopHasRaceButton = !!deskPane && [...deskPane.querySelectorAll('button')].some((b) => b.textContent === '重跑變體競賽');
// 窗格內全部項目都要在
const has = (t) => !!gpuPane && [...gpuPane.querySelectorAll('button, label, div, span')].some((e) => (e.textContent || '').indexOf(t) >= 0 && e.children.length <= 3);
R.items = {
  toggle: !!gpuPane && !!gpuPane.querySelector('input[type="checkbox"]'),
  float64Select: !!gpuPane && !!gpuPane.querySelector('select'),
  detectButton: !!gpuPane && [...gpuPane.querySelectorAll('button')].some((b) => b.textContent === '重新偵測'),
  benchTable: has('矩陣乘') || has('基準'),
  raceButton: !!gpuPane && [...gpuPane.querySelectorAll('button')].some((b) => b.textContent === '重跑變體競賽'),
};
// 按鈕能用：重新偵測（讀狀態列變化）
const detBtn = gpuPane ? [...gpuPane.querySelectorAll('button')].find((b) => b.textContent === '重新偵測') : null;
const leafTexts = () => (gpuPane ? [...gpuPane.querySelectorAll('div')].filter((d) => d.children.length === 0).map((d) => d.textContent) : []);
const before = leafTexts();
if (detBtn) detBtn.click();
// 偵測完成後，窗格裡的文字會變（狀態列）；記錄變了的那幾行
R.detectChanged = await until(() => { const now = leafTexts(); const diff = now.filter((t) => before.indexOf(t) < 0); return diff.length ? diff.map((t) => t.slice(0, 160)).slice(0, 4) : null; }, 30000);
// 按鈕能用：重跑變體競賽（真 GPU，約一分鐘內結束）
const raceBtn = gpuPane ? [...gpuPane.querySelectorAll('button')].find((b) => b.textContent === '重跑變體競賽') : null;
const raceWrap = raceBtn ? raceBtn.parentElement.parentElement : null;
const raceStatus = raceBtn ? raceBtn.parentElement.previousElementSibling : null;
if (raceBtn) raceBtn.click();
R.raceFinished = !!(await until(() => raceStatus && /競賽完成|已取消|沒有 GPU|競賽失敗/.test(raceStatus.textContent) && !raceBtn.disabled, 240000));
await wait(1500);
R.raceStatus = raceStatus ? raceStatus.textContent.slice(0, 300) : null;
const tbl = raceWrap && raceWrap.children[4] ? raceWrap.children[4].querySelector('table') : null;
const rows = tbl ? [...tbl.querySelectorAll('tr')].slice(1).map((tr) => [...tr.children].map((td) => td.textContent)) : [];
R.rowCount = rows.length;
R.rowsWithoutResultOrReason = rows.filter((c) => !(Number(c[2]) > 0) && !/略過/.test(c[8] || '')).map((c) => c[0] + ' ' + c[1] + ' 來源=' + c[8]);
return R;
