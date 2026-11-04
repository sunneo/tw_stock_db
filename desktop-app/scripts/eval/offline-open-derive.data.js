// 離線「打開」語意推導評測集：沒有寫進任何規則的新說法。格式：[句子, 期望種類]
// 規則：不可以為了讓這份評測過關，把這些句子或關鍵詞寫進規則（共識檔 offline-semantic.json 禁止）；要靠工具說明、同義詞、探索步驟。
// 分兩組：
//   seen：第一輪寫的（工具說明的「適用」詞是看著這組寫的，所以這組的程式端命中率偏樂觀，只能當回歸測試）
//   heldout：說明補完之後才寫的，用的詞沒有出現在任何種類名詞或工具說明裡；這組才是真正的「推導能力」
const seen = [
    ['叫出 https://example.com 這個頁面', 'url'], ['開一下 tw.yahoo.com', 'url'], ['幫我前往 https://news.ycombinator.com 看看', 'url'],
    ['調出剛剛那首曲子的鋼琴捲簾', 'music'], ['打開那段旋律', 'music'], ['叫出那個配樂檔', 'music'], ['秀出這首歌的樂譜', 'music'],
    ['打開那份 pdf', 'pdf'], ['叫出那份 PDF 說明書', 'pdf'],
    ['把那份合約叫出來', 'docx'], ['調出會議紀錄', 'docx'], ['叫出那封公文', 'docx'], ['秀出我的履歷', 'docx'],
    ['把那份財報叫出來', 'xlsx'], ['調出績效表', 'xlsx'], ['叫出帳目明細', 'xlsx'], ['秀出銷售報表', 'xlsx'],
    ['調出員工名單', 'csv'], ['叫出那份通訊錄', 'csv'],
    ['叫出那份提案', 'deck'], ['調出那份簡報', 'deck'], ['秀出發表用的投影片', 'deck'],
    ['叫出那個模型', 'model3d'], ['調出立體場景', 'model3d'], ['秀出房間的 3D 擺設', 'model3d'],
    ['叫出那個設計稿', 'picture'], ['調出那張照片來修', 'picture'], ['調出向量標誌', 'svg'], ['叫出剪輯畫面', 'video'], ['秀出那段錄影', 'video'],
    ['開一下命令列', 'terminal'], ['叫出終端畫面', 'terminal'], ['用終端機看一下目錄', 'terminal'],
    ['檢視這個 yaml 設定', 'data'], ['叫出那個 json 檔', 'data'], ['調出 toml 設定', 'data'], ['顯示出那個純文字檔', 'text'],
    ['叫出練習題學習單', 'worksheet'], ['調出教材', 'worksheet'], ['打開我的資料庫檔', 'sqlite'], ['叫出網頁編輯畫面', 'html'], ['顯示出那個腳本檔', 'code']
];
const heldout = [
    ['叫出今年的損益表', 'xlsx'], ['調出預算規劃那張表', 'xlsx'], ['秀出庫存數量的表格', 'xlsx'],
    ['叫出那份企劃書', 'docx'], ['調出我寫的報告', 'docx'], ['秀出那封推薦信', 'docx'], ['叫出備忘錄', 'docx'],
    ['調出簡報檔', 'deck'], ['叫出明天要講的那份', 'deck'],
    ['叫出那首民謠', 'music'], ['秀出伴奏的和弦', 'music'], ['調出這首歌', 'music'],
    ['叫出建築物的模型', 'model3d'], ['秀出家具的擺放位置', 'model3d'], ['調出空間規劃圖', 'model3d'],
    ['叫出那張海報', 'picture'], ['調出插畫來上色', 'picture'], ['秀出公司圖案的向量檔', 'svg'],
    ['叫出影片素材來剪', 'video'], ['調出那支短片', 'video'],
    ['開個 shell', 'terminal'], ['叫出 bash', 'terminal'],
    ['叫出系統設定檔', 'data'], ['秀出那份讀我檔', 'markdown'], ['叫出那篇隨手記', 'text'],
    ['調出孩子的作業單', 'worksheet'], ['叫出期末測驗卷', 'worksheet'], ['秀出那個官網', 'html']
];
module.exports = seen.concat(heldout);
module.exports.seen = seen;
module.exports.heldout = heldout;
