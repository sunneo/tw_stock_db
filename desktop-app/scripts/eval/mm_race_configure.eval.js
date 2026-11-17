// 真桌面版（Electron，真 GPU）：Configure 的「GPU 變體競賽」表 → 按「重跑變體競賽」→ 讀 DOM 確認表的每一列都有結果或明確的略過原因。
// 用法：node scripts/eval/mm_race_configure.run.js（獨立使用者資料夾、換埠、停用覆蓋；不加 --disable-gpu，否則沒有 WebGPU）。
// 結果由 [eval-file] result 那一行印出。
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(100); } return null; };
R.hasApi = !!(fa && fa._gpuVariantPanel && fa._gpuBenchShapesList);
R.shapes = R.hasApi ? fa._gpuBenchShapesList() : [];
R.gpu = !!navigator.gpu;
const panel = R.hasApi ? fa._gpuVariantPanel() : null;
if (panel) document.body.appendChild(panel);
// 面板的表是非同步畫出來的
R.tableReady = !!(panel && await until(() => panel.children[4] && panel.children[4].querySelector('table'), 20000));
const btn = panel ? [...panel.querySelectorAll('button')].find((b) => b.textContent === '重跑變體競賽') : null;
R.hasButton = !!btn;
const statusEl = panel ? panel.children[2] : null;
R.statusBefore = statusEl ? statusEl.textContent : null;
if (btn) btn.click();
// 等競賽結束（狀態列不再是「變體競賽中」，且表已重畫）
const finalStatus = /競賽完成|已取消|沒有 GPU|競賽失敗/;
R.finished = !!(await until(() => statusEl && finalStatus.test(statusEl.textContent) && !btn.disabled, 240000));
await wait(1500);
R.statusAfter = statusEl ? statusEl.textContent : null;
R.progressSeen = null;
// 讀表：每列 [形狀, 變體, 樣本, 中位數, GFLOP/s, 占峰值, 編譯, 正確性, 來源, 勝者]
const tbl = panel && panel.children[4] ? panel.children[4].querySelector('table') : null;
const rows = tbl ? [...tbl.querySelectorAll('tr')].slice(1).map((tr) => [...tr.children].map((td) => td.textContent)) : [];
R.rowCount = rows.length;
R.rows = rows.map((c) => ({ shape: c[0], variant: c[1], samples: c[2], correct: c[7], source: c[8], winner: c[9] }));
// 每列的判斷：有樣本（本機實測）或來源欄寫了略過原因，才算「有結果或略過原因」
R.rowsWithoutResultOrReason = R.rows.filter((r) => !(Number(r.samples) > 0) && !/略過/.test(r.source)).map((r) => r.shape + ' ' + r.variant + ' 來源=' + r.source);
R.shapesCovered = R.shapes.map((s) => ({ shape: s, rows: R.rows.filter((r) => r.shape === s).length }));
R.shapesMissingRows = R.shapesCovered.filter((x) => x.rows === 0).map((x) => x.shape);
R.summary = panel && panel.children[4] ? (panel.children[4].querySelector('.ai-advanced-hint') || {}).textContent || null : null;
// 收尾：拆掉面板
if (panel) panel.remove();
return R;
