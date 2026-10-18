# 統一的 LLM 橋接（FaLlm）：線上／離線切換、備援、弱模型外殼、工具呼叫走橋接

> 範圍：2026-10-18 做出來的橋接。程式在 `renderer/src/floating-assistant.js` 的 `const FaLlm`（在 `class FloatingAssistant` 前面）。
> 相關：[反思總覽](DESIGN.reflection.md)、[離線食譜](DESIGN.offline-recipes.md)、[離線計畫](DESIGN.offline-plans.md)、[CoLU](DESIGN.colu.md)、[技能→食譜與設計出來的工具](DESIGN.skill-recipes.md)。

---

## 一、為什麼要有橋接

原本「連到 AI 模型」散在十幾個呼叫點（對話、子任務、摘要、反思、向量化、語音…），離線開關只管一般對話，斜線指令、技能包、子任務照樣偷偷連線；線上全部失敗的備援也只在主對話有。

要求（使用者原話整理）：
1. 離線開著，**所有內容都離線**，不論哪個斜線指令，不能偷偷來；而且不是「擋下」，是**改走離線模型**。
2. Python、JavaScript、bash 的「問 AI」也要有一樣的效果。
3. 線上模型全部失敗，要能退到離線模型試著解決。
4. 離線模型本身很弱，一定要走食譜、CoLU、UML design 這些補足的流程；線上的弱模型也要能用（弱不弱看模型體檢，不是新寫一套）。
5. 橋接口是 OpenAI 相容，**工具呼叫也是橋接的**。
6. 所有橋接的紀錄要在**同一份 transcript**，不要一堆卡片。

## 二、結構

```
所有 AI 呼叫點（18 處）──→ FaLlm.fetch(url, init)
Python／JS／bash（走同一批呼叫點）        │
window.fetch 後備（抓漏網的）─────────────┘
                                         ▼
   kindOf(url)：chat（/chat/completions、/v1/messages）／embed（/embeddings）／tts（/edge-tts）
        │
        ├─ chat ＋ 離線開著 ───────→ offlineResponse（離線流程）
        ├─ chat ＋ 線上 ───→ ① weakShell（弱模型外殼，程式先試）→ ② 照常連線
        │                      └─ 連續失敗次數 ≥ 模型列數量 → offlineResponse（備援）
        └─ embed／tts ＋ 離線 ─→ 回報失敗（呼叫端走自己的本機做法：TF-IDF、本地 Kokoro）
```

- 回傳一律是 **OpenAI 格式**的 `Response`（含串流：包成 SSE 的單一 chunk＋`[DONE]`），呼叫端不用改。
- 「連續失敗」＝ 2 分鐘內連續失敗的次數（網路錯誤、408／429／401／403／5xx）；達到 `_getModelRows().length`（每個模型列都試過）才交給離線，不會搶在呼叫端自己的 cascade 前面。`advancedSettings.offlineLlmFallback === false` 關掉備援。
- 看圖的請求（messages 裡有 `image_url`）**不走文字流程**：回報失敗，讓呼叫端走它自己的離線圖像備援（Florence-2 的 `image_to_text`）。遠端實測踩過：視覺呼叫被當文字題，回了離線訓練器的訊息當成「圖中文字」。
- 看得到的紀錄：`FaLlm.blocked`（離線下沒辦法處理的請求，最多 200 筆）、聊天裡「🔌 離線模式…」提示（同一種 10 分鐘只說一次）。

## 三、離線流程（`offlineResponse`）

跟使用者在離線模式下直接問它是同一條路，所以離線怎麼補強，橋接就自動跟著強。

| 請求長相 | 做什麼 |
|---|---|
| 最後一則是工具結果（`role: tool`） | 程式把結果整理成可讀文字（`_otPretty`）→ 離線文字模型只負責措辭，**措辭要過抽取式檢查**（只能重述結果裡有的）→ 沒過就用程式整理的結果 |
| 帶 `tools` | ① **技能食譜**（`_skillRecipeRun`，見 [DESIGN.skill-recipes.md](DESIGN.skill-recipes.md)）→ ② 離線訓練器＋**食譜**（路由→欄位，`planOnly`）→ 回標準 `tool_calls` → ③ 決定不了就**反思** |
| 其餘 | `_offlineRespond(task, {capture:true})`：規則與快取、計畫、食譜、離線文字模型照跑，結果收集起來當回答；解不出來就**反思** |

**工具呼叫是橋接的**：食譜／技能食譜決定「用哪個工具、填什麼」，回 `tool_calls`，**由呼叫端自己執行**（它的副作用確認、紀錄、重試、視覺結果的收集都照常）。不是在橋接裡把事做完再回一段文字——那樣呼叫端看不到工具呼叫，簡報的播放器也收不到。

任務文字取法：子任務重試時會再丟一則「【你只用文字說明了…】」的系統提醒，規劃要用**原本的任務**，不是那則提醒（遠端實測：提醒被當成 `interpret_image` 的 `question`）。

整份文件類的欄位（`yaml`／`json`／`html`／`code`…）如果食譜填成一行字，這個決定作廢（遠端實測：`render_presentation.yaml` 被填成檔名）。離線小模型寫不出整份文件。

## 四、反思：解不出來時，程式依序看（`reflect`）

1. **是不是有現有工具**：`_capSearchTools`（同工具反思的 `cap_reflect` 搜尋，含「設計出來的工具」的說明當別名）；命中的是呼叫端給了的工具 → 用食譜填欄位（只用程式）→ `tool_calls`。
2. **達成路線**：`_routePlan`。設計類（`kind: design`）→ 手動模式問一次、自動模式直接做 → `_umlDesign({model:'offline'})`；其餘類回路線說明（不猜、也不放棄）。
3. 都不行才回失敗，帶具體原因。

**離線模型不能輕易放棄**（使用者要求）：食譜沒決定 → 反思 → 路線／UML design；不是丟一句「做不到」。

## 五、弱模型外殼（`weakShell`）

「弱不弱」靠**模型體檢**（CoLU 按鈕、`/colu-bench`，存在模型列的 `coluProfile.advice`），不重新判斷：`guided`／`auto` ＝ 需要輔助。

- 條件：線上、請求帶 `tools`、這是使用者那一輪的**第一次呼叫**（最後一則是 user）、`body.model` 對得上體檢建議輔助的模型列、`advancedSettings.weakModelShell !== false`。
- 做法：食譜只用**程式的決定**（`noModel: true`，不呼叫任何模型）試一次；工具與欄位都有證據就直接回 `tool_calls`，弱模型不必自己挑；決定不了才照常交給它（系統提示裡已有體檢結論的提示，見 `_coluHint`）。
- 工具結果回來之後不介入。

## 六、同一份 transcript

- 在子任務（`_delegateToSubagentDomain`）裡：橋接的紀錄寫進**該子任務自己的卡片**，每行前面 🌉；`this._activeTranscript` ＝ 進度卡片，`'none'` ＝ 子任務存在但沒開卡片（橋接也不出聲）。
- 不在子任務裡：兩分鐘內的橋接呼叫共用**一張**「🌉 橋接（離線／備援）」卡片，每次呼叫在裡面加一段（`—— 第 N 次橋接 ——`）。
- **簡報與技能包的子任務一律顯示過程卡片**（不看「顯示工具呼叫追蹤」開關）：這是使用者自己下的指令，要跑好幾分鐘，不能靜悄悄做完。（遠端實測：那台沒開開關，5 分鐘什麼都看不到。）其他子任務仍照開關。

## 七、設定與資料

| 項目 | 位置 |
|---|---|
| 離線模式 | `advancedSettings.offlineMode`（Configure 的「離線／線上」開關、`/offline`） |
| 線上全失敗改離線 | `advancedSettings.offlineLlmFallback`（預設開） |
| 弱模型外殼 | `advancedSettings.weakModelShell`（預設開） |
| 模型體檢 | 模型列的 `coluProfile` |
| 橋接紀錄 | `FaLlm.blocked`、進度卡片 |

## 八、測試與驗證

桌面版（Electron 測試用 app）直接呼叫 `FaLlm.fetch`：
- 離線開著，帶工具的請求 → 回 `tool_calls`（`browser_search {"query":…}`），約 0.1 秒（程式決定）。
- 工具結果回來 → 措辭被抽取式檢查退回時改用程式整理的結果。
- 看圖請求 → 回報失敗（讓呼叫端走離線圖像備援）。
- 子任務提醒不當任務；整份文件欄位只有一行字 → 作廢。
- 3 次橋接呼叫只出現 1 張卡片；有子任務的 transcript 時寫進它。
- 弱模型外殼：體檢 `guided` 的模型列，不連線就回了 `tool_calls`；`self` 的不介入。
- 線上 8 個模型列連續失敗後，第 6 次呼叫（先前已累積 3 次）改由離線流程回答。

## 九、限制與下一步

1. 離線文字模型很弱：這台測試機只有 smollm2-360m 能寫回答（qwen3-0.6b 的「寫回答」角色在那份設定裡關著），中文品質差；所以措辭一律要過檢查。
2. 離線食譜的**欄位**要靠模型填數字（例如「1000 元打 8 折」）；模型填不出來就走反思，不會硬填。
3. 串流只包成單一 chunk（沒有逐字）；`tool_calls` 一次只回一個。
4. 離線下沒有處理的連網功能（網頁搜尋、下載、遠端派工）沒有納入離線規則。
5. bash／JavaScript 的「問 AI」沒有逐一測，只確認最後走同一批呼叫點。
6. `uml_design` 在離線 CPU 上很慢，真的設計流程沒有在橋接裡跑完整驗證（測試用假的）。

## 十、決策紀錄

- **統一在一個函式，不在各呼叫點檢查**：漏一處就偷偷連線；`window.fetch` 後備抓漏網的。
- **離線是「切換」不是「擋下」**：使用者明確要求；擋下只留給離線做不到的（向量化、線上語音）。
- **備援等每個模型列都失敗**：不搶在呼叫端自己的 cascade 前面。
- **工具呼叫回 `tool_calls`、由呼叫端執行**：保留呼叫端的確認、紀錄、視覺結果。
- **弱的判斷用體檢**：不另外寫一套；體檢的結論就是「要不要輔助」。
- **程式決定、模型措辭、措辭要過檢查**：離線模型不被信任寫事實。
