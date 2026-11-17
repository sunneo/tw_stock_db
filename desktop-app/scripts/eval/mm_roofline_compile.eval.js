// 真桌面版（Electron，真 GPU）：按「重跑變體競賽」→ 讀 DOM 與 TUNE.roofline，確認
//   (1) 占峰值：屋頂有量到就顯示實測峰值（不是內建表）；量不到就寫出原因
//   (2) 編譯 ms：勝者那一列有數字（其餘列是「—」）
//   (3) 核心計時：勝者的中位數是核心時間（basis = kernel-only）
// 用法：node scripts/eval/mm_race_configure.run.js mm_roofline_compile
// 結果由 [eval-file] result 那一行印出。不加 --disable-gpu（要真 WebGPU）。
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(100); } return null; };
R.hasApi = !!(fa && fa._gpuVariantPanel && fa._gpuBenchShapesList);
R.shapes = R.hasApi ? fa._gpuBenchShapesList() : [];
R.gpu = !!navigator.gpu;
const panel = R.hasApi ? fa._gpuVariantPanel() : null;
if (panel) document.body.appendChild(panel);
R.tableReady = !!(panel && await until(() => panel.children[4] && panel.children[4].querySelector('table'), 20000));
const btn = panel ? [...panel.querySelectorAll('button')].find((b) => b.textContent === '重跑變體競賽') : null;
R.hasButton = !!btn;
const statusEl = panel ? panel.children[2] : null;
const infoEl = panel ? panel.children[1] : null;
R.infoBefore = infoEl ? infoEl.textContent : null;
if (btn) btn.click();
const finalStatus = /競賽完成|已取消|沒有 GPU|競賽失敗/;
R.finished = !!(await until(() => statusEl && finalStatus.test(statusEl.textContent) && !btn.disabled, 300000));
await wait(1500);
R.statusAfter = statusEl ? statusEl.textContent : null;
// 讀表：每列 [形狀, 變體, 樣本, 中位數 ms, GFLOP/s, 占峰值, 編譯 ms, 正確性, 來源, 勝者]
const tbl = panel && panel.children[4] ? panel.children[4].querySelector('table') : null;
const rows = tbl ? [...tbl.querySelectorAll('tr')].slice(1).map((tr) => [...tr.children].map((td) => td.textContent)) : [];
R.rowCount = rows.length;
const winners = rows.filter((c) => /勝者/.test(c[9]));
R.winners = winners.map((c) => ({ shape: c[0], variant: c[1], medianMs: c[3], gflops: c[4], pctPeak: c[5], compileMs: c[6], correct: c[7] }));
R.winnerHasCompile = winners.length > 0 && winners.every((c) => /^[0-9]/.test(c[6]));
R.nonWinnerCompileDash = rows.filter((c) => !/勝者/.test(c[9])).every((c) => c[6] === '—');
R.infoAfter = infoEl ? infoEl.textContent : null;
// 屋頂：TUNE.roofline（本次競賽的量測結果）與儲存的 ROOF 鍵
const mm = fa._qwenModule ? fa._qwenModule().mm : null;
R.roofline = mm && mm.TUNE ? mm.TUNE.roofline : null;
try {
  const ents = mm && mm.TUNE && mm.TUNE.store ? await mm.TUNE.store.entries() : [];
  R.roofKeys = ents.filter((e) => String(e.key).indexOf('ROOF|') === 0).map((e) => ({ key: e.key, value: e.value }));
} catch (_) { R.roofKeys = null; }
// 占峰值的分母：有實測屋頂時表的峰值來自它，不是內建表
R.peakFromMeasured = !!(R.roofline && R.roofline.ok && /本機實測/.test(R.infoAfter || ''));
R.peakFromBuiltIn = /內建/.test(R.infoAfter || '') || /峰值：127\.5/.test(R.infoAfter || '');
if (panel) panel.remove();
return R;
