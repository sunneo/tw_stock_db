// node renderer/src/studio/music_train_core.test.js -- 作曲訓練核心：詞彙、符號編解碼、語法檢查、跳進指標、MIDI 往返
const S = require('./music_train_core.js');
const M = require('../music/midi_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }

// 詞彙：固定大小、id 唯一、特殊符號在前
const V = S.VOCAB;
check('vocab: size = 3 specials + 9 styles + 33 G + 37 P + 16 D', V.size === 3 + S.STYLES.length + 33 + 37 + 16 && S.STYLES.length === 9, V.size);
check('vocab: ids unique and specials first', new Set(V.tokens).size === V.tokens.length && V.tokens[0] === '<pad>' && V.tokens[1] === '<bos>' && V.tokens[2] === '<eos>');

// 手作的曲子：三個音，第二個音在第 3 格（之後有 gap），第三個音跟在後面
function song(notes) { return { tracks: [{ notes: notes }] }; }
const hand = song([{ t: 0, d: 240, n: 60, v: 90 }, { t: 360, d: 120, n: 64, v: 90 }, { t: 480, d: 1920, n: 67, v: 90 }]);
const enc = S.songToTokens(hand, 'pop');
check('encode: starts <bos> S:pop and ends <eos>', enc.tokens[0] === '<bos>' && enc.tokens[1] === 'S:pop' && enc.tokens[enc.tokens.length - 1] === '<eos>', enc.tokens);
check('encode: note groups are G P D with the right values', enc.tokens.join(' ') === '<bos> S:pop G0 P60 D2 G3 P64 D1 G1 P67 D16 <eos>', enc.tokens.join(' '));
const dec = S.tokensToNotes(enc.tokens);
check('decode: ok and recovers onsets (16th units) and pitches', dec.ok && dec.notes.map(function (n) { return [n.t, n.n, n.d].join(':'); }).join(' ') === '0:60:2 3:64:1 4:67:16', dec);

// 超過 32 格的空白：G32 重複、解回來時間一樣
const far = song([{ t: 0, d: 120, n: 60, v: 90 }, { t: 120 * 70, d: 120, n: 62, v: 90 }]);
const fe = S.songToTokens(far, 'rock');
check('encode: gap 70 becomes G32 G32 G6', fe.tokens.slice(2, 5).join(' ') === 'G0 P60 D1' && fe.tokens.slice(5, 8).join(' ') === 'G32 G32 G6', fe.tokens.join(' '));
const fd = S.tokensToNotes(fe.tokens);
check('decode: long gap recovered exactly', fd.ok && fd.notes[1].t === 70, fd);

// 量化誤差：不在格上的音符，最多偏半格（60 ticks）
const off = song([{ t: 61, d: 300, n: 70, v: 90 }]);
const offE = S.songToTokens(off, 'pop'), offD = S.tokensToNotes(offE.tokens);
check('quantize: off-grid onset within half a grid', Math.abs(offD.notes[0].t * S.GRID - 61) <= 60, offD.notes);

// 截斷：超過 16 格的持續時間截到 16（記錄在 quant）
const longN = song([{ t: 0, d: 120 * 40, n: 60, v: 90 }]);
const le = S.songToTokens(longN, 'pop');
check('quantize: long note clamped to D16 and counted', le.tokens.indexOf('D16') > 0 && le.quant.clampedDur === 1, le.quant);

// 超出音域的音符不編碼（計數）
const hi = song([{ t: 0, d: 120, n: 100, v: 90 }, { t: 120, d: 120, n: 60, v: 90 }]);
check('quantize: out-of-range pitch skipped and counted', S.songToTokens(hi, 'pop').quant.outOfRange === 1 && S.songToTokens(hi, 'pop').quant.notes === 1);

// 語法檢查：壞句子都要標出來，不丟例外
const bads = {
  no_bos: ['S:pop', 'G0', 'P60', 'D1', '<eos>'],
  no_eos: ['<bos>', 'S:pop', 'G0', 'P60', 'D1'],
  p_after_p: ['<bos>', 'S:pop', 'P60', 'P62', 'D1', '<eos>'],
  d_without_p: ['<bos>', 'S:pop', 'D1', '<eos>'],
  g_between_p_and_d: ['<bos>', 'S:pop', 'P60', 'G1', 'D1', '<eos>'],
  pitch_out_of_range: ['<bos>', 'S:pop', 'P99', 'D1', '<eos>'],
  after_eos: ['<bos>', 'S:pop', 'G0', 'P60', 'D1', '<eos>', 'G0', 'P60', 'D1'],
  unknown: ['<bos>', 'S:pop', 'X', '<eos>'],
  missing_dur: ['<bos>', 'S:pop', 'G0', 'P60', '<eos>']
};
Object.keys(bads).forEach(function (k) {
  var r = S.tokensToNotes(bads[k]);
  check('grammar: rejects ' + k, r.ok === false && r.errors.length > 0, r);
});
check('grammar: valid minimal song accepted', S.tokensToNotes(['<bos>', 'S:pop', '<eos>']).ok === true);

// 跳進指標
check('leap: 60→64 ok, 64→80 not ok (rate 1/2)', S.leapOkRate([{ n: 60 }, { n: 64 }, { n: 80 }]).rate === 0.5);
check('leap: single note has no leaps', S.leapOkRate([{ n: 60 }]).total === 0);

// 樣本指標
const good = S.songToTokens(hand, 'pop').tokens.map(function (t) { return t; });
const sm = S.sampleMetrics([good, ['<bos>', 'S:pop', 'P60', 'P62', '<eos>']]);
check('sample metrics: counts valid songs', sm.songs === 2 && sm.grammar_valid === 1 && sm.grammar_valid_rate === 0.5, sm);

// MIDI 往返：解出的曲子通過 midi_core 的驗證與寫出，再讀回音符數相同
const ts = S.tokensToSong(enc.tokens, { title: 't' });
check('tokensToSong: parse ok', ts.parsed.ok === true);
const bytes = M.write(ts.song), back = M.parse(bytes);
check('midi: writes and reads back the same note count', back.tracks[0].notes.length === 3, back.tracks.map(function (t) { return t.notes.length; }));

// 語料產生：同參數同結果（確定性）
const c1 = S.generateCorpus(1, 5, 0), c2 = S.generateCorpus(1, 5, 0);
check('corpus: deterministic for the same arguments', JSON.stringify(c1) === JSON.stringify(c2) && c1.train.length === S.STYLES.length);
check('corpus: every row decodes ok and has a style token', c1.train.every(function (r) { var t = r.ids.map(function (id) { return V.tokens[id]; }); return S.tokensToNotes(t).ok && t[1] === 'S:' + r.style; }), c1.train.slice(0, 1));

console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'ok'); console.log(ok + ' passed, ' + bad.length + ' failed'); process.exit(bad.length ? 1 : 0);
