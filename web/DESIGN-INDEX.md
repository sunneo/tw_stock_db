# floating-assistant.js — 文件地圖 / 索引 (DESIGN-INDEX.md)

> `floating-assistant.js` 單一檔案已經超過 11000 行，逐行讀過一遍再開始改動的成本
> 越來越高。這份文件不是架構設計文件（沒有一份獨立的 DESIGN.md 描述這個檔案——
> 設計脈絡分散在檔案內部大量的行內註解裡，見下方「行內註解的既有慣例」），單純是
> 一份**索引**：告訴你「要找某個功能，該搜尋什麼關鍵字、去哪個區塊看」，减少每次
> 都要整份重讀或大範圍 grep 摸索的成本。

**行號會隨編輯漂移，不保證準確**——下面列的行號是寫這份索引當下（commit
`fbdd5039`，2026-09-05）的快照，僅供「大概在這一帶」的參考。真正可靠的定位方式是
用檔案名／函式名／常數名/工具名做 grep，這份索引存在的目的就是先告訴你該 grep
什麼關鍵字，而不是取代 grep。

## 怎麼用這份索引

1. 先看下面「功能區塊地圖（依開發階段）」找到你要改的功能屬於哪個階段。
2. 用該階段列出的關鍵字（通常是主要方法名或常數名）在檔案裡搜尋，一次通常會連帶
   看到同一個功能的其他相關程式碼（既有的行內註解習慣會互相 cross-reference）。
3. 這個檔案裡幾乎每一段客製邏輯開頭都有一段以 `tw_stock_db客製:` 開頭的註解，
   說明「為什麼」要這樣做（通常是某次使用者實測回報的問題），不是單純說明
   「這段程式碼做什麼」——先讀這段註解通常比直接讀程式碼本身更快理解意圖。
4. 兩種特別好用的全域搜尋關鍵字：
   - `tw_stock_db客製: 階段N`（N=0~6）——找某個「移植階段」的所有相關程式碼，
     不管它實際散落在檔案的哪些地方（同一階段的功能常常橫跨好幾個不相鄰的方法）。
   - `tw_stock_db客製: 2026-`（後面接日期，例如`2026-09-05`）——找「這個日期
     使用者實測回報的問題」相關的修正，這是 session-by-session 的變更記錄，比
     `git log`更精準（一個commit可能包含好幾個不同日期的修正，因為有些修正是
     累積好幾天才一起commit）。
5. 找不到想找的東西時，也可以直接參考本檔案結尾的「常見任務 → 該看哪裡」對照表。

## 這個檔案跟 `index.html` 的分工

`floating-assistant.js` 是完全獨立、跟 tw_stock_db 業務邏輯無關的通用 AI 聊天
widget（可以被任何 host 頁面掛載使用），`index.html` 負責把 tw_stock_db 專屬的
股票分析工具/指令「掛」進來，兩者只透過幾個公開方法溝通，**絕對不會反過來**（這個
檔案內部絕對不會直接引用任何 tw_stock_db 的股票/資料庫概念）：

| 公開介面 | 方法簽名 | 用途 |
|---|---|---|
| 註冊 AI 工具 | `register_openai_tool(name, description, callback, parametersSchema)` | 加一個 AI 能呼叫的 function，第1439行附近定義 |
| 註冊斜線指令 | `register_slash_command(cmd, hint, desc, handler, argChoices?)` | 加一個`/xxx`本地指令（不經過LLM），第7869行附近定義 |
| 設定 system prompt | `setSystemPrompt(prompt)` | 附加/覆蓋系統提示文字，第1615行附近 |
| 暫停詢問使用者 | `requestUserForm(options)` | 彈出確認/選擇/表單，回傳Promise，見下方「階段6」 |
| 建構子選項 `chipsProvider` | `options.chipsProvider(): string[]` | 對話清空時要顯示的「建議操作」按鈕清單，由host提供內容 |
| 建構子選項 `onTableRendered` | `options.onTableRendered(tableEl)` | AI回覆裡每次渲染出一個`<table>`就呼叫一次，host可以掛股票代號點擊等行為 |
| 建構子選項 `render` | `options.render(container, instance)` | 完全接管UI渲染（目前tw_stock_db沒有用這個，用預設UI） |

`index.html`用`AI_CAPABILITIES`陣列（`registerAiCapabilities(ai)`函式，約
index.html第7911行）批次呼叫`register_openai_tool`掛進tw_stock_db自己的工具
（`diagnose_stock`/`export_document`等，個別工具清單不在這份索引重複列出，直接看
`AI_CAPABILITIES`常數本身），另外用`register_slash_command`個別掛`/collect-volrank`
`/pattern-xlsx``/pattern-xlsx-live`三個業務指令（約index.html第12457行起）。

## 功能區塊地圖（依開發階段，見`tw_stock_db客製: 階段N`註解慣例）

這個檔案是從一個獨立的Redmine plugin（`redmine_ai_chat`）逐階段移植過來的（見
`D:\Downloads\tw_stock_db_repo\web\ref-redmine\plugins\redmine_ai_chat\`底下的
`DESIGN.md`/`PROMPT.md`/`CHANGE.md`——那三份文件記錄的是**跨專案**的移植脈絡跟
「redmine那邊還沒有、這邊已經有」的功能落差，這份索引只管這個檔案*自己*內部怎麼
找程式碼，兩份文件是互補、不重複的關係）。

| 階段 | 功能 | 主要進入點（grep關鍵字） | 主要常數 |
|---|---|---|---|
| 0 | 工具呼叫追蹤/思考過程顯示開關 | `showInternalTrace`（advancedSettings欄位） | — |
| 1 | Sub agent委派框架 | `delegate_to_subagent`、`SUBAGENT_DOMAIN_REGISTRY`、`_runSubAgentTask` | `SUBAGENT_DOMAIN_REGISTRY`（~641行）、`SUBAGENT_DELEGATE_MAX_ROUNDS` |
| 2 | 檔案上傳+sub agent解析 | `parse_uploaded_file`、`_wireAttachmentUpload`、`FileCache`類別 | — |
| 3 | 3D場景viewer（含2026-09-05新增的STL/OBJ/3MF/FBX匯入匯出、Worker offload） | `_mount3DScene`（~5347行起）、`render_3d_scene`、`_convertModelFileToSceneYaml`、`_extractMeshPartsFromObject3D`、`FA_3D_IMPORT_WORKER_SRC` | `SCENE3D_MESH_TYPES`、`SCENE3D_ANIMATION_TYPES`、`SCENE3D_PARTICLE_PRESETS`、`SCENE3D_TOPIC_DOCS`、`SCENE3D_DEFAULT_MAX_IMPORTED_MESH_TRIANGLES` |
| 4 | 通用繪圖工具（SVG） | `render_drawing`、DOMPurify sanitize流程 | — |
| 5 | 互動式viewer（多頁表單/精靈）+ 2026-09-05新增的可互動文件封裝匯出/匯入 | `_mountInteractiveViewer`（~6319行起）、`render_interactive_viewer`、`KVStore`類別、`_buildViewerPackageYaml`、`_importViewerPackageText` | `VIEWER_COMPONENT_TYPES`、`VIEWER_INPUT_TYPES`、`VIEWER_ACTION_KINDS`、`VIEWER_PACKAGE_KIND` |
| 6 | 暫停並詢問使用者 | `requestUserForm`（~3046行） | — |

其餘不屬於這個「六階段移植」框架、但同樣是這個檔案主要功能的部分：

| 功能 | 主要進入點 | 備註 |
|---|---|---|
| 對話核心迴圈（function calling） | `_loopFetch`（文字式`[CALL:...]`協定）、`_loopFetchNative`（原生tools協定）、`executeChat` | `_shouldUseNativeToolCalls`/`_ensureNativeToolSupportProbed`決定走哪一條 |
| 工具註冊表 | `register_openai_tool`（~1439行）、`this.tools` | 見上方公開介面表 |
| Graph RAG記憶 | `IndexedDBRAGSystem`類別（~149行）、`rag_store_graph_node`/`rag_query_graph`/`rag_delete`工具 | TF-IDF+依賴鏈解析 |
| AI自製函式（FromAI） | `add_ai_function`/`call_ai_function`/`delete_ai_function`、`_openAiFnModal`/`_openAiFnEditor` | |
| 自訂工具（Skill） | `advancedSettings.customTools`、`_openToolEditor`、`_exportSkillZip`/`_importSkillZip` | |
| Advance設定面板（分頁式） | `_openAdvancedModal`/`_renderAdvancedSettings`、`.ai-advanced-cat`/`.ai-advanced-pane`（見下方「近期重大修改」） | 2026-09-05改成分頁 |
| PDF/PPTX/Markdown匯出 | `_faMarkdownToPptxBlob`/`_faMarkdownToPdfBlob`、`_appendCardExportButton`/`_appendMarkdownExportButton` | vendor pdfmake/pptxgenjs/JSZip |
| 模型節點設定+benchmark | `/benchmark-model`指令、`_handleBenchmarkModelCommand`、`_benchmarkRunTurn` | 見下方常見任務對照表 |
| 對話自動壓縮(Prune) | `pruneContext()`、`_turnPruneCount`（同一輪壓縮重試次數上限） | 訊息數或估計token數任一超標觸發，見約7137行「核心對話與AI自動壓縮」區塊 |
| 檔案快取（附件/匯出檔） | `FileCache`類別（~386行）、`this.fileCache` | LRU淘汰，見`fileCacheLimitMB`設定 |
| 訊息渲染主流程 | `_renderMessageHistory`、`_renderSingleMessage`（單則訊息渲染，兩者都在同一個大區塊） | `_markSupersededVisualDrafts`處理「同輪重做只留最後結果」 |
| 主視窗UI建構+事件綁定 | `_initUI()`（建HTML骨架）、`_initEventListeners()`（~11006行，所有`document.getElementById('ai-*').onclick`集中在這裡） | 見下方「主要DOM id」 |

## 近期重大修改（2026-09-05這次工作階段新增，尚未整理進上面的階段分類）

- **3D模型匯入的Web Worker offload**：`_ensureModelImportWorker`/
  `_convertModelPartsViaWorker`/`FA_3D_IMPORT_WORKER_SRC`——STL/OBJ/3MF/FBX的
  `.parse()`+網格抽取搬進背景執行緒，避免卡住主執行緒；`isWorkerInfraFailure`
  旗標區分「worker基礎設施失敗要退回主執行緒」跟「worker正常執行、只是業務邏輯
  拒絕（例如超過三角形上限）不該重跑」。`_extractMeshPartsFromObject3D`是退回
  主執行緒時才會用到的版本，跟worker內嵌的複製版本要保持邏輯一致（見兩處程式碼
  彼此的註解）。
- **3D模型匯入進度顯示**：`_3dImportStageLabel`（階段名稱→中文文字）、
  `_displayScene3DImportProgress`訊息旗標（`_renderSingleMessage`裡的獨立分支，
  要放在`_displayScene3DYaml`判斷之前）、`_setResponseIndicatorLabel`（AI tool
  路徑更新「AI回應中」狀態列文字用）。
- **附件上傳進度chip**：`_readFileWithProgress`（File.slice分塊讀取，真實位元組
  進度）、`_pendingAttachments`每筆多了`status`(`uploading`|`done`)/`progress`/
  `cancelled`/`promise`欄位、`_renderPendingAttachments`（進度條視覺）、
  `_getLastCompletedPendingAttachment`（指令類功能只能挑已完成的附件）、
  `_submitChatInput`送出前會等未完成的上傳（見函式內的`stillUploading`）。
- **互動viewer可互動文件封裝**：`VIEWER_PACKAGE_KIND`、`_buildViewerPackageYaml`/
  `_importViewerPackageText`、`/import-viewer-attachment`指令、
  `import_interactive_viewer_attachment`工具——**這個封裝格式是跨系統交換格式**，
  跟`redmine_ai_chat`那邊要完全相容，欄位名稱不能自行更動，詳見上面提到的
  ref-redmine資料夾裡CHANGE.md第14項。
- **匯入三角形數量上限可調整**：`_getMaxImportedMeshTriangles`、
  `advancedSettings.maxImportedMeshTriangles`（0=不限制），UI在Advance設定面板
  「效能與限制」分頁。
- **Advance設定面板改分頁式**：`.ai-advanced-sidebar`/`.ai-advanced-cat`/
  `.ai-advanced-content`/`.ai-advanced-pane`（CSS在`_ensureAdvancedStyles`），
  分頁切換邏輯在`_initEventListeners`裡找`.ai-advanced-cat`的click監聽。

## 內建AI工具完整清單（`register_openai_tool`，共22個，行號為commit `fbdd5039`快照）

| 工具名 | 約略行號 | 一句話用途 |
|---|---|---|
| `list_ai_functions` | 2031 | 列出AI自製函式(FromAI) |
| `call_ai_function` | 2040 | 呼叫一個AI自製函式 |
| `add_ai_function` | 2056 | 新增/覆蓋一個AI自製函式 |
| `delete_ai_function` | 2075 | 刪除一個AI自製函式 |
| `rag_store_graph_node` | 2095 | 寫入一筆長期記憶(RAG graph節點) |
| `rag_query_graph` | 2117 | 語意查詢RAG記憶 |
| `rag_chunk_document` | 2145 | 大文件語意分段後個別存進RAG |
| `rag_delete` | 2232 | 刪除RAG節點 |
| `get_tool_details` | 2266 | 查詢工具的完整參數schema(兩層式工具清單機制) |
| `delegate_to_subagent` | 2292 | 委派任務給限定工具集的巢狀subagent |
| `list_uploaded_files` | 2315 | 列出使用者上傳過的檔案(file_id清單) |
| `parse_uploaded_file` | 2330 | 解析上傳檔案內容(csv/xlsx/docx/zip等) |
| `render_3d_scene` | 2355 | 渲染純宣告式YAML描述的3D場景 |
| `get_3d_scene_topic` | 2374 | 查詢3D場景進階主題(texture/particles/polygon/defs) |
| `get_3d_scene_yaml` | 2387 | 取得目前3D場景的真實YAML(修改前必查) |
| `import_3d_model_attachment` | 2403 | 匯入STL/OBJ/3MF/FBX轉成3D場景 |
| `render_drawing` | 2438 | 渲染通用SVG繪圖 |
| `render_interactive_viewer` | 2464 | 渲染多頁互動表單/精靈 |
| `get_interactive_viewer_yaml` | 2483 | 取得目前互動viewer的真實YAML |
| `get_viewer_state` | 2492 | 查詢互動viewer的填寫狀態 |
| `set_viewer_state` | 2505 | 覆寫互動viewer的填寫狀態 |
| `import_interactive_viewer_attachment` | 2523 | 匯入「可互動文件」封裝檔 |

（tw_stock_db自己的業務工具，例如`diagnose_stock`/`export_document`，不在這份
清單——那些是`index.html`透過`AI_CAPABILITIES`陣列掛進來的，見上面「這個檔案跟
index.html的分工」。）

## 內建斜線指令完整清單（`register_slash_command`，共4個）

| 指令 | 約略行號 | 用途 |
|---|---|---|
| `/benchmark-model` | 1509 | 對指定模型跑三項基準測試評分 |
| `/suggest` | 1520 | 重新顯示建議操作按鈕 |
| `/view-3d-attachment` | 1529 | 本地開啟附加的3D場景/模型檔案（不經過AI） |
| `/import-viewer-attachment` | 1537 | 本地匯入「可互動文件」封裝檔（不經過AI） |

（`/collect-volrank`/`/pattern-xlsx`/`/pattern-xlsx-live`是tw_stock_db業務指令，
`index.html`裡註冊，不在這份清單。）

## 主要頂層常數/類別速查

| 名稱 | 約略行號 | 說明 |
|---|---|---|
| `SimpleEmbeddingEngine` | 90 | RAG用的簡易文字embedding |
| `IndexedDBRAGSystem` | 149 | RAG記憶的IndexedDB儲存 |
| `FileCache` | 386 | 附件/匯出檔的IndexedDB快取(LRU淘汰) |
| `KVStore` | 504 | 互動viewer填寫狀態的結構化KV儲存 |
| `SUBAGENT_DOMAIN_REGISTRY` | 641 | 每個委派領域的固定工具集+system prompt |
| `SCENE3D_MESH_TYPES`/`SCENE3D_ANIMATION_TYPES`/`SCENE3D_PARTICLE_PRESETS` | 708-727 | 3D場景格式的封閉字彙表 |
| `SCENE3D_TOPIC_DOCS` | 825 | `get_3d_scene_topic`工具的內容來源 |
| `VIEWER_COMPONENT_TYPES`/`VIEWER_INPUT_TYPES`/`VIEWER_ACTION_KINDS` | 731-733 | 互動viewer的封閉元件字彙表 |
| `VIEWER_PACKAGE_KIND` | 743 | 可互動文件封裝格式的kind判別值 |
| `FA_3D_IMPORT_WORKER_SRC` | 759 | 3D模型解析worker的完整原始碼字串 |
| `FA_ASSET_URLS` | 921 | 所有vendor第三方函式庫的CDN網址 |
| `FloatingAssistant` | 1418 | 主class，其餘幾乎所有方法都是它的成員 |

## 主要DOM id（`_initEventListeners`集中綁定，約11006行起）

視窗骨架：`ai-floating-btn`、`ai-floating-window`、`ai-window-header`、
`ai-chat-body`、`ai-input-text`、`ai-send-btn`、`ai-attach-btn`/`ai-attach-input`/
`ai-pending-attachments`、`ai-response-indicator`、`ai-stop-response-btn`、
`ai-status-log`。

快速設定面板：`ai-config-panel`、`ai-btn-config`、`ai-input-key`/`ai-url`/
`ai-model-name`、`ai-hermes-evolve-chk`、`ai-slash-menu-chk`、`ai-show-trace-chk`。

Advance設定彈窗：`ai-advanced-modal`、`ai-advanced-sidebar`/`.ai-advanced-cat`/
`.ai-advanced-pane`（分頁）、`ai-rules-input`、`ai-custom-functions-input`、
`ai-custom-tool-list`、`ai-perf-file-cache-mb`/`ai-perf-batch-concurrency`/
`ai-perf-max-mesh-triangles`（效能與限制分頁）、`ai-settings-export-btn`/
`ai-settings-import-input`。

其他彈窗：`ai-tool-editor-modal`（Skill編輯）、`ai-fn-modal`/`ai-fn-editor-modal`
（AI自製函式管理）、`ai-rag-modal`/`ai-rag-editor-modal`（RAG記憶管理）。

## 常見任務 → 該看哪裡

- **新增一個3D場景YAML欄位**：`_build3DGeometryForNode`/`_build3DMaterial`（幾何/
  材質建構）、`_validate3DSceneYaml`（伺服器端等效驗證，其實是client端但同精神）、
  `render_3d_scene`的description字串（AI看到的schema說明）、如果是進階主題還要更新
  `SCENE3D_TOPIC_DOCS`。改完記得檢查`FA_3D_IMPORT_WORKER_SRC`裡有沒有需要同步修改
  的抽取邏輯（通常新增材質/幾何欄位不需要，只有網格抽取邏輯本身變動才需要）。
- **新增一個互動viewer元件類型**：`VIEWER_COMPONENT_TYPES`（加進白名單）、
  `_validateViewerComponentShape`（驗證規則）、`_renderViewerComponent`（實際渲染）、
  `render_interactive_viewer`的description字串。
- **新增一個advancedSettings欄位**：`_createDefaultAdvancedSettings`（預設值）、
  `_normalizeAdvancedSettings`（驗證/夾範圍）、如果要有UI輸入框，加進Advance設定
  面板對應分頁的HTML＋`_renderAdvancedSettings`（載入現值）＋
  `_initEventListeners`裡的input監聽器（存值）。
- **新增一個AI工具**：`register_openai_tool`（跟著既有22個抄同樣的呼叫模式）、如果
  屬於某個委派領域，記得也加進`SUBAGENT_DOMAIN_REGISTRY`對應domain的`toolNames`。
- **新增一個斜線指令**：`register_slash_command`（建構子裡，跟著既有4個抄）、
  如果是tw_stock_db業務邏輯指令，應該加在`index.html`而不是這個檔案（見上面
  「這個檔案跟index.html的分工」）。
- **改動下載/匯出行為**：一律用`generateAndDeliverFile`（存進FileCache→產生真正的
  使用者點擊下載連結），**不要**用「動態`<a>`+合成`click()`」——這個模式在部分
  行動裝置瀏覽器上，`click()`前只要經過一次`await`就可能被判定不是使用者手勢觸發
  而悄悄擋下，沒有任何錯誤訊息（2026-09-05真實踩過的坑，見`_appendCardSourceButtons`
  的下載按鈕實作註解）。
- **3D場景/繪圖/互動viewer要新增卡片按鈕**：`_appendCardExportButton`（📤匯出，
  支援`extraFormats`參數擴充額外格式）、`_appendCardSourceButtons`（📝檢視/📥下載
  原始碼），兩個都是共用helper，三種卡片型態（scene3d/drawing/viewer）都呼叫同一份。
- **想知道某個功能在redmine_ai_chat那邊是不是也有、或該不該同步移植過去**：先看
  `D:\Downloads\tw_stock_db_repo\web\ref-redmine\plugins\redmine_ai_chat\CHANGE.md`
  （目前floating-assistant.js有、redmine還沒有的功能清單）跟同資料夾的`DESIGN.md`
  （redmine那邊已經做過的功能架構文件）。
