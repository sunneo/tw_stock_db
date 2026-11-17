// G5 實機驗證（真 Electron，獨立 --user-data-dir，換埠）：變體競賽面板 fa._gpuVariantPanel() 的 DOM 與按鈕行為。
// 用法見 docs/HANDOFF.cudaweb-optimize.md 第九段：FA_DEBUG_EVAL_FILE=<此檔絕對路徑> FA_DISABLE_MAIN_OVERLAY=1 FA_BROWSER_CONTROL_PORT=<非 17923 的埠>，
// 參數 <desktop-app> --no-sandbox --disable-gpu --user-data-dir=<新暫存資料夾>，並先在該資料夾寫入 main-ext-rev.txt（內容＝main-ext.js 的 REV）。
// 結果：標準輸出的 [eval-file] result 行。
const fa = window.fa;
const R = { loaded: {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { /* */ } await wait(150); } return null; };
R.loaded.hasPanel = typeof fa._gpuVariantPanel === 'function';
R.loaded.hasBenchPanel = typeof fa._gpuBenchPanel === 'function';
R.loaded.scripts = Array.from(document.scripts).map((s) => s.src || '(inline)').filter((s) => /floating|renderer/.test(s)).slice(0, 6);
const host = document.createElement('div'); host.id = 'g5-eval-host'; host.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:600px;overflow:auto;z-index:99999;background:#fff;color:#000;';
document.body.appendChild(host);
let panel = null;
try {
  panel = fa._gpuVariantPanel();
  host.appendChild(panel);
  // 等非同步的 render() 結束（它會讀 adapter 與 IndexedDB）
  await until(() => panel.querySelector('table') && panel.querySelector('table').rows.length >= 2, 15000);
  await wait(500);
  const tbl = panel.querySelector('table');
  R.table = { rows: tbl ? tbl.rows.length : 0, header: tbl ? Array.from(tbl.rows[0].cells).map((c) => c.textContent) : [], sampleRows: tbl ? Array.from(tbl.rows).slice(1, 4).map((r) => Array.from(r.cells).map((c) => c.textContent)) : [] };
  const infoEl = panel.children[1], statusEl = panel.children[2];
  R.info = infoEl ? infoEl.textContent : null;
  R.statusBefore = statusEl ? statusEl.textContent : null;
  const btn = (t) => Array.from(panel.querySelectorAll('button')).find((b) => b.textContent.trim() === t);
  R.buttons = Array.from(panel.querySelectorAll('button')).map((b) => b.textContent.trim());
  // 按「套用最佳」：只讀 IndexedDB 的勝者，不會開 GPU 量測
  btn('套用最佳').click(); await until(() => /已把儲存的勝者|套用失敗/.test(statusEl.textContent), 10000); await wait(300);
  R.applyStatus = statusEl.textContent;
  // 按「匯出剖析」：文字框應出現 JSON
  btn('匯出剖析').click(); await until(() => /已匯出|匯出失敗/.test(statusEl.textContent), 10000); await wait(300);
  const ta = panel.querySelector('textarea');
  R.exportStatus = statusEl.textContent;
  R.exportJsonHead = ta && ta.value ? ta.value.slice(0, 160) : null;
  // 匯入一份不合法的 JSON：應回報失敗，且不改動儲存的剖析
  if (ta) { ta.value = '{壞掉'; } btn('匯入剖析').click(); await until(() => /匯入失敗/.test(statusEl.textContent), 5000); R.badImportStatus = statusEl.textContent;
  // 匯入 heuristic 筆：應被拒絕
  if (ta) { ta.value = JSON.stringify({ schema: 1, entries: [{ sig: 'x', op: 'matmul', shape: '*', source: 'heuristic', ranking: ['a'], basis: 'x' }] }); }
  btn('匯入剖析').click(); await until(() => /匯入失敗/.test(statusEl.textContent), 5000); R.heuristicImportStatus = statusEl.textContent;
  // 恢復預設：清掉本機匯入與勝者（只清這個面板的資料）
  btn('恢復預設').click(); await until(() => /已恢復預設/.test(statusEl.textContent), 10000); R.resetStatus = statusEl.textContent;
} catch (e) {
  R.error = String((e && e.stack) || e);
} finally {
  host.remove();
}
R.ok = !R.error && R.table && R.table.rows >= 2;
return R;
