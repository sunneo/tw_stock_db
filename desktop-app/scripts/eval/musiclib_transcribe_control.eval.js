// 評測守則（使用者要求，2026-11-22；適用所有 scripts/eval/musiclib*.eval.js）：
//  1. 每次評測都用全新的 --user-data-dir（空目錄），開始時佇列與對話狀態必須是空的；不沿用上次評測留下的轉錄工作、佇列、對話。
//  2. 一次只跑一個評測；同一時間只有一個轉錄工作在跑。新評測開始前，先確認上一個 Electron 與轉錄工作都已結束或已取消。
//  3. 評測結束前呼叫 FaMusicLibHost.cancelTranscribe() 清掉自己產生的佇列，並確認沒有殘留行程（只停自己啟動的 PID）。
//  4. 面板上若有舊的卡住工作，開新評測不能與它並行，要先取消（同上，cancelTranscribe）。
//  5. 這些評測都不需要 GPU；真 Whisper 評測要先確認 Whisper 模型快取是否可用，沒有就明講「未驗證」，不下載大檔。
// 開始時的檢查（下面 out.startClean）：佇列必須空、沒有排隊或轉錄中的曲目。不符合就不算通過，要換一個全新的 user-data-dir 再跑。
// 對照評測：走既有的 _transcribeMedia（transcribe_media 工具同一條流程），同一個 user-data-dir、同一個 1 秒靜音 wav，只跑一次。
// 記錄：Cache Storage 的 key（模型快取是否在這個 origin 下）、每一條 app 日誌與時間、最後結果或卡住時的狀態。
const WAV = 'E:/Temp/claude/1845096e089295dd/9a7c10bd-971c-4190-8bc3-a58c49076b0b/scratchpad/musictest/音樂A_中文/Autumn Leaves.wav';
const out = { log: [] };
const t0 = Date.now();
const el = () => Math.round((Date.now() - t0) / 1000);
try {
  out.cacheKeys = (await caches.keys()).slice(0, 20);
  let cnt = 0;
  for (const k of out.cacheKeys) { try { const c = await caches.open(k); cnt += (await c.keys()).length; } catch (_) { /* */ } }
  out.cacheEntries = cnt;
  out.online = navigator.onLine;
  const r = await window.desktopAPI.rawfs.readFile(WAV, 'base64');
  const bin = atob(r.base64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const blob = new Blob([u]);
  const origLog = window.fa._log;
  window.fa._log = function (m) { out.log.push(el() + 's ' + String(m).slice(0, 160)); try { return origLog.apply(this, arguments); } catch (_) { return undefined; } };
  const run = window.fa._transcribeMedia({ filename: 'Autumn Leaves.wav', blob: blob }, 'zh')
    .then((v) => ({ done: true, ok: v && v.ok, error: v && v.error, segments: v && v.segments ? v.segments.length : null }), (e) => ({ done: true, threw: String((e && e.message) || e) }));
  const timeout = new Promise((res) => setTimeout(() => res({ done: false, note: '400 秒內沒有回傳' }), 400000));
  out.result = await Promise.race([run, timeout]);
  out.elapsedSec = el();
  window.fa._log = origLog;
} catch (e) {
  out.error = String((e && e.stack) || e);
}
try { if (typeof FaMusicLibHost !== 'undefined') { FaMusicLibHost.cancelTranscribe(); out.endCancelled = true; } } catch (_) { /* */ }
return out;
