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
fs.rmSync(dir, { recursive: true, force: true });
console.log(passed + ' passed, 0 failed');
