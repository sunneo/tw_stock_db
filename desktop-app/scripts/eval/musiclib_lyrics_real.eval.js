// 真轉錄評測：不用假轉錄，走 app 既有的 Whisper 流程（同一個 user-data-dir 的快取裡有模型）。
// 只跑一首短音檔（音樂A 的 wav，1 秒靜音）＋一個 mp3（合成的，預期解碼失敗，原因要具體）。
const ROOT = 'E:/Temp/claude/1845096e089295dd/9a7c10bd-971c-4190-8bc3-a58c49076b0b/scratchpad/musictest';
const A = ROOT + '/音樂A_中文';
const out = { steps: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) { const end = Date.now() + (ms || 30000); while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(200); } throw new Error('等待逾時'); }
const readHead = (p, n) => window.desktopAPI.rawfs.readHead(p, n).then((r) => (r && r.base64 != null ? Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)) : null));
const btn = (p, label) => [...p.querySelectorAll('button')].find((b) => b.textContent === label);
try {
  const L = FaMusicLibHost.getLib();
  await L.ready;
  out.beforeCount = L.records.length;
  // 每次都重新掃描（檔案沒變就略過；變了就重建，歌詞跟著清掉）
  {
    const entries = (await FaMusicLibHost.walkFolder(A)).filter((e) => /\.(wav|mp3)$/i.test(e.path) && !/夜曲/.test(e.path));
    const sid = L.addSource('folder', '音樂A_中文');
    out.scan = await L.scan(sid, entries, readHead);
    await L.save();
  }
  // 只留 wav 一首進佇列（其他的先標成不做）
  L.records.forEach((r) => { if (r.name !== 'Autumn Leaves.wav') r.status = r.status; });
  window.fa._mlOpen();
  const p = await waitFor(() => { const all = document.querySelectorAll('.fml'); return all.length ? all[all.length - 1] : null; }, 15000);
  const t0 = Date.now();
  const q = L.queue;
  // 只跑 wav：原生解碼應該能直接吃（不需要 ffmpeg.wasm，也就不會出現下載同意卡片）。不替使用者按任何確認。
  const keys = L.records.filter((r) => r.name === 'Autumn Leaves.wav').map((r) => r.key);
  q.enqueue(keys);
  try { await waitFor(() => !q.state().running && q.state().queued === 0, 400000); } catch (e) { out.waitTimeout = true; }
  out.stateAfterWait = q.state();
  out.seconds = Math.round((Date.now() - t0) / 1000);
  out.records = L.records.filter((r) => keys.indexOf(r.key) >= 0).map((r) => ({ name: r.name, status: r.lyricStatus, error: r.lyricError, segments: r.lyrics ? r.lyrics.segments.length : null, durationSec: r.lyrics ? r.lyrics.durationSec : null, device: null }));
  out.panelLine = p.querySelector('.fml-lyr .fml-st').textContent.slice(0, 300);
  out.saveError = q.state().saveError;
} catch (e) {
  out.error = String((e && e.stack) || e);
}
return out;
