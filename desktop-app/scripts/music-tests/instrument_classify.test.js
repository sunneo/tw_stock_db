// node scripts/music-tests/instrument_classify.test.js -- YAMNet 分數 → 封閉候選清單挑樂器,每個標籤都要對得到 GM 音色
const C = require('../../renderer/src/music/instrument_classify.js');
const A = require('../../renderer/src/music/audio_to_midi.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const mk = (frames, o) => { const s = new Float32Array(frames * 521); for (let f = 0; f < frames; f++) Object.keys(o).forEach((k) => { s[f * 521 + +k] = o[k]; }); return s; };
check('every candidate label maps to a GM program', C.CANDIDATES.every(([i, l]) => A.labelToProgram(l) != null), C.CANDIDATES.filter(([i, l]) => A.labelToProgram(l) == null));
check('bass labels map to bass, electric guitar to 27, piano to 0, Rhodes to 4', A.labelToProgram('Bass') === 33 && A.labelToProgram('Electric guitar') === 27 && A.labelToProgram('Piano') === 0 && A.labelToProgram('Rhodes') === 4);
let r = C.pick(mk(10, { 136: 0.6, 148: 0.1, 132: 0.9 }), 10);
check('picks electric guitar; the generic Music class (132) is not a candidate', r && r.label === 'Electric guitar' && r.confident, r);
check('two names for one instrument do not make a false tie (acoustic guitar via 138 and 135)', (r = C.pick(mk(10, { 135: 0.3, 138: 0.35, 148: 0.05 }), 10)) && r.label === 'Acoustic guitar' && r.confident, r);
check('too weak a score gives null (caller falls back to range rule)', C.pick(mk(10, { 148: 0.03 }), 10) === null);
check('close race is reported as not confident', (r = C.pick(mk(10, { 148: 0.30, 186: 0.29 }), 10)) && !r.confident, r);
check('no frames gives null', C.pick(new Float32Array(0), 0) === null);
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'ok'); console.log(ok + ' passed, ' + bad.length + ' failed'); process.exit(bad.length ? 1 : 0);
