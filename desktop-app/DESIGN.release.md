# 發版：版號只有一個維護處（`PATCH_VERSION`）

多個 session、多個人都會發熱更新（patch）。版號不能各自記在腦袋或對話裡，所以：

| 東西 | 在哪 | 角色 |
|---|---|---|
| **`desktop-app/PATCH_VERSION`** | 這個 repo（跟發版的那個 commit 一起提交） | **唯一維護處**：一行整數＝最後一次發出去的 patch 版號。git 歷史就是版號歷史 |
| `origin/desktop-app-patch` 的 `manifest.v2.json` | 遠端 | 實際發出去的（現在真正的最新） |
| 同一個分支的 `manifest.json` | 遠端 | 給舊版客戶端的互換版，**凍結在 188**，不要拿來算下一版 |
| 同一個 commit 的訊息 `desktop-app-patch: vNNN - …` | 遠端 | 另一個紀錄（曾經與 manifest 不一致，所以也看） |

## 工具：`scripts/release-version.js`
```bash
node scripts/release-version.js status   # 檔案版號、遠端三處版號、下一版；不一致會警告
node scripts/release-version.js next     # 只印下一版 = max(檔案, 遠端各處) + 1
node scripts/release-version.js claim    # 把 PATCH_VERSION 寫成下一版（或 claim N，N 必須剛好是下一版）
node scripts/release-version.js check    # 檔案版號 ≠ 遠端 → 以 1 結束（發完版後檢查有沒有漏提交）
```
`scripts/publish.sh` 已經用它：版號沒指定就取 `next`，提交前 `claim` 並把 `PATCH_VERSION` 放進同一個提交。

## 接手的人怎麼做
1. `node scripts/release-version.js status`：看下一版是多少、有沒有不一致（有就先弄清楚誰發了版沒更新檔案）。
2. 用 `scripts/publish.sh`（它會建置、提交、發 patch、驗證）；網頁版釘 SHA 的步驟見 `.claude/skills/publish-live-update-patch/SKILL.md`。
3. 發完 `node scripts/release-version.js check` 應該是「一致」。
4. **兩個 session 同時發版**：`claim` 與 patch 分支的 `--force-with-lease` 會讓後到的失敗，不會蓋掉前面的；失敗就重新 `status` 再發。

不要手工組 patch 或手寫版號：發版格式（v2 manifest、分檔）由 `publish.sh`／`publish-manifest.js` 維護。

## 發布前本機驗證（網頁版）
網頁版一發布就是給所有使用者用，所以改了網頁版會碰到的程式（`renderer/src/floating-assistant.js`、`web-lazy/`）時，**先在本機測，OK 才發布**。`scripts/web-local-serve.js` 起一個只綁 `127.0.0.1` 的唯讀伺服器，把網頁版的 `raw.githubusercontent.com/sunneo/tw_stock_db/<SHA>/desktop-app/…` 改寫成本機路徑，讓網頁版直接載到目前工作目錄的建置產物。

1. 先建置（伺服器只會警告、不會替你建）：
   ```bash
   node scripts/embed-code-ui.js && node build-assistant.js
   ```
2. 起伺服器（預設埠 18770，網頁版目錄預設 `D:\Downloads\videos-嗨投資\web`，可用 `--web` 或環境變數 `FA_WEB_DIR` 指定）：
   ```bash
   node scripts/web-local-serve.js
   ```
   啟動時會檢查建置產物是否比來源新；不是最新就印警告。`--dry-run` 只列出會改寫的網址、不起伺服器。
3. 命令列先確認改寫有效（不該再看到 `340d…` 這種釘住的 desktop-app 網址，且載入的都是本機路徑）：
   ```bash
   curl -s http://127.0.0.1:18770/web/aiweb/ | grep -c "raw.githubusercontent.com/sunneo/tw_stock_db/[0-9a-f]\{40\}/desktop-app"
   ```
   結果應該是 `0`。
4. 用 **Claude in Chrome**（不是內建瀏覽器）開 `http://127.0.0.1:18770/web/aiweb/` 與 `http://127.0.0.1:18770/web/`，檢查：
   - 頁面正常載入、沒有 console 錯誤；助理面板打得開。
   - 改動的功能照預期運作（例如 Pyodide 的 python 執行：有沒有 `Failed to fetch`；失敗時訊息有沒有列出試過的來源與 HTTP 狀態）。
   - 匯入一份含 `fa-local://` 的設定檔時，有提示「已略過 N 項桌面版專屬設定」，且網頁版不會因此打不通。
   - 網頁版其他外部資源（sql.js、模型、字型）照常載入（它們維持原網址，不經過本機伺服器）。
5. **OK 才** `scripts/publish.sh`。有任何一項不對，回頭改程式、重建、重測，不要先發布再修。

注意：本機伺服器只讀網頁版倉庫，不會修改它；網頁版的 SHA 釘住與發版要換成的 SHA 仍由發版流程處理（見上面的「接手的人怎麼做」與 `.claude/skills/publish-live-update-patch/SKILL.md`）。

## 冷載入優化（2026-11-15）

目標：網頁版沒有快取時，盡快顯示出來。管理者在使用者的 Chrome 量到的基線（助理就緒約 6.0 秒，`window.fa` 出現為準）：

| 時段（秒） | 事件 |
| --- | --- |
| 0.4→2.7 | 下載 `web-lazy/core.js`（gzip 約 2.0 MB、解開約 5.8 MB；raw.githubusercontent 回應 `max-age=300`） |
| 2.7→3.1 | 執行核心 |
| 3.1→4.7 | 32 個分塊用同步 XHR 一個接一個載入（快取命中每個約 5 毫秒，冷快取每個一次網路往返） |
| 3.3→4.6 | marked、purify、katex（269 KB）、three.js（589 KB）＋OrbitControls、js-yaml 依序載入 |
| 約 5.97 | supabase 載入 |
| 約 0.6（開機路徑上） | `api.github.com/repos/sunneo/tw_stock_db/releases/latest` |

下載來源比較（同一個核心檔，SHA `a575ce383e47b7312a84736e86eb53a3e59b3d9f`，curl 量）：

| 來源 | 大小 | 快取標頭 | 耗時 |
| --- | --- | --- | --- |
| `raw.githubusercontent.com` | gzip 2,002,489 位元組 | `max-age=300` | 約 2.15 秒 |
| `cdn.jsdelivr.net/gh/sunneo/tw_stock_db@<SHA>/desktop-app/web-lazy/core.js` | br 1,904,298 位元組 | `public, max-age=31536000, immutable` | 約 0.15 秒（首次 MISS 也快） |

### 已做（本次）

1. **來源改走 jsDelivr、退路 raw**：`web/index.html`、`web/aiweb/index.html` 的核心與分塊都改用 jsDelivr（釘完整 SHA）。任一檔失敗（網路錯誤、8 秒逾時、非 200）退回 raw，每次失敗 `console.warn` 寫出檔名、來源、錯誤與耗時。`lazy-runtime.js` 的同步與非同步載入也都走 `window.__FA_LAZY_BASES` 多來源，失敗寫 `[FaLazy]` 訊息。
2. **開機區塊預抓（機制已做，清單待量）**：`web-lazy/boot.json` 列出開機要用的區塊，網頁版在核心執行前用並行 `fetch` 抓好，放進 `window.__FA_PREFETCH`；`loadSync()` 有預抓就直接執行，不發同步 XHR；沒有就照舊同步載入。`scripts/web-lazy-boot.json` 是清單來源（預設 `[]`，建置時寫入 `web-lazy/boot.json`），清單由真瀏覽器量出後手動填入。
3. **releases 查詢移出開機路徑**（`web/aiweb/index.html`）：閒置時（`requestIdleCallback`，逾時 4 秒）才查；結果存 `localStorage` 24 小時，有效期內不重查。
4. **預連線與預載**（`web/index.html`）：`preconnect` 到 jsDelivr，`preload`（`as="fetch"`，`crossorigin`）核心網址，DOM 解析時就開始下載。
5. **預熱（發布流程）**：`scripts/publish.sh` 在網頁版釘新 SHA 並推上 main 之後，對 core.js、boot.json 與 manifest 每個分塊各發一次 `curl`（逾時 20 秒，失敗只警告，不擋發布），讓使用者第一次造訪就是 HIT。網址清單由 `scripts/web-warm-urls.js` 產生，有測試。
6. **本機測試伺服器**（`scripts/web-local-serve.js`）：jsDelivr 釘 SHA 的網址（字面值與字串相加兩種寫法）一併改寫成本機路徑；新增 `--throttle <kbps>`（回應限速，模擬慢網路）與 `--no-cache`（回應一律 `Cache-Control: no-store`；預設本來就是，這個參數只是寫明意圖）。
7. **量測**：`scripts/web-cold-load-probe.js --print` 印出要貼進 Chrome 的量測程式，`--summarize <結果檔.json>` 印摘要（就緒近似時間、jsDelivr／raw 數量、分塊數、開機候選區塊）。
8. **測試**：`scripts/web-cold-load.test.js`（8 項）：FaLazy 預抓不發 XHR、jsDelivr 失敗退回 raw 並寫 warn、舊版單一來源、非同步來源退路、網頁版 html 的 `__faLoadCore`（正常走 jsDelivr、boot.json 預抓、jsDelivr 失敗退回 raw）、預熱網址的組合與拒絕錯誤 SHA。

### 沒做、為什麼

- **外部套件延後（three.js、katex、js-yaml、marked、purify）與 supabase 延後**：要逐一確認呼叫點（index.html 約 13,000 行、嵌入的 floating-assistant.js 也有同步使用處），而且 supabase 的判斷規則（有儲存的登入或遠端設定才開機載入）需要真瀏覽器驗證。這一輪沒有做，留待下一輪。
- **分塊改真的按需載入、骨架與進度條**：分塊目前仍由核心同步載入；預抓清單還沒量出來，所以分塊真正並行的效果要等 `boot.json` 填入後才會出現。骨架與「載入分塊 x/y」進度 UI 沒做。
- **coi-serviceworker 只在需要時註冊**：`web/coi-serviceworker.js` 第一次造訪會註冊、然後 `location.reload()` 一次（`updatefound` 或 `reg.active && !controller` 時），用來取得 SharedArrayBuffer（離線模型的多執行緒）。改成「只有用到多執行緒功能才註冊」需要先確認 Pyodide、Whisper 等功能的啟動點，這一輪沒改，屬於後續項目。

### 驗證狀態

- `scripts/web-cold-load.test.js` 8 項通過（在 desktop-app 執行）。
- 核心與分塊重建（`node scripts/embed-code-ui.js && node build-assistant.js`），`node --check web-lazy/core.js` 通過。
- 本機伺服器：jsDelivr 網址已改寫為本機路徑（頁面內 jsDelivr 網址剩 0 個）；`--throttle 800` 實測回應速率約 100 KB/秒。
- **未驗證**：真瀏覽器的前後對照（就緒時間、各資源時間線）。這要管理者用使用者的 Chrome 做：先 `node scripts/web-local-serve.js --throttle <kbps>` 起本機伺服器，再貼 `web-cold-load-probe.js --print` 的程式，存 JSON 後 `--summarize`。
- 核心仍釘在 `a575ce38`（舊版核心）。新版的 `lazy-runtime.js` 要等 `scripts/publish.sh` 釘新 SHA 後才會上線；在那之前網頁版行為與改版前相同：舊核心忽略 `__FA_PREFETCH`，網頁只設舊變數 `__FA_LAZY_BASE`（維持 raw，不走 jsDelivr），所以分塊仍是原本的 raw 來源；核心本身的 jsDelivr 優先與退路也要等新 SHA 才會生效。
