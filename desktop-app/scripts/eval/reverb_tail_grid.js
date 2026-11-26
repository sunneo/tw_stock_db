// 殘響尾巴抑制的參數網格：真實 MIDI 渲染（Grandfathers-Clock）＋三種喇叭→麥克風條件，量非模型 Viterbi 的幀準確度與碎音比例。
const R = 'D:/Downloads/videos-嗨投資/.claude/worktrees/objective-nash-008719/desktop-app/';
const fs = require('fs');
const M = require(R + 'renderer/src/music/midi_core.js'), MM = require(R + 'renderer/src/musiclib/musiclib_melody.js'), MA = require(R + 'renderer/src/musiclib/musiclib_audio.js'), AM = require(R + 'renderer/src/music/audio_to_midi.js');
const SR = 16000;
const song = M.parse(new Uint8Array(fs.readFileSync('D:/Musics/midi/Grandfathers-Clock.mid')));
const allNotes = []; song.tracks.forEach((tr, ti) => { if (tr.drum) return; (tr.notes || []).forEach((n) => { const t0 = M.ticksToSec(song, n.t), t1 = M.ticksToSec(song, n.t + n.d); allNotes.push({ t: t0, d: t1 - t0, n: n.n, v: n.v, tr: ti }); }); });
const truth = MM.melodyFromSong(song).map((x) => ({ t: x.t, d: x.d, n: x.n, v: x.v }));
const DUR = Math.max.apply(null, allNotes.map((x) => x.t + x.d)) + 0.5;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
function render() {
  const n = Math.floor(DUR * SR), x = new Float32Array(n);
  allNotes.forEach((nt) => {
    const vibe = nt.tr === 2 || nt.tr === 3, amp = 0.08 * (nt.v || 90) / 127, s0 = Math.floor(nt.t * SR), ln = Math.floor((nt.d + (vibe ? 0.8 : 0.25)) * SR), f = mtof(nt.n);
    for (let i = 0; i < ln && s0 + i < n; i++) { const tt = i / SR, env = vibe ? Math.min(1, i / (0.01 * SR)) * Math.exp(-tt * 1.6) : Math.min(1, i / (0.003 * SR)) * Math.exp(-tt * 7); let v = 0; if (vibe) { const trem = 1 + 0.15 * Math.sin(2 * Math.PI * 5.5 * tt); v = (Math.sin(2 * Math.PI * f * tt) + 0.35 * Math.sin(2 * Math.PI * 4 * f * tt) * Math.exp(-tt * 3)) * trem; } else { for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * tt) * Math.exp(-tt * (1.5 + 1.2 * h)) / h; } x[s0 + i] += amp * env * v; }
  });
  return x;
}
let seed = 99; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const gauss = () => { let s = 0; for (let k = 0; k < 6; k++) s += rnd(); return s - 3; };
function mic(x, p) {
  const y = Float32Array.from(x); const a = 1 - Math.exp(-2 * Math.PI * p.lp / SR); let s1 = 0, s2 = 0;
  for (let i = 0; i < y.length; i++) { s1 += a * (y[i] - s1); s2 += a * (s1 - s2); y[i] = s2; }
  if (p.rt60 > 0) { const rev = new Float32Array(y.length); for (const d of [0.0297, 0.0371, 0.0411, 0.0437]) { const N = Math.round(d * SR), g = Math.pow(10, -3 * N / (p.rt60 * SR)), buf = new Float32Array(N); let idx = 0; for (let i = 0; i < y.length; i++) { const o = buf[idx]; buf[idx] = y[i] + g * o; rev[i] += o / 4; idx = (idx + 1) % N; } } for (let i = 0; i < y.length; i++) y[i] = 0.5 * y[i] + 0.5 * rev[i]; }
  let ps = 0; for (let i = 0; i < y.length; i++) ps += y[i] * y[i]; ps /= y.length;
  if (p.snrDb != null) { const sd = Math.sqrt(ps / Math.pow(10, p.snrDb / 10)); for (let i = 0; i < y.length; i++) y[i] += sd * gauss(); }
  for (let i = 0; i < y.length; i++) y[i] = Math.max(-1, Math.min(1, y[i] * p.gain));
  return y;
}
function f1(est, tr) { const used = new Set(); let tp = 0; for (const e of est) { let best = -1, bd = 1e9; tr.forEach((t, i) => { if (used.has(i)) return; const dt = Math.abs(e.t - t.t); if (dt > 0.05 || Math.abs(e.n - t.n) > 0.5) return; if (dt < bd) { bd = dt; best = i; } }); if (best >= 0) { used.add(best); tp++; } } const p = est.length ? tp / est.length : 0, rc = tr.length ? tp / tr.length : 0; return p + rc > 0 ? +(2 * p * rc / (p + rc)).toFixed(3) : 0; }
function frameAcc(est, tr, dur) { const s = est.slice().sort((a, b) => a.t - b.t); let tot = 0, ok = 0, ti = 0; for (let t = 0; t < dur; t += 0.01) { while (ti < tr.length && tr[ti].t + tr[ti].d <= t) ti++; if (ti >= tr.length || t < tr[ti].t) continue; tot++; const es = s.find((x) => t >= x.t && t < x.t + x.d); if (es && Math.abs(es.n - tr[ti].n) <= 0.5) ok++; } return tot ? +(ok / tot).toFixed(3) : 0; }
const short = (e) => e.length ? +(e.filter((x) => x.d < 0.12).length / e.length).toFixed(3) : 0;
const clean = render();
const CONDS = { clean: { gain: 0.9, lp: 9000, rt60: 0, snrDb: null }, room: { gain: 0.5, lp: 4500, rt60: 0.5, snrDb: 15 }, harsh: { gain: 0.3, lp: 3500, rt60: 0.9, snrDb: 8 } };
const recs = {}; for (const [c, p] of Object.entries(CONDS)) recs[c] = c === 'clean' ? clean : mic(clean, p);
const GRID = [null, { lagMin: 5, lagMax: 30, decay: 0.93, beta: 0.6 }, { lagMin: 5, lagMax: 30, decay: 0.93, beta: 0.9 }, { lagMin: 5, lagMax: 50, decay: 0.95, beta: 0.9 }, { lagMin: 3, lagMax: 40, decay: 0.9, beta: 1.0 }, { lagMin: 8, lagMax: 60, decay: 0.96, beta: 1.0 }];
for (const g of GRID) {
  const row = [];
  for (const c of Object.keys(CONDS)) {
    const est = MA.humNotes({ channels: [recs[c]], sampleRate: SR }, { AudioToMidi: AM, thr: 0.3, glideMax: 0.12, tail: g }).notes;
    row.push(c + ' fa=' + frameAcc(est, truth, DUR) + ' f1=' + f1(est, truth) + ' short=' + short(est));
  }
  console.log((g ? JSON.stringify(g) : 'off').padEnd(60), row.join(' | '));
}
