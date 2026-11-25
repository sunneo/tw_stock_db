// 真桌面版評測：Demucs 拆軌走 GPU 時，是否會讓顯示卡卡死（Windows DXGI_ERROR_DEVICE_HUNG，畫面變黑）。
// 評測守則：全新 --user-data-dir、一次一個、結束前確認無殘留行程、最多跑兩次。Demucs 模型約 136 MB（使用者 2026-11-25 已同意下載）。
// 注意：這個檔案會讓 GPU 跑大量工作，螢幕可能短暫變黑（正是要量的現象）；使用者會先被通知才執行。本檔只是寫好，尚未執行。
// 量：後端（cudaweb GPU／WASM）、每批提交的耗時最大值與批數（nn_ops 的 __faGpuChunkStat）、是否發生裝置遺失（__faGpuLost）、
//     最終秒數、使用的後端、沒用 GPU 的原因（notes）。上限 500 秒。
const out = { say: [], notes: [], backend: null };
let prog = ''; const T0 = Date.now();
const plog = async (t) => { prog += '[' + Math.round((Date.now() - T0) / 1000) + 's] ' + t + String.fromCharCode(10); try { await window.desktopAPI.rawfs.writeFile('E:/Temp/sephang_progress.txt', { text: prog }); } catch (_) { /* */ } };
const a = window.desktopAPI;
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
const LIMIT_MS = 500000;
function withLimit(p, label) {
  let timer = null;
  return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(label + ' 超過 500 秒上限')), LIMIT_MS); })]).finally(() => clearTimeout(timer));
}
try {
  window.fa.advancedSettings.gpuAccel = 'on';   // 使用者的環境：GPU 加速開著（只改記憶體裡的設定，不存檔）
  out.webgpu = !!navigator.gpu;
  try { globalThis.__faGpuChunkStat = { batches: 0, maxMs: 0 }; } catch (_) { /* */ }
  const t0 = Date.now();
  await plog('開始載入分軌模型（webgpu=' + out.webgpu + '）');
  const sep = await withLimit(window.fa._audioLoadSeparator((t) => {
    t = String(t).slice(0, 160);
    if (/後端/.test(t)) out.backend = t;
    if (out.say[out.say.length - 1] !== t && out.say.length < 40) { out.say.push(t); plog(t); }
  }, out.notes), '載入模型');
  await plog('載入完成 loaded=' + !!sep + ' notes=' + JSON.stringify(out.notes));
  out.loadSec = Math.round((Date.now() - t0) / 1000);
  out.loaded = !!sep;
  if (sep) {
    const full = await window.fa._decodeAudioBuffer(new Blob([b64ToBytes((await a.rawfs.readFile('C:/Users/sunneo/Desktop/midi音樂/GrandfatherClock.mp3', 'base64')).base64)]));
    const sr = full.sampleRate, n = Math.floor((sep.segmentSec || 7.8) * sr);
    const L = full.getChannelData(0).slice(sr * 20, sr * 20 + n), R = full.numberOfChannels > 1 ? full.getChannelData(1).slice(sr * 20, sr * 20 + n) : null;
    const t1 = Date.now(); await plog('開始分軌一段 ' + (sep.segmentSec || 7.8) + ' 秒');
    const st = await withLimit(sep({ left: L, right: R, sr: sr }), '分軌一段');
    await plog('分軌完成'); out.sepSec = +((Date.now() - t1) / 1000).toFixed(1);
    out.stems = Object.keys(st || {}); out.segmentSec = sep.segmentSec;
  }
} catch (e) { out.error = String((e && e.stack) || e); await plog('錯誤：' + out.error.slice(0, 300)); }
// 量測結果：每批提交的耗時最大值與批數；裝置遺失紀錄（有就代表顯示驅動逾時發生過）
try { out.chunkStat = globalThis.__faGpuChunkStat || null; } catch (_) { out.chunkStat = 'unreadable'; }
try { out.deviceLost = globalThis.__faGpuLost || null; } catch (_) { out.deviceLost = 'unreadable'; }
try { out.lostFlag = localStorage.getItem('fa_gpu_broken:audioGpuLost'); } catch (_) { out.lostFlag = 'unreadable'; }
try { out.slowFlag = localStorage.getItem('fa_gpu_broken:audioGpuSlow:demucs-6s'); } catch (_) { out.slowFlag = 'unreadable'; }
await plog('結束：後端=' + out.backend + ' 最終秒數=' + out.sepSec + ' 批數=' + (out.chunkStat && out.chunkStat.batches) + ' 單批最長毫秒=' + (out.chunkStat && Math.round(out.chunkStat.maxMs)) + ' 裝置遺失=' + !!out.deviceLost);
return out;
