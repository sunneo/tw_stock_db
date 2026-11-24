// 評測守則（使用者要求，2026-11-22）：全新 --user-data-dir、一次一個、結束前確認無殘留行程、最多跑兩次。
// 拆軌（Demucs 6 軌）真桌面版評測。會下載 Demucs 模型約 136 MB（使用者 2026-11-25 同意：「下載並實測」）。
// 1. 批次輸出 mp3→mid 勾拆軌：讀回的 mid 應有多條音軌，方法欄有「＋Demucs 拆軌」；
// 2. 旋律索引勾拆軌：15 秒的 wav 片段建索引，索引的方法欄有「＋Demucs 拆軌」、有多條旋律線（tracks）。
const out = { checks: [], timing: {} };
const check = (name, ok, detail) => { out.checks.push({ name: name, ok: !!ok, detail: detail || '' }); };
const a = window.desktopAPI;
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function bytesToB64(u8) { let s = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }
function wavOf(chan, sr) { const n = chan.length, d = new Uint8Array(44 + n * 2), dv = new DataView(d.buffer); const w = (o, s) => { for (let i = 0; i < s.length; i++) d[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, chan[i])) * 32767, true); return d; }
const SAMPLE = 'C:/Users/sunneo/Desktop/midi音樂/GrandfatherClock.mp3', OUT = 'E:/Temp/exp_stems_out';
try {
  // 1. 輸出：mp3→mid 拆軌，30 秒
  let t0 = Date.now();
  const rec = { key: 'k:gc', name: 'GrandfatherClock.mp3', path: SAMPLE, status: 'ok', pending: false, sizeBytes: 0 };
  const r = await FaMusicLibHost.exportBatch([rec], { format: 'mid', minutes: 0.5, outDir: OUT, useStems: true });
  const b = r.results[0]; out.timing.exportSec = Math.round((Date.now() - t0) / 1000);
  out.exportResult = { status: b.status, reason: b.reason, stage: b.stage, method: b.output && b.output.method, verify: b.verify && b.verify.detail };
  check('輸出拆軌：完成', b.status === 'done', JSON.stringify(out.exportResult));
  check('輸出拆軌：方法欄有「＋Demucs 拆軌」', !!(b.output && /＋Demucs 拆軌/.test(b.output.method || '')), (b.output && b.output.method) || '');
  if (b.status === 'done') {
    const song = FaMidi.parse(b64ToBytes((await a.rawfs.readFile(b.output.path, 'base64')).base64));
    out.exportTracks = song.tracks.map((t) => (t.name || '') + ':' + t.notes.length + (t.drum ? '(鼓)' : ''));
    check('輸出拆軌：mid 有多條音軌（至少 2 條有音符）', song.tracks.filter((t) => t.notes.length).length >= 2, out.exportTracks.join('、'));
  }

  // 2. 索引：取前 15 秒存成 wav，建索引（勾拆軌）
  const full = await window.fa._decodeAudioBuffer(new Blob([b64ToBytes((await a.rawfs.readFile(SAMPLE, 'base64')).base64)]));
  const sr = full.sampleRate, clip = full.getChannelData(0).slice(0, sr * 15);
  const wavPath = OUT + '/clip15.wav';
  await a.rawfs.writeFile(wavPath, { base64: bytesToB64(wavOf(clip, sr)) });
  localStorage.setItem('fa.musiclib.melodyStems', '1');
  const L = FaMusicLibHost.getLib(); await L.ready;
  const R = { key: 'src|' + wavPath, sourceId: 'src', sourceType: 'file', sourceLabel: 'eval', path: wavPath, name: 'clip15.wav', ext: 'wav', kind: 'wav', category: 'audio', label: 'WAV', pending: false, status: 'ok', sizeBytes: 1, mtimeMs: 1, derivedFrom: null, lyricStatus: 'none', lyrics: null, melody: null };
  L.records.push(R);
  t0 = Date.now();
  const sum = await FaMusicLibHost.melody.buildIndex(function () {}, false);
  out.timing.indexSec = Math.round((Date.now() - t0) / 1000);
  const rr = L.records.filter((x) => x.key === R.key)[0];
  out.index = { sum: sum && { done: sum.done, failed: sum.failed, failures: sum.failures }, status: rr && rr.melody && rr.melody.status, method: rr && rr.melody && rr.melody.method, lines: rr && rr.melody && (rr.melody.tracks || []).map((t) => t.label) };
  check('索引拆軌：建好', !!(rr && rr.melody && rr.melody.status === 'ok'), JSON.stringify(out.index));
  check('索引拆軌：方法欄有「＋Demucs 拆軌」', !!(rr && rr.melody && /＋Demucs 拆軌/.test(rr.melody.method || '')), (rr && rr.melody && rr.melody.method) || '');
  check('索引拆軌：有旋律線（tracks）', !!(rr && rr.melody && (rr.melody.tracks || []).length >= 1), String(rr && rr.melody && (rr.melody.tracks || []).length));
} catch (e) { out.error = String((e && e.stack) || e); check('評測本身沒出錯', false, out.error); }
try { localStorage.removeItem('fa.musiclib.melodyStems'); } catch (_) { /* */ }
try { FaMusicLibHost.cancelExport(); } catch (_) { /* */ }
out.passed = out.checks.filter((c) => c.ok).length; out.total = out.checks.length;
return out;
