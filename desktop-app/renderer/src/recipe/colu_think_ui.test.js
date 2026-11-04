// CoLU+Thinking 階段 5 測試：設定開關預設值、推理區塊（跳脫 HTML、空推理不顯示、長推理截斷）。純函式，不載入模型。
// 用法：node renderer/src/recipe/colu_think_ui.test.js
const R = require('./recipe_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info))); } }

// 1-3：開關預設值與讀寫
check('1 setting undefined → on（預設打開）', R.coluThinkingSetting(undefined) === true);
check('2 setting null → on', R.coluThinkingSetting(null) === true);
check('3 setting true → on, false → off', R.coluThinkingSetting(true) === true && R.coluThinkingSetting(false) === false);
// 4：寫入後再讀（模擬設定面板：checkbox 的值 → advancedSettings → 讀回）
const saved = { coluThinking: false }; const reread = R.coluThinkingSetting(JSON.parse(JSON.stringify(saved)).coluThinking);
check('4 round-trip through JSON keeps off', reread === false);
// 5：escapeHtml 跳脫五種字元
check('5 escapeHtml escapes <>&"\'', R.escapeHtml('<b>&"\'</b>') === '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;', R.escapeHtml('<b>&"\'</b>'));
check('5b escapeHtml null → empty string', R.escapeHtml(null) === '');
// 6-7：推理顯示規則
const e1 = R.reasoningView('   \n  ');
check('6 whitespace-only reasoning is hidden', e1.show === false && e1.text === '' && e1.total === 0, e1);
check('7 undefined reasoning is hidden', R.reasoningView(undefined).show === false);
check('8 normal reasoning shown, trimmed, not truncated', (() => { const v = R.reasoningView('  想一想  '); return v.show && v.text === '想一想' && v.truncated === false; })());
// 9：空推理不產生區塊 HTML
check('9 empty reasoning → no block html', R.reasoningBlockHtml('', '計畫') === '' && R.reasoningBlockHtml(null) === '');
// 10：推理內容跳脫 HTML（不可出現可執行的標籤）
const h1 = R.reasoningBlockHtml('<img src=x onerror=alert(1)> & 想</b>', '計畫');
check('10 reasoning html is escaped', h1.indexOf('<img') < 0 && h1.indexOf('</b>') < 0 && h1.indexOf('&lt;img') >= 0 && h1.indexOf('&amp; 想') >= 0, h1);
// 11：區塊是收合的 details，摘要是「思考過程」
check('11 block is collapsed details with 思考過程 summary', /^<details class="colu-think-block"/.test(h1) && h1.indexOf('<details class="colu-think-block" style="margin-top:6px;">') === 0 && h1.indexOf('<details open') < 0 && h1.indexOf('<summary') >= 0 && h1.indexOf('思考過程（計畫）') >= 0, h1.slice(0, 200));
// 12：標籤也跳脫
const h2 = R.reasoningBlockHtml('x', '<script>');
check('12 label is escaped', h2.indexOf('<script>') < 0 && h2.indexOf('&lt;script&gt;') >= 0);
// 13：長推理截斷到 20000 字，並註明已截斷與總字數
const long = 'a'.repeat(25000);
const vl = R.reasoningView(long);
check('13 long reasoning truncated to 20000', vl.truncated === true && vl.text.length === 20000 && vl.total === 25000 && vl.limit === 20000, { len: vl.text.length, total: vl.total });
const hl = R.reasoningBlockHtml(long);
check('14 truncation note shown in block', hl.indexOf('已截斷') >= 0 && hl.indexOf('共 25000 字') >= 0, hl.slice(-200));
// 15：剛好 20000 字不截斷、不註明
const exact = R.reasoningBlockHtml('b'.repeat(20000));
check('15 exactly 20000 chars not truncated', exact.indexOf('已截斷') < 0);
// 16：可自訂上限
const vc = R.reasoningView('字字字字字', 3);
check('16 custom max respected', vc.text === '字字字' && vc.truncated === true && vc.limit === 3, vc);
// 17：REASONING_SHOW_MAX 常數
check('17 REASONING_SHOW_MAX is 20000', R.REASONING_SHOW_MAX === 20000);
// 18：推理文字裡的換行保留（pre 區塊內顯示）、CRLF 正規化
const vn = R.reasoningView('第一行\r\n第二行');
check('18 CRLF normalized to LF', vn.text === '第一行\n第二行', JSON.stringify(vn.text));
// 19：區塊是純文字 pre（不產生 input／a／button 等互動元素）
check('19 block has no interactive elements', !/<(a|button|input|script|iframe)\b/i.test(h1));

console.log('colu_think_ui.test: ' + ok + ' passed, ' + bad.length + ' failed');
if (bad.length) process.exit(1);
