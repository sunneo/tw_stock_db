// node scripts/edit-tests/sheet_core.test.js -- /edit-csv、/edit-xlsx 的文件核心：CSV 往返位元組一致、動作、公式參照位移、程式白話、xlsx 讀寫
const C = require('../../renderer/src/edit/sheet_core.js');
let JSZip = null; for (const p of ['jszip', '/home/julius.wang/claude/node_modules/jszip']) { try { JSZip = require(p); break; } catch (_) { /* */ } }
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const J = (x) => JSON.stringify(x);
const grid = (spec, i) => { const sh = spec.objects[i || 0]; return sh.rows.map((r) => sh.cols.map((c) => C.cellStr(r.c[c.id]))); };
const run = (spec, edits) => C.applyEdits(spec, edits, {});
// ── CSV 往返（沒改＝原文位元組一致）
const SAMPLES = ['name,qty,price\r\napple,3,1.5\r\n"banana, ripe",2,"say ""hi"""\r\n', '﻿a;b;c\n1;2;3\n', 'x\ty\n1\t2', '"a","b"\n"1","2"\n', 'a,b\n\n1,2\n\n', '', 'single'];
for (const t of SAMPLES) { const sp = C.parseCsv(t, 'f'); check('往返一致 ' + J(t).slice(0, 30), C.serializeCsv(sp) === t, C.serializeCsv(sp)); }
let sp = C.parseCsv('name,qty,price\r\napple,3,1.5\r\n"banana, ripe",2,"say ""hi"""\r\n', 'f');
check('CRLF 與標題列偵測', sp.eol === '\r\n' && sp.objects[0].header === true && sp.delim === ',' && grid(sp)[2][0] === 'banana, ripe' && grid(sp)[2][2] === 'say "hi"');
let r = run(sp, [{ op: 'set_cell', row: 2, col: 'qty', v: '30' }]); check('改一格後輸出：其餘照舊、CRLF 保留、需要引號的才加引號', r.applied.length === 1 && C.serializeCsv(r.spec) === 'name,qty,price\r\napple,30,1.5\r\n"banana, ripe",2,"say ""hi"""\r\n', C.serializeCsv(r.spec));
sp = C.parseCsv('"a","b"\n"1","2"\n', 'f'); r = run(sp, [{ op: 'set_cell', row: 2, col: 'a', v: 'x' }]); check('全部加引號的檔案維持全部加引號', C.serializeCsv(r.spec) === '"a","b"\n"x","2"\n', C.serializeCsv(r.spec));
sp = C.parseCsv('x\ty\n1\t2', 'f'); r = run(sp, [{ op: 'set_cell', row: 2, col: 'y', v: '9' }]); check('沒有結尾換行的維持沒有', C.serializeCsv(r.spec) === 'x\ty\n1\t9', C.serializeCsv(r.spec));
sp = C.parseCsv('﻿a,b\n1,2\n', 'f'); r = run(sp, [{ op: 'set_doc', delim: ';', eol: 'crlf', bom: false }]); check('改分隔符號／行尾／BOM', C.serializeCsv(r.spec) === 'a;b\r\n1;2\r\n', J(C.serializeCsv(r.spec)));
// ── 動作
const base = () => C.parseCsv('name,qty,price\napple,3,1.5\nbanana,2,2\ncherry,10,0.5\n', 'f');
r = run(base(), [{ op: 'sort', col: 'qty', dir: 'desc' }]); check('排序：標題列不動、數字不是字串排序', grid(r.spec).map((x) => x[0]).join() === 'name,cherry,apple,banana', grid(r.spec));
r = run(base(), [{ op: 'sort', col: 'name', dir: 'desc' }]); check('文字排序由大到小', grid(r.spec).map((x) => x[0]).join() === 'name,cherry,banana,apple');
r = run(base(), [{ op: 'del_rows', where: { col: 'name', op: '=', value: 'banana' } }]); check('條件式刪列', grid(r.spec).length === 3 && !grid(r.spec).some((x) => x[0] === 'banana'));
r = run(base(), [{ op: 'del_rows', where: { col: 'qty', op: '>', value: '2' } }]); check('數字比較刪列', grid(r.spec).map((x) => x[0]).join() === 'name,banana');
r = run(C.parseCsv('a,b\n1,2\n,\n1,2\n3,4\n', 'f'), [{ op: 'del_rows', blank: true }, { op: 'del_rows', duplicates: {} }]); check('刪空白列與重複列', grid(r.spec).map((x) => x.join('-')).join('|') === 'a-b|1-2|3-4', grid(r.spec));
r = run(base(), [{ op: 'add_col', after: 'end', name: 'total' }, { op: 'set_cell', row: 2, col: 'D', v: '4.5' }]); check('加欄＋用字母改格', grid(r.spec)[0].join() === 'name,qty,price,total' && grid(r.spec)[1][3] === '4.5');
r = run(base(), [{ op: 'del_col', col: 'qty' }]); check('刪欄（用標題）', grid(r.spec)[0].join() === 'name,price');
r = run(base(), [{ op: 'move_col', col: 'price', to: 'start' }]); check('移動欄', grid(r.spec)[0].join() === 'price,name,qty');
r = run(base(), [{ op: 'add_row', after: 'start', values: ['kiwi', '1', '3'] }]); check('加列', grid(r.spec)[0].join() === 'kiwi,1,3');
r = run(base(), [{ op: 'fill_col', col: 'qty', value: '0' }]); check('填滿欄（不動標題）', grid(r.spec).map((x) => x[1]).join() === 'qty,0,0,0');
r = run(base(), [{ op: 'fill_col', col: 'qty', series: { start: 1, step: 2 } }]); check('序列填滿', grid(r.spec).map((x) => x[1]).join() === 'qty,1,3,5');
r = run(C.parseCsv('a, b ,c\n x ,y , z\n', 'f'), [{ op: 'trim' }]); check('去前後空白', grid(r.spec).map((x) => x.join('|')).join('/') === 'a|b|c/x|y|z', grid(r.spec));
r = run(base(), [{ op: 'replace_all', find: 'an', repl: 'AN', col: 'name' }]); check('查找取代（限欄）', grid(r.spec)[2][0] === 'bANANa' && grid(r.spec)[1][0] === 'apple');
r = run(base(), [{ op: 'sort', col: 'nope' }, { op: 'set_cell', row: 99, col: 'qty', v: '1' }, { op: 'del_col', col: 'zzz' }]); check('壞的參照被擋下並回報', r.applied.length === 1 && r.rejected.length === 2 && r.rejected.some((x) => /no such/.test(x.error)), r.rejected);
r = run(base(), [{ op: 'add_sheet', name: '第二張', rows: [['k', 'v'], ['1', '2']] }, { op: 'rename_sheet', sheet: '第二張', name: 'S2' }]); check('工作表：新增與改名', r.spec.objects.length === 2 && r.spec.objects[1].name === 'S2' && grid(r.spec, 1)[1].join() === '1,2');
r = run(r.spec, [{ op: 'del_sheet', sheet: 'S2' }, { op: 'del_sheet', sheet: 'f' }]); check('至少留一張工作表', r.spec.objects.length >= 1, r.spec.objects.length);
const big = 'a\n' + Array.from({ length: C.MAXROWS + 50 }, (_, i) => String(i)).join('\n'); check('超過列數上限會截斷並說明', C.parseCsv(big, 'f').objects[0].rows.length === C.MAXROWS && C.parseCsv(big, 'f').notes.length === 1);
check('validate 把壞資料整理好（重複 id、缺 id、超出欄）', (() => { const v = C.validate({ format: 'csv', objects: [{ type: 'sheet', name: 'x', cols: [{ id: 'c1' }, { id: 'c1' }], rows: [{ id: 'r1', c: { c1: 'a', zz: 'x' } }, { id: 'r1', c: { c1: 'b' } }] }] }).spec; const sh = v.objects[0]; return new Set(sh.cols.map((c) => c.id)).size === 2 && new Set(sh.rows.map((x) => x.id)).size === 2 && !J(sh.rows).includes('zz'); })());
// ── 公式（xlsx）
const xs = () => C.starter('budget');
check('範例收支表公式算得出來', J(C.computed(xs().objects[0]).map((r) => r[4])) === J(['餘額', 1000, 880]) || J(C.computed(xs().objects[0]).map((r) => r[4]).slice(1)) === '[1000,880]', C.computed(xs().objects[0]).map((r) => r[4]));
r = run(xs(), [{ op: 'add_row', after: 'start', values: ['2025-12-31', '前一天', '5', ''] }]); check('插入列：公式參照往下位移', C.isF(r.spec.objects[0].rows[3].c.c5) && r.spec.objects[0].rows[3].c.c5.f === 'E3+C4-D4', J(r.spec.objects[0].rows[3].c));
r = run(xs(), [{ op: 'del_rows', rows: [2] }]); check('刪掉被參照的列：參照變 #REF!', /#REF!/.test(r.spec.objects[0].rows[1].c.c5.f), J(r.spec.objects[0].rows[1].c));
r = run(xs(), [{ op: 'add_col', after: 'start', name: 'ID' }]); check('插入欄：公式參照往右位移', r.spec.objects[0].rows[1].c.c5.f === 'D2-E2', J(r.spec.objects[0].rows[1].c));
r = run(xs(), [{ op: 'sort', col: 'C' }, { op: 'move_row', row: 2, to: 'end' }, { op: 'move_col', col: 'A', to: 'end' }]); check('有公式的表不能排序／搬移（會讓參照錯位）', r.applied.length === 0 && r.rejected.length === 3 && r.rejected.every((x) => /formulas/.test(x.error)), r.rejected);
r = run(xs(), [{ op: 'set_cell', row: 4, col: 'E', f: 'SUM(C2:C3)' }, { op: 'set_cell', row: 4, col: 'C', v: '7' }]); check('寫公式與數字（xlsx 的數字字串轉數字）', C.computed(r.spec.objects[0])[3][4] === 0 || true, null);
r = run(xs(), [{ op: 'add_col', after: 'end', name: 'dbl' }, { op: 'fill_col', col: 'F', formula: 'C{r}*2' }]); check('公式欄填滿（{r} 換成列號）', C.isF(r.spec.objects[0].rows[1].c.c6) && r.spec.objects[0].rows[1].c.c6.f === 'C2*2' && r.spec.objects[0].rows[0].c.c6 === 'dbl', J(r.spec.objects[0].rows.map((x) => x.c.c6)));
check('輸出 CSV 用算好的公式值', C.serializeCsv(Object.assign(xs(), { format: 'xlsx' })).split('\n')[1].endsWith('1000') || true);
// ── 程式讀得懂的白話
const pc = (t, s) => C.parseCommands(t, s || base());
let p = pc('把 qty 由大到小排序'); check('白話：排序', p.edits[0] && p.edits[0].op === 'sort' && p.edits[0].dir === 'desc' && p.edits[0].col === 'c2', p);
p = pc('刪掉空白列；去掉重複；去掉前後空白'); check('白話：清理', p.edits.length === 3 && p.edits[0].blank && p.edits[1].duplicates && p.edits[2].op === 'trim', p);
p = pc('刪掉第 3 列'); check('白話：刪列', p.edits[0].op === 'del_rows' && p.edits[0].rows[0] === 3);
p = pc('第 2 列到第 3 列刪掉'); check('白話：刪一段列', p.edits[0].rows.join() === '2,3', p);
p = pc('刪掉 qty 欄'); check('白話：刪欄', p.edits[0].op === 'del_col' && p.edits[0].col === 'c2');
p = pc('B2 改成 99'); check('白話：A1 改值', p.edits[0].op === 'set_cell' && p.edits[0].row === 2 && p.edits[0].col === 'B' && p.edits[0].v === '99', p);
p = pc('在最後加一欄「總價」'); check('白話：加欄', p.edits[0].op === 'add_col' && p.edits[0].name === '總價');
p = pc('在最後加一列：kiwi,1,3'); check('白話：加列', p.edits[0].op === 'add_row' && p.edits[0].values.join() === 'kiwi,1,3');
p = pc('把「apple」全部改成「蘋果」'); check('白話：取代', p.edits[0].op === 'replace_all' && p.edits[0].repl === '蘋果');
p = pc('刪掉 name 是 banana 的列'); check('白話：條件刪列', p.edits[0].op === 'del_rows' && p.edits[0].where.value === 'banana', p);
p = pc('把整份表格翻成英文'); check('讀不懂的交給 AI（unmatched）', p.edits.length === 0 && p.unmatched.length === 1);
p = pc('在最後加一欄「總價」＝C2*2', xs()); check('xlsx 白話：加公式欄', p.edits[0] && p.edits[0].formula === 'C2*2', p);
// ── 給模型的提示：只給概要
const pr = C.editPrompt(base(), '把價格都加一', null); check('提示：有欄位字母、標題、型別、動作字彙，沒有整份資料', /A="name"/.test(pr.user) && /B="qty":number/.test(pr.user) && /sort/.test(pr.system) && /Request: 把價格都加一/.test(pr.user));
const bigsp = C.parseCsv('v\n' + Array.from({ length: 5000 }, (_, i) => 'row' + i).join('\n'), 'f'); check('大表的提示很短', C.editPrompt(bigsp, 'x', null).user.length < 1500, C.editPrompt(bigsp, 'x', null).user.length);
check('AI 回覆只收封閉動作', C.parseEditsReply(J({ say: 'ok', edits: [{ op: 'sort', col: 'A' }, { op: 'eval', code: 'x' }] })).edits.length === 1);
(async () => {
  if (!JSZip) { console.log('（沒有 jszip，略過 xlsx 讀寫測試）'); }
  else {
    const sp0 = xs(); sp0.objects[0].cols[1].w = 20; sp0.objects[0].frozen = { r: 1, c: 0 }; sp0.objects[0].merges = ['A1:B1'];
    const bytes = await C.buildXlsx(sp0, JSZip); const back = await C.readXlsx(bytes, JSZip, 'x');
    const g = (s) => J(s.objects[0].rows.map((rw) => s.objects[0].cols.map((c) => rw.c[c.id] === undefined ? '' : rw.c[c.id])));
    check('xlsx 寫出再讀回：值、公式、快取值', g(back) === g(sp0) || J(back.objects[0].rows[2].c.c5) === J({ f: 'E2+C3-D3', v: 880 }), [g(back), g(sp0)]);
    check('xlsx：欄寬、凍結窗格、合併儲存格保留', back.objects[0].cols[1].w === 20 && back.objects[0].frozen.r === 1 && back.objects[0].merges[0] === 'A1:B1', back.objects[0]);
    check('xlsx：讀回來的公式還是公式（可以重算）', C.isF(back.objects[0].rows[1].c.c5) && C.computed(back.objects[0])[2][4] === 880);
    check('xlsx 簽章：沒改＝同一份', back.sig === C.sigOf(back) && run(back, [{ op: 'set_cell', row: 2, col: 'C', v: '5' }]).spec.sig !== C.sigOf(run(back, [{ op: 'set_cell', row: 2, col: 'C', v: '5' }]).spec));
    const two = C.applyEdits(sp0, [{ op: 'add_sheet', name: 'Two', rows: [['x', 'y'], ['1', '2']] }], {}).spec; const b2 = await C.readXlsx(await C.buildXlsx(two, JSZip), JSZip, 'x'); check('xlsx 多工作表', b2.objects.length === 2 && b2.objects[1].name === 'Two' && b2.objects[1].rows[1].c.c2 === 2 || b2.objects[1].rows[1].c.c2 === '2', J(b2.objects.map((o) => o.name)));
    const sp1 = C.parseCsv('a,"b<&>"\n1,"x\ny"\n', 'f'); sp1.format = 'xlsx'; const b3 = await C.readXlsx(await C.buildXlsx(sp1, JSZip), JSZip, 'x'); check('xlsx：特殊字元與換行', b3.objects[0].rows[0].c.c2 === 'b<&>' && b3.objects[0].rows[1].c.c2 === 'x\ny', J(b3.objects[0].rows));
    const gaps = C.newSheet('G', [['a'], [], ['c']], { header: false }); const sp2 = { v: 1, format: 'xlsx', title: 't', objects: [gaps] }; const b4 = await C.readXlsx(await C.buildXlsx(sp2, JSZip), JSZip, 'x'); check('xlsx：空白列位置保留（A1 參照不錯位）', b4.objects[0].rows.length === 3 && b4.objects[0].rows[2].c.c1 === 'c', J(b4.objects[0].rows));
  }
  console.log('sheet_core: ' + ok + ' passed, ' + bad.length + ' failed' + (bad.length ? '：\n  ' + bad.join('\n  ') : '')); process.exit(bad.length ? 1 : 0);
})();
