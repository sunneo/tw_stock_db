// node scripts/deck-tests/deck_url_wiring.test.js
// 簡報委派：只有網址（沒有附件）時，模型沒做出簡報也要由程式組（先抓網頁當素材），不能因為「帶網址」就放棄。
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'src', 'floating-assistant.js'), 'utf8');
const DT = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'src', 'deck', 'deck_tools.js'), 'utf8'); // 簡報工具的真正來源（嵌進 floating-assistant.js，改嵌入區塊會被覆寫）
let ok = 0, bad = 0; const check = (n, c) => { if (c) ok++; else { bad++; console.log('FAIL ' + n); } };
check('有 _deckUrlBrief（抓網頁文字）', /async _deckUrlBrief\(url, log\)/.test(SRC) && /fetch_web_page/.test(SRC));
check('程式組簡報不看有沒有附件／網址（簡報跟附件無關）', /!askedForMaterial\(subResult\) && !\(extra\.shouldStop && extra\.shouldStop\(\)\)\) \{\n\s+const line0/.test(SRC));
check('只有沒說要講什麼才請使用者補素材', /topicLen < 6 && asksMaterial/.test(SRC));
check('網址會被抓回並併進食譜任務', /recipeTask/.test(SRC) && /_deckTopicRecipe\(recipeTask/.test(SRC));
check('截圖在簡報任務裡直接給圖片代號（下載失敗時截圖就拿得到圖）', /meta\.deck_ref = ir\.ref/.test(SRC));
check('下載圖片失敗的錯誤訊息引導改用截圖', /不要重複試下載：用 browser_create_tab/.test(DT) && /take a screenshot of the source page instead/.test(DT));
check('食譜：找不到照片用瀏覽器截圖補（_deckPageShots）', /async _deckPageShots\(url, n, log\)/.test(SRC) && /opts\.url && photos\.filter\(Boolean\)\.length </.test(SRC));
check('食譜：使用者給的圖依序插到沒有照片的頁面', /from: 'user_attachment'/.test(SRC));
check('委派流程把網址與附件圖交給食譜', /\{ url: urlM && urlM\[0\], images: myImages \}/.test(SRC));
check('網頁讀不到文字：fetch → 瀏覽器讀全文／頁面結構 → 截圖＋看圖模型（VLM）', /路三：讀不到文字也能「看」/.test(SRC) && /interpret: true/.test(SRC) && /browser_get_page_structure/.test(SRC) && /browser_get_page_text/.test(SRC));
check('抓不到網址內容就不編造，請使用者貼內文', /我不會憑空編寫新聞/.test(SRC) && /if \(urlM && noMaterialErr\)/.test(SRC));
check('截圖＋看圖：一直看到頁面最底，不限 4 段（只有 300 段安全閥）', /k < 300/.test(SRC) && !/k < 4; k\+\+\) \{\n\s+if \(k > 0\) \{ try \{ await call\('browser_scroll'[^\n]*interpret/.test(SRC) && /到底（捲動位置不再增加）/.test(SRC) && /到底（畫面和上一段一樣）/.test(SRC));
check('網頁素材最多收 12000 字（不再 1800）', /br\.text\.slice\(0, 12000\)/.test(SRC));

// ---- 圖要對題：新聞只用文章自己的圖；圖庫照片要看圖確認、品牌／不相干的不用（2026-11-12 黃仁勳新聞配 TEDx 人物照、健康飲食配麥當勞）----
{
    const fa = require('fs').readFileSync(require('path').join(__dirname, '../../renderer/src/floating-assistant.js'), 'utf8');
    const dt = require('fs').readFileSync(require('path').join(__dirname, '../../renderer/src/deck/deck_tools.js'), 'utf8');
    check('有網址／素材的簡報不走圖庫（newsy）、改用文章自己的圖', /const newsy = !!opts\.url/.test(fa) && /_deckArticleImages\(opts\.url/.test(fa) && /!newsy\) \{/.test(fa));
    check('找圖會請看圖模型確認對題（verify）並預設用查詢字', /verifyText/.test(dt) && /Reply NO if it shows a different subject/.test(dt));
    check('品牌照片（麥當勞等）預設濾掉', /mcdonald/.test(dt));
    check('配圖頁傳 minScore＋verify', /minScore: 1, verify:/.test(fa));
}

console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
