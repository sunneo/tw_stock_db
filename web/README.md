# floating-assistant.js

一個**自成一體、零依賴框架**的浮動 AI 聊天助理元件。單一 JS 檔案，貼一個
`<script>` 標籤就能掛進任何網頁，透過公開 API 讓宿主頁面掛上自己的工具
（tool-calling）、系統提示詞、建議操作、主題偵測等——本身完全不認識「股票」
「台股」這類業務概念，`tw_stock_db` 的所有股票相關工具都是從 `index.html`
的 `AI_CAPABILITIES` 透過 `register_openai_tool()` 掛進來的。這個檔案已經
被複製到至少一個其他專案重用過，設計上刻意不寫死任何單一宿主頁面的慣例
（例如主題偵測、markdown 匯出行為都可被 `options` 覆寫）。

想了解「為什麼」這樣設計（省 token 的手法、native/text tool-calling 怎麼
判斷、schema 型別參數是什麼）請看 [DESIGN.md](DESIGN.md)。這份文件是
「怎麼用」。

## 相容的後端

任何 OpenAI-compatible 的 `/chat/completions` 端點，包含：
- NVIDIA NIM（本專案主要使用，含 `nvidia/nemotron-*`、`meta/llama-*`、
  `openai/gpt-oss-*` 等）
- 一般 OpenAI 相容代理（例如透過 Cloudflare Worker 中繼的端點）

不支援原生 `tools`/`tool_calls` 的端點會自動退回文字式 `[CALL: ...]` 慣例
（見 DESIGN.md「Native vs. 文字式工具呼叫偵測」），不需要額外設定。

## 快速開始

```html
<script src="floating-assistant.js?v=xxxxxxxxxx"></script>
<script>
const ai = new FloatingAssistant({
  // 選填：主題偵測（預設讀 <html data-theme>）
  isLightTheme: () => document.documentElement.getAttribute('data-theme') !== 'dark',
  // 選填：每輪對話開頭自動注入的即時上下文（例如「現在時間」「目前選中的項目」）
  contextProvider: () => `現在時間：${new Date().toISOString()}`,
  // 選填：對話一開始/使用者輸入時顯示的建議操作 chip
  chipsProvider: () => [{ label: '查詢範例', text: '幫我查詢範例資料' }],
});

ai.setSystemPrompt('你是一個範例助理，服務對象是正在使用這個網頁的使用者。');

ai.register_openai_tool(
  'get_example_data',
  '查詢範例資料。參數: {"id": "資料id"}',
  async (rawArgs) => {
    const { id } = JSON.parse(rawArgs || '{}');
    return JSON.stringify({ ok: true, id, value: 42 });
  },
  // 選填第4參數：JSON Schema，讓原生tool_calls模式的模型知道參數型別
  // （沒給就退回opaque schema，仍然可用，只是原生模式下較容易被模型
  // 誤序列化成字串，見DESIGN.md「額外參數：parametersSchema」）
  { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false }
);
</script>
```

使用者第一次打開視窗時，會在畫面右下角看到一顆浮動按鈕；點開後是一個標準
聊天視窗，含 API Key / 端點 / 模型名稱設定面板（齒輪圖示）。

## 版本快取

`floating-assistant.js` **沒有 build 流程**，每次修改都要手動更新載入頁面
裡 `<script src="floating-assistant.js?v=...">` 的版本號，否則使用者/瀏覽器
可能繼續跑修好之前的快取版本。專案裡有 `web/tools/bump-asset-version.js`
可以自動處理這一步：

```bash
node web/tools/bump-asset-version.js
```

## 公開 API

### 建構子 / 掛載

```js
new FloatingAssistant(options)
```

或用靜態方法明確指定掛載位置：

```js
FloatingAssistant.mount('#my-container', options); // CSS selector
FloatingAssistant.mount(someElement, options);      // 或直接給 Element
```

沒指定 `mountElement`/`mountSelector` 時，預設掛到 `document.body`，以浮動
按鈕+浮動視窗的形式呈現。

### `options` 物件欄位

| 欄位 | 型別 | 說明 |
|---|---|---|
| `mountElement` / `mountSelector` | Element / string | 掛載位置 |
| `render(container, instance)` | function | 完全自訂渲染，回傳 `{btn, win}`，取代內建的按鈕/視窗 DOM |
| `windowStyle` / `buttonStyle` | object | CSS 覆寫（合併進內建樣式，不是取代） |
| `buttonText` | string | 浮動按鈕文字 |
| `windowPosition` | object | 視窗定位參數 |
| `isLightTheme()` | () => boolean | 覆寫預設的 `<html data-theme>` 主題偵測 |
| `contextProvider()` | () => string | 每輪對話開頭自動插入一則 `[Live Context]` 系統訊息 |
| `chipsProvider()` | () => `{label, text}[]` | 建議操作 chip 的內容來源 |
| `onTableRendered(table)` | (HTMLTableElement) => void | 每次渲染出 markdown 表格時呼叫 |
| `onExportMarkdown(text, fmt)` | function | 提供時取代內建 PPTX/PDF 匯出邏輯 |

### 方法

| 方法 | 說明 |
|---|---|
| `setSystemPrompt(prompt)` | 設定系統提示詞（宿主頁面的業務規則、專有名詞澄清等都寫在這裡） |
| `register_openai_tool(name, description, callback, parametersSchema?)` | 註冊一個 AI 可呼叫的工具。`callback(rawArgs: string) => string \| Promise<string>`，`rawArgs` 是（可能不合法的）JSON字串，回傳值會被塞進 `[TOOL RESULT]`/`tool` 訊息 |
| `register_slash_command(cmd, hint, description, handler)` | 註冊一個 `/xxx` 斜線指令——**不經過模型**，使用者打出來就直接本地執行 |
| `toggleWindow(forceOpen?)` | 開關聊天視窗 |
| `refreshTheme()` | 主題切換信號不是 `<html data-theme>` 時，宿主頁面手動呼叫這個套用新主題 |
| `refreshSuggestionChipsIfUntouched()` | 對話還沒真的開始（只有一則建議操作訊息）時，原地換上最新的 `chipsProvider()` 內容；已經在聊天則完全不動 |
| `generateAndDeliverFile(blob, filename, mimeType)` | 讓工具/宿主頁面把一個 `Blob`（PPTX/PDF/圖片等）交給助理，存進 IndexedDB 檔案快取並在對話裡提供下載連結 |
| `callFromAI(name, args)` | 用跟模型呼叫工具一樣的路徑，手動觸發一個已註冊的工具（除錯/console用） |
| `insertSuggestionChipsMessage()` | 立即插入一則建議操作訊息（`/suggest` 指令背後就是呼叫這個） |

### 內建斜線指令

- `/suggest` — 重新顯示建議操作
- `/benchmark-model <model> [apiUrl] [apiKey]` — 對指定的模型/端點跑一套
  三題測試（速度/單一工具呼叫/完整多步驟流程）並打分，見 DESIGN.md

### 內建工具（不需要宿主頁面另外註冊）

- `list_ai_functions` / `call_ai_function` / `add_ai_function` /
  `delete_ai_function` — 讓 AI 在對話中自己定義並呼叫新的 JS 函式
- `rag_store_graph_node` / `rag_query_graph` / `rag_chunk_document` /
  `rag_delete` — Graph-RAG 長期記憶（見 DESIGN.md）
- `get_tool_details` — 文字式協定模式下，查詢某個工具的完整參數規格

## 資料保存位置

| 內容 | 位置 |
|---|---|
| 對話歷史（含側錄的圖片/檔案參照/推理過程/建議chip） | `localStorage['floating_ai_chat_history']` |
| 下載檔案本體（PPTX/PDF等二進位） | IndexedDB `FileCache`（LRU，預設上限256MB） |
| Graph-RAG 節點 | IndexedDB `FloatingAssistantRAG_*`（LRU，預設上限50MB） |
| API Key / 端點 / 模型名稱 / 進階設定（含自訂工具、取樣參數黑名單） | `localStorage`（多個獨立 key） |
| 原生 tool_calls 支援探測結果快取 | `localStorage['floating_ai_native_tool_support_cache_v2']` |
| 已測試模型的 benchmark 卡片 | `localStorage`（`MODEL_CARDS_KEY`） |

**注意**：所有資料都是單一瀏覽器本機儲存，沒有任何後端同步——換裝置、清
瀏覽器資料都不會保留（`tw_stock_db` 專案另外做了一套雲端設定同步機制，
但那是 `index.html` 業務層的功能，不是這個元件本身的一部分）。

## 外部依賴（皆為延遲載入，不用的功能不用背這個成本）

- `marked` + `DOMPurify` — markdown 渲染（首次渲染訊息時才載入）
- `JSZip` — `.skill` 檔案匯入/匯出（首次按下匯入/匯出按鈕時才注入 CDN script）

## 已知限制

- **自訂工具/AI自建函式沒有沙箱**：`advancedSettings.customTools` 跟
  `add_ai_function` 產生的程式碼都是透過 `new Function(...)` 在頁面本身的
  全域環境（有 `window`/DOM/`fetch`）直接執行，`_validateCustomScript()`
  目前是永遠回傳 `true` 的空殼。只在你信任會操作這個功能的使用者/AI輸出
  的情境下啟用這兩個功能。
- **RAG 記憶是 TF-IDF 關鍵字比對，不是語意向量搜尋**——沒有真正的embedding
  模型，長文/程式碼分片後的檢索精準度取決於用詞重疊程度，不是語意相似度。
- Sub-agent 批次分析（`runBatchSubAgents`）只適合「每一項獨立判斷」的任務
  （例如逐檔篩選/打分），不適合需要跨項目比較的任務——系統提示詞會引導
  模型自己判斷，但如果模型判斷錯誤，這裡沒有額外的防呆。
