// 評測守則（使用者要求，2026-11-22；適用所有 scripts/eval/musiclib*.eval.js）：
//  1. 每次評測都用全新的 --user-data-dir（空目錄），開始時佇列與對話狀態必須是空的；不沿用上次評測留下的轉錄工作、佇列、對話。
//  2. 一次只跑一個評測；同一時間只有一個轉錄工作在跑。新評測開始前，先確認上一個 Electron 與轉錄工作都已結束或已取消。
//  3. 評測結束前呼叫 FaMusicLibHost.cancelTranscribe() 清掉自己產生的佇列，並確認沒有殘留行程（只停自己啟動的 PID）。
//  4. 面板上若有舊的卡住工作，開新評測不能與它並行，要先取消（同上，cancelTranscribe）。
//  5. 這些評測都不需要 GPU；真 Whisper 評測要先確認 Whisper 模型快取是否可用，沒有就明講「未驗證」，不下載大檔。
// 開始時的檢查（下面 out.startClean）：佇列必須空、沒有排隊或轉錄中的曲目。不符合就不算通過，要換一個全新的 user-data-dir 再跑。
// 真桌面版評測（FA_DEBUG_EVAL_FILE）：音樂庫的加資料夾、掃描、搜尋、畫面、重開後資料還在。
// 執行環境：renderer 內的 async 函式本體，可以用 window.fa、window.desktopAPI、FaMusicLibHost、FaMusicLibUI。
const ROOT = 'E:/Temp/claude/1845096e089295dd/9a7c10bd-971c-4190-8bc3-a58c49076b0b/scratchpad/musictest';
const A = ROOT + '/音樂A_中文', B = ROOT + '/音樂B_日本';
const out = { steps: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const L = FaMusicLibHost.getLib();
  await L.ready;
  out.persistent = L.persistent;
  out.loadError = L.loadError ? String(L.loadError.message || L.loadError) : null;
  out.beforeCount = L.records.length;
  out.beforeSources = L.sources.map((s) => s.label);

  // 加資料夾：嘗試用真的資料夾瀏覽器的路徑（把 browse 換成回傳測試資料夾；若 contextBridge 物件不允許改，就退回直接走訪）
  const roots = window.desktopAPI.roots;
  const origBrowse = roots.browse;
  let picked = [];
  for (const folder of [A, B]) {
    try { roots.browse = async () => folder; } catch (e) { out.patchErr = String(e); }
    const patched = roots.browse !== origBrowse;
    let src;
    if (patched) src = await FaMusicLibHost.pickFolder();
    else {
      const entries = await FaMusicLibHost.walkFolder(folder);
      src = { label: folder.split('/').pop(), entries, readHead: (p, n) => window.desktopAPI.rawfs.readHead(p, n).then((r) => (r && r.base64 != null ? Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)) : null)) };
    }
    picked.push({ folder: folder.split('/').pop(), patched, walked: src ? src.entries.length : null, paths: src ? src.entries.map((e) => e.path.split('/').slice(-2).join('/')) : [] });
    const sid = L.addSource('folder', src.label);
    const rep = await L.scan(sid, src.entries, src.readHead);
    picked[picked.length - 1].report = rep;
  }
  roots.browse = origBrowse;
  await L.save();
  out.picked = picked;
  out.afterCount = L.records.length;
  out.records = L.records.map((r) => ({ name: r.name, album: r.album, albumSource: r.albumSource, title: r.title, artist: r.artist, kind: r.kind, dur: r.durationSec == null ? null : Math.round(r.durationSec * 100) / 100, pending: r.pending }));

  const names = (q) => L.search(q).map((x) => x.record.name);
  out.search = {
    '晴天': names('晴天'), 'autumn': names('autumn'), '葉惠美': names('葉惠美'), '夜曲': names('夜曲'),
    'さくら': names('さくら'), '周杰倫 晴天': names('周杰倫 晴天'), '周杰倫 autumn': names('周杰倫 autumn'), 'jazz': names('jazz')
  };

  // 畫面：開音樂庫面板（對話裡一則訊息），檢查清單與搜尋框
  window.fa._mlOpen();
  await sleep(1200);
  const panels = document.querySelectorAll('.fml');
  out.panelCount = panels.length;
  const p = panels[panels.length - 1];
  if (p) {
    out.rowsAll = p.querySelectorAll('.fml-tbl tbody tr').length;
    out.stat = p.querySelector('.fml-st') ? p.querySelector('.fml-st').textContent : null;
    const box = p.querySelector('input[type=search]');
    box.value = '晴天'; box.dispatchEvent(new Event('input'));
    out.rowsSearch晴天 = p.querySelectorAll('.fml-tbl tbody tr').length;
    box.value = ''; box.dispatchEvent(new Event('input'));
  }
} catch (e) {
  out.error = String((e && e.stack) || e);
}
try { if (typeof FaMusicLibHost !== 'undefined') { FaMusicLibHost.cancelTranscribe(); out.endCancelled = true; } } catch (_) { /* */ }
return out;
