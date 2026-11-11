'use strict';
// 待補教學佇列寫檔（matrix_teach_queue_core）：用真的暫存檔（os.tmpdir）測：① 新增後重讀一致；② 同一題重複加入只計次數；③ 壞行（非 JSON、缺 statement）略過、其他行保留；④ 寫檔後沒有殘留暫存檔；⑤ 刪除與清空；⑥ 摘要的數字與行文字。
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const S = require('./matrix_spec_core.js'); const Q = require('./matrix_teach_queue_core.js');
let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teachq-')); const file = path.join(dir, 'teach_queue.jsonl');
const q = Q.create(Q.nodeFsIO(fs, path), file);
const e1 = S.teachEntry({ statement: '輸入 n，輸出 n 的歐拉函數', examples: [{ in: '6\n', out: '2\n' }], result: { ok: false, reason: '矩陣層：沒有符合', rounds: [{ by: 'paradigm', verdict: 'WA' }] }, readOk: true });
const e2 = S.teachEntry({ statement: '讀一個 xxd 十六進位傾印，輸出位元組數', examples: [], result: { ok: false, reason: '讀取器：讀不出' }, readOk: false });
const e3 = S.teachEntry({ statement: '輸入 n，輸出 n 的歐拉函數', examples: [{ in: '6\n', out: '2\n' }, { in: '9\n', out: '6\n' }], result: { ok: false, reason: '矩陣層：沒有符合', rounds: [] }, readOk: true });

q.add(e1); q.add(e2);
let list = q.list(); ok(list.length === 2, '新增兩筆');
ok(list.find((e) => e.id === e1.id).count === 1, '第一次 count=1');
// ② 重複：同一題只計次數，範例較多的版本會換上
q.add(e3); list = q.list();
ok(list.length === 2, '同一題重複加入不新增列');
const got1 = list.find((e) => e.id === e1.id); ok(got1.count === 2 && got1.examples.length === 2, '重複：count=2、範例換成較多的版本');
console.log('① ② 新增與重複計次：2 筆，同一題 count=2、範例 2 筆');

// ③ 壞行略過
fs.appendFileSync(file, 'not json\n{"nostatement":1}\n\n');
list = q.list(); ok(list.length === 2, '壞行與缺 statement 的行略過，其他行保留（' + list.length + '）');
console.log('③ 壞行（非 JSON、缺 statement、空行）略過，仍讀到 2 題');

// ④ 寫檔後沒有殘留暫存檔
q.add(e1); const left = fs.readdirSync(dir).filter((f) => f.includes('.tmp-')); ok(left.length === 0, '寫檔後沒有暫存檔殘留');
console.log('④ 寫檔後目錄內沒有暫存檔殘留');

// ⑤ 刪除與清空
const removed = q.remove(e2.id); ok(removed === 1 && q.list().length === 1, '刪除一筆後剩 1 筆');
q.clear(); ok(q.list().length === 0, '清空後 0 筆');
const none = Q.create(Q.nodeFsIO(fs, path), path + '.none'); ok(none.list().length === 0, '檔案不存在＝空佇列');
console.log('⑤ 刪除、清空與不存在的檔案都正確');

// ⑥ 摘要
q.add(e1); q.add(e2); q.add(e3);
const sm = q.summary();
ok(sm.total === 2 && sm.needExamples === 1, '摘要：2 題，1 題沒有範例（e2）');
ok(sm.lines[0].includes('2 題') && sm.lines[0].includes('1 題還沒有範例'), '摘要首行：' + sm.lines[0]);
ok(sm.top[0].count === 2 && sm.top[0].statement.startsWith('輸入 n'), '最常出現的題排第一、次數 2');
console.log('⑥ 摘要：' + sm.lines.join(' ｜ '));
// ⑦ 純函式 mergeText（產品端 _teachQueueRecord 用它）：與直接 mergeQueue＋queueText 逐字相同；同一題再加只計次數；壞文字不丟其他行
{
    const base = S.queueText(S.mergeQueue([], e1));
    const direct = S.queueText(S.mergeQueue(S.parseQueue(base), e2));
    const viaMT = Q.mergeText(base, e2);
    ok(viaMT.text === direct && viaMT.count === 2, 'mergeText 與直接合併逐字相同（2 筆）');
    const again = Q.mergeText(viaMT.text, e3);
    ok(again.count === 2 && again.entries.find((x) => x.statement === e1.statement).count === 2, 'mergeText 同題第二次加入只計次數（count=2、仍 2 筆）');
    const bad = Q.mergeText('這不是 JSON\n' + base + '{"缺statement":1}\n', e2);
    ok(bad.count === 2 && bad.summary.total === 2, 'mergeText 略過壞行，其他行保留');
    const empty = Q.mergeText('', e1); ok(empty.count === 1 && empty.summary.lines[0].includes('1 題'), 'mergeText 空字串＝空佇列，加入 1 筆');
    ok(Q.mergeText(null, e1).count === 1, 'mergeText 接受 null（rawfs 沒讀到時）');
    console.log('⑦ mergeText：逐字相同、同題計次、壞行略過、空／null 輸入');
}
// ⑧ 走哪一層（§13.6）：成本順序 blockly 教學 < 編成矩陣 < 留給 LoRA；佇列記錄的 route 與摘要計數一致
{
    const rA = S.routeOf({ stage: 'paradigm', examples: 0 }); ok(rA.route === 'blockly-teach' && rA.cost === 1, '讀得懂（paradigm）→ blockly 教學');
    const rB = S.routeOf({ stage: 'matrix', examples: 2 }); ok(rB.route === 'blockly-teach', '讀得懂但矩陣沒範本（matrix）→ 仍先 blockly 教學（最便宜）');
    const rC = S.routeOf({ stage: 'reader', examples: 3 }); ok(rC.route === 'matrix' && rC.cost === 2, '讀不懂有範例 → 編成矩陣');
    const rD = S.routeOf({ stage: 'reader', examples: 0 }); ok(rD.route === 'lora' && rD.cost === 3, '讀不懂沒範例 → 留給 LoRA');
    const eR = S.teachEntry({ statement: '甲題：讀不懂', examples: [{ in: '1', out: '2' }], result: { ok: false }, readOk: false });
    ok(eR.route === 'matrix', 'teachEntry 帶 route（讀不懂有範例）：' + eR.route);
    const eB = S.teachEntry({ statement: '乙題：缺骨架', examples: [{ in: '1', out: '2' }], fallback: { stage: 'paradigm', reasons: {}, teach: {} } });
    ok(eB.route === 'blockly-teach', 'teachEntry 帶 route（讀得懂）：' + eB.route);
    const sm = Q.mergeText(S.queueText([]), eR); const sm2 = Q.mergeText(sm.text, eB); const cnt = Q.summarize(sm2.entries);
    ok(cnt.byRoute['blockly-teach'] === 1 && cnt.byRoute.matrix === 1 && cnt.byRoute.lora === 0, '摘要計數：' + JSON.stringify(cnt.byRoute));
    ok(cnt.lines.some((l) => l.includes('建議順序：blockly 教學 1 題') && l.includes('編成矩陣 1 題') && l.includes('LoRA 0 題')), '摘要行：' + cnt.lines[1]);
    console.log('⑧ 走哪一層：' + cnt.lines[1]);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(passed + ' passed, 0 failed');
