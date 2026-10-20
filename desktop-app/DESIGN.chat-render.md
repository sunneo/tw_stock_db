# 對話區的增量重繪

## 問題（2026-10-20 使用者回報）
`_renderMessageHistory()` 每次都 `chatBody.innerHTML = ''` 整個重畫。調整設定、發出新需求、進來一段新的 transcript、系統提示重整……都會走到它，結果：
捲動條亂跳；上面已經掛好的東西（簡報播放器、viewer、重新配音的進度）全被重建而歸零——「全部投影片重新配音」跑到一半就被打斷。

## 做法
每則訊息畫在自己的包裝節點 `div.fa-msg-wrap` 裡（`_renderSingleMessage` 不知道它：它還是 `(msg, container, palette)`），並記在 `this._chatNodeCache`（WeakMap：訊息 → `{sig, el}`）。
重繪時：
1. 先排出「計畫」：被封存且不摺疊的訊息各一個、摺疊的封存區塊整個一個、目前的訊息各一個。
2. 每個項目算簽章（`_chatMsgSig`）；簽章沒變且節點還在 → **原封不動留著**（連 DOM 都不碰）。
3. 不再需要的節點（訊息被改掉、被壓縮移走、不是本函式管的雜物）拿掉；其他的依序放好——只有順序不對的才移動，新節點插在前一個節點後面，再把內容畫進去（先放進畫面再畫，元件才量得到寬度）。
4. 有東西真的變了才動捲動位置（原本在底部就跟到新的底部）；什麼都沒變就完全不碰。

簽章 `_chatMsgSig(msg)`：訊息自己所有的屬性（含不可列舉的 `_display*`、`_card`、`_progressWidget`…），值遞迴最多 3 層；字串用雜湊（超過 20000 字只取頭尾與 7 個取樣點）；函式與 DOM 節點只記種類；`_scene3DHandle`／`_anim2DHandle` 是渲染的結果、不算輸入；畫面上不顯示的 system 訊息一律 `hidden-system`（系統提示重整不重畫）。
全域的畫面設定（主題色、`showInternalTrace`、`slashCommandMenuEnabled`、marked／DOMPurify 是否載入）變了才整批重畫。

## 效果（真實 Electron，`scripts/eval/chat-incremental.eval.js`）
- 什麼都沒變／與畫面無關的設定變動／新訊息：舊節點身分不變，掛在裡面的元件與計時器照跑，捲動位置不變；簡報播放器只掛載一次。
- 改一則訊息：只有那一則重畫；刪一則：其他不動；顯示內部過程切換：整批重畫；還在底部時新訊息：跟到新的底部。
- 600 則、123 萬字：整批重畫約 300 ms；沒變的重畫約 13 ms；附加一則約 12 ms。

## 限制與注意
- 簽章看不到的變化不會重畫：超長字串（> 20000 字）只改了中間一段而長度不變；巢狀超過 3 層的屬性；訊息之外的狀態（`_renderSingleMessage` 目前只讀 msg、主題、`showInternalTrace`、`slashCommandMenuEnabled`——以後它若多讀別的全域狀態，要加進 `envSig`）。要強制重畫某則訊息：`this._chatNodeCache.delete(msg)`。
- 串流中的氣泡（`ctx.streamDiv`）不是本函式管的，重繪時照舊會被移除（跟以前一樣）。
- 訊息的包裝節點是一個沒有樣式的區塊 `div`，版面與以前相同（外距照樣合併）。
