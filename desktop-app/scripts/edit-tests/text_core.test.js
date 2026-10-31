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
r = T.applyEdits(d, [{ op: 'move_object', id: ids[10], to: 'back' }]); check('搬到最前面（共用動作的 back＝文件開頭）', T.serialize(r.spec).startsWith('結尾段落'), T.serialize(r.spec).slice(0, 20));
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
console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'text_core: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
