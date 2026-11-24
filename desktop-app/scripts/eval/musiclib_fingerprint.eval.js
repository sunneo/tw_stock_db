// 音訊指紋階段一的真桌面版驗收（設計：docs/DESIGN.musiclib-audio-features.md 第 5 節）。
// 做法：5 首 D:\Musics\Tara 的 mp3 走正式的 melody.buildIndex（不另外寫捷徑），量每首建索引的秒數（要 ≤ 5 秒）。
// 查詢：每首取原曲任意 3 段 12 秒，當成「播放給麥克風」的錄音：第 1 段乾淨、第 2 段改音量＋加白雜訊（約 20 dB）、第 3 段改音量＋輕微殘響。
// 走正式的 melody.search(notes=[], { blob }) → 看 fp 的名次第一是否是正確的歌、時間點誤差是否 ≤ 2 秒。
// 另放一首沒建索引、不相干的歌當負面對照：不該命中。
// 進度每一步寫進 E:/Temp/fp_eval_progress.txt（逾時也看得到做到哪）。
const out = { songs: [], index: {}, queries: [], negatives: [], timing: {} };
let prog = ''; const T0 = Date.now(); const NL = String.fromCharCode(10);
const plog = async (t) => { prog += '[' + Math.round((Date.now() - T0) / 1000) + 's] ' + t + NL; try { await window.desktopAPI.rawfs.writeFile('E:/Temp/fp_eval_progress.txt', { text: prog }); } catch (_) { /* 寫不成功不影響評測 */ } };
const a = window.desktopAPI;
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function wavBlob(chan, sr) { const n = chan.length, d = new Uint8Array(44 + n * 2), dv = new DataView(d.buffer); const w = (o, s) => { for (let i = 0; i < s.length; i++) d[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, chan[i])) * 32767, true); return new Blob([d], { type: 'audio/wav' }); }
// 偽隨機（固定種子，結果可重現）
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const DIR = 'D:/Musics/Tara/';
const SONG_FILES = [
  'T-Ara SuperNova TTL2 HD.mp3',
  'T-ara - Lovey Dovey Instrumental.mp3',
  'T-ara - Roly Poly (Official Instrumental).mp3',
  'T-ARA Little Apple (Official Instrumental).mp3',
  'T-ara  DAY BY DAY.mp3'
];
const NEG_FILE = '[MV] T-ara - Like The First Time.mp3';   // 沒建索引、不相干的歌：負面對照
try {
  const L = FaMusicLibHost.getLib(); await L.ready;
  const mk = (n, i) => ({ key: 'src|' + DIR + n, sourceId: 'src', sourceType: 'folder', sourceLabel: 'Tara', path: DIR + n, name: n, ext: 'mp3', kind: 'mp3', category: 'audio', label: 'MP3', pending: false, status: 'ok', sizeBytes: 1000 + i, mtimeMs: 1, derivedFrom: null, lyricStatus: 'none', lyrics: null, melody: null });
  SONG_FILES.forEach((n, i) => L.records.push(mk(n, i)));
  // 建索引：正式流程，每首量秒數（running → done／failed 之間）
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
  SONG_FILES.forEach((n) => { const k = 'src|' + DIR + n, r = L.records.find((x) => x.key === k); out.songs.push({ name: n.slice(0, 40), perSong: perSong[k] || null, fpN: r && r.fp ? r.fp.n : null, fpBytes: r && r.fp ? JSON.stringify(r.fp).length : null, fpFrames: r && r.fp ? r.fp.frames : null, melodyStatus: r && r.melody ? r.melody.status : null }); });
  await plog('建索引完成：' + JSON.stringify(out.songs.map((s) => s.perSong && s.perSong.sec)));

  // 解碼整首（查詢時切段用）
  const pcm = {};
  const decodeAll = async (n) => { const buf = await window.fa._decodeAudioBuffer(new Blob([b64ToBytes((await a.rawfs.readFile(DIR + n, 'base64')).base64)])); const chs = []; for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c)); const m = new Float32Array(buf.length); for (const ch of chs) for (let i = 0; i < buf.length; i++) m[i] += ch[i] / chs.length; return { mono: m, sr: buf.sampleRate }; };
  for (const n of SONG_FILES) pcm[n] = await decodeAll(n);
  // 查詢變形
  const SEG = 12;
  const variantOf = (x, sr, kind, r) => {
    const a0 = Math.floor(x.start * sr), len = SEG * sr, seg = new Float32Array(len);
    for (let i = 0; i < len; i++) seg[i] = pcm[x.name].mono[a0 + i];
    let p = 0; for (let i = 0; i < len; i++) p += seg[i] * seg[i]; const rms = Math.sqrt(p / len);
    if (kind === 'clean') return seg;
    if (kind === 'noisy') { const sd = 0.5 * rms * Math.pow(10, -20 / 20), A = sd * Math.sqrt(3); return seg.map((v) => 0.5 * v + (r() * 2 - 1) * A); }  // 改音量（×0.5）＋白雜訊（SNR 約 20 dB）
    // 殘響：70 毫秒的延遲回聲（衰減 0.35），再改音量（×1.6）
    const d = Math.floor(0.07 * sr), e = new Float32Array(len); for (let i = 0; i < len; i++) e[i] = seg[i] + (i >= d ? 0.35 * e[i - d] : 0);
    return e.map((v) => 1.6 * v);
  };
  const kinds = ['clean', 'noisy', 'reverb'];
  for (let si = 0; si < SONG_FILES.length; si++) {
    const n = SONG_FILES[si], total = pcm[n].mono.length / pcm[n].sr, r = rng(1000 + si * 17);
    for (let qi = 0; qi < 3; qi++) {
      const start = +(20 + r() * (total - 40 - SEG)).toFixed(2);
      const sr = pcm[n].sr, seg = variantOf({ name: n, start: start }, sr, kinds[qi], r);
      const blob = wavBlob(seg, sr);
      const t1 = Date.now();
      await plog('查詢 ' + n.slice(0, 24) + ' 第 ' + start + ' 秒（' + kinds[qi] + '）');
      const res = await FaMusicLibHost.melody.search([], { blob: blob, useText: false });
      const fp = res && res.fp, hits = (fp && fp.hits) || [];
      const first = hits[0] || null;
      const rank1 = !!first && first.key === 'src|' + DIR + n;
      const timeErr = first && rank1 ? +Math.abs(first.offsetSec - start).toFixed(2) : null;
      out.queries.push({ song: n.slice(0, 30), start: start, kind: kinds[qi], ms: Date.now() - t1, ok: !!(fp && fp.ok), reason: fp ? fp.reason : 'no fp', rank1Correct: rank1, timeErrSec: timeErr, pass: rank1 && timeErr != null && timeErr <= 2, top: hits.slice(0, 3).map((h) => ({ name: String(h.name).slice(0, 28), offsetSec: h.offsetSec, votes: h.votes })), missingCount: fp && fp.missingNames ? fp.missingNames.length : null });
    }
  }
  // 負面對照：不相干的歌（沒建索引），取 3 段，不該命中
  const negPcm = await decodeAll(NEG_FILE);
  const rn = rng(4242);
  for (let qi = 0; qi < 3; qi++) {
    const start = +(20 + rn() * (negPcm.mono.length / negPcm.sr - 40 - SEG)).toFixed(2);
    const seg = negPcm.mono.subarray(Math.floor(start * negPcm.sr), Math.floor((start + SEG) * negPcm.sr));
    await plog('負面對照 ' + qi);
    const res = await FaMusicLibHost.melody.search([], { blob: wavBlob(seg, negPcm.sr), useText: false });
    const fp = res && res.fp;
    out.negatives.push({ start: start, ok: !!(fp && fp.ok), reason: fp ? fp.reason : 'no fp', top: fp && fp.top ? { name: fp.top.name, votes: fp.top.votes, second: fp.top.second } : null });
  }
  const passN = out.queries.filter((q) => q.pass).length;
  out.summary = { rank1WithinTwoSec: passN + '/' + out.queries.length, rate: +(passN / out.queries.length).toFixed(3), negativeFalsePositives: out.negatives.filter((x) => x.ok).length + '/' + out.negatives.length, maxIndexSec: Math.max.apply(null, out.songs.map((s) => (s.perSong ? s.perSong.sec : 999))) };
  await plog('完成：' + JSON.stringify(out.summary));
} catch (e) { out.error = String((e && e.stack) || e); await plog('錯誤：' + out.error); }
return out;
