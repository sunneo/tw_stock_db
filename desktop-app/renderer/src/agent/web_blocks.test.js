const W = require('./web_blocks.js'); const P = require('./jsonl_pager.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 200) : '')); };
const md = '# 標題\n\n開頭段落 [連結](http://a.com/x) 與圖 ![圖說](http://i/p.png)。\n第二行接續。\n\n## 第一章\n- 項目一\n- 項目二 [b](http://b)\n  - 子項\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\n# 不是標題\nlet a = 1;\n```\n\n> 引用文字\n\n### 小節\n尾段';
const r = W.toBlocks(md);
const recs = r.lines.map((l) => JSON.parse(l));
check('types', recs.map((x) => x.t).join(',') === 'h,p,h,li,li,li,table,code,quote,h,p', recs.map((x) => x.t));
check('links split out', recs[1].links.length === 1 && recs[1].links[0].url === 'http://a.com/x' && recs[1].text.includes('連結') && !recs[1].text.includes('http') , recs[1]);
check('image placeholder', recs[1].text.includes('[圖：圖說]'));
check('para lines joined', recs[1].text.includes('。 第二行') || recs[1].text.includes('。第二行') || /。\s*第二行/.test(recs[1].text));
check('code keeps # and lang', recs[7].text.includes('# 不是標題') && recs[7].lang === 'js');
check('sec tracking', recs[3].sec === 's2' && recs[10].sec === 's3' && recs[0].sec === 's1');
check('outline ranges', r.outline.length === 3 && r.outline[1].from === 2 && r.outline[1].to === 8 && r.outline[1].chars > 0, r.outline);
check('nested depth', recs[5].depth === 1);
check('empty', W.toBlocks('').blocks === 0);
// 與分頁器銜接：2000 段長文，小窗口逐頁讀完，筆數與內容相等
let big = ''; for (let i = 0; i < 2000; i++) big += (i % 50 === 0 ? '## 章' + i + '\n\n' : '') + '段落' + i + ' 內容內容內容。\n\n';
const b2 = W.toBlocks(big); let cur = null, got = 0, pages = 0, texts = [];
for (let g = 0; g < 5000; g++) { const pg = P.page(b2.lines, { source: 'bc_1', cursor: cur, chars: 3000 }); if (!pg.ok) { bad.push('page err ' + pg.error); break; } pages++; const ls = pg.text.split('\n').slice(1); got += ls.length; ls.forEach((l) => texts.push(JSON.parse(l).text)); if (!pg.meta.has_more) break; cur = pg.meta.next_cursor; }
check('paging reads everything', got === b2.blocks && pages > 5 && texts.filter((t) => t.startsWith('段落')).length === 2000, { got, blocks: b2.blocks, pages });
check('outline for head limits', W.outlineForHead(b2.outline, 10).length <= 10 && W.outlineForHead(b2.outline, 100).length === 40, W.outlineForHead(b2.outline, 10).length);
const si = W.sectionIndex(r, md.length);
check('index parents', si.length === 3 && si[0].parent === null && si[1].parent === 's1' && si[2].parent === 's2', si);
check('index doc offsets cover reference doc', md.slice(si[1].doc.offset, si[1].doc.offset + si[1].doc.chars).startsWith('## 第一章') && si[2].doc.offset + si[2].doc.chars === md.length, si);
check('index blocks ranges', si[1].blocks[0] === 2 && si[1].blocks[1] === 8, si[1]);
check('index no headings', W.sectionIndex(W.toBlocks('只有一段'), 4)[0].ref === 's0');
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'web_blocks: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
