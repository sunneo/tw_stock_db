// 「帶上下文」的離線打開評測集：[分組, 對話片段（role/content）, 最近成功開過的種類（新的在前）, 最後一句, 期望]
// 期望：種類名稱＝應該直接決定成那個種類；'ask'＝上下文互相衝突或沒有線索，應該不猜、交給使用者（回傳沒決定）。
// 分組：anaphora＝純指代（把它打開）；again＝再開一次；tie＝句子有內容但模糊、靠上下文打破平手；ambiguous＝上下文兩種線索衝突；none＝沒有上下文線索；counter＝反例（上下文有線索，但句子自己說了別的種類，以句子為準）。
// 規則：不可以把這些句子或檔名寫進程式的規則；上下文線索由程式從對話自動抽取。
const U = (c) => ({ role: 'user', content: c }), A = (c) => ({ role: 'assistant', content: c });
const items = [
    ['anaphora', [U('幫我看一下 年度預算.xlsx [附件：年度預算.xlsx（file_id=f1）]'), A('這份試算表有三個工作表')], [], '把它打開', 'xlsx'],
    ['anaphora', [U('這是合約 [附件：服務合約.docx（file_id=f2）]'), A('收到了')], [], '打開剛剛那個', 'docx'],
    ['anaphora', [U('簡報在這 [附件：季報.pptx（file_id=f3）]')], [], '幫我叫出那份', 'deck'],
    ['anaphora', [U('看看這張 [附件：封面.png（file_id=f4）]')], [], '開一下這個', 'picture'],
    ['anaphora', [U('說明書在 [附件：手冊.pdf（file_id=f5）]')], [], '把它秀出來', 'pdf'],
    ['anaphora', [U('這首曲子 [附件：夜曲.mid（file_id=f6）]'), A('好的')], [], '打開它', 'music'],
    ['anaphora', [U('資料在 [附件：客戶名單.csv（file_id=f7）]')], [], '調出剛才那份', 'csv'],
    ['anaphora', [U('設定檔 [附件：app.json（file_id=f8）]'), A('已讀取')], [], '叫出它', 'data'],
    ['anaphora', [U('幫我看 https://example.com/news 這篇'), A('這篇是關於…')], [], '把它打開', 'url'],
    ['anaphora', [U('這個模型 [附件：椅子.glb（file_id=f9）]')], [], '開一下剛剛那個', 'model3d'],
    ['again', [U('你好'), A('你好！')], ['xlsx', 'docx'], '再開一次', 'xlsx'],
    ['again', [U('剛剛那個不錯'), A('是的')], ['deck'], '再打開上次那個', 'deck'],
    ['again', [], ['picture'], '重新開一次', 'picture'],
    ['again', [U('謝謝')], ['music', 'video'], '再叫出來', 'music'],
    ['tie', [U('我寫了一份 [附件：期末.docx（file_id=g1）]'), A('寫得不錯')], [], '調出我寫的報告', 'docx'],
    ['tie', [U('明天的簡報 [附件：發表.pptx（file_id=g2）]')], [], '叫出明天要講的那份', 'deck'],
    ['tie', [U('會議錄音的文字 [附件：會議.docx（file_id=g3）]')], [], '叫出會議逐字稿', 'docx'],
    ['ambiguous', [U('先看 [附件：甲.docx（file_id=h1）]'), A('好'), U('再看 [附件：乙.xlsx（file_id=h2）]'), A('好')], [], '把它打開', 'ask'],
    ['ambiguous', [U('這張 [附件：a.png（file_id=h3）]'), U('還有這個 [附件：b.pdf（file_id=h4）]')], [], '開一下剛剛那個', 'ask'],
    ['none', [U('今天天氣很好'), A('是啊')], [], '把它打開', 'ask'],
    ['none', [], [], '打開它', 'ask'],
    ['counter', [U('合約 [附件：服務合約.docx（file_id=c1）]')], [], '叫出那首民謠', 'music'],
    ['counter', [U('看這份 [附件：手冊.pdf（file_id=c2）]')], [], '打開那個試算表', 'xlsx'],
    ['counter', [U('簡報 [附件：季報.pptx（file_id=c3）]')], [], '開一個終端機', 'terminal'],
    ['counter', [U('文件 [附件：報告.docx（file_id=c4）]')], ['docx'], '再開一次那個影片編輯器', 'video'],
    ['counter', [U('試算表 [附件：預算.xlsx（file_id=c5）]')], ['xlsx'], '叫出今年的損益表', 'xlsx']
];
module.exports = items;
