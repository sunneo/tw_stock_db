// 端到端旋律命中率（真桌面版）：三路查詢轉譜 × 比對（精確 n-gram ／ 現行 searchMelody）× 和聲色度融合（fuseHum）。本檔只寫不跑，由使用者在真桌面版執行。
// 做法：
//   1. 語料：D:/Musics/midi 內前 32 首可解析、30–90 秒的 MIDI，在頁面內用 FaMidi 解析，以簡易音源渲染成「原曲」（與 scripts/eval/e2e_retrieval.js 相同的音源與條件）。
//   2. 索引：每首整段音訊的旋律，走「非模型 Viterbi」（FaMusicLibAudio.humNotes）。
//   3. 查詢：原曲播放片段（完整伴奏），過三種喇叭→麥克風條件（乾淨／中等殘響／強殘響），每首 2 段，共 64 題／條件。
//      查詢轉譜三路：
//        (A) 非模型 Viterbi：FaMusicLibAudio.humNotes
//        (B) bpViterbi：Basic Pitch（FaAudioRuntime.makeTranscriber，模型 E:/Temp/onnx-models/nmp.onnx）音符 → FaMusicLibAudio.melodyFromNotes
//        (C) 融合：FaMusicLibAudio.agreeNotes(Basic Pitch 音符, 非模型音符) → melodyFromNotes
//      比對兩種：精確 n-gram（FaMusicLibMelody.searchNgram）與現行 searchMelody。
//      另外每一種比對都再與和聲色度（FaMusicLibFP.chromaSearch）用 FaMusicLibFP.humVerdict 融合，量融合後的前1／前5。
//   4. 輸出：E:/Temp/a2m_e2e_out.json；進度：E:/Temp/a2m_e2e_progress.txt。
//   5. 模型沒載入時（沒有 Basic Pitch），(B)(C) 記為 null，並寫明原因；多聲部判定與退路見 FaMusicLibAudio.queryPathFor。
// 不設通過門檻；數字照實回報。
const T_START = Date.now();
const out = { songs: [], conditions: {}, model: { loaded: false, error: null }, timing: {}, truncated: false };
let prog = ''; const NL = String.fromCharCode(10);
const plog = async (t) => { prog += '[' + Math.round((Date.now() - T_START) / 1000) + 's] ' + t + NL; try { await window.desktopAPI.rawfs.writeFile('E:/Temp/a2m_e2e_progress.txt', { text: prog }); } catch (_) { /* 寫不成功不影響評測 */ } };
const DEADLINE_MS = 540 * 1000, overTime = () => Date.now() - T_START > DEADLINE_MS;
const SR = 16000, DIR = 'D:/Musics/midi/', N_SONGS = 32;
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
function renderSong(notes, dur) {
  const n = Math.floor(dur * SR), x = new Float32Array(n);
  notes.forEach((nt) => { const s0 = Math.floor(nt.t * SR), ln = Math.floor((nt.d + 0.3) * SR), f = mtof(nt.n), amp = 0.06 * (nt.v || 90) / 127;
    for (let i = 0; i < ln && s0 + i < n; i++) { const tt = i / SR, env = Math.min(1, i / (0.003 * SR)) * Math.exp(-tt * 5); let v = 0; for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * f * h * tt) * Math.exp(-tt * (1.2 + h)) / h; x[s0 + i] += amp * env * v; } });
  return x;
}
function micOf(x, p, rand) {
  const y = Float32Array.from(x); const a = 1 - Math.exp(-2 * Math.PI * p.lp / SR); let s1 = 0, s2 = 0;
  for (let i = 0; i < y.length; i++) { s1 += a * (y[i] - s1); s2 += a * (s1 - s2); y[i] = s2; }
  if (p.rt60 > 0) { const rev = new Float32Array(y.length); for (const d of [0.0297, 0.0371, 0.0411, 0.0437]) { const Nn = Math.round(d * SR), g = Math.pow(10, -3 * Nn / (p.rt60 * SR)), buf = new Float32Array(Nn); let idx = 0; for (let i = 0; i < y.length; i++) { const o = buf[idx]; buf[idx] = y[i] + g * o; rev[i] += o / 4; idx = (idx + 1) % Nn; } } for (let i = 0; i < y.length; i++) y[i] = 0.5 * y[i] + 0.5 * rev[i]; }
  let ps = 0; for (let i = 0; i < y.length; i++) ps += y[i] * y[i]; ps /= y.length;
  if (p.snrDb != null) { const sd = Math.sqrt(ps / Math.pow(10, p.snrDb / 10)); for (let i = 0; i < y.length; i++) { let g6 = 0; for (let k = 0; k < 6; k++) g6 += rand(); y[i] += sd * (g6 - 3); } }
  let mx = 0; for (let i = 0; i < y.length; i++) mx = Math.max(mx, Math.abs(y[i])); const g2 = p.gain / Math.max(1e-9, mx) * 0.7;
  for (let i = 0; i < y.length; i++) y[i] = Math.max(-1, Math.min(1, y[i] * g2));
  return y;
}
const CONDS = { clean: { lp: 9000, rt60: 0, snrDb: null, gain: 0.9 }, room: { lp: 4500, rt60: 0.5, snrDb: 15, gain: 0.5 }, harsh: { lp: 3500, rt60: 0.9, snrDb: 8, gain: 0.3 } };
function rankOf(list, key) { const i = (list || []).map((x) => x.key).indexOf(key); return i < 0 ? null : i + 1; }
return (async () => {
  // 1. 語料
  const L = window.desktopAPI.rawfs;
  let files = [];
  try { files = (await L.listDir ? await L.listDir(DIR) : []) || []; } catch (_) { files = []; }
  const names = ['Grandfathers-Clock.mid'].concat(files.map((f) => (f && f.name) || f).filter((n) => /\.midi?$/i.test(String(n))));
  const songs = [];
  for (const nm of Array.from(new Set(names))) {
    if (songs.length >= N_SONGS || overTime()) break;
    try {
      const r = await L.readFile(DIR + nm, 'base64'); const s = FaMidi.parse(b64ToBytes(r.base64));
      const mel = FaMusicLibMelody.melodyFromSong(s); if (mel.length < 40) continue;
      const dur = mel[mel.length - 1].t + mel[mel.length - 1].d; if (dur < 30 || dur > 90) continue;
      const notes = []; s.tracks.forEach((tr) => { if (tr.drum) return; (tr.notes || []).forEach((q) => { const t0 = FaMidi.ticksToSec(s, q.t), t1 = FaMidi.ticksToSec(s, q.t + q.d); notes.push({ t: t0, d: t1 - t0, n: q.n, v: q.v || 90 }); }); });
      songs.push({ file: nm, notes: notes, dur: Math.max.apply(null, notes.map((x) => x.t + x.d)) + 0.3 });
    } catch (e) { await plog('略過 ' + nm + '：' + String((e && e.message) || e)); }
  }
  out.songs = songs.map((s) => ({ file: s.file, sec: +s.dur.toFixed(1) }));
  await plog('語料 ' + songs.length + ' 首');
  // 2. 模型
  let transcriber = null;
  try {
    const bytes = b64ToBytes((await L.readFile('E:/Temp/onnx-models/nmp.onnx', 'base64')).base64);
    const ort = await FaAudioRuntime.loadOrt();
    const s = await FaAudioRuntime.createSession(ort, bytes, ['wasm'], {});
    transcriber = FaAudioRuntime.makeTranscriber(ort, s.session); out.model.loaded = true; out.model.ep = s.ep;
    await plog('模型載入：' + s.ep);
  } catch (e) { out.model.error = String((e && e.message) || e); await plog('模型載入失敗：' + out.model.error); }
  const AM = FaAudioToMidi, HUM = { AudioToMidi: AM, thr: 0.3, glideMax: 0.12 };
  const viterbi = (ch) => FaMusicLibAudio.humNotes({ channels: [ch], sampleRate: SR }, HUM).notes;
  const bpNotes = async (ch) => transcriber ? await transcriber(ch, SR) : null;
  // 3. 索引（非模型 Viterbi，每首整段）
  const idx = [];
  for (const sg of songs) {
    if (overTime()) { out.truncated = true; break; }
    const ch = renderSong(sg.notes, sg.dur), m = FaMusicLibMelody.melodyNotes(viterbi(ch));
    if (m.length < FaMusicLibMelody.MIN_NOTES) continue;
    const contour = FaMusicLibMelody.contourOf(m), chroma = FaMusicLibFP.chromaOf([ch], SR);
    idx.push({ key: sg.file, name: sg.file, lines: [{ label: '主旋律', contour: contour, mode: 'merged' }], chroma: chroma, cells: chroma.cells, chromaBytes: chroma.chroma });
  }
  await plog('索引 ' + idx.length + ' 首');
  const chromaEntries = idx.map((e) => ({ key: e.key, name: e.name, cells: e.cells, chroma: e.chromaBytes }));
  // 4. 查詢
  const CAT = ['viterbi', 'bpViterbi', 'fused'];
  for (const [cn, cp] of Object.entries(CONDS)) {
    if (overTime()) { out.truncated = true; break; }
    const res = {}; CAT.forEach((k) => { res[k] = {}; ['ngram', 'searchMelody'].forEach((m) => { res[k][m] = { top1: 0, top5: 0, fuseTop1: 0, fuseTop5: 0, n: 0 }; }); });
    const rand = rng(31 + cn.length);
    for (let si = 0; si < songs.length; si++) {
      const sg = songs[si]; if (!idx.some((e) => e.key === sg.file)) continue;
      for (let q = 0; q < 2; q++) {
        if (overTime()) { out.truncated = true; break; }
        const r0 = (rand() * 0.6 + 0.1) * sg.dur, Lq = Math.min(12, sg.dur - r0 - 0.5);
        const seg = renderSong(sg.notes.filter((x) => x.t >= r0 && x.t < r0 + Lq).map((x) => ({ t: x.t - r0, d: Math.min(x.d, r0 + Lq - x.t), n: x.n, v: x.v })), Lq);
        const rec = micOf(seg, cp, rand);
        const vit = viterbi(rec), bp = await bpNotes(rec);
        const variants = { viterbi: vit, bpViterbi: bp ? FaMusicLibAudio.melodyFromNotes(bp, { hopSec: 0.01 }) : null, fused: bp ? FaMusicLibAudio.melodyFromNotes(FaMusicLibAudio.agreeNotes(bp, vit), { hopSec: 0.01 }) : null };
        const chroma = FaMusicLibFP.chromaOf([rec], SR), chr = FaMusicLibFP.chromaSearch(chroma, chromaEntries, { limit: 10 });
        for (const k of CAT) {
          const qn = variants[k]; if (!qn) continue;
          const ng = FaMusicLibMelody.searchNgram(qn, idx, { limit: 10 }), sm = FaMusicLibMelody.searchMelody(qn, idx, { limit: 10 });
          for (const [mname, rr] of [['ngram', ng], ['searchMelody', sm]]) {
            const list = rr.results || [], rk = rankOf(list, sg.file);
            const fused = FaMusicLibFP.humVerdict(list.map((x) => ({ key: x.key, name: x.name, score: x.score })), chr, { melodyConfident: 0.5 }).fused;
            const fk = rankOf(fused, sg.file);
            const c = res[k][mname]; c.n++; if (rk === 1) c.top1++; if (rk && rk <= 5) c.top5++; if (fk === 1) c.fuseTop1++; if (fk && fk <= 5) c.fuseTop5++;
          }
        }
        await plog(cn + ' ' + sg.file.slice(0, 24) + ' #' + q + ' 完成');
      }
    }
    const pct = (a, n) => n ? +(a / n).toFixed(3) : null;
    out.conditions[cn] = {};
    for (const k of CAT) for (const m of ['ngram', 'searchMelody']) {
      const c = res[k][m];
      out.conditions[cn][k + '/' + m] = { n: c.n, top1: pct(c.top1, c.n), top5: pct(c.top5, c.n), fusedTop1: pct(c.fuseTop1, c.n), fusedTop5: pct(c.fuseTop5, c.n) };
    }
  }
  out.timing.totalSec = Math.round((Date.now() - T_START) / 1000);
  try { await L.writeFile('E:/Temp/a2m_e2e_out.json', { text: JSON.stringify(out, null, 1) }); } catch (_) { /* 結果仍回傳 */ }
  await plog('完成');
  return out;
})().catch(async (e) => { out.error = String((e && e.stack) || e); await plog('錯誤：' + out.error); return out; });
