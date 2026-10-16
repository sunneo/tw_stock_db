# MCP 伺服器與壓縮檔附件設計

## 一、壓縮檔附件解析（`renderer/src/archive/archive_core.js`）

附件一律先看檔頭魔術位元組，副檔名只是輔助。支援：zip／jar／war／ear／aar、7z、rar（4／5）、tar（ustar／v7）、gzip、bzip2、xz、iso、cab、zstd，以及 tar.gz／tgz／tar.bz2／tar.xz。

| 格式 | 解法 |
|---|---|
| zip／jar | JSZip；加密 zip 退到 libarchive（帶密碼） |
| tar | 自寫解析（ustar 前綴、pax、GNU 長檔名） |
| gzip | 瀏覽器內建 DecompressionStream |
| bzip2 | 純 JS 解碼器（多區塊、串接串流、CRC 檢查、輸出上限防炸彈） |
| xz | `xz-decompress@0.2.3`，第一次用才從 CDN 載入 |
| 7z／rar／iso／cab／zstd | `libarchive.js@2.0.2`（wasm 約 1MB），第一次用才載入 |

工具 `parse_uploaded_file` 增加 `password` 參數；列出內容與摘要，或用 `entry` 讀單一檔案。

限制：輸入 300MB、解壓後輸出 256MB 上限；標頭加密的 7z 連列表都做不到；壓縮檔裡的壓縮檔只標註、不自動展開；程式庫要連網路才能第一次載入。

## 二、MCP（`renderer/src/mcp/mcp_core.js`）

### 架構
- **核心**（`FaMcp`）：JSON-RPC 用戶端（initialize 協商 2025-06-18／2025-03-26／2024-11-05、tools／resources／prompts、分頁、逾時送 cancelled），三種傳輸：stdio、Streamable HTTP、舊版 SSE；設定檔解析（容忍 JSONC、各家 mcp.json 寫法）；`.mcpb`／`.dxt` manifest；專案偵測（package.json、pyproject、requirements＋server.py、smithery.yaml）。
- **桌面端宿主**（`main-ext.js`，`fa:mcp:*`）：啟動／寫入／停止子行程、解壓到 `<userData>/mcp-servers/<name>`、執行安裝指令。`preload.js` 暴露 `desktopAPI.mcp`。
- **渲染端**：設定存在 fileCache 的 `mcp-servers.json`；設定頁 AI → MCP 伺服器；斜線指令 `/mcp-install`、`/mcp`；獨立 domain `mcp`（子 agent）。

### 為什麼獨立 domain
伺服器工具數量不可預期。若全部註冊成主要對話的工具，會塞爆工具清單。主 agent 只看到一個 `mcp` domain，子 agent 才看到 `mcp_servers → mcp_tools → mcp_call` 這組工具，再依需要呼叫。

### 安全
- 啟動任何子行程、執行安裝指令，都要經 `ctx.execConfirmGate`；桌面設定的 `execEnabled` 沒開就一律拒絕。
- 安裝流程：嗅探 → 偵測 → 解壓 → 列出要執行的安裝步驟給使用者核准（npm install／`python -m pip`）→ 確認表單 → 儲存。拒絕就停，不繞過。
- 解壓有 zip-slip 防護。環境變數在介面中遮罩。
- 網頁版沒有子行程，只支援 http／sse 遠端伺服器；stdio 設定會明確說明要改用桌面版。

### 已驗證（真實 Electron）
mcp.json（含註解、stdio＋遠端）、zip／7z／tgz 專案包、`.mcpb`（含 user_config 表單與環境變數傳遞）、工具列表與呼叫（中文／emoji、isError、缺參數、不存在的工具建議）、資源讀取、日誌、停止／重啟／停用／移除（含刪安裝資料夾）、設定頁畫面、`/mcp list`、`/mcp-install` 帶附件。結束後無殘留行程。

### 尚未驗證
- 真正的 LLM 子 agent 經 `mcp` domain 自行呼叫。
- 真實第三方伺服器（需要 npm／pip 實際安裝）。
- Windows `.cmd` 搭配特殊字元參數的引號處理。

### 已知限制
- Dockerfile 型專案不支援。
- Windows 上剛結束的行程會短暫鎖住資料夾：重裝／移除時先停止並等待，刪除另有重試。
- `main-ext.js` 可熱更新；`preload.js` 的新增暴露要重新啟動才生效。
