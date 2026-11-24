// 評測守則：全新 --user-data-dir、一次一個、結束前確認無殘留行程、最多跑兩次。Demucs 模型約 136 MB（使用者 2026-11-25 已同意下載）。
// 拆軌的後端選擇：開了「GPU 加速」（gpuAccel）後，Demucs 應走 cudaweb GPU 圖形 session，而不是開機後第一次就退到 CPU。
// 量：載入模型的訊息（哪個後端）、分一段音訊的秒數、沒用 GPU 的原因（notes）。
const out = { say: [], notes: [] };
let prog = ''; const T0 = Date.now();
const plog = async (t) => { prog += '[' + Math.round((Date.now() - T0) / 1000) + 's] ' + t + String.fromCharCode(10); try { await window.desktopAPI.rawfs.writeFile('E:/Temp/sepgpu_progress.txt', { text: prog }); } catch (_) { /* */ } };
const a = window.desktopAPI;
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
try {
  window.fa.advancedSettings.gpuAccel = 'on';   // 使用者的環境：GPU 加速開著（只改記憶體裡的設定，不存檔）
  out.webgpu = !!navigator.gpu;
  const t0 = Date.now();
  await plog('開始載入分軌模型（webgpu=' + out.webgpu + '）');
  const sep = await window.fa._audioLoadSeparator((t) => { t = String(t).slice(0, 160); if (out.say[out.say.length - 1] !== t && out.say.length < 40) { out.say.push(t); plog(t); } }, out.notes);
  await plog('載入完成 loaded=' + !!sep + ' notes=' + JSON.stringify(out.notes));
  out.loadSec = Math.round((Date.now() - t0) / 1000);
  out.loaded = !!sep;
  if (sep) {
    const full = await window.fa._decodeAudioBuffer(new Blob([b64ToBytes((await a.rawfs.readFile('C:/Users/sunneo/Desktop/midi音樂/GrandfatherClock.mp3', 'base64')).base64)]));
    const sr = full.sampleRate, n = Math.floor((sep.segmentSec || 7.8) * sr);
    const L = full.getChannelData(0).slice(sr * 20, sr * 20 + n), R = full.numberOfChannels > 1 ? full.getChannelData(1).slice(sr * 20, sr * 20 + n) : null;
    const t1 = Date.now(); await plog('開始分軌一段 ' + (sep.segmentSec || 7.8) + ' 秒');
    const st = await sep({ left: L, right: R, sr: sr });
    await plog('分軌完成'); out.sepSec = +((Date.now() - t1) / 1000).toFixed(1);
    out.stems = Object.keys(st || {}); out.segmentSec = sep.segmentSec;
  }
} catch (e) { out.error = String((e && e.stack) || e); }
return out;
