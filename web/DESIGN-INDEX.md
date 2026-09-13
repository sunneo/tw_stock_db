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
  - **修復：`emissive`+`texture`同時設定時貼圖完全被自發光蓋過去**：使用者
    實測回報太陽地球月亮場景「最多只有一個材質被載入」，一開始懷疑是CORS/
    載入問題，逐一用curl驗證使用者提供的外部貼圖網址（wellesley/threejs.org/
    raw.githubusercontent/jsdelivr）**全部**都有`Access-Control-Allow-Origin: *`
    也都能正常下載——不是CORS問題。使用者刻意把三個節點都指向同一張貼圖
    網址做對照實驗才抓到真正原因：太陽節點同時有`emissive_intensity: 3`，
    地球/月亮沒有emissive；三個節點用同一張貼圖，唯獨太陽完全看不出貼圖
    花紋、只剩一顆均勻的黃色球——`MeshStandardMaterial`的emissive是「純色
    ×intensity」直接疊加進最終畫面的自發光分量，intensity超過1時遠超
    texture能貢獻的範圍（0~1），太陽這類常見的高intensity發光設定會把
    貼圖完全蓋過去，這是PBR著色模型的既有行為，不是載入失敗。修法：
    `_build3DMaterial`（~6527行）在`m.texture`跟`m.emissive`同時存在時，
    額外把同一張貼圖設成`material.emissiveMap`，讓自發光亮度跟著貼圖花紋
    走（亮部多發光、暗部少發光）而不是均勻的純色光——貼圖細節在glow之下
    仍然看得出來。已用真實截圖前後對照驗證：修前太陽是一顆純黃球，修後
    太陽清楚看得出貼圖的大陸/海洋花紋（同一張圖）。`SCENE3D_TOPIC_DOCS.texture`
    也補上這個行為的說明，順便建議emissive_intensity不要超過1~2。
  - **`_runSubAgentTask`新增暫時性錯誤retry + MODEL NAME留空時的候選模型
    fallback**：使用者實測遇到`delegate_to_subagent`回傳
    `[子任務失敗: HTTP 500 ...]`，要求子任務也要能retry、且MODEL NAME
    留空時能比照主對話迴圈依序往下試候選模型。新增
    `SUBAGENT_TRANSIENT_RETRY_LIMIT`(2)/`SUBAGENT_TRANSIENT_RETRY_DELAY_MS`(800)
    兩個常數；`_runSubAgentTask`裡`apiModel`/`useNative`改成`let`，新增
    function-scope（不是instance-level，避免`runBatchSubAgents`平行執行
    的多個子任務互相干擾）的`modelFieldBlank`/`fallbackIndex`/
    `transientRetryCount`三個狀態變數。處理順序：網路例外或HTTP
    5xx先重試同一個模型（有次數上限，重試前等一段時間）；重試次數用完、
    或HTTP 404（模型/部署根本不存在，重試同一個模型沒意義）時，若使用者
    沒有手動指定MODEL NAME（`_isModelFieldBlank()`）就換
    `PRESET_MODEL_OPTIONS`的下一個候選模型繼續；都不行了才真的回報失敗。
    這整套retry/fallback都用`round--`不消耗`maxRounds`，跟既有的stop參數/
    取樣參數自我修復路徑同一個「基礎設施問題不算一輪對話」原則。已用
    mock fetch驗證4種情境：500兩次後成功（重試同一個模型，不觸發
    fallback）、500持續失敗（依序試完全部8個候選模型後才放棄）、明確指定
    MODEL NAME時500持續失敗（只重試同一個模型3次就放棄，不會fallback到
    其他模型，尊重使用者的明確選擇）、404（跳過同一個模型的重試，直接
    逐一換下一個候選模型）。
  - **Multi-subagent三模式（router/full/off）+ browser_search子agent + 大型
    文字「不論多長都能分段處理」**（2026-09-09）：使用者要求把原本二選一的
    `builtinToolExposure`（'root'/'domains'）擴充成三種`multiSubAgentMode`：
    1. **router**（預設，等同原本'domains'行為）：根層級只看得到
       `get_tool_details`/`delegate_to_subagent`兩個plumbing，不知道有哪些
       domain，`domain`留空時交給`_routeTaskToDomains`（路由子agent，多一次
       LLM往返）判斷。
    2. **full**（新）：`delegate_to_subagent`的description改成動態列出全部
       enabled domain代號+label（見`_buildDelegateToSubagentDescription`），
       鼓勵根模型自己判斷、直接指定domain（省掉路由那次往返，代價是根層級
       system prompt/tools每輪都多背一份domain清單）。
    3. **off**（等同原本'root'）：`_getRootToolNames()`回傳「全部工具except
       `delegate_to_subagent`」（`get_tool_details`仍保留，那是文字協定通用
       機制、跟subagent無關），23個內建工具直接掛根層級，完全沒有委派機制。
       三種模式都是`advancedSettings.multiSubAgentMode`（localStorage持久化），
       **可以在Advance Settings的新分頁「子Agent」即時切換，不用重新整理**
       ——`_getRootToolNames()`/`_buildDelegateToSubagentDescription()`都是
       即時讀取當下模式，`_registerBuiltinAiTools()`的`registerOptional`改成
       無條件把工具名稱收進`_domainGatedToolNames`（不再依註冊當下的模式
       決定），過濾邏輯完全交給`_getRootToolNames()`。建構子仍接受
       `options.multiSubAgentMode`/`options.builtinToolExposure:'root'`
       （向下相容別名）當**初始預設值**，只在使用者從沒存過Advance設定時
       套用。
  - **新增`browser_search`內建domain**（預設`browserSearchEnabled:false`，
    需使用者自己在「子Agent」分頁勾選啟用）：查詢
    wiki/stackoverflow/github/google/sourceforge/codeproject/deepwiki，經
    `web/cloudflare-worker/worker.js`的新路由`/browser-search`代打（wiki/
    stackoverflow/github打各自官方API；google/sourceforge/codeproject/
    deepwiki代打DuckDuckGo HTML介面+`site:`限制，是2026-09-09實測過各來源
    真實回應後才決定的做法，不是猜的——見worker.js檔頭「關於
    /browser-search」的完整說明）。結果存進獨立的
    `this.searchCache`（`FileCache`實例，獨立20MB預算，不跟256MB的
    `fileCache`共用）＋1天TTL（`SEARCH_CACHE_TTL_MS`，`_getCachedSearchResult`
    讀取時主動判斷過期並刪除，`_purgeExpiredSearchCache`每個實例生命週期
    額外主動掃描一次），TTL之外沿用FileCache既有的LRU容量淘汰——完全符合
    使用者說的「跟使用空間的原則一樣，超出去就用LRU找到沒在用的移除」。
    `browserSearchProxyUrl`（Advance Settings「子Agent」分頁）指向worker
    網址本身（不含路徑）；`web/index.html`已經把這個值的建構子預設指到
    `TWSE_PROXY_BASE`（跟AI助理本來就在用的同一個worker），使用者只需要
    勾選啟用即可。
  - **`summarize_large_text`新工具 + `rag_chunk_document`修掉25000字元截斷**：
    使用者明確要求「不論多大的文章都可以分段summary，無論是upload、
    webfetch，或任何現有AI整合到的情境」。新增共用helper
    `_callSimpleCompletion`（單輪非agentic LLM呼叫）、
    `_chunkTextByLength`（純字元數切塊）、`_summarizeLargeTextChunks`
    （map-reduce：每個`SUMMARIZE_CHUNK_SIZE`=6000字元的區塊各自摘要，
    >1個區塊時再彙整成最終摘要；單一區塊失敗不會讓整個流程中止，用佔位
    文字接續）。`summarize_large_text`工具（`file_analysis` domain新成員）
    透過新的`_getFullTextFromUploadedFile`（跟`_parseUploadedFileContent`
    分開——那個方法設計上就是會截斷，這個方法保證讀到完整原始文字）讀取
    persistentStorage裡的檔案，不論多長都能摘要。`rag_chunk_document`原本
    `docText.slice(0,25000)`直接截斷丟棄後面內容，改成`_chunkDocumentForRag`
    依`RAG_CHUNK_WINDOW_SIZE`=20000字元切窗口、每個窗口各自跑一次原本的
    語意分段+依賴關係prompt（窗口間用「上一個窗口最後一個節點id」當提示
    引導依賴鏈延續，非強制），新增`file_id`參數當`documentText`的替代輸入
    （跟`summarize_large_text`共用同一份`fileCache`，不用先把全文讀出來
    當參數傳回去——那樣還是沒解決「多長都能處理」的根本問題，因為受限於
    呼叫端自己能產生的輸出長度）。
  - **`web/index.html`的`fetch_web_page`改存persistentStorage**：原本
    worker端`/webfetch`用`WEBFETCH_MAX_BYTES`(200000)截斷回應（使用者要求
    拿掉，已從worker.js移除，含一開始遺漏移除`handleWebFetch`內兩處
    使用點的疏漏，隨後修正），前端`fetch_web_page`原本直接把抓到的原始
    內容整段回傳給根模型。使用者要求「先放到persistentStorage，然後用
    subagent自己分段處理」——改成抓到內容後用`aiConsoleInstance.fileCache.put`
    存成`kind:'uploaded'`記錄（跟使用者📎上傳檔案共用同一套機制/同一份
    `list_uploaded_files`清單），只回傳`file_id`+提示文字，引導根模型呼叫
    `delegate_to_subagent(domain:"file_analysis")`委派子agent用
    `parse_uploaded_file`/`summarize_large_text`處理，不是自己回答內容或
    把整段HTML塞進對話。persistentStorage寫入失敗時有防禦性fallback（退回
    直接回傳原始內容），不會讓整個工具直接失效。
  - **`web/cloudflare-worker/worker.js`第一次進repo**：這個檔案先前只在
    tw_stock_db的AI助理程式碼註解裡被提及（例如
    `checkAndIncrementRateLimit`），實際的Worker原始碼從沒進過這個repo
    （使用者透過對話貼出目前實際部署的版本）。已補進repo，同時整合了
    `/browser-search`新路由；同目錄`README.md`記錄部署步驟/環境變數/
    `browser_search`要在Advance Settings額外設定的東西。
  - **真實LLM三模式token/時間比較**（`nvidia/nemotron-3.5-lightning-30b-a3b`，
    支援原生tool_calls，用來確保拿到穩定的`usage`欄位；透過匿名共用channel
    量測，非估算值）：
    | 模式 | 簡單問題（無需委派） | 複雜問題（畫圖+查RAG，需委派） |
    |---|---|---|
    | router | 2.3s／1,304 tokens（1次呼叫） | 84.7s／9,328 tokens（6次呼叫） |
    | full | 19.0s／1,903 tokens（1次呼叫） | 81.3s／13,977 tokens（7次呼叫） |
    | off | 18.3s／8,602 tokens（1次呼叫） | 45.5s／26,687 tokens（3次呼叫） |

    簡單問題：router的prompt token明顯最省（根層級只看得到host自己的工具+
    2個plumbing），off最貴（25個內建工具的完整schema/description每輪都要
    帶）；full介於中間（domain清單比完整工具規格輕，但比router多）。複雜
    問題：off雖然token最貴，但因為不用經過委派/路由的LLM往返，總耗時反而
    最短；router因為要先問路由子agent才知道開哪些domain，往返次數
    （6次）介於full（7次，含根模型自己先摸索了一輪才決定委派）跟off（3次，
    根模型直接呼叫`render_drawing`/`rag_query_graph`兩個工具）之間。**注意
    這次複雜任務兩次(router/full)測試中，模型都沒有真的呼叫`render_drawing`
    ——而是直接把SVG程式碼寫進文字回覆**（`temperature:0`仍無法完全消除
    這種行為變異，這是量測當下真實觀察到的模型行為，不是測試設計刻意
    誘發，如實記錄），代表這次的「複雜任務」比較數字混雜了「domain曝光
    方式的差異」跟「模型是否選擇使用委派/工具」兩種變因，不是單純的
    apples-to-apples token成本比較，解讀時要留意這點。
  - **`browserSearchProxyUrl`留空時自動沿用API URL**（2026-09-09，使用者
    追問）：`_browserSearch()`原本留空就直接報錯，改成`|| this._getApiConfig().apiUrl`
    ——多數情況下`/browser-search`本來就跟chat completions代理部署在同一個
    Worker，這樣使用者不用重複填兩次網址；且是**每次呼叫都重新讀取**，不是
    快照，使用者之後換API URL會自動跟著換。連帶把`web/index.html`原本寫死
    `browserSearchProxyUrl:TWSE_PROXY_BASE`的建構子選項拿掉（那個快照現在
    反而是劣化版，不會跟著API URL變動）。也順便修掉3處還在講舊檔名
    `browser-search-worker.js`的過期註解（合併進`worker.js`之後忘記全部
    更新）。
  - **新增`news`來源（Google News RSS）**（2026-09-09，使用者實測回報
    `google`來源查「今日焦點新聞」效果很差）：`google`來源代打的是
    DuckDuckGo一般網頁搜尋，沒有新聞時效性概念；改用Google官方的
    News RSS Feed（`news.google.com/rss/search?q=...&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`，
    不需要金鑰、文件本身允許個人非商業feed reader用途），回應是真正依時間
    排序、含正確發布時間/來源媒體名稱的新聞——用一般正則表達式解析（RSS
    結構固定可信任，不像任意HTML需要HTMLRewriter的容錯能力）。`google`
    來源保留不變（一般網頁查詢仍然有用），`news`是新增的第8個來源，
    `BROWSER_SEARCH_SOURCES`陣列/domain systemPrompt都提醒模型「時效性
    查詢要用news、不要只靠google」。已用真實curl請求驗證RSS格式+parser
    邏輯（下載實際回應、跑同一套regex，確認能正確抽出title/url/snippet）。
  - **清除對話沒有重設`topicData.currentTopic`的bug**（2026-09-09使用者
    實測回報「對話刪除了，還是會檢查話題轉移」）：`this.topicData.currentTopic`
    是純instance-level狀態，只有建構子會初始化成「無（新對話開始）」，
    `_clearChatHistory()`原本只重設`this.messages`/`archivedDisplayBlocks`，
    沒有一併重設這個欄位——使用者清除對話後，新對話一旦累積到3則訊息
    （`_checkTopicTransition`的length<3提早return門檻），就會拿新對話內容
    去跟清除前殘留的舊話題比對，容易誤判成「已經轉移話題」而觸發不必要的
    封存。修法：`_clearChatHistory()`裡一併把`topicData.currentTopic`重設回
    建構子的初始值，讓「清除對話」在語意上真正等同「回到全新對話開始」。
  - **Skill自動register成slash-command**（2026-09-09使用者要求）：新增
    `_syncCustomToolSlashCommands()`——每個`advancedSettings.customTools`
    （Advance Settings「Skill」分頁）自動掛一個同名`/<skill名稱>`指令，
    讓使用者可以直接在輸入框打指令跳過AI判斷、本地端直接執行（複用既有
    `_executeCustomTool`，跟AI自己決定呼叫時完全同一份handlerScript/執行
    邏輯），也會自動出現在既有的「/」自動完成選單裡。用
    `entry._autoFromSkill`旗標區分「這個slash command是自動衍生出來的」
    跟「host/內建明確註冊的」——同名時明確註冊的優先，Skill不會覆蓋掉既有
    指令（該Skill仍然可以被AI正常呼叫，只是拿不到這個slash command捷徑）。
    掛在`_saveAdvancedSettings()`裡（Skill新增/編輯/刪除/.skill匯入/完整
    設定匯入這幾個既有入口最後都會呼叫它），每次都重新同步一次（先移除
    上一輪自動註冊、這次已經不在customTools裡的舊entry，再逐一重新註冊），
    建構子裡也額外呼叫一次（`_saveAdvancedSettings()`不會在單純載入既有
    設定時被呼叫）。觸發後的畫面呈現比照
    `_handleImport2DAnimationAttachmentCommand`那類「本地端直接產生結果」
    的既有slash command：推入使用者訊息回顯指令、用`_buildToolResultMessage()`
    包裝結果（連帶支援視覺型payload自動偵測），渲染+存檔。已用mock測試
    驗證：預先存在的Skill建構時自動註冊、新增/刪除即時同步、呼叫時0次
    fetch（真的跳過LLM）、撞名時不覆蓋既有指令。
  - **`transcribe_media`（語音轉文字）+ 新`media_transcription` domain**
    （2026-09-11，「帶聲音的影片→逐字稿」的Phase 1）：上傳的影片/音檔在
    **瀏覽器端**用Whisper轉逐字稿，音訊完全不上傳伺服器。
    - 模型：`onnx-community/whisper-base`（中英雙語）`dtype:'q8'`（int8，
      encoder~23MB + decoder~54MB ≈ 77MB），首次使用從HuggingFace Hub
      下載、transformers.js用瀏覽器Cache API快取。Whisper詞彙表是跨語言
      共用的byte-level BPE，**沒辦法**用「只要中英文」把詞彙表砍小，
      「minimize」＝挑最小的模型層級＋還堪用的量化，這已經是底線
      （`WHISPER_MODEL_ID`/`WHISPER_DTYPE`常數，換模型只改這裡）。
    - Runtime：transformers.js經jsDelivr `/+esm`（官方dist有未解析的
      bare specifier `onnxruntime-web/webgpu`，`/+esm`會預先bundle掉），
      動態`import()`載入（跟index.html載qr-scanner同一種手法）。
    - Device：`_isWebGpuAvailable()`（`navigator.gpu.requestAdapter()`）
      可用就走WebGPU、否則CPU WASM，WebGPU建pipeline或轉錄失敗會退回CPU。
      CPU多執行緒（`WHISPER_WASM_THREADS`=4）需要`crossOriginIsolated`
      （COOP/COEP header），GitHub Pages不能設header→沒加coi-serviceworker
      的話onnxruntime-web自動夾回1執行緒（不會壞、只是慢）。
    - **WebGPU跟CPU用不同版本的transformers.js**（`transformersJs`＝3.7.5、
      `transformersJsWebGpu`＝4.2.0，`_ensureTransformersJsLoaded(device)`
      依device挑）：2026-09-11對jfk.wav實測——4.2.0的WebGPU路徑正確、CPU
      WASM路徑載入量化模型直接噴`TransposeDQWeightsForMatMulNBits`建session
      失敗（所有dtype都一樣）；3.7.5的CPU WASM路徑正確、WebGPU路徑會跑完
      但吐整段亂碼。兩版共用同一組HF模型檔（Cache API依模型URL快取、跟
      transformers.js版本無關），只有transformers.js那包JS各下載一次。
      上游修好其中一版的兩條路徑後可以收斂回單一版本。
    - 音訊解碼：Web Audio API `decodeAudioData`（自動從mp4/mov抽AAC音軌，
      **不需要ffmpeg.wasm**）+ `OfflineAudioContext`重採樣成16kHz單聲道
      （`_decodeAudioForWhisper`）。已實測mp4（帶聲音的影片）解碼正常。
    - 回傳`{ok, language, durationSeconds, device, text, segments:[{start,
      end,text}], transcript_file_id}`——逐字稿也另存成persistentStorage
      檔案（跟檔案上傳/fetch_web_page共用fileCache），很長時可再委派給
      `summarize_large_text`。
    - 已實測驗證：WebGPU/CPU兩條路徑對jfk.wav都轉錄正確、有時間軸分段、
      逐字稿存檔可取回；mp4影片音軌解碼正常；**使用者提供的真實中文影片
      （康軒「月亮魔法師」）也實測過**——whisper-base對中文是「聽得懂在講
      什麼」的水準但有同音字錯（魔法→模法、細細→吸息），這是q8 base的
      已知取捨，不是bug。
  - **2026-09-11 追加（影音處理domain擴充）**：
    - domain從`media_transcription`改名`media_av`「影音處理（逐字稿/擷取
      聲音/字幕）」，toolNames加`extract_audio`。
    - `transcribe_media`的參數`file_id`改成`file`（吃file_id**或檔名**，
      留空＝用最近上傳的），透過新的`_resolveUploadedFileRecord(arg,
      {kindFilter, consumePendingAttachment})`定位檔案——這是使用者要求
      「slash-command能用附件id/檔名接續操作」的共用機制。
    - `transcribe_media`改成**自己把音訊切30秒window逐段轉錄**
      （`_runWhisperWindowed`），不用transformers.js pipeline內建chunking：
      (1) 每段log進度（長影片轉錄可能好幾分鐘，使用者實測回報「開始轉錄」
      後一直沒動靜像卡住）(2) 繞開pipeline內建chunking在某些版本的
      stitching問題。window間留`WHISPER_STRIDE_LENGTH_S`重疊、第2段起丟
      重疊前段的segment、時間軸offset回絕對時間、相鄰逐字相同的segment
      去重。逐字稿檔改存**`.srt`**（有時間軸時）——可以直接當之後
      burn_subtitles的字幕來源，也還是純文字能餵summarize_large_text。
    - 新工具`extract_audio`（`_extractAudio`）：`decodeAudioData`解碼音軌
      →`_faEncodeWav`（純JS、無函式庫）編成16-bit PCM WAV存進fileCache。
    - 新slash指令（共同`/media-`前綴，都跳過LLM直接跑本地工具）：
      `/media-transcribe [<影片id或檔名>] [zh|en]`、
      `/media-extract-audio [<影片id或檔名>]`——結果用
      `_deliverExistingCacheFile`在對話裡給下載連結。
    - Advance Settings「子Agent」分頁新增：CPU執行緒數（`whisperWasmThreads`，
      預設4，夾1~16，`_getWhisperWasmThreads`）＋模型快取占用顯示/重新
      整理/清除（`_getWhisperCacheInfo`/`_clearWhisperCache`/
      `_refreshWhisperCacheSizeDisplay`——transformers.js把模型檔存在
      `transformers-cache`這個Cache API）。
    - 字幕解析helper`_faParseSubtitleText`（吃`.srt`或`[M:SS - M:SS] 文字`
      逐行格式→segments），給burn_subtitles吃「使用者自己提供的字幕檔」用。
  - **2026-09-11 追加（burn_subtitles 燒錄字幕，Phase 3）**：
    - **用 Mediabunny + WebCodecs，不是 `<video>` tag**（使用者明確要求：
      不要即時播放那種、要用 decoder、要平行、offscreen）。Mediabunny
      （`mp4-muxer` 作者的新作、`mp4-muxer` 已停止維護官方導向這個）
      `FA_ASSET_URLS.mediabunny` 走 jsDelivr `/+esm` 動態 import。
    - `FA_BURN_SUBTITLES_WORKER_SRC`：**module worker**（才能 import ESM），
      整條「demux→`VideoDecoder` 硬體解碼→逐幀畫字幕 overlay 到
      OffscreenCanvas→`VideoEncoder` 重編→mux」都在 worker 裡跑、不碰
      主執行緒。用 `Conversion.init({ video:{process}, audio:{} })`——
      `audio:{}` 就是**音軌 passthrough 不重編**（AAC 原封不動）。字幕
      繪製函式 `_drawSubtitle`/`_wrapLines`（CJK 逐字換行、Latin 空白換行）
      也在 worker src 裡。實測 12s/1080p 影片 6.3s 燒完（2x 影片長度、
      連沒有真實 GPU 的環境）、音軌長度保留、輸出可播、字幕正確燒進畫面
      （白字黑邊半透明底、置中）。
    - **瀏覽器需求**：WebCodecs（`VideoDecoder`/`VideoEncoder`）＋
      OffscreenCanvas＋module worker——較新的 Chrome/Edge/Safari，**含
      Android Chrome 跟 iOS Safari 16.4+**（跟既有的 3D→MP4 匯出同一組
      API，那個一樣早就能在手機跑，所以工具/錯誤訊息裡「只有桌機」的
      措辭是抄舊版 3D 匯出、過度保守，2026-09-11 已改成正確措辭）。
      Firefox 目前 `VideoEncoder` 支援還不夠、不能用。手機/沒 GPU 會
      慢很多，長影片也可能因記憶體不足失敗（尤其 iOS Safari），這是
      「可能失敗」不是「不支援」。
    - `_burnSubtitles(videoRecord, segments, onProgress)`：建 worker、
      postMessage、收 progress + 最後 transfer 回來的 ArrayBuffer→Blob→
      fileCache→`{ok, video_file_id, filename, frames, sizeBytes}`。
    - `_resolveSubtitleSegments(videoRecord, subtitleArg, language, onLog)`：
      subtitleArg 給字幕檔 id/檔名就 `_faParseSubtitleText`；留空就自動
      先跑 `_transcribeMedia` 轉一份（`autoTranscribed:true`）。
    - 工具 `burn_subtitles({video, subtitle?, language?})`、slash
      `/media-burn-subtitles [<影片>] [<字幕檔>]`，都加進 media_av domain。
    - **進度 widget**（使用者要求：長處理要有會更新的對話內 widget）：
      `_createProgressWidget(title)` → 推一則帶 `_progressWidget` 非可枚舉
      旗標的訊息，`_renderSingleMessage` 有對應渲染分支（標題+進度條+狀態
      +spinner/✅/❌），回傳 handle 讓呼叫端 `update({pct,status})`/
      `finish()`/`fail()`（內部節流 250ms 重繪）。**三個 `/media-*` slash
      指令都改用它**（不再狂洗 `_log`）：transcribe 把 `_transcribeMedia`
      內部的 `_log` 暫時導到 widget status 列。
    - Advance Settings「子Agent」分頁加：字幕字級（`subtitleFontScale`，
      占影片高度比例，預設 0.052）＋位置（`subtitlePosition` top/bottom）。
      其餘外觀用 `SUBTITLE_DEFAULT_STYLE` 內建（`_getSubtitleStyle` 疊合）。
  - **2026-09-11 追加（compose_video 動畫版影片，media_av 第 4 項）**：
    - 完成使用者要的「一個完整 subagent 做 4 件事」：mp4→逐字稿
      (`transcribe_media`)、mp4→音軌 (`extract_audio`)、字幕燒回原片
      (`burn_subtitles`)、**mp4→動畫版影片 (`compose_video`)**——最後這項
      是「LLM 自己設計一段 2D/3D 動畫 YAML＋配上原片音軌＋時間軸對齊的
      字幕，合成一支有聲 MP4」。
    - 工具 `compose_video({animation_2d? | animation_3d?, audio?, captions?})`
      → `_composeAnimationVideo(opts)`：`audio` 有給就 `_decodeAudioBuffer`
      拿 `AudioBuffer`、輸出長度＝音軌長度（動畫 `duration` 被 override 成
      音軌長度、`speed` 不變、不 loop）；`captions` 收字幕檔 id/檔名
      （`_faParseSubtitleText`）或直接 `[{start,end,text}]` 陣列。
      **不新增渲染路徑**——直接重用既有 `_export2DAnimationToMp4` /
      `_exportSceneToMp4`，只在它們共用的 `_encodeCanvasFramesToMp4`
      加第 6 個參數 `extra = {audioBuffer, captionSegments, captionStyle}`：
      - `audioBuffer` 有值 → 改走 **Mediabunny `Output` + `CanvasSource`
        + `AudioBufferSource`**（`avc` 5Mbps／`aac` 160kbps），舊的
        `mp4-muxer` 路徑只有影像軌、留給無音軌情況。
      - `captionSegments` 有值 → 用一個中介 2D canvas
        （`compositeCtx.drawImage(來源canvas)` + `_faDrawSubtitle`）逐幀
        合成，這樣 WebGL 來源 canvas（3D 場景）也能疊字幕。
    - `_faWrapSubtitleLines` / `_faDrawSubtitle`：**主執行緒版**的字幕
      繪製（跟 `FA_BURN_SUBTITLES_WORKER_SRC` 裡 worker 的
      `_wrapLines`/`_drawSubtitle` 是同一份邏輯的兩份拷貝，改字幕外觀
      要兩邊一起改）。`_export2DAnimationToMp4`/`_exportSceneToMp4` 的
      `opts` 也接 `audioBuffer`/`captionSegments`/`captionStyle` 透傳。
    - media_av domain `toolNames` 補上 `compose_video` + 動畫工具
      （`render_2d_animation`/`render_3d_scene`/`get_2d_animation_yaml`/
      `get_3d_scene_yaml`/`get_3d_scene_topic`），systemPrompt 改寫成完整
      「影片→動畫版」流程指引。**沒有** `/media-compose-video` slash——
      合成需要 LLM 設計動畫，不像其他三個 `/media-*` 是純機械轉換。
    - 實測（`_compose_test.html`，已刪）：2D 動畫 YAML＋3s tone WAV＋
      2 段 inline 字幕 → 3.01s 輸出、`video=avc audio=aac`、字幕確實燒進
      像素（t=2s 底部偵測到白字＋半透明黑底）、耗時 ~1.1s。
  - **2026-09-11 追加（Whisper 模型 GitHub 備份分支 + 退路）**：
    - 使用者要求：repo 要有一個 single-commit 分支放同一份 Whisper q8 模型
      （大檔切 20MB 一份），HuggingFace 抓不到時從 GitHub 取回合併。
    - `web/tools/build-whisper-backup-branch.mjs`（Node 16 相容，用 `node:https`
      不用 `fetch`）：從 HF 抓 `dtype=q8` 實際用到的 7 個檔
      （`WHISPER_MODEL_BACKUP_FILES`：config/preprocessor_config/tokenizer_config/
      tokenizer/generation_config + `onnx/encoder_model_quantized.onnx` 23.2MB +
      `onnx/decoder_model_merged_quantized.onnx` 53.7MB），>20MB 切成
      `.part000..` + 產 `manifest.json`（`{files:[{path,size,sha256,parts}]}`）
      到 `web/tools/_whisper-backup-staging/`（gitignored）。加 `--commit` 在
      暫存 clone 裡建 orphan 分支 `whisper-model-backup`（目錄 `whisper-base-q8/`）
      並 commit，`--push` 才 force-push（不碰使用者工作樹）。
    - `FA_ASSET_URLS.whisperModelBackupBase`（預設
      `raw.githubusercontent.com/sunneo/tw_stock_db/whisper-model-backup/whisper-base-q8/`，
      `setAssetUrls` 可覆蓋）。
    - `_prefetchWhisperModelFromRepo(onProgress)`：讀 manifest → 每個檔抓
      `.partNNN` 合併回 Blob（驗 size）→ 用 transformers.js 真正 fetch 的
      **HF 完整 URL**（`WHISPER_HF_RESOLVE_BASE + path`）當 key `cache.put` 進
      `transformers-cache`。沒 manifest 時退回內建清單、單檔失敗再試分片。
    - `_getWhisperTranscriber`：`mod.pipeline(...)` 包 try/catch，失敗且
      `!this._whisperRepoFallbackTried` 時跑退路再重試一次（cache 命中、不碰 HF）。
      `_clearWhisperCache` 會把 `_whisperRepoFallbackTried` 重設。
    - 實測（本機 serve staging 當備份來源、以及對實際推上去的 GitHub 分支）：
      prefetch 76MB / 7 keys size 全對、transformers.js 建 pipeline
      **0 次 huggingface.co 請求**、silence 推論正確回 `[BLANK_AUDIO]`。
  - **2026-09-12 追加（transcribe_media 運算裝置偏好）**：
    - 使用者回報某些機器 WebGPU 反而比 CPU 慢。新增
      `advancedSettings.whisperDevicePreference`（`'auto'` 預設／`'cpu'`）。
      `_transcribeMedia` 的 `deviceOrder`：`'cpu'` 時直接 `['wasm']`、
      連 `_isWebGpuAvailable()` 都不呼叫。
    - Advance Settings「子Agent」分頁的影音區塊：原本只有「CPU 執行緒數」，
      上面加一個「運算裝置」下拉（自動／只用 CPU）。改動後清掉
      `_whisperTranscriber` 讓下次轉錄重挑。
  - **2026-09-12 追加（轉錄語言預設中文、不自動偵測）**：
    - 使用者要求：`/media-transcribe`、`/media-burn-subtitles`（自動轉逐字稿時）
      跟 `transcribe_media`/`burn_subtitles` 工具，language 不填一律當
      **中文（zh）**，不做語言自動偵測（Whisper-base 自動偵測不可靠）。要
      英文才明寫 `en`。slash 指令的 `[zh|en]` token 仍可覆蓋。
    - `task` 維持 `'transcribe'`（不是 `'translate'`）——講者中英夾雜時輸出
      照原樣保留英文，屬正常、不是辨識錯誤。工具描述也照這個講法改寫。
  - **2026-09-12 修正（一次附加 mp4＋srt 時 /media-burn-subtitles 挑錯檔）**：
    - 症狀：使用者同時附加 `x.mp4` 跟 `x.字幕.srt` 後直接 `/media-burn-subtitles`
      （不帶參數），`_resolveUploadedFileRecord('')` 取「最後一個附件」＝ `.srt`，
      當成影片拿去 `decodeAudioData` → `Unable to decode audio data`。
    - `_faClassifyMediaFile(filename)`：依副檔名分 video/audio/subtitle/other。
    - `_handleMediaBurnSubtitlesCommand`：沒帶參數時掃 `_pendingAttachments`，
      影音檔當來源、字幕檔（.srt/.vtt/.ass…）當字幕，兩個都從清單消化；
      解析出來的「影片」若其實是字幕檔就擋下來給明確提示。
    - `_resolveUploadedFileRecord` 加 `preferAv` 選項（`/media-transcribe`／
      `/media-extract-audio`／burn 都帶）：空參數挑附件/最近上傳時優先選
      影音檔，不會抓到一起附加的 `.srt`。
  - **2026-09-12 追加（extract_audio 預設輸出 MP3）**：
    - 使用者要求：WAV 太占 persistentStorage 空間。新增 `lamejs`（純 JS MP3
      編碼器，UMD 全域腳本，`_faLoadScriptOnce` 載入）＋
      `_faLamejsEncode(channelsInt16, sr, kbps)`/`_faFloat32ToInt16` 兩個
      module-level 共用函式、`_ensureLamejsLoaded()`/`_encodeMp3(audioBuffer)`
      instance方法。`advancedSettings.extractAudioFormat`（`'mp3'`預設／
      `'wav'`）控制，MP3編碼失敗（載入失敗等）優雅退回WAV，不讓功能整個
      失敗。Advance Settings「子Agent」分頁新增下拉。
    - 實測：1s 44.1kHz WAV→MP3(128kbps)：96KB→16.5KB（約1/5.8）、解碼回去
      驗證時長正確。
  - **2026-09-12 追加（text_to_speech 語音合成，Kokoro TTS）**：
    - 使用者要求：`/media-text-to-speech <prompt> [聲音id]`＋語音庫可從
      Advance Settings安裝到persistentStorage、語音包獨立一組可個別
      安裝/刪除。
    - **重要限制（已實測確認，不是猜測）**：只支援英文。研究過程：
      (1) `kokoro-js`（官方推薦的瀏覽器JS wrapper）npm套件本身的
      `_validate_voice`把語言代號寫死成`voice.at(0)`只認`'a'`(美式)/`'b'`
      (英式)，voice清單也寫死只有28個英文語音，中文voice代號（`zf_*`等，
      HF模型repo裡的`.bin`檔確實存在）直接被拒絕。(2) 改用
      `@huggingface/transformers`通用`pipeline('text-to-speech',...)`指向
      HF上專門的中文模型`onnx-community/Kokoro-82M-v1.1-zh-ONNX`——實測
      拋錯`Unsupported model type: style_text_to_speech_2`，這個model_type
      根本沒被transformers.js的通用pipeline dispatcher支援，只有kokoro-js
      自己手動兜的`StyleTextToSpeech2Model`路徑能用，而那條路徑的G2P是
      英文專屬的。(3) Meta的MMS-TTS（另一個多語言選項）沒有涵蓋中文
      （`facebook/mms-tts-cmn`不存在）。**結論**：瀏覽器端目前沒有可驗證
      可靠的中文TTS方案，`text_to_speech`工具/`_synthesizeSpeech`主動用
      `_looksLikeCjkText()`（CJK字元占比>20%）擋下中文文字，回傳明確錯誤
      而不是嘗試硬讀（會讀出錯誤的音），media_av systemPrompt也交代AI
      遇到使用者要中文語音要照實告知限制。
    - **⚠️2026-09-12實測發現：這個模型走WebGPU在部分環境會直接把GPU裝置
      卡死**（`DXGI_ERROR_DEVICE_HUNG`，onnxruntime-web的WebGPU backend對
      Kokoro/StyleTTS2這個模型結構有問題，推論永遠不回來，不是「比較慢」
      是真的掛住）——`_getTtsEngine`因此**一律用CPU wasm，不嘗試
      WebGPU**（跟Whisper的auto/cpu選項不同，刻意不給選）。CPU路徑實測：
      模型下載92.4MB/7個檔＋一句~20字英文推論，首次（含tokenizer/session
      建立）約50~70秒（WASM單執行緒，沒有crossOriginIsolated），輸出正確
      可解碼MP3。
    - 常數：`TTS_MODEL_ID`(`onnx-community/Kokoro-82M-v1.0-ONNX`)、
      `TTS_DTYPE`(`q8`，模型本體約90MB)、`TTS_SAMPLE_RATE`(24000)、
      `TTS_VOICES`(28個內建英文語音，抄自kokoro-js的voices.js)、
      `TTS_VOICE_CACHE_NAME`(`'kokoro-voices'`)、`TTS_VOICE_DATA_URL_BASE`。
    - **語音包天生獨立管理**（使用者要求的「獨立一組」）：kokoro-js自己
      用一個獨立的Cache API物件`"kokoro-voices"`持久化每個語音的`.bin`
      （522KB/個，跟模型本體、跟Whisper都不同的cache）——不用我們自己另外
      實作快取層，`_listInstalledTtsVoices`/`_installTtsVoice`/
      `_deleteTtsVoice`直接讀寫這個Cache即可。模型本體（onnx+tokenizer）
      沒得選，跟Whisper共用同一個`'transformers-cache'`（
      `@huggingface/transformers`固定用這個名稱），`_getTtsCacheInfo`／
      `_clearTtsModelCache`用URL含`'Kokoro'`子字串篩選/清除，效果上等同
      獨立管理。
    - `_synthesizeSpeech(text, voiceId, onProgress)`：CJK擋下→挑語音→
      `_ttsChunkText`依句尾標點切段（每段≤400字元，避免超過kokoro-js內部
      509 token限制丟字）→逐段`engine.generate()`→接起Float32樣本→
      預設MP3編碼（沿用`_faLamejsEncode`，跟extract_audio同一個「省空間」
      決策）失敗才退WAV→存fileCache。
    - 工具`text_to_speech({text, voice?})`＋slash
      `/media-text-to-speech <英文文字…> [聲音代號]`（trailing token剛好
      完全符合某個voice id才當作聲音代號抽掉）＋`/media-list-voices`（列出
      全部28個代號）。media_av domain toolNames/systemPrompt加入。
    - Advance Settings「子Agent」分頁新增「語音合成子Agent」區塊：預設
      語音下拉（28選項）、模型快取用量+清除、語音包管理（安裝下拉+按鈕、
      已安裝清單各自一個刪除按鈕）。
    - 實測：CJK文字秒退（不下載模型）；英文合成CPU路徑成功（7.1s輸出，
      MP3 114KB，解碼驗證duration/sr正確）；語音包安裝/刪除/列舉正確；
      設定面板渲染正確（模型88.1MB/7檔、4個已安裝語音、24個可安裝選項）；
      slash指令trailing voice token解析正確；長文字分段（1000字元→3段、
      每段≤400）正確。
  - **2026-09-12 追加（中文語音走API轉接：Microsoft Edge神經網路語音）**：
    - 使用者要求：本地Kokoro只支援英文，中文改用API轉接層，並實際點名
      Microsoft Edge的神經網路語音（免費、不用金鑰）。研究/驗證過程：
      (1) 用真實瀏覽器`WebSocket`直連`speech.platform.bing.com`（照舊版
      `edge-tts@1.0.1`的協定）→ code 1006連線被拒（Microsoft驗證Origin
      header，瀏覽器JS設不了）。(2) 用Node.js `ws`套件（可以自訂header）
      照同一份協定連 → HTTP 403——查到2026-09仍在維護、下載量最大的
      `node-edge-tts@1.2.10`原始碼，發現Microsoft後來加了`Sec-MS-GEC`
      簽章要求（時間戳無條件捨去到5分鐘邊界＋固定token做SHA-256）。
      (3) 照這個新版協定重新實作、用Node.js對`speech.platform.bing.com`
      送真實請求 → **成功**，拿到5.66秒、可播放的中文MP3（`ffprobe`驗證
      duration正確、xxd確認MP3 magic bytes+LAME header）。
    - 因為瀏覽器JS設不了`Origin`/`User-Agent`等自訂header、Microsoft的
      服務只接受特定Origin，改走Cloudflare Worker轉接（跟`/browser-search`
      同一個「瀏覽器做不到、Worker代勞」的既有模式）：新路由
      `POST /edge-tts`（`web/cloudflare-worker/worker.js`的
      `handleEdgeTts`）——`fetch(msUrl, {headers:{Upgrade:'websocket',
      Origin:...}})`（Cloudflare官方文件記載的outbound WebSocket+自訂
      header手法）→`.webSocket.accept()`→送`speech.config`+`ssml`兩則
      文字訊息→收二進位音訊frame（`Path:audio\r\n`分隔）→`turn.end`後
      關閉、把累積的MP3位元組原樣回傳。`edgeTtsGenerateSecMsGec()`用Web
      Crypto(`crypto.subtle.digest`)算SHA-256，跟node-edge-tts參考實作的
      node:crypto版本等價。（這個版本部署後實測跑不動，除錯過程跟最終
      修好的版本見下面「`/edge-tts` 真實部署除錯」那一條。）
    - `floating-assistant.js`：`TTS_API_VOICES`（12個精選Edge語音：
      中文台灣3個/中國大陸4個/粵語香港2個/日文/韓文/英文各1個，
      `engine:'api'`）＋`TTS_VOICES`全部28個補上`engine:'local'`tag，
      voice id格式天生可判斷engine（本地`xx_name`底線格式 vs API
      `xx-XX-NameNeural`連字號格式）。`advancedSettings.ttsApiEnabled`
      （預設**關閉**，跟`browserSearchEnabled`同一個理由）、
      `ttsApiProxyUrl`（留空依序fallback到`browserSearchProxyUrl`→
      目前LLM apiUrl，同`browser_search`的既有模式）、
      `ttsDefaultApiVoice`（預設`zh-TW-HsiaoChenNeural`曉臻）。
    - `_synthesizeSpeech`改成路由器：有給voice→依engine分派；沒給→
      `_looksLikeCjkText`判斷，CJK且API已啟用→API＋預設中文語音，CJK但
      API未啟用→明確錯誤（附啟用方式，不再是死路）,非CJK→本地Kokoro。
      `_synthesizeSpeechLocal`（原本的Kokoro邏輯，改名）／
      `_synthesizeSpeechViaApi`（新增：`_ttsChunkText`現在接受
      `maxChars`參數、且分句regex加入中文標點`。！？；`當切點，
      API路徑用`TTS_API_MAX_CHARS_PER_CHUNK`=1800字元；逐段POST
      `{proxyUrl}/edge-tts`、直接串接回傳的MP3 Blob——不像本地路徑要
      解碼混音重新編碼，Worker回傳的本來就是MP3）。API語音沒有duration
      資訊，用粗略估計（中文約4字/秒）當顯示值。
    - 工具/slash描述、media_av systemPrompt、`/media-list-voices`（分
      「本地」/「API」兩個section，API section顯示目前啟用/未啟用狀態）
      全部更新反映新路徑。
    - Advance Settings新增「語音合成子Agent —— 中文語音（API轉接）」
      區塊：啟用checkbox、Worker端點網址輸入框、預設中文語音下拉——跟
      本地英文語音那個區塊分開放，明確標示這條路徑「文字會離開瀏覽器」
      的差異。
    - 實測（mock `fetch`模擬Worker回應，因為當時沒有真實部署可測）：CJK+API
      關閉→明確錯誤；CJK+API開啟→自動選zh-TW-HsiaoChenNeural、正確組
      lang參數；明確指定日文/中文API voice→正確使用；長文字(2400字元)→
      正確切成2段、各自呼叫、MP3正確串接；設定面板checkbox/輸入框/下拉
      渲染+存檔正確；`/media-list-voices`兩個section+啟用狀態顯示正確。
  - **2026-09-12 追加（`/edge-tts` 真實部署除錯，三個Cloudflare Workers
    runtime特有的bug）**：使用者實際部署`worker.js`到
    `dawn-disk-778c.sunneo529.workers.dev`後，協定本身（已經用Node.js對
    Microsoft伺服器驗證過正確）在Workers環境完全跑不動，靠使用者一輪輪
    curl測試+回報才抓出來，全部不是協定公式的錯，是Workers runtime的
    outbound WebSocket實作跟Node.js/瀏覽器行為不一樣：
    1. `fetch()`走`Upgrade:websocket`時URL要是`https://`不能是`wss://`
       （`"Fetch API cannot load: wss://..."`）。
    2. 修完(1)後連線成功但`audioChunks.length===0`——加了診斷欄位
       （收到的文字/二進位訊息內容、close code）才發現`turn.end`分支
       之前無條件`resolve({ok:true})`沒檢查`audioChunks`，把診斷資訊
       都吞掉了，回到外層只看到一句籠統訊息。
    3. 修完(2)後看到真正的診斷：連線/訊息交換都正常（`turn.start`/
       `response`/`turn.end`都收到），但**唯一一則二進位訊息是0
       bytes**——查到`DIYgod/cloudflare-edge-tts`（真的部署在Cloudflare、
       有使用者在用的開源實作）的原始碼，發現Workers上binary WebSocket
       訊息的`event.data`有時是`Blob`不是`ArrayBuffer`，
       `new Uint8Array(blob)`不會報錯、只會靜默產生0長度陣列——完全對上
       症狀。同時發現之前照抄node-edge-tts（純Node.js套件）的協定細節在
       Workers環境缺了幾樣東西：URL要帶`ConnectionId`、header要加
       `Sec-WebSocket-Version:13`+`Cookie:muid=<隨機值>;`；二進位frame
       正確格式是「前2 bytes big-endian長度＋文字header＋音訊body」，不是
       土法煉鋼搜尋`"Path:audio\r\n"`子字串（這招在Node.js剛好搜得到，
       但不是正式協定）。全部照`DIYgod/cloudflare-edge-tts`的寫法改掉
       （`edgeTtsToUint8Array`處理Blob、`edgeTtsParseBinaryFrame`用長度
       前綴、拿掉沒用的`Origin`header——參考實作根本沒送這個）。
    - **最終在真實部署上端到端驗證成功**：`curl`直打`/edge-tts`→HTTP
      200、`audio/mpeg`、20160 bytes、`ffprobe`驗證3.36秒、`file`指令
      確認是正確的MPEG Layer III 24kHz/48kbps mono；瀏覽器端`fa.
      _synthesizeSpeech()`（自動CJK路由）跟`fa.tools['text_to_speech']`
      （真正的AI工具callback路徑）都對著真實Worker測過，拿到可解碼、
      時長吻合的MP3（6.4秒故事文本測試）。三個樣本檔都已傳給使用者
      聽過。`README.md`「已知限制」的「沒辦法部署測試」那條已經拿掉，
      改成記錄這次除錯過程本身。

- **2026-09-12 新增（輸入框🎤語音輸入按鈕，不是工具，是根層級UI功能）**：
  使用者要求：跟transcribe_media共用同一份Whisper模型/快取，不是另一套
  辨識邏輯，用Advance Settings新分頁「輸入」開關控制，第一次用要先跳確認框
  說明會下載模型、按確定才下載並要求麥克風權限，操作方式是點一下開始錄音
  （按鈕變成⏹️）、再點一下停止並辨識。
  - HTML：`#ai-mic-btn`（🎤），放在`#ai-input-text`跟`#ai-send-btn`中間，
    預設`style="display:none"`（不是`.hidden`——這個檔案的`.hidden`只對
    `.ai-advanced-pane`生效，一般元素直接控制inline style）。
  - Advance Settings新增分頁：sidebar `.ai-advanced-cat[data-cat="input"]`
    「輸入」＋對應pane，只有一個checkbox「啟用語音輸入」
    （`#ai-voice-input-enabled-chk`）＋說明文字。分頁切換本身是既有的
    通用`data-cat`/`data-pane`比對機制，新增分頁不用額外寫JS。
  - `advancedSettings.voiceInputEnabled`（預設**關閉**，跟browser_search/
    TTS API同樣理由：要下載模型、要跟使用者要麥克風權限，不該預設出現）。
    勾選/取消即時呼叫`_updateVoiceInputButtonVisibility()`顯示/隱藏按鈕，
    不用重新整理頁面。
  - `_wireVoiceInputButton(inputText)`／`_handleMicButtonClick`：閒置時
    點擊→`_getWhisperCacheInfo()`檢查模型是否已快取→沒快取才跳
    `confirm()`（使用者取消就整個中止，**不會**呼叫`getUserMedia`）→
    `navigator.mediaDevices.getUserMedia({audio:true})`要麥克風權限→
    `_startVoiceRecording`（`MediaRecorder`，優先選
    `audio/webm;codecs=opus`，逐一嘗試fallback格式）。錄音中再點一次→
    `recorder.stop()`→`onstop`裡釋放麥克風track、把錄到的Blob丟給
    `_recognizeVoiceInput`。
  - `_recognizeVoiceInput(blob, btn, inputText)`：`_decodeAudioForWhisper`
    解碼→跟`_transcribeMedia`同一套device fallback
    （`whisperDevicePreference`／WebGPU可用性）→
    `_getWhisperTranscriber`＋`_runWhisperWindowed`（跟transcribe_media
    共用，處理錄超過30秒的情況；語言固定`'zh'`，跟這個專案其餘語音功能
    一致不做自動偵測）→辨識出的文字接到輸入框現有內容後面（空白分隔，
    不覆蓋、不自動送出，使用者可以先看/改再按送出）。失敗/沒辨識出文字
    都有對應的`_log`警告，按鈕一律在`finally`重設回🎤／可點擊狀態，不會
    卡住。
  - 實測（mock `getUserMedia`/`MediaRecorder`/whisper底層函式，因為
    自動化瀏覽器工具沒有真的麥克風裝置）：預設隱藏→啟用後顯示；模型未
    快取＋使用者取消確認框→**不會**呼叫`getUserMedia`；模型已快取→
    **不會**跳確認框、直接要權限錄音；完整開始/停止狀態機（按鈕文字/
    背景色切換、麥克風track正確釋放）；辨識成功正確接回輸入框既有內容
    後面；辨識失敗/辨識出空字串都有對應警告且不會讓輸入框內容跑掉、
    按鈕正確恢復可點擊。

- **2026-09-12 新增「配音小幫手」（`start_dubbing_session`工具＋互動widget）**：
  使用者要求：針對一支影片的逐句字幕，一句一句提示使用者錄音配音（例如
  把外語對話換成使用者自己的聲音），用一個有上一頁/下一頁、可以看到那句
  話關鍵影格截圖的互動widget呈現，可以隨時輸出目前錄好的成果看效果、或
  結束配音。
  - **踩到的一個渲染架構bug**：一開始把widget訊息寫成`{role:'assistant',
    content:...}`，widget完全沒出現、只看到一句純文字。查`_renderSingleMessage`
    才發現`_progressWidget`/`_displayScene3DYaml`等等所有「特殊widget」
    判斷式全部包在`if (msg.role === 'tool')`這個大分支裡面，
    `role:'assistant'`的訊息根本進不去、被更早的一般文字訊息渲染邏輯接走
    了。改成跟`_createProgressWidget`同一個慣例——`role:'tool'`、
    `content`留空（真正的說明交給widget本身呈現）——才正確顯示。
  - **踩到的一個關鍵影格全黑bug**：第一頁（t=0）的截圖永遠是全黑，其他頁
    正常。原因是`_seekVideoTo`（第一版用`<video>`+seek實作）在
    `currentTime`已經等於目標時間時直接return不等待——但這只保證影片
    metadata（尺寸/時長）讀到了，不保證第0幀真的解碼完成可以畫；瀏覽器對
    「設定成一樣的currentTime」不會觸發`'seeked'`事件，原本的程式碼因此
    完全不等，畫出一張還沒解碼的黑畫面。（這個bug在後續改用Mediabunny
    CanvasSink後不再適用，但診斷過程本身值得記錄。）
  - **效能問題與架構改版（最重要的一次修正）**：第一版關鍵影格截圖／最終
    匯出的畫面來源都用`<video>`標籤seek+canvas截圖，理由是「音軌替換、
    影像完全不變」這個操作模式，用Mediabunny的`Conversion` API能不能做到
    「影像passthrough＋音軌換成自訂buffer」當下沒有把握（跟burn_subtitles
    「逐格畫字幕」、compose_video「動畫產生新畫面」的既有用法都不一樣），
    為了避免重演edge-tts那種要來回好幾輪部署才抓到根因的除錯過程，先用
    確定會動的`<video>`方式。**實測發現這是災難級的效能問題**：一支12秒
    測試短片，逐格seek要跑220秒以上（約18倍real-time）——對「隨時輸出看
    效果」這個核心賣點完全不能用（一支3分鐘影片會需要55分鐘才能匯出一次）。
    查Mediabunny官方文件（https://mediabunny.dev/guide/media-sinks）找到
    `CanvasSink`：`canvasesAtTimestamps([...])`（稀疏查詢，一次查多個
    時間點，內部避免重複解碼同一個packet）跟`canvases()`（循序解碼
    async iterator，只解碼一次、不重複seek）——純decoder-based、不透過
    `<video>`播放/seek管線，正好呼應使用者先前對burn_subtitles的「不要
    video tag、要用decoder」要求。改用後同一支影片：關鍵影格（3個時間點）
    4.1秒→3.4秒，完整匯出（288幀，約12秒份的影片內容）從220+秒降到
    **6.1秒（循序解碼）／4.1秒（含混音+編碼的完整匯出）**，約2倍real-time，
    效能落差35倍以上。
  - `_getMediabunnyVideoTrack(blob)`：`new MB.Input({formats:ALL_FORMATS,
    source:new MB.BlobSource(blob)})`+`getPrimaryVideoTrack()`。
    `_createVideoFrameCursor(canvasSink)`：包一層在`canvases()`這個async
    iterator外面，用一幀lookahead buffer做「輸出時間t落在[目前幀,下一幀)
    之間就沿用目前幀」的對齊邏輯，讓輸出fps（`DUBBING_EXPORT_FPS`=24）
    跟來源影片實際fps不同也不會隨時間累積誤差；來源解碼完之後（配音比
    原片長）全部輸出時間沿用最後一幀（維持最後畫面，不會變黑）。
    `_canvasElementToBlob`：CanvasSink在主執行緒給`HTMLCanvasElement`
    （`.toBlob`是callback式），worker context才會退回`OffscreenCanvas`
    （`.convertToBlob`是Promise式），兩種都處理。
  - `_startDubbingSession(record, subtitleArg, onProgress)`：跟
    burn_subtitles共用`_resolveSubtitleSegments`（字幕檔或自動先轉逐字稿，
    語言固定`'zh'`）→`CanvasSink.canvasesAtTimestamps()`稀疏查詢每句
    開始時間的關鍵影格（存成JPEG進fileCache，寬度上限
    `DUBBING_KEYFRAME_MAX_WIDTH`=240）→建立`_dubbingWidget`訊息。
  - `_mountDubbingWidget(container, msg)`：整個widget用一個內部
    `renderPage()`重繪函式管理（不是每次操作都觸發整個訊息列表
    `_renderMessageHistory()`——換頁/錄音/試聽這種互動頻繁的操作，整包
    重繪代價較高、也容易在錄音途中把DOM砍掉重建）。每頁顯示：頁碼、關鍵
    影格、字幕文字、試聽（如果已錄）、錄音/重新錄音按鈕、上一頁/下一頁、
    輸出目前成果/結束配音。`this._dubbingRecorder`/`_dubbingRecordingPage`
    是widget層級共用狀態（一次只能錄一頁，其他頁的錄音按鈕/換頁按鈕會
    disabled）。
  - `_handleDubbingRecordClick`：跟輸入框🎤語音輸入同一套`MediaRecorder`
    手法，差別是錄完不做語音辨識，直接存原始錄音當這一頁的配音檔（給
    `_exportDubbedVideo`混音、給使用者試聽）。
  - `_exportDubbedVideo(state, onProgress)`：解碼原始音軌
    （`_decodeAudioBuffer`）＋解碼每一句已錄的配音音軌→用
    `OfflineAudioContext`混音（`GainNode`在每個「已配音」的時間段把原始
    音軌自動化到0、同時在那個時間點插入配音音軌，兩者一次算出來，不是
    先剪接原始音檔）→`_createVideoFrameCursor`循序解碼原始畫面（完全不變，
    純passthrough）→沿用既有的`_encodeCanvasFramesToMp4`（跟compose_video
    共用同一個「canvas幀+自訂audioBuffer」Mediabunny編碼路徑，這裡把
    `renderFrameFn`改成`async`才能在裡面`await`游標推進——見
    `_encodeCanvasFramesToMp4`的異動說明）。沒配音的句子維持原音，可以在
    任何進度按輸出看效果。
  - `advancedSettings.voiceInputEnabled`不影響這個功能（配音小幫手的錄音
    permission/MediaRecorder跟輸入框🎤是各自獨立的功能，只是共用同一套
    `MediaRecorder`手法）。
  - `_persistChatHistory`/`_loadPersistedChatHistory`新增`dubbingMap`（跟
    `scene3DMap`/`anim2dMap`同一套「非可枚舉屬性額外存一份」既有模式）——
    這個widget的互動狀態（已錄哪幾句、頁碼、關鍵影格/錄音的file_id）
    如果重新整理頁面就不見，使用者辛苦錄的東西會全部白錄，所以一定要
    進這個既有的持久化機制，不能像`_progressWidget`那樣當作純ephemeral
    狀態處理。
  - media_av domain toolNames/systemPrompt加入`start_dubbing_session`；
    工具描述明確交代「widget建立成功後AI不用再問要不要繼續、不用描述
    後續步驟」，避免子agent畫蛇添足。
  - 實測（真實12秒測試片段，非mock）：關鍵影格擷取全部正常（含修過bug
    後的第0秒那一幀）；完整錄音/換頁/試聽/停止/結束配音狀態機（mock
    `getUserMedia`/`MediaRecorder`，環境沒有真麥克風）；匯出正確性用
    zero-crossing-rate驗證——餵一段1kHz純音當配音，匯出後解碼該時間段
    量到約2000次過零/秒（1kHz正弦波理論值剛好2000），RMS約0.353（0.5
    振幅正弦波理論RMS），跟前後原始音軌時段的zero-crossing特徵/RMS明顯
    不同，證實混音時原始音軌確實在配音時段被正確靜音、配音音軌確實被
    正確插入，不是簡單疊加或完全沒替換到。

- **2026-09-12 配音小幫手三項延伸：時間段配音／上傳音檔／獨立domain＋斜線指令**：
  使用者要求：(1) 使用者可以直接指定一個時間段配音，不用整支轉逐字稿；
  (2) widget互動時除了按麥克風錄音，也能直接上傳音檔；(3) 配音功能改歸到一個
  獨立的「影片編修」domain（不再混在media_av裡），也要有`/media-`開頭的斜線
  指令可以直接觸發（不經過LLM）。
  - **`_parseTimeValue(v)`**：新增的共用時間解析helper，接受純數字（當秒數）、
    `"M:SS"`、`"H:MM:SS"`（可選`.mmm`/`,mmm`毫秒），無法解析回傳`null`。斜線
    指令的時間範圍token、`start_dubbing_session`工具的`ranges`參數都共用這個
    函式，只寫一次解析邏輯。
  - **`_startDubbingSession`新增第4個參數`explicitRanges`**：有值時完全跳過
    `_resolveSubtitleSegments`（不呼叫字幕解析、不會觸發自動轉逐字稿），直接
    把每筆`{start,end,text}`轉成頁面（`end`留空自動補`start+1`秒，`text`留空
    自動補時間範圍字串），其餘關鍵影格擷取/建立widget邏輯完全共用不變。實測
    （真實測試短片＋`_resolveUploadedFileRecord`拿到的record）：給2筆range
    （其中1筆`end`留空、1筆`text`留空）正確產生2頁、關鍵影格正確擷取、全程
    沒有呼叫任何逐字稿相關函式（用`console.log`確認`_resolveSubtitleSegments`
    未被觸發）。
  - **`start_dubbing_session`工具schema新增`ranges`參數**（陣列，每筆
    `{start,end?,text?}`），description明確交代兩種用法的取捨（給ranges＝快、
    不需要字幕；不給＝整支字幕逐句一頁）；`ranges`存在時完全忽略`subtitle`
    參數。
  - **`_handleDubbingUpload(file, state, pageIdx, rerender)`**：新增的上傳
    處理函式，直接把使用者選的音檔存進`fileCache`（檔名帶頁碼、副檔名沿用
    原始檔案），寫回`state.pages[pageIdx].takeFileId`後持久化＋觸發widget
    重繪——跟錄音完成後的效果完全一樣（`_exportDubbedVideo`混音時不分辨這段
    配音是錄的還是上傳的，統一當作`takeFileId`處理）。`_mountDubbingWidget`
    的錄音按鈕那一列改成flex row，右側加一個「📁 上傳音檔」按鈕＋隱藏的
    `<input type=file accept=audio/*>`，正在錄音時disabled（避免錄音與上傳
    同時對同一頁寫入衝突）。實測：上傳一個假音檔後`takeFileId`正確寫入、
    `fileCache`裡確實存在該筆、重繪callback有被觸發。
  - **domain拆分**：`SUBAGENT_DOMAIN_REGISTRY.media_av`移除`start_dubbing_session`
    （toolNames與systemPrompt的說明段落都拿掉，補一句「配音是另一個領域，
    委派過去」避免它自己嘗試處理），新增`video_editing`domain（`toolNames:
    ['start_dubbing_session','list_uploaded_files']`，systemPrompt描述新的
    ranges用法）。這個專案的domain機制在9/6已經改成instance-level的
    `this.domains`（建構子從`SUBAGENT_DOMAIN_REGISTRY`複製一份，見
    `_routeTaskToDomains`等處都讀`this.domains`不是直接讀module常數），所以
    module常數這裡改完，委派路由（`_routeTaskToDomains`依`this.domains`動態
    組出的路由system prompt）自動就會反映新domain，不需要另外改別的查找點。
    實測：new一個實例後`fa.domains.media_av.toolNames`確認已移除、
    `fa.domains.video_editing`確認存在且內容正確。
  - **新斜線指令`/media-dub-video [<影片id或檔名>] [<開始>-<結束>]`**：
    `_parseDubRangeToken(token)`用正規表示式`^([\d:.,]+)-([\d:.,]+)$`判斷
    最後一個token是不是時間範圍格式（避免跟檔名裡的`-`混淆——檔名格式不會
    整段只由數字/冒號/逗號/句點加一個`-`組成），是的話呼叫`_parseTimeValue`
    解析成`{start,end}`並從token清單裡移除；剩下的token當檔案id/檔名。有
    range就走`explicitRanges`（不轉逐字稿）；沒有range就傳`null`給
    `_startDubbingSession`走既有的整支字幕流程（跟工具版`ranges`留空時完全
    同一條路徑，沒有另外寫一份邏輯）。指令本身先push一則`user`角色訊息代表
    這次操作（跟其他`/media-*`指令同樣的既有慣例），再呼叫
    `_startDubbingSession`（成功會自己建立widget訊息並渲染，指令這裡失敗才
    額外`_log`錯誤）。實測：`/media-dub-video <id> 1:00-2:00`正確解析出
    `{start:60,end:120}`、只產生1頁、頁面文字正確補成`"1:00 - 2:00"`；純數字
    `1:20-1:45`、`80-105`、帶毫秒`0:05-0:10,500`都正確解析；`my-video-file.mp4`
    這種帶`-`的檔名正確判斷「不是」時間範圍（不會被誤吃）。

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

- **2026-09-13 Skill（自訂工具）改走subagent domain委派，不再無條件掛根層級**：
  使用者要求：AI要能透過subagent啟動Skill，而不是像原本那樣每個Skill都無條件
  掛在根層級對話（`_getRootToolNames()`原本在`router`/`full`模式下也會
  `.concat(this.advancedSettings.customTools.map(t=>t.name))`）——Skill越加越多
  會塞爆根層級system prompt/tools、稀釋模型注意力。使用者明確澄清：**不是要
  發明新的技能包格式**（一開始筆者誤以為要仿Claude官方Skill系統做一套全新的
  bundle格式，被糾正「沒有不一樣，這個skill跟.skill,技能包一樣」）——這次動的
  就是這個專案既有的Skill機制（Advance Settings「Skill」分頁的
  `advancedSettings.customTools` + `.skill` zip匯出/匯入），格式完全不變，只改
  「會不會無條件曝光在根層級」這件事。
  - **`custom_skills`虛擬domain**（建構子，緊接`this.domains = Object.fromEntries(...)`
    之後）：跟9/6~9/9做好的內建工具domain委派機制共用同一套`_delegateToSubagentDomain`/
    `_routeTaskToDomains`/`_delegateToSubagentAuto`，差別只在`toolNames`故意用
    **函式**（`() => this.advancedSettings.customTools.map(t => t.name)`）而不是
    固定陣列，每次都即時讀`advancedSettings.customTools`——新增/編輯/刪除Skill
    不用另外通知這個domain更新，永遠反映當下狀態。
  - **`_resolveDomainToolNames(domain)`**（新helper）：`typeof domain.toolNames
    === 'function' ? domain.toolNames() : domain.toolNames`，統一陣列化。取代
    3處既有直接讀`domain.toolNames`/`d.toolNames`的地方
    （`_delegateToSubagentDomain`、`_routeTaskToDomains`的目錄迴圈、
    `_delegateToSubagentAuto`合併命中domain的toolNames）——這是唯一認得
    `toolNames`可以是函式的地方，其餘既有domain的`toolNames`都還是固定陣列，
    行為完全不受影響。`_routeTaskToDomains`的目錄迴圈跟
    `_buildDelegateToSubagentDescription()`的full模式清單都加上「resolve出來是
    空陣列就跳過」的過濾——使用者還沒建立任何Skill時，`custom_skills`不會出現在
    路由子agent的目錄裡、也不會出現在full模式的根層級domain清單裡（不列一個
    「這個領域目前沒有任何工具」的雜訊分類）。
  - **`_getRootToolNames()`**：`router`/`full`分支拿掉`.concat(custom)`（Skill
    不再無條件曝光，只能透過`custom_skills`domain委派觸及）；`'off'`模式（完全
    不用subagent）維持`.concat(custom)`**不變**——這個模式本來就沒有委派機制，
    Skill如果連根層級都拿掉會變成完全叫不到，跟其他內建工具在`'off'`模式下維持
    直接掛根層級是同一個既有邏輯。
  - **`_applyImportedSkillBundle({skillMdText, toolFileEntries, sourceLabel})`**
    （新函式，從原本`_importSkillZip`裡抽出的共用核心）：解析`tools/*.js`（開頭
    兩行`// name:`/`// description:`宣告）、跟內建工具同名則略過、跟既有
    customTool同名則`confirm()`是否覆蓋、`SKILL.md`文字附加進`rulesMd`、存檔+
    重繪+`_syncFromAI`。`toolFileEntries`是`[{path,text}]`中性形狀，zip/資料夾
    來源都能餵進來，兩種匯入管道行為完全等價、不會有兩份平行維護風險。
  - **`_importSkillFolder(dirHandle)`**（新函式，使用者要求的「系統上用專屬
    資料夾」）：用File System Access API（`window.showDirectoryPicker()`）讀
    `SKILL.md`+`tools/*.js`（`getFileHandle`/`getDirectoryHandle`/`entries()`），
    走到同一個`_applyImportedSkillBundle`。**刻意不持久化授權、不自動重新掃描**
    ——每次都是使用者主動點按鈕→選資料夾→立即匯入一次的單次動作，直接滿足
    「避免被當成自動載入」的訴求，不需要額外的IndexedDB store/權限管理機制。
    Advance Settings「Skill」分頁新增「從資料夾匯入」按鈕，`feature-detect
    window.showDirectoryPicker`（僅Chrome/Edge支援，不支援時disable+title提示，
    不是隱藏性功能缺失）；使用者在原生資料夾選擇對話框按取消丟出的`AbortError`
    安靜略過不跳錯誤框。
  - 實測（Browser工具，`new FloatingAssistant(...)`直接操作）：`custom_skills`
    domain在空Skill時`_resolveDomainToolNames`回傳`[]`；新增一個假Skill後
    `router`/`full`模式的`_getRootToolNames()`都不含它、`'off'`模式仍然含它
    （回歸測試通過）；`full`模式`_buildDelegateToSubagentDescription()`正確列出
    `custom_skills(使用者自訂技能(Skill))`；mock原生tool-calling走完整條
    `_delegateToSubagentDomain('custom_skills', task)`，確認`body.tools`只包含
    該Skill、真的執行到`_executeCustomTool`、正確回傳最終結論；mock一個假
    `FileSystemDirectoryHandle`（實作`getFileHandle`/`getDirectoryHandle`/
    `entries()`）呼叫`_importSkillFolder`，確認`rulesMd`/`customTools`正確更新、
    跟真實`.zip`匯入（重構後）行為一致（無回歸）；mock路由子agent回應確認
    `_routeTaskToDomains`的catalog正確包含`[custom_skills]`區塊、
    `_delegateToSubagentAuto`正確合併出對應的`toolNames`/`systemPrompt`。

- **2026-09-13 兩層domain路由（類別→細分domain）+ subagent執行中動態追加工具**：
  使用者計畫在piano-web新增「成噸」等級的subagent（音樂曲風分類，可能上百種），
  擔心既有扁平單層路由（`_routeTaskToDomains`一次列出全部enabled domain的目錄）
  在domain數大到這種規模時會塞爆路由子agent的注意力。用tw_stock_db既有的
  `tw_stock_db_api:{sessionId}`共用金鑰模式對`nvidia/nemotron-3-super-120b-a12b`
  做了真實LLM benchmark（3組規模：9/24/45個合成曲風domain，15個音樂類別）：
  45個domain時，兩層式比扁平式**省58%路由token**（3654→1531）但**延遲多6.7秒**
  （1991ms→8660ms，多一次序列化網路往返）；精準度測試（9道有標準答案的任務）
  扁平模式**真的漏判一題**（民謠木吉他分解和弦，45個domain候選同時列出時對排序
  較後面的domain注意力被稀釋），兩層式全對——這組實測數據直接決定了這次把兩層
  路由做成**選配模式**（domain少時不建議用）而不是取代現有機制。
  - **`this.domainCategories`**（建構子，`this.domains.custom_skills`賦值之後）：
    新的instance-level登記表，`{categoryKey:{label,description}}`，純路由用
    中繼資料，不含toolNames/systemPrompt。**`register_domain_category(key,
    {label,description})`**（公開方法，比照`register_domain`同一種模式）。
  - **`register_domain`新增選填的`category`參數**——domain掛到一個分類代號下
    才會被兩層路由當成「細分domain」，留空（現有全部內建domain都是）維持原本
    「獨立領域」扁平行為，完全向下相容。
  - **`_routeTaskHierarchical(task)`**（新函式，跟`_routeTaskToDomains`同一層級）：
    完全沒有任何domain帶`category`時直接委派給`_routeTaskToDomains`（不多花這次
    網路往返）；否則第一層問「要哪個類別/哪個獨立領域」，選中的每個類別**平行**
    （`Promise.all`）各自問一次「這個類別底下要哪個細分domain」——平行是關鍵，
    延遲取決於最慢的那一個類別查詢，不是隨選中類別數疊加。回傳跟
    `_routeTaskToDomains`完全同一個`{ok,domains,toolNames,systemPrompt}`形狀，
    `_delegateToSubagentAuto`第一行依`multiSubAgentMode`分支呼叫哪一個，其餘
    合併/執行邏輯不用區分呼叫端。
  - **`_callRouterLLM(systemPrompt, userText)`**（新函式，從原本
    `_routeTaskToDomains`裡抽出的共用fetch+解析邏輯）、
    **`_buildDomainCatalogSection(key, domain, toolByName)`**（新函式，
    `[key] label\n- tool: 摘要`這段目錄格式的共用建構）——`_routeTaskToDomains`
    跟`_routeTaskHierarchical`的三次路由呼叫（第一層1次+每個選中類別平行1次）
    都共用，避免貼三份幾乎一樣的邏輯。
  - **規劃階段（使用者要求「避免subagent失敗了才請求」）**：兩個路由函式的
    prompt都新增一句引導：「如果任務包含多個階段（例如先查詢/研究、再產生設計
    或報告），請把預期會用到的領域一次全部選出來，不要只選第一步用得到的；
    不確定時傾向選進來而不是保守省略」——刻意選擇**純prompt wording調整**（零
    額外LLM往返成本），不是加一輪獨立的「驗證夠不夠」呼叫，跟使用者對速度的
    顧慮一致；真正的保險是下一項機制。
  - **`request_additional_tools`偽工具（使用者要求「執行中發現不夠，原地
    追加，不要跳出去重跑」）**：`_runSubAgentTask`（floating-assistant.js
    ~14680起）的`allowedToolNames`改成`let`+可變複本（原本是`const`）——
    body.tools`在round迴圈裡每輪都重新用`allowedToolNames`重建，這個既有結構
    天生就支援「中途擴充、下一輪自動反映」，不用改迴圈結構。新增`resolveTool`
    區域函式，攔截`request_additional_tools`這個名稱（只在`allowedToolNames`
    非null，即來自domain委派時啟用；`_getFinalSystemPrompt()`預設情境本來就
    看得到全部工具，沒有「追加」的意義），callback內部呼叫
    `_routeTaskHierarchical`或`_routeTaskToDomains`（依`multiSubAgentMode`）
    找對應工具、直接`allowedToolNames.push(...newNames)`——**不是**巢狀呼叫
    `delegate_to_subagent`重新委派（那樣要重建全新system prompt/對話歷史，
    確實比較慢，是使用者明確要排除的做法）。`_buildNativeToolsSchema`新增
    選填第二參數`extraEntries`（原始`[name,tool]`陣列），讓這個「只在這次
    子任務執行內有效、不寫進`this.tools`」的偽工具也能出現在native
    tool-calling的schema裡；文字協定模式下domain委派的systemPrompt本來就不會
    自動列出工具清單（既有限制），這裡額外在systemPrompt後面補一句提示，讓
    文字協定模式的子agent也知道這個機制存在。新增常數
    `SUBAGENT_MAX_TOOL_ESCALATIONS = 3`防止單次子任務無限申請追加。這個機制
    掛在`_runSubAgentTask`本身，扁平/兩層/明確指定domain三條路徑（分別呼叫
    `_delegateToSubagentDomain`/`_delegateToSubagentAuto`的兩種路由）全部
    自動受益，不用個別修改。
  - **`multiSubAgentMode`新增第4個值`'hierarchical'`**：getter（原本
    `router`/`full`/`off`三選一）、建構子選項驗證、
    `_createDefaultAdvancedSettings`附近的enum陣列、UI change listener，共4處
    都加上`'hierarchical'`；Advance Settings下拉選單新增第4個選項＋hint文字
    （附上面實測的45個domain數字，明講「domain數量不多時不建議用」）。
  - 實測（Browser工具，真實mock情境，非猜測）：沒有任何categorized domain時
    `_routeTaskHierarchical`正確只打1次fetch（委派給扁平路由，不多花往返）；
    註冊2個類別+3個曲風domain後，單一類別命中（2次呼叫）、多類別平行命中
    （3次呼叫、正確合併toolNames/systemPrompt）都驗證正確；
    `request_additional_tools`端對端測試——第一輪只給1個domain工具、model
    呼叫追加工具、下一輪`body.tools`確認真的包含新舊工具、新工具真的能被
    成功呼叫，全程只有1個`_runSubAgentTask`執行（沒有跳出去重跑）；追加次數
    上限測試——連續5次申請，前3次成功各自加入不同工具，第4/5次被正確擋下並
    回報明確錯誤，不會無限追加。

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
