// YouTube 下載「只驗證解析影片資訊」（真實 Electron；不下載媒體檔）。
// 用法：FA_DEBUG_EVAL_FILE=<本檔絕對路徑> FA_DISABLE_MAIN_OVERLAY=1 FA_BROWSER_CONTROL_PORT=<非17923> electron <desktop-app> --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
// 影片編號由環境不傳，直接寫在下面 IDS；結果在標準輸出的 [eval-file] result。
const fa = window.fa; const R = { loaded: [...document.scripts].map((s) => s.src).filter((s) => /floating-assistant/.test(s)), hasNet: typeof FaYtNet, per: [] };
const IDS = ['Jsw5U9sBeps', 'dQw4w9WgXcQ', 'jNQXAC9IVRw'];
const t0all = Date.now(); const lg = (m) => console.log('[ytparse ' + ((Date.now() - t0all) / 1000).toFixed(1) + 's] ' + m);
const SENT = 'EVAL_STOP_AFTER_PARSE';
let seen = null;
fa._downloadBinaryWithProgress = async (url) => { seen = (() => { try { const u = new URL(url); return u.hostname + ' clen=' + u.searchParams.get('clen'); } catch (_) { return '?'; } })(); throw new Error(SENT); };
lg('載入yt-dlp環境…');
try { await Promise.race([fa._ensureYtDlpLoaded(), new Promise((_, rj) => setTimeout(() => rj(new Error('載入逾時240秒')), 240000))]); lg('環境已載入'); } catch (e) { R.loadError = String(e && e.message || e); lg(R.loadError); return R; }
for (const id of IDS) {
  lg('解析 ' + id);
  seen = null; const t0 = Date.now();
  try { await fa._youtubeDownloadOne(id, true, async () => {}); R.per.push({ id, ok: 'unexpected', ms: Date.now() - t0 }); }
  catch (e) {
    const m = String(e && e.message || e);
    R.per.push({ id, parsed: m === SENT, firstMediaUrl: seen, ms: Date.now() - t0, err: m === SENT ? null : m.slice(0, 1800), trace: fa._ytNetTraceArr });
  }
}
return R;
