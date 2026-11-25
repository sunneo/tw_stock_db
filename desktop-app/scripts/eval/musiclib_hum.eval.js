// 哼歌找歌階段二的真桌面版評測（設計：docs/DESIGN.musiclib-audio-features.md 第 5 節）。本檔只寫不跑，由使用者在真桌面版執行。
// 做法（不另外寫捷徑，走正式流程）：
//   1. 對 T-Ara 五首（D:\Musics\Tara）用正式的 melody.buildIndex 建索引（預設＝快速旋律線，一次掃描），量每首秒數（驗收 ≤ 5 秒）。
//   2. 模擬哼歌：從原曲抽出的主旋律（索引裡每首的旋律線，用 base＋semis 還原成音符）截 3 段、每段 8～12 秒，
//      用合成單音（正弦）重新演奏，每個音加音高抖動（±0.3 半音）、整段速度變化（±10%），寫成 WAV，
//      再走正式的哼歌流程：notesFromHum（音高追蹤）→ melody.search(notes, { blob })（旋律比對＋色度比對＋名次融合）。
//      每段量：融合名次第 1、前 5 是否命中；另外量旋律層單獨與和聲層單獨。
//   3. 舊的「用音符哼歌」：直接拿同一段的音符（不經音訊，模擬使用者逐音符輸入）查詢，量前 1／前 5 是否仍命中。
// 驗收：前 5 命中 ≥ 80%、前 1 ≥ 50%（融合結果）、建索引每首 ≤ 5 秒。整個評測上限 500 秒，超過就停在目前進度並回報 truncated。
// 進度每一步寫進 E:/Temp/hum_progress.txt（逾時也看得到做到哪）。
const T_START = Date.now(), DEADLINE_MS = 470 * 1000;
const out = { songs: [], index: {}, queries: [], oldNotes: [], summary: {}, truncated: false, timing: {} };
let prog = ''; const NL = String.fromCharCode(10);
const plog = async (t) => { prog += '[' + Math.round((Date.now() - T_START) / 1000) + 's] ' + t + NL; try { await window.desktopAPI.rawfs.writeFile('E:/Temp/hum_progress.txt', { text: prog }); } catch (_) { /* 寫不成功不影響評測 */ } };
const overTime = () => Date.now() - T_START > DEADLINE_MS;
const a = window.desktopAPI;
// 評測用的設定：旋律線開、舊的逐音符路徑關（正式預設）、不拆軌、不用 Basic Pitch
window.localStorage.setItem('fa.musiclib.melodyLines', '1');
window.localStorage.setItem('fa.musiclib.melodyOld', '0');
window.localStorage.setItem('fa.musiclib.melodyStems', '0');
window.localStorage.setItem('fa.musiclib.melodyBasicPitch', '0');
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function wavBlob(chan, sr) { const n = chan.length, d = new Uint8Array(44 + n * 2), dv = new DataView(d.buffer); const w = (o, s) => { for (let i = 0; i < s.length; i++) d[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, chan[i])) * 32767, true); return new Blob([d], { type: 'audio/wav' }); }
// 偽隨機（線性同餘，固定種子，結果可重現）
const lcg = (s) => (Math.imul(s, 1664525) + 1013904223) >>> 0;
function rng(seed) { let s = seed >>> 0; return () => { s = lcg(s); return s / 4294967296; }; }
const DIR = 'D:/Musics/Tara/';
const SONG_FILES = [
  'T-Ara SuperNova TTL2 HD.mp3',
  'T-ara - Lovey Dovey Instrumental.mp3',
  'T-ara - Roly Poly (Official Instrumental).mp3',
  'T-ARA Little Apple (Official Instrumental).mp3',
  'T-ara  DAY BY DAY.mp3'
];
const SEGS_PER_SONG = 3, SR_OUT = 22050;
try {
  const L = FaMusicLibHost.getLib(); await L.ready;
  const mk = (n, i) => ({ key: 'src|' + DIR + n, sourceId: 'src', sourceType: 'folder', sourceLabel: 'Tara', path: DIR + n, name: n, ext: 'mp3', kind: 'mp3', category: 'audio', label: 'MP3', pending: false, status: 'ok', sizeBytes: 1000 + i, mtimeMs: 1, derivedFrom: null, lyricStatus: 'none', lyrics: null, melody: null, fp: null });
  SONG_FILES.forEach((n, i) => L.records.push(mk(n, i)));

  // 1. 建索引（正式流程，快速旋律線）：每首量秒數（running → done／failed 之間）
  const started = {}, perSong = {};
  let t0 = Date.now();
  const sum = await FaMusicLibHost.melody.buildIndex(function (ev) {
    if (!ev || !ev.key) return;
    if (ev.status === 'running') started[ev.key] = Date.now();
    if (ev.status === 'done' || ev.status === 'failed') perSong[ev.key] = { sec: +((Date.now() - (started[ev.key] || Date.now())) / 1000).toFixed(2), status: ev.status, reason: ev.reason || null };
    plog('建索引 ' + ev.status + ' ' + String(ev.name || '').slice(0, 40) + (ev.reason ? ' ' + ev.reason : ''));
  }, false);
  out.timing.indexAllSec = +((Date.now() - t0) / 1000).toFixed(1);
  out.index = { done: sum.done, failed: sum.failed, failures: sum.failures || [] };
  SONG_FILES.forEach((n) => {
    const k = 'src|' + DIR + n, r = L.records.find((x) => x.key === k);
    out.songs.push({ name: n.slice(0, 40), indexSec: perSong[k] ? perSong[k].sec : null, status: perSong[k] ? perSong[k].status : 'none', feat: r && r.melody ? (r.melody.feat || 0) : null, lines: r && r.melody && r.melody.tracks ? r.melody.tracks.length + 1 : 0 });
  });
  await plog('建索引完成：' + JSON.stringify(out.songs.map((s) => s.indexSec)));

  // 2. 切哼歌段：每首 3 段，起點與長度固定種子；音符取自索引裡的主旋律線（已還原成秒＋音高）
  const plan = [];
  SONG_FILES.forEach((f, si) => {
    const r = rng(5000 + si * 31);
    for (let q = 0; q < SEGS_PER_SONG; q++) plan.push({ file: f, key: 'src|' + DIR + f, seed: Math.floor(r() * 1e9), pick: r(), len: 8 + r() * 4 });
  });
  // 合成哼歌：正弦、音高抖動 ±0.3 半音、整段速度 ±10%
  const renderHum = (notes, seed) => {
    const r = rng(seed), tempo = 0.9 + r() * 0.2, total = notes.length ? notes[notes.length - 1].t + notes[notes.length - 1].d : 1;
    const len = Math.floor((total / tempo + 0.5) * SR_OUT), buf = new Float32Array(len);
    notes.forEach((x) => {
      const n = x.n + (r() * 2 - 1) * 0.3, f = 440 * Math.pow(2, (n - 69) / 12), s0 = Math.floor(x.t / tempo * SR_OUT), ln = Math.floor(x.d / tempo * SR_OUT);
      for (let i = 0; i < ln && s0 + i < len; i++) { const env = Math.min(1, i / (0.01 * SR_OUT)) * Math.exp(-2.5 * i / ln); buf[s0 + i] += 0.6 * env * Math.sin(2 * Math.PI * f * i / SR_OUT); }
    });
    return { samples: buf, tempo: tempo };
  };
  // 3. 查詢
  const restoreOf = (rec) => { const ln = rec.melody && rec.melody.contour; return ln ? FaMusicLibMelody.restoreNotes(ln) : []; };
  const rows = [], oldRows = [];
  for (const p of plan) {
    if (overTime()) { out.truncated = true; await plog('逾時，停在第 ' + rows.length + ' 段'); break; }
    const rec = L.records.find((x) => x.key === p.key);
    const all = restoreOf(rec);
    if (all.length < 8) { rows.push({ song: p.file.slice(0, 26), skipped: '沒有旋律線' }); continue; }
    const total = all[all.length - 1].t + all[all.length - 1].d;
    const segLen = Math.min(p.len, total - 2), startMax = Math.max(0, total - segLen - 1), a0 = +(p.pick * startMax).toFixed(2);
    const seg = all.filter((x) => x.t >= a0 && x.t < a0 + segLen).map((x) => ({ t: x.t - a0, d: Math.min(x.d, a0 + segLen - x.t), n: x.n }));
    if (seg.length < 6) { rows.push({ song: p.file.slice(0, 26), skipped: '段內音符太少' }); continue; }
    const hum = renderHum(seg, p.seed);
    const blob = wavBlob(hum.samples, SR_OUT);
    try {
      const nh = await FaMusicLibHost.melody.notesFromHum(blob, false);
      const res = await FaMusicLibHost.melody.search(nh.notes, { blob: blob, useText: false, limit: 10 });
      const fusedKeys = ((res.hum && res.hum.fused) || []).map((f) => f.key);
      const melKeys = (res.results || []).map((x) => x.key), chrKeys = ((res.hum && res.hum.chromaRanks) || []).map((x) => x.key);
      const rank = (ks) => { const i = ks.indexOf(p.key); return i < 0 ? null : i + 1; };
      const row = { song: p.file.slice(0, 26), startSec: a0, lenSec: +segLen.toFixed(1), tempo: +hum.tempo.toFixed(3), notes: seg.length,
        fusedRank: rank(fusedKeys), melodyRank: rank(melKeys), chromaRank: rank(chrKeys),
        top1: rank(fusedKeys) === 1, top5: rank(fusedKeys) != null && rank(fusedKeys) <= 5,
        confident: !!(res.hum && res.hum.confident), chromaError: (res.hum && res.hum.chromaError) || '', noFeat: (res.noFeat || []).length,
        fusedTop: fusedKeys.slice(0, 3).map((k) => (L.records.find((x) => x.key === k) || { name: k }).name.slice(0, 24)) };
      rows.push(row);
      await plog('哼 ' + p.file.slice(0, 20) + ' ' + a0 + 's → 融合名次 ' + row.fusedRank + '（旋律 ' + row.melodyRank + '、和聲 ' + row.chromaRank + '）');
    } catch (e) { rows.push({ song: p.file.slice(0, 26), error: String((e && e.message) || e) }); await plog('哼歌查詢失敗 ' + String((e && e.message) || e)); }
    // 舊路：同一段的音符（模擬逐音符輸入），不經音訊，直接比對（音符的旋律比對要仍命中）
    if (!overTime()) {
      const notesTyped = seg.map((x) => ({ t: x.t, d: x.d, n: Math.round(x.n) }));
      const r2 = await FaMusicLibHost.melody.search(notesTyped, { useText: false, limit: 10 });
      const keys = (r2.results || []).map((x) => x.key), i2 = keys.indexOf(p.key);
      oldRows.push({ song: p.file.slice(0, 26), rank: i2 < 0 ? null : i2 + 1, top1: i2 === 0, top5: i2 >= 0 && i2 < 5 });
    }
  }
  out.queries = rows; out.oldNotes = oldRows;
  const ok = rows.filter((x) => !x.skipped && !x.error);
  const n1 = ok.filter((x) => x.top1).length, n5 = ok.filter((x) => x.top5).length, nM1 = ok.filter((x) => x.melodyRank === 1).length, nC1 = ok.filter((x) => x.chromaRank === 1).length;
  const o1 = oldRows.filter((x) => x.top1).length, o5 = oldRows.filter((x) => x.top5).length;
  const maxIdx = Math.max.apply(null, out.songs.map((s) => (s.indexSec == null ? 999 : s.indexSec)));
  out.summary = {
    fusedTop1: n1 + '/' + ok.length, fusedTop1Rate: ok.length ? +(n1 / ok.length).toFixed(3) : null,
    fusedTop5: n5 + '/' + ok.length, fusedTop5Rate: ok.length ? +(n5 / ok.length).toFixed(3) : null,
    melodyOnlyTop1: nM1 + '/' + ok.length, chromaOnlyTop1: nC1 + '/' + ok.length,
    oldNotesTop1: o1 + '/' + oldRows.length, oldNotesTop5: o5 + '/' + oldRows.length,
    maxIndexSec: maxIdx, indexWithin5Sec: maxIdx <= 5,
    accepted: ok.length > 0 && n5 / ok.length >= 0.8 && n1 / ok.length >= 0.5 && maxIdx <= 5
  };
  await plog('完成：' + JSON.stringify(out.summary));
} catch (e) { out.error = String((e && e.stack) || e); await plog('錯誤：' + out.error); }
return out;
