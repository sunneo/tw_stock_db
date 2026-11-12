'use strict';
// 資料集逐筆編輯核心測試：解析（jsonl／json）、不合法整份拒絕、序列化往返、分頁、增改刪與索引邊界。
const E = require('./dataset_edit_core.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };

// 格式判斷
check('jsonl 副檔名', E.formatOf('data/train.jsonl') === 'jsonl');
check('json 副檔名', E.formatOf('data/solutions.json') === 'json');
check('txt 不能逐筆編輯', E.formatOf('data/corpus.txt') === null && E.parseRows('data/corpus.txt', 'x').ok === false);

// jsonl 解析：空行略過；列號不算空行
const jl = E.parseRows('data/a.jsonl', '{"q":1}\n\n{"q":2}\r\n{"q":3}\n');
check('jsonl 解析三筆（空行略過）', jl.ok && jl.rows.length === 3 && jl.rows[1].q === 2, jl);
const jlBad = E.parseRows('data/a.jsonl', '{"q":1}\n{oops\n{"q":3}');
check('jsonl 有壞行：整份拒絕並寫第 2 行', jlBad.ok === false && /第 2 行/.test(jlBad.error), jlBad);
check('jsonl 某行是陣列：拒絕', E.parseRows('data/a.jsonl', '[1,2]\n').ok === false);
check('jsonl 空檔案：0 筆', E.parseRows('data/a.jsonl', '').ok && E.parseRows('data/a.jsonl', '').rows.length === 0);

// json 解析
const js = E.parseRows('data/s.json', '[{"a":1},{"a":2}]');
check('json 陣列解析', js.ok && js.rows.length === 2, js);
check('json 頂層不是陣列：拒絕', E.parseRows('data/s.json', '{"a":1}').ok === false);
check('json 陣列內有純量：拒絕並寫第幾筆', (() => { const r = E.parseRows('data/s.json', '[{"a":1},5]'); return r.ok === false && /第 2 筆/.test(r.error); })());
check('json 壞掉：拒絕', E.parseRows('data/s.json', '[{').ok === false);

// 序列化往返
const rt = E.parseRows('data/a.jsonl', E.serializeRows('jsonl', [{ x: 1 }, { x: 'é中文' }]));
check('jsonl 往返保留內容（含中文）', rt.ok && rt.rows[1].x === 'é中文' && rt.rows.length === 2);
check('jsonl 空陣列序列化為空字串', E.serializeRows('jsonl', []) === '');
const rj = E.parseRows('data/s.json', E.serializeRows('json', [{ k: [1, 2] }]));
check('json 往返', rj.ok && rj.rows[0].k[1] === 2, rj);
let threw = false; try { E.serializeRows('csv', []); } catch (e) { threw = true; } check('未知格式丟錯（呼叫端不該傳）', threw);

// 分頁
const many = Array.from({ length: 120 }, (_, i) => ({ i }));
const p1 = E.pageRows(many, 0, 50), p3 = E.pageRows(many, 100, 50);
check('分頁：第一頁 50 筆、總數 120', p1.items.length === 50 && p1.total === 120 && p1.items[0].index === 0);
check('分頁：最後一頁只剩 20 筆', p3.items.length === 20 && p3.items[19].index === 119);
check('分頁：每列帶完整內容 row（編輯用）', p1.items[5].row.i === 5 && p3.items[0].row.i === 100);
check('分頁：offset 超出範圍夾回尾端，無列', E.pageRows(many, 9999, 50).items.length === 0);
check('分頁：limit 上限 200', E.pageRows(many, 0, 9999).limit === 200);
const longRow = [{ text: 'x'.repeat(500) }];
check('預覽截短到 160 字並加省略號', E.pageRows(longRow, 0, 10).items[0].preview.endsWith('…') && E.pageRows(longRow, 0, 10).items[0].preview.length <= 161);

// 增改刪
const base = [{ q: 'a' }, { q: 'b' }, { q: 'c' }];
const up = E.applyEdit(base, { op: 'update', index: 1, row: { q: 'B' } });
check('修改第 2 列', up.ok && up.rows[1].q === 'B' && base[1].q === 'b', up);
check('修改：索引越界回原因', E.applyEdit(base, { op: 'update', index: 3, row: { q: 'x' } }).ok === false);
check('修改：內容不是物件拒絕', E.applyEdit(base, { op: 'update', index: 0, row: [1] }).ok === false);
const del = E.applyEdit(base, { op: 'delete', index: 0 });
check('刪除第 1 列，原陣列不變', del.ok && del.rows.length === 2 && del.rows[0].q === 'b' && base.length === 3, del);
check('刪除：負索引拒絕', E.applyEdit(base, { op: 'delete', index: -1 }).ok === false);
check('刪除：非整數拒絕', E.applyEdit(base, { op: 'delete', index: 1.5 }).ok === false);
const addEnd = E.applyEdit(base, { op: 'add', row: { q: 'd' } });
check('新增預設接在尾端', addEnd.ok && addEnd.rows.length === 4 && addEnd.rows[3].q === 'd');
const addMid = E.applyEdit(base, { op: 'add', index: 1, row: { q: 'ins' } });
check('新增指定位置', addMid.ok && addMid.rows[1].q === 'ins' && addMid.rows.length === 4);
check('新增：位置等於筆數（尾端）可以', E.applyEdit(base, { op: 'add', index: 3, row: { q: 'z' } }).ok === true);
check('新增：位置超過筆數拒絕', E.applyEdit(base, { op: 'add', index: 4, row: { q: 'z' } }).ok === false);
check('新增：不是物件拒絕', E.applyEdit(base, { op: 'add', row: 'str' }).ok === false);
check('未知 op 拒絕並說明', (() => { const r = E.applyEdit(base, { op: 'swap' }); return r.ok === false && /update、delete 或 add/.test(r.error); })());
check('空陣列刪除：索引 0 越界', E.applyEdit([], { op: 'delete', index: 0 }).ok === false);

console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
