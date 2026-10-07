# 互動對話卡片

對話裡的表單：使用者在卡片上勾選、填寫、送出。可以是單張表單、多步驟 wizard，或「依使用者的回應產生下一張卡片」。

## 行為（使用者的要求）

- 送出之後、或頁面重新整理之後，卡片變成**唯讀並保留使用者的回應**（還沒送出就重新整理的卡片標成「已結束（唯讀）」，已填的內容還在，因為等著答案的那個流程已經不在了）。
- **使用者的回應不記錄在對話歷史**：卡片不是 `user` 訊息；卡片訊息本身不送給 LLM（`_sanitizeToolCallPairing` 與各個歷史過濾都跳過 `_card`）；回應只經由 `askCard()` 的回傳值交給呼叫它的程式或工具。回應存在訊息的非可枚舉屬性 `_card` 裡，持久化進 `cardMap`（跟 `_benchmarkReport` 同一套作法），不在 `messages` 的 JSON 裡。
- 切到別的對話時，背景對話等卡片的狀態標成「等你確認」（跟 `requestUserForm` 一樣）。

## 規格（純資料）

```js
{ title, description,
  questions: [...]                       // 單張表單
  // 或 steps: [{ id, title, questions, next: [{ when:{q,eq|in|has|nonEmpty}, goto:'步驟id'|'done' }] }]   // wizard；next 沒寫就依序
}
```

題目：`{ id, type, label, hint, required, default, showIf, media:{text,image,html,height}, … }`

| type | 說明 |
|---|---|
| single / multi | 選項 `{id,label,desc,image,color,extra}`；multi 有 `minSelect`／`maxSelect` |
| dropdown / text / textarea / number / color | 一般欄位（number 有 min／max；text 有 pattern／maxLength） |
| widget | 題目裡的可互動 web widget（`media.html`），用 `window.faCard.answer(值)` 回傳 |
| info | 只顯示（文字／圖片／widget） |

- **選項前**：`image`（https 或 data:image）或 `color`（#rrggbb 色塊）。
- **選項後**：`extra:{kind:'text'|'select', options, required}`——選到那個選項才能填（單選、多選都可以）。
- **題目後**：`after:[{id,kind:'text'|'select',label,options}]` 固定接在選項後面。
- **題目上**：`media.text`、`media.image`、`media.html`（widget）。
- `showIf` 條件顯示；隱藏的題目不驗證、不進結果。

## 安全

- 圖片只接受 https 或 `data:image/(png|jpeg|gif|webp|svg+xml);base64`，色塊只接受 hex。
- widget 在 `<iframe sandbox="allow-scripts">`（沒有 same-origin，碰不到助理頁面、儲存、網路身分）；只接受來源是那個 iframe 自己的 `postMessage`；答案有大小上限。
- 所有送回與還原的答案都經過 `sanitizeAnswer`（不在選項裡的 id、超長字串、不合法的值都被清掉）；還原時規格重新驗證。

## 程式介面

- `FaCard`（`renderer/src/card/card_core.js`，純函式）：`validateSpec`、`createState`、`setAnswer`、`submitStep`、`back`、`cancel`、`restoreState`、`result`、`summaryLines`…
- 宿主：`fa.askCard(spec)` → `{ok, confirmed, status, answers, flat, summary, steps}`；`fa.askCardFlow(first, nextFn)` 依回應產生下一張。
- 工具：`ask_user_card`（AI 放卡片、等回應；需要依回應決定下一張就呼叫兩次）、`uml_guide`（見下）。兩者都在 coding domain，不佔根層級 context。

## 用在 UML 設計引導（`uml_guide`）

程式先讀情境（詞彙表＋動作表，**不呼叫任何模型**），再用卡片問使用者真正需要決定的事：

1. 卡片 1（wizard）：語言（色塊）與套件名稱 → 要實作哪些使用案例（預設全勾，可取消、可補一行一句）→ 架構風格（程式建議的是預設）。
2. 卡片 2（**由卡片 1 的回應產生**）：每個設計關注點一題，平手（程式分不出來）的是必選的單選，其餘是帶建議值的下拉，選項標出對應語言的 library。
3. 確認卡：摘要＋「記住這些選擇」＋產生／回去改／取消。「回去改」會把上一輪的回應當預設值重問。
4. 依答案：取消勾選的使用案例與「只被它們用到的類別」被拿掉、補充的句子經 `addUsecaseFromText` 展開（讀不出的會回報，不編造），再走 `designProject`（不經模型）產生專案、zip、設計檢視器。

弱的 AI 或離線模型只要呼叫 `uml_guide`，其餘由程式與使用者完成。

## 測試

`node renderer/src/card/card_core.test.js`（規格驗證、答案驗證、wizard 分支、還原唯讀、偽造 id）、`node renderer/src/card/uml_guide.test.js`（用卡片狀態機實際填寫整個引導流程）。真實 App 驗證：單選＋文字／下拉、多選、色塊與圖片、showIf、必填擋下、送出唯讀、重新整理保留回應、半途重新整理變已結束、widget 沙盒（`parent` 存取被擋）、`uml_guide` 全流程。
