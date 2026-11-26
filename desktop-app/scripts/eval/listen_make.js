// 對照聽：Grandfathers-Clock 的「房間麥克風」錄音（中等殘響）→ 新 Viterbi 與舊路徑的轉譜 MIDI；另存真值 MIDI。
const R = 'D:/Downloads/videos-嗨投資/.claude/worktrees/objective-nash-008719/desktop-app/';
const fs = require('fs');
const M = require(R + 'renderer/src/music/midi_core.js'), MM = require(R + 'renderer/src/musiclib/musiclib_melody.js'), MA = require(R + 'renderer/src/musiclib/musiclib_audio.js'), AM = require(R + 'renderer/src/music/audio_to_midi.js');
const SR = 16000, OUT = 'E:/Temp/';
const song = M.parse(new Uint8Array(fs.readFileSync('D:/Musics/midi/Grandfathers-Clock.mid')));
const truth = MM.melodyFromSong(song).map((x) => ({ t: x.t, d: x.d, n: x.n, v: x.v }));
const dur = Math.max.apply(null, truth.map((x) => x.t + x.d)) + 0.3;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
// 與 reverb 網格相同的音源與房間條件（中等殘響）
const allNotes = []; song.tracks.forEach((tr) => { if (tr.drum) return; (tr.notes || []).forEach((n) => { const t0 = M.ticksToSec(song, n.t), t1 = M.ticksToSec(song, n.t + n.d); allNotes.push({ t: t0, d: t1 - t0, n: n.n, v: n.v || 90, vibe: tr.program === 11 || /VIB/i.test(String(tr.name || '')) }); }); });
const n = Math.floor(dur * SR), x = new Float32Array(n);
allNotes.forEach((nt) => { const s0 = Math.floor(nt.t * SR), ln = Math.floor((nt.d + 0.3) * SR), f = mtof(nt.n), amp = 0.08 * nt.v / 127; for (let i = 0; i < ln && s0 + i < n; i++) { const tt = i / SR, env = Math.min(1, i / (0.003 * SR)) * Math.exp(-tt * 5); let v = 0; for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * f * h * tt) * Math.exp(-tt * (1.2 + h)) / h; x[s0 + i] += amp * env * v; } });
let seed = 7; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const rec = (() => { const y = Float32Array.from(x), a = 1 - Math.exp(-2 * Math.PI * 4500 / SR); let s1 = 0, s2 = 0; for (let i = 0; i < y.length; i++) { s1 += a * (y[i] - s1); s2 += a * (s1 - s2); y[i] = s2; } const rev = new Float32Array(y.length); for (const d of [0.0297, 0.0371, 0.0411, 0.0437]) { const Nn = Math.round(d * SR), g = Math.pow(10, -3 * Nn / (0.5 * SR)), buf = new Float32Array(Nn); let idx = 0; for (let i = 0; i < y.length; i++) { const o = buf[idx]; buf[idx] = y[i] + g * o; rev[i] += o / 4; idx = (idx + 1) % Nn; } } for (let i = 0; i < y.length; i++) y[i] = 0.5 * y[i] + 0.5 * rev[i]; let ps = 0; for (let i = 0; i < y.length; i++) ps += y[i] * y[i]; ps /= y.length; const sd = Math.sqrt(ps / Math.pow(10, 1.5)); for (let i = 0; i < y.length; i++) { let g6 = 0; for (let k = 0; k < 6; k++) g6 += rnd(); y[i] = Math.max(-1, Math.min(1, (y[i] + sd * (g6 - 3)) * 0.5)); } return y; })();
function toSong(notes, title) { let s = M.emptySong(); s.title = title; s = M.addTrack(s, title, 0, false); const ti = s.tracks.length - 1; notes.forEach((q) => { s = M.addNote(s, ti, { t: M.secToTicks(s, q.t), d: Math.max(1, M.secToTicks(s, q.t + q.d) - M.secToTicks(s, q.t)), n: Math.round(q.n), v: Math.max(30, Math.min(127, q.v || 90)) }); }); return s; }
const rows = {};
for (const [name, po] of [['viterbi', { viterbi: true }], ['oldFold', { viterbi: false }]]) {
  const nt = MA.humNotes({ channels: [rec], sampleRate: SR }, Object.assign({ AudioToMidi: AM, thr: 0.3, glideMax: 0.12 }, po)).notes;
  fs.writeFileSync(OUT + 'listen_grandfathers_' + name + '_room.mid', Buffer.from(M.write(toSong(nt, name))));
  rows[name] = nt.length;
}
fs.writeFileSync(OUT + 'listen_grandfathers_truth_melody.mid', Buffer.from(M.write(toSong(truth, 'truth'))));
console.log(JSON.stringify({ notes: rows, durSec: +dur.toFixed(1), truthNotes: truth.length }));
