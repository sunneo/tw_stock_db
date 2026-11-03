// node scripts/music-tests/virtual_piano.test.js -- 虛擬鋼琴純邏輯:鍵位綁定、八度、匯出入、驗證
const V = require('../../renderer/src/music/virtual_piano.js');
let ok = 0; const bad = [];
const check = (name, cond, extra) => { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); };

const d = V.defaults();
check('defaults: C4 on Z, C#4 on S, G6 on ]; octaves 3–6', d.keys.KeyZ === 60 && d.keys.KeyS === 61 && d.keys.BracketRight === 91 && d.octaves.join() === '3,4,5,6' && Object.keys(d.shiftKeys).length === 0);
check('defaults: 32 keys, each note bound once (no two keys on one note)', Object.keys(d.keys).length === 32 && new Set(Object.values(d.keys)).size === 32);
const vn = V.visibleNotes([4]); check('visibleNotes: octave 4 is C4–B4 (60–71) with 5 black keys', vn.length === 12 && vn[0].midi === 60 && vn[11].midi === 71 && vn.filter((n) => n.black).length === 5, vn.length);
check('visibleNotes: octave 0 is A0–B0 (3 notes), octave 8 is C8 only, empty is empty', V.visibleNotes([0]).map((n) => n.name).join() === 'A0,A#0,B0' && V.visibleNotes([8]).map((n) => n.name).join() === 'C8' && V.visibleNotes([]).length === 0 && V.visibleNotes([0, 1, 2, 3, 4, 5, 6, 7, 8]).length === 88);
check('noteName', V.noteName(60) === 'C4' && V.noteName(21) === 'A0' && V.noteName(108) === 'C8' && V.noteName(61) === 'C#4');
// bind
let st = V.defaults(); const st2 = V.bind(st, 'KeyA', false, 60);
check('bind: the new key takes the note and the old key (Z) is released; original state untouched', st2.keys.KeyA === 60 && st2.keys.KeyZ === undefined && st.keys.KeyZ === 60 && st.keys.KeyA === undefined);
const st3 = V.bind(st, 'KeyX', false, 60); check('bind: a key that already played another note moves to the new note (one key, one note)', st3.keys.KeyX === 60 && st3.keys.KeyZ === undefined && Object.values(st3.keys).filter((m) => m === 62).length === 0, st3.keys);
const sh = V.bind(st, 'KeyZ', true, 72); check('bind with Shift goes to the shift table only, the plain table is unchanged', sh.shiftKeys.KeyZ === 72 && sh.keys.KeyZ === 60 && Object.keys(sh.keys).length === 32);
check('noteFor: Shift looks in the shift table first, falls back to the plain table; no Shift ignores the shift table', V.noteFor(sh, 'KeyZ', true) === 72 && V.noteFor(sh, 'KeyZ', false) === 60 && V.noteFor(sh, 'KeyS', true) === 61 && V.noteFor(sh, 'KeyK', false) === null);
check('unbind: removes the note from the chosen table only', V.unbind(sh, 72, true).shiftKeys.KeyZ === undefined && V.unbind(sh, 60, false).keys.KeyZ === undefined && V.unbind(sh, 60, false).shiftKeys.KeyZ === 72);
check('bind: bad input (no code / midi out of range) changes nothing', JSON.stringify(V.bind(st, '', false, 60)) === JSON.stringify(st) && JSON.stringify(V.bind(st, 'KeyA', false, 200)) === JSON.stringify(st));
check('labelsOf: plain and shift labels, special keys shown as symbols', V.labelsOf(sh, 60).plain === 'Z' && V.labelsOf(sh, 72).shift === 'Z' && V.labelsOf(sh, 89).plain === '[' && V.labelsOf(sh, 73).plain === '2' && V.keyLabel('Comma') === ',');
// export / import
const txt = V.serialize(sh); const back = V.parse(txt); check('serialize → parse round trip keeps octaves, keys and shift keys', back.state && JSON.stringify(back.state) === JSON.stringify(sh), back);
check('parse: wrong type, bad JSON are errors with a reason', /type/.test(V.parse('{"keys":{}}').error) && /JSON/.test(V.parse('nope').error));
const v = V.validate({ octaves: [4, 4, 9, -1, 'x', 2], keys: { KeyA: 60, 'bad key!': 61, KeyB: 999, KeyC: 'q' }, shiftKeys: 'no' }); check('validate: octaves de-duplicated and limited to 0–8, bad keys / notes dropped, non-object shift table becomes empty', v.octaves.join() === '2,4' && Object.keys(v.keys).join() === 'KeyA' && Object.keys(v.shiftKeys).length === 0, v);
check('validate: garbage input falls back to defaults', JSON.stringify(V.validate(null)) === JSON.stringify(V.defaults()) && V.validate({}).keys.KeyZ === 60 === true);

console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'ok'); console.log(ok + ' passed, ' + bad.length + ' failed'); process.exit(bad.length ? 1 : 0);
