# Floating AI Assitant(Chrome Extension)

讓 Floating AI Assistant（網頁版或桌面版）控制 Chrome：建立分頁群組與分頁、捲動、截圖、
滑鼠與鍵盤輸入、讀取頁面文字。

## 安裝（Chrome / Edge / Brave 等 Chromium 瀏覽器）

1. 解壓縮下載的 zip，得到一個資料夾（裡面有 `manifest.json`）。
2. 網址列輸入 `chrome://extensions`，右上角打開「開發人員模式」。
3. 按「載入未封裝項目」，選剛剛解壓縮的資料夾。
4. （建議）按工具列的拼圖圖示，把「Floating AI Assitant」釘選起來。

## 連線

- **網頁版**：開啟 Floating AI Assistant 的網頁，點擴充功能圖示，按「允許目前網站」。
- **桌面版**：在桌面版「設定 → 瀏覽器控制」分頁複製配對碼，貼到擴充功能彈出視窗的「配對碼」並儲存。

到設定的「瀏覽器控制」分頁按「測試連線」確認。

## 安全

- 只能操作**助理自己建立的分頁**，不能讀取或控制你原本開著的其他分頁。
- 網頁版只有你「允許」的網站可以下指令；桌面版需要配對碼。
- 滑鼠/鍵盤/截圖使用 Chrome 的偵錯功能，操作期間瀏覽器會顯示「正在偵錯此瀏覽器」提示列，這是正常的。
- 只接受 http(s) 網址。

## 1.6.0：擷取下載（capture）

自動化期間「下載到什麼」不可控（另存新檔對話框卡住、檔案落在哪不知道）。`download_behavior: "capture"` 把下載攔下來、**不讓 Chrome 存檔**，位元組留在擴充功能記憶體裡，由助理一段一段拉走，邊收邊驗證，收完再決定寫到哪：

- 網路下載（GET 連結、POST 表單都行）：用 Fetch 網域在回應階段攔截（`Content-Disposition: attachment`，或頁面導覽拿到 zip／octet-stream 這類二進位檔），讀出回應本體後讓請求中止，Chrome 完全不知道有下載。
- `blob:`／`data:` 下載：收到下載事件後在頁面裡把位元組讀出來（頁面稍後撤銷 blob 也沒關係）。
- `wait_download` 回傳 `{captured, capture_id, filename, mime, url, source, size_bytes, crc32}`（不含位元組）；助理用 `read_capture{id, offset, length}` 每段最多 768 KB 往下拉（回傳 `b64`、`eof`、`size`、`crc32`），收完用 `release_capture{id}` 釋放。`list_captures` 列出目前保存的擷取。
- 上限：單檔 200 MB、全部合計 400 MB、保存 20 分鐘；超過會回報錯誤，不會悄悄丟掉。擷取不到的下載（不是檔案回應也不是 blob／data）會被擋掉並回報 `denied:true`，不會偷偷落地。
- 驗證：`test/capture-harness.js` 把真正的 `background.js` 放進 vm、除錯器指令接到真的 Chrome，實測 GET、POST、blob、data 四種都逐位元組正確（大小與 crc32 一致），一般頁面連結不會被當成下載。

## 1.5.1：下載行為由助理控制（Page.setDownloadBehavior）

點擊會觸發下載時，Chrome 可能跳「另存新檔」對話框，擴充功能碰不到系統對話框。現在 `click` 可以帶：

- `download_behavior: "allow"` ＋ `download_path`（存檔資料夾的**絕對路徑**）：下載直接存進去，不跳對話框。
- `download_behavior: "deny"`：擋掉下載，只回報「有下載想發生」（`denied:true`、檔名、網址）。
- `download_behavior: "default"`：還給 Chrome 自己處理。

設定是「這個分頁」的，會一直生效到改成 `default`、分頁關掉或除錯器中斷。也可以先用 `set_download_behavior`（`behavior`、`path`）單獨設定。`wait_download` 在行為由助理控制時改看除錯器事件（`Page.downloadWillBegin`／`downloadProgress`），回傳 `path`（資料夾加建議檔名）、`url`、`size_bytes`；沒設定時照舊看 `chrome.downloads`。

**注意**：`Page.setDownloadBehavior` 在 Chrome 裡已標為過時，行為以實際測試為準；若這個版本不接受會直接回報原因。手動驗證用 `test/download-test.html`（有畫面外的下載按鈕與輸入框，順便驗證 1.5.0 的先捲進畫面）。

## 1.5.0：互動前先捲到元件、補回 selector／文字點擊與下載追蹤

- **互動前先捲進畫面**：`click`（selector 或文字）找到元件後先捲到畫面中央、等版面穩定，再送點擊；`type_text` 有 selector 就先把那個元件捲到畫面中央，沒有 selector 就捲到目前拿到焦點的元件。原因：(1) 中間有錄影時看得到在做什麼；(2) 有的網頁會擋畫面外的事件。
- `mouse` 用的是畫面座標，座標在可視區外時不再默默打空，而是回報「在可視區外」並建議先 `scroll` 或改用 `click`。
- **補回** `click`、`wait_download`、`list_downloads` 與 `downloads` 權限（1.1.0 同步時被覆蓋掉了）：`click` 可用 `selector`／`text`／`index` 找元件，`wait_download:true` 會等這次點擊觸發的下載完成並回傳存檔路徑。升級後請在 `chrome://extensions` 重新載入，並接受新增的「下載」權限。

## 1.4.0：區域截圖

`screenshot` 支援 `region:{x,y,width,height}`（只截指定範圍，像素，左上角 0,0；`full_page` 時用整頁座標）與 `scale`（1~3 放大），回傳 `region_applied`。助理這邊如果遇到沒有這個功能的舊版擴充功能，會在本機把整張截圖裁成指定範圍，所以舊版也能用，只是多傳一張整頁圖。

## 1.3.0：沙盒實驗用的 tab_set_html／tab_eval

程式設計領域做實驗時，可以在助理自己開的全新 about:blank 分頁寫入 HTML 並檢查結果（console、錯誤、DOM、點擊）。這個分頁沒有 opener、origin 是不透明的，跟助理網站與你的其他分頁隔離；一樣只能作用在助理自己建立的分頁，回合結束會自動關閉。

## 1.2.0 的行為（不打擾使用者）

- **不搶焦點**：助理開的分頁不會被切到前景，點擊、打字、按鍵、截圖也不會把分頁或視窗切到前景（改用 Chrome 的「焦點模擬」，頁面以為自己有焦點、實際仍在背景）。只有 `browser_activate_tab` 會真的切過去。
- **用完自動關閉**：助理開的分頁，在它這一輪回答結束時會被自動關閉（助理也被要求做完自己用 `browser_close` 關掉）。以下情況會保留：開分頁時帶 `keep_open`、用 `active` 開的、或之後呼叫過 `browser_activate_tab`（使用者要看的頁面）。
- **群組跟著清掉**：群組裡最後一個分頁關掉時，「AI Controlled」分頁群組跟著消失，擴充功能也會忘記它；分頁不管是被助理、自動清理還是你自己關掉，都會從追蹤名單移除。
- 舊版助理不會送回合結束通知，分頁就不會被自動關閉（其他功能照常）；升級擴充功能請在 `chrome://extensions` 按「重新載入」。
