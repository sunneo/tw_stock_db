// node scripts/edit-tests/text_core.test.js -- markdown／純文字的文件核心：往返位元組一致、區塊解析、封閉動作、改過的區塊才重新輸出
const T = require('../../renderer/src/edit/text_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const rt = (t, f) => T.serialize(T.parse(t, f));

const MD = '# 標題\n\n一段文字，\n有兩行。\n\n## 清單\n\n- 甲\n- 乙\n  續行\n- 丙\n\n1. 一\n2. 二\n\n> 引用\n> 第二行\n\n```js\nconst a = 1;\n\nconsole.log(a);\n```\n\n| 名稱 | 值 |\n| --- | ---: |\n| a | 1 |\n| b | 2 |\n\n---\n\n<div class="x">\n  html\n</div>\n\n結尾段落\n';
check('md 往返：完整範例位元組一致', rt(MD) === MD, rt(MD));
const sp = T.parse(MD);
check('md 解析：區塊型別依序', sp.objects.map((b) => b.type).join() === 'heading,para,heading,list,list,quote,code,table,hr,raw,para', sp.objects.map((b) => b.type).join());
check('md 解析：標題層級與文字', sp.objects[0].level === 1 && sp.objects[0].text === '標題' && sp.objects[2].level === 2);
check('md 解析：清單項目（續行併進項目）、編號清單', sp.objects[3].items.length === 3 && /續行/.test(sp.objects[3].items[1]) && sp.objects[3].ordered === false && sp.objects[4].ordered === true && sp.objects[4].items.join() === '一,二', sp.objects[3].items);
check('md 解析：程式碼語言與內容（空行保留）', sp.objects[6].lang === 'js' && sp.objects[6].text === 'const a = 1;\n\nconsole.log(a);');
check('md 解析：表格列、對齊', sp.objects[7].rows.length === 3 && sp.objects[7].rows[0].join() === '名稱,值' && sp.objects[7].align[1] === 'right', sp.objects[7]);
check('md 解析：html 區塊原樣保留', sp.objects[9].type === 'raw' && /<div/.test(sp.objects[9].text));
// 各種邊界都要位元組一致
const cases = ['', '\n', '\n\n\n', '   \n', 'a', 'a\n', 'a\n\n', '\n\na\n', 'a\r\nb\r\n\r\nc', '# h', '# h\n', '# h\ntext\n', 'text\n# h\n', 'a\nb\n---\n', 'Title\n=====\n\ntext', 'Sub\n---\n', '* * *\n', '- a\n- b', '- a\n\n- b\n', '1) x\n2) y\n', '```\nunclosed', '~~~py\nx\n~~~\n', '> q\ntext lazy\n', '|a|b|\n|-|-|\n|1|2|\n', '| not a table |\n', '<!-- c -->\n\ntext', '﻿# bom\n', 'a  \nb  \n', '\t缩进\n', '- a\n  - nested\n  - n2\n- b\n', '#no space\n', '#######\n', '``` inline ` bad\n'];
let allRt = true; cases.forEach((c) => { const r = rt(c); if (r !== c) { allRt = false; bad.push('往返失敗 ' + JSON.stringify(c) + ' → ' + JSON.stringify(r)); } }); check('md 往返：邊界案例全部位元組一致（' + cases.length + ' 個）', allRt);
check('txt 往返：換行、CRLF、結尾換行', ['', 'a', 'a\n', 'a\n\nb', 'a\r\nb\r\n', '\n\n'].every((c) => rt(c, 'txt') === c));
check('txt：一行一個區塊', T.parse('x\ny\n', 'txt').objects.length === 3 && T.parse('x\ny\n', 'txt').objects[2].text === '');
// 隨機往返（用片段拼出各種組合）
let rnd = 7; const rand = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const frag = ['# H', '## h2', 'para text', 'more', '', '', '- li', '  - sub', '1. one', '> q', '```', '```js', '---', '***', '| a | b |', '|---|---|', '| 1 | 2 |', '<div>', '</div>', '===', '   ', 'tail  ', '\t', '#'];
let fz = true; for (let i = 0; i < 400; i++) { const n = 1 + Math.floor(rand() * 14), eol = rand() < 0.2 ? '\r\n' : '\n'; const t = Array.from({ length: n }, () => frag[Math.floor(rand() * frag.length)]).join(eol) + (rand() < 0.5 ? eol : ''); const r = rt(t); if (r !== t) { fz = false; bad.push('隨機往返失敗 ' + JSON.stringify(t) + ' → ' + JSON.stringify(r)); break; } } check('隨機 400 組：parse 再 serialize 位元組一致', fz);

// 動作
let d = T.validate(T.parse(MD)).spec; const ids = d.objects.map((b) => b.id);
let r = T.applyEdits(d, [{ op: 'set_text', id: ids[1], text: '改過的段落' }]);
check('set_text：只有改過的區塊重新輸出，其餘位元組不變', r.applied.length === 1 && T.serialize(r.spec) === MD.replace('一段文字，\n有兩行。', '改過的段落'), T.serialize(r.spec).slice(0, 60));
check('改過的區塊 src 被清掉、沒改的保留', r.spec.objects[1].src === undefined && r.spec.objects[0].src === '# 標題');
r = T.applyEdits(d, [{ op: 'set_heading', id: ids[2], level: 3 }]); check('set_heading', T.serialize(r.spec).includes('### 清單') && r.spec.objects[2].level === 3);
r = T.applyEdits(d, [{ op: 'set_heading', id: ids[1], level: 2 }]); check('段落變標題（多行併成一行）', r.spec.objects[1].type === 'heading' && r.spec.objects[1].text === '一段文字， 有兩行。', r.spec.objects[1]);
r = T.applyEdits(d, [{ op: 'set_heading', id: ids[6], level: 2 }]); check('程式碼不能變標題', r.rejected.length === 1, r.rejected);
r = T.applyEdits(d, [{ op: 'add_block', block: { type: 'para', text: '新增的' }, after: ids[2] }]); const out = T.serialize(r.spec);
check('add_block：新區塊自動留空白行，不跟前後段落黏在一起', out.includes('## 清單\n\n新增的\n\n- 甲'), out.slice(0, 80));
r = T.applyEdits(d, [{ op: 'add_block', block: { type: 'para', text: '插在前面' }, before: ids[2] }]); check('add_block before', T.serialize(r.spec).includes('有兩行。\n\n插在前面\n\n## 清單'), T.serialize(r.spec).slice(0, 80));
r = T.applyEdits(d, [{ op: 'remove_object', id: ids[1] }]); check('刪除區塊（共用動作）', !T.serialize(r.spec).includes('一段文字') && T.serialize(r.spec).startsWith('# 標題\n\n## 清單'));
r = T.applyEdits(d, [{ op: 'move_object', id: ids[10], to: 'first' }]); check('搬到最前面（first＝文件開頭）', T.serialize(r.spec).startsWith('結尾段落'), T.serialize(r.spec).slice(0, 20));
r = T.applyEdits(d, [{ op: 'replace_all', find: '甲', repl: '甲甲' }]); check('replace_all：只動有出現的區塊（清單），其餘位元組不變', T.serialize(r.spec) === MD.replace('- 甲\n', '- 甲甲\n') && r.spec.objects[0].src === '# 標題', T.serialize(r.spec).slice(60, 100));
r = T.applyEdits(d, [{ op: 'replace_all', find: '不存在的字', repl: 'x' }]); check('replace_all：找不到就回報', r.rejected.length === 1 && /not found/.test(r.rejected[0].error), r.rejected);
r = T.applyEdits(d, [{ op: 'replace_all', find: 'A', repl: 'B', caseSensitive: true, scope: ids[6] }]); check('replace_all：大小寫、範圍', r.rejected.length === 1 || !T.serialize(r.spec).includes('Bonst'));
r = T.applyEdits(d, [{ op: 'replace_all', find: 'a(\\d?)', repl: 'z', regex: true, scope: ids[6] }]); check('replace_all：regex', /const z = 1;/.test(T.serialize(r.spec)), T.serialize(r.spec).slice(140, 200));
r = T.applyEdits(d, [{ op: 'set_cell', id: ids[7], row: 1, col: 1, text: '99' }]); check('set_cell：改表格儲存格（表格重新輸出、對齊保留）', /\| a \| 99 \|/.test(T.serialize(r.spec)) && /---:/.test(T.serialize(r.spec)), T.serialize(r.spec).slice(190, 260));
r = T.applyEdits(d, [{ op: 'set_cell', id: ids[7], row: 9, col: 0, text: 'x' }]); check('set_cell：超出表格被拒絕', r.rejected.length === 1);
r = T.applyEdits(d, [{ op: 'list_toggle', id: ids[3], ordered: true }]); check('list_toggle：項目符號變編號', /^1\. 甲/m.test(T.serialize(r.spec)));
r = T.applyEdits(d, [{ op: 'set_text', id: ids[1], text: 'x' }, { op: 'set_text', id: 'nope', text: 'y' }]); check('不存在的區塊被略過並回報，其他照做', r.applied.length === 1 && r.rejected.length === 1);
let lk = T.applyEdits(d, [{ op: 'set_locked', id: ids[1], locked: true }]).spec; r = T.applyEdits(lk, [{ op: 'set_text', id: ids[1], text: 'z' }]); check('鎖住的區塊不能改', r.rejected.length === 1 && /locked/.test(r.rejected[0].error));
// 驗證
const v = T.validate({ v: 1, objects: [{ type: 'heading', text: 'a\nb', level: 99 }, { type: 'list', items: 'oops' }, { type: 'table', rows: [['a'], ['b', 'c']] }] }).spec;
check('validate：層級夾在 1–6、標題不含換行、清單至少一項、表格各列等寬', v.objects[0].level === 6 && v.objects[0].text === 'a b' && v.objects[1].items.length === 1 && v.objects[2].rows.every((x) => x.length === 2), v.objects);
check('起手式可用且能輸出', T.listStarters().length >= 3 && T.serialize(T.starter('readme')).includes('## 安裝') && /```bash/.test(T.serialize(T.starter('readme'))));
check('outline', T.outline(T.parse(MD)) === '- 標題\n  - 清單');
// 移動（文件順序：earlier／later／first／last）、轉型、白話指令、AI 提示與回覆
{ const d2 = T.parse('甲\n\n乙\n\n丙\n', 'md'), id = (i) => d2.objects[i].id;
  let q = T.applyEdits(d2, [{ op: 'move_object', id: id(2), to: 'earlier' }, { op: 'move_object', id: id(0), to: 'last' }]); check('move earlier／last 依序套用（每一個看當下的位置）', T.serialize(q.spec) === '丙\n\n乙\n\n甲\n' || T.serialize(q.spec) === '乙\n\n丙\n\n甲\n', T.serialize(q.spec));
  q = T.applyEdits(d2, [{ op: 'move_object', id: id(1), to: 'later' }]); check('move later', T.serialize(q.spec) === '甲\n\n丙\n\n乙\n', T.serialize(q.spec));
  q = T.applyEdits(d2, [{ op: 'move_object', id: id(1), to: 'nope' }]); check('move 不認得的位置被拒絕', q.rejected.length === 1);
  q = T.applyEdits(d2, [{ op: 'convert_block', id: id(0), to: 'quote' }, { op: 'convert_block', id: id(1), to: 'olist' }, { op: 'convert_block', id: id(2), to: 'heading', level: 3 }]); check('convert_block：引用、編號清單、標題', T.serialize(q.spec) === '> 甲\n\n1. 乙\n\n### 丙\n', T.serialize(q.spec));
  const tx = T.parse('a\nb', 'txt'); q = T.applyEdits(tx, [{ op: 'convert_block', id: tx.objects[0].id, to: 'heading' }]); check('純文字不能轉成標題', q.rejected.length === 1);
  const pc = (t, doc) => T.parseCommands(t, doc || d2);
  check('白話：全部取代', JSON.stringify(pc('把「乙」改成「Z」').edits) === JSON.stringify([{ op: 'replace_all', find: '乙', repl: 'Z' }]));
  check('白話：刪掉第 N 段、改第 N 段', pc('刪掉第2段').edits[0].op === 'remove_block' && pc('把第3段改成 新的').edits[0].text === '新的');
  check('白話：標題層級、轉清單', pc('把第1段改成二級標題').edits[0].level === 2 && pc('把第2段改成編號清單').edits[0].to === 'olist');
  check('白話：在最後加一段、在某段後面加標題', pc('在最後加一段：結尾').edits[0].after === 'end' && pc('在第1段後面加一個三級標題：小').edits[0].block.level === 3);
  check('白話：讀不懂的留給 AI', pc('把這份文件寫得更專業一點').unmatched.length === 1 && pc('把這份文件寫得更專業一點').edits.length === 0);
  const ap = T.applyEdits(d2, pc('在最後加一段：結尾；刪掉第1段').edits); check('白話：一次多件事', T.serialize(ap.spec) === '乙\n\n丙\n\n結尾\n', T.serialize(ap.spec));
  const P = T.editPrompt(d2, '把乙改短', d2.objects[1].id); check('editPrompt：含 id、選取標記、動作清單', /\[b2\]/.test(P.user) && /\(selected\)/.test(P.user) && /set_text/.test(P.system) && /把乙改短/.test(P.user));
  const R = T.parseEditsReply('好的 {"say":"改好","edits":[{"op":"set_text","id":"b1","text":"x"},{"op":"drop_database"}]}'); check('parseEditsReply：只收清單裡的動作', R.ok && R.edits.length === 1 && R.dropped === 1);
}
// 編輯之後文件欄位（格式、換行、BOM）還在：往返之外，「改一個字」也不能把整份檔案的換行改掉
{ const a = T.parse('\uFEFF# a\r\n\r\nb\r\n', 'md'), q = T.applyEdits(a, [{ op: 'set_text', id: a.objects[1].id, text: 'c' }]); check('改一個字之後 BOM 與 CRLF 還在', T.serialize(q.spec) === '\uFEFF# a\r\n\r\nc\r\n', T.serialize(q.spec));
  const b = T.parse('x\r\ny', 'txt'), q2 = T.applyEdits(b, [{ op: 'set_text', id: b.objects[0].id, text: 'z' }]); check('純文字改一行之後格式與換行還在', q2.spec.format === 'txt' && T.serialize(q2.spec) === 'z\r\ny', T.serialize(q2.spec));
  const c = T.parse('  \n\n# t\n', 'md'), q3 = T.applyEdits(c, [{ op: 'set_title', text: '新名字' }]); check('改文件標題不動內容（含開頭空白行）', T.serialize(q3.spec) === '  \n\n# t\n', T.serialize(q3.spec)); }
// replace_block／set_doc／reparse／html
{ const d3 = T.parse('# 甲\n\n乙\n\n丙\n', 'md'), ids3 = d3.objects.map((b) => b.id);
  let q = T.applyEdits(d3, [{ op: 'replace_block', id: ids3[1], text: '**粗** 與 `碼`' }]); check('replace_block：一個區塊換成一個（id 不變，打的字原樣）', q.spec.objects.length === 3 && q.spec.objects[1].id === ids3[1] && T.serialize(q.spec) === '# 甲\n\n**粗** 與 `碼`\n\n丙\n', T.serialize(q.spec));
  q = T.applyEdits(d3, [{ op: 'replace_block', id: ids3[1], text: '## 小\n\n- a\n- b' }]); check('replace_block：一個換成多個（第一個沿用 id）', q.spec.objects.length === 4 && q.spec.objects[0].id === ids3[0] && q.spec.objects[1].id === ids3[1] && q.spec.objects[1].type === 'heading' && q.spec.objects[2].type === 'list' && T.serialize(q.spec) === '# 甲\n\n## 小\n\n- a\n- b\n\n丙\n', T.serialize(q.spec));
  q = T.applyEdits(d3, [{ op: 'replace_block', id: ids3[1], text: '   ' }]); check('replace_block：空白＝刪掉這個區塊', q.spec.objects.length === 2 && T.serialize(q.spec) === '# 甲\n\n丙\n', T.serialize(q.spec));
  q = T.applyEdits(d3, [{ op: 'replace_block', id: ids3[2], text: '最後' }]); check('replace_block：最後一個區塊的結尾換行不變', T.serialize(q.spec) === '# 甲\n\n乙\n\n最後\n', T.serialize(q.spec));
  const tx3 = T.parse('a\nb\nc', 'txt'); q = T.applyEdits(tx3, [{ op: 'replace_block', id: tx3.objects[1].id, text: 'x\ny' }]); check('純文字 replace_block：多行變多個 line 區塊', T.serialize(q.spec) === 'a\nx\ny\nc', T.serialize(q.spec));
  q = T.applyEdits(T.parse('a\n\nb\n', 'md'), [{ op: 'set_doc', eol: 'crlf' }]); check('set_doc 換成 CRLF（src 一起換）', T.serialize(q.spec) === 'a\r\n\r\nb\r\n', T.serialize(q.spec));
  q = T.applyEdits(T.parse('```\nx\ny\n```\n', 'md'), [{ op: 'set_doc', eol: 'crlf' }, { op: 'set_doc', eol: 'lf' }, { op: 'set_doc', bom: true }]); check('set_doc 換來換去回得來、BOM 可加', T.serialize(q.spec) === '﻿```\nx\ny\n```\n', JSON.stringify(T.serialize(q.spec)));
  const old = T.parse('# 甲\n\n乙\n\n丙\n\n丁\n', 'md'), oid = old.objects.map((b) => b.id); const rp = T.reparse(old, '# 甲\n\n乙\n\n新的一段\n\n丙\n\n丁\n'); check('reparse：沒變的區塊沿用 id，新的給新 id', rp.objects.map((b) => b.id).slice(0, 2).join() === oid.slice(0, 2).join() && rp.objects[3].id === oid[2] && rp.objects[4].id === oid[3] && oid.indexOf(rp.objects[2].id) < 0 && new Set(rp.objects.map((b) => b.id)).size === 5, rp.objects.map((b) => b.id));
  const rp2 = T.reparse(T.applyEdits(old, [{ op: 'set_locked', id: oid[1], locked: true }]).spec, '# 甲\n\n乙\n\n丁\n'); check('reparse：刪掉一段，其他保留，鎖定狀態沿用', rp2.objects.length === 3 && rp2.objects[1].locked === true && rp2.objects[2].id === oid[3]);
  check('reparse 之後輸出就是打的字', T.serialize(rp) === '# 甲\n\n乙\n\n新的一段\n\n丙\n\n丁\n');
  { const o3 = T.parse('# 甲\n\n乙\n\n丙\n', 'md'), r3 = T.reparse(o3, '# 甲\n\n乙改了\n\n丙\n'); check('reparse：同位置改了內容的區塊沿用 id', r3.objects.map((b) => b.id).join() === o3.objects.map((b) => b.id).join() && r3.objects[1].text === '乙改了'); }
  check('html：跳脫與連結白名單', T.inlineHtml('<script>x</script> **b** [a](javascript:x) [ok](https://x.y/z?a=1&b=2)') === '&lt;script&gt;x&lt;/script&gt; <strong>b</strong> a <a href="https://x.y/z?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">ok</a>', T.inlineHtml('<script>x</script> **b** [a](javascript:x) [ok](https://x.y/z?a=1&b=2)'));
  const h3 = T.toHtml(T.parse('# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- x\n\n```js\n<b>\n```\n')); check('toHtml：標題、表格、清單、程式碼都有', /<h1>T<\/h1>/.test(h3) && /<th>a<\/th>/.test(h3) && /<td>2<\/td>/.test(h3) && /<ul><li>x<\/li><\/ul>/.test(h3) && /&lt;b&gt;/.test(h3) && !/<b>/.test(h3)); }
console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'text_core: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
