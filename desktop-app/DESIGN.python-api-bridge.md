# Python API 轉接層（技能包腳本）設計文件

> 原始碼：`renderer/src/pybridge/*.py`（`fa_bridge.py`、`fa_run.py`、`playwright/sync_api.py`），由 `scripts/embed-code-ui.js` 嵌入 `renderer/src/floating-assistant.js` 的 `FA_PYBRIDGE_FILES`；主機端 `_pyBridge*` 方法；桌面版啟動改寫在 `renderer/bootstrap.js` 的 `run_command`。

## 為什麼

技能包的腳本常是為別的環境（例如 Claude）寫的，例如用 Playwright 連 Chrome 遠端除錯埠。靠提示叫弱模型「讀懂再改寫」不保證它照做，也不能假設腳本用的是哪些公開 API。所以多加一層**不依賴模型理解**的保險：腳本照原樣執行，但執行期間部分公開 API 實際是接到助理自己的工具／領域。

## 範圍與開關

- 只在**執行技能包期間**生效（`_delegateToSubagentDomain` 對 `skill_*` 領域計數 `_pyBridgeDepth`），一般的 python／run_command 不受影響。
- 設定 `pythonApiBridge`：`skill`（預設）／`off`。
- 桌面版與網頁版都支援（兩種傳輸，同一套主機端分派 `_pyBridgeDispatch`）。

## 兩種傳輸

| | 桌面版（run_command，真的 Python） | 網頁版／Pyodide（python_execute） |
|---|---|---|
| 啟動 | 把 `python x.py …` 改寫成 `python fa_run.py --rpc <信箱> -- x.py …`（含 `cd … && python x.py` 的一行指令、與 command＋args 兩種寫法） | 執行前把檔案寫進 Pyodide 檔案系統 `/fa_pybridge`，放進 `sys.path` 最前面 |
| 通道 | 檔案信箱 `.floating-assistant/pybridge/rpc/<runId>/req-*.json → res-*.json`，主程式在腳本執行期間輪詢處理；不開網路埠、不需要改主程式 | 註冊 JS 模組 `_fa_pybridge`，Python 用 `asyncio.run` 呼叫（與既有 subprocess 橋接相同的 JSPI 作法） |
| 等待 | `time.sleep` | `_fa_pybridge.sleep`（不能卡住頁面） |

截圖等檔案一律由 Python 端寫檔（兩種環境的檔案系統不同，相對路徑以腳本自己的工作目錄為準）。

## 轉接的 API

- `playwright.sync_api`：`sync_playwright()`、`chromium/firefox/webkit.connect_over_cdp()/launch()`、browser／context／page／locator 的常用子集（goto、inner_text、locator.first/count/screenshot、evaluate、wait_for_*、close…），每個動作對應到瀏覽器控制的 `tab_create／tab_navigate／get_page_text／tab_eval／screenshot／tab_close`。使用者的登入狀態就是他自己 Chrome 的狀態。
- 沒支援的功能丟出說明清楚的 `NotImplementedError`，指向 `fa_bridge.tool(...)`／`fa_bridge.domain(...)`。
- 通用通道：`fa_bridge.tool("browser_…", …)`（僅開放瀏覽器控制工具）、`fa_bridge.domain("browser_control", "任務")`（委派給任何已啟用的領域）。

## 回報

`run_command` 結果多一個 `python_api_bridge: {used, calls, ops, note}`，讓上層 AI 知道哪些呼叫被轉接；腳本 stderr 會印一行 `[fa-bridge] …`。

## 驗證

桌面版：原封不動的 `redmine_capture.py`（用 `connect_over_cdp`、`locator().screenshot()`）在沒有 Chrome 除錯埠、以假的瀏覽器控制回應下執行成功，輸出數字與截圖檔；網頁版：Pyodide 內 `python_execute` 同樣成功；關閉設定後轉接版從 `sys.path` 移除。

## 之後可擴充

新增別的公開 API 的轉接（例如 `selenium`、`requests` 指向助理的網路工具）：在 `renderer/src/pybridge/` 加一個同名套件、在 `_pyBridgeDispatch` 加對應 op 即可。
