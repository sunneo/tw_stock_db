// LALR(1) 表產生器與驅動程式測試：node renderer/src/logmine/lr_core.test.js
const R = require('./lr_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 800))); } }
const T = (s) => s.split(' ').filter(Boolean).map((t, i) => ({ t, v: t, n: i + 1 }));
const P = (lhs, rhs, extra) => Object.assign({ lhs, rhs: rhs.split(' ').filter(Boolean) }, extra || {});
const show = (n) => (n.leaf ? n.sym : '(' + n.sym + ' ' + n.children.map(show).join(' ') + ')');

// ① 教科書的運算式文法（遞迴）：E → E + T | T、T → T * F | F、F → ( E ) | id
const EXPR = { start: 'E', productions: [P('E', 'E + T'), P('E', 'T'), P('T', 'T * F'), P('T', 'F'), P('F', '( E )'), P('F', 'id')] };
const te = R.build(EXPR);
check('運算式文法：12 個狀態＋1 個接受狀態（bison 也這樣算）、沒有衝突', te.stats.states === 13 && te.stats.conflicts === 0, te.stats);
check('運算式：id + id * id 被接受，乘法比加法結合得緊（由文法的遞迴結構決定）', (() => { const r = R.parse(te, T('id + id * id')); return r.ok && show(r.tree).replace(/\(E \(T \(F id\)\)\)/g, 'e') .indexOf('(T (T (F id)) * (F id))') > 0; })(), (() => { const r = R.parse(te, T('id + id * id')); return r.ok ? show(r.tree) : r; })());
check('運算式：巢狀括號（遞迴）', R.accepts(te, T('( id + ( id * id ) ) * id')));
check('運算式：不合法的串被拒絕，並且說出期待什麼（錯誤位置、可接受的 token）', (() => { const r = R.parse(te, T('id + * id')); return !r.ok && r.error.token === '*' && r.error.at === 2 && r.error.expected.includes('id') && r.error.expected.includes('('); })(), R.parse(te, T('id + * id')));
check('運算式：括號沒關', R.parse(te, T('( id + id')).ok === false);

// ② LALR 與 SLR 的差別：S → L = R | R；L → * R | id；R → L（SLR 會衝突，LALR(1) 不會）
const LV = R.build({ start: 'S', productions: [P('S', 'L = R'), P('S', 'R'), P('L', '* R'), P('L', 'id'), P('R', 'L')] });
check('LALR(1)：指派文法沒有衝突（SLR 會有 shift/reduce）', LV.stats.conflicts === 0 && R.accepts(LV, T('* id = id')) && R.accepts(LV, T('id')), LV.conflicts);

// ③ dangling else：一個 shift/reduce 衝突，照 bison 預設 shift
const DE = R.build({ start: 'S', productions: [P('S', 'if E then S'), P('S', 'if E then S else S'), P('S', 'other'), P('E', 'b')] });
check('dangling else：偵測到 1 個 shift/reduce 衝突，預設 shift，else 接到最近的 if', DE.stats.conflicts === 1 && DE.conflicts[0].kind === 'shift/reduce' && DE.conflicts[0].token === 'else' && /預設：shift/.test(DE.conflicts[0].resolved) && (() => { const r = R.parse(DE, T('if b then if b then other else other')); return r.ok && show(r.tree).indexOf('(S if (E b) then (S if (E b) then (S other) else (S other)))') >= 0; })(), DE.conflicts);
check('衝突說明是人看得懂的', /else.*shift／reduce.*預設：shift/.test(R.describeConflict(DE, DE.conflicts[0])), R.describeConflict(DE, DE.conflicts[0]));

// ④ 優先序解決衝突：模糊的運算式文法 E → E + E | E * E | num，加上優先序就沒有未解決的衝突
const AMB = { start: 'E', productions: [P('E', 'E + E'), P('E', 'E * E'), P('E', 'num')] };
const noPrec = R.build(AMB); const withPrec = R.build(Object.assign({}, AMB, { prec: { '+': { level: 1, assoc: 'left' }, '*': { level: 2, assoc: 'left' } } }));
check('模糊文法：沒有優先序 → 有未解決的衝突', noPrec.stats.unresolved > 0, noPrec.stats);
check('模糊文法：加優先序（* 高於 +、左結合）→ 衝突都被優先序解決，結果符合預期', withPrec.stats.unresolved === 0 && withPrec.stats.conflicts > 0 && (() => { const r = R.parse(withPrec, T('num + num * num')); return r.ok && show(r.tree) === '(E (E num) + (E (E num) * (E num)))'; })() && show(R.parse(withPrec, T('num + num + num')).tree) === '(E (E (E num) + (E num)) + (E num))', show(R.parse(withPrec, T('num + num * num')).tree));

// ⑤ ε 產生式與兩種遞迴
const LIST = R.build({ start: 'list', productions: [P('list', ''), P('list', 'list item'), P('item', 'a'), P('item', '[ list ]')] });
check('ε 產生式＋左遞迴＋巢狀：空的、a a、[ a [ a ] ] 都接受', R.accepts(LIST, T('')) && R.accepts(LIST, T('a a')) && R.accepts(LIST, T('[ a [ a ] ] a')) && !R.accepts(LIST, T('[ a')), LIST.stats);
const RR = R.build({ start: 'L', productions: [P('L', 'a , L'), P('L', 'a')] });
check('右遞迴：a , a , a', R.accepts(RR, T('a , a , a')) && !R.accepts(RR, T('a , ')), RR.stats);
const REDRED = R.build({ start: 'S', productions: [P('S', 'A x'), P('S', 'B x'), P('A', 'a'), P('B', 'a')] });
check('reduce/reduce 衝突：取編號小的產生式並記錄', REDRED.conflicts.some((c) => c.kind === 'reduce/reduce' && /取編號小的/.test(c.resolved)), REDRED.conflicts);

// ⑥ 輸出：bison 風格文字與分析表
const y = R.toBison(EXPR, { title: '運算式' });
check('bison 輸出：%token、%start、規則、遞迴的 E : E \'+\' T', /%token .*id/.test(y) && /%start E/.test(y) && /E\n    : E '\+' T\n    \| T\n    ;/.test(y), y);
check('優先序輸出：%left', /%left '\+'/.test(R.toBison(Object.assign({}, AMB, { prec: { '+': { level: 1, assoc: 'left' }, '*': { level: 2, assoc: 'left' } } }))));
const dump = R.dumpTable(te).join('\n'); check('分析表傾印：有 shift（s）、reduce（r）、goto（g）、acc', /s\d+/.test(dump) && /r\d+/.test(dump) && /g\d+/.test(dump) && /acc/.test(dump), dump.slice(0, 300));

// ⑦ 規模：幾百個產生式的文法也能很快建表
(() => { const prods = []; for (let i = 0; i < 300; i++) prods.push(P('stmt', 'k' + i + ' NAME ;')); prods.push(P('file', 'file stmt'), P('file', 'stmt')); const t0 = Date.now(); const t = R.build({ start: 'file', productions: prods }); check('300 個產生式在 2 秒內建表', Date.now() - t0 < 2000 && t.stats.conflicts === 0 && R.accepts(t, T('k7 NAME ; k299 NAME ;')), { ms: Date.now() - t0, st: t.stats }); })();

console.log(ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
