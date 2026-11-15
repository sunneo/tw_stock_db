// node scripts/music-tests/midi_editor_export.test.js -- MIDI 編輯器的「匯出」選單:選項只有 MIDI、MP3;檔名去掉不合法字元
const U = require('../../renderer/src/music/midi_editor_ui.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }

check('export choices: exactly MIDI and MP3', U.EXPORT_CHOICES.map((c) => c.id).join(',') === 'midi,mp3', U.EXPORT_CHOICES);
check('export choices: labels mention extension', U.EXPORT_CHOICES[0].label.indexOf('.mid') > 0 && U.EXPORT_CHOICES[1].label.indexOf('.mp3') > 0);
check('exportName: plain title', U.exportName('爵士曲', 'mp3') === '爵士曲.mp3', U.exportName('爵士曲', 'mp3'));
check('exportName: illegal chars replaced', U.exportName('a/b:c*?"<>|', 'mid') === 'a_b_c______.mid', U.exportName('a/b:c*?"<>|', 'mid'));
check('exportName: empty title falls back to song', U.exportName('', 'mid') === 'song.mid', U.exportName('', 'mid'));
check('exportName: no title', U.exportName(undefined, 'mp3') === 'song.mp3');

console.log('midi_editor_export: ' + ok + ' 項通過' + (bad.length ? '，' + bad.length + ' 項失敗' : ''));
if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
