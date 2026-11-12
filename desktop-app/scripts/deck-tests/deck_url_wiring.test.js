// node scripts/deck-tests/deck_url_wiring.test.js
// 簡報委派：只有網址（沒有附件）時，模型沒做出簡報也要由程式組（先抓網頁當素材），不能因為「帶網址」就放棄。
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'src', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c) => { if (c) ok++; else { bad++; console.log('FAIL ' + n); } };
check('有 _deckUrlBrief（抓網頁文字）', /async _deckUrlBrief\(url\)/.test(SRC) && /this\.tools\.fetch_web_page/.test(SRC));
check('程式組簡報的條件是「沒有檔案素材」而不是「沒有網址」', /!hasFileMaterial\(task\) && !\(extra\.shouldStop/.test(SRC));
check('網址會被抓回並併進食譜任務', /recipeTask/.test(SRC) && /_deckTopicRecipe\(recipeTask/.test(SRC));
check('檔案素材判斷不含網址', /hasFileMaterial = \(t\) => \/\\\[附件：\|client-file\\\/\|fap:\/i/.test(SRC));
console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
