# AI 功能清單

> 這份檔案由 `node scripts/ai-features.js build` 從 `features/ai-features.yaml` 自動產生，請不要手改。

## 助理本身

對話、建議、模型與多代理人分工

### 建議操作（`suggest`）

一開始或清空對話後，顯示可以直接點的建議；輸入 /suggest 可以重新顯示。

- 可用平台：網頁版、桌面版
- 斜線指令：`/suggest`
- 範例：
  - `/suggest`

### AI 功能總覽（`ai-features`）

列出助理所有功能（依分類），也可以查單一分類或單一功能的說明與範例。

- 可用平台：網頁版、桌面版
- 斜線指令：`/ai-features`
- 子代理人領域：`feature_guide`
- AI 工具：`list_ai_features`
- 範例：
  - `/ai-features`
  - `/ai-features media`
  - `你有哪些功能？`
  - `怎麼把影片轉成逐字稿？`

### 專家子代理人分工（`subagent-delegation`）

複雜任務會自動委派給專門領域的子代理人（檔案解讀、3D、繪圖、影音、程式設計…），只把結論帶回主對話，不污染上下文。

- 可用平台：網頁版、桌面版
- AI 工具：`delegate_to_subagent`、`get_tool_details`
- 介面入口：設定 → 多代理人模式
- 範例：
  - `幫我用 3D 畫一個太陽系，並且做成可以旋轉的場景`

### 模型基準測試（`benchmark-model`）

對指定模型跑簡易回應、單一工具呼叫、完整多步驟報告三項測試並算加權總分，評估要不要內建。

- 可用平台：網頁版、桌面版
- 斜線指令：`/benchmark-model`
- 範例：
  - `/benchmark-model nvidia/nemotron-3-super-120b-a12b`

### 淺色／深色主題（`theme`）

上方列的主題按鈕切換淺色或深色，設定面板也會跟著換。

- 可用平台：網頁版、桌面版
- 介面入口：上方列主題按鈕

## 知識與自製函式

知識圖譜（RAG）、AI 自製函式、儲存常用腳本

### 知識圖譜（RAG）（`rag`）

把筆記或大文件存成知識節點，之後用自然語言查詢；大文件會自動分段。

- 可用平台：網頁版、桌面版
- 子代理人領域：`rag_lookup`、`rag_management`
- AI 工具：`rag_store_graph_node`、`rag_query_graph`、`rag_chunk_document`、`rag_delete`
- 範例：
  - `把這份文件存進知識庫`
  - `知識庫裡有沒有關於 KD 黃金交叉的筆記？`

### AI 自製函式（`ai-functions`）

讓助理把常用流程存成可重複呼叫的函式，之後直接叫用。

- 可用平台：網頁版、桌面版
- 子代理人領域：`ai_functions`
- AI 工具：`list_ai_functions`、`call_ai_function`、`add_ai_function`、`delete_ai_function`
- 範例：
  - `幫我建立一個函式，把輸入的價格換算成漲跌幅`

### 儲存腳本（`saved-scripts`）

把 bash／python 腳本存起來，之後用名稱取回再執行。

- 可用平台：網頁版、桌面版
- AI 工具：`register_saved_script`、`list_saved_scripts`、`get_saved_script`
- 範例：
  - `把剛剛那段 python 存成 stats-report 腳本`

## 檔案與資料夾

上傳檔案解讀、授權資料夾存取、圖片理解

### 上傳檔案解讀（`file-analysis`）

解讀你上傳的 csv／xlsx／json／markdown／yaml／docx／pptx／log 等檔案，也能解開 zip／tar／tgz；大檔會自動分段摘要。

- 可用平台：網頁版、桌面版
- 子代理人領域：`file_analysis`
- AI 工具：`list_uploaded_files`、`parse_uploaded_file`、`summarize_large_text`、`attachment_apply_patch`
- 範例：
  - `幫我看剛上傳的 xlsx，整理成重點表格`

### 圖片理解（`image-interpret`）

描述或解讀上傳的圖片內容（圖表、截圖、照片）。

- 可用平台：網頁版、桌面版
- AI 工具：`interpret_image`
- 範例：
  - `這張截圖裡的錯誤訊息是什麼意思？`

### 授權資料夾存取（File Access Point）（`file-access-points`）

授權一個真實資料夾後，助理可以列出、讀取、搜尋、寫入修補其中的檔案。

- 可用平台：網頁版、桌面版
- 斜線指令：`/fap-list`、`/fap-read`、`/fap-find`
- 子代理人領域：`file_access_points`
- AI 工具：`list_file_access_points`、`fap_list_files`、`fap_read_file`、`fap_find_file`、`fap_write_file`、`fap_apply_patch`、`fap_copy_from_storage`、`fap_copy_to_storage`、`fap_download_url`
- 範例：
  - `/fap-list`
  - `/fap-read fap:我的筆記/todo.txt`
  - `/fap-find fap:我的筆記 todo`

### 本機檔案與指令執行（`desktop-ops`）

直接讀寫本機檔案、執行系統指令、開 tmux 工作階段（桌面版限定，需在設定允許）。

- 可用平台：桌面版
- 子代理人領域：`desktop_ops`
- AI 工具：`run_command`、`fs_read_file`、`fs_write_file`、`fs_list_files`、`fs_find_file`、`fs_stat`、`fs_mkdir`、`fs_remove`、`tmux_start_session`、`tmux_send_keys`、`tmux_capture_pane`、`tmux_list_sessions`、`tmux_kill_session`、`batch_process_items`、`analyze_large_file`、`get_large_file_analysis_chunk`
- 範例：
  - `列出這個資料夾最大的 10 個檔案`
  - `在背景開一個 tmux 跑這個腳本`

## 程式設計與版本控制

流程化寫程式、git 操作、Skill 建立、沙盒內執行程式

### 程式設計流程（`coding-workflow`）

評估、需求分析、設計計畫、用 git patch 修改、語法檢查、測試、發佈，可中斷後恢復（桌面版限定）。

- 可用平台：桌面版
- 子代理人領域：`coding`
- AI 工具：`coding_read_file`、`apply_git_patch`、`git_inspect`、`coding_task_state`、`coding_run_tests`、`coding_run_check`、`coding_workspace`
- 範例：
  - `在目前工作目錄修一個 bug，全程用 git patch，改完跑測試`

### git 操作（`git-operations`）

clone、pull、status、log、commit、push（網頁版透過 worker 中繼）。

- 可用平台：網頁版、桌面版
- 子代理人領域：`git_operations`
- AI 工具：`git_clone`、`git_pull`、`git_status`、`git_log`、`git_commit`、`git_push`
- 範例：
  - `幫我 clone 這個 repo 並看最近 5 筆 commit`

### 建立 Skill（`skill-creator`）

建立 Claude 格式的 Skill（SKILL.md 加腳本與參考資料），可下載成 .skill 檔，也能匯入匯出。

- 可用平台：網頁版、桌面版
- 子代理人領域：`skills`
- AI 工具：`skill_create`、`skill_list`、`skill_read`
- 介面入口：設定 → Skill
- 範例：
  - `幫我建立一個整理會議紀錄的 Skill`

### 沙盒程式執行（`code-execution`）

在瀏覽器沙盒內執行 bash（busybox）與 python（Pyodide），管線可以混用 python、jq、xq。

- 可用平台：網頁版、桌面版
- 子代理人領域：`code_execution`
- AI 工具：`bash_execute`、`python_execute`
- 範例：
  - `用 python 算費氏數列前 20 項，再用 column -t 排版`

### 互動終端機（`terminal`）

在對話裡嵌入可以直接打字的終端機（WASM 沙盒），可與沙盒互相複製檔案。

- 可用平台：網頁版、桌面版
- 斜線指令：`/run-terminal`、`/run-terminal-cp-to`、`/run-terminal-cp-from`
- AI 工具：`terminal_create`、`terminal_list`、`terminal_run`、`terminal_get_text`、`terminal_cp_to`、`terminal_cp_from`
- 範例：
  - `/run-terminal`
  - `/run-terminal ls -la`

## 圖表與視覺化

繪圖、流程圖、3D 場景、互動元件、2D 動畫

### 通用繪圖（`drawing`）

用 SVG 畫示意圖、流程圖、圖表。

- 可用平台：網頁版、桌面版
- 子代理人領域：`drawing`
- AI 工具：`render_drawing`
- 範例：
  - `畫一張 TCP 三向交握的示意圖`

### UML／流程圖（Mermaid）（`uml`）

用 Mermaid 語法畫 UML、流程圖、序列圖，圖可以拖曳縮放並匯出 SVG／PNG。

- 可用平台：網頁版、桌面版
- AI 工具：`render_uml_diagram`
- 範例：
  - `畫一張登入流程的序列圖`

### 3D 場景（`scene-3d`）

用 YAML 描述 3D 場景，在對話裡用滑鼠旋轉縮放；也能匯入 3D 場景檔。

- 可用平台：網頁版、桌面版
- 斜線指令：`/view-3d-attachment`
- 子代理人領域：`scene_3d`
- AI 工具：`render_3d_scene`、`get_3d_scene_topic`、`get_3d_scene_yaml`、`import_3d_model_attachment`
- 範例：
  - `做一個會旋轉的太陽系 3D 場景`

### 互動元件（`interactive-viewer`）

產生多頁表單、引導頁、教學畫面等可互動的介面，可保存狀態並匯出封裝檔。

- 可用平台：網頁版、桌面版
- 斜線指令：`/import-viewer-attachment`
- 子代理人領域：`interactive_component`
- AI 工具：`render_interactive_viewer`、`get_interactive_viewer_yaml`、`get_viewer_state`、`set_viewer_state`、`import_interactive_viewer_attachment`
- 範例：
  - `做一個三步驟的新手引導精靈`

### 2D 動畫（`animation-2d`）

用多邊形描述 2D 動畫並播放，也能匯入動畫檔。

- 可用平台：網頁版、桌面版
- 斜線指令：`/import-2d-animation-attachment`
- 子代理人領域：`animation_2d`
- AI 工具：`render_2d_animation`、`get_2d_animation_yaml`、`import_2d_animation_attachment`
- 範例：
  - `做一個彈跳的球的 2D 動畫`

## 影音處理

逐字稿、抽音、字幕、剪輯、GIF、語音合成、配音（都在瀏覽器端處理，不上傳）

### 影音轉逐字稿（`media-transcribe`）

用瀏覽器端 Whisper 把影片或音檔轉成逐字稿，預設中文。

- 可用平台：網頁版、桌面版
- 斜線指令：`/media-transcribe`
- 子代理人領域：`media_av`
- AI 工具：`transcribe_media`
- 範例：
  - `/media-transcribe`
  - `/media-transcribe en`

### 抽出影片聲音（`media-extract-audio`）

把影片音軌存成 MP3（可在設定改 WAV）。

- 可用平台：網頁版、桌面版
- 斜線指令：`/media-extract-audio`
- AI 工具：`extract_audio`
- 範例：
  - `/media-extract-audio`

### 燒字幕（`media-burn-subtitles`）

把字幕燒進影片輸出新的 MP4；沒有字幕檔時自動先轉逐字稿。

- 可用平台：網頁版、桌面版
- 斜線指令：`/media-burn-subtitles`
- AI 工具：`burn_subtitles`
- 範例：
  - `/media-burn-subtitles`

### 擷取片段（`media-clip`）

擷取影片指定時間範圍（含畫面聲音，或只要聲音），不重新編碼。

- 可用平台：網頁版、桌面版
- 斜線指令：`/media-extract-clip-range`、`/media-extract-clip-range-audio`
- AI 工具：`extract_clip_range`、`extract_clip_range_audio`
- 範例：
  - `/media-extract-clip-range 1:20-1:45`

### 影片轉動態 GIF（`media-gif`）

把影片或其中一段轉成動態 GIF，可指定每秒幀數。

- 可用平台：網頁版、桌面版
- 斜線指令：`/media-to-animated-gif`
- AI 工具：`convert_to_animated_gif`
- 範例：
  - `/media-to-animated-gif 0:05-0:10 8`

### 影片轉 2D 動畫（`media-to-animation`）

逐格擷取影片畫面，轉成本 app 的 2D 動畫 YAML。

- 可用平台：網頁版、桌面版
- 斜線指令：`/media-to-animation`
- AI 工具：`convert_video_to_animation`
- 範例：
  - `/media-to-animation 0:00-0:03 fps=5 loop`

### 文字轉語音（`tts`）

英文用本地 Kokoro，中文粵語日文韓文用可選的 API 轉接；可列出全部語音代號。

- 可用平台：網頁版、桌面版
- 斜線指令：`/media-text-to-speech`、`/media-list-voices`
- AI 工具：`text_to_speech`、`concat_audio`
- 範例：
  - `/media-text-to-speech 歡迎使用 AI 助理`
  - `/media-list-voices`

### 配音小幫手（`dubbing`）

針對影片某個時間段逐句錄音或上傳音檔配音，再合成新影片。

- 可用平台：網頁版、桌面版
- 斜線指令：`/media-dub-video`
- 子代理人領域：`video_editing`
- AI 工具：`start_dubbing_session`、`compose_video`
- 範例：
  - `/media-dub-video 1:20-1:45`

### 下載 YouTube 影片（`youtube-download`）

下載 YouTube 影片供後續轉逐字稿、剪輯（桌面版透過本地代理）。

- 可用平台：桌面版
- AI 工具：`youtube_download`
- 範例：
  - `幫我下載這支 YouTube 影片並轉成逐字稿`

## 網路與瀏覽器

搜尋、抓網頁、控制你的 Chrome

### 網路搜尋（`browser-search`）

搜尋維基百科、StackOverflow、GitHub、Google 新聞、SourceForge、CodeProject、DeepWiki 等來源（需在設定啟用）。

- 可用平台：網頁版、桌面版
- 子代理人領域：`browser_search`
- AI 工具：`browser_search`
- 介面入口：設定 → 啟用網路搜尋
- 範例：
  - `搜尋 GitHub 上有哪些 sql.js 的範例`

### 抓取網頁內容（`fetch-web-page`）

抓取指定網址的文字內容給助理閱讀。

- 可用平台：網頁版、桌面版
- AI 工具：`fetch_web_page`
- 範例：
  - `讀一下這個網址，幫我摘要重點`

### 瀏覽器控制（`browser-control`）

控制你的 Chrome：分頁群組、分頁、捲動、截圖、滑鼠鍵盤（桌面版，需安裝擴充功能）。

- 可用平台：桌面版
- 子代理人領域：`browser_control`
- AI 工具：`browser_get_page_structure`
- 範例：
  - `用瀏覽器控制開啟 https://tw.news.yahoo.com/ ，說明今天的最新新聞`

## 研究分析

唯讀的程式碼與檔案分析

### 唯讀研究（`research-readonly`）

分析程式碼與檔案但不修改、不執行，適合先理解專案再動手。

- 可用平台：桌面版
- 子代理人領域：`research`
- 範例：
  - `幫我看目前工作目錄，說明專案結構與主要功能`
