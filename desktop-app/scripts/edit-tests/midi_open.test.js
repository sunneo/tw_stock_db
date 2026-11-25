// node scripts/edit-tests/midi_open.test.js -- MIDI 編輯器 📂 開啟 .mid：解析、副檔名、大小、壞檔
const O = require('../../renderer/src/music/midi_open.js');
const M = require('../../renderer/src/music/midi_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }

// 1. 寫出一首有音符的曲子，再讀回來（往返）
{
  let song = M.emptySong();
  song = M.addTrack(song, '鋼琴', 0);
  song.tracks[0].notes = [{ t: 0, d: 480, n: 60, v: 100 }, { t: 480, d: 480, n: 64, v: 100 }];
  const bytes = M.write(song);
  const f = O.fromFile(bytes, '小星星.mid');
  check('標題取檔名', f.title === '小星星', f.title);
  check('音軌數一樣', f.song.tracks.length === song.tracks.length, f.song.tracks.length);
  check('音符數一樣', f.song.tracks[0].notes.length === 2, f.song.tracks[0].notes);
  check('音高保留', f.song.tracks[0].notes[0].n === 60 && f.song.tracks[0].notes[1].n === 64, f.song.tracks[0].notes);
}
// 2. 副檔名大小寫、ArrayBuffer 都行
{
  const bytes = M.write(M.emptySong());
  check('大寫 .MIDI 可讀', O.fromFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 'A.MIDI').title === 'A');
}
// 3. 不是 .mid 拒絕
{
  let e = null; try { O.fromFile(new Uint8Array([1, 2]), 'a.mp3'); } catch (x) { e = x; }
  check('非 .mid 拒絕', e && /不是 \.mid/.test(e.message), e && e.message);
}
// 4. 太大拒絕
{
  let e = null; try { O.fromFile(new Uint8Array(O.MAX_BYTES + 1), 'big.mid'); } catch (x) { e = x; }
  check('太大拒絕', e && /太大/.test(e.message), e && e.message);
}
// 5. 壞檔給可讀的錯誤
{
  let e = null; try { O.fromFile(new Uint8Array([0, 1, 2, 3, 4, 5]), 'bad.mid'); } catch (x) { e = x; }
  check('壞檔丟出讀不了的錯誤', e && /讀不了/.test(e.message), e && e.message);
}
// 6. 選檔設定
check('選檔類型只收 .mid／.midi', O.TYPES[0].accept['audio/midi'].join(',') === '.mid,.midi');

console.log('midi_open: ' + ok + ' 通過，' + bad.length + ' 失敗');
if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
