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
const plain = Array.from({ length: 300 }, (_, i) => '這是第' + i + '行網頁文字內容，沒有任何標題標記。').join('\n\n');
const pb = W.toBlocks(plain); const ps = W.sectionIndex(pb, plain.length, { chunkChars: 800 });
check('headingless text is chunked', ps.length > 5 && ps[0].blocks[0] === 0 && ps[ps.length - 1].blocks[1] === 299 && ps.every((x, i) => i === 0 || x.blocks[0] === ps[i - 1].blocks[1] + 1), ps.length);
check('chunk doc offsets cover text', ps[0].doc.offset === 0 && ps[1].doc.offset > 0 && plain.slice(ps[1].doc.offset).startsWith('這是第' + ps[1].blocks[0] + '行') && ps.reduce((a, x) => a + x.doc.chars, 0) === plain.length, ps.slice(0, 2));
const si2 = W.sectionIndex(W.toBlocks(md), md.length); check('block starts line up with markdown', W.toBlocks(md).starts[2] === md.indexOf('## 第一章'));
// ---- 讀完整頁文字：回放「真的 Chrome 156 跑擴充功能 pageTextExtractor」的輸出（fixtures/chrome_page_text.json，scripts 用 Playwright＋系統 Chrome 產生）----
{
  const fx = require('./fixtures/chrome_page_text.json'); const calls = [];
  const replay = async (a) => { calls.push(a); const c = fx.chunks.find((x) => x.offset === (a.offset || 0)); return c ? Object.assign({ ok: true }, c) : { ok: false, error: 'no chunk' }; };
  check('真 Chrome 的欄位是 total_length（沒有 total_chars）：以前的判斷永遠是 undefined', fx.chunks[0].total_length === fx.total_length && fx.chunks[0].total_chars === undefined && !(fx.chunks[0].total_chars > 1000));
  (async () => {
    const r = await W.readAll(replay, { tab_id: 7 }, { chunk: fx.chunk });
    check('readAll：接起來剛好是整頁（長度＝total_length），收完', r.ok && r.text.length === fx.total_length && r.complete && !r.truncated && r.calls === fx.chunks.length && r.total === fx.total_length, { len: r.text && r.text.length, calls: r.calls });
    check('readAll：第一次不帶 offset、之後用 next_offset，其他參數照傳', calls[0].offset === undefined && calls[1].offset === fx.chunks[0].next_offset && calls.every((c) => c.tab_id === 7 && c.max_chars === fx.chunk));
    check('readAll：全文跟逐段記錄逐字相同', r.text === fx.chunks.map((c) => c.text).join(''));
    const built = W.toBlocks(r.text); const idx = W.sectionIndex(built, r.text.length, { chunkChars: 6000 });
    check('真頁面文字能切成區塊與段落索引（沒有標題也不會整頁變一塊）', built.blocks > 20 && idx.length >= 2 && idx.reduce((a, x) => a + x.doc.chars, 0) >= r.text.length * 0.95, { blocks: built.blocks, sections: idx.length });
    const bad2 = await W.readAll(async (a) => (a.offset ? { ok: false } : Object.assign({ ok: true }, fx.chunks[0])), {}, { chunk: fx.chunk });
    check('readAll：中途失敗不丟例外，標成沒收完', bad2.ok && !bad2.complete && bad2.truncated && bad2.text === fx.chunks[0].text);
    const cap = await W.readAll(replay, {}, { chunk: fx.chunk, maxCalls: 1 }); check('readAll：次數上限到了標 truncated', cap.ok && cap.truncated && !cap.complete && cap.calls === 1);
    check('readAll：第一次就失敗回 ok:false', (await W.readAll(async () => ({ ok: false, error: 'x' }), {})).ok === false);
    check('totalOf：total_chars 與 total_length 都認，都沒有用文字長度', W.totalOf({ total_chars: 9 }) === 9 && W.totalOf({ total_length: 7 }) === 7 && W.totalOf({ text: 'abc' }) === 3);
    console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'web_blocks: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
  })();
}
