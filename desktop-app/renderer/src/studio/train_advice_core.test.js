// node renderer/src/studio/train_advice_core.test.js
const A = require('./train_advice_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };
const find = (r, rule, name) => r.suggestions.find((s) => s.rule === rule && (name === undefined || s.name === name));

// 形狀與 eval_run.py --json_out 相同：groups 是 {組名: {n, base, tuned}}，rows 有 key、tuned_ok、note
const groups = {
    'group/blockly-parity': { n: 8, base: 5, tuned: 3 },        // 退步
    'group/matrix-lin': { n: 10, base: 1, tuned: 4 },            // 進步但仍低於門檻（4/10 = 40%）
    'group/uml-class': { n: 12, base: 6, tuned: 11 },            // 很好
    'group/tiny': { n: 3, base: 0, tuned: 1 }                    // 題數太少，不判門檻
};
const rows = [];
for (let i = 0; i < 6; i++) rows.push({ id: 'b' + i, key: 'matrix/lin', tuned_ok: false, note: 'format: 沒有 JSON' });
for (let i = 0; i < 2; i++) rows.push({ id: 'c' + i, key: 'matrix/lin', tuned_ok: false, note: 'wrong 3: 3*x' });
for (let i = 0; i < 4; i++) rows.push({ id: 'ok' + i, key: 'matrix/lin', tuned_ok: true, note: '' });
rows.push({ id: 'u1', key: 'uml/class', tuned_ok: true, note: '' });

const trainRows = { 'matrix/lin': 150, 'uml/class': 900, 'blockly/parity': 300 };
const r = A.adviceFromEval({ groups, rows, trainRows, source: 'lora-train/eval_out.json' });

check('輸出 ok 且有門檻與動作表', r.ok === true && r.thresholds.gate === 0.6 && r.actions.add_data.label === '補資料', r);
check('退步的組被標出，附數字與來源', (() => { const s = find(r, 'regression', 'group/blockly-parity'); return !!s && s.severity === 'high' && s.action === 'reweight' && s.actionLabel === '調比重' && s.evidence.numbers.base === 5 && s.evidence.numbers.tuned === 3 && /eval_out\.json groups\["group\/blockly-parity"\]/.test(s.evidence.source) && /退步/.test(s.text); })(), r.suggestions);
check('仍低於門檻：題數足夠且微調 40%，列為補資料', (() => { const s = find(r, 'below-gate', 'group/matrix-lin'); return !!s && s.action === 'add_data' && /40/.test(s.text) && s.evidence.numbers.tuned === 4; })());
check('達門檻的組不建議', !find(r, 'below-gate', 'group/uml-class') && !find(r, 'regression', 'group/uml-class'));
check('題數太少（3 題）不判門檻；微調高於基底也不報退步', !find(r, 'below-gate', 'group/tiny') && !find(r, 'regression', 'group/tiny'));
check('領域列數低於門檻：matrix/lin 只有 150 列（門檻 200）', (() => { const s = find(r, 'few-rows', 'matrix/lin'); return !!s && s.evidence.numbers.trainRows === 150 && /150/.test(s.text); })());
check('列數足夠的領域不報列數不足', !find(r, 'few-rows', 'uml/class') && !find(r, 'few-rows', 'blockly/parity'));
check('失敗以格式錯誤為主：6/8 格式（占 75%）→ 補格式範例', (() => { const s = find(r, 'format-errors', 'matrix/lin'); return !!s && s.evidence.numbers.formatCount === 6 && s.evidence.numbers.failTuned === 8 && /格式錯誤為主/.test(s.text); })());
check('失敗以內容錯誤為主的規則，在 6/8 格式時不觸發', !find(r, 'content-errors', 'matrix/lin'));
check('內容錯誤為主時觸發（另一組數字）', (() => {
    const rr = A.adviceFromEval({ rows: [{ key: 'x/y', tuned_ok: false, note: 'wrong B: foo' }, { key: 'x/y', tuned_ok: false, note: 'wrong C: bar' }, { key: 'x/y', tuned_ok: false, note: 'wrong A: baz' }], trainRows: { 'x/y': 500 }, source: 's' });
    const s = find(rr, 'content-errors', 'x/y'); return !!s && s.evidence.numbers.contentCount === 3 && !find(rr, 'format-errors', 'x/y');
})());
check('失敗題少於最少題數時不看失敗型態', (() => {
    const rr = A.adviceFromEval({ rows: [{ key: 'x/y', tuned_ok: false, note: 'format: a' }], trainRows: { 'x/y': 500 }, source: 's' });
    return !find(rr, 'format-errors', 'x/y') && !find(rr, 'content-errors', 'x/y');
})());

// 位置偏誤：rows 沒有 gold／pred 時明說缺欄位，不猜
check('沒有 gold／pred：位置偏誤列為證據不足，不給建議', (() => { const i = r.insufficient.find((x) => x.rule === 'position-bias'); return !!i && i.missing.indexOf('rows[].gold') >= 0 && !find(r, 'position-bias'); })(), r.insufficient);
check('有 gold／pred 且某選項預測占 >=50%：判定偏誤', (() => {
    const rr = [];
    for (let i = 0; i < 10; i++) rr.push({ key: 'k/k', tuned_ok: false, gold: i < 5 ? 'A' : 'B', pred: 'A', note: 'wrong A: x' });
    const x = A.adviceFromEval({ rows: rr, trainRows: { 'k/k': 900 }, source: 's' });
    const s = find(x, 'position-bias', '全體'); return !!s && s.evidence.numbers.biasLetter === 'A' && s.evidence.numbers.biasPct === 100 && s.evidence.numbers.goldPct === 50 && s.action === 'reweight';
})());
check('有 gold／pred 但偏誤不明顯：不報', (() => {
    const rr = []; for (let i = 0; i < 10; i++) rr.push({ key: 'k/k', tuned_ok: true, gold: 'ABCD'[i % 4], pred: 'ABCD'[(i + 1) % 4], note: '' });
    return !find(A.adviceFromEval({ rows: rr, trainRows: { 'k/k': 900 }, source: 's' }), 'position-bias', '全體');
})());
check('題數不足 8 時不判位置偏誤（即使全部同一個選項）', (() => {
    const rr = []; for (let i = 0; i < 4; i++) rr.push({ key: 'k/k', tuned_ok: true, gold: 'A', pred: 'A', note: '' });
    return !find(A.adviceFromEval({ rows: rr, trainRows: { 'k/k': 900 }, source: 's' }), 'position-bias', '全體');
})());

// 門檻可覆寫；規則表是資料（改門檻就改結果）
check('覆寫門檻：列數門檻調成 100，150 列不再報', (() => { const x = A.adviceFromEval({ groups, rows, trainRows, source: 's', thresholds: { minDomainRows: 100 } }); return !find(x, 'few-rows', 'matrix/lin'); })());
check('覆寫門檻：gate 調成 0.3，40% 不再報仍低於門檻', (() => { const x = A.adviceFromEval({ groups, rows, trainRows, source: 's', thresholds: { gate: 0.3 } }); return !find(x, 'below-gate', 'group/matrix-lin'); })());
check('規則表有六條、各有 scope／動作／文字', A.RULES.length === 6 && A.RULES.every((x) => x.scope && A.ACTIONS[x.action] && x.text && Array.isArray(x.when)));

// 缺資料不猜
check('組別數字不完整：列入證據不足', (() => { const x = A.adviceFromEval({ groups: { 'g/x': { n: 5, base: 2 } }, source: 's' }); return x.insufficient.some((i) => i.name === 'g/x' && i.reason.indexOf('數字') >= 0); })());
check('領域只有失敗、沒有列數：列數規則不猜，列入證據不足', (() => { const x = A.adviceFromEval({ rows: [{ key: 'z/z', tuned_ok: false, note: 'wrong 1: a' }], source: 's' }); return !find(x, 'few-rows', 'z/z') && x.insufficient.some((i) => i.rule === 'few-rows' && i.name === 'z/z' && i.missing.indexOf('trainRows') >= 0); })());
check('空輸入不丟例外，回空建議與證據不足', (() => { const x = A.adviceFromEval(); return x.ok && x.suggestions.length === 0 && x.insufficient.length >= 1; })());

// 失敗型態分類
check('note 分類：format／wrong／其他', A.categorizeNote('format: x') === 'format' && A.categorizeNote('wrong 2: y') === 'content' && A.categorizeNote('') === 'other');

// 每條建議都有依據（數字與來源）
check('每條建議都有 evidence.source 與 numbers', r.suggestions.every((s) => typeof s.evidence.source === 'string' && s.evidence.numbers && Object.keys(s.evidence.numbers).length > 0), r.suggestions);

console.log(ok + ' passed, ' + bad + ' failed');
process.exit(bad ? 1 : 0);
