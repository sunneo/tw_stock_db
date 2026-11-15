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

### 第二輪（2026-11-15，管理者追加）：外部套件、分塊、骨架、coi 評估

前面「沒做」的項目，這一輪處理了大部分；下面是實際做了什麼、量到什麼、還剩什麼。

#### 量測方法（無頭 Chrome，不開桌面視窗、不用內建瀏覽器）

- `scripts/web-cold-load-headless.js`：每次用全新的暫存設定檔（沒有任何快取）開 `web/aiweb/`，等 `window.fa` 出現。
- 探針由 `scripts/web-local-serve.js --measure` 注入（只在量測模式），記錄就緒那一刻的資源快照、同步分塊載入（`how` 分 prefetch／sync）與載入次數（`htmlCount`）。
- 就緒時間用伺服器的牆鐘（從第一個 html 回應起算的真實毫秒），不用頁面的 `performance.now()`：Chrome 的虛擬時間（`--virtual-time-budget`）下頁面內的時間不是真實時間。虛擬時間預算要設夠大（900000），否則網頁還在下載核心時就截止（實測過 150000 會截止在 2.0–2.2 MB）。
- 「改版前」是本次開工前的網頁版（`git archive 6c53dbba6 web`）加上真實 CDN（`--no-rewrite`）；「改版後」是本機改寫模式（核心與分塊走本機建置產物，沒有 CDN 網路延遲）。兩者的網路條件不同，**不是同條件比較**；要做同條件比較，需要管理者在使用者的 Chrome 用真實 CDN 量改版後的版本（發布後）。

#### 前後對照（實測）

| 項目 | 改版前（真實 CDN，n=5） | 改版後（本機改寫，n=3） | 改版後、去掉 coi（本機，n=3） |
| --- | --- | --- | --- |
| 助理就緒（牆鐘，毫秒） | 中位數 4719（2963～5491，另有一次 28012 的冷啟動離群值） | 1855～2010 | 1119～1318 |
| 就緒前的外部請求（就緒後 50 毫秒內的快照） | 22～23 | 0 | 0 |
| 外部請求（整段，含就緒後） | 28 | 6（marked、purify、katex 的 js 與 css、calendar.json、releases） | 6 |
| supabase 相關請求 | 4 個 rg_join_room ＋ supabase-js 一個（開機就做） | 0 | 0 |
| 同步分塊載入（同步 XHR） | 16 | 0 | 0 |
| 預抓的分塊（並行 fetch，核心執行前） | 0 | 16 | 16 |
| 載入次數（htmlCount） | 2（coi 重新整理） | 2 | 1 |
| 資源總數（就緒時） | 30～31 | 26～27 | 26 |

#### 每一項的做法與狀態

1. **外部套件延後（做了）**
   - supabase：開機不再載入。原因是遠端群組的保活（`_rgKeepAlive`）每次開機都排程，15 秒後對四個後端各送一次 `rg_join_room`，每次都先載入 supabase-js。現在只有使用者設定過遠端群組（`fa_remote_group_v1`）或保存過登入工作階段（`fa_remote_session_v1`）才排程。沒有設定的人，免費專案的保活由 Cloudflare Worker 每 5 天送一次（既有設計）。實作在 `renderer/src/remote/rg_host.js`（原始模組，不可改嵌入後的那份；嵌入步驟會覆蓋）。
   - 有保存的登入或遠端設定時：`_rgAutoRejoin` 在背景執行，不擋就緒（既有行為，維持）。
   - marked、DOMPurify、KaTeX：改成就緒後閒置時才載入（`_faRunWhenIdle`，`requestIdleCallback`，逾時 4 秒；沒有就 2 秒後）。真的要渲染 markdown 時，呼叫端會 `await _ensureMarkdownLibsLoaded()`，沒載好就等它。
   - three.js：不再於開機預先載入（原本在 worker 建立時有一個沒 await 的預載），只有 3D 功能第一次用到才載入（`_ensureThreeJsLoaded` 內部 await）。
   - js-yaml：原本就是各功能第一次用到才載入（`_ensureJsYamlLoaded`），沒有改動。
   - 節慶套版（`calendar.json`）：建構時的 `_applyFestivalTheme` 改成閒置時才執行。

2. **分塊（部分做了）**
   - 開機必需的 16 個分塊（無頭 Chrome 量到的實際載入順序：`thinkstack`、`matrixgraph`、`matrixsynth`、`matrixl0`、`matrixcompose`、`matrixedit`、`matrixtext`、`matrixchecksum`、`matrixbytes`、`matrixregex`、`matrixsketch`、`matrixlist`、`matrixos`、`img3d`、`guitpl`、`vpstore`）列在 `scripts/web-lazy-boot.json`，建置寫入 `web-lazy/boot.json`（格式 `{names, coreBytes}`）。網頁版在核心執行前用 `Promise.all` 並行 `fetch` 這 16 個，放進 `window.__FA_PREFETCH`，核心的 `loadSync` 有預抓就直接執行，不再同步 XHR（同步載入次數從 16 降到 0）。
   - 其中三個可以改成真正按需載入，但還沒做（需要改呼叫點，這一輪沒有時間逐一驗證）：
     - `guitpl`：`FloatingAssistant._guiTplRegisterTools` 在建構時就碰到這個區塊（註冊 GUI 範本工具時）。要改成工具第一次被呼叫時才載入，需要把註冊與取值分開。
     - `vpstore`：`_vpRefreshUi` → `_vpLoadStore`，在 UI 重新整理時碰到。要把 UI 重新整理延後到使用者打開相關面板。
     - `img3d`：在某個建構流程的閉包裡被碰到（追蹤堆疊指向一個匿名函式），需要先找到它的呼叫點。
   - `matrix*`（13 個）是核心頂層程式碼碰到的，屬於開機必需；要分拆需要改建置的區塊切分規則，這一輪不做。
   - 要確認「呼叫點都改成 await」的既有功能清單：沒有做到，因為改動的只有兩類（三個分塊的按需呼叫、外部套件的閒置預載），都是由 `_ensure*` 函式自己 await 的既有模式。

3. **預載與骨架（aiweb 做了，主頁沒做）**
   - `web/aiweb/index.html`：`<head>` 有 preconnect（jsDelivr、raw）與 preload（核心，`as="fetch" crossorigin`，網址與載入器完全一致）。
   - 骨架：`#app` 裡的標題、對話區、輸入框與進度條，在核心下載前就顯示；核心就緒時整段移除（`FloatingAssistant` 同步建好 UI，不會閃一下）。
   - 進度：狀態列與骨架進度條顯示「載入核心 N%」（分母是 `boot.json` 的 `coreBytes`，解壓後的位元組數，因為傳輸量是壓縮後的）與「載入分塊 x/y」。
   - `web/index.html`（主頁）：沒有骨架（它的 AI 助理在一個分頁裡，骨架要改那個分頁的結構）；主頁只有 preconnect／preload 與載入器改進。
   - 載入器的逾時改成「只限連線與回應標頭（8 秒）」：回應開始後不設逾時，慢網路下完整下載 2 MB 核心可能超過 8 秒，不應換來源。中途斷線由瀏覽器回報錯誤。
   - 注意：第一版是「停滯」逾時（資料中斷 8 秒就換來源），無頭 Chrome 的虛擬時間下串流讀取會被截止，改成上述設計後量測才穩定。

4. **coi-serviceworker（評估，不改，理由如下）**
   - 機制：`web/coi-serviceworker.js` 在 head 同步註冊 service worker；新註冊時 `updatefound` 或 `reg.active && !navigator.serviceWorker.controller` 會 `location.reload()` 一次，用來取得 `crossOriginIsolated`（SharedArrayBuffer，離線模型的多執行緒需要）。
   - 量測：去掉 coi 的版本只載入一次（htmlCount 1），就緒時間中位數約 1.2 秒；有 coi 的版本載入兩次（htmlCount 2），中位數約 1.9 秒。差距約 0.7 秒（本機；本機伺服器是 `no-store`，重新整理時核心會重新下載，真實 CDN 上核心有 immutable 快取，差距應該小很多，這一點還沒量）。
   - 結論：**不做「只在需要時註冊」**。原因：service worker 只能影響之後的文件載入，不能讓目前這一頁取得跨來源隔離；所以要用到多執行緒功能時，只能「註冊、然後強制重新整理」，會打斷使用者正在做的事（對話、輸入、正在跑的任務）。
   - 可行的替代方向（未做）：(a) 第一次造訪的重新整理可以改成一個不打斷的提示（「偵測到多執行緒功能需要重新整理，要現在重新整理嗎？」），但這是 UX 改動，要使用者決定；(b) 離線模型在沒有隔離時改走單執行緒（既有的 canThread 判斷已經支援，見 floating-assistant 的 `canThread` 註解）。目前的設計維持 coi 不變。

#### 還沒做（誠實列出）

- 分塊：`guitpl`、`vpstore`、`img3d` 三個可以按需，但呼叫點還沒改（見上）；`matrix*` 13 個是核心頂層碰到的，要改建置切分規則。
- 主頁骨架與進度（只做了 aiweb）。
- 真實 CDN 下改版後的同條件量測（需要發布後，由管理者在使用者的 Chrome 做）。
- 桌面版：`renderer/src/floating-assistant.js` 的閒置延後、遠端保活的門檻，也會影響桌面版；桌面版的 live update 要另外發布（這次沒有發布）。

#### 驗證

- `scripts/web-cold-load.test.js`：9 項通過（FaLazy 預抓與來源退路、網頁版主頁與 aiweb 的 `__faLoadCore`、boot.json 的兩種格式、jsDelivr 失敗退回 raw、預熱網址）。
- 建置：`node scripts/embed-code-ui.js && node build-assistant.js`，核心與桌面版產物 `node --check` 通過。
- `scripts/web-local-serve.js --no-cache --throttle 800`：用 curl 檢查，頁面沒有剩下的 jsDelivr 網址、本機改寫保留、vendor 網址維持原樣、回應 `Cache-Control: no-store`、限速約每秒 80 KB。
- 無頭量測（上表）：每個數字都來自 `scratchpad` 的 JSON（不在版本庫裡）；重跑方法見 `scripts/web-cold-load-headless.js` 開頭的用法。
