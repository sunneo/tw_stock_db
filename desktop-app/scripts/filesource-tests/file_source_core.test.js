// node scripts/filesource-tests/file_source_core.test.js -- 斜線指令檔案來源的純函式層(對話裡的 MIDI 與附件候選、卡片回答對應)
const F = require('../../renderer/src/filesource/file_source_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }

const msgs = [
  { role: 'user', content: '/media-midi-to-mp3 [附件：舊.mid（file_id=f_old）]' },
  { role: 'assistant', content: '🎹 播放卡片\n\n```fa-midi\n{"id":"mi1","title":"爵士曲","b64":"QUJD"}\n```' },
  { role: 'user', content: '幫我看 [附件：鼓.mp3（file_id=f_mp3）、和弦.mid（file_id=f_mid2）]' },
  { role: 'assistant', content: '🎼 編輯器\n\n```fa-midi-edit\n{"id":"mi2","title":"新曲"}\n```' },
  { role: 'assistant', content: '又一張卡片\n\n```fa-midi\n{"id":"mi1","title":"爵士曲"}\n```' },
];

// MIDI：播放卡片與編輯器都認，同一首去重，新的在前
const midi = F.collect(msgs, { midi: true, attachRe: /\.midi?$/i });
check('collect midi: count (mi1 deduped, mi2, two .mid attachments)', midi.length === 4, midi.map((x) => x.label));
check('collect midi: newest first (mi1 card is the last message)', midi[0].item.type === 'midi' && midi[0].item.id === 'mi1', midi[0]);
check('collect midi: editor label', midi.some((x) => x.label === '新曲（MIDI 編輯器）'), midi.map((x) => x.label));
check('collect midi: .mp3 attachment excluded by regex', !midi.some((x) => /mp3/.test(x.label)), midi.map((x) => x.label));
check('collect midi: b64 kept for restoring (card message)', F.collect([msgs[1]], { midi: true })[0].item.b64 === 'QUJD');

// 音訊：只留 mp3／wav…，不認 MIDI 卡片
const audio = F.collect(msgs, { midi: false, attachRe: /\.(mp3|wav|m4a|ogg|flac|aac)$/i });
check('collect audio: only the mp3 attachment', audio.length === 1 && audio[0].item.id === 'f_mp3' && audio[0].item.type === 'attachment', audio);

// 沒有任何候選
check('collect: empty messages → []', F.collect([], { midi: true }).length === 0);
check('collect: null messages → []', F.collect(null, { midi: true }).length === 0);
check('collect: bad JSON block ignored', F.collect([{ content: '```fa-midi\n{bad\n```' }], { midi: true }).length === 0);

// 上限 8 筆
const many = []; for (let i = 0; i < 20; i++) many.push({ content: '```fa-midi\n{"id":"x' + i + '","title":"t' + i + '"}\n```' });
check('collect: capped at 8 items', F.collect(many, { midi: true }).length === 8);

// 選項文字與回答對應
const labels = F.labels(midi);
check('labels: prefixed with 對話中的', labels[0] === '對話中的：爵士曲（MIDI 播放卡片）', labels);
check('pick: chat item', F.pick(labels[1], midi).kind === 'item' && F.pick(labels[1], midi).item.id === 'mi2');
check('pick: upload', F.pick(F.UPLOAD_LABEL, midi).kind === 'upload');
check('pick: local file', F.pick(F.LOCAL_LABEL, midi).kind === 'local');
check('pick: cancel → null', F.pick(F.CANCEL_LABEL, midi) === null);
check('pick: unknown answer → null', F.pick('亂答', midi) === null);
check('pick: undefined answer → null', F.pick(undefined, midi) === null);

console.log('file_source_core: ' + ok + ' 項通過' + (bad.length ? '，' + bad.length + ' 項失敗' : ''));
if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
