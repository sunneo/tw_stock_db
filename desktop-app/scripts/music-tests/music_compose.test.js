// node scripts/music-tests/music_compose.test.js -- program-made composition: every style yields a valid song, same seed same song, checks hold
const M = require('../../renderer/src/music/midi_core.js');
const C = require('../../renderer/src/music/music_compose.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
for (const id of Object.keys(C.STYLES)) {
  const r = C.compose({ style: id, key: 'G', bars: 16, seed: 3 });
  const lead = r.song.tracks[0], per = (r.song.timesig.n * (4 / r.song.timesig.d)) * 480;
  check(id + ': valid song with melody, chords and bass', r.song.tracks.length >= 3 && lead.notes.length > 8 && r.song.tracks[1].notes.length && r.song.tracks[2].notes.length, r.song.tracks.map((t) => t.notes.length));
  check(id + ': passes its own checks (no warnings)', r.warnings.length === 0, r.warnings);
  check(id + ': melody stays in range and leaps are small', lead.notes.every((n) => n.n >= 55 && n.n <= 91) && lead.notes.every((n, i) => !i || Math.abs(n.n - lead.notes[i - 1].n) <= 9));
  check(id + ': round trips through the MIDI writer', M.parse(M.write(r.song)).tracks.length === r.song.tracks.length);
}
check('same seed gives the same song, other seed differs', JSON.stringify(C.compose({ style: 'pop', seed: 5 }).song) === JSON.stringify(C.compose({ style: 'pop', seed: 5 }).song) && JSON.stringify(C.compose({ style: 'pop', seed: 5 }).song) !== JSON.stringify(C.compose({ style: 'pop', seed: 9 }).song));
check('waltz is in 3/4 and has no drum track', (() => { const r = C.compose({ style: 'waltz' }); return r.song.timesig.n === 3 && r.song.tracks.every((t) => !t.drum); })());
check('drum styles get a drum track on channel 10', C.compose({ style: 'rock' }).song.tracks.some((t) => t.drum && t.channel === 9));
check('unknown style falls back to pop, bad numbers are clamped', (() => { const r = C.compose({ style: '???', tempo: 9999, bars: 1000 }); return r.style === 'pop' && r.options.tempo === 220 && r.options.bars === 64; })());
const q = C.parseRequest('幫我寫一首爵士的曲子，D調，80 bpm，8 小節');
check('parseRequest reads style, key, tempo and bars', q.style === 'jazz' && q.key === 'D' && q.tempo === 80 && q.bars === 8, q);
check('parseRequest: "快" picks the style\'s fast end', C.parseRequest('快的搖滾').tempo === C.STYLES.rock.tempo[1]);
check('sections for 16+ bars follow verse/chorus structure', C.compose({ style: 'pop', bars: 24 }).sections.map((s) => s.name).join() === '前奏,主歌,副歌,主歌,副歌,尾奏');
// 沒有專屬範本的風格／作曲家:對到最接近的範本並明講,不要靜默退成流行(使用者回報:「貝多芬風格」走偏)
{ const b = C.parseRequest('寫一首貝多芬風格的曲子'), r = C.compose(b);
  check('unknown composer maps to the closest template and says so', b.style === 'classical' && /貝多芬/.test(r.styleNote) && /古典/.test(r.styleNote) && /不是貝多芬的真實作品/.test(r.styleNote), r.styleNote);
  check('english composer name also maps (Beethoven -> classical)', C.parseRequest('write Beethoven style music').style === 'classical');
  check('metal maps to rock, hip hop maps to lofi', C.parseRequest('重金屬').style === 'rock' && C.parseRequest('hip hop beat').style === 'lofi');
  check('a known style gives no note', C.compose(C.parseRequest('來一首爵士')).styleNote === '');
  const u = C.parseRequest('寫一首很哀傷風格的曲子'); check('a style word with no template says it falls back to pop', !u.style && /流行/.test(u.styleNote) && C.compose(u).style === 'pop');
  check('a bare request ("幫我做 MIDI") makes a piece with no fuss', C.compose(C.parseRequest('幫我做 MIDI')).styleNote === ''); }
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'ok'); console.log(ok + ' passed, ' + bad.length + ' failed'); process.exit(bad.length ? 1 : 0);
