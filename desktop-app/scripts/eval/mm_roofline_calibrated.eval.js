// 真桌面版（Electron，真 GPU）：驗證「安全校準」的屋頂量測（不是再量屋頂峰值），並找出 64×1024×1024 沒有勝者的原因。
// 做一次「重跑變體競賽」，然後回報：
//   (1) TUNE.roofline：校準結果（迭代數、每次派發毫秒數）或「屋頂量測不可信」的原因（中止條件是任何派發 > 150 ms，見 mm_ops.js 的 rooflineCalibrate）
//   (2) 每個形狀的候選：驗證不過（bad）與預估逾時略過（skipped）的逐一原因
//   (3) 狀態列與表格的勝者
// 用法：node scripts/eval/mm_race_configure.run.js mm_roofline_calibrated
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(100); } return null; };
R.hasApi = !!(fa && fa._gpuVariantPanel && fa._gpuBenchShapesList);
R.gpu = !!navigator.gpu;
const panel = R.hasApi ? fa._gpuVariantPanel() : null;
if (panel) document.body.appendChild(panel);
R.tableReady = !!(panel && await until(() => panel.children[4] && panel.children[4].querySelector('table'), 20000));
const btn = panel ? [...panel.querySelectorAll('button')].find((b) => b.textContent === '重跑變體競賽') : null;
R.hasButton = !!btn;
const statusEl = panel ? panel.children[2] : null;
if (btn) btn.click();
const finalStatus = /競賽完成|已取消|沒有 GPU|競賽失敗/;
R.finished = !!(await until(() => statusEl && finalStatus.test(statusEl.textContent) && !btn.disabled, 300000));
await wait(1500);
R.statusAfter = statusEl ? statusEl.textContent : null;
const mm = fa._qwenModule ? fa._qwenModule().mm : null;
R.roofline = mm && mm.TUNE ? mm.TUNE.roofline : null;
// 每個形狀的逐一原因（來自 UI 記下的競賽結果）
const last = fa._gpuRaceLast || {};
R.raceLast = Object.keys(last).map((k) => ({ shape: k, error: last[k].error || null, bad: last[k].bad || [], skipped: last[k].skipped || [] }));
// 表格的勝者與來源欄
const tbl = panel && panel.children[4] ? panel.children[4].querySelector('table') : null;
const rows = tbl ? [...tbl.querySelectorAll('tr')].slice(1).map((tr) => [...tr.children].map((td) => td.textContent)) : [];
R.rowCount = rows.length;
R.winners = rows.filter((c) => /勝者/.test(c[9])).map((c) => ({ shape: c[0], variant: c[1], medianMs: c[3], gflops: c[4], compileMs: c[6] }));
R.rowSources = rows.map((c) => c[0] + ' ' + c[1] + ' → ' + c[8]);
const info = panel && panel.children[1] ? panel.children[1].textContent : null;
R.infoAfter = info;
if (panel) panel.remove();
return R;
