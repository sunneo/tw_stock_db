// node scripts/article-tests/article_outline.test.js -- 長文章目錄：wiki（Markdown／MediaWiki）、新聞（沒標題）、小說（章回）、分段閱讀
const A = require('../../renderer/src/tools/article_outline.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }

// ---- wiki（Markdown，抓網頁轉出來的樣子）
const wiki = '# 蜘蛛\n\n蜘蛛是節肢動物。\n\n## 分類\n\n分類內容很多。\n\n```\n# 這不是標題\n```\n\n## 習性\n\n### 捕食\n\n結網捕食。\n\n### 繁殖\n\n產卵。\n';
const w = A.outline(wiki);
check('markdown: style and titles', w.style === 'markdown' && w.sections.map((s) => s.title).join('|') === '蜘蛛|分類|習性|捕食|繁殖', w.sections.map((s) => s.title));
check('markdown: # inside a code fence is not a heading', !w.sections.some((s) => /這不是標題/.test(s.title)));
check('markdown: levels follow the #s', w.sections.map((s) => s.level).join('') === '12233');
check('section chars add up to the whole text (no gaps)', w.sections.reduce((n, s) => n + s.chars, 0) === wiki.length);
check('preview shows the first words of the body', /蜘蛛是節肢動物/.test(w.sections[0].preview));

// ---- MediaWiki
const mw = A.outline('開頭一段文字，說明這個條目講什麼，足夠長讓它自成一節的內容。\n== 歷史 ==\n很久以前。\n=== 早期 ===\n更早。\n== 現況 ==\n現在。\n');
check('mediawiki headings; text before the first heading becomes its own section', mw.style === 'mediawiki' && mw.sections.map((s) => s.title).join('|') === '（開頭：第一個標題之前）|歷史|早期|現況', mw.sections.map((s) => s.title));

// ---- 小說：章回
const novel = '《三國演義》\n\n楔子\n話說天下大勢。\n\n第一回 宴桃園豪傑三結義\n劉備關羽張飛。\n\n第二回 張翼德怒鞭督郵\n怒鞭。\n\n第十二回 陶恭祖三讓徐州\n三讓。\n\n尾聲\n完。\n';
const n = A.outline(novel);
check('novel: chapters detected (楔子, 第N回, 尾聲)', n.style === 'chapters' && n.sections.map((s) => s.title).join('|').includes('第十二回 陶恭祖三讓徐州') && n.sections.some((s) => s.title === '楔子') && n.sections.some((s) => s.title === '尾聲'), n.sections.map((s) => s.title));
const en = A.outline('Chapter 1\nIt was a dark night.\n\nChapter 2\nMorning came.\n\nChapter III\nThe end of it.\n\nEpilogue\nLater.\n');
check('English novel: Chapter N, roman numerals, Epilogue', en.style === 'chapters' && en.count === 4, en.sections.map((s) => s.title));

// ---- 新聞：沒標題 → 依段落切
const news = Array.from({ length: 30 }, (_, i) => '第' + (i + 1) + '段新聞內容，'.repeat(60)).join('\n\n');
const nw = A.outline(news);
check('headingless article is split by paragraphs into similar-sized parts', nw.style === 'paragraphs' && nw.count >= 2 && nw.sections.every((s) => s.chars > 0) && nw.sections.reduce((a, s) => a + s.chars, 0) === news.length, nw.count);
const short = A.outline('一則很短的快訊。\n');
check('a tiny article is one section', short.count === 1 && short.sections[0].chars === short.total_chars);

// ---- 編號標題與底線標題
check('numbered headings', A.outline('1. 簡介\n文字\n2. 方法\n文字\n2.1 資料\n文字\n').style === 'numbered');
check('underlined headings', A.outline('簡介\n====\n文字\n\n方法\n====\n文字\n').style === 'underline');

// ---- 分段閱讀
const s2 = A.sectionText(novel, n, 2);
check('read one chapter by number (the heading line is part of it, the next chapter is not)', s2.content.indexOf('第一回 宴桃園豪傑三結義') === 0 && /劉備/.test(s2.content) && !/第二回/.test(s2.content) && s2.has_more === false, s2);
check('read by part of the title', /三讓/.test(A.sectionText(novel, n, '陶恭祖').content));
const rg = A.sectionText(novel, n, { from: 2, to: 3 });
check('read a range of sections', /劉備/.test(rg.content) && /怒鞭/.test(rg.content) && rg.from_section === 2 && rg.to_section === 3, rg);
const big = '# 長\n' + '很長的一段文字。\n'.repeat(3000);
const bo = A.outline(big); const p1 = A.sectionText(big, bo, 1, { maxChars: 2000 });
check('a long section is paged: has_more and next_offset continue exactly', p1.has_more && p1.returned_chars <= 2000 && A.sectionText(big, bo, 1, { maxChars: 2000, offset: p1.next_offset }).offset === p1.next_offset);
let all = '', off = 0, guard = 0; for (;;) { const r = A.sectionText(big, bo, 1, { maxChars: 5000, offset: off }); all += r.content; if (!r.has_more || ++guard > 50) break; off = r.next_offset; }
check('paging a section reads every character exactly once', all === big);
check('unknown section gives a helpful error', /no such section/.test(A.sectionText(novel, n, 99).error) && /no such section/.test(A.sectionText(novel, n, '不存在').error));
check('max_depth keeps only the upper levels', A.outline(wiki, { max_depth: 2 }).sections.every((s) => s.level <= 2));
check('CRLF text is handled', A.outline('# A\r\n內容\r\n# B\r\n內容\r\n').count === 2);
console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'article_outline: ' + ok + ' passed');
process.exit(bad.length ? 1 : 0);
