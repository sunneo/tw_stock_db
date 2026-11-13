// node renderer/src/studio/speech_core.test.js —— 語音合成訓練的資料格式、切分、語音包大小、摘要檢查（不跑訓練）
const S = require('./speech_core.js');
let ok = 0, bad = 0; const check = (n, c, d) => { if (c) ok++; else { bad++; console.log('FAIL ' + n, d === undefined ? '' : JSON.stringify(d).slice(0, 300)); } };

const row = (o) => Object.assign({ id: 'train_000', text: 'Hello there.', phonemes: 'həlˈoʊ ðɛɹ.', audio: 'audio/train_000.wav', sr: 24000, pred_dur: [1, 3, 4], split: 'train', source: { kind: 'teacher' } }, o);
const line = (r) => JSON.stringify(r);

// 語音包大小：510 × 256 × 4 = 522,240
check('語音包大小常數正確', S.VOICE_BIN_BYTES === 522240 && S.VOICE_ROWS * S.STYLE_DIM * 4 === 522240);
check('大小正確通過', S.checkVoiceBinSize(522240).ok === true);
check('大小錯誤會說明', (() => { const r = S.checkVoiceBinSize(522236); return !r.ok && /522240/.test(r.reason); })());
check('非數字拒絕', !S.checkVoiceBinSize('x').ok && !S.checkVoiceBinSize(NaN).ok);

// 單列檢查
check('正常列通過', S.checkRow(row()) === '');
check('文字空白拒絕', /文字/.test(S.checkRow(row({ text: '  ' }))));
check('缺音素拒絕', /音素/.test(S.checkRow(row({ phonemes: '' }))));
check('取樣率不是 24000 拒絕', /取樣率/.test(S.checkRow(row({ sr: 16000 }))));
check('split 不合法拒絕', /split/.test(S.checkRow(row({ split: 'dev' }))));
check('絕對路徑拒絕', /相對路徑/.test(S.checkRow(row({ audio: '/etc/x.wav' }))));
check('Windows 磁碟路徑拒絕', /相對路徑/.test(S.checkRow(row({ audio: 'C:\\x.wav' }))));
check('含 .. 的路徑拒絕', /相對路徑/.test(S.checkRow(row({ audio: 'audio/../../x.wav' }))));
check('時長為 0 或小數拒絕', /時長/.test(S.checkRow(row({ pred_dur: [0, 2] }))) && /時長/.test(S.checkRow(row({ pred_dur: [1.5] }))));
check('缺教師時長拒絕', /教師時長/.test(S.checkRow(row({ pred_dur: [] }))));

// JSONL 解析：壞行回報行號，id 重複也回報
const text = [line(row({ id: 'a' })), '', '{壞', line(row({ id: 'a', text: 'other' })), line(row({ id: 'b', sr: 8000 }))].join('\r\n');
const p = S.parseDatasetJsonl(text);
check('解析：空行略過、合法列保留', p.rows.length === 1 && p.rows[0].id === 'a', p.rows.length);
check('解析：壞 JSON 回報行號 3', p.errors.some((e) => e.line === 3 && /JSON/.test(e.reason)), p.errors);
check('解析：id 重複回報', p.errors.some((e) => /重複/.test(e.reason)), p.errors);
check('解析：取樣率錯誤回報行號 5', p.errors.some((e) => e.line === 5 && /取樣率/.test(e.reason)), p.errors);
check('解析：空字串回傳空結果', S.parseDatasetJsonl('').rows.length === 0);

// 切分與洩漏
const trainRows = [row({ id: 't1', text: 'One.' }), row({ id: 't2', text: 'Two.' })];
const heldRows = [row({ id: 'h1', text: 'Three.', split: 'heldout' })];
check('切分正常', (() => { const r = S.splitRows(trainRows.concat(heldRows)); return r.ok && r.train.length === 2 && r.heldout.length === 1; })());
check('沒有留出句 → 不通過', (() => { const r = S.splitRows(trainRows); return !r.ok && /留出/.test(r.reason); })());
check('沒有訓練句 → 不通過', !S.splitRows(heldRows).ok);
check('留出句文字與訓練句相同 → 洩漏拒絕', (() => { const r = S.splitRows(trainRows.concat([row({ id: 'h2', text: 'One.', split: 'heldout' })])); return !r.ok && /洩漏/.test(r.reason) && /h2/.test(r.reason); })());
check('洩漏比對忽略前後空白', (() => { const r = S.splitRows(trainRows.concat([row({ id: 'h3', text: ' One. ', split: 'heldout' })])); return !r.ok; })());

// 損失趨勢
check('損失下降：decreased 為真', (() => { const t = S.lossTrend([2, 1.9, 1.7, 1.5, 1.4, 1.2, 1.1, 1.0]); return t.ok && t.decreased && t.ratio < 1; })());
check('損失上升：decreased 為假', S.lossTrend([1, 1.2, 1.5, 1.8]).decreased === false);
check('損失點不足：不通過', S.lossTrend([1]).ok === false);
check('忽略 NaN', S.lossTrend([NaN, 3, 2, 1, 1]).decreased === true);

// 摘要檢查
const goodSummary = { format: 'fa-speech-style', version: 1, steps: 40, train_rows: 16, heldout_rows: 4, heldout_loss_before: 2.0, heldout_loss_after: 1.5, voice_bin: { file: 'voice_trained.bin', bytes: 522240, sha256: 'a'.repeat(64) } };
check('正常摘要通過', S.verifySummary(goodSummary).ok === true, S.verifySummary(goodSummary));
check('留出損失沒下降 → 不通過', (() => { const v = S.verifySummary(Object.assign({}, goodSummary, { heldout_loss_after: 2.1 })); return !v.ok && v.errors.some((e) => /沒有下降/.test(e)); })());
check('語音包大小錯 → 不通過', !S.verifySummary(Object.assign({}, goodSummary, { voice_bin: { bytes: 100, sha256: 'a'.repeat(64) } })).ok);
check('sha256 格式錯 → 不通過', !S.verifySummary(Object.assign({}, goodSummary, { voice_bin: { bytes: 522240, sha256: 'xyz' } })).ok);
check('格式名錯 → 不通過', !S.verifySummary(Object.assign({}, goodSummary, { format: 'x' })).ok);
check('步數 0 → 不通過', !S.verifySummary(Object.assign({}, goodSummary, { steps: 0 })).ok);
check('null 輸入不丟例外', S.verifySummary(null).ok === false);

console.log(ok + ' ok, ' + bad + ' bad');
if (bad) process.exit(1);
