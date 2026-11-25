// 音訊指紋階段一的真桌面版驗收（設計：docs/DESIGN.musiclib-audio-features.md 第 5 節）。
// 做法：5 首 D:\Musics\Tara 的 mp3 走正式的 melody.buildIndex（不另外寫捷徑），量每首建索引的秒數（要 ≤ 5 秒）。
// 查詢：每首取 3 段 12 秒當成「播放給麥克風」的錄音，變形三種：乾淨／改音量＋白雜訊（約 20 dB）／改音量＋輕微殘響。
//   第 A 組：與第一次評測相同的 15 段（起點與噪音完全一樣，用來對照改善前後）
//   第 B 組：另取的 15 段（種子 9000 起，起點另抽）
//   第 C 組：再另取的 15 段（種子 3333 起，起點另抽；只用來盲測）
// 每段看兩件事：(1) 名次第一的歌是否正確且時間誤差 ≤ 2 秒（驗收線 ≥ 90%）；(2) 產品的把握判斷（confident）是否也命中。
// 負面對照：另一首不相干、沒建索引的歌，12 段，不該有有把握的命中。
// 進度每一步寫進 E:/Temp/fp_eval_progress.txt（逾時也看得到做到哪）。
// 本檔量的是指紋（快）那條路：先把「建旋律線」關掉（預設是開，開的話每首約 3～4 分鐘，超過執行時間上限）。命中率與旋律線無關。
window.localStorage.setItem('fa.musiclib.melodyLines', '0');
const out = { sets: {}, songs: [], negatives: [], timing: {} };
let prog = ''; const T0 = Date.now(); const NL = String.fromCharCode(10);
const plog = async (t) => { prog += '[' + Math.round((Date.now() - T0) / 1000) + 's] ' + t + NL; try { await window.desktopAPI.rawfs.writeFile('E:/Temp/fp_eval_progress.txt', { text: prog }); } catch (_) { /* 寫不成功不影響評測 */ } };
const a = window.desktopAPI;
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function wavBlob(chan, sr) { const n = chan.length, d = new Uint8Array(44 + n * 2), dv = new DataView(d.buffer); const w = (o, s) => { for (let i = 0; i < s.length; i++) d[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, chan[i])) * 32767, true); return new Blob([d], { type: 'audio/wav' }); }
// 偽隨機（線性同餘，固定種子，結果可重現）：狀態 s；rng(s) 每次取下一個值（0–1）
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
const NEG_FILE = '[MV] T-ara - Like The First Time.mp3';   // 沒建索引、不相干的歌：負面對照
const SEG = 12, KINDS = ['clean', 'noisy', 'reverb'];
// 三組的計畫：每首的起點與噪音種子。A 組的串流與第一次評測完全相同（種子 1000 + 第幾首 × 17）
const SET_SEEDS = { A: [1000, 17], B: [9000, 29], C: [3333, 41] };
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

  // 解碼整首（查詢切段用）：取各聲道平均
  const pcm = {};
  const decodeAll = async (n) => { const buf = await window.fa._decodeAudioBuffer(new Blob([b64ToBytes((await a.rawfs.readFile(DIR + n, 'base64')).base64)])); const chs = []; for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c)); const m = new Float32Array(buf.length); for (const ch of chs) for (let i = 0; i < buf.length; i++) m[i] += ch[i] / chs.length; return { mono: m, sr: buf.sampleRate }; };
  for (const n of SONG_FILES) pcm[n] = await decodeAll(n);
  // 變形：乾淨／改音量（×0.5）＋白雜訊（約 20 dB）／殘響（70 毫秒回聲 0.35，再改音量 ×1.6）
  const variantOf = (name, start, kind, r) => {
    const sr = pcm[name].sr, a0 = Math.floor(start * sr), len = SEG * sr, seg = new Float32Array(len);
    for (let i = 0; i < len; i++) seg[i] = pcm[name].mono[a0 + i];
    let p = 0; for (let i = 0; i < len; i++) p += seg[i] * seg[i]; const rms = Math.sqrt(p / len);
    if (kind === 'clean') return seg;
    if (kind === 'noisy') { const sd = 0.5 * rms * Math.pow(10, -20 / 20), A = sd * Math.sqrt(3); return seg.map((v) => 0.5 * v + (r() * 2 - 1) * A); }
    const d = Math.floor(0.07 * sr), e = new Float32Array(len); for (let i = 0; i < len; i++) e[i] = seg[i] + (i >= d ? 0.35 * e[i - d] : 0);
    return e.map((v) => 1.6 * v);
  };
  // 計畫：每首、每段的起點與噪音種子。噪音段會吃掉 len 個亂數，與評測檔的串流一致
  const planSet = (name) => {
    const [base, step] = SET_SEEDS[name], plan = [];
    SONG_FILES.forEach((f, si) => {
      const total = pcm[f].mono.length / pcm[f].sr;
      let s = (base + si * step) >>> 0;
      for (let qi = 0; qi < 3; qi++) {
        s = lcg(s); const v = s / 4294967296; const start = +(20 + v * (total - 40 - SEG)).toFixed(2);
        const cap = s;
        if (KINDS[qi] === 'noisy') for (let i = 0; i < SEG * pcm[f].sr; i++) s = lcg(s);
        plan.push({ file: f, start: start, kind: KINDS[qi], seed: cap });
      }
    });
    return plan;
  };
  for (const setName of ['A', 'B', 'C']) {
    const plan = planSet(setName), rows = [];
    for (const q of plan) {
      const sr = pcm[q.file].sr, blob = wavBlob(variantOf(q.file, q.start, q.kind, rng(q.seed)), sr);
      const res = await FaMusicLibHost.melody.search([], { blob: blob, useText: false });
      const fp = res && res.fp, hits = (fp && fp.hits) || [], first = hits[0] || null;
      const rank1 = !!first && first.key === 'src|' + DIR + q.file;
      const timeErr = first && rank1 ? +Math.abs(first.offsetSec - q.start).toFixed(2) : null;
      rows.push({ song: q.file.slice(0, 26), start: q.start, kind: q.kind, rank1Correct: rank1, timeErrSec: timeErr, pass: rank1 && timeErr != null && timeErr <= 2, confident: !!(fp && fp.ok), reason: fp ? fp.reason : 'no fp', top: hits.slice(0, 2).map((h) => ({ name: String(h.name).slice(0, 24), offsetSec: h.offsetSec, votes: h.votes })), queryHashes: fp ? fp.queryHashes : null, missingCount: fp && fp.missingNames ? fp.missingNames.length : null });
      await plog('第 ' + setName + ' 組 ' + q.file.slice(0, 20) + ' ' + q.start + ' ' + q.kind + ' → ' + (rank1 ? '名次第一對' : '名次第一錯') + (timeErr != null ? '，誤差 ' + timeErr : ''));
    }
    const passN = rows.filter((x) => x.pass).length, confN = rows.filter((x) => x.confident && x.pass).length;
    out.sets[setName] = { rows: rows, rank1WithinTwoSec: passN + '/' + rows.length, rate: +(passN / rows.length).toFixed(3), confidentAndCorrect: confN + '/' + rows.length };
    await plog('第 ' + setName + ' 組：名次第一且時間誤差 ≤ 2 秒 ' + passN + '/' + rows.length + '，有把握的命中 ' + confN + '/' + rows.length);
  }
  // 負面對照：不相干的歌（沒建索引），12 段（一半乾淨、一半噪音）
  const negPcm = await decodeAll(NEG_FILE); pcm[NEG_FILE] = negPcm;
  const rn = rng(4242);
  for (let k = 0; k < 12; k++) {
    const start = +(20 + rn() * (negPcm.mono.length / negPcm.sr - 40 - SEG)).toFixed(2);
    const kind = k % 2 ? 'noisy' : 'clean';
    const sr = negPcm.sr, seg = variantOf(NEG_FILE, start, kind, rng(77 + k));
    await plog('負面對照 ' + k);
    const res = await FaMusicLibHost.melody.search([], { blob: wavBlob(seg, sr), useText: false });
    const fp = res && res.fp;
    out.negatives.push({ start: start, kind: kind, confident: !!(fp && fp.ok), reason: fp ? fp.reason : 'no fp', top: fp && fp.top ? { name: fp.top.name, votes: fp.top.votes, second: fp.top.second } : null });
  }
  out.summary = { A: out.sets.A.rank1WithinTwoSec, B: out.sets.B.rank1WithinTwoSec, C: out.sets.C.rank1WithinTwoSec, negativeConfidentFalseHits: out.negatives.filter((x) => x.confident).length + '/' + out.negatives.length, maxIndexSec: Math.max.apply(null, out.songs.map((s) => (s.perSong ? s.perSong.sec : 999))) };
  await plog('完成：' + JSON.stringify(out.summary));
} catch (e) { out.error = String((e && e.stack) || e); await plog('錯誤：' + out.error); }
return out;
