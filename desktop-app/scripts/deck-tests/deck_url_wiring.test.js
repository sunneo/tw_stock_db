// node scripts/deck-tests/deck_url_wiring.test.js
// 簡報委派：只有網址（沒有附件）時，模型沒做出簡報也要由程式組（先抓網頁當素材），不能因為「帶網址」就放棄。
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'src', 'floating-assistant.js'), 'utf8');
const DT = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'src', 'deck', 'deck_tools.js'), 'utf8'); // 簡報工具的真正來源（嵌進 floating-assistant.js，改嵌入區塊會被覆寫）
let ok = 0, bad = 0; const check = (n, c) => { if (c) ok++; else { bad++; console.log('FAIL ' + n); } };
check('有 _deckUrlBrief（抓網頁文字）', /async _deckUrlBrief\(url\)/.test(SRC) && /this\.tools\.fetch_web_page/.test(SRC));
check('程式組簡報不看有沒有附件／網址（簡報跟附件無關）', /!askedForMaterial\(subResult\) && !\(extra\.shouldStop && extra\.shouldStop\(\)\)\) \{\n\s+const line0/.test(SRC));
check('只有沒說要講什麼才請使用者補素材', /topicLen < 6 && asksMaterial/.test(SRC));
check('網址會被抓回並併進食譜任務', /recipeTask/.test(SRC) && /_deckTopicRecipe\(recipeTask/.test(SRC));
check('截圖在簡報任務裡直接給圖片代號（下載失敗時截圖就拿得到圖）', /meta\.deck_ref = ir\.ref/.test(SRC));
check('下載圖片失敗的錯誤訊息引導改用截圖', /不要重複試下載：用 browser_create_tab/.test(DT) && /take a screenshot of the source page instead/.test(DT));
check('食譜：找不到照片用瀏覽器截圖補（_deckPageShots）', /async _deckPageShots\(url, n, log\)/.test(SRC) && /opts\.url && photos\.filter\(Boolean\)\.length </.test(SRC));
check('食譜：使用者給的圖依序插到沒有照片的頁面', /from: 'user_attachment'/.test(SRC));
check('委派流程把網址與附件圖交給食譜', /\{ url: urlM && urlM\[0\], images: myImages \}/.test(SRC));
console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
