// 評測守則（使用者要求，2026-11-22；適用所有 scripts/eval/musiclib*.eval.js）：
//  1. 每次評測都用全新的 --user-data-dir（空目錄），開始時佇列與對話狀態必須是空的；不沿用上次評測留下的轉錄工作、佇列、對話。
//  2. 一次只跑一個評測；同一時間只有一個轉錄工作在跑。新評測開始前，先確認上一個 Electron 與轉錄工作都已結束或已取消。
//  3. 評測結束前呼叫 FaMusicLibHost.cancelTranscribe() 清掉自己產生的佇列，並確認沒有殘留行程（只停自己啟動的 PID）。
//  4. 面板上若有舊的卡住工作，開新評測不能與它並行，要先取消（同上，cancelTranscribe）。
//  5. 這些評測都不需要 GPU；真 Whisper 評測要先確認 Whisper 模型快取是否可用，沒有就明講「未驗證」，不下載大檔。
// 開始時的檢查（下面 out.startClean）：佇列必須空、沒有排隊或轉錄中的曲目。不符合就不算通過，要換一個全新的 user-data-dir 再跑。
// 真桌面版評測（FA_DEBUG_EVAL_FILE）：歌詞轉錄的面板流程（假轉錄函式）。
// 第一次跑（空庫）：掃描、按「轉錄歌詞」、暫停、續跑、失敗附原因、歌詞搜尋與範圍切換。
// 第二次跑（同一 user-data-dir）：狀態與歌詞還在。
const USE_FAKE = true;
const ROOT = 'E:/Temp/claude/1845096e089295dd/9a7c10bd-971c-4190-8bc3-a58c49076b0b/scratchpad/musictest';
const A = ROOT + '/音樂A_中文', B = ROOT + '/音樂B_日本';
const out = { steps: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeouts = [];
async function waitFor(fn, ms, label) { const end = Date.now() + (ms || 30000); while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(50); } let snap = null; try { snap = FaMusicLibHost.getLib().queue.state(); } catch (_) { snap = 'no state'; } timeouts.push({ label: label || 'unlabeled', state: snap, pageHasPanel: document.querySelectorAll('.fml').length }); return null; }
const readHead = (p, n) => window.desktopAPI.rawfs.readHead(p, n).then((r) => (r && r.base64 != null ? Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)) : null));
// 假轉錄：每首分 4 段（每段 150 毫秒、段與段之間檢查暫停）；song.mid 故意失敗，附具體原因
const seenFake = {};
const fake = async (rec, o) => {
  if (rec.name === 'song.mid') throw new Error('假轉錄失敗：模擬這個檔案的音訊軌損毀');
  // 卡住：報一次進展後永遠不回 → 無進展偵測應該中止，三次重試後標失敗，原因要有階段名與耗時
  if (rec.name === 'Autumn Leaves.wav') { o.report('load', { detail: '假：模型下載 3%' }); return new Promise(() => { /* 永遠不回 */ }); }
  // 暫時性失敗：第一次網路錯誤，重試後成功
  if (rec.name === '晴天.mp3' && !seenFake[rec.name]) { seenFake[rec.name] = true; throw new Error('network error: 假的網路中斷'); }
  if (o.report) o.report('decode', { detail: '假：解碼', units: 1, window: 1 });
  for (let i = 0; i < 4; i++) {
    if (o.shouldPause && o.shouldPause()) { const e = new Error('已暫停'); e.paused = true; throw e; }
    if (o.onProgress) o.onProgress(i / 4);
    await sleep(150);
  }
  return { segments: [{ start: 0, end: 2.5, text: '測試歌詞 中文 ' + rec.name.replace(/\.\w+$/, '') }, { start: 2.5, end: 5, text: 'English lyric line 來源' }], language: 'zh', durationSeconds: 5 };
};
const btn = (p, label) => [...p.querySelectorAll('button')].find((b) => b.textContent === label);
try {
  const L = FaMusicLibHost.getLib();
  await L.ready;
  out.persistent = L.persistent;
  // 評測用的縮短政策（正式值較長）：卡住約 4 秒就判定，重試等待仍是正式的 2／6／14 秒
  FaMusicLibHost.setQueuePolicy({ floorMs: 4000, factor: 2, prior: { decode: 200, load: 1000, infer: 200 } });
  out.beforeCount = L.records.length;
  out.beforeCounts = L.queue.state().counts;
  if (!L.records.length) {
    for (const folder of [A, B]) {
      const entries = await FaMusicLibHost.walkFolder(folder);
      const sid = L.addSource('folder', folder.split('/').pop());
      const rep = await L.scan(sid, entries, readHead);
      out.steps.push({ scan: folder.split('/').pop(), added: rep.added, skipped: rep.skipped });
    }
    await L.save();
  }
  out.afterScanCount = L.records.length;
  if (USE_FAKE) FaMusicLibHost.setTranscriber(fake);

  window.fa._mlOpen();
  const p = await waitFor(() => { const all = document.querySelectorAll('.fml'); return all.length ? all[all.length - 1] : null; }, 15000);
  out.lyricLine0 = p.querySelector('.fml-lyr .fml-st').textContent;

  if (out.beforeCounts.done === 0) {
    // 第一次：按轉錄（全部未完成），過一會兒按暫停，再續跑
    btn(p, '轉錄歌詞').click();
    await waitFor(() => L.queue.state().running && L.queue.state().progress != null, 10000);
    await sleep(250);
    btn(p, '暫停').click();
    await waitFor(() => !L.queue.state().running, 20000);
    const s1 = L.queue.state();
    out.paused = { paused: s1.paused, running: s1.running, counts: s1.counts, queued: s1.queued };
    out.pausedLine = p.querySelector('.fml-lyr .fml-st').textContent;
    btn(p, '續跑').click();
    await waitFor(() => !L.queue.state().running && L.queue.state().queued === 0 && !L.queue.state().paused, 300000);
    out.afterRun = L.queue.state().counts;
    out.afterRunLine = p.querySelector('.fml-lyr .fml-st').textContent;
    out.statusCells = [...p.querySelectorAll('tbody tr')].filter((tr) => tr.querySelector('td')).map((tr) => tr.lastElementChild.textContent).slice(0, 12);
    const failCell = [...p.querySelectorAll('td.bad')][0];
    out.failCell = failCell ? failCell.textContent : null;
    out.failTitle = failCell ? failCell.title : null;
  }

  // 歌詞搜尋與範圍切換
  const box = p.querySelector('input[type=search]'), sel = p.querySelector('select');
  const rowsNow = () => [...p.querySelectorAll('tbody tr')].filter((tr) => tr.querySelector('td') && !tr.classList.contains('fml-hit')).length;
  const hitLines = () => [...p.querySelectorAll('tr.fml-hit')].map((tr) => tr.textContent);
  box.value = 'English lyric'; box.dispatchEvent(new Event('input'));
  out.searchAllRows = rowsNow(); out.searchAllHits = hitLines().slice(0, 4);
  sel.value = 'meta'; sel.dispatchEvent(new Event('change'));
  out.searchMetaRows = rowsNow();
  sel.value = 'lyrics'; sel.dispatchEvent(new Event('change'));
  out.searchLyricsRows = rowsNow();
  box.value = '晴天'; box.dispatchEvent(new Event('input'));
  out.searchNameWithLyricsScope = rowsNow();
  sel.value = 'all'; sel.dispatchEvent(new Event('change'));
  out.searchNameAll = rowsNow(); out.searchNameAllHits = hitLines().slice(0, 2);
  box.value = ''; box.dispatchEvent(new Event('input'));
} catch (e) {
  out.error = String((e && e.stack) || e);
}
out.timeouts = timeouts;
try { if (typeof FaMusicLibHost !== 'undefined') { FaMusicLibHost.cancelTranscribe(); out.endCancelled = true; } } catch (_) { /* */ }
return out;
