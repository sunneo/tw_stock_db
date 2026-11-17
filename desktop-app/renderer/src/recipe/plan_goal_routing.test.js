// node renderer/src/recipe/plan_goal_routing.test.js
// 計畫目標的路由（plan_core.matchGoals）：用跟 floating-assistant.js 的 _planAnswer 一樣的 facts（query＝cleanQuery(userText)）。
// 斷言：非新聞的「上網查…並整理」走 web_research；沒有附件的「摘要這份文件」不會誤判成文件摘要；沒有 query 的情況不會走 web_research。
const P = require('./plan_core.js'); const R = require('./recipe_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 240))); } };

function goalsFor(q, extra) {
    const f = P.factsFrom(Object.assign({ query: R.cleanQuery(q), text: q, attachments: [] }, extra || {}));
    return P.matchGoals(q, f).map((g) => g.id);
}

// 1. 非新聞的網路查詢 → web_research
check('1 上網查 台積電 並整理', goalsFor('上網查 台積電 股利政策 並整理重點').includes('web_research'), goalsFor('上網查 台積電 股利政策 並整理重點'));
check('1 幫我查 Rust 並整理成重點', goalsFor('幫我查一下 Rust 非同步 並整理成重點').includes('web_research'), goalsFor('幫我查一下 Rust 非同步 並整理成重點'));

// 2. 沒有附件、只說「摘要這份文件」：不該被判成文件摘要（doc_summary 需要 doc／file 附件）
check('2 沒附件不走 doc_summary', !goalsFor('幫我摘要這份文件的重點').includes('doc_summary'), goalsFor('幫我摘要這份文件的重點'));

// 3. 沒有 query 事實時不走 web_research（需要 query 才能搜）
check('3 沒有 query 不走 web_research', !P.matchGoals('上網查 台積電 並整理重點', P.factsFrom({ text: '上網查 台積電 並整理重點' })).some((g) => g.id === 'web_research'));

// 4. 網址＋摘要 → web_summary（有網址時網頁優先）
check('4 有網址走 web_summary', goalsFor('https://example.com/a 摘要重點', { url: 'https://example.com/a' }).includes('web_summary'), goalsFor('https://example.com/a 摘要重點', { url: 'https://example.com/a' }));

console.log('plan_goal_routing.test.js: ' + ok + ' passed, ' + bad + ' failed');
if (bad) process.exit(1);
