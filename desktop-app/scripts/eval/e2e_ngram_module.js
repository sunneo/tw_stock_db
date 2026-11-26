// 端到端命中率（旋律路徑、指紋關閉）：庫內 MIDI 以簡易音源渲染成「原曲」，索引＝每首的旋律（走同一條音訊→音符路徑）；
// 查詢＝原曲播放片段（完整伴奏）過喇叭→麥克風三條件。比較兩條轉譜路徑：新（Viterbi）與舊（逐幀＋八度折回）。
const R = 'D:/Downloads/videos-嗨投資/.claude/worktrees/objective-nash-008719/desktop-app/';
const fs = require('fs');
const M = require(R + 'renderer/src/music/midi_core.js'), MM = require(R + 'renderer/src/musiclib/musiclib_melody.js'), MA = require(R + 'renderer/src/musiclib/musiclib_audio.js'), AM = require(R + 'renderer/src/music/audio_to_midi.js');
const SR = 16000, DIR = 'D:/Musics/midi/';
// 語料：目錄內前 N 個可解析、長度 30–90 秒、有音符的 MIDI（固定順序，結果可重現）
const N = Number(process.env.N_SONGS || 8), CAND = [];
function walk(d, depth) { if (depth > 2) return; for (const f of fs.readdirSync(d)) { const p = d + '/' + f; let st; try { st = fs.statSync(p); } catch (_) { continue; } if (st.isDirectory()) walk(p, depth + 1); else if (/\.midi?$/i.test(f)) CAND.push(p); } }
walk(DIR.replace(/\/$/, ''), 0);
const songs = [];
for (const p of CAND.sort()) {
  if (songs.length >= N) break;
  let s; try { s = M.parse(new Uint8Array(fs.readFileSync(p))); } catch (_) { continue; }
  const mel = MM.melodyFromSong(s); if (mel.length < 40) continue;
  const dur = mel[mel.length - 1].t + mel[mel.length - 1].d; if (dur < 30 || dur > 90) continue;
  const notes = []; s.tracks.forEach((tr) => { if (tr.drum) return; (tr.notes || []).forEach((n) => { const t0 = M.ticksToSec(s, n.t), t1 = M.ticksToSec(s, n.t + n.d); notes.push({ t: t0, d: t1 - t0, n: n.n, v: n.v || 90 }); }); });
  if (!notes.length) continue;
  songs.push({ file: p.split('/').pop(), mel, notes, dur: Math.max.apply(null, notes.map((x) => x.t + x.d)) + 0.3 });
}
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
function renderSong(sg) {
  const n = Math.floor(sg.dur * SR), x = new Float32Array(n);
  sg.notes.forEach((nt) => { const s0 = Math.floor(nt.t * SR), ln = Math.floor((nt.d + 0.3) * SR), f = mtof(nt.n), amp = 0.06 * nt.v / 127;
    for (let i = 0; i < ln && s0 + i < n; i++) { const tt = i / SR, env = Math.min(1, i / (0.003 * SR)) * Math.exp(-tt * 5); let v = 0; for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * f * h * tt) * Math.exp(-tt * (1.2 + h)) / h; x[s0 + i] += amp * env * v; } });
  return x;
}
let seed = 4242; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const gauss = () => { let s = 0; for (let k = 0; k < 6; k++) s += rnd(); return s - 3; };
function mic(x, p) {
  const y = Float32Array.from(x); const a = 1 - Math.exp(-2 * Math.PI * p.lp / SR); let s1 = 0, s2 = 0;
  for (let i = 0; i < y.length; i++) { s1 += a * (y[i] - s1); s2 += a * (s1 - s2); y[i] = s2; }
  if (p.rt60 > 0) { const rev = new Float32Array(y.length); for (const d of [0.0297, 0.0371, 0.0411, 0.0437]) { const Nn = Math.round(d * SR), g = Math.pow(10, -3 * Nn / (p.rt60 * SR)), buf = new Float32Array(Nn); let idx = 0; for (let i = 0; i < y.length; i++) { const o = buf[idx]; buf[idx] = y[i] + g * o; rev[i] += o / 4; idx = (idx + 1) % Nn; } } for (let i = 0; i < y.length; i++) y[i] = 0.5 * y[i] + 0.5 * rev[i]; }
  let ps = 0; for (let i = 0; i < y.length; i++) ps += y[i] * y[i]; ps /= y.length;
  if (p.snrDb != null) { const sd = Math.sqrt(ps / Math.pow(10, p.snrDb / 10)); for (let i = 0; i < y.length; i++) y[i] += sd * gauss(); }
  let mx = 0; for (let i = 0; i < y.length; i++) mx = Math.max(mx, Math.abs(y[i])); const g2 = p.gain / Math.max(1e-9, mx) * 0.7;
  for (let i = 0; i < y.length; i++) y[i] = Math.max(-1, Math.min(1, y[i] * g2));
  return y;
}
const CONDS = { clean: { lp: 9000, rt60: 0, snrDb: null, gain: 0.9 }, room: { lp: 4500, rt60: 0.5, snrDb: 15, gain: 0.5 }, harsh: { lp: 3500, rt60: 0.9, snrDb: 8, gain: 0.3 } };
function grams(notes) { const iv = []; for (let i = 1; i < notes.length; i++) iv.push(Math.max(-12, Math.min(12, Math.round(notes[i].n - notes[i - 1].n)))); const g = new Set(); for (let i = 0; i + 2 < iv.length; i++) g.add(iv[i] + ',' + iv[i + 1] + ',' + iv[i + 2]); return g; }
function ngramRank(qnotes, byKey, target) { const qg = grams(qnotes); if (!qg.size) return null; const scored = Object.keys(byKey).map((k) => { const sg = grams(byKey[k]); let hit = 0; qg.forEach((x) => { if (sg.has(x)) hit++; }); return { k, s: hit / qg.size }; }).sort((a, b) => b.s - a.s || a.k.localeCompare(b.k)); return scored.findIndex((x) => x.k === target) + 1; }
const PATHS = { viterbi: { viterbi: true } };
function notesOf(audio, pathOpts) { return MA.humNotes({ channels: [audio], sampleRate: SR }, Object.assign({ AudioToMidi: AM, thr: 0.3, glideMax: 0.12 }, pathOpts)).notes; }
// 索引：每首的整段音訊（乾淨）→ 旋律 → 輪廓
const audioOf = songs.map((sg) => renderSong(sg));
const out = { songs: songs.map((s) => ({ file: s.file, sec: +s.dur.toFixed(1), melNotes: s.mel.length })), results: {} };
for (const [pn, po] of Object.entries(PATHS)) {
  const notesByKey = {}; const entries = songs.map((sg, i) => { const nt = notesOf(audioOf[i], po); notesByKey[sg.file] = MM.melodyNotes(nt); const m = MM.melodyNotes(nt); return { key: sg.file, name: sg.file, lines: [{ label: '主旋律', contour: m.length >= MM.MIN_NOTES ? MM.contourOf(m) : null, mode: 'merged' }] }; }).filter((e) => e.lines[0].contour);
  out.results[pn] = {};
  for (const [cn, cp] of Object.entries(CONDS)) {
    let top1 = 0, top5 = 0, tot = 0, ng1 = 0, ng5 = 0, ngTot = 0;
    songs.forEach((sg, i) => {
      for (let q = 0; q < 2; q++) {
        const r = (rnd() * 0.6 + 0.1) * sg.dur, L = Math.min(12, sg.dur - r - 0.5), s0 = Math.floor(r * SR), s1 = Math.floor((r + L) * SR);
        const seg = audioOf[i].subarray(s0, s1), rec = mic(seg, cp);
        const qn = notesOf(rec, po); const sr = MM.searchMelody(qn, entries, { limit: 10 }); const keys = (sr.results || []).map((x) => x.key);
        const rk = keys.indexOf(sg.file) + 1; tot++; if (rk === 1) top1++; if (rk >= 1 && rk <= 5) top5++;
        const ngk = (MM.searchNgram(qn, entries, { limit: 50 }).results || []).map((x) => x.key); const ng = ngk.indexOf(sg.file) + 1; if (ng === 1) ng1++; if (ng >= 1 && ng <= 5) ng5++; ngTot++;
      }
    });
    out.results[pn][cn] = { queries: tot, top1: +(top1 / tot).toFixed(3), top5: +(top5 / tot).toFixed(3), ngramTop1: +(ng1 / ngTot).toFixed(3), ngramTop5: +(ng5 / ngTot).toFixed(3) };
    console.error(pn, cn, JSON.stringify(out.results[pn][cn]));
  }
}
console.log(JSON.stringify(out, null, 1));
