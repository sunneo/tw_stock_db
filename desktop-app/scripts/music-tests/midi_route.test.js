// node scripts/music-tests/midi_route.test.js -- 「寫貝多芬風格的 MIDI」這類說法要穩定進 midi_compose(任務提示規則與離線規則都讀原始碼裡的正規表示式來測)
const fs = require('fs'), path = require('path');
const s = fs.readFileSync(path.join(__dirname, '../../renderer/src/floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n'); // Windows 工作樹是 CRLF，統一成 LF 再定位
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 200) : '')); }
const i = s.indexOf("id: 'midi_compose',\n    re: "); check('task hint for midi_compose exists', i > 0);
const block = s.slice(i, i + 2600), re = eval(/re: (\/.*\/i),/.exec(block)[1]), neg = eval(/neg: (\/.*\/i),/.exec(block)[1]);
const j = s.indexOf("id: 'midi_compose_request'"); check('offline rule for midi_compose exists', j > 0);
const off = new RegExp(/expr: '((?:[^'\\]|\\.)*)'/.exec(s.slice(j, j + 1500))[1].replace(/\\\\/g, '\\'));
const hint = (t) => re.test(t) && !neg.test(t);
['寫貝多芬風格的 MIDI', '寫一首貝多芬風格的曲子', '幫我做 MIDI', '幫我作一首輕快的爵士', '做一首 lofi 的背景音樂', '幫我寫一首歌', '產生一段 MIDI 配樂', 'compose a melody in D major'].forEach((t) => {
  check('hint routes: ' + t, hint(t)); if (!/compose/.test(t)) check('offline rule routes: ' + t, off.test(t));
});
['播放這個 midi', '把 mp3 轉成 midi', '怎麼寫一首曲子', '什麼是和弦', '幫我寫一個 python 程式', '幫我寫一份報告', '寫一首詩', '上傳的 mid 檔幫我轉成 mp3'].forEach((t) => {
  check('hint leaves alone: ' + t, !hint(t)); check('offline rule leaves alone: ' + t, !off.test(t));
});
const blk = s.slice(i, i + 2600);
check('hint lists midi_compose first and tells the model to use cards, not scripts', /tools: \['midi_compose'/.test(blk) && /不要自己寫 Python／mido/.test(blk) && /卡片交付/.test(blk));
const b = fs.readFileSync(path.join(__dirname, '../../renderer/bootstrap.js'), 'utf8');
check('desktop domain tells the model to use cards and to leave music to midi_compose', /成品檔案（MIDI、音訊、圖片、文件）要用卡片交付/.test(b) && /deliver_file/.test(b) && /midi_compose/.test(b));
check('fs_write_file puts a card up for media files', /_deliverDiskFile\(r\.path \|\| parsed\.path\)/.test(b));
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'ok'); console.log(ok + ' passed, ' + bad.length + ' failed'); process.exit(bad.length ? 1 : 0);
