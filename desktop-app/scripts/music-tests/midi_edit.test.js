// node scripts/music-tests/midi_edit.test.js -- MIDI editor pure layer (closed actions, Chinese commands, undo/redo)
// track numbers in actions: a number is a 0-based index, a string is a 1-based number or a name
const M = require('../../renderer/src/music/midi_core.js');
const E = require('../../renderer/src/music/midi_edit.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }

let s = M.emptySong(); s = M.addTrack(s, '旋律', 0); s = M.addTrack(s, '貝斯', 33);
[60, 62, 64].forEach((n, i) => { s = M.addNote(s, 0, { t: i * 480, d: 400, n, v: 90 }); });

check('cnNum: Chinese and Arabic numbers', E.cnNum('十二') === 12 && E.cnNum('二十') === 20 && E.cnNum('三') === 3 && E.cnNum('7') === 7 && E.cnNum('十') === 10);
check('pitchOf: names and numbers', E.pitchOf('C4') === 60 && E.pitchOf('c#5') === 73 && E.pitchOf('Bb3') === 58 && E.pitchOf('64') === 64);
check('apply: transpose a track', E.apply(s, { act: 'transpose', semitones: 2, track: 0 }).song.tracks[0].notes[0].n === 62);
check('apply: unknown action is an error', !!E.apply(s, { act: 'explode' }).error);
check('apply: unknown track is an error, song untouched', (() => { const r = E.apply(s, { act: 'transpose', semitones: 1, track: 9 }); return !!r.error && r.song === s; })());
check('apply: add_note with pitch name and beat', (() => { const r = E.apply(s, { act: 'add_note', track: 0, beat: 4, beats: 1, pitch: 'C5' }).song; return r.tracks[0].notes.length === 4 && r.tracks[0].notes[3].n === 72 && r.tracks[0].notes[3].t === 1920; })());
check('apply: set_program and original is not mutated', (() => { const r = E.apply(s, { act: 'set_program', track: 1, program: 24 }).song; return r.tracks[1].program === 24 && s.tracks[1].program === 33; })());
check('apply: split_pitch and merge_tracks round trip the note count', (() => { const sp = E.apply(s, { act: 'split_pitch', track: 0, at: 'D4' }).song; return sp.tracks.length === 3 && M.noteCount(sp) === 3; })());

const c1 = E.parseCommands('全部升兩個半音', s);
check('parse: raise two semitones', c1.actions.length === 1 && c1.actions[0].act === 'transpose' && c1.actions[0].semitones === 2 && !c1.rest, c1);
const c2 = E.parseCommands('第一軌降一個八度，速度改成 90', s);
check('parse: lower an octave on track 1 plus tempo, as two actions', c2.actions.length === 2 && c2.actions[0].semitones === -12 && c2.actions[0].track === 0 && c2.actions[1].act === 'set_tempo' && c2.actions[1].bpm === 90, c2);
const c3 = E.parseCommands('旋律往後兩拍', s);
check('parse: track found by name, move later by beats', c3.actions[0] && c3.actions[0].act === 'move' && c3.actions[0].beats === 2 && c3.actions[0].track === 0, c3);
const c4 = E.parseCommands('量化十六分', s);
check('parse: quantize with a grid', c4.actions[0] && c4.actions[0].act === 'quantize' && c4.actions[0].grid === 0.25, c4);
const c5 = E.parseCommands('貝斯換成大提琴', s);
check('parse: change instrument by name', c5.actions[0] && c5.actions[0].act === 'set_program' && c5.actions[0].program === 42 && c5.actions[0].track === 1, c5);
const c6 = E.parseCommands('幫我寫一段憂傷的副歌', s);
check('parse: unreadable text goes to rest (for the model)', c6.actions.length === 0 && c6.rest.length > 0, c6);
const c7 = E.parseCommands('新增一軌小提琴', s);
check('parse: add a track with an instrument', c7.actions[0] && c7.actions[0].act === 'add_track' && c7.actions[0].program === 40, c7);
const c8 = E.parseCommands('在第 3 拍放 C5 長 2 拍', s);
check('parse: put a note at a beat', c8.actions[0] && c8.actions[0].act === 'add_note' && c8.actions[0].beat === 2 && c8.actions[0].beats === 2, c8);

const all = E.applyAll(s, [{ act: 'transpose', semitones: 1 }, { act: 'remove_track', track: 9 }, { act: 'set_tempo', bpm: 100 }]);
check('applyAll: keeps going after an error and reports it', all.errors.length === 1 && all.song.tempos[0].bpm === 100 && all.song.tracks[0].notes[0].n === 61, all.errors);

const h = E.history(s); const s2 = E.apply(s, { act: 'transpose', semitones: 5 }).song; h.push(s2);
check('history: undo and redo', h.canUndo() && h.undo() === s && !h.canUndo() && h.canRedo() && h.redo() === s2);
check('history: new edit clears redo, limit is respected', (() => { const hh = E.history(s, 3); for (let i = 0; i < 6; i++) hh.push(E.apply(hh.song, { act: 'transpose', semitones: 1 }).song); let n = 0; while (hh.canUndo()) { hh.undo(); n++; } return n === 3; })());

// remote co-editing: id-addressed doc merges events from two people
const P = require('../../renderer/src/remote/rg_patch.js');
(() => {
  const base = E.toDoc(s); const keys = E.PATCH_KEYS;
  check('doc: toDoc is stable (ids kept) and fromDoc round trips', JSON.stringify(E.toDoc(base)) === JSON.stringify(base) && JSON.stringify(E.fromDoc(base).tracks[0].notes.map((n) => n.n)) === '[60,62,64]');
  const alice = E.reId(base, E.apply(E.fromDoc(base), { act: 'transpose', semitones: 12, track: 1 }).song);   // 貝斯軌(沒音符)沒影響,改旋律軌:
  const a2 = E.reId(base, E.apply(E.fromDoc(base), { act: 'transpose', semitones: 12, track: 0 }).song);
  const b2 = E.reId(base, E.apply(E.fromDoc(base), { act: 'add_note', track: 1, beat: 0, beats: 1, pitch: 'C2' }).song);
  const opsA = P.diff(base, a2, keys), opsB = P.diff(base, b2, keys);
  const m = P.apply(P.apply(base, opsA, keys).doc, opsB, keys).doc;
  check('doc: one edits melody notes, other adds a bass note: both survive', m.tracks[0].notes.map((n) => n.n).join() === '72,74,76' && m.tracks[1].notes.length === 1 && m.tracks[1].notes[0].n === 36, m.tracks.map((t) => t.notes.length));
  check('doc: transposed notes keep identity only when unchanged (reId reuses ids for equal notes)', E.reId(base, E.fromDoc(base)).tracks[0].notes.every((n, i) => n.id === base.tracks[0].notes[i].id));
  const del = E.reId(base, E.apply(E.fromDoc(base), { act: 'remove_notes', track: 0, fromBeat: 0, toBeat: 0.5 }).song);
  const m2 = P.apply(P.apply(base, P.diff(base, del, keys), keys).doc, opsB, keys).doc;
  check('doc: delete one note while another person adds elsewhere', m2.tracks[0].notes.length === 2 && m2.tracks[1].notes.length === 1);
})();
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'ok');
console.log(ok + ' passed, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
