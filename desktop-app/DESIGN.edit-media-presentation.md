# /edit-media-presentation:簡報編輯器

在簡報播放器旁邊多一個 AI 對話框,用說的改簡報:插入畫面、到每一頁插入內容、上網找圖、讀資料、畫圖表。

## 畫面(沿用 /edit-svg、/edit-3d-model、/edit-game 的外框 FaEditShell)

- 左:章 > 頁的樹狀大綱(搬動、複製、隱藏 👁、鎖定 🔓、刪除、改名)與屬性面板(標題、版面、副標題、重點、旁白、轉場)。
- 中:原本的簡報播放器(播放、拖進度、匯出 MP4／PPTX／封包都在播放器上);另一個分頁是簡報的 YAML(權威文件,可直接改)。
- 右:AI 對話框與每一步的記錄(復原、重做、點一步回到那一步)。
- 入口:`/edit-media-presentation [簡報檔案 id｜一句話]`,或播放器工具列上的「✏️ 編輯」(`window.AiChatDeckEditHook`,deck_player.js)。已經在編輯器裡的播放器不放這顆鈕。

## 「這頁」

播放器現在看的那一頁就是「這頁」(500 ms 輪詢 `curIndex()`,大綱跟著;點大綱的一頁,播放器跳過去)。給 AI 的脈絡包:大綱(第幾頁、版面、圖的種類、旁白字數、鎖定)＋這一頁的完整 YAML＋前後頁的標題。

## 文件模型(deck_edit_core.js,純函式)

簡報 YAML 攤平成物件清單:章 `{type:'chapter'}`、頁 `{type:'slide', parent, slide:{layout,bullets,narration,visual,…}}`,清單順序就是簡報順序。隱藏的頁不進輸出的簡報;鎖住的頁不能被改(AI 與面板一樣)。

封閉動作:`set_deck`、`add_chapter`、`rename_chapter`、`add_slide`(after／before／chapter／position)、`update_slide`、`set_title`、`set_narration`、`set_bullets`、`set_visual`、`set_transition`、`remove_object`、`rename_object`、`move_object`、`duplicate_object`、`set_visible`、`set_locked`、`replace_deck`。頁的指法:id、數字(第幾頁,不算隱藏的)、`current`。程式驗證每個動作(欄位白名單、1200 字旁白、6 條重點、150 頁、鎖定),放不進去的退回並說明。

程式先讀的白話(不叫模型):「第 3 頁標題改成…」「這頁旁白改成…」「刪掉第 2 頁」「複製這頁」「把第 1 頁移到最後」「在這頁後面加一頁 標題叫…」「語速改成 1.5 倍」「這頁轉場改成推進」「把第 3 頁隱藏」。

## AI 的兩條路(都用 /media-presentation 原本的零件)

1. **程式先讀的找圖**:「找／插入／放／加…圖片／照片」→ 2~5 個英文關鍵字(AI 翻)→ `_deckFindPhoto`(Wikimedia Commons 與 Openverse,免費授權)→ 圖進檔案快取 → `set_visual`(這頁有重點就 `split`,沒有就 `visual`);「新增一頁放…照片」→ `add_slide`。出處與授權寫進圖的 caption。貼進對話框的圖也一樣處理。
2. **快路**(一次模型呼叫):改字、旁白、加頁、換順序,以及 `find_picture`(每一頁各一個,最多 15)、`generate_image`、`agent`。
3. **代理人**:要上網查、讀網頁或檔案、畫圖表、整章重做(或模型回 `{"op":"agent"}`)→ 委派給內建技能 `media-presentation`(跟 `/media-presentation` 同一組工具:search、find_photo、import_image_url、讀檔案與資料夾、render_chart、get／render_presentation)。任務文字帶:這份簡報的網址、大綱、「這頁」是哪一頁、鎖住的頁不可改、「先 get_presentation_yaml、只改要求的地方、用 render_presentation 存」。結果是新的一份簡報 → `replace_deck`。

## 預覽再套用

每一輪 AI 的結果先存成候選版本(`.deck.yaml`,同一套 `_deckCheck`:格式、圖片、內嵌場景、總長度),播放器直接放候選版本並停在第一個被改的頁,下方列出 ＋新增／✎修改／－刪除,按「接受」才進記錄;「退回」換回原本的版本。簡報檢查沒過的結果直接退回並說明原因。

## 版本

每一步是一個版本(外框的步驟記錄),`ptr` 動就是復原／重做;播放器重新載入、停在原本那一頁。專案存在 IndexedDB(`project/edit-media-presentation/<id>`),重新整理後復原;簡報檔在檔案快取。

## 限制(如實)

- 代理人要真的連得到模型與網路;離線時只剩程式先讀的白話與已經在檔案快取的圖。
- 代理人是整份重寫再比對:鎖住的頁如果被它改到,預覽時會警告,但不會自動還原——不要就按「退回」。
- 隱藏的頁不在 YAML 分頁裡(YAML 是「會播出去的簡報」);用 YAML 分頁改寫會保留隱藏頁以外的內容,隱藏的頁會被丟掉。
- 播放器的聲音(TTS)與匯出沿用原本的實作;這裡不重做。

## 測試

`scripts/deck-tests/deck_edit_core.test.js`(模型、動作、白話、差異)、`scripts/eval/deck_edit.eval.js`(真實 Electron:假模型、假找圖、假代理人;播放器掛載與換頁同步、預覽接受／退回、每頁配圖、代理人替換整份、鎖定、復原、YAML、重新整理、✏️ 編輯鈕、斜線指令)。
