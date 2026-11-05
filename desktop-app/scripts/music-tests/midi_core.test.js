// node scripts/music-tests/midi_core.test.js -- the MIDI core (parse, write, round trip, edits, time conversion)
const M = require('../../renderer/src/music/midi_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }

const song = () => {
  let s = M.emptySong(); s.title = '測試';
  s = M.addTrack(s, '旋律', 0); s = M.addTrack(s, '貝斯', 33); s = M.addTrack(s, '鼓', 0, true);
  const mel = [60, 62, 64, 65, 67];
  mel.forEach((n, i) => { s = M.addNote(s, 0, { t: i * 480, d: 400, n, v: 90 }); });
  s = M.addNote(s, 1, { t: 0, d: 1920, n: 36, v: 100 });
  s = M.addNote(s, 2, { t: 0, d: 120, n: 36, v: 110 }); s = M.addNote(s, 2, { t: 480, d: 120, n: 38, v: 100 });
  return s;
};

const s = song();
check('model: tracks get distinct channels and the drum track is on channel 10 (index 9)', s.tracks.map((t) => t.channel).join() === '0,1,9' && s.tracks[2].drum);
check('write: header is MThd, format 1, ppq 480, one tempo track plus one per track', (() => { const b = M.write(s); return b[0] === 0x4d && b[8] === 0 && b[9] === 1 && b[10] === 0 && b[11] === 4 && ((b[12] << 8) | b[13]) === 480; })());
const rt = M.parse(M.write(s));
check('round trip: track count, names, programs, notes survive', rt.tracks.length === 3 && rt.tracks[1].name === '貝斯' && rt.tracks[1].program === 33 && rt.tracks[0].notes.length === 5 && JSON.stringify(rt.tracks[0].notes) === JSON.stringify(s.tracks[0].notes));
check('round trip: drum track stays on channel 9 and keeps its notes', rt.tracks[2].drum && rt.tracks[2].channel === 9 && rt.tracks[2].notes.length === 2);
check('round trip: title, tempo and time signature', rt.title === '測試' && rt.tempos[0].bpm === 120 && rt.timesig.n === 4 && rt.timesig.d === 4);
check('round trip: writing twice gives identical bytes', Buffer.from(M.write(rt)).equals(Buffer.from(M.write(M.parse(M.write(rt))))));
check('parse: rejects a file that is not MIDI', (() => { try { M.parse(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])); return false; } catch (e) { return /MThd/.test(e.message); } })());

// a hand-made format 0 file with running status and a note-on velocity 0 note-off
const f0 = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96,
  0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 25,
  0x00, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, // tempo 500000 = 120 bpm
  0x00, 0x90, 60, 100, // note on
  0x60, 60, 0, // running status, velocity 0 = off at tick 96 (ppq 96 -> 480)
  0x00, 0x90, 64, 80,
  0x60, 64, 0,
  0x00, 0xff, 0x2f, 0]);
const p0 = M.parse(f0);
check('parse: format 0 with ppq 96 is rescaled to 480 and running status works', p0.tracks.length === 1 && p0.tracks[0].notes.length === 2 && p0.tracks[0].notes[0].d === 480 && p0.tracks[0].notes[1].t === 480, p0.tracks[0] && p0.tracks[0].notes);

// time
const tm = M.emptySong(); tm.tempos = [{ t: 0, bpm: 120 }, { t: 1920, bpm: 60 }];
check('time: tempo map converts ticks to seconds (4 beats at 120 then 4 beats at 60 = 6 s)', Math.abs(M.ticksToSec(tm, 3840) - 6) < 1e-9);
check('time: seconds convert back to ticks', M.secToTicks(tm, 6) === 3840 && M.secToTicks(tm, 1) === 960);
check('time: duration is measured to the last note end', Math.abs(M.durationSec(s) - 2320 / 960) < 1e-9, M.durationSec(s));

// edits
const tp = M.transpose(s, 5);
check('transpose: melody and bass move, drums do not, the original is untouched', tp.tracks[0].notes[0].n === 65 && tp.tracks[1].notes[0].n === 41 && tp.tracks[2].notes[0].n === 36 && s.tracks[0].notes[0].n === 60);
check('transpose: clamps at the ends of the keyboard', M.transpose(M.addNote(M.addTrack(M.emptySong(), 'x', 0), 0, { t: 0, d: 10, n: 126 }), 12).tracks[0].notes[0].n === 127);
const loose = M.addNote(M.addNote(M.addTrack(M.emptySong(), 'x', 0), 0, { t: 130, d: 100, n: 60 }), 0, { t: 250, d: 130, n: 62 });
const q = M.quantize(loose, 120);
check('quantize: starts snap to the grid and lengths never drop below one grid step', q.tracks[0].notes[0].t === 120 && q.tracks[0].notes[1].t === 240 && q.tracks[0].notes.every((n) => n.d >= 120), q.tracks[0].notes);
check('quantize: keepLength leaves lengths alone', M.quantize(loose, 120, null, { keepLength: true }).tracks[0].notes[0].d === 100);
check('mergeTracks: notes combine in time order and the source track disappears', (() => { const m = M.mergeTracks(s, 0, 1); return m.tracks.length === 2 && m.tracks[0].notes.length === 6 && m.tracks[0].notes[0].t === 0; })());
check('splitByPitch: one track becomes a high and a low track, empty halves are dropped', (() => { const sp = M.splitByPitch(s, 0, 64); return sp.tracks.length === 4 && sp.tracks[0].notes.every((n) => n.n >= 64) && sp.tracks[1].notes.every((n) => n.n < 64) && M.splitByPitch(s, 0, 20).tracks.length === 3; })());
check('removeNotes: a time and pitch window removes exactly what is inside it', (() => { const r = M.removeNotes(s, 0, 0, 960, 60, 62); return r.removed === 2 && r.song.tracks[0].notes.length === 3; })());
check('setTempo / scaleVelocity / shiftTime behave', M.setTempo(s, 90).tempos[0].bpm === 90 && M.scaleVelocity(s, 0.5).tracks[0].notes[0].v === 45 && M.shiftTime(s, -10000).tracks[0].notes[0].t === 0 && M.shiftTime(s, 480).tracks[0].notes[0].t === 480);

// validation
const junk = M.validate({ tempos: [{ t: 99, bpm: 9999 }], timesig: { n: 0, d: 5 }, tracks: [{ channel: 40, program: 300, notes: [{ t: -5, d: 0, n: 999, v: 0 }, null, { t: 5, d: 5, n: 'x', v: 'y' }] }, null, 'x'] });
check('validate: out-of-range values are clamped, nulls dropped, the first tempo starts at 0', junk.tempos[0].t === 0 && junk.tempos[0].bpm === 400 && junk.timesig.n === 1 && junk.timesig.d === 4 && junk.tracks.length === 1 && junk.tracks[0].channel === 15 && junk.tracks[0].program === 127 && junk.tracks[0].notes.length === 2 && junk.tracks[0].notes[0].n === 127 && junk.tracks[0].notes[0].v === 1 && junk.tracks[0].notes[0].d === 1, junk);
check('validate: garbage in gives an empty valid song, never an exception', M.validate(null).tracks.length === 0 && M.validate('x').tempos.length === 1);
check('summary: mentions track count, drum label and note range', (() => { const t = M.summary(s); return /3 軌/.test(t) && /鼓組/.test(t) && /C4–G4/.test(t); })(), M.summary(s));
check('noteName: middle C is C4', M.noteName(60) === 'C4' && M.noteName(21) === 'A0');
// 多層 JSONL：攤平與還原
{
  let big = M.emptySong(); big.title = '大曲'; big.timesig = { n: 3, d: 4 }; big = M.addTrack(big, '旋律', 0); big = M.addTrack(big, '鼓', 0, true);
  for (let i = 0; i < 400; i++) big = M.addNote(big, 0, { t: i * 240, d: 200, n: 48 + (i * 7) % 30, v: 60 + i % 50 });
  for (let i = 0; i < 100; i++) big = M.addNote(big, 1, { t: i * 480, d: 100, n: 36 + i % 3, v: 100 });
  const full = M.toJsonl(big); const back = M.fromJsonl(full.lines);
  check('jsonl: full round trip equals the song', back.ok && JSON.stringify(back.song) === JSON.stringify(big) || (back.ok && require('assert').deepStrictEqual(back.song, big) === undefined), back.missing);
  check('jsonl: levels give layers (song+tracks < +bars < +notes)', M.toJsonl(big, { levels: 0 }).count === 3 && M.toJsonl(big, { levels: 1 }).count > 3 && M.toJsonl(big, { levels: 1 }).count < full.count);
  const top = M.fromJsonl(M.toJsonl(big, { levels: 1 }).lines); check('jsonl: top levels restore with missing notes reported', top.ok && top.missing.length === 2 && top.missing[0].have === 0 && top.missing[0].declared === 400, top.missing);
  const l = M.toJsonl(big, { levels: 1 }).lines.concat(M.expandNotes(big, 0).lines, M.expandNotes(big, 1).lines); const b2 = M.fromJsonl(l);
  check('jsonl: drill down per track restores everything', b2.ok && b2.missing.length === 0 && b2.song.tracks[0].notes.length === 400 && b2.song.tracks[1].notes[99].t === 99 * 480);
  const eb = M.expandNotes(big, 0, 2); check('jsonl: expand one bar gives its notes with bar/beat/name', eb.lines.length === 6 && JSON.parse(eb.lines[0]).bar === 2 && JSON.parse(eb.lines[0]).beat === 1 && JSON.parse(eb.lines[0]).name.length >= 2, eb.lines);
  check('jsonl: bad track and garbage handled', M.expandNotes(big, 9).ok === false && M.fromJsonl(['x']).ok === false);
}

console.log(ok + ' passed, ' + bad.length + ' failed'); bad.forEach((b) => console.log('FAIL: ' + b)); process.exit(bad.length ? 1 : 0);
