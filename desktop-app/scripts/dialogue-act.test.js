// 對話動作判斷（renderer/src/offline/dialogue_act.js）：預檢、選擇題、程式驗證、記憶、英文句、長句與網址不觸發
const D = require('../renderer/src/offline/dialogue_act.js');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else fail++; console.log((c ? 'ok   ' : 'FAIL ') + m); };
const LA = { tool: 'browser_create_tab', kind: 'url', candidates: ['美國選舉新聞', '川普新聞', '選舉民調'], alternatives: ['web_search', 'browser_create_tab'], primary: 'browser_create_tab' };

// (a) 預檢：沒觸發就保持原行為
ok(!D.precheck('不對，換個方法', null).triggered, '沒有上一步時不觸發');
ok(D.precheck('不對，換個方法', LA).triggered, '短句＋反駁特徵＋有上一步會觸發');
ok(!D.precheck('今天天氣怎麼樣', LA).triggered, '一般句子不觸發（維持現行路由）');
ok(!D.precheck('我是說第二個，然後幫我把這個報告整理成很長很長很長很長的摘要謝謝你', LA).triggered, '超過 25 字不觸發');
ok(!D.precheck('不對 https://a.com', LA).triggered, '句子含網址不觸發');
ok(!D.precheck('不對 [附件：a.pdf（file_id=1）]', LA).triggered, '句子含附件不觸發');
ok(D.precheck('no, that\'s wrong', LA).triggered, '英文 no that\'s wrong 會觸發');
ok(D.precheck('try another one', LA).triggered, '英文 try another 會觸發');
ok(D.precheck('I meant the second one', LA).triggered, '英文 I meant 會觸發');
ok(!D.precheck('', LA).triggered, '空白句不觸發');

// 選擇題訊息與驗證
const msgs = D.buildChoiceMessages({ prevUser: '打開 a.com 找選舉', lastAction: LA, text: '不對，換個方法' });
ok(msgs.length === 2 && msgs[1].content.indexOf('換個方法') >= 0, '選擇題帶上一句與新句');
ok(msgs[1].content.indexOf('選單') >= 0 && /5\. /.test(msgs[1].content), '選單有 5 個選項、沒有「都不是」');
ok(!/都不是/.test(msgs[0].content + msgs[1].content.replace(/都不是，這句不用/g, '')) , '選單不放「都不是」');
ok(msgs[1].content.length < 900, '給模型的訊息夠短');
ok(D.validateChoice({ choice: 3 }).length === 0, '選項 3 合法');
ok(D.validateChoice({ choice: 6 }).length > 0, '選項 6 不合法');
ok(D.validateChoice({ choice: '2' }).length > 0, '字串選項不合法（必須是整數）');
ok(D.validateChoice({}).length > 0, '沒有 choice 欄位不合法');

// 各選項決策
ok(D.decide(1, '我要寫一篇文章', LA).mode === 'pass', '選項 1 新請求照現行路由');
ok(D.decide(2, '不對', LA).mode === 'retry_alt' && D.decide(2, '不對', LA).alternative === 'web_search', '選項 2 否定：改用第一個不同的備選');
ok(D.decide(3, '換個方法', LA).mode === 'retry_alt', '選項 3 換做法走備選');
ok(D.decide(4, '我是說第二個', LA).mode === 'pick' && D.decide(4, '我是說第二個', LA).item === '川普新聞', '選項 4 第二個取到候選');
ok(D.decide(5, '還要加上日期', LA).mode === 'supplement', '選項 5 補充參數');
ok(D.decide(9, 'x', LA).mode === 'ask', '無效選項改問');

// (c) 程式驗證：第N個與換做法
ok(D.parsePick('我是說第二個') === 2, '阿拉伯與中文「第二個」解析為 2');
ok(D.parsePick('第3則') === 3, '「第3則」解析為 3');
ok(D.parsePick('第十一項') === 11 && D.parsePick('第十個') === 10 && D.parsePick('第二十個') === 20, '十一、十、二十都能解析');
ok(D.parsePick('換個方法') === null, '沒有第N個時回 null');
ok(D.decide(4, '不是那個', LA).mode === 'ask', '選項 4 但句子沒有第N個 → 問使用者');
ok(D.decide(4, '第七個', LA).mode === 'ask' && /超出/.test(D.decide(4, '第七個', LA).why), '第七個超出候選範圍 → 問');
ok(D.decide(4, '第一個', LA).item === '美國選舉新聞', '第一個落在範圍內');
ok(D.decide(2, '不對', { tool: 'x', candidates: [] }).mode === 'ask', '沒有備選時否定 → 問使用者');
ok(D.decide(2, '不對', { tool: 'x', alternatives: ['x'], primary: 'x' }).mode === 'ask', '備選全部等於首選 → 問使用者');
const askOpt = D.askOptions(2);
ok(askOpt.length === 3 && askOpt[0].label === '換別的做法' && askOpt[1].label === '選第2個' && askOpt[2].label === '新的問題', '驗證失敗的問題是 1.換別的做法 2.選第N個 3.新的問題');
ok(D.decideFromAsk(1, LA).mode === 'retry_alt', '使用者答 1 → 換做法');
ok(D.decideFromAsk(2, LA).mode === 'pick_ask', '使用者答 2 → 再問第幾個');
ok(D.decideFromAsk(3, LA).mode === 'pass', '使用者答 3 → 新問題照現行');

// 記憶：命中就不再問；換了上一步種類不命中
const mem = {};
const dec = D.decide(4, '第二個', LA);
D.remember(mem, '我是說第二個', LA, dec);
const hit = D.recall(mem, '我是說第二個', LA);
ok(hit && hit.mode === 'pick' && hit.index === 1, '記憶命中：同一句話＋同種類，直接取得 pick');
ok(D.recall(mem, '我是說第二個', { kind: 'pdf', tool: 'x' }) === null, '上一步種類不同不命中');
ok(D.recall(mem, '換個做法', LA) === null, '沒學過的句子不命中');
ok(D.remember(mem, 'x', LA, { mode: 'ask' }) === mem && D.recall(mem, 'x', LA) === null, '問題模式不寫入記憶');
const rec = D.learnRecord('我是說第二個', LA, dec);
ok(rec.verified === true && rec.mode === 'pick' && rec.kind === 'url', '程式驗證成功的紀錄帶 verified 與種類，給訓練資料用');

// 候選清單與上一步摘要
ok(D.summarizeAction(LA).length <= 120 && /候選/.test(D.summarizeAction(LA)), '上一步摘要含候選且不超過 120 字');
ok(D.summarizeAction(null) === '（無）', '沒有上一步時摘要為（無）');

console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
