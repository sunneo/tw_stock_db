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
| 1 | Sub agent委派框架（2026-09-06新增domain階層式註冊+兩層委派自動路由，見下方「近期重大修改」） | `delegate_to_subagent`、`SUBAGENT_DOMAIN_REGISTRY`、`this.domains`、`register_domain`、`_routeTaskToDomains`、`_delegateToSubagentAuto`、`_runSubAgentTask`、`_getRootToolNames` | `SUBAGENT_DOMAIN_REGISTRY`（~641行）、`SUBAGENT_DELEGATE_MAX_ROUNDS` |
| 2 | 檔案上傳+sub agent解析 | `parse_uploaded_file`、`_wireAttachmentUpload`、`FileCache`類別 | — |
| 3 | 3D場景viewer（含2026-09-05新增的STL/OBJ/3MF/FBX匯入匯出、Worker offload、`mesh:"line"`軌跡線、頂層欄位白名單） | `_mount3DScene`（~5347行起）、`render_3d_scene`、`_convertModelFileToSceneYaml`、`_extractMeshPartsFromObject3D`、`FA_3D_IMPORT_WORKER_SRC`、`_build3DLineObject` | `SCENE3D_MESH_TYPES`、`SCENE3D_ANIMATION_TYPES`、`SCENE3D_PARTICLE_PRESETS`、`SCENE3D_TOPIC_DOCS`、`SCENE3D_DEFAULT_MAX_IMPORTED_MESH_TRIANGLES`、`SCENE3D_KNOWN_TOP_LEVEL_KEYS` |
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

## 近期重大修改（2026-09-05/06這次工作階段新增，尚未整理進上面的階段分類）

- **全新子系統：2D多邊形動畫**（跟3D場景/互動viewer完全獨立，不共用場景圖/
  渲染邏輯，只共用`_encodeCanvasFramesToMp4`）——圓/矩形/多邊形/折線/文字/圖片
  六種shape類型（`TWODANIM_SHAPE_TYPES`）+ 六種動畫類型move/rotate/scale/fade/
  orbit/keyframes（`TWODANIM_ANIMATION_TYPES`），純Canvas2D渲染（沒有WebGL/軟體
  光柵化fallback的複雜度，Canvas2D本身不會像WebGL context創建那樣失敗）。核心
  方法：`_validate2DAnimationYaml`/`_validate2DShapeShape`（跟3D場景同一套
  strict生成/lenient播放驗證模式，從第一版就這樣設計，不是事後補）、
  `_build2DShapeGraph`/`_build2DAnimatorForShape`（`animation.parent`階層動畫，
  例如齒輪帶動另一個齒輪——這是直接吸取3D場景那次「衛星繞母星」教訓、從一開始
  就做進去的設計，不是事後才補）、`_draw2DShape`、`_mount2DAnimation`（掛載即時
  播放）、`_export2DAnimationToMp4`。**貼圖/照片支援**：`type:"image"`（獨立圖片
  shape）+ circle/rect/polygon的`fill_image`（用圖片取代純色填滿形狀，polygon是
  用bounding box近似、不是精確UV映射）；跟3D場景的`material.texture_data_url`
  同一個限制/同一個解法——沒有伺服器端附件系統，一律用`data:`開頭的base64或
  http(s)網址直接內嵌在YAML的`src`/`fill_image`欄位，`_load2DImageAsync`/
  `_preload2DShapeImages`負責非同步預先載入（render loop本身是同步的），載入
  失敗/未完成一律優雅退回灰色佔位/純色，不會讓整個動畫壞掉。訊息顯示走
  `_displayAnim2DYaml`旗標，跟`_displayScene3DYaml`等其餘視覺類型並列在
  `_persistChatHistory`/`_loadPersistedChatHistory`（`anim2dMap`）、
  `_markSupersededVisualDrafts`（`KIND_PROPS`）、`_captureVisualSnapshot`、
  `_renderSingleMessage`（卡片UI，跟3D場景卡片結構幾乎一致，只是沒有「重設
  視角」按鈕——2D動畫沒有camera概念）這幾個既有的「視覺類型分派點」裡，新增
  一種視覺類型時這幾個地方都要記得同步加，不能只顧著渲染邏輯本身。工具：
  `render_2d_animation`/`get_2d_animation_yaml`/`import_2d_animation_attachment`，
  獨立的`animation_2d`委派domain。匯入指令`/import-2d-animation-attachment`
  （跟互動viewer不同，2D動畫本身就是完全由YAML決定的宣告式內容，沒有分離的
  可變狀態，不需要像`VIEWER_PACKAGE_KIND`那樣另外設計一個「狀態要不要打包」的
  封裝格式，直接匯入/匯出YAML文字本身就夠）。
- **3D場景匯出成H.264 MP4影片**：`_exportSceneToMp4(yamlText, opts, onProgress)`
  ——瀏覽器原生WebCodecs的`VideoEncoder`直接編碼H.264（Chrome/Edge支援，
  Firefox/Safari目前不支援WebCodecs時會明確回報不支援，不會假裝成功），純JS的
  `mp4-muxer`（`FA_ASSET_URLS.mp4Muxer`，透過既有的`_faLoadScriptOnce`載入，
  **不要用indirect eval**——2026-09-06實測發現這個做法在某些執行環境下會
  「不報錯但也沒有真的建立全域變數」，原因不明，改用已驗證可靠的
  `_faLoadScriptOnce`就正常了）把encoder吐出的H.264 chunk包成真正的.mp4容器，
  不需要ffmpeg.wasm那種重量級wasm。逐幀呼叫`_build3DSceneGraph`同一套animator
  在一個off-screen canvas上render，`codec:'avc1.42001f'`（H.264 Baseline
  Profile，相容性優先）。每10幀yield一次主執行緒避免長片段卡住UI。
  `_appendCardExportButton`同步擴充：`getBlobFn`現在可以選擇性接受一個
  `(current,total)`進度callback參數（既有的STL/OBJ/3MF等`getBlobFn`不用這個
  參數也完全不受影響），MP4匯出用它把匯出按鈕文字即時顯示成`⏳42%`。已用
  真實瀏覽器測試驗證：產出的檔案有正確的MP4 `ftyp` box、原生`<video>`元素能
  正確讀出metadata（時長/寬高皆正確）。
- **MP4匯出：預設秒數可調(無上限)＋匯出當下選秒數＋用目前視角**（2026-09-06）：
  `advancedSettings.mp4DefaultDurationSeconds`（Advance設定「效能與限制」分頁，
  `_getMp4DefaultDurationSeconds()`讀取，只有下限1秒防呆，**刻意不設上限**——
  使用者明確要求秒數越長匯出時間/檔案越大是使用者自己的取捨，不是這裡該擋的
  事，`_exportSceneToMp4`/`_export2DAnimationToMp4`的`durationSeconds`夾值邏輯
  同步拿掉原本的`Math.min(30,...)`）。`_appendCardExportButton`新增
  `extra.needsMp4ExportDialog`分支：點MP4匯出項目時跳出自製的輕量Modal
  `_showMp4ExportOptionsDialog(defaults)`（inline style、不依賴
  `_ensureAdvancedStyles`那份Advance設定專用CSS，回傳
  `Promise<{durationSeconds,speed}|null>`）讓使用者臨時調整**秒數**（預填值
  來自上述設定，無上限）跟**播放速度**（0.1x~4.0x，預設1x——動畫時間軸相對
  匯出秒數的加速/減速倍率，不是fps/位元率；`_exportSceneToMp4`/
  `_export2DAnimationToMp4`都在算`t`/`dt`時乘上`speed`），取消（按取消鈕或
  點遮罩背景）就靜默放棄匯出（不當錯誤）。**原本第一版用單欄位
  `window.prompt()`，因為要加播放速度變成兩個欄位放不下才改成自製Modal**
  （2026-09-06當天兩次迭代）。3D場景卡片的MP4匯出項目另外多帶一個
  `extra.getCameraOverride`函式，讀取畫面上正在跑的`msg._scene3DHandle`
  （見`_mount3DScene`新增的`getCameraState()`——回傳`{position, target}`，
  分別讀`camera.position`跟`OrbitControls.target`目前的即時值）當作
  `opts.cameraOverride`傳給`_exportSceneToMp4`，讓匯出影片用「使用者自己拖曳
  調整過的視角」而不是永遠用YAML寫死的`camera.position`/`look_at`；場景還沒
  mount完成時（handle不存在）`getCameraOverride`回傳null，行為退回原本的YAML
  camera定義。2D動畫沒有camera概念，不受影響。
- **階層式軌道（衛星繞母星）+ `_build3DSceneGraph`共用場景組裝**：
  `node.id`（選填字串）+ `node.animation_parent`（orbit動畫專用，指向另一個
  節點的id）讓軌道中心從固定世界座標改成每一幀動態讀取母星節點目前的位置
  （`_build3DAnimatorForNode`新增第三個參數`nodesById`）——解決「月亮繞地球、
  地球繞太陽」這種階層運動原本畫不出來的問題（原本兩個都繞固定原點轉，會
  完全重疊）。純向下相容，沒有animation_parent時行為逐字不變。連帶把
  `_mount3DScene`裡camera/lights/nodes/animators的組裝邏輯抽成獨立方法
  `_build3DSceneGraph(sceneDef, expandedNodes, particlePresets, aspectRatio)`
  （不含canvas/renderer/OrbitControls），因為要支援階層軌道，節點建構跟
  animator建立必須拆成兩輪（先建完全部物件＋id查找表，animator才能查到
  parent），這個共用方法之後也給MP4匯出功能重用，避免維護兩份幾乎一樣的
  場景組裝程式碼。
- **3D場景驗證分成strict（生成）/lenient（播放）兩種模式**：
  `_validate3DSceneYaml(yamlText, opts)`新增選填的`opts.lenient`——**這是理解
  這一整塊驗證邏輯最關鍵的一點，改動前務必先讀這裡**。預設（`opts`省略，
  `render_3d_scene`工具呼叫等AI生成路徑用這個）維持嚴格行為：任何一項不符合
  就整個reject並回傳明確錯誤，讓AI能在同一輪立刻自我修正。`{lenient:true}`
  （`_mount3DScene`/`_buildTemporarySceneObjectFromYaml`/
  `_handleViewAttachedSceneCommand`這些「播放/檢視既有場景」的路徑用這個）則是
  「跳過壞掉的部分＋記一筆warning＋繼續」，只有YAML語法錯誤/scene本身不是物件
  這兩種真的沒東西可以顯示的情況才會整個擋下來——理由是使用者明確要求「不存在
  的preset不需要reject...出現意外的元件應該還是可以by pass並播放，不然這會
  造成舊的model無法繼續顯示」，新增驗證規則不該讓舊場景突然整個播不出來。
  `_mount3DScene`的節點建構迴圈也額外包了一層try/catch（收集進同一個
  `warnings`陣列）當第二道防線，防止未預期的例外讓其餘節點也不畫出來。收集到
  的warnings會顯示在3D場景卡片的「⚠️ N」按鈕（`_renderSingleMessage`的
  scene3d分支裡，`btnGroup.insertBefore(warnBtn,...)`那段），點擊才展開細節，
  預設不佔版面。**新增任何一種scene3d相關的驗證規則時，都要同時想清楚它在
  strict跟lenient兩種模式下該怎麼表現**（通常是「一樣的判斷邏輯，只是要不要
  立刻return」），不能只改strict那一種情境。
- **`mesh:"line"`（軌跡線/軌道環）+ 頂層欄位白名單守門**：`_build3DLineObject`（
  `points:[[x,y,z],...]`折線，或`shape:"circle"+radius+center+plane+segments`
  簡便畫圓環；`plane`預設`"xz"`跟`animation:"orbit"`的繞行平面一致）、
  `SCENE3D_KNOWN_TOP_LEVEL_KEYS`（`_validate3DSceneYaml`現在會擋掉任何不在白名單
  內的頂層欄位並直接報錯，起因是AI自己編了不存在的`lines:`/`markers:`頂層陣列
  想畫軌道線，靜默被忽略）、`_raster3DFrame`裡新增的`obj.isLine`繪製分支（軟體
  光柵化路徑，跟三角形/Points是三種各自獨立的繪製步驟）。同一次修正也補上
  `_mount3DScene`呼叫`_build3DMeshObject`時漏傳`validation.particlePresets`的
  既有bug（自訂粒子preset在即時掛載這條路徑上原本永遠找不到）。
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
- **Domain階層式工具註冊 + 兩層委派（路由子agent+執行子agent）**（2026-09-06，
  起因是把這個檔案整合進另一個專案`piano-web`時發現內建的22個通用工具不管
  host需不需要都無條件塞進根層級對話，稀釋模型注意力）：
  - `SUBAGENT_DOMAIN_REGISTRY`（~641行）新增兩個domain：`ai_functions`
    （AI自製函式4個工具）、`rag_management`（RAG寫入/分段/刪除3個工具，跟
    唯讀的`rag_lookup`分開）——這樣`_registerBuiltinAiTools()`裡的25個工具
    才會全部有domain覆蓋。
  - `this.domains`：建構子把`SUBAGENT_DOMAIN_REGISTRY`複製成instance-level
    的可擴充登記表，新增公開方法`register_domain(key, {label, toolNames,
    systemPrompt, enabled})`讓host頁面自己新增domain（跟`register_openai_tool`
    同一種公開介面模式）。原本4處讀`SUBAGENT_DOMAIN_REGISTRY[...]`的地方
    （互動viewer的`subagent_panel`驗證/渲染、`_delegateToSubagentDomain`）
    全部改讀`this.domains[...]`。
  - `builtinToolExposure`選項（建構子`options.builtinToolExposure`）：
    **預設`'domains'`**——`_registerBuiltinAiTools()`裡25個工具中的22個
    （除了`get_tool_details`/`delegate_to_subagent`這兩個核心plumbing）改用
    內部的`registerOptional()`外殼註冊，被記進`this._domainGatedToolNames`；
    `_getRootToolNames()`回傳「host自己的工具＋這兩個核心plumbing」這份
    allowlist（不含這22個），3處根層級工具清單組裝（`_loopFetchNative`的
    `_buildNativeToolsSchema()`呼叫、`/benchmark-model`的同一個呼叫、
    `_getFinalSystemPrompt()`文字協定的`[PREDEFINED TOOLS]`清單）都改用這份
    allowlist過濾。傳`options.builtinToolExposure:'root'`可以退回舊行為（全部
    25個工具都在根層級，`_getRootToolNames()`回傳`null`＝不過濾）——這是
    唯一影響既有tw_stock_db行為的地方，但預設值已經改變，**web/index.html
    沒有另外設定這個選項**，確認過它的`AI_SYSTEM_PROMPT`完全沒有直接引用
    這22個工具名稱，所以吃到新預設值不需要額外處理。
  - `delegate_to_subagent`工具的`domain`參數從必填改選填、description不再
    列出每個domain代號+label（那份清單現在只在下面的路由子agent自己的
    system prompt裡）。留空domain時走新的`_delegateToSubagentAuto(task)`：
    先呼叫`_routeTaskToDomains(task)`（Layer 1，單次非streaming、不帶tools
    參數的分類請求，system prompt用`_getCombinedToolEntries(null)`+
    `_summarizeToolDescription`列出全部domain底下全部工具的「名稱+極短
    摘要」，模型只需要回傳`{"domains":[...]}`，用既有的`repairJsonPayload`
    寬容解析），拿到要開的domain後合併`toolNames`/`systemPrompt`，直接複用
    既有`_runSubAgentTask`（Layer 2，跟`_delegateToSubagentDomain`完全同一條
    執行路徑）真正執行，回傳`{ok:true, domains, result}`。已明確指定domain
    時完全不觸發這條路由，行為跟原本一模一樣。已用真實的NVIDIA端點
    （`web/index.html`的匿名假金鑰channel，`tw_stock_db_api:{sessionId}` +
    `https://dawn-disk-778c.sunneo529.workers.dev`）端對端驗證過：路由正確
    判斷「畫流程圖」→`drawing`、「存進長期記憶」→`rag_management`、「新增
    AI自製函式」→`ai_functions`、單純打招呼→空陣列（不委派），完整
    delegate_to_subagent呼叫（含實際render_drawing執行）也成功產出真正的
    SVG。**驗證過程中發現一個既有、無關的bug（2026-09-06已修）**：預設的
    `advancedSettings.generation.samplingParams.length_penalty`（原本 value 0.3,
    disabled:false）在這個預設channel/模型組合下會被NVIDIA API直接拒絕
    （HTTP 400 Unsupported parameter），導致所有`_runSubAgentTask`（不限於
    這次新功能，`delegate_to_subagent`/`batch_analyze_stocks`都受影響）在
    預設設定下都會失敗。修法：(1)`_createDefaultGenerationSettings()`把
    `length_penalty`預設值改回`null`（＝不送這個欄位；它是beam search專屬的
    非標準欄位，其餘三個參數預設都是中性值，只有它是帶意見的非中性預設）；
    (2)`_runSubAgentTask`補上跟主迴圈`_loopFetch`一樣的取樣參數被拒自我修復
    路徑（`_detectRejectedSamplingParam`+`_disableRejectedSamplingParam`），
    讓已經在localStorage存過舊預設值的使用者也能自動排除、不用手動進設定面板。
  - **實測token數對照**（同一模型、同一組25個內建工具，`'root'` vs 預設
    `'domains'`，真實API `usage`欄位加總，不是估算）：**單一明確意圖的簡單
    需求**（例如「列出所有AI自製函式」）——`root`模式2次呼叫共14,512
    tokens；`domains`模式雖然多繞3輪（root呼叫delegate→路由子agent→執行
    子agent→root收尾）變成5次呼叫，但總計只要5,459 tokens（省62%），因為
    每輪的tools schema從25個縮到2~4個，省下的遠多於多繞幾輪的成本。
    **一句話同時橫跨3個領域的複雜需求**（RAG查詢/寫入+畫圖+列AI函式）——
    一開始`domains`模式反而比`root`模式的39,180 tokens貴38%（54,012
    tokens，25次呼叫）：根模型只看得到2個工具，會先用`get_tool_details`
    亂猜工具名稱（"draw"/"sketch"/"image_generation"...都查無結果）才想到
    用delegate_to_subagent，而且把一句話拆成3次獨立的delegate呼叫而不是
    一次講清楚。**修法**：`get_tool_details`跟`delegate_to_subagent`兩個的
    description都補上明確引導（`get_tool_details`不要用來猜測未出現在清單
    裡的名稱、找不到能力應該直接委派；`delegate_to_subagent`一次講清楚
    整段需求即可、不用拆成多次呼叫），同樣的複雜需求重測後降到27,766
    tokens、15次呼叫（比修之前省49%），雖然還沒完全達到只呼叫一次delegate
    的理想（模型仍然傾向拆成幾個獨立呼叫），但已經大幅減少無謂的
    get_tool_details亂猜。這個「單一意圖大幅省token、多重意圖混雜在一句話
    裡反而可能更貴」的落差是這個設計本質上的取捨（根層級知道的原則越少，
    複雜/混雜需求就越需要多繞幾圈才能釐清該委派什麼），descriptions已經
    盡量緩解但沒有完全消除，仍有進一步優化空間（例如routing prompt本身
    的準確度、或讓根模型更傾向一次把整段需求講完）。
  - **修復：委派出去的視覺型工具結果原本會整個消失（重大，已修）**：
    使用者實測token對照時發現「畫的圖沒看到」——`render_3d_scene`/
    `render_drawing`/`render_interactive_viewer`/`render_2d_animation`這幾個
    工具透過`delegate_to_subagent`委派執行時，`_runSubAgentTask`原本的設計
    是「只回傳最終文字結論」，子agent自己會把render_drawing的SVG結果轉述
    成一段文字（例如「這是一個簡單的咖啡杯示意圖：...」），這段文字才是
    回傳給主對話的東西——真正的SVG/YAML從來沒有機會傳回去，使用者只看得到
    文字轉述，看不到真正渲染出來的圖/3D場景/viewer/動畫。**因為
    `builtinToolExposure`預設值已經改成`'domains'`，這幾個工具現在只能透過
    委派抵達**，代表這個bug預設就會影響所有畫圖/3D/viewer/2D動畫需求，
    嚴重度很高。修法：抽出`_detectVisualToolPayload(result)`（從
    `_buildToolResultMessage`原本inline的shape判斷邏輯抽出來，兩處共用）；
    `_runSubAgentTask`回傳值改成`{text, visual}`（原本是純字串，
    `runBatchSubAgents`這個既有呼叫端取`.text`即可，不受影響）——`visual`
    是子agent執行期間最後一次呼叫視覺型工具的原始payload；新增
    `_mergeSubAgentResultForDisplay(baseFields, subResult)`，
    `_delegateToSubagentDomain`/`_delegateToSubagentAuto`都改用它：有
    `visual`時把它原封不動攤平合併進最終回傳物件（例如
    `{ok:true, domain:'drawing', type:'drawing', svg:'...', note:'子agent的
    文字結論'}`），這樣主對話處理`delegate_to_subagent`工具結果時，
    `_buildToolResultMessage`同一套shape偵測邏輯就能正確認出並顯示。已用
    真實模型端對端驗證：委派畫三角形的請求，`this.messages`裡
    `delegate_to_subagent`的工具結果訊息確實帶有`_displayDrawingSvg`，
    畫面上也確實渲染出真正的三角形SVG卡片（截圖驗證過），不再只有文字
    轉述。
  - **修復：自動路由失敗時，根模型結構上無法照建議重試**：使用者實測
    真實案例——請求「3D顯示太陽地球月亮…真實貼圖」被`_routeTaskToDomains`
    誤判成`domains:[]`（沒有適合的領域），根模型收到
    `_delegateToSubagentAuto`的錯誤訊息「domain參數也可以指定明確的領域
    代號重試」後，直接放棄委派、自己輸出一大段Three.js程式碼叫使用者貼去
    CodePen執行——完全沒用到這個元件內建的3D渲染能力。根因：
    `delegate_to_subagent`的description刻意不列出domain代號清單給根模型看
    （省token），導致失敗訊息叫模型「指定domain重試」時，模型結構上根本
    不知道有哪些domain代號可以填，這個建議對它來說是做不到的事。修法：
    `_delegateToSubagentAuto`的兩種失敗路徑（`_routeTaskToDomains`本身
    出錯、或domains回傳空陣列）都附上`available_domains`（key+label陣列，
    跟`_delegateToSubagentDomain`原本就有的同一個欄位），讓根模型收到
    失敗訊息時真的有domain代號可以拿來重試。已用真實模型重新測試同一句
    「3D太陽地球月亮」請求，`_routeTaskToDomains`本身這次正確判斷出
    `scene_3d`（4次重複測試皆一致，這次沒有觸發到空陣列分支，研判使用者
    當時遇到的是舊版本快取或單次模型判斷失誤），完整端對端流程也確認
    3D場景卡片正確渲染出來（不再是純文字模型結果）；`available_domains`
    的加強屬於「即使之後再發生類似誤判，根模型也不會束手無策」的防禦性
    修復，不是治本（治本仍要靠路由prompt本身的準確度）。

## 內建AI工具完整清單（`register_openai_tool`，共25個，行號為commit `fbdd5039`快照，2D動畫3個工具行號較新未更新）

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
| `render_2d_animation` | ~2582 | 渲染純宣告式YAML描述的2D多邊形動畫(Canvas2D) |
| `get_2d_animation_yaml` | ~2600 | 取得目前2D動畫的真實YAML(修改前必查) |
| `import_2d_animation_attachment` | ~2610 | 匯入2D動畫YAML附件 |

（tw_stock_db自己的業務工具，例如`diagnose_stock`/`export_document`，不在這份
清單——那些是`index.html`透過`AI_CAPABILITIES`陣列掛進來的，見上面「這個檔案跟
index.html的分工」。）

## 內建斜線指令完整清單（`register_slash_command`，共5個）

| 指令 | 約略行號 | 用途 |
|---|---|---|
| `/benchmark-model` | 1509 | 對指定模型跑三項基準測試評分 |
| `/suggest` | 1520 | 重新顯示建議操作按鈕 |
| `/view-3d-attachment` | 1529 | 本地開啟附加的3D場景/模型檔案（不經過AI） |
| `/import-viewer-attachment` | 1537 | 本地匯入「可互動文件」封裝檔（不經過AI） |
| `/import-2d-animation-attachment` | ~1587 | 本地匯入2D動畫YAML附件（不經過AI） |

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
