// node renderer/src/studio/sr_train_core.test.js -- 語音辨識訓練核心的純函式（正規化、切分、資料檢查、WER、清單）
const S = require('./sr_train_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }

// 正規化：與 sr_train.py 的 normalize 規則一致（小寫、去標點、保留撇號、壓縮空白）
check('normalize: case, punctuation, apostrophe', S.normalizeText("Mister Quilter's, MANNER!  less") === "mister quilter's manner less");
check('normalize: empty and null', S.normalizeText('') === '' && S.normalizeText(null) === '');
check('normalize: digits and CJK kept', S.normalizeText('第3課，OK!') === '第3課 ok');

// 切分：列號 %4==0 為 eval（與 Python prep 相同）
check('split rule: index 0 eval, 1-3 train, 4 eval', [0, 1, 2, 3, 4].map(S.splitOf).join() === 'eval,train,train,train,eval');
const sp = S.splitRows([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]);
check('splitRows: counts 2 eval of 5', sp.filter(function (r) { return r.split === 'eval'; }).length === 2, sp);

// 資料檢查
const good = [{ id: 'x1', audio: 'wav/x1.wav', text: 'HELLO THERE', split: 'train' }, { id: 'x2', audio: 'wav/x2.wav', text: 'GENERAL KENOBI', split: 'eval' }];
check('validate: good rows pass', S.validateRows(good).ok === true && S.validateRows(good).train === 1 && S.validateRows(good).eval === 1, S.validateRows(good));
check('validate: empty list fails', S.validateRows([]).ok === false);
check('validate: absolute path rejected', S.validateRows([{ id: 'a', audio: '/etc/a.wav', text: 'hi', split: 'train' }, { id: 'b', audio: 'b.wav', text: 'hi', split: 'eval' }]).errors.some(function (e) { return /相對路徑/.test(e); }));
check('validate: parent path rejected', S.validateRows([{ id: 'a', audio: '../a.wav', text: 'hi', split: 'train' }, { id: 'b', audio: 'b.wav', text: 'hi', split: 'eval' }]).ok === false);
check('validate: non-wav rejected', S.validateRows([{ id: 'a', audio: 'a.mp3', text: 'hi', split: 'train' }, { id: 'b', audio: 'b.wav', text: 'hi', split: 'eval' }]).ok === false);
check('validate: duplicate id rejected', S.validateRows([{ id: 'a', audio: 'a.wav', text: 'hi', split: 'train' }, { id: 'a', audio: 'b.wav', text: 'hi', split: 'eval' }]).errors.some(function (e) { return /重複/.test(e); }));
check('validate: punctuation-only text rejected', S.validateRows([{ id: 'a', audio: 'a.wav', text: '...', split: 'train' }, { id: 'b', audio: 'b.wav', text: 'hi', split: 'eval' }]).ok === false);
check('validate: needs an eval row', S.validateRows([{ id: 'a', audio: 'a.wav', text: 'hi', split: 'train' }]).errors.some(function (e) { return /驗證/.test(e); }));
check('validate: bad split value', S.validateRows([{ id: 'a', audio: 'a.wav', text: 'hi', split: 'test' }, { id: 'b', audio: 'b.wav', text: 'hi', split: 'eval' }]).ok === false);

// 字錯率
check('wer: identical is 0', S.wordErrorRate('a b c', 'A, B c!').wer === 0);
const w1 = S.wordErrorRate('the cat sat', 'the bat sat down');
check('wer: one sub + one insert over 3 words', w1.errors === 2 && w1.words === 3 && Math.abs(w1.wer - 2 / 3) < 1e-9, w1);
check('wer: empty hyp is all deletions', S.wordErrorRate('a b', '').wer === 1);
check('wer: empty ref with output is 1', S.wordErrorRate('', 'x').wer === 1 && S.wordErrorRate('', '').wer === 0);
const c = S.corpusWer([{ ref: 'a b c d', hyp: 'a b c d' }, { ref: 'e f', hyp: 'x y' }]);
check('corpus wer: total errors over total words (not per-sentence average)', c.errors === 2 && c.words === 6 && Math.abs(c.wer - 2 / 6) < 1e-9, c);

// 產物清單
const m = S.buildManifest({ base: 'whisper-tiny', rank: 8, alpha: 16, steps: 40, batch: 4, lr: 0.001, seed: 0, trainRows: 54, evalRows: 19,
  lossFirst: 3.1, lossLast: 1.2, before: { wer: 0.5, n: 19, errors: 1, words: 2 }, after: { wer: 0.3, n: 19, errors: 1, words: 2 }, sha256: { 'adapter_model.safetensors': 'abc' } });
check('manifest: format and kind', m.format === 'fa-sr-lora' && m.kind === 'speech_recognition');
check('manifest: improved only when after WER is lower', m.eval.improved === true && S.buildManifest({ base: 'b', rank: 8, alpha: 16, before: { wer: 0.2 }, after: { wer: 0.2 } }).eval.improved === false);
check('manifest: no before/after means not improved', S.buildManifest({ base: 'b', rank: 8, alpha: 16 }).eval.improved === false);

console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'ok'); console.log(ok + ' passed, ' + bad.length + ' failed'); process.exit(bad.length ? 1 : 0);
