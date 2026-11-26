// 評測：Demucs 在 cudaweb WebGPU 圖形 session 上的逐段耗時（首次含編譯／權重上傳，第二次為暖機後）。
// 守則：全新 --user-data-dir、一次一個、結束前確認無殘留行程、最多跑兩次。樣本：GrandfatherClock.mp3 第 20 秒起一段。
// 量：GPU adapter 資訊與 limits、載入耗時、第一段與第二段推論牆鐘時間、輸出 stem 數。
const out = { notes: [] };
const T0 = Date.now();
const a = window.desktopAPI;
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
const save = async () => { try { await a.rawfs.writeFile('E:/Temp/audio_gpu_profile.json', { text: JSON.stringify(out, null, 2) }); } catch (_) { /* */ } };
try {
  window.fa.advancedSettings.gpuAccel = 'on';   // 只改記憶體內的設定，不存檔
  out.webgpu = !!navigator.gpu;
  if (navigator.gpu) {
    const ad = await navigator.gpu.requestAdapter();
    const info = ad && (ad.info || {});
    out.adapter = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description };
    const lim = ad ? ad.limits : {};
    out.limits = {
      maxComputeInvocationsPerWorkgroup: lim.maxComputeInvocationsPerWorkgroup,
      maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize,
      maxComputeWorkgroupSizeX: lim.maxComputeWorkgroupSizeX,
      maxBufferSize: lim.maxBufferSize,
    };
    out.features = ad ? Array.from(ad.features).filter((f) => /f16|subgroup/.test(f)) : [];
  }
  // 先前的「太慢」旗標（localStorage fa_gpu_broken:audioGpuSlow:*）會讓 GPU 路徑直接略過，這次量測的 GPU 數字就不是 GPU。
  // 只在記憶體內忽略這類旗標（不清 localStorage，不動使用者實際的設定）。
  const origGet = window.fa._gpuBrokenGet.bind(window.fa);
  window.fa._gpuBrokenGet = (f) => (String(f).indexOf('audioGpuSlow:') === 0 ? null : origGet(f));
  out.ignoredSlowFlagInMemory = true;
  const tL = Date.now();
  const sep = await window.fa._audioLoadSeparator((t) => { /* 進度只記錄，不寫檔 */ }, out.notes);
  out.loadSec = +((Date.now() - tL) / 1000).toFixed(1);
  out.loaded = !!sep;
  if (sep) {
    const mp3 = await a.rawfs.readFile('C:/Users/sunneo/Desktop/midi音樂/GrandfatherClock.mp3', 'base64');
    const full = await window.fa._decodeAudioBuffer(new Blob([b64ToBytes(mp3.base64)]));
    const sr = full.sampleRate, n = Math.floor((sep.segmentSec || 7.8) * sr);
    const L = full.getChannelData(0).slice(sr * 20, sr * 20 + n);
    const R = full.numberOfChannels > 1 ? full.getChannelData(1).slice(sr * 20, sr * 20 + n) : null;
    out.runs = [];
    for (let i = 0; i < 2; i++) {
      const t1 = Date.now();
      const st = await sep({ left: L.slice(), right: R ? R.slice() : null, sr: sr });
      out.runs.push({ run: i + 1, sec: +((Date.now() - t1) / 1000).toFixed(2), stems: Object.keys(st || {}) });
      await save();
    }
    out.segmentSec = sep.segmentSec;
  }
} catch (e) { out.error = String((e && e.stack) || e); }
try { out.slowFlag = localStorage.getItem('fa_gpu_broken:audioGpuSlow:demucs-6s'); } catch (_) { out.slowFlag = 'unreadable'; }
out.totalSec = +((Date.now() - T0) / 1000).toFixed(1);
await save();
return out;
