// 評測 2：Demucs GPU（cudaweb 圖形引擎）整段跑完，看門狗只在記憶體內放寬（不存檔），逐運算類型計時（量測鉤子 globalThis.__FA_OP_TIMING）。
// 守則：全新 --user-data-dir、一次一個、最多跑兩次、結束確認無殘留。樣本：GrandfatherClock.mp3 第 20 秒起 7.8 秒。
// 量：第一段（含編譯／權重上傳）與第二段（暖機後）的牆鐘時間、各運算類型的次數與毫秒、每軌取樣前 4000 點（給和 WASM 比數值）。
const out = { notes: [] };
const T0 = Date.now();
const a = window.desktopAPI;
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
const save = async () => { try { await a.rawfs.writeFile('E:/Temp/audio_gpu_profile2.json', { text: JSON.stringify(out) }); } catch (_) { /* */ } };
// 看門狗（floating-assistant.js 的 _audioGpuSession）用 setTimeout(…, 150000)；這裡只在評測頁面內把這個值放大，不改來源、不存檔
const origST = window.setTimeout.bind(window);
window.setTimeout = (fn, ms, ...rest) => origST(fn, ms === 150000 ? 1e9 : ms, ...rest);
try {
  window.fa.advancedSettings.gpuAccel = 'on';   // 只改記憶體內的設定
  // 先前的「太慢」旗標只在記憶體內忽略（不清 localStorage）
  const origGet = window.fa._gpuBrokenGet.bind(window.fa);
  window.fa._gpuBrokenGet = (f) => (String(f).indexOf('audioGpuSlow:') === 0 ? null : origGet(f));
  out.ignoredSlowFlagInMemory = true; out.watchdogRelaxedInMemory = true;
  if (navigator.gpu) {
    const ad = await navigator.gpu.requestAdapter();
    const info = ad && (ad.info || {});
    out.adapter = { vendor: info.vendor, architecture: info.architecture };
    const lim = ad ? ad.limits : {};
    out.limits = { maxComputeInvocationsPerWorkgroup: lim.maxComputeInvocationsPerWorkgroup, maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize, maxComputeWorkgroupSizeX: lim.maxComputeWorkgroupSizeX };
  }
  const tL = Date.now();
  const sep = await window.fa._audioLoadSeparator(() => {}, out.notes);
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
      globalThis.__FA_OP_TIMING = {};
      const t1 = Date.now();
      const st = await sep({ left: L.slice(), right: R ? R.slice() : null, sr: sr });
      const sec = +((Date.now() - t1) / 1000).toFixed(2);
      const ops = globalThis.__FA_OP_TIMING; globalThis.__FA_OP_TIMING = undefined;
      const samples = {}; for (const k of Object.keys(st || {})) { const arr = st[k] && st[k].length !== undefined ? st[k] : (st[k] && st[k].data) || []; samples[k] = Array.from(arr.slice(0, 4000)); }
      out.runs.push({ run: i + 1, sec: sec, ops: ops, stems: Object.keys(st || {}), samples: samples });
      await save();
    }
    out.segmentSec = sep.segmentSec;
  }
} catch (e) { out.error = String((e && e.stack) || e); }
out.totalSec = +((Date.now() - T0) / 1000).toFixed(1);
await save();
return { done: true, error: out.error || null, loaded: out.loaded, runs: (out.runs || []).map((r) => ({ run: r.run, sec: r.sec, ops: r.ops, stems: r.stems })), notes: out.notes, adapter: out.adapter, totalSec: out.totalSec };
