// 評測守則：全新 --user-data-dir、一次一個、結束前確認無殘留行程、最多跑兩次。
// 重現使用者回報：「我播放音樂（歌在索引裡），按哼歌，找不到這首」。
// 做法：把 D:\Musics\Tara 的 5 首 mp3 用現行流程建旋律索引，取其中 T-Ara SuperNova TTL2 HD 的一段（原曲的 12 秒，等於「播放歌曲給麥克風」），
// 走哼歌同一條路（notesFromHum → search），看排名。也量建索引每首要多久、索引線的數量。
const out = { songs: [], queries: [], timing: {} };
let prog = ''; const T0 = Date.now(); const NL = String.fromCharCode(10);
const plog = async (t) => { prog += '[' + Math.round((Date.now() - T0) / 1000) + 's] ' + t + NL; try { await window.desktopAPI.rawfs.writeFile('E:/Temp/playback_progress.txt', { text: prog }); } catch (_) { /* */ } };
const a = window.desktopAPI;
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function bytesToB64(u8) { let s = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }
function wavBlob(chan, sr) { const n = chan.length, d = new Uint8Array(44 + n * 2), dv = new DataView(d.buffer); const w = (o, s) => { for (let i = 0; i < s.length; i++) d[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, chan[i])) * 32767, true); return new Blob([d], { type: 'audio/wav' }); }
const DIR = 'D:/Musics/Tara/';
const FILES = ['T-Ara SuperNova TTL2 HD.mp3', 'T-ARA Little Apple (Official Instrumental).mp3'];
try {
  const L = FaMusicLibHost.getLib(); await L.ready;
  FILES.forEach((n, i) => L.records.push({ key: 'src|' + DIR + n, sourceId: 'src', sourceType: 'folder', sourceLabel: 'Tara', path: DIR + n, name: n, ext: 'mp3', kind: 'mp3', category: 'audio', label: 'MP3', pending: false, status: 'ok', sizeBytes: 1 + i, mtimeMs: 1, derivedFrom: null, lyricStatus: 'none', lyrics: null, melody: null }));
  let t0 = Date.now();
  const sum = await FaMusicLibHost.melody.buildIndex(function (ev) { if (ev && ev.name) plog((ev.status || 'start') + ' ' + String(ev.name).slice(0, 30) + (ev.reason ? ' ' + ev.reason : '')); }, false);
  await plog('索引完成');
  out.timing.indexAllSec = Math.round((Date.now() - t0) / 1000);
  out.index = { done: sum.done, failed: sum.failed, failures: sum.failures };
  L.records.filter((r) => r.melody).forEach((r) => out.songs.push({ name: r.name.slice(0, 40), status: r.melody.status, method: r.melody.method, lines: 1 + (r.melody.tracks || []).length, notes: r.melody.contour && r.melody.contour.intervals ? r.melody.contour.intervals.length + 1 : null, reason: r.melody.reason }));
  // 查詢：原曲 SuperNova 的 12 秒（從 60 秒、100 秒起），原樣當成「播放給麥克風」
  const full = await window.fa._decodeAudioBuffer(new Blob([b64ToBytes((await a.rawfs.readFile(DIR + FILES[0], 'base64')).base64)]));
  const sr = full.sampleRate, ch = full.getChannelData(0);
  for (const start of [60, 100]) {
    const blob = wavBlob(ch.slice(sr * start, sr * (start + 12)), sr);
    t0 = Date.now();
    await plog('查詢 ' + start);
    const q = await FaMusicLibHost.melody.notesFromHum(blob, false);
    const res = await FaMusicLibHost.melody.search(q.notes, {});
    const hits = (res && (res.hits || res.results)) || [];
    out.queries.push({ start: start, queryNotes: q.notes.length, diag: q.diag, ms: Date.now() - t0, ok: res && res.ok, reason: res && res.reason, top: hits.slice(0, 5).map((h) => ({ name: String((h.name || (h.hit && h.hit.name) || '')).slice(0, 30), score: +(h.score || (h.hit && h.hit.score) || 0).toFixed(3) })) });
  }
} catch (e) { out.error = String((e && e.stack) || e); }
return out;
