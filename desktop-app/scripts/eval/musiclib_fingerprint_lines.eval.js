// 旋律線勾選的真桌面版檢查（不是整組評測）：
//   (1) 預設（未設定 fa.musiclib.melodyLines，等於勾選）：1 首建索引後，紀錄同時有 fp 與 melody.contour，哼歌候選含這首。
//   (2) 取消勾選（fa.musiclib.melodyLines = '0'）：另 1 首只建指紋，哼歌候選不含它，且 lineless（提示用）列出它。
// 預設流程一首約 3～4 分鐘（舊的逐音符轉譜），所以這個檔只跑 2 首，不跑整組。
const out = { steps: [] };
let prog = ''; const T0 = Date.now(); const NL = String.fromCharCode(10);
const plog = async (t) => { prog += '[' + Math.round((Date.now() - T0) / 1000) + 's] ' + t + NL; try { await window.desktopAPI.rawfs.writeFile('E:/Temp/fp_lines_progress.txt', { text: prog }); } catch (_) { /* 寫不成功不影響檢查 */ } };
const DIR = 'D:/Musics/Tara/';
const mk = (n, i) => ({ key: 'src|' + DIR + n, sourceId: 'src', sourceType: 'folder', sourceLabel: 'Tara', path: DIR + n, name: n, ext: 'mp3', kind: 'mp3', category: 'audio', label: 'MP3', pending: false, status: 'ok', sizeBytes: 2000 + i, mtimeMs: 1, derivedFrom: null, lyricStatus: 'none', lyrics: null, melody: null });
try {
  const L = FaMusicLibHost.getLib(); await L.ready;
  const LINES_KEY = 'fa.musiclib.melodyLines';
  // (1) 預設：不設定鍵（等於勾選）
  window.localStorage.removeItem(LINES_KEY);
  const A = 'T-Ara SuperNova TTL2 HD.mp3';
  L.records.push(mk(A, 1));
  let t0 = Date.now();
  await plog('(1) 預設建 1 首（旋律線開）');
  await FaMusicLibHost.melody.buildIndex(function (ev) { if (ev && ev.name) plog(ev.status + ' ' + String(ev.name).slice(0, 30)); }, false);
  const ra = L.records.find((r) => r.name === A);
  out.steps.push({ step: '1 預設（旋律線開）', name: A, sec: +((Date.now() - t0) / 1000).toFixed(1), hasFp: !!(ra && ra.fp), fpN: ra && ra.fp ? ra.fp.n : null, hasContour: !!(ra && ra.melody && ra.melody.contour), melodyStatus: ra && ra.melody ? ra.melody.status : null, method: ra && ra.melody ? ra.melody.method : null, inHumCandidates: FaMusicLibHost.melody.entries().some((e) => e.name === A) });
  // (2) 取消勾選：只建指紋
  window.localStorage.setItem(LINES_KEY, '0');
  const B = 'T-ara - Lovey Dovey Instrumental.mp3';
  L.records.push(mk(B, 2));
  t0 = Date.now();
  await plog('(2) 取消勾選建 1 首（只建指紋）');
  await FaMusicLibHost.melody.buildIndex(function (ev) { if (ev && ev.name) plog(ev.status + ' ' + String(ev.name).slice(0, 30)); }, false);
  const rb = L.records.find((r) => r.name === B);
  const cand = FaMusicLibHost.melody.entries().map((e) => e.name);
  // 哼歌查詢（用錄音的指紋）回傳的 lineless 清單
  out.steps.push({ step: '2 取消勾選（只建指紋）', name: B, sec: +((Date.now() - t0) / 1000).toFixed(1), hasFp: !!(rb && rb.fp), fpN: rb && rb.fp ? rb.fp.n : null, hasContour: !!(rb && rb.melody && rb.melody.contour), melodyStatus: rb && rb.melody ? rb.melody.status : null, method: rb && rb.melody ? rb.melody.method : null, inHumCandidates: cand.indexOf(B) >= 0, });
  // 用真的哼歌查詢路徑看 lineless：錄音從 SuperNova 取 12 秒（WAV），只看提示清單
  const full = await window.fa._decodeAudioBuffer(new Blob([Uint8Array.from(atob((await window.desktopAPI.rawfs.readFile(DIR + A, 'base64')).base64), (c) => c.charCodeAt(0))]));
  const ch = full.getChannelData(0), sr = full.sampleRate, seg = ch.slice(sr * 60, sr * 72);
  const hdr = new Uint8Array(44 + seg.length * 2), dv = new DataView(hdr.buffer), w = (o, s) => { for (let i = 0; i < s.length; i++) hdr[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + seg.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, seg.length * 2, true);
  for (let i = 0; i < seg.length; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, seg[i])) * 32767, true);
  const res = await FaMusicLibHost.melody.search([], { blob: new Blob([hdr], { type: 'audio/wav' }), useText: false });
  out.steps.push({ step: '3 哼歌查詢的提示清單', lineless: res.lineless || [], fpTop: res.fp && res.fp.top ? { name: res.fp.top.name, offsetSec: res.fp.top.offsetSec } : null });
  await plog('完成');
} catch (e) { out.error = String((e && e.stack) || e); await plog('錯誤：' + out.error); }
window.localStorage.removeItem('fa.musiclib.melodyLines');
return out;
