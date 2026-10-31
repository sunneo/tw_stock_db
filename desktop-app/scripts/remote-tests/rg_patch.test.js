// node scripts/remote-tests/rg_patch.test.js -- 遠端共筆的 patch 模式：以 id 定址的 JSON 差異、套用與略過、逐行 diff3
const P = require('../../renderer/src/remote/rg_patch.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const J = (x) => JSON.stringify(x);
const rt = (a, b, keys) => { const ops = P.diff(a, b, keys); const r = P.apply(a, ops, keys); return { ops, r, same: J(r.doc) === J(b) }; };

// 物件與純量
let t = rt({ a: 1, b: { c: 2, d: 3 } }, { a: 1, b: { c: 5 }, e: 'x' }); check('物件：改、刪、增', t.same && t.r.rejected.length === 0, t);
t = rt({ a: 1 }, { a: 1 }); check('沒變就沒有 ops', t.ops.length === 0);
// 有 id 的陣列（video 的 cues）
const A = { cues: [{ id: 'c1', start: 0, text: '你好' }, { id: 'c2', start: 2, text: '世界' }, { id: 'c3', start: 4, text: '再見' }], name: 'v' };
let B = { cues: [{ id: 'c1', start: 0, text: '你好嗎' }, { id: 'c3', start: 4, text: '再見' }, { id: 'c4', start: 6, text: '新的' }], name: 'v' };
t = rt(A, B); check('有 id 的陣列：改一句、刪一句、加一句', t.same, [t.ops, t.r.doc]);
check('只改一句字幕＝一個很小的 op', P.diff(A, { cues: [Object.assign({}, A.cues[0], { text: 'X' }), A.cues[1], A.cues[2]], name: 'v' }).length === 1);
B = { cues: [A.cues[2], A.cues[0], A.cues[1]], name: 'v' }; t = rt(A, B); check('重新排序', t.same, t.r.doc);
B = { cues: [{ id: 'z', text: 'a' }, ...A.cues], name: 'v' }; t = rt(A, B); check('插到最前面', t.same, t.r.doc);
// 沒有 id 的陣列：整個當一個值
t = rt({ xs: [1, 2, 3] }, { xs: [1, 3] }); check('沒有 id 的陣列整個替換', t.same && t.ops.length === 1 && t.ops[0].op === 'set');
// 並發：我改了 c1，對方同時刪掉 c2 並改了 c3 → 兩邊的 ops 套在同一份上都保留
const base = A, mine = P.apply(base, P.diff(base, { cues: [Object.assign({}, A.cues[0], { text: '我改的' }), A.cues[1], A.cues[2]], name: 'v' })).doc;
const theirOps = P.diff(base, { cues: [A.cues[0], Object.assign({}, A.cues[2], { text: '他改的' })], name: 'v' });
let r = P.apply(mine, theirOps); check('並發：不同項目的修改都保留', r.doc.cues.length === 2 && r.doc.cues[0].text === '我改的' && r.doc.cues[1].text === '他改的' && r.rejected.length === 0, r.doc);
// 對象已被刪：略過並回報
const delOps = P.diff(base, { cues: [A.cues[0], A.cues[2]], name: 'v' }), editOps = P.diff(base, { cues: [A.cues[0], Object.assign({}, A.cues[1], { text: '改被刪的' }), A.cues[2]], name: 'v' });
const afterDel = P.apply(base, delOps).doc; r = P.apply(afterDel, editOps); check('改一個已被別人刪掉的項目：略過並回報', r.rejected.length >= 1 && r.doc.cues.length === 2, r);
r = P.apply(afterDel, delOps); check('重複刪除是冪等的', r.doc.cues.length === 2 && r.rejected.length === 0);
r = P.apply(base, P.diff(base, { cues: [...A.cues, { id: 'n1', text: 'x' }], name: 'v' })); const again = P.apply(r.doc, P.diff(base, { cues: [...A.cues, { id: 'n1', text: 'x' }], name: 'v' })); check('重複插入是冪等的', again.doc.cues.length === 4);
// 以檔名定址（webedit 的 files）
const W = { title: 't', files: [{ name: 'index.html', content: '<h1>a</h1>\n<p>b</p>\n<p>c</p>' }, { name: 'app.js', content: 'let x = 1;\n' }], backend: null };
const W2 = { title: 't', files: [{ name: 'index.html', content: '<h1>a</h1>\n<p>B!</p>\n<p>c</p>' }, { name: 'app.js', content: 'let x = 1;\n' }, { name: 'style.css', content: 'p{}' }], backend: null };
t = rt(W, W2, { files: 'name' }); check('webedit：以檔名定址（改一行、加檔案）', t.same, t.r.doc);
check('webedit：同檔案改字串走文字 op', t.ops.some((o) => o.op === 'text'));
// 同一個檔案兩人改不同行 → diff3 都保留
const mineW = P.apply(W, P.diff(W, { ...W, files: [{ name: 'index.html', content: '<h1>A!</h1>\n<p>b</p>\n<p>c</p>' }, W.files[1]] }, { files: 'name' }), { files: 'name' }).doc;
r = P.apply(mineW, P.diff(W, { ...W, files: [{ name: 'index.html', content: '<h1>a</h1>\n<p>b</p>\n<p>C!</p>' }, W.files[1]] }, { files: 'name' }), { files: 'name' });
check('同一個檔案兩人改不同行：都保留、沒有衝突', r.doc.files[0].content === '<h1>A!</h1>\n<p>b</p>\n<p>C!</p>' && r.conflicts.length === 0, r.doc.files[0]);
r = P.apply(mineW, P.diff(W, { ...W, files: [{ name: 'index.html', content: '<h1>別人的</h1>\n<p>b</p>\n<p>c</p>' }, W.files[1]] }, { files: 'name' }), { files: 'name' });
check('同一行兩人都改：後到者贏並標示衝突', /別人的/.test(r.doc.files[0].content) && !/A!/.test(r.doc.files[0].content) && r.conflicts.length === 1, [r.doc.files[0], r.conflicts]);
// merge3
let m = P.merge3('a\nb\nc\nd', 'a\nB\nc\nd', 'a\nb\nc\nD'); check('merge3：不重疊', m.text === 'a\nB\nc\nD' && !m.conflict, m);
m = P.merge3('a\nb\nc', 'a\nb\nc\nx', 'z\na\nb\nc'); check('merge3：一個加在前、一個加在後', m.text === 'z\na\nb\nc\nx' && !m.conflict, m);
m = P.merge3('a\nb\nc', 'a\nX\nc', 'a\nY\nc'); check('merge3：同一行衝突以 theirs 為準', m.text === 'a\nY\nc' && m.conflict, m);
m = P.merge3('a\nb\nc', 'a\nc', 'a\nb\nc\nd'); check('merge3：一個刪、一個在後面加', m.text === 'a\nc\nd' && !m.conflict, m);
m = P.merge3('x', 'x', 'y'); check('merge3：我沒改就取對方的', m.text === 'y' && !m.conflict);
// 隨機往返：任意兩份文件 diff 再 apply 一定等於目標
let rnd = 1; const rand = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const gen = () => ({ n: Math.floor(rand() * 5), s: rand() < 0.5 ? 'x' : 'line1\nline2\nline3', items: Array.from({ length: Math.floor(rand() * 5) }, (_, i) => ({ id: 'i' + Math.floor(rand() * 8), v: Math.floor(rand() * 3), t: rand() < 0.5 ? 'a' : 'b' })).filter((e, i, a) => a.findIndex((x) => x.id === e.id) === i), tags: rand() < 0.5 ? [1, 2] : [2, 3] });
let allOk = true; for (let i = 0; i < 300; i++) { const a = gen(), b = gen(); const x = rt(a, b); if (!x.same) { allOk = false; bad.push('隨機往返失敗 ' + J(a) + ' → ' + J(b) + ' 得到 ' + J(x.r.doc)); break; } } check('隨機 300 組：diff 再 apply 等於目標', allOk);
console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'rg_patch: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
