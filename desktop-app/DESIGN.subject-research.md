# 不認識的東西，先去查（3D 編輯器與圖像設計共用）

> 2026-10-26。核心 `renderer/src/edit/subject_research.js`（`FaSubjectResearch`，純函式，測試 `scripts/edit-tests/subject_research.test.js`）；宿主端 `edit_host.js` 的 `_subjRefFor`／`_subjBrief`／`_subjGetJson`。

## 起因
在 `/edit-3d` 說「產生茶壺、桌面，把茶壺放到桌面中間，放一個盤子，把雞翅放到盤子」，模型不知道雞翅長怎樣，放了兩個圓錐。使用者要求：不知道的形狀要自己去查——① 上網找 OBJ、② 上網找詳細的形狀描述、③ 上網找平面圖再用 decompose-view 3D 化；而且「這些步驟應該要包括在圖像設計上」，也就是畫圖（`generate_image` 形狀圖路線）、`/edit-svg`、`/edit-picture` 遇到不認識的東西也一樣。

## 梯子（由便宜到貴，做到就不往後）
| 階 | 做法 | 狀態 |
|---|---|---|
| 0 | 自己已經會的：模型庫（茶壺、花瓶…）、成功案例（`DESIGN.edit-cases.md`） | 已有 |
| 1 | **查外形描述**：維基百科（先中文、再英文）取摘要 → 模型整理成「由哪幾塊基本形狀組成、多大（公分）、什麼顏色、在哪裡」→ 存起來 → 給編輯器的模型一小段參考 | **已做（這份文件）** |
| 2D | **找現成的 SVG（已做）**：維基共享資源 `filetype:drawing`（免費授權，不用金鑰）→ 標題要含名字、不要標誌／旗幟／地圖、不要太大 → 清理（`sanitizeSvg`：去腳本／外部連結／編輯器屬性，viewBox 移到 0,0）→ 變成編輯器的 `svg` 物件，附來源與授權。**沒有描述時，找參考圖請視覺模型整理成部位（已做）**（`FaPictureSource` 找圖，`imageBriefPrompt`，答案同樣由程式驗證） |
| 3D-1 | **GitHub 公開專案的 OBJ（已做，3D 的第一階）**：`api.github.com` 搜專案 → 檔案樹找名字對得上的 `.obj` → 抓 `raw.githubusercontent.com` → 解析、縮減面數、擺正、縮到合理大小 | 已做 |
| 3D-2 | 查外形描述（上面的階 1） | 已做 |
| 3D-3 | **找圖 → 3D 化（已做，3D 的最後一階；2026-10-30 起先走 `/image-to-3d` 的封閉立體管線，失敗才退回下面的浮雕做法並註明）**：沒有 OBJ、也沒有文字描述才走：找一張圖 → 切掉背景 → 現有的圖片分解（`image-decompose-redraw`：四叉樹三角網格＋距離變換充氣成 2.5D，Pyodide）→ 帶貼圖的自訂形狀 | 已做 |
3D 的順序是使用者定的：**有 OBJ 就不查描述；沒有描述才找圖 3D 化**（因為專案本來就有「多邊形擬合 2D 再建立 3D」的基礎）。2D 的順序：現成 SVG → 描述 → 參考圖加視覺模型。

## 階 1 怎麼運作
1. 編輯器的 AI 入口（`_edHost` 的 `ask`）在案例比對之後、呼叫編輯器自己的模型之前：`_subjRefFor(kind, 這句話)`。畫圖的形狀圖路線（`_imageMake` 步驟 2c）同一個函式（kind＝`image`）。
2. **問模型一個封閉的題目**（`subjectsPrompt`）：「這句話裡真實世界的具體東西，哪些外形不是簡單幾何體、你不確定能畫對？」附上內建模型庫的名字（那些不用查）。答案一律驗證：最多 3 個、去掉內建的與重複的、英文名稱不是英文就丟掉。常見簡單的東西（桌子、盤子、杯子）不列。
3. 每個東西：**快取**（IndexedDB `FloatingAssistantSubjects`，上限 200 個，最舊的先淘汰）→ 沒有就 **維基百科**（`pickExtract`：標題跟查詢字對得上才收，避免查「雞翅」收到不相干的條目）→ **模型整理**（`briefPrompt`/`parseBrief`：部位的形狀必須在允許清單、尺寸三個數字並夾在合理範圍，不合格的部位丟掉，一個都沒有就當失敗）→ 存快取。查不到網路資料時模型憑印象整理，參考文字裡會標明「沒查到網路資料，僅供參考」。
4. **給模型的參考**（`refBlock`）：「【物件資料：雞翅（網路資料整理）】整體長怎樣；整體約 12×5×4 公分；・小腿 ellipsoid 6×3.5×3.5cm 位置… #c8872e …（照這些部位用基本形狀拼出來，不要只放一兩個圓錐）」。字數依模型上下文大小縮放（300～1600 字），只加在這一次請求，不進對話記錄。
- **離線模式或使用者關閉**（`advancedSettings.subjectResearchOff`）：整段略過；網路或模型不通：回空字串，編輯照原本進行（查不到不能讓編輯壞掉）。
- 為什麼不是「讓模型自己決定要不要查」：弱模型根本不知道自己不知道；由程式固定問一次、答案驗證，弱模型也走得動。代價是多一次很小的模型呼叫（約 300 字）。

## 驗證
純函式 12 項（提示、答案驗證、維基摘要挑選、部位整理與夾限、參考文字預算、快取淘汰）。桌面版實測見提交紀錄。

## 2D 怎麼用（SVG 編輯器與平常的畫圖，同一條路）
- `/edit-svg` 後面接一句話、編輯器裡說話：`_subjResolve('edit-svg', …)` 找到素材 → **由程式先把素材放進畫面**（`add_object` 加在模型的動作前面），模型只用名字安排位置與大小（參考文字裡有「不要再重畫一個」）；備註欄附素材來源。
- 平常叫 AI 畫圖（`generate_image` 形狀圖路線，步驟 2c）：找到素材時，**只是要那個東西**（`isJustSubject`：去掉名字與客套字後不超過 3 個字）就直接交付；還有別的要求就跟編輯器一樣：素材放進空白畫布，請模型用 `editPrompt` 安排，再合成交付。擴散路線（照片、插畫）不查。
- 沒找到 SVG：描述（維基百科）→ 沒有描述就找一張圖給視覺模型 → 都沒有才用模型自己的印象（參考文字標明）。
- **下載與儲存（使用者決定，2026-10-26）**：預設直接下載、不問；只放記憶體與 IndexedDB（`FloatingAssistantSubjects`，200 個上限、最舊先淘汰），**不存成檔案**（不進檔案快取、不出下載卡片；畫圖的成品本身另當別論）。
- 驗證：純函式 22 項；測試版實測——維基共享資源找到 CC0 的小提琴 SVG、清理後 406×424、編輯器加進畫面並套用模型的移動縮放（rejected 0）、平常畫圖直接交付（route=asset）；找不到的東西退回描述。

## 3D 怎麼運作（`subject_3d.js`，`FaSubject3d`，測試 `subject_3d.test.js` 22 項）
- **GitHub OBJ**：`repoSearchUrl`（`<英文名> obj in:name,description,topics`，不用金鑰，未登入每分鐘 10 次搜尋）→ `pickRepos`（授權寬鬆的先、再來是**沒標示授權的公開專案**——使用者決定「公開的就可以」；GPL 與太大的專案不收；專案名稱／描述／主題要含這個東西的名字）→ `treeUrl`/`pickObj`（檔案樹裡 1.5KB～6MB 的 `.obj`，路徑要含名字；編譯產生的 `Debug/main.obj` 這類二進位檔因為名字對不上、也解析不出面而被擋掉）→ `parseObj`（v、vt、f 各種寫法、負索引、多邊形三角化；超過 1.2 萬面用頂點叢集縮減）→ `fit`（x、z 置中、底面貼地、縮到 `cm`——問模型時順便估的一般大小；Z 軸向上的模型自動轉正）→ `toObject`（`mesh:'polygon'`，跟內建模型庫、匯入 OBJ 同一種）。放進場景的是**程式先加的 `add_object`**，模型之後用名字安排位置；備註欄附出處與授權（「未標示授權，僅供個人使用」）。
- **找圖 → 3D**：圖片來源 `_subjImageCandidates`：維基共享資源與 Openverse（免金鑰）；`advancedSettings.imgurClientId` 有填就加 imgur；`googleSearchKey`＋`googleSearchCx` 有填就加 Google 圖片（兩者都要使用者自己的金鑰，沒填就略過）。每張圖：縮到長邊 360 → `bgMask`（用圖的邊緣估背景色，從邊緣填色；前景比例要在 10%～85%，否則換下一張）→ `_subjDecompose`（Pyodide，全程記憶體，輸出讀回字串、用完清掉）→ `parseScene` → `cutBackground`（三角形中心落在背景就丟）→ `fit(…, {depthRatio:0.4})`（浮雕很薄，前後深度至少是寬高較小邊的 40%）→ 貼圖物件（兩面都畫）。最多試 4 張。
- **實測（測試版，真網路）**：「bunny」→ GitHub `KunKunaa/Bunny` 的 `Bunny/bunny.obj`（5001 面、縮到 30 公分、編輯器接受）；「apple」→ 維基共享資源 `Red Apple`（CC BY 2.0，前景 55%、8311 面、貼圖 27KB、約 14 秒含 Pyodide 載入）；完整對話流程：說「在右邊放一隻兔子」，程式先把 OBJ 放進場景。
- **已知限制**：GitHub 上的 OBJ 命中率看東西而定（「violin」搜不到專案；多數專案沒有授權標示）；圖片 3D 化只有單面浮雕（背面是同一張圖），背景複雜或東西跟背景同色就換下一張或放棄；未登入的 GitHub 搜尋有次數限制，用完會直接往下一階走。

## 用瀏覽器控制搜尋（2026-10-26，使用者：Google、GitHub 也可以用瀏覽器控制）
設定「瀏覽器控制」開著、擴充功能連上時（`_subjBcReady`：`browserControlEnabled` 加 `ping`，30 秒快取），搜尋改走使用者的 Chrome；沒開、沒連上、沒登入都不是錯誤，往下一個來源。每次搜尋開一個背景分頁（`tab_create`，不搶畫面）→ 輪詢在頁面裡跑的抽取腳本（`tab_eval`，回 JSON 字串，`ready:true` 才算頁面好了，最多 22 秒）→ `tab_close`。
- **GitHub 程式碼搜尋**（`https://github.com/search?type=code&q=<英文名> extension:obj`）：程式碼搜尋要登入，所以用使用者登入的 Chrome。抽取 `a[href*="/blob/"]` 與頁面內嵌 JSON（`react-app.embeddedData`）的結果 → `parseCodeHits`（.obj、路徑或專案名要含名字、去重）→ 用 `raw.githubusercontent.com` 抓檔。**沒登入**時頁面是「Sign in to search code」，抽取腳本回 `login:true`：狀態列提示「要先在 Chrome 登入 GitHub」，這次退回公開專案搜尋（API）。
- **Google 圖片**（`tbm=isch`，查詢字加 `png`）：頁面的縮圖直接內嵌成 `data:image/jpeg`（約 225 像素，有描述文字），抽取後直接拿來做 3D，不用另外下載。
- **imgur**（`imgur.com/search?q=`）：縮圖是 `<id>b.jpg`，`imgurLarge` 改成 `<id>l.jpg`（640 像素）。
- 圖片候選的順序：Google → 維基共享資源／Openverse → imgur；沒有瀏覽器控制才用使用者自己填的金鑰（`imgurClientId`、`googleSearchKey`＋`googleSearchCx`）。
- **驗證**：三個抽取腳本都在真實頁面上跑過（瀏覽器窗格：imgur 16 張、Google 16 張縮圖、GitHub 沒登入回 `login:true`）；整條流程用假的擴充功能（回傳跟真實頁面一樣形狀的資料）在測試版跑過：登入時找到 `KunKunaa/Bunny` 的 OBJ（`via: browser`）、沒登入時有提示並退回 API。**沒驗證**：真的連上擴充功能、GitHub 程式碼搜尋登入後的頁面結構（抽取同時看連結與內嵌 JSON，但沒看過登入後的實際內容）。

## 2026-10-30 補充：找圖那一階改走圖片轉 3D
`_subjImage3d` 取得圖片並通過去背檢查後，先呼叫 `_i3dSubjectSolid`（`edit3d_host.js`：深度模型→每個物件封閉→原圖貼圖），結果標 `solid:true`，放進場景時不再放大厚度（`depthRatio` 只給舊浮雕用）；沒有深度模型或做不出封閉物件時才用下面的舊做法，結果標 `relief:true`，說明文字寫「退回舊的浮雕做法」。限制：背面是依輪廓推測的；新舊品質並排比較沒做；真實 App 沒驗證。設計見 `DESIGN.image-to-3d.md`。
